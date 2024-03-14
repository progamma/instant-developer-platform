/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
/* global require, module */

var Node = Node || {};

// Import modules
Node.zlib = require("zlib");
Node.querystring = require("querystring");
Node.url = require("url");

// Import Classes
Node.Utils = require("../utils");


/**
 * @Class represent an Instan Developer AppClient
 * @param {Node.AppSession} par
 */
Node.AppClient = function (par)
{
  this.parent = par;
  this.id = Node.Utils.generateUID24();
};


Node.AppClient.msgTypeMap = {
  redirect: "redirect",
  appmsg: "appmsg"
};


// Define usefull properties for this object
Object.defineProperties(Node.AppClient.prototype, {
  session: {
    get: function () {
      return this.parent;
    }
  },
  app: {
    get: function () {
      return this.session.app;
    }
  },
  config: {
    get: function () {
      return this.session.config;
    }
  },
  logger: {
    get: function () {
      return this.session.logger;
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
Node.AppClient.prototype.log = function (level, message, sender, data)
{
  // Add "local" info
  data = (data ? JSON.parse(JSON.stringify(data)) : {});
  data.cid = this.id;
  //
  this.session.log(level, message, sender, data);
};


/**
 * Initiaziazlise the AppClient
 * @param {request} req
 * @param {response} res
 */
Node.AppClient.prototype.init = function (req, res)
{
  var pthis = this;
  //
  // Save test auto id
  if (req.query.testid)
    this.session.testAutoId = req.query.testid;
  //
  // If requested, send SID and CID via query string
  var qrys = "";
  if (req.query.addsid !== undefined) {
    qrys = "?" + Node.querystring.stringify({sid: this.session.id, cid: this.id});
    //
    // Remember that a new client has been started "unsecured"
    this.startUnsecured = true;
  }
  //
  // If there was a query string, add it
  var qryKeys = JSON.parse(JSON.stringify(req.query));
  delete qryKeys.addsid;
  if (Object.keys(qryKeys).length)
    qrys += (qrys ? "&" : "?") + Node.querystring.stringify(qryKeys);
  //
  // If the app has been started in OFFLINE mode and the app CAN'T be started in offline mode
  let mode = req.query.mode;
  if (mode === "offline" && (!this.app.params || !this.app.params.allowOffline)) {
    this.log("WARN", "Requested OFFLINE mode but the app does not allow it (apps' allowOffline parameter must be true for the app to work in offline mode)", "AppClient.init");
    mode = undefined;
  }
  //
  // Redirect to the main app page
  var appPage = (this.app.params ? this.app.params.startPage : "") || this.config.getAppMainFile(mode);
  res.redirect("/" + this.app.name + "/" + appPage + qrys);
  //
  // Create a timer. If an openConnection does not arrive within 10 seconds,
  // the app client is deleted
  this.killClient = setTimeout(function () {
    pthis.log("DEBUG", "Client did not confirm its connection within 10 sec -> deleted", "AppClient.init");
    pthis.session.deleteAppClient(pthis, true);
  }, 10000);
};


/**
 * OpenConnection of the appclient
 * @param {socket} socket
 * @param {object} lastMsg - if it's a reconnect attemt this is the last message handled by client
 */
Node.AppClient.prototype.openConnection = function (socket, lastMsg)
{
  var pthis = this;
  //
  // If my ID is inside the cTokens array, my ID is a CTOKEN
  var ctoken = (this.session.cTokens.indexOf(this.id) !== -1 ? this.id : undefined);
  if (ctoken) { // I've been invited...
    // I've been invited: if this session has not a master -> that's not allowed
    if (!this.session.masterAppClient) {
      this.log("WARN", "Master, that invited me, is gone", "AppClient.openConnection", {ctoken: ctoken});
      socket.emit(Node.AppClient.msgTypeMap.redirect, this.config.saveProperties().exitUrl);
      return;
    }
    //
    // "Eat" the token from the list of valid tokens
    var id = this.session.cTokens.indexOf(ctoken);
    this.session.cTokens.splice(id, 1);
    //
    this.log("DEBUG", "A new client is SLAVE for session", "AppClient.openConnection");
  }
  else {  // I've not been invited
    // If the SID is invalid
    if (this.session.invalidSID(socket, this)) {
      var exitUrl = this.config.saveProperties().exitUrl;
      this.log("WARN", "Invalid SID -> redirect to " + exitUrl, "AppClient.openConnection");
      socket.emit(Node.AppClient.msgTypeMap.redirect, exitUrl);
      return;
    }
    //
    // I've not been invited: if this session has already a master (and it's not me) -> that's not allowed
    if (this.session.masterAppClient && this.session.masterAppClient !== this) {
      this.log("WARN", "Session is busy", "AppClient.openConnection");
      socket.emit(Node.AppClient.msgTypeMap.redirect, this.config.saveProperties().exitUrl);
      return;
    }
    //
    // Now I'm the client master
    this.log("DEBUG", "A new client is MASTER for session", "AppClient.openConnection");
    this.session.masterAppClient = this;
  }
  //
  this.socket = socket;
  //
  // Stop killClient timer (see AppClient::init)
  if (this.killClient) {
    clearTimeout(this.killClient);
    delete this.killClient;
  }
  //
  // Listen for "appmsg" (sent by client app.js)
  socket.on("appmsg", function (msg, callback) {
    // Update query string
    if (msg.appurl && pthis.session.request) {
      let query = Node.url.parse(msg.appurl).query;
      pthis.session.request.query = (query ? Node.querystring.parse(query) : undefined);
    }
    //
    // Route this message to the child
    pthis.session.sendToChild({type: Node.AppClient.msgTypeMap.appmsg, sid: msg.sid, cid: pthis.id,
      content: msg.events, master: (pthis.session.masterAppClient === pthis), request: pthis.session.request, cookies: pthis.session.cookies});
    //
    // During a test auto some requests may arrive before onStart (for example onPause/onResume...).
    // So I don't have to delete request and cookies until onStart message arrives
    var testAuto = pthis.app.getTestById(pthis.session.testAutoId);
    if (testAuto && !testAuto.onStartArrived)
      return;
    //
    // Delete the content of the request after it has been sent
//    delete pthis.session.request;
    delete pthis.session.cookies;
    //
    if (callback) // Old apps does not provide the callback
      callback(); // Message received
  });
  //
  // Listen for disconnect
  socket.on("disconnect", function () {
    // Log disconnection
    pthis.log("DEBUG", "Received disconnect from " +
            (pthis.session.masterAppClient === pthis ? "MASTER" : "SLAVE") + " client socket", "AppClient.openConnection");
    //
    // Socket is not connected anymore
    delete pthis.socket;
    //
    var testAuto = pthis.app.getTestById(pthis.session.testAutoId);
    if (testAuto)
      testAuto.onDisconnectClient();
    //
    // If the disconnected client was the session master, the session looses the master
    if (pthis.session.masterAppClient === pthis)
      delete pthis.session.masterAppClient;
    //
    // If the app is updating... die immediately (no wait for reconnect... I'm installing!!!)
    if (pthis.app.updating) {
      pthis.log("DEBUG", "App is updating -> delete session", "AppClient.openConnection");
      return pthis.session.deleteAppClient(pthis);
    }
    //
    // Ask my parent to delete me
    // Wait 15 seconds before actually deleting this session...
    // So that if the client has been disconnected and comes back I'm here waiting for him
    var sessTimeout = 15000; // 15 sec for REFRESH handling
    pthis.killClient = setTimeout(function () {
      pthis.log("DEBUG", "Client did not return within " + (sessTimeout / 1000) + " sec -> deleted", "AppClient.openConnection");
      pthis.session.deleteAppClient(pthis);
    }, sessTimeout);
  });
  //
  // Get test auto of this session and initialize it giving session, so that it can send recorded message to client in case of replay mode
  var testAuto = this.app.getTestById(this.session.testAutoId);
  if (testAuto)
    testAuto.init(this);
  //
  // If there are unsent messages, resynch with client
  if (lastMsg && this.sentMsgs) {
    // First search inside the unsent messages the last client message
    // If not found it means that we were in synch and I just need to send all messages
    let lastidx = Math.max(this.sentMsgs.findIndex(function (el) { return (JSON.stringify(el) === JSON.stringify(lastMsg)); }), 0);
    for (let i=lastidx; i<this.sentMsgs.length; i++) {
      let msg = this.sentMsgs[i];
      socket.emit("appmsg", msg, function() {
        let index = this.sentMsgs.indexOf(msg);
        if (index > -1) {
          this.sentMsgs.splice(index, 1);
          if (this.sentMsgs.length === 0)
            delete this.sentMsgs;
        }
      }.bind(this));
    }
  }
};


/**
 * Send a message to the client counterpart (called by session)
 * @param {Object} msg
 */
Node.AppClient.prototype.sendAppMessage = function (msg)
{
  if (!this.socket)
    return this.log("WARN", "Can't send message to app client (no socket)", "AppClient.sendAppMessage", msg);
  //
  // Remember the messages that have been sent to client
  this.sentMsgs = this.sentMsgs || [];
  this.sentMsgs.push(msg);
  //
  this.socket.emit("appmsg", msg, function() {
    // Client received the message -> remove from the sent messages list
    let index = this.sentMsgs.indexOf(msg);
    if (index > -1)
      this.sentMsgs.splice(index, 1);
  }.bind(this));
};



/**
 * Close the app client socket
 */
Node.AppClient.prototype.close = function ()
{
  if (this.socket)
    this.socket.disconnect();
};


// Export module
module.exports = Node.AppClient;
