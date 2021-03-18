/*
 * Instant Developer Next
 * Copyright Pro Gamma Spa 2000-2016
 * All rights reserved
 */
/* global require, module */

var Node = Node || {};

// Import modules
Node.fs = require("fs");
Node.rimraf = require("rimraf");
Node.mime = require("mime");
Node.ncp = require("../ncp_fixed");
Node.multiparty = require("multiparty");
Node.child = require("child_process");

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
    get: function () {
      return this.parent;
    }
  },
  server: {
    get: function () {
      return this.parent.parent.parent;
    }
  },
  config: {
    get: function () {
      return this.parent.parent;
    }
  },
  logger: {
    get: function () {
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
  var r = {cl: "Node.Project", id: this.id, name: this.name, version: this.version, public: this.public,
    lastSave: this.lastSave, lastSaveID: this.lastSaveID, ivAES: this.ivAES, ivAESdtt: this.ivAESdtt};
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
  var r = this.save();
  //
  // Delete children
  delete r.cl;
  //
  // Add usefull properties
  r.user = this.user.saveProperties();
  r.company = this.config.serverType;
  r.cloudPath = "users/" + this.config.serverType + "/" + this.user.userName + "/" + this.name;
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
Node.Project.prototype.check = function ()
{
  this.createProjectFolder(function () {
  });
};


/**
 * Update project's data (coming from the session's child process)
 * @param {Object} info - object that contains project's info
 */
Node.Project.prototype.updateInfo = function (info)
{
  for (var k in info) {
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
 * @param {function} callback - function(err)
 */
Node.Project.prototype.init = function (projectName, callback)
{
  this.name = projectName;
  //
  // Generate data for saving the project into ChromeFS
  this.id = Node.Utils.generateUID36().substring(0, 32);
  this.ivAES = [];
  for (var i = 0; i < 16; i++)
    this.ivAES[i] = Math.floor((Math.random() * 256) + 1);
  //
  // Create the project folder if needed
  this.createProjectFolder(callback);
};


/**
 * Returns true if this project "is online" (i.e. there is
 * an IDE session open on it)
 */
Node.Project.prototype.isOnline = function ()
{
  var skeys = Object.keys(this.server.IDESessions);
  for (var i = 0; i < skeys.length; i++) {
    var sess = this.server.IDESessions[skeys[i]];
    if (sess.project === this)
      return true;
  }
};


/**
 * Create the Project folder and all inner folders if they do not exist
 * @param {function} callback - function(err)
 */
Node.Project.prototype.createProjectFolder = function (callback)
{
  var pthis = this;
  var path = this.config.directory + "/" + this.user.userName + "/" + this.name;
  var foldersToCreate = ["/", "/branches", "/build", "/files", "/files/blobs", "/files/private", "/files/temp",
    "/files/uploaded", "/resources", "/tutorials"];
  //
  var createFolder = function () {
    // If all folder have been created
    if (foldersToCreate.length === 0) {
      // If not LOCAL, fix permissions
      if (!pthis.config.local) {
        pthis.server.execFileAsRoot("ChownChmod", [pthis.user.OSUser, path], function (err, stdout, stderr) {   // jshint ignore:line
          if (err) {
            pthis.log("ERROR", "Error changing project folder permissions: " + (stderr || err), "Project.createProjectFolder",
                    {OSUser: pthis.user.OSUser, path: path});
            return callback("Error changing project folder permissions: " + (stderr || err));
          }
          //
          callback();
        });
      }
      else  // Not local -> DONE
        callback();
      return;
    }
    //
    // Create the first folder in the array
    var pathToCreate = foldersToCreate[0];
    Node.fs.mkdir(path + pathToCreate, function (err) {
      if (err && err.code !== "EEXIST") {
        pthis.log("ERROR", "Error creating the project folder " + path + pathToCreate + ": " + err, "Project.createProjectFolder");
        return callback("Error creating the project folder " + path + pathToCreate + ": " + err);
      }
      //
      // The first has been done... continue with the next one
      foldersToCreate.splice(0, 1);
      createFolder();
    });
  };
  //
  // Create the first one
  createFolder();
};


/**
 * Delete the Project folder and all the files
 * @param {function} callback - function(err)
 */
Node.Project.prototype.deleteProjectFolder = function (callback)
{
  var pthis = this;
  var path = this.config.directory + "/" + this.user.userName + "/" + this.name;
  //
  var delProjectFolder = function () {
    Node.rimraf(path, function (err) {
      if (err) {
        pthis.log("ERROR", "Error deleting the project folder " + path + ": " + err, "Project.deleteProjectFolder");
        return callback("Error deleting the project folder " + path + ": " + err);
      }
      //
      callback();
    });
  };
  //
  // Before deleting the project folder I need to be sure I'm able to do it -> fix permissions
  if (!this.config.local && Node.fs.existsSync(path)) {
    this.server.execFileAsRoot("ChownChmod", [this.user.OSUser, path], function (err, stdout, stderr) {   // jshint ignore:line
      if (err) {
        pthis.log("ERROR", "Error changing the project folder permissions: " + (stderr || err), "Project.deleteProjectFolder",
                {OSUser: pthis.user.OSUser, path: path});
        return callback("Error changing the project folder permissions: " + (stderr || err));
      }
      else
        delProjectFolder();
    });
  }
  else
    delProjectFolder();
};


/**
 * Edit the project
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Project.prototype.editProject = function (params, callback)
{
  // If needed, check the edit prj token
  if (this.config.editPrjToken && (!this.token || params.req.query.t !== this.token)) {
    this.log("WARN", "Unauthorized", "Project.editProject");
    return callback({err: "Unauthorized", code: 401});
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
  var session = this.server.getOpenSession(this, {type: "ide", readOnly: undefined});
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
  // If not found, create a new session for this project
  if (!session) {
    this.log("DEBUG", "Create a new IDE session", "Project.editProject");
    //
    var qry = (Object.keys(params.req.query).length ? params.req.query : undefined);
    session = this.server.createSession(this, {openParams: qry});
  }
  //
  // Protects SID cookie
  session.protectSID(params.req, params.res);
  //
  // Redirect to the MAIN page with the sid as querystring
  params.res.redirect(this.config.getMainFile() + "?sessionid=" + session.id);
  //
  // Done
  callback({skipReply: true});
};


/**
 * Create a session for viewing the project (readonly mode)
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Project.prototype.viewProject = function (params, callback)
{
  // If the project is not public and the edit prj token is enabled it must match
  if (!this.public && this.config.editPrjToken && (!this.token || params.req.query.t !== this.token)) {
    this.log("WARN", "Unauthorized", "Project.viewProject");
    return callback({err: "Unauthorized", code: 401});
  }
  //
  // Create a new session for this project (READONLY mode)
  // Pass query string params if any
  var qry = (Object.keys(params.req.query).length ? params.req.query : undefined);
  //
  // If this is an openDTT operation
  if (qry && qry.showDtt) {
    // If needed generate key for dtt projects crypting
    if (!this.ivAESdtt) {
      this.ivAESdtt = [];
      for (var i = 0; i < 16; i++)
        this.ivAESdtt[i] = Math.floor((Math.random() * 256) + 1);
      //
      // Save the new configuration
      this.config.saveConfig();
    }
    //
    // Send them to client so that it can save/load DTT projects
    qry.ivAESdtt = this.ivAESdtt;
  }
  var session = this.server.createSession(this, {readOnly: true, openParams: qry});
  //
  // Protects SID cookie
  session.protectSID(params.req, params.res);
  //
  // Redirect to the page with the sid as querystring
  params.res.redirect(this.config.getMainFile() + "?sessionid=" + session.id);
  //
  // If it's a course forget about RID (the document will send the "RID" reply when the
  // project will be closed (see InDe.Document.prototype.sendPrjInfoToConsole))
  if (qry && qry.course)
    delete params.req.query.rid;
  //
  // Done
  callback({skipReply: true});
};


/**
 * Download a file from one of project's folders
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Project.prototype.downloadFile = function (params, callback)
{
  var pthis = this;
  //
  // The URL is in the following form:
  //   http://servername/username/projectname/folder/filename
  var folder = params.tokens.slice(0, params.tokens.length - 1).join("/");   // resources, tutorials, files (with AUTK)
  var filename = params.tokens[params.tokens.length - 1];
  var path = this.config.directory + "/" + this.user.userName + "/" + this.name + "/" + folder + "/" + filename;
  //
  // Send the file only if there is an editing session
  // (don't check resources/libusage.json... that file is asked whenever the callee needs it)
  if (folder !== "resources" || filename !== "libusage.json") {
    var session = this.server.getOpenSession(this, {request: params.req});
    if (!session) {
      this.log("WARN", "No session is asking for this file", "Project.downloadFile", {path: path});
      return callback("No session is asking for this file");
    }
  }
  //
  // filename must not contain ..
  if (filename.indexOf("..") !== -1) {
    this.log("WARN", "Double dot operator (..) not allowed", "Project.downloadFile");
    return callback("Double dot operator (..) not allowed");
  }
  //
  // Full path must be valid and not a directory
  Node.fs.stat(path, function (err, pathStats) {
    if (err) {
      pthis.log("WARN", "Can't get path info: " + err, "Project.downloadFile");
      return callback({err: "Can't get path info: " + err, code: 404});
    }
    if (pathStats.isDirectory()) {
      pthis.log("WARN", "Invalid path (file is a directory)", "Project.downloadFile");
      return callback("Invalid path (file is a directory)");
    }
    //
    // Compute the mimetype
    var mimetype = Node.mime.getType(filename);
    //
    // If the file is an AUDIO or a VIDEO resource and a RANGE was provided
    var stream;
    if (mimetype && (mimetype.indexOf("audio") !== -1 || mimetype.indexOf("video") !== -1) && params.req.headers.range) {
      var positions = params.req.headers.range.replace(/bytes=/, "").split("-");
      //
      Node.fs.stat(path, function (err, stats) {
        if (err) {
          pthis.log("ERROR", "Error while reading file " + path + "'s stats: " + err, "Project.downloadFile");
          return callback({err: "Error while reading file " + path + "'s stats: " + err, code: 404});
        }
        //
        var total = stats.size;
        var start = parseInt(positions[0], 10);
        var end = positions[1] ? parseInt(positions[1], 10) : total - 1;
        //
        // Send the requested file slice
        stream = Node.fs.createReadStream(path, {start: start, end: end});
        stream.on("open", function () {
          params.res.writeHead(206, {
            "Content-Range": "bytes " + start + "-" + end + "/" + total,
            "Accept-Ranges": "bytes",
            "Content-Length": (end - start) + 1,
            "Content-Type": mimetype
          });
          //
          stream.pipe(params.res);
        });
        stream.on("end", function () {
          callback({skipReply: true});
        });
        stream.on("error", function (err) {
          pthis.log("ERROR", "Error while streaming file " + path + ": " + err, "Project.downloadFile");
          callback({err: "Error while streaming file " + path + ": " + err, code: 404});
        });
      });
      //
      return;
    }
    //
    // Send the full file
    stream = Node.fs.createReadStream(path);
    stream.on("open", function () {
      params.res.writeHead(200, {"Content-Type": mimetype});
      //
      stream.pipe(params.res);
    });
    stream.on("end", function () {
      callback({skipReply: true});
    });
    stream.on("error", function (err) {
      pthis.log("WARN", "Error sending the file " + path + ": " + err, "Project.downloadFile");
      callback({err: "Error sending the file " + path + ": " + err, code: 404});
    });
  });
};


/**
 * Handle file system commands
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Project.prototype.handleFileSystem = function (params, callback)
{
  var prjFilesPath = this.config.directory + "/" + this.user.userName + "/" + this.name + "/files";
  var objPath = params.req.query.path || "";    // (optional)
  //
  // Fix objPath (add / if needed)
  if (objPath && objPath[0] !== "/")
    objPath = "/" + objPath;
  //
  var options = {
    path: prjFilesPath + objPath,
    command: params.tokens[1],
    tempPath: prjFilesPath + "/temp/"
  };
  //
  this.logger.log("DEBUG", "Handle file system command", "Project.handleFileSystem", options);
  //
  // Append original params map
  options.params = params;
  //
  // Function for fixing permissions
  var fixPathPermissions = function (cb) {    // cb(err)
    this.server.execFileAsRoot("ChownChmod", [this.user.OSUser, prjFilesPath], function (err, stdout, stderr) {   // jshint ignore:line
      if (err) {
        this.log("ERROR", "Error changing folder permissions: " + (stderr || err), "Project.handleFileSystem",
                {OSUser: this.user.OSUser, path: prjFilesPath});
        return cb("Error changing folder permissions: " + (stderr || err));
      }
      //
      cb();
    }.bind(this));
  }.bind(this);
  //
  // If I'm on a windows machine there are no permissions to fix
  if (/^win/.test(process.platform))
    fixPathPermissions = function (cb) {
      cb();
    };
  //
  // If it's a WRITE operation, I need to fix permissions BEFORE I execute the command
  if (options.command === "put" || options.command === "del" || options.command === "move") {
    fixPathPermissions(function (err) {
      if (err)
        return callback(err); // Can't continue... I need permissions to be correct for executing the command
      //
      // Handle the command
      Node.Utils.handleFileSystem(options, function (res) {
        if (res && (res.err || typeof res === "string"))
          this.logger.log("WARN", "Error while handling file system command: " + (res.err || res), "Project.handleFileSystem");
        //
        // If it's a PUT operation, fix permissions after I've executed the command
        if (options.command === "put") {
          fixPathPermissions(function (err) {
            callback(err || res);
          });
        }
        else
          callback(res);
      }.bind(this));
    }.bind(this));
  }
  else { // No PUT/DEL/MOVE -> execute
    Node.Utils.handleFileSystem(options, function (res) {
      if (res && (res.err || typeof res === "string"))
        this.logger.log("WARN", "Error while handling file system command: " + (res.err || res), "Project.handleFileSystem");
      //
      callback(res);
    }.bind(this));
  }
};


/**
 * Upload a file to the project's RESOURCES folder
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Project.prototype.uploadResource = function (params, callback)
{
  var pthis = this;
  //
  // The URL is in the following form:
  //   http://servername/username/projectname/upload/filename
  var filename = params.tokens[1];
  var path = this.config.directory + "/" + this.user.userName + "/" + this.name + "/resources/" + filename;
  //
  // filename must be a valid GUID followed by "." and the extension
  if (!filename.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.?\w*$/i)) {
    this.log("WARN", "Invalid file name (not a GUID)", "Project.uploadResource");
    return callback("Invalid file name (not a GUID)");
  }
  //
  // Get the session that will receive this resource
  var session = this.server.getOpenSession(this, {type: "ide", readOnly: undefined, request: params.req});
  if (!session) {
    // Session is not there... check if it's a course... he is allowed to upload files
    // (course is IDE, readonly with openParams.course)
    session = this.server.getOpenSession(this, {type: "ide", readOnly: true, request: params.req});
    if (session && (!session.options.openParams || !session.options.openParams.course))
      session = null;
  }
  if (!session) {
    this.log("WARN", "No session is waiting for this resource", "Project.uploadResource");
    return callback("No session is waiting for this resource");
  }
  //
  // Parse the request
  var form = new Node.multiparty.Form();
  form.on("part", function (part) {
    // Write content of post request in the file
    var writable = Node.fs.createWriteStream(path);
    part.pipe(writable);
    writable.on("finish", function () {
      // If not LOCAL, fix permissions
      if (!pthis.config.local) {
        pthis.server.execFileAsRoot("ChownChmod", [pthis.user.OSUser, path], function (err, stdout, stderr) {   // jshint ignore:line
          if (err) {
            pthis.log("ERROR", "Error changing the resource permissions: " + (stderr || err), "Project.uploadResource",
                    {OSUser: pthis.user.OSUser, path: path});
            return callback("Error changing the resource permissions: " + (stderr || err));
          }
          //
          // Done -> tell the session that a new resource has been uploaded
          session.sendToChild({type: Node.Project.msgTypeMap.resourceUploaded, guid: filename});
          callback();
        });
      }
      else {  // Not local
        // Done -> tell the session that a new resource has been uploaded
        session.sendToChild({type: Node.Project.msgTypeMap.resourceUploaded, guid: filename});
        callback();
      }
    });
    writable.on("error", function (err) {
      pthis.log("ERROR", "Error while writing the file " + path + ": " + err, "Project.uploadResource");
      callback("Error while writing the file " + path + ": " + err);
    });
  });
  form.on("error", function (err) {
    pthis.log("ERROR", "Error in form parsing: " + err, "Project.uploadResource");
    callback("Error in form parsing: " + err);
  });
  //
  form.parse(params.req);
};


/**
 * Send project status
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Project.prototype.sendStatus = function (params, callback)
{
  var pthis = this;
  //
  var stat = {version: this.version, public: this.public, lastSave: this.lastSave};
  //
  // If local or Windows -> can't compute dir sizes
  if (this.config.local || /^win/.test(process.platform))
    return callback({msg: JSON.stringify(stat)});
  //
  // Get the size of the project directory
  var path = this.config.directory + "/" + this.user.userName + "/" + this.name;
  this.server.execFileAsRoot("/usr/bin/du", ["-k", "-a", "-d", "1", path], function (err, stdout, stderr) {   // jshint ignore:line
    if (err) {
      pthis.log("ERROR", "Error getting the size of project folder: " + (stderr || err), "Project.sendStatus", {path: path});
      return callback("Error getting the size of project folder: " + (stderr || err));
    }
    //
    stat.pathSizes = {};
    var sizes = stdout.split("\n");
    for (var i = 0; i < sizes.length - 1; i++) {                        // Last one is an empty row
      var size = Math.ceil(parseFloat(sizes[i].split("\t")[0]) * 1024);
      var dir = sizes[i].split("\t")[1].substring(path.length + 1);     // Remove path
      if (["branches", "trans", "TwConfig.json", "TwConfig.json.bak"].indexOf(dir) !== -1)
        stat.pathSizes.twSize = (stat.pathSizes.twSize || 0) + size;
      else if (dir === "project.json")
        stat.pathSizes.prjSize = size;
      else if (dir === "build")
        stat.pathSizes.buildSize = size;
      else if (dir === "files")
        stat.pathSizes.filesSize = size;
      else if (dir === "resources")
        stat.pathSizes.resSize = size;
      else if (dir === "")
        stat.diskSize = size;
    }
    callback({msg: JSON.stringify(stat)});
  });
};


/**
 * Change the project configuration via web commands
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Project.prototype.configure = function (params, callback)
{
  // Compute the array of properties provided via url
  var query = params.req.query;
  var queryProps = Object.getOwnPropertyNames(query);
  if (queryProps.length === 0) {
    this.log("WARN", "No property specified", "Project.configure");
    return callback("No property specified");
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
      return callback("Can't configure the project: open IDE session");
    }
    //
    // No session available. Use a "worker" session
    this.server.createSession(this, {type: "configProject", params: params.req.query}, function (result) {
      callback(result.err);
    });
  }
  else
    callback();
};


/**
 * Handle a generic TW request
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Project.prototype.teamworksCmd = function (params, callback)
{
  var command = params.tokens[0];
  //
  this.server.createSession(this, {type: "teamworksCmd", twcommand: command, twparams: params.req.query}, function (result) {
    if (result.err)
      callback({err: result.err});
    else
      callback({msg: JSON.stringify(result.data)});
  });
};


/*
 * Set the token coming from the console (this token allows the project to be edited)
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Project.prototype.setToken = function (params, callback)
{
  // Read and store the token
  this.token = params.req.query.t;
  //
  // Done
  callback();
};


/**
 * Backup the project into the cloud
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Project.prototype.backup = function (params, callback)
{
  var pthis = this;
  var archiver = new Node.Archiver(this.server, (params.req && params.req.query.nigthly));
  var path = this.config.directory + "/" + this.user.userName + "/" + this.name;
  var pathTemp = this.config.directory + "/" + this.user.userName + "/tmp_" + this.name;
  //
  var pathCloud;
  if (params.req && params.req.query.path) {
    // Given path could be a full file path (with .tar.gz extension) or a folder
    pathCloud = params.req.query.path;
    if (pathCloud.substr(-7) !== ".tar.gz")
      pathCloud += "/" + this.name + ".tar.gz";   // Was a folder
  }
  else
    pathCloud = "users/" + this.config.serverType + "/" + this.user.userName + "/backups/projects/" + this.name + "/" + this.name + ".tar.gz";
  //
  this.log("DEBUG", "Project backup", "Project.backup", {pathCloud: pathCloud, params: (params.req ? params.req.query : undefined)});
  //
  // Define useful functions
  var errorFnc = function (msg) {
    pthis.log("ERROR", msg, "Project.backup");
    callback(msg);
    //
    // Operation failed -> clean up
    Node.rimraf(pathTemp, function () {
    });
  };
  var successFnc = function () {
    pthis.log("INFO", "Backup of the project succeeded", "Project.backup");
    callback();
  };
  //
  var doBackup = function () {
    // If no path nor exclude were given
    if (!params.req || (!params.req.query.path && !params.req.query.exclude)) {
      // Simply backup the entire directory
      archiver.backup(path, pathCloud, function (err) {
        if (err)
          return errorFnc("Error while backing up project " + pthis.name + ": " + err);
        //
        successFnc();
      });
      //
      // Done
      return;
    }
    //
    // If an exclude list was provided, define filter function
    var filterFnc;
    if (params.req.query.exclude) {
      var exclList = params.req.query.exclude.split(";");
      filterFnc = function (fileName) {
        fileName = fileName.replace(/\\/g, "/");   // Windows
        //
        var copyFile = true;
        for (var i = 0; i < exclList.length && copyFile; i++) {
          var excl = path + "/" + exclList[i];
          //
          // If the exclude path is a directory exclude the directory itself
          var fn = fileName;
          if (excl.substr(-1) === "/")
            fn += "/";
          if (fn.substring(0, excl.length) === excl)
            copyFile = false;
        }
        return copyFile;
      };
    }
    //
    // Remove the temp folder if present (due to a failed previous backup)
    Node.rimraf(pathTemp, function (err) {
      if (err)
        return errorFnc("Error removing the previous temp folder (" + pathTemp + "): " + err);
      //
      // Create a temp folder
      Node.fs.mkdir(pathTemp, function (err) {
        if (err)
          return errorFnc("Error creating the " + pathTemp + " folder:" + err);
        //
        // Copy the project folder with filter function
        Node.ncp(path, pathTemp + "/" + pthis.name, {filter: filterFnc}, function (err) {
          if (err)
            return errorFnc("Error copying the folder: " + err);
          //
          // Do backup
          archiver.backup(pathTemp + "/" + pthis.name, pathCloud, function (err) {
            if (err)
              return errorFnc("Error while backing up project " + pthis.name + ": " + err);
            //
            // Delete the temp folder
            Node.rimraf(pathTemp, function (err) {
              if (err)
                return errorFnc("Error removing the temp folder (" + pathTemp + "): " + err);
              //
              successFnc();
            });
          });
        });
      });
    });
  };
  //
  // If we are in the server adjust files permissions to 770 and files ownership to owner (user) BEFORE backing up
  if (!this.config.local) {
    this.server.execFileAsRoot("ChownChmod", [this.user.OSUser, path], function (err, stdout, stderr) {   // jshint ignore:line
      if (err)
        return errorFnc("Error changing the project folder permissions: " + (stderr || err));
      //
      doBackup();
    });
  }
  else
    doBackup();
};


/**
 * Restore the project from the cloud
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Project.prototype.restore = function (params, callback)
{
  var pthis = this;
  var archiver = new Node.Archiver(this.server, (params.req && params.req.query.nigthly));
  var path = this.config.directory + "/" + this.user.userName + "/" + this.name;
  var pathTemp = this.config.directory + "/" + this.user.userName + "/tmp_" + this.name;
  //
  var pathCloud;
  if (params.req && params.req.query.path) {
    // Given path could be a full file path (with .tar.gz extension) or a folder
    pathCloud = params.req.query.path;
    if (pathCloud.substr(-7) !== ".tar.gz")
      pathCloud += "/" + this.name + ".tar.gz";   // Was a folder
  }
  else
    pathCloud = "users/" + this.config.serverType + "/" + this.user.userName + "/backups/projects/" + this.name + "/" + this.name + ".tar.gz";
  //
  this.log("DEBUG", "Project restore", "Project.restore", {pathCloud: pathCloud, params: (params.req ? params.req.query : undefined)});
  //
  // Define useful functions
  var errorFnc = function (msg) {
    pthis.log("ERROR", msg, "Project.restore");
    callback(msg);
    //
    // Operation failed -> clean up
    Node.rimraf(pathTemp, function () {
    });
  };
  var successFnc = function () {
    pthis.log("INFO", "Restore of the project succeeded", "Project.restore");
    callback();
  };
  //
  var completeRestore = function () {
    // If not CLONE nor FORK -> I've done!
    var mode = (params.req ? params.req.query.mode : "");
    if (mode !== "clone" && mode !== "fork")
      return successFnc();
    //
    // Create a new session for setting properly the TW
    pthis.server.createSession(pthis, {type: "TWrestore"}, function (result) {
      if (result.err)
        return errorFnc("Error while resetting changes: " + result.err);
      //
      // If it was a FORK I've done
      if (mode === "fork")
        return successFnc();
      //
      // It was a CLONE -> I need to clean TW
      Node.rimraf(path + "/branches", function (err) {
        if (err)
          return errorFnc("Error deleting the BRANCHES folder: " + err);
        //
        Node.rimraf(path + "/trans", function (err) {
          if (err)
            return errorFnc("Error deleting the TRANS folder: " + err);
          //
          Node.rimraf(path + "/TwConfig.json", function (err) {
            if (err)
              return errorFnc("Error deleting the TwConfig.json file: " + err);
            //
            successFnc();
          });
        });
      });
    });
  };
  //
  // Create a temp folder
  Node.fs.mkdir(pathTemp, function (err) {
    if (err)
      return errorFnc("Error creating the " + pathTemp + " folder:" + err);
    //
    // Restore files from the cloud
    archiver.restore(pathTemp + "/" + pthis.name, pathCloud, function (err) {
      if (err)
        return errorFnc("Error restoring files: " + err);
      //
      // Get the name of the first object inside the temporary folder
      // (should be the name of the "original" project)
      Node.fs.readdir(pathTemp + "/", function (err, files) {
        if (err)
          return errorFnc("Error retrieving the first file:" + err);
        //
        // Copy all files from the "original" directory to the project directory
        Node.ncp(pathTemp + "/" + files[0] + "/", path, function (err) {
          if (err)
            return errorFnc("Error copying the folder: " + err);
          //
          // Delete the temp folder
          Node.rimraf(pathTemp, function (err) {
            if (err)
              return errorFnc("Error removing the temp folder (" + pathTemp + "): " + err);
            //
            // Done file extraction. Fix permissions then complete the restore procedure
            if (!pthis.config.local) {
              pthis.server.execFileAsRoot("ChownChmod", [pthis.user.OSUser, path], function (err, stdout, stderr) {   // jshint ignore:line
                if (err)
                  return errorFnc("Error adjusting files: " + (stderr || err));
                //
                completeRestore();
              });
            }
            else
              completeRestore();
          });
        });
      });
    });
  });
};


/**
 * Automatic backup of the project (called by server during nightly backup)
 * @param {function} callback (err)
 */
Node.Project.prototype.nightlyBackup = function (callback)
{
  // Backup in a specific place and with a specific name
  var date = new Date().toISOString().replace(/-/g, "").replace(/:/g, "").replace("T", "").replace(".", "").replace("Z", "");
  var prjPath = "users/" + this.config.serverType + "/" + this.user.userName + "/backups/projects/" +
          this.name + "/" + this.name + "-" + date + ".tar.gz";
  //
  var params = {req: {query: {nigthly: true, exclude: "build/;files/", path: prjPath}}};
  this.backup(params, function (err) {
    if (err)
      callback(err.err || err);
    else
      callback();
  });
};


/**
 * Rename this project
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Project.prototype.renameProject = function (params, callback)
{
  var pthis = this;
  //
  // Command is in the form
  // (http://servername/username/prjname/rename?newName=newName)
  var newName = Node.Utils.clearName(params.req.query.newName);
  var oldName = this.name;
  //
  // If a new name was not provided or it's the same as the old one
  if (!newName) {
    this.log("WARN", "Can't rename project: new name not specified", "Project.renameProject");
    return callback("Can't rename project: new name not specified");
  }
  if (newName === oldName) {
    this.log("WARN", "Can't rename project: new name and old name are the same", "Project.renameProject");
    return callback("Can't rename project: new name and old name are the same");
  }
  //
  // If there is an open session I can't rename the project!
  if (this.server.getOpenSession(this)) {
    this.log("WARN", "Can't rename the project: open IDE session", "Project.renameProject");
    return callback("Can't rename the project: open IDE session");
  }
  //
  // Rename the folder
  var path = this.config.directory + "/" + this.user.userName + "/";
  Node.fs.rename(path + oldName, path + newName, function (err) {
    if (err) {
      pthis.log("ERROR", "Error renaming folder " + path + oldName + " to " + path + newName + ": " + err, "Project.renameProject");
      return callback("Error renaming the project folder " + path + oldName + " to " + path + newName + ": " + err);
    }
    //
    // Update the name
    pthis.name = newName;
    pthis.config.saveConfig();
    //
    // Log the operation
    pthis.log("DEBUG", "Project " + oldName + " renamed to " + newName, "Project.renameProject");
    //
    // Done
    callback();
  });
};


/**
 * Reset TW configuration
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Project.prototype.resetTW = function (params, callback)
{
  var pthis = this;
  var path = this.config.directory + "/" + this.user.userName + "/" + this.name;
  //
  // I've to delete all this objects
  var objectsToRemove = ["/branches", "/trans", "/TwConfig.json", "/TwConfig.json.bak"];
  var removeObject = function () {
    // If there are no more objects to delete
    if (objectsToRemove.length === 0) {
      // Create a new branches directory
      Node.fs.mkdir(path + "/branches", function (err) {
        if (err) {
          pthis.log("WARN", "Error creating an empty branches directory: " + err, "Project.resetTW");
          return callback("Error creating an empty branches directory: " + err);
        }
        //
        // Log the operation
        pthis.log("INFO", "TeamWorks cleared", "Project.resetTW");
        //
        // Fix branches directory (it's created by me... I'm not the OSUser)
        pthis.server.execFileAsRoot("ChownChmod", [pthis.user.OSUser, path + "/branches"], function (err, stdout, stderr) {   // jshint ignore:line
          if (err) {
            pthis.log("ERROR", "Error changing branches folder permissions: " + (stderr || err), "Project.resetTW",
                    {OSUser: pthis.user.OSUser, path: path});
            return callback("Error changing branches folder permissions: " + (stderr || err));
          }
          //
          // Done
          callback();
        });
      });
      //
      return;
    }
    //
    // Delete first object in the list
    var obj = path + "/" + objectsToRemove[0];
    Node.rimraf(obj, function (err) {
      if (err) {
        pthis.log("WARN", "Error while deleting " + obj + ": " + err, "Project.resetTW");
        return callback("Error while deleting " + obj + ": " + err);
      }
      //
      // This folder has been deleted. Continue with next one
      objectsToRemove.splice(0, 1);
      removeObject();
    });
  };
  //
  // First I need to "fix" permissions
  this.server.execFileAsRoot("ChownChmod", [this.user.OSUser, path], function (err, stdout, stderr) {   // jshint ignore:line
    if (err) {
      pthis.log("ERROR", "Error changing project folder permissions: " + (stderr || err), "Project.resetTW",
              {OSUser: pthis.user.OSUser, path: path});
      return callback("Error changing project folder permissions: " + (stderr || err));
    }
    //
    // Start...
    removeObject();
  });
};


/**
 * Backup a branch in the cloud
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Project.prototype.backupBranch = function (params, callback)
{
  var pthis = this;
  //
  var form = new Node.multiparty.Form();
  form.parse(params.req, function (err, fields, files) {   // jshint ignore:line
    if (err) {
      pthis.log("ERROR", "Error in form parsing: " + err, "Project.backupBranch");
      return callback("Error in form parsing: " + err);
    }
    //
    // Extract POST data (see request::backupBranch)
    var branch = fields.branch[0];
    var commits = fields.commits[0];
    var user = fields.user[0];
    var project = fields.project[0];
    //
    // Creates a new session that backes up the given branch
    pthis.server.createSession(pthis, {type: "backupBranch", branch: branch, commits: commits,
      user: user, project: project}, function (result) {
      if (result.err)
        callback({err: result.err});
      else
        callback();
    });
  });
};


/**
 * Restore a branch from the cloud
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Project.prototype.restoreBranch = function (params, callback)
{
  var pthis = this;
  //
  var form = new Node.multiparty.Form();
  form.parse(params.req, function (err, fields, files) {   // jshint ignore:line
    if (err) {
      pthis.log("ERROR", "Error in form parsing: " + err, "Project.restoreBranch");
      return callback("Error in form parsing: " + err);
    }
    //
    // Extract POST data (see request::restoreBranch)
    var branch = fields.branch[0];
    var message = (fields.message ? fields.message[0] : undefined);   // The MESSAGE field is sent only if it was user specified
    var pr = (fields.pr ? fields.pr[0] : undefined);                  // The PR field is sent only if the branch is a PR
    //
    var srcUser = fields.srcUser[0];
    var srcProject = fields.srcProject[0];
    var srcCompany = fields.srcCompany[0];
    //
    // Check if there is an open session for this project. If so, when I've finisched, I can tell
    // the session that it has to update its TeamWorks UI
    var session = pthis.server.getOpenSession(pthis, {type: "ide", readOnly: undefined});
    //
    var opt = {type: "restoreBranch", branch: branch, msg: message, pr: pr, srcUser: srcUser, srcProject: srcProject, srcCompany: srcCompany};
    pthis.server.createSession(pthis, opt, function (result) {
      if (result.err)
        callback({err: result.err});
      else {
        callback();
        //
        // If there was an open session, tell her that I need to update TW UI
        if (session)
          session.sendToChild({type: Node.Project.msgTypeMap.branchRestored});
      }
    });
  });
};


/**
 * Build the project calling the method build in session
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Project.prototype.buildProject = function (params, callback)
{
  this.server.createSession(this, {type: "buildProject", params: params.req.query}, function (result) {
    if (result.err)
      callback({err: result.err});
    else
      callback();
  });
};


/**
 * Deletes a build
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Project.prototype.removeBuild = function (params, callback)
{
  var prjBuildPath = this.config.directory + "/" + this.user.userName + "/" + this.name + "/build/";
  var buildVersion = params.req.query.buildVersion;
  //
  if (!buildVersion) {
    this.log("WARN", "Missing buildVersion parameter", "Project.removeBuild");
    return callback("Missing buildVersion parameter");
  }
  if ((buildVersion || "").indexOf("..") !== -1) {
    this.log("WARN", "Double dot operator (..) not allowed", "Project.removeBuild");
    return callback("Double dot operator (..) not allowed");
  }
  //
  var fname = prjBuildPath + "project_" + buildVersion + ".json";
  Node.rimraf(fname, function (err) {
    if (err) {
      this.log("ERROR", "Error deleting the build " + fname + ": " + err, "Project.removeBuild");
      return callback("Error deleting the build " + fname + ": " + err);
    }
    //
    callback();
  }.bind(this));
};


/**
 * Upload a recording and store it inside the TUTORIALS directory
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Project.prototype.uploadRecFile = function (params, callback)
{
  var pthis = this;
  var path = this.config.directory + "/" + this.user.userName + "/" + this.name + "/tutorials/";
  var filePath = path + params.req.query.dir;
  //
  // Get the session that will receive this rec file
  var session = this.server.getOpenSession(this, {type: "ide", readOnly: undefined, request: params.req});
  if (!session) {
    this.log("WARN", "No session is waiting for this tutorial rec file", "Project.uploadRecFile");
    return callback("No session is waiting for this tutorial rec file");
  }
  //
  // Listen to request containing files
  var form = new Node.multiparty.Form();
  form.on("part", function (part) {
    // Create a directory where to store uploaded file
    Node.fs.mkdir(filePath, 0770, function (err) {
      if (err && err.code !== "EEXIST") {
        pthis.log("ERROR", "Error while creating directory " + filePath + ": " + err, "Project.uploadRecFile");
        return callback("Error while creating directory " + filePath + ": " + err);
      }
      //
      // Write content of post request in the file
      var writable = Node.fs.createWriteStream(filePath + "/" + part.name);
      part.pipe(writable);
      writable.on("finish", function () {
        // Fix permissions
        if (!pthis.config.local) {
          pthis.server.execFileAsRoot("ChownChmod", [pthis.user.OSUser, filePath], function (err, stdout, stderr) {   // jshint ignore:line
            if (err) {
              pthis.log("ERROR", "Error changing the tutorial permissions: " + (stderr || err), "Project.uploadRecFile",
                      {OSUser: pthis.user.OSUser, path: filePath});
              return callback("Error changing the tutorial permissions: " + (stderr || err));
            }
            //
            // Done
            callback();
          });
        }
        else  // Not local -> DONE
          callback();
      });
      writable.on("error", function (err) {
        pthis.log("ERROR", "Error while writing the file: " + err, "Project.uploadRecFile");
        callback("Error while writing the file: " + err);
      });
    });
  });
  form.on("error", function (err) {
    pthis.log("ERROR", "Error in form parsing: " + err, "Project.uploadRecFile");
    callback("Error in form parsing: " + err);
  });
  //
  form.parse(params.req);
};


/**
 * Execute commands for the project
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Project.prototype.openTutorial = function (params, callback)
{
  var command = params.tokens[0];
  var mode;
  if (command === "playTutorial")
    mode = "play";
  else if (command === "editTutorial")
    mode = "edit";
  else {
    this.log("WARN", "Wrong mode selected: " + command, "Project.openTutorial", {command: command});
    return callback("Wrong mode selected: " + command);
  }
  //
  // Create a new session for this project (TUTORIAL mode)
  var session = this.server.createSession(this, {type: "tutorial", recFolder: params.req.query.dir, tutorialMode: mode});
  //
  // Protects SID cookie
  session.protectSID(params.req, params.res);
  //
  // Redirect to the page with the sid as querystring
  params.res.redirect(this.config.getMainFile() + "?sessionid=" + session.id);
  //
  // Done
  callback({skipReply: true});
};


/**
 * Execute commands for the project
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Project.prototype.updateTutProject = function (params, callback)
{
  var pthis = this;
  //
  // Get the session that will receive this rec file
  var session = this.server.getOpenSession(this, {type: "ide", readOnly: undefined, request: params.req});
  if (!session) {
    this.log("WARN", "No session is waiting for this tutorial project", "Project.updateTutProject");
    return callback("No session is waiting for this tutorial project");
  }
  //
  // Read project.json
  var prjPath = this.config.directory + "/" + this.user.userName + "/" + this.name + "/project.json";
  Node.fs.readFile(prjPath, {encoding: "utf8"}, function (err, data) {
    if (err) {
      pthis.logger.log("ERROR", "Error reading the file project.json: " + err, "Project.updateTutProject");
      return callback("Error reading the file project.json: " + err);
    }
    //
    // Update tutorial project.json aligning it to parent project one
    var tutPrjPath = pthis.config.directory + "/" + pthis.user.userName + "/" + pthis.name + "/tutorials/" + params.req.query.dir + "/project.json";
    Node.fs.writeFile(tutPrjPath, data, function (err) {
      if (err) {
        pthis.logger.log("ERROR", "Error writing the file project.json: " + err, "Project.updateTutProject");
        return callback("Error writing the file project.json: " + err);
      }
      //
      // Done
      callback();
    });
  });
};


/**
 * Process the commands related to this project
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Project.prototype.processCommand = function (params, callback)
{
  this.execCommand(params, callback);
};


/**
 * Execute commands for the project
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Project.prototype.execCommand = function (params, callback)
{
  var command = params.tokens[0];
  //
  // Handle commands
  switch (command) {
    case "edit":
      this.editProject(params, callback);
      break;
    case "view":
      this.viewProject(params, callback);
      break;
    case "resources":
    case "tutorials":
      this.downloadFile(params, callback);
      break;
    case "files":
      this.downloadFile(params, callback);
      break;
    case "upload":
      this.uploadResource(params, callback);
      break;
    case "backupBranch":
      this.backupBranch(params, callback);
      break;
    case "restoreBranch":
      this.restoreBranch(params, callback);
      break;
    case "playTutorial":
      this.openTutorial(params, callback);
      break;
    case "uploadRecFile":
      this.uploadRecFile(params, callback);
      break;
    case "updateTutProject":
      this.updateTutProject(params, callback);
      break;

    default:
      // If the authorization key is enabled and the given one does not match -> error
      if (this.config.auth && params.req.query.autk !== this.config.autk) {
        this.log("WARN", "Unauthorized", "Project.execCommand", {url: params.req.originalUrl});
        return callback({err: "Unauthorized", code: 401});
      }
      //
      // Valid AUTK (or AUTK not enabled)
      switch (command) {
        case "status":
          this.sendStatus(params, callback);
          break;
        case "config":
          this.configure(params, callback);
          break;
        case "branches":
        case "commits":
          this.teamworksCmd(params, callback);
          break;
        case "token":
          this.setToken(params, callback);
          break;
        case "backup":
          this.backup(params, callback);
          break;
        case "restore":
          this.restore(params, callback);
          break;
        case "rename":
          this.renameProject(params, callback);
          break;
        case "resetTW":
          this.resetTW(params, callback);
          break;
        case "build":
          this.buildProject(params, callback);
          break;
        case "removeBuild":
          this.removeBuild(params, callback);
          break;
        case "filesystem":
          this.handleFileSystem(params, callback);
          break;
        case "editTutorial":
          this.openTutorial(params, callback);
          break;
        default:
          this.log("WARN", "Invalid Command", "Project.execCommand", {cmd: command, url: params.req.originalUrl});
          callback("Invalid Command");
          break;
      }
      break;
  }
};


// Export module
module.exports = Node.Project;
