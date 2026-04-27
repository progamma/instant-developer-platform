/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
var Node = Node || {};
var InDe = InDe || {};

// Import modules
Node.querystring = require("querystring");
Node.zlib = require("zlib");

// Import Classes
Node.Utils = require("./utils");


/**
 * @class represent an Instan Developer AppClient
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
 * @param {String} level - message level (DEBUG, INFO, WARN, ERROR)
 * @param {String} message - text message
 * @param {String} sender - function that generated the message
 * @param {Object} data - optional data to log
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
 * @param {Request} req
 * @param {Response} res
 */
Node.IDEAppClient.prototype.init = function (req, res)
{
  // Get the appid from the url (if given)
  this.appid = req.params?.appid.replace(/-/g, "/");
  this.mode = req.query?.mode;
  //
  // Get the dark theme indicator from the query string that the preview page has passed.
  let dark = req.query?.previewDark === "true" && req.query?.forceuitheme === "true";
  //
  // Redirect to the main page
  let qrys = Node.querystring.stringify({sid: this.session.id, acid: this.id, appid: this.appid});
  //
  // Add dark theme request if needed
  if (dark)
    qrys += "&previewDark=true";
  //
  res.redirect(`/app/${this.config.getAppMainFile(this.mode)}?${qrys}`);
  //
  // Create a timer. If an openConnection does not arrive within 20 seconds,
  // the app client is deleted
  this.killClient = setTimeout(() => {
    this.log("DEBUG", "Client did not confirm its connection within 20 sec -> deleted", "IDEAppClient.init");
    this.session.deleteAppClient(this);
  }, 20000);
};


/**
 * OpenConnection of the appclient
 * @param {Socket} socket
 */
Node.IDEAppClient.prototype.openConnection = function (socket)
{
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
  socket.on("appmsg", msg => {
    // Route this message to the child
    this.session.sendToChild({
      type: Node.IDEAppClient.msgTypeMap.appmsg2ide,
      cid: this.id,
      appid: msg.appid,
      events: msg.events,
      request: this.session.request,
      cookies: this.session.cookies
    });
    //
    // Delete the content of the request after is sent
    delete this.session.request;
    delete this.session.cookies;
  });
  //
  // Listen for "offmsg" messages (sent by client app.js when the app is offline)
  socket.on("offmsg", msg => {
    // This is a message from an offline proxy app. Redirect to child
    this.session.sendToChild({
      type: Node.IDEAppClient.msgTypeMap.offmsg2ide,
      cid: this.id,
      appid: msg.appid,
      cnt: msg.content
    });
  });
  //
  // Listen for disconnect
  socket.on("disconnect", () => {
    // Log disconnection
    this.log("DEBUG", "Received disconnect from client socket (1)", "IDEAppClient.openConnection");
    //
    // Ask my parent to delete me
    this.session.deleteAppClient(this);
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
  this.socket?.disconnect();
};

// Export module
module.exports = Node.IDEAppClient;
