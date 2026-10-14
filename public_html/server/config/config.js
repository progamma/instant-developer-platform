/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
var Node = Node || {};

// Import Modules
Node.fs = require("fs");
Node.mime = require("mime-types");
Node.ncp = require("../ncp_fixed");
Node.multiparty = require("multiparty");
Node.path = require("path");
Node.child = require("child_process");
Node.os = require("os");
Node.dns = require("dns");

// Import Classes
Node.Utils = require("../utils");
Node.User = require("./user");
Node.Project = require("./project");
Node.Database = require("./database");
Node.App = require("./app");
Node.IdeVersion = require("./ideversion");
Node.Archiver = require("../archiver");


/**
 * @class Node.Config
 * @classdesc
 * Central configuration manager for the Instant Developer Cloud server.
 * Manages all server settings, user accounts, database connections, applications,
 * certificates, licenses, and system parameters. Provides a comprehensive API
 * for server administration and runtime configuration.
 *
 * Key features:
 * - **Configuration Persistence**: Saves and loads server configuration from disk
 * - **User Management**: Creates, manages, and authenticates user accounts
 * - **Application Management**: Handles installed applications and their lifecycle
 * - **License Management**: Manages product licenses and enforces limitations
 * - **SSL Certificates**: Configures and manages SSL certificates including Let's Encrypt
 * - **Database Connections**: Manages database configurations for projects
 * - **Server Updates**: Handles server software updates and package management
 * - **Backup & Restore**: Provides backup and restore capabilities for projects
 * - **System Monitoring**: Tracks server status and resource usage
 * - **Request Processing**: Routes and handles administrative API requests
 *
 * @property {Node.Server} parent - Reference to the parent server instance
 * @property {Array<Node.User>} users - Array of configured user accounts
 * @property {String} name - Server name/identifier
 * @property {String} domain - Server domain name
 * @property {String} protocol - Protocol (http/https)
 * @property {Number} port - Server port number
 * @property {Boolean} local - Whether running in local development mode
 * @property {Object} licdata - License information and restrictions
 * @property {Object} idfoptions - IDE/IDF configuration options
 * @property {Array<Node.Database>} databases - Configured database connections
 * @property {Array<Node.App>} apps - Installed applications
 * @property {String} [SSLCert] - Path to SSL certificate file
 * @property {String} [SSLKey] - Path to SSL private key file
 * @property {Array<String>} [SSLCABundles] - Paths to SSL CA bundle files
 * @property {Array<Object>} [customSSLCerts] - Custom SSL certificates for specific domains
 * @property {String} [serverToken] - Server authentication token
 * @property {Boolean} [isUpdating] - Flag indicating server update in progress
 * @property {Boolean} [customPackages] - Whether custom NPM packages are configured
 */
Node.Config = class Config
{
  /**
   * Mode of an update command on a multi-version server: which part(s) to update (`server`/`ide`/
   * `both`), or `legacy` to downgrade the server back to the flat single-version layout.
   * @enum {String}
   */
  static updateScope = {SERVER: "server", IDE: "ide", BOTH: "both", LEGACY: "legacy"};


  /**
   * Suffixes of the leftovers a failed restore/install cleanup can leave inside the apps folder:
   * entries ending with these are not applications.
   * @type {Array<String>}
   */
  static appLeftoverSuffixes = [".$$$", ".tmp", ".tar.gz"];


  /**
   * Result code the licSrv* operations return when the license server could not be reached or did
   * not answer as expected. It belongs to the same set the license server itself uses in the
   * ErrorCode of its answers, i.e. the `IDSLogErrors` enum the wizards read to turn a result code
   * into the message shown to the user (`ide/app/idf/Wizards/common/commondef.js`), where it is the
   * connection error. Any code outside that set falls back to a generic "unexpected error", which
   * tells the user nothing about what went wrong.
   * @type {Number}
   */
  static licSrvConnectionError = 9250;


  /**
   * Builds an error carrying an HTTP status code for a bad/unprocessable command request, so that
   * processCommand surfaces it to the Console with the right status instead of a generic 500 (a 500
   * would signal a server fault for what is a request-side condition). Use for request errors only
   * (missing/invalid parameters, state conflicts), never for internal faults, which stay 500.
   * @param {String} message - Error message
   * @param {Number} code - HTTP status code (400 bad parameters, 404 missing version, 409 state conflict, 503 busy)
   * @param {Error} [cause] - Original error to chain, when the request error wraps one
   * @returns {Error} The error, with its `code` set
   */
  static requestError(message, code, cause)
  {
    let err = new Error(message, cause ? {cause} : undefined);
    err.code = code;
    return err;
  }


  /**
   * @param {Node.Server} par - pointer to parent (server) object
   */
  constructor(par)
  {
    this.parent = par;
    this.users = [];
    this.ides = [];
    this.name = null;
    this.licdata = {
      guid: "00000000-0000-0000-0000-000000000000",
      name: "test",
      releasetype: 1,
      code: "EXPRESS",
      products: 0x0102, // C# e report
      maxtables: 20,
      maxversion: "",
      startdate: "",
      complist: "",
      enddate: "",
      lastcheck: 0
    };
    this.idfoptions = {
      AntBat: "",
      AntOpt: "",
      JavaHome: "",
      TomUrl: "localhost",
      TomPort: 8080,
      Tomcat: "",
      TomUserName: "admin",
      TomPassword: "",
      DotNetVer: 40,
      TomcatVer: 10,
      InDeServerURL: "http://www.progamma.com/INDEWS/INDEWS.asmx",
      InDeServerURLAlt: "http://www2.progamma.com/INDEWS/INDEWS.asmx",
      ShowAllIcons: true,
      InlineParams: true,
      UseAlwaysVCE: true,
      ContEditing: false,
      ColRes: "#0846c4",
      ColNorm: "#000000",
      ColConst: "#C00060",
      ColComm: "#007000",
      ColError: "#FF0000",
      ColWarning: "#008040",
      ColGrid: "#F8F8F8",
      ColSelection: "#FFFFAA",
      ColCut: "#E0E0E0",
      ColBlock: "#A0A0A0",
      ColBack: "#FFFFFF",
      ColQuery: "#F0F0F0",
      ColHilight: "#FFFFAA",
      ColCtx: "#EAF1FB",
      ColWaterMark: "#808080",
      AutoComments: false,
      ShowObjDescr: true,
      ReuseView: false,
      NumColumns: 80,
      AutoColumns: true,
      FontSize: "12",
      FontName: "Courier New",
      IdsTheme: "-1",
      IdsVividIcons: "0",
      IdsTreeSize: "normal",
      DocLang: "ITA",
      IdsRestoreUI: "0",
      IdsTempDir: ""
    };
  }


  /**
   * Gets the parent server instance.
   * @type {Node.Server}
   * @readonly
   */
  get server()
  {
    return this.parent;
  }


  /**
   * Gets the server's logger instance for logging messages.
   * @type {Node.Logger}
   * @readonly
   */
  get logger()
  {
    return this.server.logger;
  }


  /**
   * Serializes the configuration object for persistence.
   * Prepares configuration data for saving by collecting all relevant properties
   * and removing sensitive runtime data like SSL certificate contents.
   * @returns {Object} Serialized configuration object ready for storage
   */
  save()
  {
    let r = {
      cl: "Node.Config",
      name: this.name,
      domain: this.domain,
      protocol: this.protocol,
      alias: this.alias,
      serverType: this.serverType,
      portHttp: this.portHttp,
      portHttps: this.portHttps,
      SSLCert: this.SSLCert,
      SSLKey: this.SSLKey,
      SSLCABundles: this.SSLCABundles,
      customSSLCerts: this.customSSLCerts,
      directory: this.directory,
      auth: this.auth,
      editPrjToken: this.editPrjToken,
      consoleURL: this.consoleURL,
      exitUrl: this.exitUrl,
      configS3: this.configS3,
      bucketS3: this.bucketS3,
      configGCloudStorage: this.configGCloudStorage,
      bucketGCloud: this.bucketGCloud,
      nightlyBucketGCloud: this.nightlyBucketGCloud,
      storage: this.storage,
      customPackages: this.customPackages,
      dbPort: this.dbPort,
      dbAddress: this.dbAddress,
      dbUser: this.dbUser,
      dbPassword: this.dbPassword,
      googleAPIKey: this.googleAPIKey,
      timerSession: this.timerSession,
      recoveryTimeout: this.recoveryTimeout,
      timerTokenConsole: this.timerTokenConsole,
      handleException: this.handleException,
      minify: this.minify,
      timeBackup: this.timeBackup,
      daysBackups: this.daysBackups,
      numMinBackups: this.numMinBackups,
      numHoursSnapshot: this.numHoursSnapshot,
      numMaxSnapshot: this.numMaxSnapshot,
      timeSnapshot: this.timeSnapshot,
      appDirectory: this.appDirectory,
      defaultApp: this.defaultApp,
      services: this.services,
      maxAppUsers: this.maxAppUsers,
      minAppUsersPerWorker: this.minAppUsersPerWorker,
      maxAppWorkers: this.maxAppWorkers,
      lowDiskThreshold: this.lowDiskThreshold,
      responseHeaders: this.responseHeaders,
      corsOrigins: this.corsOrigins,
      params: this.params,
      users: this.users,
      ides: this.ides,
      flatVersion: this.flatVersion,
      licdata: this.licdata,
      idfoptions: this.idfoptions,
      devAgentApiKey: this.devAgentApiKey,
      devAgentDailyBudget: this.devAgentDailyBudget,
      turnConfig: this.turnConfig
    };
    //
    // Remove certificate's file content
    if (r.customSSLCerts) {
      // I want to keep it in memory... but I don't want to store it
      let oldcustomSSLCerts = r.customSSLCerts;
      r.customSSLCerts = [];
      //
      oldcustomSSLCerts.forEach(cert => {
        // Create a copy of the certificate and remove file's content
        let certClone = Object.assign({}, cert);
        delete certClone.SSLKey_data;
        delete certClone.SSLCert_data;
        delete certClone.SSLCABundles_data;
        delete certClone._secureContext;
        //
        r.customSSLCerts.push(certClone);
      });
    }
    //
    return r;
  }


  /**
   * Loads configuration data from a saved object.
   * Restores all configuration properties from a previously serialized configuration,
   * updating the current instance with the saved values.
   * @param {Object} v - The saved configuration object to load
   */
  load(v)
  {
    if (v.name)
      this.name = v.name;
    if (v.users)
      this.users = v.users;
    if (v.ides)
      this.ides = v.ides;
    if (v.flatVersion)
      this.flatVersion = v.flatVersion;
    if (v.auth)
      this.auth = v.auth;
    if (v.editPrjToken)
      this.editPrjToken = v.editPrjToken;
    if (v.timerSession)
      this.timerSession = v.timerSession;
    if (v.recoveryTimeout)
      this.recoveryTimeout = v.recoveryTimeout;
    if (v.timerTokenConsole)
      this.timerTokenConsole = v.timerTokenConsole;
    if (v.directory)
      this.directory = v.directory;
    if (v.configS3)
      this.configS3 = v.configS3;
    if (v.bucketS3)
      this.bucketS3 = v.bucketS3;
    if (v.configGCloudStorage)
      this.configGCloudStorage = v.configGCloudStorage;
    if (v.bucketGCloud)
      this.bucketGCloud = v.bucketGCloud;
    if (v.nightlyBucketGCloud)
      this.nightlyBucketGCloud = v.nightlyBucketGCloud;
    else if (v.nigthlybucketGCloud)  // TODO: remove once every deployment's config.json has been re-saved with the corrected key
      this.nightlyBucketGCloud = v.nigthlybucketGCloud;
    if (v.dbPort)
      this.dbPort = v.dbPort;
    if (v.dbAddress)
      this.dbAddress = v.dbAddress;
    if (v.dbUser)
      this.dbUser = v.dbUser;
    if (v.dbPassword)
      this.dbPassword = v.dbPassword;
    if (v.googleAPIKey)
      this.googleAPIKey = v.googleAPIKey;
    if (v.storage)
      this.storage = v.storage;
    if (v.customPackages)
      this.customPackages = v.customPackages;
    if (v.serverType)
      this.serverType = v.serverType;
    if (v.consoleURL)
      this.consoleURL = v.consoleURL;
    if (v.exitUrl)
      this.exitUrl = v.exitUrl;
    if (v.handleException)
      this.handleException = v.handleException;
    if (v.domain)
      this.domain = v.domain;
    if (v.protocol)
      this.protocol = v.protocol;
    if (v.alias)
      this.alias = v.alias;
    if (v.minify)
      this.minify = v.minify;
    if (v.SSLKey)
      this.SSLKey = v.SSLKey;
    if (v.SSLCert)
      this.SSLCert = v.SSLCert;
    if (v.SSLCABundles)
      this.SSLCABundles = v.SSLCABundles;
    if (v.customSSLCerts)
      this.customSSLCerts = v.customSSLCerts;
    if (v.portHttp)
      this.portHttp = v.portHttp;
    if (v.portHttps)
      this.portHttps = v.portHttps;
    if (v.timeBackup)
      this.timeBackup = v.timeBackup;
    if (v.numMinBackups)
      this.numMinBackups = v.numMinBackups;
    if (v.daysBackups)
      this.daysBackups = v.daysBackups;
    if (v.numHoursSnapshot)
      this.numHoursSnapshot = v.numHoursSnapshot;
    if (v.numMaxSnapshot)
      this.numMaxSnapshot = v.numMaxSnapshot;
    if (v.timeSnapshot)
      this.timeSnapshot = v.timeSnapshot;
    if (v.appDirectory)
      this.appDirectory = v.appDirectory;
    if (v.defaultApp)
      this.defaultApp = v.defaultApp;
    if (v.services)
      this.services = v.services;
    if (v.maxAppUsers)
      this.maxAppUsers = v.maxAppUsers;
    if (v.minAppUsersPerWorker)
      this.minAppUsersPerWorker = v.minAppUsersPerWorker;
    if (v.maxAppWorkers)
      this.maxAppWorkers = v.maxAppWorkers;
    if (v.lowDiskThreshold)
      this.lowDiskThreshold = v.lowDiskThreshold;
    if (v.responseHeaders)
      this.responseHeaders = v.responseHeaders;
    if (v.corsOrigins)
      this.corsOrigins = v.corsOrigins;
    if (v.params)
      this.params = v.params;
    if (v.local)
      this.local = true;
    if (v.licdata) {
      this.licdata = v.licdata;
      if (this.licdata.releasetype)
        this.licdata.releasetype = parseInt(this.licdata.releasetype) || 1;
    }
    if (v.idfoptions)
      this.idfoptions = v.idfoptions;
    if (v.devAgentApiKey)
      this.devAgentApiKey = v.devAgentApiKey;
    if (v.devAgentDailyBudget)
      this.devAgentDailyBudget = v.devAgentDailyBudget;
    if (v.turnConfig)
      this.turnConfig = v.turnConfig;
  }


  /**
   * Saves only the configuration properties, excluding child objects.
   * Creates a simplified version of the configuration with additional runtime
   * information like URL and version, suitable for sending to clients.
   * @returns {Object} Configuration properties without child objects
   */
  saveProperties()
  {
    let r = this.save();
    //
    // Delete children
    delete r.cl;
    delete r.users;
    delete r.ides;
    delete r.turnConfig;
    //
    // Add usefull properties
    r.url = this.getUrl();
    r.local = this.local;
    r.version = this.server.version || this.getIndeVersion();
    r.remoteDBurls = this.getRemoteDBUrls();
    //
    // Default values
    r.exitUrl = r.exitUrl || "https://www.instantdeveloper.com";
    //
    return r;
  }


  /**
   * Gets a map of all remote database URLs configured for users.
   * Scans all user databases and collects those with remote URLs configured.
   * @returns {Object} Map of database name to remote URL, or undefined if none exist
   */
  getRemoteDBUrls()
  {
    let remoteDBurls;
    for (let i = 0; i < this.users?.length; i++)
      for (let j = 0; j < this.users[i].databases?.length; j++) {
        let db = this.users[i].databases[j];
        if (!db.remoteUrl)
          continue;
        //
        remoteDBurls = remoteDBurls || {};
        remoteDBurls[db.name] = db.remoteUrl;
      }
    //
    return remoteDBurls;
  }


  /**
   * Builds the ICE servers list with TURN credentials (issue #12897).
   * With a "secret" the credentials are ephemeral, following the coturn REST API mechanism
   * (use-auth-secret): the username is the expiry unix timestamp and the credential is the
   * base64 HMAC-SHA1 of the username computed with the shared secret, so no static TURN
   * credential reaches the client. With "username"/"credential" the static credentials are
   * distributed as they are: transition mode for a coturn still using long-term credentials
   * (the secret takes precedence when both are present).
   * Requires a "turnConfig" section in config.json: {urls: [String], secret: String, ttl: Number}
   * (ttl in seconds, default 86400) or {urls: [String], username: String, credential: String}.
   * A single String is also accepted for "urls".
   * @returns {Array} ICE server entries as {urls, username, credential}, or null if no TURN server is configured
   */
  getIceServers()
  {
    // Tolerate a single URL string: a plain string would pass the length check and then crash on map
    let urls = this.turnConfig?.urls;
    if (typeof urls === "string")
      urls = [urls];
    if (!urls?.length)
      return null;
    //
    let username, credential;
    if (this.turnConfig.secret) {
      // Ephemeral credential: username = expiry timestamp, credential = HMAC-SHA1(secret, username)
      let crypto = require("crypto");
      let ttl = parseInt(this.turnConfig.ttl) || 86400;
      username = `${Math.floor(Date.now() / 1000) + ttl}:inde`;
      credential = crypto.createHmac("sha1", this.turnConfig.secret).update(username).digest("base64");
    }
    else if (this.turnConfig.username && this.turnConfig.credential) {
      // Transition mode: static credentials from config, delivered only to authenticated clients
      username = this.turnConfig.username;
      credential = this.turnConfig.credential;
    }
    else
      return null;
    //
    return urls.map(url => ({urls: url, username, credential}));
  }


  /**
   * Persists the complete configuration to the config.json file.
   * Concurrent calls are serialized: a write already running works on the state snapshotted at its
   * start, so a caller arriving meanwhile joins one queued follow-up write that starts right after
   * it. The returned promise settles when the write covering the caller's state has completed.
   * Write errors are logged and swallowed by default, since the many fire-and-forget callers must
   * not leak a rejection to the process-wide unhandledRejection handler (which kills the server);
   * a caller that needs the persistence guarantee passes rethrow (issue #16466).
   * @param {Boolean} [rethrow] - True to throw the write error instead of swallowing it
   * @throws {Error} When the write fails and rethrow is true
   */
  async saveConfig(rethrow)
  {
    // Start a write and free the slot when it settles (the promise resolves with the write error,
    // or undefined: it never rejects, see writeConfig)
    let startWrite = () => this.savingConf = this.writeConfig().finally(() => {
      delete this.savingConf;
    });
    //
    let save;
    if (!this.savingConf && !this.pendingSaveConf)
      save = startWrite();
    else {
      // Join the single follow-up write queued behind the running one (one follow-up covers every
      // caller that arrives while the current write is running). The pending check also covers the
      // window between a write settling (which frees the slot) and its queued follow-up starting:
      // a caller landing there must join the follow-up, not start a clashing write of its own
      save = this.pendingSaveConf = this.pendingSaveConf || this.savingConf.then(() => {
        delete this.pendingSaveConf;
        return startWrite();
      });
    }
    //
    let err = await save;
    if (err && rethrow)
      throw err;
  }


  /**
   * Performs one atomic write of the configuration to the config.json file (temp file + fsync +
   * backup rotation). Never throws: the write error is logged and returned, and it is
   * {@link Node.Config#saveConfig} — the only caller — that decides whether to surface it.
   * @returns {Promise<Error>} The write error, undefined when the write succeeded
   * @private
   */
  async writeConfig()
  {
    let configFile;
    if (this.local)
      configFile = Node.path.resolve(__dirname, "..", "config.json");
    else
      configFile = Node.path.resolve(__dirname, "..", "..", "..", "config", "config.json");
    //
    this.logger.log("INFO", "Config file save started", "Config.saveConfig");
    //
    let action;
    try {
      let docjson = JSON.stringify(this, (k, v) => {
        if (v instanceof Node.Config || v instanceof Node.User || v instanceof Node.Database || v instanceof Node.Project || v instanceof Node.App || v instanceof Node.IdeVersion)
          return v.save();
        else
          return v;
      });
      //
      // Write a new config file
      // Owner RW only
      action = `saving the CONFIG file (OPEN) ${configFile}.new`;
      let fd = await Node.fs.promises.open(`${configFile}.new`, "w", 0o600);
      //
      try {
        action = `saving the CONFIG file (WRITE) ${configFile}.new`;
        await Node.fs.promises.writeFile(fd, docjson);
        //
        action = `saving the CONFIG file (FSYNC) ${configFile}.new`;
        await fd.sync();
      }
      finally {
        action = `saving the CONFIG file (CLOSE) ${configFile}.new`;
        await fd.close();
      }
      //
      // Rotate the backup only when there is a config file to back up: after a write that died
      // between the two renames below, config.json is gone and the .bak is the ONLY surviving
      // configuration — removing it here would leave nothing loadConfig can read
      if (Node.fs.existsSync(configFile)) {
        // Everything went fine... Remove the old .BAK if present
        action = `removing the old CONFIG file ${configFile}.bak`;
        await Node.fs.promises.rm(`${configFile}.bak`, {force: true});
        //
        // Backup the config file into a .bak file
        action = `renaming the CONFIG file ${configFile} to ${configFile}.bak`;
        await Node.fs.promises.rename(configFile, `${configFile}.bak`);
      }
      //
      // Rename the .new into the final file
      action = `renaming the CONFIG file ${configFile}.new to ${configFile}`;
      await Node.fs.promises.rename(`${configFile}.new`, configFile);
      //
      this.logger.log("INFO", "Config file saved successfully", "Config.saveConfig");
    }
    catch (err) {
      this.logger.log("ERROR", `Error ${action}: ${err}`, "Config.saveConfig");
      return new Error(`Error ${action}: ${err.message || err}`, {cause: err});
    }
  }


  /**
   * Loads the complete configuration from the config.json file.
   * Deserializes the configuration tree and instantiates all child objects
   * including users, databases, projects, and applications.
   */
  async loadConfig()
  {
    let configFile;
    if (this.local)
      configFile = Node.path.resolve(__dirname, "..", "config.json");
    else
      configFile = Node.path.resolve(__dirname, "..", "..", "..", "config", "config.json");
    //
    let configTXT = await Node.fs.promises.readFile(configFile, {encoding: "utf8"});
    JSON.parse(configTXT, (k, v) => {
      if (v instanceof Object && v.cl !== undefined) {
        let obj;
        if (v.cl === "Node.Config")
          obj = this;
        if (v.cl === "Node.User")
          obj = new Node.User();
        if (v.cl === "Node.Database")
          obj = new Node.Database();
        if (v.cl === "Node.Project")
          obj = new Node.Project();
        if (v.cl === "Node.App")
          obj = new Node.App();
        if (v.cl === "Node.IdeVersion")
          obj = new Node.IdeVersion();
        //
        obj.load(v);
        return obj;
      }
      else
        return v;
    });
    //
    await this.initBrowserPath();
    //
    // Connect all childrens
    this.setParent(this.parent);
    //
    // Check current configuration
    await this.check();
  }


  /**
   * Sets the parent reference for this configuration and all its child objects.
   * Propagates the parent relationship down to all users in the configuration tree.
   * @param {Node.Server} par - The parent server instance
   */
  setParent(par)
  {
    this.parent = par;
    //
    if (this.users)
      for (let i = 0; i < this.users.length; i++)
        this.users[i].setParent(this);
    //
    if (this.ides)
      for (let i = 0; i < this.ides.length; i++)
        this.ides[i].setParent(this);
  }


  /**
   * Returns the installed IDE version entry matching the given version.
   * @param {String} version - IDE version to look up
   * @returns {Node.IdeVersion|undefined} The matching entry, or undefined if not installed
   */
  getIdeVersion(version)
  {
    return this.ides.find(ide => ide.version === version);
  }


  /**
   * Returns the installed IDE version entry of the same release as the given version. The exact key
   * wins when present; otherwise any installed build of the same release matches (compareVersions
   * ignores the build metadata possibly decorating the version strings), the first in the registry
   * when more than one. Used to resolve a project's lastSaveVersion, which records the saving
   * session's version string and may refer to a build no longer installed.
   * @param {String} version - Version to look up (possibly a decorated build string)
   * @returns {Node.IdeVersion|undefined} The matching entry, or undefined when no build of that release is installed
   */
  getIdeVersionByRelease(version)
  {
    return this.getIdeVersion(version) || this.ides.find(ide => Node.Utils.compareVersions(ide.version, version) === 0);
  }


  /**
   * Returns whether the given IDE version is installed on this server.
   * @param {String} version - IDE version to check
   * @returns {Boolean} True if the version is installed
   */
  isIdeVersionInstalled(version)
  {
    return this.getIdeVersion(version) !== undefined;
  }


  /**
   * Returns the highest IDE version installed on this server (numeric comparison
   * per segment, so "26.10" > "26.2"). Returns undefined when no IDE is installed
   * (legacy/flat server or local development).
   * @returns {String|undefined} The highest installed IDE version, or undefined
   */
  getHighestIdeVersion()
  {
    let highest;
    for (let ide of this.ides) {
      if (!highest || Node.Utils.compareVersions(ide.version, highest) > 0)
        highest = ide.version;
    }
    //
    return highest;
  }


  /**
   * Returns whether this server runs in multi-version mode, i.e. the installed-versions registry
   * is populated. A flat server (empty registry, before the 26.3 bootstrap migration, or local
   * development) returns false and keeps the classic single-version install behavior.
   * @returns {Boolean} True when at least one IDE version is registered
   */
  isMultiVersion()
  {
    return this.ides.length > 0;
  }


  /**
   * Validates and initializes the server configuration.
   * Ensures required users exist, creates necessary directories, and validates
   * all user configurations in the system.
   */
  async check()
  {
    // If the MANAGER user is missing, create it
    if (!this.getUser("manager")) {
      let user = new Node.User(this);
      user.userName = "manager";
      //
      // Add the new user to the list of users and save the current configuration
      // DO not save configuration because now logger is not set yet, and we can re-add manager
      // again if the config won't be saved
      this.users.push(user);
    }
    //
    // If there is no IDE directory, check is complete
    if (!this.directory)
      return;
    //
    // Create the home folder if needed
    try {
      await Node.fs.promises.mkdir(this.directory);
    }
    catch (err) {
      if (err.code !== "EEXIST")
        this.logger.log("ERROR", `Error creating the home folder ${this.directory}: ${err}`, "Config.ensureInitialized");
    }
    //
    // Check the configuration for all the users
    // (this operation must be serialized as the OS cannot create many users at the same time)
    for (let user of this.users)
      await user.check().catch(() => {});
  }


  /**
   * Gets the complete server URL based on the configuration and optional request context.
   * Returns the appropriate URL for local, production, or request-specific scenarios.
   * @param {Object} [req] - Optional HTTP request object to extract host information
   * @returns {String} The complete server URL including protocol and host
   */
  getUrl(req)
  {
    if (this.local)
      return `http://localhost:${this.portHttp || 8081}`;           // Return LOCAL url (use the configured port)
    else if (req && this.getHostFromReq(req))
      return `${this.protocol}://${this.getHostFromReq(req)}`;      // If a REQ object was given use it to get the "right" HOST
    else if (this.domain !== "instantdevelopercloud.com") {
      // MyCloud: use the configured domain directly (no "name." subdomain) and include the port if non-standard
      let port = this.protocol === "https" ? this.portHttps : this.portHttp;
      let portSuffix = (port && port !== 80 && port !== 443) ? `:${port}` : "";
      return `${this.protocol}://${this.domain}${portSuffix}`;
    }
    else
      return `${this.protocol}://${this.name}.${this.domain}`; // Return "design-time" url
  }


  /**
   * Extracts and validates the host from an HTTP request.
   * Checks against configured aliases and domain settings to ensure the host is valid.
   * @param {Object} req - HTTP request object containing headers
   * @returns {String} The validated host string, or undefined if invalid
   */
  getHostFromReq(req)
  {
    // If I'm local -> return the given host
    if (this.local)
      return req.headers.host;
    //
    // No host -> return undefined (i.e. the given host)
    if (!req.headers.host)
      return;
    //
    // Extract HOST from request (and remove TCP port if it's there)
    let host = req.headers.host.toLowerCase();
    if (host.includes(":"))
      host = host.substring(0, host.indexOf(":"));
    //
    // If it's me use the given host
    if (host === `${this.name}.${this.domain}`)
      return req.headers.host;
    //
    // If I've an external IP address and it's using it use the given host
    if (this.externalIP && host === this.externalIP)
      return req.headers.host;
    //
    // If I've an alias list, use it
    if (this.alias) {
      let aliases = this.alias.split(",");
      for (let i = 0; i < aliases.length; i++) {
        let al = aliases[i];
        //
        // If the alias contain the default app, clean it up
        if (al.includes("|"))
          al = al.substring(0, al.indexOf("|"));
        //
        // If host matches, use the given host
        if (host === al)
          return req.headers.host;
        //
        // Handle 2-level domains (*.domain.com)
        if (al.includes("*") && host.includes(".") &&
                host.substring(host.indexOf(".")) === al.substring(1))
          return req.headers.host;
      }
    }
  }


  /**
   * Gets the server's external IP address by querying Google Cloud metadata service.
   * Caches the result after first successful retrieval.
   * @returns {Promise<String>} The external IP address or undefined if unavailable
   */
  async getExternalIp()
  {
    // If I've not yet asked, I'm not local and I'm not on windows
    if (!this.externalIP && !this.local && !/^win/.test(process.platform)) {
      // Try to ask google what's my external IP address
      let options = {
        protocol: "http:",
        hostname: "metadata.google.internal",
        headers: {"Metadata-Flavor": "Google"},
        path: "/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip"
      };
      //
      let err;
      let {code, data: extip} = await this.server.request.getRequest(options).catch(e => err = e) ?? {};
      if (code !== 200 || err)
        return this.logger.log("WARN", `Can't read metadata::external-ip: ${err || `ResponseCode: ${code}`}`,
                "Config.getExternalIp", options);
      //
      // Got it!
      this.externalIP = extip;
      this.logger.log("DEBUG", `External IP: ${extip}`, "Config.getExternalIp");
    }
    //
    return this.externalIP;
  }


  /**
   * Gets the path to the main IDE HTML file based on configuration.
   * Returns the local or minified version depending on settings.
   * @returns {String} Path to the main IDE HTML file
   */
  getMainFile(version)
  {
    // Use INDEXLOCAL.html file if I'm on a local machine or if I'm not minifying
    let base = (this.local || !this.minify) ? "/indexLocal2.html" : "/index2.html";
    //
    // On a multi-version server the IDE client lives under a per-version prefix (served by the
    // version-aware middleware in Server.start). The client uses only relative paths (resources and
    // service-worker registration), so the prefix scopes everything to the right version with no
    // client change — old IDE versions work unmodified.
    if (this.isMultiVersion())
      return `/ide_${version || this.getHighestIdeVersion()}${base}`;
    //
    return base;
  }


  /**
   * Gets the path to the main application HTML file based on configuration.
   * Returns the appropriate version for local/production and online/offline modes.
   * @param {Boolean} [offline] - If true, returns the offline version of the app
   * @returns {String} Path to the main application HTML file
   */
  getAppMainFile(offline)
  {
    // Use INDEXLOCAL.html file if I'm on a local machine or if I'm not minifying
    let page = offline ? "offline" : "index";
    if (this.local || !this.minify)
      page += "Local";
    //
    return `client/${page}.html`;
  }


  /**
   * Finds a user by their username.
   * Searches through the configured users array for an exact username match.
   * @param {String} name - The username to search for
   * @returns {Node.User} The user object if found, undefined otherwise
   */
  getUser(name)
  {
    return this.users.find(user => user.userName === name);
  }


  /**
   * Creates a new user account in the system.
   * Initializes the user, creates their directory structure, and persists the configuration.
   * For local installations, can auto-generate username from system user.
   * @param {String} userName - The username to create (use "$$$" for system user in local mode)
   * @returns {Promise<Node.User>} The user that was created
   * @throws {Error} If a user with the same name already exists
   */
  async createUser(userName)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Deletes an existing user account from the system.
   * Removes the user's databases, directory structure, and configuration entry.
   * The manager user cannot be deleted.
   * @param {String} userName - The username to delete
   */
  async deleteUser(userName)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Updates the package.json file with custom packages.
   * Modifies dependencies by removing and adding specified NPM packages,
   * then runs npm install to update the node_modules.
   * @param {Array} [toRemove] - List of package names to remove from dependencies
   * @param {Array} [toAdd] - List of package specifications to add to dependencies
   * @param {String} [targetDir] - Folder holding the package.json to update; defaults to public_html (flat layout). On multi-version servers it's a per-version folder (ides/ide_<version>)
   */
  async updatePackageJson(toRemove, toAdd, targetDir)
  {
    // If there is nothing to do, return to callee
    if (!toRemove && !toAdd)
      return;
    //
    // If toAdd and toRemove are the same, return to callee
    if (toRemove && toAdd && toRemove.length === toAdd.length) {
      let toRemoveSorted = toRemove.slice().sort();
      let sameList = toAdd.slice().sort().every((pckg, idx) => pckg === toRemoveSorted[idx]);
      //
      if (sameList) {
        this.logger.log("DEBUG", "Nothing to do (add list equal to remove list)", "Config.updatePackageJson", {toRemove, toAdd});
        return;
      }
    }
    //
    let packageJSONfile = Node.path.join(targetDir || Node.Utils.rootDir(), "package.json");
    //
    this.logger.log("DEBUG", "Updating Package.json file", "Config.updatePackageJson", {toRemove, toAdd, targetDir});
    //
    try {
      // First, read package.json file
      let data;
      try {
        data = await Node.fs.promises.readFile(packageJSONfile);
      }
      catch (err) {
        throw new Error(`Error reading the package.json file: ${err.message || err}`, {cause: err});
      }
      //
      let packageJson = JSON.parse(data);
      //
      // First delete all packages to be removed (if any)
      toRemove?.forEach(pack => {
        // Handle scoped and non-scoped packages (@google/pack@1.1.2, mypacket@1.2.3)
        let packName = pack;
        if (pack.substring(1).includes("@"))
          packName = pack.substring(0, pack.substring(1).indexOf("@") + 1);
        //
        delete packageJson.dependencies[packName];
      });
      //
      // Then add new packages (if any)
      toAdd?.forEach(pack => {
        // Handle scoped and non-scoped packages (@google/pack@1.1.2, mypacket@1.2.3)
        let packName = pack;
        let packVer = "*";
        if (pack.substring(1).includes("@")) {
          packName = pack.substring(0, pack.substring(1).indexOf("@") + 1);
          packVer = pack.substring(pack.substring(1).indexOf("@") + 2);
        }
        //
        // If the package is already available it means that the user is trying to overwrite a "standard" package
        // (before I've already removed all user-defined packages... so if I'm here it means that the user is trying
        // to rewrite one of our packages).
        // It can't be done, otherwise, if he will remove it, the system will have problems
        if (packageJson.dependencies[packName])
          throw new Error(`Package ${packName} is already installed`);
        //
        packageJson.dependencies[packName] = packVer;
      });
      //
      // Remove the old BACK if present
      try {
        await Node.fs.promises.rm(`${packageJSONfile}.bak`, {force: true});
      }
      catch (err) {
        throw new Error(`Error removing the old package.json file ${packageJSONfile}.bak: ${err.message || err}`, {cause: err});
      }
      //
      // Backup the the config file into a .bak file
      try {
        await Node.fs.promises.rename(packageJSONfile, `${packageJSONfile}.bak`);
      }
      catch (err) {
        throw new Error(`Error renaming the package.json file ${packageJSONfile} to ${packageJSONfile}.bak: ${err.message || err}`, {cause: err});
      }
      //
      // Save package.json file
      try {
        await Node.fs.promises.writeFile(packageJSONfile, JSON.stringify(packageJson, null, 2), {mode: 0o644}); // RW-R-R
      }
      catch (err) {
        throw new Error(`Error while saving the package.json file: ${err.message || err}`, {cause: err});
      }
      //
      this.logger.log("DEBUG", "Package.json file saved with success", "Config.updatePackageJson");
      //
      // Last: update packages
      try {
        await this.server.execFileAsRoot("UpdNodePackages", [targetDir]);
        this.logger.log("INFO", "Package.json and node_modules updated", "Config.updatePackageJson", {toRemove, toAdd, targetDir});
      }
      catch (err) {
        // Restore old package.json file
        try {
          await Node.fs.promises.rename(`${packageJSONfile}.bak`, packageJSONfile);
        }
        catch (errRestore) {
          this.logger.log("ERROR", `Can't restore package.json file!: ${errRestore}`, "Config.updatePackageJson");
        }
        //
        throw new Error(`Error while updating packages: ${err.message || err}`, {cause: err});
      }
    }
    catch (err) {
      this.logger.log("ERROR", err.message || err, "Config.updatePackageJson");
      throw err;
    }
  }


  /**
   * Refreshes the node_modules of a target folder, applying the given custom packages in the same
   * single npm pass: {@link Node.Config#updatePackageJson} rewrites package.json and runs npm when
   * there are custom packages; otherwise the explicit UpdNodePackages does the plain install, unless
   * `noPackages` skips it. Target-aware: `targetDir` defaults to public_html. Shared by the flat and
   * multi-version install paths.
   * @param {Object} params - Options
   * @param {Array} [params.customPackages] - Custom NPM package specs to apply (e.g. `["pkg@1.2.3"]`)
   * @param {String} [params.targetDir] - Folder holding package.json/node_modules; defaults to public_html
   * @param {Boolean} [params.noPackages] - When true skips the plain install (the update command's `nopackages` flag); custom packages, if present, are still applied
   * @throws {Error} When the npm install fails
   */
  async updateNodeModules(params)
  {
    let {customPackages, targetDir, noPackages} = params;
    //
    await this.updatePackageJson(null, customPackages, targetDir);
    if (!noPackages && !customPackages)
      await this.server.execFileAsRoot("UpdNodePackages", [targetDir]);
  }


  /**
   * Processes application run requests for both IDE and production environments.
   * Routes requests to appropriate sessions and applications based on URL patterns
   * and authentication. Handles WebSocket, REST, and WebAPI modes.
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */
  async processRun(req, res)
  {
    // Possible URL formats:
    //    for IDE:     [sid]/[appid]/run
    //    for MASTER:  {nothing}
    //                 [app]                   (master user)
    //                 [app]?sid={SID}         (master user)
    //                 [user]/[app]
    //                 [user]/[app]?sid={SID}
    let isIDE = Node.Utils.isIDERequest(req);
    let isWebApi = Node.Utils.isWebApiRequest(req);
    let isBot = Node.Utils.isBotRequest(req);
    let isRest = (req.query?.mode === "rest");
    //
    this.logger.log("DEBUG", "Handle process RUN", "Config.processRun", {url: req.originalUrl, host: req.socket.remoteAddress});
    //
    Node.Utils.unlockRequestQuery(req);
    //
    // Bots go REST (unless already REST/WebAPI)
    if (!isRest && !isWebApi && isBot) {
      req.query.mode = "rest";
      isRest = true;
      //
      this.logger.log("DEBUG", "Bot request -> activate REST", "Config.processRun", {url: req.originalUrl, userAgent: req.useragent.source});
    }
    //
    // OPTIONS preflight
    if (req.method === "OPTIONS") {
      this.handleRunOptions(req, res, isRest);
      return;
    }
    //
    // Validate HTTP method
    let allowedMethods = isWebApi ? ["GET", "POST", "PUT", "DELETE", "PATCH"] : ["GET", "POST"];
    if (!allowedMethods.includes(req.method)) {
      this.logger.log("WARN", "Request method not allowed", "Config.processRun",
              {meth: req.method, url: req.originalUrl, remoteAddress: req.socket.remoteAddress});
      return res.status(405).end("HTTP method not supported");
    }
    //
    // Validate HOST
    if (!this.getHostFromReq(req)) {
      this.logger.log("WARN", "Bad HOST", "Config.processRun",
              {meth: req.method, url: req.originalUrl, host: req.headers.host, remoteAddress: req.socket.remoteAddress});
      return res.status(500).end("Invalid HOST parameter");
    }
    //
    // Resolve session (and, for MASTER, the target app)
    let session, app;
    //
    if (isIDE) {
      let sid = req.params.sid;
      session = this.server.IDESessions[sid];
      if (!session) {
        this.logger.log("WARN", "Session not found", "Config.processRun", {sid});
        return res.status(500).send("Session not found");
      }
    }
    else {
      let target = this.resolveRunMasterTarget(req, res);
      if (!target)
        return;
      //
      app = target.app;
      //
      if (!this.checkRunAppRunnable(req, res, app, target.userName))
        return;
      //
      let resolved = this.resolveRunSession(req, res, app, target.appName, isRest);
      if (!resolved)
        return;
      //
      session = resolved.session;
      //
      if (!isRest && !isWebApi)
        this.setRunSessionCookies(req, res, session, app, resolved.cid);
    }
    //
    // Body handling: multipart parse or plain flag
    let params;
    let newAppReq = false;
    //
    if (req.method === "POST") {
      let contentType = req.get("Content-Type");
      if (contentType?.includes("multipart/form-data")) {
        let upload = await this.parseRunMultipartUpload(req, res, session, app);
        if (!upload)
          return;
        //
        params = upload.params;
        session = upload.session;   // Session may have been refreshed after async parse
        isRest = true;              // Multipart uploads are REST
        newAppReq = true;
      }
      else
        newAppReq = true;
    }
    else if (req.method === "GET" || (isWebApi && ["DELETE", "PUT", "PATCH"].includes(req.method)))
      newAppReq = true;
    //
    if (!newAppReq)
      return;
    //
    // Build session.request and dispatch to the app
    let oldreq = session.request;
    session.request = {
      query: req.query,
      body: req.body,
      headers: req.headers,
      cookies: req.cookies,
      isBot
    };
    session.cookies = req.cookies;
    if (req.socket?.remoteAddress)
      session.request.remoteAddress = req.socket.remoteAddress.replace(/^.*:/, "");
    //
    if (isRest || isWebApi) {
      session.request.protocol = req.protocol;
      session.request.host = req.get("host");
      session.request.url = req.url;
      session.request.method = req.method;
      if (isWebApi)
        session.request.class = req.params.cls;
    }
    //
    if (params)
      Object.assign(session.request, params);
    //
    if (isRest || isWebApi) {
      session.startRest(req, res);
      //
      // Restore the "original" request (needed when a REST request runs on a normal session)
      session.request = oldreq;
    }
    else
      session.createAppClient(req, res);
  }


  /**
   * Handles a CORS preflight OPTIONS request for processRun.
   * Accepts only OPTIONS from WebAPI requests or from DROPZONE elements (POST with mode=rest).
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   * @param {Boolean} isRest - Whether the request is in REST mode
   * @private
   */
  handleRunOptions(req, res, isRest)
  {
    let isWebApi = Node.Utils.isWebApiRequest(req);
    //
    let meth = req.headers["access-control-request-method"];
    if (!["GET", "POST", "DELETE", "PUT", "PATCH"].includes(meth) || (!isRest && !isWebApi)) {
      this.logger.log("WARN", "Invalid OPTIONS request", "Config.processRun",
              {meth: req.method, url: req.originalUrl, headers: req.headers});
      return res.status(405).end("HTTP method not supported");
    }
    //
    this.logger.log("DEBUG", "Valid OPTIONS request", "Config.processRun",
            {meth: req.method, url: req.originalUrl, headers: req.headers});
    //
    // If config.corsOrigins is a non-empty array, reflect the request Origin only if allowed.
    // Otherwise fall back to "*" (legacy default).
    let allowed = this.corsOrigins;
    if (Array.isArray(allowed) && allowed.length) {
      // Always emit Vary: Origin when the response value depends on Origin,
      // even when the request Origin is rejected (see CORS hardening note in server.js).
      res.header("Vary", "Origin");
      let origin = req.get("Origin");
      if (origin && allowed.includes(origin))
        res.header("Access-Control-Allow-Origin", origin);
    }
    else
      res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "*");
    res.header("Access-Control-Allow-Methods", "*");
    res.header("Access-Control-Max-Age", "86400"); // Cache for 24 hours
    res.status(204).end();
  }


  /**
   * Parses the MASTER URL to determine the target user and app, handling the
   * default-app redirect, user/app lookup and relative error replies.
   * Returns nothing (undefined) when the response has already been taken over (redirect, error,
   * or forwarded to next middleware) — callers must stop processing in that case.
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   * @returns {{app: Object, userName: String, appName: String}} Target triple when resolution succeeded
   * @private
   */
  resolveRunMasterTarget(req, res)
  {
    let isWebApi = Node.Utils.isWebApiRequest(req);
    //
    let urlParts = req.originalUrl.substring(1).split("?")[0].split("/");
    if (urlParts.length && urlParts[urlParts.length - 1] === "")    // Eat last part if empty (originalUrl may end with "/")
      urlParts.pop();
    //
    let userName, appName;
    if (urlParts.length === 0) {      // {nothing}
      // Look for a specific default app for the request host
      let defApp;
      if (req.headers.host && this.alias) {
        let host = req.headers.host.toLowerCase();
        if (host.includes(":"))
          host = host.substring(0, host.indexOf(":"));
        let aliases = this.alias.split(",");
        for (let i = 0; i < aliases.length; i++) {
          let al = aliases[i];
          if (!al.includes("|"))
            continue;   // Skip aliases that have no default app
          //
          al = al.split("|");   // 0-HOST, 1-DefaultApp
          if (al[0] === host)
            defApp = al[1];
        }
      }
      //
      defApp = defApp || this.defaultApp;
      if (defApp) {
        this.logger.log("DEBUG", "No app specified -> redirect to default app", "Config.processRun",
                {defaultApp: defApp, url: req.originalUrl});
        //
        // Don't use `this.getUrl() + "/" + this.defaultApp`: reply using the domain used in the request
        // (may differ from the server URL when DNS or custom certificates define several domains)
        let redirUrl = defApp;
        if (req.originalUrl.includes("?"))
          redirUrl += req.originalUrl.substring(req.originalUrl.indexOf("?"));
        //
        res.redirect(redirUrl);
        return;
      }
      // No default app -> fall through; the !appName branch below will redirect to exitUrl
    }
    else if (urlParts.length === 1) { // [app] and [app]?sid={SID}
      userName = "manager";
      appName = urlParts[0];
      this.logger.log("DEBUG", "App detected (manager/app form)", "Config.processRun", {userName, app: appName, url: req.originalUrl});
    }
    else if (isWebApi) {
      userName = "manager";
      appName = req.params.app;
      this.logger.log("DEBUG", "App detected (manager/app/cls form)", "Config.processRun", {userName, app: appName, url: req.originalUrl});
    }
    else {
      userName = urlParts[0];
      appName = urlParts[1];          // [user]/[app] and [user]/[app]?sid={SID}
      this.logger.log("DEBUG", "App detected (user/app form)", "Config.processRun", {userName, app: appName, url: req.originalUrl});
    }
    //
    if (!appName) {
      let exitUrl = this.saveProperties().exitUrl;
      this.logger.log("WARN", `No command detected and no app to start. Redirect to ${exitUrl}`, "Config.processRun",
              {url: req.originalUrl});
      res.redirect(exitUrl);
      return;
    }
    //
    let user = this.getUser(userName);
    if (!user) {
      if (isWebApi) {
        req.next();
        return;
      }
      this.logger.log("WARN", "User not found", "Config.processRun", {user: userName, app: appName, url: req.originalUrl});
      res.status(500).send(`User ${userName} not found`);
      return;
    }
    //
    let app = user.getApp(appName);
    if (!app) {
      if (isWebApi) {
        req.next();
        return;
      }
      this.logger.log("WARN", "App not found", "Config.processRun", {user: userName, app: appName, url: req.originalUrl});
      res.status(404).send(`App ${appName} not found`);
      return;
    }
    //
    return {
      app,
      userName,
      appName
    };
  }


  /**
   * Checks whether the app is runnable (not stopped, not updating, not in offline mode).
   * Writes the appropriate response when the request can't proceed.
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   * @param {Object} app - Target app
   * @param {String} userName - Owner user name (for logging)
   * @returns {Boolean} True when the app is runnable and the caller should continue; false when a response has already been emitted and the caller must stop
   * @private
   */
  checkRunAppRunnable(req, res, app, userName)
  {
    if (app.stopped) {
      this.logger.log("WARN", "Can't start app because it's stopped", "Config.processRun", {user: userName, app: app.name});
      res.status(503).send(`App ${app.name} stopped`);
      return false;
    }
    //
    if (app.updating) {
      this.logger.log("WARN", "Can't start app because it's updating", "Config.processRun", {user: userName, app: app.name});
      //
      // Send updating.html as response without redirecting.
      // A redirect would let the user hit REFRESH and wait forever for the update to complete.
      res.writeHead(200, {"Content-Type": "text/html"});
      //
      let path = Node.path.join(this.appDirectory, "apps", app.name, "client", "updating.html");
      //
      // Fire-and-forget: the method must return synchronously, so we don't await the stream.
      // pipeline still tears the file stream down on error/abort (no fd leak).
      require("stream/promises").pipeline(Node.fs.createReadStream(path), res)
        .then(() => this.logger.log("DEBUG", "Updating.html sent", "Config.processRun", {user: userName, app: app.name}),
              err => {
                if (!Node.Utils.isClientAbortError(err))
                  this.logger.log("WARN", `Error sending the file ${path} to an updating app: ${err}`, "Config.processRun",
                          {user: userName, app: app.name});
              });
      return false;
    }
    //
    // Offline mode redirect
    if (req.query.mode === "offline" && app.params?.allowOffline && !app.params.startPage) {
      this.logger.log("DEBUG", "Start app in OFFLINE mode", "Config.processRun", {user: userName, app: app.name});
      res.redirect(`/${app.name}/${this.getAppMainFile(req.query.mode)}`);
      return false;
    }
    //
    return true;
  }


  /**
   * Handles WebAPI meta routes (api-docs, openapi.json, $metadata) and validates cls.
   * Mutates `req.params.cls` to its canonical form when the class matches an entity/action import.
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   * @param {String} appName - Target app name
   * @returns {Boolean} True when the response was served or forwarded to the next middleware (caller must stop); false when cls was validated and the caller should continue
   * @private
   */
  handleRunWebApiMetaRoutes(req, res, appName)
  {
    let webApiPath = `${this.appDirectory}/apps/${appName}/server/webapi`;
    let openApiPath = `${webApiPath}/openapi.json`;
    //
    // GET api-docs -> stream swagger HTML
    if (req.params.cls === "api-docs" && req.method === "GET") {
      if (!Node.fs.existsSync(openApiPath)) {
        res.status(404).send("File not found");
        return true;
      }
      //
      let swaggerPath = `${this.appDirectory}/apps/${appName}/client/swagger/index.html`;
      res.setHeader("Content-Type", "text/html; charset=UTF-8");
      //
      // Fire-and-forget: the method returns synchronously. pipeline tears the stream down on
      // error/abort (no fd leak); on a real read error before any byte is sent we still reply 500.
      require("stream/promises").pipeline(Node.fs.createReadStream(swaggerPath), res)
        .catch(err => {
          if (!Node.Utils.isClientAbortError(err) && !res.headersSent)
            res.status(500).send("Internal Server Error");
        });
      return true;
    }
    //
    // GET openapi.json -> serve the spec with replaced $serverUrl
    if (req.params.cls === "openapi.json" && req.method === "GET") {
      if (!Node.fs.existsSync(openApiPath)) {
        res.status(404).send("File not found");
        return true;
      }
      //
      let spec = require(openApiPath);
      let serverUrl = `${req.protocol}://${req.get("host")}/${appName}`;
      spec.info.description = spec.info.description.replace(/\$serverUrl/g, serverUrl);
      spec.servers[0].url = serverUrl;
      //
      res.setHeader("Content-Type", "application/json");
      res.send(spec);
      return true;
    }
    //
    let metadataPath = `${webApiPath}/metadata.json`;
    if (!Node.fs.existsSync(metadataPath)) {
      req.next();
      return true;
    }
    //
    let metadata = require(metadataPath);
    //
    // GET $metadata -> reply with OData metadata XML
    if (req.params.cls === "$metadata" && req.method === "GET") {
      let serviceMetadata = require("odata-v4-service-metadata").ServiceMetadata;
      res.type("text/xml").set("OData-Version", "4.0").status(200).end(serviceMetadata.processMetadataJson(metadata).data);
      return true;
    }
    //
    // Validate cls as a WebAPI class and canonicalize `req.params.cls` when matched
    let cls = req.params.cls.split("(")[0];
    let matched = metadata.dataServices.schema.find(s => {
      if (!s.entityContainer)
        return false;
      //
      if (s.entityContainer.entitySet.find(e => {
        if (e.name === cls) {
          req.params.cls = e.name;
          return true;
        }
      }) || s.entityContainer.actionImport.find(a => {
        if (a.name === cls) {
          req.params.cls = cls.split("__")[0];
          return true;
        }
      })) {
        if (s.namespace.toLowerCase() !== appName.toLowerCase())
          req.params.cls = `${s.namespace}.${req.params.cls}`;
        return true;
      }
      //
      return false;
    });
    //
    if (!matched) {
      req.next();
      return true;
    }
    //
    return false;
  }


  /**
   * Resolves the app session for a MASTER request: validates the existing SID (with client/telecollab
   * handling) or creates a new one. For WebAPI requests without SID, runs the meta routes handler first.
   * Returns nothing (undefined) when the response has already been taken over — callers must stop processing in that case.
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   * @param {Object} app - Target app
   * @param {String} appName - Target app name
   * @param {Boolean} isRest - Whether the request is in REST mode
   * @returns {{session: Object, cid: String}} Resolved session data when resolution succeeded
   * @private
   */
  resolveRunSession(req, res, app, appName, isRest)
  {
    let isWebApi = Node.Utils.isWebApiRequest(req);
    let sid = req.query.sid;
    let cid = req.query.cid;
    let session;
    //
    if (sid) {
      session = this.server.appSessions[sid];
      if (!session) {
        this.logger.log("WARN", "Session not found", "Config.processRun",
                {sid, cid, user: app.user.userName, app: app.name});
        res.status(500).send("Invalid session");
        return;
      }
      //
      if (cid) {
        let client = session.getAppClientById(cid);
        if (!client) {
          this.logger.log("WARN", "Session client not found", "Config.processRun",
                  {sid, cid, user: app.user.userName, app: app.name});
          res.status(500).send("Invalid client");
          return;
        }
      }
      else if (!isRest && req.query.ctoken) {
        // Telecollaboration: SID valid and connected with a master client, session is not REST, no CID provided.
        // Use the CTOKEN as the new client ID (easier); the client will be created inside session::createAppClient.
        cid = req.query.ctoken;
        session.newCid = cid;
        //
        this.logger.log("DEBUG", "No CID provided for MASTER session -> grant for telecollaboration", "Config.processRun",
                {sid, cid, user: app.user.userName, app: app.name});
      }
    }
    else {
      if (isWebApi && this.handleRunWebApiMetaRoutes(req, res, appName))
        return;
      //
      // No SID -> create a new session
      session = app.createNewSession({type: (isRest ? "rest" : "web"), query: req.originalUrl.split("?")[1]});
      if (!session) {
        this.logger.log("WARN", "Session can't be created: too many users", "Config.processRun", {user: app.user.userName, app: app.name});
        res.status(503).send("Too many users");
        return;
      }
      //
      // Create a new ID for the client that will be created inside session::createAppClient below
      cid = Node.Utils.generateUID36();
      session.newCid = cid;
      //
      this.logger.log("DEBUG", "Created new app session", "Config.processRun",
              {user: app.user.userName, app: appName, sid: session.id, cid, url: req.originalUrl});
    }
    //
    return {session, cid};
  }


  /**
   * Sets the sid/cid/exitUrl cookies for a MASTER session and protects the SID cookie.
   * Removes the opposite cookie partition so legacy clients read the new session identifiers.
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   * @param {Object} session - Resolved session
   * @param {Object} app - Target app
   * @param {String} cid - Client id
   * @private
   */
  setRunSessionCookies(req, res, session, app, cid)
  {
    let expires = new Date(Date.now() + 86400000);
    let cookieOpt = {expires, path: `/${app.name}`};
    //
    if (!this.local && this.protocol === "https") {
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
      // may be a client/index.html loaded directly inside a cross-site iframe, where unpartitioned
      // SameSite=None cookies would be rejected (the exitUrl one has no other transport). The
      // opposite jar is cleared below so stale cookies cannot shadow the new session
      if (Node.Utils.isEmbeddedRequest(req) || req.query.addsid !== undefined)
        cookieOpt.partitioned = true;
    }
    //
    // Legacy clients cannot delete Partitioned cookies: clear the other jar before setting new ones.
    if (cookieOpt.secure) {
      let clearOpt = {
        path: cookieOpt.path,
        secure: true,
        sameSite: cookieOpt.sameSite,
        partitioned: !cookieOpt.partitioned
      };
      res.clearCookie("sid", clearOpt);
      res.clearCookie("cid", clearOpt);
      res.clearCookie("exitUrl", clearOpt);
    }
    //
    res.cookie("sid", session.id, cookieOpt);
    res.cookie("cid", cid, cookieOpt);
    res.cookie("exitUrl", this.saveProperties().exitUrl, cookieOpt);
    //
    session.protectSID(req, res);
  }


  /**
   * Parses a multipart/form-data POST: runs multiparty, flattens single-element fields,
   * renames uploaded files into the target upload directory and drops the bak-tempfiles
   * when the session was GC'd during parsing.
   * Returns nothing (undefined) when the response has already been taken over — callers must stop processing in that case.
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   * @param {Object} session - Current session (may be replaced after parsing if GC'd)
   * @param {Object} app - Target app (MASTER only; undefined for IDE)
   * @returns {Promise<{params: Object, session: Object}>} Parsed params and (possibly refreshed) session when parsing succeeded
   * @private
   */
  async parseRunMultipartUpload(req, res, session, app)
  {
    let isIDE = Node.Utils.isIDERequest(req);
    let sid = session.id;
    //
    // Multipart uploads are REST requests
    req.query = req.query || {};
    req.query.mode = "rest";
    //
    let maxFilesSize = parseInt(app?.params?.maxUploadFileSize || this.params?.maxUploadFileSize || 0) || 50 * 1024 * 1024; // 50 MB default
    //
    let uploadDir = isIDE
            ? Node.path.join(this.directory, session.project.user.userName, session.project.name, "files", "uploaded")
            : Node.path.join(this.appDirectory, "apps", app.name, "files", "uploaded");
    //
    let form = new Node.multiparty.Form({autoFields: true, autoFiles: true, maxFilesSize, uploadDir});
    //
    let fields, files;
    try {
      let result = await new Promise((resolve, reject) => {
        form.parse(req, (err, fields, files) => err ? reject(err) : resolve({fields, files}));
      });
      fields = result.fields;
      files = result.files;
    }
    catch (err) {
      this.logger.log("ERROR", `Error parsing post request: ${err}`, "Config.processRun", {maxFilesSize});
      res.status(500).end(err.message);
      return;
    }
    //
    // Session may have been GC'd while parsing the body
    session = isIDE ? this.server.IDESessions[sid] : this.server.appSessions[sid];
    if (!session) {
      for (let name of Object.keys(files)) {
        for (let f of files[name]) {
          try {
            await Node.fs.promises.rm(`${f.path}.bak`, {force: true});
          }
          catch (err) {
            this.logger.log("WARN", `Can't delete file ${f.path}: ${err}`, "Config.processRun", {sid});
          }
        }
      }
      //
      this.logger.log("WARN", "Session not found", "Config.processRun", {sid});
      res.status(500).send("Session not found");
      return;
    }
    //
    // Flatten single-element field arrays
    for (let key of Object.keys(fields)) {
      if (fields[key].length === 1)
        fields[key] = fields[key][0];
    }
    //
    // Move uploaded files and build the postfiles list
    let postfiles = [];
    let fileArr = [];
    for (let name of Object.keys(files)) {
      for (let f of files[name])
        fileArr.push(f);
    }
    //
    for (let f of fileArr) {
      let ext = "";
      //
      // Extension from content-type header, otherwise from original filename
      if (f.headers?.["content-type"])
        ext = Node.mime.extension(f.headers["content-type"]);
      if (!ext) {
        let parts = f.originalFilename.split(".");
        if (parts.length > 1)
          ext = parts[parts.length - 1];
      }
      if (ext)
        ext = `.${ext}`;
      //
      let id = Node.Utils.generateUID36();
      let path, localPath;
      if (isIDE) {
        path = `${session.project.user.userName}/${session.project.name}/files/uploaded/${id}${ext}`;
        localPath = Node.path.join(this.directory, path);
      }
      else {
        path = `${app.name}/files/uploaded/${id}${ext}`;
        localPath = Node.path.join(this.appDirectory, "apps", path);
      }
      let serverPath = `${this.getUrl()}/${path}`;
      //
      try {
        await Node.fs.promises.rename(f.path, localPath);
        postfiles.push({path: `uploaded/${id}${ext}`, type: undefined, originalName: f.originalFilename, publicUrl: serverPath});
        //
        this.logger.log("INFO", "Received file via REST request", "Config.processRun",
                {path: `uploaded/${id}${ext}`, serverPath});
      }
      catch (err) {
        this.logger.log("ERROR", `Error moving POST file: ${err}`, "Config.processRun", {src: f.path, dst: localPath});
        //
        try {
          await Node.fs.promises.unlink(f.path);
        }
        catch (err) {
          this.logger.log("ERROR", `Error removing temp POST file after move failed: ${err}`, "Config.processRun", {src: f.path});
        }
      }
    }
    //
    return {
      params: {
        params: fields,
        files: postfiles
      },
      session
    };
  }


  /**
   * Initializes the authentication token timer for console communication.
   * Sets up a periodic timer to send authentication tokens to the configured console URL.
   */
  initTokenTimer()
  {
    // If a consoleURL was not provided, do nothing
    if (!this.consoleURL)
      return;
    //
    // If a previous interval was set, clear it
    if (this.intervalToken) {
      clearInterval(this.intervalToken);
      delete this.intervalToken;
    }
    //
    // Set timer with right frequency (if timerTokenConsole has been provided)
    if (this.timerTokenConsole)
      this.intervalToken = setInterval(() => {
        this.server.request.sendTokenToConsole();
      }, this.timerTokenConsole);
    //
    // Send token now (server startup)
    setImmediate(() => this.server.request.sendTokenToConsole());
  }


  /**
   * Returns the current server status information.
   * Includes server configuration, system resources, and runtime statistics
   * while excluding sensitive data like passwords and API keys.
   * @param {Object} params - Request parameters
   * @returns {Promise<Object>} Server status information
   */
  async getStatus(params)
  {
    // Send the current server status (skip class name and users)
    let status = this.save();
    delete status.cl;
    delete status.users;
    //
    // Remove "sensitive data"
    delete status.configGCloudStorage;
    delete status.dbPassword;
    delete status.googleAPIKey;
    delete status.devAgentApiKey;
    delete status.configS3;
    delete status.turnConfig;
    //
    // Add server info
    let srvFile = Node.path.resolve(__dirname, "..", "server.js");
    status.serverInfo = {
      version: this.server.version,
      startTime: this.server.startTime,
      pid: process.pid,
      lastWrite: (await Node.fs.promises.stat(srvFile)).mtime,
      dockerName: process.env["DOCKER_NAME"]
    };
    //
    // Installed IDE versions: a server property, returned in every status (not only FULL). Use the
    // plain registry list, never the live Node.IdeVersion instances whose parent backref would make
    // the status a circular structure.
    status.ides = this.getIdeVersionsList(params);
    //
    // Add current disk status
    try {
      let cmd, cmdParams;
      if (!/^win/.test(process.platform)) {   // linux
        cmd = "/bin/df";
        cmdParams = ["."];
      }
      else {  // windows
        cmd = "wmic";
        cmdParams = ["logicaldisk", "where", `DeviceID='${srvFile[0]}:'`, "get", "freespace,size", "/format:table"];
      }
      //
      let stdout;
      try {
        stdout = await this.server.execFileAsRoot(cmd, cmdParams);
      }
      catch (err) {
        throw new Error(`Error getting the disk size: ${err.message || err}`, {cause: err});
      }
      //
      stdout = stdout.split("\n")[1];   // Remove headers
      stdout = stdout.split(/\s+/);     // Split spaces
      //
      if (!/^win/.test(process.platform) && !/^darwin/.test(process.platform)) {    // linux (not windows and not darwin/mac)
        status.serverInfo.disk = {size: stdout[1], used: stdout[2], available: stdout[3], capacity: stdout[4]};
        status.serverInfo.time = {date: new Date()};
        //
        // Add more info (TOP)
        try {
          status.serverInfo.top = await this.server.execFileAsRoot("/usr/bin/top", ["-b", "-n", "1"]);
        }
        catch (err) {
          throw new Error(`Error getting the CPU load and memory status: ${err.message || err}`, {cause: err});
        }
        //
        // Finally, get CPU load
        let cpuLoad = await Node.Utils.getCPUload();
        status.serverInfo.globalCpuLoad = cpuLoad;
      }
      else {  // windows
        status.serverInfo.disk = {
          size: stdout[1] / 1024,
          available: stdout[0] / 1024
        };
        status.serverInfo.disk.used = status.serverInfo.disk.size - status.serverInfo.disk.available;
        status.serverInfo.disk.capacity = `${Math.ceil(status.serverInfo.disk.used / status.serverInfo.disk.size * 100)}%`;
      }
      //
      // If FULL mode -> add all other infos
      if (params.req.query.full) {
        delete params.req.query.full;   // I don't want following commands to send FULL info
        //
        // IDE sessions list
        status.sessions = this.getSessionsList(params);
        //
        // Users list
        // If there are no users it means that this is a PROD server -> add MANAGER
        let userList = this.getUsersList(params);
        if (userList.length === 0)
          userList.push("manager");
        //
        status.users = [];
        for (let u of userList) {
          let user = this.getUser(u);
          let userInfo = {
            userName: user.userName,
            databases: await user.getDatabasesList(params)
          };
          //
          // For each user: get app sessions, apps, databases, projects
          if (user.userName === "manager") {
            userInfo.appsessions = await user.getAppSessions(params);
            userInfo.apps = await user.getAppsList(params);
          }
          else
            userInfo.projects = user.getProjectsList(params);
          //
          status.users.push(userInfo);
        }
      }
      //
      return status;
    }
    catch (err) {
      this.logger.log("ERROR", err.message || err, "Config.getStatus");
      throw err;
    }
  }


  /**
   * Updates server configuration properties via HTTP request parameters.
   * Modifies configuration values and persists changes to disk.
   * @param {Object} params - Request parameters containing configuration updates
   * @returns {Promise<Object>} Success message
   */
  async configureServer(params)
  {
    let logData;
    try {
      // Compute the array of properties provided via url
      let query = params.req.query;
      let queryProps = Object.getOwnPropertyNames(query);
      if (queryProps.length === 0)
        throw new Error("No property specified");
      //
      // Helper function to parse boolean values
      let parseBoolean = value => {
        if (value === "false")
          return false;
        if (value === "true")
          return true;
      };
      //
      // Helper function to parse integer with validation
      let parseInteger = value => {
        let num = parseInt(value, 10);
        if (!isNaN(num))
          return num;
      };
      //
      // Process each query parameter
      for (let [key, value] of Object.entries(query)) {
        switch (key) {
          // Simple string properties - direct assignment
          case "name":
          case "domain":
          case "protocol":
          case "alias":
          case "serverType":
          case "directory":
          case "bucketS3":
          case "bucketGCloud":
          case "storage":
          case "dbAddress":
          case "dbUser":
          case "dbPassword":
          case "googleAPIKey":
            if (value)
              this[key] = value;
            break;

          // Integer properties
          case "portHttp":
          case "portHttps":
          case "dbPort":
          case "timerSession":
          case "recoveryTimeout":
          case "timerTokenConsole":
          case "maxAppUsers":
          case "minAppUsersPerWorker":
          case "maxAppWorkers":
            if (value !== undefined && value !== "")
              this[key] = parseInteger(value);
            break;

          // Boolean properties
          case "auth":
          case "editPrjToken":
          case "handleException":
          case "flatVersion":
          case "minify": {
            let boolValue = parseBoolean(value);
            if (boolValue !== undefined)
              this[key] = boolValue;
            break;
          }

          // Special boolean case for logger
          case "debug2log": {
            let debugValue = parseBoolean(value);
            if (debugValue !== undefined)
              this.logger.debug2log = debugValue;
            break;
          }

          // Optional string properties (can be undefined)
          case "consoleURL":
          case "exitUrl":
          case "appDirectory":
          case "defaultApp":
          case "services":
            if (value !== undefined)
              this[key] = value || undefined;
            break;

          // Nightly backup bucket
          // TODO: drop the legacy "nigthlybucketGCloud" case once the console always sends the corrected key
          case "nigthlybucketGCloud":
          case "nightlyBucketGCloud":
            if (value !== undefined)
              this.nightlyBucketGCloud = value || undefined;
            break;

          // Optional integer properties (can be undefined)
          case "timeBackup":
          case "daysBackups":
          case "numMinBackups":
          case "numHoursSnapshot":
          case "numMaxSnapshot":
          case "timeSnapshot": {
            if (value !== undefined && value !== "")
              this[key] = parseInteger(value);
            break;
          }

          // Special integer case with different handling
          case "lowDiskThreshold":
            if (value !== undefined)
              this.lowDiskThreshold = value ? (parseInteger(value) || 0) : 0;
            break;

          // JSON properties
          case "configS3":
          case "configGCloudStorage":
            if (value) {
              try {
                this[key] = JSON.parse(value);
              }
              catch (err) {
                logData = {[key]: value};
                throw new Error(`Invalid JSON for ${key}: ${err.message || err}`, {cause: err});
              }
            }
            break;

          // Complex array processing - Response Headers
          case "responseHeaders":
            if (value) {
              try {
                let responseHeadersArray = JSON.parse(value);
                this.responseHeaders = {};
                for (let i = 0; i < responseHeadersArray.length; i++) {
                  let head = responseHeadersArray[i].split("=");
                  let headName = head[0];
                  let headValue = head.slice(1).join("=");

                  if (headValue)
                    this.responseHeaders[headName] = headValue;
                  else
                    delete this.responseHeaders[headName];
                }
                if (Object.keys(this.responseHeaders).length === 0)
                  delete this.responseHeaders;
              }
              catch (err) {
                logData = {newResponseHeaders: value};
                throw new Error(`Can't update server's responseHeaders: ${err.message || err}`, {cause: err});
              }
            }
            else {
              delete this.responseHeaders;
            }
            break;

          // CORS allowlist - JSON array of allowed origins. Empty/missing -> fallback to "*"
          case "corsOrigins":
            if (value) {
              try {
                let arr = JSON.parse(value);
                if (!Array.isArray(arr) || !arr.every(o => typeof o === "string"))
                  throw new Error("corsOrigins must be a JSON array of strings");
                if (arr.length)
                  this.corsOrigins = arr;
                else
                  delete this.corsOrigins;
              }
              catch (err) {
                logData = {newCorsOrigins: value};
                throw new Error(`Can't update server's corsOrigins: ${err.message || err}`, {cause: err});
              }
            }
            else
              delete this.corsOrigins;
            break;

          // Complex array processing - Parameters with change notification
          case "params":
            if (value) {
              try {
                let paramsArray = JSON.parse(value);
                let olparams = this.params || {};

                this.params = {};
                for (let i = 0; i < paramsArray.length; i++) {
                  let par = paramsArray[i].split("=");
                  let parName = par[0];
                  let parValue = par.slice(1).join("=");
                  //
                  // If the param value has changed
                  if (parValue !== olparams[parName]) {
                    // Tell every app and every session that the parameter has changed
                    for (let user of this.users) {
                      if (!user.apps)
                        continue; // Skip users with no apps
                      //
                      for (let app of user.apps)
                        await app.handleChangedAppParamMsg({par: parName, old: olparams[parName], new : parValue}, true);   // SkipSave
                    }
                  }
                  //
                  this.params[parName] = parValue;
                }
              }
              catch (err) {
                logData = {newParams: value};
                throw new Error(`Can't update server's parameters: ${err.message || err}`, {cause: err});
              }
            }
            else  // No parameters
              delete this.params;
            break;

          case "customPackages": {
            // Custom packages with package.json update. The target is the server (public_html) by
            // default, or a specific installed ide version (ides/ide_<version>) when the `version`
            // query param is set.
            let version = query.version;
            let target = version ? this.getIdeVersion(version) : this;
            if (version && !target) {
              logData = {version};
              throw Node.Config.requestError(`IDE version ${version} is not installed`, 404);
            }
            //
            let oldcustomPackages = target.customPackages;
            let newcustomPackages;
            if (value) {
              try {
                //  module1@1.0.0,module2@1.0.0,
                newcustomPackages = JSON.parse(`["${value.replace(/,/g, "\",\"")}"]`);
              }
              catch (err) {
                logData = {customPackages: value};
                throw Node.Config.requestError(`Wrong customPackages parameter: ${err.message || err}`, 400, err);
              }
            }
            //
            // Store the new list: a version entry keeps an (empty) array, the server drops the
            // property when empty
            if (version)
              target.customPackages = newcustomPackages || [];
            else if (newcustomPackages)
              this.customPackages = newcustomPackages;
            else
              delete this.customPackages;
            //
            // Update package.json in the right folder (public_html or the version folder). Skip the
            // npm pass entirely when there's nothing to remove nor to add (e.g. clearing an already
            // empty version list, whose [] default would not hit updatePackageJson's early return)
            if ((oldcustomPackages || []).length || newcustomPackages) {
              try {
                await this.updatePackageJson(oldcustomPackages, newcustomPackages, version ? Node.Utils.ideVersionDir(version) : undefined);
              }
              catch (err) {
                logData = {customPackages: value, version};
                throw new Error(`Error while updating package.json file: ${err.message || err}`, {cause: err});
              }
            }
            //
            // Keep the version's install marker aligned with the entry (issue #16466): a rebuilt
            // entry must carry the current list, not the installation-time one. Best-effort, the
            // boot reconciliation realigns a stale marker anyway
            if (version) {
              try {
                await Node.Utils.saveObject(Node.path.join(Node.Utils.ideVersionDir(version), "installInfo.json"), {
                  version,
                  customPackages: target.customPackages
                });
              }
              catch (err) {
                this.logger.log("WARN", `Can't update the install marker of IDE version ${version}: ${err.message || err}`, "Config.configureServer");
              }
            }
            break;
          }
        }
      }
      //
      // Save the new configuration
      await this.saveConfig();
      //
      // Log the operation
      this.logger.log("DEBUG", "Updated server configuration", "Config.configureServer", {config: query});
      //
      // If something changed, restart services
      if (query.numHoursSnapshot !== undefined || query.numMaxSnapshot !== undefined || query.timeSnapshot !== undefined)
        this.server.backupDisk();
      //
      if (query.consoleURL !== undefined || query.timerTokenConsole)
        this.initTokenTimer();
      //
      if ((query.services || "").split(",").includes("track"))
        await this.initTracking();
    }
    catch (err) {
      this.logger.log("WARN", err.message || err, "Config.configureServer", logData);
      throw err;
    }
  }


  /**
   * Gets the list of all non-manager users on the server.
   * Returns an array of usernames excluding the system manager user.
   * @param {Object} params - Request parameters
   * @returns {Object} Message containing JSON array of usernames
   */
  getUsersList(params)
  {
    let users = [];
    for (let user of this.users) {
      if (user.userName === "manager")
        continue; // Skip MANAGER user
      //
      users.push(user.userName);
    }
    //
    return users;
  }


  /**
   * Gets the list of installed IDE versions (multi-version servers) as plain registry entries.
   * Used by {@link Node.Config#getStatus}: returns the persisted form of each entry, never the live
   * Node.IdeVersion instances (whose parent backref would make the status a circular structure).
   * The cl class marker is stripped: it only serves the config.json reviver, consumers of the
   * status (the Console) must not have to know about it.
   * @param {Object} params - Request parameters
   * @returns {Array<Object>} Array of plain registry entries ({version, customPackages})
   */
  getIdeVersionsList(params)
  {
    let ides = [];
    for (let ide of this.ides) {
      let entry = ide.save();
      delete entry.cl;
      ides.push(entry);
    }
    //
    return ides;
  }


  /**
   * Gets the list of all active online sessions.
   * Returns session details including ID, type, user, project, client count and, on multi-version
   * servers, the IDE version the session runs with (so the Console can check for active sessions
   * before uninstalling a version).
   * @param {Object} params - Request parameters
   * @returns {Object} Message containing JSON array of session information
   */
  getSessionsList(params)
  {
    let sessions = [];
    let onlineSessions = this.server.getOnlineSessions();
    for (let sess of onlineSessions) {
      sessions.push({
        id: sess.id,
        type: sess.options.type,
        readOnly: sess.options.readOnly,
        user: sess.project.user.userName,
        project: sess.project.name,
        nClients: sess.countClients(),
        ideVersion: sess.options.openParams?.version
      });
    }
    //
    return sessions;
  }


  /**
   * Refreshes the authentication token and sends it to the console.
   * Generates a new server token and transmits it to the configured console URL.
   * @param {Object} params - Request parameters
   */
  async refreshConsoleToken(params)
  {
    // If I don't need to communicate with the console, do nothing
    if (!this.consoleURL)
      throw new Error("ConsoleURL not set: token not sent");
    //
    // Send the new token to console
    await this.server.request.sendTokenToConsole();
  }


  /**
   * Manages log and console output files with rotation and retrieval.
   * Handles reading, rotating, and clearing of server log files and PM2 console outputs.
   * @param {Object} params - Request parameters with command and file specifications
   * @returns {Object} Log file content or operation result
   */
  async handleLogCommand(params)
  {
    //
    // Possible commands:
    //   manager/log/status[?console=<out/error>&date=<date>]
    //      Sends log/console.out/console.error status (size)
    //   manager/log/clear[?console=<out/error>]
    //      Clears console.out/console.error (LOG can't be cleared)
    //   manager/log/view[?console=<out/error>&date=<date>]
    //      Shows log/console.out/console.error. DATE handled only for LOG
    //   manager/log[?console=<out/error>&date=<date>]
    //      Downloads log/console.out/console.error. DATE handled only for LOG
    //
    let date = params.req.query.date || (new Date()).toISOString().substring(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      return {
        err: "Invalid date format"
      };
    //
    let logData;
    //
    try {
      // Compute filename
      let filename = `${date}.log`;
      //
      // If a console was requested
      if (params.req.query.console !== undefined) {
        switch (params.req.query.console) {
          case "out":
            filename = "console.out.log";
            break;

          case "error":
            filename = "console.error.log";
            break;

          default:
            logData = {
              console: params.req.query.console
            };
            throw new Error("Wrong parameter");
        }
      }
      //
      // Handle commands
      let path = Node.path.resolve(__dirname, "..", "..", "log");
      let command = params.tokens[1] || "download";
      switch (command) {
        case "status":
          return await Node.Config.getLogFileStatus(path, filename);

        case "clear":
          logData = {filename};
          await this.clearConsoleLog(path, filename);
          break;

        case "view":
        case "download":
          return await this.sendLogFile(params, path, filename, command);

        case "checkrotate": {
          logData = {filename};
          let maxLen = 50 * 1024 * 1024;
          await this.rotateConsoleLog(path, filename, maxLen);
          break;
        }

        default:
          logData = {
            cmd: command,
            url: params.req.originalUrl
          };
          throw new Error("Invalid Command");
      }
    }
    catch (err) {
      this.logger.log("WARN", err.message || err, "Config.handleLogCommand", logData);
      throw err;
    }
  }


  /**
   * Gets the status (size) of a log file including its rotated version.
   * @private
   * @param {String} path - Directory path containing log files
   * @param {String} filename - Name of the log file
   * @returns {Object} Object with file size information
   */
  static async getLogFileStatus(path, filename)
  {
    let stats;
    try {
      stats = await Node.fs.promises.stat(Node.path.join(path, filename));
    }
    catch (err) {
      if (err.code !== "ENOENT")
        throw new Error(`Error getting the file ${filename} status: ${err.message || err}`, {cause: err});
    }
    //
    // If .1 file exists, add that file as well
    try {
      let stats1 = await Node.fs.promises.stat(Node.path.join(path, `${filename}.1`));
      if (stats1 && stats)
        stats.size += stats1.size;
    }
    catch (err) {
      if (err.code !== "ENOENT")
        throw new Error(`Error getting the file ${filename}.1 status: ${err.message || err}`, {cause: err});
    }
    //
    return {
      size: stats?.size
    };
  }


  /**
   * Clears a console log file and its rotated version.
   * @private
   * @param {String} path - Directory path containing log files
   * @param {String} filename - Name of the console file to clear
   */
  async clearConsoleLog(path, filename)
  {
    // Can't clear server LOG
    if (!filename.startsWith("console."))
      throw new Error("Can't clear server LOG");
    //
    // Empty the file (don't delete it otherwise PM2 will not create it again)
    try {
      await this.server.execFileAsRoot("/usr/bin/truncate", ["-s0", Node.path.join(path, filename)]);
    }
    catch (err) {
      throw new Error(`Can't clear file ${filename}: ${err.message || err}`, {cause: err});
    }
    //
    // Remove .1 if exists
    try {
      await Node.fs.promises.rm(Node.path.join(path, `${filename}.1`), {force: true});
    }
    catch (err) {
      throw new Error(`Error removing the ${filename}.1: ${err.message || err}`, {cause: err});
    }
  }


  /**
   * Reads and sends a log file to the client for viewing or download.
   * @private
   * @param {Object} params - Request parameters
   * @param {String} path - Directory path containing log files
   * @param {String} filename - Name of the log file
   * @param {String} command - Either "view" or "download"
   */
  async sendLogFile(params, path, filename, command)
  {
    // Read main file
    let data;
    try {
      data = await Node.fs.promises.readFile(Node.path.join(path, filename));
    }
    catch (err) {
      throw new Error(`Error reading the file ${filename}: ${err.message || err}`, {cause: err});
    }
    //
    // Read rotated file if exists and prepend it
    try {
      let data1 = await Node.fs.promises.readFile(Node.path.join(path, `${filename}.1`));
      if (data1)
        data = data1 + data;
    }
    catch (err) {
      if (err.code !== "ENOENT")
        throw new Error(`Error reading the file ${filename}.1: ${err.message || err}`, {cause: err});
    }
    //
    // Send response
    params.res.status(200);
    if (command === "view") {
      params.res.setHeader("Content-type", "text/plain");
      params.res.write(data, "binary");
    }
    else {
      params.res.setHeader("Content-disposition", `attachment; filename = ${this.name}-${filename}`);
      params.res.write(data, "binary");
    }
    params.res.end();
  }


  /**
   * Rotates a console log file if it exceeds maximum size.
   * @private
   * @param {String} path - Directory path containing log files
   * @param {String} filename - Name of the console file
   * @param {Number} maxLen - Maximum file size before rotation
   */
  async rotateConsoleLog(path, filename, maxLen)
  {
    if (!filename.startsWith("console."))
      throw new Error("Can't rotate server LOG");
    //
    // Check file size
    let rotateStats;
    try {
      rotateStats = await Node.fs.promises.stat(Node.path.join(path, filename));
    }
    catch (err) {
      throw new Error(`Error reading the file ${filename}: ${err.message || err}`, {cause: err});
    }
    //
    // If bigger than maxLen -> rotate!
    if (rotateStats.size > maxLen) {
      // Remove old .1 if exists
      try {
        await Node.fs.promises.rm(Node.path.join(path, `${filename}.1`), {force: true});
      }
      catch (err) {
        throw new Error(`Error removing the ${filename}.1: ${err.message || err}`, {cause: err});
      }
      //
      // Copy last portion to .1 file
      let data;
      try {
        data = await Node.fs.promises.readFile(Node.path.join(path, filename), "utf8");
      }
      catch (err) {
        throw new Error(`Error reading the file ${filename}: ${err.message || err}`, {cause: err});
      }
      //
      try {
        await Node.fs.promises.writeFile(Node.path.join(path, `${filename}.1`), data.slice(-maxLen));
      }
      catch (err) {
        throw new Error(`Error copying the ${filename} to .1: ${err.message || err}`, {cause: err});
      }
      //
      // Clear the main file
      try {
        await this.server.execFileAsRoot("/usr/bin/truncate", ["-s0", Node.path.join(path, filename)]);
      }
      catch (err) {
        throw new Error(`Can't clear file ${filename}: ${err.message || err}`, {cause: err});
      }
    }
  }


  /**
   * Downloads a release archive from the cloud and extracts it into a fresh temporary directory.
   * The archive is a `.tar.gz` holding the whole repo in the flat layout (`server/` next to `ide/`
   * plus the package files). Mirrors the download/extract done by {@link Node.Config#installUpdate}.
   * Self-cleaning: on failure the temporary directory is removed before rethrowing; on success the
   * caller is responsible for removing the returned `tempPath`.
   * @param {String} file - Release archive: a name resolved under `updates/` on the cloud bucket, or an absolute http(s) URL
   * @returns {Promise<Object>} `{tempPath, srcRoot}` — the temp dir to clean up and the root of the extracted repo tree
   * @throws {Error} When the download or extraction fails
   */
  async extractRelease(file)
  {
    let foldername = file.slice(0, -7);   // remove .tar.gz
    let pathCloud = `updates/${file}`;
    let tempPath = Node.path.join(Node.Utils.rootDir(), "update.tmp");
    //
    // Absolute URLs: the file is the source itself
    if (file.toLowerCase().startsWith("http://") || file.toLowerCase().startsWith("https://")) {
      pathCloud = file;
      foldername = foldername.substring(foldername.lastIndexOf("/") + 1);
    }
    //
    try {
      // Fresh temporary directory (protect against a leftover from a crashed run)
      await Node.fs.promises.rm(tempPath, {recursive: true, force: true});
      await Node.fs.promises.mkdir(tempPath);
      //
      // Download from the cloud and extract into the temp directory
      let archiver = new Node.Archiver(this.server);
      await archiver.restore(Node.path.join(tempPath, foldername), pathCloud);
      //
      // The archive's top directory, picked by type: that leaves out both the dot-entries macOS
      // adds to tar.gz files and the downloaded archive, which is a sibling of the directory when
      // the restore could not delete it
      let entries = await Node.fs.promises.readdir(tempPath, {withFileTypes: true});
      let srcDir = entries.find(entry => entry.isDirectory())?.name;
      //
      return {tempPath, srcRoot: Node.path.join(tempPath, srcDir)};
    }
    catch (err) {
      // Best-effort cleanup of the temp dir; the extraction error below is the surfaced cause
      try {
        await Node.fs.promises.rm(tempPath, {recursive: true, force: true});
      }
      catch (e) {
        this.logger.log("WARN", `Can't remove temp dir ${tempPath}: ${e}`, "Config.extractRelease");
      }
      //
      throw new Error(`Error extracting release ${file}: ${err.message || err}`, {cause: err});
    }
  }


  /**
   * Installs an IDE version into `ides/ide_<version>` from an already-extracted release tree: copies
   * the pieces that make up a version folder — `ide/` next to a copy of `server/` plus the package
   * files — so that the relative requires between the two resolve within the folder. The archive
   * carries no `node_modules`, so they are installed inside the folder, applying this version's
   * custom packages in the same single npm pass; finally the version (with its custom packages) is
   * recorded in the installed-versions registry (`ides`) and the configuration is persisted. Does
   * NOT download/extract (the caller does that via {@link Node.Config#extractRelease}) nor touch the
   * shared `public_html` layout, so it is reused both by the installIdeVersion command and by update
   * for the ide part. Transactional: on any failure the partially-created folder and the registry
   * entry are rolled back, so a failed install never leaves a corrupt/unregistered version.
   * @param {Object} params - Options
   * @param {String} params.srcRoot - Absolute path of the extracted release tree (holds `ide/`, `server/` and the package files)
   * @param {String} params.version - IDE version to install (folder name `ides/ide_<version>`)
   * @param {Array} [params.customPackages] - Custom NPM package specs for this IDE version (e.g. `["pkg@1.2.3"]`), applied during install
   * @param {String} [params.relinkInstallations] - Re-link to the new version the installed apps whose node_modules point to this version (fix flow)
   * @param {Boolean} [params.replaceLinked] - Sweep a dead install folder even when apps are linked to it (Console-driven installs: the folder is recreated under the same name); without it the sweep refuses with 409
   * @throws {Error} When the version is already installed, or a copy/install/save step fails
   */
  async installIdeVersion(params)
  {
    let {srcRoot, version, customPackages, relinkInstallations, replaceLinked} = params;
    let destRoot = Node.Utils.ideVersionDir(version);
    //
    // A folder the registry does not know and no marker certifies is a dead install (what an
    // interruption leaves behind): sweep it and proceed — the 409 below belongs to the living
    // states (registered, or certified complete and pending re-registration at the next boot).
    // A removal failure fails the install: overwriting is never an option
    if (Node.fs.existsSync(destRoot) && !this.isIdeVersionInstalled(version) && !Node.fs.existsSync(Node.path.join(destRoot, "installInfo.json"))) {
      // With apps still running on it, the caller decides: a Console-driven install proceeds like
      // the replace flow does — the folder is recreated under the same name, the symlinks resolve
      // again, and until then the apps may fail module loads; refusing would instead deadlock the
      // retry of an interrupted replace, whose leftover is exactly this state. The boot migration
      // must not break apps on its own: it refuses, the log says why and the operator decides
      let linkedApps = await this.getLinkedApps(version);
      if (linkedApps.length) {
        if (!replaceLinked)
          throw Node.Config.requestError(`Cannot install IDE version ${version}: a dead install folder is present and these apps are linked to it: ${linkedApps.join(", ")}`, 409);
        //
        this.logger.log("WARN", `Replacing the dead install of IDE version ${version} while these apps are linked to it: ${linkedApps.join(", ")} (they may fail module loads until the install recreates the version folder)`, "Config.installIdeVersion", {version, linkedApps});
      }
      else
        this.logger.log("WARN", `Removing the dead install of IDE version ${version} before installing it`, "Config.installIdeVersion");
      //
      await this.server.removeDir(destRoot);
    }
    //
    // Guard: never overwrite an existing version (keeps the rollback below always safe to run)
    if (Node.fs.existsSync(destRoot) || this.isIdeVersionInstalled(version))
      throw Node.Config.requestError(`IDE version ${version} is already installed`, 409);
    //
    let registered = false;
    try {
      // Create the version folder (and the ides/ parent if missing)
      await Node.fs.promises.mkdir(destRoot, {recursive: true});
      //
      // Mirror the repo layout: copy ide/ and server/ so their relative requires resolve in-folder
      for (let dir of ["ide", "server"]) {
        await new Promise((resolve, reject) => {
          Node.ncp(Node.path.join(srcRoot, dir), Node.path.join(destRoot, dir), err => {
            if (err)
              reject(new Error(`Error copying ${dir}: ${err.message || err}`, {cause: err}));
            else
              resolve();
          });
        });
      }
      //
      // Copy the package files (node_modules are not in the archive: installed next). Releases with
      // split dependencies keep the full IDE set in ide/package.json (the root one holds only the
      // server modules): prefer that form, falling back to the root files for older releases
      let pkgDir = Node.fs.existsSync(Node.path.join(srcRoot, "ide", "package.json")) ? Node.path.join(srcRoot, "ide") : srcRoot;
      for (let pkgFile of ["package.json", "package-lock.json"]) {
        let src = Node.path.join(pkgDir, pkgFile);
        if (Node.fs.existsSync(src))
          await Node.fs.promises.copyFile(src, Node.path.join(destRoot, pkgFile));
      }
      //
      // Install node_modules inside the folder, applying this version's custom packages (single npm pass)
      await this.updateNodeModules({customPackages, targetDir: destRoot});
      //
      // Certify the folder as complete (issue #16466): the marker lets the boot reconciliation
      // re-register an orphan folder instead of removing it, and carries the custom packages the
      // rebuilt entry needs. Written before the registry entry, so a folder without it is a dead
      // install by protocol
      await Node.Utils.saveObject(Node.path.join(destRoot, "installInfo.json"), {
        version,
        customPackages: customPackages || []
      });
      //
      // Record the version (with its custom packages) in the installed-versions registry and
      // persist. A failed write must fail the install (rethrow): declaring installed a version the
      // on-disk registry does not know leaves an orphan folder after a reboot (issue #16466)
      let entry = new Node.IdeVersion(this);
      entry.version = version;
      entry.customPackages = customPackages || [];
      this.ides.push(entry);
      registered = true;
      await this.saveConfig(true);
      //
      // Fix flow: migrate to the new version the apps that were linked to the version being replaced
      // (the Console will uninstall it right after). Best-effort per app: one that can't be re-linked
      // keeps pointing to the old version, whose uninstall will then be refused (recoverable state)
      if (relinkInstallations)
        await this.relinkInstallations(relinkInstallations, version);
    }
    catch (err) {
      // Roll back: drop the registry entry and persist (so disk matches memory even if saveConfig
      // above had already written the entry before failing), then remove the partial folder through
      // removeDir: UpdNodePackages runs npm as root, so node_modules may contain root-owned files
      // the server process couldn't delete. Cleanup failures are logged but not rethrown, so
      // the original install error stays the surfaced cause.
      if (registered) {
        this.ides = this.ides.filter(ide => ide.version !== version);
        try {
          await this.saveConfig(true);
        }
        catch (e) {
          this.logger.log("WARN", `Can't persist registry rollback for IDE version ${version}: ${e}`, "Config.installIdeVersion");
        }
      }
      //
      // Invalidate the completion marker BEFORE removing the folder: an interrupted removal must
      // not leave a certified-looking partial folder for the boot reconciliation to re-register.
      // The single try makes a failed marker removal skip the folder removal too: the marker only
      // exists past npm, so the folder is complete — keeping it whole and certified is truthful,
      // a partial removal would not be
      try {
        await Node.fs.promises.rm(Node.path.join(destRoot, "installInfo.json"), {force: true});
        await this.server.removeDir(destRoot);
      }
      catch (e) {
        this.logger.log("WARN", `Can't remove the partial version folder: ${e}`, "Config.installIdeVersion");
      }
      //
      throw new Error(`Error installing IDE version ${version}: ${err.message || err}`, {cause: err});
    }
  }


  /**
   * Lists the applications installed in `apps`, leaving out what only looks like one: what a restore
   * and an installation leave behind when their own cleanup fails. The backup of a restore is a full
   * copy of an app folder, node_modules symlink included, so every filter based on the folder's
   * content would take it for an application; the temporary folder of an installation holds the
   * package just extracted, and the downloaded archive carries the app's own name.
   * @returns {Promise<String[]>} Names of the installed apps, empty when there is no apps folder
   */
  async listInstalledApps()
  {
    try {
      let entries = await Node.fs.promises.readdir(Node.path.join(this.appDirectory, "apps"));
      return entries.filter(entry => !Node.Config.appLeftoverSuffixes.some(suffix => entry.endsWith(suffix)));
    }
    catch (err) {
      return [];    // no apps folder: nothing is installed
    }
  }


  /**
   * Re-links the installed apps from one IDE version to another: every app whose node_modules
   * symlink points to `ides/ide_<fromVersion>` is re-pointed to `ides/ide_<toVersion>` (fix flow:
   * the Console installs the fixed version asking to migrate the apps of the one being replaced).
   * Best-effort per app; apps without a symlink (shared modules or own node_modules folder) are skipped.
   * @param {String} fromVersion - Version the apps to migrate are linked to
   * @param {String} toVersion - Version to link them to
   */
  async relinkInstallations(fromVersion, toVersion)
  {
    if (!this.appDirectory)
      return;
    //
    let appsDir = Node.path.join(this.appDirectory, "apps");
    let newModules = Node.path.join(Node.Utils.ideVersionDir(toVersion), "node_modules");
    for (let appName of await this.listInstalledApps()) {
      let link = Node.path.join(appsDir, appName, "node_modules");
      let target;
      try {
        target = await Node.fs.promises.readlink(link);
      }
      catch (err) {
        continue;   // no symlink inside this app: not linked to any version
      }
      if ((target.match(/ide_([0-9A-Za-z.-]+)[\/\\]node_modules$/) || [])[1] !== fromVersion)
        continue;
      //
      try {
        await Node.fs.promises.rm(link, {force: true});
        await Node.fs.promises.symlink(newModules, link, "dir");
        this.logger.log("INFO", `App ${appName} re-linked from IDE version ${fromVersion} to ${toVersion}`, "Config.relinkInstallations");
      }
      catch (err) {
        this.logger.log("WARN", `Can't re-link app ${appName} from IDE version ${fromVersion} to ${toVersion}: ${err.message || err}`, "Config.relinkInstallations");
      }
    }
  }


  /**
   * Lists the installed apps whose node_modules symlink points to the given IDE version's folder
   * (issue #7571): they run on that version's modules, so removing the folder would break them at
   * the first module resolution.
   * @param {String} version - IDE version to check
   * @returns {Promise<String[]>} Names of the linked apps, empty when there is no app directory
   */
  async getLinkedApps(version)
  {
    let linkedApps = [];
    if (!this.appDirectory)
      return linkedApps;
    //
    // Read the apps folder directly instead of listInstalledApps, which flattens every read error
    // to "no apps": here that would turn an I/O failure into "no linked apps", and the callers use
    // the answer to decide a removal
    let appsDir = Node.path.join(this.appDirectory, "apps");
    let appNames;
    try {
      appNames = await Node.fs.promises.readdir(appsDir);
    }
    catch (err) {
      if (err.code === "ENOENT")
        return linkedApps;
      //
      throw err;
    }
    //
    let versionModules = Node.path.join(Node.Utils.ideVersionDir(version), "node_modules");
    for (let appName of appNames.filter(name => !Node.Config.appLeftoverSuffixes.some(suffix => name.endsWith(suffix)))) {
      try {
        if (await Node.fs.promises.readlink(Node.path.join(appsDir, appName, "node_modules")) === versionModules)
          linkedApps.push(appName);
      }
      catch (err) {
        // ENOENT: no node_modules inside the app; EINVAL: a real folder, not a symlink (an app on
        // its own modules). Anything else is an answer we did not get — surface it, "could not
        // check" must never read as "not linked"
        if (!["ENOENT", "EINVAL"].includes(err.code))
          throw err;
      }
    }
    //
    return linkedApps;
  }


  /**
   * Uninstalls an IDE version: removes its `ides/ide_<version>` folder (as root, since the node_modules
   * created by npm may be root-owned) and drops it from the installed-versions registry. Refuses to
   * remove the master version (the one matching the server), which must always stay installed
   * (invariant: no IDE newer than the master).
   * @param {String} version - IDE version to uninstall
   * @param {Boolean} [force] - Terminate the open sessions running this version instead of refusing
   * @param {Boolean} [reinstall] - The caller is replacing the version and reinstalls it right after (the update's rebuild flow): skip the master-version guard and demote the linked-apps guard to a warning
   * @returns {Promise<String[]>} Names of the installed apps linked to the version (the reinstall caller reports them if the reinstall then fails)
   * @throws {Error} When the version is the master (unless reinstall), is not installed, is linked to some installed app (unless reinstall), or a removal/save step fails
   */
  async uninstallIdeVersion(version, force, reinstall)
  {
    if (!reinstall && version === this.server.version)
      throw Node.Config.requestError(`Cannot uninstall the master IDE version ${version}`, 409);
    //
    if (!this.isIdeVersionInstalled(version))
      throw Node.Config.requestError(`IDE version ${version} is not installed`, 404);
    //
    // Refuse when some installed app is linked to this version's node_modules (issue #7571):
    // removing the folder would break those apps at the first module resolution. This guard is not
    // bypassed by force, so it must run before the session-termination block below: killing the
    // users' sessions for an operation that would then be refused anyway is an avoidable damage.
    // In the reinstall flow the folder is recreated right after under the same name and the apps'
    // symlinks resolve again by themselves, so the linked apps only risk failing lazy module loads
    // during the reinstall window: warn instead of refusing
    let linkedApps = await this.getLinkedApps(version);
    if (linkedApps.length) {
      if (!reinstall)
        throw Node.Config.requestError(`Cannot uninstall IDE version ${version}: the following apps are linked to it: ${linkedApps.join(", ")}`, 409);
      //
      this.logger.log("WARN", `Replacing IDE version ${version} while these apps are linked to it: ${linkedApps.join(", ")} (they may fail module loads until the update recreates the version folder)`, "Config.uninstallIdeVersion", {version, linkedApps});
    }
    //
    // Sessions running this version's child: removing the folder under a live child would break its
    // lazy requires. Refuse, unless the caller forces the operation: then the sessions are terminated
    // (the same way editProject kills a dying session) and their children get a grace period to exit
    let versionSessions = Object.values(this.server.IDESessions || {}).filter(sess => sess.options?.openParams?.version === version);
    if (versionSessions.length) {
      if (!force)
        throw Node.Config.requestError(`Cannot uninstall IDE version ${version}: it is in use by an open session of project ${versionSessions[0].project?.name}`, 409);
      //
      this.logger.log("INFO", `Terminating ${versionSessions.length} open sessions using IDE version ${version} (force)`, "Config.uninstallIdeVersion", {version});
      for (let sess of versionSessions)
        sess.closeAllConnections();
      //
      // Wait (up to 15 seconds) for the children to terminate and leave the sessions map
      for (let i = 0; i < 30 && Object.values(this.server.IDESessions).some(sess => sess.options?.openParams?.version === version); i++)
        await new Promise(resolve => setTimeout(resolve, 500));
      //
      if (Object.values(this.server.IDESessions).some(sess => sess.options?.openParams?.version === version))
        this.logger.log("WARN", `Some sessions using IDE version ${version} did not terminate within the grace period`, "Config.uninstallIdeVersion", {version});
    }
    //
    // Uninstall protocol (issue #16466), ordered so every interruption lands in a state the boot
    // reconciliation heals TOWARDS "uninstalled" — the folder must not go first: an interrupted
    // removal would leave a registered partial folder the marker backfill would then certify.
    // 1) Decertify: on failure the version is still fully installed and consistent
    let destRoot = Node.Utils.ideVersionDir(version);
    await Node.fs.promises.rm(Node.path.join(destRoot, "installInfo.json"), {force: true});
    //
    // 2) Deregister and persist: on failure restore the entry and its marker — back to fully
    // installed (an interruption in between leaves a registered complete folder without marker,
    // which the backfill re-certifies: the uninstall simply never happened)
    let entry = this.ides.find(ide => ide.version === version);
    this.ides = this.ides.filter(ide => ide.version !== version);
    try {
      await this.saveConfig(true);
    }
    catch (err) {
      this.ides.push(entry);
      try {
        await Node.Utils.saveObject(Node.path.join(destRoot, "installInfo.json"), {
          version,
          customPackages: entry.customPackages || []
        });
      }
      catch (e) {
        this.logger.log("WARN", `Can't rewrite the install marker of IDE version ${version}: ${e}`, "Config.uninstallIdeVersion");
      }
      throw err;
    }
    //
    // 3) Remove the folder through removeDir (npm runs as root, so node_modules may be root-owned).
    // The version is already gone from the registry: a failure here leaves an unmarked
    // unregistered leftover that the boot reconciliation (or a reinstall of the same version)
    // sweeps by itself, so it is surfaced but the state needs no undo
    await this.server.removeDir(destRoot);
    //
    return linkedApps;
  }


  /**
   * Reconciles the `ides` folders with the installed-versions registry at boot (issue #16466), in
   * both directions. Registry side: an entry whose folder is missing (an uninstall interrupted
   * between the folder removal and the config write) is dropped, so the version stops being
   * selectable and a reinstall stops being refused. Marker side: registered folders get the
   * installInfo.json marker backfilled or realigned to the entry (the registry is the authority on
   * them). Folder side: an unregistered folder WITH the marker was fully installed and only lost
   * its registry entry (a crash before the config write, a config.json restored from its backup) —
   * its entry is rebuilt from the marker instead of losing the folder; one WITHOUT the marker is a
   * dead install by protocol: removed, unless some installed app is still linked to it — the
   * folder is serving those apps through their node_modules symlink, registry or not, so removing
   * it would break them. Every step is best-effort and retried at the next boot, and no failure
   * ever escalates to a removal. Skipped on a deliberate flat layout (flatVersion marker): the
   * leftovers of the undone mirror must not be re-registered. Must run after the (root) childer is
   * available, since the removal goes through it (npm may have left root-owned files in
   * node_modules).
   */
  async reconcileIdeVersions()
  {
    // Same skip guards as the migration: local development and Instant Developer Studio never
    // hold a mirror layout, and on a deliberate flat (flatVersion) the ides leftovers belong to a
    // downgrade that removal failures left behind — re-registering them would resurrect the
    // mirror
    if (this.local || this.serverType === "instant-developer-studio" || this.flatVersion)
      return;
    //
    // Drop the entries whose folder is missing (an uninstall or a downgrade interrupted after the
    // removal, before or without the config write): the version can't serve sessions and its 409
    // would refuse a reinstall forever. Checked BEFORE the ides guard below, since the whole
    // folder can be gone with the registry still populated. On a save failure the entries come
    // back in memory, so memory and disk stay aligned and the next boot retries
    let missing = this.ides.filter(ide => !Node.fs.existsSync(Node.Utils.ideVersionDir(ide.version)));
    if (missing.length) {
      this.ides = this.ides.filter(ide => !missing.includes(ide));
      try {
        await this.saveConfig(true);
        this.logger.log("WARN", `Dropped from the registry the IDE versions whose folder is missing: ${missing.map(ide => ide.version).join(", ")}`, "Config.reconcileIdeVersions");
      }
      catch (err) {
        this.ides = this.ides.concat(missing);
        this.logger.log("WARN", `Can't drop from the registry the IDE versions whose folder is missing: ${err.message || err}`, "Config.reconcileIdeVersions");
      }
    }
    //
    // Flat servers have no ides folder at all: nothing else to reconcile
    let idesDir = Node.Utils.idesDir();
    if (!Node.fs.existsSync(idesDir))
      return;
    //
    // Backfill the marker on registered folders installed before it existed, and realign one whose
    // custom packages drifted (the config command edits the entry, not the marker), so a future
    // registry regression (e.g. a config.json restored from its .bak) can rebuild faithful entries
    for (let ide of this.ides) {
      let folder = Node.Utils.ideVersionDir(ide.version);
      if (!Node.fs.existsSync(folder))
        continue;
      //
      let markerFile = Node.path.join(folder, "installInfo.json");
      let wanted = {
        version: ide.version,
        customPackages: ide.customPackages || []
      };
      try {
        let marker;
        try {
          marker = Node.fs.existsSync(markerFile) ? await Node.Utils.loadObject(markerFile) : undefined;
        }
        catch (err) {
          // Unreadable marker: rewritten below
        }
        if (JSON.stringify(marker) === JSON.stringify(wanted))
          continue;
        //
        await Node.Utils.saveObject(markerFile, wanted);
        this.logger.log("INFO", `${marker ? "Realigned" : "Backfilled"} the install marker of IDE version ${ide.version}`, "Config.reconcileIdeVersions");
      }
      catch (err) {
        this.logger.log("WARN", `Can't write the install marker of IDE version ${ide.version}: ${err.message || err}`, "Config.reconcileIdeVersions");
      }
    }
    //
    for (let entry of await Node.fs.promises.readdir(idesDir)) {
      if (!entry.startsWith("ide_"))
        continue;
      //
      let version = entry.substring(4);
      if (this.isIdeVersionInstalled(version))
        continue;
      //
      // Marker present: the folder is certified complete, only its registry entry is lost. Rebuild
      // the entry (the version is the folder name, the registry key; the marker only adds the
      // custom packages — an unreadable one still forbids the removal, it just loses that list)
      let folder = Node.path.join(idesDir, entry);
      if (Node.fs.existsSync(Node.path.join(folder, "installInfo.json"))) {
        let customPackages = [];
        try {
          customPackages = (await Node.Utils.loadObject(Node.path.join(folder, "installInfo.json")))?.customPackages || [];
        }
        catch (err) {
          this.logger.log("WARN", `Unreadable install marker of IDE version ${version}: re-registering it without custom packages`, "Config.reconcileIdeVersions", {version});
        }
        //
        let ide = new Node.IdeVersion(this);
        ide.version = version;
        ide.customPackages = customPackages;
        this.ides.push(ide);
        try {
          await this.saveConfig(true);
          this.logger.log("WARN", `IDE version ${version} was installed but not in the registry: entry rebuilt from its install marker`, "Config.reconcileIdeVersions", {version, customPackages});
        }
        catch (err) {
          // The folder stays (it has the marker): the next boot retries
          this.ides = this.ides.filter(i => i.version !== version);
          this.logger.log("WARN", `Can't re-register IDE version ${version}: ${err.message || err}`, "Config.reconcileIdeVersions");
        }
        continue;
      }
      //
      // No marker: a dead install. Keep it anyway when some installed app still runs on its
      // node_modules, and fail safe towards keeping when the scan itself fails
      let linkedApps;
      try {
        linkedApps = await this.getLinkedApps(version);
      }
      catch (err) {
        this.logger.log("WARN", `Can't check the apps linked to the orphan IDE version folder ${entry}: keeping it (${err.message || err})`, "Config.reconcileIdeVersions");
        continue;
      }
      if (linkedApps.length) {
        this.logger.log("WARN", `Orphan IDE version folder ${entry} kept: these apps are linked to it: ${linkedApps.join(", ")}`, "Config.reconcileIdeVersions", {version, linkedApps});
        continue;
      }
      //
      this.logger.log("WARN", `Removing the orphan IDE version folder ${entry} (not in the registry, no install marker)`, "Config.reconcileIdeVersions");
      try {
        await this.server.removeDir(folder);
      }
      catch (err) {
        this.logger.log("WARN", `Can't remove the orphan IDE version folder ${entry}: ${err.message || err}`, "Config.reconcileIdeVersions");
      }
    }
  }


  /**
   * Migrates a flat (single-version) server to the multi-version layout on the first 26.3 boot:
   * builds `ides/ide_<master>` from the current flat layout (`public_html/{ide,server,package.json}`)
   * by reusing {@link Node.Config#installIdeVersion} (so the version folder is identical to any
   * installed version — copy of ide/+server/, fresh npm install, registry entry), then removes the
   * now-redundant flat `public_html/ide`. The shared server part (`server/`, `node_modules`,
   * `package.json`) stays in `public_html`. Detection is by state: it runs only while the registry is
   * empty and a flat `ide` folder is present, so it is idempotent. On failure `installIdeVersion`
   * rolls back, leaving the flat layout intact so the server keeps running single-version and retries
   * on the next boot. Must run after the (root) childer is available, since npm/rm go through it.
   * @throws {Error} When the server version is unknown or the version install fails
   */
  async migrateToMultiVersion()
  {
    let flatIde = Node.path.join(Node.Utils.rootDir(), "ide");
    //
    // Never migrate: in local development (the repo runs flat from public_html), on Instant Developer
    // Studio (standalone Electron build, single-version by design), when the flat layout is deliberate
    // (flatVersion marker, left by a legacy-scope install of a >= 26.3 release), when already
    // multi-version, or with no flat ide layout to migrate (e.g. self-managed production servers,
    // which don't host the IDE)
    if (this.local || this.serverType === "instant-developer-studio" || this.flatVersion || this.ides.length > 0 || !Node.fs.existsSync(flatIde))
      return;
    //
    let version = this.server.version;
    if (!version)
      throw new Error("Cannot migrate to multi-version: server version unknown");
    //
    this.logger.log("INFO", `Migrating to multi-version layout (master ${version})`, "Config.migrateToMultiVersion");
    //
    // Self-heal: a stale ides/ folder can survive a failed downgrade cleanup (its removal there is
    // best-effort). The registry is empty here and the flat ide is present — whatever ides/ holds
    // is a leftover of a mirror episode the downgrade deliberately undid, install markers
    // included: re-registering those folders would resurrect it, so the sweep is marker-blind —
    // and a leftover ide_<master> would make the install below fail forever on its anti-overwrite
    // guard. Folders some installed app still runs on are spared instead (removing them would
    // break the app; a spared ide_<master> makes the install below fail, and the log says why).
    // Best-effort per folder: what can't be removed is retried at the next boot
    if (Node.fs.existsSync(Node.Utils.idesDir())) {
      for (let entry of await Node.fs.promises.readdir(Node.Utils.idesDir())) {
        // The certified folder of the very version being migrated is the completed install of a
        // previous attempt that died before persisting the registry: spared here, reused below
        if (entry === `ide_${version}` && Node.fs.existsSync(Node.path.join(Node.Utils.idesDir(), entry, "installInfo.json")))
          continue;
        //
        let linkedApps;
        try {
          linkedApps = entry.startsWith("ide_") ? await this.getLinkedApps(entry.substring(4)) : [];
        }
        catch (err) {
          this.logger.log("WARN", `Can't check the apps linked to the stale folder ${entry}: keeping it (${err.message || err})`, "Config.migrateToMultiVersion");
          continue;
        }
        if (linkedApps.length) {
          this.logger.log("WARN", `Stale folder ${entry} kept before migration: these apps are linked to it: ${linkedApps.join(", ")}`, "Config.migrateToMultiVersion", {linkedApps});
          continue;
        }
        //
        // Decertify before removing (the same protocol as the install rollback): an interrupted
        // removal must not leave a certified partial folder for the reconciliation to register.
        // The single try makes a failed marker removal keep the folder whole: the reconciliation
        // then re-registers a complete version, never a broken one
        try {
          await Node.fs.promises.rm(Node.path.join(Node.Utils.idesDir(), entry, "installInfo.json"), {force: true});
          await this.server.removeDir(Node.path.join(Node.Utils.idesDir(), entry));
        }
        catch (err) {
          this.logger.log("WARN", `Can't remove the stale folder ${entry} before migration: ${err}`, "Config.migrateToMultiVersion");
        }
      }
    }
    //
    // Build ides/ide_<version> from the flat layout, reusing the version installer (transactional).
    // The custom packages stay server-level, where they were before the migration (the apps still
    // reach them through the walk-up to the shared node_modules): pinning them on a version is a
    // choice left to the user. A certified folder spared by the sweep above is re-registered as it
    // is: rebuilding it would waste a completed npm pass and risk losing a ready version
    let destRoot = Node.Utils.ideVersionDir(version);
    if (Node.fs.existsSync(Node.path.join(destRoot, "installInfo.json"))) {
      this.logger.log("INFO", `Reusing the completed version folder of a previous migration attempt (master ${version})`, "Config.migrateToMultiVersion");
      let ide = new Node.IdeVersion(this);
      ide.version = version;
      ide.customPackages = [];
      this.ides.push(ide);
      try {
        await this.saveConfig(true);
      }
      catch (err) {
        this.ides = this.ides.filter(i => i.version !== version);
        throw err;
      }
    }
    else
      await this.installIdeVersion({srcRoot: Node.Utils.rootDir(), version});
    //
    // The projects' lastSaveVersion is deliberately NOT stamped here: the version they were really
    // saved with (the pre-update release) is not knowable at this point — the classic update already
    // replaced the whole flat layout, and old releases never recorded it — while stamping the migrated
    // master would be a false claim (it would end up in the status and in the backups of
    // genuinely-older projects). Empty is the honest
    // state: opens keep resolving to the highest installed version, the Console decides the default
    // for version-less projects, and the first real save records the truth (the shared server injects
    // it even for pre-26.3 children).
    //
    // Link the already-installed apps to the migrated version's node_modules (issue #7571), so they
    // keep the modules they were running on before the migration. Best-effort per app: an app that
    // can't be linked keeps resolving the shared node_modules through the appDirectory link
    if (this.appDirectory) {
      let appsDir = Node.path.join(this.appDirectory, "apps");
      let versionModules = Node.path.join(Node.Utils.ideVersionDir(version), "node_modules");
      for (let appName of await this.listInstalledApps()) {
        // Only real apps (folders with a server part), and only when there's no node_modules yet
        // (lstat, not existsSync: a broken symlink must count as present)
        let appRoot = Node.path.join(appsDir, appName);
        if (!Node.fs.existsSync(Node.path.join(appRoot, "server")))
          continue;
        try {
          await Node.fs.promises.lstat(Node.path.join(appRoot, "node_modules"));
          continue;
        }
        catch (err) {
          // No node_modules in the app folder: link it
        }
        //
        try {
          await Node.fs.promises.symlink(versionModules, Node.path.join(appRoot, "node_modules"), "dir");
        }
        catch (err) {
          this.logger.log("WARN", `Can't link app ${appName} to IDE version ${version}: ${err.message || err}`, "Config.migrateToMultiVersion");
        }
      }
    }
    //
    // Remove the now-redundant flat ide (best-effort: a leftover is harmless, resolveIdeDir uses
    // ides/ide_<version>/ide)
    try {
      await this.server.removeDir(flatIde);
    }
    catch (err) {
      this.logger.log("WARN", `Can't remove the flat ide folder after migration: ${err}`, "Config.migrateToMultiVersion");
    }
    //
    // On Linux the migration runs while the process is still ROOT (the privileges drop waits for the
    // HTTP/HTTPS listen), so everything under ides/ was created root-owned. Fix the ownership right
    // away: the boot-time setOwnerToIndert pass runs only after the listen and is fire-and-forget,
    // which leaves a window where an installIdeVersion command, running as INDERT, would fail its
    // mkdir inside a root-owned ides/. On FreeBSD the drop happens before the migration, so the
    // folder is already owned by INDERT
    if (process.platform === "linux" && !this.local && Node.fs.existsSync("/mnt/disk")) {
      try {
        await this.server.execFileAsRoot("/bin/chown", ["-R", "indert:indert", Node.Utils.idesDir()]);
      }
      catch (err) {
        this.logger.log("WARN", `Can't fix the ides folder ownership after migration: ${err}`, "Config.migrateToMultiVersion");
      }
    }
    //
    this.logger.log("INFO", `Multi-version migration complete (master ${version})`, "Config.migrateToMultiVersion");
  }


  /**
   * Downgrades a multi-version server back to the flat single-version layout (the reverse of
   * {@link Node.Config#migrateToMultiVersion}), used when updating to a release without multi-version
   * support (< 26.3) or when deliberately installing a >= 26.3 release flat (internal capability).
   * Installs the target release flat onto `public_html` — updates the shared `server/` (via
   * {@link Node.Config#updateServerPart}, with its server.bak rollback) and restores the flat
   * `public_html/ide` (absent on a mirror server) — then unmounts the mirror by removing the `ides/`
   * folder and clearing the installed-versions registry. The flatVersion marker is persisted only
   * for >= 26.3 targets (see below). The server install runs first, so a failure there leaves the
   * mirror intact for a retry; the unmount is the last step. Takes effect after the next reboot
   * (into the flat target version).
   * @param {Object} params - Options
   * @param {String} params.srcRoot - Absolute path of the extracted release tree (holds `ide/`, `server/` and the package files)
   * @param {Boolean} [params.noPackages] - When true skips the plain npm install (the update command's `nopackages` flag)
   * @param {String} [params.targetVersion] - Version of the target release (the update's `version` parameter); absent = old release (< 26.3)
   * @throws {Error} When a copy or the npm install fails
   */
  async migrateToFlatVersion(params)
  {
    let {srcRoot, noPackages, targetVersion} = params;
    let publicHtml = Node.Utils.rootDir();
    //
    // Restore the flat ide first (absent on a mirror server): copy the target release's ide onto
    // public_html. Doing this before the server update keeps any single-step failure recoverable —
    // resolveIdeDir still uses ides/ide_<master>/ide, so a leftover public_html/ide is ignored and the
    // server keeps booting as a working 26.3 mirror until the whole downgrade succeeds.
    // Remove a possible flat-ide leftover first (the migration's cleanup is best-effort): ncp would
    // merge the release onto the old files, mixing two versions
    await this.server.removeDir(Node.path.join(publicHtml, "ide"));
    await new Promise((resolve, reject) => {
      Node.ncp(Node.path.join(srcRoot, "ide"), Node.path.join(publicHtml, "ide"), err => {
        if (err)
          reject(new Error(`Error copying the ide folder: ${err.message || err}`, {cause: err}));
        else
          resolve();
      });
    });
    //
    // Multi-version capable target (>= 26.3): the single classification driving both the full-set
    // package files below and the flatVersion marker at the end
    let multiCapableTarget = targetVersion && Node.Utils.compareVersions(targetVersion, "26.3") >= 0;
    //
    // Update the shared server part (server.bak swap + package files + npm + rollback).
    // A >= 26.3 release installed deliberately flat needs the FULL package set at root: its split
    // root package.json holds only the server modules, but the flat layout serves the IDE from the
    // shared node_modules — without the full set, everything IDE-side (children, requireAll from the
    // master) would find no modules. Take the package files from ide/, like installIdeVersion does
    // for the version folders; releases before the split have the full set at root anyway
    let fullSet = multiCapableTarget && Node.fs.existsSync(Node.path.join(srcRoot, "ide", "package.json"));
    await this.updateServerPart({srcRoot, noPackages, pkgDir: fullSet ? Node.path.join(srcRoot, "ide") : undefined});
    //
    // Unmount the mirror. Persist the empty registry FIRST: if saveConfig fails the ides/ folder is
    // still there and config.json still describes a mirror, so the disk stays consistent (and even a
    // reboot is safe, since the flat target ignores the ides registry). We do not roll back this.ides
    // here: the on-disk layout is already flat (ide + server are the target release), so restoring the
    // registry would contradict reality — throwing and letting the admin retry is the correct recovery.
    // The flatVersion marker records that this flat layout is DELIBERATE, and it only makes sense
    // when the target release is multi-version capable (>= 26.3): there it stops the first-boot
    // auto-migration from rebuilding the mirror (internal capability, not exposed by the Console;
    // cleared with the config command, flatVersion=false + reboot). For older targets the flat
    // layout is the only one their code knows: no marker is needed, and a stale one would silently
    // block the migration at the NEXT update back to >= 26.3 (the mono->multi->mono->multi cycle),
    // so it gets cleared. The Console classifies the target with the version parameter; without it
    // the target is assumed to be an old release.
    this.ides = [];
    if (multiCapableTarget)
      this.flatVersion = true;
    else
      delete this.flatVersion;
    await this.saveConfig();
    //
    // Now remove the no-longer-referenced ides/ folder, decertifying each version folder FIRST
    // (marker out, then removal, in the same try): an interrupted removal must not leave a
    // certified partial folder that a later re-migration would reuse as a complete version — a
    // marker that can't be removed keeps its folder whole instead, a truthful reuse candidate.
    // Best effort: a leftover is harmless dead weight ignored by the flat layout.
    try {
      for (let entry of await Node.fs.promises.readdir(Node.Utils.idesDir())) {
        await Node.fs.promises.rm(Node.path.join(Node.Utils.idesDir(), entry, "installInfo.json"), {force: true});
        await this.server.removeDir(Node.path.join(Node.Utils.idesDir(), entry));
      }
      await this.server.removeDir(Node.Utils.idesDir());
    }
    catch (err) {
      this.logger.log("WARN", `Can't remove the ides/ folder during downgrade: ${err}`, "Config.migrateToFlatVersion");
    }
    //
    this.logger.log("INFO", "Downgraded to flat single-version layout", "Config.migrateToFlatVersion");
  }


  /**
   * Handles the `installIdeVersion` Console command: validates the parameters, downloads and extracts
   * the release archive once via {@link Node.Config#extractRelease}, then installs the version from
   * the extracted tree via {@link Node.Config#installIdeVersion}. Serializes with other install
   * operations through `isUpdating` and always removes the temporary extraction directory. This is the
   * command boundary: it logs the outcome and rethrows on failure.
   * @param {Object} params - Request/response envelope; reads `file`, `version` and `customPackages` from `params.req.query`
   * @returns {Promise<String>} A success message
   * @throws {Error} When a parameter is missing/invalid, the version is already installed, or a download/install step fails
   */
  async handleInstallIdeVersion(params)
  {
    let logData;
    let warning = false;
    try {
      let file = params.req.query.file;
      let version = params.req.query.version;
      if (!file) {
        warning = true;
        throw Node.Config.requestError("Missing FILE parameter", 400);
      }
      //
      if (!version) {
        warning = true;
        throw Node.Config.requestError("Missing VERSION parameter", 400);
      }
      //
      // Already installed (registry): fail early, before downloading the archive
      if (this.isIdeVersionInstalled(version)) {
        warning = true;
        throw Node.Config.requestError(`IDE version ${version} is already installed`, 409);
      }
      //
      if (this.isUpdating) {
        warning = true;
        throw Node.Config.requestError("The server is already updating", 503);
      }
      //
      // Custom packages of the IDE being installed (same comma-separated wire as the config command)
      let customPackages;
      if (params.req.query.customPackages) {
        try {
          customPackages = JSON.parse(`["${params.req.query.customPackages.replace(/,/g, "\",\"")}"]`);
        }
        catch (err) {
          warning = true;
          throw Node.Config.requestError(`Wrong customPackages parameter: ${err.message || err}`, 400, err);
        }
      }
      //
      let err, tempPath;
      logData = {file, version};
      try {
        this.isUpdating = true;
        //
        // Download and extract the release once, then install the version from the extracted tree
        let extracted = await this.extractRelease(file);
        tempPath = extracted.tempPath;
        await this.installIdeVersion({srcRoot: extracted.srcRoot, version, customPackages, relinkInstallations: params.req.query.relinkInstallations, replaceLinked: true});
      }
      catch (e) {
        err = e;
        throw e;
      }
      finally {
        delete this.isUpdating;
        //
        // Remove the temporary extraction directory (and all its content)
        if (tempPath) {
          try {
            await Node.fs.promises.rm(tempPath, {recursive: true, force: true});
          }
          catch (e) {
            if (!err)
              err = new Error(`Error removing the temp folder: ${e}`);
            else
              this.logger.log("WARN", `Can't remove temporary directory: ${e}`, "Config.handleInstallIdeVersion", {tempPath});
          }
        }
      }
      //
      if (err)
        throw err;
      //
      this.logger.log("INFO", `IDE version ${version} installed`, "Config.handleInstallIdeVersion");
      //
      return "IDE version installed";
    }
    catch (err) {
      this.logger.log(warning ? "WARN" : "ERROR", err.message || err, "Config.handleInstallIdeVersion", logData);
      throw err;
    }
  }


  /**
   * Handles the `uninstallIdeVersion` Console command: validates the version, serializes with other
   * install operations through `isUpdating`, then removes the version via
   * {@link Node.Config#uninstallIdeVersion}. This is the command boundary: it logs the outcome and
   * rethrows on failure.
   * @param {Object} params - Request/response envelope; reads `version` from `params.req.query`
   * @returns {Promise<String>} A success message
   * @throws {Error} When the version is missing, is the master, is not installed, or removal fails
   */
  async handleUninstallIdeVersion(params)
  {
    let logData;
    let warning = false;
    try {
      let version = params.req.query.version;
      if (!version) {
        warning = true;
        throw Node.Config.requestError("Missing VERSION parameter", 400);
      }
      //
      if (this.isUpdating) {
        warning = true;
        throw Node.Config.requestError("The server is already updating", 503);
      }
      //
      logData = {version};
      try {
        this.isUpdating = true;
        await this.uninstallIdeVersion(version, params.req.query.force === "true");
      }
      finally {
        delete this.isUpdating;
      }
      //
      this.logger.log("INFO", `IDE version ${version} uninstalled`, "Config.handleUninstallIdeVersion");
      //
      return "IDE version uninstalled";
    }
    catch (err) {
      this.logger.log(warning ? "WARN" : "ERROR", err.message || err, "Config.handleUninstallIdeVersion", logData);
      throw err;
    }
  }


  /**
   * Updates the shared server part of a multi-version server in place: replaces `public_html/server`
   * with the one from the extracted release tree and refreshes the server's `package.json` and
   * node_modules, applying the server-level custom packages ({@link Node.Config#customPackages}) in a
   * single npm pass. The IDE versions under `ides/` are not touched. Mirrors the classic flat update's
   * `ide.bak` swap, applied to `server/`. Transactional on the server code: the current folder is
   * moved aside and, on any failure of the copy/install, restored so the master can still boot the
   * previous version (node_modules may be left partially updated — a re-run of update restores a
   * consistent state). Takes effect after the next reboot.
   * @param {Object} params - Options
   * @param {String} params.srcRoot - Absolute path of the extracted release tree (holds `server/` and the package files)
   * @param {Boolean} [params.noPackages] - When true skips the plain npm install (the update command's `nopackages` flag)
   * @param {String} [params.pkgDir] - Folder to take the package files from, instead of srcRoot (the legacy downgrade to a split release passes the full-set `srcRoot/ide`)
   * @throws {Error} When a copy or the npm install fails
   */
  async updateServerPart(params)
  {
    let {srcRoot, noPackages, pkgDir} = params;
    let publicHtml = Node.Utils.rootDir();
    let serverDir = Node.path.join(publicHtml, "server");
    let serverBak = Node.path.join(publicHtml, "server.bak");
    //
    // Move the current server aside (restored on failure below)
    try {
      await Node.fs.promises.rm(serverBak, {recursive: true, force: true});
      await Node.fs.promises.rename(serverDir, serverBak);
    }
    catch (err) {
      throw new Error(`Error backing up the server folder: ${err.message || err}`, {cause: err});
    }
    //
    try {
      // Copy the new server folder and the package files onto public_html
      await new Promise((resolve, reject) => {
        Node.ncp(Node.path.join(srcRoot, "server"), serverDir, err => {
          if (err)
            reject(new Error(`Error copying the server folder: ${err.message || err}`, {cause: err}));
          else
            resolve();
        });
      });
      //
      for (let pkgFile of ["package.json", "package-lock.json"]) {
        let src = Node.path.join(pkgDir || srcRoot, pkgFile);
        if (Node.fs.existsSync(src))
          await Node.fs.promises.copyFile(src, Node.path.join(publicHtml, pkgFile));
      }
      //
      // Refresh node_modules + server-level custom packages on public_html (single npm pass)
      await this.updateNodeModules({customPackages: this.customPackages, noPackages});
    }
    catch (err) {
      // Roll back the server code so the master can still boot the previous version (the partial new
      // server holds only copied code, no root-owned files, so a plain rm is enough)
      try {
        await Node.fs.promises.rm(serverDir, {recursive: true, force: true});
        await Node.fs.promises.rename(serverBak, serverDir);
      }
      catch (e) {
        this.logger.log("WARN", `Can't restore the server folder after a failed update: ${e}`, "Config.updateServerPart");
      }
      //
      throw new Error(`Error updating the server part: ${err.message || err}`, {cause: err});
    }
    //
    // Remove the backup on success
    try {
      await Node.fs.promises.rm(serverBak, {recursive: true, force: true});
    }
    catch (err) {
      this.logger.log("WARN", `Can't remove server backup ${serverBak}: ${err}`, "Config.updateServerPart");
    }
    //
    // The process cwd normally lives inside server/ (pm2 starts the server from there) and the swap
    // above just deleted that inode: a dangling cwd breaks every child spawn (e.g. psql for the DB
    // sizes of getStatus) until the reboot. Re-enter the same path — now the new folder — to keep the
    // process healthy in the rid-to-reboot window. The chdir is UNCONDITIONAL: probing with
    // process.cwd() first is unreliable, because graceful-fs (loaded via fs-extra in the archiver)
    // replaces it with a memoized version that returns the cached string instead of throwing on a
    // dangling cwd. Only the success path needs this: the rollback renames the original folder back,
    // which revives the old cwd inode by itself. Log-only on failure: the update itself already
    // succeeded, a cwd-only problem must not make it look failed
    try {
      process.chdir(serverDir);
    }
    catch (err) {
      this.logger.log("WARN", `Can't recover the process cwd: ${err}`, "Config.updateServerPart");
    }
  }


  /**
   * Updates the server software from a specified archive file.
   * Downloads and installs server updates, optionally updating NPM packages and rebooting.
   * @param {Object} params - Request parameters with update file and options
   * @returns {Object} Update operation result
   */
  async installUpdate(params)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Configures SSL certificates for the server including Let's Encrypt support.
   * Handles base certificates, custom domain certificates, and automatic SSL generation.
   * @param {Object} params - Request parameters with certificate configuration
   * @returns {Object} Certificate configuration result
   */
  async configureCert(params)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Configures base SSL certificates for the server.
   * Updates SSLCert, SSLKey, and SSLCABundles properties.
   * @param {Object} cert - Certificate configuration object
   * @param {String} certPath - Path to certificate directory
   * @returns {Object} Object with filesToRemove array and saveConfig flag
   */
  configureBaseCertificate(cert, certPath)
  {
    let filesToRemove = [];
    let saveConfig = false;
    //
    // If a new SSLCert has been provided
    if (cert.SSLCert !== undefined) {
      // If there was already a SSLCert, remove the associated file
      if (this.SSLCert)
        filesToRemove.push(this.SSLCert);
      if (cert.SSLCert)
        this.SSLCert = Node.path.join(certPath, cert.SSLCert);
      else
        delete this.SSLCert;
      saveConfig = true;
      //
      this.logger.log("DEBUG", "Updated SSLCert property", "Config.configureBaseCertificate", {SSLCert: this.SSLCert});
    }
    //
    // If a new SSLKey has been provided
    if (cert.SSLKey !== undefined) {
      // If there was already a SSLKey, remove the associated file
      if (this.SSLKey)
        filesToRemove.push(this.SSLKey);
      if (cert.SSLKey)
        this.SSLKey = Node.path.join(certPath, cert.SSLKey);
      else
        delete this.SSLKey;
      saveConfig = true;
      //
      this.logger.log("DEBUG", "Updated SSLKey property", "Config.configureBaseCertificate", {SSLKey: this.SSLKey});
    }
    //
    // If a new SSLCABundles has been provided
    if (cert.SSLCABundles !== undefined) {
      // If there was already a SSLCABundles, remove the associated file
      if (this.SSLCABundles) {
        for (let i = 0; i < this.SSLCABundles.length; i++)
          if (!cert.SSLCABundles.includes(this.SSLCABundles[i].substring(certPath.length)))     // File it's not there anymore
            filesToRemove.push(this.SSLCABundles[i]);
      }
      //
      if (cert.SSLCABundles?.length) {
        this.SSLCABundles = [];
        for (let i = 0; i < cert.SSLCABundles.length; i++)
          this.SSLCABundles.push(Node.path.join(certPath, cert.SSLCABundles[i]));
      }
      else
        delete this.SSLCABundles;
      saveConfig = true;
      //
      this.logger.log("DEBUG", "Updated SSLCABundles property", "Config.configureBaseCertificate", {SSLCABundles: this.SSLCABundles});
    }
    //
    return {
      filesToRemove,
      saveConfig
    };
  }


  /**
   * Creates an auto-SSL certificate using Let's Encrypt.
   * @param {Object} cert - Certificate configuration object
   * @param {String} letsencryptPath - Path to Let's Encrypt directory
   */
  async createAutoSSLCertificate(cert, letsencryptPath)
  {
    // Ensure there is the letsencrypt directory (on older servers was not there)
    try {
      await Node.fs.promises.mkdir(letsencryptPath);
    }
    catch (err) {
      if (err.code !== "EEXIST")
        throw new Error(`Error creating the letsencrypt folder: ${err.message || err}`, {cause: err});
    }
    //
    // Add auto-SSL certificate
    let pars = [
      "certonly", // Obtain or renew a certificate, but do not install it
      "-n", // Run non-interactively
      "--agree-tos", // Agree to the ACME server's Subscriber Agreement
      "--webroot", // Place files in a server's webroot folder for authentication
      "--key-type", "rsa", // Force RSA algorythm
      "--config-dir", letsencryptPath, // Installation folder
      "-m", "certificates@instantdevelopercloud.com", // Email address for important account notifications
      "-w", letsencryptPath, // Work directory
      "-d", cert.SSLDomain || `${this.name}.${this.domain}`
    ]; // Comma-separated list of domains to obtain a certificate for
    try {
      await this.server.execFileAsRoot("/usr/bin/certbot", pars);
    }
    catch (err) {
      throw new Error(`Can't create auto-SSL certificate: ${err.message || err}`, {cause: err});
    }
    //
    // Point to certificate files
    if (!cert.SSLDomain) {  // MAIN certificate
      this.SSLCert = Node.path.join(letsencryptPath, "live", `${this.name}.${this.domain}`, "fullchain.pem");
      this.SSLKey = Node.path.join(letsencryptPath, "live", `${this.name}.${this.domain}`, "privkey.pem");
      delete this.SSLCABundles;
    }
    else {  // Custom certificate
      cert.SSLCert = Node.path.join(letsencryptPath, "live", cert.SSLDomain, "fullchain.pem");
      cert.SSLKey = Node.path.join(letsencryptPath, "live", cert.SSLDomain, "privkey.pem");
      delete cert.SSLCABundles;
      //
      this.customSSLCerts = this.customSSLCerts || [];
      this.customSSLCerts.push(cert);
    }
    //
    // Save config
    await this.saveConfig();
    //
    // Done
    if (!cert.SSLDomain)   // MAIN certificate
      this.logger.log("INFO", "Auto-SSL MAIN certificate added", "Config.createAutoSSLCertificate");
    else
      this.logger.log("INFO", "Auto-SSL CUSTOM certificate added", "Config.createAutoSSLCertificate", cert);
  }


  /**
   * Adds a custom SSL certificate for a specific domain.
   * @param {Object} cert - Certificate configuration object
   * @param {String} certPath - Path to certificate directory
   * @param {String} letsencryptPath - Path to Let's Encrypt directory
   * @returns {Object} Object with saveConfig flag
   */
  async addCustomCertificate(cert, certPath, letsencryptPath)
  {
    // If a domain have been provided check if a certificate for that domain exists
    if (cert.SSLDomain && this.customSSLCerts) {
      for (let i = 0; i < this.customSSLCerts.length; i++)
        if (this.customSSLCerts[i].SSLDomain === cert.SSLDomain) {
          let err = new Error(`Cert for domain ${cert.SSLDomain} exists`);
          err.isWarning = true;
          err.logData = {cert};
          throw err;
        }
    }
    //
    // If no certificate files have been provided handle auto-SSL certificate creation with letsencrypt
    if (!cert.SSLCert && !cert.SSLKey && !cert.SSLCABundles) {
      // Auto-SSL generation is allowed only in the following two cases:
      if ((!cert.SSLDomain && !this.SSLCert && !this.SSLKey && !this.SSLCABundles) || // 1) no SSLDomain have been provided and no main-certificate is present
              cert.SSLDomain) { // 2) SSLDomain have been provided and no certificate is already available for that domain (checked above)
        await this.createAutoSSLCertificate(cert, letsencryptPath);
        return {saveConfig: false};  // Config already saved by createAutoSSLCertificate
      }
    }
    //
    if (!cert.SSLDomain || !cert.SSLCert || !cert.SSLKey || !cert.SSLCABundles) {
      let err = new Error("Invalid cert format (missing SSLDomain, SSLCert, SSLKey or SSLCABundles)");
      err.isWarning = true;
      err.logData = {cert};
      throw err;
    }
    //
    cert.SSLCert = Node.path.join(certPath, cert.SSLCert);
    cert.SSLKey = Node.path.join(certPath, cert.SSLKey);
    if (cert.SSLCABundles)
      for (let i = 0; i < cert.SSLCABundles.length; i++)
        cert.SSLCABundles[i] = Node.path.join(certPath, cert.SSLCABundles[i]);
    this.customSSLCerts = this.customSSLCerts || [];
    this.customSSLCerts.push(cert);
    //
    this.logger.log("DEBUG", "Added new custom certificate", "Config.addCustomCertificate", cert);
    //
    return {saveConfig: true};
  }


  /**
   * Revokes a custom SSL certificate for a specific domain.
   * @param {String} certDomain - Domain of certificate to revoke
   * @param {String} letsencryptPath - Path to Let's Encrypt directory
   * @returns {Object} Object with filesToRemove array and saveConfig flag
   */
  async revokeCustomCertificate(certDomain, letsencryptPath)
  {
    let filesToRemove = [];
    let saveConfig = false;
    //
    for (let i = 0; i < (this.customSSLCerts || []).length; i++) {
      if (this.customSSLCerts[i].SSLDomain === certDomain) {
        this.logger.log("DEBUG", "Custom certificate revoked", "Config.revokeCustomCertificate", this.customSSLCerts[i]);
        //
        // Found! Remove the certificate
        let revokedCert = this.customSSLCerts.splice(i, 1)[0];
        //
        // If this was a let's encrypt auto-certificate, revoke it
        if (revokedCert.SSLCert.includes(letsencryptPath)) {
          let pars = [
            "revoke", // Revoke a certificate
            "-n", // Run non-interactively
            "--config-dir", letsencryptPath, // Installation folder
            "--delete-after-revoke", // Delete useless files
            "--cert-name", revokedCert.SSLDomain // Certificate to be revoked
          ];
          //
          try {
            await this.server.execFileAsRoot("/usr/bin/certbot", pars);
          }
          catch (err) {
            this.logger.log("ERROR", `Can't revoke auto-SSL certificate: ${err.message || err}`, "Config.revokeCustomCertificate");
          }
        }
        else {
          // Check if some files have become useless and if that's the case, delete them
          // To check, compute the list of currently used files
          let usedFiles = [];
          for (let i = 0; i < this.customSSLCerts.length; i++) {
            let c = this.customSSLCerts[i];
            usedFiles.push(c.SSLCert);
            usedFiles.push(c.SSLKey);
            if (c.SSLCABundles)
              for (let j = 0; j < (c.SSLCABundles || []).length; j++)
                usedFiles.push(c.SSLCABundles[j]);
          }
          //
          // Then check if the revoked certificate files are still used
          if (!usedFiles.includes(revokedCert.SSLCert))
            filesToRemove.push(revokedCert.SSLCert);
          if (!usedFiles.includes(revokedCert.SSLKey))
            filesToRemove.push(revokedCert.SSLKey);
          if (revokedCert.SSLCABundles)
            for (let j = 0; j < revokedCert.SSLCABundles.length; j++)
              if (!usedFiles.includes(revokedCert.SSLCABundles[j]))
                filesToRemove.push(revokedCert.SSLCABundles[j]);
        }
        //
        // If this was the last one, remove the custom SSL array
        if (this.customSSLCerts.length === 0)
          delete this.customSSLCerts;
        //
        saveConfig = true;
        break;
      }
    }
    //
    if (!saveConfig) {
      let err = new Error(`Certificate ${certDomain} not found`);
      err.code = 404;
      err.isWarning = true;
      err.logData = {cert: certDomain};
      throw err;
    }
    //
    return {
      filesToRemove,
      saveConfig
    };
  }


  /**
   * Handles certificate file uploads.
   * @param {Object} params - Request parameters
   * @param {String} certPath - Path to certificate directory
   */
  async uploadCertificateFiles(params, certPath)
  {
    let files;
    try {
      let form = new Node.multiparty.Form({autoFields: true, autoFiles: true, uploadDir: certPath});
      files = await new Promise((resolve, reject) => {
        form.parse(params.req, (err, _fields, files) => err ? reject(err) : resolve(files));
      });
    }
    catch (err) {
      let error = new Error(`Error parsing post request: ${err.message || err}`, {cause: err});
      error.isWarning = true;
      throw error;
    }
    //
    // Rename uploaded files
    let farr = Object.keys(files);
    for (let i = 0; i < farr.length; i++) {
      let k = farr[i];
      let f = files[k][0];
      let newfile = Node.path.join(certPath, f.originalFilename);
      try {
        await Node.fs.promises.rename(f.path, newfile);
      }
      catch (err) {
        let error = new Error(`Error moving uploaded file: ${err.message || err}`, {cause: err});
        error.isWarning = true;
        error.logData = {originalfile: f.originalFilename, newfile: newfile};
        throw error;
      }
    }
    this.logger.log("DEBUG", "Certificate files uploaded", "Config.uploadCertificateFiles", files);
  }


  /**
   * Removes unused certificate files from disk.
   * @param {Array<String>} filesToRemove - List of file paths to remove
   */
  async removeCertificateFiles(filesToRemove)
  {
    for (let fn of filesToRemove) {
      try {
        await Node.fs.promises.rm(fn, {force: true});
        this.logger.log("DEBUG", `Removed useless file ${fn}`, "Config.removeCertificateFiles");
      }
      catch (err) {
        this.logger.log("WARN", `Error removing the file ${fn}: ${err}`, "Config.removeCertificateFiles");
      }
    }
  }


  /**
   * Checks and adjusts the data disk size to match available space.
   * Automatically expands the file system when disk space has been increased.
   * Supports FreeBSD and Linux platforms.
   * @param {Object} params - Request parameters
   * @returns {Promise<Object>} Disk adjustment result or undefined if no change needed
   */
  async checkDataDisk(params)
  {
    // Do nothing on a windows machine
    if (/^win/.test(process.platform))
      return;
    //
    let disk = {};
    try {
      // On FreeBSD
      if (process.platform === "freebsd") {
        // First compute the "SCSI" disk reading it from dmesg.boot when disk was first detected  (da1 is /mnt/disk)
        // I'm expecting something like this:
        //    (da1:vtscsi0:0:2:0): UNMAPPED
        //    da1 at vtscsi0 bus 0 scbus0 target 2 lun 0
        //    da1: <Google PersistentDisk 1> Fixed Direct Access SPC-4 SCSI device
        //    da1: 2937028.393MB/s transfers
        //    da1: Command Queueing enabled
        //    da1: 10240MB (20971520 512 byte sectors)
        let stdout;
        try {
          stdout = await new Promise((resolve, reject) => {
            Node.child.execFile("/usr/bin/grep", ["da1", "/var/run/dmesg.boot"], (err, stdout, stderr) => err ? reject(stderr || err) : resolve(stdout));
          });
        }
        catch (err) {
          throw new Error(`Error while computing SCSI device id: ${err.message || err}`, {cause: err});
        }
        //
        let lines = stdout.split("\n");   // Split lines
        let scsiId = lines[0];            // First row
        scsiId = scsiId.substring(1, scsiId.indexOf(")"));      // Get part inside ()
        scsiId = scsiId.split(":");       // Split :
        scsiId = scsiId.slice(2);         // Remove "(da1:vtscsi0:"
        scsiId = scsiId.join(":");        // Re-join and get scsiId
        //
        // Ask the system to reprobe disk size
        try {
          await this.server.execFileAsRoot("/sbin/camcontrol", ["reprobe", scsiId]);
        }
        catch (err) {
          throw new Error(`Error while reprobing disk size: ${err.message || err}`, {cause: err});
        }
        //
        // Get current part status (da1 is /mnt/disk)
        try {
          stdout = await this.server.execFileAsRoot("/sbin/gpart", ["show", "da1"]);
        }
        catch (err) {
          throw new Error(`Error while executing GPART: ${err.message || err}`, {cause: err});
        }
        //
        lines = stdout.split("\n");      // Split lines
        //
        // Expected reply:
        // =>      34  20971453  da1  GPT  (TOTALSIZE)            (eg. 15G)
        //         34         6       - free -  (3.0K)
        //         40  20971440    1  freebsd-ufs  (USEDSIZE)     (eg. 10G)
        //   20971480         7       - free -  (3.5K)
        //
        disk.designSize = lines[0].split(/\s+/)[5];
        disk.designSize = disk.designSize.substring(1, disk.designSize.length - 1);   // Remove ()
        //
        // Now search the "freebsd-ufs" partition (there should be only one!)
        for (let i = 1; i < lines.length; i++) {
          if (lines[i].includes("freebsd-ufs")) {
            disk.currSize = lines[i].split(/\s+/)[5];
            disk.currSize = disk.currSize.substring(1, disk.currSize.length - 1);    // Remove ()
            break;
          }
        }
        //
        // If Size is the same, do nothing
        if (disk.designSize === disk.currSize)
          return;
        //
        // Size is not equal... fix it
        this.logger.log("INFO", "Fixing data disk", "Config.checkDataDisk", disk);
        //
        // Recover partition
        try {
          await this.server.execFileAsRoot("/sbin/gpart", ["recover", "da1"]);
        }
        catch (err) {
          throw new Error(`Error while executing GPART RECOVER: ${err.message || err}`, {cause: err});
        }
        //
        // Out from the box you cannot write to MBR of disk, which is the one FreeBSD boots from.
        // After setting sysctl kern.geom.debugflags=16 I get allowed to shoot in the foot and write to MBR.
        try {
          await this.server.execFileAsRoot("/sbin/sysctl", ["kern.geom.debugflags=16"]);
        }
        catch (err) {
          throw new Error(`Error while executing SYSCTL=16: ${err.message || err}`, {cause: err});
        }
        //
        // Resize partition to fill up all the free space
        try {
          await this.server.execFileAsRoot("/sbin/gpart", ["resize", "-i", "1", "da1"]);
        }
        catch (err) {
          throw new Error(`Error while executing GPART RESIZE: ${err.message || err}`, {cause: err});
        }
        //
        // Resize file system and fill up the partition (quiet mode!!!)
        try {
          await this.server.execFileAsRoot("/sbin/growfs", ["-y", "/dev/da1p1"]);
        }
        catch (err) {
          throw new Error(`Error while executing GROWFS: ${err.message || err}`, {cause: err});
        }
        //
        // Restore flag
        try {
          await this.server.execFileAsRoot("/sbin/sysctl", ["kern.geom.debugflags=0"]);
        }
        catch (err) {
          throw new Error(`Error while executing SYSCTL=0: ${err.message || err}`, {cause: err});
        }
        //
        this.logger.log("INFO", "Data disk fixed", "Config.checkDataDisk");
        return `Fixed to ${disk.designSize}`;
      }
      else if (process.platform === "linux") {
        let stdout;
        try {
          stdout = await this.server.execFileAsRoot("/usr/sbin/parted", ["-m", "/dev/sdb", "print"]);
        }
        catch (err) {
          throw new Error(`Error while executing PARTED: ${err.message || err}`, {cause: err});
        }
        //
        // BYT;
        // /dev/sdb:23.6GB:scsi:512:4096:loop:Google PersistentDisk:;
        // 1:0.00B:23.6GB:23.6GB:ext4::;
        let lines = stdout.split("\n");
        disk.designSize = lines[1];
        disk.designSize = disk.designSize.split(":")[1];
        //
        // Resize partition to fill up all the free space
        try {
          await this.server.execFileAsRoot("/usr/sbin/resize2fs", ["/dev/sdb"]);
        }
        catch (err) {
          // If the disk needs nothing
          if ((err.message || err).includes("The filesystem is already"))
            return;
          //
          throw new Error(`Error while executing RESIZE2FS: ${err.message || err}`, {cause: err});
        }
        //
        // Done!
        this.logger.log("INFO", "Data disk fixed", "Config.checkDataDisk");
        return `Fixed to ${disk.designSize}`;
      }
      else
        throw new Error(`Unsupported platform: ${process.platform}`);
    }
    catch (err) {
      this.logger.log("ERROR", err.message || err, "Config.checkDataDisk", disk);
      throw err;
    }
  }


  /**
   * Creates backups of all user projects in the cloud storage.
   * Iterates through all users and backs up their projects to the configured cloud bucket.
   * @param {Object} params - Request parameters
   */
  async backupProjects(params)
  {
    // Compute when the automatic backup was performed and get all projects that have been modified since then
    let saveLimit;
    if (params.req.query.fromDate)
      saveLimit = new Date(params.req.query.fromDate);  // If a date was provided, use it
    else if (!this.nightlyBucketGCloud || !this.daysBackups || !this.numMinBackups) {
      // Auto-backup is not enabled -> back up all projects that have been modified in the last 24 hours
      saveLimit = new Date();
      saveLimit.setDate(saveLimit.getDate() - 1);
    }
    else {
      // Periodic backup is enabled.
      // Compute HOURS and MINUTES from timeBackup param
      let hours = Math.floor((this.timeBackup || 0) / 100);
      let mins = (this.timeBackup || 0) % 100;
      //
      // Compute how many ms there are from NOW to the expected backup time
      let now = new Date();
      saveLimit = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, mins, 0, 0);
      if (saveLimit > now)
        saveLimit.setDate(saveLimit.getDate() - 1);
    }
    //
    this.logger.log("DEBUG", `Save limit for backing up: ${saveLimit}`, "Config.backupProjects");
    //
    let logData;
    let warning = false;
    try {
      // Compute which projects I have to backup
      let prjsToBackup = [];
      for (let i = 0; i < this.users.length; i++) {
        let user = this.users[i];
        for (let j = 0; j < user.projects.length; j++) {
          let prj = user.projects[j];
          //
          // If the project is online -> stop
          if (prj.isOnline()) {
            warning = true;
            logData = {user: user.userName, project: prj.name};
            throw new Error(`The project ${prj.user.userName}/${prj.name} is open`);
          }
          //
          // Skip projects that have not been modified since the saveLimit
          if (!prj.lastSave || new Date(prj.lastSave) < saveLimit)
            continue;
          //
          // I have to backup this project
          prjsToBackup.push(prj);
        }
      }
      //
      // Backup all projects
      for (let prj of prjsToBackup) {
        this.logger.log("DEBUG", "Backup project", "Config.backupProjects", {user: prj.user.userName, project: prj.name});
        try {
          await prj.nightlyBackup();
        }
        catch (err) {
          logData = {user: prj.user.userName, project: prj.name};
          throw new Error(`Can't backup project ${prj.user.userName}/${prj.name}: ${err.message || err}`, {cause: err});
        }
        //
        try {
          await this.cleanProjectBucket(prj);
        }
        catch (err) {
          logData = {user: prj.user.userName, project: prj.name};
          throw new Error(`Can't clean up project's bucket: ${err.message || err}`, {cause: err});
        }
      }
    }
    catch (err) {
      this.logger.log(warning ? "WARN" : "ERROR", err.message || err, "Config.backupProjects", logData);
      throw err;
    }
  }


  /**
   * Removes old backups from the cloud storage bucket for a specific project.
   * Deletes backup files older than the configured retention period.
   * @param {Node.Project} prj - The project to clean backups for
   */
  async cleanProjectBucket(prj)
  {
    let path = `users/${this.serverType}/${prj.user.userName}/backups/projects/${prj.name}/`;
    let msLimit = this.daysBackups * 24 * 3600 * 1000;   // Number of ms I have to keep the file for
    let now = new Date();
    //
    // Get the list of all files in the cloud at the given project's backup path
    let archiver = new Node.Archiver(this.server, true);
    let files;
    try {
      files = await archiver.getFiles(path);
    }
    catch (err) {
      throw new Error(`Can't enumerate files: ${err.message || err}`, {cause: err});
    }
    //
    // If the number of files in the bucket is already at minimum, do nothing
    this.logger.log("DEBUG", `#files in bucket: ${files ? files.length : 0}/${this.numMinBackups}`, "Config.cleanProjectBucket",
            {project: prj.name, user: prj.user.userName});
    if (files.length <= this.numMinBackups)
      return;
    //
    // Remove older ones
    for (let file of files) {
      let fn = file;
      //
      // Compute the file date
      // File name format: [project]-[date].tar.gz
      // where [date] is in the ISO form without "-:T.Z" (thus YYYYMMDDHHMMSSmmm - see Node.Project#backup)
      fn = fn.substring(0, fn.length - 7);     // Remove extension (.tar.gz)
      fn = fn.substring(fn.lastIndexOf("-") + 1); // Get the DATE part
      let dateFile = new Date(fn.substring(0, 4) + "-" + fn.substring(4, 6) + "-" + fn.substring(6, 8) + "T" +
              fn.substring(8, 10) + ":" + fn.substring(10, 12) + ":" + fn.substring(12, 14) + "." + fn.substring(15) + "Z");
      let msFileDelta = now - dateFile;
      //
      if (msFileDelta > msLimit) {
        this.logger.log("DEBUG", `Remove older file ${file}`, "Config.cleanProjectBucket", {project: prj.name, user: prj.user.userName});
        try {
          await archiver.deleteFile(file);
        }
        catch (err) {
          throw new Error(`Error removing file ${file} from the project backup bucket: ${err.message || err}`, {cause: err});
        }
      }
    }
  }


  /**
   * Manages disk snapshots for backup and recovery.
   * Creates, lists, and removes ZFS snapshots of the data disk.
   * @param {Object} params - Request parameters with snapshot command
   * @returns {Promise<Object>} Snapshot operation result
   */
  async handleSnapshot(params)
  {
    // If there was an auto-stop snapshot timer, kill it
    if (this.autoStopSnapshotTimer) {
      clearTimeout(this.autoStopSnapshotTimer);
      delete this.autoStopSnapshotTimer;
    }
    //
    let logData;
    let warning = false;
    try {
      let op = params.tokens[1];
      switch (op) {
        case "start":
          await this.startSnapshot(params);
          break;

        case "end":
          await this.endSnapshot(params);
          break;

        default: {
          warning = true;
          logData = {
            op,
            url: params.req.originalUrl
          };
          throw new Error("Invalid operation");
        }
      }
    }
    catch (err) {
      this.logger.log(warning ? "WARN" : "ERROR", err.message || err, "Config.handleSnapshot", logData);
      throw err;
    }
  }


  /**
   * Freezes the data disk filesystem in preparation for a snapshot.
   * Flushes pending writes with sync(1), freezes /mnt/disk with fsfreeze -f and
   * schedules an auto-unfreeze timer to guard against a caller that dies before
   * completing the snapshot (leaving the filesystem locked).
   * @param {Object} params - Request parameters (tokens, req, optional unlockTimeout)
   * @throws {Error} If sync or fsfreeze fail
   * @private
   */
  async startSnapshot(params)
  {
    // Flush data to disk
    try {
      await this.server.execFileAsRoot("/bin/sync", []);
    }
    catch (err) {
      throw new Error(`Error while executing SYNC: ${err.message || err}`, {cause: err});
    }
    //
    // Stop writing to disk
    try {
      await this.server.execFileAsRoot("/sbin/fsfreeze", ["-f", "/mnt/disk"]);
    }
    catch (err) {
      throw new Error(`Error while executing FSFREEZE: ${err.message || err}`, {cause: err});
    }
    //
    // Done!
    this.logger.log("INFO", "Disk freezed -> ready for snapshot", "Config.handleSnapshot", {url: params.req.originalUrl});
    //
    // Be skeptics: auto-unlock after some time (if callee dies it's a problem... fs will remain LOCKED)
    this.autoStopSnapshotTimer = setTimeout(async () => {
      this.logger.log("WARN", "Disk auto-unfreeze", "Config.handleSnapshot");
      //
      params.tokens[1] = "end";
      try {
        await this.handleSnapshot(params);
      }
      catch (err) {
        this.logger.log("ERROR", `Error while auto-unlocking FS: ${err}`, "Config.handleSnapshot");
      }
    }, params.unlockTimeout || 15000);
  }


  /**
   * Unfreezes the data disk filesystem after a snapshot completes, resuming writes.
   * @param {Object} params - Request parameters (tokens, req)
   * @throws {Error} If fsfreeze fails
   * @private
   */
  async endSnapshot(params)
  {
    // Resume writing to disk
    try {
      await this.server.execFileAsRoot("/sbin/fsfreeze", ["-u", "/mnt/disk"]);
      //
      // Done!
      this.logger.log("INFO", "Disk unfreezed -> write allowed", "Config.handleSnapshot", {url: params.req.originalUrl});
    }
    catch (err) {
      throw new Error(`Error while executing FSFREEZE: ${err.message || err}`, {cause: err});
    }
  }


  /**
   * Initializes user tracking service if configured.
   * Sets up analytics tracking for server usage monitoring.
   */
  async initTracking()
  {
    // If tracking is not active, do nothing
    if (!(this.services || "").split(",").includes("track"))
      return;
    //
    let ideDir = Node.Utils.resolveIdeDir(this.getHighestIdeVersion());
    let Postgres;
    try {
      Postgres = require(Node.path.join(ideDir, "app", "server", "requireAll")).Postgres;
    }
    catch (err) {
      // Flat >= 26.3 window (shared node_modules pruned to the server set, migration not completed
      // yet): tracking can't start this boot — the next boot, with the migration done, will have it
      this.logger.log("WARN", `Can't load the IDE Postgres driver, tracking not started: ${err.message || err}`, "Config.initTracking");
      return;
    }
    let trackDB = new Postgres();
    trackDB.schema = {"id": "q0QvNTfSzEHdmYsdj+WEIA==", "name": "$trackingDB$", "type": "$trackingDB$", "tables": [{"id": "h6aAxGQcqGH9zCgYcN/7jA==", "name": "Issues", "fields": [{"id": "raFFirodiY5SYrKs8khbnA==", "name": "ID", "datatype": "id", "maxlen": 24, "pk": true}, {"id": "GMu4qCtqK2ylk1a9+xpSzw==", "name": "IssueApplicationID", "datatype": "id", "maxlen": 24}, {"id": "gvEa1E8hV0EYuzk0b48xpA==", "name": "ProjectID", "datatype": "id", "maxlen": 24}, {"id": "8VuRWXB3HiIb8rR5L7iwUA==", "name": "ProjectJsonID", "datatype": "id", "maxlen": 24, "notn": true}, {"id": "zrluHniES3g/HlY1+VhBNg==", "name": "ApplicationJsonID", "datatype": "id", "maxlen": 24}, {"id": "8RtjtmBa9CskXDbDL8QArw==", "name": "BuildID", "datatype": "id", "maxlen": 24}, {"id": "uuxk4NaVz0wfFNt9+NK2rw==", "name": "BuildName", "datatype": "vc"}, {"id": "zZqgdCi9k5ffG38wROQ4ug==", "name": "BuildFormat", "datatype": "vc", "maxlen": 3}, {"id": "G1hOjxkADUkjWc9H0tmO6A==", "name": "LinkedObject", "datatype": "j"}, {"id": "C4uWoHljnhoiyDRuIdXb3w==", "name": "Branch", "datatype": "j"}, {"id": "qvHBMiJyYTHMDzHxAriiug==", "name": "Context", "datatype": "j"}, {"id": "gfkj8VwK7c9mVs8NZHdgbA==", "name": "CommitID", "datatype": "id", "maxlen": 24}, {"id": "X1faYOw57iteQzy8jNTaxw==", "name": "AuthorID", "datatype": "vc"}, {"id": "1Btb7CUR/U0m/piKpRuDow==", "name": "AuthorAvatar", "datatype": "vc"}, {"id": "7hp+1ep1FS+Nt6Su4hWa7Q==", "name": "AuthorName", "datatype": "vc"}, {"id": "c9eqpXDdFKkI+QeIdbXKmw==", "name": "AuthorLanguage", "datatype": "vc"}, {"id": "tzxZ+ZpfBIvT3M4uFJetGw==", "name": "Title", "datatype": "vc"}, {"id": "gKx8db8g8IPsv9AYTd8XPw==", "name": "Description", "datatype": "vc"}, {"id": "c9RBYdro91EuMbxanQGH2Q==", "name": "SourceObject", "datatype": "j"}, {"id": "GcPOOAVhhSXXD1EBmZVFEg==", "name": "CreationDate", "datatype": "dt"}, {"id": "s7oYtzRmGYs4UV03a2DABQ==", "name": "IssueType", "datatype": "i"}, {"id": "e4gvrscSsjb4niwd+33vsw==", "name": "Screenshot", "datatype": "vc"}, {"id": "BQrvkhKUsdZbEXEx0boqzA==", "name": "Activities", "datatype": "j"}, {"id": "Yd9MeOLH6zNdFjMLB9mbUA==", "name": "AssignToID", "datatype": "id", "maxlen": 24}, {"id": "PHO+nUZD6k9pWlj7K0xMlA==", "name": "AssignToAvatar", "datatype": "vc"}, {"id": "dbNioY++YCw+oobrhybsSg==", "name": "AssignToName", "datatype": "vc"}, {"id": "olDW06tCtsfiq9mGo22j7w==", "name": "Code", "datatype": "i"}, {"id": "D+DFykWF3JeHv+cTpC0nyA==", "name": "Priority", "datatype": "i"}, {"id": "myfGITWjTKzaOl31z4dvaw==", "name": "Tags", "datatype": "vc"}, {"id": "2GysvAQaUxS+25h5e4dHow==", "name": "DeployStatus", "datatype": "i"}, {"id": "vhMO4QuJeAfi2fk0M0qrQg==", "name": "Category", "datatype": "i"}, {"id": "dbT7We57+jk9NuE8dluPzg==", "name": "Votes", "datatype": "i", "defval": "0"}, {"id": "TneyghFUGS6pK5F5B9JGVA==", "name": "NotificationEmails", "datatype": "vc"}, {"id": "v/ljRAQzPtMNI8sRsL+yGg==", "name": "ForkChainID", "datatype": "id", "maxlen": 24}], "fks": [{"id": "dPSTX+LzXuTMSoAcVUIT4A==", "name": "fkIssueApplications", "t": "IssueApplications", "ur": "c", "dr": "c", "refs": {"GMu4qCtqK2ylk1a9+xpSzw==": "ID"}}]}, {"id": "UAZbmF3p3VFzZANljHCUyw==", "name": "IssueTags", "fields": [{"id": "+5mLeHZjmPbZYVCCUKLPUg==", "name": "ID", "datatype": "id", "maxlen": 24, "pk": true}, {"id": "qcZe2R1nhWsm2AluUqIPsA==", "name": "TagLabel", "datatype": "vc", "notn": true}, {"id": "knNBsG9IjNTixiSPMU4/xQ==", "name": "Available", "datatype": "b"}, {"id": "INik72DBhiLta5VQad9Dbg==", "name": "AccountID", "datatype": "id", "maxlen": 24}]}, {"id": "kr3qP6vuLOc4E31EN0UVwQ==", "name": "IssueApplications", "fields": [{"id": "FSAY7uGwp8zhmf7mocRjTA==", "name": "ID", "datatype": "id", "maxlen": 24, "pk": true}, {"id": "D7rgv3xFaWjP3A7yUv82+A==", "name": "ProjectID", "datatype": "id", "maxlen": 24}, {"id": "KVVu0MTG5AtVzUC1xJdphg==", "name": "ProjectJsonID", "datatype": "id", "maxlen": 24, "notn": true}, {"id": "cu2THSSWPeLnH8qKW0NMXA==", "name": "ApplicationJsonID", "datatype": "id", "maxlen": 24, "notn": true}, {"id": "VF7d2FtNzhEMBee1dGzOAQ==", "name": "ApplicationName", "datatype": "vc"}, {"id": "e0FdPOi5ITQlMXyKE5J6Pg==", "name": "Format", "datatype": "vc", "maxlen": 3, "notn": true}]}]};
    trackDB.initDbConString(`postgres://${this.dbUser}:${this.dbPassword}@${this.dbAddress}:${this.dbPort}`);
    //
    // Replace the standard createDb function (normally the updateSchema method is called from a child process
    // thus the createDb method sends a message to the parent process... but not this time)
    trackDB.createDb = async () => {
      let manager = this.getUser("manager");     // It must exist
      let db = manager.getDatabase(trackDB.schema.name);
      if (db)
        return;
      //
      // $tracking$ DB is not there -> create one
      try {
        await manager.createDatabase(trackDB.schema.name);
      }
      catch (err) {
        this.logger.log("ERROR", `Error while creating ${trackDB.schema.name} database: ${err.message || err}`, "Config.initTracking");
        throw err;
      }
    };
    //
    try {
      // Update database's schema
      await trackDB.updateSchema();
      this.logger.log("DEBUG", `${trackDB.schema.name} schema updated`, "Config.initTracking");
    }
    catch (err) {
      let msg = `Error while updating ${trackDB.schema.name} schema: ${err}`;
      this.logger.log("ERROR", msg, "Config.initTracking");
      throw new Error(msg, {cause: err});
    }
  }


  /**
   * Processes administrative commands received via HTTP requests.
   * Routes commands to appropriate handlers based on URL path and authentication.
   * A command carrying a `rid` is taken over at once and always gets its outcome on the asynchronous
   * channel: an unknown user is a 404 sent there, not a hand-over to the next middleware.
   * A failing `restore` rolls back the user it has just created only when nothing has reached
   * the disk yet: a failure after the extraction leaves data, user and error to the caller.
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */
  async processCommand(req, res)
  {
    // Handle only GET or POST
    if (req.method !== "POST" && req.method !== "GET")
      return req.next();
    //
    // Tokenize URL
    let params = {
      tokens: req.originalUrl.substring(1).split("?")[0].split("/"),
      req,
      res
    };
    //
    // Merge Query-string parameters with BODY (i.e. x-www-form-urlencoded POST parameters)
    Node.Utils.unlockRequestQuery(req);
    params.req.query = Object.assign(req.query, req.body);
    //
    // Log the operation
    this.logger.log("DEBUG", "Processing operation", "Config.processCommand", {url: req.originalUrl, host: req.socket.remoteAddress});
    //
    // Extract user and command
    let userName = Node.Utils.clearName(params.tokens[0]);
    let command = params.tokens[1];
    //
    // Remove user from list of tokens
    params.tokens.splice(0, 1);
    //
    if (params.req.query.rid)
      setImmediate(() => {
        // If the callee gave me a RID (i.e. he wants to know "asynchronously" if the command was succeded)
        // and I've not ansered yet (with errors or other) send an "OK" reply (that means I'm handling it)
        if (!res.headersSent)
          res.status(200).send("OK");
      });
    //
    let result, error;
    try {
      // Check the authorization key only for "CREATE", "RESTORE" and "DELETE" commands
      // ('cause other commands will handle it where it's needed)
      if (["create", "restore", "delete"].includes(command)) {
        this.checkAuthorization(params, "Config.processCommand");
        //
        // An empty name would target a user whose folder is the root of every user's folder. It means
        // something only when creating on a local installation, where it stands for the system user
        // and createUser resolves it: deleteUser resolves nothing, so there it is never legitimate
        if (!userName && (!this.local || command === "delete")) {
          this.logger.log("WARN", "Invalid user name", "Config.processCommand", {command});
          throw Object.assign(new Error("Invalid user name"), {code: 400});
        }
      }
      //
      // Handle user commands
      // (http://servername/username/command)
      switch (command) {
        case "create":
          await this.createUser(userName);
          break;

        case "restore": {
          // createUser can resolve the name on its own (the system user on local installations),
          // so the restore works on the user it returns and never on the requested name
          let user = await this.createUser(userName);
          try {
            await user.processCommand(params);
          }
          catch (err) {
            // Undoing the creation deletes the databases and the whole user folder: it makes sense only
            // while the disk is untouched, after the extraction it would destroy the restored data.
            // A folder that was already there holds data predating the command, so it is kept too
            if (err.dataOnDisk || user.folderExisted)
              this.logger.log("WARN", "Restore failed, the user is kept: delete it explicitly to retry", "Config.processCommand", {
                user: user.userName,
                dataOnDisk: err.dataOnDisk,
                folderExisted: user.folderExisted
              });
            else
              await this.deleteUser(user.userName).catch(() => {});
            //
            throw err;
          }
          break;
        }

        case "delete":
          await this.deleteUser(userName);
          break;

        default: {
          let user = this.getUser(userName);
          if (!user) {
            // Passing the request on is how application addresses are served, but a command carrying a
            // rid has already been told it was taken over: leaving it to the next middleware would keep
            // the caller waiting for an outcome nobody is going to send
            if (!params.req.query.rid)
              return req.next();
            //
            this.logger.log("WARN", "User not found", "Config.processCommand",
                    {cmd: command, user: userName, url: req.originalUrl});
            throw Object.assign(new Error("User not found"), {code: 404});
          }
          //
          // If the userName is "manager" handle "basic" server commands otherwise handle user commands
          // (http://servername/manager/command)
          if (userName === "manager")
            result = await this.execCommand(params);
          else
            result = await user.processCommand(params);
          break;
        }
      }
    }
    catch (err) {
      error = err;
    }
    //
    let code, data;
    if (error) {
      code = error.code || 500;
      data = error.message;
    }
    else {
      code = 200;
      data = (typeof result === "object") ? JSON.stringify(result) : (result || "OK");
    }
    //
    // Handle RID if given (not for Unauthorized... that should go out immediately on the main output stream)
    if (params.req.query.rid && code !== 401)
      this.server.request.sendResponse(params.req.query.rid, code, data);
    else if (!res.headersSent) // No RID -> answer (unless the handler already did)
      res.status(code).send(data);
    //
    this.logger.log("DEBUG", "Operation completed", "Config.processCommand",
            {result: error ? error : data, url: req.originalUrl, host: req.socket.remoteAddress});
  }


  /**
   * Refuses a command that does not carry a valid authorization key, logging the attempt and throwing
   * a 401. When the AUTK check is enabled but no token has been generated yet (it is created at
   * startup and handed to the console, see {@link Node.Request#sendTokenToConsole}) every request is
   * refused: comparing a missing query key with a missing token would otherwise authorize anyone
   * (issue #14062).
   * @param {Object} params - Command parameters
   * @param {Object} params.req - Express request
   * @param {String} sender - Method asking for the check, for the log entry
   * @throws {Error} Unauthorized (code 401) when the request carries no valid AUTK
   */
  checkAuthorization(params, sender)
  {
    if (!this.auth)
      return;
    //
    if (this.autk && params.req.query.autk === this.autk)
      return;
    //
    this.logger.log("WARN", "Unauthorized", sender, {url: params.req.originalUrl});
    throw Object.assign(new Error("Unauthorized"), {code: 401});
  }


  /**
   * Executes a specific administrative command on the server.
   * Handles various management commands like status, configuration, updates, and diagnostics.
   * @param {Object} params - Command parameters including request and tokens
   * @returns {Promise<Object>} Command execution result
   */
  async execCommand(params)
  {
    let command = params.tokens[0];
    //
    // There are only 2 commands that can be executed without AUTK:
    // - Server RENAME (only if name is the default NEWIMAGE)
    // - TOKEN REFRESH
    let skipAutk = false;
    if (command === "config" && params.req.query.name && Object.keys(params.req.query).length === 1 && this.name === "newimage")
      skipAutk = true;
    else if (command === "refresh")
      skipAutk = true;
    //
    if (!skipAutk)
      this.checkAuthorization(params, "Config.execCommand");
    //
    // I'm here if AUTK is not enabled or if the given one matches
    switch (command) {
      case "geturl":
        return await this.fetchRemoteUrl(params);

      case "getavalic":
        return await this.getAvailableIdfLicenses(params);

      case "getlic":
        return this.getIdfLicense(params);

      case "setlic":
        return await this.setIdfLicense(params);

      case "checklic":
        return await this.checkLicense(true);

      case "getopt":
        return this.getIdfOptions(params);

      case "setopt":
        return await this.setIdfOptions(params);

      case "getappdata":
        return await this.getAppData(params);

      case "setappdata":
        return await this.setAppData(params);

      case "getthemes":
        // "Application not found" descrive la sessione che non ha quell'app, e non le altre due cose
        // che possono andare storte: la sessione che se n'e' andata, e quella che c'e' ma il cui invio
        // fallisce. Tutte e due portano il proprio messaggio invece di travestirsi dalla prima (#15707)
        try {
          return await this.sendCommandToIDESession(params.req.query.idesid, "idf-getthemes", {
            appid: params.req.query.appid
          }) || {err: "Application not found"};
        }
        catch (ex) {
          return {err: `${ex.message || ex}`};
        }

      case "createtheme":
        try {
          return await this.sendCommandToIDESession(params.req.query.idesid, "idf-createtheme", {
            appid: params.req.query.appid,
            name: params.req.query.name,
            source: params.req.query.source
          }) || {err: "Application not found"};
        }
        catch (ex) {
          return {err: `${ex.message || ex}`};
        }

      case "status":
        return await this.getStatus(params);

      case "config":
        return await this.configureServer(params);

      case "users":
        return this.getUsersList(params);

      case "sessions":
        return this.getSessionsList(params);

      case "refresh":
        return await this.refreshConsoleToken(params);

      case "log":
        return await this.handleLogCommand(params);

      case "message":
        return this.server.sendMessage(params);

      case "cert":
        return await this.configureCert(params);

      case "update":
        return await this.installUpdate(params);

      case "installIdeVersion":
        return await this.handleInstallIdeVersion(params);

      case "uninstallIdeVersion":
        return await this.handleUninstallIdeVersion(params);

      case "reboot":
        this.server.reboot();
        return;

      case "checkdisk":
        return await this.checkDataDisk();

      case "backupprj":
        return await this.backupProjects(params);

      case "snapshot":
        return await this.handleSnapshot(params);

      case "openprjfolder":
        return await this.openPrjFolder(params);

      default: {
        // For any other command ask MANAGER user
        let user = this.getUser("manager");
        if (user)
          return await user.processCommand(params);
        //
        this.logger.log("WARN", "Invalid command", "Config.execCommand", {cmd: command, url: params.req.originalUrl});
        throw new Error("Invalid Command");
      }
    }
  }


  /**
   * Gets the current license information.
   * Returns a copy of the server's license data including product permissions and limits.
   * @param {Object} params - Request parameters
   * @returns {Object} Message containing JSON-encoded license data
   */
  getIdfLicense(params)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }



  /**
   * Gets the list of available licenses from the license server.
   * Retrieves all licenses that can be activated on this server.
   * @param {Object} params - Request parameters
   * @returns {Promise<Object>} Message containing JSON-encoded list of available licenses
   */
  async getAvailableIdfLicenses(params)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }



  /**
   * Sends a command to all the active IDE sessions.
   * The command reaches every session and whatever they answer is ignored: it is the form of the
   * commands that carry the settings of the installation ("idf-setlic", "idf-setopt"), which every
   * open IDE has to apply.
   *
   * It must NOT be used for a command about a single object. Object ids are not unique across
   * projects - a project obtained by fork or duplication holds objects with the same ids as the
   * original - so every open session that finds that id answers, and a write would be applied by
   * all of them (#15707). Those commands go through sendCommandToIDESession.
   * @private
   * @param {String} command - API command to send (e.g., "idf-setlic", "idf-setopt")
   * @param {Object} [data] - Data to send with the command
   * @returns {Promise<void>}
   */
  async sendCommandToAllIDESessions(command, data)
  {
    for (let ideses of Object.values(this.server.IDESessions)) {
      await ideses.sendApiCommand({
        command,
        data
      }).catch(err => {
        // A session that has nothing to say answers `undefined`: a rejection is a real failure,
        // and swallowing it silently would leave no trace of it at all
        this.logger.log("WARN", `Session error handling ${command}: ${err?.message || err}`, "Config.sendCommandToAllIDESessions", {data});
      });
    }
  }


  /**
   * Sends a command about a single object to the IDE session it came from.
   * The wizards carry the id of their own session in `idesid` (see FCliApp, "idf_cli_config", and
   * ActiveXObject.execCommand), so a command about an object reaches only the project the user is
   * looking at, even when another project holds an object with the same id.
   *
   * When `idesid` is missing - a wizard opened before the IDE started sending it - the sessions are
   * asked one after the other until one of them answers, which is the behaviour of before, kept so
   * that a stale wizard goes on working. A session that does not hold the object answers `undefined`
   * (see Document.handleApiCommand).
   *
   * A named session that is no longer open is a different matter and does NOT fall back: the project
   * has been closed while its wizard was open, and asking the others would apply the command to a
   * project the user is not looking at - the very thing this method exists to prevent. It throws,
   * because not falling back has to be told: a write that answered "done" without having reached
   * anybody would lose what the user typed, and only the server log would know.
   * @private
   * @param {String} [idesid] - Id of the IDE session that sent the command
   * @param {String} command - API command to send (e.g., "idf-getappdata", "idf-createtheme")
   * @param {Object} [data] - Data to send with the command
   * @returns {Promise<Object>} the answer of the session, undefined when nobody answered
   * @throws {Error} When `idesid` names a session that is no longer open
   */
  async sendCommandToIDESession(idesid, command, data)
  {
    // `rethrow` distingue i due usi dello stesso invio: nel giro sulle sessioni un errore vuol dire
    // "prova la prossima", quindi si annota e si prosegue; alla sessione NOMINATA invece non c'e'
    // nessuna prossima, e ingoiarlo lascerebbe la causa nel solo log - chi ha premuto Salva si
    // sentirebbe dire che l'applicazione non e' stata trovata, mentre la sessione era aperta e a
    // fallire e' stato l'invio
    let send = async (ideses, rethrow) => await ideses.sendApiCommand({
      command,
      data
    }).catch(err => {
      this.logger.log("WARN", `Session error handling ${command}: ${err?.message || err}`, "Config.sendCommandToIDESession", {idesid, data});
      if (rethrow)
        throw err;
    });
    //
    if (idesid) {
      let session = this.server.IDESessions[idesid];
      if (!session) {
        this.logger.log("WARN", `Session ${idesid} is no longer open: ${command} not sent`, "Config.sendCommandToIDESession", {idesid});
        throw new Error("IDE session is no longer open");
      }
      //
      return await send(session, true);
    }
    //
    // Nobody named: the behaviour of before
    for (let ideses of Object.values(this.server.IDESessions)) {
      let res = await send(ideses);
      if (res !== undefined && res !== null)
        return res;
    }
  }


  /**
   * Sets or releases the server license.
   * Updates the license information and propagates it to all active IDE sessions.
   * Can activate a new license or release the current one.
   * @param {Object} params - Request parameters with license data
   * @returns {Promise<String>} Error code as string ("0" = success) or "ERROR ..." on exception
   */
  async setIdfLicense(params)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Fetches data from a URL bypassing CORS restrictions.
   * Used by ActiveX wizard to fetch external resources with security validations.
   * Blocks access to private/internal networks and enforces size limits.
   * @param {Object} params - Request parameters with target URL
   * @returns {Promise<String>} The remote response body as a string
   * @throws {Error} If the URL is invalid, uses a non-HTTP(S) protocol, points to a private/internal IP, the response exceeds 10MB, the request times out, or any network error occurs
   */
  async fetchRemoteUrl(params)
  {
    // Validate URL: only http/https allowed
    let parsed;
    let url = params.req.query.url;
    try {
      parsed = new URL(url);
    }
    catch (err) {
      throw new Error(`Invalid URL: ${err.message || err}`, {cause: err});
    }
    //
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new Error("Only HTTP/HTTPS protocols are allowed");
    //
    // Resolve hostname and block private/internal IP ranges (use lookup, not resolve4, to use the OS resolver)
    let address;
    try {
      address = await Node.dns.promises.lookup(parsed.hostname, {family: 4});
    }
    catch (err) {
      throw new Error(`Cannot resolve hostname ${parsed.hostname}: ${err.message || err}`, {cause: err});
    }
    //
    let parts = address.address.split(".").map(Number);
    if (parts[0] === 10 ||                                          // 10.0.0.0/8
            (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||  // 172.16.0.0/12
            (parts[0] === 192 && parts[1] === 168) ||                   // 192.168.0.0/16
            parts[0] === 127 ||                                          // 127.0.0.0/8 (loopback)
            (parts[0] === 169 && parts[1] === 254) ||                   // 169.254.0.0/16 (link-local / cloud metadata)
            parts[0] === 0)                                              // 0.0.0.0/8
      throw new Error("Access to private/internal networks is not allowed");
    //
    // Determine which module to use based on the protocol
    let client = require(parsed.protocol === "https:" ? "https" : "http");
    //
    let maxSize = 10 * 1024 * 1024;  // 10MB max
    return await new Promise((resolve, reject) => {
      // Security (issue #14643, E9): pin the connection to the IP just validated above so the
      // hostname is not re-resolved by the HTTP client. Without this the second resolution allows
      // a TOCTOU DNS-rebinding to a private/metadata range that passed the check the first time.
      // Node calls lookup with {all:true} (expects an array), so handle both callback forms.
      let pin = (hostname, opts, cb) => opts?.all ? cb(null, [{address: address.address, family: 4}]) : cb(null, address.address, 4);
      let req = client.get(url, {timeout: 30000, lookup: pin}, res => {
        let data = "";
        let size = 0;
        //
        // Receiving data
        res.on("data", chunk => {
          size += chunk.length;
          if (size > maxSize) {
            res.destroy();
            reject(new Error("Response too large"));
          }
          else
            data += chunk;
        });
        //
        // End of reception
        res.on("end", () => resolve(data));
      });
      req.on("error", err => reject(err));
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timed out"));
      });
    });
  }


  /**
   * Gets the IDF configuration options.
   * Returns IDE/IDF settings including work directory and UI preferences.
   * @param {Object} params - Request parameters
   * @returns {Object} Message containing JSON-encoded IDF options
   */
  getIdfOptions(params)
  {
    return Object.assign({
      AutoSaveTime: 1,
      MaxViews: 1,
      WorkDirectory: this.directory
    }, this.idfoptions);
  }


  /**
   * Sets the IDF configuration options.
   * Updates IDE/IDF settings and propagates changes to all active sessions.
   * @param {Object} params - Request parameters with options data
   * @returns {Promise<String>} "0" on success or "ERROR ..." on exception
   */
  async setIdfOptions(params)
  {
    try {
      let data = JSON.parse(params.req.query.data);
      //
      delete data.AutoSaveTime;
      delete data.MaxViews;
      data.ShowAllIcons = data.ShowAllIcons == "1";
      data.InlineParams = data.InlineParams == "1";
      data.UseAlwaysVCE = data.UseAlwaysVCE == "1";
      data.ContEditing = data.ContEditing == "1";
      data.AutoComments = data.AutoComments == "1";
      data.ShowObjDescr = data.ShowObjDescr == "1";
      data.ReuseView = data.ReuseView == "1";
      data.AutoColumns = data.AutoColumns == "1";
      //
      if (data.WorkDirectory) {
        this.directory = data.WorkDirectory;
        delete data.WorkDirectory;
      }
      //
      data.teamWorks = {
        gcloud: {
          bucketName: data.BucketName,
          bucketConfig: data.BucketConfig
        }
      };
      //
      try {
        if (data.BucketConfig)
          data.teamWorks.gcloud.bucketConfig = JSON.parse(data.BucketConfig.replaceAll(/\n/g, "\\n"));
      }
      catch {
      }
      //
      delete data.BucketName;
      delete data.BucketConfig;
      //
      this.idfoptions = data;
      //
      // Send the new options to all child sessions
      await this.sendCommandToAllIDESessions("idf-setopt", data);
      //
      await this.saveConfig();
      //
      return "0";
    }
    catch (ex) {
      return `ERROR ${ex}`;
    }
  }


  /**
   * Gets application data from the IDE session the wizard was opened from.
   * The app id alone does not tell the project apart - a forked project holds the same ids - so
   * without the id of the session the answer could be the one of another project, and the wizard
   * would then save those values over the right ones (#15707).
   * @param {Object} params - Request parameters with application ID
   * @returns {Promise<Object>} Application data object, or empty object `{}` if no sessions are active or no session contains the requested app
   */
  async getAppData(params)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Sets application data in the IDE session the wizard was opened from.
   * It used to reach every session, and each one holding an object with that id applied the write:
   * changing the build parameters of an application changed those of the twin application in a
   * forked project too (#15707).
   * @param {Object} params - Request parameters with application data
   * @returns {Promise<String>} "0" on success or "ERROR ..." on exception
   */
  async setAppData(params)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Sends SOAP requests to the license server.
   * Communicates with the Progamma license server for license operations.
   * Never throws and never returns a null value: any communication or parsing failure is
   * reported as an `{error}` object, so that a temporary problem with the license server
   * can't kill the process. Every `licSrv*` caller relies on this, dereferencing the result
   * without guarding the variable itself, so every exit point here has to return an object.
   * @param {String} operation - The operation to perform
   * @param {Object} [data] - Data to send to the server
   * @param {String} [format="json"] - Response format (json or xml)
   * @returns {Promise<Object|String>} Server response in the requested format, or `{error}` on failure
   */
  async sendToLicServer(operation, data, format = "json")
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Generates a unique system GUID based on hardware characteristics.
   * Caches the result for subsequent calls to maintain consistency.
   * @returns {String} System-specific UUID
   */
  generateSystemGUID()
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Gets the MAC address of the primary network interface.
   * Returns the first non-internal IPv4 interface MAC address.
   * @returns {String} MAC address or null if not found
   */
  getPrimaryMacAddress()
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Gets the current date and time formatted as DD/MM/YYYY HH:MM:SS.
   * @returns {String} Formatted date-time string
   */
  getCurrentDateTime()
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Gets operating system information including platform, version, and architecture.
   * @returns {String} Formatted OS information string
   */
  getOSInfo()
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Gets the Instant Developer Foundation JavaScript version.
   * @returns {String} Version string
   */
  getIndeVersion()
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Gets the first non-manager user with an active IDF license.
   * @returns {Node.User} User with IDF license or undefined
   */
  getIdfUser()
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Checks connectivity to the license server.
   * Tests if the license server is reachable and responding.
   * @returns {Promise<Boolean>} True if connected, false otherwise
   */
  async licSrvCheckConnection()
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Creates or updates user data on the license server.
   * Registers user information for license management.
   * @param {Node.User} user - User to register or update
   * @returns {Promise<Number>} Error code: 0 on success, the code returned by the license server, or
   * {@link Node.Config.licSrvConnectionError} if the server could not be reached
   */
  async licSrvUpdateUser(user)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Creates or updates the Instant Developer installation on the license server.
   * Registers installation details and retrieves license information.
   * @returns {Promise<Number>} Error code: 0 on success, -1 if there is no registered user, the code
   * returned by the license server, or {@link Node.Config.licSrvConnectionError} if the server could
   * not be reached
   */
  async licSrvUpdateInde()
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Retrieves the list of available licenses from the license server.
   * Gets all licenses associated with the current user account.
   * @returns {Promise<Array<Object>>} Array of license objects, empty if there is no registered user
   * or the license server could not be reached
   */
  async licSrvGetLicList()
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Associates a license with this installation.
   * Activates the specified license and updates local license data.
   * @param {Object} lic - License object to activate
   * @returns {Promise<Number>} Error code: 0 on success, -1 if there is no registered user, the code
   * returned by the license server, or {@link Node.Config.licSrvConnectionError} if the server could
   * not be reached
   */
  async licSrvGetLicense(lic)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Releases the current license from this installation.
   * Deactivates the license on the server and resets to Express license.
   * @returns {Promise<Number>} Error code: 0 on success, -1 if there is no registered user, the code
   * returned by the license server, or {@link Node.Config.licSrvConnectionError} if the server could
   * not be reached
   */
  async licSrvReleaseLicense()
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Uninstalls the Instant Developer installation from the license server.
   * Removes installation registration and releases any associated licenses.
   * @returns {Promise<Number>} Error code: 0 on success, -1 if there is no registered user, the code
   * returned by the license server, or {@link Node.Config.licSrvConnectionError} if the server could
   * not be reached
   */
  async licSrvUninstall()
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Validates and updates the software license from the license server.
   * Checks license validity, expiration, and product permissions periodically.
   * @param {Boolean} [force=false] - Force license check regardless of timing
   */
  async checkLicense(force = false)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Redirects to the initial landing page for the server based on configuration.
   * Routes to IDE login, default app, or alias-specific apps.
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */
  async redirectToFirstPage(req, res)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Opens the given project folder in the system file explorer.
   * Available only on a locally-running server (IDS desktop/local); refused on cloud servers.
   * The path must be within one of the allowed roots: the local Instant Developer folder or, when
   * set, the configured projects directory.
   * @param {Object} params - Request parameters
   * @param {String} params.req.query.path - Absolute path of the folder to open
   * @returns {Promise<String>} "OK" if launched successfully
   */
  async openPrjFolder(params)
  {
    if (!this.local)
      throw Object.assign(new Error("Only available on local servers"), {code: 403});
    //
    let reqPath = params.req.query.path;
    if (!reqPath)
      throw new Error("Missing 'path' parameter");
    //
    // Resolve and confine to the allowed roots, to avoid opening arbitrary system paths: the local
    // Instant Developer folder and, when set, the configured projects directory (#14585). Confining
    // to the local folder alone rejected every request as soon as that option was in use, because
    // that is exactly where the projects no longer are (issue #15005)
    let target = await Node.Utils.realPath(reqPath);
    let roots = [this.directory];
    if (this.idfoptions?.IdsPrjDir)
      roots.push(this.idfoptions.IdsPrjDir);
    //
    if (!Node.Utils.isPathInside(target, await Promise.all(roots.map(r => Node.Utils.realPath(r)))))
      throw new Error("Path is outside the allowed directory");
    //
    let cmd = process.platform === "win32" ? "explorer.exe" :
              process.platform === "darwin" ? "open" : "xdg-open";
    Node.child.spawn(cmd, [target], {detached: true, stdio: "ignore"}).unref();
    //
    return "OK";
  }


  /**
   * Check if a specific product/module is active in the license
   * @param {Number} productFlag - Product flag (e.g., 0x0200 for TeamWorks)
   * @returns {Boolean} - True if the product is active
   */
  isProductActive(productFlag)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Initialize browser paths by detecting installed browsers on the system
   * Detects installed browsers (IE, Firefox, Safari, Chrome, Edge) and determines the default browser
   * Supports Windows, macOS, and Linux platforms
   */
  async initBrowserPath()
  {
    if (!this.idfoptions || this.idfoptions.SelBrowser)
      return;
    //
    let os = require("os");
    let util = require("util");
    let exec = util.promisify(require("child_process").exec);
    //
    let platform = os.platform();
    let defBrowser;
    //
    if (platform === "win32") {
      // Windows implementation
      let regedit = require("regedit").promisified;
      //
      // Helper function to get registry value from HKCU or HKLM
      let getRegistryValue = async (hives, keyPath, valueName = "") => {
        try {
          for (let hive of hives) {
            let key = `${hive}\\${keyPath}`;
            let registry = (await regedit.list([key]))[key];
            if (registry.exists)
              return registry.values?.[valueName]?.value;
          }
        }
        catch {
          // Ignore errors
        }
      };
      //
      // Set default IE path
      this.idfoptions.IEPath = "iexplore.exe";
      //
      let hives = ["HKCU", "HKLM"];
      let appPaths = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\";
      //
      // Get Firefox path
      let ffxPath = await getRegistryValue(hives, `${appPaths}firefox.exe`);
      if (ffxPath)
        this.idfoptions.FfxPath = ffxPath;
      //
      // Get Safari path
      let safariPath = await getRegistryValue(hives, `${appPaths}Safari.exe`);
      if (safariPath)
        this.idfoptions.SafariPath = safariPath;
      //
      // Get Chrome path
      let chromePath = await getRegistryValue(hives, `${appPaths}chrome.exe`);
      if (chromePath)
        this.idfoptions.ChromePath = chromePath;
      //
      // Get Edge path
      let edgePath = await getRegistryValue(hives, `${appPaths}msedge.exe`);
      if (edgePath)
        this.idfoptions.EdgePath = edgePath;
      //
      // Get default browser from user choice
      let key = "Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice";
      let progid = await getRegistryValue(["HKCU"], key, "ProgId");
      switch (progid) {
        case "ChromeHTML":
          defBrowser = "CHROME.EXE";
          break;
        case "MSEdgeHTM":
          defBrowser = "MSEDGE.EXE";
          break;
        case "FirefoxURL":
          defBrowser = "FIREFOX.EXE";
          break;
        default:
          defBrowser = "IEXPLORE";
      }
      //
      // Se non ho ancora trovato, provo con la default app per i file con estensione http
      if (!defBrowser) {
        defBrowser = await getRegistryValue(["HKCR"], "http\\shell\\open\\command");
        if (!defBrowser)
          defBrowser = await getRegistryValue(hives, "SOFTWARE\\Classes\\http\\shell\\open\\command");
      }
    }
    else if (platform === "darwin") {
      // macOS implementation
      // Common macOS browser paths
      let firefoxPath = "/Applications/Firefox.app/Contents/MacOS/firefox";
      if (Node.fs.existsSync(firefoxPath))
        this.idfoptions.FfxPath = firefoxPath;
      //
      let safariPath = "/Applications/Safari.app/Contents/MacOS/Safari";
      if (Node.fs.existsSync(safariPath))
        this.idfoptions.SafariPath = safariPath;
      //
      let chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      if (Node.fs.existsSync(chromePath))
        this.idfoptions.ChromePath = chromePath;
      //
      let edgePath = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
      if (Node.fs.existsSync(edgePath))
        this.idfoptions.EdgePath = edgePath;
      //
      // Get default browser on macOS
      try {
        let {stdout: bundleId} = await exec("plutil -convert json -o - ~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist | jq -r '.LSHandlers[] | select(.LSHandlerURLScheme == \"https\") | .LSHandlerRoleAll' | head -1");
        bundleId = bundleId.trim();
        //
        // Map bundle ID to browser name
        switch (bundleId) {
          case "com.google.chrome":
            defBrowser = "CHROME";
            break;

          case "com.apple.safari":
            defBrowser = "SAFARI";
            break;

          case "org.mozilla.firefox":
            defBrowser = "FIREFOX";
            break;

          case "com.microsoft.edgemac":
            defBrowser = "EDGE";
            break;

          default:
            defBrowser = "SAFARI"; // Default to Safari if unknown
        }
      }
      catch {
        defBrowser = "SAFARI"; // Default to Safari on macOS
      }
    }
    else {
      // Linux implementation
      // Common Linux browser paths
      let firefoxPaths = [
        "/usr/bin/firefox",
        "/usr/local/bin/firefox",
        "/snap/bin/firefox"
      ];
      for (let p of firefoxPaths) {
        if (Node.fs.existsSync(p)) {
          this.idfoptions.FfxPath = p;
          break;
        }
      }
      //
      let chromePaths = [
        "/usr/bin/google-chrome",
        "/usr/local/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium"
      ];
      for (let p of chromePaths) {
        if (Node.fs.existsSync(p)) {
          this.idfoptions.ChromePath = p;
          break;
        }
      }
      //
      let edgePaths = [
        "/usr/bin/microsoft-edge",
        "/usr/bin/microsoft-edge-stable"
      ];
      for (let p of edgePaths) {
        if (Node.fs.existsSync(p)) {
          this.idfoptions.EdgePath = p;
          break;
        }
      }
      //
      // Get default browser on Linux
      try {
        let {stdout} = await exec("xdg-settings get default-web-browser");
        defBrowser = stdout.trim().toUpperCase();
      }
      catch {
        // Try alternative method
        try {
          let {stdout} = await exec("update-alternatives --query x-www-browser | grep Value | awk '{print $2}'");
          defBrowser = stdout.trim().toUpperCase();
        }
        catch {
          defBrowser = "FIREFOX"; // Default to Firefox on Linux
        }
      }
    }
    //
    // Determine selected browser (cross-platform)
    defBrowser = (defBrowser || "").toUpperCase();
    if (defBrowser.includes("FIREFOX") && this.idfoptions.FfxPath)
      this.idfoptions.SelBrowser = 2;
    else if (defBrowser.includes("SAFARI") && this.idfoptions.SafariPath)
      this.idfoptions.SelBrowser = 3;
    else if (["CHROME", "CHROMIUM"].includes(defBrowser) && this.idfoptions.ChromePath)
      this.idfoptions.SelBrowser = 4;
    else if (defBrowser.includes("EDGE") && this.idfoptions.EdgePath)
      this.idfoptions.SelBrowser = 5;
    else if (platform === "win32")
      this.idfoptions.SelBrowser = 5; // IE/Edge on Windows
    else if (platform === "darwin")
      this.idfoptions.SelBrowser = this.idfoptions.SafariPath ? 3 : (this.idfoptions.ChromePath ? 4 : 2); // Safari > Chrome > Firefox on macOS
    else
      this.idfoptions.SelBrowser = this.idfoptions.FfxPath ? 2 : (this.idfoptions.ChromePath ? 4 : 5); // Firefox > Chrome > Edge on Linux
  }
};


// Export module
module.exports = Node.Config;
