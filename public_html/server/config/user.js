/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
var Node = Node || {};

// Import Modules
Node.multiparty = require("multiparty");
Node.ncp = require("../ncp_fixed");
Node.fs = require("fs");
Node.child = require("child_process");
Node.crypto = require("crypto");
Node.path = require("path");

// Import classes
Node.Project = require("./project");
Node.Database = require("./database");
Node.App = require("./app");
Node.Archiver = require("../archiver");
Node.Utils = require("../utils");
Node.Device = require("./device");


/**
 * @class Represents an Instant Developer User
 * @param {Node.Config} par
 */
Node.User = function (par)
{
  this.parent = par;
  //
  this.userName = "";
  this.dbPassword = "";
  this.projects = [];
  this.databases = [];
  this.apps = [];
  this.devices = [];
  this.cloudConnectors = [];
  this.idfdata = {
    guid: "00000000-0000-0000-0000-000000000000",
    password: "",
    group: "",
    email: "",
    language: "",
    phone: ""
  };
};


Node.User.msgTypeMap = {
  deviceMsg: "dm",
  cloudConnectorMsg: "ccm"
};


// Define usefull properties for this object
Object.defineProperties(Node.User.prototype, {
  server: {
    get: function () {
      return this.parent.parent;
    }
  },
  config: {
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
 * Log a new message
 * @param {string} level - message level (DEBUG, INFO, WARN, ERROR)
 * @param {string} message - text message
 * @param {string} sender - function that generated the message
 * @param {object} data - optional data to log
 */
Node.User.prototype.log = function (level, message, sender, data)
{
  // Add "local" info
  data = (data ? JSON.parse(JSON.stringify(data)) : {});
  data.user = this.userName;
  //
  this.logger.log(level, message, sender, data);
};


/**
 * Save the object
 */
Node.User.prototype.save = function ()
{
  return {
    cl: "Node.User",
    userName: this.userName,
    dbPassword: this.dbPassword,
    projects: this.projects,
    databases: this.databases,
    apps: this.apps,
    name: this.name,
    surname: this.surname,
    OSUser: this.OSUser,
    IID: this.IID,
    uid: this.uid,
    gid: this.gid,
    idfdata: this.idfdata
  };
};


/**
 * Load the object
 * @param {Object} v - the object that contains my data
 */
Node.User.prototype.load = function (v)
{
  this.userName = v.userName;
  this.projects = v.projects;
  this.databases = v.databases;
  this.apps = v.apps;
  this.name = v.name;
  this.surname = v.surname;
  this.dbPassword = v.dbPassword;
  this.OSUser = v.OSUser;
  this.uid = v.uid;
  this.gid = v.gid;
  this.IID = v.IID;
  if (v.idfdata)
    this.idfdata = v.idfdata;
  //
  // TODO: eliminare prima o poi... i vecchi utenti avevano questa password hard-coded
  if (!this.dbPassword)
    this.dbPassword = "12345";
};


/**
 * Save the object's properties (i.e. no children objects)
 */
Node.User.prototype.saveProperties = function ()
{
  var r = this.save();
  //
  // Delete children
  delete r.cl;
  delete r.projects;
  delete r.databases;
  delete r.apps;
  //
  return r;
};


/**
 * Set the parent of this object (and its children)
 * @param {Node.Config} par - my parent
 */
Node.User.prototype.setParent = function (par)
{
  this.parent = par;
  //
  var i;
  if (this.projects)
    for (i = 0; i < this.projects.length; i++)
      this.projects[i].setParent(this);
  //
  if (this.databases)
    for (i = 0; i < this.databases.length; i++)
      this.databases[i].setParent(this);
  //
  if (this.apps)
    for (i = 0; i < this.apps.length; i++)
      this.apps[i].setParent(this);
};


/**
 * Stringify this user
 */
Node.User.prototype.saveUser = function ()
{
  return JSON.stringify(this, function (k, v) {
    if (v instanceof Node.User || v instanceof Node.Project || v instanceof Node.Database || v instanceof Node.App)
      return v.save();
    else
      return v;
  });
};


/*
 * Loads the user from a JSON text
 * @param {String} s - JSON data to load
 */
Node.User.prototype.loadUser = function (s)
{
  var pthis = this;
  //
  // I'm loading the user from the JSON file. This method is used inside the RESTORE method.
  // Here I have to be careful: the OSUser, UID, GID, and apps array that are inside the JSON
  // are, probably, wrong. They could come from a different server (if the RESTORE is a cross-server operation)
  // or they are from this server but in different times (the user has been backed up some time ago and it's
  // OSUser could, now, be occupied by someone else). I need to keep the current OSUser, UID and GID that have
  // been calculated when this user has been created.
  //
  // Save "system" data
  var old_OSUser = this.OSUser;
  var old_uid = this.uid;
  var old_gid = this.gid;
  //
  JSON.parse(s, function (k, v) {
    if (v instanceof Object && v.cl !== undefined) {
      var obj;
      if (v.cl === "Node.User")
        obj = pthis;
      if (v.cl === "Node.Database") {
        obj = new Node.Database(pthis);
        pthis.databases.push(obj);
      }
      if (v.cl === "Node.Project") {
        obj = new Node.Project(pthis);
        pthis.projects.push(obj);
      }
      if (v.cl === "Node.App") {
        obj = new Node.App(pthis);
        pthis.apps.push(obj);
      }
      //
      obj.load(v);
      return obj;
    }
    else
      return v;
  });
  //
  // Restore "system" data
  this.OSUser = old_OSUser;
  this.uid = old_uid;
  this.gid = old_gid;
  //
  // Restore does not restore apps, thus the user looses them
  this.apps = [];
  //
  // Connect all objects
  this.setParent(this.parent);
};


/**
 * Initialise the user
 * @param {string} userName
 * @param {function} callback - function(err)
 */
Node.User.prototype.init = function (userName, callback)
{
  var pthis = this;
  this.userName = userName;
  //
  // Create a new random-dbPassword
  this.dbPassword = Node.crypto.randomBytes(16).toString("hex");
  //
  // If I'm the manager user, I don't need anything more
  if (this.userName === "manager")
    return callback();
  //
  // Assign an OS user and create the user folder
  this.assignOsUser(function (err) {
    if (err)
      return callback(err);
    //
    pthis.createUserFolder(callback);
  });
};


/**
 * Start default server session of all apps
 */
Node.User.prototype.startServerSessions = function ()
{
  // Notify event to my apps
  for (var i = 0; this.apps && i < this.apps.length; i++)
    this.apps[i].startDefaultServerSession();
};


/**
 * Assign a system user to the user
 * @param {Function} callback - function(err)
 */
Node.User.prototype.assignOsUser = function (callback)
{
  var pthis = this;
  //
  // If LOCAL do nothing
  if (this.config.local)
    return callback();
  //
  // If this user has not yet been coupled with an OS system user
  if (!this.OSUser) {
    // Find a "free" OS user
    var i, array = [];
    for (i = 0; i < 300; i++)
      array[i] = true;
    //
    for (i = 0; i < this.config.users.length; i++) {
      var OsU = this.config.users[i].OSUser;
      if (OsU) {
        var uidx = OsU.split("-")[OsU.split("-").length - 1];
        array[uidx] = false;
      }
    }
    //
    // Now get the first free user
    for (i = 0; i < 300 && !this.OSUser; i++)
      if (array[i])
        this.OSUser = (process.platform === "freebsd" ? "indeuser-" : "user-") + i;
    //
    // If not found...
    if (!this.OSUser) {
      pthis.log("ERROR", "No available OS users", "User.assignOsUser");
      return callback("No available OS users");
    }
  }
  //
  // Now ask the system the UID and GID of the given OS user
  Node.child.execFile("/usr/bin/id", ["-u", this.OSUser], function (err, stdout, stderr) {    // jshint ignore:line
    if (err) {
      pthis.log("ERROR", "Error getting UID: " + err, "User.assignOsUser", {osUser: pthis.OSUser});
      return callback("Error getting UID: " + err);
    }
    pthis.uid = stdout;
    //
    Node.child.execFile("/usr/bin/id", ["-g", pthis.OSUser], function (err, stdout, stderr) {   // jshint ignore:line
      if (err) {
        pthis.log("ERROR", "Error getting GID: " + err, "User.assignOsUser", {osUser: pthis.OSUser});
        return callback("Error getting GID: " + err);
      }
      pthis.gid = stdout;
      //
      // Done
      callback();
    });
  });
};


/**
 * Create the User folder if does not exist
 * @param {function} callback - function(err)
 */
Node.User.prototype.createUserFolder = function (callback)
{
  var pthis = this;
  var path = this.config.directory + "/" + this.userName;
  //
  // Create user folder
  Node.fs.mkdir(path, function (err) {
    if (err && err.code !== "EEXIST") {
      pthis.log("ERROR", "Error creating the user folder " + path + ": " + err, "User.createUserFolder");
      return callback("Error creating the user folder " + path + ": " + err);
    }
    //
    // Create DB directory
    Node.fs.mkdir(path + "/db", function (err) {
      if (err && err.code !== "EEXIST") {
        pthis.log("ERROR", "Error creating the user folder " + path + "/db" + ": " + err, "User.createUserFolder");
        return callback("Error creating the db folder " + path + "/db" + ": " + err);
      }
      //
      // If not local
      if (!pthis.config.local) {
        // Set ownership of all files and directories
        pthis.server.execFileAsRoot("ChownChmod", [pthis.OSUser, path], function (err, stdout, stderr) {   // jshint ignore:line
          if (err) {
            pthis.log("ERROR", "Error changing user folder permissions: " + (stderr || err), "User.createUserFolder",
                    {OSUser: pthis.OSUser, path: path});
            return callback("Error changing user folder permissions: " + (stderr || err));
          }
          //
          pthis.server.execFileAsRoot("ChownDBFolder", [path + "/db"], function (err, stdout, stderr) {   // jshint ignore:line
            if (err) {
              pthis.log("ERROR", "Error changing the database folder permissions: " + (stderr || err), "User.createUserFolder",
                      {path: path + "/db"});
              return callback("Error changing the database folder permissions: " + (stderr || err));
            }
            //
            // Done
            callback();
          });
        });
      }
      else
        callback();
    });
  });
};


/**
 * Find a project by name
 * @param {string} name
 * @returns {Node.Project}
 */
Node.User.prototype.getProject = function (name)
{
  for (var i = 0; i < this.projects.length; i++) {
    if (this.projects[i].name === name || this.projects[i].id === name)
      return this.projects[i];
  }
};


/**
 * Create a new project
 * @param {string} projectName
 * @param {function} callback (err or {err, msg, code})
 */
Node.User.prototype.createProject = function (projectName, callback)
{
  var pthis = this;
  //
  // Check if the prj already exists
  if (this.getProject(projectName)) {
    this.log("WARN", "Project already exists", "User.createProject", {project: projectName});
    return callback("Project already exists");
  }
  //
  // Create and initialize a new project
  var project = new Node.Project(this);
  project.init(projectName, function (err) {
    if (err)
      return callback(err);
    //
    // Add the project to the array and save the configuration
    pthis.projects.push(project);
    pthis.config.saveConfig();
    //
    // Log the project creation
    pthis.log("INFO", "Project created", "User.createProject", {project: projectName});
    //
    // Done
    callback();
  });
};


/**
 * Delete an existing project
 * @param {string} projectName
 * @param {function} callback (err or {err, msg, code})
 */
Node.User.prototype.deleteProject = function (projectName, callback)
{
  var pthis = this;
  //
  var project = this.getProject(projectName);
  if (!project) {
    this.log("WARN", "Project not found", "User.deleteProject", {project: projectName});
    return callback({code: 404, err: "Project not found"});
  }
  //
  // Delete the project folder
  project.deleteProjectFolder(function (err) {
    if (err)
      return callback(err);
    //
    // Delete the project from the projects array
    var index = pthis.projects.indexOf(project);
    pthis.projects.splice(index, 1);
    //
    // Save the new configuration
    pthis.config.saveConfig();
    //
    // Log the project deletion
    pthis.log("INFO", "Project removed", "User.deleteProject", {project: projectName});
    //
    // Done
    callback();
  });
};


/**
 * Find a database by name
 * @param {string} name
 */
Node.User.prototype.getDatabase = function (name)
{
  for (var i = 0; i < this.databases.length; i++) {
    if (this.databases[i].name === name)
      return this.databases[i];
  }
};


/**
 * Create a new database object
 * @param {string} dbName
 * @param {function} callback (err or {err, msg, code})
 */
Node.User.prototype.createDatabase = function (dbName, callback)
{
  var pthis = this;
  //
  // Check if the database already exists
  if (this.getDatabase(dbName)) {
    this.log("WARN", "Database already exists", "User.createDatabase", {database: dbName});
    return callback("Database already exists");
  }
  //
  // Create and initialize a new database
  var database = new Node.Database(this);
  database.init(dbName, function (err) {
    if (err)
      return callback(err);
    //
    // Add the database to the array and save the configuration
    pthis.databases.push(database);
    pthis.config.saveConfig();
    //
    // Log the database creation
    pthis.log("INFO", "Database created", "User.createDatabase", {database: dbName});
    //
    // Done
    callback();
  });
};


/**
 * Delete an existing database
 * @param {string} dbName
 * @param {function} callback (err or {err, msg, code})
 */
Node.User.prototype.deleteDatabase = function (dbName, callback)
{
  var pthis = this;
  //
  var database = this.getDatabase(dbName);
  if (!database) {
    this.log("WARN", "Database not found", "User.deleteDatabase", {database: dbName});
    return callback({code: 404, msg: "Database not found"});
  }
  //
  database.dropDb(function (err) {
    if (err)
      return callback(err);
    //
    var index = pthis.databases.indexOf(database);
    pthis.databases.splice(index, 1);
    //
    // Save the new configuration
    pthis.config.saveConfig();
    //
    // Log the db deletion
    pthis.log("INFO", "Database removed", "User.deleteDatabase", {database: dbName});
    //
    // Done
    callback();
  });
};


/**
 * Delete all User databases
 * @param {function} callback - function(err)
 */
Node.User.prototype.deleteAllDatabases = function (callback)
{
  var pthis = this;
  //
  // Define function that removes the first database
  var dropFirstDB = function () {
    // If there are no more database
    if (pthis.databases.length === 0) {
      // Remove user's DB environment
      Node.Database.cleanDbEnv(pthis, function (err) {
        callback(err);
      });
      return;
    }
    //
    // There are database to remove. Drop the first db in the list
    var db = pthis.databases[0];
    db.dropDb(function (err) {
      if (err)
        return callback(err);
      //
      // This has been removed, continue with next one
      pthis.databases.splice(0, 1);
      dropFirstDB();
    });
  };
  //
  // Drop first DB (if present)
  dropFirstDB();
};


/**
 * Delete the user folder (tablespace included)
 * @param {function} callback - function(err)
 */
Node.User.prototype.deleteUserFolder = function (callback)
{
  var pthis = this;
  var path = this.config.directory + "/" + this.userName;
  //
  var delUserDir = function () {
    Node.fs.rm(path, {recursive: true, force: true}, function (err) {
      if (err) {
        pthis.log("ERROR", "Error deleting the user folder " + path + " :" + err, "User.deleteUserFolder");
        return callback("Error deleting the user folder " + path + " :" + err);
      }
      //
      // Done
      callback();
    });
  };
  //
  // If we are in a true environment I need to launch a specific script to delete the tablespace
  if (!this.config.local) {
    this.server.execFileAsRoot("/bin/rm", ["-rf", path + "/db"], function (err, stdout, stderr) {   // jshint ignore:line
      if (err) {
        pthis.log("ERROR", "Error deleting the tablespace: " + (stderr || err), "User.deleteUserFolder",
                {OSUser: pthis.OSUser, path: path + "/db"});
        return callback("Error deleting the tablespace: " + (stderr || err));
      }
      //
      // Before deleting the user folder I want to be sure I'm able to do it -> fix permissions
      pthis.server.execFileAsRoot("ChownChmod", [pthis.OSUser, path], function (err, stdout, stderr) {   // jshint ignore:line
        if (err) {
          pthis.log("ERROR", "Error changing user folder permissions: " + (stderr || err), "User.deleteUserFolder",
                  {OSUser: pthis.OSUser, path: path});
          return callback("Error changing user folder permissions: " + (stderr || err));
        }
        //
        delUserDir();
      });
    });
  }
  else
    delUserDir();
};


/**
 * Backup the user
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.User.prototype.backup = function (params, callback)
{
  let path = Node.path.join(this.config.directory, this.userName);
  let tempPath = Node.path.join(this.config.directory, "tmp");
  let pathCloud = `users/${this.config.serverType}/${this.userName}/backups/${this.userName}.tar.gz`;
  //
  this.log("DEBUG", "User backup", "User.backup", {pathCloud});
  //
  // Error function: report error and clean up temp directory
  let errorFnc = msg => {
    this.log("ERROR", msg, "User.backup");
    callback(msg);
    //
    Node.fs.rm(Node.path.join(this.config.directory, "tmp"), {recursive: true, force: true}, err => {
      if (err)
        this.log("ERROR", `Error deleting the temporary folder ${this.config.directory}/tmp: ${err}`, "User.backup");
    });
  };
  //
  // Create a temporary (work) directory
  Node.fs.mkdir(tempPath, err => {
    if (err && err.code !== "EEXIST")
      return errorFnc(`Error creating the folder ${this.config.directory}/tmp: ${err}`);
    //
    let backupDir = () => {
      // Copy all the user folder except the db directory into the tmp folder
      let skipdb = item => item !== `${path}/db`;
      Node.ncp(path, Node.path.join(tempPath, this.userName), {filter: skipdb}, err => {
        if (err)
          return errorFnc(`Error copying the user folder ${path}: ${err}`);
        //
        // Write user's info into an index.json file
        let ws = Node.fs.createWriteStream(Node.path.join(tempPath, this.userName, "index.json"), {encoding: "utf8"});
        ws.write(this.saveUser());
        ws.end();
        //
        ws.on("error", err => errorFnc(`Error writing the file ${Node.path.join(tempPath, this.userName, "index.json")}: ${err}`));
        //
        ws.on("finish", () => {
          // Backup the tmp folder int the cloud
          let archiver = new Node.Archiver(this.server);
          archiver.backup(Node.path.join(tempPath, this.userName), pathCloud).then(() => {
            // Delete the tmp folder
            Node.fs.rm(tempPath, {recursive: true, force: true}, err => {
              if (err) {
                this.log("ERROR", `Error deleting the TEMP folder ${this.config.directory}/tmp (2): ${err}`, "User.backup");
                return callback(`Error deleting the temporary folder ${this.config.directory}/tmp: ${err}`);
              }
              //
              // Last, backup all user's databases
              this.backupDatabases(err => {
                if (err)
                  return callback(`Error backing up databases: ${err}`);
                //
                // Log the user backup
                this.log("INFO", "User backed up", "User.backup");
                //
                // Done!
                callback();
              });
            });
          }, err => errorFnc(`Error backing up the files: ${err}`));
        });
      });
    };
    //
    // Fix permissions if needed before backing up the user
    if (!this.config.local) {
      this.server.execFileAsRoot("ChownChmod", [this.OSUser, path], (err, stdout, stderr) => {
        if (err) {
          this.log("ERROR", `Error changing user folder permissions: ${stderr || err}`, "User.backup", {OSUser: this.OSUser, path});
          return callback(`Error changing user folder permissions: ${stderr || err}`);
        }
        //
        this.server.execFileAsRoot("ChownDBFolder", [`${path}/db`], (err, stdout, stderr) => {
          if (err) {
            this.log("ERROR", `Error changing database folder permissions: ${stderr || err}`, "User.backup", {path: `${path}/db`});
            return callback(`Error changing database folder permissions: ${stderr || err}`);
          }
          //
          backupDir();
        });
      });
    }
    else
      backupDir();
  });
};


/**
 * Backup the user's database
 * @param {function} callback (err)
 */
Node.User.prototype.backupDatabases = function (callback)
{
  var dbToBackup = this.databases.slice(0);
  //
  var backupDB = function () {
    if (dbToBackup.length === 0)     // No (more) DB -> done
      return callback();
    //
    // Backup first DB
    var db = dbToBackup[0];
    db.backup({}, function (err) {
      if (err)
        return callback(err);
      //
      // This has been backupped... continue with the next one
      dbToBackup.splice(0, 1);
      backupDB();
    });
  };
  //
  // Start with the first one
  backupDB();
};


/**
 * Restore the user
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.User.prototype.restore = function (params, callback)
{
  let path = Node.path.join(this.config.directory, this.userName);
  let pathCloud = `users/${this.config.serverType}/${this.userName}/backups/${this.userName}.tar.gz`;
  //
  this.log("DEBUG", "User restore", "User.restore", {pathCloud});
  //
  // Restore backup from the cloud
  let archiver = new Node.Archiver(this.server);
  archiver.restore(path, pathCloud).then(() => {
    let restoreDir = () => {
      let pathJSON = Node.path.join(this.config.directory, this.userName, "index.json");
      Node.fs.readFile(pathJSON, {encoding: "utf8"}, (err, file) => {
        if (err) {
          this.log("ERROR", `Error reading the file ${pathJSON}: ${err}`, "User.restore");
          return callback(`Error reading the file ${pathJSON}: ${err}`);
        }
        //
        // Load the user from the JSON file and save the current configuration
        this.loadUser(file);
        this.config.saveConfig();
        //
        // Delete the JSON file
        Node.fs.rm(pathJSON, {force: true}, err => {
          if (err) {
            this.log("ERROR", `Error deleting the file ${pathJSON}: ${err}`, "User.restore");
            return callback(`Error deleting the file ${pathJSON}: ${err}`);
          }
          //
          // Restore all user's DBs
          this.restoreDatabases(err => {
            if (err)
              return callback(`Error restoring databases: ${err}`);
            //
            // Log the user restore
            this.log("INFO", "Restore of user succeeded", "User.restore");
            //
            // Done
            callback();
          });
        });
      });
    };
    //
    // Create DB directory
    Node.fs.mkdir(Node.path.join(path, "db"), err => {
      if (err && err.code !== "EEXIST") {
        this.log("ERROR", `Error creating the user folder ${path}/db: ${err}`, "User.restore");
        return callback(`Error creating the user folder ${path}/db: ${err}`);
      }
      //
      // Fix permissions if needed then restore user directory
      if (!this.config.local) {
        this.server.execFileAsRoot("ChownChmod", [this.OSUser, path], (err, stdout, stderr) => {
          if (err) {
            this.log("ERROR", `Error changing the user folder permissions: ${stderr || err}`, "User.restore", {OSUser: this.OSUser, path});
            return callback(`Error changing the user folder permissions: ${stderr || err}`);
          }
          //
          this.server.execFileAsRoot("ChownDBFolder", [Node.path.join(path, "db")], (err, stdout, stderr) => {
            if (err) {
              this.log("ERROR", `Error changing the database folder permissions: ${stderr || err}`, "User.restore", {path: Node.path.join(path, "db")});
              return callback(`Error changing the database folder permissions: ${stderr || err}`);
            }
            //
            restoreDir();
          });
        });
      }
      else
        restoreDir();
    });
  }, err => callback(err));
};


/**
 * Restore all user's databases
 * @param {function} callback - function(err)
 */
Node.User.prototype.restoreDatabases = function (callback)
{
  var dbToRestore = this.databases.slice(0);
  //
  var restoreDB = function () {
    if (dbToRestore.length === 0)     // No (more) DB -> done
      return callback();
    //
    // Restore first DB
    var db = dbToRestore[0];
    db.init(db.name, function (err) {
      if (err)
        return callback(err);
      //
      db.restore({}, function (err) {
        if (err)
          return callback(err);
        //
        // This has been restored... continue with the next one
        dbToRestore.splice(0, 1);
        restoreDB();
      });
    });
  };
  //
  // Start with the first one
  restoreDB();
};


/**
 * Check user configuration
 * @param {function} callback - function(err)
 */
Node.User.prototype.check = function (callback)
{
  var pthis = this;
  //
  // If I'm the manager user, I'm fine
  if (this.userName === "manager")
    return callback();
  //
  // Couple the user with a system user (if needed)
  this.assignOsUser(function (err) {
    if (err)
      return callback(err);
    //
    // Create the user folder
    pthis.createUserFolder(function (err) {
      callback(err);
      //
      // Do this asynchronously... I don't care that much about the result
      for (var i = 0; i < pthis.projects.length; i++) {
        var prj = pthis.projects[i];
        prj.check(function (err) {
          pthis.log("ERROR", "Error while checking the project folder " + prj.name + ": " + err, "User.check", {project: prj.name});
        }); // jshint ignore:line
      }
    });
  });
};


/**
 * Create a new app
 * @param {string} appName
 * @return {Node.App}
 */
Node.User.prototype.createApp = function (appName)
{
  var app = new Node.App(this);
  this.apps.push(app);
  //
  // Init the app
  app.initApp(appName);
  //
  // Save the new configuration
  this.config.saveConfig();
  //
  return app;
};


/**
 * Delete an existing app
 * @param {Node.App} app
 */
Node.User.prototype.deleteApp = function (app)
{
  var idx = this.apps.indexOf(app);
  if (idx === -1)
    return this.log("WARN", "App not found", "User.deleteApp", {app: app.name});
  //
  this.apps.splice(idx, 1);
  //
  // Save the new configuration
  this.config.saveConfig();
};


/**
 * Search an app by name
 * @param {string} name
 */
Node.User.prototype.getApp = function (name)
{
  var lname = name.toLowerCase();
  for (var i = 0; i < this.apps.length; i++) {
    if (this.apps[i].name.toLowerCase() === lname)
      return this.apps[i];
  }
};


/**
 * Get the status of the user
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.User.prototype.sendStatus = function (params, callback)
{
  var pthis = this;
  //
  // If local -> can't compute user dir size
  if (this.config.local)
    return callback({msg: "OK"});
  //
  // Get the size of the user directory
  var path = this.config.directory + "/" + this.userName;
  this.server.execFileAsRoot("/usr/bin/du", ["-sh", path], function (err, stdout, stderr) {   // jshint ignore:line
    if (err) {
      pthis.log("ERROR", "Error getting the size of user folder: " + (stderr || err), "User.sendStatus", {path: path});
      return callback("Error getting the size of user folder: " + (stderr || err));
    }
    //
    var size = stdout.split("\t")[0];
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
    var status = {diskSize: size};
    callback({msg: JSON.stringify(status)});
  });
};


/**
 * List databases for the user
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.User.prototype.sendDatabasesList = function (params, callback)
{
  if (!this.databases.length)
    return callback({msg: JSON.stringify([])});
  //
  var databases = [];
  this.databases.forEach(function (db) {
    db.sendStatus(params, function (res) {   // For each database: database status
      if (typeof res === "string")
        return callback(res);
      //
      databases = databases.concat(JSON.parse(res.msg));
      if (databases.length === this.databases.length)
        return callback({msg: JSON.stringify(databases)});
    }.bind(this));
  }.bind(this));
};


/*
 * List all the apps for the user
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.User.prototype.sendAppsList = function (params, callback)
{
  if (!this.apps.length)
    return callback({msg: JSON.stringify([])});
  //
  var apps = [];
  this.apps.forEach(function (app) {
    app.sendStatus(params, function (res) {   // For each app: status
      if (typeof res === "string")
        return callback(res);
      //
      apps = apps.concat(JSON.parse(res.msg));
      if (apps.length === this.apps.length)
        return callback({msg: JSON.stringify(apps)});
    }.bind(this));
  }.bind(this));
};


/*
 * Send the projects list
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.User.prototype.sendProjectsList = function (params, callback)
{
  var projects = [];
  for (var i = 0; i < this.projects.length; i++)
    projects.push(this.projects[i].name);
  //
  callback({msg: JSON.stringify(projects)});
};


/*
 * Send the projects list in JSON format
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.User.prototype.sendProjectsListJson = function (params, callback)
{
  var projects = [];
  for (let prj of this.projects) {
    let prjData = {name: prj.name, lastSave: prj.lastSave, path: this.config.directory + "/" + this.userName};
    //
    let goodName = this.config.directory + "/" + this.userName + "/" + prj.name + "/project.json.good";
    if (Node.fs.existsSync(goodName)) 
      prjData.restoreDT = Node.fs.statSync(goodName).mtime.toISOString();
    //
    projects.push(prjData);
  }
  //
  callback({msg: JSON.stringify(projects)});
};


/*
 * Import a new IDF Project (local)
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.User.prototype.importPrj = function (params, callback)
{
  const path = require("path");
  var pthis = this;
  //
  try {
    let filePath = params.req.query.path;
    // extract the file name from the path
    let fileName = path.basename(filePath, path.extname(filePath));
    // call cleanName function
    let prjName = params.req.query.prjname || fileName;
    // Define target directory (user's directory)
    const targetDir = path.join(this.config.directory, this.userName);
    //
    const archiver = new Node.Archiver(this.server);
    archiver.unzip(filePath, targetDir).then((ris) => {
      if (ris) {
        let oldPath = path.join(targetDir, fileName + ".prj");
        if (!Node.fs.existsSync(oldPath))
          oldPath = path.join(targetDir, fileName + ".idm");
        if (!Node.fs.existsSync(oldPath))
          oldPath = path.join(targetDir, fileName + ".idp");
        const newPath = path.join(targetDir, prjName);
        setTimeout(() => {
          Node.fs.promises.rename(oldPath, newPath).then(() => {
            pthis.createProject(prjName, (ris) => {
              let p = pthis.getProject(prjName);
              p.lastSave = new Date();
              pthis.config.saveConfig();
              callback(ris);
            });
          });
        }, 1000);
      }
      else
        callback({msg: `Can't unzip file ${filePath}`});
    });
  }
  catch (e) {
    callback({msg: `Error while unzipping file ${filePath}: ${e}`});
  }
};



/*
 * Esport a project in zip format.
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.User.prototype.exportPrj = function (params, callback)
{
  const fullPath = params.req.query.path;
  const archiver = new Node.Archiver(this.server);
  archiver.zip(fullPath, {suffix: ".prj"})
  .then((result) => {
    console.log("User.exportPrj", result);
    callback({msg: result});
  })
  .catch((e) => {
    callback({error: `Error while exporting project ${fullPath}; ${e}`});
  })
};


/*
 * Send the list of sessions for all user's apps
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.User.prototype.sendAppSessions = function (params, callback)
{
  // Reply:
  //  sessions: {total number of sessions for all apps}
  //  app1: {
  //    sessions: {total number of sessions for the app1}
  //    workers: [{app1.worker 1 details}, {app1.worker 2 details}, ...]}  (see worker::getStatus)
  //  },
  //  app2: {
  //    sessions: {total number of sessions for the app2}
  //    workers: [{app2.worker 1 details}, {app2.worker 2 details}, ...]}  (see worker::getStatus)
  //  }, ...
  var appsess = {sessions: 0};
  //
  // If there are no apps I've done
  if (this.apps.length === 0)
    return callback({msg: JSON.stringify(appsess)});
  //
  // Add app's details
  var napp = 0;
  for (var i = 0; i < this.apps.length; i++) {
    var app = this.apps[i];
    //
    app.sendSessions(params, function (app, result) {
      // Add app's sessions
      var appdata = JSON.parse(result.msg);
      appsess[app.name] = appdata;
      appsess.sessions += appdata.sessions;
      //
      // If that's the last one, I can reply
      if (++napp === this.apps.length)
        callback({msg: JSON.stringify(appsess)});
    }.bind(this, app));    // jshint ignore:line
  }
};


/**
 * Set/update the user's profile
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.User.prototype.profileUser = function (params, callback)
{
  var pthis = this;
  //
  var form = new Node.multiparty.Form({uploadDir: this.config.directory + "/" + this.userName});
  form.parse(params.req, function (err, fields, files) {
    if (err) {
      pthis.log("ERROR", "Error while parsing request data: " + err, "User.profileUser");
      return callback("Error while parsing request data: " + err);
    }
    //
    if (fields.name)
      pthis.name = fields.name[0];
    if (fields.surname)
      pthis.surname = fields.surname[0];
    //
    // Handle image
    if (fields.file) {    // "file" string parameter -> delete previous image
      Node.fs.rm(pthis.config.directory + "/" + pthis.userName + "/" + pthis.IID, {force: true}, function (err) {
        if (err)
          pthis.log("ERROR", "Unable to remove previous image: " + err, "User.profileUser");
      });
      //
      delete pthis.IID;
    }
    else if (files.file && files.file.length) {   // "file" multi-part object -> add/replace image
      var oldIID = pthis.IID;
      //
      // Generate a new IID
      pthis.IID = Node.Utils.generateUID36();
      //
      // Move the file from the temporary path to the "final" destination
      var path = pthis.config.directory + "/" + pthis.userName + "/" + pthis.IID;
      Node.fs.rename(files.file[0].path, path, function (err) {
        if (err)
          return callback(err);
        //
        // Fix permissions
        pthis.server.execFileAsRoot("ChownChmod", [pthis.OSUser, path], function (err, stdout, stderr) {   // jshint ignore:line
          if (err) {
            pthis.log("ERROR", "Error changing user picture permissions: " + (stderr || err), "User.profileUser",
                    {OSUser: pthis.OSUser, path: path});
            return callback("Error changing user picture permissions: " + (stderr || err));
          }
          //
          // If there was an old image, remove the old one
          if (oldIID)
            Node.fs.rm(pthis.config.directory + "/" + pthis.userName + "/" + oldIID, {force: true}, function (err) {
              if (err)
                pthis.log("ERROR", "Unable to remove previous image: " + err, "User.profileUser");
            });
        });
      });
    }
    //
    pthis.config.saveConfig();
    callback();
  });
};


/**
 * Download a file from the client to the project folder
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.User.prototype.downloadProfilePic = function (params, callback)
{
  var pthis = this;
  //
  // If the user has no IID, do nothing
  if (!this.IID) {
    params.res.end();
    return callback({skipReply: true});
  }
  //
  // Path where the profile img is located
  var path = this.config.directory + "/" + this.userName + "/" + this.IID;
  Node.fs.readFile(path, function (err, data) {
    if (err) {
      pthis.log("ERROR", "Error reading the file " + path + ": " + err, "User.downloadProfilePic");
      return callback("Error reading the profile pic: " + err);
    }
    //
    params.res.end(data);
    callback({skipReply: true});
  });
};


/*
 * Add a device to the owner's list
 * @param {socket} socket
 * @param {object} data
 */
Node.User.prototype.addDevice = function (socket, data)
{
  var pthis = this;
  //
  // If this device is already present and I'm not waiting for a remove confermation (see later) -> error
  var device = this.getDeviceByUuid(data.deviceUuid);
  if (device && !device.removeTimerID) {
    this.log("WARN", "Device already connected", "User.addDevice", {device: data});
    socket.disconnect();
    return;
  }
  //
  // Fix the device name if a "similar one" is already connected for this user
  var deviceName = data.deviceName;
  var deviceNameSuffix = 1;
  while (this.getDeviceByName(deviceName))
    deviceName = data.deviceName + " " + deviceNameSuffix++;
  //
  // Listen for socket disconnect
  socket.on("disconnect", function () {
    // Socket disconnected. Don't remove now the device...
    // Procrastinate device removal and if the device comes back reuse it without saying anything to anyone
    device.removeTimerID = setTimeout(function () {
      pthis.log("DEBUG", "Device removed", "User.addDevice", {device: data});
      pthis.removeDevice(device);
    }, 3000);
    //
    // The device can't use this socket anymore... it has been disconnected!
    // It must reconnect or be removed
    delete device.socket;
    //
    pthis.log("DEBUG", "Device disconnected. Wait 3 sec for remove:", "User.addDevice", {device: data});
  });
  //
  // If I'm here with a valid device it means that a device has been disconnected less than 5 seconds ago
  if (device) {
    // Stop remove
    clearTimeout(device.removeTimerID);
    delete device.removeTimerID;
    //
    // Attach the new socket to the device that was disconnecting
    device.socket = socket;
    //
    this.log("DEBUG", "Device reused", "User.addDevice", {device: data});
  }
  else {
    // Add a new device
    device = new Node.Device(socket);
    device.init({userName: this.userName, deviceName: deviceName, deviceUuid: data.deviceUuid, deviceType: data.deviceType, deviceSID: data.sid});
    this.devices.push(device);
    //
    this.updateAvailableDevicesList("connected");
    //
    this.log("DEBUG", "Device connected", "User.addDevice", {device: data});
  }
};


/*
 * Remove a device from the owner's list
 * @param {Device} device
 */
Node.User.prototype.removeDevice = function (device)
{
  var idx = this.devices.indexOf(device);
  if (idx !== -1) {
    this.devices.splice(idx, 1);
    //
    this.updateAvailableDevicesList("disconnected");
  }
};


/*
 * Send to client's sessions the up to date list of connected devices
 * @param {string} event   (eg "disconnected" or "connected", used to fill in the notification text)
 */
Node.User.prototype.updateAvailableDevicesList = function (event)
{
  // Update all live session's device list
  var sessionList = this.server.getSessionListByUser(this.userName);
  var msg = {type: Node.User.msgTypeMap.deviceMsg, cnt: {type: "deviceList", event: event}};
  //
  for (var i = 0; i < sessionList.length; i++) {
    var ses = sessionList[i];
    //
    // Compute device list for this session and send the message
    msg.cnt.data = this.getUiDeviceList(ses);
    ses.sendToChild(msg);
  }
};


/*
 * Create a list of connected devices usable from PropertyView
 * @param {Node.IDESession} ses - ide session that will receive this list
 * @returns {Array}
 */
Node.User.prototype.getUiDeviceList = function (ses)
{
  var uiDeviceList = [];
  for (var i = 0; i < this.devices.length; i++) {
    var device = this.devices[i];
    //
    // If the device is valid only for a specific session and the session is not the right one, skip the device
    // If the device is not valid for a specific session add the device only if the session is a "true" (not readonly) IDE session
    if (device.deviceSID && ses.id !== device.deviceSID)
      continue;
    else if (!device.deviceSID && (ses.options.type !== "ide" || ses.options.readOnly))
      continue;
    //
    uiDeviceList.push({
      deviceName: device.deviceName,
      deviceUuid: device.deviceUuid,
      deviceType: device.deviceType
    });
  }
  //
  return uiDeviceList;
};


/*
 * Get a device given its Uuid
 * @param {string} deviceuuid
 * @returns {Device}
 */
Node.User.prototype.getDeviceByUuid = function (uuid)
{
  for (var i = 0; i < this.devices.length; i++) {
    if (this.devices[i].deviceUuid === uuid)
      return this.devices[i];
  }
};


/*
 * Get a device given its Name
 * @param {string} deviceName
 * @returns {Device}
 */
Node.User.prototype.getDeviceByName = function (deviceName)
{
  for (var i = 0; i < this.devices.length; i++) {
    if (this.devices[i].deviceName === deviceName)
      return this.devices[i];
  }
};


/*
 * Add a cloudConnector to the owner's list
 * @param {socket} socket
 * @param {object} data
 */
Node.User.prototype.addCloudConnector = function (socket, data)
{
  // Find if already exists
  let connector = this.cloudConnectors.find(cc => cc.socket === socket);
  let prevConnector = this.cloudConnectors.find(cc => cc.name === data.name);
  if (!connector && prevConnector) {
    if (!prevConnector.id || !data.id || prevConnector.id !== data.id) {
      this.log("WARN", "There is already a cloud connector connected with the same name but with different id. The new connection will be rejected.", "User.addCloudConnector", {connector: data.name, user: this.name, oldID: prevConnector.id, newID: data.id});
      socket.disconnect();
    }
    else {
      this.log("WARN", "There is already a cloud connector connected with the same name and same id. The new connection will replace the previous one.", "User.addCloudConnector", {connector: data.name, user: this.name, id: data.id});
      //
      // A reconnection occurred from the same cloud connector: I keep the new socket
      connector = prevConnector;
      //
      // I disconnect the old socket marking it as old
      connector.socket.old = true;
      connector.socket.disconnect();
      //
      connector.socket = socket;
    }
    return;
  }
  //
  let event = {name: data.name};
  if (!connector) {
    // Create a new cloudConnector instance
    connector = {
      socket,
      callbacks: []
    };
    //
    // Add the cloudConnector to the owner's list
    this.cloudConnectors.push(connector);
    event.connected = true;
  }
  else
    event.changed = true;
  //
  socket.on("disconnect", () => this.removeCloudConnector(socket));
  //
  Object.assign(connector, data);
  //
  this.updateAvailableCloudConnectorsList(event);
};


/*
 * Remove a cloudConnector from the owner's list
 * @param {socket} socket
 */
Node.User.prototype.removeCloudConnector = function (socket)
{
  // If the socket has been replaced by a new one of the same connector I do nothing
  if (socket.old)
    return;
  //
  for (let i = 0; i < this.cloudConnectors.length; i++) {
    if (this.cloudConnectors[i].socket === socket) {
      let cname = this.cloudConnectors[i].name;
      this.cloudConnectors.splice(i, 1);
      //
      clearInterval(socket.watchDog);
      //
      this.updateAvailableCloudConnectorsList({name: cname, connected: false});
      //
      // Search for all the sessions involving the user distpatch message to them
      let sessionList = this.server.getSessionListByUser(this.userName);
      let msg = {type: Node.User.msgTypeMap.cloudConnectorMsg, cnt: {type: "disconnect", data: {name: cname}}};
      //
      for (let j = 0; j < sessionList.length; j++)
        sessionList[j].sendToChild(msg);
      //
      if (this.userName === "manager")
        Object.values(this.server.appSessions).forEach(s => s.sendToChild(msg));
      break;
    }
  }
};


/*
 * Send to client's sessions the up to date list of connected cloudConnectors
 * @param {object} event   ({name: <cloud connector name>, connected: <true/false>})
 */
Node.User.prototype.updateAvailableCloudConnectorsList = function (event)
{
  // Search for all the sessions involving the user and talk to them
  var sessionList = this.server.getSessionListByUser(this.userName);
  var msg = {type: Node.User.msgTypeMap.cloudConnectorMsg, cnt: {type: "connectorList", event: event, data: this.getUiCloudConnectorsList()}};
  //
  for (var i = 0; i < sessionList.length; i++)
    sessionList[i].sendToChild(msg);
};


/*
 * Create a list of connected cloudConnectors usable from PropertyView
 * @returns {Array}
 */
Node.User.prototype.getUiCloudConnectorsList = function ()
{
  var list = [];
  for (var i = 0; i < this.cloudConnectors.length; i++)
    list.push({name: this.cloudConnectors[i].name, dmlist: this.cloudConnectors[i].dmlist});
  return list;
};


/*
 * Get a cloudConnector given info in msg
 * @param {Object} msg
 * @returns {Object}
 */
Node.User.prototype.getCloudConnector = function (msg)
{
  for (let i = 0; i < this.cloudConnectors.length; i++) {
    let cc = this.cloudConnectors[i];
    if (cc.name === msg.conn) {
      let list = [];
      let key = msg.key;
      let name;
      if (msg.data.dm) {
        list = cc.dmlist;
        name = msg.data.dm;
      }
      else if (msg.data.fs) {
        list = cc.fslist;
        name = msg.data.fs;
      }
      else if (msg.data.plugin) {
        list = cc.pluginslist;
        name = msg.data.plugin;
      }
      else if (msg.data.app)
        return cc;
      //
      for (let j = 0; j < list.length; j++) {
        let obj = list[j];
        if (obj.name === name && obj.key === key)
          return cc;
      }
    }
  }
};


/**
 * Handle a Cloud Connector message
 * @param {object} msg
 * @param {IDESession/Worker/Socket} sender
 */
Node.User.prototype.handleCloudConnectorMessage = function (msg, sender)
{
  switch (msg.type) {
    case "connectorListRequest":
      sender.sendToChild({
        type: Node.User.msgTypeMap.cloudConnectorMsg,
        cnt: {
          type: "connectorList",
          data: this.getUiCloudConnectorsList()
        }
      });
      break;

    case "remoteCmd":
      if (msg.data.cmd === "listCC") {
        let m = {};
        m.type = Node.User.msgTypeMap.cloudConnectorMsg;
        m.cnt = {
          type: "response",
          appid: msg.data.appid,
          sid: msg.data.sid,
          cbid: msg.data.cbid,
          app: true,
          data: {
            result: this.cloudConnectors.map(cc => {
              return {
                name: cc.name,
                version: cc.version,
                nodeVersion: cc.nodeVersion,
                hostname: cc.hostname
              };
            })
          }
        };
        return sender.sendToChild(m);
      }
      //
      let conn = this.getCloudConnector(msg);
      //
      // Connector not found -> invoke callback with error
      if (!conn) {
        if (msg.data.cbid) {
          let m = {};
          m.type = Node.User.msgTypeMap.cloudConnectorMsg;
          m.cnt = {
            type: "response",
            appid: msg.data.appid,
            cbid: msg.data.cbid,
            sid: msg.data.sid,
            data: {
              error: `Cloud connector '${msg.conn}' not found`
            }
          };
          if (msg.data.fs)
            m.cnt.fs = true;
          else if (msg.data.plugin)
            m.cnt.plugin = true;
          else if (msg.data.app)
            m.cnt.app = true;
          //
          sender.sendToChild(m);
        }
        return;
      }
      //
      // New command for remote configuration cause old cloud connectors to restart
      // It's better to protect
      if (msg.data.app && !conn.nodeVersion) {
        if (msg.data.cbid) {
          let m = {};
          m.type = Node.User.msgTypeMap.cloudConnectorMsg;
          m.cnt = {
            type: "response",
            appid: msg.data.appid,
            cbid: msg.data.cbid,
            sid: msg.data.sid,
            app: true,
            data: {error: `Command '${msg.data.cmd}' not supported by cloud connectors in versions prior to 21.0`}
          };
          //
          sender.sendToChild(m);
        }
        return;
      }
      //
      // Check if an exadecimal string need to be converted to ArrayBuffer
      if (msg?.data.args) {
        for (let i = 0; i < msg.data.args.length; i++) {
          let arg = msg.data.args[i];
          if (arg && typeof arg === "object" && arg._t === "buffer" && "data" in arg)
            msg.data.args[i] = Node.Utils.base64ToBuffer(arg.data);
        }
      }
      //
      // Send message to connector
      conn.socket.emit("cloudServerMsg", msg.data);
      //
      // Store callback function for invoke it when response comes
      if (msg.data.cbid)
        conn.callbacks[msg.data.cbid] = sender;
      break;

    case "response":
      for (let i = 0; i < this.cloudConnectors.length; i++) {
        let cc = this.cloudConnectors[i];
        if (cc.socket === sender) {
          let recipient = cc.callbacks[msg.cbid];
          if (!recipient)
            return false;
          //
          // Check if an ArrayBuffer need to be converted to exadecimal string
          if (msg.data.result instanceof Buffer)
            msg.data.result = {_t: "buffer", data: Node.Utils.bufferToBase64(msg.data.result)};
          if (msg.data.result?.body instanceof Buffer)
            msg.data.result.body = {_t: "buffer", data: Node.Utils.bufferToBase64(msg.data.result.body)};
          //
          recipient.sendToChild({type: Node.User.msgTypeMap.cloudConnectorMsg, cnt: msg});
          delete cc.callbacks[msg.cbid];
          return true;
        }
      }
      break;
  }
};


/**
 * Process the commands related to a project and call the execution of those related to the user
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.User.prototype.processCommand = function (params, callback)
{
  var pthis = this;
  //
  // If there is no project nor DB token, handle "basic" user commands
  // (http://servername/username/command)
  if (params.tokens.length === 1)
    return this.execCommand(params, callback);
  //
  // Project or DB or APP is there... handle project/db/app commands
  // (http://servername/username/projectname/command)
  // (http://servername/username/db/dbname/command)
  // (http://servername/username/app/appname/command)
  // (http://servername/manager/appname/command)    (if user is manager, "/app/" is not needed)
  var isDB = false;
  var isAPP = false;
  if (params.tokens[0] === "db") {
    isDB = true;
    //
    // Remove "db" from the list
    params.tokens.splice(0, 1);
  }
  else if (params.tokens[0] === "app") {
    isAPP = true;
    //
    // Remove "app" from the list
    params.tokens.splice(0, 1);
  }
  else if (this.userName === "manager")
    isAPP = true;
  //
  // Databases' name is not filtered by console -> trust callee
  var objName = (isDB ? params.tokens[0] : Node.Utils.clearName(params.tokens[0]));
  var command = params.tokens[1];
  //
  // Remove objName from the list
  params.tokens.splice(0, 1);
  //
  // If the authorization key is enabled and the given one does not match -> error
  // (do it only for "CREATE", "RESTORE" and "DELETE" commands 'cause other commands will handle it where it's needed)
  if (this.auth && params.req.query.autk !== this.autk && ["create", "restore", "delete"].indexOf(command) !== -1) {
    this.logger.log("WARN", "Unauthorized", "User.processCommand", {url: params.req.originalUrl});
    return callback({err: "Unauthorized", code: 401});
  }
  //
  // MANAGER user can't CREATE, DELETE or RESTORE projects... Only "true" users can do that
  if (this.userName === "manager" && ["create", "restore", "delete"].indexOf(command) !== -1 && !isDB && !isAPP) {
    this.logger.log("WARN", "Command can't be executed on the MANAGER user", "User.processCommand", {url: params.req.originalUrl});
    return callback("Command can't be executed on the MANAGER user");
  }
  //
  var project, database, app;
  switch (command) {
    case "create":
      if (isDB)
        this.createDatabase(objName, callback);
      else if (isAPP)
        callback("Not supported");
      else
        this.createProject(objName, callback);
      break;

    case "restore":
      if (isDB) {
        database = pthis.getDatabase(objName);
        if (!database) {
          // If the database does not exist, create a new one
          this.createDatabase(objName, function (err) {
            if (err)
              return callback(err);
            //
            database = pthis.getDatabase(objName);
            database.processCommand(params, function (err) {
              // If error -> delete database
              callback(err);
              if (err)
                pthis.deleteDatabase(objName, function () {
                });
            });
          });
        }
        else // The database exists -> restore (i.e. overwrite) it
          database.processCommand(params, callback);
      }
      else if (isAPP) {
        app = this.getApp(objName);
        if (!app) {
          // If the app does not exist, create a new one
          app = this.createApp(objName);
          app.processCommand(params, function (err) {
            // If error -> delete app
            callback(err);
            if (err)
              pthis.deleteApp(objName, function () {
              });
          });
        }
        else // The app exists -> restore (i.e. overwrite) it
          app.processCommand(params, callback);
      }
      else {
        this.createProject(objName, function (err) {
          if (err)
            return callback(err);
          //
          project = pthis.getProject(objName);
          project.processCommand(params, function (err) {
            // If error -> delete project
            callback(err);
            if (err)
              pthis.deleteProject(objName, function () {
              });
          });
        });
      }
      break;

    case "delete":
      if (isDB)
        this.deleteDatabase(objName, callback);
      else if (isAPP)
        callback("Not supported");
      else
        this.deleteProject(objName, callback);
      break;

    case "install":
      if (isAPP) {
        // If the app does not exists, create one
        var appCreated;
        app = this.getApp(objName);
        if (!app) {
          app = this.createApp(objName);
          appCreated = true;  // Remember that I've created a new app
        }
        app.processCommand(params, function (err) {
          if (err && appCreated)
            pthis.deleteApp(app);    // There is a problem and I've created the app  -> delete it
          callback(err);
        });
      }
      else
        callback("Not supported");
      break;

    default:
      if (isDB) {
        database = this.getDatabase(objName);
        if (!database) {
          this.log("WARN", "Database not found", "User.processCommand",
                  {cmd: command, database: objName, url: params.req.originalUrl});
          return callback({code: 404, err: "Database not found"});
        }
        //
        database.processCommand(params, callback);
      }
      else if (isAPP) {
        app = this.getApp(objName);
        if (!app) {
          this.log("WARN", "App not found", "User.processCommand",
                  {cmd: command, app: objName, url: params.req.originalUrl});
          return callback({code: 404, err: "App not found"});
        }
        //
        app.processCommand(params, callback);
      }
      else {
        project = this.getProject(objName);
        if (!project) {
          this.log("WARN", "Project not found", "User.processCommand",
                  {cmd: command, project: objName, url: params.req.originalUrl});
          return callback({code: 404, err: "Project not found"});
        }
        //
        project.processCommand(params, callback);
      }
      break;
  }
};


/*
 * Get IDF data
 */
Node.User.prototype.getData = function (params, callback)
{
  let version = this.parent.getIndeVersion(); // ad es 25.5.9620
  version += " r1"; // versione EXE
  version += "|0"; // numero di revisione installato (sempre 0)
  version += "|https://www.progamma.com/doc"; // note di rilascio
  version += "|1"; // versione attuale
  version += "|0"; // numero di revisioni disponibili (sempre 0)
  //
  let data = Object.assign({
    name: this.name,
    surname: this.surname,
    version: version
  }, this.idfdata);
  delete data.password;
  callback({msg: JSON.stringify(data)});
};


/*
 * Set IDF data and save user
 */
Node.User.prototype.setData = function (params, callback)
{
  try {
    let data = JSON.parse(params.req.query.data);
    this.name = data.name;
    this.surname = data.surname;
    delete data.name;
    delete data.surname;
    //
    // Get the new password or the decrypted password (we need it to call this.config.licSrvUpdateUser )
    data.password = data.password || this.decryptUserPassword(this.idfdata.password);  
    this.idfdata = data;
    this.config.licSrvUpdateUser(this).then(ris => {
      // Restore the encrypted password after the call
      this.idfdata.password = this.encryptUserPassword(this.idfdata.password);
      this.config.saveConfig();
      callback({msg: ris});
    });
  }
  catch (ex) {
    callback({msg: `ERROR ${ex}`});
  }
};


/**
 * Execute command for the user
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.User.prototype.execCommand = function (params, callback)
{
  var command = params.tokens[0];
  //
  // MANAGER user handles only APPS, DATABASES and SESSIONS commands
  if (this.userName === "manager" && ["apps", "databases", "appsessions"].indexOf(command) === -1) {
    this.log("WARN", "Invalid command for MANAGER", "User.execCommand", {url: params.req.originalUrl});
    return callback("Invalid command");
  }
  //
  // Handle commands
  switch (command) {
    case "picture":
      this.downloadProfilePic(params, callback);
      break;

    default:
      // If the authorization key is enabled and the given one does not match -> error
      if (this.config.auth && params.req.query.autk !== this.config.autk) {
        this.log("WARN", "Unauthorized", "User.execCommand", {url: params.req.originalUrl});
        return callback({err: "Unauthorized", code: 401});
      }
      //
      // Valid AUTK (or AUTK not enabled)
      switch (command) {
        case "status":
          this.sendStatus(params, callback);
          break;
        case "apps":
          this.sendAppsList(params, callback);
          break;
        case "databases":
          this.sendDatabasesList(params, callback);
          break;
        case "projects":
          this.sendProjectsList(params, callback);
          break;
        case "projects2":
          this.sendProjectsListJson(params, callback);
          break;
        case "importPrj":
          this.importPrj(params, callback);
          break;
        case "exportPrj":
          this.exportPrj(params, callback);
          break;
        case "appsessions":
          this.sendAppSessions(params, callback);
          break;
        case "profile":
          this.profileUser(params, callback);
          break;
        case "backup":
          this.backup(params, callback);
          break;
        case "restore":
          this.restore(params, callback);
          break;
        case "getdata":
          this.getData(params, callback);
          break;
        case "setdata":
          this.setData(params, callback);
          break;
        case "twListPrjs":
          this.listTeamWorksProjects(params, callback);
          break;
        case "twForkPrj":
          this.forkProjectFromTeamWorks(params, callback);
          break;
        default:
          this.log("WARN", "Invalid command", "User.execCommand", {cmd: command, url: params.req.originalUrl});
          callback("Invalid Command");
          break;
      }
  }
};

// Funzioni di cifratura reversibile per la password utente
const PASSWORD_KEY = Buffer.from('8NnZG70yHNRCfJzGqK7i0zyHCN7zMV1o', 'utf8'); // 32 bytes (256 bit)
const PASSWORD_IV = Buffer.from('TMSsPvq1a3bFQRH6', 'utf8'); // 16 bytes (128 bit)

Node.User.prototype.encryptUserPassword = function(password) {
  let cipher = Node.crypto.createCipheriv('aes-256-cbc', PASSWORD_KEY, PASSWORD_IV);
  let encrypted = cipher.update(password, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return encrypted;
};

Node.User.prototype.decryptUserPassword = function(encrypted) {
  let decipher = Node.crypto.createDecipheriv('aes-256-cbc', PASSWORD_KEY, PASSWORD_IV);
  let decrypted = decipher.update(encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};


/**
 * List TeamWorks projects available for this organization
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.User.prototype.listTeamWorksProjects = function (params, callback)
{
  // Check if TeamWorks module is active
  if (!this.config.isProductActive(Node.Utils.IdfModules.MOD_TW)) {
    this.log("WARN", "TeamWorks module is not active", "User.listTeamWorksProjects");
    return callback("TeamWorks module is not active");
  }
  //
  // Check if user has organization info
  if (!this.idfdata?.groupGuid || !this.idfdata?.group){
    this.log("WARN", "User has no organization info", "User.listTeamWorksProjects");
    return callback("User has no organization info");
  }
  //
  try {
    // Import TwGCloudDriver
    let TwGCloudDriver = require("../TW/TwGCloudDriver");
    //
    // Create a minimal driver instance for listing projects
    let driver = new TwGCloudDriver({
      child: {
        config: this.config,
        project: {
          user: this
        }
      }
    });
    //
    // List projects (listProjects is async)
    driver.listProjects().then(
      projects => callback({msg: JSON.stringify(projects || [])}),
      err => {
        this.log("ERROR", "Error listing TeamWorks projects: " + err.message, "User.listTeamWorksProjects");
        callback("Error listing TeamWorks projects: " + err.message);
      }
    );
  }
  catch (ex) {
    this.log("ERROR", "Error creating TeamWorks driver: " + ex.message, "User.listTeamWorksProjects");
    callback("ERROR", "Error creating TeamWorks driver: " + ex.message);
  }
};


/**
 * Fork project from TeamWorks
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.User.prototype.forkProjectFromTeamWorks = function (params, callback)
{
  // Check if TeamWorks module is active
  if (!this.config.isProductActive(Node.Utils.IdfModules.MOD_TW)) {
    this.log("WARN", "TeamWorks module is not active", "User.forkProjectFromTeamWorks");
    return callback("TeamWorks module is not active");
  }
  //
  let projectId = params.req.query.projectId;
  let projectName = params.req.query.projectName;
  //
  if (!projectId || !projectName){
    this.log("WARN", "Missing projectId or projectName", "User.forkProjectFromTeamWorks");
    return callback("Project to fork not found");
  }
  //
  // Check if user has organization info
  if (!this.idfdata?.groupGuid || !this.idfdata?.group) {
    this.log("WARN", "User has no organization info", "User.forkProjectFromTeamWorks");
    return callback("User has no organization");
  }
  //
  // Generate fork name: projectName-fork, projectName-fork1, projectName-fork2, etc.
  let baseName = projectName + "-fork";
  let finalProjectName = baseName;
  let counter = 0;

  // Check for existing forks and find available name
  while (this.getProject(finalProjectName)) {
    counter++;
    finalProjectName = baseName + counter;
  }
  //
  // Local path for the project (use the final fork name)
  let localPath = this.config.directory + "/" + this.userName + "/" + finalProjectName;
  //
  try {
    // Import TwGCloudDriver
    let TwGCloudDriver = require("../TW/TwGCloudDriver");
    //
    // Create a minimal driver instance for downloading projects
    let driver = new TwGCloudDriver({
      child: {
        config: this.config,
        project: {
          user: this
        }
      }
    });
    //
    // Download project from TeamWorks (downloadProject is async)
    driver.downloadProject(projectName, localPath)
      .then(
        () =>
        {
          // Create the project with the fork name
          this.createProject(finalProjectName, err =>
          {
            if (err) {
              this.log("ERROR", "Error creating fork: " + err, "User.forkProjectFromTeamWorks");
              return callback("Error creating fork");
            }
            //
            // Get the created project
            let newProject = this.getProject(finalProjectName);
            //
            // Set the project ID and TeamWorks properties
            newProject.updateInfo({twFork: true, lastSave: new Date()});
            //
            this.log("INFO", "Project forked from TeamWorks successfully", "User.forkProjectFromTeamWorks",
            {projectId: projectId, projectName: projectName, forkName: finalProjectName});
            callback({msg: "OK"});
          });
        },
        err => {
          this.log("ERROR", "Error downloading project from TeamWorks: " + err, "User.forkProjectFromTeamWorks");
          callback("Error downloading project");
        });
  }
  catch (ex) {
    this.log("ERROR", "Error creating TeamWorks driver: " + ex.message, "User.forkProjectFromTeamWorks");
    callback("Error accessing TeamWorks");
  }
};

// Export module
module.exports = Node.User;
