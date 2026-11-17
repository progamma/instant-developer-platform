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
Node.SessionDiagnostics = require("./sessionDiagnostics");


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
    /** Files that could not be copied, on their way back to the user */
    copyPrjFileResult: "cpfres",
    /** Create database request */
    createDB: "cdb",
    /** Create database result */
    createDBresult: "cdbres",
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
    /** Account-wide onboarding budget request/result */
    onboardingBudget: "onbb",
    onboardingBudgetResult: "onbbres",
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
    // Keep incident evidence outside the worker and outside the mutable projection.
    if (options.type === "ide" && !options.readOnly && !options.openParams?.course && !options.openParams?.showDtt) {
      this.diagnostics = new Node.SessionDiagnostics(this.path, this.id, {
        source: "parent",
        version: options.openParams?.version || this.config.version,
        uid: Number(this.project.user.uid),
        gid: Number(this.project.user.gid)
      });
      this.diagnostics.start();
    }
    //
    // Map of sockets connected with this session
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


  /** Keep this session's warnings/errors with its incident, without unrelated server data. */
  log(level, message, sender, data)
  {
    if (["WARN", "ERROR"].includes(level))
      this.diagnostics?.record("parent-log", {
        level, sender,
        message: String(message).substring(0, 8000)
      });
    super.log(level, message, sender, data);
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
      sessionDiagnostics: !!this.diagnostics,
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
      sessionDiagnostics: !!this.diagnostics,
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
    // The local prospect harness can force onboarding for this session without changing
    // account settings. Remember only this master-issued command, never a worker assertion.
    if (msg.type === "force_onboarding")
      this.forcedOnboarding = !!msg.cnt?.onboarding;
    //
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
    this.diagnostics?.record("expiry-scheduled", {timeout});
    //
    // Create a new timer that will fire after the given timeout
    let timerID = setTimeout(() => {
      this.log("DEBUG", "Auto-kill fired -> delete session", "IDESession.startAutoKillTimer", {timeout});
      this.diagnostics?.record("expiry-timer-fired", {timeout});
      this.closeAllConnections(true);
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
        profile.devAgentSessionStorageMB = require("./devAgentOptionsStore").sessionStorageMB(opts.sessionStorageMB);
        profile.devAgentProvider = opts.provider || "anthropic";
        profile.devAgentCodexModel = opts.codexModel || "gpt-6-astra";
        profile.devAgentClaudeModel = opts.model || null;
        profile.devAgentAnthropicContextWindow = opts.anthropicContextWindow === 200000 ? 200000 : 1000000;
        profile.devAgentDeepseekModel = opts.deepseekModel || null;
        profile.devAgentMistralModel = opts.mistralModel || "mistral-large-4";
        profile.devAgentMistralRegion = opts.mistralRegion === "global" ? "global" : "eu";
        profile.hasDevAgentMistralKey = !!opts.mistralApiKey;
        if (opts.provider === "mistral-codex")
          profile.hasDevAgentKey = !!opts.mistralApiKey;
        profile.devAgentModel = opts.provider === "codex" ? profile.devAgentCodexModel :
          opts.provider === "mistral-codex" ? profile.devAgentMistralModel : opts.model || null;
        if (["deepseek", "deepseek-codex"].includes(opts.provider) && profile.devAgentDeepseekModel)
          profile.devAgentModel = profile.devAgentDeepseekModel;
        if (["deepseek", "deepseek-codex"].includes(opts.provider))
          profile.hasDevAgentKey = !!opts.deepseekApiKey;
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
          if (!["codex", "deepseek", "deepseek-codex", "mistral-codex"].includes(opts.provider)) profile.hasDevAgentKey = true;
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
   * Handles authentication and reconnection, and manages the session lifecycle.
   * @param {Socket} socket - The Socket.io socket that initiated the connection
   * @param {Object} msg - Initial message from the client containing the session ID
   */
  openConnection(socket, msg)
  {
    let reconnected;      // TRUE if this is a succesful reconnection
    //
    // If the SID is invalid
    if (this.invalidSID(socket)) {
      let exitUrl = this.config.saveProperties().exitUrl;
      this.log("WARN", `Invalid SID -> redirect to ${exitUrl}`, "IDESession.openConnection");
      socket.emit(Node.IDESession.msgTypeMap.redirect, exitUrl);
      return;
    }
    //
    // If this is a reconnect attempt
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
    this.diagnostics?.record("browser-connected", {reconnected: !!reconnected, master: this.masterClientSod === sod});
    // Only this authenticated socket can submit small lifecycle observations. These are
    // browser claims, not proof of a server timeout or process death.
    socket.on("sessionDiagnostics", payload => this.recordBrowserDiagnostics(sod, payload));
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
    socket.on("disconnect", (reason, description) => {
      // Capture socket.io's disconnect `reason` (e.g. "ping timeout", "transport close",
      // "server namespace disconnect"): when the MASTER socket drops, masterClientSod is
      // deleted below and the next save_project/close_project fails with "No browser client
      // connected". WARN for a master drop (it breaks the session), INFO otherwise. The old
      // DEBUG level was filtered out of the persisted log, so the reason was unrecoverable.
      let isMaster = this.masterClientSod === sod;
      // Keep the Engine.IO error code without logging its request, URL, headers or bearer token.
      let code = description?.code || description?.description?.code;
      let details = {
        reason,
        master: isMaster,
        transport: socket.conn?.transport?.name,
        protocol: socket.conn?.protocol,
        transportErrorCode: typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code) ? code : undefined
      };
      this.diagnostics?.record("browser-disconnected", details);
      this.log(isMaster ? "WARN" : "INFO", "IDE socket disconnected", "IDESession.openConnection", {...msg, ...details});
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
    });
  }


  /** Accept bounded lifecycle facts only from the authenticated master browser. */
  recordBrowserDiagnostics(sod, payload)
  {
    if (!this.diagnostics || this.masterClientSod !== sod || !Array.isArray(payload?.events))
      return;
    // Limit disk writes even if a browser floods the diagnostic channel.
    let now = Date.now();
    if (!this.browserDiagnosticWindow || now - this.browserDiagnosticWindow.time >= 60000)
      this.browserDiagnosticWindow = {time: now, count: 0};
    let allowed = ["connect", "disconnect", "visibilitychange", "freeze", "resume", "pagehide", "pageshow", "online", "offline"];
    for (let entry of payload.events.slice(0, 32)) {
      if (this.browserDiagnosticWindow.count >= 64)
        break;
      if (!entry || !allowed.includes(entry.event))
        continue;
      this.browserDiagnosticWindow.count++;
      this.diagnostics.record("browser-lifecycle", {
        event: entry.event,
        clientTime: typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : null,
        visibility: ["hidden", "visible"].includes(entry.visibility) ? entry.visibility : "unknown",
        online: entry.online === true,
        wasDiscarded: entry.wasDiscarded === true,
        reason: typeof entry.reason === "string" ? entry.reason.substring(0, 120) : undefined
      });
    }
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
   * @param {Boolean} [expired] - Preserve unsaved changes only for an expired session
   */
  closeAllConnections(expired)
  {
    this.diagnostics?.record("termination-requested", {expired: !!expired, completed: !!this.sessionCompletedReceived});
    if (expired && !this.sessionCompletedReceived && !this.expiryCompletion) {
      this.expiryCompletion = this.waitCompleted();
      //
      // An expiry with no waiting opener can still be rejected by the watchdog.
      this.expiryCompletion.catch(() => {});
    }
    //
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
      type: Node.IDESession.msgTypeMap.terminateChild,
      expired: !!expired
    });
    //
    // Termination watchdog (issue #14839): the closing handshake is entirely pull —
    // terminateChild → child's sessionCompleted → closeSession → child.disconnect().
    // A child stuck in a busy-loop or on a hung await never sends sessionCompleted,
    // and without this timer the worker (and the claude CLI it spawned) survive forever.
    if (!this.terminationWatchdog && !this.sessionCompletedReceived) {
      this.terminationWatchdog = setTimeout(() => {
        delete this.terminationWatchdog;
        this.diagnostics?.record("termination-watchdog", {timeout: Node.IDESession.terminationWatchdogTimeout});
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
        if (msg.info.lastSaveID === null && !msg.resync)
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
        this.diagnostics?.end({
          reason: msg.workerExit ? "worker-exit" : "worker-completed",
          workerExit: msg.workerExit,
          error: msg.result?.err ? String(msg.result.err).substring(0, 2000) : undefined
        });
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
          // The child sends back only the message of its error: whoever waits gets a real Error,
          // since the callers read error.message (see Config.processCommand)
          if (msg.result?.err)
            reject(new Error(msg.result.err));
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

      case Node.IDESession.msgTypeMap.onboardingBudget:
        this.handleOnboardingBudgetMessage(msg);
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
            let state = JSON.parse(msg.cnt);
            // A stale project worker may save progress after another worker consumed a gift.
            for (let flag of Object.values(require("./onboardingBudget").resetFlags)) {
              if (this.project.user.onboardingState?.[flag])
                state[flag] = true;
            }
            this.project.user.onboardingState = state;
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
   * The IDE session serves every app of the project and has no REST timeout: a request the preview
   * never answers (preview not started, stopped or relaunched) would block all the following ones.
   * @type {Boolean}
   * @readonly
   * @override
   */
  get queuesRestCalls()
  {
    return false;
  }


  /**
   * Hands a REST request to the app.
   * Overrides base class to handle IDE-specific app ID processing and routing.
   * @param {Object} restCall - REST request (see {@link Node.Session#startRest})
   * @override
   */
  sendRestToChild(restCall)
  {
    // IDE-specific: send message to child with appid
    let appid = restCall.req.params?.appid.replace(/-/g, "/");
    this.sendToChild({
      type: Node.IDESession.msgTypeMap.appmsg2ide,
      appid,
      sid: this.id,
      request: restCall.request,
      cookies: restCall.cookies
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


  /** Read or reset the authenticated user's budget; worker payloads cannot select another user. */
  async handleOnboardingBudgetMessage(msg)
  {
    let result;
    let err;
    try {
      if (!this.getProfile().isOnboarding && !this.forcedOnboarding)
        throw new Error("Onboarding budget unavailable outside onboarding");
      result = await require("./onboardingBudget").request(this.project.user, this.project, msg.command);
    }
    catch (error) {
      this.log("WARN", error.message, "IDESession.handleOnboardingBudgetMessage");
      err = "Unable to update onboarding budget";
    }
    this.sendToChild({
      type: Node.IDESession.msgTypeMap.onboardingBudgetResult,
      sid: this.id,
      reqid: msg.reqid,
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
   *
   * A request carries ALL the files of one paste, not one at a time: it is the only way to tell
   * the user in a single message what did not arrive (#12261).
   * @param {Object} msg - Message containing copy options in `cnt`: `files` (an array of
   * {name, src, dst}) and `srcPrj`, the project they come from
   */
  async handleCopyPrjFile(msg)
  {
    // `cnt` arriva dal browser e puo' mancare del tutto: senza questo, la riga qui sotto
    // solleva prima di qualunque difesa, e il rigetto a terra spegne il processo (#12261)
    let options = msg.cnt || {};
    this.log("DEBUG", "Copy project file", "IDESession.handleCopyPrjFile", options);
    //
    let mancanti = [];
    //
    // Confining a path takes more than comparing strings. The old guard compared the resolved
    // path with `this.config.directory` as written - forward slashes against backslashes on
    // Windows - so it was always false and rejected EVERY copy, legitimate ones included, leaving
    // just a WARN nobody read (#12261).
    //
    // Resolving both sides is still not enough: a symlink points wherever it wants and the file
    // system follows it, on reads and on writes - and the mkdir below would create directories
    // through it. realPath and isPathInside are the pair the repo already uses for exactly this
    // (utils.js, issue #14062), and isPathInside carries the trailing separator of its own, so a
    // sibling folder whose name starts the same way does not pass as inside.
    //
    // On v26.0r9-IDS those two utilities do not exist, and the same walk is written inline there
    // rather than adding public utilities to a release branch: the two branches diverge here on
    // purpose, and this note is in both places so neither looks like a mistake
    // Con IdsPrjDir (#14585) i progetti NON stanno sotto <directory>/<utente>: stanno tutti
    // dentro quella cartella, per nome di progetto (user.js, getProjectsListJson). Il client
    // manda comunque <utente>/<progetto>/resources/<guid>, che e' la sola forma che conosce,
    // quindi qui il segmento dell'utente non vuol dire niente e va tolto: senza, si cerca e si
    // scrive dove i progetti non sono piu', l'incolla non porta niente e l'utente si prende
    // l'avviso a ogni volta. La #15005 e' lo stesso inciampo su un'altra porta, e il commento
    // di Config.openPrjFolder lo dice gia' (#12261)
    let prjDir = this.config.idfoptions?.IdsPrjDir;
    let intero = p => prjDir ? Node.path.resolve(prjDir, p.split(/[\\/]/).slice(1).join("/"))
            : Node.path.resolve(this.config.directory, p);
    //
    // Il client compone sempre <utente>/<progetto>/resources/<guid>, sia quello di oggi sia
    // quello di prima del rilascio. Pretendere la FORMA chiude una classe intera: senza, la sola
    // guardia sul confine lascia leggere il project.json di chiunque e scrivere fuori da
    // resources/ (#16461).
    //
    // Tre cose non ovvie, tutte misurate:
    //  - le barre ROVESCE si rifiutano: su Windows path.resolve le tratta da separatore, quindi
    //    un `..` nascosto fra loro esce dalla cartella senza comparire fra i pezzi;
    //  - dopo `resources` ci vuole un pezzo VERO: una barra in coda ne produce uno vuoto, e la
    //    copia finisce sulla cartella stessa - che pianta li' un FILE, e da allora ogni incolla
    //    in quel progetto muore sulla mkdir con EEXIST;
    //  - il confronto e' su `>= 4` perche' il guid oggi non contiene barre, ma non ci si appoggia.
    let risorsa = p => {
      let pezzi = p.split("/");
      return pezzi.length >= 4 && pezzi[2] === "resources" && !p.includes("\\")
              && pezzi.slice(0, 3).every(x => x && x !== ".")
              && pezzi.slice(3).some(x => x && x !== ".")
              && !pezzi.includes("..");
    };
    //
    let radice = await Node.Utils.realPath(prjDir || this.config.directory);
    //
    // La DESTINAZIONE resta dentro il PROGETTO di questa sessione: si incolla nel proprio
    // progetto, e chi compone il messaggio e' il browser. Confinare alla cartella dell'utente
    // non basta - li' sotto ci sono anche index.json, il file IID della licenza e db/, cioe' il
    // tablespace, e dietro la guardia c'e' una mkdir ricorsiva piu' una copyFile (#12261).
    //
    // getProjectsDir() e' l'accessore che il repo usa per ogni percorso di progetto, e tiene
    // gia' dentro tutte e due le disposizioni: <directory>/<utente> di default, la cartella
    // condivisa quando IdsPrjDir e' configurato. La stessa composizione sta a idesession.js:181,
    // e Project.downloadFile confina cosi' la stessa cartella resources servita su HTTP.
    //
    // L'ORIGINE invece resta libera dentro la radice: incollare dal progetto di un collega e'
    // permesso apposta, lo decide il client in canPasteFromOtherPrj
    let mia = await Node.Utils.realPath(Node.path.join(this.project.user.getProjectsDir(), this.project.name));
    //
    // An IDE tab loaded before this change still sends one file as {src, dst}: the loop over
    // `options.files` would throw on undefined, and processMessage calls this without await
    // (idesession.js:805), so the rejection would reach the process-wide unhandledRejection
    // handler - which kills the server, and with it every session on it (#12261)
    // Il controllo e' su `typeof`, non su truthy: path.basename di un numero, di un oggetto o di
    // un array solleva, e qui siamo ancora PRIMA della guardia dentro il ciclo - cioe' nel punto
    // che la riga esiste apposta per proteggere
    let files = Array.isArray(options.files) ? options.files : (typeof options.src === "string" ? [{
      name: Node.path.basename(typeof options.dst === "string" ? options.dst : options.src),
      src: options.src,
      dst: options.dst
    }] : []);
    //
    for (let f of files) {
      // A file entry without src or dst reaches the same fatal path the line above exists to
      // close: path.resolve throws on undefined, processMessage does not await, and the floating
      // rejection kills the process. The cnt is composed in the browser and nobody checks it on
      // the way here, so the shape is an assumption until it is verified (#12261)
      if (typeof f?.src !== "string" || typeof f?.dst !== "string") {
        this.log("WARN", "Malformed copy request", "IDESession.handleCopyPrjFile", f);
        mancanti.push(f?.name || "?");
        continue;
      }
      //
      // Un percorso ASSOLUTO - lettera di volume, barra iniziale o UNC - sopravvive a
      // path.resolve intatto, e la riga qui sotto ci va sopra PRIMA che la guardia possa dire di
      // no. Su un UNC quella risoluzione esce in rete verso un indirizzo scelto dal browser e
      // torna dopo una ventina di secondi: in fila nel ciclo, e in questo processo, che e' il
      // server e non il figlio. Il client compone sempre percorsi relativi, quindi qui si
      // rifiuta prima di toccare il filesystem (#12261).
      //
      // isAbsolute va chiesto nelle due forme: quella della piattaforma e quella di Windows,
      // perche' un server Linux non riconoscerebbe ne' C: ne' l'UNC
      if (Node.path.isAbsolute(f.src) || Node.path.isAbsolute(f.dst) ||
              Node.path.win32.isAbsolute(f.src) || Node.path.win32.isAbsolute(f.dst)) {
        this.log("WARN", "Absolute path refused", "IDESession.handleCopyPrjFile", f);
        mancanti.push(f.name);
        continue;
      }
      //
      // Il controllo sulla forma sta PRIMA della traduzione: con IdsPrjDir `intero` butta via il
      // primo segmento, e dopo non si saprebbe piu' se c'era
      if (!risorsa(f.src) || !risorsa(f.dst)) {
        this.log("WARN", "Not a resource path", "IDESession.handleCopyPrjFile", f);
        mancanti.push(f.name);
        continue;
      }
      //
      let src = await Node.Utils.realPath(intero(f.src));
      let dst = await Node.Utils.realPath(intero(f.dst));
      //
      // Path traversal validation
      if (!Node.Utils.isPathInside(src, [radice], true) || !Node.Utils.isPathInside(dst, [mia], true)) {
        this.log("WARN", "Path traversal detected", "IDESession.handleCopyPrjFile", f);
        mancanti.push(f.name);
        continue;
      }
      //
      try {
        // The resources folder of a project that never had one does not exist yet, and copyFile
        // would fail with an ENOENT naming the file instead of the missing folder
        await Node.fs.promises.mkdir(Node.path.dirname(dst), {recursive: true});
        await Node.fs.promises.copyFile(src, dst);
      }
      catch (e) {
        this.log("WARN", `Can't copy file: ${e}`, "IDESession.handleCopyPrjFile", f);
        mancanti.push(f.name);
      }
    }
    //
    // A file that does not arrive leaves the project broken in a way that shows up only at build
    // time, weeks later, with an error naming a file the user has never seen. While this was only
    // a WARN in the log, nobody knew (#12261)
    if (mancanti.length)
      this.sendToChild({
        type: Node.IDESession.msgTypeMap.copyPrjFileResult,
        sid: this.id,
        cnt: {
          mancanti,
          srcPrj: options.srcPrj
        }
      });
  }
};


// Export module
module.exports = Node.IDESession;
