/*
 * Instant Developer Next
 * Copyright Pro Gamma Spa 2000-2016
 * All rights reserved
 */
/* global require, module */

var Node = Node || {};
var InDe = InDe || {};

// Import modules
Node.querystring = require("querystring");
Node.path = require("path");
Node.zlib = require("zlib");

// Import Classes
Node.Utils = require("./utils");


/**
 * @Class represent an Instan Developer AppClient
 * @param {Node.IDESession} par
 */
Node.IDEAppClient = function (par)
{
  this.parent = par;
  this.id = Node.Utils.generateUID24();
};


Node.IDEAppClient.msgTypeMap = {
  appmsg2ide: "a2i",
  offmsg2ide: "o2i"
};


// Define usefull properties for this object
Object.defineProperties(Node.IDEAppClient.prototype, {
  session: {
    get: function () {
      return this.parent;
    }
  },
  server: {
    get: function () {
      return this.session.server;
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
Node.IDEAppClient.prototype.log = function (level, message, sender, data)
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
Node.IDEAppClient.prototype.init = function (req, res)
{
  var pthis = this;
  //
  // Get the appid from the url (if given)
  this.appid = (req.params ? req.params.appid.replace(/-/g, "/") : undefined);
  this.mode = (req.query ? req.query.mode : undefined);
  //
  // Redirect to the main page
  var qrys = Node.querystring.stringify({sid: this.session.id, acid: this.id, appid: this.appid});
  res.redirect("/app/" + this.config.getAppMainFile(this.mode) + "?" + qrys);
  //
  // Create a timer. If an openConnection does not arrive within 20 seconds,
  // the app client is deleted
  this.killClient = setTimeout(function () {
    pthis.log("DEBUG", "Client did not confirm its connection within 20 sec -> deleted", "IDEAppClient.init");
    pthis.session.deleteAppClient(pthis);
  }, 20000);
};


/**
 * OpenConnection of the appclient
 * @param {socket} socket
 */
Node.IDEAppClient.prototype.openConnection = function (socket)
{
  var pthis = this;
  //
  this.socket = socket;
  //
  // Stop killClient timer (see IDEAppClient::init)
  if (this.killClient) {
    clearTimeout(this.killClient);
    delete this.killClient;
  }
  //
  // I the session has not an App master yet, I'm the app master
  if (!this.session.masterAppClient)
    this.session.masterAppClient = this;
  //
  // Listen for "appmsg" (sent by client app.js)
  socket.on("appmsg", function (msg) {
    // Route this message to the child
    pthis.session.sendToChild({type: Node.IDEAppClient.msgTypeMap.appmsg2ide, cid: pthis.id, appid: msg.appid,
      events: msg.events, request: pthis.session.request, cookies: pthis.session.cookies});
    //
    // Delete the content of the request after is sent
    delete pthis.session.request;
    delete pthis.session.cookies;
  });
  //
  // Listen for "offmsg" messages (sent by client app.js when the app is offline)
  socket.on("offmsg", function (msg) {
    // This is a message from an offline proxy app. Redirect to child
    pthis.session.sendToChild({type: Node.IDEAppClient.msgTypeMap.offmsg2ide, cid: pthis.id,
      appid: msg.appid, cnt: msg.content});
  });
  //
  // Listen for disconnect
  socket.on("disconnect", function () {
    // Log disconnection
    pthis.log("DEBUG", "Received disconnect from client socket (1)", "IDEAppClient.openConnection");
    //
    // Ask my parent to delete me
    pthis.session.deleteAppClient(pthis);
  });
};


/**
 * Send a message to the client counterpart (called by session)
 * @param {Object} msg
 */
Node.IDEAppClient.prototype.sendAppMessage = function (msg)
{
  if (!this.socket)
    return this.log("WARN", "Can't send message to app client (no socket)", "IDEAppClient.sendAppMessage", msg);
  //
  this.socket.emit("appmsg", msg);
};


/**
 * Send a message to the offline client counterpart (called by session)
 * @param {Object} msg
 */
Node.IDEAppClient.prototype.sendOfflineMessage = function (msg)
{
  if (!this.socket)
    return this.log("WARN", "Can't send message to offline app client (no socket)", "IDEAppClient.sendOfflineMessage", msg);
  //
  this.socket.emit("offmsg", msg);
};


/**
 * Close the app client socket
 */
Node.IDEAppClient.prototype.close = function ()
{
  if (this.socket)
    this.socket.disconnect();
};

// Export module
module.exports = Node.IDEAppClient;
