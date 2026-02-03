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
  // If the storage is gcloud
  if (this.useGCloud()) {
    let file = this.indertBucket.file(pathCloud);
    let readStream = Node.fs.createReadStream(pathFile);
    let writeStream = file.createWriteStream({resumable: false});
    //
    return new Promise((resolve, reject) => {
      readStream.pipe(writeStream);
      //
      readStream.on("error", err => {
        this.logger.log("ERROR", `Error reading the file ${pathFile}: ${err}`, "Archiver.upload");
        reject(new Error(`Error reading the file ${pathFile}: ${err}`));
      });
      writeStream.on("error", err => {
        this.logger.log("ERROR", `Error writing the file ${pathFile} to GCloud ${pathCloud}: ${err}`, "Archiver.upload");
        reject(new Error(`Error writing the file ${pathFile} to GCloud ${pathCloud}: ${err}`));
      });
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
      this.logger.log("ERROR", `Error writing the file ${pathFile} to local file ${pathCloud}: ${err}`, "Archiver.upload");
      throw new Error(`Error writing the file ${pathFile} to local file ${pathCloud}: ${err}`);
    }
  }
};


/**
 * Download a file from the cloud
 * @param {string} pathCloud
 * @param {string} pathFile
 * @param {function} callback - function(err)
 */
Node.Archiver.prototype.download = function (pathCloud, pathFile, callback)
{
  // Path cloud is needed!
  if (!pathCloud) {
    this.logger.log("WARN", "Missing file name", "Archiver.download");
    return callback("Missing file name");
  }
  //
  // First, if the pathCloud is an URL, download the file directly
  if (pathCloud.toLowerCase().startsWith("http://") || pathCloud.toLowerCase().startsWith("https://")) {
    // Handle only HTTP and HTTPS
    let request = (pathCloud.toLowerCase().startsWith("http://") ? Node.http : Node.https).get(pathCloud, function (resp) {
      resp.pipe(Node.fs.createWriteStream(pathFile));
      resp.on("end", function () {
        // Handle HTTP's STATUS CODE
        if (resp.statusCode >= 400)
          callback(`Wrong reply: ${resp.statusCode}`);
        else
          callback();
      });
    });
    request.on("error", callback);
    //
    // Do nothing and wait for download to complete
    return;
  }
  //
  // If the storage is gcloud
  if (this.useGCloud()) {
    let file = this.indertBucket.file(pathCloud);
    let readStream = file.createReadStream();
    let writeStream = Node.fs.createWriteStream(pathFile);
    readStream.pipe(writeStream);
    //
    // NOTE: if there are READ errors (i.e. the file is not there) the gcloud module notifies
    // the "read.error" AND "finish" events!!!!
    let readError;
    readStream.on("error", err => {
      readError = true;
      this.logger.log("ERROR", `Error while reading the file ${pathCloud} from GCloud: ${err}`, "Archiver.download");
      callback(err);
      //
      // In this particular case an empty file remains here. Delete it!
      writeStream.end();
      Node.fs.rm(pathFile, {force: true}, () => {
      });
    });
    writeStream.on("error", err => {
      this.logger.log("ERROR", `Error while writing the file ${pathFile}: ${err}`, "Archiver.download");
      callback(err);
    });
    writeStream.on("finish", () => {
      if (!readError)
        callback();
    });
  }
  else {
    // Supponiamo che il file sia locale
    let fs = require("fs-extra");
    fs.copy(pathCloud, pathFile, err => {
      if (err) {
        this.logger.log("ERROR", `Error writing the file ${pathCloud} to local file ${pathFile}: ${err}`, "Archiver.download");
        callback(`Error writing the file ${pathCloud} to local file ${pathFile}: ${err}`);
      }
      else
        callback();
    });
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
  let pathExists;
  //
  // Check if the pathServer exists
  try {
    await Node.fs.promises.access(pathServer);
    pathExists = true;
  }
  catch {
    pathExists = false;
  }
  //
  try {
    // Download the file from the cloud
    try {
      await new Promise((resolve, reject) => {
        this.download(pathCloud, fileServer, err => {
          if (err)
            reject(err);
          else
            resolve();
        });
      });
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
        if (err && err.code !== "ENOTEMPTY")
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
 * @param {function} callback - function(err, [files])
 */
Node.Archiver.prototype.getFiles = function (path, callback)
{
  this.indertBucket.getFiles({prefix: path}, (err, files, nextQuery, apiResponse) => {
    if (err) {
      this.logger.log("ERROR", `Error while reading files list from GCloud: ${err}`, "Archiver.getFiles", {path});
      return callback(`Error while reading files list from GCloud: ${err}`);
    }
    //
    let result = [];
    for (let i = 0; i < files.length; i++)
      result.push(files[i].metadata.name);
    //
    callback(null, result);
  });
};


/**
 * Delete file in path on gcloud bucket
 * @param {string} path
 * @param {function} callback - function(err)
 */
Node.Archiver.prototype.deleteFile = function (path, callback)
{
  if (this.indertBucket) {
    let file = this.indertBucket.file(path);
    file.delete(callback);
  }
  else {
    // Provo a cancellare il file in locale
    let fs = require("fs-extra");
    fs.remove(path, callback);
  }
};


/**
 * Stores an object in the cloud
 * @param {string} pathCloud
 * @param {object} obj - object to store (as JSON string)
 * @param {function} callback - function(err)
 */
Node.Archiver.prototype.saveObject = function (pathCloud, obj, callback)
{
  // If the storage se is gcloud
  if (this.useGCloud()) {
    let file = this.indertBucket.file(pathCloud);
    //
    // copy the file into the cloud
    let wsFile = file.createWriteStream({resumable: false});
    wsFile.on("finish", () => callback());
    wsFile.on("error", err => {
      callback(err);
      this.logger.log("ERROR", `Error uploading the object in GCloud storage (${pathCloud}): ${err}`, "Archiver.saveObject");
    });
    //
    if (typeof obj === "object")
      wsFile.write(JSON.stringify(obj));
    else
      wsFile.write(obj);
    wsFile.end();
  }
  else {
    let fs = require("fs-extra");
    fs.outputFile(pathCloud, typeof obj === "object" ? JSON.stringify(obj) : obj, callback);
  }
};


/**
 * Restore an object from the cloud
 * @param {string} pathCloud
 * @param {function} callback - function(obj, err)
 */
Node.Archiver.prototype.readObject = function (pathCloud, callback)
{
  // If the storage se is gcloud
  if (this.useGCloud()) {
    let file = this.indertBucket.file(pathCloud);
    let rsFile = file.createReadStream();
    rsFile.read();
    //
    let txt = "";
    rsFile.on("data", chunk => txt += chunk);
    rsFile.on("finish", () => {
      if (txt !== null)   // ERROR (see error handler)
        callback(txt ? JSON.parse(txt) : {});
    });
    rsFile.on("error", err => {
      err = err.message || err;
      txt = null;   // The FINISH event gets fired anyway (see previous handler)
      //
      this.logger.log("WARN", `Error reading the object from GCloud storage (${pathCloud}): ${err}`, "Archiver.readObject");
      callback(null, err);
    });
  }
  else {
    let fs = require("fs-extra");
    fs.readFile(pathCloud, "utf8", (err, txt) => {
      if (err)
        callback(null, err);
      else
        callback(txt ? JSON.parse(txt) : {});
    });
  }
};

Node.Archiver.prototype.zip = async function (fullPath, options) {
  let outputFile = `${fullPath}.zip`;
  //
  try {
    return new Promise((resolve, reject) => {
      let output = Node.fs.createWriteStream(outputFile);      
      let archive = Node.archiver.create("zip");
      const baseName = Node.path.basename(fullPath);
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
      const stats = Node.fs.statSync(fullPath);
      const zipElementName = options?.suffix ? baseName + options.suffix : baseName;
      if (stats.isDirectory())
        archive.directory(fullPath, zipElementName);
      else
        archive.file(fullPath, { name: zipElementName });
      archive.finalize();
    });
  }
  catch (err) {
    this.logger.log("ERROR", err.message || err, "Archiver.zip");
    throw err;
  }
}

Node.Archiver.prototype.unzip = async function (sourceZipPath, destinationDirPath) {
  const fs = Node.fs;
  const path = Node.path;
  const yauzl = require("yauzl");

  try {
    // Assicurati che la directory di destinazione esista
    await fs.promises.mkdir(destinationDirPath, {recursive: true});

    // Apri il file ZIP
    const openZip = (filePath, options) => {
      return new Promise((resolve, reject) => {
        yauzl.open(filePath, options, (err, zipFile) => {
          if (err)
            return reject(err);
          resolve(zipFile);
        });
      });
    };

    const zipFile = await openZip(sourceZipPath, {lazyEntries: true});

    const processEntry = async (entry) => {
      const entryPath = path.join(destinationDirPath, entry.fileName);

      // Normalizza il percorso per evitare percorsi relativi malevoli
      const normalizedPath = path.normalize(entryPath);

      if (!normalizedPath.startsWith(destinationDirPath)) {
        throw new Error(`Tentativo di estrazione al di fuori della directory: ${normalizedPath}`);
      }

      if (/\/$/.test(entry.fileName)) {
        // Entry è una directory
        await fs.promises.mkdir(normalizedPath, {recursive: true});
      }
      else {
        // Entry è un file
        await fs.promises.mkdir(path.dirname(normalizedPath), {recursive: true}); // Crea la directory genitore
        return new Promise((resolve, reject) => {
          zipFile.openReadStream(entry, (err, readStream) => {
            if (err)
              return reject(err);

            const writeStream = fs.createWriteStream(normalizedPath);
            readStream.pipe(writeStream);

            readStream.on("end", () => resolve());
            readStream.on("error", (err) => reject(err));
            writeStream.on("error", (err) => reject(err));
          });
        });
      }
    };

    // Itera attraverso le entry
    const readEntries = () => {
      return new Promise((resolve, reject) => {
        zipFile.readEntry();
        zipFile.on("entry", async (entry) => {
          try {
            await processEntry(entry);
            zipFile.readEntry(); // Leggi la prossima entry
          }
          catch (err) {
            reject(err);
          }
        });
        zipFile.on("end", resolve); // Completamento
        zipFile.on("error", reject); // Errori
      });
    };

    await readEntries();
    zipFile.close();

    return true;
  }
  catch (e) {
    console.error("Errore durante l'unzip:", e);
    this.lastError = e.message;
    return false;
  }
};


// Export the class
module.exports = Node.Archiver;
