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
Node.ncp = require("./ncp_fixed");
Node.crypto = require("crypto");

/**
 * @class Node.Utils
 * @classdesc
 * Utility module for the Instant Developer Cloud server framework.
 * Provides common helper functions for file operations, process communication,
 * system monitoring, and data encoding/decoding operations.
 *
 * Key features:
 * - **UID Generation**: Creates unique identifiers in 24 and 36 character formats
 * - **Process Communication**: Handles chunked message transmission between processes
 * - **File System Operations**: Manages file operations via web interface with security checks
 * - **System Monitoring**: Provides CPU usage and disk space monitoring
 * - **Data Encoding**: Handles HTML encoding and base64 conversions
 * - **ZIP Extraction**: Common utility for extracting ZIP archives
 * - **Object Persistence**: Save/load objects to/from JSON files
 */
Node.Utils = function ()
{
};


/**
 * Module flags for IDF license checking.
 * Bitmask values used to determine which modules are available in the current license.
 * @enum {Number}
 */
Node.Utils.IdfModules = {
  /** Demo module flag */
  MOD_DEMO         : 0x0001,
  /** C# code generation module */
  MOD_CSHARP       : 0x0002,
  /** Java code generation module */
  MOD_JAVA         : 0x0004,
  /** Web services integration module */
  MOD_WEBSERVICES  : 0x0008,
  /** Real-time collaboration module */
  MOD_RTC          : 0x0010,
  /** User tracking and analytics module */
  MOD_TRACKING     : 0x0020,
  /** Testing and automation module */
  MOD_TESTING      : 0x0040,
  /** E-learning features module */
  MOD_ELEARNING    : 0x0080,
  /** Report generation module */
  MOD_REPORT       : 0x0100,
  /** TeamWorking module */
  MOD_TW           : 0x0200
};


/**
 * Generates a 36-character unique identifier.
 * Creates a UUID v4 compliant identifier in the format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 * where x is any hexadecimal digit and y is one of 8, 9, A, or B.
 * @returns {String} A 36-character unique identifier string
 */
Node.Utils.generateUID36 = function ()
{
  // Security (issue #14643): session id / secureSID / autk / ctoken / reconnectToken are all
  // generated here and used as bearer / anti-hijack secrets, so they MUST be unpredictable.
  // crypto.randomUUID() is a CSPRNG and keeps the v4 UUID layout (36 chars) callers expect.
  return Node.crypto.randomUUID();
};

/**
 * Generates a 24-character unique identifier.
 * Creates a base64-encoded identifier from random bytes, providing a compact unique string.
 * @returns {String} A 24-character base64 unique identifier string
 */
Node.Utils.generateUID24 = function ()
{
  // Security (issue #14643): CSPRNG instead of Math.random(). 16 random bytes -> 24-char base64,
  // same format as the previous implementation.
  return Node.crypto.randomBytes(16).toString("base64");
};


/**
 * Checks whether an HTTP request originates from an embedded browsing context (iframe & co.).
 * Used to decide if session cookies need the Partitioned (CHIPS) attribute: only embedded
 * apps need it, and setting it elsewhere would leave the cookie in the partitioned jar, where
 * clients built before the fix of issue #14800 cannot delete it (issue #14816).
 * Note: the check uses Sec-Fetch-Dest alone, without Sec-Fetch-Site. A navigation started from
 * inside the iframe itself (a link, a location change) reports the site relative to its initiator,
 * i.e. same-origin, not to the top-level embedder: gating on cross-site would drop the attribute
 * exactly while embedded, and Chrome would reject the unpartitioned SameSite=None cookie there.
 * A same-site iframe receiving a partitioned cookie is harmless (the partition key is its own
 * site). Browsers that implement CHIPS always send Sec-Fetch-Dest; when the header is missing
 * the attribute would be ignored anyway, so the request is treated as not embedded.
 * @param {Request} req - Express request object
 * @returns {Boolean} True when the request comes from an embedded context
 */
Node.Utils.isEmbeddedRequest = function (req)
{
  return ["iframe", "frame", "embed", "object"].includes(req.headers["sec-fetch-dest"]);
};


/**
 * Builds an app entry URL for session recovery, keeping application parameters but discarding
 * the rejected session identifiers and invitation token so the redirect starts a fresh session.
 * @param {String} appName - Target app name
 * @param {String} [appUrl] - Original absolute app URL
 * @returns {String} Relative app entry URL
 */
Node.Utils.getAppRestartUrl = function (appName, appUrl)
{
  let entry = `/${encodeURIComponent(appName)}`;
  let params = URL.parse(appUrl || "")?.searchParams;
  if (!params)
    return entry;
  //
  params.delete("sid");
  params.delete("cid");
  params.delete("ctoken");
  let query = params.toString();
  return query ? `${entry}?${query}` : entry;
};


/**
 * Best-effort IPC send to the parent process. `process.send` can throw `EPIPE` or
 * `ERR_IPC_CHANNEL_CLOSED` while the channel is tearing down (e.g. the user closes the
 * project tab) even when `process.connected` is still `true` - a race, typical on Windows.
 * Swallow only those two codes so a message emitted during shutdown never becomes an
 * uncaught exception that gets re-logged in a loop; re-throw anything else (issue #14680).
 * @param {Object} msg - message to send to the parent process
 * @returns {Boolean} true if the message was handed to the channel, false otherwise
 */
Node.Utils.safeSend = function (msg)
{
  if (!process.connected)
    return false;
  //
  try {
    process.send(msg);
    return true;
  }
  catch (err) {
    if (["EPIPE", "ERR_IPC_CHANNEL_CLOSED"].includes(err?.code))
      return false;
    //
    throw err;
  }
};


/**
 * Sends messages to the parent process with automatic chunking for large messages.
 * Automatically splits messages larger than 100KB into chunks to avoid IPC channel congestion.
 * Particularly useful for project data, commit history, and document synchronization.
 * @param {Object} msg - Message object to send to parent process
 * @param {String} msg.type - Message type (e.g., 'gc', 'prj')
 * @param {Object} [msg.cnt] - Message content that may be chunked if large
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
    return Node.Utils.safeSend(msg);
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
        Node.Utils.safeSend(msgToRoute);
      });
    })(i);
};


/**
 * Map storing incomplete chunked messages being reassembled.
 * Keys are message IDs, values contain timestamp and accumulated data.
 * @private
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
/**
 * Processes incoming messages and reassembles chunked messages.
 * Handles both regular messages and chunked messages split by process_send.
 * Accumulates chunks until the complete message is received, then reassembles it.
 * @param {Object} msg - The received message object
 * @param {Object} msg.cnt - The content of the message (may be a chunk or regular content)
 * @param {String} [msg.cnt.type] - If 'chunk', indicates this is part of a chunked message
 * @param {String} [msg.cnt.id] - Unique identifier for the chunked message
 * @param {Number} [msg.cnt.idx] - Current chunk index (1-based)
 * @param {Number} [msg.cnt.total] - Total number of chunks
 * @param {String} [msg.cnt.data] - Chunk data portion
 * @returns {Promise<Boolean>} True if message is complete (or not chunked), false if waiting for more chunks
 */
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
 * Tells whether a path is confined to one of the given root directories.
 * The trailing separator matters: without it the root "/home/user" would also match "/home/userAB".
 * @param {String} target - Path to check (resolved before comparing)
 * @param {String[]} roots - Allowed root directories
 * @param {Boolean} [strict] - Refuse the roots themselves: only what lives inside them passes. For a
 * caller serving files a root is a directory, never a legitimate target
 * @returns {Boolean} True when the path is confined to one of the roots
 */
Node.Utils.isPathInside = function (target, roots, strict)
{
  let resolved = Node.path.resolve(target);
  return roots.some(r => {
    let root = Node.path.resolve(r);
    return (!strict && resolved === root) || resolved.startsWith(root + Node.path.sep);
  });
};


/**
 * Resolves a path through the symlinks it crosses, falling back to the deepest ancestor that does
 * exist. Resolving the string alone is not enough to confine a path: a symlink points wherever it
 * wants, and the file system follows it on both reads and writes. What does not exist cannot be
 * resolved - but its parent can, and a symlinked parent is exactly how a path that passes a plain
 * string check ends up creating a file outside its jail (issue #14062).
 * @param {String} p - Path to resolve
 * @returns {Promise<String>} The real absolute path
 */
Node.Utils.realPath = async function (p)
{
  let target = Node.path.resolve(p);
  let missing = [];
  let current = target;
  while (true) {
    try {
      return Node.path.join(await Node.fs.promises.realpath(current), ...missing);
    }
    catch {
      // Nothing along the path exists: no symlink can be crossed, the resolved path is the answer
      let parent = Node.path.dirname(current);
      if (parent === current)
        return target;
      //
      missing.unshift(Node.path.basename(current));
      current = parent;
    }
  }
};


/**
 * Handles file system operations through web interface.
 * Provides secure file operations with path validation to prevent directory traversal attacks.
 * Supports listing directories, downloading files/folders, uploading files, and deletion.
 * Once validated, `options.path` and `options.basePath` are replaced with their real paths, so the
 * command handlers work on what has been checked.
 * @param {Object} options - File system operation configuration
 * @param {String|String[]} options.path - Target path for the operation, or (for the "del" command) an array of paths (must resolve inside options.basePath)
 * @param {String} [options.tempPath] - Temporary directory for upload operations
 * @param {String} options.basePath - Jail root: options.path is rejected if it resolves outside this directory
 * @param {String} options.command - Operation to perform ('list', 'get', 'put', 'del', 'copy', 'move')
 * @param {Object} options.params - Command-specific parameters
 * @param {Object} options.params.req - Express request object
 * @param {Object} options.params.res - Express response object
 * @returns {Promise<Object>} Result object with operation outcome (nothing for the 'get' operation, which streams the response directly)
 * @throws {Error} Throws error if the resolved path escapes options.basePath, path doesn't exist, or operation fails
 */
Node.Utils.handleFileSystem = async function (options)
{
  // Batch delete: the console can pass an array of paths to remove many files in a single
  // request (issue #14577). Each path reuses the single-path logic (security check + fsDelete)
  // via a recursive call: fail-fast on the first error, "ok" when all are deleted. Only "del"
  // is batched; the other commands keep receiving a single path.
  if (options.command === "del" && Array.isArray(options.path)) {
    for (let p of options.path)
      await Node.Utils.handleFileSystem({...options, path: p});
    //
    return {result: "ok"};
  }
  //
  // An array of paths is only meaningful for "del" (batched above). For any other command a
  // stray array (e.g. ?path=a&path=b on a "list") would degrade into a confusing downstream
  // error, so reject it up front with a clear message (issue #14577).
  if (Array.isArray(options.path))
    throw new Error("An array of paths is only supported by the 'del' command");
  //
  // Security (issue #14643): the target MUST stay inside the app/project files jail. Checking
  // options.path for ".." here is useless: path.join already collapsed the "../" from the raw query,
  // so a traversal survives as a clean path outside basePath (config.json read/write). Both sides go
  // through realPath, so a symlink planted inside the jail cannot lead out of it either (#14062)
  let realBase = await Node.Utils.realPath(options.basePath);
  let realTarget = await Node.Utils.realPath(options.path);
  if (!Node.Utils.isPathInside(realTarget, [realBase]))
    throw new Error("Path outside of the allowed directory");
  //
  // From here on work on the path that was checked, not on the one that was asked for: every command
  // below would otherwise cross the symlinks again on its own (issue #14062)
  options.path = realTarget;
  options.basePath = realBase;
  //
  // Check if the path exists
  try {
    await Node.fs.promises.access(options.path);
  }
  catch {
    // If the path does not exist and the command is not PUT (that could add that path)
    if (options.command !== "put") {
      let err = new Error("Path does not exist");
      err.code = 404;
      throw err;
    }
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
      throw new Error(`Can't get path info: ${err.message || err}`, {cause: err});
  }
  //
  // Dispatch to the specific command handler
  switch (options.command) {
    case "list":
      return Node.Utils.fsList(options, pathStats);

    case "get":
      return Node.Utils.fsGet(options, pathStats);

    case "put":
      return Node.Utils.fsPut(options, pathStats);

    case "del":
      return Node.Utils.fsDelete(options);

    case "copy":
    case "move":
      return Node.Utils.fsCopyMove(options);

    default:
      throw new Error(`Unsupported command: ${options.command}`);
  }
};


/**
 * Lists the content of a directory.
 * Returns one entry per file with name, timestamps, size, mode and directory flag;
 * entries that fail stat() are returned with an 'err' field instead.
 * When the ?dirsize query flag is set, directory entries also report their total
 * (recursively computed) content size in the `size` field; otherwise directories
 * leave `size` undefined, as folder measuring can be expensive on large trees.
 * @param {Object} options - File system operation configuration (see handleFileSystem)
 * @param {Object} pathStats - Stats of options.path (must reference a directory)
 * @returns {Promise<Array>} Array of file info objects
 * @throws {Error} If options.path is not a directory or the directory can't be read
 * @private
 */
Node.Utils.fsList = async function (options, pathStats)
{
  if (!pathStats.isDirectory())
    throw new Error("Can't list a file");
  //
  // Read the directory
  let files;
  try {
    files = await Node.fs.promises.readdir(options.path);
  }
  catch (err) {
    throw new Error(`Can't list the directory content: ${err.message || err}`, {cause: err});
  }
  //
  // Now I've file names... I need all files info (cheap per-entry stat, run concurrently)
  let filesInfo = await Promise.all(files.map(async file => {
    try {
      let stats = await Node.fs.promises.stat(Node.path.join(options.path, file));
      let isDir = stats.isDirectory();
      //
      return {
        name: file,
        birthtime: stats.birthtime,
        mtime: stats.mtime,
        size: (isDir ? undefined : stats.size),
        mode: stats.mode,
        dir: isDir
      };
    }
    catch (err) {
      return {
        name: file,
        err
      };
    }
  }));
  //
  // Opt-in: measure directory entries too. The recursive walks are run one at a time
  // (never concurrently) so the whole listing keeps at most a single bounded fsDirSize
  // traversal in flight, avoiding EMFILE on wide directories of large sub-trees
  if (options.params.req.query.dirsize) {
    for (let info of filesInfo) {
      if (info.dir)
        info.size = await Node.Utils.fsDirSize(Node.path.join(options.path, info.name));
    }
  }
  //
  return filesInfo;
};


/**
 * Recursively computes the total size (in bytes) of a directory's content.
 * Entries that can't be read or stat-ed are skipped so a single unreadable file
 * (or an unreadable sub-directory) doesn't abort the whole computation.
 * @param {String} dirPath - Absolute path of the directory to measure
 * @returns {Promise<Number>} Total size in bytes of every file below dirPath
 * @private
 */
Node.Utils.fsDirSize = async function (dirPath)
{
  let entries;
  try {
    entries = await Node.fs.promises.readdir(dirPath, {withFileTypes: true});
  }
  catch {
    return 0;
  }
  //
  // Walk sequentially: recursing with Promise.all would fan out an unbounded number of
  // concurrent stat/readdir handles on large trees (the very case this is meant to measure)
  // and risk EMFILE, whose error would then be silently swallowed into an underestimated total
  let total = 0;
  for (let entry of entries) {
    let entryPath = Node.path.join(dirPath, entry.name);
    try {
      if (entry.isDirectory())
        total += await Node.Utils.fsDirSize(entryPath);
      else
        total += (await Node.fs.promises.stat(entryPath)).size;
    }
    catch {
      // Skip entries that can't be stat-ed
    }
  }
  //
  return total;
};


/**
 * Streams a file (or a tar.gz-compressed directory) to the HTTP response.
 * If options.path is a directory, it is first compressed into a .tar.gz archive
 * inside options.tempPath, then streamed and removed.
 * The ?inline query flag toggles between inline and attachment Content-disposition.
 * @param {Object} options - File system operation configuration (see handleFileSystem)
 * @param {Object} pathStats - Stats of options.path
 * @throws {Error} If streaming the file fails
 * @private
 */
Node.Utils.fsGet = async function (options, pathStats)
{
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
    options.params.res.writeHead(200, {
      "Content-disposition": (options.params.req.query.inline ? "inline" : `attachment; filename = ${Node.path.basename(filePath)}`),
      "Content-Length": (pathStats.isDirectory() ? (await Node.fs.promises.stat(filePath)).size : pathStats.size),
      "Content-Type": Node.mime.lookup(filePath)
    });
    //
    // Stream the file
    let rstream = Node.fs.createReadStream(filePath);
    await require("stream/promises").pipeline(rstream, options.params.res);
  }
  catch (err) {
    // A client abort (connection closed mid-download) is not a real error: pipeline has
    // already torn the file stream down. The finally block still removes the temp TAR.
    if (Node.Utils.isClientAbortError(err))
      return;
    //
    throw new Error(`Can't send file: ${err.message || err}`, {cause: err});
  }
  finally {
    // Remove temporary TAR file if it was created
    if (pathStats.isDirectory())
      await Node.fs.promises.rm(filePath, {force: true});
  }
};


/**
 * Handles file upload through a multipart form.
 * If options.path does not exist yet, a single dummy file is enough to create the directory;
 * otherwise every uploaded file is moved into options.path and - when ?extract is set -
 * any .tar.gz or .zip archive is automatically extracted and then removed.
 * @param {Object} options - File system operation configuration (see handleFileSystem)
 * @param {Object} [pathStats] - Stats of options.path (undefined when the path does not yet exist)
 * @throws {Error} If form parsing, directory creation, file moving or archive extraction fails
 * @private
 */
Node.Utils.fsPut = async function (options, pathStats)
{
  let form = new Node.multiparty.Form({autoFields: true, autoFiles: true, uploadDir: options.tempPath});
  let files = await new Promise((resolve, reject) => {
    form.parse(options.params.req, (err, fields, files) => {
      if (err) {
        options.params.res.status(500).end();
        reject(new Error(`Error parsing post request: ${err.message || err}`, {cause: err}));
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
      throw new Error(`Error while creating the new directory: ${err.message || err}`, {cause: err});
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
    // Security (issue #14643): basename() the upload filename so a multipart originalFilename
    // like "../../evil.js" can't escape options.path (arbitrary write as the server user = RCE).
    let newfile = Node.path.join(options.path, Node.path.basename(f.originalFilename));
    try {
      await Node.fs.promises.rename(f.path, newfile);
    }
    catch (err) {
      throw new Error(`Error moving POST file: ${err.message || err}`, {cause: err});
    }
    //
    // If the file needs to be extracted, do it and delete uploaded file
    if (options.params.req.query.extract)
      await Node.Utils.fsExtractArchive(newfile, options.path);
  }
};


/**
 * Extracts a .tar.gz or .zip archive into destPath and removes the archive file.
 * For .tar.gz the content is first validated via gunzip because the tar library
 * crashes asynchronously on invalid archives, leaving no way to detect the error otherwise.
 * @param {String} archivePath - Absolute path of the archive to extract
 * @param {String} destPath - Destination directory for the extracted content
 * @throws {Error} If the extension is unsupported, the archive is corrupt, or extraction/deletion fails
 * @private
 */
Node.Utils.fsExtractArchive = async function (archivePath, destPath)
{
  let lower = archivePath.toLowerCase();
  //
  if (lower.endsWith(".tar.gz")) {
    // tar.gz uses some junky library that has a problem: if the file has an invalid format
    // the extract method crashes in an asynchronous way... thus there is no way of knowing
    // if something is wrong... Thus, before I extract the file, I check if it's correct
    let buffer = await Node.fs.promises.readFile(archivePath);
    await new Promise((resolve, reject) => {
      Node.zlib.gunzip(buffer, (err, result) => {
        if (err)
          reject(new Error(`Error while checking the ${archivePath}: ${err.message || err}`, {cause: err}));
        else
          resolve(result);
      });
    });
    //
    // No errors -> extract with buggy method
    try {
      await Node.tar.extract({file: archivePath, cwd: destPath});
    }
    catch (err) {
      throw new Error(`Error during the ${archivePath} extraction: ${err.message || err}`, {cause: err});
    }
  }
  else if (lower.endsWith(".zip")) {
    try {
      // Use the common utility function for ZIP extraction.
      // Security (issue #14643): own the anti zip-slip containment instead of relying only on the
      // unzip library's internal filtering (same guard already used by archiver.js).
      await Node.Utils.extractZip(archivePath, destPath, {checkPathSecurity: true});
    }
    catch (err) {
      throw new Error(`Error while extracting the ZIP file: ${err.message || err}`, {cause: err});
    }
  }
  else
    throw new Error(`Error extracting the file ${archivePath}: unsupported file extension`);
  //
  // Delete the archive file after successful extraction
  try {
    await Node.fs.promises.rm(archivePath, {force: true});
  }
  catch (err) {
    throw new Error(`Error deleting the file ${archivePath}: ${err.message || err}`, {cause: err});
  }
};


/**
 * Deletes a file or directory recursively.
 * Refuses to touch the root "files" directory.
 * @param {Object} options - File system operation configuration (see handleFileSystem)
 * @throws {Error} If options.path points to the main FILES directory or if deletion fails
 * @private
 */
Node.Utils.fsDelete = async function (options)
{
  // Can't delete the "main" FILES directory. Comparing it with the jail root - handleFileSystem has
  // already resolved both - instead of looking for a path ending in "/files/", which missed the two
  // ways of naming the root: a "del" without a path parameter (path.join leaves no trailing separator)
  // and any path on Windows, where the separator is a backslash. Both wiped the folder (issue #14062)
  if (options.path === options.basePath)
    throw new Error("Can't delete FILES directory");
  //
  try {
    await Node.fs.promises.rm(options.path, {recursive: true, force: true});
  }
  catch (err) {
    throw new Error(`Error while deleting the file: ${err.message || err}`, {cause: err});
  }
};


/**
 * Copies or moves a file/directory to a new name inside options.basePath.
 * The target name comes from the 'newname' query parameter and must resolve inside options.basePath.
 * Refuses to touch the root "files" directory.
 * @param {Object} options - File system operation configuration (see handleFileSystem); options.command must be "copy" or "move"
 * @throws {Error} If options.path targets the main FILES directory, if newname is missing or not a string, if the destination escapes or coincides with options.basePath, or if the rename/copy fails
 * @private
 */
Node.Utils.fsCopyMove = async function (options)
{
  // Can't copy/rename the "main" FILES directory (see fsDelete for why it is a plain comparison)
  if (options.path === options.basePath)
    throw new Error(`Can't ${options.command === "move" ? "move" : "copy"} FILES directory`);
  //
  // A duplicated parameter (?newname=a&newname=b) arrives as an array, which path.join below rejects
  // with a raw TypeError: same reason the path parameter is checked up front (issue #14577)
  let newName = options.params.req.query?.newname;
  if (!newName || typeof newName !== "string")
    throw new Error("Missing or invalid newname parameter");
  //
  // Security (issue #14643): the copy/move destination must resolve inside the app/project files jail.
  // (Replaces the raw ".." check with the same containment used by handleFileSystem; also avoids
  // false-positives on legit names that merely contain "..", e.g. "file..bak".)
  // The destination does not exist yet, so realPath resolves its deepest existing ancestor: a newname
  // that walks through a symlink planted in the jail would otherwise write outside it. What gets
  // written is the path that was checked, not the one that was asked for. Strict like the source
  // check above: path.join collapses the segments, so a newname of "." or "sub/.." lands on the jail
  // root, which is no more a legitimate destination than it is a source (issue #14062)
  let target = await Node.Utils.realPath(Node.path.join(options.basePath, newName));
  if (!Node.Utils.isPathInside(target, [options.basePath], true))
    throw new Error("Destination outside of the allowed directory");
  //
  try {
    if (options.command === "move")
      await Node.fs.promises.rename(options.path, target);
    else {
      await new Promise((resolve, reject) => {
        Node.ncp(options.path, target, err => err ? reject(err) : resolve());
      });
    }
  }
  catch (err) {
    throw new Error(`Error while ${options.command === "move" ? "moving" : "copying"} the file/directory: ${err.message || err}`, {cause: err});
  }
};


/**
 * Calculates average CPU usage across all cores.
 * Computes the average idle and total tick counts for all CPU cores,
 * used as a baseline for measuring CPU load percentage.
 * @returns {Object} CPU usage metrics
 * @returns {Number} returns.idle - Average idle time across all CPU cores
 * @returns {Number} returns.total - Average total time across all CPU cores
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
 * Measures current CPU load percentage.
 * Takes two CPU measurements 200ms apart to calculate the actual CPU usage percentage
 * across all cores, rounded to 2 decimal places.
 * @returns {Promise<Number>} CPU load percentage (0-100)
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
 * Gets available disk space on the current drive.
 * Uses platform-specific commands (df on Linux/Mac, wmic on Windows) to determine
 * the free disk space available on the drive where the application is running.
 * @returns {Promise<Number>} Available disk space in bytes
 * @throws {Error} Throws error if disk space check fails
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
 * Encodes a string for safe HTML output.
 * Replaces special HTML characters with their entity equivalents to prevent XSS attacks.
 * @param {String} str - String to be HTML-encoded
 * @returns {String} HTML-safe encoded string
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
 * Tells whether an error raised while streaming a file to an HTTP response is just the client
 * dropping the connection (e.g. a `<video>` seek that aborts the current range request, or a
 * cancelled download) rather than a real failure. When streaming with `stream/promises.pipeline`
 * a client disconnect surfaces as `ERR_STREAM_PREMATURE_CLOSE` (or a raw `ECONNRESET`/`EPIPE`);
 * pipeline has already torn the file stream down, so the caller can simply stop with no error.
 * @param {Error} err - The error caught around the streaming call
 * @returns {Boolean} true when the error is a client-side abort that can be ignored
 */
Node.Utils.isClientAbortError = function (err)
{
  return ["ERR_STREAM_PREMATURE_CLOSE", "ECONNRESET", "EPIPE"].includes(err?.code);
};


/**
 * Extracts a ZIP file to the specified destination directory.
 * Common utility function for ZIP extraction used by multiple components
 * to eliminate code duplication across the framework.
 * @param {String} sourceZipPath - Path to the ZIP file to extract
 * @param {String} destinationDirPath - Directory where contents will be extracted
 * @param {Object} [options] - Optional extraction configuration
 * @param {Boolean} [options.checkPathSecurity=false] - Enable path traversal attack prevention
 * @throws {Error} When extraction fails or security check fails
 */
Node.Utils.extractZip = async function (sourceZipPath, destinationDirPath, options = {})
{
  // Ensure the destination directory exists
  await Node.fs.promises.mkdir(destinationDirPath, {recursive: true});
  //
  // Open the ZIP file
  let yauzl = require("yauzl-promise");
  let zipFile = await yauzl.open(sourceZipPath);
  //
  try {
    // Iterate through entries
    for await (let entry of zipFile) {
      // Skip the macOS service entries (__MACOSX folder and AppleDouble ._name files): they carry no
      // content, and without this they survive the import next to the project folder (issue #15508).
      // __MACOSX is matched at any depth, not just at the root: zipping a folder that already holds
      // one nests it. Zip entry names always use "/", whatever the platform that created the archive
      let segments = entry.filename.split("/");
      if (segments.includes("__MACOSX") || segments[segments.length - 1].startsWith("._"))
        continue;
      //
      // Process each entry
      let entryPath = Node.path.join(destinationDirPath, entry.filename);
      //
      // Optional security check for path traversal attacks
      if (options.checkPathSecurity) {
        // Security (issue #14643): resolve both sides and require the trailing separator, otherwise a
        // sibling dir sharing the prefix (dest ".../temp" vs entry "../temp-evil/x") would pass the check.
        let normalizedDest = Node.path.resolve(destinationDirPath);
        let normalizedPath = Node.path.resolve(entryPath);
        if (normalizedPath !== normalizedDest && !normalizedPath.startsWith(normalizedDest + Node.path.sep))
          throw new Error(`Attempted extraction outside of directory: ${normalizedPath}`);
      }
      //
      if (Node.Utils.isZipEntryDirectory(entry)) {
        // Entry is a directory
        await Node.fs.promises.mkdir(entryPath, {recursive: true});
      }
      else {
        // Entry is a file - Ensure parent directory exists
        await Node.fs.promises.mkdir(Node.path.dirname(entryPath), {recursive: true});
        //
        let readStream = await zipFile.openReadStream(entry);
        //
        let writeStream = Node.fs.createWriteStream(entryPath);
        await require("stream/promises").pipeline(readStream, writeStream);
      }
    }
  }
  finally {
    zipFile.close();
  }
};


/**
 * Sanitizes a string for use as a clean name.
 * Converts to lowercase, removes special characters, and replaces spaces with hyphens.
 * Only allows alphanumeric characters, hyphens, and spaces.
 * @param {String} str - String to be cleaned
 * @returns {String} Sanitized string suitable for use as a name
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
 * Converts an ArrayBuffer to a base64 encoded string.
 * Uses Node.js Buffer for server-side conversion or manual encoding for browser compatibility.
 * @param {ArrayBuffer} buffer - ArrayBuffer to convert
 * @returns {String} Base64 encoded string representation of the buffer
 * @see {@link https://www.npmjs.com/package/base64-arraybuffer} - Original implementation reference
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
 * Converts a base64 encoded string to an ArrayBuffer.
 * Decodes the base64 string and returns the binary data as an ArrayBuffer.
 * @param {String} base64 - Base64 encoded string to decode
 * @returns {ArrayBuffer} Decoded binary data as ArrayBuffer
 * @see {@link https://www.npmjs.com/package/base64-arraybuffer} - Original implementation reference
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
 * Generates arguments for child process forking.
 * Automatically assigns unique debug ports for Node.js inspector when debugging,
 * preventing port conflicts when spawning multiple child processes.
 * @returns {Object} Fork arguments object
 * @returns {Array} returns.execArgv - Modified execution arguments with unique inspector ports
 */
Node.Utils.forkArgs = function ()
{
  // Compute how many NODE processes are already running
  let execArgv = () => {
    return process.execArgv.map(e => {
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
  //
  return {
    execArgv: execArgv()
  };
};


/**
 * Returns the absolute path of the deployment root directory (`public_html`), which holds the
 * shared `server/`, the `ide/`, the `ides/` per-version bundles, plus `package.json`/`node_modules`.
 * Single source of truth for the base path of the install layout.
 * @returns {String} Absolute path of the deployment root
 */
Node.Utils.rootDir = function ()
{
  return Node.path.resolve(__dirname, "..");
};


/**
 * Returns the absolute path of the `ides` folder that holds the per-version IDE
 * bundles on a multi-version server (`public_html/ides`).
 * @returns {String} Absolute path of the ides folder
 */
Node.Utils.idesDir = function ()
{
  return Node.path.join(Node.Utils.rootDir(), "ides");
};


/**
 * Returns the absolute path of the root folder of a given installed IDE version
 * (`ides/ide_<version>`). The folder mirrors the repo layout: its own `ide/` and
 * `server/` plus package files and node_modules.
 * @param {String} version - IDE version (e.g. "26.3")
 * @returns {String} Absolute path of the version root folder
 */
Node.Utils.ideVersionDir = function (version)
{
  return Node.path.join(Node.Utils.idesDir(), `ide_${version}`);
};


/**
 * Resolves the absolute path of the IDE folder to use for a given version.
 * In a multi-version server the IDE of each installed version lives in
 * `ides/ide_<version>/ide`: when that folder exists it is returned, otherwise the
 * method falls back to the flat single-version `ide` folder, so behaviour is
 * unchanged when the server is not in multi-version mode and in local development.
 * @param {String} [version] - IDE version to resolve (e.g. "26.3"); when omitted or not installed the flat layout is used
 * @returns {String} Absolute path of the IDE folder
 */
Node.Utils.resolveIdeDir = function (version)
{
  if (version) {
    let versionedDir = Node.path.join(Node.Utils.ideVersionDir(version), "ide");
    if (Node.fs.existsSync(versionedDir))
      return versionedDir;
  }
  //
  // Fallback: flat single-version layout (server not in multi-version mode / local development)
  return Node.path.join(Node.Utils.rootDir(), "ide");
};


/**
 * Compares two version strings numerically, segment by segment, so that
 * "26.10" > "26.2" and "26.3.1" > "26.3". Missing segments count as 0.
 * Only the numeric release part is compared: a version may decorate it with a branch tag
 * and a build date (e.g. "1.2-XX.<date>"), which are metadata — if kept in the comparison,
 * the date would land into a numeric slot and outweigh any real release segment. Parsing
 * stops at the first decorated segment, keeping its numeric prefix; two builds of the same
 * release compare as equal.
 * @param {String} a - First version
 * @param {String} b - Second version
 * @returns {Number} A value > 0 if a > b, < 0 if a < b, 0 if equal
 */
Node.Utils.compareVersions = function (a, b)
{
  let parse = v => {
    let segs = [];
    for (let s of (v || "").split(".")) {
      segs.push(parseInt(s, 10) || 0);
      if (!/^\d+$/.test(s))
        break;
    }
    return segs;
  };
  //
  let sa = parse(a);
  let sb = parse(b);
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    let diff = (sa[i] || 0) - (sb[i] || 0);
    if (diff)
      return diff;
  }
  //
  return 0;
};


/**
 * Saves an object to a JSON file.
 * Serializes the object to JSON and writes it to the specified file.
 * If the object is null or undefined, deletes the file instead.
 * @param {String} filename - Path to the JSON file
 * @param {Object} obj - Object to save, or null/undefined to delete the file
 */
Node.Utils.saveObject = async function (filename, obj)
{
  // If there is no object, remove JSON file and return
  if (!obj)
    return await Node.fs.promises.rm(filename, {force: true});
  //
  // Write atomically: serialize to a unique temp file, then rename it onto the target.
  // rename() is atomic on the same filesystem, so a concurrent or interrupted write can
  // never leave a half-written / corrupt JSON file behind.
  let tmp = `${filename}.${process.pid}-${Node.crypto.randomUUID()}.tmp`;
  try {
    await Node.fs.promises.writeFile(tmp, JSON.stringify(obj));
    await Node.fs.promises.rename(tmp, filename);
  }
  catch (ex) {
    await Node.fs.promises.rm(tmp, {force: true});
    throw ex;
  }
};


/**
 * Loads an object from a JSON file.
 * Reads and parses a JSON file, returning the deserialized object.
 * Returns undefined if the file doesn't exist.
 * @param {String} filename - Path to the JSON file
 * @returns {Promise<Object|undefined>} The parsed object or undefined if file doesn't exist
 * @throws {Error} Throws error if JSON parsing fails
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


/**
 * Unlocks the Express request query property for modification.
 * Makes the req.query property configurable by converting it to a getter/setter,
 * allowing middleware to modify query parameters after initial parsing.
 * @param {Object} req - Express request object
 */
Node.Utils.unlockRequestQuery = function (req)
{
  let query = req.query;
  Object.defineProperty(req, "query", {
    configurable: true,
    enumerable: true,
    get: () => req._query = req._query || {},
    set: q => req._query = q
  });
  req.query = query;
};


/**
 * Returns whether the request targets an IDE session (URL form [sid]/[appid]/run).
 * @param {Request} req - Express request object
 * @returns {Boolean} True when the URL carries a session id parameter
 */
Node.Utils.isIDERequest = function (req)
{
  return !!req.params.sid;
};


/**
 * Returns whether the request targets a WebAPI endpoint (URL form [app]/[clsid] or [app]/[clsid]/*).
 * @param {Request} req - Express request object
 * @returns {Boolean} True when the URL carries a WebAPI class parameter
 */
Node.Utils.isWebApiRequest = function (req)
{
  return !!req.params.cls;
};


/**
 * Returns whether the request comes from a bot (as detected by the express-useragent middleware).
 * @param {Request} req - Express request object
 * @returns {Boolean} True when the useragent middleware flagged the request as a bot
 */
Node.Utils.isBotRequest = function (req)
{
  return !!req.useragent?.isBot;
};


/**
 * Fixes and extends MIME type mappings.
 * Corrects incorrect default MIME types and adds support for additional file formats
 * like YAML that may not be properly recognized by default.
 */
Node.Utils.fixMimeTypes = function ()
{
  // Fix mime types
  Node.mime = require("mime-types");
  Node.mime.types["mp4"] = "video/mp4"; // Force mp4 to be video/mp4 (not application/mp4) 
  Node.mime.types["mpg4"] = "video/mp4"; // Force mpg4 to be video/mp4 (not application/mp4)
  Node.mime.types["yaml"] = "text/yaml"; // Add support for YAML files
  Node.mime.types["yml"] = "text/yaml"; // Add support for YML files
};


/**
 * Checks if running in IDF (Instant Developer Foundation) environment.
 * Determines if the current process is running within an Electron-based IDF application.
 * @returns {Boolean} True if running in IDF/Electron, false otherwise
 */
Node.Utils.isIDF = function ()
{
  return process.versions.electron;
}

// Export module
module.exports = Node.Utils;
