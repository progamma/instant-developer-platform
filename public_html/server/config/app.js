/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
var Node = Node || {};

// Import modules
Node.fs = require("fs");
Node.ncp = require("../ncp_fixed");
Node.path = require("path");

// Import classes
Node.Worker = require("../master/worker");
Node.Archiver = require("../archiver");
Node.Utils = require("../utils");
Node.TestAuto = require("../master/testauto");
Node.AppSession = require("../master/appsession");


/**
 * @class Node.App
 * @classdesc
 * Represents an Instant Developer installed application in the server configuration.
 * Manages the complete lifecycle of an application including installation, updates,
 * worker processes, sessions, and resource management.
 *
 * Key features:
 * - **Worker Management**: Creates and manages multiple worker processes for load balancing
 * - **Session Handling**: Routes and manages user sessions across workers
 * - **Installation/Updates**: Handles app deployment, updates, and rollback operations
 * - **Backup/Restore**: Provides backup and restore capabilities for applications
 * - **Server Sessions**: Manages persistent server-side sessions for background tasks
 * - **DTT Integration**: Handles debug and trace file management
 * - **Parameter Management**: Manages application configuration parameters
 * - **Test Automation**: Provides test automation capabilities for the application
 *
 * @property {Node.User} parent - Parent user object that owns this app
 * @property {Array<Node.Worker>} workers - Array of worker processes for this app
 * @property {String} name - Application name
 * @property {String} version - Application version
 * @property {String} date - Application build date
 * @property {Boolean} stopped - Whether the app is stopped
 * @property {Boolean} updating - Whether the app is currently updating
 * @property {Boolean} startSS - Whether to start default server session
 * @property {Number} maxAppUsers - Maximum users this app can handle
 * @property {Number} minAppUsersPerWorker - Minimum users per worker before creating new worker
 * @property {Number} maxAppWorkers - Maximum number of workers allowed
 * @property {Object} customWorkerConf - Custom worker configuration
 * @property {Object} params - Application parameters
 * @property {Object} testAuto - Test automation instances
 */
Node.App = class App
{
  /**
   * @param {Node.User} par - Parent user object
   */
  constructor(par)
  {
    this.parent = par;
    //
    this.workers = [];
  }


  /**
   * Gets the parent user object that owns this app.
   * @type {Node.User}
   * @readonly
   */
  get user()
  {
    return this.parent;
  }


  /**
   * Gets the server instance through the parent chain.
   * @type {Node.Server}
   * @readonly
   */
  get server()
  {
    return this.parent.parent.parent;
  }


  /**
   * Gets the configuration object through the parent chain.
   * @type {Node.Config}
   * @readonly
   */
  get config()
  {
    return this.parent.parent;
  }


  /**
   * Gets the logger instance from the server.
   * @type {Node.Logger}
   * @readonly
   */
  get logger()
  {
    return this.server.logger;
  }


  /**
   * Gets the folder where {@link Node.App#backupToDisk} writes the copy of the app that
   * {@link Node.App#restoreFromDisk} reads back.
   * @type {String}
   * @readonly
   */
  get backupPath()
  {
    return Node.path.join(this.config.appDirectory, "backups", this.name);
  }


  /**
   * Gets the folder where {@link Node.App#restore} parks the live app while the archive is extracted.
   * Deliberately outside `apps`: that backup survives a failed cleanup, and anything sitting in `apps`
   * is read as an installed application (it is a full copy of the app folder, node_modules symlink
   * included, so every content-based filter takes it for one), while `backups` is where the copies of
   * this app already live.
   * @type {String}
   * @readonly
   */
  get restoreBackupPath()
  {
    return Node.path.join(this.config.appDirectory, "backups", `${this.name}.$$$`);
  }


  /**
   * Gets the folder where a restore done before {@link Node.App#restoreBackupPath} parked the app
   * outside `apps` left its backup: the `.$$$` sibling of the app folder. Nothing writes it any more,
   * but an installation that already has one keeps it until a restore or an uninstall collects it.
   * @type {String}
   * @readonly
   */
  get legacyRestoreBackupPath()
  {
    return Node.path.join(this.config.appDirectory, "apps", `${this.name}.$$$`);
  }


  /**
   * Gets the archive the app exchanges with the cloud: {@link Node.App#restore} downloads it and
   * {@link Node.App#backup} builds it to upload, and both name it after the app folder, so it is a
   * sibling of it. Either can leave it behind: the restore when its own cleanup fails, the backup on
   * any failure once the archive exists — a compression that stops halfway, an upload that does not
   * go through, the final removal that fails.
   * @type {String}
   * @readonly
   */
  get cloudArchivePath()
  {
    return Node.path.join(this.config.appDirectory, "apps", `${this.name}.tar.gz`);
  }


  /**
   * Gets the folder where {@link Node.App#install} extracts the package before copying it onto the
   * app. It is a sibling of the app folder, and {@link Node.Config#listInstalledApps} leaves its
   * suffix out: a temporary folder that survives its own cleanup must never be read as an
   * installed application.
   * @type {String}
   * @readonly
   */
  get installTempPath()
  {
    return Node.path.join(this.config.appDirectory, "apps", `${this.name}.tmp`);
  }


  /**
   * Logs a message with app context information.
   * Enriches log data with app name and username before delegating to the logger.
   * @param {String} level - Log level (DEBUG, INFO, WARN, ERROR)
   * @param {String} message - Log message text
   * @param {String} sender - Function or module that generated the log
   * @param {Object} [data] - Additional structured data to include in the log
   */
  log(level, message, sender, data)
  {
    // Add "local" info
    data = {
      ...data,
      app: this.name,
      user: this.user.userName
    };
    //
    this.logger.log(level, message, sender, data);
  }


  /**
   * Serializes the app object for persistence.
   * Returns a plain object with essential app properties for saving to configuration.
   * @returns {Object} Serialized app object with class name and configuration properties
   */
  save()
  {
    return {
      cl: "Node.App",
      name: this.name,
      version: this.version,
      date: this.date,
      stopped: this.stopped,
      startSS: this.startSS,
      maxAppUsers: this.maxAppUsers,
      minAppUsersPerWorker: this.minAppUsersPerWorker,
      maxAppWorkers: this.maxAppWorkers,
      customWorkerConf: this.customWorkerConf
    };
  }


  /**
   * Deserializes and loads app configuration from a saved object.
   * Restores app properties from a previously serialized configuration.
   * @param {Object} v - Serialized app object containing configuration data
   * @param {String} v.name - Application name
   * @param {String} v.version - Application version
   * @param {String} v.date - Application build date
   * @param {Boolean} v.stopped - Whether app is stopped
   * @param {Boolean} v.startSS - Whether to start server session
   * @param {Number} [v.maxAppUsers] - Maximum users
   * @param {Number} [v.minAppUsersPerWorker] - Minimum users per worker
   * @param {Number} [v.maxAppWorkers] - Maximum workers
   * @param {Object} [v.customWorkerConf] - Custom worker configuration
   */
  load(v)
  {
    this.name = v.name;
    this.version = v.version;
    this.date = v.date;
    this.stopped = v.stopped;
    this.startSS = v.startSS;
    if (v.maxAppUsers)
      this.maxAppUsers = v.maxAppUsers;
    if (v.minAppUsersPerWorker)
      this.minAppUsersPerWorker = v.minAppUsersPerWorker;
    if (v.maxAppWorkers)
      this.maxAppWorkers = v.maxAppWorkers;
    if (v.customWorkerConf)
      this.customWorkerConf = v.customWorkerConf;
  }


  /**
   * Sets the parent object and loads application parameters.
   * Establishes parent relationship and loads app parameters from the private directory.
   * Parameters are loaded synchronously to ensure availability before starting server sessions.
   * @param {Node.User} p - Parent user object to set
   */
  setParent(p)
  {
    this.parent = p;
    //
    // Load parameters file
    let filename = Node.path.join(this.config.appDirectory, "apps", this.name, "files", "private", "app_params.json");
    //
    // I need to do it synchronously because I need to do it before starting the ServerSession (if enabled)
    if (Node.fs.existsSync(filename)) {
      let json = Node.fs.readFileSync(filename);
      if (json.length) {
        try {
          this.params = JSON.parse(json);
        }
        catch (ex) {
          // Corrupt parameters file: don't let it crash app startup. Treat it as "no params"
          // (they'll be rewritten valid on the next saveParameters call).
          this.log("WARN", `Invalid JSON in app_params.json, ignored: ${ex.message}`, "App.setParent", {filename});
        }
      }
    }
  }


  /**
   * Initializes a new app with the given name.
   * Sets up initial properties for a freshly created app instance.
   * @param {String} name - Name to assign to the app
   */
  initApp(name)
  {
    this.name = name;
    this.version = "";
  }


  /**
   * Creates a new application session and assigns it to an appropriate worker.
   * Implements load balancing across workers based on configuration parameters and
   * worker utilization. Creates new workers when needed up to the maximum limit.
   * @param {Object} [options] - Options for session routing
   * @param {String} [options.type="web"] - Session type (web, ss, etc.)
   * @param {String} [options.query] - Query string for custom worker configuration matching
   * @returns {Node.AppSession} The newly created app session, or undefined if max users reached
   */
  createNewSession(options)
  {
    // Uses 3 config parameters:
    //   "maxAppUsers": indicates how many users this app can handle
    //   "minAppUsersPerWorker": indicates the minimum number of users that a worker can handle before the system needs a new worker
    //   "maxAppWorkers": maxmimum number of workers
    let maxAppUsers = this.maxAppUsers || this.config.maxAppUsers;
    let minAppUsersPerWorker = this.minAppUsersPerWorker || this.config.minAppUsersPerWorker;
    let maxAppWorkers = this.maxAppWorkers || this.config.maxAppWorkers;
    //
    // Handle optional options
    options = options || {};
    options.type = options.type || "web";
    //
    // Check if a custom app worker configuration applies
    let wrkConf = {type: "*"};    // Default server/app configuration: type:ANY, query:NONE
    if (this.customWorkerConf) {
      for (let i = 0; i < this.customWorkerConf.length; i++) {
        let conf = this.customWorkerConf[i];
        //
        // If the configuration has nothing to do with what callee asked for
        if (conf.type !== options.type)
          continue;
        //
        // If the configuration is specific to a particular query string
        if (conf.query && (!options.query || !options.query.includes(conf.query)))
          continue;
        //
        // Found it! Use this custom configuration settings (if given)
        maxAppUsers = conf.maxAppUsers || maxAppUsers;
        minAppUsersPerWorker = conf.minAppUsersPerWorker || minAppUsersPerWorker;
        maxAppWorkers = conf.maxAppWorkers || maxAppWorkers;
        //
        wrkConf = conf;     // Custom configuration
        break;
      }
    }
    //
    // Choose the worker that will handle the new user
    let worker;
    //
    // Locate the worker that have that has less users (i.e. the unloaded one)
    // and, while doing that, check if there are too many users for this worker type
    let minload, numUsers = 0;
    for (let i = 0; i < this.workers.length; i++) {
      let wrk = this.workers[i];
      //
      if (wrk.hibernated)
        continue; // Skip hibernated workers
      //
      // If this worker is not what I'm looking for -> skip it
      if (JSON.stringify(wrk.options) !== JSON.stringify(wrkConf))
        continue;   // Wrong options
      //
      let wrkload = wrk.getLoad();
      //
      // If event loop utilization is too high (>70%), skip this worker
      if (wrk.lastMinuteAvgUtilization > 0.7) {
        this.log("DEBUG", "Worker skipped (high ELU)", "App.createNewSession", {
          workerIdx: i,
          utilization: wrk.lastMinuteAvgUtilization,
          sessions: wrkload
        });
        continue;
      }
      //
      if (minload === undefined || wrkload < minload) {
        minload = wrkload;
        worker = wrk;
      }
      //
      // Compute total worker-type load (i.e. the sum of all sessions for all workers of wkrConf type)
      numUsers += wrkload;
    }
    //
    // First check if this app can handle this new user
    if (numUsers >= maxAppUsers) {
      this.log("DEBUG", "Too many users", "App.createNewSession",
              {options, wrkConf, numUsers});
      return;   // Too many users
    }
    //
    // If I've found a worker but it has already too many users and I can create new workers
    let numwrk = this.workers.filter(w => !w.hibernated).length;
    if (worker?.getLoad() >= minAppUsersPerWorker && numwrk < maxAppWorkers)
      worker = undefined;   // Create a new worker
    //
    // If I haven't found one, create a new worker
    if (!worker) {
      worker = new Node.Worker(this);
      this.workers.push(worker);
      //
      // Remember worker's options
      worker.options = wrkConf;
      //
      this.log("DEBUG", "Worker created", "App.createNewSession",
              {workerIdx: this.workers.indexOf(worker), options, wrkConf});
    }
    else
      this.log("DEBUG", "Reuse worker", "App.createNewSession",
              {workerIdx: this.workers.indexOf(worker), options, wrkConf});
    //
    // Ask the worker I've found/created to create a new session
    return worker.createNewSession();
  }


  /**
   * Retrieves a server session by its name.
   * Searches across all workers for a server session with the specified name.
   * @param {String} name - Name of the server session to find
   * @returns {Node.AppSession} The found server session, or undefined if not found
   */
  getServerSession(name)
  {
    for (let i = 0; i < this.workers.length; i++) {
      let s = this.workers[i].getServerSession(name);
      if (s)
        return s;
    }
  }


  /**
   * Starts a new server session with the specified name.
   * Creates a server-side session for background tasks and processing.
   * Prevents duplicate sessions with the same name.
   * @param {String} name - Unique name for the server session
   * @param {Object} request - Request object containing initialization parameters
   * @returns {Node.AppSession} The created server session, or undefined if name already exists
   */
  startServerSession(name, request)
  {
    // Check if a session with same name already exists
    if (this.getServerSession(name))
      return this.log("WARN", "Can't start server session: session with same name already exists",
              "App.startServerSession", {name, request});
    //
    let ss = this.createNewSession({type: "ss"});
    //
    // If a session can't be created -> do nothing
    if (!ss)
      return this.log("WARN", "Session can't be created: too many users", "App.startServerSession", {name});
    //
    ss.name = name;
    //
    // If I haven't done it yet create the physical process for the worker
    if (!ss.worker.child)
      ss.worker.createChild();
    //
    // Route this message to the child
    ss.sendToChild({
      type: Node.AppSession.msgTypeMap.appmsg,
      sid: ss.id,
      content: [{
        id: "onStart",
        name,
        content: {},
        master: true
      }],
      request
    });
    //
    return ss;
  }


  /**
   * Starts the default server session for the application.
   * Creates a persistent "_default" server session and sets up automatic restart
   * if the session terminates unexpectedly. Only starts if startSS is enabled.
   */
  startDefaultServerSession()
  {
    if (!this.startSS)
      return;
    //
    this.startServerSession("_default", {});
    //
    // Periodically check if the default server session dies... if so, restart it
    if (!this.defaultSStimeoutID)
      this.defaultSStimeoutID = setInterval(() => {
        // If the app is updating or stopped, wait...
        if (this.updating || this.stopped)
          return;
        //
        let s = this.getServerSession("_default");
        if (!s) {
          this.log("WARN", "Default server session evaporated -> start a new one", "App.startDefaultServerSession");
          this.startDefaultServerSession();   // Resurrect default server session
        }
      }, 5000);
  }


  /**
   * Stops the default server session for the application.
   * Terminates the "_default" server session and clears the automatic restart timer.
   * Only operates if startSS is enabled.
   */
  stopDefaultServerSession()
  {
    if (!this.startSS)
      return;
    //
    this.getServerSession("_default")?.terminate();
    //
    // Stop default server session interval
    if (this.defaultSStimeoutID) {
      clearInterval(this.defaultSStimeoutID);
      delete this.defaultSStimeoutID;
    }
  }


  /**
   * Removes a worker from the workers array and terminates its child process.
   * Gracefully attempts to kill the worker's child process, with forced termination
   * after 3 seconds if the process doesn't end normally.
   * @param {Node.Worker} worker - Worker instance to delete
   */
  deleteWorker(worker)
  {
    let idx = this.workers.indexOf(worker);
    if (idx === -1)
      return this.log("WARN", "Worker not found", "App.deleteWorker");
    //
    this.workers.splice(idx, 1);
    //
    // If the worker has a child, kill him
    if (worker.child) {
      // Kill the child
      worker.killChild();
      //
      // If the child does not end normally, I'll (forcedly) kill him in 3 seconds
      setTimeout(() => {
        if (worker.child && worker.child.connected) {
          this.log("WARN", "Worker did not quit in 3 seconds -> killing him", "App.deleteWorker", {workerIdx: idx});
          worker.killChild(true);
        }
      }, 3000);
      //
      // Log the operation
      this.log("DEBUG", "Worker deleted", "App.deleteWorker", {workerIdx: idx});
    }
    else
      this.log("WARN", "Can't delete worker: worker child not found (was killed before?)", "App.deleteWorker", {workerIdx: idx});
  }


  /**
   * Sends an install message to the application child process.
   * Creates a temporary worker to execute the installation and receive app information.
   * The worker is terminated after installation completes.
   * @param {Object} options - Installation options
   * @param {Boolean} [options.updateDB] - Whether to update database schema
   * @param {Object} [options.appParams] - Application parameters
   * @returns {Promise<Object>} Installation result containing app info
   * @throws {Error} If installation fails or child process dies
   */
  async sendInstallToApp(options)
  {
    // Create a dummy worker so that I can send install to app
    let worker = new Node.Worker(this);
    //
    // Store a promise in the worker so that it will be called when install is completed
    try {
      let result = await new Promise((resolve, reject) => {
        worker.installPromise = {resolve, reject};
        //
        // Create the worker and tell him that the app have to be installed
        worker.createChild();
        worker.stopWatchDog();  // I don't need it
        worker.child.send({
          type: Node.Worker.msgTypeMap.install,
          cnt: options
        });
      });
      //
      if (!worker.child)
        throw new Error("Child process is dead");
      //
      return result;
    }
    finally {
      // Terminate the worker (N.B.: the worker has no sessions, it's just a dummy process...
      // then I have to kill it directly!)
      worker.child?.kill();
    }
  }


  /**
   * Retrieves the current status of the application.
   * Includes app info, running status, version, and disk usage statistics.
   * @param {Object} params - Status request parameters
   * @returns {Promise<Object>} Response with app status
   * @throws {Error} If unable to retrieve disk usage
   */
  async getStatus(params)
  {
    let status = {
      name: this.name,
      version: this.version,
      date: this.date,
      params: this.params,
      ideVersion: await this.getLinkedIdeVersion()
    };
    if (this.stopped)
      status.status = "stopped";
    else if (this.updating)
      status.status = "updating";
    else
      status.status = "running";
    //
    // Get the size of the app directory
    let path = Node.path.join(this.config.appDirectory, "apps", this.name);
    let cmd, cmdParams;
    if (!/^win/.test(process.platform)) {   // linux
      cmd = "/usr/bin/du";
      cmdParams = ["-sh", path];
    }
    else {  // windows
      cmd = "cmd";
      cmdParams = ["/c", "powershell", `(Get-ChildItem -Path "${path.replace(/\//g, "\\")}" -Recurse | Measure-Object -Property Length -Sum).Sum`];      // Inside "cmd /c" command / are not allowed
    }
    //
    let stdout;
    try {
      stdout = await this.server.execFileAsRoot(cmd, cmdParams);
    }
    catch (err) {
      this.log("ERROR", `Error getting the size of app folder: ${err.message || err}`, "App.getStatus", {path});
      throw new Error(`Error getting the size of app folder: ${err.message || err}`, {cause: err});
    }
    //
    let size;
    if (!/^win/.test(process.platform))    // linux
      size = stdout.split("\t")[0];
    else {
      stdout = stdout.split("\r\n");        // Convert into array
      size = stdout[0];
    }
    switch (size.slice(-1)) {
      case "K":
        size = Math.ceil(parseFloat(size) * 1024);
        break;
      case "M":
        size = Math.ceil(parseFloat(size) * 1024 * 1024);
        break;
      case "G":
        size = Math.ceil(parseFloat(size) * 1024 * 1024 * 1024);
        break;
    }
    //
    status.diskSize = size;
    return status;
  }


  /**
   * Retrieves the list of all active sessions for this application.
   * Includes detailed information about workers and their sessions.
   * @param {Object} params - Sessions request parameters
   * @returns {Promise<Object>} Response with total session count and worker details
   */
  async getSessions(params)
  {
    // Reply:
    //  sessions: {total number of sessions}
    //  workers: [{worker 1 details}, {worker 2  details}, ...]}  (see worker::getStatus)
    let sessions = {sessions: 0, workers: []};
    //
    // Add worker's details
    for (let wrk of this.workers) {
      // Compute total app sessions (by adding worker's count)
      sessions.sessions += wrk.sessions.length;
      //
      // Add worker status
      sessions.workers.push(await wrk.getStatus(params));
    }
    //
    return sessions;
  }


  /**
   * Retrieves and sends the list of DTT (Debug Trace Tool) sessions.
   * Includes both live and offline sessions, with filtering based on app parameters.
   * Reads session data from index files and merges with live session information.
   * @param {Object} params - DTT sessions request parameters
   * @param {Object} params.req - Request object
   * @param {String} [params.req.query.fromDate] - Filter sessions updated after this date
   * @returns {Promise<Object>} Response with DTT session list
   * @throws {Error} If unable to read DTT index files
   */
  async getDttSessions(params)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Deletes DTT sessions older than the specified date.
   * Purges trace files and index entries for sessions before the cutoff date.
   * Uses live workers when available, or directly purges for inactive workers.
   * @param {Object} params - Delete parameters
   * @param {Object} params.req - Request object
   * @param {String} params.req.query.beforeDate - Delete sessions before this date
   * @throws {Error} If beforeDate is missing or deletion fails
   */
  async deleteDttSessions(params)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Starts the application after installation or when manually started.
   * Sends install message to verify app integrity, updates configuration,
   * and starts the default server session if configured.
   * @param {Object} params - Start parameters
   * @throws {Error} If app fails to start
   */
  async start(params)
  {
    try {
      // Send "install" message to app and wait for reply
      await this.sendInstallToApp({updateDB: false});
    }
    catch (err) {
      this.log("WARN", `Error while starting the app: ${err.message || err}`, "App.start");
      throw new Error(`Error while starting the app: ${err.message || err}`, {cause: err});
    }
    //
    // App is started -> save config
    this.updating = false;
    this.stopped = false;
    await this.config.saveConfig();
    //
    // If needed, start app's server session
    this.startDefaultServerSession();
    //
    // Log the operation
    this.log("INFO", "Application started", "App.start");
  }


  /**
   * Stops the application without terminating sessions.
   * Sets the stopped flag, saves configuration, and stops the default server session.
   * Existing sessions continue running but new sessions are prevented.
   * @param {Object} params - Stop parameters
   */
  async stop(params)
  {
    // App is stopped -> save config
    this.stopped = true;
    await this.config.saveConfig();
    //
    // If needed, stop app's server session
    this.stopDefaultServerSession();
    //
    // Log the operation
    this.log("INFO", "Application stopped", "App.stop");
  }


  /**
   * Terminates the application and all its workers and sessions.
   * Sends termination messages to all workers and waits for graceful shutdown.
   * Forces termination after 30 seconds if workers don't stop normally.
   * @param {Object} params - Termination parameters
   * @param {Object} [params.req] - Request object
   * @param {Boolean} [params.req.query.force] - Force immediate termination
   * @param {Number} [params.req.query.timeout] - Grace period before forced termination
   * @param {String} [params.req.query.msg] - Message to show users before termination
   */
  async terminate(params)
  {
    let waitWorkersStart = new Date();
    let timeout = 30000;
    //
    // Tell all workers to terminate
    let options = {
      force: params.req?.query.force,
      timeout: params.req?.query.timeout,
      msg: params.req?.query.msg
    };
    this.log("DEBUG", "Send terminate to all workers", "App.terminate");
    //
    for (let i = 0; i < this.workers.length; i++)
      this.workers[i].terminate(options);
    //
    // Wait for all workers to end
    while (this.workers.length) {
      // If the workers did not stop in timeout ms -> error
      if (new Date() - waitWorkersStart > timeout) {
        this.log("WARN", `Workers did not stop in ${timeout / 1000} seconds`, "App.terminate", {workersLeft: this.workers.length});
        //
        // Delete all workers still alive (if they don't die smothly they will be killed)
        for (let worker of this.workers)
          this.deleteWorker(worker);
        //
        break;
      }
      //
      // Wait 500 ms before checking again
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    //
    // Done. All worker terminated
    this.log("DEBUG", "All workers have been terminated", "App.terminate");
  }


  /**
   * Hibernates all workers to prevent accepting new sessions.
   * Sets all workers to hibernated state and stops the default server session.
   * Used during quiet installations to avoid disrupting existing sessions.
   */
  hibernateWorkers()
  {
    // Server session must be stoped
    this.stopDefaultServerSession();
    //
    for (let i = 0; i < this.workers.length; i++)
      this.workers[i].hibernated = true;
  }


  /**
   * Gets the IDE version the app's node_modules symlink points to, i.e. the version whose modules
   * the app actually runs with on a multi-version server.
   * @returns {Promise<String>} The linked version, or undefined (shared modules or own node_modules folder)
   */
  async getLinkedIdeVersion()
  {
    try {
      let target = await Node.fs.promises.readlink(Node.path.join(this.config.appDirectory, "apps", this.name, "node_modules"));
      return (target.match(/ide_([0-9A-Za-z.-]+)[\/\\]node_modules$/) || [])[1];
    }
    catch (err) {
      // No node_modules symlink inside the app: shared modules or app's own folder
    }
  }


  /**
   * Links the app to the node_modules of the requested IDE version (issue #7571).
   * The ideVersion query parameter wins: the Console orchestrates installs and re-links (e.g. after
   * the fix of a version, the app is reinstalled declaring the new one). The buildInfo.json stamped
   * into the package at build time is the fallback when nothing is declared; without either, the app
   * is linked to the highest installed version with a warning.
   * The link is a node_modules symlink at the app root: module resolution walks up from
   * server/app.js and finds it before the appDirectory-level link to the shared server modules.
   * No-op on single-version servers (the app keeps resolving the shared node_modules).
   * A requested/declared version that is not installed falls back to the highest installed one
   * (with a WARN): the Console gate is the primary barrier, the server stays resilient.
   * @param {Object} params - Request context
   * @param {Request} params.req - Express request; `req.query.ideVersion` declares the version to link
   */
  async linkIdeVersion(params)
  {
    if (!this.config.isMultiVersion())
      return;
    //
    let appPath = Node.path.join(this.config.appDirectory, "apps", this.name);
    //
    // Read the version stamped at build time (missing in packages built by older IDE versions)
    let declared;
    try {
      declared = (await Node.Utils.loadObject(Node.path.join(appPath, "server", "buildInfo.json")) || {}).ideVersion;
    }
    catch (err) {
      // Corrupt buildInfo in the package: same as not declared
    }
    //
    // The requested version wins over the declared one (a fix reinstall links the same package to
    // the fixed version); trace the divergence, so a wrong declaration is visible in the logs
    let version = params.req.query.ideVersion || declared;
    if (declared && params.req.query.ideVersion && declared !== params.req.query.ideVersion)
      this.log("WARN", `The app declares IDE version ${declared} but ${version} was requested -> linking to ${version}`, "App.linkIdeVersion", {declared, version});
    //
    if (version && !this.config.isIdeVersionInstalled(version)) {
      this.log("WARN", `The app requires IDE version ${version}, which is not installed -> linking to the highest installed`, "App.linkIdeVersion", {version});
      version = undefined;
    }
    else if (!version)
      this.log("WARN", "The app package doesn't declare its build IDE version -> linking to the highest installed", "App.linkIdeVersion");
    //
    if (!version)
      version = this.config.getHighestIdeVersion();
    //
    // (Re)create the link (an update may change the build version). If the app ships a real
    // node_modules folder of its own, respect it: that's an even stronger isolation than the link
    let link = Node.path.join(appPath, "node_modules");
    let linkStat;
    try {
      linkStat = await Node.fs.promises.lstat(link);
    }
    catch (err) {
      // No node_modules in the app folder: first link
    }
    if (linkStat && !linkStat.isSymbolicLink()) {
      this.log("INFO", "The app ships its own node_modules folder -> not linked", "App.linkIdeVersion");
      return;
    }
    if (linkStat)
      await Node.fs.promises.rm(link, {force: true});
    await Node.fs.promises.symlink(Node.path.join(Node.Utils.ideVersionDir(version), "node_modules"), link, "dir");
    //
    this.log("INFO", `App linked to the node_modules of IDE version ${version}`, "App.linkIdeVersion", {version});
  }


  /**
   * Installs or updates the application from a cloud package.
   * Handles the complete installation process including backup, extraction, database updates,
   * and rollback on failure. Supports both new installations and updates of existing apps.
   * @param {Object} params - Installation parameters
   * @param {Object} params.req - Request object
   * @param {String} params.req.query.file - Cloud path to installation package
   * @param {String} [params.req.query.quiet] - If "true", hibernate workers instead of terminating
   * @param {String} [params.req.query.updateDB] - If "true", update database schema
   * @throws {Error} If installation fails, with automatic rollback attempt
   */
  async install(params)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Completely uninstalls the application from the server.
   * Terminates all sessions, removes app directory, backups and leftovers, and unregisters from
   * configuration.
   * This operation is irreversible.
   * @param {Object} params - Uninstall parameters
   * @throws {Error} If uninstall fails at any stage
   */
  async uninstall(params)
  {
    try {
      // First terminate all sessions
      try {
        // force TERMINATE
        params.req.query.force = true;
        await this.terminate(params);
      }
      catch (err) {
        throw new Error(`Can't terminate the app: ${err.message || err}`, {cause: err});
      }
      //
      // Remove app directory
      try {
        await Node.fs.promises.rm(Node.path.join(this.config.appDirectory, "apps", this.name), {recursive: true, force: true});
      }
      catch (err) {
        throw new Error(`Can't delete app folder: ${err.message || err}`, {cause: err});
      }
      //
      // Remove app backups (if any)
      try {
        await Node.fs.promises.rm(this.backupPath, {recursive: true, force: true});
      }
      catch (err) {
        throw new Error(`Can't delete backup folder: ${err.message || err}`, {cause: err});
      }
      //
      // Collect what carries the app name without being the app: the backup Archiver.restore parks
      // aside, in the two places it can be (where it goes now, and the `.$$$` sibling inside apps left
      // by a restore done before that move), the archive exchanged with the cloud, and the temporary
      // folder of an installation. Best-effort: it is garbage, and its removal must not fail the
      // uninstall
      for (let leftover of [this.restoreBackupPath, this.legacyRestoreBackupPath, this.cloudArchivePath, this.installTempPath]) {
        try {
          await Node.fs.promises.rm(leftover, {recursive: true, force: true});
        }
        catch (err) {
          this.log("WARN", `Error deleting the leftover ${leftover}: ${err.message || err}`, "App.uninstall");
        }
      }
      //
      // Tell the user to delete this app
      await this.user.deleteApp(this);
      //
      // Log the operation
      this.log("INFO", "App deleted", "App.uninstall");
    }
    catch (err) {
      this.log("WARN", err.message || err, "App.uninstall");
      throw err;
    }
  }


  /**
   * Updates the application's database schema.
   * Sends an install message with updateDB flag to trigger schema migration.
   * @param {Object} params - Update parameters
   * @throws {Error} If database update fails
   */
  async updateDBschema(params)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Handles application parameter changes and propagates them to all workers.
   * Updates the parameter in memory and optionally saves to disk.
   * Notifies all active workers about the parameter change.
   * @param {Object} msg - Parameter change message
   * @param {String} msg.par - Parameter name
   * @param {*} msg.old - Previous value
   * @param {*} msg.new - New value (undefined to delete)
   * @param {Boolean} [skipSave=false] - If true, skip saving to params.json file
   */
  async handleChangedAppParamMsg(msg, skipSave)
  {
    // Get the new parameter
    this.params = this.params || {};
    if (msg.new !== undefined)
      this.params[msg.par] = msg.new;
    else
      delete this.params[msg.par];
    //
    // Tell it to every session in every worker
    for (let i = 0; i < this.workers.length; i++) {
      let wrk = this.workers[i];
      //
      // Skip "dead" workers (i.e. workers with no child process)
      if (!wrk.child)
        continue;
      //
      wrk.child.send({
        type: Node.Worker.msgTypeMap.changedAppParam,
        cnt: msg
      });
    }
    //
    // If I don't need to save, I've done my job
    if (skipSave)
      return;
    //
    // Save parameters to disk
    clearTimeout(this.saveParamsTimer);
    this.saveParamsTimer = setTimeout(async () => {
      try {
        await this.saveParameters();
      }
      catch (err) {
        this.log("ERROR", `Can't update app parameters: ${err.message || err}`, "App.handleChangedAppParamMsg", msg);
      }
    }, 100);
  }


  /**
   * Persists application parameters to disk.
   * Saves non-volatile parameters to app_params.json file in the private directory.
   * Volatile parameters (enableDtt, logDttQueries) are excluded from persistence.
   */
  async saveParameters()
  {
    // If params is empty, forget about it
    let par;
    if (Object.keys(this.params).length === 0)
      delete this.params;
    else {
      // Delete volatile parameters (so that they won't be saved on disk)
      par = Object.assign({}, this.params);
      delete par.enableDtt;
      delete par.logDttQueries;
      //
      // If, beside volatile parameters, there is nothing left, don't save
      if (Object.keys(par).length === 0)
        par = undefined;
    }
    //
    // Save parameter file
    let filename = Node.path.join(this.config.appDirectory, "apps", this.name, "files", "private", "app_params.json");
    await Node.Utils.saveObject(filename, par);
  }


  /**
   * Creates a local backup of the application on disk.
   * Copies app folders (server, client, resources) to the backups directory.
   * Previous backup is deleted before creating a new one.
   * @param {Object} params - Backup parameters
   * @throws {Error} If backup creation fails
   */
  async backupToDisk(params)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Restores the application from a local disk backup.
   * Deletes current app folders and replaces them with backed up versions.
   * Only works if a backup exists in the backups directory.
   * @param {Object} params - Restore parameters
   * @throws {Error} If no backup exists or restore fails
   */
  async restoreFromDisk(params)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Creates a cloud backup of the application.
   * Archives the app directory and uploads it to cloud storage (S3).
   * @param {Object} params - Backup parameters
   * @param {Object} [params.req] - Request object
   * @param {String} [params.req.query.path] - Custom cloud path for backup
   * @throws {Error} If backup to cloud fails
   */
  async backup(params)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Restores the application from a cloud backup.
   * Downloads and extracts the app archive from cloud storage (S3). A restore that succeeds also
   * collects the leftover backup of a restore done before {@link Node.App#restoreBackupPath}.
   * @param {Object} params - Restore parameters
   * @param {Object} [params.req] - Request object
   * @param {String} [params.req.query.path] - Custom cloud path of backup
   * @throws {Error} If restore from cloud fails
   */
  async restore(params)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Handles file system operations for app files.
   * Delegates file operations to the Utils.handleFileSystem with proper path mapping.
   * Supports list, get, put, del, copy, and move operations on app files.
   * @param {Object} params - File system command parameters
   * @param {Object} params.req - Request object
   * @param {String} [params.req.query.path] - Relative path within app files directory
   * @param {Array} params.tokens - Command tokens array
   * @returns {Promise<Object>} Operation result from Utils.handleFileSystem
   */
  async handleFileSystem(params)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Collects and sends feedback messages to the console.
   * Batches feedback messages and sends them to the console in chunks of 100
   * with a 2-minute delay to avoid overwhelming the console API.
   * @param {Object} msg - Feedback message
   * @param {Object} msg.cnt - Feedback content to send to console
   */
  handleFeedbackMsgToConsole(msg)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Updates application configuration settings via web commands.
   * Modifies various app settings including name, version, worker configuration,
   * parameters, and operational flags. Saves configuration after successful updates.
   * @param {Object} params - Configuration parameters
   * @param {Object} params.req - Request object
   * @param {Object} params.req.query - Query parameters with configuration settings
   * @throws {Error} If no properties specified or configuration update fails
   */
  async configure(params)
  {
    // Compute the array of properties provided via url
    let query = params.req.query;
    //
    this.log("INFO", "Update app settings", "App.configure", query);
    //
    let logData;
    let warning = false;
    try {
      let queryProps = Object.getOwnPropertyNames(query);
      if (queryProps.length === 0) {
        warning = true;
        throw new Error("No property specified");
      }
      //
      if (query.name) {
        // Everything named after the app has to follow it: the disk backup is read back by name, so
        // one left behind is both wasted space and a backup that restoreFromDisk no longer finds, and
        // the leftovers are collected by name too. All these paths derive from this.name, so the same
        // list read before and after the rename gives the source and the destination of each
        let oldPaths = [this.backupPath, this.restoreBackupPath, this.legacyRestoreBackupPath, this.cloudArchivePath, this.installTempPath];
        try {
          await Node.fs.promises.rename(Node.path.join(this.config.appDirectory, "apps", this.name), Node.path.join(this.config.appDirectory, "apps", query.name));
          this.name = query.name;
        }
        catch (err) {
          logData = {newName: query.name};
          throw new Error(`Can't rename app: ${err.message}`, {cause: err});
        }
        //
        // Past this point the app is already renamed, and what is left are copies and garbage: a
        // failure here is logged and the configuration goes on
        let newPaths = [this.backupPath, this.restoreBackupPath, this.legacyRestoreBackupPath, this.cloudArchivePath, this.installTempPath];
        for (let i = 0; i < oldPaths.length; i++) {
          try {
            await Node.fs.promises.rename(oldPaths[i], newPaths[i]);
          }
          catch (err) {
            // Most apps have neither a backup nor a leftover
            if (err.code !== "ENOENT")
              this.log("WARN", `Can't rename ${oldPaths[i]} to ${newPaths[i]}: ${err.message || err}`, "App.configure");
          }
        }
      }
      if (query.version !== undefined)
        this.version = query.version || undefined;
      if (query.date !== undefined)
        this.date = query.date || undefined;
      if (query.stopped) {
        if (query.stopped === "false")
          this.stopped = false;
        else if (query.stopped === "true")
          this.stopped = true;
      }
      if (query.updating) {
        if (query.updating === "false")
          this.updating = false;
        else if (query.updating === "true")
          this.updating = true;
      }
      if (query.startSS) {
        if (query.startSS === "false" && this.startSS) {
          this.stopDefaultServerSession();
          this.startSS = false;
        }
        else if (query.startSS === "true" && !this.startSS) {
          this.startSS = true;
          this.startDefaultServerSession();
        }
      }
      if (query.maxAppUsers !== undefined)
        this.maxAppUsers = (query.maxAppUsers ? parseInt(query.maxAppUsers, 10) : undefined);
      if (query.minAppUsersPerWorker !== undefined)
        this.minAppUsersPerWorker = (query.minAppUsersPerWorker ? parseInt(query.minAppUsersPerWorker, 10) : undefined);
      if (query.maxAppWorkers !== undefined)
        this.maxAppWorkers = (query.maxAppWorkers ? parseInt(query.maxAppWorkers, 10) : undefined);
      if (query.customWorkerConf !== undefined) {
        try {
          this.customWorkerConf = (query.customWorkerConf ? JSON.parse(query.customWorkerConf) : undefined);
        }
        catch (err) {
          warning = true;
          logData = {customWorkerConf: query.customWorkerConf};
          throw new Error(`Invalid customWorkerConf setting: ${err.message || err}`, {cause: err});
        }
      }
      if (query.params !== undefined) {
        let newParams = {};
        if (query.params) {
          // Callee will send every time all parameters as an array of NAME=VALUE couples
          try {
            let paramsArray = JSON.parse(query.params);
            //
            // Change from
            //    ["par1=valuePar1", "par2=valuePar2", ...]
            // to
            //    {
            //     "par1": "valuePar1",
            //     "par2": "valuePar2",
            //    }
            for (let i = 0; i < paramsArray.length; i++) {
              let par = paramsArray[i].split("=");
              //
              let parName = par[0];
              let parValue = par.slice(1).join("=");
              //
              newParams[parName] = parValue;
            }
          }
          catch (err) {
            warning = true;
            logData = {newParams: query.params};
            throw new Error(`Can't update app parameters: ${err.message || err}`, {cause: err});
          }
        }
        else  // No parameters
          newParams = {};
        //
        // Create a new params object if needed
        this.params = this.params || {};
        //
        // Now check new parameters
        let saveParamFile = false;
        let parr = Object.keys(Object.assign({}, newParams, this.params));
        for (let i = 0; i < parr.length; i++) {
          let parName = parr[i];
          if (newParams[parName] === this.params[parName])
            continue;   // Value hasn't changed
          //
          // Value has changed -> tell every session that a parameter has changed
          await this.handleChangedAppParamMsg({par: parName, old: this.params[parName], new : newParams[parName]}, true);   // SkipSave
          //
          // Don't save volatile (i.e. non permanent) parameters
          if (!["enableDtt", "logDttQueries"].includes(parName))
            saveParamFile = true; // Params file should be saved at the end
        }
        //
        // Save param object
        if (saveParamFile) {
          try {
            await this.saveParameters();
          }
          catch (err) {
            logData = {params: this.params};
            throw new Error(`Can't update app parameters: ${err.message || err}`, {cause: err});
          }
        }
      }
      //
      // Save the new configuration
      await this.config.saveConfig();
      //
      // Log the operation
      this.log("INFO", "App settings updated", "App.configure");
    }
    catch (err) {
      this.log(warning ? "WARN" : "ERROR", err.message || err, "App.configure", logData);
      throw err;
    }
  }


  /**
   * Manages test automation sessions for the application.
   * Handles starting, status checking, and termination of test sessions.
   * Supports various test modes including recording, replay, non-regression, and load testing.
   * @param {Object} params - Test parameters
   * @param {Object} params.req - Request object with test configuration
   * @param {Object} params.res - Response object for redirects
   * @param {Array} params.tokens - Command tokens (status, terminate, etc.)
   * @returns {Object} Test operation result with code and message/error
   */
  test(params)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Retrieves a test automation instance by its ID.
   * @param {String} id - Test automation session ID
   * @returns {Node.TestAuto} The test automation instance, or null if not found
   */
  getTestById(id)
  {
    return this.testAuto ? this.testAuto[id] : null;
  }


  /**
   * Processes web API commands related to this application.
   * Entry point for all app-related commands, delegates to execCommand.
   * @param {Object} params - Command parameters
   * @returns {Promise<Object>} Command execution result
   */
  async processCommand(params)
  {
    return await this.execCommand(params);
  }


  /**
   * Executes specific commands for the application.
   * Routes commands to appropriate handler methods based on the command token.
   * Validates authorization key if enabled before executing commands.
   * @param {Object} params - Command execution parameters
   * @param {Array} params.tokens - Command tokens array
   * @param {Object} params.req - Request object
   * @returns {Promise<Object>} Command execution result
   * @throws {Object} Error object with code 401 if unauthorized
   * @throws {Error} If invalid command or execution fails
   */
  async execCommand(params)
  {
    let command = params.tokens[0];
    //
    this.config.checkAuthorization(params, "App.execCommand");
    //
    // Valid AUTK (or AUTK not enabled)
    switch (command) {
      case "status":
        return await this.getStatus(params);

      case "sessions":
        return await this.getSessions(params);

      case "dttsessions":
        return await this.getDttSessions(params);

      case "deletedttsessions":
        return await this.deleteDttSessions(params);

      case "start":
        return await this.start(params);

      case "stop":
        return await this.stop(params);

      case "terminate":
        return await this.terminate(params);

      case "install":
        return await this.install(params);

      case "uninstall":
        return await this.uninstall(params);

      case "backup":
        return await this.backup(params);

      case "restore":
        return await this.restore(params);

      case "updatedbschema":
        return await this.updateDBschema(params);

      case "filesystem":
        return await this.handleFileSystem(params);

      case "config":
        return await this.configure(params);

      case "test":
        return this.test(params);

      default:
        this.log("WARN", "Invalid Command", "App.execCommand", {cmd: command, url: params.req.originalUrl});
        throw new Error("Invalid Command");
    }
  }
};


// Export module
module.exports = Node.App;
