/*
 * Instant Developer Next
 * Copyright Pro Gamma Spa 2000-2016
 * All rights reserved
 */
/* global require, module, process, __dirname */

var Node = Node || {};

// Import Modules
Node.fs = require("fs");
Node.ncp = require("../ncp_fixed");
Node.rimraf = require("rimraf");
Node.multiparty = require("multiparty");
Node.path = require("path");
Node.child = require("child_process");

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
};


Node.Config.msgTypeMap = {
  notify: "n",
  execCmd: "excmd"
};


// Define usefull properties for this object
Object.defineProperties(Node.Config.prototype, {
  server: {
    get: function () {
      return this.parent;
    }
  },
  logger: {
    get: function () {
      return this.server.logger;
    }
  }
});


/**
 * Save the object
 */
Node.Config.prototype.save = function ()
{
  var r = {cl: "Node.Config", name: this.name, domain: this.domain, protocol: this.protocol, alias: this.alias,
    serverType: this.serverType, portHttp: this.portHttp, portHttps: this.portHttps,
    SSLCert: this.SSLCert, SSLKey: this.SSLKey, SSLCABundles: this.SSLCABundles, customSSLCerts: this.customSSLCerts,
    directory: this.directory, auth: this.auth, editPrjToken: this.editPrjToken,
    consoleURL: this.consoleURL, configS3: this.configS3, bucketS3: this.bucketS3,
    configGCloudStorage: this.configGCloudStorage, bucketGCloud: this.bucketGCloud,
    nigthlybucketGCloud: this.nigthlybucketGCloud, storage: this.storage, customPackages: this.customPackages,
    dbPort: this.dbPort, dbAddress: this.dbAddress, dbUser: this.dbUser, dbPassword: this.dbPassword,
    googleAPIKey: this.googleAPIKey, timerSession: this.timerSession,
    timerTokenConsole: this.timerTokenConsole, handleException: this.handleException, minify: this.minify,
    timeBackup: this.timeBackup, daysBackups: this.daysBackups, numMinBackups: this.numMinBackups,
    numHoursSnapshot: this.numHoursSnapshot, numMaxSnapshot: this.numMaxSnapshot, timeSnapshot: this.timeSnapshot,
    appDirectory: this.appDirectory, defaultApp: this.defaultApp, services: this.services,
    maxAppUsers: this.maxAppUsers, minAppUsersPerWorker: this.minAppUsersPerWorker, maxAppWorkers: this.maxAppWorkers,
    users: this.users
  };
  return r;
};


/**
 * Load the object
 * @param {Object} v - the object that contains my data
 */
Node.Config.prototype.load = function (v)   /*jshint maxcomplexity:100 */
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
  if (v.local)
    this.local = true;
};


/**
 * Save the object's properties (i.e. no children objects)
 */
Node.Config.prototype.saveProperties = function ()
{
  var r = this.save();
  //
  // Delete children
  delete r.cl;
  delete r.users;
  //
  // Add usefull properties
  r.url = this.getUrl();
  r.local = this.local;
  r.version = this.server.version;
  r.remoteDBurls = this.getRemoteDBUrls();
  //
  return r;
};


/**
 * Return a map of all remote DB urls (name -> remoteUrl)
 */
Node.Config.prototype.getRemoteDBUrls = function ()
{
  var remoteDBurls;
  for (var i = 0; i < (this.users || []).length; i++)
    for (var j = 0; j < (this.users[i].databases || []).length; j++) {
      var db = this.users[i].databases[j];
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
Node.Config.prototype.saveConfig = function ()
{
  var pthis = this;
  //
  var configFile;
  if (this.local)
    configFile = Node.path.resolve(__dirname + "/../") + "/";
  else
    configFile = Node.path.resolve(__dirname + "/../../../config") + "/";
  configFile += "config.json";
  //
  // This method is called in several points and it's asynchronous, thus we can have problems
  // if two different clients calls this method in the same time.... better protect multiple calls
  if (this.savingConf) {
    // I'm already saving the config file... procrastinate
    setTimeout(function () {
      pthis.saveConfig();
    }, 100);
    //
    return;
  }
  //
  this.savingConf = true;   // Start save
  var docjson = JSON.stringify(this, function (k, v) {
    if (v instanceof Node.Config || v instanceof Node.User || v instanceof Node.Database || v instanceof Node.Project || v instanceof Node.App)
      return v.save();
    else
      return v;
  });
  //
  // Remove the old BACK if present
  Node.rimraf(configFile + ".bak", function (err) {
    if (err) {
      delete pthis.savingConf;  // End save
      return pthis.logger.log("ERROR", "Error removing the old CONFIG file " + configFile + ".bak: " + err, "Config.saveConfig");
    }
    //
    // Backup the the config file into a .bak file
    Node.fs.rename(configFile, configFile + ".bak", function (err) {
      if (err) {
        delete pthis.savingConf;  // End save
        return pthis.logger.log("ERROR", "Error renaming the CONFIG file " + configFile + " to " + configFile + ".bak: " + err, "Config.saveConfig");
      }
      //
      // Write the config file
      Node.fs.writeFile(configFile, docjson, {mode: 0600}, function (err) {     // Owner RW only
        if (err) {
          delete pthis.savingConf;  // End save
          return pthis.logger.log("ERROR", "Error saving the CONFIG file " + configFile + ": " + err, "Config.saveConfig");
        }
        //
        delete pthis.savingConf;  // End save
        pthis.logger.log("DEBUG", "Config file saved with success", "Config.saveConfig");
      });
    });
  });
};


/**
 * Read the JSON of the configuration from the file config.json
 */
Node.Config.prototype.loadConfig = function ()
{
  var pthis = this;
  //
  var configFile;
  if (this.local)
    configFile = Node.path.resolve(__dirname + "/../") + "/";
  else
    configFile = Node.path.resolve(__dirname + "/../../../config") + "/";
  configFile += "config.json";
  //
  var configTXT = Node.fs.readFileSync(configFile, {encoding: "utf8"});
  JSON.parse(configTXT, function (k, v) {
    if (v instanceof Object && v.cl !== undefined) {
      var obj;
      if (v.cl === "Node.Config")
        obj = pthis;
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
    for (var i = 0; i < this.users.length; i++)
      this.users[i].setParent(this);
};


/**
 * Check server configuration
 */
Node.Config.prototype.check = function ()
{
  var pthis = this;
  //
  // If the MANAGER user is missing, create it
  if (!this.getUser("manager")) {
    var user = new Node.User(this);
    user.userName = "manager";
    //
    // Add the new user to the list of users and save the current configuration
    this.users.push(user);
    this.saveConfig();
  }
  //
  // If there is no IDE directory, check is complete
  if (!this.directory)
    return;
  //
  // Create the home folder if needed
  Node.fs.mkdir(this.directory, function (err) {
    if (err && err.code !== "EEXIST")
      return pthis.logger.log("ERROR", "Error creating the home folder " + pthis.directory + ": " + err, "Config.check");
    //
    // Check the configuration for all the users
    // (this operation must be serialized as the OS cannot create many users at the same time)
    var checkUser = function (i) {
      if (i >= pthis.users.length)
        return;
      //
      var user = pthis.users[i++];
      user.check(function () {
        checkUser(i);
      });
    };
    //
    checkUser(0);
  });
};


/**
 * Get the server URL
 * @param {object} req - optional http request to be used to get HOST
 * @returns {String}
 */
Node.Config.prototype.getUrl = function (req)
{
  if (this.local)
    return "http://localhost:8081";                               // Return LOCAL url
  else if (req && this.getHostFromReq(req))
    return this.protocol + "://" + this.getHostFromReq(req);      // If a REQ object was given use it to get the "right" HOST
  else
    return this.protocol + "://" + this.name + "." + this.domain; // Return "design-time" url
};


/**
 * Returns a valid HOST from the given HTTP request
 * @param {object} req - http request to be used to get HOST
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
  var host = req.headers.host.toLowerCase();
  if (host.indexOf(":") !== -1)
    host = host.substring(0, host.indexOf(":"));
  //
  // If it's me use the given host
  if (host === this.name + "." + this.domain)
    return req.headers.host;
  //
  // If I've an external IP address and it's using it use the given host
  if (this.externalIP && host === this.externalIP)
    return req.headers.host;
  //
  // If I've an alias list, use it
  if (this.alias) {
    var aliases = this.alias.split(",");
    for (var i = 0; i < aliases.length; i++) {
      var al = aliases[i];
      //
      // If the alias contain the default app, clean it up
      if (al.indexOf("|") !== -1)
        al = al.substring(0, al.indexOf("|"));
      //
      // If host matches, use the given host
      if (host === al)
        return req.headers.host;
      //
      // Handle 2-level domains (*.domain.com)
      if (al.indexOf("*") !== -1 && host.indexOf(".") !== -1 &&
              host.substring(host.indexOf(".")) === al.substring(1))
        return req.headers.host;
    }
  }
};


/**
 * Return the server external IP
 * @returns {String}
 */
Node.Config.prototype.getExternalIp = function ()
{
  // If I've not yet asked, I'm not local and I'm not on windows
  if (!this.externalIP && !this.local && !/^win/.test(process.platform)) {
    // Try to ask google what's my external IP address
    var options = {
      protocol: "http:",
      hostname: "metadata.google.internal",
      headers: {"Metadata-Flavor": "Google"}
    };
    //
    options.path = "/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip";
    this.server.request.getRequest(options, function (code, extip, err) {
      if (code !== 200 || err)
        return this.logger.log("WARN", "Can't read metadata::external-ip: " + (err || "ResponseCode: " + code),
                "Config.getExternalIp", options);
      //
      // Got it!
      this.externalIP = extip;
      this.logger.log("DEBUG", "External IP: " + extip, "Config.getExternalIp");
    }.bind(this));
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
 * @param {boolean} offline - (optional) if given use offline.htm file
 */
Node.Config.prototype.getAppMainFile = function (offline)
{
  // Use INDEXLOCAL.html file if I'm on a local machine or if I'm not minifying
  var page = (offline ? "offline" : "index");
  if (this.local || !this.minify)
    page += "Local";
  //
  return "client/" + page + ".html";
};


/**
 * Find a user by name
 * @param {string} name
 * @returns {Node.User}
 */
Node.Config.prototype.getUser = function (name)
{
  for (var i = 0; i < this.users.length; i++) {
    if (this.users[i].userName === name)
      return this.users[i];
  }
};


/**
 * Create a new user
 * @param {string} userName
 * @param {function} callback (err or {err, msg, code})
 */
Node.Config.prototype.createUser = function (userName, callback)
{
  var pthis = this;
  //
  // Check if the user exists already
  if (this.getUser(userName)) {
    this.logger.log("WARN", "User already exists", "Config.createUser", {user: userName});
    return callback("User already exists");
  }
  //
  // Create and initialize a new user
  var user = new Node.User(this);
  user.init(userName, function (err) {
    if (err)
      return callback(err);
    //
    // Add the user obj to the list of users and save the current configuration
    pthis.users.push(user);
    pthis.saveConfig();
    //
    // Log the user creation
    pthis.logger.log("INFO", "User created", "Config.createUser", {user: userName});
    //
    // Done
    callback();
  });
};


/**
 * Delete an existing user
 * @param {string} userName
 * @param {function} callback (err or {err, msg, code})
 */
Node.Config.prototype.deleteUser = function (userName, callback)
{
  var pthis = this;
  //
  var user = this.getUser(userName);
  if (!user) {
    this.logger.log("WARN", "User not found", "Config.deleteUser", {user: userName});
    return callback({code: 404, msg: "User not found"});
  }
  //
  // Can't delete MANAGER user
  if (user.userName === "manager") {
    this.logger.log("WARN", "Can't delete MANAGER user", "Config.deleteUser", {user: userName});
    return callback("Can't delete MANAGER user");
  }
  //
  // Delete the user DBs
  user.deleteAllDatabases(function (err) {
    if (err)
      return callback(err);
    //
    // Delete user folder
    user.deleteUserFolder(function (err) {
      if (err)
        return callback(err);
      //
      // Delete the user from the users array
      var index = pthis.users.indexOf(user);
      pthis.users.splice(index, 1);
      //
      // Save the new configuration
      pthis.saveConfig();
      //
      // Log the user deletion
      pthis.logger.log("INFO", "User removed", "Config.deleteUser", {user: userName});
      //
      // Done
      callback();
    });
  });
};


/**
 * Updates the package.json file with customPackages property
 * @param {array} toRemove - list of modules to remove
 * @param {array} toAdd - list of modules to add
 * @param {function} callback (err)
 */
Node.Config.prototype.updatePackageJson = function (toRemove, toAdd, callback)
{
  // If there is nothing to do, return to callee
  if (!toRemove && !toAdd)
    return callback();
  //
  var packageJSONfile = __dirname + "/../../package.json";
  //
  var errorFnc = function (err) {
    this.logger.log("ERROR", err, "Config.updatePackageJson");
    callback(err);
  }.bind(this);
  //
  this.logger.log("DEBUG", "Updating Package.json file", "Config.updatePackageJson", {toRemove: toRemove, toAdd: toAdd});
  //
  // First, read package.json file
  Node.fs.readFile(packageJSONfile, function (err, data) {
    if (err)
      return errorFnc("Error reading the package.json file: " + err);
    //
    var packageJson = JSON.parse(data);
    //
    // First delete all packages to be removed (if any)
    if (toRemove)
      toRemove.forEach(function (pack) {
        delete packageJson.dependencies[pack.split("@")[0]];
      });
    //
    // Then add new packages (if any)
    if (toAdd)
      toAdd.forEach(function (pack) {
        packageJson.dependencies[pack.split("@")[0]] = pack.split("@")[1];
      });
    //
    // Remove the old BACK if present
    Node.rimraf(packageJSONfile + ".bak", function (err) {
      if (err)
        return errorFnc("Error removing the old package.json file " + packageJSONfile + ".bak: " + err);
      //
      // Backup the the config file into a .bak file
      Node.fs.rename(packageJSONfile, packageJSONfile + ".bak", function (err) {
        if (err)
          return errorFnc("Error renaming the package.json file " + packageJSONfile + " to " + packageJSONfile + ".bak: " + err);
        //
        // Save package.json file
        Node.fs.writeFile(packageJSONfile, JSON.stringify(packageJson, null, 2), {mode: 0644}, function (err) {     // RW-R-R
          if (err)
            return errorFnc("Error while saving the package.json file: " + err);
          //
          this.logger.log("DEBUG", "Package.json file saved with success", "Config.updatePackageJson");
          //
          // Last: update packages
          this.server.execFileAsRoot("UpdNodePackages", [], function (err, stdout, stderr) {   // jshint ignore:line
            if (err)
              return errorFnc("Error while updating packages: " + (stderr || err));
            //
            // Done
            this.logger.log("INFO", "Package.json and node_modules updated", "Config.updatePackageJson", {toRemove: toRemove, toAdd: toAdd});
            callback();
          }.bind(this));
        }.bind(this));
      }.bind(this));
    }.bind(this));
  }.bind(this));
};


/**
 * Process RUN command for the server
 * @param {request} req
 * @param {response} res
 */
/* jshint maxstatements:120 */
/* jshint maxcomplexity:40 */
Node.Config.prototype.processRun = function (req, res)
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
  var pthis = this;
  var sid, cid, session, i, app;
  var isIDE = (req.params.sid);     // [sid]/[appid]/run
  var isWebApi = (req.params.cls);  // [app]/[clsid] or [app]/[clsid]/*
  var isRest = (req.query && req.query.mode === "rest");
  //
  this.logger.log("DEBUG", "Handle process RUN", "Config.processRun", {url: req.originalUrl, host: req.connection.remoteAddress});
  //
  if (req.method === "OPTIONS") {
    // Accept only "OPTIONS" that comes from webAPI requests or a DROPZONE element
    // (that will send a POST with mode=rest in the query string)
    var meth = req.headers["access-control-request-method"];
    if (["GET", "POST", "DELETE", "PUT", "PATCH"].indexOf(meth) >= 0 && (isRest || isWebApi)) {
      // That good... reply with 204
      this.logger.log("DEBUG", "Valid OPTIONS request", "Config.processRun",
              {meth: req.method, url: req.originalUrl, headers: req.headers});
      //
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Headers", "Accept, Cache-Control, X-Requested-With, X-HTTP-Method, Content-Type, Prefer, Authorization");
      res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, PUT, PATCH");
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
  if ((!isWebApi && ["GET", "POST"].indexOf(req.method) === -1) ||
          (isWebApi && ["GET", "POST", "PUT", "DELETE", "PATCH"].indexOf(req.method) === -1)) {
    this.logger.log("WARN", "Request method not allowed", "Config.processRun",
            {meth: req.method, url: req.originalUrl, remoteAddress: req.connection.remoteAddress});
    return res.status(405).end("HTTP method not supported");
  }
  //
  // If the HOST is not valid, don't reply
  if (!this.getHostFromReq(req)) {
    this.logger.log("WARN", "Bad HOST", "Config.processRun",
            {meth: req.method, url: req.originalUrl, host: req.headers.host, remoteAddress: req.connection.remoteAddress});
    return res.status(500).end("Invalid HOST parameter");
  }
  //
  if (isIDE) {     // IDE
    sid = req.params.sid;
    session = this.server.IDESessions[sid];
    if (!session) {
      this.logger.log("WARN", "Session not found", "Config.processRun", {sid: sid});
      return res.status(500).send("Session not found");
    }
  }
  else {      // MASTER
    // Get the name of the user and app from the url
    var urlParts = req.originalUrl.substring(1).split("?")[0].split("/");
    if (urlParts.length && urlParts[urlParts.length - 1] === "")    // Eat last part if empty (originalUrl always ends with "/")
      urlParts.pop();
    //
    var userName, appName;
    if (urlParts.length === 0) {     // {nothing}
      // If an HOST was provided, try to see if there is a specific app for this host
      var defApp;
      if (req.headers.host && this.alias) {
        var host = req.headers.host.toLowerCase();
        if (host.indexOf(":") !== -1)
          host = host.substring(0, host.indexOf(":"));
        var aliases = this.alias.split(",");
        for (i = 0; i < aliases.length; i++) {
          var al = aliases[i];
          if (al.indexOf("|") === -1)
            continue;   // Skip aliases that have no default app
          //
          al = al.split("|");   // 0-HOST, 1-DefaultApp
          if (al[0] === host)
            defApp = al[1];
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
          res.redirect(defApp);
          return;
        }
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
      this.logger.log("WARN", "No command detected and no app to start. Redirect to www.instantdeveloper.com", "Config.processRun",
              {url: req.originalUrl});
      return res.redirect("http://www.instantdeveloper.com");
    }
    //
    // Get the user
    var user = this.getUser(userName);
    if (!user) {
      if (isWebApi)
        return req.next();
      this.logger.log("WARN", "User not found", "Config.processRun", {user: userName, app: appName, url: req.originalUrl});
      return res.status(500).send("User " + userName + " not found");
    }
    //
    // Search the app with the given name
    app = user.getApp(appName);
    if (!app) {
      if (isWebApi)
        return req.next();
      this.logger.log("WARN", "App not found", "Config.processRun", {user: userName, app: appName, url: req.originalUrl});
      return res.status(404).send("App " + appName + " not found");
    }
    //
    // If the app has been stopped
    if (app.stopped) {
      this.logger.log("WARN", "Can't start app because it's stopped", "Config.processRun", {user: userName, app: app.name});
      return res.status(503).send("App " + app.name + " stopped");
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
      var path = this.appDirectory + "/apps/" + app.name + "/client/updating.html";
      var stream = Node.fs.createReadStream(path);
      stream.on("open", function () {
        stream.pipe(res);
      });
      stream.on("end", function () {
        pthis.logger.log("DEBUG", "Updating.html sent", "Config.processRun", {user: userName, app: app.name});
      });
      stream.on("error", function (err) {
        pthis.logger.log("WARN", "Error sending the file " + path + " to an updating app: " + err, "Config.processRun",
                {user: userName, app: app.name});
      });
      return;
    }
    //
    // If the app has been started in OFFLINE mode and the app CAN be started in offline mode
    if (req.query.mode === "offline" && app.params && app.params.allowOffline) {
      this.logger.log("DEBUG", "Start app in OFFLINE mode", "Config.processRun", {user: userName, app: app.name});
      return res.redirect("/" + app.name + "/" + this.getAppMainFile(req.query.mode));
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
                {sid: sid, cid: cid, user: app.user.userName, app: app.name});
        return res.status(500).send("Invalid session");
      }
      //
      // Session exists. Now, if given, check client
      if (cid) {
        var client = session.getAppClientById(cid);
        if (!client) {
          this.logger.log("WARN", "Session client not found", "Config.processRun",
                  {sid: sid, cid: cid, user: app.user.userName, app: app.name});
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
                {sid: sid, cid: cid, user: app.user.userName, app: app.name});
      }
    }
    else {
      if (isWebApi) {
        // Try to load metadata.json file
        var metadataPath = this.appDirectory + "/apps/" + appName + "/server/webapi/metadata.json";
        if (!Node.fs.existsSync(metadataPath))
          return req.next();
        //
        // Read content of metadata.json
        var metadata = require(metadataPath);
        //
        // If metadata is required (by GET) responde with it
        if (req.params.cls === "$metadata" && req.method === "GET") {
          var serviceMetadata = require("odata-v4-service-metadata").ServiceMetadata;
          res.type("text/xml").set("OData-Version", "4.0").status(200).end(serviceMetadata.processMetadataJson(metadata).data);
          return;
        }
        //
        // Verify if cls is a good name of class with WebAPI flag
        var cls = req.params.cls.split("(")[0];
        if (!metadata.dataServices.schema.find(function (s) {
          if (!s.entityContainer)
            return false;
          //
          return s.entityContainer.entitySet.find(function (e) {
            if (e.name === cls) {
              req.params.cls = (s.namespace === appName ? "" : s.namespace + ".") + e.name;
              return true;
            }
          }) || s.entityContainer.actionImport.find(function (a) {
            if (a.name === cls) {
              req.params.cls = (s.namespace === appName ? "" : s.namespace + ".") + cls.split("__")[0];
              return true;
            }
          });
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
              {user: app.user.userName, app: appName, sid: sid, cid: cid, url: req.originalUrl});
    }
    //
    if (!isRest && !isWebApi) {
      // Create/update cookies for this session
      var expires = new Date(Date.now() + 86400000);
      res.cookie("sid", sid, {expires: expires, path: "/" + app.name});
      res.cookie("cid", cid, {expires: expires, path: "/" + app.name});
      //
      // Protects SID cookie
      session.protectSID(res, expires);
    }
  }
  //
  // Define app request callback
  var newAppReq = function (req, res, session, params) {
    var oldreq = session.request;
    session.request = {query: req.query, body: req.body};
    if (req.connection && req.connection.remoteAddress)
      session.request.remoteAddress = req.connection.remoteAddress.replace(/^.*:/, "");
    session.cookies = req.cookies;
    //
    if (isRest || isWebApi) {
      session.request.protocol = req.protocol;
      session.request.host = req.get("host");
      session.request.url = req.url;
      session.request.method = req.method;
      session.request.headers = req.headers;
      if (isWebApi) {
        if (req.params.cls.startsWith(session.app.name + "."))
          session.request.class = req.params.cls.split(".").slice(1).join(".");
        else
          session.request.class = req.params.cls;
      }
    }
    //
    if (params) {
      var parr = Object.keys(params);
      for (i = 0; i < parr.length; i++)
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
  };
  //
  // If it's a POST request
  if (req.method === "POST") {
    // Check if it's a multi-part POST
    var contentType = req.get("Content-Type");
    if (contentType && contentType.indexOf("multipart/form-data") >= 0) {
      // Multi part request. Parse it
      var form;
      if (isIDE)
        form = new Node.multiparty.Form({autoFields: true, autoFiles: true,
          uploadDir: pthis.directory + "/" + session.project.user.userName + "/" +
                  session.project.name + "/files/uploaded"});
      else
        form = new Node.multiparty.Form({autoFields: true, autoFiles: true,
          uploadDir: pthis.appDirectory + "/apps/" + app.name + "/files/uploaded"});
      form.parse(req, function (err, fields, files) {
        if (err) {
          pthis.logger.log("ERROR", "Error parsing post request: " + err, "Config.processRun");
          return res.status(400).end();
        }
        //
        // Check if the session is still there
        session = (isIDE ? pthis.server.IDESessions[sid] : pthis.server.appSessions[sid]);
        if (!session) {
          pthis.logger.log("WARN", "Session not found", "Config.processRun", {sid: sid});
          return res.status(500).send("Session not found");
        }
        //
        // Extract fields
        var fldarr = Object.keys(fields);
        for (i = 0; i < fldarr.length; i++) {
          var key = fldarr[i];
          if (fields[key].length === 1)
            fields[key] = fields[key][0];
        }
        //
        // Extract files
        var postfiles = [];
        var nOfFiles = Object.keys(files).length;
        var nOfSavedFiles = 0;
        if (nOfFiles === 0) // No files -> send to app
          newAppReq(req, res, session, {params: fields, files: postfiles});
        else {
          // There are files... rename them and send to app
          var farr = Object.keys(files);
          for (i = 0; i < farr.length; i++) {
            var k = farr[i];
            var f = files[k][0];
            var ext = f.originalFilename.split(".");
            ext = "." + ext[ext.length - 1];
            var id = Node.Utils.generateUID36();
            var path, localPath;
            if (isIDE) {    // IDE
              path = "/" + session.project.user.userName + "/" + session.project.name + "/files/uploaded/" + id + ext;
              localPath = pthis.directory + path;
            }
            else {    // MASTER
              path = "/" + app.name + "/files/uploaded/" + id + ext;
              localPath = pthis.appDirectory + "/apps" + path;
            }
            var serverPath = pthis.getUrl() + path;
            //
            // Beautify file name
            /*jshint loopfunc: true */
            Node.fs.rename(f.path, localPath, function (err) {
              if (err) {
                pthis.logger.log("ERROR", "Error moving POST file: " + err, "Config.processRun", {src: f.path, dst: localPath});
                //
                // Remove the file
                Node.fs.unlink(f.path, function (err) {
                  if (err)
                    pthis.logger.log("ERROR", "Error removing temp POST file after move failed: " + err, "Config.processRun", {src: f.path});
                });
              }
              else
                postfiles.push({path: "uploaded/" + id + ext, type: undefined, originalName: f.originalFilename, publicUrl: serverPath});
              //
              // Log operation
              pthis.logger.log("INFO", "Received file via REST request", "Config.processRun",
                      {path: "uploaded/" + id + ext, serverPath: serverPath});
              //
              nOfSavedFiles++;
              //
              // If last file, send to app
              if (nOfSavedFiles === nOfFiles)
                newAppReq(req, res, session, {params: fields, files: postfiles});
            });
          }
        }
      });
    }
    else // non-multipart post
      newAppReq(req, res, session);
  }
  else if (req.method === "GET" || (isWebApi && (req.method === "DELETE" || req.method === "PUT" || req.method === "PATCH")))
    newAppReq(req, res, session);
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
    this.intervalToken = setInterval(function () {
      this.server.request.sendTokenToConsole();
    }.bind(this), this.timerTokenConsole);
  //
  // Send token now (server startup)
  this.server.request.sendTokenToConsole();
};


/*
 * Sends the current server status
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Config.prototype.sendStatus = function (params, callback)
{
  // Send the current server status (skip class name and users)
  var result = this.save();
  delete result.cl;
  delete result.users;
  //
  // Remove "sensitive data"
  delete result.configGCloudStorage;
  delete result.dbPassword;
  delete result.googleAPIKey;
  //
  // Add server info
  var srvFile = Node.path.resolve(__dirname + "/../server.js");
  result.serverInfo = {version: this.server.version, startTime: this.server.startTime, pid: process.pid, lastWrite: Node.fs.statSync(srvFile).mtime};
  //
  // Add current disk status
  var cmd, cmdParams;
  if (!/^win/.test(process.platform)) {   // linux
    cmd = "/bin/df";
    cmdParams = ["."];
  }
  else {  // windows
    cmd = "wmic";
    cmdParams = ["logicaldisk", "where", "DeviceID='" + srvFile[0] + ":'", "get", "freespace,size", "/format:table"];
  }
  this.server.execFileAsRoot(cmd, cmdParams, function (err, stdout, stderr) {   // jshint ignore:line
    if (err) {
      this.logger.log("ERROR", "Error getting the disk size: " + (stderr || err), "Config.sendStatus");
      return callback("Error getting the disk size: " + (stderr || err));
    }
    //
    stdout = stdout.split("\n")[1];   // Remove headers
    stdout = stdout.split(/\s+/);     // Split spaces
    //
    if (!/^win/.test(process.platform))    // linux
      result.serverInfo.disk = {size: stdout[1], used: stdout[2], available: stdout[3], capacity: stdout[4]};
    else {  // windows
      result.serverInfo.disk = {size: stdout[1] / 1024, available: stdout[0] / 1024};
      result.serverInfo.disk.used = result.serverInfo.disk.size - result.serverInfo.disk.available;
      result.serverInfo.disk.capacity = Math.ceil(result.serverInfo.disk.available * 100 / result.serverInfo.disk.size) + "%";
    }
    //
    // On linux add NTP info and CPU load
    if (process.platform === "freebsd") {   // freebsd
      this.server.execFileAsRoot("/usr/bin/ntpq", ["-p"], function (err, stdout, stderr) {   // jshint ignore:line
        if (err) {
          this.logger.log("ERROR", "Error getting NTP info: " + (stderr || err), "Config.sendStatus");
          return callback("Error getting NTP info: " + (stderr || err));
        }
        //
        stdout = stdout.split("\n")[2];   // Remove headers
        stdout = stdout.trim().split(/\s+/);     // Split spaces
        //
        result.serverInfo.time = {synch: (stdout[0][0] === "*" ? "on" : "off"), date: new Date(), offset: stdout[8]};
        //
        // Add more info (per-process CPU load)
        this.server.execFileAsRoot("/bin/ps", ["-o", "pcpu", "-p", process.pid], function (err, stdout, stderr) {   // jshint ignore:line
          if (err) {
            this.logger.log("ERROR", "Error getting the CPU load: " + (stderr || err), "Config.sendStatus");
            return callback(null, "Error getting the CPU load: " + (stderr || err));
          }
          //
          stdout = stdout.split("\n")[1];   // Remove headers
          result.serverInfo.cpuLoad = parseFloat(stdout);
          //
          // Finally, get CPU load
          Node.Utils.getCPUload(function (cpuLoad) {
            result.serverInfo.globalCpuLoad = cpuLoad;
            //
            // Finally, finally... get memory usage
            this.server.execFileAsRoot("/usr/bin/top", ["-n"], function (err, stdout, stderr) {   // jshint ignore:line
              if (err) {
                this.logger.log("ERROR", "Error getting the memory status: " + (stderr || err), "Config.sendStatus");
                return callback(null, "Error getting the memory status: " + (stderr || err));
              }
              //
              // Mem: 719M Active, 3832M Inact, 1196M Wired, 736M Buf, 1679M Free
              stdout = stdout.split("\n")[3];   // Remove headers
              stdout = stdout.split(", ")[4];   // Get Free memory value
              stdout = stdout.substring(0, stdout.length - 5);      // remove " Free"
              result.serverInfo.freeMemory = stdout;
              //
              callback({msg: JSON.stringify(result)});
            }.bind(this));
          }.bind(this));
        }.bind(this));
      }.bind(this));
    }
    else if (process.platform === "linux") {   // linux
      result.serverInfo.time = {date: new Date()};
      //
      // Add more info (per-process CPU load)
      this.server.execFileAsRoot("/usr/bin/top", ["-b", "-n", "1"], function (err, stdout, stderr) {   // jshint ignore:line
        if (err) {
          this.logger.log("ERROR", "Error getting the CPU load and memory status: " + (stderr || err), "Config.sendStatus");
          return callback(null, "Error getting the CPU load and memory status: " + (stderr || err));
        }
        //
        // Mem: 719M Active, 3832M Inact, 1196M Wired, 736M Buf, 1679M Free
        var memstat = stdout.split("\n")[0];   // Get values
        memstat = memstat.split(", ")[1];   // Get Free memory value
        memstat = memstat.substring(0, memstat.length - 5);      // remove " Free"
        //
        // "Convert" from K to M
        result.serverInfo.freeMemory = Math.floor(parseFloat(memstat) / 1024) + "M";
        //
        stdout = stdout.split("\n").slice(4);   // Remove headers
        for (var i = 0; i < stdout.length; i++) {
          // Search right PID
          var procstat = stdout[i].trim().split(/\s+/);
          if (parseInt(procstat[0]) === process.pid) {
            result.serverInfo.cpuLoad = parseFloat(procstat[7].replace("%", ""));
            break;
          }
        }
        //
        // If not found... could be that PID is more than 999999... try "starts-with"
        if (result.serverInfo.cpuLoad === undefined) {
          for (var i = 0; i < stdout.length; i++) {
            // Search right PID
            var procstat = stdout[i].trim().split(/\s+/);
            if (procstat[0].startsWith(process.pid + "")) {
              result.serverInfo.cpuLoad = parseFloat(procstat[6].replace("%", ""));
              break;
            }
          }
        }
      });
      //
      // Finally, get CPU load
      Node.Utils.getCPUload(function (cpuLoad) {
        result.serverInfo.globalCpuLoad = cpuLoad;
        //
        callback({msg: JSON.stringify(result)});
      });
    }
    else
      callback({msg: JSON.stringify(result)});
  }.bind(this));
};


/**
 * Change the server configuration via web commands
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Config.prototype.configureServer = function (params, callback)   /*jshint maxcomplexity:100 */
{
  // Compute the array of properties provided via url
  var query = params.req.query;
  var queryProps = Object.getOwnPropertyNames(query);
  if (queryProps.length === 0) {
    this.logger.log("WARN", "No property specified", "Config.configureServer");
    return callback("No property specified");
  }
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
  if (query.debug2log !== undefined) {
    if (query.debug2log === "false")
      this.logger.debug2log = false;
    else if (query.debug2log === "true")
      this.logger.debug2log = true;
  }
  if (query.customPackages !== undefined) {
    // If given
    var oldcustomPackages = this.customPackages;
    if (query.customPackages) {
      try {
        //  module1@1.0.0,module2@1.0.0,
        this.customPackages = JSON.parse("[\"" + query.customPackages.replace(/,/g, "\",\"") + "\"]");
      }
      catch (ex) {
        this.logger.log("WARN", "Wrong customPackages parameter: " + ex.message, "Config.configureServer", {customPackages: query.customPackages});
        return callback("Wrong customPackages parameter: " + ex.message);
      }
    }
    else  // No customPackages
      delete this.customPackages;
    //
    // Update package.json (if needed)
    this.updatePackageJson(oldcustomPackages, this.customPackages, function (err) {
      if (err) {
        this.logger.log("WARN", "Error while updating package.json file: " + err, "Config.configureServer", {customPackages: query.customPackages});
        return callback("Error while updating package.json file: " + err);
      }
      //
      setImmediate(function () {
        completeConfigure();
      });  // Use setImmediate so that I can write the completeConfigure code after this block
    }.bind(this));
  }
  else
    setImmediate(function () {
      completeConfigure();
    });  // Use setImmediate so that I can write the completeConfigure code after this block
  //
  var completeConfigure = function () {
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
    if ((query.services || "").split(",").indexOf("track") !== -1)
      return this.initTracking(callback);
    //
    callback();
  }.bind(this);
};


/*
 * Send the list of all users on this server
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Config.prototype.sendUsersList = function (params, callback)
{
  var users = [];
  for (var i = 0; i < this.users.length; i++) {
    var u = this.users[i];
    if (u.userName === "manager")
      continue;   // Skip MANAGER user
    //
    users.push(u.userName);
  }
  //
  callback({msg: JSON.stringify(users)});
};


/*
 * Send the list of all online sessions
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Config.prototype.sendSessionsList = function (params, callback)
{
  var sessions = [];
  var onlineSessions = this.server.getOnlineSessions();
  for (var i = 0; i < onlineSessions.length; i++) {
    var sess = onlineSessions[i];
    //
    sessions.push({id: sess.id, type: sess.options.type, readOnly: sess.options.readOnly,
      user: sess.project.user.userName, project: sess.project.name, nClients: sess.countClients()});
  }
  //
  callback({msg: JSON.stringify(sessions)});
};


/*
 * Resfresh AuthToken and send it to console
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Config.prototype.refresh = function (params, callback)
{
  // If I don't need to communicate with the console, do nothing
  if (!this.consoleURL)
    return callback("ConsoleURL not set: token not sent");
  //
  // Send the new token to console
  this.server.request.sendTokenToConsole();
  //
  callback();
};


/*
 * Handle the log/console.out/console.error files
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Config.prototype.handleLog = function (params, callback)
{
  var pthis = this;
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
  var path = Node.path.resolve(__dirname + "/../../log") + "/";
  var filename = (params.req.query.date || (new Date()).toISOString().substring(0, 10)) + ".log";
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
        pthis.logger.log("WARN", "Wrong parameter", "Config.handleLog", {console: params.req.query.console});
        return callback("Wrong parameter");
    }
  }
  //
  // Handle commands
  var command = (params.tokens[1] || "download");
  switch (command) {
    case "status":
      Node.fs.stat(path + filename, function (err, stats) {
        if (err && err.code !== "ENOENT") {
          pthis.logger.log("WARN", "Error getting the file " + filename + " status: " + err, "Config.handleLog");
          return callback("Error getting the file " + filename + " status: " + err);
        }
        //
        // Report file size
        callback({msg: {size: (stats ? stats.size : -1)}});
      });
      break;

    case "clear":
      // Can't clear server LOG
      if (!filename.startsWith("console.")) {
        pthis.logger.log("WARN", "Can't clear server LOG", "Config.handleLog", {filename: filename});
        return callback("Can't clear server LOG");
      }
      //
      // Empty the file (don't delete it otherwise PM2 will not create it again)
      this.server.execFileAsRoot("/usr/bin/truncate", ["-s0", path + filename], function (err, stdout, stderr) {   // jshint ignore:line
        if (err) {
          pthis.logger.log("WARN", "Can't clear file " + filename + ": " + (stderr || err), "Config.handleLog");
          return callback("Can't clear file " + filename + ": " + (stderr || err));
        }
        //
        callback();
      });
      break;

    case "view":
    case "download":
      // Send file to client
      Node.fs.readFile(path + filename, function (err, data) {
        if (err) {
          pthis.logger.log("WARN", "Error reading the file " + filename + ": " + err, "Config.handleLog");
          return callback("Error reading the file " + filename + ": " + err);
        }
        //
        // If the user requested to view the file, don't force the download
        params.res.status(200);
        if (command === "view") {
          params.res.setHeader("Content-type", "text/html");
          if (params.req.headers["user-agent"])     // If it's a browser, beautify output
            params.res.write("<pre>");
          params.res.write(data, "binary");
          if (params.req.headers["user-agent"])     // If it's a browser, beautify output
            params.res.write("</pre>");
        }
        else {
          params.res.setHeader("Content-disposition", "attachment; filename = " + pthis.name + "-" + filename);
          params.res.write(data, "binary");
        }
        params.res.end();
        //
        // Done (don't reply, I've done it)
        callback({skipReply: true});
      });
      break;

    default:
      this.logger.log("WARN", "Invalid command", "Config.handleLog", {cmd: command, url: params.req.originalUrl});
      callback("Invalid Command");
      break;
  }
};


/**
 * Sends a message to every session
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Config.prototype.sendMessage = function (params, callback)
{
  var txt = decodeURIComponent(params.req.query.txt || /*jshint multistr: true */
          "Il server sarà aggiornato tra 5 minuti. Salvare e chiudere la sessione di lavoro<br/><br/>\
     The server will be updated in 5 minutes. Please save and leave the session");
  //
  var tot = 0;
  var keys = Object.keys(this.server.IDESessions);
  for (var i = 0; i < keys.length; i++) {
    var sess = this.server.IDESessions[keys[i]];
    //
    // If I want to send a message to a single session and this is not the
    // right one, skip it
    if (params.req.query.sid && sess.id !== params.req.query.sid)
      continue;
    //
    var message = {type: params.req.query.type, text: txt, style: (params.req.query.style || "alert")};
    if (message.type === "telecollaboration") {
      message.acceptLink = params.req.query.acceptLink;
      message.refuseLink = params.req.query.refuseLink;
    }
    sess.sendToChild({type: Node.Config.msgTypeMap.notify, cnt: message});
    tot++;
  }
  //
  callback({msg: "Text: '" + txt + "'<br/><br/>Total sessions: " + keys.length + "<br/><br/>Notified sessions: " + tot});
};


/**
 * Update the server
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Config.prototype.update = function (params, callback)
{
  // If the file is missing -> can't continue
  if (!params.req.query.file) {
    this.logger.log("WARN", "Missing FILE parameter", "Config.update");
    return callback("Missing FILE parameter");
  }
  //
  // Check if I'm already updating
  if (this.isUpdating) {
    this.logger.log("WARN", "The server is already updating", "Config.update");
    return callback("The server is already updating");
  }
  this.isUpdating = true;
  //
  var pthis = this;
  var foldername = params.req.query.file.substring(0, params.req.query.file.length - 7);      // Remove .tar.gz
  //
  // Compute source and destination paths
  var pathCloud = "updates/" + params.req.query.file;
  var path = Node.path.resolve(__dirname + "/../..") + "/update.tmp";
  //
  // Handle absolute URLs
  if (params.req.query.file.toLowerCase().startsWith("http://") || params.req.query.file.toLowerCase().startsWith("https://")) {
    // Recalc local variables
    pathCloud = params.req.query.file;
    foldername = foldername.substring(foldername.lastIndexOf("/") + 1);
  }
  //
  // Create error function (plus clean up)
  var errorFnc = function (err) {
    pthis.logger.log("ERROR", err, "Config.update", {path: path, pathCloud: pathCloud});
    //
    // Remove temporary directory
    Node.rimraf(path, function (err1) {
      if (err1)
        pthis.logger.log("WARN", "Can't remove temporary directory: " + err1, "Config.update", {path: path});
      //
      delete pthis.isUpdating;
      callback(err);
    });
  };
  //
  // Create a temporary directory (in order to "protect" main dirs)
  Node.fs.mkdir(path, function (err) {
    if (err)
      return errorFnc("Can't create temporary directory: " + err);
    //
    // Extract into temporary directory
    var archiver = new Node.Archiver(pthis.server);
    archiver.restore(path + "/" + foldername, pathCloud, function (err) {
      if (err)
        return errorFnc("Error restoring the update archive from the cloud: " + err);
      //
      // Compute the name of the directory (so that I can have a "logical name" that is different from what it contains)
      Node.fs.readdir(path, function (err, files) {
        if (err)
          return errorFnc("Error restoring the update archive from the cloud: " + err);
        //
        // Search, within the archive, the first file that does not start with .
        // (mac puts garbage inside TAR.GZ files...)
        var dirname;
        files.forEach(function (fn) {
          if (!dirname && fn[0] !== ".")
            dirname = fn;
        });
        //
        // Copy tar.gz content onto main dirs
        Node.ncp(path + "/" + dirname, path + "/..", function (err) {
          if (err)
            return errorFnc("Error copying the folders: " + err);
          //
          // Remove temporary directory (and all its content)
          Node.rimraf(path, function (err) {
            if (err)
              return errorFnc("Error removing the update folder: " + err);
            //
            // Update package.json if needed
            pthis.updatePackageJson(null, pthis.customPackages, function (err) {
              if (err)
                return errorFnc("Error while updating package.json file: " + err);
              //
              // If not skipped, update packages...
              if (!params.req.query.nopackages) {
                pthis.server.execFileAsRoot("UpdNodePackages", [], function (err, stdout, stderr) {   // jshint ignore:line
                  if (err)
                    return errorFnc("Error updating packages: " + (stderr || err));
                  //
                  fixIndeJSON();
                });
              }
              else
                setImmediate(fixIndeJSON);  // Use setImmediate so that I can write the fixIndeJSON code after this block
              //
              // If I'm on Node10 I need to "clean" the inde.json file
              // TODO: Rimuovere prima o poi....
              var fixIndeJSON = function () {
                if (process.platform === "linux" && parseInt(process.versions.node.split(".")[0], 10) >= 10) {
                  pthis.server.execFileAsRoot("/bin/sed", ["-i", "s/--harmony_object_observe//", __dirname + "/../inde.json"], function (err, stdout, stderr) {   // jshint ignore:line
                    if (err)
                      return errorFnc("Error while fixing inde.json (1): " + (stderr || err));
                    //
                    pthis.server.execFileAsRoot("/bin/sed", ["-i", "s/\\[\\\"\\\"\\]/\\[\\]/", __dirname + "/../inde.json"], function (err, stdout, stderr) {   // jshint ignore:line
                      if (err)
                        return errorFnc("Error while fixing inde.json (2): " + (stderr || err));
                      //
                      completeUpdate();
                    });
                  });
                }
                else
                  completeUpdate();
              };
              //
              var completeUpdate = function () {
                // If requested, reboot
                if (params.req.query.reboot) {
                  pthis.server.childer.send({type: Node.Config.msgTypeMap.execCmd, cmd: "reboot"});
                  pthis.logger.log("INFO", "Reboot requested", "Config.update");
                }
                //
                // LOG the operation
                pthis.logger.log("INFO", "Update succeeded", "Config.update");
                //
                delete pthis.isUpdating;
                callback({msg: "Update succeeded"});
              };
            });
          });
        });
      });
    });
  });
};


/**
 * Configure certificates
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
/*jshint maxcomplexity:45 */
Node.Config.prototype.configureCert = function (params, callback)
{
  /*
   "SSLCert": "/mnt/disk/config/cert/406a935796b9f.crt",
   "SSLKey": "/mnt/disk/config/cert/star_instantdevelopercloud_com.key",
   "SSLCABundles": ["/mnt/disk/config/cert/gd_bundle.crt", "/mnt/disk/config/cert/gd_bundle-g1.crt", "/mnt/disk/config/cert/gd_bundle-g2.crt"],

   BASE CERTIFICATE CONFIGURATION (i.e. *.instantdevelopercloud.com)
   1) manager/cert/config?cert={SSLCert:<filename>, SSLKey:<filename>, SSLCABundles:[<filename1>, <filename2>, <filename3>]}
   if the SSLCert was already there the system will delete the SSLCert file.
   A new file have to be uploaded with a POST request manager/cert/upload
   if the SSLKey was already there the system will delete the SSLKey file.
   A new file have to be uploaded with a POST request manager/cert/upload
   if the SSLCABundles was already there the system will delete the useless bundles.
   One or more files have to be uploaded with several POST request manager/cert/upload

   CUSTOM CERTIFICATES
   1) manager/cert/add?cert={SSLDomain:<certdomain>, SSLCert:<filename>, SSLKey:<filename>, SSLCABundles:[<filename1>, <filename2>, <filename3>]}
   One or more files have to be uploaded with several POST request manager/cert/upload

   2) manager/cert/revoke?cert=<certdomain>
   The system will delete all files used by the certificate then remove the certificate from the custom certificate array
   */
  //
  var command = params.tokens[1];
  var cert = params.req.query.cert;
  var certPath = Node.path.resolve(__dirname + "/../../../config") + "/cert/";
  //
  // If it's not an upload and the CERT parameter is missing -> error
  if (!cert && command !== "upload") {
    this.logger.log("WARN", "Missing certificate object", "Config.configureCert");
    return callback("Missing certificate object");
  }
  //
  // For CONFIG and ADD cert value is a JSON.stringified object
  // (for UPLOAD there is no cert parameter and for REVOKE cert is a string
  if (command === "config" || command === "add") {
    try {
      cert = JSON.parse(cert);
    }
    catch (ex) {
      this.logger.log("WARN", "Invalid cert format", "Config.configureCert", {cert: cert});
      return callback("Invalid cert format");
    }
  }
  //
  var i, j, filesToRemove = [], saveConfig = false;
  switch (command) {
    case "config":
      // If a new SSLCert has been provided
      if (cert.SSLCert) {
        // If there was already a SSLCert, remove the associated file
        if (this.SSLCert)
          filesToRemove.push(this.SSLCert);
        this.SSLCert = certPath + cert.SSLCert;
        saveConfig = true;
        //
        this.logger.log("DEBUG", "Updated SSLCert property", "Config.configureCert", {SSLCert: this.SSLCert});
      }
      //
      // If a new SSLKey has been provided
      if (cert.SSLKey) {
        // If there was already a SSLKey, remove the associated file
        if (this.SSLKey)
          filesToRemove.push(this.SSLKey);
        this.SSLKey = certPath + cert.SSLKey;
        saveConfig = true;
        //
        this.logger.log("DEBUG", "Updated SSLKey property", "Config.configureCert", {SSLKey: this.SSLKey});
      }
      //
      // If a new SSLCABundles has been provided
      if (cert.SSLCABundles) {
        // If there was already a SSLCABundles, remove the associated file
        if (this.SSLCABundles) {
          for (i = 0; i < this.SSLCABundles.length; i++)
            if (cert.SSLCABundles.indexOf(this.SSLCABundles[i].substring(certPath.length)) === -1)     // File it's not there anymore
              filesToRemove.push(this.SSLCABundles[i]);
        }
        //
        this.SSLCABundles = [];
        for (i = 0; i < cert.SSLCABundles.length; i++)
          this.SSLCABundles.push(certPath + cert.SSLCABundles[i]);
        saveConfig = true;
        //
        this.logger.log("DEBUG", "Updated SSLCABundles property", "Config.configureCert", {SSLCABundles: this.SSLCABundles});
      }
      break;

    case "add":
      if (!cert.SSLDomain || !cert.SSLCert || !cert.SSLKey || !cert.SSLCABundles) {
        this.logger.log("WARN", "Invalid cert format (missing SSLDomain, SSLCert, SSLKey or SSLCABundles)", "Config.configureCert", cert);
        return callback("Invalid cert format (missing SSLDomain, SSLCert, SSLKey or SSLCABundles)");
      }
      //
      // If the domain exists -> that's an error
      this.customSSLCerts = this.customSSLCerts || [];
      for (i = 0; i < this.customSSLCerts.length; i++)
        if (this.customSSLCerts[i].SSLDomain === cert.SSLDomain) {
          this.logger.log("WARN", "Cert for domain " + cert.SSLDomain + " exists", "Config.configureCert", cert);
          return callback("Cert for domain " + cert.SSLDomain + " exists");
        }
      //
      cert.SSLCert = certPath + cert.SSLCert;
      cert.SSLKey = certPath + cert.SSLKey;
      for (i = 0; i < cert.SSLCABundles.length; i++)
        cert.SSLCABundles[i] = certPath + cert.SSLCABundles[i];
      this.customSSLCerts.push(cert);
      saveConfig = true;
      //
      this.logger.log("DEBUG", "Added new custom certificate", "Config.configureCert", cert);
      break;

    case "revoke":
      for (i = 0; i < (this.customSSLCerts || []).length; i++) {
        if (this.customSSLCerts[i].SSLDomain === cert) {
          this.logger.log("DEBUG", "Custom certificate revoked", "Config.configureCert", this.customSSLCerts[i]);
          //
          // Found! Remove the certificate
          var revokedCert = this.customSSLCerts.splice(i, 1)[0];
          //
          // Check if some files have become useless and if that's the case, delete them
          // To check, compute the list of currently used files
          var usedFiles = [];
          for (i = 0; i < this.customSSLCerts.length; i++) {
            var c = this.customSSLCerts[i];
            usedFiles.push(c.SSLCert);
            usedFiles.push(c.SSLKey);
            for (j = 0; j < (c.SSLCABundles || []).length; j++)
              usedFiles.push(c.SSLCABundles[j]);
          }
          //
          // Then check if the revoked certificate files are still used
          if (usedFiles.indexOf(revokedCert.SSLCert) === -1)
            filesToRemove.push(revokedCert.SSLCert);
          if (usedFiles.indexOf(revokedCert.SSLKey) === -1)
            filesToRemove.push(revokedCert.SSLKey);
          for (j = 0; j < (revokedCert.SSLCABundles || []).length; j++)
            if (usedFiles.indexOf(revokedCert.SSLCABundles[j]) === -1)
              filesToRemove.push(revokedCert.SSLCABundles[j]);
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
        this.logger.log("WARN", "Certificate " + cert + " not found", "Config.configureCert", {cert: cert});
        return callback({code: 404, msg: "Certificate " + cert + " not found"});
      }
      break;

    case "upload":
      var form = new Node.multiparty.Form({autoFields: true, autoFiles: true, uploadDir: certPath});
      form.parse(params.req, function (err, fields, files) {
        if (err) {
          this.logger.log("WARN", "Error parsing post request: " + err, "Config.configureCert");
          return callback("Error parsing post request: " + err);
        }
        //
        // Rename uploaded files
        var nfiles = 0;
        var farr = Object.keys(files);
        for (i = 0; i < farr.length; i++) {
          var k = farr[i];
          var f = files[k][0];
          var newfile = certPath + f.originalFilename;
          Node.fs.rename(f.path, newfile, function (err) {
            if (err) {
              this.logger.log("WARN", "Error moving uploaded file: " + err, "Config.configureCert",
                      {originalfile: f.originalFilename, newfile: newfile});
              return callback("Error moving uploaded file: " + err);
            }
            //
            // If it's the last one, report to callee
            if (++nfiles === farr.length) {
              this.logger.log("DEBUG", "Certificate files uploaded", "Config.configureCert", files);
              callback();
            }
          }.bind(this));    // jshint ignore:line
        }
      }.bind(this));
      return;   // Don't do anything else...

    default:
      this.logger.log("WARN", "Invalid command", "Config.configureCert", {cmd: command, url: params.req.originalUrl});
      return callback("Invalid Command");
  }
  //
  // If there are files to remove, remove them
  for (i = 0; i < filesToRemove.length; i++)
    (function (fn) {
      Node.rimraf(fn, function (err) {
        if (err)
          this.logger.log("WARN", "Error removing the file " + fn + ": " + err, "Config.configureCert");
        else
          this.logger.log("DEBUG", "Removed useless file " + fn, "Config.configureCert");
      }.bind(this));
    }.bind(this))(filesToRemove[i]);    // jshint ignore:line
  //
  // If config has changed, save it
  if (saveConfig)
    this.saveConfig();
  //
  // Done!
  callback();
};


/**
 * Check if the data-disk must be size-adjusted
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Config.prototype.checkDataDisk = function (params, callback)
{
  // Do nothing on a windows machine
  if (/^win/.test(process.platform))
    return callback();
  //
  var disk = {};
  var errorFnc = function (err) {
    this.logger.log("ERROR", err, "Config.checkDataDisk", disk);
    callback(err);
  }.bind(this);
  //
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
    Node.child.execFile("/usr/bin/grep", ["da1", "/var/run/dmesg.boot"], function (err, stdout, stderr) {    // jshint ignore:line
      if (err)
        return errorFnc("Error while computing SCSI device id: " + (stderr || err));
      //
      stdout = stdout.split("\n");      // Split lines
      var scsiId = stdout[0];           // First row
      scsiId = scsiId.substring(1, scsiId.indexOf(")"));      // Get part inside ()
      scsiId = scsiId.split(":");       // Split :
      scsiId = scsiId.slice(2);         // Remove "(da1:vtscsi0:"
      scsiId = scsiId.join(":");        // Re-join and get scsiId
      //
      // Ask the system to reprobe disk size
      this.server.execFileAsRoot("/sbin/camcontrol", ["reprobe", scsiId], function (err, stdout, stderr) {   // jshint ignore:line
        if (err)
          return errorFnc("Error while reprobing disk size: " + (stderr || err));
        //
        // Get current part status (da1 is /mnt/disk)
        this.server.execFileAsRoot("/sbin/gpart", ["show", "da1"], function (err, stdout, stderr) {   // jshint ignore:line
          if (err)
            return errorFnc("Error while executing GPART: " + (stderr || err));
          //
          stdout = stdout.split("\n");      // Split lines
          //
          // Expected reply:
          // =>      34  20971453  da1  GPT  (TOTALSIZE)            (eg. 15G)
          //         34         6       - free -  (3.0K)
          //         40  20971440    1  freebsd-ufs  (USEDSIZE)     (eg. 10G)
          //   20971480         7       - free -  (3.5K)
          //
          disk.designSize = stdout[0].split(/\s+/)[5];
          disk.designSize = disk.designSize.substring(1, disk.designSize.length - 1);   // Remove ()
          //
          // Now search the "freebsd-ufs" partition (there should be only one!)
          for (var i = 1; i < stdout.length; i++) {
            if (stdout[i].indexOf("freebsd-ufs") !== -1) {
              disk.currSize = stdout[i].split(/\s+/)[5];
              disk.currSize = disk.currSize.substring(1, disk.currSize.length - 1);    // Remove ()
              break;
            }
          }
          //
          // If Size is the same, do nothing
          if (disk.designSize === disk.currSize)
            return callback();
          //
          // Size is not equal... fix it
          this.logger.log("INFO", "Fixing data disk", "Config.checkDataDisk", disk);
          //
          // Recover partition
          this.server.execFileAsRoot("/sbin/gpart", ["recover", "da1"], function (err, stdout, stderr) {   // jshint ignore:line
            if (err)
              return errorFnc("Error while executing GPART RECOVER: " + (stderr || err));
            //
            // Out from the box you cannot write to MBR of disk, which is the one FreeBSD boots from.
            // After setting sysctl kern.geom.debugflags=16 I get allowed to shoot in the foot and write to MBR.
            this.server.execFileAsRoot("/sbin/sysctl", ["kern.geom.debugflags=16"], function (err, stdout, stderr) {   // jshint ignore:line
              if (err)
                return errorFnc("Error while executing SYSCTL=16: " + (stderr || err));
              //
              // Resize partition to fill up all the free space
              this.server.execFileAsRoot("/sbin/gpart", ["resize", "-i", "1", "da1"], function (err, stdout, stderr) {   // jshint ignore:line
                if (err)
                  return errorFnc("Error while executing GPART RESIZE: " + (stderr || err));
                //
                // Resize file system and fill up the partition (quiet mode!!!)
                this.server.execFileAsRoot("/sbin/growfs", ["-y", "/dev/da1p1"], function (err, stdout, stderr) {   // jshint ignore:line
                  if (err)
                    return errorFnc("Error while executing GROWFS: " + (stderr || err));
                  //
                  // Restore flag
                  this.server.execFileAsRoot("/sbin/sysctl", ["kern.geom.debugflags=0"], function (err, stdout, stderr) {   // jshint ignore:line
                    if (err)
                      return errorFnc("Error while executing SYSCTL=0: " + (stderr || err));
                    //
                    // Done!
                    this.logger.log("INFO", "Data disk fixed", "Config.checkDataDisk");
                    callback({msg: "Fixed to " + disk.designSize, code: 200});
                  }.bind(this));
                }.bind(this));
              }.bind(this));
            }.bind(this));
          }.bind(this));
        }.bind(this));
      }.bind(this));
    }.bind(this));
  }
  else if (process.platform === "linux") {
    this.server.execFileAsRoot("/usr/sbin/parted", ["-m", "/dev/sdb", "print"], function (err, stdout, stderr) {   // jshint ignore:line
      if (err)
        return errorFnc("Error while executing PARTED: " + (stderr || err));
      //
      // BYT;
      // /dev/sdb:23.6GB:scsi:512:4096:loop:Google PersistentDisk:;
      // 1:0.00B:23.6GB:23.6GB:ext4::;
      disk.designSize = stdout.split("\n")[1];
      disk.designSize = disk.designSize.split(":")[1];
      //
      // Resize partition to fill up all the free space
      this.server.execFileAsRoot("/usr/sbin/resize2fs", ["/dev/sdb"], function (err, stdout, stderr) {   // jshint ignore:line
        if (err)
          return errorFnc("Error while executing RESIZE2FS: " + (stderr || err));
        //
        // If the disk needs nothing
        if (stderr.indexOf("The filesystem is already") !== -1)
          return callback();
        //
        // Done!
        this.logger.log("INFO", "Data disk fixed", "Config.checkDataDisk");
        callback({msg: "Fixed to " + disk.designSize, code: 200});
      }.bind(this));
    }.bind(this));
  }
  else
    return errorFnc("Unsupported platform: " + process.platform);
};


/**
 * Initialize tracking
 * @param {function} callback (err or {err, msg, code})
 */
Node.Config.prototype.initTracking = function (callback)
{
  // At start-up there is no callback
  callback = callback || function () {
  };
  //
  // If tracking is not active, do nothing
  if ((this.services || "").split(",").indexOf("track") === -1)
    return callback();
  //
  var Postgres = require("../../ide/app/server/postgres");
  var trackDB = new Postgres();
  trackDB.schema = {"id": "q0QvNTfSzEHdmYsdj+WEIA==", "name": "$trackingDB$", "type": "$trackingDB$", "tables": [{"id": "h6aAxGQcqGH9zCgYcN/7jA==", "name": "Issues", "fields": [{"id": "raFFirodiY5SYrKs8khbnA==", "name": "ID", "datatype": "id", "maxlen": 24, "pk": true}, {"id": "GMu4qCtqK2ylk1a9+xpSzw==", "name": "IssueApplicationID", "datatype": "id", "maxlen": 24}, {"id": "gvEa1E8hV0EYuzk0b48xpA==", "name": "ProjectID", "datatype": "id", "maxlen": 24}, {"id": "8VuRWXB3HiIb8rR5L7iwUA==", "name": "ProjectJsonID", "datatype": "id", "maxlen": 24, "notn": true}, {"id": "zrluHniES3g/HlY1+VhBNg==", "name": "ApplicationJsonID", "datatype": "id", "maxlen": 24}, {"id": "8RtjtmBa9CskXDbDL8QArw==", "name": "BuildID", "datatype": "id", "maxlen": 24}, {"id": "uuxk4NaVz0wfFNt9+NK2rw==", "name": "BuildName", "datatype": "vc"}, {"id": "zZqgdCi9k5ffG38wROQ4ug==", "name": "BuildFormat", "datatype": "vc", "maxlen": 3}, {"id": "G1hOjxkADUkjWc9H0tmO6A==", "name": "LinkedObject", "datatype": "j"}, {"id": "C4uWoHljnhoiyDRuIdXb3w==", "name": "Branch", "datatype": "j"}, {"id": "qvHBMiJyYTHMDzHxAriiug==", "name": "Context", "datatype": "j"}, {"id": "gfkj8VwK7c9mVs8NZHdgbA==", "name": "CommitID", "datatype": "id", "maxlen": 24}, {"id": "X1faYOw57iteQzy8jNTaxw==", "name": "AuthorID", "datatype": "vc"}, {"id": "1Btb7CUR/U0m/piKpRuDow==", "name": "AuthorAvatar", "datatype": "vc"}, {"id": "7hp+1ep1FS+Nt6Su4hWa7Q==", "name": "AuthorName", "datatype": "vc"}, {"id": "tzxZ+ZpfBIvT3M4uFJetGw==", "name": "Title", "datatype": "vc"}, {"id": "gKx8db8g8IPsv9AYTd8XPw==", "name": "Description", "datatype": "vc"}, {"id": "c9RBYdro91EuMbxanQGH2Q==", "name": "SourceObject", "datatype": "j"}, {"id": "GcPOOAVhhSXXD1EBmZVFEg==", "name": "CreationDate", "datatype": "dt"}, {"id": "s7oYtzRmGYs4UV03a2DABQ==", "name": "IssueType", "datatype": "i"}, {"id": "e4gvrscSsjb4niwd+33vsw==", "name": "Screenshot", "datatype": "vc"}, {"id": "BQrvkhKUsdZbEXEx0boqzA==", "name": "Activities", "datatype": "j"}, {"id": "Yd9MeOLH6zNdFjMLB9mbUA==", "name": "AssignToID", "datatype": "id", "maxlen": 24}, {"id": "PHO+nUZD6k9pWlj7K0xMlA==", "name": "AssignToAvatar", "datatype": "vc"}, {"id": "dbNioY++YCw+oobrhybsSg==", "name": "AssignToName", "datatype": "vc"}, {"id": "olDW06tCtsfiq9mGo22j7w==", "name": "Code", "datatype": "i"}, {"id": "D+DFykWF3JeHv+cTpC0nyA==", "name": "Priority", "datatype": "i"}, {"id": "myfGITWjTKzaOl31z4dvaw==", "name": "Tags", "datatype": "vc"}, {"id": "2GysvAQaUxS+25h5e4dHow==", "name": "DeployStatus", "datatype": "i"}, {"id": "vhMO4QuJeAfi2fk0M0qrQg==", "name": "Category", "datatype": "i"}, {"id": "dbT7We57+jk9NuE8dluPzg==", "name": "Votes", "datatype": "i", "defval": "0"}, {"id": "TneyghFUGS6pK5F5B9JGVA==", "name": "NotificationEmails", "datatype": "vc"}, {"id": "v/ljRAQzPtMNI8sRsL+yGg==", "name": "ForkChainID", "datatype": "id", "maxlen": 24}], "fks": [{"id": "dPSTX+LzXuTMSoAcVUIT4A==", "name": "fkIssueApplications", "t": "IssueApplications", "ur": "c", "dr": "c", "refs": {"GMu4qCtqK2ylk1a9+xpSzw==": "ID"}}]}, {"id": "UAZbmF3p3VFzZANljHCUyw==", "name": "IssueTags", "fields": [{"id": "+5mLeHZjmPbZYVCCUKLPUg==", "name": "ID", "datatype": "id", "maxlen": 24, "pk": true}, {"id": "qcZe2R1nhWsm2AluUqIPsA==", "name": "TagLabel", "datatype": "vc", "notn": true}, {"id": "knNBsG9IjNTixiSPMU4/xQ==", "name": "Available", "datatype": "b"}, {"id": "INik72DBhiLta5VQad9Dbg==", "name": "AccountID", "datatype": "id", "maxlen": 24}]}, {"id": "kr3qP6vuLOc4E31EN0UVwQ==", "name": "IssueApplications", "fields": [{"id": "FSAY7uGwp8zhmf7mocRjTA==", "name": "ID", "datatype": "id", "maxlen": 24, "pk": true}, {"id": "D7rgv3xFaWjP3A7yUv82+A==", "name": "ProjectID", "datatype": "id", "maxlen": 24}, {"id": "KVVu0MTG5AtVzUC1xJdphg==", "name": "ProjectJsonID", "datatype": "id", "maxlen": 24, "notn": true}, {"id": "cu2THSSWPeLnH8qKW0NMXA==", "name": "ApplicationJsonID", "datatype": "id", "maxlen": 24, "notn": true}, {"id": "VF7d2FtNzhEMBee1dGzOAQ==", "name": "ApplicationName", "datatype": "vc"}, {"id": "e0FdPOi5ITQlMXyKE5J6Pg==", "name": "Format", "datatype": "vc", "maxlen": 3, "notn": true}]}]};
  trackDB.initDbConString("postgres://" + this.dbUser + ":" + this.dbPassword + "@" + this.dbAddress + ":" + this.dbPort);
  //
  // Replace the standard createDb function (normally the updateSchema method is called from a child process
  // thus the createDb method sends a message to the parent process... but not this time)
  trackDB.createDb = function (cb) {      // cb - result, error
    var manager = this.getUser("manager");     // It must exist
    var db = manager.getDatabase(trackDB.schema.name);
    if (!db) {
      // $tracking$ DB is not there -> create one
      manager.createDatabase(trackDB.schema.name, function (err) {
        if (err) {
          this.logger.log("ERROR", "Error while creating " + trackDB.schema.name + " database: " + (err.msg || err), "Config.initTracking");
          return cb(null, err.msg || err);
        }
        //
        // Now DB exists -> check DB schema
        cb();
      }.bind(this));
    }
    else
      cb();
  }.bind(this);
  //
  // Update database's schema
  trackDB.updateSchema(function (result, error) {
    if (error) {
      this.logger.log("ERROR", "Error while updating " + trackDB.schema.name + " schema: " + error, "Config.initTracking");
      callback("Error while updating " + trackDB.schema.name + " schema: " + error);
    }
    else {
      this.logger.log("DEBUG", trackDB.schema.name + " schema updated", "Config.initTracking");
      callback();
    }
  }.bind(this));
};


/**
 * Process an URL command
 * @param {request} req
 * @param {response} res
 */
Node.Config.prototype.processCommand = function (req, res)
{
  var pthis = this;
  //
  // Handle only GET or POST
  if (req.method !== "POST" && req.method !== "GET")
    return req.next();
  //
  // Tokenize URL
  var params = {tokens: req.originalUrl.substring(1).split("?")[0].split("/")};
  //
  // Add REQ and RES to params object
  params.req = req;
  params.res = res;
  //
  // Merge Query-string parameters with BODY (i.e. x-www-form-urlencoded POST parameters)
  params.req.query = Object.assign(req.query, req.body);
  //
  // Log the operation
  this.logger.log("DEBUG", "Processing operation", "Config.processCommand", {url: req.originalUrl, host: req.connection.remoteAddress});
  //
  // Function for response
  var sendResponse = function (result) {
    result = result || {};    // Default: everything is fine
    //
    // If RESULT is a string, it's an error message
    if (result && typeof result === "string")
      result = {err: result};
    //
    // Handle RID if given (not for Unauthorized... that should go out immediately on the main output stream)
    if (params.req.query.rid && result.code !== 401) {
      if (result.err)
        pthis.server.request.sendResponse(params.req.query.rid, result.code || 500, result.err);
      else
        pthis.server.request.sendResponse(params.req.query.rid, 200, result.msg || "OK");
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
    pthis.logger.log("DEBUG", "Operation completed", "Config.processCommand",
            {result: result, url: req.originalUrl, host: req.connection.remoteAddress});
  };
  //
  // Extract user and command
  var userName = Node.Utils.clearName(params.tokens[0]);
  var command = params.tokens[1];
  //
  // Remove user from list of tokens
  params.tokens.splice(0, 1);
  //
  // If the authorization key is enabled and the given one does not match -> error
  // (do it only for "CREATE", "RESTORE" and "DELETE" commands 'cause other commands will handle it where it's needed)
  if (this.auth && params.req.query.autk !== this.autk && ["create", "restore", "delete"].indexOf(command) !== -1) {
    this.logger.log("WARN", "Unauthorized", "Config.execCommand", {url: params.req.originalUrl});
    return sendResponse({err: "Unauthorized", code: 401});
  }
  //
  // Handle user commands
  // (http://servername/username/command)
  switch (command) {
    case "create":
      this.createUser(userName, sendResponse);
      break;

    case "restore":
      this.createUser(userName, function (err) {
        if (err)
          return sendResponse(err);
        //
        var user = pthis.getUser(userName);
        user.processCommand(params, function (err) {
          // If error -> delete user
          sendResponse(err);
          if (err)
            pthis.deleteUser(userName, function () {
            });
        });
      });
      break;

    case "delete":
      this.deleteUser(userName, sendResponse);
      break;

    default:
      var user = this.getUser(userName);
      if (!user)
        return req.next();
      //
      // If the userName is "manager" handle "basic" server commands otherwise handle user commands
      // (http://servername/manager/command)
      if (userName === "manager")
        this.execCommand(params, sendResponse);
      else
        user.processCommand(params, sendResponse);
      break;
  }
  //
  // If the callee gave me a RID (i.e. he wants to know "asynchronously" if the command was succeded)
  // and I've not ansered yet (with errors or other) send an "OK" reply (that means I'm handling it)
  if (params.req.query.rid && !res.answered) {
    res.status(200).send("OK");
    res.answered = true;
  }
};


/**
 * Execute commands for the server
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Config.prototype.execCommand = function (params, callback)
{
  var command = params.tokens[0];
  //
  // There are only 2 commands that can be executed without AUTK:
  // - Server RENAME (only if name is the default NEWIMAGE)
  // - TOKEN REFRESH
  if (command === "config" && params.req.query.name && Object.keys(params.req.query).length === 1 && this.name === "newimage")
    return this.configureServer(params, callback);
  else if (command === "refresh")
    return this.refresh(params, callback);
  //
  // If the authorization key is enabled and the given one does not match -> error
  if (this.auth && params.req.query.autk !== this.autk) {
    this.logger.log("WARN", "Unauthorized", "Config.execCommand", {url: params.req.originalUrl});
    return callback({err: "Unauthorized", code: 401});
  }
  //
  // I'm here if AUTK is not enabled or if the given one matches
  switch (command) {
    case "status":
      this.sendStatus(params, callback);
      break;
    case "config":
      this.configureServer(params, callback);
      break;
    case "users":
      this.sendUsersList(params, callback);
      break;
    case "sessions":
      this.sendSessionsList(params, callback);
      break;
    case "refresh":
      this.refresh(params, callback);
      break;
    case "log":
      this.handleLog(params, callback);
      break;
    case "message":
      this.sendMessage(params, callback);
      break;
    case "cert":
      this.configureCert(params, callback);
      break;
    case "update":
      this.update(params, callback);
      break;
    case "reboot":
      this.server.childer.send({type: Node.Config.msgTypeMap.execCmd, cmd: "reboot"});
      callback();
      break;
    case "checkdisk":
      this.checkDataDisk(params, callback);
      break;
    default:
      // For any other command ask MANAGER user
      var user = this.getUser("manager");
      if (user)
        user.processCommand(params, callback);
      else {
        this.logger.log("WARN", "Invalid command", "Config.execCommand", {cmd: command, url: params.req.originalUrl});
        callback("Invalid Command");
      }
      break;
  }
};


// Export module
module.exports = Node.Config;
