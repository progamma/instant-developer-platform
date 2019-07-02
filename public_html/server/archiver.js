/*
 * Instant Developer Next
 * Copyright Pro Gamma Spa 2000-2016
 * All rights reserved
 */
/* global require, module */

var Node = Node || {};

// Import classes
Node.Utils = require("./utils");

// Import Modules
Node.tar = require("tar");
Node.archiver = require("archiver");
Node.AWS = require("aws-sdk");
Node.rimraf = require("rimraf");
Node.fs = require("fs");
Node.googleCloudStorage = require("@google-cloud/storage");
Node.http = require("http");
Node.https = require("https");


/**
 * @class Represents an Instant Developer Archiver
 * @param {Node.Server/Node.Child} par
 * @param {type} nightly
 */
Node.Archiver = function (par, nightly)
{
  this.parent = par;
  //
  if (this.config.storage === "gcloud") {
    var storage = Node.googleCloudStorage(this.config.configGCloudStorage);
    if (nightly)
      Node.indertBucket = storage.bucket(this.config.nigthlybucketGCloud);
    else
      Node.indertBucket = storage.bucket(this.config.bucketGCloud);
  }
};


// Define usefull properties for this object
Object.defineProperties(Node.Archiver.prototype, {
  config: {
    get: function () {
      return this.parent.config;
    }
  },
  logger: {
    get: function () {
      return this.parent.logger;
    }
  }
});


/**
 * Upload a file in the cloud
 * @param {string} pathFile
 * @param {string} pathCloud
 * @param {function} callback - function(err)
 */
Node.Archiver.prototype.upload = function (pathFile, pathCloud, callback)
{
  var pthis = this;
  //
  // If the storage is gcloud
  if (this.config.storage === "gcloud") {
    var file = Node.indertBucket.file(pathCloud);
    var readStream = Node.fs.createReadStream(pathFile);
    var writeStream = file.createWriteStream({resumable: false});
    readStream.pipe(writeStream);
    //
    readStream.on("error", function (err) {
      pthis.logger.log("ERROR", "Error reading the file " + pathFile + ": " + err, "Archiver.upload");
      callback("Error reading the file " + pathFile + ": " + err);
    });
    writeStream.on("error", function (err) {
      pthis.logger.log("ERROR", "Error writing the file " + pathFile + " to GCloud " + pathCloud + ": " + err, "Archiver.upload");
      callback("Error writing the file " + pathFile + " to GCloud " + pathCloud + ": " + err);
    });
    writeStream.on("finish", function () {
      callback();
    });
  }
  else if (this.config.storage === "aws") {  // If the storage is S3
    // Read the full file
    Node.fs.readFile(pathFile, function (err, data) {
      if (err) {
        pthis.log("ERROR", "Error reading the file " + pathFile + ": " + err, "Archiver.upload");
        return callback("Error reading the file " + pathFile + ": " + err);
      }
      //
      Node.AWS.config.update(pthis.config.configS3);
      var S3 = new Node.AWS.S3();
      S3.putObject({Bucket: pthis.config.bucketS3, Key: pathCloud, Body: data}, function (err) {
        if (err) {
          pthis.logger.log("ERROR", "Error uploading the file " + pathFile + " to S3 " + pathCloud + ": " + err, "Archiver.upload");
          return callback("Error uploading the file " + pathFile + " to S3 " + pathCloud + ": " + err);
        }
        //
        callback();
      });
    });
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
  var pthis = this;
  //
  // Path cloud is needed!
  if (!pathCloud) {
    this.logger.log("WARN", "Missing file name", "Archiver.download");
    return callback("Missing file name");
  }
  //
  // First, if the pathCloud is an URL, download the file directly
  if (pathCloud.toLowerCase().startsWith("http://") || pathCloud.toLowerCase().startsWith("https://")) {
    // Handle only HTTP and HTTPS
    var request = (pathCloud.toLowerCase().startsWith("http://") ? Node.http : Node.https).get(pathCloud, function (resp) {
      resp.pipe(Node.fs.createWriteStream(pathFile));
      resp.on("end", function () {
        // Handle HTTP's STATUS CODE
        if (resp.statusCode >= 400)
          callback("Wrong reply: " + resp.statusCode);
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
  if (this.config.storage === "gcloud") {
    var file = Node.indertBucket.file(pathCloud);
    var readStream = file.createReadStream();
    var writeStream = Node.fs.createWriteStream(pathFile);
    readStream.pipe(writeStream);
    //
    // NOTE: if there are READ errors (i.e. the file is not there) the gcloud module notifies
    // the "read.error" AND "finish" events!!!!
    var readError;
    readStream.on("error", function (err) {
      readError = true;
      pthis.logger.log("ERROR", "Error while reading the file " + pathCloud + " from GCloud: " + err, "Archiver.download");
      callback(err);
      //
      // In this particular case an empty file remains here. Delete it!
      Node.rimraf(pathFile, function () {
      });
    });
    writeStream.on("error", function (err) {
      pthis.logger.log("ERROR", "Error while writing the file " + pathFile + ": " + err, "Archiver.download");
      callback(err);
    });
    writeStream.on("finish", function () {
      if (!readError)
        callback();
    });
  }
  else if (this.config.storage === "aws") {
    Node.AWS.config.update(this.config.configS3);
    var S3 = new Node.AWS.S3();
    //
    S3.getObject({Bucket: this.config.bucketS3, Key: pathCloud}, function (err, data) {
      if (err) {
        pthis.logger.log("ERROR", "Error while downloading the file " + pathCloud + " from S3: " + err, "Archiver.download");
        return callback("Error while downloading the file " + pathCloud + " from S3: " + err);
      }
      //
      Node.fs.writeFile(pathFile, data.Body, function (err) {
        if (err) {
          pthis.logger.log("ERROR", "Error while writing the file " + pathFile + ": " + err, "Archiver.download");
          return callback("Error while writing the file " + pathFile + ": " + err);
        }
        //
        callback();
      });
    });
  }
};


/**
 * Backup the given pathServer in the cloud as a tar.gz file
 * @param {string} pathServer
 * @param {string} pathCloud
 * @param {function} callback - function(err)
 */
Node.Archiver.prototype.backup = function (pathServer, pathCloud, callback)
{
  var pthis = this;
  //
  var fileServer = pathServer + ".tar.gz";
  //
  // If the output file already exists, delete it
  Node.rimraf(fileServer, function (err) {
    if (err) {
      pthis.logger.log("ERROR", "Error removing the old file " + fileServer + ": " + err, "Archiver.backup");
      return callback("Error deleting the old file " + fileServer + ": " + err);
    }
    //
    // Ccompress the file into a tar.gz file
    var parentPath = pathServer.substring(0, pathServer.lastIndexOf("/"));
    var dirName = pathServer.substring(pathServer.lastIndexOf("/") + 1);
    Node.tar.create({file: fileServer, cwd: parentPath, gzip: true, portable: true}, [dirName], function (err) {
      if (err) {
        pthis.logger.log("ERROR", "Error compressing the directory " + pathServer + ": " + err, "Archiver.backup");
        return callback("Error compressing the directory " + pathServer + ": " + err);
      }
      //
      // Upload the file in the cloud
      pthis.upload(fileServer, pathCloud, function (err) {
        if (err) {
          pthis.logger.log("ERROR", "Error while uploading file " + fileServer + ": " + err, "Archiver.backup");
          return callback("Error while uploading file " + fileServer + ": " + err);
        }
        //
        // Remove the compressed file
        Node.rimraf(fileServer, function (err) {
          if (err) {
            pthis.logger.log("ERROR", "Error removing the file " + fileServer + ": " + err, "Archiver.backup");
            return callback("Error removing the file " + fileServer + ": " + err);
          }
          //
          // Done
          callback();
        });
      });
    });
  });
};


/**
 * Backup the project located at pathServer into pathS3 on AWS as a zip
 * @param {string} pathServer
 * @param {string} pathCloud
 * @param {function} callback - function (err)
 */
Node.Archiver.prototype.backupZip = function (pathServer, pathCloud, callback)
{
  var pthis = this;
  //
  var fileServer = pathServer + ".zip";
  //
  var output = Node.fs.createWriteStream(fileServer);
  var archive = Node.archiver.create("zip");
  //
  output.on("close", function () {
    pthis.upload(fileServer, pathCloud, function (err) {
      if (err) {
        pthis.logger.log("ERROR", "Error while uploading the file " + fileServer + " to the cloud: " + err, "Archiver.backupZip");
        return callback("Error while uploading the file " + fileServer + " to the cloud: " + err);
      }
      //
      // Remove the compressed file
      Node.rimraf(fileServer, function (err) {
        if (err) {
          pthis.logger.log("ERROR", "Error removing the file " + fileServer + ": " + err, "Archiver.backupZip");
          return callback("Error removing the file " + fileServer + ": " + err);
        }
        //
        callback();
      });
    });
  });
  output.on("error", function (err) {
    pthis.logger.log("ERROR", "Error while writing the ZIP file " + fileServer + ": " + err, "Archiver.backupZip");
    callback("Error while writing the ZIP file " + fileServer + ": " + err);
  });
  archive.on("error", function (err) {
    pthis.logger.log("ERROR", "Error while compressing the file " + fileServer + ": " + err, "Archiver.backupZip");
    callback("Error while compressing the file " + fileServer + ": " + err);
  });
  //
  archive.pipe(output);
  archive.directory(pathServer, false).finalize();
};


/**
 * Restore a file from the cloud
 * @param {string} pathServer
 * @param {string} pathCloud
 * @param {function} callback - function(err)
 */
Node.Archiver.prototype.restore = function (pathServer, pathCloud, callback)
{
  var pthis = this;
  var fileServer = pathServer + ".tar.gz";
  var pathExists;
  //
  var errorFnc = function (err) {
    // First: report the error
    pthis.logger.log("ERROR", err, "Archiver.restore");
    //
    // Delete the tar.gz
    Node.rimraf(fileServer, function (err1) {
      if (err1)
        pthis.logger.log("WARN", "Error while deleting the file " + fileServer + ": " + err1, "Archiver.restore");
      //
      // If the path existed, I need to restore the one I've backed up
      if (pathExists) {
        Node.fs.access(pathServer + ".$$$", function (err) {
          // If the ".$$$" exists
          if (!err) {
            // First, try to remove the old directory
            Node.rimraf(pathServer, function (err1) {
              if (err1)
                pthis.logger.log("WARN", "Error while deleting the directory " + pathServer + ": " + err1, "Archiver.restore");
              //
              // Then restore the .$$$ (backup) renaming it back
              Node.fs.rename(pathServer + ".$$$", pathServer, function (err1) {
                if (err1)
                  pthis.logger.log("WARN", "Error while restoring backup directory " + pathServer + ".$$$: " + err1, "Archiver.restore");
                //
                // Probably I've fixed everything -> report to callee
                callback(err);
              });
            });
          }
          else  // The path existed but the .$$$ path does not exist -> there is nothing else to do
            callback(err);
        });
      }
      else  // Path did not exist: nothing else to do than report to callee
        callback(err);
    });
  };
  //
  // Check if the pathServer exists
  Node.fs.access(pathServer, function (err) {
    pathExists = (err ? false : true);
    //
    // Download the file from the cloud
    pthis.download(pathCloud, fileServer, function (err) {
      if (err)
        return errorFnc("Error downloading the file " + pathCloud + " from the cloud: " + err);
      //
      if (pathExists)
        // Rename the old path to a temporary one
        Node.fs.rename(pathServer, pathServer + ".$$$", function (err) {
          if (err && err.code !== "ENOTEMPTY")
            return errorFnc("Error rename the path " + pathServer + " to temporary: " + err);
          //
          extractFile();
        });
      else
        extractFile();
    });
  });
  //
  var extractFile = function () {
    // Extract the file to parent directory (so that it becomes a pathServer sibling)
    Node.tar.extract({file: fileServer, cwd: pathServer + "/.."}, function (err) {
      if (err)
        return errorFnc("Error during the " + fileServer + " extraction: " + err);
      //
      // Delete the .tar.gz file
      Node.rimraf(fileServer, function (err) {
        if (err)
          return errorFnc("Error delering the file " + fileServer + ": " + err);
        //
        // If the path on the server existed already, delete old path
        if (pathExists)
          Node.rimraf(pathServer + ".$$$", function (err) {
            if (err)
              return errorFnc("Error deleting the old folder " + pathServer + ".$$$: " + err);
            //
            // Done
            callback();
          });
        else
          callback();
      });
    });
  };
};


/**
 * Get list of files in path on gcloud bucket
 * @param {string} path
 * @param {function} callback - function(err, [files])
 */
Node.Archiver.prototype.getFiles = function (path, callback)
{
  var pthis = this;
  //
  Node.indertBucket.getFiles({prefix: path}, function (err, files, nextQuery, apiResponse) {    // jshint ignore:line
    if (err) {
      pthis.logger.log("ERROR", "Error while reading files list from GCloud: " + err, "Archiver.getFiles", {path: path});
      return callback("Error while reading files list from GCloud: " + err);
    }
    //
    var result = [];
    for (var i = 0; i < files.length; i++)
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
  var file = Node.indertBucket.file(path);
  file.delete(function (err) {
    callback(err);
  });
};


/**
 * Stores an object in the cloud
 * @param {string} pathCloud
 * @param {object} obj - object to store (as JSON string)
 * @param {function} callback - function(err)
 */
Node.Archiver.prototype.saveObject = function (pathCloud, obj, callback)
{
  var pthis = this;
  //
  // If the storage se is gcloud
  if (this.config.storage === "gcloud") {
    var file = Node.indertBucket.file(pathCloud);
    //
    // copy the file into the cloud
    var wsFile = file.createWriteStream({resumable: false});
    wsFile.on("finish", function () {
      callback();
    });
    wsFile.on("error", function (err) {
      callback(err);
      pthis.logger.log("ERROR", "Error uploading the object in GCloud storage (" + pathCloud + "): " + err, "Archiver.saveObject");
    });
    //
    if (typeof obj === "object")
      wsFile.write(JSON.stringify(obj));
    else
      wsFile.write(obj);
    wsFile.end();
  }
  else if (this.config.storage === "aws") {
    Node.AWS.config.update(pthis.config.configS3);
    var S3 = new Node.AWS.S3();
    //
    var data = (typeof obj === "object" ? JSON.stringify(obj) : obj);
    S3.putObject({Bucket: pthis.config.bucketS3, Key: pathCloud, Body: data}, function (err) {
      if (err)
        pthis.logger.log("ERROR", "Error uploading the object in S3 storage (" + pathCloud + "): " + err, "Archiver.saveObject");
      //
      callback(err);
    });
  }
};


/**
 * Restore an object from the cloud
 * @param {string} pathCloud
 * @param {function} callback - function(obj, err)
 */
Node.Archiver.prototype.readObject = function (pathCloud, callback)
{
  var pthis = this;
  //
  // If the storage se is gcloud
  if (this.config.storage === "gcloud") {
    var file = Node.indertBucket.file(pathCloud);
    var rsFile = file.createReadStream();
    rsFile.read();
    //
    var txt = "";
    rsFile.on("data", function (chunk) {
      txt += chunk;
    });
    rsFile.on("finish", function () {
      if (txt !== null)   // ERROR (see error handler)
        callback(txt ? JSON.parse(txt) : {});
    });
    rsFile.on("error", function (err) {
      err = err.message || err;
      txt = null;   // The FINISH event gets fired anyway (see previous handler)
      //
      pthis.logger.log("WARN", "Error reading the object from GCloud storage (" + pathCloud + "): " + err, "Archiver.readObject");
      callback(null, err);
    });
  }
  else if (this.config.storage === "aws") {
    Node.AWS.config.update(this.config.configS3);
    var S3 = new Node.AWS.S3();
    //
    S3.getObject({Bucket: this.config.bucketS3, Key: pathCloud}, function (err, data) {
      if (err)
        pthis.logger.log("WARN", "Error reading the object from S3 storage (" + pathCloud + "): " + err, "Archiver.readObject");
      callback((err ? null : data), err);
    });
  }
};


// Export the class
module.exports = Node.Archiver;
