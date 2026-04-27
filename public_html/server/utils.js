/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */

var Node = Node || {};

// Import modules
Node.fs = require("fs");
Node.path = require("path");
Node.tar = require("tar");
Node.multiparty = require("multiparty");
Node.mime = require("mime-types");
Node.os = require("os");
Node.child = require("child_process");
Node.zlib = require("zlib");
Node.yauzl = require("yauzl");
Node.ncp = require("./ncp_fixed");

/**
 * Utils object class
 * @type Utils
 */
Node.Utils = function ()
{
};


// Module flags for license checking
Node.Utils.IdfModules = {
  MOD_DEMO         : 0x0001,
  MOD_CSHARP       : 0x0002,
  MOD_JAVA         : 0x0004,
  MOD_WEBSERVICES  : 0x0008,
  MOD_RTC          : 0x0010,
  MOD_TRACKING     : 0x0020,
  MOD_TESTING      : 0x0040,
  MOD_ELEARNING    : 0x0080,
  MOD_REPORT       : 0x0100,
  MOD_TW           : 0x0200
};


/**
 * Return a 36-char UID
 */
Node.Utils.generateUID36 = function ()
{
  let lut = [];
  for (let i = 0; i < 256; i++)
    lut[i] = (i < 16 ? "0" : "") + (i).toString(16);
  //
  let d0 = Math.random() * 0xffffffff | 0;
  let d1 = Math.random() * 0xffffffff | 0;
  let d2 = Math.random() * 0xffffffff | 0;
  let d3 = Math.random() * 0xffffffff | 0;
  return lut[d0 & 0xff] + lut[d0 >> 8 & 0xff] + lut[d0 >> 16 & 0xff] + lut[d0 >> 24 & 0xff] + "-" +
          lut[d1 & 0xff] + lut[d1 >> 8 & 0xff] + "-" + lut[d1 >> 16 & 0x0f | 0x40] + lut[d1 >> 24 & 0xff] + "-" +
          lut[d2 & 0x3f | 0x80] + lut[d2 >> 8 & 0xff] + "-" + lut[d2 >> 16 & 0xff] + lut[d2 >> 24 & 0xff] +
          lut[d3 & 0xff] + lut[d3 >> 8 & 0xff] + lut[d3 >> 16 & 0xff] + lut[d3 >> 24 & 0xff];
};

/**
 * Return a 24-char UID
 */
Node.Utils.generateUID24 = function ()
{
  let d0 = Math.random() * 0xffffffff | 0;
  let d1 = Math.random() * 0xffffffff | 0;
  let d2 = Math.random() * 0xffffffff | 0;
  let d3 = Math.random() * 0xffffffff | 0;
  let s = String.fromCharCode(d0 & 0xff) + String.fromCharCode(d0 >> 8 & 0xff) +
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
  let splitMsg = (msg.type === "gc" && msg.cnt && ["lp", "sm", "ch", "chit"].includes(msg.cnt.type));
  splitMsg |= (msg.type === "prj" && msg.cnt?.doc ? true : false);
  if (!splitMsg)
    return process.send(msg);
  //
  let smsg = JSON.stringify(msg);
  let msgid = Node.Utils.generateUID24();
  //
  // Send the message in chunks
  let chunkSize = 100 * 1024;   // 100KB each
  let nChunk = Math.ceil(smsg.length / chunkSize);
  for (let i = 0; i < nChunk; i++)
    // Don't send it immediately (I don't want to clog the channel)
    // Let the system relax and send each chunk when free
    (i => {
      setImmediate(() => {
        let msgToRoute = {type: "chunk", id: msgid, idx: i + 1, total: nChunk, data: smsg.substring(i * chunkSize, (i + 1) * chunkSize)};
        process.send(msgToRoute);
      });
    })(i);
};


/**
 * Processes a chunked message, reassembling it when all chunks are received
 * @param {Object} msg - The received message object
 * @param {Object} msg.cnt - The content of the message (may be a chunk or regular content)
 * @returns {Promise<Boolean>} - Returns true if message is complete (or not chunked), false if waiting for more chunks
 */
Node.Utils.chunkMap = {};
//
// Cleanup stale chunk fragments every 5 minutes (handles child process crashes mid-message)
let chunkTTL = 5 * 60 * 1000;
setInterval(() => {
  let now = Date.now();
  for (let id in Node.Utils.chunkMap) {
    if (now - Node.Utils.chunkMap[id].ts > chunkTTL)
      delete Node.Utils.chunkMap[id];
  }
}, chunkTTL).unref();
//
Node.Utils.process_on = async function (msg)
{
  // Non-chunked messages are already complete
  if (!msg.cnt || msg.cnt.type !== "chunk")
    return true;
  //
  // Handle chunked message
  let chunk = msg.cnt;
  //
  // Initialize buffer for first chunk of a message
  if (chunk.idx === 1)
    Node.Utils.chunkMap[chunk.id] = {ts: Date.now(), data: ""};
  //
  // Append chunk data to buffer
  Node.Utils.chunkMap[chunk.id].data += chunk.data;
  //
  // Return false if more chunks are expected
  if (chunk.idx !== chunk.total)
    return false;
  //
  // All chunks received - reassemble the complete message
  msg.cnt = JSON.parse(Node.Utils.chunkMap[chunk.id].data);
  delete Node.Utils.chunkMap[chunk.id];
  //
  return true;
};


/**
 * Handles file system operations through web interface
 * @param {object} options - command options:
 *                    path - path that have to be accessible through web
 *                    tempPath - temporary (work) directory (for put)
 *                    command - command to execute (list, get, put, del)
 *                    params - command parameters
 */
Node.Utils.handleFileSystem = async function (options)
{
  // If the object path contains .. -> error
  // (I don't want the callee to mess around. It MUST play inside options.path)
  if (options.path.includes(".."))
    throw new Error("Double dot operator (..) not allowed");
  //
  // Check if the path exists
  try {
    await Node.fs.promises.access(options.path);
  }
  catch {
    // If the path does not exist and the command is not PUT (that could add that path)
    if (options.command !== "put")
      throw {err: "Path does not exist", code: 404};
  }
  //
  // Retrieve path statistics
  let pathStats;
  try {
    pathStats = await Node.fs.promises.stat(options.path);
  }
  catch (err) {
    // If there is an error and the error is not "PATH-DOES-NOT-EXIST" or the command is not PUT)
    if (options.command !== "put" || err.code !== "ENOENT")
      throw new Error(`Can't get path info: ${err}`);
  }
  //
  // Handle command
  switch (options.command) {
    case "list": {
      if (!pathStats.isDirectory())
        throw new Error("Can't list a file");
      //
      // Read the directory
      let files;
      try {
        files = await Node.fs.promises.readdir(options.path);
      }
      catch (err) {
        throw new Error(`Can't list the directory content: ${err}`);
      }
      //
      // Now I've file names... I need all files info
      let filesInfo = await Promise.all(files.map(async file => {
        try {
          let stats = await Node.fs.promises.stat(Node.path.join(options.path, file));
          return {
            name: file,
            birthtime: stats.birthtime,
            mtime: stats.mtime,
            size: (stats.isDirectory() ? undefined : stats.size),
            mode: stats.mode,
            dir: stats.isDirectory()
          };
        }
        catch (err) {
          return {
            name: file,
            err
          };
        }
      }));
      return {msg: JSON.stringify(filesInfo)};
    }

    case "get": {
      // If the object is a folder, I need to TARGZ-pit first
      let filePath = options.path;
      if (pathStats.isDirectory()) {
        let parentPath = Node.path.dirname(options.path);
        let dirName = Node.path.basename(options.path);
        filePath = Node.path.join(options.tempPath, `${dirName}.tar.gz`);
        await Node.tar.create({file: filePath, cwd: parentPath, gzip: true, portable: true}, [dirName]);
      }
      //
      try {
        await new Promise((resolve, reject) => {
          // Stream the file
          let rstream = Node.fs.createReadStream(filePath);
          let headerSent = false;
          rstream.on("data", () => {
            // If I haven't sent header yet, do it now
            if (!headerSent) {
              headerSent = true;
              //
              let stat = Node.fs.statSync(filePath);
              let mimetype = Node.mime.lookup(filePath);
              options.params.res.writeHead(200, {
                "Content-disposition": (options.params.req.query.inline ? "inline" : `attachment; filename = ${Node.path.basename(filePath)}`),
                "Content-Length": stat.size,
                "Content-Type": mimetype
              });
            }
          });
          rstream.on("end", resolve);
          rstream.on("error", reject);
          rstream.pipe(options.params.res);
        });
      }
      catch (err) {
        throw new Error(`Can't send file: ${err}`);
      }
      finally {
        // Remove temporary TAR file if it was created
        if (pathStats.isDirectory())
          await Node.fs.promises.rm(filePath, {force: true});
      }
      return {skipReply: true};      // Done (don't reply, I've done it)
    }

    case "put": {
      let form = new Node.multiparty.Form({autoFields: true, autoFiles: true, uploadDir: options.tempPath});
      let files = await new Promise((resolve, reject) => {
        form.parse(options.params.req, (err, fields, files) => {
          if (err) {
            options.params.res.status(500).end();
            reject(new Error(`Error parsing post request: ${err}`));
          }
          else
            resolve(files);
        });
      });
      //
      // If I don't have the path status it means that I've got an error before
      // (and the reason is that the path does not yet exist)
      // Allow the callee to create a single directory and nothing more...
      if (pathStats === undefined) {
        try {
          await Node.fs.promises.mkdir(options.path);
        }
        catch (err) {
          throw new Error(`Error while creating the new directory: ${err}`);
        }
        finally {
          // Delete the "dummy" file I've used to create the directory
          let farr = Object.keys(files);
          if (farr.length && files[farr[0]] && files[farr[0]][0])
            await Node.fs.promises.rm(files[farr[0]][0].path, {force: true}).catch(() => {});
        }
        //
        return;
      }
      //
      // Extract all files
      let farr = Object.keys(files);
      //
      // If there are no files
      if (farr.length === 0)
        throw new Error("PUT command requires one or more files");
      //
      for (let i = 0; i < farr.length; i++) {
        let k = farr[i];
        let f = files[k][0];
        let newfile = Node.path.join(options.path, f.originalFilename);
        try {
          await Node.fs.promises.rename(f.path, newfile);
        }
        catch (err) {
          throw new Error(`Error moving POST file: ${err}`);
        }
        //
        // If the file needs to be extracted, do it and delete uploaded file
        if (options.params.req.query.extract) {
          if (newfile.toLowerCase().endsWith(".tar.gz")) {
            // tar.gz uses some junky library that has a problem: if the file has an invalid format
            // the extract method crashes in an asynchronous way... thus there is no way of knowing
            // if something is wrong... Thus, before I extract the file, I check if it's correct
            let buffer = await Node.fs.promises.readFile(newfile);
            await new Promise((resolve, reject) => {
              Node.zlib.gunzip(buffer, (err, result) => {
                if (err)
                  reject(new Error(`Error while checking the ${newfile}: ${err}`));
                else
                  resolve(result);
              });
            });
            //
            // No errors -> extract with buggy method
            try {
              await Node.tar.extract({file: newfile, cwd: options.path});
            }
            catch (err) {
              throw new Error(`Error during the ${newfile} extraction: ${err}`);
            }
            //
            // Delete the .tar.gz file
            try {
              await Node.fs.promises.rm(newfile, {force: true});
            }
            catch (err) {
              throw new Error(`Error deleting the file ${newfile}: ${err}`);
            }
          }
          else if (newfile.toLowerCase().endsWith(".zip")) {
            await new Promise((resolve, reject) => {
              let ok = false;
              Node.yauzl.open(newfile, {lazyEntries: true}, (err, zipfile) => {
                if (err)
                  return reject(new Error(`Error reading the ${newfile}: ${err}`));
                //
                zipfile.readEntry();
                zipfile.on("entry", async entry => {
                  if (/\/$/.test(entry.fileName)) {
                    // Directory file names end with '/'.
                    try {
                      await Node.fs.promises.mkdir(`${options.path}/${entry.fileName}`, {recursive: true});
                      zipfile.readEntry();
                    }
                    catch (e) {
                      reject(new Error(`Error while extracting the ${entry.fileName} directory: ${e.message || e}`));
                    }
                  }
                  else {
                    // It's a file
                    zipfile.openReadStream(entry, async (err, readStream) => {
                      if (err)
                        return reject(new Error(`Error while extracting the ${entry.fileName} file (READ): ${err}`));
                      //
                      // Ensure parent directory exists
                      try {
                        await Node.fs.promises.mkdir(Node.path.dirname(Node.path.join(options.path, entry.fileName)), {recursive: true});
                        //
                        await new Promise((res, rej) => {
                          let output = Node.fs.createWriteStream(Node.path.join(options.path, entry.fileName));
                          output.on("open", () => {
                            readStream.pipe(output);
                          });
                          output.once("error", err => {
                            rej(new Error(`Error while extracting the ${entry.fileName} file (WRITE): ${err}`));
                          });
                          output.on("close", () => {
                            res();
                            zipfile.readEntry();
                          });
                        });
                      }
                      catch (e) {
                        reject(new Error(`Error while ensuring parent directory ${Node.path.dirname(entry.fileName)} existence: ${e.message || e}`));
                      }
                    });
                  }
                });
                zipfile.on("error", error => {
                  reject(new Error(`Error while extracting the ZIP file: ${error}`));
                });
                zipfile.on("end", () => {
                  ok = true;
                });
                zipfile.on("close", async () => {
                  if (!ok)
                    return;
                  //
                  // Delete the .zip file
                  try {
                    await Node.fs.promises.rm(newfile, {force: true});
                    resolve();
                  }
                  catch (err) {
                    reject(new Error(`Error deleting the file ${newfile}: ${err}`));
                  }
                });
              });
            });
          }
          else
            throw new Error(`Error extracting the file ${newfile}: unsupported file extension`);
        }
      }
      break;
    }

    case "del":
      // Can't delete the "main" FILES directory
      if ((options.path.match(/\/files\//g) || []).length === 1 && options.path.endsWith("/files/"))
        throw new Error("Can't delete FILES directory");
      //
      try {
        await Node.fs.promises.rm(options.path, {recursive: true, force: true});
      }
      catch (err) {
        throw new Error(`Error while deleting the file: ${err}`);
      }
      break;

    case "copy":
    case "move": {
      // Can't copy/rename the "main" FILES directory
      if ((options.path.match(/\/files\//g) || []).length === 1 && options.path.endsWith("/files/"))
        throw new Error(`Can't ${options.command === "move" ? "move" : "copy"} FILES directory`);
      //
      let newName = options.params.req.query?.newname;
      if (!newName)
        throw new Error("Missing newname parameter");
      //
      // If the newName path contains .. -> error
      // (I don't want the callee to mess around. It MUST play inside options.path)
      if (newName.includes(".."))
        throw new Error("Double dot operator (..) not allowed");
      //
      try {
        if (options.command === "move")
          await Node.fs.promises.rename(options.path, Node.path.join(options.basePath, newName));
        else {
          await new Promise((resolve, reject) => {
            Node.ncp(options.path, Node.path.join(options.basePath, newName), err => err ? reject(err) : resolve());
          });
        }
      }
      catch (err) {
        throw new Error(`Error while ${options.command === "move" ? "moving" : "copying"} the file/directory: ${err}`);
      }
      break;
    }

    default:
      throw new Error(`Unsupported command: ${options.command}`);
  }
};


/**
 * Calculates CPU average usage
 * @returns {Object} {idle, total} - Average idle and total tick counts
 */
Node.Utils.cpuAverage = function ()
{
  let totalIdle = 0, totalTick = 0;
  //
  let cpus = Node.os.cpus();
  for (let i = 0; i < cpus.length; i++) {
    let cpu = cpus[i];
    for (let type in cpu.times)
      totalTick += cpu.times[type];
    totalIdle += cpu.times.idle;
  }
  return {
    idle: totalIdle / cpus.length,
    total: totalTick / cpus.length
  };
};


/**
 * Returns CPU load
 */
Node.Utils.getCPUload = async function ()
{
  let startMeasure = Node.Utils.cpuAverage();
  //
  return new Promise(resolve => {
    setTimeout(() => {
      let endMeasure = Node.Utils.cpuAverage();
      let idleDifference = endMeasure.idle - startMeasure.idle;
      let totalDifference = endMeasure.total - startMeasure.total;
      let percentageCPU = 100 - (100 * idleDifference / totalDifference);
      //
      percentageCPU = Math.round(percentageCPU * 100) / 100;    // 2 dec digits
      //
      resolve(percentageCPU);
    }, 200);    // Wait 200ms and measure again
  });
};


/**
 * Returns free disk size (async version)
 * @returns {Promise<number>} Available disk space in bytes
 */
Node.Utils.getFreeDiskSize = async function ()
{
  // Check disk size
  let cmd, cmdParams;
  if (!/^win/.test(process.platform)) {   // linux
    cmd = "/bin/df";
    cmdParams = ["."];
  }
  else {  // windows
    cmd = "wmic";
    cmdParams = ["logicaldisk", "where", `DeviceID='${__filename[0]}:'`, "get", "freespace,size", "/format:table"];
  }
  //
  return new Promise((resolve, reject) => {
    require("child_process").execFile(cmd, cmdParams, (err, stdout, stderr) => {
      if (err)
        return reject(stderr || err);
      //
      stdout = stdout.split("\n")[1];   // Remove headers
      stdout = stdout.split(/\s+/);     // Split spaces
      //
      let available;
      if (!/^win/.test(process.platform))    // linux
        available = stdout[3] * 1024;
      else   // windows
        available = stdout[0];
      resolve(available);
    });
  });
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
 * Determines whether a ZIP entry represents a directory.
 * An entry is a directory when its filename ends with "/" OR when the external file
 * attributes flag it as one. Some Windows-produced archives omit the trailing slash,
 * so relying only on the filename misclassifies such entries as files.
 * @param {Object} zipEntry - ZIP entry (from yauzl or yauzl-promise)
 * @returns {Boolean} true if the entry represents a directory
 */
Node.Utils.isZipEntryDirectory = function (zipEntry)
{
  // yauzl uses "fileName", yauzl-promise uses "filename": accept both
  let name = zipEntry.filename ?? zipEntry.fileName;
  //
  // Canonical ZIP convention: a directory entry's name ends with "/"
  if (/\/$/.test(name))
    return true;
  //
  // Fallback: inspect external file attributes. Their meaning depends on the
  // originating platform, encoded in the high byte of "versionMadeBy":
  //   0  = MS-DOS/FAT/NTFS
  //   3  = UNIX
  //   10 = Windows NTFS
  //   ...
  let madeByPlatform = (zipEntry.versionMadeBy >>> 8) & 0xff;
  //
  // UNIX: the top 16 bits hold the POSIX mode; isolate the file-type bits
  // (mask 0o170000) and compare with S_IFDIR (0o040000)
  if (madeByPlatform === 3)
    return ((zipEntry.externalFileAttributes >>> 16) & 0o170000) === 0o040000;
  //
  // DOS/Windows: the low byte holds DOS attributes; bit 0x10 is the directory flag
  return (zipEntry.externalFileAttributes & 0x10) !== 0;
};


/**
 * Cleans the given name (as it's done by the console)
 * @param {string} str - string to be cleaned
 */
Node.Utils.clearName = function (str)
{
  let allowedChar = "qwertyuiopasdfghjklzxcvbnm1234567890- ";
  let out = "";
  //
  str = str.toLowerCase();
  for (let i = 0; i < str.length; i++) {
    if (allowedChar.includes(str[i]))
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
  let base64 = "";
  let bytes = new Uint8Array(buffer);
  let len = bytes.length;
  let chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < len; i += 3) {
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
  let bufferLength = base64.length * 0.75;
  if (base64[base64.length - 1] === "=") {
    bufferLength--;
    if (base64[base64.length - 2] === "=")
      bufferLength--;
  }
  //
  let p = 0, i;
  let len = base64.length;
  let arraybuffer = new ArrayBuffer(bufferLength);
  let bytes = new Uint8Array(arraybuffer);
  let lookup = new Uint8Array(256);
  let chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (i = 0; i < chars.length; i++)
    lookup[chars.charCodeAt(i)] = i;
  for (i = 0; i < len; i += 4) {
    let encoded1 = lookup[base64.charCodeAt(i)];
    let encoded2 = lookup[base64.charCodeAt(i + 1)];
    let encoded3 = lookup[base64.charCodeAt(i + 2)];
    let encoded4 = lookup[base64.charCodeAt(i + 3)];
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
  let execArgv = () => {
    return process.execArgv.map((e) => {
      if (e.startsWith("--inspect")) {
        let nProcs;
        if (/^win/.test(process.platform))
          nProcs = parseInt(Node.child.execSync("tasklist /FI \"imagename eq node.exe\" /fo csv | find /c \"node.exe\"").toString());
        else
          nProcs = parseInt(Node.child.execSync("ps aux | grep \"node\\ \" | wc -l").toString());
        return `--inspect=${9229 + nProcs}`;
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
 */
Node.Utils.saveObject = async function (filename, obj)
{
  // If there is no object, remove JSON file and return
  if (!obj)
    return await Node.fs.promises.rm(filename, {force: true});
  //
  // There is an object -> I need to write the file
  await Node.fs.promises.writeFile(filename, JSON.stringify(obj));
};


/**
 * Load an object from a JSON file
 * @param {string} filename - name to be used
 * @returns {Promise<Object|null>} - The parsed object or null if file doesn't exist
 */
Node.Utils.loadObject = async function (filename)
{
   // If file does not exist, return null
  if (!await Node.fs.promises.access(filename).then(() => true, err => false))
    return;
  //
  // File exists -> read it
  let txt = await Node.fs.promises.readFile(filename, "utf8");
  //
  try {
    return txt ? JSON.parse(txt) : {};
  }
  catch (e) {
    console.error("JSON parse error in file:", filename);
    console.error("Content (first 600 chars):", txt.substring(0, 600));
    console.error("Content length:", txt.length);
    throw e;
  }
};

Node.Utils.unlockRequestQuery = function (req)
{
  let query = req.query;
  Object.defineProperty(req, "query", {
    configurable: true,
    enumerable: true,
    get: () => req._query = req._query || {},
    set: (q) => req._query = q
  });
  req.query = query;
};

Node.Utils.fixMimeTypes = function ()
{
  // Fix mime types
  Node.mime = require("mime-types");
  Node.mime.types["mp4"] = "video/mp4"; // Force mp4 to be video/mp4 (not application/mp4) 
  Node.mime.types["mpg4"] = "video/mp4"; // Force mpg4 to be video/mp4 (not application/mp4)
  Node.mime.types["yaml"] = "text/yaml"; // Add support for YAML files
  Node.mime.types["yml"] = "text/yaml"; // Add support for YML files
};

Node.Utils.isIDF = function ()
{
  return process.versions.electron;
}

// Export module
module.exports = Node.Utils;
