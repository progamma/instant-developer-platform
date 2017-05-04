/*
 * Instant Developer Next
 * Copyright Pro Gamma Spa 2000-2016
 * All rights reserved
 */
/* global require, module */

var Node = Node || {};
var InDe = InDe || {};

// Import modules
Node.fs = require("fs");
Node.path = require("path");
Node.rimraf = require("rimraf");

// Import classes
Node.Utils = require("./utils");
Node.IDEAppClient = require("./ideappclient");
Node.Archiver = require("./archiver");


/**
 * @Class represent an Instan Developer session
 * @param {Node.Project} prj
 * @param {obj} options - options for the session
 * @param {function} callback - called when session completed its job
 */
Node.IDESession = function (prj, options, callback)
{
  this.project = prj;
  this.options = options;
  this.sessionCompletedCB = callback;
  //
  // List of client tokens (tele-collaboration)
  this.cTokens = [];
  //
  // New SessionID
  this.id = Node.Utils.generateUID36();
  //
  // Compute the "active" path
  // (tutorials are "redirected" to the proper tutorial path)
  this.path = this.config.directory + "/" + this.project.user.userName + "/" + this.project.name;
  if (this.options.type === "tutorial")
    this.path += "/tutorials/" + this.options.recFolder;
  //
  // Map of sockets connected with this session (master and telecollaborators)
  this.sockets = {};
  //
  // Array of AppClients (clients connected with this session)
  this.appClients = [];
  //
  // Create a new child (remember: here (i.e. inside IDE) each session has one and only one child)
  this.createChild();
  //
  // The client have to "confirm" its initialization in 1 minute... otherwise this session is lost
  this.startAutoKillTimer(60000);
};


Node.IDESession.msgTypeMap = {
  createChild: "cc",
  initChild: "ic",
  forwardToChild: "fc",
  terminateChild: "tc",
  sessionError: "seser",
  //
  generalChannel: "gc",
  project: "prj",
  ideToDev: "itd",
  sync: "sync",
  processRequest: "pr",
  offlineMessage: "offmsg",
  prjSaved: "prjs",
  sessionCompleted: "sc",
  initNewClient: "inc",
  profile: "prf",
  reconnectedClient: "recon",
  //
  createDB: "cdb",
  createDBresult: "cdbres",
  //
  deviceMsg: "dm",
  cloudConnectorMsg: "ccm",
  //
  sendRestResponse: "rest",
  //
  disconnectClient: "dcli",
  closeClient: "ccli",
  //
  deleteAppSession: "das",
  appmsg2ide: "a2i",
  //
  febeMode: "fm",
  //
  deleteTutorialDBs: "dtdbs"
};


// Define usefull properties for this object
Object.defineProperties(Node.IDESession.prototype, {
  server: {
    get: function () {
      return this.project.server;
    }
  },
  childer: {
    get: function () {
      return this.server.childer;
    }
  },
  config: {
    get: function () {
      return this.server.config;
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
Node.IDESession.prototype.log = function (level, message, sender, data)
{
  // Add "local" info
  data = (data ? JSON.parse(JSON.stringify(data)) : {});
  data.sid = this.id;
  //
  this.project.log(level, message, sender, data);
};


/**
 * Create and initialize the child process associated with this session
 */
Node.IDESession.prototype.createChild = function ()
{
  // Send a message to the childer asking him to create a new child process corresponding to this session
  this.childer.send({type: Node.IDESession.msgTypeMap.createChild, id: this.id,
    uid: this.project.user.uid, gid: this.project.user.gid, path: this.path});
  //
  // Send an init message to the child process
  this.sendToChild({type: Node.IDESession.msgTypeMap.initChild, sid: this.id, path: this.path, options: this.options,
    project: this.project.saveProperties(), config: this.config.saveProperties()});
  //
  this.log("DEBUG", "Created new child", "IDESession.createChild", {options: this.options});
};


/*
 * Send a message to the childer which will route it to the child process corresponding to this session
 * (i.e. the child with my same id)
 * @param {object} msg - message to send
 */
Node.IDESession.prototype.sendToChild = function (msg)
{
  this.childer.send({id: this.id, type: Node.IDESession.msgTypeMap.forwardToChild, msg: msg});
};


/**
 * Start an auto-kill timer that will kill this session if no one "confirm" it
 * @param {int} timeout - (ms)
 * @param {boolean} logStart - if true remember when the timer has been started
 */
Node.IDESession.prototype.startAutoKillTimer = function (timeout, logStart)
{
  var pthis = this;
  //
  // Stop kill timer if already started
  if (this.killSessionTimer)
    clearTimeout(this.killSessionTimer.timerID);
  //
  // Create a new timer that will fire after the given timeout
  var timerID = setTimeout(function () {
    pthis.log("DEBUG", "Auto-kill fired -> delete session", "IDESession.startAutoKillTimer", {timeout: timeout});
    pthis.closeAllConnections();
  }, timeout);
  //
  this.killSessionTimer = {timerID: timerID};
  if (logStart)
    this.killSessionTimer.start = new Date();
};


/**
 * Opens a new socket connection with this session (called by server)
 * @param {socket} socket - socket that initiated the connection
 * @param {object} msg - SID message received from the client
 */
Node.IDESession.prototype.openConnection = function (socket, msg)
{
  var pthis = this;
  var ctoken = msg.ctoken;
  var reconnected;      // TRUE if this is a succesful reconnection
  //
  // Check if I can accept this message. If the client sent a CTOKEN
  if (ctoken) {
    // If the session has NO master -> that's not allowed
    // If the the session has a master but the CTOKEN is invalid -> that's not allowed
    if (!this.masterClientSod || this.cTokens.indexOf(ctoken) === -1) {
      this.log("WARN", "Session refuses to accept an invited client", "IDESession.openConnection",
              {ctoken: ctoken, masterSOD: this.masterClientSod});
      socket.emit(Node.IDESession.msgTypeMap.sessionError, {type: "noPermission"});
      return;
    }
    //
    // The session is connected with a valid MASTER and the client sent a valid CTOKEN
    this.log("DEBUG", "Session has a Master and a valid CTOKEN was received", "IDESession.openConnection",
            {ctoken: ctoken, masterSOD: this.masterClientSod});
    //
    // "Eat" the token from the list of valid tokens
    var id = this.cTokens.indexOf(ctoken);
    this.cTokens.splice(id, 1);
    //
    // Session has a master and a valid ctoken was received -> accept this connection
  }
  else {  // No ctoken received
    // If this is a reconnect attempt (only for main socket, not for ctokens)
    if (socket.client.request._query.reconnect) {        // Reconnect attempt
      this.log("DEBUG", "Reconnect attempt", "IDESession.openConnection", {masterSOD: this.masterClientSod});
      //
      // It's a reconnect attempt. If this session is already owned by someone else
      if (this.masterClientSod) {
        // Detach this session from the "old" master
        var oldSocket = this.sockets[this.masterClientSod];
        oldSocket.disconnect();
        //
        this.log("WARN", "This session was owned by another client -> take session ownership", "IDESession.openConnection",
                {oldSOD: this.masterClientSod, oldSocketStatus: (oldSocket ? "connected" : "disconnected")});
        //
        // Now this session has no master... the new incoming socket will be the new master
        delete this.masterClientSod;
      }
      //
      // This is an handled reconnection
      reconnected = true;
    }
    //
    // If this session has already a master -> that's not allowed
    if (this.masterClientSod) {
      this.log("WARN", "Session is busy", "IDESession.openConnection", {type: this.options.type});
      socket.emit(Node.IDESession.msgTypeMap.sessionError, {type: "busySession"});
      return;
    }
    //
    // Session has no master -> accept this connection
  }
  //
  // If a "kill-session" was scheduled, stop it
  if (this.killSessionTimer) {
    clearTimeout(this.killSessionTimer.timerID);
    delete this.killSessionTimer;
  }
  //
  // Create a new Socket ID and add this socket to the map
  var sod = Node.Utils.generateUID36();
  this.sockets[sod] = socket;
  //
  // Prepare profile data I'll send to the client
  var profile = {name: this.project.user.name, surname: this.project.user.surname,
    projectname: this.project.name, username: this.project.user.userName};
  //
  // If I've not a master client the incoming connection become my master SOD
  // (do this only for IDE or tutorial sessions)
  if (!this.masterClientSod && (this.options.type === "ide" || this.options.type === "tutorial")) {
    this.masterClientSod = sod;
    //
    // If the user has an image, use it for profile
    if (this.project.user.IID)
      profile.img = "/" + this.project.user.userName + "/picture" + (this.config.auth ? "?autk=" + this.config.autk : "");
  }
  //
  // If not reconnected
  if (!reconnected) {
    // Send profile info to the incoming client
    socket.emit(Node.IDESession.msgTypeMap.profile, profile);
    //
    // Tell the child that a new client has arrived
    this.sendToChild({type: Node.IDESession.msgTypeMap.initNewClient, sod: sod,
      cnt: {master: (sod === this.masterClientSod)}});
  }
  else   // Reconnect: inform the client that we've successfully reconnected
    this.sendToChild({type: Node.IDESession.msgTypeMap.reconnectedClient, sod: sod});
  //
  // Listen to generalChannel messages
  socket.on(Node.IDESession.msgTypeMap.generalChannel, function (msg) {
    // If the message is for a device, send it to the device
    if (msg.type === Node.IDESession.msgTypeMap.ideToDev) {
      var dev = pthis.project.user.getDeviceByUuid(msg.devid);
      if (!dev)
        return pthis.log("WARN", "Can't send message to unknown device", "IDESession.openConnection", msg);
      //
      dev.sendCommand(msg.cnt);
    }
    else  // Not for a device -> send it to the child
      pthis.sendToChild({type: Node.IDESession.msgTypeMap.generalChannel, sod: sod, cnt: msg});
  });
  //
  // Listen to disconnect event
  socket.on("disconnect", function () {
    // Close all apps started by this session
    // (do it backwards because the "close()" call will close the socket that will send
    // a synchronous message to session that will remove the client from the appClients array)
    for (var i = pthis.appClients.length - 1; i >= 0; i--)
      pthis.appClients[i].close();
    //
    // Tell the child that this socked has gone
    pthis.sendToChild({type: Node.IDESession.msgTypeMap.disconnectClient, sod: sod});
    //
    // Remove the socket from the socket map
    delete pthis.sockets[sod];
    //
    // If the socket that has left was the MASTER one, close everything
    if (pthis.masterClientSod === sod) {
      // This session has no MASTER sod starting from now
      delete pthis.masterClientSod;
      //
      // Start the "kill-session" timer
      pthis.startAutoKillTimer(pthis.config.timerSession, true);
    }
    else  // The disconnected socket was not the MASTER
      // Put the ctoken back in the list of "valid" tokens
      // (the client can come back until the MASTER is alive)
      pthis.cTokens.push(ctoken);
  });
};


/**
 * Adds a new CToken for this session
 * @param {string} ctoken
 */
Node.IDESession.prototype.addCToken = function (ctoken)
{
  // Add the ctoken to the array (if not there already)
  if (this.cTokens.indexOf(ctoken) === -1)
    this.cTokens.push(ctoken);
};


/**
 * New sync connection
 * @param {socket} socket
 * @param {Object} msg
 */
Node.IDESession.prototype.openSyncConnection = function (socket, msg)   // jshint ignore:line
{
  var pthis = this;
  //
  this.syncSocket = socket;
  socket.on("disconnect", function () {
    delete pthis.syncSocket;
    pthis.sendToChild({type: "sync", sid: msg.sid, cnt: {id: "disconnect"}});
  });
};


/*
 * Closes all connections
 */
Node.IDESession.prototype.closeAllConnections = function ()
{
  // First, close all sockets
  var skey = Object.keys(this.sockets);
  for (var k = 0; k < skey.length; k++) {
    var sod = skey[k];
    this.sockets[sod].disconnect();
  }
  //
  // Stop kill timer if started
  if (this.killSessionTimer) {
    clearTimeout(this.killSessionTimer.timerID);
    delete this.killSessionTimer;
  }
  //
  // Ask the child to gracefully terminate
  this.sendToChild({type: Node.IDESession.msgTypeMap.terminateChild});
};


/**
 * Handle messages coming from the childer relative to this session
 * @param {object} msg - message
 */
Node.IDESession.prototype.processMessage = function (msg)
{
  switch (msg.type) {
    case Node.IDESession.msgTypeMap.processRequest:    // Message to client app
      this.sendMessageToClientApp(msg);
      break;

    case Node.IDESession.msgTypeMap.offlineMessage:    // Message to offline app
      this.sendMessageToOffline(msg);
      break;

    case Node.IDESession.msgTypeMap.prjSaved:     // Project was saved in the child process -> update config's data
      this.project.updateInfo("save", msg);
      break;

    case Node.IDESession.msgTypeMap.sessionCompleted:      // I've done my job
      // If this session had a callback, call the callback
      if (this.sessionCompletedCB)
        this.sessionCompletedCB(msg.result);
      //
      // Close all connections for this session
      this.closeAllConnections();
      //
      this.log("DEBUG", "Session completed its job", "IDESession.processMessage");
      //
      // Tell the server that I've been terminated and he needs to forget about me
      this.server.closeSession(this);
      break;

    case Node.IDESession.msgTypeMap.closeClient:
      // If I've no SOD -> close all clients (happens when the client asked to close the document)
      if (!msg.sod)
        this.closeAllConnections();
      else if (this.sockets[msg.sod])
        this.sockets[msg.sod].disconnect();
      else
        this.log("WARN", "Can't close client connection (socket not found)", "IDESession.processMessage", msg);
      break;

    case Node.IDESession.msgTypeMap.createDB:
      this.handleCreateDBMsg(msg);
      break;

    case Node.IDESession.msgTypeMap.sendRestResponse:
      this.log("DEBUG", "Sending REST response", "IDESession.processMessage", msg);
      if (typeof msg.text === "object")
        msg.text = JSON.stringify(msg.text);
      this.restRes.status(msg.code || 500).end(msg.text + "");
      break;

    case Node.IDESession.msgTypeMap.deviceMsg:
      this.handleDeviceMessage(msg);
      break;

    case Node.IDESession.msgTypeMap.cloudConnectorMsg:
      this.handleCloudConnectorMessage(msg);
      break;

    case Node.IDESession.msgTypeMap.sync:
      this.handleSyncMessage(msg);
      break;

    case Node.IDESession.msgTypeMap.deleteTutorialDBs:
      this.handleDeleteTutorialDBsMessage(msg.dbNames);
      break;

    default:
      this.handleOtherMessages(msg);
      break;
  }
};


/**
 * Sends a message to an online app
 * @param {object} msg
 */
Node.IDESession.prototype.sendMessageToClientApp = function (msg)
{
  for (var i = 0; i < this.appClients.length; i++) {
    var acli = this.appClients[i];
    //
    var send;
    if (!msg.cidr)
      send = true;      // No CIDR -> send message to every app client
    else {
      // CIDR is there... check if I need to send the message to this client
      if (msg.cide)
        send = (acli.id === msg.cidr);    // If CIDE -> send the message only to the client that sent the message
      else
        send = (acli.id !== msg.cidr);    // If no CIDE -> send the message to all others but the one that sent the message
    }
    if (send)
      acli.sendAppMessage(msg);
  }
};


/**
 * Sends a message to an offline app
 * @param {object} msg
 */
Node.IDESession.prototype.sendMessageToOffline = function (msg)
{
  // Locate the client app and send the message
  for (var i = 0; i < this.appClients.length; i++) {
    var acli = this.appClients[i];
    if (acli.id === msg.cid)
      return acli.sendOfflineMessage(msg.content);
  }
};


/**
 * Handles a create DB message
 * @param {object} msg
 */
Node.IDESession.prototype.handleCreateDBMsg = function (msg)
{
  var pthis = this;
  //
  // Create the database for project's user
  this.project.user.createDatabase(msg.dbname, function (result) {
    // Extract error message (if embedded)
    if (result && result.err)
      result = result.err;
    //
    // It's an error only if the error is not "the DB already exists"
    var err = (result !== "Database already exists" ? result : undefined);
    if (err)
      pthis.log("WARN", "Can't create database: " + err, "IDESession.handleCreateDBMsg", {dbname: msg.dbname});
    //
    // Report to callee
    pthis.sendToChild({type: Node.IDESession.msgTypeMap.createDBresult, dbname: msg.dbname, err: err});
  });
};


/**
 * Handle a device message
 * @param {object} msg
 */
Node.IDESession.prototype.handleDeviceMessage = function (msg)
{
  switch (msg.cnt.type) {
    case "deviceListRequest":   // Send DEVICE list to child process
      this.sendToChild({type: Node.IDESession.msgTypeMap.deviceMsg,
        cnt: {type: "deviceList", data: this.project.user.getUiDeviceList(this)}});
      break;
  }
};


/**
 * Handle a Cloud Connector message
 * @param {object} msg
 */
Node.IDESession.prototype.handleCloudConnectorMessage = function (msg)
{
  switch (msg.cnt.type) {
    case "connectorListRequest":
      this.sendToChild({type: Node.IDESession.msgTypeMap.cloudConnectorMsg,
        cnt: {type: "connectorList", data: this.project.user.getUiCloudConnectorsList()}});
      break;

    case "remoteCmd":
      var conn = this.project.user.getCloudConnectorByName(msg.cnt.conn);
      if (conn) {
        msg.cnt.data.sid = this.id;
        conn.socket.emit("cloudServerMsg", msg.cnt.data);
      }
      else if (msg.cnt.data.cbid) {
        this.sendToChild({type: Node.IDESession.msgTypeMap.cloudConnectorMsg,
          cnt: {type: "response", appid: msg.cnt.data.appid, cbid: msg.cnt.data.cbid, dmid: msg.cnt.data.dmid,
            data: {error: "Remote connector not found"}}});
      }
      break;
  }
};


/**
 * Handle a SYNC message
 * @param {object} msg
 */
Node.IDESession.prototype.handleSyncMessage = function (msg)
{
  if (!this.syncSocket)
    return;
  //
  if (msg.cnt.id === "disconnect") {
    this.syncSocket.disconnect();
    delete this.syncSocket;
  }
  else
    this.syncSocket.emit("sync", msg);
};


/**
 * Handle other messages
 * @param {object} msg
 */
Node.IDESession.prototype.handleOtherMessages = function (msg)
{
  var socket = this.sockets[msg.sod];
  if (!socket)
    return this.log("WARN", "Can't send message to unknown socket", "IDESession.handleOtherMessages", msg);
  //
  socket.emit(msg.type, msg.cnt);
};


/**
 * Start a new REST session (called by server)
 * @param {Node.Request} req
 * @param {Node.Response} res
 */
Node.IDESession.prototype.startRest = function (req, res)
{
  var appid = (req.params ? req.params.appid : undefined);
  //
  // Store the request/response objects so that the app can use them
  // (for instance, the app can answer to a REST request using the .restRes property and the app::sendResponse method)
  this.restReq = req;
  this.restRes = res;
  //
  this.sendToChild({type: Node.IDESession.msgTypeMap.appmsg2ide, appid: appid, sid: this.id,
    request: this.request, cookies: this.cookies});
};


/**
 * Create a new app client (called by server's config)
 * @param {Node.Request} req
 * @param {Node.Response} res
 */
Node.IDESession.prototype.createAppClient = function (req, res)
{
  // Create a new app client
  var appClient = new Node.IDEAppClient(this);
  //
  // Add it to the app clients array
  this.appClients.push(appClient);
  //
  // Initialize the new app client
  appClient.init(req, res);
  //
  // If this session has exactly two appClients (having opposite modes)
  // send message to child containing offline app id, so that it can set
  // febe property on that app. This property is used by offline AApp
  // to know if need to preset serverUrl property for synchronization
  if (this.appClients.length === 2) {
    var febeMode;
    //
    var isOfflineFirstAppClient = this.appClients[0].mode === "offline";
    var isOfflineSecondAppClient = this.appClients[1].mode === "offline";
    //
    // If the appclients have opposing modes, I'm in febe mode
    if (isOfflineFirstAppClient !== isOfflineSecondAppClient)
      febeMode = true;
    //
    if (febeMode) {
      for (var i = 0; i < this.appClients.length; i++)
        this.sendToChild({type: Node.IDESession.msgTypeMap.febeMode, appid: this.appClients[i].appid, enabled: true});
    }
  }
};


/**
 * Delete an appClient
 * @param {appClient} appClient
 */
Node.IDESession.prototype.deleteAppClient = function (appClient)
{
  // Delete the app client from the array
  var idx = this.appClients.indexOf(appClient);
  this.appClients.splice(idx, 1);
  //
  // If the master client is deleted then we send a message to the child to delete the Session or the Offline Proxy
  if (this.masterAppClient === appClient) {
    this.log("DEBUG", "Terminated MASTER client from session (2)", "IDESession.deleteAppClient");
    //
    this.sendToChild({type: Node.IDESession.msgTypeMap.deleteAppSession, sid: this.id, appid: appClient.appid});
    //
    // Now this session has no master app client
    delete this.masterAppClient;
  }
  else
    this.log("DEBUG", "Terminated SLAVE client " + idx + " from session (2)", "IDESession.deleteAppClient");
  //
  // Disable febe mode
  this.sendToChild({type: Node.IDESession.msgTypeMap.febeMode, appid: appClient.appid});
};


/**
 * Search an app client by its ID
 * @param {string} id
 */
Node.IDESession.prototype.getAppClientById = function (id)
{
  for (var i = 0; i < this.appClients.length; i++) {
    var acli = this.appClients[i];
    if (acli.id === id)
      return acli;
  }
};


/**
 * Return the number of active sockets (i.e. number of connected clients)
 */
Node.IDESession.prototype.countClients = function ()
{
  return Object.keys(this.sockets).length;
};


/**
 * Send delete db command
 * @param {Array} dbNames
 */
Node.IDESession.prototype.handleDeleteTutorialDBsMessage = function (dbNames)
{
  this.deleteTutorialDBsTimeout = setTimeout(function () {
    for (var i = 0; i < dbNames.length; i++) {
      this.project.user.deleteDatabase(dbNames[i], function () {
        clearTimeout(this.deleteTutorialDBsTimeout);
        delete this.deleteTutorialDBsTimeout;
      }.bind(this));         // jshint ignore:line
    }
  }.bind(this), this.config.timerSession);
};


// Export module
module.exports = Node.IDESession;
