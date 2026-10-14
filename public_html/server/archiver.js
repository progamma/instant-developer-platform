/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
var Node = Node || {};

// Import classes
Node.Utils = require("./utils");

// Import Modules
Node.tar = require("tar");
Node.archiver = require("archiver");
Node.fs = require("fs");
Node.googleCloudStorage = require("@google-cloud/storage").Storage;
Node.http = require("http");
Node.https = require("https");
Node.path = require("path");


/**
 * @class Node.Archiver
 * @classdesc
 * Manages file archiving operations for Instant Developer applications.
 * Provides unified interface for file operations across local storage and Google Cloud Storage.
 *
 * Key features:
 * - **Cloud Storage**: Seamless integration with Google Cloud Storage for backup operations
 * - **Archive Operations**: Create and extract tar.gz and zip archives
 * - **Backup/Restore**: Automated backup and restore of project directories
 * - **File Transfer**: Upload and download files between local and cloud storage
 *
 * @property {Node.Server|Node.Child} parent - Parent server or child process instance
 * @property {Object} indertBucket - Google Cloud Storage bucket instance (when using GCloud)
 */
Node.Archiver = class Archiver
{
  /**
   * @param {Node.Server|Node.Child} par - Parent server or child process that owns this archiver
   * @param {Boolean} [nightly] - Whether to use nightly backup bucket (for GCloud storage)
   */
  constructor(par, nightly)
  {
    this.parent = par;
    //
    if (this.useGCloud()) {
      let storage = new Node.googleCloudStorage(JSON.parse(JSON.stringify(this.config.configGCloudStorage)));
      if (nightly)
        this.indertBucket = storage.bucket(this.config.nightlyBucketGCloud);
      else
        this.indertBucket = storage.bucket(this.config.bucketGCloud);
    }
  }


  /**
   * Gets the configuration object from the parent server/child.
   * Contains storage settings, GCloud credentials, and bucket names.
   * @type {Object}
   * @readonly
   */
  get config()
  {
    return this.parent.config;
  }


  /**
   * Gets the logger instance from the parent server/child.
   * Used for logging operations and errors.
   * @type {Object}
   * @readonly
   */
  get logger()
  {
    return this.parent.logger;
  }


  /**
   * Checks whether to use Google Cloud Storage for archiving.
   * Returns true only if the project is not IDF and storage is configured as "gcloud".
   * @returns {Boolean} true if Google Cloud Storage should be used, false for local storage
   */
  useGCloud()
  {
    return !this.parent.doc?.prj.isIDF() && this.config.storage === "gcloud";
  }


  /**
   * Uploads a file to cloud storage or copies it locally.
   * Handles both Google Cloud Storage and local file system operations.
   * Uses streaming for efficient memory usage with large files.
   * @param {String} pathFile - Local file path to upload
   * @param {String} pathCloud - Destination path in cloud storage or local filesystem
   * @throws {Error} If upload fails due to read/write errors
   */
  async upload(pathFile, pathCloud)
  {
    try {
      // If the storage is gcloud
      if (this.useGCloud()) {
        let file = this.indertBucket.file(pathCloud);
        try {
          // pipeline destroys both streams on error (no fd leak) and waits for the upload to flush
          await require("stream/promises").pipeline(Node.fs.createReadStream(pathFile), file.createWriteStream({resumable: false}));
        }
        catch (err) {
          throw new Error(`Error uploading the file ${pathFile} to GCloud ${pathCloud}: ${err}`);
        }
      }
      else {
        // Assume the file is on the local filesystem
        let fs = require("fs-extra");
        try {
          await fs.copy(pathFile, pathCloud);
        }
        catch (err) {
          throw new Error(`Error writing the file ${pathFile} to local file ${pathCloud}: ${err}`);
        }
      }
    }
    catch (err) {
      this.logger.log("ERROR", err.message || err, "Archiver.upload");
      throw err;
    }
  }


  /**
   * Downloads a file from cloud storage or copies it locally.
   * Supports downloading from HTTP/HTTPS URLs, Google Cloud Storage, or local filesystem.
   * Automatically handles different source types based on the pathCloud format.
   * Note: Empty files created due to read errors are automatically cleaned up.
   * @param {String} pathCloud - Source path (URL, cloud storage path, or local path)
   * @param {String} pathFile - Local destination file path
   * @throws {Error} If download fails or source file is missing
   */
  async download(pathCloud, pathFile)
  {
    try {
      // Path cloud is needed!
      if (!pathCloud)
        throw new Error("Missing file name");
      //
      // First, if the pathCloud is an URL, download the file directly
      if (pathCloud.toLowerCase().startsWith("http://") || pathCloud.toLowerCase().startsWith("https://")) {
        return new Promise((resolve, reject) => {
          // Handle only HTTP and HTTPS
          let request = (pathCloud.toLowerCase().startsWith("http://") ? Node.http : Node.https).get(pathCloud, async resp => {
            // Check status code before piping
            if (resp.statusCode >= 400) {
              reject(new Error(`Wrong reply: ${resp.statusCode}`));
              return;
            }
            //
            // pipeline waits for the data to be flushed to disk (not just received) and tears the
            // file stream down on a mid-download error, avoiding fd leaks and orphan partial files
            try {
              await require("stream/promises").pipeline(resp, Node.fs.createWriteStream(pathFile));
              resolve();
            }
            catch (err) {
              reject(err);
            }
          });
          request.on("error", reject);
        });
      }
      //
      // If the storage is gcloud
      if (this.useGCloud()) {
        let file = this.indertBucket.file(pathCloud);
        try {
          // pipeline rejects on a read error (e.g. the object is not there) and tears both streams
          // down, so the gcloud "read error AND finish both fire" quirk no longer needs a manual guard
          await require("stream/promises").pipeline(file.createReadStream(), Node.fs.createWriteStream(pathFile));
        }
        catch (err) {
          // On a read error an empty/partial file may remain: delete it
          await Node.fs.promises.rm(pathFile, {force: true});
          throw err;
        }
      }
      else {
        // Assume the file is on the local filesystem
        let fs = require("fs-extra");
        try {
          await fs.copy(pathCloud, pathFile);
        }
        catch (err) {
          throw new Error(`Error writing the file ${pathCloud} to local file ${pathFile}: ${err}`);
        }
      }
    }
    catch (err) {
      this.logger.log("ERROR", err.message || err, "Archiver.download");
      throw err;
    }
  }


  /**
   * Backs up a directory to cloud storage as a tar.gz archive.
   * Creates a temporary compressed archive and uploads it to the specified location.
   * Note: the archive is a `.tar.gz` sibling of pathServer. The one this call builds is cleaned up
   * on both paths - once uploaded, and before propagating a failure - and a failed cleanup is
   * logged, not thrown. The archive a previous run may have left behind is removed first instead,
   * and that removal does throw: nothing has been done yet that a failure would waste.
   * @param {String} pathServer - Local directory path to backup
   * @param {String} pathCloud - Destination path in cloud storage
   * @throws {Error} If a previous archive cannot be removed, or if compression or upload fails
   */
  async backup(pathServer, pathCloud)
  {
    let fileServer = `${pathServer}.tar.gz`;
    //
    try {
      // If the output file already exists, delete it
      try {
        await Node.fs.promises.rm(fileServer, {force: true});
      }
      catch (err) {
        throw new Error(`Error deleting the old file ${fileServer}: ${err}`);
      }
      //
      // Compress the file into a tar.gz file
      let parentPath = Node.path.dirname(pathServer);
      let dirName = Node.path.basename(pathServer);
      try {
        await Node.tar.create({file: fileServer, cwd: parentPath, gzip: true, portable: true}, [dirName]);
      }
      catch (err) {
        throw new Error(`Error compressing the directory ${pathServer}: ${err}`);
      }
      //
      // Upload the file in the cloud
      try {
        await this.upload(fileServer, pathCloud);
      }
      catch (err) {
        throw new Error(`Error while uploading file ${fileServer}: ${err}`);
      }
      //
      // From here on the backup is already in the cloud: removing the archive is an accessory step,
      // and a failure must not throw away a backup that succeeded
      try {
        await Node.fs.promises.rm(fileServer, {force: true});
      }
      catch (err) {
        // ERROR, not WARN: the backup goes on, so this log is the only trace of the archive left on
        // the disk, as big as the folder it holds
        this.logger.log("ERROR", `Error removing the file ${fileServer} (remove it manually): ${err}`, "Archiver.backup");
      }
    }
    catch (err) {
      this.logger.log("ERROR", err.message, "Archiver.backup");
      //
      // Cleanup: delete the archive being built: it is as big as the folder it holds, and it is a
      // sibling of it - for App.backup, inside the `apps` the server publishes as static content
      try {
        await Node.fs.promises.rm(fileServer, {force: true});
      }
      catch (err1) {
        this.logger.log("WARN", `Error while deleting the file ${fileServer}: ${err1}`, "Archiver.backup");
      }
      //
      throw err;
    }
  }


  /**
   * Backs up a directory to cloud storage as a ZIP archive.
   * Creates a temporary ZIP file and uploads it to the specified location.
   * Note: the archive is a `.zip` sibling of pathServer, and it is cleaned up on both paths - once
   * uploaded, and before propagating a failure; a failed cleanup is logged but does not fail the
   * backup.
   * @param {String} pathServer - Local directory path to backup
   * @param {String} pathCloud - Destination path in cloud storage
   * @throws {Error} If compression or upload fails
   */
  async backupZip(pathServer, pathCloud)
  {
    let fileServer = `${pathServer}.zip`;
    //
    try {
      // Create the ZIP; pipeline resolves when the file is fully written, rejecting on archive/output errors
      let output = Node.fs.createWriteStream(fileServer);
      let archive = Node.archiver.create("zip");
      let written = require("stream/promises").pipeline(archive, output);
      archive.directory(pathServer, false).finalize();
      try {
        await written;
      }
      catch (err) {
        throw new Error(`Error while creating the ZIP file ${fileServer}: ${err}`);
      }
      //
      // Upload the compressed file to the cloud
      try {
        await this.upload(fileServer, pathCloud);
      }
      catch (err) {
        throw new Error(`Error while uploading the file ${fileServer} to the cloud: ${err}`);
      }
      //
      // From here on the backup is already in the cloud: removing the archive is an accessory step,
      // and a failure must not throw away a backup that succeeded
      try {
        await Node.fs.promises.rm(fileServer, {force: true});
      }
      catch (err) {
        // ERROR, not WARN: the backup goes on, so this log is the only trace of the archive left on
        // the disk, as big as the folder it holds
        this.logger.log("ERROR", `Error removing the file ${fileServer} (remove it manually): ${err}`, "Archiver.backupZip");
      }
    }
    catch (err) {
      this.logger.log("ERROR", err.message || err, "Archiver.backupZip");
      //
      // Cleanup: delete the archive being built: it is as big as the folder it holds, and nothing
      // else collects it
      try {
        await Node.fs.promises.rm(fileServer, {force: true});
      }
      catch (err1) {
        this.logger.log("WARN", `Error while deleting the file ${fileServer}: ${err1}`, "Archiver.backupZip");
      }
      //
      throw err;
    }
  }


  /**
   * Removes a directory tree, delegating to the parent when it knows how.
   * A plain `fs.rm` is not enough for a user folder: it holds the `db` tablespace,
   * owned by the DB user with restrictive permissions, that the Node process cannot
   * even traverse (EACCES). Only {@link Node.Server} owns that policy, and the parent
   * is a {@link Node.Child} when the archiver runs inside a session (see `TW/branch.js`).
   * @param {String} path - Directory to remove
   * @throws {Error} If the directory cannot be removed. As in {@link Node.Server#removeDir},
   * the message always names `path`, so a caller does not have to add that context itself
   */
  async removeDir(path)
  {
    if (this.parent.removeDir)
      await this.parent.removeDir(path);
    else {
      // Same contract as the parent: fs.rm names the entry deep inside that failed, not the
      // directory it was asked to remove
      try {
        await Node.fs.promises.rm(path, {recursive: true, force: true});
      }
      catch (err) {
        throw new Error(`Error removing the directory ${path}: ${err.message || err}`, {cause: err});
      }
    }
  }


  /**
   * Restores a directory from a tar.gz archive in cloud storage.
   * Downloads the archive, backs up existing directory if present, and extracts the new content.
   * Includes automatic rollback on failure to preserve existing data.
   * Note: the downloaded archive and the temporary backup directory are cleaned up automatically
   * once the content has been extracted; a failed cleanup is logged but does not fail the restore.
   * @param {String} pathServer - Local directory path to restore to
   * @param {String} pathCloud - Source archive path in cloud storage
   * @param {String} [pathBackup] - Where to park the existing directory while the archive is extracted
   * (default: a `.$$$` sibling of pathServer). Must be on the same filesystem as pathServer. A caller
   * whose parent folder is enumerated as a list of live objects passes a path outside it, so that a
   * failed cleanup cannot leave behind something that reads as one more object
   * @throws {Error} If download or extraction fails. The error carries `dataOnDisk` when the archive
   * had been extracted and the rollback did not put the previous content back, so the caller must not
   * react to the failure by deleting the directory. No step that follows the extraction throws, so
   * today the flag is always false: it is computed anyway, to keep the contract of a step added there
   * in the future
   */
  async restore(pathServer, pathCloud, pathBackup = `${pathServer}.$$$`)
  {
    let fileServer = `${pathServer}.tar.gz`;
    let extracted = false;
    let rolledBack = false;
    //
    // Check if the pathServer exists
    let pathExists = await Node.fs.promises.access(pathServer).then(() => true, err => false);
    //
    try {
      // Download the file from the cloud
      try {
        await this.download(pathCloud, fileServer);
      }
      catch (err) {
        throw new Error(`Error downloading the file ${pathCloud} from the cloud: ${err}`);
      }
      //
      // Rename the old path to a temporary one if it exists
      if (pathExists) {
        try {
          await Node.fs.promises.rename(pathServer, pathBackup);
        }
        catch (err) {
          if (err?.code === "ENOTEMPTY") {
            // Log the error and attempt cleanup
            this.logger.log("WARN", `Directory ${pathBackup} not empty, attempting cleanup`, "Archiver.restore");
            try {
              // Try to remove the backup directory if it exists
              await this.removeDir(pathBackup);
              //
              // Retry the rename
              await Node.fs.promises.rename(pathServer, pathBackup);
              this.logger.log("INFO", `Successfully cleaned up and renamed ${pathServer}`, "Archiver.restore");
            }
            catch (cleanupErr) {
              this.logger.log("ERROR", `Failed to cleanup and rename: ${cleanupErr.message || cleanupErr}`, "Archiver.restore");
              throw new Error(`Cannot prepare for restore - directory conflicts exist: ${cleanupErr.message || cleanupErr}`);
            }
          }
          else
            throw new Error(`Error rename the path ${pathServer} to temporary: ${err}`);
        }
      }
      //
      // Extract the file to parent directory (so that it becomes a pathServer sibling)
      try {
        await Node.tar.extract({file: fileServer, cwd: `${pathServer}/..`});
      }
      catch (err) {
        throw new Error(`Error during the ${fileServer} extraction: ${err}`);
      }
      extracted = true;
      //
      // From here on the restored data is already in place: what follows are accessory steps,
      // and a failure must not throw away a restore that succeeded
      try {
        // Delete the .tar.gz file
        await Node.fs.promises.rm(fileServer, {force: true});
      }
      catch (err) {
        // ERROR, not WARN: the restore goes on, so this log is the only trace of the archive left
        // on the disk, as big as the folder it holds
        this.logger.log("ERROR", `Error deleting the file ${fileServer} (remove it manually): ${err}`, "Archiver.restore");
      }
      //
      // If the path on the server existed already, delete old path
      if (pathExists) {
        try {
          await this.removeDir(pathBackup);
        }
        catch (err) {
          // ERROR, not WARN: the restore goes on, so this log is the only trace of a whole
          // leftover copy of the folder occupying the disk, and what would collect it on its own
          // may never come: a later restore of the same path, or the deletion of a user folder
          this.logger.log("ERROR", `Error deleting the old folder (remove it manually): ${err}`, "Archiver.restore");
        }
      }
    }
    catch (err) {
      // Log the error
      this.logger.log("ERROR", err.message || err, "Archiver.restore");
      //
      // Cleanup: Delete the tar.gz if it exists
      try {
        await Node.fs.promises.rm(fileServer, {force: true});
      }
      catch (err1) {
        this.logger.log("WARN", `Error while deleting the file ${fileServer}: ${err1}`, "Archiver.restore");
      }
      //
      // Cleanup: If the path existed, try to restore the backup
      if (pathExists) {
        try {
          await Node.fs.promises.access(pathBackup);
          //
          // First, try to remove the potentially corrupted directory
          try {
            await this.removeDir(pathServer);
          }
          catch (err1) {
            this.logger.log("WARN", `Error while deleting the directory: ${err1}`, "Archiver.restore");
          }
          //
          // Then restore the backup renaming it back
          try {
            await Node.fs.promises.rename(pathBackup, pathServer);
            rolledBack = true;
          }
          catch (err1) {
            this.logger.log("WARN", `Error while restoring backup directory ${pathBackup}: ${err1}`, "Archiver.restore");
          }
        }
        catch {
          // The path existed but the backup path does not exist -> there is nothing else to do
        }
      }
      //
      // Tell the caller whether the disk holds restored data that must not be thrown away: the
      // rollback above is best-effort, so only the rename that went through proves the folder is
      // back to the content it had before the command
      err.dataOnDisk = extracted && !rolledBack;
      //
      // Re-throw the original error
      throw err;
    }
  }


  /**
   * Gets list of files from Google Cloud Storage bucket.
   * Retrieves all files matching the specified path prefix.
   * @param {String} path - Path prefix to filter files in the bucket
   * @returns {Promise<String[]>} Array of file names with their full paths
   * @throws {Error} If reading from GCloud fails
   */
  async getFiles(path)
  {
    try {
      let [files] = await this.indertBucket.getFiles({prefix: path});
      return files.map(file => file.metadata.name);
    }
    catch (err) {
      this.logger.log("ERROR", `Error while reading files list from GCloud: ${err}`, "Archiver.getFiles", {path});
      throw new Error(`Error while reading files list from GCloud: ${err}`, {cause: err});
    }
  }


  /**
   * Deletes a file from cloud storage or local filesystem.
   * Handles both Google Cloud Storage and local file deletion.
   * @param {String} path - File path to delete (cloud storage path or local path)
   * @throws {Error} If deletion fails
   */
  async deleteFile(path)
  {
    if (this.indertBucket) {
      let file = this.indertBucket.file(path);
      await file.delete();
    }
    else {
      // Try to delete the file from the local filesystem
      let fs = require("fs-extra");
      await fs.remove(path);
    }
  }


  /**
   * Stores an object in cloud storage or local filesystem as JSON.
   * Automatically serializes objects to JSON format before saving.
   * Supports both object and string input types.
   * @param {String} pathCloud - Destination path in cloud storage or local filesystem
   * @param {Object|String} obj - Object to store (will be JSON stringified if object)
   * @throws {Error} If upload or write operation fails
   */
  async saveObject(pathCloud, obj)
  {
    let data = typeof obj === "object" ? JSON.stringify(obj) : obj;
    //
    // If the storage is gcloud
    if (this.useGCloud()) {
      try {
        await this.indertBucket.file(pathCloud).save(data, {resumable: false});
      }
      catch (err) {
        this.logger.log("ERROR", `Error uploading the object in GCloud storage (${pathCloud}): ${err}`, "Archiver.saveObject");
        throw err;
      }
    }
    else
      await require("fs-extra").outputFile(pathCloud, data);
  }


  /**
   * Reads and parses a JSON object from cloud storage or local filesystem.
   * Automatically deserializes JSON content to JavaScript object.
   * Returns empty object if content is empty.
   * @param {String} pathCloud - Source path in cloud storage or local filesystem
   * @returns {Promise<Object>} The parsed JavaScript object
   * @throws {Error} If read operation fails or JSON parsing fails
   */
  async readObject(pathCloud)
  {
    // If the storage is gcloud
    let txt;
    if (this.useGCloud()) {
      try {
        let [buf] = await this.indertBucket.file(pathCloud).download();
        txt = buf.toString();
      }
      catch (err) {
        this.logger.log("WARN", `Error reading the object from GCloud storage (${pathCloud}): ${err}`, "Archiver.readObject");
        let wrapped = new Error(`Error reading the object from GCloud storage (${pathCloud}): ${err}`);
        //
        // Normalize the GCS "file not found" to the "ENOENT" code, consistent with local fs.readFile:
        // the SDK's ApiError exposes the HTTP status in err.code (404 = missing object), so the catch
        // in Child.exportComponent can recognise the "first export" case (issue #13858)
        if (err?.code === 404)
          wrapped.code = "ENOENT";
        throw wrapped;
      }
    }
    else {
      let fs = require("fs-extra");
      txt = await fs.readFile(pathCloud, "utf8");
    }
    //
    return txt ? JSON.parse(txt) : {};
  }


  /**
   * Creates a ZIP archive from a file or directory.
   * Supports adding custom suffix to archived file names through options.
   * @param {String} fullPath - Path to file or directory to compress
   * @param {Object} [options] - Compression options
   * @param {String} [options.suffix] - Suffix to add to archived file names
   * @returns {Promise<Object>} Object with fileName and filePath properties
   * @throws {Error} If compression fails
   */
  async zip(fullPath, options)
  {
    let outputFile = `${fullPath}.zip`;
    //
    try {
      let stats = await Node.fs.promises.stat(fullPath);
      let baseName = Node.path.basename(fullPath);
      let zipElementName = options?.suffix ? baseName + options.suffix : baseName;
      //
      let output = Node.fs.createWriteStream(outputFile);
      let archive = Node.archiver.create("zip");
      // pipeline resolves when the ZIP is fully written, rejecting on archive/output errors
      let written = require("stream/promises").pipeline(archive, output);
      //
      if (stats.isDirectory())
        archive.directory(fullPath, zipElementName);
      else
        archive.file(fullPath, {name: zipElementName});
      archive.finalize();
      //
      await written;
      return {fileName: baseName, filePath: outputFile};
    }
    catch (err) {
      this.logger.log("ERROR", err.message || err, "Archiver.zip");
      throw err;
    }
  }


  /**
   * Extracts a ZIP file to a specified directory.
   * Uses the framework's secure extraction utility with path traversal protection.
   * @param {String} sourceZipPath - Path to the ZIP file to extract
   * @param {String} destinationDirPath - Directory where the ZIP contents will be extracted
   * @returns {Promise<Boolean>} true if extraction succeeds, false otherwise
   */
  async unzip(sourceZipPath, destinationDirPath)
  {
    try {
      // Use the common utility function with security check enabled
      await Node.Utils.extractZip(sourceZipPath, destinationDirPath, {checkPathSecurity: true});
      return true;
    }
    catch (err) {
      this.logger.log("ERROR", err.message || err, "Archiver.unzip");
      return false;
    }
  }
};


// Export the class
module.exports = Node.Archiver;
