/*
 * Instant Developer Next
 * Copyright Pro Gamma Spa 2000-2016
 * All rights reserved
 */
/* global require, module */

var Node = Node || {};

// Import modules
Node.child = require("child_process");

// Import Classes
Node.AppSession = require("./appsession");

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
  connectionDB: "conDB",
  sync: "sync",
  syncBroad: "syncBroad",
  cloudConnectorMsg: "ccm",
  install: "inst",
  installResult: "instres",
  createDB: "cdb",
  createDBresult: "cdbres"
};


// Define usefull properties for this object
Object.defineProperties(Node.Worker.prototype, {
  app: {
    get: function () {
      return this.parent;
    }
  },
  user: {
    get: function () {
      return this.app.user;
    }
  },
  server: {
    get: function () {
      return this.app.server;
    }
  },
  config: {
    get: function () {
      return this.app.config;
    }
  },
  logger: {
    get: function () {
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
  //
  this.logger.log(level, message, sender, data);
};


/**
 * Create a new child process for this worker
 */
Node.Worker.prototype.createChild = function ()
{
  var pthis = this;
  var apppath = this.config.appDirectory + "/apps/" + this.app.name + "/server/app.js";
  //
  // Create the child process
  // If I'm installing, get ERRORS from child stderr stream
  var runErrors = [];
  if (this.installCallback) {
    this.child = Node.child.fork(apppath, [], {silent: true});     // Capture StdErr errors
    //
    this.child.stderr.on("data", function (err) {
      err += "";      // Convert error into string
      pthis.log("WARN", "Application error: " + err, "Worker.createChild");
      //
      // Store error in errors array
      runErrors.push(err);
    });
  }
  else
    this.child = Node.child.fork(apppath);
  //
  // Log child creation
  this.log("DEBUG", "Created app child", "Worker.createChild");
  //
  // Initialize app child
  this.child.send({type: Node.Worker.msgTypeMap.initApp, sender: "master",
    name: this.app.name, url: this.config.getUrl(), path: this.config.appDirectory + "/apps/" + this.app.name,
    publicUrl: this.config.getUrl() + "/" + this.app.name, online: true});
  //
  // Tell the app how to connect with the database
  var constring = "postgres://" + this.config.dbUser + ":" + this.config.dbPassword + "@" + this.config.dbAddress + ":" + this.config.dbPort;
  this.child.send({type: Node.Worker.msgTypeMap.connectionDB,
    username: (this.user.userName === "manager" ? undefined : this.user.userName), constring: constring});
  //
  // Listen for messages
  this.child.on("message", function (msg) {
    pthis.handleAppChildMessage(msg);
  });
  this.child.on("disconnect", function () {
    pthis.log("DEBUG", "Worker child disconnected", "Worker.createChild");
    //
    // Child has died. If I was installing the child crashed during install
    if (pthis.installCallback) {
      var err = (runErrors.length > 0 ? runErrors.join("\n") : "Unknown error");
      pthis.installCallback({err: "Installation failed: " + err});
      delete pthis.installCallback;
    }
    //
    // Now the child is dead
    delete pthis.child;
  });
};



/**
 * Handle app child messages (i.e. messages sent by app.js)
 * @param {object} msg
 */
Node.Worker.prototype.handleAppChildMessage = function (msg)
{
  var appsess;
  //
  switch (msg.type) {
    case Node.Worker.msgTypeMap.processRequest:
      // Send the message to the right app session
      appsess = this.server.appSessions[msg.sid];
      if (appsess)
        appsess.sendMessageToClientApp(msg);
      else
        this.log("WARN", "Can't process request: session not found", "Worker.handleAppChildMessage", msg);
      break;

    case Node.Worker.msgTypeMap.sessionParams:
      // Send the message to the right app session
      appsess = this.server.appSessions[msg.sid];
      if (appsess)
        appsess.handleSessionParams(msg.cnt);
      else
        this.log("WARN", "Can't handle session params message: session not found", "Worker.handleAppChildMessage", msg);
      break;

    case Node.Worker.msgTypeMap.deleteSession:
      appsess = this.server.appSessions[msg.sid];
      if (appsess)
        appsess.terminate();
      else
        this.log("WARN", "Can't delete session: session not found", "Worker.handleAppChildMessage", msg);
      break;

    case Node.Worker.msgTypeMap.sendRestResponse:
      appsess = this.server.appSessions[msg.sid];
      if (appsess) {
        this.log("DEBUG", "Send REST response", "Worker.handleAppChildMessage", msg);
        if (typeof msg.text === "object")
          msg.text = JSON.stringify(msg.text);
        appsess.restRes.status(msg.code || 500).end(msg.text + "");
      }
      else
        this.log("WARN", "Can't send REST response: session not found", "Worker.handleAppChildMessage", msg);
      break;

    case Node.Worker.msgTypeMap.sync:
      this.handleSync(msg);
      break;

    case Node.Worker.msgTypeMap.syncBroad:
      this.handleSyncBroad(msg);
      break;

    case Node.Worker.msgTypeMap.cloudConnectorMsg:
      this.handleCloudConnectorMsg(msg.cnt);
      break;

    case Node.Worker.msgTypeMap.createDB:
      this.handleCreateDBMsg(msg);
      break;

    case Node.Worker.msgTypeMap.installResult:
      if (this.installCallback) {
        this.installCallback(msg.cnt);      // Call callback attached at the beginning of the install method (see Worker::installApp)
        delete this.installCallback;
      }
      else
        this.log("WARN", "Can't handle install result message: no callback", "Worker.handleAppChildMessage", msg);
      break;

    default:
      this.log("WARN", "Unhandled message", "Worker.handleAppChildMessage", msg);
      break;
  }
};


/*
 * Process the sync message
 * @param {object} msg
 */
Node.Worker.prototype.handleSync = function (msg)
{
  var session = this.server.appSessions[msg.sid.sidsrv];
  if (!session)
    return this.log("WARN", "Can't handle SYNC message: session not found", "Worker.handleSync", msg);
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
  for (var i = 0; i < this.app.workers.length; i++) {
    var wrk = this.app.workers[i];
    //
    // Skip "dead" workers (i.e. workers with no child process)
    if (!wrk.child)
      continue;
    //
    wrk.child.send({type: Node.Worker.msgTypeMap.syncBroad, cnt: msg.cnt});
  }
};


/*
 * Process the cloud connector message
 * @param {object} msg
 */
Node.Worker.prototype.handleCloudConnectorMsg = function (msg)
{
  switch (msg.type) {
    case "remoteCmd":
      var conn = this.user.getCloudConnectorByName(msg.conn);
      if (conn)
        conn.socket.emit("cloudServerMsg", msg.data);
      else if (msg.data.cbid) {
        this.child.send({type: Node.Worker.msgTypeMap.cloudConnectorMsg,
          cnt: {type: "response", appid: msg.data.appid, cbid: msg.data.cbid,
            data: {error: "Remote connector not found"}}});
      }
      break;
  }
};


/*
 * Handles a create DB message
 * @param {object} msg
 */
Node.Worker.prototype.handleCreateDBMsg = function (msg)
{
  var pthis = this;
  //
  // Create the database for worker's user
  this.user.createDatabase(msg.dbname, function (result) {
    // Extract error message (if embedded)
    if (result && result.err)
      result = result.err;
    //
    // It's an error only if the error is not "the DB already exists"
    var err = (result !== "Database already exists" ? result : undefined);
    if (err)
      pthis.log("WARN", "Can't create database: " + err, "Worker.handleCreateDBMsg", {dbname: msg.dbname});
    //
    // Report to callee
    pthis.child.send({type: Node.Worker.msgTypeMap.createDBresult, dbname: msg.dbname, err: err});
  });
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
  var session = new Node.AppSession(this);
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
  var pthis = this;
  this.log("DEBUG", "Delete worker session", "Worker.deleteSession", {sid: session.id});
  //
  // Remove the session from my session list
  var idx = this.sessions.indexOf(session);
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
    pthis.log("DEBUG", "Worker is empty", "Worker.deleteSession");
    //
    this.killWorkerTimer = setTimeout(function () {
      pthis.log("DEBUG", "Worker is empty and timeout expired -> delete it", "Worker.deleteSession");
      pthis.app.deleteWorker(pthis);
    }, 5000);  // wait 5 sec
  }
};


/**
 * Delete the session
 * @param {object} options ({force, timeout, msg})
 */
Node.Worker.prototype.terminate = function (options)
{
  if (this.child)
    this.child.send({type: Node.Worker.msgTypeMap.terminate, options: options});
  else
    this.log("WARN", "Worker has no child: can't send TERMINATE", "Worker.terminate");
};



Node.Worker.prototype.sendToChild = function (msg)
{
  if (this.child)
    this.child.send(msg);
  else
    this.log("WARN", "Can't send message: worker's child is gone", "Worker.sendToChild", msg);
};


// Export module
module.exports = Node.Worker;
