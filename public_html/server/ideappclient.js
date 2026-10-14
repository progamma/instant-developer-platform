/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
var Node = Node || {};

// Import modules
Node.querystring = require("querystring");

// Import Classes
Node.Utils = require("./utils");


/**
 * @class Node.IDEAppClient
 * @classdesc
 * Represents a client application instance connected to the Instant Developer IDE session.
 * Manages the WebSocket connection between the browser-based application and the IDE server,
 * handling message routing, offline capabilities, and session lifecycle.
 *
 * Key features:
 * - **WebSocket communication**: Manages real-time bidirectional communication with the client app
 * - **Message routing**: Routes messages between the browser app and the IDE child process
 * - **Offline support**: Handles messages from offline proxy applications
 * - **Session management**: Tracks app client lifecycle and automatic cleanup
 *
 * @property {Node.IDESession} parent - Reference to the parent IDE session
 * @property {String} id - Unique 24-character identifier for this app client
 * @property {String} appid - Application identifier from the URL
 * @property {String} mode - Application mode (e.g., debug, production)
 * @property {Socket} socket - WebSocket connection to the browser client
 * @property {Number} killClient - Timer ID for automatic cleanup if connection not confirmed
 */
Node.IDEAppClient = class IDEAppClient
{
  /**
   * Message type identifiers for communication between the app client and IDE.
   * @enum {String}
   */
  static msgTypeMap = {
    /** Application message sent from client to IDE */
    appmsg2ide: "a2i",
    /** Offline message sent from client to IDE */
    offmsg2ide: "o2i"
  };


  /**
   * @param {Node.IDESession} par - The parent IDE session that owns this app client
   */
  constructor(par)
  {
    this.parent = par;
    this.id = Node.Utils.generateUID24();
  }


  /**
   * Gets the parent IDE session.
   * @type {Node.IDESession}
   * @readonly
   */
  get session()
  {
    return this.parent;
  }


  /**
   * Gets the main server instance.
   * @type {Node.Server}
   * @readonly
   */
  get server()
  {
    return this.session.server;
  }


  /**
   * Gets the server configuration object.
   * @type {Node.Config}
   * @readonly
   */
  get config()
  {
    return this.server.config;
  }


  /**
   * Gets the server logger instance.
   * @type {Node.Logger}
   * @readonly
   */
  get logger()
  {
    return this.server.logger;
  }


  /**
   * Logs a message with client-specific context.
   * Adds the client ID to the log data before delegating to the session logger.
   * @param {String} level - Message severity level (DEBUG, INFO, WARN, ERROR)
   * @param {String} message - The log message text
   * @param {String} sender - The method name that generated the message
   * @param {Object} [data] - Additional data to include in the log
   */
  log(level, message, sender, data)
  {
    // Add "local" info
    data = {
      ...data,
      cid: this.id
    };
    //
    this.session.log(level, message, sender, data);
  }


  /**
   * Initializes the app client with the incoming HTTP request.
   * Redirects the client to the main application page and sets up an automatic cleanup timer.
   * @param {Request} req - The Express HTTP request object
   * @param {Response} res - The Express HTTP response object
   */
  init(req, res)
  {
    // Get the appid from the url (if given)
    this.appid = req.params?.appid.replace(/-/g, "/");
    this.mode = req.query?.mode;
    //
    // Redirect to the main page
    let qrys = Node.querystring.stringify({sid: this.session.id, acid: this.id, appid: this.appid});
    //
    // Propagate the UI theme indicator from the query string that the preview page has passed
    if (req.query?.uitheme)
      qrys += `&uitheme=${encodeURIComponent(req.query.uitheme)}`;
    //
    res.redirect(`/app/${this.config.getAppMainFile(this.mode)}?${qrys}`);
    //
    // Create a timer. If an openConnection does not arrive within 20 seconds,
    // the app client is deleted
    this.killClient = setTimeout(() => {
      this.log("DEBUG", "Client did not confirm its connection within 20 sec -> deleted", "IDEAppClient.init");
      this.session.deleteAppClient(this);
    }, 20000);
  }


  /**
   * Establishes the WebSocket connection with the browser client.
   * Sets up event listeners for app messages, offline messages, and disconnection.
   * Cancels the automatic cleanup timer and potentially promotes this client to master.
   * @param {Socket} socket - The Socket.io WebSocket connection
   */
  openConnection(socket)
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
    socket.on("appmsg", (msg, callback) => {
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
      //
      // Acknowledge receipt after forwarding, as in published apps. This is not an app commit.
      // Older clients do not provide a callback.
      callback?.();
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
  }


  /**
   * Sends a message to the connected browser application.
   * Used by the session to forward IDE messages to the client app.
   * @param {Object} msg - The message object to send to the client
   */
  sendAppMessage(msg)
  {
    if (!this.socket)
      return this.log("WARN", "Can't send message to app client (no socket)", "IDEAppClient.sendAppMessage", msg);
    //
    this.socket.emit("appmsg", msg);
  }


  /**
   * Sends a message to the offline proxy application.
   * Used by the session to forward messages when the app is in offline mode.
   * @param {Object} msg - The message object to send to the offline client
   */
  sendOfflineMessage(msg)
  {
    if (!this.socket)
      return this.log("WARN", "Can't send message to offline app client (no socket)", "IDEAppClient.sendOfflineMessage", msg);
    //
    this.socket.emit("offmsg", msg);
  }


  /**
   * Closes the WebSocket connection to the browser client.
   * Safely disconnects the socket if it exists.
   */
  close()
  {
    this.socket?.disconnect();
  }
};


// Export module
module.exports = Node.IDEAppClient;
