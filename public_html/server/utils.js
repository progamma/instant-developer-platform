/*
 * Instant Developer Next
 * Copyright Pro Gamma Spa 2000-2016
 * All rights reserved
 */
/* global module, process */

var Node = Node || {};

// Import modules
Node.fs = require("fs");
Node.fsExtra = require("fs.extra");
Node.path = require("path");
Node.rimraf = require("rimraf");
Node.tar = require("tar");
Node.multiparty = require("multiparty");
Node.os = require("os");
Node.child = require("child_process");
Node.zlib = require("zlib");
Node.yauzl = require("yauzl");

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
  return (Buffer.from(s || "", "ascii")).toString("base64");
};


/**
 * Sends big messages to parent process (as 100kb chunk)
 * @param {Object} msg - message to send
 */
Node.Utils.process_send = function (msg)
{
  // InDe.IndeProxy.msgTypeMap.generalChannel:
  //   - InDe.Document.msgTypeMap.loadProject
  //   - InDe.Document.msgTypeMap.savedModifications
  //   - InDe.Document.msgTypeMap.commitHistory
  //   - InDe.Document.msgTypeMap.commitHistoryItems
  // InDe.IndeProxy.msgTypeMap.project
  //   - message that contains a full doc
  var splitMsg = (msg.type === "gc" && msg.cnt && ["lp", "sm", "ch", "chit"].indexOf(msg.cnt.type) !== -1);
  splitMsg |= (msg.type === "prj" && msg.cnt && msg.cnt.doc ? true : false);
  if (!splitMsg)
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
  if (!msg.cnt || msg.cnt.type !== "chunk")
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
  Node.fs.access(options.path, function (err) {
    // If the path does not exist and the command is not PUT (that could add that path)
    if (err && options.command !== "put")
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
            var parentPath = options.path.substring(0, options.path.lastIndexOf("/"));
            var dirName = options.path.substring(options.path.lastIndexOf("/") + 1);
            var tarFile = options.tempPath + (options.tempPath.substr(-1) === "/" ? "" : "/") + dirName + ".tar.gz";
            Node.tar.create({file: tarFile, cwd: parentPath, gzip: true, portable: true}, [dirName], function (err) {
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
                  if (newfile.toLowerCase().endsWith(".tar.gz")) {
                    // tar.gz uses some junky library that has a problem: if the file has an invalid format
                    // the extract method crashes in an asynchronous way... thus there is no way of knowing
                    // if something is wrong... Thus, before I extract the file, I check if it's correct
                    Node.zlib.gunzip(Node.fs.readFileSync(newfile), function (err, buffer) {
                      if (err)
                        return callback("Error while checking the " + newfile + ": " + err);
                      //
                      // No errors -> extract with buggy method
                      Node.tar.extract({file: newfile, cwd: options.path}, function (err) {
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
                    });
                  }
                  else if (newfile.toLowerCase().endsWith(".zip")) {
                    var ok = false;
                    Node.yauzl.open(newfile, {lazyEntries: true}, function (err, zipfile) {
                      if (err)
                        return callback("Error reading the " + newfile + ": " + err);
                      //
                      zipfile.readEntry();
                      zipfile.on("entry", function (entry) {
                        if (/\/$/.test(entry.fileName)) {
                          // Directory file names end with '/'.
                          Node.fsExtra.mkdirs(options.path + "/" + entry.fileName, function (err) {
                            if (err)
                              return callback("Error while extracting the " + entry.fileName + " directory: " + err);
                            //
                            zipfile.readEntry();
                          });
                        }
                        else {
                          // It's a file
                          zipfile.openReadStream(entry, function (err, readStream) {
                            if (err)
                              return callback("Error while extracting the " + entry.fileName + " file (READ): " + err);
                            //
                            // Ensure parent directory exists
                            Node.fsExtra.mkdirs(Node.path.dirname(entry.fileName), function (err) {
                              if (err)
                                return cb(err);
                              //
                              var output = Node.fs.createWriteStream(options.path + "/" + entry.fileName);
                              output.on("open", function () {
                                readStream.pipe(output);
                              });
                              output.once("error", function (err) {
                                return callback("Error while extracting the " + entry.fileName + " file (WRITE): " + err);
                              });
                              output.on("close", function () {
                                zipfile.readEntry();
                              });
                            });
                          });
                        }
                      });
                      zipfile.on("error", function (error) {
                        return callback("Error while extracting the ZIP file: " + error);
                      });
                      zipfile.on("end", function (error) {
                        ok = true;
                      });
                      zipfile.on("close", function () {
                        if (!ok)
                          return;
                        //
                        // Delete the .zip file
                        Node.rimraf(newfile, function (err) {
                          if (err)
                            return callback("Error deleting the file " + newfile + ": " + err);
                          //
                          // If it's the last one, report to callee
                          if (++nfiles === farr.length)
                            callback();
                        });
                      });
                    });
                  }
                  else
                    return callback("Error extracting the file " + newfile + ": unsupported file extension");
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

        case "move":
          // Can't rename the "main" FILES directory
          if ((options.path.match(/\/files\//g) || []).length === 1 && options.path.substr(-7) === "/files/")
            return callback("Can't rename FILES directory");
          //
          var newName = (options.params.req.query || {}).newname;
          if (!newName)
            return callback("Missing newname parameter");
          //
          // If the newName path contains .. -> error
          // (I don't want the callee to mess around. It MUST play inside options.path)
          if (newName.indexOf("..") !== -1)
            return callback("Double dot operator (..) not allowed");
          //
          // "relocate" new name. The idea is "keep" all path pieces and replace only the pieces inside newName
          var pathPieces = options.path.split("/");
          pathPieces.splice(pathPieces.length - newName.split("/").length);
          newName = pathPieces.join("/") + "/" + newName;
          Node.fs.rename(options.path, newName, function (err) {
            if (err)
              return callback("Error while renaming the file/directory: " + err);
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


/**
 * Returns CPU load
 * @param {function} callback (result)
 */
Node.Utils.getCPUload = function (callback)
{
  var cpuAverage = function () {
    var totalIdle = 0, totalTick = 0;
    //
    var cpus = Node.os.cpus();
    for (var i = 0; i < cpus.length; i++) {
      var cpu = cpus[i];
      for (var type in cpu.times)   // jshint ignore:line
        totalTick += cpu.times[type];
      totalIdle += cpu.times.idle;
    }
    return {idle: totalIdle / cpus.length, total: totalTick / cpus.length};
  };
  //
  var startMeasure = cpuAverage();
  setTimeout(function () {
    var endMeasure = cpuAverage();
    var idleDifference = endMeasure.idle - startMeasure.idle;
    var totalDifference = endMeasure.total - startMeasure.total;
    var percentageCPU = 100 - (100 * idleDifference / totalDifference);
    //
    percentageCPU = Math.round(percentageCPU * 100) / 100;    // 2 dec digits
    //
    callback(percentageCPU);
  }, 200);    // Wait 200ms and measure again
};


/**
 * HTML encode the given string
 * @param {string} str - string to be HTML-encoded
 */
Node.Utils.HTMLencode = function (str)
{
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
};


/**
 * Cleans the given name (as it's done by the console)
 * @param {string} str - string to be cleaned
 */
Node.Utils.clearName = function (str)
{
  var allowedChar = "qwertyuiopasdfghjklzxcvbnm1234567890- ";
  var out = "";
  //
  str = str.toLowerCase();
  for (var i = 0; i < str.length; i++) {
    if (allowedChar.indexOf(str[i]) !== -1)
      out += str[i];
  }
  //
  return out.replace(/ /g, "-");
};


/**
 * Convert an ArrayBuffer to base64 string
 * @param {ArrayBuffer} buffer
 * See https://www.npmjs.com/package/base64-arraybuffer
 */
Node.Utils.bufferToBase64 = function (buffer)
{
  if (module)
    return Buffer.from(buffer).toString("base64");
  //
  var base64 = "";
  var bytes = new Uint8Array(buffer);
  var len = bytes.length;
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (var i = 0; i < len; i += 3) {
    base64 += chars[bytes[i] >> 2];
    base64 += chars[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)];
    base64 += chars[((bytes[i + 1] & 15) << 2) | (bytes[i + 2] >> 6)];
    base64 += chars[bytes[i + 2] & 63];
  }
  //
  if ((len % 3) === 2)
    base64 = base64.substring(0, base64.length - 1) + "=";
  else if (len % 3 === 1)
    base64 = base64.substring(0, base64.length - 2) + "==";
  //
  return base64;
};


/**
 * Convert an exadecimal string to ArrayBuffer
 * @param {String} base64
 * See https://www.npmjs.com/package/base64-arraybuffer
 */
Node.Utils.base64ToBuffer = function (base64)
{
  var bufferLength = base64.length * 0.75;
  if (base64[base64.length - 1] === "=") {
    bufferLength--;
    if (base64[base64.length - 2] === "=")
      bufferLength--;
  }
  //
  var p = 0, i;
  var len = base64.length;
  var arraybuffer = new ArrayBuffer(bufferLength);
  var bytes = new Uint8Array(arraybuffer);
  var lookup = new Uint8Array(256);
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (i = 0; i < chars.length; i++)
    lookup[chars.charCodeAt(i)] = i;
  for (i = 0; i < len; i += 4) {
    var encoded1 = lookup[base64.charCodeAt(i)];
    var encoded2 = lookup[base64.charCodeAt(i + 1)];
    var encoded3 = lookup[base64.charCodeAt(i + 2)];
    var encoded4 = lookup[base64.charCodeAt(i + 3)];
    //
    bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
    bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
    bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
  }
  //
  return arraybuffer;
};


/**
 * Returns an object that will be used for child.fork calls
 */
Node.Utils.forkArgs = function ()
{
  // Compute how many NODE processes are already running
  var execArgv = function () {
    return process.execArgv.map(function (e) {
      if (e.startsWith("--inspect")) {
        var nProcs;
        if (/^win/.test(process.platform))
          nProcs = parseInt(Node.child.execSync("tasklist /FI \"imagename eq node.exe\" /fo csv | find /c \"node.exe\"").toString());
        else
          nProcs = parseInt(Node.child.execSync("ps aux | grep \"node\\ \" | wc -l").toString()) - 1;
        return "--inspect=" + (9229 + nProcs);
      }
      return e;
    });
  };
  return {execArgv: execArgv()};
};


/**
 * Save an object into a JSON file
 * @param {string} filename - name to be used
 * @param {Object} obj - object to be saved
 * @param {function} callback (err)
 */
Node.Utils.saveObject = function (filename, obj, callback)
{
  // If there is no object, remove JSON file and return to callee
  if (!obj)
    return Node.rimraf(filename, callback);
  //
  // There is an object -> I need to write the file
  var wsFile = Node.fs.createWriteStream(filename);
  wsFile.on("finish", callback);
  wsFile.on("error", callback);
  wsFile.write(JSON.stringify(obj));
  wsFile.end();
};


/**
 * Load an object from a JSON file
 * @param {string} filename - name to be used
 * @param {Function} callback - function(res, err)
 */
Node.Utils.loadObject = function (filename, callback)
{
  // Check if the file exists
  Node.fs.access(filename, function (err) {
    // If does not exist -> return null object
    if (err)
      return callback();
    //
    // File exists -> read it
    var rsFile = Node.fs.createReadStream(filename);
    rsFile.read();
    //
    var txt = "";
    rsFile.on("data", function (chunk) {
      txt += chunk;
    });
    rsFile.on("end", function () {
      callback(txt ? JSON.parse(txt) : {});
    });
    rsFile.on("error", function (err) {
      callback(null, err);
    });
  });
};


// Export module
module.exports = Node.Utils;
