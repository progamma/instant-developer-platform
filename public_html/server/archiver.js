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
 * @class Represents an Instant Developer Archiver
 * @param {Node.Server/Node.Child} par
 * @param {type} nightly
 */
Node.Archiver = function (par, nightly)
{
  this.parent = par;
  //
  if (this.useGCloud()) {
    let storage = new Node.googleCloudStorage(JSON.parse(JSON.stringify(this.config.configGCloudStorage)));
    if (nightly)
      this.indertBucket = storage.bucket(this.config.nigthlybucketGCloud);
    else
      this.indertBucket = storage.bucket(this.config.bucketGCloud);
  }
};


// Define usefull properties for this object
Object.defineProperties(Node.Archiver.prototype, {
  config: {
    get() {
      return this.parent.config;
    }
  },
  logger: {
    get() {
      return this.parent.logger;
    }
  }
});


/**
 * Checks whether to use Google Cloud Storage for archiving
 * @returns {boolean} true if the project is not IDF and storage is configured as "gcloud"
 */
Node.Archiver.prototype.useGCloud = function ()
{
  return !this.parent.doc?.prj.isIDF() && this.config.storage === "gcloud";
};


/**
 * Upload a file in the cloud
 * @param {string} pathFile
 * @param {string} pathCloud
 */
Node.Archiver.prototype.upload = async function (pathFile, pathCloud)
{
  try {
    // If the storage is gcloud
    if (this.useGCloud()) {
      let file = this.indertBucket.file(pathCloud);
      let readStream = Node.fs.createReadStream(pathFile);
      let writeStream = file.createWriteStream({resumable: false});
      //
      await new Promise((resolve, reject) => {
        readStream.pipe(writeStream);
        //
        readStream.on("error", err => reject(new Error(`Error reading the file ${pathFile}: ${err}`)));
        writeStream.on("error", err => reject(new Error(`Error writing the file ${pathFile} to GCloud ${pathCloud}: ${err}`)));
        writeStream.on("finish", () => resolve());
      });
    }
    else {
      // Supponiamo che il file sia locale
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
};


/**
 * Download a file from the cloud
 * @param {string} pathCloud
 * @param {string} pathFile
 */
Node.Archiver.prototype.download = async function (pathCloud, pathFile)
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
        let request = (pathCloud.toLowerCase().startsWith("http://") ? Node.http : Node.https).get(pathCloud, resp => {
          // Check status code before piping
          if (resp.statusCode >= 400) {
            reject(new Error(`Wrong reply: ${resp.statusCode}`));
            return;
          }
          //
          let writeStream = Node.fs.createWriteStream(pathFile);
          resp.pipe(writeStream);
          //
          // Listen to writeStream's finish event, not response's end event
          // The "end" event on response only means data was received, not written to disk
          writeStream.on("finish", resolve);
          writeStream.on("error", reject);
        });
        request.on("error", reject);
      });
    }
    //
    // If the storage is gcloud
    if (this.useGCloud()) {
      await new Promise((resolve, reject) => {
        let file = this.indertBucket.file(pathCloud);
        let readStream = file.createReadStream();
        let writeStream = Node.fs.createWriteStream(pathFile);
        let rejected = false;
        readStream.pipe(writeStream);
        //
        // NOTE: if there are READ errors (i.e. the file is not there) the gcloud module notifies
        // the "read.error" AND "finish" events!!!!
        readStream.on("error", err => {
          rejected = true;
          // In this particular case an empty file remains here. Delete it!
          writeStream.end();
          Node.fs.rm(pathFile, {force: true}, () => reject(err));
        });
        writeStream.on("error", reject);
        writeStream.on("finish", () => {
          if (!rejected)
            resolve();
        });
      });
    }
    else {
      // Supponiamo che il file sia locale
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
};


/**
 * Backup the given pathServer in the cloud as a tar.gz file
 * @param {string} pathServer
 * @param {string} pathCloud
 */
Node.Archiver.prototype.backup = async function (pathServer, pathCloud)
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
    // Remove the compressed file
    try {
      await Node.fs.promises.rm(fileServer, {force: true});
    }
    catch (err) {
      throw new Error(`Error removing the file ${fileServer}: ${err}`);
    }
  }
  catch (err) {
    this.logger.log("ERROR", err.message, "Archiver.backup");
    throw err;
  }
};


/**
 * Backup the project located at pathServer into pathS3 on AWS as a zip
 * @param {string} pathServer
 * @param {string} pathCloud
 */
Node.Archiver.prototype.backupZip = async function (pathServer, pathCloud)
{
  let fileServer = `${pathServer}.zip`;
  //
  try {
    await new Promise((resolve, reject) => {
      let output = Node.fs.createWriteStream(fileServer);
      let archive = Node.archiver.create("zip");
      //
      output.on("close", async () => {
        try {
          await this.upload(fileServer, pathCloud);
        }
        catch (err) {
          reject(new Error(`Error while uploading the file ${fileServer} to the cloud: ${err}`));
          return;
        }
        //
        // Remove the compressed file
        try {
          await Node.fs.promises.rm(fileServer, {force: true});
          resolve();
        }
        catch (err) {
          reject(new Error(`Error removing the file ${fileServer}: ${err}`));
        }
      });
      //
      output.on("error", err => reject(new Error(`Error while writing the ZIP file ${fileServer}: ${err}`)));
      archive.on("error", err => reject(new Error(`Error while compressing the file ${fileServer}: ${err}`)));
      //
      archive.pipe(output);
      archive.directory(pathServer, false).finalize();
    });
  }
  catch (err) {
    this.logger.log("ERROR", err.message || err, "Archiver.backupZip");
    throw err;
  }
};


/**
 * Restore a file from the cloud
 * @param {string} pathServer
 * @param {string} pathCloud
 */
Node.Archiver.prototype.restore = async function (pathServer, pathCloud)
{
  let fileServer = `${pathServer}.tar.gz`;
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
        await Node.fs.promises.rename(pathServer, `${pathServer}.$$$`);
      }
      catch (err) {
        if (err?.code === "ENOTEMPTY") {
          // Log the error and attempt cleanup
          this.logger.log("WARN", `Directory ${pathServer}.$$$ not empty, attempting cleanup`, "Archiver.restore");
          try {
            // Try to remove the backup directory if it exists
            await Node.fs.promises.rm(`${pathServer}.$$$`, {recursive: true, force: true});
            //
            // Retry the rename
            await Node.fs.promises.rename(pathServer, `${pathServer}.$$$`);
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
    //
    try {
      // Delete the .tar.gz file
      await Node.fs.promises.rm(fileServer, {force: true});
    }
    catch (err) {
      throw new Error(`Error delering the file ${fileServer}: ${err}`);
    }
    //
    // If the path on the server existed already, delete old path
    if (pathExists) {
      try {
        await Node.fs.promises.rm(`${pathServer}.$$$`, {recursive: true, force: true});
      }
      catch (err) {
        throw new Error(`Error deleting the old folder ${pathServer}.$$$: ${err}`);
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
        await Node.fs.promises.access(`${pathServer}.$$$`);
        //
        // First, try to remove the potentially corrupted directory
        try {
          await Node.fs.promises.rm(pathServer, {recursive: true, force: true});
        }
        catch (err1) {
          this.logger.log("WARN", `Error while deleting the directory ${pathServer}: ${err1}`, "Archiver.restore");
        }
        //
        // Then restore the .$$$ (backup) renaming it back
        try {
          await Node.fs.promises.rename(`${pathServer}.$$$`, pathServer);
        }
        catch (err1) {
          this.logger.log("WARN", `Error while restoring backup directory ${pathServer}.$$$: ${err1}`, "Archiver.restore");
        }
      }
      catch {
        // The path existed but the .$$$ path does not exist -> there is nothing else to do
      }
    }
    //
    // Re-throw the original error
    throw err;
  }
};


/**
 * Get list of files in path on gcloud bucket
 * @param {string} path
 * @returns {Promise<string[]>} Array of file names
 */
Node.Archiver.prototype.getFiles = async function (path)
{
  return await new Promise((resolve, reject) => {
    this.indertBucket.getFiles({prefix: path}, (err, files, nextQuery, apiResponse) => {
      if (err) {
        this.logger.log("ERROR", `Error while reading files list from GCloud: ${err}`, "Archiver.getFiles", {path});
        return reject(new Error(`Error while reading files list from GCloud: ${err}`));
      }
      //
      resolve(files.map(file => file.metadata.name));
    });
  });
};


/**
 * Delete file in path on gcloud bucket
 * @param {string} path
 */
Node.Archiver.prototype.deleteFile = async function (path)
{
  if (this.indertBucket) {
    await new Promise((resolve, reject) => {
      let file = this.indertBucket.file(path);
      file.delete(err => err ? reject(err) : resolve());
    });
  }
  else {
    // Provo a cancellare il file in locale
    let fs = require("fs-extra");
    await fs.remove(path);
  }
};


/**
 * Stores an object in the cloud
 * @param {string} pathCloud
 * @param {object} obj - object to store (as JSON string)
 */
Node.Archiver.prototype.saveObject = async function (pathCloud, obj)
{
  // If the storage se is gcloud
  if (this.useGCloud()) {
    let file = this.indertBucket.file(pathCloud);
    //
    // copy the file into the cloud
    await new Promise((resolve, reject) => {
      let wsFile = file.createWriteStream({resumable: false});
      wsFile.on("finish", resolve);
      wsFile.on("error", err => {
        this.logger.log("ERROR", `Error uploading the object in GCloud storage (${pathCloud}): ${err}`, "Archiver.saveObject");
        reject(err);
      });
      //
      if (typeof obj === "object")
        wsFile.write(JSON.stringify(obj));
      else
        wsFile.write(obj);
      //
      wsFile.end();
    });
  }
  else {
    let fs = require("fs-extra");
    await fs.outputFile(pathCloud, typeof obj === "object" ? JSON.stringify(obj) : obj);
  }
};


/**
 * Restore an object from the cloud
 * @param {string} pathCloud
 * @returns {Promise<object>} The parsed object or throws an error
 */
Node.Archiver.prototype.readObject = async function (pathCloud)
{
  // If the storage se is gcloud
  let txt = "";
  if (this.useGCloud()) {
    await new Promise((resolve, reject) => {
      let file = this.indertBucket.file(pathCloud);
      let rsFile = file.createReadStream();
      rsFile.read();
      //
      rsFile.on("data", chunk => txt += chunk);
      rsFile.on("finish", resolve);
      rsFile.on("error", err => {
        this.logger.log("WARN", `Error reading the object from GCloud storage (${pathCloud}): ${err}`, "Archiver.readObject");
        reject(new Error(`Error reading the object from GCloud storage (${pathCloud}): ${err}`));
      });
    });
  }
  else {
    let fs = require("fs-extra");
    txt = await fs.readFile(pathCloud, "utf8");
  }
  //
  return txt ? JSON.parse(txt) : {};
};


Node.Archiver.prototype.zip = async function (fullPath, options)
{
  let outputFile = `${fullPath}.zip`;
  //
  try {
    return new Promise((resolve, reject) => {
      let output = Node.fs.createWriteStream(outputFile);      
      let archive = Node.archiver.create("zip");
      let baseName = Node.path.basename(fullPath);
      //
      output.on("close", async () => {
        try {
          resolve({fileName : baseName, filePath: outputFile});
        }
        catch (err) {
          reject(new Error(`Error removing the file ${outputFile}: ${err}`));
        }
      });
      //
      output.on("error", err => reject(new Error(`Error while writing the ZIP file ${outputFile}: ${err}`)));
      archive.on("error", err => reject(new Error(`Error while compressing the file ${outputFile}: ${err}`)));
      //
      archive.pipe(output);
      //
      let stats = Node.fs.statSync(fullPath);
      let zipElementName = options?.suffix ? baseName + options.suffix : baseName;
      if (stats.isDirectory())
        archive.directory(fullPath, zipElementName);
      else
        archive.file(fullPath, {name: zipElementName});
      archive.finalize();
    });
  }
  catch (err) {
    this.logger.log("ERROR", err.message || err, "Archiver.zip");
    throw err;
  }
}


/**
 * Extracts a ZIP file to a specified directory
 * @param {string} sourceZipPath - Path to the ZIP file to extract
 * @param {string} destinationDirPath - Directory where the ZIP contents will be extracted
 * @returns {boolean} true if extraction succeeds, false otherwise
 */
Node.Archiver.prototype.unzip = async function (sourceZipPath, destinationDirPath)
{
  let fs = Node.fs;
  let path = Node.path;
  let yauzl = require("yauzl");
  //
  try {
    // Ensure the destination directory exists
    await fs.promises.mkdir(destinationDirPath, {recursive: true});
    //
    // Open the ZIP file
    let openZip = (filePath, options) => {
      return new Promise((resolve, reject) => {
        yauzl.open(filePath, options, (err, zipFile) => err ? reject(err) : resolve(zipFile));
      });
    };
    //
    let zipFile = await openZip(sourceZipPath, {lazyEntries: true});
    let processEntry = async (entry) => {
      let entryPath = path.join(destinationDirPath, entry.fileName);
      //
      // Normalize the path to prevent malicious relative paths
      let normalizedPath = path.normalize(entryPath);
      if (!normalizedPath.startsWith(destinationDirPath))
        throw new Error(`Attempted extraction outside of directory: ${normalizedPath}`);
      //
      if (Node.Utils.isZipEntryDirectory(entry)) {
        // Entry is a directory
        await fs.promises.mkdir(normalizedPath, {recursive: true});
      }
      else {
        // Entry is a file
        await fs.promises.mkdir(path.dirname(normalizedPath), {recursive: true}); // Create parent directory
        return new Promise((resolve, reject) => {
          zipFile.openReadStream(entry, (err, readStream) => {
            if (err)
              return reject(err);
            //
            let writeStream = fs.createWriteStream(normalizedPath);
            readStream.pipe(writeStream);
            //
            readStream.on("end", () => resolve());
            readStream.on("error", (err) => reject(err));
            writeStream.on("error", (err) => reject(err));
          });
        });
      }
    };
    //
    // Iterate through entries
    let readEntries = () => {
      return new Promise((resolve, reject) => {
        zipFile.readEntry();
        zipFile.on("entry", async (entry) => {
          try {
            await processEntry(entry);
            zipFile.readEntry(); // Read next entry
          }
          catch (err) {
            reject(err);
          }
        });
        zipFile.on("end", resolve); // Completion
        zipFile.on("error", reject); // Errors
      });
    };
    //
    await readEntries();
    zipFile.close();
    //
    return true;
  }
  catch (err) {
    this.logger.log("ERROR", err.message || err, "Archiver.unzip");
    return false;
  }
};


// Export the class
module.exports = Node.Archiver;
