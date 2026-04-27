/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
var Node = Node || {};

// Import modules
Node.child = require("child_process");
Node.path = require("path");

// Import Classes
Node.AppSession = require("./appsession");
Node.Utils = require("../utils");

/*
 * @Class representing an app worker
 * @param {Node.App} par
 */
Node.Worker = function (par)
{
  this.parent = par;
  //
  // Sessions in this worker
  this.sessions = [];
};


Node.Worker.msgTypeMap = {
  initApp: "initApp",
  processRequest: "pr",
  sessionParams: "sespar",
  terminate: "terminate",
  deleteSession: "delses",
  sendRestResponse: "rest",
  watchdogRequest: "wdreq",
  watchdogResponse: "wdres",
  connectionDB: "conDB",
  sync: "sync",
  syncBroad: "syncBroad",
  cloudConnectorMsg: "ccm",
  install: "inst",
  installResult: "instres",
  createDB: "cdb",
  createDBresult: "cdbres",
  serverSession: "serverSession",
  testStartResult: "testres",
  cTokenOp: "ctop",
  changedAppParam: "chpar",
  dtt: "dtt",
  log: "log",
  deleteTraceFiles: "dtf",
  deleteTraceFilesResult: "dtfr",
  getStatus: "gst",
  getStatusResult: "gstr",
  notifyFeedbackToConsole: "nftc",
  eval: "eval",
  evalResult: "evalResult",
  serverStatus: "serverStatus",
  serverStatusResult: "serverStatusResult"
};


// Define usefull properties for this object
Object.defineProperties(Node.Worker.prototype, {
  app: {
    get() {
      return this.parent;
    }
  },
  user: {
    get() {
      return this.app.user;
    }
  },
  server: {
    get() {
      return this.app.server;
    }
  },
  config: {
    get() {
      return this.app.config;
    }
  },
  logger: {
    get() {
      return this.app.logger;
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
Node.Worker.prototype.log = function (level, message, sender, data)
{
  // Add "local" info
  data = (data ? JSON.parse(JSON.stringify(data)) : {});
  data.app = this.app.name;
  data.user = this.user.userName;
  data.workerIdx = this.app.workers.indexOf(this);
  data.totalWorkers = this.app.workers.length;
  data.options = this.options;
  //
  this.logger.log(level, message, sender, data);
};


/**
 * Create a new child process for this worker
 */
Node.Worker.prototype.createChild = function ()
{
  let appPath = Node.path.join(this.config.appDirectory, "apps", this.app.name, "server", "app.js");
  //
  // Create the child process
  // If I'm installing, get ERRORS from child stderr stream
  let runErrors = [];
  if (this.installPromise) {
    this.child = Node.child.fork(appPath, [], Object.assign({silent: true}, Node.Utils.forkArgs()));     // Capture StdErr errors
    //
    this.child.stderr.on("data", err => {
      err += "";      // Convert error into string
      this.log("WARN", `Application error: ${err}`, "Worker.createChild");
      //
      // Store error in errors array
      runErrors.push(err);
    });
  }
  else
    this.child = Node.child.fork(appPath, Node.Utils.forkArgs());
  //
  // Log child creation
  this.log("DEBUG", "Created app child", "Worker.createChild");

  // Now, that everything is completed and child is ready, if requested change child process priority excecuting renice command
  if (this.options && this.options.priority && !/^win/.test(process.platform)) {
    Node.child.execFile("/usr/bin/renice", [this.options.priority, this.child.pid], (err, stdout, stderr) => {
      if (err)
        this.log("WARN", `Can't renice child process: ${err}`, "Worker.createChild");
    });
  }
  //
  // Initialize app child
  this.child.send({
    type: Node.Worker.msgTypeMap.initApp,
    sender: "master",
    name: this.app.name,
    url: this.config.getUrl(),
    path: Node.path.join(this.config.appDirectory, "apps", this.app.name),
    publicUrl: `${this.config.getUrl()}/${this.app.name}`,
    online: true,
    workerIdx: this.app.workers.indexOf(this),
    params: Object.assign({}, this.config.params, this.app.params, {_lowDiskThreshold: this.config.lowDiskThreshold}),
    services: this.config.services
  });
  //
  // Tell the app how to connect with the database
  let constring = `postgres://${this.config.dbUser}:${this.config.dbPassword}@${this.config.dbAddress}:${this.config.dbPort}`;
  this.child.send({
    type: Node.Worker.msgTypeMap.connectionDB,
    username: (this.user.userName === "manager" ? undefined : this.user.userName),
    constring,
    remoteDBurls: this.config.getRemoteDBUrls()
  });
  //
  // Listen for messages
  this.child.on("message", msg => this.handleAppChildMessage(msg));
  this.child.on("disconnect", () => {
    this.log("DEBUG", "Worker child disconnected", "Worker.createChild");
    //
    // Now the child is dead
    delete this.child;
    //
    // Child has died. If I was installing the child crashed during install
    if (this.installPromise) {
      let err = runErrors.join("\n") || "Unknown error";
      this.installPromise.reject(new Error(`Installation failed: ${err}`));
      delete this.installPromise;
    }
    else if (this.app.workers.includes(this)) {
      // If I'm still inside my app's worker list it means I've crashed...
      // (see app::deleteWorker: first the worker is removed then the worker's child is disconnected)
      this.log("WARN", "Worker is still inside app's list (maybe it crashed?) -> Delete worker all its sessions", "Worker.createChild",
              {numsession: this.sessions.length});
      //
      // Terminate and delete all worker's sessions
      while (this.sessions.length) {
        let sToDel = this.sessions[0];
        sToDel.terminate();
        this.deleteSession(sToDel);
      }
      //
      // Now, deleting all sessions should have programmed my death (see Worker::deleteSession).
      // I don't need to die... I just need a new child...
      if (this.killWorkerTimer) {
        clearTimeout(this.killWorkerTimer);
        delete this.killWorkerTimer;
      }
      //
      this.log("INFO", "Crashed worker restored", "Worker.createChild");
    }
    //
    // If a getStatus was pending, resolve with empty data
    if (this.statusResultPromise) {
      this.statusResultPromise.resolve({sessions: []});
      delete this.statusResultPromise;
    }
  });
  //
  // Start the child process watchdog
  this.startWatchDog();
};


/**
 * Kill the child process
 * @param {boolean} force - if true sends a SIGKILL message
 */
Node.Worker.prototype.killChild = function (force)
{
  // If dead, do nothing
  if (!this.child)
    return;
  //
  // If there was a kill timer, stop it
  if (this.killWorkerTimer) {
    clearTimeout(this.killWorkerTimer);
    delete this.killWorkerTimer;
  }
  //
  // Stop watchDog... I'll be dead soon!
  this.stopWatchDog();
  //
  // If requested use brute force
  if (force) {
    this.log("WARN", "Forcedly kill worker child", "Worker.killChild");
    this.child.kill("SIGKILL");
    //
    // Now the child should be dead
    delete this.child;
  }
  else {
    this.log("DEBUG", "Disconnects worker child", "Worker.killChild");
    this.child.disconnect();
  }
};


/**
 * Handle app child messages (i.e. messages sent by app.js)
 * @param {object} msg
 */
Node.Worker.prototype.handleAppChildMessage = function (msg)
{
  switch (msg.type) {
    case Node.Worker.msgTypeMap.processRequest: {
      // Send the message to the right app session
      let appsess = this.server.appSessions[msg.sid];
      if (appsess)
        appsess.sendMessageToClientApp(msg);
      else
        this.log("WARN", "Can't process request: session not found", "Worker.handleAppChildMessage", msg);
      break;
    }

    case Node.Worker.msgTypeMap.sessionParams: {
      // Send the message to the right app session
      let appsess = this.server.appSessions[msg.sid];
      if (appsess)
        appsess.handleSessionParams(msg.cnt);
      else
        this.log("WARN", "Can't handle session params message: session not found", "Worker.handleAppChildMessage", msg);
      break;
    }

    case Node.Worker.msgTypeMap.deleteSession: {
      let appsess = this.server.appSessions[msg.sid];
      appsess?.terminate();
      break;
    }

    case Node.Worker.msgTypeMap.sendRestResponse: {
      let appsess = this.server.appSessions[msg.sid];
      if (appsess)
        appsess.handleSendResponseMsg(msg);
      else
        this.log("WARN", "Can't send REST response: session not found", "Worker.handleAppChildMessage", msg);
      break;
    }

    case Node.Worker.msgTypeMap.watchdogResponse:
      if (this.watchdog)
        this.watchdog.lastTick = new Date();
      //
      // Handle event loop utilization if provided
      if (msg.cnt)
        this.handleEventLoopStatus(msg.cnt);
      break;

    case Node.Worker.msgTypeMap.sync:
      this.handleSync(msg);
      break;

    case Node.Worker.msgTypeMap.syncBroad:
      this.handleSyncBroad(msg);
      break;

    case Node.Worker.msgTypeMap.cloudConnectorMsg:
      this.user.handleCloudConnectorMessage(msg.cnt, this);
      break;

    case Node.Worker.msgTypeMap.createDB:
      this.handleCreateDBMsg(msg);
      break;

    case Node.Worker.msgTypeMap.cTokenOp: {
      let appsess = this.server.appSessions[msg.sid];
      appsess?.handleCTokenOpMsg(msg);
      break;
    }

    case Node.Worker.msgTypeMap.installResult:
      if (this.installPromise) {
        let {resolve, reject} = this.installPromise;
        delete this.installPromise;
        //
        // Resolve promise attached at the beginning of the install method (see Worker::installApp)
        msg.cnt.err ? reject(new Error(msg.cnt.err)) : resolve(msg.cnt.appinfo);
      }
      else
        this.log("WARN", "Can't handle install result message: no promise", "Worker.handleAppChildMessage", msg);
      break;

    case Node.Worker.msgTypeMap.testStartResult:
      if (this.app.testAuto && msg.cnt && this.app.testAuto[msg.cnt.testAutoId])
        this.app.testAuto[msg.cnt.testAutoId].handleUpdateSchemaResult(msg.cnt);
      break;

    case Node.Worker.msgTypeMap.serverSession:
      this.handleServerSessionMsg(msg);
      break;

    case Node.Worker.msgTypeMap.changedAppParam:
      this.app.handleChangedAppParamMsg(msg.cnt);
      break;

    case Node.Worker.msgTypeMap.dtt: {
      // Send the message to the right app session
      let appsess = this.server.appSessions[msg.sid];
      if (appsess)
        appsess.sendDttMessage(msg);
      else
        this.log("WARN", "Can't process DTT request: session not found", "Worker.handleAppChildMessage", msg);
      break;
    }

    case Node.Worker.msgTypeMap.log:
      this.log(msg.level, msg.message, msg.sender, msg.data);
      break;

    case Node.Worker.msgTypeMap.deleteTraceFilesResult: {
      if (!this.app.deleteTraceFilesPromise)
        return this.log("WARN", "Can't handle delete trace result message: no promise", "Worker.handleAppChildMessage", msg);
      //
      let {resolve, reject} = this.app.deleteTraceFilesPromise;
      delete this.app.deleteTraceFilesPromise;
      //
      msg.err ? reject(msg.err) : resolve();
      break;
    }

    case Node.Worker.msgTypeMap.getStatusResult:
      if (this.statusResultPromise) {
        let {resolve} = this.statusResultPromise;
        delete this.statusResultPromise;
        //
        resolve(msg.cnt);      // Resolve promise attached inside the getStatus method
      }
      else
        this.log("WARN", "Can't handle status result message: no promise", "Worker.handleAppChildMessage", msg);
      break;

    case Node.Worker.msgTypeMap.notifyFeedbackToConsole:
      this.app.handleFeedbackMsgToConsole(msg);
      break;

    case Node.Worker.msgTypeMap.evalResult:
      if (msg.cnt.error)
        this.log("WARN", `Error while executing EVAL: ${msg.cnt.error}`, "Worker.handleAppChildMessage", msg);
      break;

    case Node.Worker.msgTypeMap.serverStatus:
      this.handleServerStatus(msg);
      break;

    default:
      this.log("WARN", "Unhandled message", "Worker.handleAppChildMessage", msg);
      break;
  }
};


/**
 * Handle event loop utilization status updates from child process
 * Storage strategy:
 *   - Last hour: samples every 5 seconds (720 samples)
 *   - Previous 23 hours: 1-minute averages (1380 samples)
 * @param {Object} elu - Event loop utilization metrics
 */
Node.Worker.prototype.handleEventLoopStatus = function (elu)
{
  if (!elu)
    return;
  //
  let now = new Date();
  //
  // Initialize storage if needed
  if (!this.eluStorage) {
    this.eluStorage = {
      lastHour: [],           // 5-second samples for last hour
      previous23Hours: [],    // 1-minute averages for previous 23 hours
      minuteAccumulator: []   // Temporary accumulator for current minute
    };
  }
  //
  // Save current ELU for getStatus()
  this.eventLoopUtilization = elu;
  //
  // Add to last hour (5-second samples) - only utilization
  this.eluStorage.lastHour.push({
    timestamp: now,
    utilization: elu.utilization
  });
  //
  // Calculate average utilization over last minute (after adding new sample)
  this.calculateLastMinuteAverage();
  //
  // Keep only last hour
  let oneHourAgo = now - 3600000;
  while (this.eluStorage.lastHour.length > 0 && this.eluStorage.lastHour[0].timestamp < oneHourAgo) {
    // Move oldest sample from lastHour to minuteAccumulator for aggregation
    let oldSample = this.eluStorage.lastHour.shift();
    this.eluStorage.minuteAccumulator.push(oldSample);
  }
  //
  // Aggregate minute samples based on time elapsed (not count)
  // Check if we have at least 1 minute of data to aggregate
  if (this.eluStorage.minuteAccumulator.length > 0) {
    let firstSample = this.eluStorage.minuteAccumulator[0];
    let lastSample = this.eluStorage.minuteAccumulator[this.eluStorage.minuteAccumulator.length - 1];
    let timeSpan = lastSample.timestamp - firstSample.timestamp;
    //
    // If we have at least 1 minute of samples, aggregate them
    if (timeSpan >= 60000) {
      let utilization = 0;
      //
      for (let i = 0; i < this.eluStorage.minuteAccumulator.length; i++)
        utilization += this.eluStorage.minuteAccumulator[i].utilization;
      //
      this.eluStorage.previous23Hours.push({
        timestamp: new Date(firstSample.timestamp),
        utilization: utilization / this.eluStorage.minuteAccumulator.length,
        sampleCount: this.eluStorage.minuteAccumulator.length  // For debugging
      });
      this.eluStorage.minuteAccumulator = [];
      //
      // Keep only 23 hours of minute averages (1380 samples = 23 * 60)
      if (this.eluStorage.previous23Hours.length > 1380)
        this.eluStorage.previous23Hours.shift();
    }
  }
  //
  // Log warning if utilization is critically high (max once per minute)
  if (elu.utilization > 0.8) {
    let lastWarning = this.eluStorage.lastWarning || 0;
    let timeSinceLastWarning = now - lastWarning;
    //
    if (timeSinceLastWarning > 60000) {  // 60 seconds
      this.eluStorage.lastWarning = now;
      this.log("WARN", `Event loop heavily loaded (${(elu.utilization * 100).toFixed(1)}%)`, "Worker.handleEventLoopStatus", {
        utilization: elu.utilization,
        workerIdx: this.app.workers.indexOf(this),
        pid: this.child?.pid
      });
    }
  }
};


/**
 * Calculate average event loop utilization over last minute
 * Returns undefined if: no data yet OR no samples in last minute (worker blocked)
 */
Node.Worker.prototype.calculateLastMinuteAverage = function ()
{
  if (!this.eluStorage || this.eluStorage.lastHour.length === 0) {
    this.lastMinuteAvgUtilization = undefined;
    return;
  }
  //
  let now = new Date();
  let oneMinuteAgo = now - 60000;
  let sum = 0;
  let count = 0;
  //
  // Calculate average from samples in last minute
  for (let i = this.eluStorage.lastHour.length - 1; i >= 0; i--) {
    let sample = this.eluStorage.lastHour[i];
    if (sample.timestamp < oneMinuteAgo)
      break;
    //
    sum += sample.utilization;
    count++;
  }
  //
  // If we have samples, calculate average
  if (count > 0) {
    this.lastMinuteAvgUtilization = sum / count;
    this.lastMinuteSampleCount = count;
  }
  else {
    // No samples in last minute = worker is probably blocked/frozen
    // Assume 100% utilization to avoid assigning new sessions
    this.lastMinuteAvgUtilization = 1.0;
    this.lastMinuteSampleCount = 0;
  }
};


/*
 * Process the sync message
 * @param {object} msg
 */
Node.Worker.prototype.handleSync = function (msg)
{
  let session = this.server.appSessions[msg.sid.sidsrv];
  if (!session)
    return this.log("WARN", "Can't handle SYNC message: session not found", "Worker.handleSync", msg);
  //
  if (!session.syncSocket)
    return this.log("WARN", "Can't handle SYNC message: socket disconnected", "Worker.handleSync", msg);
  //
  if (msg.cnt.id === "disconnect")
    session.syncSocket.disconnect();
  else
    session.syncSocket.emit("sync", msg);
};


/*
 * Process the syncBroad message
 * @param {object} msg
 */
Node.Worker.prototype.handleSyncBroad = function (msg)
{
  // Check if there are other apps to which I have to dispatch the message
  let appNames = msg.cnt.relApps || [];
  appNames.unshift(this.app.name);
  delete msg.cnt.relApps;
  //
  for (let a = 0; a < appNames.length; a++) {
    let app = this.user.getApp(appNames[a]);
    if (!app) {
      this.log("WARN", `Can't dispatch message to app ${appNames[a]}: app not found`, "Worker.handleSyncBroad", msg);
      continue;
    }
    //
    for (let i = 0; i < app.workers.length; i++)
      app.workers[i].sendToChild({
        type: Node.Worker.msgTypeMap.syncBroad,
        cnt: msg.cnt
      });
  }
};


/*
 * Handles a create DB message
 * @param {object} msg
 */
Node.Worker.prototype.handleCreateDBMsg = async function (msg)
{
  // Create the database for worker's user
  let err;
  try {
    await this.user.createDatabase(msg.dbname);
  }
  catch (e) {
    // It's an error only if the error is not "the DB already exists"
    if (e.message !== "Database already exists") {
      this.log("WARN", `Can't create database: ${e}`, "Worker.handleCreateDBMsg", {dbname: msg.dbname});
      err = e;
    }
  }
  //
  // Report to callee
  if (this.child)    // The child could be dead if it crashed some time ago...
    this.child.send({
      type: Node.Worker.msgTypeMap.createDBresult,
      dbname: msg.dbname,
      err
    });
  else
    this.log("WARN", "Child process is dead -> can't send create DB result", "Worker.handleCreateDBMsg", {dbname: msg.dbname, err});
};


/*
 * Handles a server session message
 * @param {object} msg
 */
Node.Worker.prototype.handleServerSessionMsg = function (msg)
{
  let name = msg.cnt.name;
  let request = msg.cnt.request;
  let ss = this.app.getServerSession(name);
  //
  switch (msg.cnt.cmd) {
    case "start":
      if (ss)
        return this.log("WARN", "Can't start server session: session with same name already exists", "Worker.handleServerSessionMsg", msg);
      //
      this.app.startServerSession(name, request);
      break;

    case "stop":
      if (!ss)
        return this.log("WARN", "Can't stop server session: session not found", "Worker.handleServerSessionMsg", msg);
      //
      ss.terminate();
      break;

    case "running":
      this.sendToChild({
        type: Node.AppSession.msgTypeMap.appmsg,
        sid: msg.cnt.sid,
        request,
        content: [{
          id: "serverSessionCB",
          content: {
            cbId: msg.cnt.cbId,
            running: !!ss
          },
          master: true
        }]
      });
      break;
  }
};


/*
 * Get a server session by name
 * @param {string} name
 * @returns {Node.AppSession}
 */
Node.Worker.prototype.getServerSession = function (name)
{
  let ids = Object.keys(this.sessions);
  for (let i = 0; i < ids.length; i++) {
    let s = this.sessions[ids[i]];
    if (s.name === name)
      return s;
  }
};


/**
 * Starts the watchdog that checks if the child process is up and running properly
 */
Node.Worker.prototype.startWatchDog = function ()
{
  // If there was a previous watchdog, kill it
  this.stopWatchDog();
  //
  // Check process every 5 seconds... If it does not reply for more than 30 seconds, kill it
  this.watchdog = {
    lastTick : new Date(),
    intervalID: setInterval(() => {
      // If I'm already dying, do nothing but refreshing the watchdog lastTick (no sessions means no one can me stuck)
      if (this.killWorkerTimer) {
        this.watchdog.lastTick = new Date();
        return;
      }
      //
      // If the elapsed time exceeded
      let dt = (new Date() - this.watchdog.lastTick);
      if (dt > 30000) {
        this.log("WARN", "Child did not answer for 30sec -> killing it", "Worker.startWatchDog");
        //
        // Kill the child (brute force)
        this.killChild(true);
        //
        // Stop the watchdog
        this.stopWatchDog();
        return;
      }
      //
      // If the child is still here, check if is alive and kicking
      if (this.child)
        this.sendToChild({
          type: Node.Worker.msgTypeMap.watchdogRequest
        });
    }, 5000)
  };
};


/**
 * Stops the watchdog that checks if the child process is up and running properly
 */
Node.Worker.prototype.stopWatchDog = function ()
{
  // If the watchdog was enabled stop its interval
  if (this.watchdog?.intervalID)
    clearInterval(this.watchdog.intervalID);
  //
  delete this.watchdog;
};


/**
 * Get the number of sessions for this worker
 */
Node.Worker.prototype.getLoad = function ()
{
  return this.sessions.length;
};


/**
 * Create a new session
 * @returns {Node.AppSession}
 */
Node.Worker.prototype.createNewSession = function ()
{
  // If this worker was dying (see Worker::deleteSession), stop the death timer
  if (this.killWorkerTimer) {
    clearTimeout(this.killWorkerTimer);
    delete this.killWorkerTimer;
  }
  //
  // Create a new session
  let session = new Node.AppSession(this);
  this.sessions.push(session);
  //
  // Add this session to the "global" session map in the server
  // (so that he can route all connections to this session)
  this.server.appSessions[session.id] = session;
  //
  // Log the operation
  this.log("DEBUG", "Created app session", "Worker.createNewSession", {sid: session.id});
  //
  return session;
};


/**
 * Delete the session
 * @param {session} session
 */
Node.Worker.prototype.deleteSession = function (session)
{
  this.log("DEBUG", "Delete worker session", "Worker.deleteSession", {sid: session.id});
  //
  // Remove the session from my session list
  let idx = this.sessions.indexOf(session);
  if (idx === -1)
    return this.log("WARN", "Session not found", "Worker.deleteSession", {sid: session.id});
  //
  this.sessions.splice(idx, 1);
  //
  // Delete the session from the server global map
  delete this.server.appSessions[session.id];
  //
  // If there are no more sessions in this worker, delete it after 10 seconds
  if (this.getLoad() === 0) {
    let killTimeout = (this.options ? this.options.idleTimeout : 0) || 5000;      // default: 5 sec
    //
    this.log("DEBUG", "Worker is empty", "Worker.deleteSession", {killTimeout: killTimeout});
    this.killWorkerTimer = setTimeout(() => {
      this.log("DEBUG", "Worker is empty and timeout expired -> delete it", "Worker.deleteSession", {killTimeout: killTimeout});
      this.app.deleteWorker(this);
    }, killTimeout);
  }
};


/**
 * Terminate the worker
 * @param {object} options ({force, timeout, msg})
 */
Node.Worker.prototype.terminate = function (options)
{
  if (this.child)
    this.child.send({
      type: Node.Worker.msgTypeMap.terminate,
      options
    });
  else
    this.log("WARN", "Worker has no child: can't send TERMINATE", "Worker.terminate");
};


/**
 * Send a message to worker's child
 * @param {object} msg - message to send
 */
Node.Worker.prototype.sendToChild = function (msg)
{
  if (this.child)
    this.child.send(msg);
  else
    this.log("WARN", "Can't send message: worker's child is gone", "Worker.sendToChild", msg);
};


/**
 * Returns the worker's status
 * @param {object} params
 */
Node.Worker.prototype.getStatus = async function (params)
{
  let stat = {sessions: this.sessions.length};
  //
  // If I'm hibernated, inform callee
  if (this.hibernated)
    stat.hibernated = true;
  //
  // If a FULL status is requested, replace sessions count with an array of SIDs
  if (params.req.query.full) {
    stat.options = this.options;
    //
    stat.sessions = [];
    for (let i = 0; i < this.sessions.length; i++) {
      let session = this.sessions[i];
      //
      // If not online, flag it as "zombie"
      let online = (session.masterAppClient || session.syncSocket || session.restReq || session.name === "_default");
      stat.sessions.push(session.id + (online ? "" : " (-)"));
    }
    stat.sessions.sort();
  }
  //
  // If I've no child, I've nothing more to say
  if (!this.child)
    return stat;
  //
  // If a FULL status is requested, get child sessions count
  if (params.req.query.full) {
    // Ask my child the sessions count
    if (this.child) {
      let childStatus = await new Promise((resolve, reject) => {
        this.statusResultPromise = {resolve};
        this.child.send({
          type: Node.Worker.msgTypeMap.getStatus
        });
      });
      //
      stat.childSessions = childStatus.sessions;
    }
    else
      stat.childSessions = [];
  }
  //
  // Add child's PID
  stat.pid = this.child.pid;
  //
  // Add event loop utilization metrics if available
  if (this.eluStorage) {
    stat.eventLoop = {
      current: this.eventLoopUtilization,
      lastHour: this.eluStorage.lastHour,
      previous23Hours: this.eluStorage.previous23Hours
    };
  }
  //
  // On Windows there is nothing I can add
  if (/^win/.test(process.platform))   // windows
    return stat;
  //
  let logData;
  try {
    // Add more info (per-process CPU load)
    if (process.platform === "freebsd") {   // freebsd
      try {
        let stdout = await new Promise((resolve, reject) => {
          Node.child.execFile("/bin/ps", ["-o", "pcpu", "-p", this.child.pid], (err, stdout, stderr) => {
            if (err)
              reject(new Error(stderr || err.message || err));
            else
              resolve(stdout);
          });
        });
        stat.cpuLoad = stdout.split("\n")[1];   // Remove headers
      }
      catch (err) {
        throw new Error(`Error getting the CPU load: ${err}`);
      }
    }
    else if (process.platform === "linux") {   // linux
      let stdout;
      try {
        stdout = await new Promise((resolve, reject) => {
          Node.child.execFile("/usr/bin/top", ["-b", "-n", "1"], (err, stdout, stderr) => {
            // If the child is gone
            if (!err && !this.child)
              err = stderr = "child process is gone";
            //
            if (err)
              reject(new Error(stderr || err.message || err));
            else
              resolve(stdout);
          });
        });
      }
      catch (err) {
        throw new Error(`Error getting the CPU load: ${err}`);
      }
      //
      stdout = stdout.split("\n").slice(4);   // Remove headers
      for (let i = 0; i < stdout.length; i++) {
        // Search right PID
        let procstat = stdout[i].trim().split(/\s+/);
        if (parseInt(procstat[0]) === this.child.pid) {
          stat.cpuLoad = procstat[7].replace("%", "");
          break;
        }
      }
      //
      // Ok... I haven't found it... on Alpine I've a problem if PID gets too big...
      // It moves stuff away...
      //   PID  PPID USER     STAT   VSZ %VSZ CPU %CPU COMMAND
      //    41     8 postgres S     162m   2%   1   0% postgres: autovacuum launcher process
      // 35179562093990 root     S     493m   7%   0   5% node /mnt/disk/IndeRT/server/server.js
      // I have to get the line that "starts" with the given PID
      for (let i = 0; i < stdout.length && !stat.cpuLoad; i++) {
        // Search right PID
        let procstat = stdout[i].trim().split(/\s+/);
        if (procstat[0].startsWith(this.child.pid)) {
          stat.cpuLoad = procstat[7].replace("%", "");
          break;
        }
      }
      //
      if (!stat.cpuLoad) {
        logData = {pid: this.child.pid};
        throw new Error("Error getting the CPU load. PID not found");
      }
    }
    //
    stat.cpuLoad = parseFloat(stat.cpuLoad);
  }
  catch (err) {
    this.log("ERROR", err.message || err, "Worker.getStatus", logData);
    stat.cpuLoad = err.message || err;
  }
  //
  return stat;
};


/*
 * Handles a server session message
 * @param {object} msg
 */
Node.Worker.prototype.handleServerStatus = async function (msg)
{
  let response = {
    type: Node.Worker.msgTypeMap.serverStatusResult,
    cnt: {
      sid: msg.cnt.sid,
      cbId: msg.cnt.cbId
    }
  };
  //
  try {
    let result = await this.server.config.sendStatus({
      req: {
        query: {}
      }
    });
    if (!result.msg)
      throw result.err || result;
    //
    response.cnt.status = JSON.parse(result.msg).serverInfo;
  }
  catch (err) {
    response.cnt.error = err.message || err;
  }
  //
  this.sendToChild(response);
};


// Export module
module.exports = Node.Worker;
