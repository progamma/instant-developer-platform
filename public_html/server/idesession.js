/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
var Node = Node || {};

// Import modules
Node.fs = require("fs");
Node.path = require("path");
Node.cookie = require("cookie");

// Import classes
Node.Utils = require("./utils");
Node.IDEAppClient = require("./ideappclient");
Node.Session = require("./session");


/**
 * @class Node.IDESession
 * @classdesc
 * Manages an Instant Developer IDE session, handling the communication between the browser-based IDE
 * and the server-side child process. Each session represents an active IDE instance with its own
 * isolated environment, child process, and client connections.
 *
 * Key features:
 * - **Child process management**: Creates and manages dedicated child processes for code execution
 * - **Multi-client support**: Handles master and collaborative client connections via WebSocket
 * - **Message routing**: Routes messages between browser clients, child processes, and devices
 * - **Session lifecycle**: Manages session creation, reconnection, and automatic cleanup
 * - **Security**: Implements token-based access control for collaborative sessions
 *
 * @extends Node.Session
 * @property {Node.Project} project - The project associated with this session
 * @property {Object} options - Session configuration options (type, etc.)
 * @property {String} path - Active filesystem path for the session
 * @property {Object} sockets - Map of connected WebSocket clients indexed by socket ID
 * @property {String} masterClientSod - Socket ID of the master client connection
 * @property {Object} promisesList - Map of pending API command promises
 * @property {Object} killSessionTimer - Auto-cleanup timer for inactive sessions
 * @property {Object} sessionCompletedPromise - Promise resolved when session completes
 * @property {Object} _cachedProfile - Cached user profile data
 */
Node.IDESession = class IDESession extends Node.Session
{
  /**
   * Message type identifiers for communication between IDE session, child processes, and clients.
   * @enum {String}
   */
  static msgTypeMap = {
    /** Request to create a new child process */
    createChild: "cc",
    /** Initialize child process with session data */
    initChild: "ic",
    /** Forward a message to the child process */
    forwardToChild: "fc",
    /** Terminate the child process */
    terminateChild: "tc",
    /** Session error notification */
    sessionError: "seser",
    /** Redirect client to another URL */
    redirect: "redirect",
    /** General channel message */
    generalChannel: "gc",
    /** Project information message */
    project: "prj",
    /** Message from IDE to device */
    ideToDev: "itd",
    /** Synchronization message */
    sync: "sync",
    /** Process request from child to client */
    processRequest: "pr",
    /** Offline application message */
    offlineMessage: "offmsg",
    /** Project saved notification */
    prjSaved: "prjs",
    /** Session completion notification */
    sessionCompleted: "sc",
    /** Initialize new client connection */
    initNewClient: "inc",
    /** User profile information */
    profile: "prf",
    /** Client reconnection notification */
    reconnectedClient: "recon",
    /** Copy project file request */
    copyPrjFile: "cpf",
    /** Create database request */
    createDB: "cdb",
    /** Create database result */
    createDBresult: "cdbres",
    /** Collaboration token operation */
    cTokenOp: "ctop",
    /** Device message */
    deviceMsg: "dm",
    /** Cloud connector message */
    cloudConnectorMsg: "ccm",
    /** Send REST response */
    sendRestResponse: "rest",
    /** Disconnect client connection */
    disconnectClient: "dcli",
    /** Close client connection */
    closeClient: "ccli",
    /** Delete app session */
    deleteAppSession: "das",
    /** App message to IDE */
    appmsg2ide: "a2i",
    /** Frontend-Backend mode toggle */
    febeMode: "fm",
    /** Remote query request */
    remoteQuery: "rq",
    /** Remote query result */
    remoteQueryResult: "rqres",
    /** API command request */
    apiCommand: "apic",
    /** API command result */
    apiCommandResult: "apir",
    /** Production logs request (child → server: server holds the current autk) */
    productionLogs: "prdl",
    /** Production logs result */
    productionLogsResult: "prdlres",
    /** Console AI assistant chat request (child → server: server holds the current autk) */
    consoleChat: "ccht",
    /** Console AI assistant chat result */
    consoleChatResult: "cchtres",
    /** Save devAgent options */
    saveDevAgentOptions: "sdao",
    /** Save devAgent onboarding progress summary */
    saveOnboardingState: "sobs"
  };

  /**
   * Time (ms) the child has to complete the graceful termination handshake after
   * terminateChild before the session is forcibly closed (issue #14839).
   * Same threshold as the app workers' watchdog (Node.Worker.startWatchDog).
   * @type {Number}
   */
  static terminationWatchdogTimeout = 30000;


  /**
   * Decrypts devAgent options from base64 encrypted string.
   * Uses AES-256-CBC encryption with a fixed key for decryption.
   * Note: Must be kept in sync with Node.Child.decryptDevAgentOptions (ide/child.js).
   * @param {String} encrypted - Base64 encoded AES-256-CBC encrypted JSON string
   * @returns {Object|null} Decrypted options object or null if decryption fails
   */
  static decryptDevAgentOptions(encrypted)
  {
    return require("./devAgentOptionsStore").decrypt(encrypted);
  }


  /**
   * Who opened this session: "console" (IDC console via MCP), "test" (MCP test harness)
   * or "human" (a person's browser). Read from the /edit query string, so it is set on
   * EVERY opening path — headless, visible Chrome and human alike — and the MCP server can
   * refuse to drive a project someone else opened without inferring from its own state.
   * @param {Object} [openParams] - The session's openParams (the /edit query string)
   * @returns {String} "console" | "test" | "human"
   */
  static originOf(openParams)
  {
    return ["console", "test"].includes(openParams?.mcpOrigin) ? openParams.mcpOrigin : "human";
  }


  /**
   * @param {Node.Project} prj - The project to open in this session
   * @param {Object} options - Session configuration options
   */
  constructor(prj, options)
  {
    // Call base constructor
    super();
    //
    this.project = prj;
    this.options = options;
    this.origin = Node.IDESession.originOf(options?.openParams);
    //
    // Compute the "active" path
    this.path = Node.path.join(this.project.user.getProjectsDir(), this.project.name);
    //
    // Map of sockets connected with this session (master and telecollaborators)
    this.sockets = {};
    //
    // Create a new child (remember: here (i.e. inside IDE) each session has one and only one child)
    this.createChild();
    //
    // The client have to "confirm" its initialization in 1 minute... otherwise this session is lost
    // (do it only for "ide-like" sessions, not for "working" sessions like "buildProject", "backupBranch", "restoreBranch",
    // "TWrestore", "teamworksCmd")
    if (this.options.type === "ide")
      this.startAutoKillTimer(60000);
    //
    // Promise list for send and wait
    this.promisesList = {};
  }


  /**
   * Gets the main server instance.
   * @type {Node.Server}
   * @readonly
   */
  get server()
  {
    return this.project.server;
  }


  /**
   * Gets the childer process manager.
   * @type {Node.Childer}
   * @readonly
   */
  get childer()
  {
    return this.server.childer;
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
   * Waits for the IDE session to complete.
   * Creates a promise that will be resolved when the session receives a completion message.
   * @returns {Promise<Object>} Promise that resolves with the session result or rejects with an error
   */
  async waitCompleted()
  {
    return await new Promise((resolve, reject) => this.sessionCompletedPromise = {resolve, reject});
  }


  /**
   * Returns the log target for this session.
   * Implements abstract method from Node.Session base class.
   * @returns {Node.Project} The project associated with this session
   * @override
   */
  getLogTarget()
  {
    return this.project;
  }


  /**
   * Creates and initializes the child process associated with this session.
   * Sends messages to the childer to create a new child process with appropriate
   * user permissions and initializes it with session data.
   */
  createChild()
  {
    // Send a message to the childer asking him to create a new child process corresponding to this session.
    // openParams.version (validated by Project.editProject) selects the IDE version on multi-version
    // servers: the childer forks ides/ide_<version>/ide/child.js.
    this.childer.send({
      type: Node.IDESession.msgTypeMap.createChild,
      id: this.id,
      uid: this.project.user.uid,
      gid: this.project.user.gid,
      local: this.config.local,
      path: this.path,
      version: this.options.openParams?.version
    });
    //
    // Onboarding telemetry: ensure a prospect_id exists for guest visitors
    // (anonymous users that haven't registered yet). The id is generated lazily
    // here at child-init time — it lives in IDESession memory and travels in
    // options so the devAgent can include it in telemetry events. Cross-session
    // persistence (cookie) is a follow-up — for now each new IDE session
    // produces a fresh prospect_id for unauthenticated visitors.
    let optionsToSend = this.options;
    if (this.config.serverType === "personal" && this.project.user?.userType === "guest") {
      if (!this.prospectUuid)
        this.prospectUuid = Node.Utils.generateUID36();
      optionsToSend = Object.assign({}, this.options, {prospectUuid: this.prospectUuid});
    }
    //
    // Stamp the resolved IDE version into the config sent to the child, so that its
    // IDEver matches the version it was forked from instead of the master version.
    let config = this.config.saveProperties();
    if (this.options.openParams?.version)
      config.version = this.options.openParams.version;
    //
    // Send an init message to the child process
    this.sendToChild({
      type: Node.IDESession.msgTypeMap.initChild,
      sid: this.id,
      path: this.path,
      options: optionsToSend,
      project: this.project.saveProperties(),
      config,
      devAgentOptions: this.project.user?.devAgentOptions
    });
    //
    this.log("DEBUG", "Created new child", "IDESession.createChild", {options: optionsToSend});
  }


  /**
   * Sends a message to the child process through the childer.
   * The childer will route the message to the child process with matching session ID.
   * @param {Object} msg - The message object to send to the child process
   */
  sendToChild(msg)
  {
    this.childer.send({
      id: this.id,
      type: Node.IDESession.msgTypeMap.forwardToChild,
      msg
    });
  }


  /**
   * Starts an auto-kill timer that will terminate the session if not confirmed.
   * Used to clean up abandoned sessions after a specified timeout period.
   * @param {Number} timeout - Timeout duration in milliseconds
   * @param {Boolean} [logStart] - If true, stores the timer start time for logging
   */
  startAutoKillTimer(timeout, logStart)
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
    this.killSessionTimer = {timerID};
    if (logStart)
      this.killSessionTimer.start = new Date();
  }


  /**
   * Returns the user profile data for this session.
   * Uses caching to avoid expensive repeated decryption of devAgent options.
   * @returns {Object} Profile object containing user information and settings
   */
  getProfile()
  {
    // Return cached profile if available — but always refresh prospectUuid,
    // which can change between createChild (generated value) and openConnection
    // (cookie-resolved value) within the same session lifecycle.
    if (this._cachedProfile) {
      this._cachedProfile.prospectUuid = this.prospectUuid || null;
      return this._cachedProfile;
    }
    //
    // Read the catalog from the same IDE as the child; older IDEs have no Codex catalog.
    let ideDir = Node.Utils.resolveIdeDir(this.options.openParams?.version);
    let catalogPath = Node.path.join(ideDir, "agent", "CodexModels.js");
    let codexModels = Node.fs.existsSync(catalogPath) ? require(catalogPath).catalog : [];
    //
    // Build profile data
    let profile = {
      name: this.project.user.name,
      surname: this.project.user.surname,
      projectname: this.project.name,
      username: this.project.user.userName,
      language: this.project.user.idfdata?.language || "ITA",
      hasDevAgentKey: !!this.config.devAgentApiKey,    // any usable credential (personal OR server) — personal key folded in below
      hasPersonalDevAgentKey: false,                   // personal key only — the one SettingsWindow manages
      devAgentModel: null,
      devAgentCodexModels: codexModels.map(model => ({
        id: model.id,
        label: model.label
      })),
      devAgentEffort: null,
      devAgentSupportConsent: false,
      devAgentSupportConsentMode: null,  // "yes" | "ask" | "no" — tri-state consent (issue #14003)
      isOnboarding: this.config.serverType === "personal",
      onboardingState: this.project.user?.onboardingState || null,
      localIDE: !!this.config.local,
      prospectUuid: this.prospectUuid || null
    };
    //
    // Decrypt devAgent options (expensive operation - done once and cached)
    if (this.project.user?.devAgentOptions) {
      let opts = Node.IDESession.decryptDevAgentOptions(this.project.user.devAgentOptions);
      if (opts) {
        profile.devAgentProvider = opts.provider || "anthropic";
        profile.devAgentCodexModel = opts.codexModel || "gpt-6-astra";
        profile.devAgentModel = opts.provider === "codex" ? profile.devAgentCodexModel : opts.model || null;
        if (opts.provider === "codex") profile.hasDevAgentKey = !!opts.codexAuth;
        profile.devAgentEffort = opts.effort || null;
        profile.devAgentSupportConsent = !!opts.supportConsent;
        // Tri-state mode (issue #14003). Lazy migration: if no explicit mode is
        // stored but the legacy boolean is true, surface "yes" so existing users
        // keep their autonomous-ticket behavior; otherwise leave null and let
        // the SettingsWindow / request_support tool trigger the bootstrap.
        if (opts.supportConsentMode === "yes" || opts.supportConsentMode === "ask" || opts.supportConsentMode === "no")
          profile.devAgentSupportConsentMode = opts.supportConsentMode;
        else if (opts.supportConsent === true)
          profile.devAgentSupportConsentMode = "yes";
        profile.isOnboarding = this.config.serverType === "personal"
          ? !(opts.apiKey || opts.codexAuth)
          : !!opts.onboarding;
        // A personal key is present only when the decrypted blob actually carries
        // an `apiKey` — the blob also exists for model/effort/provider settings.
        if (opts.apiKey) {
          profile.hasPersonalDevAgentKey = true;
          if (opts.provider !== "codex") profile.hasDevAgentKey = true;
        }
      }
    }
    //
    // Cache the profile for future use
    this._cachedProfile = profile;
    return profile;
  }


  /**
   * Invalidates the cached profile data.
   * Should be called when user data or devAgent settings change to ensure
   * the next getProfile() call returns fresh data.
   */
  invalidateProfileCache()
  {
    delete this._cachedProfile;
  }


  /**
   * Opens a new WebSocket connection with this session.
   * Handles authentication, reconnection, and multi-client support with collaboration tokens.
   * Sets up event listeners for the socket and manages the session lifecycle.
   * @param {Socket} socket - The Socket.io socket that initiated the connection
   * @param {Object} msg - Initial message from the client containing session ID and optional tokens
   */
  openConnection(socket, msg)
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
        // Validate reconnect credentials
        let auth = socket.handshake.auth || {};
        if (!auth.reconnectToken || auth.reconnectToken !== this.project.reconnectToken) {
          this.log("WARN", "Reconnect attempt with invalid credentials", "IDESession.openConnection",
                  {hasToken: !!auth.reconnectToken});
          socket.emit(Node.IDESession.msgTypeMap.sessionError, {type: "noPermission"});
          return;
        }
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
    // Onboarding telemetry: prefer the `idePuid` HttpOnly cookie set by the
    // Express middleware (server.js) over the in-session UUID generated at
    // createChild time. The cookie persists across browser reloads, so the
    // funnel correlates events from the same physical visitor across sessions.
    // Falls through to the in-session value when the cookie is missing (e.g.
    // when serverType !== "personal" or when set-cookie was suppressed).
    if (this.config.serverType === "personal" && this.project.user?.userType === "guest") {
      let cookieHeader = socket.handshake?.headers?.cookie || socket.request?.headers?.cookie || "";
      let cookies = Node.cookie.parse(cookieHeader || "");
      if (cookies.idePuid)
        this.prospectUuid = cookies.idePuid;
      else if (!this.prospectUuid)
        this.prospectUuid = Node.Utils.generateUID36();
    }
    //
    // Get cached profile data (avoids repeated decryption)
    let profile = this.getProfile();
    //
    // If I've not a master client the incoming connection become my master SOD
    // (do this only for IDE sessions)
    if (!this.masterClientSod && this.options.type === "ide") {
      this.masterClientSod = sod;
      //
      // If the user has an image, add it to profile (only for master client)
      if (this.project.user.IID) {
        // Create a copy to avoid modifying cached profile
        profile = Object.assign({}, profile);
        profile.img = `/${this.project.user.userName}/picture`;
      }
    }
    //
    // If not reconnected
    if (!reconnected) {
      // Attach ephemeral TURN credentials for WebRTC calls (issue #12897) to a copy of the
      // profile, so the cached profile stays clean and each connection gets fresh credentials
      let iceServers = this.config.getIceServers();
      if (iceServers) {
        profile = Object.assign({}, profile);
        profile.iceServers = iceServers;
      }
      //
      // Send profile info to the incoming client
      socket.emit(Node.IDESession.msgTypeMap.profile, profile);
      //
      // Tell the child that a new client has arrived. Forward the resolved
      // prospect_uuid so the devAgent's getProspectId() picks up the cookie
      // value rather than the createChild-time fallback (which may differ).
      this.sendToChild({
        type: Node.IDESession.msgTypeMap.initNewClient,
        sod,
        cnt: {
          master: sod === this.masterClientSod,
          prospectUuid: this.prospectUuid || null
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
    socket.on("disconnect", (reason) => {
      // Capture socket.io's disconnect `reason` (e.g. "ping timeout", "transport close",
      // "server namespace disconnect"): when the MASTER socket drops, masterClientSod is
      // deleted below and the next save_project/close_project fails with "No browser client
      // connected". WARN for a master drop (it breaks the session), INFO otherwise. The old
      // DEBUG level was filtered out of the persisted log, so the reason was unrecoverable.
      let isMaster = this.masterClientSod === sod;
      this.log(isMaster ? "WARN" : "INFO", "IDE socket disconnected", "IDESession.openConnection", {...msg, reason, master: isMaster});
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
  }


  /**
   * Returns the session ID to use in sync disconnect messages.
   * Overrides base class to use IDE-specific session ID format.
   * @returns {String} The sync session ID
   * @override
   */
  getSyncDisconnectSid()
  {
    // IDESession uses the sid from the original sync message
    return this.syncSid;
  }


  /**
   * Closes all client connections and terminates the session.
   * Disconnects all sockets, clears timers, and requests child process termination.
   */
  closeAllConnections()
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
    // Clear any pending app runtime teardown timers (set by deleteAppClient): the session is closing,
    // so their callbacks must not fire sendToChild on an already-terminated child.
    if (this.appTeardownTimers) {
      for (let appid in this.appTeardownTimers)
        clearTimeout(this.appTeardownTimers[appid]);
      delete this.appTeardownTimers;
    }
    //
    // Ask the child to gracefully terminate
    this.sendToChild({
      type: Node.IDESession.msgTypeMap.terminateChild
    });
    //
    // Termination watchdog (issue #14839): the closing handshake is entirely pull —
    // terminateChild → child's sessionCompleted → closeSession → child.disconnect().
    // A child stuck in a busy-loop or on a hung await never sends sessionCompleted,
    // and without this timer the worker (and the claude CLI it spawned) survive forever.
    if (!this.terminationWatchdog && !this.sessionCompletedReceived) {
      this.terminationWatchdog = setTimeout(() => {
        delete this.terminationWatchdog;
        this.log("WARN", "Child did not confirm termination in time -> force close", "IDESession.closeAllConnections");
        //
        // Callers awaiting the session outcome must not hang forever with it
        if (this.sessionCompletedPromise) {
          let {reject} = this.sessionCompletedPromise;
          delete this.sessionCompletedPromise;
          reject(new Error("IDE session forcibly closed (termination watchdog)"));
        }
        //
        // Force: the childer disconnects the child and, if it does not exit within the
        // grace period, SIGKILLs it together with its descendant processes
        this.server.closeSession(this, true);
      }, Node.IDESession.terminationWatchdogTimeout);
    }
  }


  /**
   * Processes messages coming from the child process through the childer.
   * Routes messages to appropriate handlers based on message type.
   * @param {Object} msg - The message object containing type and content
   */
  processMessage(msg)
  {
    switch (msg.type) {
      case Node.IDESession.msgTypeMap.processRequest:    // Message to client app
        this.sendMessageToClientApp(msg);
        break;

      case Node.IDESession.msgTypeMap.offlineMessage:    // Message to offline app
        this.sendMessageToOffline(msg);
        break;

      case Node.IDESession.msgTypeMap.prjSaved:     // Project was saved in the child process -> update config's data
        // Children older than 26.3 don't declare the version they saved with: stamp the version this
        // session was opened with, so lastSaveVersion tracks the saving version for every child.
        // Only on a real save: a keys message (lastSaveID set) also arrives when the client merely
        // caches the loaded document into the browser FS at open time, where nothing was written
        // server-side — stamping there would pin the project to the opening version just for having
        // looked at it. A real save is recognizable because the child's saveDocument invalidates the
        // keys first (lastSaveID null), so only the keys that follow an invalidation get the stamp
        if (msg.info.lastSaveID === null)
          this.prjSaveStarted = true;
        else if (msg.info.lastSaveID && !msg.info.lastSaveVersion && this.prjSaveStarted) {
          let sessionVersion = this.options.openParams?.version || this.config.getHighestIdeVersion();
          if (sessionVersion)
            msg.info.lastSaveVersion = sessionVersion;
        }
        if (msg.info.lastSaveID)
          delete this.prjSaveStarted;
        this.project.updateInfo(msg.info);
        break;

      case Node.IDESession.msgTypeMap.sessionCompleted:      // I've done my job
        // The child confirmed its termination — disarm the force-close watchdog and
        // remember the confirmation, so the closeAllConnections below can't re-arm it
        this.sessionCompletedReceived = true;
        this.config._codexCredentials?.detach(this);
        if (this.terminationWatchdog) {
          clearTimeout(this.terminationWatchdog);
          delete this.terminationWatchdog;
        }
        //
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

      case "setAppGrace":   // OIDC redirect login (preview): extend/restore the app runtime teardown grace
        this.oidcGraceMs = msg.cnt.killClientGrace || undefined;
        break;

      case "cancelAppTeardown":   // explicit relaunch: drop the pending teardown grace so the fresh runtime isn't killed
        if (this.appTeardownTimers && this.appTeardownTimers[msg.appid]) {
          clearTimeout(this.appTeardownTimers[msg.appid]);
          delete this.appTeardownTimers[msg.appid];
        }
        break;

      case Node.IDESession.msgTypeMap.remoteQuery:
        this.handleRemoteQueryMessage(msg.options);
        break;

      case Node.IDESession.msgTypeMap.productionLogs:
        this.handleProductionLogsMessage(msg);
        break;

      case Node.IDESession.msgTypeMap.consoleChat:
        this.handleConsoleChatMessage(msg);
        break;

      case Node.IDESession.msgTypeMap.copyPrjFile:
        this.handleCopyPrjFile(msg);
        break;

      case Node.IDESession.msgTypeMap.apiCommandResult:
        this.handleApiCommandResult(msg);
        break;

      case "codex_request":
        if (!this.config._codexCredentials)
          this.config._codexCredentials = new (require("./codexCredentials").CodexCredentials)(this.config);
        this.config._codexCredentials.handle(this, msg).then(
          result => this.sendToChild({type: "codex_response", id: msg.id, result}),
          error => this.sendToChild({type: "codex_response", id: msg.id, error: error.message})
        );
        break;

      case Node.IDESession.msgTypeMap.saveDevAgentOptions:
        // Save encrypted devAgentOptions to user config (validate base64 payload).
        // 32 KB is enough for API keys, models, effort and a GCP service account JSON (~2-3 KB) with headroom.
        // The previous 4 KB limit silently rejected payloads carrying service account credentials
        if (typeof msg.cnt === "string" && msg.cnt.length < 32768
            && /^[A-Za-z0-9+/=]+$/.test(msg.cnt)) {
          let store = require("./devAgentOptionsStore");
          let incoming = store.decrypt(msg.cnt);
          if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) break;
          let current = store.decrypt(this.project.user.devAgentOptions) || {};
          this.project.user.devAgentOptions = store.encrypt(store.merge(current, incoming,
            Array.isArray(msg.patchKeys) ? msg.patchKeys.filter(k => typeof k === "string") : undefined));
          this.config.saveConfig().catch(err => console.log(`[IDESession] saveDevAgentOptions: saveConfig failed: ${err?.message}`));
          //
          // Invalidate profile cache since devAgentOptions changed
          this.invalidateProfileCache();
          //
          // Push the refreshed profile to the master client so InDe.theApp.devAgent*
          // caches reflect the new options immediately (no need to reconnect to see
          // the new model/effort/supportConsentMode in the Settings window).
          if (this.masterClientSod && this.sockets[this.masterClientSod]) {
            try {
              let updatedProfile = this.getProfile();
              this.sockets[this.masterClientSod].emit(Node.IDESession.msgTypeMap.profile, updatedProfile);
            }
            catch (e) {
              console.log(`[IDESession] saveDevAgentOptions: profile push failed: ${e?.message}`);
            }
          }
        }
        else {
          // Include typeof so a malformed payload (number/bool/object) doesn't coerce silently in the log
          let cntType = typeof msg.cnt;
          let cntLen = (cntType === "string") ? msg.cnt.length : "n/a";
          let regexOk = (cntType === "string") ? /^[A-Za-z0-9+/=]+$/.test(msg.cnt) : false;
          console.log(`[IDESession] saveDevAgentOptions: payload rejected by validator (typeof=${cntType}, length=${cntLen}, regexOk=${regexOk})`);
        }
        break;

      case Node.IDESession.msgTypeMap.saveOnboardingState:
        // Persist the devAgent onboarding progress summary on the user's config record.
        // Payload is a small JSON string ({examplesActivated, a2Completed, connectorConfigured,
        // lastSessionAt}). The child has only a data copy of the config — only the master
        // owns the live Node.Config, so the write + saveConfig happen here.
        if (typeof msg.cnt === "string" && msg.cnt.length < 4096) {
          try {
            this.project.user.onboardingState = JSON.parse(msg.cnt);
            this.config.saveConfig().catch(err => console.log(`[IDESession] saveOnboardingState: saveConfig failed: ${err?.message}`));
          }
          catch (e) {
            console.log(`[IDESession] saveOnboardingState: invalid JSON payload: ${e.message}`);
          }
        }
        else
          console.log(`[IDESession] saveOnboardingState: payload rejected (typeof=${typeof msg.cnt})`);
        break;

      default:
        this.handleOtherMessages(msg);
        break;
    }
  }


  /**
   * Sends an API command to the IDE child process and waits for a response.
   * Uses promises to implement synchronous request-response communication.
   * @param {Object} command - The API command to send
   * @returns {Promise<Object>} Promise that resolves with the command result or rejects with an error
   */
  async sendApiCommand(command)
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
  }


  /**
   * Handles the result of an API command sent to the child process.
   * Resolves or rejects the corresponding promise based on the result.
   * @param {Object} message - The message containing promiseId and result or error
   */
  handleApiCommandResult(message)
  {
    let promise = this.promisesList[message.promiseId];
    delete this.promisesList[message.promiseId];
    if (message.error)
      promise?.reject(message.error)
    else
      promise?.resolve(message.result);
  }


  /**
   * Sends a message to an offline application client.
   * Finds the appropriate app client by ID and forwards the offline message.
   * @param {Object} msg - Message containing client ID and content
   */
  sendMessageToOffline(msg)
  {
    // Locate the client app and send the message
    for (let i = 0; i < this.appClients.length; i++) {
      let acli = this.appClients[i];
      if (acli.id === msg.cid)
        return acli.sendOfflineMessage(msg.content);
    }
  }


  /**
   * Handles a database creation request from the child process.
   * Creates the database for the project's user and reports the result.
   * @param {Object} msg - Message containing the database name
   */
  async handleCreateDBMsg(msg)
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
  }


  /**
   * Handles device-related messages from the child process.
   * Responds to device list requests with the user's device information.
   * @param {Object} msg - Message containing the device operation type
   */
  handleDeviceMessage(msg)
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
  }


  /**
   * Handles synchronization messages between the IDE and sync server.
   * Forwards sync messages to the sync socket or handles disconnect requests.
   * @param {Object} msg - Message containing sync operation data
   */
  handleSyncMessage(msg)
  {
    if (!this.syncSocket)
      return;
    //
    if (msg.cnt.id === "disconnect")
      this.syncSocket.disconnect();
    else
      this.syncSocket.emit("sync", msg);
  }


  /**
   * Handles miscellaneous messages by forwarding them to the appropriate socket.
   * Includes special handling for large General Channel messages to prevent logging issues.
   * @param {Object} msg - Message containing socket ID and content to forward
   */
  handleOtherMessages(msg)
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
  }


  /**
   * Starts a new REST session for handling HTTP requests.
   * Overrides base class to handle IDE-specific app ID processing and routing.
   * @param {Request} req - Express HTTP request object
   * @param {Response} res - Express HTTP response object
   * @override
   */
  startRest(req, res)
  {
    // Call base implementation to store req/res
    super.startRest(req, res);
    //
    // IDE-specific: send message to child with appid
    let appid = req.params?.appid.replace(/-/g, "/");
    this.sendToChild({
      type: Node.IDESession.msgTypeMap.appmsg2ide,
      appid,
      sid: this.id,
      request: this.request,
      cookies: this.cookies
    });
  }


  /**
   * Returns the app client class to use for this session type.
   * Implements abstract method from Node.Session base class.
   * @returns {Function} The IDEAppClient constructor function
   * @override
   */
  getAppClientClass()
  {
    return Node.IDEAppClient;
  }


  /**
   * Hook called after an app client is created.
   * Checks for Frontend-Backend (FEBE) mode activation when multiple clients are connected.
   * @param {Node.IDEAppClient} appClient - The newly created app client
   * @override
   */
  afterCreateAppClient(appClient)
  {
    // If this app was just closed (e.g. a browser refresh of the preview), cancel its pending runtime
    // teardown so the refreshed client re-attaches to the still-alive runtime instead of a dead one.
    if (this.appTeardownTimers && this.appTeardownTimers[appClient.appid]) {
      clearTimeout(this.appTeardownTimers[appClient.appid]);
      delete this.appTeardownTimers[appClient.appid];
      this.log("DEBUG", "Cancelled pending app runtime teardown (app re-opened)", "IDESession.afterCreateAppClient");
    }
    //
    this.checkFebeMode();
  }


  /**
   * Checks and activates Frontend-Backend (FEBE) mode when conditions are met.
   * FEBE mode is enabled when exactly two app clients with opposite modes (online/offline) are connected.
   */
  checkFebeMode()
  {
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
  }


  /**
   * Deletes an app client from the session.
   * Handles cleanup including master client removal and FEBE mode deactivation.
   * @param {Node.IDEAppClient} appClient - The app client to delete
   */
  deleteAppClient(appClient)
  {
    // Delete the app client from the array
    let idx = this.appClients.indexOf(appClient);
    this.appClients.splice(idx, 1);
    //
    // If the master client is deleted then we send a message to the child to delete the Session or the Offline Proxy
    if (this.masterAppClient === appClient) {
      this.log("DEBUG", "Terminated MASTER client from session (2)", "IDESession.deleteAppClient");
      //
      // Grace before tearing down the app runtime. A browser refresh of the preview disconnects this
      // master client and immediately re-runs /run (a new app client) a few ms later; tearing the
      // runtime down right away makes the refreshed client's onStart hit a dead runtime -> blank page.
      // Defer the teardown; afterCreateAppClient() cancels it when the app is re-opened in time.
      let appid = appClient.appid;
      this.appTeardownTimers = this.appTeardownTimers || {};
      if (this.appTeardownTimers[appid])
        clearTimeout(this.appTeardownTimers[appid]);
      // Normally short (3s) so a real close frees the runtime promptly; an in-flight OIDC redirect login
      // bumps it (oidcGraceMs, via "setAppGrace") so a cold login at the IdP survives, and
      // checkRedirectResume() restores it. During that window the runtime is only waiting, not working.
      this.appTeardownTimers[appid] = setTimeout(() => {
        delete this.appTeardownTimers[appid];
        this.sendToChild({
          type: Node.IDESession.msgTypeMap.deleteAppSession,
          sid: this.id,
          appid
        });
      }, this.oidcGraceMs || 3000);
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
  }


  /**
   * Returns the number of active WebSocket connections to this session.
   * @returns {Number} The count of connected clients
   */
  countClients()
  {
    return Object.keys(this.sockets).length;
  }


  /**
   * Handles a remote database query request from the child process.
   * Executes queries either locally or on remote servers and returns the results.
   * @param {Object} options - Query options including server, user, database, SQL, and query ID
   */
  async handleRemoteQueryMessage(options)
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
          result = await db.query(params);
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
  }


  /**
   * Performs the production-logs CCC call on behalf of the child process. The autk token lives
   * only on the server process and rotates ~hourly, so the child cannot perform the call itself
   * (it never receives autk in its config snapshot). We attach the current autk + consoleURL,
   * POST cmd=productionlogs, and return the raw response to the child, which handles file I/O.
   * @param {Object} msg - {reqid, body}
   */
  async handleProductionLogsMessage(msg)
  {
    let result, err;
    try {
      let autk = this.config.autk;
      if (!this.config.consoleURL)
        throw new Error("Error: missing consoleURL in IDE configuration.");
      //
      if (!autk)
        throw new Error("Error: IDE has not yet authenticated with the console (missing autk token).");
      //
      let https = require("https");
      let consoleUrl = new URL(this.config.consoleURL);
      let bodyStr = JSON.stringify(msg.body || {});
      result = await new Promise((resolve, reject) => {
        let req = https.request({
          protocol: consoleUrl.protocol,
          hostname: consoleUrl.hostname,
          port: consoleUrl.port,
          path: `${consoleUrl.pathname}?mode=rest&cmd=productionlogs&autk=${autk}`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(bodyStr)
          },
          timeout: 120000
        }, res => {
          require("stream/consumers").text(res).then(data => {
            let parsed = null;
            try {
              parsed = JSON.parse(data);
            }
            catch {
              /* leave parsed=null */
            }
            resolve({
              statusCode: res.statusCode,
              json: parsed,
              raw: data
            });
          }, reject);
        });
        req.on("error", e => reject(new Error(`Error contacting CCC: ${e.message}`)));
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("Error contacting CCC: request timeout (120s)"));
        });
        req.write(bodyStr);
        req.end();
      });
    }
    catch (e) {
      err = e.message || String(e);
      this.log("WARN", err, "IDESession.handleProductionLogsMessage");
    }
    //
    this.sendToChild({
      type: Node.IDESession.msgTypeMap.productionLogsResult,
      sid: this.id,
      reqid: msg.reqid,
      result,
      err
    });
  }


  /**
   * Sends a natural-language request to the console (CCC) AI assistant on behalf of the child
   * process and returns its reply. The autk token lives only on the server process and rotates
   * ~hourly, so the child cannot perform the call itself (it never receives autk in its config
   * snapshot). We attach the current autk + caller identity (username/company) in the query string
   * and POST cmd=ai_chat_message with a {message, threadId} body — mirrors handleProductionLogsMessage.
   * @param {Object} msg - {reqid, body} where body = {message, threadId, username, company}
   */
  async handleConsoleChatMessage(msg)
  {
    let result, err;
    try {
      let autk = this.config.autk;
      let consoleURL = this.config.consoleURL;
      //
      if (!consoleURL)
        throw new Error("Error: missing consoleURL in IDE configuration.");
      //
      if (!autk)
        throw new Error("Error: IDE has not yet authenticated with the console (missing autk token).");
      //
      let body = msg.body || {};
      if (!body.message)
        throw new Error("Error: missing message for the console assistant.");
      //
      if (!body.username || !body.company)
        throw new Error("Error: missing username or company to identify the console account.");
      //
      let https = require("https");
      let consoleUrl = new URL(consoleURL);
      //
      // Caller identity goes in the query string (autk + username + company), the conversation
      // payload in the body — same auth gate verified against the console's onCommand.
      let query = `mode=rest&cmd=ai_chat_message&autk=${encodeURIComponent(autk)}`
        + `&username=${encodeURIComponent(body.username)}&company=${encodeURIComponent(body.company)}`;
      let payload = {message: body.message};
      if (body.threadId)
        payload.threadId = body.threadId;
      //
      let bodyStr = JSON.stringify(payload);
      result = await new Promise((resolve, reject) => {
        let req = https.request({
          protocol: consoleUrl.protocol,
          hostname: consoleUrl.hostname,
          port: consoleUrl.port,
          path: `${consoleUrl.pathname}?${query}`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(bodyStr)
          },
          timeout: 180000
        }, res => {
          let data = "";
          res.on("data", chunk => data += chunk);
          res.on("end", () => {
            let parsed = null;
            try {
              parsed = JSON.parse(data);
            }
            catch {
              /* leave parsed=null */
            }
            resolve({
              statusCode: res.statusCode,
              json: parsed,
              raw: data
            });
          });
        });
        req.on("error", e => reject(new Error(`Error contacting CCC: ${e.message}`)));
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("Error contacting CCC: request timeout (180s)"));
        });
        req.write(bodyStr);
        req.end();
      });
    }
    catch (e) {
      err = e.message || String(e);
      this.log("WARN", err, "IDESession.handleConsoleChatMessage");
    }
    //
    this.sendToChild({
      type: Node.IDESession.msgTypeMap.consoleChatResult,
      sid: this.id,
      reqid: msg.reqid,
      result,
      err
    });
  }


  /**
   * Handles a file copy request between projects.
   * Validates paths to prevent traversal attacks before copying.
   * @param {Object} msg - Message containing copy options in `cnt` (src and dst paths)
   */
  async handleCopyPrjFile(msg)
  {
    let options = msg.cnt;
    this.log("DEBUG", "Copy project file", "IDESession.handleCopyPrjFile", options);
    //
    let src = Node.path.resolve(this.config.directory, options.src);
    let dst = Node.path.resolve(this.config.directory, options.dst);
    //
    // Path traversal validation
    if (!src.startsWith(this.config.directory) || !dst.startsWith(this.config.directory))
      return this.log("WARN", "Path traversal detected", "IDESession.handleCopyPrjFile", options);
    //
    try {
      await Node.fs.promises.copyFile(src, dst);
    }
    catch (e) {
      this.log("WARN", `Can't copy file: ${e}`, "IDESession.handleCopyPrjFile", options);
    }
  }
};


// Export module
module.exports = Node.IDESession;
