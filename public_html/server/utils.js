/*
 * Instant Developer Next
 * Copyright Pro Gamma Spa 2000-2016
 * All rights reserved
 */
/* global module, process */

var Node = Node || {};

// Import modules
Node.fs = require("fs");
Node.rimraf = require("rimraf");
Node.targz = require("tar.gz");
Node.multiparty = require("multiparty");

/**
 * Utils object class
 * @type Utils
 */
Node.Utils = function ()
{
};


/**
 * Return a 36-char UID
 */
/* jshint bitwise: false */
Node.Utils.generateUID36 = function ()
{
  var lut = [];
  for (var i = 0; i < 256; i++)
    lut[i] = (i < 16 ? "0" : "") + (i).toString(16);
  //
  var d0 = Math.random() * 0xffffffff | 0;
  var d1 = Math.random() * 0xffffffff | 0;
  var d2 = Math.random() * 0xffffffff | 0;
  var d3 = Math.random() * 0xffffffff | 0;
  return lut[d0 & 0xff] + lut[d0 >> 8 & 0xff] + lut[d0 >> 16 & 0xff] + lut[d0 >> 24 & 0xff] + "-" +
          lut[d1 & 0xff] + lut[d1 >> 8 & 0xff] + "-" + lut[d1 >> 16 & 0x0f | 0x40] + lut[d1 >> 24 & 0xff] + "-" +
          lut[d2 & 0x3f | 0x80] + lut[d2 >> 8 & 0xff] + "-" + lut[d2 >> 16 & 0xff] + lut[d2 >> 24 & 0xff] +
          lut[d3 & 0xff] + lut[d3 >> 8 & 0xff] + lut[d3 >> 16 & 0xff] + lut[d3 >> 24 & 0xff];
};

/**
 * Return a 24-char UID
 */
/* jshint bitwise: false */
Node.Utils.generateUID24 = function ()
{
  var d0 = Math.random() * 0xffffffff | 0;
  var d1 = Math.random() * 0xffffffff | 0;
  var d2 = Math.random() * 0xffffffff | 0;
  var d3 = Math.random() * 0xffffffff | 0;
  var s = String.fromCharCode(d0 & 0xff) + String.fromCharCode(d0 >> 8 & 0xff) +
          String.fromCharCode(d0 >> 16 & 0xff) + String.fromCharCode(d0 >> 24 & 0xff) +
          String.fromCharCode(d1 & 0xff) + String.fromCharCode(d1 >> 8 & 0xff) +
          String.fromCharCode(d1 >> 16 & 0xff) + String.fromCharCode(d1 >> 24 & 0xff) +
          String.fromCharCode(d2 & 0xff) + String.fromCharCode(d2 >> 8 & 0xff) +
          String.fromCharCode(d2 >> 16 & 0xff) + String.fromCharCode(d2 >> 24 & 0xff) +
          String.fromCharCode(d3 & 0xff) + String.fromCharCode(d3 >> 8 & 0xff) +
          String.fromCharCode(d3 >> 16 & 0xff) + String.fromCharCode(d3 >> 24 & 0xff);
  //
  // btoa does not work in node therefore we use a function toBase64 defined below
  return (new Buffer(s || "", "ascii")).toString("base64");
};


/**
 * Sends big messages to parent process (as 100kb chunk)
 * @param {Object} msg - message to send
 */
Node.Utils.process_send = function (msg)
{
  var isLoadPrj = (msg.type === "gc" && msg.cnt && msg.cnt.type === "lp");
  var isReloadPrj = (msg.type === "prj" && msg.cnt && msg.cnt.doc ? true : false);
  if (!isLoadPrj && !isReloadPrj)
    return process.send(msg);
  //
  var smsg = JSON.stringify(msg);
  var msgid = Node.Utils.generateUID24();
  //
  // Send the message in chunks
  var chunkSize = 100 * 1024;   // 100KB each
  var nChunk = Math.ceil(smsg.length / chunkSize);
  for (var i = 0; i < nChunk; i++)
    // Don't send it immediately (I don't want to clog the channel)
    // Let the system relax and send each chunk when free
    (function (i) {
      setImmediate(function () {
        var msgToRoute = {type: "chunk", id: msgid, idx: i + 1, total: nChunk, data: smsg.substring(i * chunkSize, (i + 1) * chunkSize)};
        process.send(msgToRoute);
      });
    })(i);    // jshint ignore:line
};


/**
 * Calls a callback when a chunked message is complete
 * @param {Object} msg - received msg
 * @param {Object} callback - function(msg) called when message is complete
 */
Node.Utils.chunkMap = {};
Node.Utils.process_on = function (msg, callback)
{
  // If it's not a chunked message
  if (msg.cnt.type !== "chunk")
    return callback(msg);
  //
  // It's a chunk!!
  var chunk = msg.cnt;
  //
  // If it's the first piece, initialize message in chunkMap
  if (chunk.idx === 1)
    Node.Utils.chunkMap[chunk.id] = "";
  //
  // Add chunk data
  Node.Utils.chunkMap[chunk.id] += chunk.data;
  //
  // If not completed, wait
  if (chunk.idx !== chunk.total)
    return;
  //
  // Message is complete. Replace message content with JSON parse and provide full message to callee
  msg.cnt = JSON.parse(Node.Utils.chunkMap[chunk.id]);
  delete Node.Utils.chunkMap[chunk.id];
  //
  callback(msg);
};


/**
 * Handles file system operations through web interface
 * @param {object} options - command options:
 *                    path - path that have to be accessible through web
 *                    tempPath - temporary (work) directory (for put)
 *                    command - command to execute (list, get, put, del)
 *                    params - command parameters
 * @param {function} callback (err or {err, msg, code})
 */
Node.Utils.handleFileSystem = function (options, callback)
{
  // If the object path contains .. -> error
  // (I don't want the callee to mess around. It MUST play inside options.path)
  if (options.path.indexOf("..") !== -1)
    return callback("Double dot operator (..) not allowed");
  //
  // Check if the path exists
  Node.fs.exists(options.path, function (exists) {
    // If the path does not exist and the command is not PUT (that could add that path)
    if (!exists && options.command !== "put")
      return callback({err: "Path does not exist", code: 404});
    //
    // Retrieve path statistics
    Node.fs.stat(options.path, function (err, pathStats) {
      // If there is an error and the error is not "PATH-DOES-NOT-EXIST" or the command is not PUT)
      if (err && (options.command !== "put" || err.code !== "ENOENT"))
        return callback("Can't get path info: " + err);
      //
      // Handle command
      switch (options.command) {
        case "list":
          if (!pathStats.isDirectory())
            return callback("Can't list a file");
          //
          // Read the directory
          Node.fs.readdir(options.path, function (err, files) {
            if (err)
              return callback("Can't list the directory content: " + err);
            //
            // Handle empty directory
            if (files.length === 0)
              return callback({msg: "[]"});
            //
            // Now I've file names... I need all files info
            var filesInfo = [];
            for (var i = 0; i < files.length; i++) {
              (function (idx) {
                // https://nodejs.org/api/fs.html#fs_class_fs_stats
                Node.fs.stat(options.path + (options.path.substr(-1) === "/" ? "" : "/") + files[idx], function (err, stats) {
                  // https://nodejs.org/api/fs.html#fs_file_mode_constants
                  if (err)
                    filesInfo.push({name: files[idx], err: err});
                  else
                    filesInfo.push({name: files[idx], birthtime: stats.birthtime, mtime: stats.mtime,
                      size: (stats.isDirectory() ? undefined : stats.size), mode: stats.mode, dir: stats.isDirectory()});
                  //
                  // If I've stated all files, report to callee
                  if (filesInfo.length === files.length)
                    callback({msg: JSON.stringify(filesInfo)});
                });
              })(i);      // jshint ignore:line
            }
          });
          break;

        case "get":
          var sendFile = function (path, cb) {
            // Stream the file
            var rstream = Node.fs.createReadStream(path);
            var headerSent = false;
            rstream.on("data", function () {
              // If I have't sent header yet, do it now
              if (!headerSent) {
                headerSent = true;
                //
                var stat = Node.fs.statSync(path);
                options.params.res.writeHead(200, {
                  "Content-disposition": "attachment; filename = " + path.substring(path.lastIndexOf("/") + 1),
                  "Content-Length": stat.size
                });
              }
            });
            rstream.on("end", cb);
            rstream.on("error", cb);
            rstream.pipe(options.params.res);
          };
          //
          // If the object is a folder, I need to TARGZ-pit first
          if (pathStats.isDirectory()) {
            var tarFile = options.tempPath + (options.tempPath.substr(-1) === "/" ? "" : "/") +
                    options.path.substring(options.path.lastIndexOf("/") + 1) + ".tar.gz";
            new Node.targz().compress(options.path, tarFile, function (err) {
              if (err)
                return callback("Can't compress path: " + err);
              //
              sendFile(tarFile, function (err) {
                // Remove temporary TAR file
                Node.rimraf(tarFile, function (err1) {
                  if (err1)
                    this.log("WARN", "Can't remove temporary TAR.GZ file: " + err1, "Project.handleFileSystem");
                  //
                  if (err)
                    return callback("Can't send file: " + err);
                  //
                  callback({skipReply: true});      // Done (don't reply, I've done it)
                }.bind(this));
              }.bind(this));
            }.bind(this));
          }
          else {    // Object is a file -> send it
            sendFile(options.path, function (err) {
              if (err)
                return callback("Can't send file: " + err);
              //
              callback({skipReply: true});      // Done (don't reply, I've done it)
            });
          }
          break;

        case "put":
          var form = new Node.multiparty.Form({autoFields: true, autoFiles: true, uploadDir: options.tempPath});
          form.parse(options.params.req, function (err, fields, files) {
            if (err) {
              callback("Error parsing post request: " + err);
              return options.params.res.status(500).end();
            }
            //
            // If I don't have the path status it means that I've got an error before
            // (and the reason is that the path does not yet exist)
            // Allow the callee to create a single directory and nothing more...
            if (pathStats === undefined) {
              Node.fs.mkdir(options.path, function (err) {
                if (err)
                  return callback("Error while creating the new directory: " + err);
                //
                callback();
              });
              //
              // Do nothing more
              return;
            }
            //
            // Extract all files
            var nfiles = 0;
            var farr = Object.keys(files);
            //
            // If there are no files
            if (farr.length === 0)
              return callback("PUT command requires one or more files: " + err);
            //
            for (var i = 0; i < farr.length; i++) {
              var k = farr[i];
              var f = files[k][0];
              var newfile = options.path + (options.path.substr(-1) === "/" ? "" : "/") + f.originalFilename;
              Node.fs.rename(f.path, newfile, function (err) {
                if (err)
                  callback("Error moving POST file: " + err);
                //
                // If the file needs to be extracted, do it and delete uploaded file
                if (options.params.req.query.extract) {
                  new Node.targz().extract(newfile, options.path, function (err) {
                    if (err)
                      return callback("Error during the " + newfile + " extraction: " + err);
                    //
                    // Delete the .tar.gz file
                    Node.rimraf(newfile, function (err) {
                      if (err)
                        return callback("Error deleting the file " + newfile + ": " + err);
                      //
                      // If it's the last one, report to callee
                      if (++nfiles === farr.length)
                        callback();
                    });
                  });
                }
                else { // No extraction
                  // If it's the last one, report to callee
                  if (++nfiles === farr.length)
                    callback();
                }
              });   // jshint ignore:line
            }
          });
          break;

        case "del":
          // Can't delete the "main" FILES directory
          if ((options.path.match(/\/files\//g) || []).length === 1 && options.path.substr(-7) === "/files/")
            return callback("Can't delete FILES directory");
          //
          Node.rimraf(options.path, function (err) {
            if (err)
              return callback("Error while deleting the file: " + err);
            //
            callback();
          }.bind(this));
          break;

        default:
          return callback("Unsupported command: " + options.command);
      }
    }.bind(this));
  }.bind(this));
};


// Export module
module.exports = Node.Utils;
