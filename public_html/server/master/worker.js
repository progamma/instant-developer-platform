/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
var Node = Node || {};

// Import modules
Node.child = require("child_process");
Node.path = require("path");

// Import Classes
Node.AppSession = require("./appsession");
Node.Utils = require("../utils");

/**
 * @class Node.Worker
 * @classdesc
 * Runtime container for an {@link Node.App} inside the master process.
 * A worker owns exactly one Node.js child process (forked from the app's
 * `server/app.js`) and a collection of {@link Node.AppSession} bound to it.
 * The master-side worker is the bridge between the public server (HTTP,
 * sockets, REST, sync) and the sandboxed app logic.
 *
 * Key features:
 * - **Child lifecycle**: spawns, supervises and recycles the app's child
 *   process; handles renice, stderr capture during install, and graceful
 *   vs forcible termination.
 * - **IPC dispatch**: {@link Node.Worker#handleAppChildMessage} routes the
 *   many message types of {@link Node.Worker.msgTypeMap} to sessions,
 *   promises or sibling workers.
 * - **Watchdog**: pings the child every 5 seconds and forcibly kills it
 *   if no reply arrives within 30 seconds (120 seconds before the first
 *   reply, to give large apps room to finish their startup).
 * - **Event-loop telemetry**: samples the child's event-loop utilization
 *   every tick, keeps a 1-hour high-resolution window + 23-hour aggregated
 *   window, and surfaces a 1-minute rolling average used by the scheduler.
 * - **Self-healing on crash**: when the child disconnects unexpectedly,
 *   terminates every session, cancels the idle-death timer and prepares a
 *   fresh child on demand.
 *
 * @property {Node.App} parent - Parent app
 * @property {Node.AppSession[]} sessions - Sessions currently bound to this worker
 * @property {ChildProcess} [child] - Forked Node.js process running the app; `undefined` when the worker is dead or not spawned yet
 * @property {Object} [options] - Worker options (currently `priority`, `idleTimeout`)
 * @property {Object} [installPromise] - `{resolve, reject, errors}` triple armed while an install is running (`errors` collects child stderr chunks)
 * @property {Object} [statusResultPromise] - `{resolve, timeout}` pair armed while awaiting a `getStatusResult` reply
 * @property {Object} [watchdog] - Internal watchdog state (`{lastTick, intervalID}`)
 * @property {Object} [killWorkerTimer] - `setTimeout` scheduling the worker's idle death
 * @property {Object} [eluStorage] - Event-loop utilization history (`{lastHour, previous23Hours, minuteAccumulator, lastWarning}`)
 * @property {Object} [eventLoopUtilization] - Latest event-loop utilization sample received from the child
 * @property {Number} [lastMinuteAvgUtilization] - Rolling 1-minute average ELU (0-1); `1.0` if no samples in the last minute (worker assumed blocked)
 * @property {Number} [lastMinuteSampleCount] - Number of samples used to compute `lastMinuteAvgUtilization`
 * @property {Boolean} [hibernated] - `true` when the worker has been hibernated and rejects new sessions
 */
Node.Worker = class Worker
{
  /**
   * Map of IPC message types exchanged with the app child process.
   * @enum {String}
   */
  static msgTypeMap = {
    /** Initial handshake sent to the child with app name/url/params */
    initApp: "initApp",
    /** Child-originated response meant for a session's client */
    processRequest: "pr",
    /** Child-originated session parameter change (timeout, name) */
    sessionParams: "sespar",
    /** Master → child: terminate the app */
    terminate: "terminate",
    /** Child-originated request to delete an app session */
    deleteSession: "delses",
    /** Child-originated REST reply */
    sendRestResponse: "rest",
    /** Master → child watchdog ping */
    watchdogRequest: "wdreq",
    /** Child → master watchdog pong (with ELU payload) */
    watchdogResponse: "wdres",
    /** Master → child: database connection parameters */
    connectionDB: "conDB",
    /** Point-to-point sync message */
    sync: "sync",
    /** Broadcast sync message across apps/workers */
    syncBroad: "syncBroad",
    /** Cloud connector RPC message */
    cloudConnectorMsg: "ccm",
    /** Master → child: install the app */
    install: "inst",
    /** Child → master: install result or failure */
    installResult: "instres",
    /** Child → master: request the creation of a user database */
    createDB: "cdb",
    /** Master → child: ack of the `createDB` request */
    createDBresult: "cdbres",
    /** Server-session lifecycle message */
    serverSession: "serverSession",
    /** Child → master: result of the `testStart` notification */
    testStartResult: "testres",
    /** Session cToken operation (invite/revoke/consume) */
    cTokenOp: "ctop",
    /** Child → master: runtime change of an app parameter */
    changedAppParam: "chpar",
    /** Developer Tracing Tool payload */
    dtt: "dtt",
    /** Child → master: log entry to be forwarded to the shared logger */
    log: "log",
    /** Master → child: delete trace files */
    deleteTraceFiles: "dtf",
    /** Child → master: delete-trace-files result */
    deleteTraceFilesResult: "dtfr",
    /** Master → child: request status dump */
    getStatus: "gst",
    /** Child → master: status reply */
    getStatusResult: "gstr",
    /** Child → master: feedback to surface to the console */
    notifyFeedbackToConsole: "nftc",
    /** Master → child: arbitrary `eval` request */
    eval: "eval",
    /** Child → master: `eval` result (errors logged) */
    evalResult: "evalResult",
    /** Child → master: request of the current server status */
    serverStatus: "serverStatus",
    /** Master → child: server status reply */
    serverStatusResult: "serverStatusResult"
  };


  /**
   * @param {Node.App} par - Parent app that owns this worker
   */
  constructor(par)
  {
    this.parent = par;
    //
    // Sessions in this worker
    this.sessions = [];
  }


  /**
   * Gets the owning app (alias of `parent`).
   * @type {Node.App}
   * @readonly
   */
  get app()
  {
    return this.parent;
  }


  /**
   * Gets the user that owns the app.
   * @type {Node.User}
   * @readonly
   */
  get user()
  {
    return this.app.user;
  }


  /**
   * Gets the server instance.
   * @type {Node.Server}
   * @readonly
   */
  get server()
  {
    return this.app.server;
  }


  /**
   * Gets the shared configuration.
   * @type {Node.Config}
   * @readonly
   */
  get config()
  {
    return this.app.config;
  }


  /**
   * Gets the shared logger instance.
   * @type {Node.Logger}
   * @readonly
   */
  get logger()
  {
    return this.app.logger;
  }


  /**
   * Logs a message through the shared logger, decorating the payload with
   * app name, user name, worker index and worker options so every entry can
   * be correlated to the specific child.
   * @param {String} level - Message level (DEBUG, INFO, WARN, ERROR)
   * @param {String} message - Text of the message
   * @param {String} sender - Function that generated the message
   * @param {Object} [data] - Optional data payload to log
   */
  log(level, message, sender, data)
  {
    // Add "local" info
    data = {
      ...data,
      app: this.app.name,
      user: this.user.userName,
      workerIdx: this.app.workers.indexOf(this),
      totalWorkers: this.app.workers.length,
      options: this.options
    };
    //
    this.logger.log(level, message, sender, data);
  }


  /**
   * Forks the app's `server/app.js` as a Node.js child process and wires it.
   *
   * Flow:
   * - During an install the child is spawned with `silent: true` so stderr
   *   can be captured and aggregated into `installPromise.errors` (bubbled up
   *   through the install promise on failure).
   * - On non-Windows platforms honours `options.priority` via `renice`.
   * - Sends two handshake messages: `initApp` (app metadata, services, params)
   *   and `connectionDB` (Postgres connection string, remote DB URLs).
   * - Subscribes to `message` (routed through {@link Node.Worker#handleAppChildMessage})
   *   and `disconnect` (routed through {@link Node.Worker#handleChildDisconnect}).
   * - Starts the watchdog via {@link Node.Worker#startWatchDog}.
   */
  createChild()
  {
    let appPath = Node.path.join(this.config.appDirectory, "apps", this.app.name, "server", "app.js");
    //
    // Create the child process
    // If I'm installing, get ERRORS from child stderr stream
    if (this.installPromise) {
      this.installPromise.errors = [];
      this.child = Node.child.fork(appPath, [], Object.assign({silent: true}, Node.Utils.forkArgs()));     // Capture StdErr errors
      //
      this.child.stderr.on("data", err => {
        err += "";      // Convert error into string
        this.log("WARN", `Application error: ${err}`, "Worker.createChild");
        //
        // Store error in errors array (optional chaining: a late chunk may arrive after installPromise was cleared)
        this.installPromise?.errors.push(err);
      });
    }
    else
      this.child = Node.child.fork(appPath, Node.Utils.forkArgs());
    //
    // Log child creation
    this.log("DEBUG", "Created app child", "Worker.createChild");

    // Now, that everything is completed and child is ready, if requested change child process priority excecuting renice command
    if (this.options && this.options.priority && !/^win/.test(process.platform)) {
      Node.child.execFile("/usr/bin/renice", [this.options.priority, this.child.pid], err => {
        if (err)
          this.log("WARN", `Can't renice child process: ${err}`, "Worker.createChild");
      });
    }
    //
    // Initialize app child
    this.child.send({
      type: Node.Worker.msgTypeMap.initApp,
      sender: "master",
      name: this.app.name,
      url: this.config.getUrl(),
      path: Node.path.join(this.config.appDirectory, "apps", this.app.name),
      publicUrl: `${this.config.getUrl()}/${this.app.name}`,
      online: true,
      workerIdx: this.app.workers.indexOf(this),
      params: Object.assign({}, this.config.params, this.app.params, {_lowDiskThreshold: this.config.lowDiskThreshold}),
      services: this.config.services
    });
    //
    // Tell the app how to connect with the database
    let constring = `postgres://${this.config.dbUser}:${this.config.dbPassword}@${this.config.dbAddress}:${this.config.dbPort}`;
    this.child.send({
      type: Node.Worker.msgTypeMap.connectionDB,
      username: (this.user.userName === "manager" ? undefined : this.user.userName),
      constring,
      remoteDBurls: this.config.getRemoteDBUrls()
    });
    //
    // Listen for messages
    this.child.on("message", msg => this.handleAppChildMessage(msg));
    this.child.on("disconnect", () => this.handleChildDisconnect());
    //
    // Start the child process watchdog
    this.startWatchDog();
  }


  /**
   * Handles the child process `disconnect` event: clears `this.child`, fails
   * the pending install promise (if any) by joining stderr chunks collected in
   * `installPromise.errors`, otherwise — if the worker is still registered in
   * `app.workers` — assumes a crash, terminates every session and cancels the
   * idle-kill timer so a fresh child can be spawned on demand. Also resolves a
   * pending `getStatus` request with an empty payload.
   */
  handleChildDisconnect()
  {
    this.log("DEBUG", "Worker child disconnected", "Worker.handleChildDisconnect");
    //
    // Now the child is dead
    delete this.child;
    //
    // Child has died. If I was installing the child crashed during install
    if (this.installPromise) {
      let err = this.installPromise.errors.join("\n") || "Unknown error";
      this.installPromise.reject(new Error(`Installation failed: ${err}`));
      delete this.installPromise;
    }
    else if (this.app.workers.includes(this)) {
      // If I'm still inside my app's worker list it means I've crashed...
      // (see app::deleteWorker: first the worker is removed then the worker's child is disconnected)
      this.log("WARN", "Worker is still inside app's list (maybe it crashed?) -> Delete worker all its sessions", "Worker.handleChildDisconnect",
              {numsession: this.sessions.length});
      //
      // Terminate and delete all worker's sessions
      while (this.sessions.length) {
        let sToDel = this.sessions[0];
        sToDel.terminate();
        this.deleteSession(sToDel);
      }
      //
      // Now, deleting all sessions should have programmed my death (see Worker::deleteSession).
      // I don't need to die... I just need a new child...
      if (this.killWorkerTimer) {
        clearTimeout(this.killWorkerTimer);
        delete this.killWorkerTimer;
      }
      //
      this.log("INFO", "Crashed worker restored", "Worker.handleChildDisconnect");
    }
    //
    // If a getStatus was pending, resolve with empty data
    if (this.statusResultPromise) {
      clearTimeout(this.statusResultPromise.timeout);
      this.statusResultPromise.resolve({sessions: []});
      delete this.statusResultPromise;
    }
  }


  /**
   * Terminates the child process. Cancels the idle-kill timer, stops the
   * watchdog and either disconnects the child politely or sends `SIGKILL`
   * when `force` is set. No-op if the child is already gone.
   * @param {Boolean} [force] - `true` to kill via `SIGKILL` instead of a clean disconnect
   */
  killChild(force)
  {
    // If dead, do nothing
    if (!this.child)
      return;
    //
    // If there was a kill timer, stop it
    if (this.killWorkerTimer) {
      clearTimeout(this.killWorkerTimer);
      delete this.killWorkerTimer;
    }
    //
    // Stop watchDog... I'll be dead soon!
    this.stopWatchDog();
    //
    // If requested use brute force
    if (force) {
      this.log("WARN", "Forcedly kill worker child", "Worker.killChild");
      this.child.kill("SIGKILL");
      //
      // Now the child should be dead
      delete this.child;
    }
    else {
      this.log("DEBUG", "Disconnects worker child", "Worker.killChild");
      this.child.disconnect();
    }
  }


  /**
   * Dispatches an IPC message originated by the app's child process to the
   * appropriate handler based on `msg.type`. The switch covers the full
   * {@link Node.Worker.msgTypeMap} vocabulary, including session routing
   * (`processRequest`, `sessionParams`, `deleteSession`, `sendRestResponse`,
   * `dtt`, `cTokenOp`), watchdog replies (with ELU piggyback), sync
   * (point-to-point and broadcast), cloud connector RPC, install / DB /
   * test-auto / status result promises, log forwarding, feedback-to-console
   * and server-status requests.
   * Unknown message types are logged at WARN level.
   * @param {Object} msg - IPC message sent by `app.js`
   */
  handleAppChildMessage(msg)
  {
    switch (msg.type) {
      case Node.Worker.msgTypeMap.processRequest: {
        // Send the message to the right app session
        let appsess = this.server.appSessions[msg.sid];
        if (appsess)
          appsess.sendMessageToClientApp(msg);
        else
          this.log("WARN", "Can't process request: session not found", "Worker.handleAppChildMessage", msg);
        break;
      }

      case Node.Worker.msgTypeMap.sessionParams: {
        // Send the message to the right app session
        let appsess = this.server.appSessions[msg.sid];
        if (appsess)
          appsess.handleSessionParams(msg.cnt);
        else
          this.log("WARN", "Can't handle session params message: session not found", "Worker.handleAppChildMessage", msg);
        break;
      }

      case Node.Worker.msgTypeMap.deleteSession: {
        let appsess = this.server.appSessions[msg.sid];
        appsess?.terminate();
        break;
      }

      case Node.Worker.msgTypeMap.sendRestResponse: {
        let appsess = this.server.appSessions[msg.sid];
        if (appsess)
          appsess.handleSendResponseMsg(msg);
        else
          this.log("WARN", "Can't send REST response: session not found", "Worker.handleAppChildMessage", msg);
        break;
      }

      case Node.Worker.msgTypeMap.watchdogResponse:
        if (this.watchdog) {
          this.watchdog.lastTick = new Date();
          //
          // First reply: child has finished booting, switch from startup grace to steady-state threshold
          this.watchdog.started = true;
        }
        //
        // Handle event loop utilization if provided
        if (msg.cnt)
          this.handleEventLoopStatus(msg.cnt);
        break;

      case Node.Worker.msgTypeMap.sync:
        this.handleSync(msg);
        break;

      case Node.Worker.msgTypeMap.syncBroad:
        this.handleSyncBroad(msg);
        break;

      case Node.Worker.msgTypeMap.cloudConnectorMsg:
        this.user.handleCloudConnectorMessage(msg.cnt, this);
        break;

      case Node.Worker.msgTypeMap.createDB:
        this.handleCreateDBMsg(msg);
        break;

      case Node.Worker.msgTypeMap.cTokenOp: {
        let appsess = this.server.appSessions[msg.sid];
        appsess?.handleCTokenOpMsg(msg);
        break;
      }

      case Node.Worker.msgTypeMap.installResult:
        if (this.installPromise) {
          let {resolve, reject} = this.installPromise;
          delete this.installPromise;
          //
          // Resolve promise attached at the beginning of the install method (see Worker::installApp)
          msg.cnt.err ? reject(new Error(msg.cnt.err)) : resolve(msg.cnt.appinfo);
        }
        else
          this.log("WARN", "Can't handle install result message: no promise", "Worker.handleAppChildMessage", msg);
        break;

      case Node.Worker.msgTypeMap.testStartResult:
        if (this.app.testAuto && msg.cnt && this.app.testAuto[msg.cnt.testAutoId])
          this.app.testAuto[msg.cnt.testAutoId].handleUpdateSchemaResult(msg.cnt);
        break;

      case Node.Worker.msgTypeMap.serverSession:
        this.handleServerSessionMsg(msg);
        break;

      case Node.Worker.msgTypeMap.changedAppParam:
        this.app.handleChangedAppParamMsg(msg.cnt);
        break;

      case Node.Worker.msgTypeMap.dtt: {
        // Send the message to the right app session
        let appsess = this.server.appSessions[msg.sid];
        if (appsess)
          appsess.sendDttMessage(msg);
        else
          this.log("WARN", "Can't process DTT request: session not found", "Worker.handleAppChildMessage", msg);
        break;
      }

      case Node.Worker.msgTypeMap.log:
        this.log(msg.level, msg.message, msg.sender, msg.data);
        break;

      case Node.Worker.msgTypeMap.deleteTraceFilesResult: {
        if (!this.app.deleteTraceFilesPromise)
          return this.log("WARN", "Can't handle delete trace result message: no promise", "Worker.handleAppChildMessage", msg);
        //
        let {resolve, reject} = this.app.deleteTraceFilesPromise;
        delete this.app.deleteTraceFilesPromise;
        //
        msg.err ? reject(msg.err) : resolve();
        break;
      }

      case Node.Worker.msgTypeMap.getStatusResult:
        if (this.statusResultPromise) {
          let {resolve, timeout} = this.statusResultPromise;
          clearTimeout(timeout);
          delete this.statusResultPromise;
          //
          resolve(msg.cnt);      // Resolve promise attached inside the getStatus method
        }
        else
          this.log("WARN", "Can't handle status result message: no promise", "Worker.handleAppChildMessage", msg);
        break;

      case Node.Worker.msgTypeMap.notifyFeedbackToConsole:
        this.app.handleFeedbackMsgToConsole(msg);
        break;

      case Node.Worker.msgTypeMap.evalResult:
        if (msg.cnt.error)
          this.log("WARN", `Error while executing EVAL: ${msg.cnt.error}`, "Worker.handleAppChildMessage", msg);
        break;

      case Node.Worker.msgTypeMap.serverStatus:
        this.handleServerStatus(msg);
        break;

      default:
        this.log("WARN", "Unhandled message", "Worker.handleAppChildMessage", msg);
        break;
    }
  }


  /**
   * Ingests an event-loop utilization sample sent by the child alongside a
   * `watchdogResponse` and maintains the two-tier retention window.
   *
   * Retention strategy:
   * - `lastHour`: raw 5-second samples, kept for 60 minutes
   *   (up to ~720 entries).
   * - `previous23Hours`: 1-minute averages, kept for 23 hours
   *   (up to 1380 entries). Aggregation is **time-based**, not count-based:
   *   samples are accumulated until their time span reaches 60 s.
   *
   * When a sample reports utilization above 80%, logs a WARN — at most once
   * per minute — so that a sustained overload is signalled without flooding
   * the log.
   * @param {Object} elu - Event loop metrics (`{utilization, ...}`)
   */
  handleEventLoopStatus(elu)
  {
    if (!elu)
      return;
    //
    let now = new Date();
    //
    // Initialize storage if needed
    if (!this.eluStorage) {
      this.eluStorage = {
        lastHour: [],           // 5-second samples for last hour
        previous23Hours: [],    // 1-minute averages for previous 23 hours
        minuteAccumulator: []   // Temporary accumulator for current minute
      };
    }
    //
    // Save current ELU for getStatus()
    this.eventLoopUtilization = elu;
    //
    // Add to last hour (5-second samples) - only utilization
    this.eluStorage.lastHour.push({
      timestamp: now,
      utilization: elu.utilization
    });
    //
    // Calculate average utilization over last minute (after adding new sample)
    this.calculateLastMinuteAverage();
    //
    // Keep only last hour
    let oneHourAgo = now - 3600000;
    while (this.eluStorage.lastHour.length > 0 && this.eluStorage.lastHour[0].timestamp < oneHourAgo) {
      // Move oldest sample from lastHour to minuteAccumulator for aggregation
      let oldSample = this.eluStorage.lastHour.shift();
      this.eluStorage.minuteAccumulator.push(oldSample);
    }
    //
    // Aggregate minute samples based on time elapsed (not count)
    // Check if we have at least 1 minute of data to aggregate
    if (this.eluStorage.minuteAccumulator.length > 0) {
      let firstSample = this.eluStorage.minuteAccumulator[0];
      let lastSample = this.eluStorage.minuteAccumulator[this.eluStorage.minuteAccumulator.length - 1];
      let timeSpan = lastSample.timestamp - firstSample.timestamp;
      //
      // If we have at least 1 minute of samples, aggregate them
      if (timeSpan >= 60000) {
        let utilization = this.eluStorage.minuteAccumulator.reduce((sum, s) => sum + s.utilization, 0);
        //
        this.eluStorage.previous23Hours.push({
          timestamp: new Date(firstSample.timestamp),
          utilization: utilization / this.eluStorage.minuteAccumulator.length,
          sampleCount: this.eluStorage.minuteAccumulator.length  // For debugging
        });
        this.eluStorage.minuteAccumulator = [];
        //
        // Keep only 23 hours of minute averages (1380 samples = 23 * 60)
        if (this.eluStorage.previous23Hours.length > 1380)
          this.eluStorage.previous23Hours.shift();
      }
    }
    //
    // Log warning if utilization is critically high (max once per minute)
    if (elu.utilization > 0.8) {
      let lastWarning = this.eluStorage.lastWarning || 0;
      let timeSinceLastWarning = now - lastWarning;
      //
      if (timeSinceLastWarning > 60000) {  // 60 seconds
        this.eluStorage.lastWarning = now;
        this.log("WARN", `Event loop heavily loaded (${(elu.utilization * 100).toFixed(1)}%)`, "Worker.handleEventLoopStatus", {
          utilization: elu.utilization,
          workerIdx: this.app.workers.indexOf(this),
          pid: this.child?.pid
        });
      }
    }
  }


  /**
   * Computes the average event-loop utilization over the last 60 seconds and
   * stores it in `lastMinuteAvgUtilization` along with the sample count.
   *
   * Special cases:
   * - No history at all → `undefined` (nothing to scale against yet).
   * - History present but no samples in the last minute → `1.0`: the worker
   *   is assumed blocked/frozen, so the scheduler avoids assigning fresh
   *   sessions to it.
   */
  calculateLastMinuteAverage()
  {
    if (!this.eluStorage || this.eluStorage.lastHour.length === 0) {
      this.lastMinuteAvgUtilization = undefined;
      return;
    }
    //
    let now = new Date();
    let oneMinuteAgo = now - 60000;
    let sum = 0;
    let count = 0;
    //
    // Calculate average from samples in last minute
    for (let i = this.eluStorage.lastHour.length - 1; i >= 0; i--) {
      let sample = this.eluStorage.lastHour[i];
      if (sample.timestamp < oneMinuteAgo)
        break;
      //
      sum += sample.utilization;
      count++;
    }
    //
    // If we have samples, calculate average
    if (count > 0) {
      this.lastMinuteAvgUtilization = sum / count;
      this.lastMinuteSampleCount = count;
    }
    else {
      // No samples in last minute = worker is probably blocked/frozen
      // Assume 100% utilization to avoid assigning new sessions
      this.lastMinuteAvgUtilization = 1.0;
      this.lastMinuteSampleCount = 0;
    }
  }


  /**
   * Relays a `sync` message coming from the child to the right session's
   * `syncSocket`. When the payload requests a disconnect the socket is
   * closed, otherwise the message is re-emitted on the `sync` channel.
   * Logs a WARN and drops the message if the session or the sync socket are
   * no longer around.
   * @param {Object} msg - Sync message (`{sid:{sidsrv}, cnt:{id, ...}}`)
   */
  handleSync(msg)
  {
    let session = this.server.appSessions[msg.sid.sidsrv];
    if (!session)
      return this.log("WARN", "Can't handle SYNC message: session not found", "Worker.handleSync", msg);
    //
    if (!session.syncSocket)
      return this.log("WARN", "Can't handle SYNC message: socket disconnected", "Worker.handleSync", msg);
    //
    if (msg.cnt.id === "disconnect")
      session.syncSocket.disconnect();
    else
      session.syncSocket.emit("sync", msg);
  }


  /**
   * Fans out a `syncBroad` message to the current app **and** to every
   * extra app listed in `msg.cnt.relApps`. For each target app, forwards
   * the payload to every worker's child process. Missing apps are logged
   * and skipped.
   * @param {Object} msg - Broadcast sync message (`{cnt:{relApps?, ...}}`)
   */
  handleSyncBroad(msg)
  {
    // Check if there are other apps to which I have to dispatch the message
    let appNames = [this.app.name, ...(msg.cnt.relApps || [])];
    //
    // Build the payload without the relApps field (relays shouldn't re-fan-out)
    let cnt = {...msg.cnt};
    delete cnt.relApps;
    //
    for (let a = 0; a < appNames.length; a++) {
      let app = this.user.getApp(appNames[a]);
      if (!app) {
        this.log("WARN", `Can't dispatch message to app ${appNames[a]}: app not found`, "Worker.handleSyncBroad", msg);
        continue;
      }
      //
      for (let i = 0; i < app.workers.length; i++)
        app.workers[i].sendToChild({
          type: Node.Worker.msgTypeMap.syncBroad,
          cnt
        });
    }
  }


  /**
   * Creates a user database on behalf of the child process and reports the
   * outcome back via `createDBresult`. A "Database already exists" error is
   * treated as success (idempotent), every other failure is logged and
   * forwarded. If the child has died in the meantime, the result is just
   * logged since there is nobody left to receive it.
   * @param {Object} msg - Create-DB request (`{dbname}`)
   */
  async handleCreateDBMsg(msg)
  {
    // Create the database for worker's user
    let err;
    try {
      await this.user.createDatabase(msg.dbname);
    }
    catch (e) {
      // It's an error only if the error is not "the DB already exists"
      if (e.message !== "Database already exists") {
        this.log("WARN", `Can't create database: ${e}`, "Worker.handleCreateDBMsg", {dbname: msg.dbname});
        err = e;
      }
    }
    //
    // Report to callee
    if (this.child)    // The child could be dead if it crashed some time ago...
      this.child.send({
        type: Node.Worker.msgTypeMap.createDBresult,
        dbname: msg.dbname,
        err
      });
    else
      this.log("WARN", "Child process is dead -> can't send create DB result", "Worker.handleCreateDBMsg", {dbname: msg.dbname, err});
  }


  /**
   * Handles server-session commands coming from the child process. The
   * supported verbs are:
   * - `start`: spawns a new server session with the given name (or warns if
   *   a session with that name already exists);
   * - `stop`: terminates the named server session;
   * - `running`: replies with a `serverSessionCB` `appmsg` carrying
   *   `{cbId, running}` so the caller can find out whether the session is alive.
   * @param {Object} msg - Server-session request (`{cnt:{cmd, name, request, sid?, cbId?}}`)
   */
  handleServerSessionMsg(msg)
  {
    let name = msg.cnt.name;
    let request = msg.cnt.request;
    let ss = this.app.getServerSession(name);
    //
    switch (msg.cnt.cmd) {
      case "start":
        if (ss)
          return this.log("WARN", "Can't start server session: session with same name already exists", "Worker.handleServerSessionMsg", msg);
        //
        this.app.startServerSession(name, request);
        break;

      case "stop":
        if (!ss)
          return this.log("WARN", "Can't stop server session: session not found", "Worker.handleServerSessionMsg", msg);
        //
        ss.terminate();
        break;

      case "running":
        this.sendToChild({
          type: Node.AppSession.msgTypeMap.appmsg,
          sid: msg.cnt.sid,
          request,
          content: [{
            id: "serverSessionCB",
            content: {
              cbId: msg.cnt.cbId,
              running: !!ss
            },
            master: true
          }]
        });
        break;
    }
  }


  /**
   * Finds a session owned by this worker by its `name` property.
   * @param {String} name - Session name to look up
   * @returns {Node.AppSession|undefined} Matching session, or `undefined` if none
   */
  getServerSession(name)
  {
    return this.sessions.find(s => s.name === name);
  }


  /**
   * Starts the child-process watchdog. Every 5 seconds the worker pings the
   * child with `watchdogRequest`; if no `watchdogResponse` has been observed
   * for more than 30 seconds the child is considered stuck and killed with
   * `SIGKILL`. Before the first reply the threshold is raised to 120 seconds:
   * large apps may take longer than 30s to complete their initial boot, and
   * we want to kill them only if startup truly stalls. If a previous watchdog
   * was running it is stopped first.
   * While the worker is already scheduled for death (`killWorkerTimer` set),
   * the watchdog keeps its `lastTick` current to avoid a false positive.
   */
  startWatchDog()
  {
    // If there was a previous watchdog, kill it
    this.stopWatchDog();
    //
    // Check process every 5 seconds. Steady-state threshold is 30s; before the first
    // watchdogResponse arrives we grant a 120s startup grace so large apps can finish booting.
    this.watchdog = {
      lastTick: new Date(),
      started: false,
      intervalID: setInterval(() => {
        // If I'm already dying, do nothing but refreshing the watchdog lastTick (no sessions means no one can me stuck)
        if (this.killWorkerTimer) {
          this.watchdog.lastTick = new Date();
          return;
        }
        //
        // If the elapsed time exceeded
        let dt = (new Date() - this.watchdog.lastTick);
        let threshold = this.watchdog.started ? 30000 : 120000;
        if (dt > threshold) {
          this.log("WARN", `Child did not answer for ${threshold / 1000}sec -> killing it`, "Worker.startWatchDog");
          //
          // Kill the child (brute force)
          this.killChild(true);
          //
          // Stop the watchdog
          this.stopWatchDog();
          return;
        }
        //
        // If the child is still here, check if is alive and kicking
        if (this.child)
          this.sendToChild({
            type: Node.Worker.msgTypeMap.watchdogRequest
          });
      }, 5000)
    };
  }


  /**
   * Stops the watchdog interval started by {@link Node.Worker#startWatchDog}
   * and clears the internal state. Safe to call when no watchdog is running.
   */
  stopWatchDog()
  {
    // If the watchdog was enabled stop its interval
    if (this.watchdog?.intervalID)
      clearInterval(this.watchdog.intervalID);
    //
    delete this.watchdog;
  }


  /**
   * Returns the current load of the worker, measured as the number of
   * sessions bound to it. Used by the scheduler to pick the least-loaded
   * worker when creating a new session.
   * @returns {Number} Session count
   */
  getLoad()
  {
    return this.sessions.length;
  }


  /**
   * Creates a new {@link Node.AppSession} bound to this worker, registers it
   * in both the worker's list and the server-global `appSessions` map (so
   * routing by SID works), and cancels any pending idle-death timer on this
   * worker so it is not killed between the two steps.
   * @returns {Node.AppSession} The freshly created session
   */
  createNewSession()
  {
    // If this worker was dying (see Worker::deleteSession), stop the death timer
    if (this.killWorkerTimer) {
      clearTimeout(this.killWorkerTimer);
      delete this.killWorkerTimer;
    }
    //
    // Create a new session
    let session = new Node.AppSession(this);
    this.sessions.push(session);
    //
    // Add this session to the "global" session map in the server
    // (so that he can route all connections to this session)
    this.server.appSessions[session.id] = session;
    //
    // Log the operation
    this.log("DEBUG", "Created app session", "Worker.createNewSession", {sid: session.id});
    //
    return session;
  }


  /**
   * Removes a session from the worker and from the server-global map.
   * When the worker is left empty, schedules its own deletion via
   * `app.deleteWorker` after `options.idleTimeout` ms (default 5 s) so a
   * short-lived burst of activity does not keep spawning and killing
   * children. Logs a WARN if the session was not in this worker.
   * @param {Node.AppSession} session - Session to delete
   */
  deleteSession(session)
  {
    this.log("DEBUG", "Delete worker session", "Worker.deleteSession", {sid: session.id});
    //
    // Remove the session from my session list
    let idx = this.sessions.indexOf(session);
    if (idx === -1)
      return this.log("WARN", "Session not found", "Worker.deleteSession", {sid: session.id});
    //
    this.sessions.splice(idx, 1);
    //
    // Delete the session from the server global map
    delete this.server.appSessions[session.id];
    //
    // If there are no more sessions in this worker, delete it after 10 seconds
    if (this.getLoad() === 0) {
      let killTimeout = (this.options ? this.options.idleTimeout : 0) || 5000;      // default: 5 sec
      //
      this.log("DEBUG", "Worker is empty", "Worker.deleteSession", {killTimeout: killTimeout});
      this.killWorkerTimer = setTimeout(() => {
        this.log("DEBUG", "Worker is empty and timeout expired -> delete it", "Worker.deleteSession", {killTimeout: killTimeout});
        this.app.deleteWorker(this);
      }, killTimeout);
    }
  }


  /**
   * Sends a `terminate` IPC message to the child process, asking it to shut
   * the app down gracefully. The child is expected to flush its state and
   * disconnect; this method does not force-kill it. No-op with a WARN log
   * when the child is already gone.
   * @param {Object} [options] - Termination options forwarded to the child (`{force, timeout, msg}`)
   */
  terminate(options)
  {
    if (this.child)
      this.child.send({
        type: Node.Worker.msgTypeMap.terminate,
        options
      });
    else
      this.log("WARN", "Worker has no child: can't send TERMINATE", "Worker.terminate");
  }


  /**
   * Sends an IPC message to the worker's child process. Logs a WARN and
   * drops the message if the child is not alive.
   * @param {Object} msg - Message to deliver to the child
   */
  sendToChild(msg)
  {
    if (this.child)
      this.child.send(msg);
    else
      this.log("WARN", "Can't send message: worker's child is gone", "Worker.sendToChild", msg);
  }


  /**
   * Returns a status snapshot of the worker. The basic reply carries
   * `{sessions}` (count) plus an optional `hibernated` flag. When the caller
   * passes `?full` in the query string, the reply is extended with:
   * - an array of session SIDs (zombie sessions are flagged with ` (-)`);
   * - the worker's `options`;
   * - `childSessions`: the session list as seen by the child, obtained via
   *   a `getStatus` IPC call with a 30-second timeout (resolves with an
   *   empty list on timeout);
   * - `pid` of the child process;
   * - `eventLoop`: the ELU telemetry block (`current`, `lastHour`,
   *   `previous23Hours`).
   *
   * On FreeBSD / Linux also reports per-process `cpuLoad` by running `ps`
   * or `top`; on Windows this field is omitted.
   * @param {Object} params - Command parameters (honours `params.req.query.full`)
   * @returns {Promise<Object>} Status object as described above
   */
  async getStatus(params)
  {
    let stat = {
      sessions: this.sessions.length
    };
    //
    // If I'm hibernated, inform callee
    if (this.hibernated)
      stat.hibernated = true;
    //
    // If a FULL status is requested, replace sessions count with an array of SIDs
    if (params.req.query.full) {
      stat.options = this.options;
      //
      stat.sessions = [];
      for (let i = 0; i < this.sessions.length; i++) {
        let session = this.sessions[i];
        //
        // If not online, flag it as "zombie"
        let online = (session.masterAppClient || session.syncSocket || session.restReq || session.name === "_default");
        stat.sessions.push(session.id + (online ? "" : " (-)"));
      }
      stat.sessions.sort();
    }
    //
    // If I've no child, I've nothing more to say
    if (!this.child)
      return stat;
    //
    // If a FULL status is requested, get child sessions count
    if (params.req.query.full) {
      // Ask my child the sessions count
      let childStatus = await new Promise((resolve, reject) => {
        let timeout = setTimeout(() => {
          delete this.statusResultPromise;
          resolve({sessions: []});
        }, 30000);
        this.statusResultPromise = {resolve, timeout};
        this.child.send({
          type: Node.Worker.msgTypeMap.getStatus
        });
      });
      //
      stat.childSessions = childStatus.sessions;
    }
    //
    // Add child's PID
    stat.pid = this.child.pid;
    //
    // Add event loop utilization metrics if available
    if (this.eluStorage) {
      stat.eventLoop = {
        current: this.eventLoopUtilization,
        lastHour: this.eluStorage.lastHour,
        previous23Hours: this.eluStorage.previous23Hours
      };
    }
    //
    // On Windows there is nothing I can add
    if (/^win/.test(process.platform))   // windows
      return stat;
    //
    let logData;
    try {
      // Add more info (per-process CPU load)
      if (process.platform === "freebsd") {   // freebsd
        try {
          let stdout = await new Promise((resolve, reject) => {
            Node.child.execFile("/bin/ps", ["-o", "pcpu", "-p", this.child.pid], (err, stdout, stderr) => {
              if (err)
                reject(new Error(stderr || err.message || err));
              else
                resolve(stdout);
            });
          });
          stat.cpuLoad = stdout.split("\n")[1];   // Remove headers
        }
        catch (err) {
          throw new Error(`Error getting the CPU load: ${err.message || err}`, {cause: err});
        }
      }
      else if (process.platform === "linux") {   // linux
        let stdout;
        try {
          stdout = await new Promise((resolve, reject) => {
            Node.child.execFile("/usr/bin/top", ["-b", "-n", "1"], (err, stdout, stderr) => {
              // If the child is gone
              if (!err && !this.child)
                err = stderr = "child process is gone";
              //
              if (err)
                reject(new Error(stderr || err.message || err));
              else
                resolve(stdout);
            });
          });
        }
        catch (err) {
          throw new Error(`Error getting the CPU load: ${err.message || err}`, {cause: err});
        }
        //
        stdout = stdout.split("\n").slice(4);   // Remove headers
        for (let i = 0; i < stdout.length; i++) {
          // Search right PID
          let procstat = stdout[i].trim().split(/\s+/);
          if (parseInt(procstat[0]) === this.child.pid) {
            stat.cpuLoad = procstat[7].replace("%", "");
            break;
          }
        }
        //
        // Ok... I haven't found it... on Alpine I've a problem if PID gets too big...
        // It moves stuff away...
        //   PID  PPID USER     STAT   VSZ %VSZ CPU %CPU COMMAND
        //    41     8 postgres S     162m   2%   1   0% postgres: autovacuum launcher process
        // 35179562093990 root     S     493m   7%   0   5% node /mnt/disk/IndeRT/server/server.js
        // I have to get the line that "starts" with the given PID
        for (let i = 0; i < stdout.length && !stat.cpuLoad; i++) {
          // Search right PID
          let procstat = stdout[i].trim().split(/\s+/);
          if (procstat[0].startsWith(this.child.pid)) {
            stat.cpuLoad = procstat[7].replace("%", "");
            break;
          }
        }
        //
        if (!stat.cpuLoad) {
          logData = {pid: this.child.pid};
          throw new Error("Error getting the CPU load. PID not found");
        }
      }
      //
      stat.cpuLoad = parseFloat(stat.cpuLoad);
    }
    catch (err) {
      this.log("ERROR", err.message || err, "Worker.getStatus", logData);
      stat.cpuLoad = err.message || err;
    }
    //
    return stat;
  }


  /**
   * Replies to a `serverStatus` request coming from the child by forwarding
   * the global server info (via `config.getStatus().serverInfo`) wrapped in
   * a `serverStatusResult` message. On error the exception is returned in
   * the `error` field of the reply instead of the `status` one.
   * @param {Object} msg - Server-status request (`{cnt:{sid, cbId}}`)
   */
  async handleServerStatus(msg)
  {
    let response = {
      type: Node.Worker.msgTypeMap.serverStatusResult,
      cnt: {
        sid: msg.cnt.sid,
        cbId: msg.cnt.cbId
      }
    };
    //
    try {
      let status = await this.server.config.getStatus({
        req: {
          query: {}
        }
      });
      response.cnt.status = status.serverInfo;
    }
    catch (err) {
      response.cnt.error = err.message || err;
    }
    //
    this.sendToChild(response);
  }
};


// Export module
module.exports = Node.Worker;
