/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
/* global require, module, process, Buffer */

var Node = Node || {};

// Import modules
Node.fs = require("fs");
Node.rimraf = require("rimraf");
Node.ncp = require("../ncp_fixed");

// Import classes
Node.Worker = require("../master/worker");
Node.Archiver = require("../archiver");
Node.Utils = require("../utils");
Node.TestAuto = require("../master/testauto");
Node.AppSession = require("../master/appsession");


/*
 * @class Represents an Instant Developer installed App
 * @param {Node.User} par
 */
Node.App = function (par)
{
  this.parent = par;
  //
  this.workers = [];
};


// Define usefull properties for this object
Object.defineProperties(Node.App.prototype, {
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
Node.App.prototype.log = function (level, message, sender, data)
{
  // Add "local" info
  data = (data ? JSON.parse(JSON.stringify(data)) : {});
  data.app = this.name;
  data.user = this.user.userName;
  //
  this.logger.log(level, message, sender, data);
};


/**
 * Save the object
 */
Node.App.prototype.save = function ()
{
  var r = {cl: "Node.App", name: this.name, version: this.version, date: this.date,
    stopped: this.stopped, startSS: this.startSS,
    maxAppUsers: this.maxAppUsers, minAppUsersPerWorker: this.minAppUsersPerWorker, maxAppWorkers: this.maxAppWorkers,
    customWorkerConf: this.customWorkerConf};
  return r;
};


/**
 * Load the object
 * @param {Object} v - the object that contains my data
 */
Node.App.prototype.load = function (v)
{
  this.name = v.name;
  this.version = v.version;
  this.date = v.date;
  this.stopped = v.stopped;
  this.startSS = v.startSS;
  if (v.maxAppUsers)
    this.maxAppUsers = v.maxAppUsers;
  if (v.minAppUsersPerWorker)
    this.minAppUsersPerWorker = v.minAppUsersPerWorker;
  if (v.maxAppWorkers)
    this.maxAppWorkers = v.maxAppWorkers;
  if (v.customWorkerConf)
    this.customWorkerConf = v.customWorkerConf;
};


/**
 * Set the parent of this object (and its children)
 * @param {Object} p - my parent
 */
Node.App.prototype.setParent = function (p)
{
  this.parent = p;
  //
  // Load parameters file
  var filename = this.config.appDirectory + "/apps/" + this.name + "/files/private/app_params.json";
  //
  // I need to do it synchronously because I need to do it before starting the ServerSession (if enabled)
  if (Node.fs.existsSync(filename)) {
    var json = Node.fs.readFileSync(filename);
    this.params = JSON.parse(json);
  }
};


/*
 * Inizialize the app
 * @param {string} name
 */
Node.App.prototype.initApp = function (name)
{
  this.name = name;
  this.version = "";
};


/*
 * Creates a new app session
 * @params {Object} options - used to route session to proper worker
 * @returns {Node.AppSession}
 */
Node.App.prototype.createNewSession = function (options)
{
  // Uses 3 config parameters:
  //   "maxAppUsers": indicates how many users this app can handle
  //   "minAppUsersPerWorker": indicates the minimum number of users that a worker can handle before the system needs a new worker
  //   "maxAppWorkers": maxmimum number of workers
  var maxAppUsers = this.maxAppUsers || this.config.maxAppUsers;
  var minAppUsersPerWorker = this.minAppUsersPerWorker || this.config.minAppUsersPerWorker;
  var maxAppWorkers = this.maxAppWorkers || this.config.maxAppWorkers;
  //
  // Handle optional options
  options = options || {};
  options.type = options.type || "web";
  //
  // Check if a custom app worker configuration applies
  var wrkConf = {type: "*"};    // Default server/app configuration: type:ANY, query:NONE
  if (this.customWorkerConf) {
    for (var i = 0; i < this.customWorkerConf.length; i++) {
      var conf = this.customWorkerConf[i];
      //
      // If the configuration has nothing to do with what callee asked for
      if (conf.type !== options.type)
        continue;
      //
      // If the configuration is specific to a particular query string
      if (conf.query && (!options.query || options.query.indexOf(conf.guery) === -1))
        continue;
      //
      // Found it! Use this custom configuration settings (if given)
      maxAppUsers = conf.maxAppUsers || maxAppUsers;
      minAppUsersPerWorker = conf.minAppUsersPerWorker || minAppUsersPerWorker;
      maxAppWorkers = conf.maxAppWorkers || maxAppWorkers;
      //
      wrkConf = conf;     // Custom configuration
      break;
    }
  }
  //
  // Choose the worker that will handle the new user
  var worker;
  //
  // Locate the worker that have that has less users (i.e. the unloaded one)
  // and, while doing that, check if there are too many users for this worker type
  var minload, nusers = 0;
  for (var i = 0; i < this.workers.length; i++) {
    var wrk = this.workers[i];
    //
    // If this worker is not what I'm looking for -> skip it
    if (JSON.stringify(wrk.options) !== JSON.stringify(wrkConf))
      continue;   // Wrong options
    //
    var wrkload = wrk.getLoad();
    if (minload === undefined || wrkload < minload) {
      minload = wrkload;
      worker = wrk;
    }
    //
    // Compute total worker-type load (i.e. the sum of all sessions for all workers of wkrConf type)
    nusers += wrkload;
  }
  //
  // First check if this app can handle this new user
  if (nusers >= maxAppUsers) {
    this.log("DEBUG", "Too many users", "App.createNewSession",
            {options: options, wrkConf: wrkConf, numUsers: nusers});
    return;   // Too many users
  }
  //
  // If I've found a worker but it has already too many users and I can create new workers
  if (worker && worker.getLoad() >= minAppUsersPerWorker && this.workers.length < maxAppWorkers)
    worker = undefined;   // Create a new worker
  //
  // If I haven't found one, create a new worker
  if (!worker) {
    worker = new Node.Worker(this);
    this.workers.push(worker);
    //
    // Remember worker's options
    worker.options = wrkConf;
    //
    this.log("DEBUG", "Worker created", "App.createNewSession",
            {workerIdx: this.workers.indexOf(worker), options: options, wrkConf: wrkConf});
  }
  else
    this.log("DEBUG", "Reuse worker", "App.createNewSession",
            {workerIdx: this.workers.indexOf(worker), options: options, wrkConf: wrkConf});
  //
  // Ask the worker I've found/created to create a new session
  return worker.createNewSession();
};


/*
 * Get a server session by name
 * @param {string} name
 * @returns {Node.AppSession}
 */
Node.App.prototype.getServerSession = function (name)
{
  for (var i = 0; i < this.workers.length; i++) {
    var s = this.workers[i].getServerSession(name);
    if (s)
      return s;
  }
};


/*
 * Start a server session
 * @param {string} name
 * @returns {Node.AppSession}
 */
Node.App.prototype.startServerSession = function (name, request)
{
  // Check if a session with same name already exists
  if (this.getServerSession(name))
    return this.log("WARN", "Can't start server session: session with same name already exists",
            "App.startServerSession", {name: name, request: request});
  //
  var ss = this.createNewSession({type: "ss"});
  //
  // If a session can't be created -> do nothing
  if (!ss)
    return this.log("WARN", "Session can't be created: too many users", "App.startServerSession", {name: name});
  //
  ss.name = name;
  //
  // If I haven't done it yet create the physical process for the worker
  if (!ss.worker.child)
    ss.worker.createChild();
  //
  // Route this message to the child
  var ev = {id: "onStart", name: name, content: {}, master: true};
  ss.sendToChild({type: Node.AppSession.msgTypeMap.appmsg, sid: ss.id, content: [ev], request: request});
  //
  return ss;
};


/**
 * Start default server session
 */
Node.App.prototype.startDefaultServerSession = function ()
{
  if (!this.startSS)
    return;
  //
  this.startServerSession("_default", {});
  //
  // Periodically check if the default server session dies... if so, restart it
  if (!this.defaultSStimeoutID)
    this.defaultSStimeoutID = setInterval(function () {
      // If the app is updating or stopped, wait...
      if (this.updating || this.stopped)
        return;
      //
      var s = this.getServerSession("_default");
      if (!s) {
        this.log("WARN", "Default server session evaporated -> start a new one", "App.startDefaultServerSession");
        this.startDefaultServerSession();   // Resurrect default server session
      }
    }.bind(this), 5000);
};


/**
 * Stop default server session
 */
Node.App.prototype.stopDefaultServerSession = function ()
{
  if (!this.startSS)
    return;
  //
  var s = this.getServerSession("_default");
  if (s)
    s.terminate();
  //
  // Stop default server session interval
  if (this.defaultSStimeoutID) {
    clearInterval(this.defaultSStimeoutID);
    delete this.defaultSStimeoutID;
  }
};


/**
 * Delete the worker from the array
 * @param {worker} worker
 */
Node.App.prototype.deleteWorker = function (worker)
{
  var pthis = this;
  //
  var idx = this.workers.indexOf(worker);
  if (idx === -1)
    return this.log("WARN", "Worker not found", "App.deleteWorker");
  //
  this.workers.splice(idx, 1);
  //
  // If the worker has a child, kill him
  if (worker.child) {
    // Kill the child
    worker.killChild();
    //
    // If the child does not end normally, I'll (forcedly) kill him in 3 seconds
    setTimeout(function () {
      if (worker.child && worker.child.connected) {
        pthis.log("WARN", "Worker did not quit in 3 seconds -> killing him", "App.deleteWorker", {workerIdx: idx});
        worker.killChild(true);
      }
    }, 3000);
    //
    // Log the operation
    this.log("DEBUG", "Worker deleted", "App.deleteWorker", {workerIdx: idx});
  }
  else
    this.log("WARN", "Can't delete worker: worker child not found (was killed before?)", "App.deleteWorker", {workerIdx: idx});
};


/**
 * Send the "install" message to the App
 * @param {object} options for install (see App::handleInstallMsg in app.js (app/server))
 * @param {function} callback (result)
 */
Node.App.prototype.sendInstallToApp = function (options, callback)
{
  // Create a dummy worker so that I can send install to app
  var worker = new Node.Worker(this);
  //
  // Store a callback in the worker so that it will be called when install is completed
  worker.installCallback = function (result) {
    // Terminate the worker (N.B.: the worker has no sessions, it's just a dummy process...
    // then I have to kill it directly!)
    if (worker.child)     // Only if it's still alive
      worker.child.kill();
    else
      result.err = result.err || "Child process is dead";
    //
    // Done!
    callback(result);
  }.bind(this);
  //
  // Create the worker and tell him that the app have to be installed
  worker.createChild();
  worker.stopWatchDog();  // I don't need it
  worker.child.send({type: Node.Worker.msgTypeMap.install, cnt: options});
};


/**
 * Send the actual status of the App
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.sendStatus = function (params, callback)
{
  var pthis = this;
  //
  var stat = {version: this.version, date: this.date, params: this.params};
  if (this.stopped)
    stat.status = "stopped";
  else if (this.updating)
    stat.status = "updating";
  else
    stat.status = "running";
  //
  // Get the size of the app directory
  var path = this.config.appDirectory + "/apps/" + this.name;
  var cmd, cmdParams;
  if (!/^win/.test(process.platform)) {   // linux
    cmd = "/usr/bin/du";
    cmdParams = ["-sh", path];
  }
  else {  // windows
    cmd = "cmd";
    cmdParams = ["/c", "dir", "/s", "/-c", path.replace(/\//g, "\\")];      // Inside "cmd /c" command / are not allowed
  }
  this.server.execFileAsRoot(cmd, cmdParams, function (err, stdout, stderr) {
    if (err) {
      pthis.log("ERROR", "Error getting the size of app folder: " + (stderr || err), "App.sendStatus", {path: path});
      return callback("Error getting the size of app folder: " + (stderr || err));
    }
    //
    var size;
    if (!/^win/.test(process.platform))    // linux
      size = stdout.split("\t")[0];
    else {
      stdout = stdout.split("\r\n");        // Convert into array
      stdout = stdout[stdout.length - 3];   // Get total size line
      stdout = stdout.split(/\s+/);         // Split spaces
      size = stdout[3];
    }
    switch (size.substr(-1)) {
      case "K":
        size = Math.ceil(parseFloat(size) * 1024);
        break;
      case "M":
        size = Math.ceil(parseFloat(size) * 1024 * 1024);
        break;
      case "G":
        size = Math.ceil(parseFloat(size) * 1024 * 1024 * 1024);
        break;
    }
    //
    stat.diskSize = size;
    callback({msg: JSON.stringify(stat)});
  });
};


/**
 * Send the list of sessions for this app
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.sendSessions = function (params, callback)
{
  // Reply:
  //  sessions: {total number of sessions}
  //  workers: [{worker 1 details}, {worker 2  details}, ...]}  (see worker::getStatus)
  var sessions = {sessions: 0, workers: []};
  //
  // If there are no workers I've done
  if (this.workers.length === 0)
    return callback({msg: JSON.stringify(sessions)});
  //
  // Add worker's details
  var nwrk = 0;
  for (var i = 0; i < this.workers.length; i++) {
    var wrk = this.workers[i];
    //
    // Compute total app sessions (by adding worker's count)
    sessions.sessions += wrk.sessions.length;
    //
    // Add worker status
    wrk.getStatus(params, function (result) {
      sessions.workers.push(result);        // Add worker's status
      if (++nwrk === this.workers.length)   // If that's the last one report to callee
        callback({msg: JSON.stringify(sessions)});
    }.bind(this));    // jshint ignore:line
  }
};


/**
 * Send the list of DTT sessions for this app
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.sendDttSessions = function (params, callback)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Deletes one or more DTT sessions for this app
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.deleteDttSessions = function (params, callback)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Start the app
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.start = function (params, callback)
{
  // Send "install" message to app and wait for reply
  this.sendInstallToApp({updateDB: false}, function (result) {
    // If there is an error, stop
    if (result.err) {
      this.log("WARN", "Error while starting the app: " + result.err, "App.start");
      return callback("Error while starting the app: " + result.err);
    }
    //
    // App is started -> save config
    this.updating = false;
    this.stopped = false;
    this.config.saveConfig();
    //
    // If needed, start app's server session
    this.startDefaultServerSession();
    //
    // Log the operation
    this.log("INFO", "Application started", "App.start");
    //
    callback();
  }.bind(this));
};


/**
 * Stop the app
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.stop = function (params, callback)
{
  // App is stopped -> save config
  this.stopped = true;
  this.config.saveConfig();
  //
  // If needed, stop app's server session
  this.stopDefaultServerSession();
  //
  // Log the operation
  this.log("INFO", "Application stopped", "App.stop");
  //
  callback();
};


/**
 * Terminates the app
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.terminate = function (params, callback)
{
  var pthis = this;
  var waitWorkersStart = new Date();
  var timeout = 30000;
  //
  // Function that waits for all workers to end
  var waitWorkersTerminate = function () {
    if (pthis.workers.length) {
      // If the workers did not stop in timeout ms -> error
      if (new Date() - waitWorkersStart > timeout) {
        pthis.log("WARN", "Workers did not stop in " + timeout / 1000 + " seconds", "App.terminate", {workersLeft: pthis.workers.length});
        //
        // Delete all workers still alive (if they don't die smothly they will be killed)
        for (var i = 0; i < pthis.workers.length; i++)
          pthis.deleteWorker(pthis.workers[i]);
      }
      //
      // Check every 500 ms
      setTimeout(function () {
        waitWorkersTerminate();
      }, 500);
      //
      return;
    }
    //
    // Done. All worker terminated
    pthis.log("DEBUG", "All workers have been terminated", "App.terminate");
    callback();
  };
  //
  // Tell all workers to terminate
  var options = (params.req ? {force: params.req.query.force, timeout: params.req.query.timeout, msg: params.req.query.msg} : {});
  this.log("DEBUG", "Send terminate to all workers", "App.terminate");
  for (var i = 0; i < this.workers.length; i++)
    this.workers[i].terminate(options);
  //
  // Wait for them to terminate
  waitWorkersTerminate();
};


/*
 * Install the app in the production server getting the installation package from S3
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.install = function (params, callback)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Uninstalls the app
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.uninstall = function (params, callback)
{
  var pthis = this;
  //
  // First terminate all sessions
  params.req.query.force = true;      // force TERMINATE
  this.terminate(params, function (err) {
    if (err) {
      pthis.log("WARN", "Can't terminate the app: " + err, "App.uninstall");
      return callback("Can't terminate the app: " + err);
    }
    //
    // First remove app directory
    Node.rimraf(pthis.config.appDirectory + "/apps/" + pthis.name, function (err) {
      if (err) {
        pthis.log("WARN", "Can't delete app folder: " + err, "App.uninstall");
        return callback("Can't delete app folder: " + err);
      }
      //
      // Remove app backups (if any)
      Node.rimraf(pthis.config.appDirectory + "/backups/" + pthis.name, function (err) {
        if (err) {
          pthis.log("WARN", "Can't delete backup folder: " + err, "App.uninstall");
          return callback("Can't delete backup folder: " + err);
        }
        //
        // Tell the user to delete this app
        pthis.user.deleteApp(pthis);
        //
        // Log the operation
        pthis.log("INFO", "App deleted", "App.uninstall");
        //
        // Report to callee
        callback();
      });
    });
  });
};


/**
 * Updates app's DBs schema
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.updateDBschema = function (params, callback)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Handle change app parameter message
 * @param {Object} msg
 * @param {boolean} skipSave - if true the params.json file will not be saved
 */
Node.App.prototype.handleChangedAppParamMsg = function (msg, skipSave)
{
  // Get the new parameter
  this.params = this.params || {};
  if (msg.new !== undefined)
    this.params[msg.par] = msg.new;
  else
    delete this.params[msg.par];
  //
  // Tell it to every session in every worker
  for (var i = 0; i < this.workers.length; i++) {
    var wrk = this.workers[i];
    //
    // Skip "dead" workers (i.e. workers with no child process)
    if (!wrk.child)
      continue;
    //
    wrk.child.send({type: Node.Worker.msgTypeMap.changedAppParam, cnt: msg});
  }
  //
  // If I don't need to save, I've done my job
  if (skipSave)
    return;
  //
  // Save parameters to disk
  this.saveParameters(function (err) {
    if (err)
      this.log("ERROR", "Can't update app parameters: " + err, "App.handleChangedAppParamMsg", msg);
  });
};


/**
 * Save app parameters on disk
 * @param {function} callback (err)
 */
Node.App.prototype.saveParameters = function (callback)
{
  // If params is empty, forget about it
  var par;
  if (Object.keys(this.params).length === 0)
    delete this.params;
  else {
    // Delete volatile parameters (so that they won't be saved on disk)
    par = JSON.parse(JSON.stringify(this.params));
    delete par.enableDtt;
    delete par.logDttQueries;
    //
    // If, beside volatile parameters, there is nothing left, don't save
    if (Object.keys(par).length === 0)
      par = undefined;
  }
  //
  // Save parameter file
  var filename = this.config.appDirectory + "/apps/" + this.name + "/files/private/app_params.json";
  Node.Utils.saveObject(filename, par, callback);
};


/**
 * Backup the app
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.backupToDisk = function (params, callback)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Restore an app backup
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.restoreFromDisk = function (params, callback)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Backup the app
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.backup = function (params, callback)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Restore the app
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.restore = function (params, callback)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Handle file system commands
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.handleFileSystem = function (params, callback)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/*
 * Send to the console the feedback collected by the app
 * @returns {undefined}
 */
Node.App.prototype.handleFeedbackMsgToConsole = function (msg)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Change the app configuration via web commands
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
/*jshint maxcomplexity:40 */
Node.App.prototype.configure = function (params, callback)
{
  // Compute the array of properties provided via url
  var query = params.req.query;
  var queryProps = Object.getOwnPropertyNames(query);
  if (queryProps.length === 0) {
    this.log("WARN", "No property specified", "App.configure");
    return callback("No property specified");
  }
  //
  this.log("INFO", "Update app settings", "App.configure", query);
  //
  if (query.name) {
    try {
      Node.fs.renameSync(this.config.appDirectory + "/apps/" + this.name, this.config.appDirectory + "/apps/" + query.name);
      this.name = query.name;
    }
    catch (ex) {
      this.log("ERROR", "Can't rename app: " + ex.message, "App.configure", {newName: query.name});
      return callback("Can't rename app: " + ex.message);
    }
  }
  if (query.version !== undefined)
    this.version = query.version || undefined;
  if (query.date !== undefined)
    this.date = query.date || undefined;
  if (query.stopped) {
    if (query.stopped === "false")
      this.stopped = false;
    else if (query.stopped === "true")
      this.stopped = true;
  }
  if (query.updating) {
    if (query.updating === "false")
      this.updating = false;
    else if (query.updating === "true")
      this.updating = true;
  }
  if (query.startSS) {
    if (query.startSS === "false" && this.startSS) {
      this.stopDefaultServerSession();
      this.startSS = false;
    }
    else if (query.startSS === "true" && !this.startSS) {
      this.startSS = true;
      this.startDefaultServerSession();
    }
  }
  if (query.maxAppUsers !== undefined)
    this.maxAppUsers = (query.maxAppUsers ? parseInt(query.maxAppUsers, 10) : undefined);
  if (query.minAppUsersPerWorker !== undefined)
    this.minAppUsersPerWorker = (query.minAppUsersPerWorker ? parseInt(query.minAppUsersPerWorker, 10) : undefined);
  if (query.maxAppWorkers !== undefined)
    this.maxAppWorkers = (query.maxAppWorkers ? parseInt(query.maxAppWorkers, 10) : undefined);
  if (query.customWorkerConf !== undefined) {
    try {
      this.customWorkerConf = (query.customWorkerConf ? JSON.parse(query.customWorkerConf) : undefined);
    }
    catch (ex) {
      this.log("WARN", "Invalid customWorkerConf setting: " + ex.message, "App.configure", {customWorkerConf: query.customWorkerConf});
      return callback("Invalid customWorkerConf setting: " + ex.message);
    }
  }
  if (query.params !== undefined) {
    var i, newParams = {};
    if (query.params) {
      // Callee will send every time all parameters as an array of NAME=VALUE couples
      try {
        var paramsArray = JSON.parse(query.params);
        //
        // Change from
        //    ["par1=valuePar1", "par2=valuePar2", ...]
        // to
        //    {
        //     "par1": "valuePar1",
        //     "par2": "valuePar2",
        //    }
        for (i = 0; i < paramsArray.length; i++) {
          var par = paramsArray[i].split("=");
          newParams[par[0]] = par[1];
        }
      }
      catch (ex) {
        this.log("WARN", "Can't update app parameters: " + ex.message, "App.configure", {newParams: query.params});
        return callback("Can't update app parameters: " + ex.message);
      }
    }
    else  // No parameters
      newParams = {};
    //
    // Create a new params object if needed
    this.params = this.params || {};
    //
    // Now check new parameters
    var saveParamFile = false;
    var parr = Object.keys(Object.assign({}, newParams, this.params));
    for (i = 0; i < parr.length; i++) {
      var parName = parr[i];
      if (newParams[parName] === this.params[parName])
        continue;   // Value hasn't changed
      //
      // Value has changed -> tell every session that a parameter has changed
      this.handleChangedAppParamMsg({par: parName, old: this.params[parName], new : newParams[parName]}, true);   // SkipSave
      //
      // Don't save volatile (i.e. non permanent) parameters
      if (["enableDtt", "logDttQueries"].indexOf(parName) === -1)
        saveParamFile = true; // Params file should be saved at the end
    }
    //
    // Save param object
    if (saveParamFile) {
      this.saveParameters(function (err) {
        if (err) {
          this.log("ERROR", "Can't update app parameters: " + err, "App.configure", {newParams: query.params});
          return callback("Can't update app parameters: " + err);
        }
        //
        // Save the new configuration
        this.config.saveConfig();
        //
        // Log the operation
        this.log("INFO", "App settings updated", "App.configure");
        //
        callback();
      }.bind(this));
      //
      // Wait for param file to be written
      return;
    }
  }
  //
  // Save the new configuration
  this.config.saveConfig();
  //
  // Log the operation
  this.log("INFO", "App settings updated", "App.configure");
  //
  callback();
};


/**
 * Start a test session for this app
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.test = function (params, callback)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Return test auto with given id
 * @param {string} id
 */
Node.App.prototype.getTestById = function (id)
{
  return this.testAuto ? this.testAuto[id] : null;
};


/**
 * Process the commands related to this app
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.processCommand = function (params, callback)
{
  this.execCommand(params, callback);
};


/**
 * Execute commands for the app
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.execCommand = function (params, callback)
{
  var command = params.tokens[0];
  //
  // If the authorization key is enabled and the given one does not match -> error
  if (this.config.auth && params.req.query.autk !== this.config.autk) {
    this.log("WARN", "Unauthorized", "App.execCommand", {url: params.req.originalUrl});
    return callback({err: "Unauthorized", code: 401});
  }
  //
  // Valid AUTK (or AUTK not enabled)
  switch (command) {
    case "status":
      this.sendStatus(params, callback);
      break;
    case "sessions":
      this.sendSessions(params, callback);
      break;
    case "dttsessions":
      this.sendDttSessions(params, callback);
      break;
    case "deletedttsessions":
      this.deleteDttSessions(params, callback);
      break;
    case "start":
      this.start(params, callback);
      break;
    case "stop":
      this.stop(params, callback);
      break;
    case "terminate":
      this.terminate(params, callback);
      break;
    case "install":
      this.install(params, callback);
      break;
    case "uninstall":
      this.uninstall(params, callback);
      break;
    case "backup":
      this.backup(params, callback);
      break;
    case "restore":
      this.restore(params, callback);
      break;
    case "updatedbschema":
      this.updateDBschema(params, callback);
      break;
    case "filesystem":
      this.handleFileSystem(params, callback);
      break;
    case "config":
      this.configure(params, callback);
      break;
    case "test":
      this.test(params, callback);
      break;
    default:
      this.log("WARN", "Invalid Command", "App.execCommand", {cmd: command, url: params.req.originalUrl});
      callback("Invalid Command");
      break;
  }
};


// Export module
module.exports = Node.App;
