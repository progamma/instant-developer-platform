/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2025
 * All rights reserved
 */
var Node = Node || {};

// Import modules
Node.cookie = require("cookie");
Node.Utils = require("./utils");

/**
 * @class Node.Session
 * @classdesc
 * Base class for session management in the Instant Developer Cloud framework.
 * Provides common functionality shared between different session types (IDESession and AppSession).
 * This abstract class handles client connections, message routing, REST operations, and security.
 *
 * Key features:
 * - **Session Management**: Generates unique session IDs and manages session lifecycle
 * - **Client Connections**: Handles multiple app clients and tele-collaboration tokens
 * - **Message Routing**: Routes messages between clients and child processes
 * - **REST Support**: Manages REST requests/responses with streaming capabilities
 * - **Security**: Implements SID protection using secure cookies
 * - **Sync Connections**: Manages WebSocket sync connections for real-time communication
 *
 * @property {String} id - Unique session identifier (UID36 format)
 * @property {Array} cTokens - List of collaboration tokens for tele-collaboration
 * @property {Array} appClients - Array of connected app clients (Node.AppClient or Node.IDEAppClient instances)
 * @property {Socket} [syncSocket] - WebSocket for sync connections
 * @property {String} [syncSid] - Session ID for sync connection
 * @property {String} [secureSID] - Secure session ID for cookie protection
 * @property {Object} [restReq] - Current REST request object
 * @property {Object} [restRes] - Current REST response object
 */
Node.Session = class Session
{
  constructor()
  {
    // Generate unique session ID
    this.id = Node.Utils.generateUID36();
    //
    // List of client tokens (tele-collaboration)
    this.cTokens = [];
    //
    // Array of AppClients (clients connected with this session)
    this.appClients = [];
  }


  /**
   * Logs a message with session context.
   * Adds session ID to the log data and delegates to the log target.
   * @param {String} level - Log level (DEBUG, INFO, WARN, ERROR)
   * @param {String} message - Log message text
   * @param {String} sender - Function or module that generated the message
   * @param {Object} [data] - Optional additional data to include in the log
   */
  log(level, message, sender, data)
  {
    // Add session info
    data = {
      ...data,
      sid: this.id
    };
    //
    // Delegate to the log target (must be implemented in subclasses)
    this.getLogTarget().log(level, message, sender, data);
  }


  /**
   * Gets the log target object.
   * Abstract method that must be implemented by subclasses to return
   * the object responsible for handling log messages.
   * @returns {Object} The logging target object
   * @throws {Error} Throws error if not implemented by subclass
   */
  getLogTarget()
  {
    throw new Error("getLogTarget must be implemented by subclass");
  }


  /**
   * Handles connection token operations.
   * Manages collaboration tokens for tele-collaboration by adding or removing them from the session.
   * @param {Object} msg - Message containing token operation
   * @param {Object} msg.cnt - Connection token information
   * @param {String} msg.cnt.ctoken - The collaboration token
   * @param {String} msg.cnt.op - Operation type ('add' to add token, 'del' to remove token)
   */
  handleCTokenOpMsg(msg)
  {
    let ctidx = this.cTokens.indexOf(msg.cnt.ctoken);
    if (msg.cnt.op === "add" && ctidx === -1)
      this.cTokens.push(msg.cnt.ctoken);  // Add the ctoken to the array (if not there already)
    else if (msg.cnt.op === "del" && ctidx !== -1)
      this.cTokens.splice(ctidx, 1);  // Remove the ctoken from the array
  }


  /**
   * Gets an app client by its ID.
   * Searches the appClients array for a client with the specified ID.
   * @param {String} id - The client ID to search for
   * @returns {Node.AppClient|Node.IDEAppClient} The matching client instance or undefined if not found
   */
  getAppClientById(id)
  {
    return this.appClients.find(acli => acli.id === id);
  }


  /**
   * Sends a message to connected app clients.
   * Routes messages to appropriate clients based on CIDR (client ID routing) and CIDE (exclude sender) flags.
   * If no routing is specified, broadcasts to all connected clients.
   * @param {Object} msg - Message to send to clients
   * @param {String} [msg.cidr] - Client ID for routing (if present, controls message targeting)
   * @param {Boolean} [msg.cide] - Client ID exclude flag (if true with cidr, sends only to specified client; if false, sends to all except specified)
   */
  sendMessageToClientApp(msg)
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
      //
      if (send)
        acli.sendAppMessage(msg);
    }
  }


  /**
   * Opens a sync connection for real-time communication.
   * Establishes a WebSocket connection for synchronous data exchange and sets up disconnect handling.
   * @param {Socket} socket - The WebSocket socket instance
   * @param {Object} msg - Connection message containing session information
   * @param {String} msg.sid - Session ID for the sync connection
   */
  openSyncConnection(socket, msg)
  {
    this.syncSocket = socket;
    this.syncSid = msg.sid;
    socket.on("disconnect", () => {
      this.sendToChild({
        type: "sync",
        sid: this.getSyncDisconnectSid(),
        cnt: {
          id: "disconnect"
        }
      });
      delete this.syncSocket;
      delete this.syncSid;
    });
  }


  /**
   * Gets the session ID to use in sync disconnect messages.
   * Abstract method that must be implemented by subclasses to provide
   * the appropriate session ID format for disconnect notifications.
   * @returns {String} The session ID for sync disconnect
   * @throws {Error} Throws error if not implemented by subclass
   */
  getSyncDisconnectSid()
  {
    throw new Error("getSyncDisconnectSid must be implemented by subclass");
  }


  /**
   * Handles REST response messages.
   * Supports both batch and streaming response modes. Can send complete responses at once
   * or stream data in chunks for large or real-time data transfers.
   * @param {Object} msg - Response message configuration
   * @param {Number|String} msg.code - HTTP response status code (100-599)
   * @param {String|Object|Buffer} msg.text - Response body content
   * @param {Object} msg.options - Response options
   * @param {String} [msg.options.stream] - Streaming mode ('start', 'chunk', 'end')
   * @param {String} [msg.options.type] - Content type ('buffer', 'file', or default)
   * @param {String} [msg.options.contentType] - MIME content type
   * @param {Object} [msg.options.headers] - Additional HTTP headers
   */
  handleSendResponseMsg(msg)
  {
    if (!this.restRes)
      return this.log("WARN", "Can't send REST response: Response object not found (was this a REST request?)",
              "Session.handleSendResponseMsg", msg);
    //
    // A REST request must be answered exactly once: the reply could have been sent already
    // (i.e. the request timed out while the app was still working, see sendRESTTimeout)
    if (this.restRes.writableEnded)
      return this.log("WARN", "Can't send REST response: the reply has been sent already",
              "Session.handleSendResponseMsg", msg);
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
        //
        // Reset REST death timer - if streaming blocks, session will be cleaned after 60s
        this.scheduleRESTDeath();
      }
      catch (ex) {
        this.log("WARN", `Can't start streaming: ${ex}`, "Session.handleSendResponseMsg", msg);
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
        //
        // Reset REST death timer on every chunk - keeps session alive while chunks arrive
        this.scheduleRESTDeath();
      }
      catch (ex) {
        this.log("WARN", `Can't send chunk: ${ex}`, "Session.handleSendResponseMsg", msg);
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
        this.log("WARN", `Can't end stream: ${ex}`, "Session.handleSendResponseMsg", msg);
      }
      // Session termination will happen in child process (app.js) after sendResponse with stream:"end"
      // REST death timer will be automatically canceled during termination
      return;
    }
    //
    // BATCH MODE (existing code)
    this.log("DEBUG", "Send REST response", "Session.handleSendResponseMsg", msg);
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
      this.log("WARN", `Can't send REST response: ${ex}`, "Session.handleSendResponseMsg", msg);
    }
  }


  /**
   * Schedules automatic REST session termination.
   * Sets up a timer to clean up REST sessions that become inactive.
   * This method can be overridden by subclasses to implement custom timeout behavior.
   */
  scheduleRESTDeath()
  {
  }


  /**
   * Closes a timed out REST request with an explicit `504 Gateway Timeout`, so that the caller
   * gets an error instead of hanging forever on a request nobody is going to answer anymore.
   * Nothing is sent if the reply has been sent already or if there is no pending request at all
   * (i.e. the session was simply abandoned by the client): in that case there is only cleanup to do.
   * @param {Number} timeout - Timeout (in msec) that expired, reported to the caller
   */
  sendRESTTimeout(timeout)
  {
    // Nothing to answer -> nothing to do (the caller is not waiting for a reply)
    if (!this.restRes || this.restRes.writableEnded)
      return;
    //
    this.log("DEBUG", "REST request timed out -> send timeout response", "Session.sendRESTTimeout");
    //
    try {
      // If the response has been started already (streaming mode) status and headers are gone:
      // the only thing left to do is to close the stream so that the caller stops waiting
      if (this.restRes.headersSent)
        this.restRes.end();
      else
        this.restRes.status(504).send(`Request timed out after ${timeout / 1000} sec`);
    }
    catch (ex) {
      this.log("WARN", `Can't send REST timeout response: ${ex}`, "Session.sendRESTTimeout");
    }
  }


  /**
   * Protects the session ID with secure cookies.
   * Adds a secure cookie to validate session authenticity and removes obsolete cookies
   * from terminated sessions. Implements security measures including httpOnly and
   * SameSite attributes for HTTPS connections.
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  protectSID(req, res)
  {
    this.secureSID = this.secureSID || Node.Utils.generateUID36();     // Update (ex: file upload on an existing session)
    let cookieOpt = {
      path: "/",
      httpOnly: true
    };
    //
    // If I'm working "securely"
    let secure = (!this.config.local && this.config.protocol === "https");
    if (secure) {
      cookieOpt.secure = true;
      cookieOpt.sameSite = "none";  // Allow embedding the app in an IFRAME
      //
      // CHIPS (see #9045): keep the cookie working when the app is embedded third-party (browsers
      // phasing out unpartitioned 3rd-party cookies). Only embedded contexts need the attribute:
      // a partitioned cookie lives in a separate jar that clients built before the fix of #14800
      // cannot delete, so setting it on top-level requests too would leave the cookie alive for
      // its whole expiry on every app not rebuilt with a recent runtime (#14816).
      // The ADDSID flow keeps the attribute unconditionally: there the entry point is reached by the
      // client's fetchSID fetch() (Sec-Fetch-Dest: empty), which hides the real context — and the page
      // may be a client/index.html loaded directly inside a cross-site iframe, where an unpartitioned
      // SameSite=None cookie would be rejected and the secureSID validation would then fail. The
      // attribute is safe in the top-level case as well (the partition key is the site itself)
      if (Node.Utils.isEmbeddedRequest(req) || req.query.addsid !== undefined)
        cookieOpt.partitioned = true;
    }
    //
    res.cookie(`${this.id}_secureSID`, this.secureSID, cookieOpt);
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
        this.log("DEBUG", `Remove OLD cookie ${key}`, "Session.protectSID");
        res.clearCookie(key, cookieOpt);  // Reuse the same attributes so the clear matches the cookie in the browser jar
        //
        // The stale cookie may live in the OTHER jar too: partitioned and unpartitioned cookies
        // with the same name are distinct, and it may have been set by a request in the other
        // context (top-level vs embedded). On HTTPS clear both variants
        if (secure)
          res.clearCookie(key, {...cookieOpt, partitioned: !cookieOpt.partitioned});
      }
    });
  }


  /**
   * Validates the session ID security cookie.
   * Checks if the secure session ID cookie matches the expected value to prevent
   * session hijacking or unauthorized access attempts.
   * @param {Socket} socket - WebSocket socket instance with request headers
   * @returns {Boolean} True if the session ID is invalid, false if valid
   */
  invalidSID(socket)
  {
    let secureSID = Node.cookie.parse(socket.request.headers.cookie || "{}")[`${this.id}_secureSID`];
    if (secureSID !== this.secureSID) {
      this.log("WARN", "Secure SID does not match", "Session.invalidSID", {sid: this.id, expectedSecureSID: this.secureSID, secureSID});
      return true;
    }
  }


  /**
   * Sends a message to the child process.
   * Abstract method that must be implemented by subclasses to handle
   * communication with the session's associated child process.
   * @param {Object} msg - Message to send to the child process
   * @throws {Error} Throws error if not implemented by subclass
   */
  sendToChild(msg)
  {
    throw new Error("sendToChild must be implemented by subclass");
  }


  /**
   * Creates a new app client for this session.
   * Instantiates the appropriate client class, adds it to the session's client list,
   * and initializes it with the request/response context.
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   * @returns {Node.AppClient|Node.IDEAppClient} The newly created app client instance
   */
  createAppClient(req, res)
  {
    // Get the client class from subclass
    let clientClass = this.getAppClientClass();
    //
    // Create a new app client
    let appClient = new clientClass(this);
    //
    // Add to clients array
    this.appClients.push(appClient);
    //
    // Log client creation
    this.log("DEBUG", "Created a new app client", "Session.createAppClient", {cid: appClient.id});
    //
    // Initialize the new app client
    appClient.init(req, res);
    //
    // Hook for additional setup after client creation
    this.afterCreateAppClient(appClient);
    //
    return appClient;
  }


  /**
   * Gets the app client class to instantiate.
   * Abstract method that must be implemented by subclasses to specify
   * which client class (Node.AppClient or Node.IDEAppClient) to use.
   * @returns {Function} The constructor function for the app client class
   * @throws {Error} Throws error if not implemented by subclass
   */
  getAppClientClass()
  {
    throw new Error("getAppClientClass must be implemented by subclass");
  }


  /**
   * Hook method called after creating an app client.
   * Can be overridden by subclasses to perform additional setup or initialization
   * after a new client is created and added to the session.
   * @param {Node.AppClient|Node.IDEAppClient} appClient - The newly created app client instance
   */
  afterCreateAppClient(appClient)
  {
    // Default implementation does nothing
  }


  /**
   * Starts a REST session.
   * Stores the request and response objects for the session, enabling the application
   * to handle REST requests and send responses using the session's REST capabilities.
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */
  startRest(req, res)
  {
    // Store the request/response objects so that the app can use them
    // (for instance, the app can answer to a REST request using the .restRes property and the app::sendResponse method)
    this.restReq = req;
    this.restRes = res;
  }
};


// Export the class
module.exports = Node.Session;
