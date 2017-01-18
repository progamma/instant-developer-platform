/*
 * Instant Developer Next
 * Copyright Pro Gamma Spa 2000-2016
 * All rights reserved
 */
/* global require, module */

var Node = Node || {};

// Import modules
Node.zlib = require("zlib");
Node.querystring = require("querystring");

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
  data.app = this.app.name;
  data.user = this.app.user.userName;
  data.sid = this.session.id;
  data.cid = this.id;
  //
  this.logger.log(level, message, sender, data);
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
  if (req.query.addsid !== undefined)
    qrys = "?" + Node.querystring.stringify({sid: this.session.id, cid: this.id});
  //
  // Redirect to the main page
  res.redirect("/" + this.app.name + "/" + this.config.getAppMainFile(req.query.mode) + qrys);
  //
  // Create a timer. If an openConnection does not arrive within 10 seconds,
  // the app client is deleted
  this.killClient = setTimeout(function () {
    pthis.log("DEBUG", "Client did not confirm its connection within 10 sec -> deleted", "AppClient.init");
    pthis.session.deleteAppClient(pthis);
  }, 10000);
};


/**
 * OpenConnection of the appclient
 * @param {socket} socket
 */
Node.AppClient.prototype.openConnection = function (socket)
{
  var pthis = this;
  //
  this.socket = socket;
  //
  // Stop killClient timer (see AppClient::init)
  if (this.killClient) {
    this.log("DEBUG", "This client was scheduled to die -> stop death", "AppClient.openConnection");
    //
    clearTimeout(this.killClient);
    delete this.killClient;
  }
  //
  // If the session has no client master, I'm the client master
  if (!this.session.masterAppClient) {
    this.log("DEBUG", "A new client is app master for session", "AppClient.openConnection");
    this.session.masterAppClient = this;
  }
  //
  // Listen for "appmsg" (sent by client app.js)
  socket.on("appmsg", function (msg) {
    // Route this message to the child
    pthis.session.sendToChild({type: Node.AppClient.msgTypeMap.appmsg, sid: msg.sid, cid: pthis.id,
      content: msg.events, master: (pthis.session.masterAppClient === pthis), request: pthis.session.request, cookies: pthis.session.cookies});
    //
    // Delete the content of the request after it has been sent
    delete pthis.session.request;
    delete pthis.session.cookies;
  });
  //
  // Listen for disconnect
  socket.on("disconnect", function () {
    // Log disconnection
    pthis.log("DEBUG", "Received disconnect from client socket", "AppClient.openConnection");
    //
    var testAuto = pthis.app.getTestById(pthis.session.testAutoId);
    if (testAuto)
      testAuto.onDisconnectClient();
    //
    // If the disconnected client was the session master, the session looses the master
    if (pthis.session.masterAppClient === pthis)
      delete this.masterAppClient;
    //
    // Ask my parent to delete me
    // Wait 1 minute (or more/less if app changed session parameter) before actually deleting this session
    // So that if the client has been disconnected and comes back I'm here waiting for him
    var sessTimeout = Math.max(3000, pthis.session.sessionTimeout) || 60000;    // Min: 3 sec for REFRESH handling
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
  this.socket.emit("appmsg", msg);
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
