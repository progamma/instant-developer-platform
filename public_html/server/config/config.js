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
Node.Archiver = require("../archiver");


/**
 * @class Represents an Instant Developer configuration
 * @param {Node.Server} par - pointer to parent (server) object
 */
Node.Config = function (par)
{
  this.parent = par;
  this.users = [];
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
    IdsRestoreUI: "0"
  };
};


Node.Config.msgTypeMap = {
  notify: "n",
  execCmd: "excmd"
};


// Define usefull properties for this object
Object.defineProperties(Node.Config.prototype, {
  server: {
    get() {
      return this.parent;
    }
  },
  logger: {
    get() {
      return this.server.logger;
    }
  }
});


/**
 * Save the object
 */
Node.Config.prototype.save = function ()
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
    nigthlybucketGCloud: this.nigthlybucketGCloud,
    storage: this.storage,
    customPackages: this.customPackages,
    dbPort: this.dbPort,
    dbAddress: this.dbAddress,
    dbUser: this.dbUser,
    dbPassword: this.dbPassword,
    googleAPIKey: this.googleAPIKey,
    timerSession: this.timerSession,
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
    params: this.params,
    users: this.users,
    licdata: this.licdata,
    idfoptions: this.idfoptions,
    devAgentApiKey: this.devAgentApiKey,
    devAgentDailyBudget: this.devAgentDailyBudget
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
      let certClone = JSON.parse(JSON.stringify(cert));
      delete certClone.SSLKey_data;
      delete certClone.SSLCert_data;
      delete certClone.SSLCABundles_data;
      //
      r.customSSLCerts.push(certClone);
    });
  }
  //
  return r;
};


/**
 * Load the object
 * @param {Object} v - the object that contains my data
 */
Node.Config.prototype.load = function (v)
{
  if (v.name)
    this.name = v.name;
  if (v.users)
    this.users = v.users;
  if (v.auth)
    this.auth = v.auth;
  if (v.editPrjToken)
    this.editPrjToken = v.editPrjToken;
  if (v.timerSession)
    this.timerSession = v.timerSession;
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
  if (v.nigthlybucketGCloud)
    this.nigthlybucketGCloud = v.nigthlybucketGCloud;
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
};


/**
 * Save the object's properties (i.e. no children objects)
 */
Node.Config.prototype.saveProperties = function ()
{
  let r = this.save();
  //
  // Delete children
  delete r.cl;
  delete r.users;
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
};


/**
 * Return a map of all remote DB urls (name -> remoteUrl)
 */
Node.Config.prototype.getRemoteDBUrls = function ()
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
};


/*
 * Write the current configuration to config.json file
 */
Node.Config.prototype.saveConfig = async function ()
{
  let configFile;
  if (this.local)
    configFile = Node.path.resolve(__dirname, "..", "config.json");
  else
    configFile = Node.path.resolve(__dirname, "..", "..", "..", "config", "config.json");
  //
  // This method is called in several points and it's asynchronous, thus we can have problems
  // if two different clients calls this method in the same time.... better protect multiple calls
  if (this.savingConf) {
    // I'm already saving the config file... procrastinate
    setTimeout(() => this.saveConfig(), 100);
    return;
  }
  //
  this.logger.log("INFO", "Config file save started", "Config.saveConfig");
  //
  this.savingConf = true;   // Start save
  let action;
  try {
    let docjson = JSON.stringify(this, (k, v) => {
      if (v instanceof Node.Config || v instanceof Node.User || v instanceof Node.Database || v instanceof Node.Project || v instanceof Node.App)
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
    // Everything went fine... Remove the old .BAK if present
    action = `removing the old CONFIG file ${configFile}.bak`;
    await Node.fs.promises.rm(`${configFile}.bak`, {force: true});
    //
    // Backup the config file into a .bak file
    action = `renaming the CONFIG file ${configFile} to ${configFile}.bak`;
    await Node.fs.promises.rename(configFile, `${configFile}.bak`);
    //
    // Rename the .new into the final file
    action = `renaming the CONFIG file ${configFile}.new to ${configFile}`;
    await Node.fs.promises.rename(`${configFile}.new`, configFile);
    //
    this.logger.log("INFO", "Config file saved successfully", "Config.saveConfig");
  }
  catch (err) {
    this.logger.log("ERROR", `Error ${action}: ${err}`, "Config.saveConfig");
  }
  finally {
    delete this.savingConf;
  }
};


/**
 * Read the JSON of the configuration from the file config.json
 */
Node.Config.prototype.loadConfig = async function ()
{
  let configFile;
  if (this.local)
    configFile = Node.path.resolve(__dirname, "..", "config.json");
  else
    configFile = Node.path.resolve(__dirname, "..", "..", "..", "config", "config.json");
  //
  let configTXT = Node.fs.readFileSync(configFile, {encoding: "utf8"});
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
  this.check();
};


/**
 * Set the parent of this object (and its children)
 * @param {Object} par - my parent
 */
Node.Config.prototype.setParent = function (par)
{
  this.parent = par;
  //
  if (this.users)
    for (let i = 0; i < this.users.length; i++)
      this.users[i].setParent(this);
};


/**
 * Check server configuration
 */
Node.Config.prototype.check = async function ()
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
      this.logger.log("ERROR", `Error creating the home folder ${this.directory}: ${err}`, "Config.check");
  }
  //
  // Check the configuration for all the users
  // (this operation must be serialized as the OS cannot create many users at the same time)
  for (let user of this.users)
    await user.check().catch(() => {});
};


/**
 * Get the server URL
 * @param {Object} req - optional http request to be used to get HOST
 * @returns {String}
 */
Node.Config.prototype.getUrl = function (req)
{
  if (this.local)
    return "http://localhost:8081";                               // Return LOCAL url
  else if (req && this.getHostFromReq(req))
    return `${this.protocol}://${this.getHostFromReq(req)}`;      // If a REQ object was given use it to get the "right" HOST
  else
    return `${this.protocol}://${this.name}.${this.domain}`; // Return "design-time" url
};


/**
 * Returns a valid HOST from the given HTTP request
 * @param {Object} req - http request to be used to get HOST
 * @returns {String}
 */
Node.Config.prototype.getHostFromReq = function (req)
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
};


/**
 * Return the server external IP
 * @returns {String}
 */
Node.Config.prototype.getExternalIp = async function ()
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
};


/**
 * Return the current main file (index.html)
 * @returns {String}
 */
Node.Config.prototype.getMainFile = function ()
{
  // Use INDEXLOCAL.html file if I'm on a local machine or if I'm not minifying
  if (this.local || !this.minify)
    return "/indexLocal2.html";
  else
    return "/index2.html";
};


/**
 * Return the current main file (index.html)
 * @param {Boolean} offline - (optional) if given use offline.htm file
 */
Node.Config.prototype.getAppMainFile = function (offline)
{
  // Use INDEXLOCAL.html file if I'm on a local machine or if I'm not minifying
  let page = offline ? "offline" : "index";
  if (this.local || !this.minify)
    page += "Local";
  //
  return `client/${page}.html`;
};


/**
 * Find a user by name
 * @param {String} name
 * @returns {Node.User}
 */
Node.Config.prototype.getUser = function (name)
{
  return this.users.find(user => user.userName === name);
};


/**
 * Create a new user
 * @param {String} userName
 */
Node.Config.prototype.createUser = async function (userName)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Delete an existing user
 * @param {String} userName
 */
Node.Config.prototype.deleteUser = async function (userName)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Updates the package.json file with customPackages property
 * @param {Array} toRemove - list of modules to remove
 * @param {Array} toAdd - list of modules to add
 */
Node.Config.prototype.updatePackageJson = async function (toRemove, toAdd)
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
  let packageJSONfile = Node.path.join(__dirname, "..", "..", "package.json");
  //
  this.logger.log("DEBUG", "Updating Package.json file", "Config.updatePackageJson", {toRemove, toAdd});
  //
  try {
    // First, read package.json file
    let data;
    try {
      data = await Node.fs.promises.readFile(packageJSONfile);
    }
    catch (err) {
      throw new Error(`Error reading the package.json file: ${err}`);
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
      throw new Error(`Error removing the old package.json file ${packageJSONfile}.bak: ${err}`);
    }
    //
    // Backup the the config file into a .bak file
    try {
      await Node.fs.promises.rename(packageJSONfile, `${packageJSONfile}.bak`);
    }
    catch (err) {
      throw new Error(`Error renaming the package.json file ${packageJSONfile} to ${packageJSONfile}.bak: ${err}`)
    }
    //
    // Save package.json file
    try {
      await Node.fs.promises.writeFile(packageJSONfile, JSON.stringify(packageJson, null, 2), {mode: 0o644});     // RW-R-R
    }
    catch (err) {
      throw new Error(`Error while saving the package.json file: ${err}`);
    }
    //
    this.logger.log("DEBUG", "Package.json file saved with success", "Config.updatePackageJson");
    //
    // Last: update packages
    try {
      await this.server.execFileAsRoot("UpdNodePackages", []);
      this.logger.log("INFO", "Package.json and node_modules updated", "Config.updatePackageJson", {toRemove, toAdd});
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
      throw new Error(`Error while updating packages: ${err}`);
    }
  }
  catch (err) {
    this.logger.log("ERROR", err.message || err, "Config.updatePackageJson");
    throw err;
  }
};


/**
 * Process RUN command for the server
 * @param {Request} req
 * @param {Response} res
 */
Node.Config.prototype.processRun = async function (req, res)
{
  // Possible URL formats:
  //    for IDE:
  //      [sid]/[appid]/run
  //    for MASTER:
  //      {nothing}
  //      [app]                             (master user)
  //      [app]?sid={SID}                   (master user)
  //      [user]/[app]
  //      [user]/[app]?sid={SID}
  let sid, cid, session, app;
  let isIDE = (req.params.sid);     // [sid]/[appid]/run
  let isWebApi = (req.params.cls);  // [app]/[clsid] or [app]/[clsid]/*
  let isRest = (req.query && req.query.mode === "rest");
  //
  this.logger.log("DEBUG", "Handle process RUN", "Config.processRun", {url: req.originalUrl, host: req.socket.remoteAddress});
  //
  Node.Utils.unlockRequestQuery(req);
  //
  // If caller is a bot -> go REST
  if (!isRest && !!req.useragent.isBot && !isWebApi) {
    req.query.mode = "rest";
    isRest = true;
    //
    this.logger.log("DEBUG", "Bot request -> activate REST", "Config.processRun", {url: req.originalUrl, userAgent: req.useragent.source});
  }
  //
  if (req.method === "OPTIONS") {
    // Accept only "OPTIONS" that comes from webAPI requests or a DROPZONE element
    // (that will send a POST with mode=rest in the query string)
    let meth = req.headers["access-control-request-method"];
    if (["GET", "POST", "DELETE", "PUT", "PATCH"].includes(meth) && (isRest || isWebApi)) {
      // That good... reply with 204
      this.logger.log("DEBUG", "Valid OPTIONS request", "Config.processRun",
              {meth: req.method, url: req.originalUrl, headers: req.headers});
      //
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Headers", "*");
      res.header("Access-Control-Allow-Methods", "*");
      res.header("Access-Control-Max-Age", "86400"); // Cache for 24 hours
      return res.status(204).end();
    }
    //
    // Something is wrong.. better reply with an error
    this.logger.log("WARN", "Invalid OPTIONS request", "Config.processRun",
            {meth: req.method, url: req.originalUrl, headers: req.headers});
    return res.status(405).end("HTTP method not supported");
  }
  //
  // Check methods
  if ((!isWebApi && !["GET", "POST"].includes(req.method)) ||
          (isWebApi && !["GET", "POST", "PUT", "DELETE", "PATCH"].includes(req.method))) {
    this.logger.log("WARN", "Request method not allowed", "Config.processRun",
            {meth: req.method, url: req.originalUrl, remoteAddress: req.socket.remoteAddress});
    return res.status(405).end("HTTP method not supported");
  }
  //
  // If the HOST is not valid, don't reply
  if (!this.getHostFromReq(req)) {
    this.logger.log("WARN", "Bad HOST", "Config.processRun",
            {meth: req.method, url: req.originalUrl, host: req.headers.host, remoteAddress: req.socket.remoteAddress});
    return res.status(500).end("Invalid HOST parameter");
  }
  //
  if (isIDE) {     // IDE
    sid = req.params.sid;
    session = this.server.IDESessions[sid];
    if (!session) {
      this.logger.log("WARN", "Session not found", "Config.processRun", {sid});
      return res.status(500).send("Session not found");
    }
  }
  else {      // MASTER
    // Get the name of the user and app from the url
    let urlParts = req.originalUrl.substring(1).split("?")[0].split("/");
    if (urlParts.length && urlParts[urlParts.length - 1] === "")    // Eat last part if empty (originalUrl always ends with "/")
      urlParts.pop();
    //
    let userName, appName;
    if (urlParts.length === 0) {     // {nothing}
      // If an HOST was provided, try to see if there is a specific app for this host
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
      defApp = defApp || this.defaultApp;   // Use server's default app if not found
      if (defApp) {
        // Redirect to default app
        this.logger.log("DEBUG", "No app specified -> redirect to default app", "Config.processRun",
                {defaultApp: defApp, url: req.originalUrl});
        //
        // Don't use
        //     this.getUrl() + "/" + this.defaultApp
        // because I want to reply using the domain used in the request (that is not always equal to the server url
        // if DNS or custom certificates defines several domains)
        let redirUrl = defApp;
        if (req.originalUrl.includes("?"))
          redirUrl += req.originalUrl.substring(req.originalUrl.indexOf("?"));
        //
        res.redirect(redirUrl);
        return;
      }
    }
    else if (urlParts.length === 1) { // [app] and [app]?sid={SID}
      userName = "manager";
      appName = urlParts[0];
      this.logger.log("DEBUG", "App detected (manager/app form)", "Config.processRun", {userName: userName, app: appName, url: req.originalUrl});
    }
    else if (isWebApi) {
      userName = "manager";
      appName = req.params.app;
      this.logger.log("DEBUG", "App detected (manager/app/cls form)", "Config.processRun", {userName: userName, app: appName, url: req.originalUrl});
    }
    else {
      userName = urlParts[0];
      appName = urlParts[1];        // [user]/[app] and [user]/[app]?sid={SID}
      this.logger.log("DEBUG", "App detected (user/app form)", "Config.processRun", {userName: userName, app: appName, url: req.originalUrl});
    }
    //
    // If there is not an app to start, stop here
    if (!appName) {
      let exitUrl = this.saveProperties().exitUrl;
      this.logger.log("WARN", `No command detected and no app to start. Redirect to ${exitUrl}`, "Config.processRun",
              {url: req.originalUrl});
      return res.redirect(exitUrl);
    }
    //
    // Get the user
    let user = this.getUser(userName);
    if (!user) {
      if (isWebApi)
        return req.next();
      this.logger.log("WARN", "User not found", "Config.processRun", {user: userName, app: appName, url: req.originalUrl});
      return res.status(500).send(`User ${userName} not found`);
    }
    //
    // Search the app with the given name
    app = user.getApp(appName);
    if (!app) {
      if (isWebApi)
        return req.next();
      this.logger.log("WARN", "App not found", "Config.processRun", {user: userName, app: appName, url: req.originalUrl});
      return res.status(404).send(`App ${appName} not found`);
    }
    //
    // If the app has been stopped
    if (app.stopped) {
      this.logger.log("WARN", "Can't start app because it's stopped", "Config.processRun", {user: userName, app: app.name});
      return res.status(503).send(`App ${app.name} stopped`);
    }
    //
    // If the app is updating
    if (app.updating) {
      this.logger.log("WARN", "Can't start app because it's updating", "Config.processRun", {user: userName, app: app.name});
      //
      // return res.redirect("/" + app.name + "/client/updating.html");
      // I could redirect to "upadting.html" file... but then the user would try to hit the REFRESH button
      // waiting forever the update to be complete.
      // Solution: send the updating.html file as a response without redirecting
      res.writeHead(200, {"Content-Type": "text/html"});
      //
      let path = Node.path.join(this.appDirectory, "apps", app.name, "client", "updating.html");
      let stream = Node.fs.createReadStream(path);
      stream.on("open", () => stream.pipe(res));
      stream.on("end", () => {
        this.logger.log("DEBUG", "Updating.html sent", "Config.processRun", {user: userName, app: app.name});
      });
      stream.on("error", err => {
        this.logger.log("WARN", `Error sending the file ${path} to an updating app: ${err}`, "Config.processRun",
                {user: userName, app: app.name});
      });
      return;
    }
    //
    // If the app has been started in OFFLINE mode and the app CAN be started in offline mode
    if (req.query.mode === "offline" && app.params && app.params?.allowOffline && !app.params.startPage) {
      this.logger.log("DEBUG", "Start app in OFFLINE mode", "Config.processRun", {user: userName, app: app.name});
      return res.redirect(`/${app.name}/${this.getAppMainFile(req.query.mode)}`);
    }
    //
    // If a SID was provided on the query string, check for it
    sid = req.query.sid;
    cid = req.query.cid;
    if (sid) {
      // Search if a session for this SID exists
      session = this.server.appSessions[sid];
      if (!session) {
        this.logger.log("WARN", "Session not found", "Config.processRun",
                {sid, cid, user: app.user.userName, app: app.name});
        return res.status(500).send("Invalid session");
      }
      //
      // Session exists. Now, if given, check client
      if (cid) {
        let client = session.getAppClientById(cid);
        if (!client) {
          this.logger.log("WARN", "Session client not found", "Config.processRun",
                  {sid, cid, user: app.user.userName, app: app.name});
          return res.status(500).send("Invalid client");
        }
      }
      else if (!isRest && req.query.ctoken) {
        // - SID was provided and is valid and is connected with a master client
        // - Session is not REST
        // - CID was not provided
        // That's telecollaboration!!!
        // Create a new ID for the new client that will be created soon (client will be created
        // inside the session::createAppClient called below)
        cid = req.query.ctoken;   // Use the CTOKEN as new client ID... it's easier
        session.newCid = cid;
        //
        this.logger.log("DEBUG", "No CID provided for MASTER session -> grant for telecollaboration", "Config.processRun",
                {sid, cid, user: app.user.userName, app: app.name});
      }
    }
    else {
      if (isWebApi) {
        // Try to load metadata.json file
        let webApiPath = `${this.appDirectory}/apps/${appName}/server/webapi`;
        //
        // If api-docs is required (by GET) responde with it
        let openApiPath = `${webApiPath}/openapi.json`;
        if (req.params.cls === "api-docs" && req.method === "GET") {
          if (!Node.fs.existsSync(openApiPath))
            return res.status(404).send("File not found");
          //
          // Serve the swagger documentation
          let swaggerPath = `${this.appDirectory}/apps/${appName}/client/swagger/index.html`;
          let readStream = Node.fs.createReadStream(swaggerPath);
          res.setHeader("Content-Type", "text/html; charset=UTF-8");
          //
          // Stream the file as response
          readStream.pipe(res);
          //
          // Stream error handling
          readStream.on("error", () => res.status(500).send("Internal Server Error"));
          return;
        }
        //
        // If openpai.json is required (by GET) responde with it
        if (req.params.cls === "openapi.json" && req.method === "GET") {
          if (!Node.fs.existsSync(openApiPath))
            return res.status(404).send("File not found");
          //
          // Read the content of "server/webapi/openapi.json"
          let spec = require(openApiPath);
          //
          // Replace $serverUrl with the real server url
          let serverUrl = `${req.protocol}://${req.get("host")}/${appName}`;
          spec.info.description = spec.info.description.replace(/\$serverUrl/g, serverUrl);
          spec.servers[0].url = serverUrl;
          //
          res.setHeader("Content-Type", "application/json");
          res.send(spec);
        }
        //
        let metadataPath = `${webApiPath}/metadata.json`;
        if (!Node.fs.existsSync(metadataPath))
          return req.next();
        //
        // Read content of metadata.json
        let metadata = require(metadataPath);
        //
        // If metadata is required (by GET) responde with it
        if (req.params.cls === "$metadata" && req.method === "GET") {
          let serviceMetadata = require("odata-v4-service-metadata").ServiceMetadata;
          res.type("text/xml").set("OData-Version", "4.0").status(200).end(serviceMetadata.processMetadataJson(metadata).data);
          return;
        }
        //
        // Verify if cls is a good name of class with WebAPI flag
        let cls = req.params.cls.split("(")[0];
        if (!metadata.dataServices.schema.find(s => {
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
          else
            return false;
        }))
          return req.next();
      }
      //
      // No SID -> create a new session
      session = app.createNewSession({type: (isRest ? "rest" : "web"), query: req.originalUrl.split("?")[1]});
      //
      // If a session can't be created -> do nothing
      if (!session) {
        this.logger.log("WARN", "Session can't be created: too many users", "Config.processRun", {user: app.user.userName, app: app.name});
        return res.status(503).send("Too many users");
      }
      //
      sid = session.id;
      //
      // Create a new ID for the new client that will be created soon (client will be created
      // inside the session::createAppClient called below)
      cid = Node.Utils.generateUID36();
      session.newCid = cid;
      //
      this.logger.log("DEBUG", "Created new app session", "Config.processRun",
              {user: app.user.userName, app: appName, sid, cid, url: req.originalUrl});
    }
    //
    if (!isRest && !isWebApi) {
      // Create/update cookies for this session
      let expires = new Date(Date.now() + 86400000);
      let cookieOpt = {expires, path: `/${app.name}`};
      //
      // If I'm working "securely"
      let secure = (!this.local && this.protocol === "https");
      if (secure) {
        cookieOpt.secure = true;
        cookieOpt.sameSite = "none";  // Allow embedding the app in an IFRAME
      }
      res.cookie("sid", sid, cookieOpt);
      res.cookie("cid", cid, cookieOpt);
      res.cookie("exitUrl", this.saveProperties().exitUrl, cookieOpt);
      //
      // Protects SID cookie
      session.protectSID(req, res);
    }
  }
  //
  let params;
  let newAppReq = false;
  //
  // If it's a POST request
  if (req.method === "POST") {
    // Check if it's a multi-part POST
    let contentType = req.get("Content-Type");
    if (contentType?.includes("multipart/form-data")) {
      // It's a file upload -> this is a rest request...
      if (!isRest) {
        isRest = true;
        req.query = req.query || {};
        req.query.mode = "rest";
      }
      //
      // Compute maximum file size
      let maxFilesSize = parseInt(app?.params?.maxUploadFileSize || this.params?.maxUploadFileSize || 0) || 50 * 1024 * 1024;   // Default: 50 MB
      //
      // Multi part request. Parse it
      let form;
      if (isIDE)
        form = new Node.multiparty.Form({autoFields: true, autoFiles: true, maxFilesSize,
          uploadDir: Node.path.join(this.directory, session.project.user.userName, session.project.name, "files", "uploaded")});
      else
        form = new Node.multiparty.Form({autoFields: true, autoFiles: true, maxFilesSize,
          uploadDir: Node.path.join(this.appDirectory, "apps", app.name, "files", "uploaded")});
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
        return res.status(500).end(err.message);
      }
      //
      // Check if the session is still there
      session = isIDE ? this.server.IDESessions[sid] : this.server.appSessions[sid];
      if (!session) {
        // Delete files
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
        return res.status(500).send("Session not found");
      }
      //
      // Extract fields
      let fldarr = Object.keys(fields);
      for (let i = 0; i < fldarr.length; i++) {
        let key = fldarr[i];
        if (fields[key].length === 1)
          fields[key] = fields[key][0];
      }
      //
      // Extract files
      let postfiles = [];
      let fileArr = [];
      for (let name of Object.keys(files)) {
        for (let f of files[name])
          fileArr.push(f);
      }
      //
      newAppReq = true;
      params = {params: fields, files: postfiles};
      //
      // There are files... rename them and send to app
      for (let f of fileArr) {
        let ext = "";
        //
        // If there's a content type, try to get extension using it
        if (f.headers?.["content-type"])
          ext = Node.mime.extension(f.headers["content-type"]);
        //
        // If no extension, try to get it from file original name
        if (!ext) {
          ext = f.originalFilename.split(".");
          if (ext.length > 1)
            ext = ext[ext.length - 1];
        }
        //
        if (ext)
          ext = "." + ext;
        //
        let id = Node.Utils.generateUID36();
        let path, localPath;
        if (isIDE) {    // IDE
          path = `${session.project.user.userName}/${session.project.name}/files/uploaded/${id}${ext}`;
          localPath = Node.path.join(this.directory, path);
        }
        else {    // MASTER
          path = `${app.name}/files/uploaded/${id}${ext}`;
          localPath = Node.path.join(this.appDirectory, `apps`, path);
        }
        let serverPath = `${this.getUrl()}/${path}`;
        //
        // Move file
        try {
          await Node.fs.promises.rename(f.path, localPath);
          postfiles.push({path: `uploaded/${id}${ext}`, type: undefined, originalName: f.originalFilename, publicUrl: serverPath});
          //
          // Log operation
          this.logger.log("INFO", "Received file via REST request", "Config.processRun",
                  {path: `uploaded/${id}${ext}`, serverPath});
        }
        catch (err) {
          this.logger.log("ERROR", `Error moving POST file: ${err}`, "Config.processRun", {src: f.path, dst: localPath});
          //
          // Remove the file
          try {
            await Node.fs.promises.unlink(f.path);
          }
          catch (err) {
            this.logger.log("ERROR", `Error removing temp POST file after move failed: ${err}`, "Config.processRun", {src: f.path});
          }
        }
      }
    }
    else // non-multipart post
      newAppReq = true;
  }
  else if (req.method === "GET" || (isWebApi && (req.method === "DELETE" || req.method === "PUT" || req.method === "PATCH")))
    newAppReq = true;
  //
  if (newAppReq) {
    let oldreq = session.request;
    session.request = {query: req.query, body: req.body};
    if (req.socket?.remoteAddress)
      session.request.remoteAddress = req.socket.remoteAddress.replace(/^.*:/, "");
    session.request.headers = req.headers;
    session.request.isBot = !!req.useragent.isBot;
    session.cookies = req.cookies;
    //
    if (isRest || isWebApi) {
      session.request.protocol = req.protocol;
      session.request.host = req.get("host");
      session.request.url = req.url;
      session.request.method = req.method;
      session.request.headers = req.headers;
      if (isWebApi)
        session.request.class = req.params.cls;
    }
    //
    if (params) {
      let parr = Object.keys(params);
      for (let i = 0; i < parr.length; i++)
        session.request[parr[i]] = params[parr[i]];
    }
    //
    // Start the right request
    if (isRest || isWebApi) {
      session.startRest(req, res);
      //
      // Restore "original" request
      // (this is necessary if a REST request has been executed on a normal session)
      session.request = oldreq;
    }
    else
      session.createAppClient(req, res);
  }
};


/*
 * Init AuthToken timer
 */
Node.Config.prototype.initTokenTimer = function ()
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
};


/**
 * Sends the current server status
 * @param {Object} params
 */
Node.Config.prototype.sendStatus = async function (params)
{
  // Send the current server status (skip class name and users)
  let result = this.save();
  delete result.cl;
  delete result.users;
  //
  // Remove "sensitive data"
  delete result.configGCloudStorage;
  delete result.dbPassword;
  delete result.googleAPIKey;
  //
  // Add server info
  let srvFile = Node.path.resolve(__dirname, "..", "server.js");
  result.serverInfo = {
    version: this.server.version,
    startTime: this.server.startTime,
    pid: process.pid,
    lastWrite: Node.fs.statSync(srvFile).mtime,
    dockerName: process.env["DOCKER_NAME"]
  };
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
      throw new Error(`Error getting the disk size: ${err}`);
    }
    //
    stdout = stdout.split("\n")[1];   // Remove headers
    stdout = stdout.split(/\s+/);     // Split spaces
    //
    if (!/^win/.test(process.platform) && !/^darwin/.test(process.platform)) {    // linux (not windows and not darwin/mac)
      result.serverInfo.disk = {size: stdout[1], used: stdout[2], available: stdout[3], capacity: stdout[4]};
      result.serverInfo.time = {date: new Date()};
      //
      // Add more info (TOP)
      try {
        result.serverInfo.top = await this.server.execFileAsRoot("/usr/bin/top", ["-b", "-n", "1"]);
      }
      catch (err) {
        throw new Error(`Error getting the CPU load and memory status: ${err}`);
      }
      //
      // Finally, get CPU load
      let cpuLoad = await Node.Utils.getCPUload();
      result.serverInfo.globalCpuLoad = cpuLoad;
    }
    else {  // windows
      result.serverInfo.disk = {
        size: stdout[1] / 1024,
        available: stdout[0] / 1024
      };
      result.serverInfo.disk.used = result.serverInfo.disk.size - result.serverInfo.disk.available;
      result.serverInfo.disk.capacity = `${Math.ceil(result.serverInfo.disk.used / result.serverInfo.disk.size * 100)}%`;
    }
    //
    // If FULL mode -> add all other infos
    if (params.req.query.full) {
      delete params.req.query.full;   // I don't want following commands to send FULL info
      //
      // IDE sessions list
      result.sessions = JSON.parse(this.sendSessionsList(params).msg);
      //
      // Users list
      // If there are no users it means that this is a PROD server -> add MANAGER
      let userList = JSON.parse(this.sendUsersList(params).msg);
      if (userList.length === 0)
        userList.push("manager");
      //
      result.users = [];
      for (let u of userList) {
        let user = this.getUser(u);
        let userInfo = {userName: user.userName};
        //
        // For each user: get app sessions, apps, databases, projects
        let res = await user.sendAppSessions(params);
        if (user.userName === "manager")
          userInfo.appsessions = JSON.parse(res.msg);
        //
        res = await user.sendAppsList(params);
        if (user.userName === "manager")
          userInfo.apps = JSON.parse(res.msg);
        //
        res = await user.sendDatabasesList(params);
        userInfo.databases = JSON.parse(res.msg);
        //
        res = user.sendProjectsList(params);
        if (user.userName !== "manager")
          userInfo.projects = JSON.parse(res.msg);
        //
        result.users.push(userInfo);
      }
    }
    //
    return {msg: JSON.stringify(result)};
  }
  catch (err) {
    this.logger.log("ERROR", err.message || err, "Config.sendStatus");
    throw err;
  }
};


/**
 * Change the server configuration via web commands
 * @param {Object} params
 */
Node.Config.prototype.configureServer = async function (params)
{
  let logData;
  try {
    // Compute the array of properties provided via url
    let query = params.req.query;
    let queryProps = Object.getOwnPropertyNames(query);
    if (queryProps.length === 0)
      throw new Error("No property specified");
    //
    // Apply the change
    if (query.name)
      this.name = query.name;
    if (query.domain)
      this.domain = query.domain;
    if (query.protocol)
      this.protocol = query.protocol;
    if (query.alias)
      this.alias = query.alias;
    if (query.serverType)
      this.serverType = query.serverType;
    if (query.portHttp)
      this.portHttp = parseInt(query.portHttp, 10);
    if (query.portHttps)
      this.portHttps = parseInt(query.portHttps, 10);
    if (query.directory)
      this.directory = query.directory;
    if (query.auth) {
      if (query.auth === "false")
        this.auth = false;
      else if (query.auth === "true")
        this.auth = true;
    }
    if (query.editPrjToken) {
      if (query.editPrjToken === "false")
        this.editPrjToken = false;
      else if (query.editPrjToken === "true")
        this.editPrjToken = true;
    }
    if (query.consoleURL !== undefined)
      this.consoleURL = query.consoleURL || undefined;
    if (query.exitUrl !== undefined)
      this.exitUrl = query.exitUrl || undefined;
    if (query.configS3)
      this.configS3 = JSON.parse(query.configS3);
    if (query.bucketS3)
      this.bucketS3 = query.bucketS3;
    if (query.configGCloudStorage)
      this.configGCloudStorage = JSON.parse(query.configGCloudStorage);
    if (query.bucketGCloud)
      this.bucketGCloud = query.bucketGCloud;
    if (query.nigthlybucketGCloud !== undefined)
      this.nigthlybucketGCloud = query.nigthlybucketGCloud || undefined;
    if (query.storage)
      this.storage = query.storage;
    if (query.dbPort)
      this.dbPort = parseInt(query.dbPort, 10);
    if (query.dbAddress)
      this.dbAddress = query.dbAddress;
    if (query.dbUser)
      this.dbUser = query.dbUser;
    if (query.dbPassword)
      this.dbPassword = query.dbPassword;
    if (query.googleAPIKey)
      this.googleAPIKey = query.googleAPIKey;
    if (query.timerSession)
      this.timerSession = parseInt(query.timerSession, 10);
    if (query.timerTokenConsole)
      this.timerTokenConsole = parseInt(query.timerTokenConsole, 10);
    if (query.handleException) {
      if (query.handleException === "false")
        this.handleException = false;
      else if (query.handleException === "true")
        this.handleException = true;
    }
    if (query.minify) {
      if (query.minify === "false")
        this.minify = false;
      else if (query.minify === "true")
        this.minify = true;
    }
    if (query.timeBackup !== undefined)
      this.timeBackup = parseInt(query.timeBackup, 10) || undefined;
    if (query.daysBackups !== undefined)
      this.daysBackups = parseInt(query.daysBackups, 10) || undefined;
    if (query.numMinBackups !== undefined)
      this.numMinBackups = parseInt(query.numMinBackups, 10) || undefined;
    if (query.numHoursSnapshot !== undefined)
      this.numHoursSnapshot = parseInt(query.numHoursSnapshot, 10) || undefined;
    if (query.numMaxSnapshot !== undefined)
      this.numMaxSnapshot = parseInt(query.numMaxSnapshot, 10) || undefined;
    if (query.timeSnapshot !== undefined)
      this.timeSnapshot = parseInt(query.timeSnapshot, 10) || undefined;
    if (query.appDirectory !== undefined)
      this.appDirectory = query.appDirectory || undefined;
    if (query.defaultApp !== undefined)
      this.defaultApp = query.defaultApp || undefined;
    if (query.services !== undefined)
      this.services = query.services || undefined;
    if (query.maxAppUsers)
      this.maxAppUsers = parseInt(query.maxAppUsers, 10);
    if (query.minAppUsersPerWorker)
      this.minAppUsersPerWorker = parseInt(query.minAppUsersPerWorker, 10);
    if (query.maxAppWorkers)
      this.maxAppWorkers = parseInt(query.maxAppWorkers, 10);
    if (query.lowDiskThreshold !== undefined)
      this.lowDiskThreshold = (query.lowDiskThreshold ? parseInt(query.lowDiskThreshold, 10) || 0 : 0);
    if (query.responseHeaders !== undefined) {
      if (query.responseHeaders) {
        // Callee will send every time all headers as an array of NAME=VALUE couples
        try {
          let responseHeadersArray = JSON.parse(query.responseHeaders);
          //
          // Change from
          //    ["par1=valuePar1", "par2=valuePar2", ...]
          // to
          //    {
          //     "par1": "valuePar1",
          //     "par2": "valuePar2",
          //    }
          this.responseHeaders = {};
          for (let i = 0; i < responseHeadersArray.length; i++) {
            let head = responseHeadersArray[i].split("=");
            let headName = head[0];
            let headValue = head.slice(1).join("=");
            //
            if (headValue)
              this.responseHeaders[headName] = headValue;
            else
              delete this.responseHeaders[headName];
          }
          if (Object.keys(this.responseHeaders).length === 0)
            delete this.responseHeaders;
        }
        catch (ex) {
          logData = {newResponseHeaders: query.responseHeaders};
          throw new Error(`Can't update server's responseHeaders: ${ex.message}`);
        }
      }
      else  // No responseHeaders
        delete this.responseHeaders;
    }
    //
    if (query.params !== undefined) {
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
          let olparams = this.params || {};
          //
          this.params = {};
          for (let i = 0; i < paramsArray.length; i++) {
            let par = paramsArray[i].split("=");
            //
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
                  await app.handleChangedAppParamMsg({par: parName, old: this.params[parName], new : parValue}, true);   // SkipSave
              }
            }
            //
            this.params[parName] = parValue;
          }
        }
        catch (ex) {
          logData = {newParams: query.params};
          throw new Error(`Can't update server's parameters: ${ex.message}`);
        }
      }
      else  // No parameters
        delete this.params;
    }
    if (query.debug2log !== undefined) {
      if (query.debug2log === "false")
        this.logger.debug2log = false;
      else if (query.debug2log === "true")
        this.logger.debug2log = true;
    }
    if (query.customPackages !== undefined) {
      // If given
      let oldcustomPackages = this.customPackages;
      if (query.customPackages) {
        try {
          //  module1@1.0.0,module2@1.0.0,
          this.customPackages = JSON.parse(`["${query.customPackages.replace(/,/g, "\",\"")}"]`);
        }
        catch (ex) {
          logData = {customPackages: query.customPackages};
          throw new Error(`Wrong customPackages parameter: ${ex.message}`);
        }
      }
      else  // No customPackages
        delete this.customPackages;
      //
      // Update package.json (if needed)
      try {
        await this.updatePackageJson(oldcustomPackages, this.customPackages);
      }
      catch (err) {
        logData = {customPackages: query.customPackages};
        throw new Error(`Error while updating package.json file: ${err}`);
      }
    }
    //
    // Save the new configuration
    this.saveConfig();
    //
    // Log the operation
    this.logger.log("DEBUG", "Updated server configuration", "Config.configureServer", {config: query});
    //
    // If something changed, restart services
    if (query.numHoursSnapshot !== undefined || query.numMaxSnapshot !== undefined || query.timeSnapshot !== undefined)
      this.server.backupDisk();
    if (query.consoleURL !== undefined || query.timerTokenConsole)
      this.initTokenTimer();
    if ((query.services || "").split(",").includes("track"))
      await this.initTracking();
  }
  catch (err) {
    this.logger.log("WARN", err.message || err, "Config.configureServer", logData);
    throw err;
  }
};


/**
 * Send the list of all users on this server
 * @param {Object} params
 */
Node.Config.prototype.sendUsersList = function (params)
{
  let users = [];
  for (let user of this.users) {
    if (user.userName === "manager")
      continue;   // Skip MANAGER user
    //
    users.push(user.userName);
  }
  //
  return {msg: JSON.stringify(users)};
};


/**
 * Send the list of all online sessions
 * @param {Object} params
 */
Node.Config.prototype.sendSessionsList = function (params)
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
      nClients: sess.countClients()
    });
  }
  //
  return {msg: JSON.stringify(sessions)};
};


/**
 * Resfresh AuthToken and send it to console
 * @param {Object} params
 */
Node.Config.prototype.refresh = async function (params)
{
  // If I don't need to communicate with the console, do nothing
  if (!this.consoleURL)
    throw new Error("ConsoleURL not set: token not sent");
  //
  // Send the new token to console
  await this.server.request.sendTokenToConsole();
};


/**
 * Handle the log/console.out/console.error files
 * @param {Object} params
 */
Node.Config.prototype.handleLog = async function (params)
{
  let maxLen = 50 * 1024 * 1024;
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
  // Compute filename
  let path = Node.path.resolve(__dirname, "..", "..", "log");
  let date = params.req.query.date || (new Date()).toISOString().substring(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return {err: "Invalid date format"};
  let filename = `${date}.log`;
  //
  let logData;
  try {
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
          logData = {console: params.req.query.console};
          throw new Error("Wrong parameter");
      }
    }
    //
    // Handle commands
    let command = (params.tokens[1] || "download");
    switch (command) {
      case "status": {
        let stats;
        try {
          stats = await Node.fs.promises.stat(Node.path.join(path, filename));
        }
        catch (err) {
          if (err.code !== "ENOENT")
            throw new Error(`Error getting the file ${filename} status: ${err}`);
        }
        //
        // If .1 file exists, add that file as well
        try {
          let stats1 = await Node.fs.promises.stat(Node.path.join(path, `${filename}.1`));
          if (stats1)
            stats.size += stats1.size;
        }
        catch (err) {
          if (err.code !== "ENOENT")
            throw new Error(`Error getting the file ${filename}.1 status: ${err}`);
        }
        //
        // Report file size
        return {msg: {size: stats.size}};
      }

      case "clear":
        // Can't clear server LOG
        if (!filename.startsWith("console.")) {
          logData = {filename};
          throw new Error("Can't clear server LOG");
        }
        //
        // Empty the file (don't delete it otherwise PM2 will not create it again)
        try {
          await this.server.execFileAsRoot("/usr/bin/truncate", ["-s0", Node.path.join(path, filename)]);
        }
        catch (err) {
          throw new Error(`Can't clear file ${filename}: ${err}`);
        }
        //
        // Remove .1 if exists
        try {
          await Node.fs.promises.rm(Node.path.join(path, `${filename}.1`), {force: true});
        }
        catch (err) {
          throw new Error(`Error removing the ${filename}.1: ${err}`);
        }
        break;

      case "view":
      case "download": {
        // Send file to client
        let data;
        try {
          data = await Node.fs.promises.readFile(Node.path.join(path, filename));
        }
        catch (err) {
          throw new Error(`Error reading the file ${filename}: ${err}`);
        }
        //
        // Send file to client
        try {
          let data1 = await Node.fs.promises.readFile(Node.path.join(path, `${filename}.1`));
          if (data1)
            data = data1 + data;
        }
        catch (err) {
          if (err.code !== "ENOENT") {
            throw new Error(`Error reading the file ${filename}.1: ${err}`);
          }
        }
        //
        // If the user requested to view the file, don't force the download
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
        //
        // Done (don't reply, I've done it)
        return {skipReply: true};
      }

      case "checkrotate": {
        if (!filename.startsWith("console.")) {
          logData = {filename};
          throw new Error("Can't rotate server LOG");
        }
        //
        // Send file to client
        let rotateStats;
        try {
          rotateStats = await Node.fs.promises.stat(Node.path.join(path, filename));
        }
        catch (err) {
          throw new Error(`Error reading the file ${filename}: ${err}`);
        }
        //
        // If bigger than maxLen -> rotate!
        if (rotateStats.size > maxLen) {
          // Remove .1 if exists
          try {
            await Node.fs.promises.rm(Node.path.join(path, `${filename}.1`), {force: true});
          }
          catch (err) {
            throw new Error(`Error removing the ${filename}.1: ${err}`);
          }
          //
          // Copy console to console.1 (copy only last maxLen portion)
          let data;
          try {
            data = await Node.fs.promises.readFile(Node.path.join(path, filename), "utf8");
          }
          catch (err) {
            throw new Error(`Error reading the file ${filename}: ${err}`);
          }
          //
          try {
            await Node.fs.promises.writeFile(Node.path.join(path, `${filename}.1`), data.slice(-maxLen));
          }
          catch (err) {
            throw new Error(`Error copying the ${filename} to .1: ${err}`);
          }
          //
          // Empty the file (don't delete it otherwise PM2 will not create it again)
          try {
            await this.server.execFileAsRoot("/usr/bin/truncate", ["-s0", Node.path.join(path, filename)]);
          }
          catch (err) {
            throw new Error(`Can't clear file ${filename}: ${err}`);
          }
        }
        break;
      }

      default:
        logData = {cmd: command, url: params.req.originalUrl};
        throw new Error("Invalid Command");
    }
  }
  catch (err) {
    this.logger.log("WARN", err.message || err, "Config.handleLog", logData);
    throw err;
  }
};


/**
 * Sends a message to every session
 * @param {Object} params
 */
Node.Config.prototype.sendMessage = function (params)
{
  let txt = decodeURIComponent(params.req.query.txt ||
          "Il server sarà aggiornato tra 5 minuti. Salvare e chiudere la sessione di lavoro<br/><br/>\
     The server will be updated in 5 minutes. Please save and leave the session");
  //
  let tot = 0;
  let keys = Object.keys(this.server.IDESessions);
  for (let i = 0; i < keys.length; i++) {
    let sess = this.server.IDESessions[keys[i]];
    //
    // If I want to send a message to a single session and this is not the
    // right one, skip it
    if (params.req.query.sid && sess.id !== params.req.query.sid)
      continue;
    //
    let message = {
      type: params.req.query.type,
      text: txt,
      style: (params.req.query.style || "alert")
    };
    if (message.type === "telecollaboration") {
      message.acceptLink = params.req.query.acceptLink;
      message.refuseLink = params.req.query.refuseLink;
    }
    sess.sendToChild({
      type: Node.Config.msgTypeMap.notify,
      cnt: message
    });
    tot++;
  }
  //
  let safeTxt = txt.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return {msg: `Text: '${safeTxt}'<br/><br/>Total sessions: ${keys.length}<br/><br/>Notified sessions: ${tot}`};
};


/**
 * Update the server
 * @param {Object} params
 */
Node.Config.prototype.update = async function (params)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Configure certificates
 * @param {Object} params
 */
Node.Config.prototype.configureCert = async function (params)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Check if the data-disk must be size-adjusted
 * @param {Object} params
 */
Node.Config.prototype.checkDataDisk = async function (params)
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
        throw new Error(`Error while computing SCSI device id: ${err}`);
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
        throw new Error(`Error while reprobing disk size: ${err}`);
      }
      //
      // Get current part status (da1 is /mnt/disk)
      try {
        stdout = await this.server.execFileAsRoot("/sbin/gpart", ["show", "da1"]);
      }
      catch (err) {
        throw new Error(`Error while executing GPART: ${err}`);
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
        throw new Error(`Error while executing GPART RECOVER: ${err}`);
      }
      //
      // Out from the box you cannot write to MBR of disk, which is the one FreeBSD boots from.
      // After setting sysctl kern.geom.debugflags=16 I get allowed to shoot in the foot and write to MBR.
      try {
        await this.server.execFileAsRoot("/sbin/sysctl", ["kern.geom.debugflags=16"]);
      }
      catch (err) {
        throw new Error(`Error while executing SYSCTL=16: ${err}`);
      }
      //
      // Resize partition to fill up all the free space
      try {
        await this.server.execFileAsRoot("/sbin/gpart", ["resize", "-i", "1", "da1"]);
      }
      catch (err) {
        throw new Error(`Error while executing GPART RESIZE: ${err}`);
      }
      //
      // Resize file system and fill up the partition (quiet mode!!!)
      try {
        await this.server.execFileAsRoot("/sbin/growfs", ["-y", "/dev/da1p1"]);
      }
      catch (err) {
        throw new Error(`Error while executing GROWFS: ${err}`);
      }
      //
      // Restore flag
      try {
        await this.server.execFileAsRoot("/sbin/sysctl", ["kern.geom.debugflags=0"]);
      }
      catch (err) {
        throw new Error(`Error while executing SYSCTL=0: ${err}`);
      }
      //
      this.logger.log("INFO", "Data disk fixed", "Config.checkDataDisk");
      return {msg: `Fixed to ${disk.designSize}`, code: 200};
    }
    else if (process.platform === "linux") {
      let stdout;
      try {
        stdout = await this.server.execFileAsRoot("/usr/sbin/parted", ["-m", "/dev/sdb", "print"]);
      }
      catch (err) {
        throw new Error(`Error while executing PARTED: ${err}`);
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
        throw new Error(`Error while executing RESIZE2FS: ${err}`);
      }
      //
      // Done!
      this.logger.log("INFO", "Data disk fixed", "Config.checkDataDisk");
      return {msg: `Fixed to ${disk.designSize}`, code: 200};
    }
    else
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
  catch (err) {
    this.logger.log("ERROR", err.message || err, "Config.checkDataDisk", disk);
    throw err;
  }
};


/**
 * Backup all projects
 * @param {Object} params
 */
Node.Config.prototype.backupProjects = async function (params)
{
  // Compute when the automatic backup was performed and get all projects that have been modified since then
  let saveLimit;
  if (params.req.query.fromDate)
    saveLimit = new Date(params.req.query.fromDate);  // If a date was provided, use it
  else if (!this.nigthlybucketGCloud || !this.daysBackups || !this.numMinBackups) {
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
        throw new Error(`Can't backup project ${prj.user.userName}/${prj.name}: ${err}`);
      }
      //
      try {
        await this.cleanProjectBucket(prj);
      }
      catch (err) {
        logData = {user: prj.user.userName, project: prj.name};
        throw new Error(`Can't clean up project's bucket: ${err}`);
      }
    }
  }
  catch (err) {
    this.logger.log(warning ? "WARN" : "ERROR", err.message || err, "Config.backupProjects", logData);
    throw err;
  }
};


/**
 * Clean bucket for a project
 * @param {Project} prj
 */
Node.Config.prototype.cleanProjectBucket = async function (prj)
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
    throw new Error(`Can't enumerate files: ${err}`);
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
    // where [date] is in the ISO form without "-:T.Z" (thus YYYYMMDDHHMMSSmmm - see Node.Project.prototype.backup)
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
        throw new Error(`Error removing file ${file} from the project backup bucket: ${err}`);
      }
    }
  }
};


/**
 * Handle safe snapshot disk creation
 * @param {Object} params
 */
Node.Config.prototype.handleSnapshot = async function (params)
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
      case "start": {
        try {
          // Flush data to disk
          await this.server.execFileAsRoot("/bin/sync", []);
        }
        catch (err) {
          throw new Error(`Error while executing SYNC: ${err}`);
        }
        //
        // Stop writing to disk
        try {
          await this.server.execFileAsRoot("/sbin/fsfreeze", ["-f", "/mnt/disk"]);
        }
        catch (err) {
          throw new Error (`Error while executing FSFREEZE: ${err}`);
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
        break;
      }
    
      case "end": {
        // Resume writing to disk
        try {
          await this.server.execFileAsRoot("/sbin/fsfreeze", ["-u", "/mnt/disk"]);
          //
          // Done!
          this.logger.log("INFO", "Disk unfreezed -> write allowed", "Config.handleSnapshot", {url: params.req.originalUrl});
        }
        catch (err) {
          throw new Error(`Error while executing FSFREEZE: ${err}`);
        }
        break;
      }

      default: {
        warning = true;
        logData = {op, url: params.req.originalUrl};
        throw new Error("Invalid operation");
      }
    }
  }
  catch (err) {
    this.logger.log(warning ? "WARN" : "ERROR", err.message || err, "Config.handleSnapshot", logData);
    throw err;
  }
};


/**
 * Initialize tracking
 */
Node.Config.prototype.initTracking = async function ()
{
  // If tracking is not active, do nothing
  if (!(this.services || "").split(",").includes("track"))
    return;
  //
  let Postgres = require("../../ide/app/server/postgres");
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
    throw new Error(msg);
  }
};


/**
 * Process an URL command
 * @param {Request} req
 * @param {Response} res
 */
Node.Config.prototype.processCommand = async function (req, res)
{
  // Handle only GET or POST
  if (req.method !== "POST" && req.method !== "GET")
    return req.next();
  //
  // Tokenize URL
  let params = {tokens: req.originalUrl.substring(1).split("?")[0].split("/")};
  //
  // Add REQ and RES to params object
  params.req = req;
  params.res = res;
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
      if (!res.answered && !res.headersSent) {
        res.status(200).send("OK");
        res.answered = true;
      }
    });
  //
  let result;
  try {
    // If the authorization key is enabled and the given one does not match -> error
    // (do it only for "CREATE", "RESTORE" and "DELETE" commands 'cause other commands will handle it where it's needed)
    if (this.auth && params.req.query.autk !== this.autk && ["create", "restore", "delete"].includes(command)) {
      this.logger.log("WARN", "Unauthorized", "Config.execCommand", {url: params.req.originalUrl});
      throw {err: "Unauthorized", code: 401};
    }
    //
    // Handle user commands
    // (http://servername/username/command)
    switch (command) {
      case "create":
        result = await this.createUser(userName);
        break;

      case "restore": {
        result = await this.createUser(userName);
        let user = this.getUser(userName);
        try {
          await user.processCommand(params);
        }
        catch (err) {
          // If error -> delete user
          await this.deleteUser(userName).catch(() => {});
          result = err;
        }
        break;
      }

      case "delete":
        result = await this.deleteUser(userName);
        break;

      default: {
        let user = this.getUser(userName);
        if (!user)
          return req.next();
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
    if (err.err)
      result = err;
    else
      result = {err: err.message || err};
  }
  //
  result = result || {};    // Default: everything is fine
  //
  // Handle RID if given (not for Unauthorized... that should go out immediately on the main output stream)
  if (params.req.query.rid && result.code !== 401) {
    if (result.err)
      this.server.request.sendResponse(params.req.query.rid, result.code || 500, result.err);
    else
      this.server.request.sendResponse(params.req.query.rid, 200, result.msg || "OK");
  }
  else if (!result.skipReply) { // No RID -> answer (unless don't needed)
    if (result.err)
      res.status(result.code || 500).send(result.err);
    else
      res.status(200).send(result.msg || "OK");
    //
    // I've answered the callee
    res.answered = true;
  }
  //
  this.logger.log("DEBUG", "Operation completed", "Config.processCommand",
          {result, url: req.originalUrl, host: req.socket.remoteAddress});
};


/**
 * Execute commands for the server
 * @param {Object} params
 */
Node.Config.prototype.execCommand = async function (params)
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
  // If the authorization key is enabled and the given one does not match -> error
  if (!skipAutk && this.auth && params.req.query.autk !== this.autk) {
    this.logger.log("WARN", "Unauthorized", "Config.execCommand", {url: params.req.originalUrl});
    throw {err: "Unauthorized", code: 401};
  }
  //
  // I'm here if AUTK is not enabled or if the given one matches
  switch (command) {
    case "geturl":
      return await this.getUrlData(params);

    case "getavalic":
      return await this.getAvaLic(params);

    case "getlic":
      return this.getLic(params);

    case "setlic":
      return await this.setLic(params);

    case "checklic":
      return await this.checkLicense(true);

    case "getopt":
      return this.getOpt(params);

    case "setopt":
      return await this.setOpt(params);

    case "getappdata":
      return await this.getAppData(params);

    case "setappdata":
      return await this.setAppData(params);

    case "status":
      return await this.sendStatus(params);

    case "config":
      return await this.configureServer(params);

    case "users":
      return this.sendUsersList(params);

    case "sessions":
      return this.sendSessionsList(params);

    case "refresh":
      return await this.refresh(params);

    case "log":
      return await this.handleLog(params);

    case "message":
      return this.sendMessage(params);

    case "cert":
      return await this.configureCert(params);

    case "update":
      return await this.update(params);

    case "reboot":
      this.server.childer.send({
        type: Node.Config.msgTypeMap.execCmd,
        cmd: "reboot"
      });
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
};


/**
 * Get license data
 */
Node.Config.prototype.getLic = function (params)
{
  console.error("NOT SUPPORTED FOR SELF");
};



/**
 * Get license data
 */
Node.Config.prototype.getAvaLic = async function (params)
{
  console.error("NOT SUPPORTED FOR SELF");
};



/**
 * Set license data
 * Updates the license information and propagates it to all active IDE sessions
 */
Node.Config.prototype.setLic = async function (params)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Get url bypassing CORS (used by ActiveX wizard to fetch external resources)
 */
Node.Config.prototype.getUrlData = async function (params)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Get options data
 */
Node.Config.prototype.getOpt = function (params)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Set options data
 */
Node.Config.prototype.setOpt = async function (params)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Get application data
 */
Node.Config.prototype.getAppData = async function (params)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Set application data
 */
Node.Config.prototype.setAppData = async function (params)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Send data to the license server
 */
Node.Config.prototype.sendToLicServer = async function (operation, data, format = "json")
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Calculate the system GUID, caching first calculated value stored in this.pcguid.
 */
Node.Config.prototype.generateSystemGUID = function ()
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Calculate the mac address of the main network card
 */
Node.Config.prototype.getPrimaryMacAddress = function ()
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Calculate current date time
 */
Node.Config.prototype.getCurrentDateTime = function ()
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Calculate operating system info
 */
Node.Config.prototype.getOSInfo = function ()
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * IDFJS version
 */
Node.Config.prototype.getIndeVersion = function ()
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * IDFJS user returns
 */
Node.Config.prototype.getIdfUser = function ()
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Check if the license server is accessible
 */
Node.Config.prototype.licSrvCheckConnection = async function ()
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Create or update a user's data
 * @param {User} user
 */
Node.Config.prototype.licSrvUpdateUser = async function (user)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Create/update installation
 */
Node.Config.prototype.licSrvUpdateInde = async function ()
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Retrieve the list of available licenses
 */
Node.Config.prototype.licSrvGetLicList = async function ()
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Associate a license with this installation
 * @param {Object} lic
 */
Node.Config.prototype.licSrvGetLicense = async function (lic)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Release the license for this installation
 */
Node.Config.prototype.licSrvReleaseLicense = async function ()
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Release the license for this installation
 */
Node.Config.prototype.licSrvUninstall = async function ()
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Check the license for IDF.JS
 * @param {Boolean} force
 */
Node.Config.prototype.checkLicense = async function (force = false)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * @param {Request} req
 * @param {Response} res
 */
Node.Config.prototype.sendFirstPage = async function (req, res)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Opens the given project folder in the system file explorer.
 * Available only on a locally-running server (IDS desktop/local); refused on cloud servers.
 * The path must be within the user's Instant Developer home directory.
 * @param {Object} params - Request parameters
 * @param {String} params.req.query.path - Absolute path of the folder to open
 * @returns {Promise<String>} "OK" if launched successfully
 */
Node.Config.prototype.openPrjFolder = async function (params)
{
  if (!this.local)
    throw Object.assign(new Error("Only available on local servers"), {code: 403});
  //
  let reqPath = params.req.query.path;
  if (!reqPath)
    throw new Error("Missing 'path' parameter");
  //
  // Resolve and confine to the user's home folder to avoid opening arbitrary system paths
  let target = Node.path.resolve(reqPath);
  let home = Node.path.resolve(this.directory);
  if (target !== home && !target.startsWith(home + Node.path.sep))
    throw new Error("Path is outside the allowed directory");
  //
  let cmd = process.platform === "win32" ? "explorer.exe" :
            process.platform === "darwin" ? "open" : "xdg-open";
  Node.child.spawn(cmd, [target], {detached: true, stdio: "ignore"}).unref();
  //
  return "OK";
};


/**
 * Check if a specific product/module is active in the license
 * @param {Number} productFlag - Product flag (e.g., 0x0200 for TeamWorks)
 * @returns {Boolean} - True if the product is active
 */
Node.Config.prototype.isProductActive = function (productFlag)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Initialize browser paths by detecting installed browsers on the system
 * Detects installed browsers (IE, Firefox, Safari, Chrome, Edge) and determines the default browser
 * Supports Windows, macOS, and Linux platforms
 */
Node.Config.prototype.initBrowserPath = async function()
{
  if (!this.idfoptions || this.idfoptions.SelBrowser)
    return;
  //
  let os = require("os");
  let fs = require("fs").promises;
  let {exec} = require("child_process");
  let util = require("util");
  let execAsync = util.promisify(exec);
  //
  let platform = os.platform();
  let defBrowser = "";
  //
  // Helper function to check if file exists
  let fileExists = async filePath => {
    try {
      await fs.access(filePath);
      return true;
    }
    catch {
      return false;
    }
  };
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
    if (await fileExists(firefoxPath))
      this.idfoptions.FfxPath = firefoxPath;
    //
    let safariPath = "/Applications/Safari.app/Contents/MacOS/Safari";
    if (await fileExists(safariPath))
      this.idfoptions.SafariPath = safariPath;
    //
    let chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (await fileExists(chromePath))
      this.idfoptions.ChromePath = chromePath;
    //
    let edgePath = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    if (await fileExists(edgePath))
      this.idfoptions.EdgePath = edgePath;
    //
    // Get default browser on macOS
    try {
      let {stdout: bundleId} = await execAsync("plutil -convert json -o - ~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist | jq -r '.LSHandlers[] | select(.LSHandlerURLScheme == \"https\") | .LSHandlerRoleAll' | head -1");
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
      if (await fileExists(p)) {
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
      if (await fileExists(p)) {
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
      if (await fileExists(p)) {
        this.idfoptions.EdgePath = p;
        break;
      }
    }
    //
    // Get default browser on Linux
    try {
      let {stdout} = await execAsync("xdg-settings get default-web-browser");
      defBrowser = stdout.trim().toUpperCase();
    }
    catch {
      // Try alternative method
      try {
        let {stdout} = await execAsync("update-alternatives --query x-www-browser | grep Value | awk '{print $2}'");
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
};


// Export module
module.exports = Node.Config;
