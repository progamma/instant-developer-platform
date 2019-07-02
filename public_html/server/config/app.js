/*
 * Instant Developer Next
 * Copyright Pro Gamma Spa 2000-2016
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
  Node.Utils.loadObject(filename, function (res, err) {
    if (err)
      this.log("WARN", "Error reading app parameters file: " + err, "App.setParent");
    else
      this.params = res;
  }.bind(this));
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
  // First check if this app can handle this new user
  var i, nusers = 0;
  for (i = 0; i < this.workers.length; i++)
    nusers += this.workers[i].getLoad();
  if (nusers >= maxAppUsers)
    return;   // Too many users
  //
  // This app can handle this new user. Choose the worker that will handle the new user
  var worker;
  //
  // First locate the worker that have that has less users (i.e. the unloaded one)
  var minload;
  for (i = 0; i < this.workers.length; i++) {
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
  // If there is a fromDate parameter, parse it
  var fromDate;
  if (params.req.query.fromDate)
    fromDate = new Date(params.req.query.fromDate);
  //
  // Reply:
  //  sessions: [{session 1 details}, {session 2 details}, ...]
  //
  // Function that sorts an array of sessions
  var sortSessions = function (sessArr) {
    sessArr.sort(function (s1, s2) {
      if (new Date(s1.start) > new Date(s2.start))
        return -1;
      else if (new Date(s1.start) < new Date(s2.start))
        return 1;
      else
        return 0;
    });
    //
    return sessArr;
  };
  //
  // First add live sessions
  var sessions = [];
  this.workers.forEach(function (wrk) {
    wrk.sessions.forEach(function (s) {
      sessions.push({sessionID: s.id, start: s.created, sessionName: s.sessionName, type: "online"});
    });
  });
  //
  // Sort by start date
  sessions = sortSessions(sessions);
  //
  var doneFnc = function (msg, fd) {
    // If there is a message, dump it
    if (msg)
      this.log("WARN", msg, "Node.App.sendDttSessions");
    //
    // If there is a FD, close it
    if (fd)
      Node.fs.close(fd, function (err) {
        if (err)
          this.log("WARN", "Error while closing file (" + fd + "): " + err, "Node.App.sendDttSessions.doneFnc");
      });
  }.bind(this);
  //
  // Read index file
  var savedSess = [];
  var maxAppWorkers = this.maxAppWorkers || this.config.maxAppWorkers;
  var fpath = this.config.appDirectory + "/apps/" + this.name + "/files/private/log";
  var readIndexFile = function (idx) {
    // If I've done -> reply
    if (idx + 1 > maxAppWorkers) {
      // Sort sessions by start date
      savedSess = sortSessions(savedSess);
      //
      // Concatenate arrays by appending saved to online list
      sessions = sessions.concat(savedSess);
      //
      // Now filter online sessions
      return filterOnlineSessionsAndReturn(sessions);
    }
    //
    var fname = fpath + "/index" + idx + ".json";
    Node.fs.open(fname, "r", function (err, fd) {
      // If there is no index file -> done
      if (err && err.code === "ENOENT")
        return readIndexFile(idx + 1);
      else if (err)    // If there are other errors... log it
        return doneFnc("Error while opening index file (read: " + fname + "): " + err);
      //
      var buff = Buffer.alloc(512);
      var readBlock = function (pos) {
        Node.fs.read(fd, buff, 0, buff.length, pos, function (err, bytesRead) {
          if (err)
            return doneFnc("Error while reading index file (read: " + fname + "): " + err, fd);
          //
          // If I've read nothing -> I've done reading
          if (bytesRead === 0) {
            return Node.fs.close(fd, function (err) {
              if (err)
                return doneFnc("Error while closing DTT index file (read: " + fname + "): " + err);
              //
              readIndexFile(idx + 1);
            });
          }
          //
          // If I've read an empty block -> skip it
          var buffData = buff.toString().replace(/\0/g, "");
          if (!buffData) {
            doneFnc("Error while reading DTT index file (read: " + fname + "): empty block at pos " + pos);
            //
            // Read next block
            return readBlock(pos + 512);
          }
          //
          // Load the session
          var s = JSON.parse(buffData);
          //
          // If a date filter was provided, use it
          if (fromDate && s.updated && new Date(s.updated) < fromDate)
            return readBlock(pos + 512); // Read next block
          //
          // Search session inside live sessions array
          var lives = sessions.find(function (ls) {
            return (ls.sessionID === s.sessionID);
          });
          //
          // If there is already a live session coupled with this saved session
          if (lives) {
            // Copy "data" from saved to online
            for (var p in s)
              lives[p] = s[p];
          }
          else { // Not there... flag the session as offline
            s.type = "offline";
            savedSess.push(s);
          }
          //
          // Read next block
          readBlock(pos + 512);
        });
      };
      //
      // Read first block
      readBlock(0);
    });
  };
  //
  // Filter online sessions
  var traceFlt = (this.params ? this.params["filterDttTrace"] : null);
  var filterOnlineSessionsAndReturn = function (sessions) {
    // Use the same "filter" schema (see dtt::canTraceSession)
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      if (s.type !== "online")
        continue; // I have to filter online sessions only
      //
      var delSession = false;
      if (!s.sessionName)
        delSession = true;  // If App has no session Name, can't apply filter -> don't trace
      else if (!s.exceptions && !s.warnings && traceFlt) {  // If there are errors or warnings -> trace always
        delSession = true;    // I'll delete this session (unless it matches filter criteria)
        traceFlt = traceFlt.toLowerCase().split(",");
        for (var j = 0; j < traceFlt.length && delSession; j++) {
          var flt = traceFlt[j];
          //
          // If sessionName contains the i-th filter, trace session
          if (s.sessionName.toLowerCase().indexOf(flt) !== -1)
            delSession = false;
        }
      }
      //
      if (delSession)
        sessions.splice(i--, 1);
    }
    //
    // Reply to callee
    callback({msg: JSON.stringify(sessions)});
  };
  //
  readIndexFile(0);
};


/**
 * Deletes one or more DTT sessions for this app
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.deleteDttSessions = function (params, callback)
{
  // Check required parameters
  if (!params.req.query.beforeDate) {
    this.log("WARN", "Missing beforeDate parameter", "App.deleteDttSessions");
    return callback("Missing beforeDate parameter");
  }
  //
  this.log("INFO", "Delete DTT sessions", "App.deleteDttSessions", {beforeDate: params.req.query.beforeDate});
  //
  // Never ever do it more than once at a time!
  if (this.deletingDttSessions) {
    this.log("WARN", "Pending delete DTT sessions", "App.deleteDttSessions");
    return callback("Pending delete DTT sessions");
  }
  this.deletingDttSessions = true;
  //
  var beforeDate = new Date(params.req.query.beforeDate);
  var maxAppWorkers = this.maxAppWorkers || this.config.maxAppWorkers;
  var appPath = this.config.appDirectory + "/apps/" + this.name;
  var purgeWorkerFile = function (idx) {
    // If I've done, return to callee
    if (idx >= maxAppWorkers) {
      delete this.deletingDttSessions;
      this.log("INFO", "Delete DTT sessions completed", "App.deleteDttSessions", {beforeDate: params.req.query.beforeDate});
      return callback();
    }
    //
    var nextWrk = function (err) {
      if (err) {
        delete this.deletingDttSessions;
        this.log("WARN", "Can't delete DTT sessions: " + err, "App.deleteDttSessions", {beforeDate: params.req.query.beforeDate, workerIdx: idx});
        return callback(err);
      }
      //
      // Next
      purgeWorkerFile(idx + 1);
    }.bind(this);
    //
    // If the worker is "alive" I ask the worker's child to do the cleaning...
    // This is needed because all "live" sessions must change their offsets...
    if (this.workers[idx] && this.workers[idx].child) {
      this.deleteTraceFilesCallback = nextWrk;
      return this.workers[idx].child.send({type: Node.Worker.msgTypeMap.deleteTraceFiles, cnt: {beforeDate: beforeDate}});
    }
    //
    // Worker is dead... Purge it directly...
    var opts = {beforeDate: beforeDate, workerIdx: idx, appPath: appPath, logFn: Node.App.prototype.log.bind(this)};
    var DTT = require(appPath + "/server/dtt").DTT;
    DTT.purgeSessionsInfo(opts, nextWrk);
  }.bind(this);
  //
  // Purge first file
  purgeWorkerFile(0);
};


/**
 * Start the app
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.start = function (params, callback)
{
  // Create a dummy worker so that I can check all app DBs
  var worker = new Node.Worker(this);
  //
  // Store a callback in the worker so that it will be called when check is completed
  worker.installCallback = function (result) {
    // Terminate the worker (N.B.: the worker has no sessions, it's just a dummy process...
    // then I have to kill it directly!)
    if (worker.child)     // Only if it's still alive
      worker.child.kill();
    else
      result.err = result.err || "Child process is dead";
    //
    // If there is an error, stop
    if (result.err) {
      this.log("WARN", "Error while starting the app: " + result.err, "App.start");
      return callback("Error while starting the app: " + result.err);
    }
    //
    // Update app's info
    this.updating = false;  // If the app was updating, from now on it's not
    this.stopped = false;   // If the app was stopped, from now on it's not
    this.version = result.appinfo.version;
    this.date = result.appinfo.date;
    //
    // Save config
    this.config.saveConfig();
    //
    // If needed, start app's server session
    this.startDefaultServerSession();
    //
    // Log the operation
    this.log("INFO", "Application started", "App.start");
    //
    // Done!
    callback();
  }.bind(this);
  //
  // Create the worker and tell him that the app have to be installed
  worker.createChild();
  worker.child.send({type: Node.Worker.msgTypeMap.install});
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
  var pthis = this;
  var path = this.config.appDirectory + "/apps/" + this.name;
  var pathCloud = params.req.query.file;
  var appExisted;           // true if the app existed before
  var filesChanged;         // true if at least a file have been changed
  //
  // If there is no appDirectory
  if (!this.config.appDirectory) {
    this.log("WARN", "The server is not configured as an app container (no appDirectory)", "App.install");
    return callback("The server is not configured as an app container (no appDirectory)");
  }
  //
  // If the app is already updating -> error
  if (this.updating) {
    this.log("WARN", "The app is already updating", "App.install");
    return callback("The app is already updating");
  }
  //
  // If the file is missing -> can't continue
  if (!pathCloud) {
    this.log("WARN", "Missing FILE parameter", "App.install");
    return callback("Missing FILE parameter");
  }
  //
  // Error function
  var errorFnc = function (err) {
    pthis.log("WARN", err, "App.install");
    //
    // The app is not updating
    pthis.updating = false;
    //
    // Try to restore the app if one or more files have changed
    if (filesChanged) {
      // Something have been changed. If the app existed, restore it otherwise delete it
      if (appExisted) {
        // App existed: restore it to previous version
        pthis.restoreFromDisk({}, function (err2) {
          if (err2) {
            err2 = err2.msg || err2;     // handle object errors
            pthis.log("WARN", "Error while restoring the app after a failed install: " + err2, "App.install");
            return callback("Error while restoring the app after a failed install: " + err2);
          }
          //
          // Restore succeded
          pthis.log("WARN", "Restore succeded after a failed install", "App.install");
          callback(err);
        });
      }
      else {
        // App did not exist -> delete it
        pthis.uninstall(params, function (err2) {
          if (err2) {
            err2 = err2.msg || err2;     // handle object errors
            pthis.log("WARN", "Error while deleting the app after a failed install: " + err2, "App.install");
            return callback("Error while deleting the app after a failed install: " + err2);
          }
          //
          // Uninstall succeded
          pthis.log("WARN", "Uninstall succeded after a failed install", "App.install");
          callback(err);
        });
      }
    }
    else {
      pthis.log("WARN", "Unable to install (files not touched)", "App.install");
      callback(err);
    }
    //
    // Delete temporary folder
    Node.rimraf(path + ".tmp", function (err) {
      if (err)
        pthis.log("WARN", "Can't delete temporary folder " + path + ".tmp: " + err, "App.install");
    });
  };
  //
  // From now on the app is updating
  this.updating = true;
  //
  // Check if the app exists
  Node.fs.access(this.config.appDirectory + "/apps/" + this.name, function (err) {
    // Remember if the app existed (needed if the app install fails)
    appExisted = (err ? false : true);
    //
    // If the app does not exist it's easy: just start install
    if (err)
      appInstall();
    else {
      // App exists -> first terminate every session and wait for the workers to terminate
      params.req.query.force = true;    // force TERMINATE
      params.req.query.timeout = 15000; // max: 15 sec
      params.req.query.msg = "The application is currently being updated and will be restarted in 15 seconds. It is recommended that you end the working session and close the browser";  // jshint ignore:line
      pthis.terminate(params, function (err) {
        if (err)
          return errorFnc("Can't terminate the app: " + err);
        //
        // All workers have been terminated, now backup the app
        pthis.backupToDisk({}, function (err) {
          if (err)
            return errorFnc("Error while backing up the app: " + err);
          //
          // App backed up. Start install
          appInstall();
        });
      });
    }
  });
  //
  // Function that cleans up app folder (i.e. removes "server", "client" and "resources" folders)
  var folderToDelete = ["server", "client", "resources"];
  var cleanUpAppFolders = function (cleanCB) {
    // If there are no more folders to delete, continue with installation
    if (folderToDelete.length === 0)
      return cleanCB();
    //
    // Delete first folder in the list
    var fld = path + "/" + folderToDelete[0];
    Node.rimraf(fld, function (err) {
      if (err)
        return cleanCB("Error while deleting folder " + fld + ": " + err);
      //
      // This folder has been deleted. Continue with next one
      folderToDelete.splice(0, 1);
      cleanUpAppFolders(cleanCB);
    });
  };
  //
  // Function that does the actual install: restore files, creates a worker then ask him to continue install
  var appInstall = function () {
    // Restore into a temporary folder (with .tmp extension)
    var archiver = new Node.Archiver(pthis.server);
    Node.fs.mkdir(path + ".tmp", function (err) {
      // If there was an error, stop
      if (err)
        return errorFnc("Error while creating temporary folder: " + err);
      //
      archiver.restore(path + ".tmp/" + pthis.name, pathCloud, function (err) {
        // If there was an error, stop
        if (err)
          return errorFnc("Error while restoring the app into a temporary folder: " + err);
        //
        // Cleanup destination directory
        cleanUpAppFolders(function (err) {
          // Files have been touched... better restore if failed later on
          filesChanged = true;
          //
          // If there was an error, stop
          if (err)
            return errorFnc("Error while cleaning up the app folder: " + err);
          //
          // N.B.: the tar.gz file should contain a single directory with the
          // "design-time" name of the app. That name could be different from this.name if
          // the callee is installing this app with a different name than the design-time one
          Node.fs.readdir(path + ".tmp/", function (err, files) {
            if (err)
              return errorFnc("Error while reading temporary directory content: " + err);
            //
            // Now copy all files from temporary folder to destination one
            Node.ncp(path + ".tmp/" + files[0], path, function (err) {
              // If there was an error, stop
              if (err)
                return errorFnc("Error while copying files from temporary folder to app folder: " + err);
              //
              // Delete temporary folder
              Node.rimraf(path + ".tmp", function (err) {
                if (err)
                  pthis.log("WARN", "Can't delete temporary folder " + path + ".tmp: " + err, "App.install");
              });
              //
              try {
                // Reset cache of WebAPI metadata
                delete require.cache[require.resolve(path + "/server/webapi/metadata.json")];
              }
              catch (e) {
              }
              //
              // Done: the app have been restored from the cloud. Now I need to start it
              pthis.start(null, function (err) {
                // If there is an error, stop
                if (err)
                  return errorFnc("Error while installing the app: " + err);
                //
                // Log the operation
                pthis.log("INFO", "Application " + (appExisted ? "updated" : "installed"), "App.install");
                //
                // Done!
                callback();
              });
            });
          });
        });
      });
    });
  };
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
  var pthis = this;
  //
  // Function that copyies all app folders
  var folderToCopy = ["server", "client", "resources"];
  var copyFolders = function () {
    // If there are no more folders to copy, backup is completed
    if (folderToCopy.length === 0) {
      pthis.log("DEBUG", "Backup of the app succeeded", "App.backupToDisk");
      return callback();
    }
    //
    // Copy first folder in the list
    var fld = folderToCopy[0];
    var srcPath = pthis.config.appDirectory + "/apps/" + pthis.name + "/" + fld;
    var dstPath = pthis.config.appDirectory + "/backups/" + pthis.name + "/" + fld;
    Node.ncp(srcPath, dstPath, function (err) {
      if (err) {
        pthis.log("WARN", "Error while copying folder " + srcPath + " to " + dstPath + ": " + err, "App.backupToDisk");
        return callback("Error while copying folder " + srcPath + " to " + dstPath + ": " + err);
      }
      //
      // This folder has been copied. Continue with next one
      folderToCopy.splice(0, 1);
      copyFolders();
    });
  };
  //
  // Delete the previous backup (if exists)
  Node.rimraf(this.config.appDirectory + "/backups/" + this.name, function (err) {
    if (err) {
      pthis.log("WARN", "Can't delete previous backup: " + err, "App.backupToDisk");
      return callback("Can't delete previous backup: " + err);
    }
    //
    // Create the backup folder
    Node.fs.mkdir(pthis.config.appDirectory + "/backups/" + pthis.name, function (err) {
      if (err) {
        pthis.log("WARN", "Can't create the backup folder: " + err, "App.backupToDisk");
        return callback("Can't create the backup folder: " + err);
      }
      //
      // Copy inner folders
      copyFolders();
    });
  });
};


/**
 * Restore an app backup
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.restoreFromDisk = function (params, callback)
{
  var pthis = this;
  //
  // Function that deletes all app folders that are backed up (see App::backup)
  var folderToDelete = ["server", "client", "resources"];
  var deleteFolders = function () {
    // If there are no more folders to delete, restore is performed
    if (folderToDelete.length === 0) {
      // Restore previous backup
      var srcPath = pthis.config.appDirectory + "/backups/" + pthis.name;
      var dstPath = pthis.config.appDirectory + "/apps/" + pthis.name;
      Node.ncp(srcPath, dstPath, function (err) {
        if (err) {
          pthis.log("WARN", "Can't restore the backup folder: " + err, "App.restoreFromDisk", {src: srcPath, dest: dstPath});
          return callback("Can't restore the backup folder: " + err);
        }
        //
        // Log the operation
        pthis.log("DEBUG", "Restore of the app succeeded", "App.restoreFromDisk");
        //
        // Done
        callback();
      });
      //
      return;
    }
    //
    // Delete first folder in the list
    var fld = folderToDelete[0];
    var path = pthis.config.appDirectory + "/apps/" + pthis.name + "/" + fld;
    Node.rimraf(path, function (err) {
      if (err) {
        pthis.log("WARN", "Error while deleting folder " + path + ": " + err, "App.restoreFromDisk");
        return callback("Error while deleting folder " + path + ": " + err);
      }
      //
      // This folder has been deleted. Continue with next one
      folderToDelete.splice(0, 1);
      deleteFolders();
    });
  };
  //
  Node.fs.access(this.config.appDirectory + "/backups/" + this.name, function (err) {
    // If the backup does not exists
    if (err) {
      pthis.log("WARN", "There is no backup for the app", "App.restoreFromDisk");
      return callback("There is no backup for the app");
    }
    //
    // Start to delete the target folders and, when finished, do restore
    deleteFolders();
  });
};


/**
 * Backup the app
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.backup = function (params, callback)
{
  var pathCloud = "users/" + this.config.serverType + "/apps/" + this.name + ".tar.gz";
  //
  this.log("DEBUG", "App backup", "App.backup", {pathCloud: pathCloud});
  //
  // Backup the app folder in the cloud
  var archiver = new Node.Archiver(this.server);
  archiver.backup(this.config.appDirectory + "/apps/" + this.name, pathCloud, function (err) {
    if (err) {
      this.log("ERROR", "Error backing up the files: " + err, "App.backup");
      return callback("Error backing up the files: " + err);
    }
    //
    // Log the app backup
    this.log("DEBUG", "App backed up in the cloud", "App.backup");
    //
    // Done!
    callback();
  }.bind(this));
};


/**
 * Restore the app
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.restore = function (params, callback)
{
  var path = this.config.appDirectory + "/apps/" + this.name;
  var pathCloud = "users/" + this.config.serverType + "/apps/" + this.name + ".tar.gz";
  //
  this.log("DEBUG", "App restore", "App.restore", {pathCloud: pathCloud});
  //
  // Restore backup from the cloud
  var archiver = new Node.Archiver(this.server);
  archiver.restore(path, pathCloud, function (err) {
    if (err) {
      this.log("ERROR", "Error restoring the files: " + err, "App.restore");
      return callback("Error restoring up the files: " + err);
    }
    //
    // Log the app restore
    this.log("DEBUG", "App restored from cloud", "App.restore");
    //
    // Done!
    callback();
  }.bind(this));
};


/**
 * Handle file system commands
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.App.prototype.handleFileSystem = function (params, callback)
{
  var appFilesPath = this.config.appDirectory + "/apps/" + this.name + "/files";
  var objPath = params.req.query.path || "";    // (optional)
  //
  // Fix objPath (add / if needed)
  if (objPath && objPath[0] !== "/")
    objPath = "/" + objPath;
  //
  var options = {
    path: appFilesPath + objPath,
    command: params.tokens[1],
    tempPath: appFilesPath + "/temp/"
  };
  //
  this.log("DEBUG", "Handle file system command", "App.handleFileSystem", options);
  //
  // Append original params map
  options.params = params;
  //
  // Handle the command
  Node.Utils.handleFileSystem(options, function (res) {
    if (res && (res.err || typeof res === "string"))
      this.logger.log("WARN", "Error while handling file system command: " + (res.err || res), "App.handleFileSystem");
    //
    callback(res);
  }.bind(this));
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
  var callbackMsg = {};
  //
  var testautoId = params.req.query.id;
  //
  if (params.tokens && params.tokens.indexOf("status") !== -1) {
    if (this.testAuto && this.testAuto[testautoId]) {
      // Update the duration
      var duration = new Date().getTime() - this.testAuto[testautoId].startTime;
      this.testAuto[testautoId].testResult.duration = parseInt(duration / 1000);
      //
      callbackMsg.code = 200;
      callbackMsg.msg = this.testAuto[testautoId].testResult;
    }
    else {
      callbackMsg.code = 404;
      callbackMsg.err = "Test not found";
    }
  }
  else if (params.tokens && params.tokens.indexOf("terminate") !== -1) {
    if (this.testAuto && this.testAuto[testautoId]) {
      this.testAuto[testautoId].terminate();
      delete this.testAuto[testautoId];
      //
      callbackMsg.code = 200;
      callbackMsg.msg = "Test terminated";
    }
    else {
      callbackMsg.code = 404;
      callbackMsg.err = "Test not found";
    }
  }
  else {
    // Get test auto params
    var testautoMode = params.req.query.mode;
    var duration = params.req.query.duration;
    var maxSessions = params.req.query.maxSessions;
    var pathList = params.req.query.path;
    var rid = params.req.query.rid;
    var device = params.req.query.device || "desktop";
    var slowTimer = params.req.query.slowTimer;
    var killTimer = params.req.query.killTimer;
    //
    // Create a new test auto
    var options = {
      id: testautoId,
      mode: testautoMode,
      duration: duration,
      pathList: pathList,
      maxSessions: maxSessions,
      rid: rid,
      slowTimer: slowTimer,
      killTimer: killTimer
    };
    //
    this.testAuto = this.testAuto || {};
    //
    // Create a new test auto
    this.testAuto[testautoId] = new Node.TestAuto(this, options);
    //
    // Non regression && load tests don't need a browser. appClient will never open a connection
    // and testAuto init method will never be called. So I called init method giving fake session
    // to test auto
    if ([Node.TestAuto.ModeMap.nonReg, Node.TestAuto.ModeMap.load].indexOf(testautoMode) !== -1)
      this.testAuto[testautoId].init({session: {}});
    //
    // I need a browser only if testauto mode is "recording" or "replay step-by-step"
    if (testautoMode === "r" || testautoMode === "sbs") {
      params.res.redirect("/" + this.name + "/client/testautoPreview.html?device=" + device + "&testmode=" + testautoMode + "&testid=" +
              testautoId + "&addsid=true");
      callbackMsg.skipReply = true;
    }
    //
    delete params.req.query.rid;
  }
  //
  callback(callbackMsg);
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
