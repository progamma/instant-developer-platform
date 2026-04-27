/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
var Node = Node || {};

// Import modules
Node.fs = require("fs");
Node.crypto = require("crypto");
Node.mime = require("mime-types");
Node.ncp = require("../ncp_fixed");
Node.multiparty = require("multiparty");
Node.child = require("child_process");
Node.path = require("path");

// Import Classes
Node.Archiver = require("../archiver");
Node.Utils = require("../utils");


/**
 * @class Represents an Instant Developer Project
 * @param {Node.User} par
 */
Node.Project = function (par)
{
  this.parent = par;
};


Node.Project.msgTypeMap = {
  branchRestored: "brarst",
  resourceUploaded: "ru"
};


// Define usefull properties for this object
Object.defineProperties(Node.Project.prototype, {
  user: {
    get() {
      return this.parent;
    }
  },
  server: {
    get() {
      return this.parent.parent.parent;
    }
  },
  config: {
    get() {
      return this.parent.parent;
    }
  },
  logger: {
    get() {
      return this.server.logger;
    }
  }
});


/**
 * Log a new message
 * @param {string} level - message level (DEBUG, INFO, WARN, ERROR)
 * @param {string} message - text message
 * @param {string} sender - function that generated the message
 * @param {object} data - optional data to log
 */
Node.Project.prototype.log = function (level, message, sender, data)
{
  // Add "local" info
  data = (data ? JSON.parse(JSON.stringify(data)) : {});
  data.project = this.name;
  data.user = this.user.userName;
  //
  this.logger.log(level, message, sender, data);
};


/**
 * Save the object
 */
Node.Project.prototype.save = function ()
{
  let r = {
    cl: "Node.Project",
    id: this.id,
    name: this.name,
    version: this.version,
    public: this.public,
    twMaster: this.twMaster,
    twFork: this.twFork,
    lastSave: this.lastSave,
    lastSaveID: this.lastSaveID,
    ivAES: this.ivAES,
    ivAESdtt: this.ivAESdtt
  };
  return r;
};


/**
 * Load the object
 * @param {Object} v - the object that contains my data
 */
Node.Project.prototype.load = function (v)
{
  this.id = v.id;
  this.name = v.name;
  this.version = v.version;
  this.public = v.public;
  this.twMaster = v.twMaster;
  this.twFork = v.twFork;
  this.lastSave = v.lastSave;
  this.lastSaveID = v.lastSaveID;
  this.ivAES = v.ivAES;
  this.ivAESdtt = v.ivAESdtt;
};


/**
 * Save the object's properties (i.e. no children objects)
 */
Node.Project.prototype.saveProperties = function ()
{
  let r = this.save();
  //
  // Delete children
  delete r.cl;
  //
  // Add usefull properties
  r.user = this.user.saveProperties();
  r.company = this.config.serverType;
  r.cloudPath = `users/${this.config.serverType}/${this.user.userName}/${this.name}`;
  r.reconnectToken = this.reconnectToken;
  //
  return r;
};


/**
 * Set the parent of this object (and its children)
 * @param {Object} p - my parent
 */
Node.Project.prototype.setParent = function (p)
{
  this.parent = p;
};


/**
 * Check Project configuration creating the folder it does not exist
 */
Node.Project.prototype.check = async function ()
{
  await this.createProjectFolder();
};


/**
 * Update project's data (coming from the session's child process)
 * @param {Object} info - object that contains project's info
 */
Node.Project.prototype.updateInfo = function (info)
{
  for (let k in info) {
    if (info[k] === null)
      delete this[k];
    else
      this[k] = info[k];
  }
  //
  // Save CONFIG
  this.config.saveConfig();
};


/**
 * Initialize a new project object
 * @param {type} projectName
 */
Node.Project.prototype.init = async function (projectName)
{
  this.name = projectName;
  //
  // Generate data for saving the project into ChromeFS
  this.id = Node.Utils.generateUID36().substring(0, 32);
  this.ivAES = Array.from(Node.crypto.randomBytes(16));
  //
  // Create the project folder if needed
  await this.createProjectFolder();
};


/**
 * Returns true if this project "is online" (i.e. there is
 * an IDE session open on it)
 */
Node.Project.prototype.isOnline = function ()
{
  let skeys = Object.keys(this.server.IDESessions);
  for (let i = 0; i < skeys.length; i++) {
    let sess = this.server.IDESessions[skeys[i]];
    if (sess.project === this)
      return true;
  }
};


/**
 * Create the Project folder and all inner folders if they do not exist
 */
Node.Project.prototype.createProjectFolder = async function ()
{
  let path = Node.path.join(this.config.directory, this.user.userName, this.name);
  let foldersToCreate = [
    "",
    "branches",
    "build",
    "files",
    "files/blobs",
    "files/private",
    "files/temp",
    "files/uploaded",
    "resources",
    "tutorials"
  ];
  //
  let logData;
  try {
    // Create all folders
    for (let p of foldersToCreate) {
      let pathToCreate = Node.path.join(path, p);
      try {
        await Node.fs.promises.mkdir(pathToCreate);
      }
      catch (err) {
        if (err.code !== "EEXIST")
          throw new Error(`Error creating the project folder ${pathToCreate}: ${err}`);
      }
    }
    //
    // If not LOCAL, fix permissions
    if (!this.config.local) {
      try {
        await this.server.execFileAsRoot("ChownChmod", [this.user.OSUser, path]);
      }
      catch (err) {
        logData = {OSUser: this.user.OSUser, path};
        throw new Error(`Error changing project folder permissions: ${err}`);
      }
    }
  }
  catch (err) {
    this.log("ERROR", err, "Project.createProjectFolder", logData);
    throw err;
  }
};


/**
 * Delete the Project folder and all the files
 */
Node.Project.prototype.deleteProjectFolder = async function ()
{
  let path = Node.path.join(this.config.directory, this.user.userName, this.name);
  let logData;
  try {
    // Before deleting the project folder I need to be sure I'm able to do it -> fix permissions
    if (!this.config.local && Node.fs.existsSync(path)) {
      try {
        await this.server.execFileAsRoot("ChownChmod", [this.user.OSUser, path]);
      }
      catch (err) {
        logData = {OSUser: this.user.OSUser, path};
        throw new Error(`Error changing the project folder permissions: ${err}`);
      }
    }
    //
    // Delete the project folder
    try {
      await Node.fs.promises.rm(path, {recursive: true, force: true});
    }
    catch (err) {
      throw new Error(`Error deleting the project folder ${path}: ${err}`);
    }
  }
  catch (err) {
    this.log("ERROR", err, "Project.deleteProjectFolder", logData);
    throw err;
  }
};


/**
 * Edit the project
 * @param {object} params
 */
Node.Project.prototype.editProject = async function (params)
{
  // If needed, check the edit prj token
  if (this.config.editPrjToken && (!this.token || params.req.query.t !== this.token)) {
    this.log("WARN", "Unauthorized", "Project.editProject");
    throw {err: "Unauthorized", code: 401};
  }
  //
  // Remember the token I've received for editing.
  // It must be used by a client that has long-disconnected if the editing session is gone and
  // the client asks to create a new session
  this.reconnectToken = this.token;
  //
  // Invalidate the token (if it was there)
  delete this.token;
  //
  // First try to see if there is an open session for this project...
  let session = this.server.getOpenSession(this, {type: "ide", readOnly: undefined});
  //
  // If there is already a session
  if (session) {
    this.log("DEBUG", "Found old open session", "Project.editProject", {sid: session.id});
    //
    // If the session is dying
    if (session.killSessionTimer) {
      // Note: I want to handle REFRESH (F5) but I don't want the user to use this dying session if it has been disconnected too long ago
      //
      // If this session has been killed more than 3 seconds ago
      if ((new Date() - session.killSessionTimer.start) > 3000) {
        this.log("WARN", "Previous session scheduled to die MORE than 3 seconds ago... replace it with a new one", "Project.editProject",
                {sid: session.id, deathDelta: (new Date() - session.killSessionTimer.start)});
        //
        // I can't leave this session alive and create a new one... there would be two sessions
        // and if the "old" (dying) session gets back I'll get in trouble!!!
        // Kill the dying session NOW so that I can replace it with a new one...
        session.closeAllConnections();
        session = undefined;
      }
      else { // The session has been killed less than 3 seconds ago. Use it
        this.log("DEBUG", "Previous session scheduled to die LESS than 3 seconds ago... stop death and use it", "Project.editProject",
                {sid: session.id, deathDelta: (new Date() - session.killSessionTimer.start)});
        //
        // Restart kill timer... otherwise this session will be dead soon!
        session.startAutoKillTimer(60000);
      }
    }
  }
  //
  // Check free space on disk... if it's too low open the project as readonly (so that
  // the developer will be unable to save)
  let available;
  if (!this.config.lowDiskThreshold)
    available = 1E12; // Do not check if there is no limit...
  else
    try {
      available = await Node.Utils.getFreeDiskSize();
    }
    catch (err) {
      this.log("ERROR", `Can't get free disk space: ${err}`, "Project.editProject");
      throw new Error(`Can't get free disk space: ${err}`);
    }
  //
  let openParams = (Object.keys(params.req.query).length ? params.req.query : undefined);
  let readOnly;
  if (available < this.config.lowDiskThreshold) {
    this.log("WARN", `Disk space left on device is too low -> project opened as readonly`, "Project.editProject", {available, lowDiskThreshold: this.config.lowDiskThreshold});
    readOnly = true;
    openParams = openParams || {};
    openParams.lowDiskSpace = true;  // Tell the process that we are low on disk space (it will tell the user)
    //
    // If I had a session but it was not readonly, I can't use that!
    if (session && !session.options.readOnly) {
      session.closeAllConnections();  // Don't live it alive
      session = undefined;
    }
  }
  //
  let bck = (openParams?.bck === "true");
  let jsonpath = Node.path.join(this.config.directory, this.user.userName, this.name, "project.json");
  if (bck && !Node.fs.existsSync(`${jsonpath}.good`)) {
    bck = false;
    this.log("DEBUG", "Restore stopped (.good file does not exist)", "Project.editProject");
  }
  //
  if (bck) {
    // Delete the old project.json file
    await Node.fs.promises.rm(jsonpath, {force : true});
    //
    // Rename the old .good file in a valid project name
    await Node.fs.promises.rename(`${jsonpath}.good`, jsonpath);
  }
  //
  // If not found, create a new session for this project
  if (!session) {
    this.log("DEBUG", "Create a new IDE session", "Project.editProject");
    if (openParams?.maxViews === undefined && this.config.licdata?.maxtables && Node.Utils.isIDF()) {
      openParams = openParams || {};
      openParams.maxViews = parseInt(this.config.licdata.maxtables);
    }
    session = this.server.createSession(this, {readOnly, openParams});
  }
  //
  // Protects SID cookie
  session.protectSID(params.req, params.res);
  //
  // Redirect to the MAIN page with the sid as querystring
  params.res.redirect(`${this.config.getMainFile()}?sessionid=${session.id}${bck ? "&bck=true" : ""}`);
  //
  // Done
  return {skipReply: true};
};


/**
 * Create a session for viewing the project (readonly mode)
 * @param {object} params
 */
Node.Project.prototype.viewProject = async function (params)
{
  // If the project is not public and the edit prj token is enabled it must match
  if (!this.public && this.config.editPrjToken && (!this.token || params.req.query.t !== this.token)) {
    this.log("WARN", "Unauthorized", "Project.viewProject");
    throw {err: "Unauthorized", code: 401};
  }
  //
  // Create a new session for this project (READONLY mode)
  // Pass query string params if any
  let qry = (Object.keys(params.req.query).length ? params.req.query : undefined);
  //
  // If this is an openDTT operation
  if (qry?.showDtt) {
    // If needed generate key for dtt projects crypting
    if (!this.ivAESdtt) {
      this.ivAESdtt = [];
      for (let i = 0; i < 16; i++)
        this.ivAESdtt[i] = Math.floor((Math.random() * 256) + 1);
      //
      // Save the new configuration
      this.config.saveConfig();
    }
    //
    // Send them to client so that it can save/load DTT projects
    qry.ivAESdtt = this.ivAESdtt;
  }
  let session = this.server.createSession(this, {readOnly: true, openParams: qry});
  //
  // Protects SID cookie
  session.protectSID(params.req, params.res);
  //
  // Redirect to the page with the sid as querystring
  params.res.redirect(`${this.config.getMainFile()}?sessionid=${session.id}`);
  //
  // If it's a course forget about RID (the document will send the "RID" reply when the
  // project will be closed (see InDe.Document.prototype.sendPrjInfoToConsole))
  if (qry?.course)
    delete params.req.query.rid;
  //
  // Done
  return {skipReply: true};
};


/**
 * Download a file from one of project's folders
 * @param {object} params
 */
Node.Project.prototype.downloadFile = async function (params)
{
  // The URL is in the following form:
  //   http://servername/username/projectname/folder/filename
  let folder = params.tokens.slice(0, params.tokens.length - 1).join("/").replace(/\+/g, " ");   // resources, tutorials, files (with AUTK)
  let filename = decodeURIComponent(params.tokens[params.tokens.length - 1].replace(/\+/g, " "));
  let path = Node.path.join(this.config.directory, this.user.userName, this.name, folder, filename);
  //
  let code, warning;
  try {
    // Send the file only if there is an editing session
    // (don't check resources/libusage.json... that file is asked whenever the callee needs it)
    if (folder !== "resources" || filename !== "libusage.json") {
      let session = this.server.getOpenSession(this, {request: params.req});
      if (!session) {
        warning = true;
        throw new Error("No session is asking for this file");
      }
    }
    //
    // filename must not contain ..
    if (filename.includes("..")) {
      warning = true;
      throw new Error("Double dot operator (..) not allowed");
    }
    //
    // Accept only a single ".." (Console uses it... :-|)
    if (folder.split("..").length > 2) {
      warning = true;
      throw new Error("Double dot operator (..) not allowed");
    }
    //
    // If it's a resource inside a branch (PR)
    //   resources/branches/OTHERUSER_FORKEDPROJECT_FORKEDBRANCH/resources
    // translates to
    //   [DIRECTORY]/[USERNAME]/[PRJNAME]/branches/OTHERUSER_FORKEDPROJECT_FORKEDBRANCH/resources/[FILENAME]
    let sfolder = folder.split("/");
    if (sfolder.length === 4 && sfolder[0] === "resources" && sfolder[1] === "branches" && sfolder[3] === "resources")  // resources/branhces/[BRANCH_NAME]/resources
      path = Node.path.join(this.config.directory, this.user.userName, this.name, folder.substring("resources/".length), filename);
    //
    // Full path must be valid and not a directory
    let pathStats;
    try {
      pathStats = await Node.fs.promises.stat(path);
    }
    catch {
      code = 404;
      warning = true;
      throw new Error("Can't get file info (file is missing?)");
    }
    //
    if (pathStats.isDirectory()) {
      warning = true;
      throw new Error("Invalid path (file is a directory)");
    }
    //
    // Compute the mimetype
    let mimetype = Node.mime.lookup(filename);
    //
    // If the file is an AUDIO or a VIDEO resource and a RANGE was provided
    if (mimetype && (mimetype.includes("audio") || mimetype.includes("video")) && params.req.headers.range) {
      let positions = params.req.headers.range.replace(/bytes=/, "").split("-");
      //
      let stats;
      try {
        stats = await Node.fs.promises.stat(path);
      }
      catch (err) {
        code = 404;
        throw new Error(`Error while reading file ${path}'s stats: ${err}`);
      }
      //
      let total = stats.size;
      let start = parseInt(positions[0], 10);
      let end = positions[1] ? parseInt(positions[1], 10) : total - 1;
      //
      // Send the requested file slice
      params.res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Accept-Ranges": "bytes",
        "Content-Length": (end - start) + 1,
        "Content-Type": mimetype
      });
      //
      try {
        let stream = Node.fs.createReadStream(path, {start, end});
        await new Promise((resolve, reject) => {
          stream.on("open", () => stream.pipe(params.res));
          stream.on("end", resolve);
          stream.on("error", reject);
        });
        return {skipReply: true};
      }
      catch (err) {
        code = 404;
        throw new Error(`Error while streaming file ${path}: ${err}`);
      }
    }
    //
    // Send the full file
    params.res.writeHead(200, {"Content-Type": mimetype});
    try {
      let stream = Node.fs.createReadStream(path);
      await new Promise((resolve, reject) => {
        stream.on("open", () => stream.pipe(params.res));
        stream.on("end", resolve);
        stream.on("error", reject);
      });
      return {skipReply: true};
    }
    catch (err) {
      code = 404;
      warning = true;
      throw new Error(`Error while sending the file ${path}: ${err}`);
    }
  }
  catch (e) {
    this.log(warning ? "WARN" : "ERROR", e.message || e, "Project.downloadFile");
    throw {err: e, code};
  }
};


/**
 * Handle file system commands
 * @param {object} params
 */
Node.Project.prototype.handleFileSystem = async function (params)
{
  let prjFilesPath = Node.path.join(this.config.directory, this.user.userName, this.name, "files");
  let objPath = params.req.query.path || "";    // (optional)
  let logData;
  try {
    let options = {
      path: Node.path.join(prjFilesPath, objPath),
      command: params.tokens[1],
      basePath: prjFilesPath,
      tempPath: Node.path.join(prjFilesPath, "temp")
    };
    //
    this.log("DEBUG", "Handle file system command", "Project.handleFileSystem", options);
    //
    // Append original params map
    options.params = params;
    //
    // Function for fixing permissions
    let fixPathPermissions = async () => {
      if (/^win/.test(process.platform))
        return;
      //
      try {
        await this.server.execFileAsRoot("ChownChmod", [this.user.OSUser, prjFilesPath]);
      }
      catch (err) {
        logData = {OSUser: this.user.OSUser, path: prjFilesPath};
        throw new Error(`Error changing folder permissions: ${err}`);
      }
    };
    //
    // If it's a WRITE operation, I need to fix permissions BEFORE I execute the command
    if (["put", "del", "move"].includes(options.command))
      await fixPathPermissions();
    //
    // Handle the command
    let res = await Node.Utils.handleFileSystem(options);
    //
    // If it's a PUT operation, fix permissions after I've executed the command
    if (options.command === "put")
      await fixPathPermissions();
    //
    return res;
  }
  catch (err) {
    this.log("WARN", `Error while handling file system command: ${err.err || err.message || err}`, "Project.handleFileSystem", logData);
    throw err;
  }
};


/**
 * Upload a file to the project's RESOURCES folder
 * @param {object} params
 */
Node.Project.prototype.uploadResource = async function (params)
{
  // The URL is in the following form:
  //   http://servername/username/projectname/upload/filename
  let filename = params.tokens[1];
  let path = Node.path.join(this.config.directory, this.user.userName, this.name, "resources", filename);
  //
  let logData;
  let warning = false;
  try {
    // filename must be a valid GUID followed by "." and the extension
    if (!filename.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.?\w*$/i)) {
      warning = true;
      throw new Error("Invalid file name (not a GUID)");
    }
    //
    // Get the session that will receive this resource
    let session = this.server.getOpenSession(this, {type: "ide", readOnly: undefined, request: params.req});
    if (!session) {
      // Session is not there... check if it's a course... he is allowed to upload files
      // (course is IDE, readonly with openParams.course)
      session = this.server.getOpenSession(this, {type: "ide", readOnly: true, request: params.req});
      if (session && (!session.options.openParams || !session.options.openParams.course))
        session = null;
    }
    if (!session) {
      warning = true;
      throw new Error("No session is waiting for this resource");
    }
    //
    // Parse the request
    let form = new Node.multiparty.Form();
    await new Promise((resolve, reject) => {
      form.on("part", part => {
        // Write content of post request in the file
        let writable = Node.fs.createWriteStream(path);
        part.pipe(writable);
        writable.on("finish", async () => {
          try {
            // If not LOCAL, fix permissions
            if (!this.config.local) {
              try {
                await this.server.execFileAsRoot("ChownChmod", [this.user.OSUser, path]);
              }
              catch (err) {
                logData = {OSUser: this.user.OSUser, path};
                throw new Error(`Error changing the resource permissions: ${err}`);
              }
            }
            //
            // Done -> tell the session that a new resource has been uploaded
            session.sendToChild({
              type: Node.Project.msgTypeMap.resourceUploaded,
              guid: filename
            });
            resolve();
          }
          catch (err) {
            reject(err);
          }
        });
        writable.on("error", err => reject(new Error(`Error while writing the file ${path}: ${err}`)));
      });
      form.on("error", err => reject(new Error(`Error in form parsing: ${err}`)));
      form.parse(params.req);
    });
  }
  catch (err) {
    this.log(warning ? "WARN": "ERROR", err.message || err, "Project.uploadResource", logData);
    throw err;
  }
};


/**
 * Send project status
 * @param {object} params
 */
Node.Project.prototype.sendStatus = async function (params)
{
  let stat = {
    version: this.version,
    public: this.public,
    lastSave: this.lastSave
  };
  //
  // If local or Windows -> can't compute dir sizes
  if (!(this.config.local || /^win/.test(process.platform))) {
    // Get the size of the project directory
    let stdout;
    let path = Node.path.join(this.config.directory, this.user.userName, this.name);
    try {
      stdout = await this.server.execFileAsRoot("/usr/bin/du", ["-k", "-a", "-d", "1", path]);
    }
    catch (err) {
      this.log("ERROR", `Error getting the size of project folder: ${err}`, "Project.sendStatus", {path});
      throw new Error(`Error getting the size of project folder: ${err}`);
    }
    //
    stat.pathSizes = {};
    let sizes = stdout.split("\n");
    for (let i = 0; i < sizes.length - 1; i++) {                        // Last one is an empty row
      let size = Math.ceil(parseFloat(sizes[i].split("\t")[0]) * 1024);
      let dir = sizes[i].split("\t")[1].substring(path.length + 1);     // Remove path
      //
      switch (dir) {
        case "branches":
        case "trans":
        case "TwConfig.json":
        case "TwConfig.json.bak":
          stat.pathSizes.twSize = (stat.pathSizes.twSize || 0) + size;
          break;
          
        case "project.json":
          stat.pathSizes.prjSize = size;
          break;

        case "build":
          stat.pathSizes.buildSize = size;
          break;

        case "files":
          stat.pathSizes.filesSize = size;
          break;

        case "resources":
          stat.pathSizes.resSize = size;
          break;

        case "":
          stat.diskSize = size;
          break;
      }
    }
  }
  //
  return {msg: JSON.stringify(stat)};
};


/**
 * Change the project configuration via web commands
 * @param {object} params
 */
Node.Project.prototype.configure = async function (params)
{
  // Compute the array of properties provided via url
  let query = params.req.query;
  let queryProps = Object.getOwnPropertyNames(query);
  if (queryProps.length === 0) {
    this.log("WARN", "No property specified", "Project.configure");
    throw new Error("No property specified");
  }
  //
  if (query.public) {
    if (query.public === "false")
      this.public = false;
    else if (query.public === "true")
      this.public = true;
  }
  //
  // Save the new configuration
  this.config.saveConfig();
  //
  // Log the operation
  this.log("DEBUG", "Updated project configuration", "Project.configure", {config: query});
  //
  // If the user changed DESCRIPTION or ICONURL I need to send this information to a new IDE session that
  // have to "apply" that configuration change into the project. If everything is fine I can report to callee
  if (query.description !== undefined || query.iconUrl !== undefined) {
    // Configure the project. If there is an open session it can't be done
    if (this.server.getOpenSession(this)) {
      this.log("WARN", "Can't configure the project: open IDE session", "Project.configure");
      throw new Error("Can't configure the project: open IDE session");
    }
    //
    // No session available. Use a "worker" session
    let session = this.server.createSession(this, {type: "configProject", params: params.req.query});
    await session.waitCompleted();
  }
};


/**
 * Handle a generic TW request
 * @param {object} params
 */
Node.Project.prototype.teamworksCmd = async function (params)
{
  let command = params.tokens[0];
  let session = this.server.createSession(this, {type: "teamworksCmd", twcommand: command, twparams: params.req.query});
  let result = await session.waitCompleted();
  return {msg: JSON.stringify(result.data)};
};


/*
 * Set the token coming from the console (this token allows the project to be edited)
 * @param {object} params
 */
Node.Project.prototype.setToken = function (params)
{
  // Read and store the token
  this.token = params.req.query.t;
};


/*
 * Resets the keys used for storing the project into browser's file system
 * @param {object} params
 */
Node.Project.prototype.resetKeys = function (params)
{
  this.log("INFO", "Reset encryption keys", "Project.resetKeys");
  this.updateInfo({lastSaveID: null, ivAES: null});
};


/**
 * Backup the project into the cloud
 * @param {object} params
 */
Node.Project.prototype.backup = async function (params)
{
  let archiver = new Node.Archiver(this.server, params.req?.query.nigthly);
  let path = Node.path.join(this.config.directory, this.user.userName, this.name);
  let pathTemp = Node.path.join(this.config.directory, this.user.userName, `tmp_${this.name}`);
  //
  let pathCloud;
  if (params.req?.query.path) {
    // Given path could be a full file path (with .tar.gz extension) or a folder
    pathCloud = params.req.query.path;
    if (!pathCloud.endsWith(".tar.gz"))
      pathCloud += `/${this.name}.tar.gz`;   // Was a folder
  }
  else
    pathCloud = `users/${this.config.serverType}/${this.user.userName}/backups/projects/${this.name}/${this.name}.tar.gz`;
  //
  this.log("DEBUG", "Project backup", "Project.backup", {pathCloud, params: (params.req ? params.req.query : undefined)});
  //
  try {
    let err;
    try {
      // If we are in the server adjust files permissions to 770 and files ownership to owner (user) BEFORE backing up
      if (!this.config.local) {
        try {
          await this.server.execFileAsRoot("ChownChmod", [this.user.OSUser, path]);
        }
        catch (err) {
          throw new Error(`Error changing the project folder permissions: ${err.message || err}`);
        }
      }
      //
      // If no path nor exclude were given
      let pathToBackup;
      if (params.req?.query.path || params.req?.query.exclude) {
        // If an exclude list was provided, define filter function
        let filterFnc;
        if (params.req.query.exclude) {
          let exclList = params.req.query.exclude.split(";");
          filterFnc = fileName => {
            fileName = fileName.replace(/\\/g, "/");   // Windows
            //
            let copyFile = true;
            for (let i = 0; i < exclList.length && copyFile; i++) {
              let excl = Node.path.join(path, exclList[i]).replace(/\\/g, "/");
              //
              // If the exclude path is a directory exclude the directory itself
              let fn = fileName;
              if (excl.endsWith("/"))
                fn += "/";
              if (fn.startsWith(excl))
                copyFile = false;
            }
            return copyFile;
          };
        }
        //
        // Remove the temp folder if present (due to a failed previous backup)
        try {
          await Node.fs.promises.rm(pathTemp, {recursive: true, force: true});
        }
        catch (err) {
          throw new Error(`Error removing the previous temp folder (${pathTemp}): ${err.message || err}`);
        }
        //
        // Create a temp folder
        try {
          await Node.fs.promises.mkdir(pathTemp);
        }
        catch (err) {
          throw new Error(`Error creating the ${pathTemp} folder: ${err.message || err}`);
        }
        //
        // Copy the project folder with filter function
        pathToBackup = Node.path.join(pathTemp, this.name);
        try {
          await new Promise((resolve, reject) => {
            Node.ncp(path, pathToBackup, {filter: filterFnc}, e => e ? reject(e) : resolve());
          });
        }
        catch (err) {
          throw new Error(`Error copying the folder: ${err.message || err}`);
        }
        //
      }
      else // Simply backup the entire directory
        pathToBackup = path;
      //
      // Do backup
      try {
        await archiver.backup(pathToBackup, pathCloud);
      }
      catch (err) {
        throw new Error(`Error while backing up project ${this.name}: ${err.message || err}`);
      }
    }
    catch (e) {
      err = e;
      throw e;
    }
    finally {
      // Delete the temp folder
      try {
        await Node.fs.promises.rm(pathTemp, {recursive: true, force: true});
      }
      catch (e) {
        if (!err)
          err = Error(`Error removing the temp folder (${pathTemp}): ${e.message || e}`);
      }
    }
    //
    if (err)
      throw err;
    //
    this.log("INFO", "Backup of the project succeeded", "Project.backup");
  }
  catch (err) {
    this.log("ERROR", err.message || err, "Project.backup");
    throw err;
  }
};


/**
 * Restore the project from the cloud
 * @param {object} params
 */
Node.Project.prototype.restore = async function (params)
{
  let archiver = new Node.Archiver(this.server, params.req?.query.nigthly);
  let path = Node.path.join(this.config.directory, this.user.userName, this.name);
  let pathTemp = Node.path.join(this.config.directory, this.user.userName, `tmp_${this.name}`);
  //
  let pathCloud;
  if (params.req?.query.path) {
    // Given path could be a full file path (with .tar.gz extension) or a folder
    pathCloud = params.req.query.path;
    if (!pathCloud.endsWith(".tar.gz"))
      pathCloud += `/${this.name}.tar.gz`;   // Was a folder
  }
  else
    pathCloud = `users/${this.config.serverType}/${this.user.userName}/backups/projects/${this.name}/${this.name}.tar.gz`;
  //
  this.log("DEBUG", "Project restore", "Project.restore", {pathCloud, params: (params.req ? params.req.query : undefined)});
  //
  try {
    let err;
    try {
      // Create a temp folder
      try {
        await Node.fs.promises.mkdir(pathTemp);
      }
      catch (err) {
        throw new Error(`Error creating the ${pathTemp} folder: ${err.message || err}`);
      }
      //
      // Restore files from the cloud
      await archiver.restore(Node.path.join(pathTemp, this.name), pathCloud);
      //
      // Get the name of the first object inside the temporary folder
      // (should be the name of the "original" project)
      let files;
      try {
        files = await Node.fs.promises.readdir(pathTemp);
      }
      catch (err) {
        throw new Error(`Error retrieving the first file: ${err.message || err}`);
      }
      //
      // Copy all files from the "original" directory to the project directory
      await new Promise((resolve, reject) => {
        Node.ncp(Node.path.join(pathTemp, files[0]), path, err => {
          if (err)
            reject(new Error(`Error copying the folder: ${err.message || err}`));
          else
            resolve();
        });
      });
      //
      // Done file extraction. Fix permissions then complete the restore procedure
      if (!this.config.local)
        await this.server.execFileAsRoot("ChownChmod", [this.user.OSUser, path]);
      //
      // If not CLONE nor FORK -> I've done!
      let mode = (params.req ? params.req.query.mode : "");
      if (mode === "clone" || mode === "fork") {
        // Create a new session for setting properly the TW
        let session = this.server.createSession(this, {type: "TWrestore", mode});
        await session.waitCompleted();
        //
        if (mode === "clone") {
          // It was a CLONE -> I need to clean TW
          try {
            await Node.fs.promises.rm(Node.path.join(path, "branches"), {recursive: true, force: true});
          }
          catch (err) {
            throw new Error(`Error deleting the BRANCHES folder: ${err.message || err}`);
          }
          //
          try {
            await Node.fs.promises.rm(Node.path.join(path, "trans"), {recursive: true, force: true});
          }
          catch (err) {
            throw new Error(`Error deleting the TRANS folder: ${err.message || err}`);
          }
          //
          try {
            await Node.fs.promises.rm(Node.path.join(path, "TwConfig.json"), {force: true});
          }
          catch (err) {
            throw new Error(`Error deleting the TwConfig.json file: ${err.message || err}`);
          }
        }
      }
    }
    catch (e) {
      err = e;
      throw e;
    }
    finally {
      // Delete the temp folder
      try {
        await Node.fs.promises.rm(pathTemp, {recursive: true, force: true});
      }
      catch (e) {
        if (!err)
          err = new Error(`Error removing the temp folder (${pathTemp}): ${e.message || e}`);
      }
    }
    //
    if (err)
      throw err;
    //
    this.log("INFO", "Restore of the project succeeded", "Project.restore");
  }
  catch (err) {
    this.log("ERROR", err, "Project.restore");
    throw err;
  }
};


/**
 * Automatic backup of the project (called by server during nightly backup)
 */
Node.Project.prototype.nightlyBackup = async function ()
{
  // Backup in a specific place and with a specific name
  let date = new Date().toISOString().replace(/-/g, "").replace(/:/g, "").replace("T", "").replace(".", "").replace("Z", "");
  let prjPath = `users/${this.config.serverType}/${this.user.userName}/backups/projects/${this.name}/${this.name}-${date}.tar.gz`;
  //
  let params = {req: {query: {nigthly: true, exclude: "build/;files/", path: prjPath}}};
  await this.backup(params);
};


/**
 * Rename this project
 * @param {object} params
 */
Node.Project.prototype.renameProject = async function (params)
{
  // Command is in the form
  // (http://servername/username/prjname/rename?newName=newName)
  let newName = Node.Utils.clearName(params.req.query.newName);
  let oldName = this.name;
  let warning = false;
  //
  try {
    // If a new name was not provided or it's the same as the old one
    if (!newName) {
      warning = true;
      throw new Error("Can't rename project: new name not specified");
    }
    if (newName === oldName) {
      warning = true;
      throw new Error("Can't rename project: new name and old name are the same");
    }
    //
    // If there is an open session I can't rename the project!
    if (this.server.getOpenSession(this)) {
      warning = true;
      throw new Error("Can't rename the project: open IDE session");
    }
    //
    // Rename the folder
    let path = Node.path.join(this.config.directory, this.user.userName);
    try {
      await Node.fs.promises.rename(Node.path.join(path, oldName), Node.path.join(path, newName));
    }
    catch (err) {
      throw new Error(`Error renaming the project folder ${path}${oldName} to ${path}${newName}: ${err}`);
    }
    //
    // Update the name
    this.name = newName;
    this.config.saveConfig();
    //
    // Log the operation
    this.log("DEBUG", `Project ${oldName} renamed to ${newName}`, "Project.renameProject");
  }
  catch (err) {
    this.log(warning ? "WARN" : "ERROR", err.message || err, "Project.renameProject");
    throw err;
  }
};


/**
 * Reset TW configuration
 * @param {object} params
 */
Node.Project.prototype.resetTW = async function (params)
{
  let path = Node.path.join(this.config.directory, this.user.userName, this.name);
  let warning = false;
  let logData;
  //
  try {
    // First I need to "fix" permissions
    try {
      await this.server.execFileAsRoot("ChownChmod", [this.user.OSUser, path]);
    }
    catch (err) {
      logData = {OSUser: this.user.OSUser, path};
      throw new Error(`Error changing project folder permissions: ${err}`);
    }
    //
    // I've to delete all this objects
    let objectsToRemove = ["branches", "trans", "TwConfig.json", "TwConfig.json.bak"];
    for (let objPath of objectsToRemove) {
      let obj = Node.path.join(path, objPath);
      try {
        await Node.fs.promises.rm(obj, {recursive: true, force: true});
      }
      catch (err) {
        warning = true;
        throw new Error(`Error while deleting ${obj}: ${err}`);
      }
    }
    //
    // Create a new branches directory
    try {
      await Node.fs.promises.mkdir(Node.path.join(path, "branches"));
    }
    catch (err) {
      warning = true;
      throw new Error(`Error creating an empty branches directory: ${err}`);
    }
    //
    // Fix branches directory (it's created by me... I'm not the OSUser)
    try {
      await this.server.execFileAsRoot("ChownChmod", [this.user.OSUser, Node.path.join(path, "branches")]);
    }
    catch (err) {
      logData = {OSUser: this.user.OSUser, path};
      throw new Error(`Error changing branches folder permissions: ${err}`);
    }
    //
    // Log the operation
    this.log("INFO", "TeamWorks cleared", "Project.resetTW");
  }
  catch (err) {
    this.log(warning ? "WARN" : "ERROR", err.message || err, "Project.resetTW", logData);
    throw err;
  }
};


/**
 * Backup a branch in the cloud
 * @param {object} params
 */
Node.Project.prototype.backupBranch = async function (params)
{
  let form = new Node.multiparty.Form();
  //
  // Parse form data
  let fields;
  try {
    fields = await new Promise((resolve, reject) => {
      form.parse(params.req, (err, fields) => err ? reject(err) : resolve(fields));
    });
  }
  catch (err) {
    this.log("ERROR", `Error in form parsing: ${err}`, "Project.backupBranch");
    throw new Error(`Error in form parsing: ${err}`);
  }
  //
  // Extract POST data (see request::backupBranch)
  let branch = fields.branch[0];
  let commits = fields.commits[0];
  let user = fields.user[0];
  let project = fields.project[0];
  //
  // Creates a new session that backes up the given branch
  let session = this.server.createSession(this, {type: "backupBranch", branch, commits, user, project});
  await session.waitCompleted();
};


/**
 * Restore a branch from the cloud
 * @param {object} params
 */
Node.Project.prototype.restoreBranch = async function (params)
{
  let form = new Node.multiparty.Form();
  //
  // Parse form data
  let fields;
  try {
    fields = await new Promise((resolve, reject) => {
      form.parse(params.req, (err, fields) => err ? reject(err) : resolve(fields));
    });
  }
  catch (err) {
    this.log("ERROR", `Error in form parsing: ${err}`, "Project.restoreBranch");
    throw new Error(`Error in form parsing: ${err}`);
  }
  //
  // Extract POST data (see request::restoreBranch)
  let branch = fields.branch[0];
  let msg = (fields.message ? fields.message[0] : undefined);   // The MESSAGE field is sent only if it was user specified
  let pr = (fields.pr ? fields.pr[0] : undefined);                  // The PR field is sent only if the branch is a PR
  //
  let srcUser = fields.srcUser[0];
  let srcProject = fields.srcProject[0];
  let srcCompany = fields.srcCompany[0];
  //
  // Check if there is an open session for this project. If so, when I've finisched, I can tell
  // the session that it has to update its TeamWorks UI
  let ideSession = this.server.getOpenSession(this, {type: "ide", readOnly: undefined});
  //
  let session = this.server.createSession(this,  {type: "restoreBranch", branch, msg, pr, srcUser, srcProject, srcCompany});
  try {
    await session.waitCompleted();
  }
  finally {
    // If there was an open session, tell her that I need to update TW UI
    ideSession?.sendToChild({
      type: Node.Project.msgTypeMap.branchRestored
    });
  }
};


/**
 * Build the project calling the method build in session
 * @param {object} params
 */
Node.Project.prototype.buildProject = async function (params)
{
  let session = this.server.createSession(this, {type: "buildProject", params: params.req.query});
  await session.waitCompleted();
};


/**
 * Deletes a build
 * @param {object} params
 */
Node.Project.prototype.removeBuild = async function (params)
{
  let prjBuildPath = Node.path.join(this.config.directory, this.user.userName, this.name, "build");
  let buildVersion = params.req.query.buildVersion;
  let warning = false;
  //
  try {
    if (!buildVersion) {
      warning = true;
      throw new Error("Missing buildVersion parameter");
    }
    if ((buildVersion || "").includes("..")) {
      warning = true;
      throw new Error("Double dot operator (..) not allowed");
    }
    //
    let fname = Node.path.join(prjBuildPath, `project_${buildVersion}.json`);
    try {
      await Node.fs.promises.rm(fname, {force: true});
    }
    catch (err) {
      throw new Error(`Error deleting the build ${fname}: ${err}`);
    }
  }
  catch (err) {
    this.log(warning ? "WARN" : "ERROR", err.message || err, "Project.removeBuild");
    throw err;
  }
};


/**
 * Upload a recording and store it inside the TUTORIALS directory
 * @param {object} params
 */
Node.Project.prototype.uploadRecFile = async function (params)
{
  let path = Node.path.join(this.config.directory, this.user.userName, this.name, "tutorials");
  let filePath = Node.path.join(path, params.req.query.dir);
  let warning = false;
  let logData;
  //
  try {
    // Get the session that will receive this rec file
    let session = this.server.getOpenSession(this, {type: "ide", readOnly: undefined, request: params.req});
    if (!session) {
      warning = true;
      throw new Error("No session is waiting for this tutorial rec file");
    }
    //
    // Listen to request containing files
    let form = new Node.multiparty.Form();
    //
    await new Promise((resolve, reject) => {
      form.on("part", async part => {
        try {
          // Create a directory where to store uploaded file
          try {
            await Node.fs.promises.mkdir(filePath, 0o770);
          }
          catch (err) {
            if (err.code !== "EEXIST") {
              return reject(new Error(`Error while creating directory ${filePath}: ${err}`));
            }
          }
          //
          // Write content of post request in the file
          let writable = Node.fs.createWriteStream(Node.path.join(filePath, part.name));
          part.pipe(writable);
          //
          writable.on("finish", async () => {
            try {
              // Fix permissions
              if (!this.config.local)
                await this.server.execFileAsRoot("ChownChmod", [this.user.OSUser, filePath]);
              //
              // Done
              resolve();
            }
            catch (err) {
              logData = {OSUser: this.user.OSUser, path: filePath};
              reject(new Error(`Error changing the tutorial permissions: ${err}`));
            }
          });
          //
          writable.on("error", err => reject(new Error(`Error while writing the file: ${err}`)));
        }
        catch (err) {
          reject(err);
        }
      });
      //
      form.on("error", err => reject(new Error(`Error in form parsing: ${err}`)));
      //
      form.parse(params.req);
    });
  }
  catch (err) {
    this.log(warning ? "WARN" : "ERROR", err.message || err, "Project.uploadRecFile", logData);
    throw err;
  }
};


/**
 * Execute commands for the project
 * @param {object} params
 */
Node.Project.prototype.openTutorial = function (params)
{
  let command = params.tokens[0];
  let mode;
  if (command === "playTutorial")
    mode = "play";
  else if (command === "editTutorial")
    mode = "edit";
  else {
    this.log("WARN", `Wrong mode selected: ${command}`, "Project.openTutorial", {command: command});
    throw new Error(`Wrong mode selected: ${command}`);
  }
  //
  // Create a new session for this project (TUTORIAL mode)
  let session = this.server.createSession(this, {type: "tutorial", recFolder: params.req.query.dir, tutorialMode: mode});
  //
  // Protects SID cookie
  session.protectSID(params.req, params.res);
  //
  // Redirect to the page with the sid as querystring
  params.res.redirect(`${this.config.getMainFile()}?sessionid=${session.id}`);
  //
  return {skipReply: true};
};


/**
 * Execute commands for the project
 * @param {object} params
 */
Node.Project.prototype.updateTutProject = async function (params)
{
  let warning = false;
  //
  try {
    // Get the session that will receive this rec file
    let session = this.server.getOpenSession(this, {type: "ide", readOnly: undefined, request: params.req});
    if (!session) {
      warning = true;
      throw new Error(`No session is waiting for this tutorial project`);
    }
    //
    // Read project.json
    let prjPath = Node.path.join(this.config.directory, this.user.userName, this.name, "project.json");
    let data;
    try {
      data = await Node.fs.promises.readFile(prjPath, {encoding: "utf8"});
    }
    catch (err) {
      throw new Error(`Error reading the file project.json: ${err}`);
    }
    //
    // Update tutorial project.json aligning it to parent project one
    let tutPrjPath = Node.path.join(this.config.directory, this.user.userName, this.name, "tutorials", params.req.query.dir, "project.json");
    try {
      await Node.fs.promises.writeFile(tutPrjPath, data);
    }
    catch (err) {
      throw new Error(`Error writing the file project.json: ${err}`);
    }
  }
  catch (err) {
    this.log(warning ? "WARN": "ERROR", err.message || err, "Project.updateTutProject");
    throw err;
  }
};


/**
 * Process the commands related to this project
 * @param {object} params
 */
Node.Project.prototype.processCommand = async function (params)
{
  return await this.execCommand(params);
};


/**
 * Execute commands for the project
 * @param {object} params
 */
Node.Project.prototype.execCommand = async function (params)
{
  let command = params.tokens[0];
  //
  // Handle commands
  switch (command) {
    case "edit":
      return await this.editProject(params);

    case "view":
      return await this.viewProject(params);

    case "resources":
    case "tutorials":
    case "files":
      return await this.downloadFile(params);

    case "upload":
      return await this.uploadResource(params);

    case "backupBranch":
      return await this.backupBranch(params);

    case "restoreBranch":
      return await this.restoreBranch(params);

    case "playTutorial":
      return this.openTutorial(params);

    case "uploadRecFile":
      return await this.uploadRecFile(params);

    case "updateTutProject":
      return await this.updateTutProject(params);

    default:
      // If the authorization key is enabled and the given one does not match -> error
      if (this.config.auth && params.req.query.autk !== this.config.autk) {
        this.log("WARN", "Unauthorized", "Project.execCommand", {url: params.req.originalUrl});
        throw {err: "Unauthorized", code: 401};
      }
      //
      // Valid AUTK (or AUTK not enabled)
      switch (command) {
        case "status":
          return await this.sendStatus(params);

        case "config":
          return await this.configure(params);

        case "branches":
        case "commits":
          return await this.teamworksCmd(params);

        case "token":
          return this.setToken(params);

        case "resetkeys":
          return this.resetKeys(params);

        case "backup":
          return await this.backup(params);

        case "restore":
          return await this.restore(params);

        case "rename":
          return await this.renameProject(params);

        case "resetTW":
          return await this.resetTW(params);

        case "build":
          return await this.buildProject(params);

        case "removeBuild":
          return await this.removeBuild(params);

        case "filesystem":
          return await this.handleFileSystem(params);

        case "editTutorial":
          return this.openTutorial(params);

        default:
          this.log("WARN", "Invalid Command", "Project.execCommand", {cmd: command, url: params.req.originalUrl});
          throw new Error("Invalid Command");
      }
  }
};


// Export module
module.exports = Node.Project;
