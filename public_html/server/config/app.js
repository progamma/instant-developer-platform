/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
var Node = Node || {};

// Import modules
Node.fs = require("fs");
Node.ncp = require("../ncp_fixed");
Node.path = require("path");

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
  return {
    cl: "Node.App",
    name: this.name,
    version: this.version,
    date: this.date,
    stopped: this.stopped,
    startSS: this.startSS,
    maxAppUsers: this.maxAppUsers,
    minAppUsersPerWorker: this.minAppUsersPerWorker,
    maxAppWorkers: this.maxAppWorkers,
    customWorkerConf: this.customWorkerConf
  };
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
  let filename = Node.path.join(this.config.appDirectory, "apps", this.name, "files", "private", "app_params.json");
  //
  // I need to do it synchronously because I need to do it before starting the ServerSession (if enabled)
  if (Node.fs.existsSync(filename)) {
    let json = Node.fs.readFileSync(filename);
    if (json.length)
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
  let maxAppUsers = this.maxAppUsers || this.config.maxAppUsers;
  let minAppUsersPerWorker = this.minAppUsersPerWorker || this.config.minAppUsersPerWorker;
  let maxAppWorkers = this.maxAppWorkers || this.config.maxAppWorkers;
  //
  // Handle optional options
  options = options || {};
  options.type = options.type || "web";
  //
  // Check if a custom app worker configuration applies
  let wrkConf = {type: "*"};    // Default server/app configuration: type:ANY, query:NONE
  if (this.customWorkerConf) {
    for (let i = 0; i < this.customWorkerConf.length; i++) {
      let conf = this.customWorkerConf[i];
      //
      // If the configuration has nothing to do with what callee asked for
      if (conf.type !== options.type)
        continue;
      //
      // If the configuration is specific to a particular query string
      if (conf.query && (!options.query || !options.query.includes(conf.query)))
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
  let worker;
  //
  // Locate the worker that have that has less users (i.e. the unloaded one)
  // and, while doing that, check if there are too many users for this worker type
  let minload, numUsers = 0;
  for (let i = 0; i < this.workers.length; i++) {
    let wrk = this.workers[i];
    //
    if (wrk.hibernated)
      continue; // Skip hibernated workers
    //
    // If this worker is not what I'm looking for -> skip it
    if (JSON.stringify(wrk.options) !== JSON.stringify(wrkConf))
      continue;   // Wrong options
    //
    let wrkload = wrk.getLoad();
    //
    // If event loop utilization is too high (>70%), skip this worker
    if (wrk.lastMinuteAvgUtilization > 0.7) {
      this.log("DEBUG", "Worker skipped (high ELU)", "App.createNewSession", {
        workerIdx: i,
        utilization: wrk.lastMinuteAvgUtilization,
        sessions: wrkload
      });
      continue;
    }
    //
    if (minload === undefined || wrkload < minload) {
      minload = wrkload;
      worker = wrk;
    }
    //
    // Compute total worker-type load (i.e. the sum of all sessions for all workers of wkrConf type)
    numUsers += wrkload;
  }
  //
  // First check if this app can handle this new user
  if (numUsers >= maxAppUsers) {
    this.log("DEBUG", "Too many users", "App.createNewSession",
            {options, wrkConf, numUsers});
    return;   // Too many users
  }
  //
  // If I've found a worker but it has already too many users and I can create new workers
  let numwrk = this.workers.filter(w => !w.hibernated).length;
  if (worker?.getLoad() >= minAppUsersPerWorker && numwrk < maxAppWorkers)
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
            {workerIdx: this.workers.indexOf(worker), options, wrkConf});
  }
  else
    this.log("DEBUG", "Reuse worker", "App.createNewSession",
            {workerIdx: this.workers.indexOf(worker), options, wrkConf});
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
  for (let i = 0; i < this.workers.length; i++) {
    let s = this.workers[i].getServerSession(name);
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
            "App.startServerSession", {name, request});
  //
  let ss = this.createNewSession({type: "ss"});
  //
  // If a session can't be created -> do nothing
  if (!ss)
    return this.log("WARN", "Session can't be created: too many users", "App.startServerSession", {name});
  //
  ss.name = name;
  //
  // If I haven't done it yet create the physical process for the worker
  if (!ss.worker.child)
    ss.worker.createChild();
  //
  // Route this message to the child
  ss.sendToChild({
    type: Node.AppSession.msgTypeMap.appmsg,
    sid: ss.id,
    content: [{
      id: "onStart",
      name,
      content: {},
      master: true
    }],
    request
  });
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
    this.defaultSStimeoutID = setInterval(() => {
      // If the app is updating or stopped, wait...
      if (this.updating || this.stopped)
        return;
      //
      let s = this.getServerSession("_default");
      if (!s) {
        this.log("WARN", "Default server session evaporated -> start a new one", "App.startDefaultServerSession");
        this.startDefaultServerSession();   // Resurrect default server session
      }
    }, 5000);
};


/**
 * Stop default server session
 */
Node.App.prototype.stopDefaultServerSession = function ()
{
  if (!this.startSS)
    return;
  //
  this.getServerSession("_default")?.terminate();
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
  let idx = this.workers.indexOf(worker);
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
    setTimeout(() => {
      if (worker.child && worker.child.connected) {
        this.log("WARN", "Worker did not quit in 3 seconds -> killing him", "App.deleteWorker", {workerIdx: idx});
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
 * @returns {Promise<object>} result
 */
Node.App.prototype.sendInstallToApp = async function (options)
{
  // Create a dummy worker so that I can send install to app
  let worker = new Node.Worker(this);
  //
  // Store a promise in the worker so that it will be called when install is completed
  try {
    let result = await new Promise((resolve, reject) => {
      worker.installPromise = {resolve, reject};
      //
      // Create the worker and tell him that the app have to be installed
      worker.createChild();
      worker.stopWatchDog();  // I don't need it
      worker.child.send({
        type: Node.Worker.msgTypeMap.install,
        cnt: options
      });
    });
    //
    if (!worker.child)
      throw new Error("Child process is dead");
    //
    return result;
  }
  finally {
    // Terminate the worker (N.B.: the worker has no sessions, it's just a dummy process...
    // then I have to kill it directly!)
    worker.child?.kill();
  }
};


/**
 * Send the actual status of the App
 * @param {object} params
 * @returns {Promise<{msg: string}>}
 */
Node.App.prototype.sendStatus = async function (params)
{
  let stat = {
    name: this.name,
    version: this.version,
    date: this.date,
    params: this.params
  };
  if (this.stopped)
    stat.status = "stopped";
  else if (this.updating)
    stat.status = "updating";
  else
    stat.status = "running";
  //
  // Get the size of the app directory
  let path = Node.path.join(this.config.appDirectory, "apps", this.name);
  let cmd, cmdParams;
  if (!/^win/.test(process.platform)) {   // linux
    cmd = "/usr/bin/du";
    cmdParams = ["-sh", path];
  }
  else {  // windows
    cmd = "cmd";
    cmdParams = ["/c", "powershell", `(Get-ChildItem -Path "${path.replace(/\//g, "\\")}" -Recurse | Measure-Object -Property Length -Sum).Sum`];      // Inside "cmd /c" command / are not allowed
  }
  //
  let stdout;
  try {
    stdout = await this.server.execFileAsRoot(cmd, cmdParams);
  }
  catch (err) {
    this.log("ERROR", `Error getting the size of app folder: ${err}`, "App.sendStatus", {path});
    throw new Error(`Error getting the size of app folder: ${err}`);
  }
  //
  let size;
  if (!/^win/.test(process.platform))    // linux
    size = stdout.split("\t")[0];
  else {
    stdout = stdout.split("\r\n");        // Convert into array
    size = stdout[0];
  }
  switch (size.slice(-1)) {
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
  return {msg: JSON.stringify(stat)};
};


/**
 * Send the list of sessions for this app
 * @param {object} params
 */
Node.App.prototype.sendSessions = async function (params)
{
  // Reply:
  //  sessions: {total number of sessions}
  //  workers: [{worker 1 details}, {worker 2  details}, ...]}  (see worker::getStatus)
  let sessions = {sessions: 0, workers: []};
  //
  // Add worker's details
  for (let wrk of this.workers) {
    // Compute total app sessions (by adding worker's count)
    sessions.sessions += wrk.sessions.length;
    //
    // Add worker status
    sessions.workers.push(await wrk.getStatus(params));
  }
  //
  return {msg: JSON.stringify(sessions)};
};


/**
 * Send the list of DTT sessions for this app
 * @param {object} params
 */
Node.App.prototype.sendDttSessions = async function (params)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Deletes one or more DTT sessions for this app
 * @param {object} params
 */
Node.App.prototype.deleteDttSessions = async function (params)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Start the app
 * @param {object} params
 */
Node.App.prototype.start = async function (params)
{
  try {
    // Send "install" message to app and wait for reply
    await this.sendInstallToApp({updateDB: false});
  }
  catch (err) {
    this.log("WARN", `Error while starting the app: ${err}`, "App.start");
    throw new Error(`Error while starting the app: ${err}`);
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
};


/**
 * Stop the app
 * @param {object} params
 */
Node.App.prototype.stop = async function (params)
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
};


/**
 * Terminates the app
 * @param {object} params
 */
Node.App.prototype.terminate = async function (params)
{
  let waitWorkersStart = new Date();
  let timeout = 30000;
  //
  // Tell all workers to terminate
  let options = {
    force: params.req?.query.force,
    timeout: params.req?.query.timeout,
    msg: params.req?.query.msg
  };
  this.log("DEBUG", "Send terminate to all workers", "App.terminate");
  //
  for (let i = 0; i < this.workers.length; i++)
    this.workers[i].terminate(options);
  //
  // Wait for all workers to end
  while (this.workers.length) {
    // If the workers did not stop in timeout ms -> error
    if (new Date() - waitWorkersStart > timeout) {
      this.log("WARN", `Workers did not stop in ${timeout / 1000} seconds`, "App.terminate", {workersLeft: this.workers.length});
      //
      // Delete all workers still alive (if they don't die smothly they will be killed)
      for (let worker of this.workers)
        this.deleteWorker(worker);
      //
      break;
    }
    //
    // Wait 500 ms before checking again
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  //
  // Done. All worker terminated
  this.log("DEBUG", "All workers have been terminated", "App.terminate");
};


/**
 * Flag all workers as hibernate (the will not accept new sessions)
 */
Node.App.prototype.hibernateWorkers = function ()
{
  // Server session must be stoped
  this.stopDefaultServerSession();
  //
  for (let i = 0; i < this.workers.length; i++)
    this.workers[i].hibernated = true;
};


/*
 * Install the app in the production server getting the installation package from S3
 * @param {object} params
 */
Node.App.prototype.install = async function (params)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Uninstalls the app
 * @param {object} params
 */
Node.App.prototype.uninstall = async function (params)
{
  try {
    // First terminate all sessions
    try {
      // force TERMINATE
      params.req.query.force = true;
      await this.terminate(params);
    }
    catch (err) {
      throw new Error(`Can't terminate the app: ${err}`);
    }
    //
    // Remove app directory
    try {
      await Node.fs.promises.rm(Node.path.join(this.config.appDirectory, "apps", this.name), {recursive: true, force: true});
    }
    catch (err) {
      throw new Error(`Can't delete app folder: ${err}`);
    }
    //
    // Remove app backups (if any)
    try {
      await Node.fs.promises.rm(Node.path.join(this.config.appDirectory, "backups", this.name), {recursive: true, force: true});
    }
    catch (err) {
      throw new Error(`Can't delete backup folder: ${err}`);
    }
    //
    // Tell the user to delete this app
    this.user.deleteApp(this);
    //
    // Log the operation
    this.log("INFO", "App deleted", "App.uninstall");
  }
  catch (err) {
    this.log("WARN", err.message || err, "App.uninstall");
    throw err;
  }
};


/**
 * Updates app's DBs schema
 * @param {object} params
 */
Node.App.prototype.updateDBschema = async function (params)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Handle change app parameter message
 * @param {Object} msg
 * @param {boolean} skipSave - if true the params.json file will not be saved
 */
Node.App.prototype.handleChangedAppParamMsg = async function (msg, skipSave)
{
  // Get the new parameter
  this.params = this.params || {};
  if (msg.new !== undefined)
    this.params[msg.par] = msg.new;
  else
    delete this.params[msg.par];
  //
  // Tell it to every session in every worker
  for (let i = 0; i < this.workers.length; i++) {
    let wrk = this.workers[i];
    //
    // Skip "dead" workers (i.e. workers with no child process)
    if (!wrk.child)
      continue;
    //
    wrk.child.send({
      type: Node.Worker.msgTypeMap.changedAppParam,
      cnt: msg
    });
  }
  //
  // If I don't need to save, I've done my job
  if (skipSave)
    return;
  //
  // Save parameters to disk
  clearTimeout(this.saveParamsTimer);
  this.saveParamsTimer = setTimeout(async () => {
    try {
      await this.saveParameters();
    }
    catch (err) {
      this.log("ERROR", `Can't update app parameters: ${err}`, "App.handleChangedAppParamMsg", msg);
    }
  }, 100);
};


/**
 * Save app parameters on disk
 */
Node.App.prototype.saveParameters = async function ()
{
  // If params is empty, forget about it
  let par;
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
  let filename = Node.path.join(this.config.appDirectory, "apps", this.name, "files", "private", "app_params.json");
  await Node.Utils.saveObject(filename, par);
};


/**
 * Backup the app
 * @param {object} params
 */
Node.App.prototype.backupToDisk = async function (params)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Restore an app backup
 * @param {object} params
 */
Node.App.prototype.restoreFromDisk = async function (params)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Backup the app
 * @param {object} params
 */
Node.App.prototype.backup = async function (params)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Restore the app
 * @param {object} params
 */
Node.App.prototype.restore = async function (params)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Handle file system commands
 * @param {object} params
 */
Node.App.prototype.handleFileSystem = async function (params)
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
 */
Node.App.prototype.configure = async function (params)
{
  // Compute the array of properties provided via url
  let query = params.req.query;
  //
  this.log("INFO", "Update app settings", "App.configure", query);
  //
  let logData;
  let warning = false;
  try {
    let queryProps = Object.getOwnPropertyNames(query);
    if (queryProps.length === 0) {
      warning = true;
      throw new Error("No property specified");
    }
    //
    if (query.name) {
      try {
        await Node.fs.promises.rename(Node.path.join(this.config.appDirectory, "apps", this.name), Node.path.join(this.config.appDirectory, "apps", query.name));
        this.name = query.name;
      }
      catch (ex) {
        logData = {newName: query.name};
        throw new Error(`Can't rename app: ${ex.message}`);
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
        warning = true;
        logData = {customWorkerConf: query.customWorkerConf};
        throw new Error(`Invalid customWorkerConf setting: ${ex.message}`);
      }
    }
    if (query.params !== undefined) {
      let newParams = {};
      if (query.params) {
        // Callee will send every time all parameters as an array of NAME=VALUE couples
        try {
          let paramsArray = JSON.parse(query.params);
          //
          // Change from
          //    ["par1=valuePar1", "par2=valuePar2", ...]
          // to
          //    {
          //     "par1": "valuePar1",
          //     "par2": "valuePar2",
          //    }
          for (let i = 0; i < paramsArray.length; i++) {
            let par = paramsArray[i].split("=");
            //
            let parName = par[0];
            let parValue = par.slice(1).join("=");
            //
            newParams[parName] = parValue;
          }
        }
        catch (ex) {
          warning = true;
          logData = {newParams: query.params};
          throw new Error(`Can't update app parameters: ${ex.message}`);
        }
      }
      else  // No parameters
        newParams = {};
      //
      // Create a new params object if needed
      this.params = this.params || {};
      //
      // Now check new parameters
      let saveParamFile = false;
      let parr = Object.keys(Object.assign({}, newParams, this.params));
      for (let i = 0; i < parr.length; i++) {
        let parName = parr[i];
        if (newParams[parName] === this.params[parName])
          continue;   // Value hasn't changed
        //
        // Value has changed -> tell every session that a parameter has changed
        await this.handleChangedAppParamMsg({par: parName, old: this.params[parName], new : newParams[parName]}, true);   // SkipSave
        //
        // Don't save volatile (i.e. non permanent) parameters
        if (!["enableDtt", "logDttQueries"].includes(parName))
          saveParamFile = true; // Params file should be saved at the end
      }
      //
      // Save param object
      if (saveParamFile) {
        try {
          await this.saveParameters();
        }
        catch (err) {
          logData = {params: this.params};
          throw new Error(`Can't update app parameters: ${err}`);
        }
      }
    }
    //
    // Save the new configuration
    this.config.saveConfig();
    //
    // Log the operation
    this.log("INFO", "App settings updated", "App.configure");
  }
  catch (err) {
    this.log(warning ? "WARN" : "ERROR", err.message || err, "App.configure", logData);
    throw err;
  }
};


/**
 * Start a test session for this app
 * @param {object} params
 */
Node.App.prototype.test = function (params)
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
 */
Node.App.prototype.processCommand = async function (params)
{
  return await this.execCommand(params);
};


/**
 * Execute commands for the app
 * @param {object} params
 * @returns {Promise}
 */
Node.App.prototype.execCommand = async function (params)
{
  let command = params.tokens[0];
  //
  // If the authorization key is enabled and the given one does not match -> error
  if (this.config.auth && params.req.query.autk !== this.config.autk) {
    this.log("WARN", "Unauthorized", "App.execCommand", {url: params.req.originalUrl});
    throw {err: "Unauthorized", code: 401};
  }
  //
  // Valid AUTK (or AUTK not enabled)
  switch (command) {
    case "status":
      return await this.sendStatus(params);

    case "sessions":
      return await this.sendSessions(params);

    case "dttsessions":
      return await this.sendDttSessions(params);

    case "deletedttsessions":
      return await this.deleteDttSessions(params);

    case "start":
      return await this.start(params);

    case "stop":
      return await this.stop(params);

    case "terminate":
      return await this.terminate(params);

    case "install":
      return await this.install(params);

    case "uninstall":
      return await this.uninstall(params);

    case "backup":
      return await this.backup(params);

    case "restore":
      return await this.restore(params);

    case "updatedbschema":
      return await this.updateDBschema(params);

    case "filesystem":
      return await this.handleFileSystem(params);

    case "config":
      return await this.configure(params);

    case "test":
      return this.test(params);

    default:
      this.log("WARN", "Invalid Command", "App.execCommand", {cmd: command, url: params.req.originalUrl});
      throw new Error("Invalid Command");
  }
};


// Export module
module.exports = Node.App;
