/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
var Node = Node || {};
var InDe = InDe || {};

// Import modules
Node.fs = require("fs");
Node.path = require("path");
Node.cookie = require("cookie");

// Import classes
Node.Utils = require("./utils");
Node.IDEAppClient = require("./ideappclient");
Node.Archiver = require("./archiver");



/**
 * @class represent an Instan Developer session
 * @param {Node.Project} prj
 * @param {Object} options - options for the session
 */
Node.IDESession = function (prj, options)
{
  this.project = prj;
  this.options = options;
  //
  // List of client tokens (tele-collaboration)
  this.cTokens = [];
  //
  // New SessionID
  this.id = Node.Utils.generateUID36();
  //
  // Compute the "active" path
  // (tutorials are "redirected" to the proper tutorial path)
  this.path = Node.path.join(this.config.directory, this.project.user.userName, this.project.name);
  if (this.options.type === "tutorial")
    this.path = Node.path.join(this.path, "tutorials", this.options.recFolder);
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
  // (do it only for "ide-like" sessions, not for "working" sessions like "buildProject", "backupBranch", "restoreBranch",
  // "TWrestore", "teamworksCmd")
  if (this.options.type === "ide" || this.options.type === "tutorial")
    this.startAutoKillTimer(60000);
  //
  // promise list for send and wait
  this.promisesList = {};
};


/**
 * Decrypt devAgentOptions from base64 encrypted string.
 * Same algorithm as Child.decryptDevAgentOptions (child process).
 * @param {String} encrypted - base64 encoded AES-256-CBC encrypted JSON
 * @returns {Object|null} decrypted options or null on error
 * KEEP IN SYNC with Node.Child.decryptDevAgentOptions (ide/child.js)
 */
Node.IDESession.decryptDevAgentOptions = function (encrypted)
{
  if (!encrypted)
    return null;
  try {
    let crypto = require("crypto");
    let key = crypto.scryptSync("LzgllCM/6rulryr4WbDZwj+rU20TZLnhV1YRz6szf/nK1sH9ib/fE1oNf3ejQcKJ", "salt", 32);
    let buffer = Buffer.from(encrypted, "base64");
    let decipher = crypto.createDecipheriv("aes-256-cbc", key, buffer.subarray(0, 16));
    let decrypted = Buffer.concat([decipher.update(buffer.subarray(16)), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8"));
  }
  catch (e) {
    return null;
  }
};


Node.IDESession.msgTypeMap = {
  createChild: "cc",
  initChild: "ic",
  forwardToChild: "fc",
  terminateChild: "tc",
  sessionError: "seser",
  redirect: "redirect",
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
  copyPrjFile: "cpf",
  //
  createDB: "cdb",
  createDBresult: "cdbres",
  //
  cTokenOp: "ctop",
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
  deleteTutorialDBs: "dtdbs",
  //
  remoteQuery: "rq",
  remoteQueryResult: "rqres",
  //
  apiCommand:"apic",
  apiCommandResult:"apir",
  //
  saveDevAgentOptions: "sdao"
};


// Define usefull properties for this object
Object.defineProperties(Node.IDESession.prototype, {
  server: {
    get() {
      return this.project.server;
    }
  },
  childer: {
    get() {
      return this.server.childer;
    }
  },
  config: {
    get() {
      return this.server.config;
    }
  },
  logger: {
    get() {
      return this.server.logger;
    }
  }
});


/**
 * Waits for the IDE session to complete.
 * @returns {Promise} Promise that resolves on session completion
 */
Node.IDESession.prototype.waitCompleted = async function ()
{
  return await new Promise((resolve, reject) => this.sessionCompletedPromise = {resolve, reject});
};


/**
 * Log a new message
 * @param {String} level - message level (DEBUG, INFO, WARN, ERROR)
 * @param {String} message - text message
 * @param {String} sender - function that generated the message
 * @param {Object} data - optional data to log
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
  this.childer.send({
    type: Node.IDESession.msgTypeMap.createChild,
    id: this.id,
    uid: this.project.user.uid,
    gid: this.project.user.gid,
    path: this.path
  });
  //
  // Send an init message to the child process
  this.sendToChild({
    type: Node.IDESession.msgTypeMap.initChild,
    sid: this.id,
    path: this.path,
    options: this.options,
    project: this.project.saveProperties(),
    config: this.config.saveProperties(),
    devAgentOptions: this.project.user?.devAgentOptions
  });
  //
  this.log("DEBUG", "Created new child", "IDESession.createChild", {options: this.options});
};


/**
 * Send a message to the childer which will route it to the child process corresponding to this session
 * (i.e. the child with my same id)
 * @param {Object} msg - message to send
 */
Node.IDESession.prototype.sendToChild = function (msg)
{
  this.childer.send({
    id: this.id,
    type: Node.IDESession.msgTypeMap.forwardToChild,
    msg
  });
};


/**
 * Start an auto-kill timer that will kill this session if no one "confirm" it
 * @param {Number} timeout - (ms)
 * @param {Boolean} logStart - if true remember when the timer has been started
 */
Node.IDESession.prototype.startAutoKillTimer = function (timeout, logStart)
{
  // Stop kill timer if already started
  if (this.killSessionTimer)
    clearTimeout(this.killSessionTimer.timerID);
  //
  // Create a new timer that will fire after the given timeout
  let timerID = setTimeout(() => {
    this.log("DEBUG", "Auto-kill fired -> delete session", "IDESession.startAutoKillTimer", {timeout});
    this.closeAllConnections();
  }, timeout);
  //
  this.killSessionTimer = {timerID: timerID};
  if (logStart)
    this.killSessionTimer.start = new Date();
};


/**
 * Opens a new socket connection with this session (called by server)
 * @param {Socket} socket - socket that initiated the connection
 * @param {Object} msg - SID message received from the client
 */
Node.IDESession.prototype.openConnection = function (socket, msg)
{
  let ctoken = msg.ctoken;
  let reconnected;      // TRUE if this is a succesful reconnection
  //
  // Check if I can accept this message. If the client sent a CTOKEN
  if (ctoken) {
    // If the session has NO master -> that's not allowed
    // If the the session has a master but the CTOKEN is invalid -> that's not allowed
    if (!this.masterClientSod || !this.cTokens.includes(ctoken)) {
      this.log("WARN", "Session refuses to accept an invited client", "IDESession.openConnection",
              {ctoken, masterSOD: this.masterClientSod});
      socket.emit(Node.IDESession.msgTypeMap.sessionError, {type: "noPermission"});
      return;
    }
    //
    // The session is connected with a valid MASTER and the client sent a valid CTOKEN
    this.log("DEBUG", "Session has a Master and a valid CTOKEN was received", "IDESession.openConnection",
            {ctoken, masterSOD: this.masterClientSod});
    //
    // "Eat" the token from the list of valid tokens
    let id = this.cTokens.indexOf(ctoken);
    this.cTokens.splice(id, 1);
    //
    // Session has a master and a valid ctoken was received -> accept this connection
  }
  else {  // No ctoken received
    // If the SID is invalid
    if (this.invalidSID(socket)) {
      let exitUrl = this.config.saveProperties().exitUrl;
      this.log("WARN", `Invalid SID -> redirect to ${exitUrl}`, "IDESession.openConnection");
      socket.emit(Node.IDESession.msgTypeMap.redirect, exitUrl);
      return;
    }
    //
    // If this is a reconnect attempt (only for main socket, not for ctokens)
    if (socket.client.request._query.reconnect) {        // Reconnect attempt
      this.log("DEBUG", "Reconnect attempt", "IDESession.openConnection", {masterSOD: this.masterClientSod});
      //
      // It's a reconnect attempt. If this session is already owned by someone else
      if (this.masterClientSod) {
        // Detach this session from the "old" master
        let oldSocket = this.sockets[this.masterClientSod];
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
  let sod = Node.Utils.generateUID36();
  this.sockets[sod] = socket;
  //
  // Prepare profile data I'll send to the client
  let profile = {
    name: this.project.user.name,
    surname: this.project.user.surname,
    projectname: this.project.name,
    username: this.project.user.userName,
    language: this.project.user.idfdata?.language || "ITA",
    hasDevAgentKey: !!this.project.user?.devAgentOptions || !!this.config.devAgentApiKey,
    devAgentModel: null,
    devAgentEffort: null,
    devAgentSupportConsent: false,
    isOnboarding: this.config.serverType === "Instant Developer"
  };
  //
  // Decrypt devAgent options to extract model/effort/supportConsent/onboarding for the settings panel
  if (this.project.user?.devAgentOptions) {
    let opts = Node.IDESession.decryptDevAgentOptions(this.project.user.devAgentOptions);
    if (opts) {
      profile.devAgentModel = opts.model || null;
      profile.devAgentEffort = opts.effort || null;
      profile.devAgentSupportConsent = !!opts.supportConsent;
      if (opts.onboarding)
        profile.isOnboarding = true;
    }
  }
  //
  // If I've not a master client the incoming connection become my master SOD
  // (do this only for IDE or tutorial sessions)
  if (!this.masterClientSod && (this.options.type === "ide" || this.options.type === "tutorial")) {
    this.masterClientSod = sod;
    //
    // If the user has an image, use it for profile
    if (this.project.user.IID)
      profile.img = `/${this.project.user.userName}/picture`;
  }
  //
  // If not reconnected
  if (!reconnected) {
    // Send profile info to the incoming client
    socket.emit(Node.IDESession.msgTypeMap.profile, profile);
    //
    // Tell the child that a new client has arrived
    this.sendToChild({
      type: Node.IDESession.msgTypeMap.initNewClient,
      sod,
      cnt: {
        master: sod === this.masterClientSod
      }
    });
  }
  else   // Reconnect: inform the client that we've successfully reconnected
    this.sendToChild({
      type: Node.IDESession.msgTypeMap.reconnectedClient,
      sod
    });
  //
  // Listen to generalChannel messages
  socket.on(Node.IDESession.msgTypeMap.generalChannel, msg => {
    // If the message is for a device, send it to the device
    if (msg.type === Node.IDESession.msgTypeMap.ideToDev) {
      let dev = this.project.user.getDeviceByUuid(msg.devid);
      if (!dev)
        return this.log("WARN", "Can't send message to unknown device", "IDESession.openConnection", msg);
      //
      dev.sendCommand(msg.cnt);
    }
    else  // Not for a device -> send it to the child
      this.sendToChild({
        type: Node.IDESession.msgTypeMap.generalChannel,
        sod,
        cnt: msg
      });
  });
  //
  // Listen to disconnect event
  socket.on("disconnect", () => {
    this.log("DEBUG", "IDE socket disconnected", "IDESession.openConnection", msg);
    //
    // Close all apps started by this session
    // (do it backwards because the "close()" call will close the socket that will send
    // a synchronous message to session that will remove the client from the appClients array)
    for (let i = this.appClients.length - 1; i >= 0; i--)
      this.appClients[i].close();
    //
    // Tell the child that this socked has gone
    this.sendToChild({
      type: Node.IDESession.msgTypeMap.disconnectClient,
      sod
    });
    //
    // Remove the socket from the socket map
    delete this.sockets[sod];
    //
    // If the socket that has left was the MASTER one, close everything
    if (this.masterClientSod === sod) {
      // This session has no MASTER sod starting from now
      delete this.masterClientSod;
      //
      // Start the "kill-session" timer
      this.startAutoKillTimer(this.config.timerSession, true);
    }
    else if (ctoken)  // The disconnected socket was not the MASTER
      // Put the ctoken back in the list of "valid" tokens
      // (the client can come back until the MASTER is alive)
      this.cTokens.push(ctoken);
  });
};


/**
 * Protects the SID
 * Adds a cookie to the given request in order to protect my SID
 * @param {HTTPRequest} req
 * @param {HTTPResponse} res
 */
Node.IDESession.prototype.protectSID = function (req, res)
{
  // Add another HTTP-only cookie that will "protect" the SID/CID cookie
  let secure = !this.config.local && this.config.protocol === "https";
  this.secureSID = this.secureSID || Node.Utils.generateUID36();     // Update (ex: file upload on an existing session)
  res.cookie(`${this.id}_secureSID`, this.secureSID, {path: "/", httpOnly: true, secure});
  //
  // Remove old _secureSID cookies
  // (for every cookie there have to be a valid IDE/APP session...
  // if such session is not there the corresponding cookie is old and useles)
  let cookies = Node.cookie.parse(req.headers.cookie || "{}");
  Object.keys(cookies).forEach(key => {
    if (!key.endsWith("_secureSID"))
      return;
    //
    let sid = key.substring(0, key.length - "_secureSID".length);
    let session = (this.server.IDESessions[sid] || this.server.appSessions[sid]);
    if (!session) {
      this.log("DEBUG", `Remove OLD cookie ${key}`, "IDESession.protectSID");
      res.clearCookie(key);
    }
  });
};


/**
 * Checks if the SID is invalid (i.e. secureSID cookie is not the expected one)
 * @param {Socket} socket
 */
Node.IDESession.prototype.invalidSID = function (socket)
{
  let secureID = Node.cookie.parse(socket.request.headers.cookie || "{}")[`${this.id}_secureSID`];
  if (secureID !== this.secureSID) {
    this.log("WARN", "Secure SID does not match", "IDESession.invalidSID",
            {sid: this.id, expectedSecureSID: this.secureID, secureSID: secureID});
    return true;
  }
};


/**
 * New sync connection
 * @param {Socket} socket
 * @param {Object} msg
 */
Node.IDESession.prototype.openSyncConnection = function (socket, msg)
{
  this.syncSocket = socket;
  socket.on("disconnect", () => {
    delete this.syncSocket;
    this.sendToChild({
      type: "sync",
      sid: msg.sid,
      cnt: {
        id: "disconnect"
      }
    });
  });
};


/*
 * Closes all connections
 */
Node.IDESession.prototype.closeAllConnections = function ()
{
  // First, close all sockets
  let skey = Object.keys(this.sockets);
  for (let k = 0; k < skey.length; k++) {
    let sod = skey[k];
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
  this.sendToChild({
    type: Node.IDESession.msgTypeMap.terminateChild
  });
};


/**
 * Handle messages coming from the childer relative to this session
 * @param {Object} msg - message
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
      this.project.updateInfo(msg.info);
      break;

    case Node.IDESession.msgTypeMap.sessionCompleted:      // I've done my job
      // Close all connections for this session
      this.closeAllConnections();
      //
      this.log("DEBUG", "Session completed its job", "IDESession.processMessage");
      //
      // Tell the server that I've been terminated and he needs to forget about me
      this.server.closeSession(this);
      //
      // If this session had a promise, resolve the promise
      if (this.sessionCompletedPromise) {
        let {resolve, reject} = this.sessionCompletedPromise;
        delete this.sessionCompletedPromise;
        if (msg.result.err)
          reject(msg.result.err);
        else
          resolve(msg.result);
      }
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

    case Node.IDESession.msgTypeMap.cTokenOp:
      this.handleCTokenOpMsg(msg);
      break;

    case Node.IDESession.msgTypeMap.createDB:
      this.handleCreateDBMsg(msg);
      break;

    case Node.IDESession.msgTypeMap.sendRestResponse:
      this.handleSendResponseMsg(msg);
      break;

    case Node.IDESession.msgTypeMap.deviceMsg:
      this.handleDeviceMessage(msg);
      break;

    case Node.IDESession.msgTypeMap.cloudConnectorMsg:
      this.project.user.handleCloudConnectorMessage(msg.cnt, this);
      break;

    case Node.IDESession.msgTypeMap.sync:
      this.handleSyncMessage(msg);
      break;

    case Node.IDESession.msgTypeMap.deleteTutorialDBs:
      this.handleDeleteTutorialDBsMessage(msg.dbNames);
      break;

    case Node.IDESession.msgTypeMap.remoteQuery:
      this.handleRemoteQueryMessage(msg.options);
      break;

    case Node.IDESession.msgTypeMap.copyPrjFile:
      this.handleCopyPrjFile(msg.cnt);
      break;

    case Node.IDESession.msgTypeMap.apiCommandResult:
      this.handleApiCommandResult(msg);
      break;

    case Node.IDESession.msgTypeMap.saveDevAgentOptions:
      // Save encrypted devAgentOptions to user config (validate base64 payload)
      if (typeof msg.cnt === "string" && msg.cnt.length < 4096
          && /^[A-Za-z0-9+/=]+$/.test(msg.cnt)) {
        this.project.user.devAgentOptions = msg.cnt;
        this.config.saveConfig();
      }
      break;

    default:
      this.handleOtherMessages(msg);
      break;
  }
};


/**
 * Sends a message to an online app
 * @param {Object} msg
 */
Node.IDESession.prototype.sendMessageToClientApp = function (msg)
{
  for (let i = 0; i < this.appClients.length; i++) {
    let acli = this.appClients[i];
    //
    let send;
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
 * Sends a message to the IDE (browser) and wait for reply
 * @param {Object} cnt
 */
Node.IDESession.prototype.sendApiCommand = async function (command)
{
  let promiseId = Node.Utils.generateUID36();
  return await new Promise((resolve, reject) => {
    this.promisesList[promiseId] = {resolve, reject};
    this.sendToChild({
      type: Node.IDESession.msgTypeMap.apiCommand,
      promiseId,
      command
    });
  });
};


/**
 * Sends a message to the IDE (browser) and wait for reply
 * @param {Object} cnt
 */
Node.IDESession.prototype.handleApiCommandResult = function (message)
{
  let promise = this.promisesList[message.promiseId];
  delete this.promisesList[message.promiseId];
  if (message.error)
    promise?.reject(message.error)
  else
    promise?.resolve(message.result);
};


/**
 * Sends a message to an offline app
 * @param {Object} msg
 */
Node.IDESession.prototype.sendMessageToOffline = function (msg)
{
  // Locate the client app and send the message
  for (let i = 0; i < this.appClients.length; i++) {
    let acli = this.appClients[i];
    if (acli.id === msg.cid)
      return acli.sendOfflineMessage(msg.content);
  }
};


/**
 * Handles a CToken operation for this session
 * @param {Object} msg
 */
Node.IDESession.prototype.handleCTokenOpMsg = function (msg)
{
  let ctidx = this.cTokens.indexOf(msg.cnt.ctoken);
  if (msg.cnt.op === "add" && ctidx === -1)
    this.cTokens.push(msg.cnt.ctoken);  // Add the ctoken to the array (if not there already)
  else if (msg.cnt.op === "del" && ctidx !== -1)
    this.cTokens.splice(ctidx, 1);  // Add the ctoken to the array (if not there already)
};














/**
 * Handles a create DB message
 * @param {Object} msg
 */
Node.IDESession.prototype.handleCreateDBMsg = async function (msg)
{
  // Create the database for project's user
  let err;
  try {
    await this.project.user.createDatabase(msg.dbname);
  }
  catch (e) {
    // It's an error only if the error is not "the DB already exists"
    if (e.message !== "Database already exists") {
      this.log("WARN", `Can't create database: ${e}`, "IDESession.handleCreateDBMsg", {dbname: msg.dbname});
      err = e;
    }
  }
  // Report to callee
  this.sendToChild({
    type: Node.IDESession.msgTypeMap.createDBresult,
    dbname: msg.dbname,
    err
  });
};


/**
 * Handles a send response message
 * Supports both batch and streaming responses
 * @param {Object} msg - {code, text, options}
 */
Node.IDESession.prototype.handleSendResponseMsg = function (msg)
{
  if (!this.restRes)
    return this.log("WARN", "Can't send REST response: Response object not found (was this a REST request?)",
            "IDESession.handleSendResponseMsg", msg);
  //
  // STREAMING MODE - START
  if (msg.options.stream === "start") {
    try {
      // Prepare headers
      let headers = Object.assign({
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }, msg.options.headers || {});
      //
      // Start streaming
      this.restRes.writeHead(msg.code, headers);
    }
    catch (ex) {
      this.log("WARN", "Can't start streaming: " + ex, "IDESession.handleSendResponseMsg", msg);
    }
    return;
  }
  //
  // STREAMING MODE - CHUNK
  if (msg.options.stream === "chunk") {
    try {
      let chunk = msg.text;
      //
      // Handle buffer chunks
      if (msg.options.type === "buffer")
        chunk = Buffer.from(chunk, "base64");
      else if (typeof chunk !== "string")
        chunk = JSON.stringify(chunk);
      //
      this.restRes.write(chunk);
    }
    catch (ex) {
      this.log("WARN", "Can't send chunk: " + ex, "IDESession.handleSendResponseMsg", msg);
    }
    return;
  }
  //
  // STREAMING MODE - END
  if (msg.options.stream === "end") {
    try {
      this.restRes.end();
    }
    catch (ex) {
      this.log("WARN", "Can't end stream: " + ex, "IDESession.handleSendResponseMsg", msg);
    }
    //
    // Session termination will happen in child process (app.js) after sendResponse with stream:"end"
    // REST death timer will be automatically canceled during termination
    return;
  }
  //
  // BATCH MODE (existing code)
  //
  this.log("DEBUG", "Send REST response", "IDESession.handleSendResponseMsg", msg);
  //
  // Handle options, if any
  if (typeof msg.code === "string")
    msg.code = parseInt(msg.code);      // Change code to INT if needed
  if (!msg.code || msg.code < 100 || msg.code >= 600)
    msg.code = 500;              // Don't send an invalid value (server crashes!!!)
  //
  // Handle some default content-type
  if (!msg.options.contentType) {
    if (typeof msg.text === "string")
      msg.options.contentType = "text/plain; charset=utf-8";
    else if (!msg.options.type && msg.text && typeof msg.text === "object")
      msg.options.contentType = "application/json";
  }
  //
  // Handle content-type
  if (msg.options.contentType) {
    msg.options.headers = msg.options.headers || {};
    msg.options.headers["Content-Type"] = msg.options.contentType;
  }
  //
  try {
    // Send headers
    if (msg.options.headers && typeof msg.options.headers === "object") {
      Object.keys(msg.options.headers).forEach(header => {
        this.restRes.setHeader(header, msg.options.headers[header]);
      });
    }
    //
    // Send code
    this.restRes.status(msg.code);
    //
    // Send response
    if (msg.options.type === "buffer")
      this.restRes.end(Buffer.from(msg.text, "base64"));
    else if (msg.options.type === "file")
      this.restRes.sendFile(msg.text);
    else
      this.restRes.end(typeof msg.text !== "string" ? JSON.stringify(msg.text) : msg.text);
  }
  catch (ex) {
    this.log("WARN", `Can't send REST response: ${ex}`, "IDESession.handleSendResponseMsg", msg);
  }
};


/**
 * Handle a device message
 * @param {Object} msg
 */
Node.IDESession.prototype.handleDeviceMessage = function (msg)
{
  switch (msg.cnt.type) {
    case "deviceListRequest":   // Send DEVICE list to child process
      this.sendToChild({
        type: Node.IDESession.msgTypeMap.deviceMsg,
        cnt: {
          type: "deviceList",
          data: this.project.user.getUiDeviceList(this)
        }
      });
      break;
  }
};


/**
 * Handle a SYNC message
 * @param {Object} msg
 */
Node.IDESession.prototype.handleSyncMessage = function (msg)
{
  if (!this.syncSocket)
    return;
  //
  if (msg.cnt.id === "disconnect")
    this.syncSocket.disconnect();
  else
    this.syncSocket.emit("sync", msg);
};


/**
 * Handle other messages
 * @param {Object} msg
 */
Node.IDESession.prototype.handleOtherMessages = function (msg)
{
  let socket = this.sockets[msg.sod];
  if (!socket) {
    // Clean up General Channel message (it's too big to be logged!)
    if (msg.type === Node.IDESession.msgTypeMap.generalChannel && msg.cnt) {
      try {
        let msgContent = JSON.stringify(msg.cnt);
        if (msgContent.length > 1000) {
          msgContent = `${msgContent.slice(0, 1000)}...`;
          msg.cnt = {"PARTIAL MESSAGE": msgContent};
        }
      }
      catch {
        msg.cnt = {"ORIGINAL MESSAGE": "NOT SERIALIZABLE"};
      }
    }
    //
    return this.log("WARN", "Can't send message to unknown socket", "IDESession.handleOtherMessages", msg);
  }
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
  let appid = req.params?.appid.replace(/-/g, "/");
  //
  // Store the request/response objects so that the app can use them
  // (for instance, the app can answer to a REST request using the .restRes property and the app::sendResponse method)
  this.restReq = req;
  this.restRes = res;
  //
  this.sendToChild({
    type: Node.IDESession.msgTypeMap.appmsg2ide,
    appid,
    sid: this.id,
    request: this.request,
    cookies: this.cookies
  });
};


/**
 * Create a new app client (called by server's config)
 * @param {Node.Request} req
 * @param {Node.Response} res
 */
Node.IDESession.prototype.createAppClient = function (req, res)
{
  // Create a new app client
  let appClient = new Node.IDEAppClient(this);
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
    let febeMode;
    //
    let isOfflineFirstAppClient = this.appClients[0].mode === "offline";
    let isOfflineSecondAppClient = this.appClients[1].mode === "offline";
    //
    // If the appclients have opposing modes, I'm in febe mode
    if (isOfflineFirstAppClient !== isOfflineSecondAppClient)
      febeMode = true;
    //
    if (febeMode) {
      for (let i = 0; i < this.appClients.length; i++)
        this.sendToChild({
          type: Node.IDESession.msgTypeMap.febeMode,
          appid: this.appClients[i].appid,
          enabled: true
        });
    }
  }
};


/**
 * Delete an appClient
 * @param {AppClient} appClient
 */
Node.IDESession.prototype.deleteAppClient = function (appClient)
{
  // Delete the app client from the array
  let idx = this.appClients.indexOf(appClient);
  this.appClients.splice(idx, 1);
  //
  // If the master client is deleted then we send a message to the child to delete the Session or the Offline Proxy
  if (this.masterAppClient === appClient) {
    this.log("DEBUG", "Terminated MASTER client from session (2)", "IDESession.deleteAppClient");
    //
    this.sendToChild({
      type: Node.IDESession.msgTypeMap.deleteAppSession,
      sid: this.id,
      appid: appClient.appid
    });
    //
    // Now this session has no master app client
    delete this.masterAppClient;
  }
  else
    this.log("DEBUG", `Terminated SLAVE client ${idx} from session (2)`, "IDESession.deleteAppClient");
  //
  // Disable febe mode
  this.sendToChild({
    type: Node.IDESession.msgTypeMap.febeMode,
    appid: appClient.appid
  });
};


/**
 * Search an app client by its ID
 * @param {String} id
 */
Node.IDESession.prototype.getAppClientById = function (id)
{
  return this.appClients.find(acli => acli.id === id);
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
  this.deleteTutorialDBsTimeout = setTimeout(async () => {
    delete this.deleteTutorialDBsTimeout;
    for (let dbName of dbNames) {
      try {
        await this.project.user.deleteDatabase(dbName);
      }
      catch (e) {
        // Log error but continue with other databases
        this.log("WARN", `Error deleting database ${dbName}: ${e.message || e}`, "IDESession.handleDeleteTutorialDBsMessage");
      }
    }
  }, this.config.timerSession);
};


/**
 * Handles a remote query message
 * @param {Object} options
 */
Node.IDESession.prototype.handleRemoteQueryMessage = async function (options)
{
  // If the server is this one execute a "local" query on a "local" database
  let result, err;
  try {
    if (options.server === "localhost") {
      // Get the user
      let user = this.config.getUser(options.user || "manager");
      if (!user)
        throw new Error("User not found");
      //
      let db = user.getDatabase(options.database);
      if (!db)
        throw new Error("Database not found");
      //
      let params = {
        req: {
          query: {
            query: encodeURIComponent(options.sql)
          }
        }
      };
      //
      try {
        let response = await db.query(params);
        result = JSON.parse(response.msg);
      }
      catch (e) {
        err = e.message || e;
        throw e;
      }
      finally {
        this.log("DEBUG", "Local query executed", "IDESession.handleRemoteQueryMessage", {result, err});
      }
    }
    else
      result = await this.server.request.executeRemoteQuery(options);
  }
  catch (e) {
    err = e.message || e;
    this.log("WARN", e.message || e, "IDESession.handleRemoteQueryMessage", options);
  }
  //
  this.sendToChild({
    type: Node.IDESession.msgTypeMap.remoteQueryResult,
    sid: this.id,
    qryid: options.qryid,
    result,
    err
  });
};

/**
 * Handles a file copy between projects
 * @param {Object} options
 */
Node.IDESession.prototype.handleCopyPrjFile = function (options)
{
  this.log("DEBUG", "Copy project file", "IDESession.handleCopyPrjFile", options);
  //
  let src = Node.path.resolve(this.config.directory, options.src);
  let dst = Node.path.resolve(this.config.directory, options.dst);
  //
  // Path traversal validation
  if (!src.startsWith(this.config.directory) || !dst.startsWith(this.config.directory))
    return this.log("WARN", "Path traversal detected", "IDESession.handleCopyPrjFile", options);
  //
  Node.fs.copyFile(src, dst, err => {
    if (err)
      return this.log("WARN", `Can't copy file: ${err}`, "IDESession.handleCopyPrjFile", options);
  });
};

// Export module
module.exports = Node.IDESession;
