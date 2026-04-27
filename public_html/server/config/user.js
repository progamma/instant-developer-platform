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
    get() {
      return this.parent.parent;
    }
  },
  config: {
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
    idfdata: this.idfdata,
    devAgentOptions: this.devAgentOptions
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
  if (v.devAgentOptions)
    this.devAgentOptions = v.devAgentOptions;
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
  let r = this.save();
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
  this.projects?.forEach(project => project.setParent(this));
  this.databases?.forEach(database => database.setParent(this));
  this.apps?.forEach(app => app.setParent(this));
};


/**
 * Stringify this user
 */
Node.User.prototype.saveUser = function ()
{
  return JSON.stringify(this, (k, v) => {
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
  // I'm loading the user from the JSON file. This method is used inside the RESTORE method.
  // Here I have to be careful: the OSUser, UID, GID, and apps array that are inside the JSON
  // are, probably, wrong. They could come from a different server (if the RESTORE is a cross-server operation)
  // or they are from this server but in different times (the user has been backed up some time ago and it's
  // OSUser could, now, be occupied by someone else). I need to keep the current OSUser, UID and GID that have
  // been calculated when this user has been created.
  //
  // Save "system" data
  let old_OSUser = this.OSUser;
  let old_uid = this.uid;
  let old_gid = this.gid;
  //
  JSON.parse(s, (k, v) => {
    if (v instanceof Object && v.cl !== undefined) {
      let obj;
      if (v.cl === "Node.User")
        obj = this;
      if (v.cl === "Node.Database") {
        obj = new Node.Database(this);
        this.databases.push(obj);
      }
      if (v.cl === "Node.Project") {
        obj = new Node.Project(this);
        this.projects.push(obj);
      }
      if (v.cl === "Node.App") {
        obj = new Node.App(this);
        this.apps.push(obj);
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
 */
Node.User.prototype.init = async function (userName)
{
  this.userName = userName;
  //
  // Create a new random-dbPassword
  this.dbPassword = Node.crypto.randomBytes(16).toString("hex");
  //
  // If I'm the manager user, I don't need anything more
  if (this.userName === "manager")
    return;
  //
  // Assign an OS user and create the user folder
  await this.assignOsUser();
  await this.createUserFolder();
};


/**
 * Start default server session of all apps
 */
Node.User.prototype.startServerSessions = function ()
{
  // Notify event to my apps
  if (this.apps)
    for (let app of this.apps)
      app.startDefaultServerSession();
};


/**
 * Assign a system user to the user
 */
Node.User.prototype.assignOsUser = async function ()
{
  // If LOCAL do nothing
  if (this.config.local)
    return;
  //
  let logData;
  try {
    // If this user has not yet been coupled with an OS system user
    if (!this.OSUser) {
      // Find a "free" OS user
      let array = [];
      for (let i = 0; i < 300; i++)
        array[i] = true;
      //
      for (let i = 0; i < this.config.users.length; i++) {
        let OsU = this.config.users[i].OSUser;
        if (OsU) {
          let uidx = OsU.split("-")[OsU.split("-").length - 1];
          array[uidx] = false;
        }
      }
      //
      // Now get the first free user
      for (let i = 0; i < 300 && !this.OSUser; i++)
        if (array[i])
          this.OSUser = (process.platform === "freebsd" ? "indeuser-" : "user-") + i;
      //
      // If not found...
      if (!this.OSUser)
        throw new Error("No available OS users");
    }
    //
    // Now ask the system the UID and GID of the given OS user
    await new Promise((resolve, reject) => {
      Node.child.execFile("/usr/bin/id", ["-u", this.OSUser], (err, stdout, stderr) => {
        if (err) {
          logData = {osUser: this.OSUser};
          reject(new Error(`Error getting UID: ${err}`));
        }
        else {
          this.uid = stdout;
          resolve();
        }
      });
    });
    //
    await new Promise((resolve, reject) => {
      Node.child.execFile("/usr/bin/id", ["-g", this.OSUser], (err, stdout, stderr) => {
        if (err) {
          logData = {osUser: this.OSUser};
          reject(new Error(`Error getting GID: ${err}`));
        }
        else {
          this.gid = stdout;
          resolve();
        }
      });
    });
  }
  catch (err) {
    this.log("ERROR", err.message || err, "User.assignOsUser", logData);
    throw err;
  }
};


/**
 * Create the User folder if does not exist
 */
Node.User.prototype.createUserFolder = async function ()
{
  let path = Node.path.join(this.config.directory, this.userName);
  let logData;
  //
  try {
    // Create user folder
    try {
      await Node.fs.promises.mkdir(path);
    }
    catch (err) {
      if (err.code !== "EEXIST")
        throw new Error(`Error creating the user folder ${path}: ${err}`);
    }
    //
    // Create DB directory
    try {
      await Node.fs.promises.mkdir(Node.path.join(path, "db"));
    }
    catch (err) {
      if (err.code !== "EEXIST")
        throw new Error(`Error creating the db folder ${path}/db: ${err}`);
    }
    //
    // If not local
    if (!this.config.local) {
      // Set ownership of all files and directories
      try {
        await this.server.execFileAsRoot("ChownChmod", [this.OSUser, path]);
      }
      catch (err) {
        logData = {OSUser: this.OSUser, path};
        throw new Error(`Error changing user folder permissions: ${err}`);
      }
      //
      try {
        await this.server.execFileAsRoot("ChownDBFolder", [Node.path.join(path, "db")]);
      }
      catch (err) {
        logData = {path: Node.path.join(path, "db")};
        throw new Error(`Error changing the database folder permissions: ${err}`);
      }
    }
  }
  catch (err) {
    this.log("ERROR", err.message || err, "User.createUserFolder", logData);
    throw err;
  }
};


/**
 * Find a project by name
 * @param {string} name
 * @returns {Node.Project}
 */
Node.User.prototype.getProject = function (name)
{
  return this.projects.find(prj => prj.name === name || prj.id === name);
};


/**
 * Create a new project
 * @param {string} projectName
 */
Node.User.prototype.createProject = async function (projectName)
{
  // Check if the prj already exists
  if (this.getProject(projectName)) {
    this.log("WARN", "Project already exists", "User.createProject", {project: projectName});
    throw new Error("Project already exists");
  }
  //
  // Create and initialize a new project
  let project = new Node.Project(this);
  await project.init(projectName);
  //
  // Add the project to the array and save the configuration
  this.projects.push(project);
  this.config.saveConfig();
  //
  // Log the project creation
  this.log("INFO", "Project created", "User.createProject", {project: projectName});
};


/**
 * Delete an existing project
 * @param {string} projectName
 */
Node.User.prototype.deleteProject = async function (projectName)
{
  let project = this.getProject(projectName);
  if (!project) {
    this.log("WARN", "Project not found", "User.deleteProject", {project: projectName});
    throw {err: "Project not found", code: 404};
  }
  //
  // If there is an open session I can't delete the project!
  if (this.server.getOpenSession(project))
    throw {err: "Can't delete the project: open IDE session", code: 409};
  //
  // Delete the project folder
  await project.deleteProjectFolder();
  //
  // Delete the project from the projects array
  let index = this.projects.indexOf(project);
  this.projects.splice(index, 1);
  //
  // Save the new configuration
  this.config.saveConfig();
  //
  // Log the project deletion
  this.log("INFO", "Project removed", "User.deleteProject", {project: projectName});
};


/**
 * Find a database by name
 * @param {string} name
 */
Node.User.prototype.getDatabase = function (name)
{
  return this.databases.find(db => db.name === name);
};


/**
 * Create a new database object
 * @param {string} dbName
 */
Node.User.prototype.createDatabase = async function (dbName)
{
  // Check if the database already exists
  if (this.getDatabase(dbName)) {
    this.log("WARN", "Database already exists", "User.createDatabase", {database: dbName});
    throw new Error("Database already exists");
  }
  //
  // Create and initialize a new database
  let database = new Node.Database(this);
  await database.init(dbName);
  //
  // Add the database to the array and save the configuration
  this.databases.push(database);
  this.config.saveConfig();
  //
  // Log the database creation
  this.log("INFO", "Database created", "User.createDatabase", {database: dbName});
};


/**
 * Delete an existing database
 * @param {string} dbName
 */
Node.User.prototype.deleteDatabase = async function (dbName)
{
  let database = this.getDatabase(dbName);
  if (!database) {
    this.log("WARN", "Database not found", "User.deleteDatabase", {database: dbName});
    throw {err: "Database not found", code: 404};
  }
  //
  await database.dropDb();
  //
  let index = this.databases.indexOf(database);
  this.databases.splice(index, 1);
  //
  // Save the new configuration
  this.config.saveConfig();
  //
  // Log the db deletion
  this.log("INFO", "Database removed", "User.deleteDatabase", {database: dbName});
};


/**
 * Delete all User databases
 */
Node.User.prototype.deleteAllDatabases = async function ()
{
  // Drop all databases
  while (this.databases.length > 0) {
    let db = this.databases[0];
    await db.dropDb();
    this.databases.splice(0, 1);
  }
  //
  // Remove user's DB environment
  await Node.Database.cleanDbEnv(this);
};


/**
 * Delete the user folder (tablespace included)
 */
Node.User.prototype.deleteUserFolder = async function ()
{
  let path = Node.path.join(this.config.directory, this.userName);
  let logData;
  //
  try {
    // If we are in a true environment I need to launch a specific script to delete the tablespace
    if (!this.config.local) {
      try {
        await this.server.execFileAsRoot("/bin/rm", ["-rf", Node.path.join(path, "db")]);
      }
      catch (err) {
        logData = {OSUser: this.OSUser, path: Node.path.join(path, "db")};
        throw new Error(`Error deleting the tablespace: ${err}`);
      }
      //
      // Before deleting the user folder I want to be sure I'm able to do it -> fix permissions
      try {
        await this.server.execFileAsRoot("ChownChmod", [this.OSUser, path]);
      }
      catch (err) {
        logData = {OSUser: this.OSUser, path};
        throw new Error(`Error changing user folder permissions: ${err}`);
      }
    }
    //
    // Delete the user directory
    try {
      await Node.fs.promises.rm(path, {recursive: true, force: true});
    }
    catch (err) {
      throw new Error(`Error deleting the user folder ${path}: ${err}`);
    }
  }
  catch (err) {
    this.log("ERROR", err.message || err, "User.deleteUserFolder", logData);
    throw err;
  }
};


/**
 * Backup the user
 * @param {object} params
 */
Node.User.prototype.backup = async function (params)
{
  let path = Node.path.join(this.config.directory, this.userName);
  let tempPath = Node.path.join(this.config.directory, "tmp");
  let pathCloud = `users/${this.config.serverType}/${this.userName}/backups/${this.userName}.tar.gz`;
  //
  this.log("DEBUG", "User backup", "User.backup", {pathCloud});
  //
  let logData;
  try {
    let err;
    try {
      // Create a temporary (work) directory
      try {
        await Node.fs.promises.mkdir(tempPath);
      }
      catch (err) {
        if (err.code !== "EEXIST")
          throw new Error(`Error creating the folder ${this.config.directory}/tmp: ${err}`);
      }
      //
      // Fix permissions if needed before backing up the user
      if (!this.config.local) {
        try {
          await this.server.execFileAsRoot("ChownChmod", [this.OSUser, path]);
        }
        catch (err) {
          logData = {OSUser: this.OSUser, path};
          throw new Error(`Error changing user folder permissions: ${err}`);
        }
        //
        try {
          await this.server.execFileAsRoot("ChownDBFolder", [`${path}/db`]);
        }
        catch (err) {
          logData = {path: `${path}/db`};
          throw new Error(`Error changing database folder permissions: ${err}`);
        }
      }
      //
      // Copy all the user folder except the db directory into the tmp folder
      let skipdb = item => item !== `${path}/db`;
      await new Promise((resolve, reject) => {
        Node.ncp(path, Node.path.join(tempPath, this.userName), {filter: skipdb}, err => {
          if (err)
            reject(new Error(`Error copying the user folder ${path}: ${err}`));
          else
            resolve();
        });
      });
      //
      // Write user's info into an index.json file
      await new Promise((resolve, reject) => {
        let ws = Node.fs.createWriteStream(Node.path.join(tempPath, this.userName, "index.json"), {encoding: "utf8"});
        ws.write(this.saveUser());
        ws.end();
        //
        ws.on("error", err => reject(new Error(`Error writing the file ${Node.path.join(tempPath, this.userName, "index.json")}: ${err}`)));
        ws.on("finish", () => resolve());
      });
      //
      // Backup the tmp folder int the cloud
      let archiver = new Node.Archiver(this.server);
      try {
        await archiver.backup(Node.path.join(tempPath, this.userName), pathCloud);
      }
      catch (err) {
        throw new Error(`Error backing up the files: ${err}`);
      }
      //
      // Last, backup all user's databases
      try {
        await this.backupDatabases();
      }
      catch (err) {
        throw new Error(`Error backing up databases: ${err}`);
      }
      //
      // Log the user backup
      this.log("INFO", "User backed up", "User.backup");
    }
    catch (e) {
      err = e;
      throw e;
    }
    finally {
      // Delete the tmp folder
      try {
        await Node.fs.promises.rm(tempPath, {recursive: true, force: true});
      }
      catch (e) {
        if (!err)
          err = new Error(`Error deleting the temporary folder ${this.config.directory}/tmp: ${e}`);
      }
    }
    //
    if (err)
      throw err;
  }
  catch (err) {
    this.log("ERROR", err.message || err, "User.backup", logData);
    throw err;
  }

};


/**
 * Backup the user's database
 */
Node.User.prototype.backupDatabases = async function ()
{
  for (let db of this.databases)
    await db.backup();
};


/**
 * Restore the user
 * @param {object} params
 */
Node.User.prototype.restore = async function (params)
{
  let path = Node.path.join(this.config.directory, this.userName);
  let pathCloud = `users/${this.config.serverType}/${this.userName}/backups/${this.userName}.tar.gz`;
  let logData;
  //
  this.log("DEBUG", "User restore", "User.restore", {pathCloud});
  //
  // Restore backup from the cloud
  let archiver = new Node.Archiver(this.server);
  await archiver.restore(path, pathCloud);
  //
  try {
    // Create DB directory
    try {
      await Node.fs.promises.mkdir(Node.path.join(path, "db"));
    }
    catch (err) {
      if (err.code !== "EEXIST")
        throw new Error(`Error creating the user folder ${path}/db: ${err}`);
    }
    //
    // Fix permissions if needed then restore user directory
    if (!this.config.local) {
      try {
        await this.server.execFileAsRoot("ChownChmod", [this.OSUser, path]);
      }
      catch (err) {
        logData = {OSUser: this.OSUser, path};
        throw new Error(`Error changing the user folder permissions: ${err}`);
      }
      //
      try {
        await this.server.execFileAsRoot("ChownDBFolder", [Node.path.join(path, "db")]);
      }
      catch (err) {
        logData = {path: Node.path.join(path, "db")};
        throw new Error(`Error changing the database folder permissions: ${err}`);
      }
    }
    //
    // Read and load user data from JSON file
    let pathJSON = Node.path.join(this.config.directory, this.userName, "index.json");
    let file;
    try {
      file = await Node.fs.promises.readFile(pathJSON, {encoding: "utf8"});
    }
    catch (err) {
      throw new Error(`Error reading the file ${pathJSON}: ${err}`);
    }
    //
    // Load the user from the JSON file and save the current configuration
    this.loadUser(file);
    this.config.saveConfig();
    //
    // Delete the JSON file
    try {
      await Node.fs.promises.rm(pathJSON, {force: true});
    }
    catch (err) {
      throw new Error(`Error deleting the file ${pathJSON}: ${err}`);
    }
    //
    // Restore all user's DBs
    try {
      await this.restoreDatabases();
    }
    catch (err) {
      throw new Error(`Error restoring databases: ${err}`);
    }
    //
    // Log the user restore
    this.log("INFO", "Restore of user succeeded", "User.restore");
  }
  catch (err) {
    this.log("ERROR", err.message || err, "User.restore", logData);
    throw err;
  }
};


/**
 * Restore all user's databases
 */
Node.User.prototype.restoreDatabases = async function ()
{
  for (let db of this.databases) {
    await db.init(db.name);
    await db.restore();
  }
};


/**
 * Check user configuration
 */
Node.User.prototype.check = async function ()
{
  // If I'm the manager user, I'm fine
  if (this.userName === "manager")
    return;
  //
  // Couple the user with a system user (if needed)
  await this.assignOsUser();
  //
  try {
    // Create the user folder
    await this.createUserFolder();
  }
  finally {
    // Do this asynchronously... I don't care that much about the result
    for (let prj of this.projects) {
      try {
        await prj.check();
      }
      catch(err) {
        this.log("ERROR", `Error while checking the project folder ${prj.name}: ${err}`, "User.check", {project: prj.name});
      }
    }
  }
};


/**
 * Create a new app
 * @param {string} appName
 * @return {Node.App}
 */
Node.User.prototype.createApp = function (appName)
{
  let app = new Node.App(this);
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
  let idx = this.apps.indexOf(app);
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
  let lname = name.toLowerCase();
  return this.apps.find(app => app.name.toLowerCase() === lname);
};


/**
 * Get the status of the user
 * @param {object} params
 */
Node.User.prototype.sendStatus = async function (params)
{
  // If local -> can't compute user dir size
  if (this.config.local)
    return {msg: "OK"};
  //
  // Get the size of the user directory
  let path = Node.path.join(this.config.directory, this.userName);
  try {
    let stdout = await this.server.execFileAsRoot("/usr/bin/du", ["-sh", path]);
    let size = stdout.split("\t")[0];
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
    return {msg: JSON.stringify({diskSize: size})};
  }
  catch (err) {
    this.log("ERROR", `Error getting the size of user folder: ${err}`, "User.sendStatus", {path});
    throw new Error(`Error getting the size of user folder: ${err}`);
  }
};


/**
 * List databases for the user
 * @param {object} params
 */
Node.User.prototype.sendDatabasesList = async function (params)
{
  let databases = [];
  for (let db of this.databases) {
    let res = await db.sendStatus(params);
    databases = databases.concat(JSON.parse(res.msg));
  }
  //
  return {msg: JSON.stringify(databases)};
};


/*
 * List all the apps for the user
 * @param {object} params
 */
Node.User.prototype.sendAppsList = async function (params)
{
  let apps = [];
  for (let app of this.apps) {
    let res = await app.sendStatus(params);
    apps.push(JSON.parse(res.msg));
  }
  //
  return {msg: JSON.stringify(apps)};
};


/*
 * Send the projects list
 * @param {object} params
 */
Node.User.prototype.sendProjectsList = function (params)
{
  let projects = this.projects.map(prj => prj.name);
  return {msg: JSON.stringify(projects)};
};


/*
 * Send the projects list in JSON format
 * @param {object} params
 */
Node.User.prototype.sendProjectsListJson = async function (params)
{
  let projects = [];
  for (let prj of this.projects) {
    let prjData = {
      name: prj.name,
      lastSave: prj.lastSave,
      path: Node.path.join(this.config.directory, this.userName)
    };
    //
    let goodName = Node.path.join(this.config.directory, this.userName, prj.name, "project.json.good");
    if (Node.fs.existsSync(goodName))
      prjData.restoreDT = (await Node.fs.promises.stat(goodName)).mtime.toISOString();
    //
    projects.push(prjData);
  }
  //
  return {msg: JSON.stringify(projects)};
};


/*
 * Import a new IDF Project (local)
 * @param {object} params
 */
Node.User.prototype.importPrj = async function (params)
{
  // Get the file path from query parameters
  let filePath = params.req.query.path;
  //
  try {
    //
    // Extract the file name from the path
    let fileName = Node.path.basename(filePath, Node.path.extname(filePath));
    //
    // Get the project name from query or filename
    let prjName = params.req.query.prjname || fileName;
    //
    // Define target directory (user's directory)
    let targetDir = Node.path.join(this.config.directory, this.userName);
    //
    // Unzip the project file to the target directory
    let archiver = new Node.Archiver(this.server);
    let ris = await archiver.unzip(filePath, targetDir);
    if (!ris)
      throw new Error(`Unable to unzip file ${filePath}`);
    //
    // Wait for file system to settle after unzip
    await new Promise(resolve => setTimeout(resolve, 1000));
    //
    // Find the extracted folder — try known extensions with the zip filename first,
    // then look for any newly created folder with a project extension
    let oldPath = Node.path.join(targetDir, `${fileName}.prj`);
    if (!Node.fs.existsSync(oldPath))
      oldPath = Node.path.join(targetDir, `${fileName}.idm`);
    if (!Node.fs.existsSync(oldPath))
      oldPath = Node.path.join(targetDir, `${fileName}.idp`);
    if (!Node.fs.existsSync(oldPath))
      oldPath = Node.path.join(targetDir, fileName);
    if (!Node.fs.existsSync(oldPath)) {
      // The zip contained a folder with a different name — scan for it
      let entries = await Node.fs.promises.readdir(targetDir, {withFileTypes: true});
      let found = entries.find(e => e.isDirectory() && (e.name.endsWith(".prj") || e.name.endsWith(".idm") || e.name.endsWith(".idp")) &&
              !this.getProject(Node.path.basename(e.name, Node.path.extname(e.name))));
      if (found)
        oldPath = Node.path.join(targetDir, found.name);
    }
    //
    let newPath = Node.path.join(targetDir, prjName);
    //
    // Rename the unzipped folder to the project name
    await Node.fs.promises.rename(oldPath, newPath);
    //
    // Create the project in the user's project list
    await this.createProject(prjName);
    //
    // Update project's last save timestamp and save configuration
    this.getProject(prjName).lastSave = new Date();
    //
    this.config.saveConfig();
  }
  catch (err) {
    throw new Error(`Error while unzipping file ${filePath}: ${err}`);
  }
};


/*
 * Esport a project in zip format.
 * @param {object} params
 */
Node.User.prototype.exportPrj = async function (params)
{
  let fullPath = params.req.query.path;
  let archiver = new Node.Archiver(this.server);
  try {
    let result = await archiver.zip(fullPath, {suffix: ".prj"});
    return {msg: result};
  }
  catch (err) {
    throw new Error(`Error while exporting project ${fullPath}; ${err}`);
  }
};


/*
 * Send the list of sessions for all user's apps
 * @param {object} params
 */
Node.User.prototype.sendAppSessions = async function (params)
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
  let appsess = {sessions: 0};
  //
  // Add app's details
  for (let app of this.apps) {
    let result = await app.sendSessions(params);
    // Add app's sessions
    let appdata = JSON.parse(result.msg);
    appsess[app.name] = appdata;
    appsess.sessions += appdata.sessions;
  }
  //
  return {msg: JSON.stringify(appsess)};
};


/**
 * Set/update the user's profile
 * @param {object} params
 */
Node.User.prototype.profileUser = async function (params)
{
  let form = new Node.multiparty.Form({uploadDir: Node.path.join(this.config.directory, this.userName)});
  //
  // Parse the multipart form data
  let {fields, files} = await new Promise((resolve, reject) => {
    form.parse(params.req, (err, fields, files) => {
      if (err) {
        this.log("ERROR", `Error while parsing request data: ${err}`, "User.profileUser");
        reject(new Error(`Error while parsing request data: ${err}`));
      }
      else
        resolve({fields, files});
    });
  });
  //
  if (fields.name)
    this.name = fields.name[0];
  if (fields.surname)
    this.surname = fields.surname[0];
  //
  // Handle image
  if (fields.file) {    // "file" string parameter -> delete previous image
    try {
      await Node.fs.promises.rm(Node.path.join(this.config.directory, this.userName, this.IID), {force: true});
    }
    catch (err) {
      this.log("ERROR", `Unable to remove previous image: ${err}`, "User.profileUser");
    }
    //
    delete this.IID;
  }
  else if (files.file?.length) {   // "file" multi-part object -> add/replace image
    let oldIID = this.IID;
    //
    // Generate a new IID
    this.IID = Node.Utils.generateUID36();
    //
    // Move the file from the temporary path to the "final" destination
    let path = Node.path.join(this.config.directory, this.userName, this.IID);
    await Node.fs.promises.rename(files.file[0].path, path);
    //
    // Fix permissions
    try {
      await this.server.execFileAsRoot("ChownChmod", [this.OSUser, path]);
    }
    catch (err) {
      this.log("ERROR", `Error changing user picture permissions: ${err}`, "User.profileUser",
              {OSUser: this.OSUser, path});
      throw new Error(`Error changing user picture permissions: ${err}`);
    }
    //
    // If there was an old image, remove the old one
    if (oldIID) {
      try {
        await Node.fs.promises.rm(Node.path.join(this.config.directory, this.userName, oldIID), {force: true});
      }
      catch (err) {
        this.log("ERROR", `Unable to remove previous image: ${err}`, "User.profileUser");
      }
    }
  }
  //
  this.config.saveConfig();
};


/**
 * Download a file from the client to the project folder
 * @param {object} params
 */
Node.User.prototype.downloadProfilePic = async function (params)
{
  // If the user has no IID, do nothing
  if (!this.IID) {
    params.res.end();
    return {skipReply: true};
  }
  //
  // Path where the profile img is located
  let path = Node.path.join(this.config.directory, this.userName, this.IID);
  try {
    let data = await Node.fs.promises.readFile(path);
    params.res.end(data);
    return {skipReply: true};
  }
  catch (err) {
    this.log("ERROR", `Error reading the file ${path}: ${err}`, "User.downloadProfilePic");
    throw new Error(`Error reading the profile pic: ${err}`);
  }
};


/*
 * Add a device to the owner's list
 * @param {socket} socket
 * @param {object} data
 */
Node.User.prototype.addDevice = function (socket, data)
{
  // If this device is already present and I'm not waiting for a remove confermation (see later) -> error
  let device = this.getDeviceByUuid(data.deviceUuid);
  if (device && !device.removeTimerID) {
    this.log("WARN", "Device already connected", "User.addDevice", {device: data});
    socket.disconnect();
    return;
  }
  //
  // Fix the device name if a "similar one" is already connected for this user
  let deviceName = data.deviceName;
  let deviceNameSuffix = 1;
  while (this.getDeviceByName(deviceName))
    deviceName = `${data.deviceName} ${deviceNameSuffix++}`;
  //
  // Listen for socket disconnect
  socket.on("disconnect", () => {
    // Socket disconnected. Don't remove now the device...
    // Procrastinate device removal and if the device comes back reuse it without saying anything to anyone
    device.removeTimerID = setTimeout(() => {
      this.log("DEBUG", "Device removed", "User.addDevice", {device: data});
      this.removeDevice(device);
    }, 3000);
    //
    // The device can't use this socket anymore... it has been disconnected!
    // It must reconnect or be removed
    delete device.socket;
    //
    this.log("DEBUG", "Device disconnected. Wait 3 sec for remove:", "User.addDevice", {device: data});
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
    device.init({
      userName: this.userName,
      deviceName,
      deviceUuid: data.deviceUuid,
      deviceType: data.deviceType,
      deviceSID: data.sid
    });
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
  let idx = this.devices.indexOf(device);
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
  let sessionList = this.server.getSessionListByUser(this.userName);
  //
  for (let ses of sessionList) {
    // Compute device list for this session and send the message
    ses.sendToChild({
      type: Node.User.msgTypeMap.deviceMsg,
       cnt: {
        type: "deviceList",
        event,
        data: this.getUiDeviceList(ses)
      }
    });
  }
};


/*
 * Create a list of connected devices usable from PropertyView
 * @param {Node.IDESession} ses - ide session that will receive this list
 * @returns {Array}
 */
Node.User.prototype.getUiDeviceList = function (ses)
{
  let uiDeviceList = [];
  for (let device of this.devices) {
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
  return this.devices.find(device => device.deviceUuid === uuid);
};


/*
 * Get a device given its Name
 * @param {string} deviceName
 * @returns {Device}
 */
Node.User.prototype.getDeviceByName = function (deviceName)
{
  return this.devices.find(device => device.deviceName === deviceName);
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
      pendingCallers: []
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
  for (let cc of this.cloudConnectors) {
    if (cc.socket === socket) {
      let cname = cc.name;
      this.cloudConnectors.splice(this.cloudConnectors.indexOf(cc), 1);
      //
      clearInterval(socket.watchDog);
      //
      this.updateAvailableCloudConnectorsList({name: cname, connected: false});
      //
      // Search for all the sessions involving the user distpatch message to them
      let sessionList = this.server.getSessionListByUser(this.userName);
      let msg = {type: Node.User.msgTypeMap.cloudConnectorMsg, cnt: {type: "disconnect", data: {name: cname}}};
      //
      for (let sess of sessionList)
        sess.sendToChild(msg);
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
  let sessionList = this.server.getSessionListByUser(this.userName);
  let msg = {
    type: Node.User.msgTypeMap.cloudConnectorMsg,
    cnt: {
      type: "connectorList",
      event,
      data: this.getUiCloudConnectorsList()
    }
  };
  //
  for (let sess of sessionList)
    sess.sendToChild(msg);
};


/*
 * Create a list of connected cloudConnectors usable from PropertyView
 * @returns {Array}
 */
Node.User.prototype.getUiCloudConnectorsList = function ()
{
  return this.cloudConnectors.map(cc => {
    return {
      name: cc.name,
      version: cc.version,
      nodeVersion: cc.nodeVersion,
      hostname: cc.hostname,
      dmlist: cc.dmlist
    };
  });
};


/*
 * Get a cloudConnector given info in msg
 * @param {Object} msg
 * @returns {Object}
 */
Node.User.prototype.getCloudConnector = function (msg)
{
  for (let cc of this.cloudConnectors) {
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

    case "remoteCmd": {
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
      let cc = this.getCloudConnector(msg);
      //
      // Connector not found -> reply to caller with error
      if (!cc) {
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
      if (msg.data.app && !cc.nodeVersion) {
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
      cc.socket.emit("cloudServerMsg", msg.data);
      //
      // Store caller for respond it when response comes
      if (msg.data.cbid)
        cc.pendingCallers[msg.data.cbid] = sender;
      break;
    }

    case "response":
      for (let cc of this.cloudConnectors) {
        if (cc.socket === sender) {
          let recipient = cc.pendingCallers[msg.cbid];
          if (!recipient)
            return false;
          //
          // Check if an ArrayBuffer need to be converted to exadecimal string
          if (msg.data.result instanceof Buffer)
            msg.data.result = {_t: "buffer", data: Node.Utils.bufferToBase64(msg.data.result)};
          if (msg.data.result?.body instanceof Buffer)
            msg.data.result.body = {_t: "buffer", data: Node.Utils.bufferToBase64(msg.data.result.body)};
          //
          recipient.sendToChild({
            type: Node.User.msgTypeMap.cloudConnectorMsg,
            cnt: msg
          });
          delete cc.pendingCallers[msg.cbid];
          return true;
        }
      }
      break;
  }
};


/**
 * Process the commands related to a project and call the execution of those related to the user
 * @param {object} params
 */
Node.User.prototype.processCommand = async function (params)
{
  // If there is no project nor DB token, handle "basic" user commands
  // (http://servername/username/command)
  if (params.tokens.length === 1)
    return await this.execCommand(params);
  //
  // Project or DB or APP is there... handle project/db/app commands
  // (http://servername/username/projectname/command)
  // (http://servername/username/db/dbname/command)
  // (http://servername/username/app/appname/command)
  // (http://servername/manager/appname/command)    (if user is manager, "/app/" is not needed)
  let isDB = false;
  let isAPP = false;
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
  let objName = (isDB ? params.tokens[0] : Node.Utils.clearName(params.tokens[0]));
  let command = params.tokens[1];
  //
  // Remove objName from the list
  params.tokens.splice(0, 1);
  //
  // If the authorization key is enabled and the given one does not match -> error
  // (do it only for "CREATE", "RESTORE" and "DELETE" commands 'cause other commands will handle it where it's needed)
  if (this.auth && params.req.query.autk !== this.autk && ["create", "restore", "delete"].includes(command)) {
    this.logger.log("WARN", "Unauthorized", "User.processCommand", {url: params.req.originalUrl});
    throw {err: "Unauthorized", code: 401};
  }
  //
  // MANAGER user can't CREATE, DELETE or RESTORE projects... Only "true" users can do that
  if (this.userName === "manager" && ["create", "restore", "delete"].includes(command) && !isDB && !isAPP) {
    this.logger.log("WARN", "Command can't be executed on the MANAGER user", "User.processCommand", {url: params.req.originalUrl});
    throw new Error("Command can't be executed on the MANAGER user");
  }
  //
  switch (command) {
    case "create":
      if (isDB)
        return await this.createDatabase(objName);
      else if (isAPP)
        throw new Error("Not supported");
      else
        return await this.createProject(objName);

    case "restore":
      if (isDB) {
        let isNew = false;
        let database = this.getDatabase(objName);
        if (!database) {
          // If the database does not exist, create a new one
          await this.createDatabase(objName);
          database = this.getDatabase(objName);
          isNew = true;
        }
        //
        try {
          await database.processCommand(params);
        }
        catch (err) {
          // If error -> delete database
          if (isNew)
            await this.deleteDatabase(objName).catch(() => {});
          throw err;
        }
      }
      else if (isAPP) {
        let isNew;
        let app = this.getApp(objName);
        if (!app) {
          // If the app does not exist, create a new one
          app = this.createApp(objName);
          isNew = true;
        }
        //
        try {
          await app.processCommand(params);
        }
        catch (err) {
          if (isNew)
            this.deleteApp(objName);
          throw err;
        }
      }
      else {
        await this.createProject(objName);
        let project = this.getProject(objName);
        try {
          await project.processCommand(params);
        }
        catch (err) {
          // If error -> delete project
          await this.deleteProject(objName).catch(() => {});
          throw err;
        }
      }
      break;

    case "delete":
      if (isDB)
        return await this.deleteDatabase(objName);
      else if (isAPP)
        throw new Error("Not supported");
      else
        return await this.deleteProject(objName);

    case "install":
      if (isAPP) {
        // If the app does not exists, create one
        let isNew;
        let app = this.getApp(objName);
        if (!app) {
          app = this.createApp(objName);
          isNew = true;  // Remember that I've created a new app
        }
        //
        try {
          await app.processCommand(params);
        }
        catch (err) {
          if (isNew)
            this.deleteApp(app);    // There is a problem and I've created the app  -> delete it
          throw err;
        }
      }
      else
        throw new Error("Not supported");
      break;

    default:
      if (isDB) {
        let database = this.getDatabase(objName);
        if (!database) {
          this.log("WARN", "Database not found", "User.processCommand",
                  {cmd: command, database: objName, url: params.req.originalUrl});
          throw {err: "Database not found", code: 404};
        }
        //
        return await database.processCommand(params);
      }
      else if (isAPP) {
        let app = this.getApp(objName);
        if (!app) {
          this.log("WARN", "App not found", "User.processCommand",
                  {cmd: command, app: objName, url: params.req.originalUrl});
          throw {err: "App not found", code: 404};
        }
        //
        return await app.processCommand(params);
      }
      else {
        let project = this.getProject(objName);
        if (!project) {
          this.log("WARN", "Project not found", "User.processCommand",
                  {cmd: command, project: objName, url: params.req.originalUrl});
          throw {err: "Project not found", code: 404};
        }
        //
        return await project.processCommand(params);
      }
  }
};


/*
 * Get IDF data
 */
Node.User.prototype.getData = function (params)
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
    version
  }, this.idfdata);
  delete data.password;
  return {msg: JSON.stringify(data)};
};


/*
 * Set IDF data and save user
 */
Node.User.prototype.setData = async function (params)
{
  let oldIdfdata = this.idfdata;
  let oldName = this.name;
  let oldSurname = this.surname;
  try {
    let data = JSON.parse(params.req.query.data);
    this.name = data.name;
    this.surname = data.surname;
    delete data.name;
    delete data.surname;
    //
    // Get the new password or the decrypted password (we need it to call this.config.licSrvUpdateUser )
    data.password = data.password || this.decryptUserPassword(this.idfdata.password);
    //
    this.idfdata = data;
    //
    let ris = await this.config.licSrvUpdateUser(this);
    //
    // Restore the encrypted password after the call
    this.idfdata.password = this.encryptUserPassword(this.idfdata.password);
    this.config.saveConfig();
    return {msg: ris};
  }
  catch (ex) {
    // Restore previous state so that a later saveConfig() won't save partial/plaintext data
    this.idfdata = oldIdfdata;
    this.name = oldName;
    this.surname = oldSurname;
    //
    return {msg: `ERROR ${ex}`};
  }
};


/**
 * Execute command for the user
 * @param {object} params
 */
Node.User.prototype.execCommand = async function (params)
{
  let command = params.tokens[0];
  //
  // MANAGER user handles only APPS, DATABASES and SESSIONS commands
  if (this.userName === "manager" && !["apps", "databases", "appsessions"].includes(command)) {
    this.log("WARN", "Invalid command for MANAGER", "User.execCommand", {url: params.req.originalUrl});
    throw new Error("Invalid command");
  }
  //
  // Handle commands
  if (command === "picture")
    return await this.downloadProfilePic(params);
  //
  // If the authorization key is enabled and the given one does not match -> error
  if (this.config.auth && params.req.query.autk !== this.config.autk) {
    this.log("WARN", "Unauthorized", "User.execCommand", {url: params.req.originalUrl});
    throw {err: "Unauthorized", code: 401};
  }
  //
  // Valid AUTK (or AUTK not enabled)
  switch (command) {
    case "status":
      return await this.sendStatus(params);

    case "apps":
      return await this.sendAppsList(params);

    case "databases":
      return await this.sendDatabasesList(params);

    case "projects":
      return this.sendProjectsList(params);

    case "projects2":
      return await this.sendProjectsListJson(params);

    case "importPrj":
      return await this.importPrj(params);

    case "exportPrj":
      return await this.exportPrj(params);

    case "appsessions":
      return await this.sendAppSessions(params);

    case "profile":
      return await this.profileUser(params);

    case "backup":
      return await this.backup(params);

    case "restore":
      return await this.restore(params);

    case "getdata":
      return this.getData(params);

    case "setdata":
      return await this.setData(params);

    case "twListPrjs":
      return await this.listTeamWorksProjects(params);

    case "twForkPrj":
      return await this.forkProjectFromTeamWorks(params);

    default:
      this.log("WARN", "Invalid command", "User.execCommand", {cmd: command, url: params.req.originalUrl});
      throw new Error("Invalid Command");
  }
};

// Funzioni di cifratura reversibile per la password utente
const PASSWORD_KEY = Buffer.from("8NnZG70yHNRCfJzGqK7i0zyHCN7zMV1o", "utf8"); // 32 bytes (256 bit)
const PASSWORD_IV = Buffer.from("TMSsPvq1a3bFQRH6", "utf8"); // 16 bytes (128 bit)

Node.User.prototype.encryptUserPassword = function (password)
{
  let cipher = Node.crypto.createCipheriv("aes-256-cbc", PASSWORD_KEY, PASSWORD_IV);
  let encrypted = cipher.update(password, "utf8", "base64");
  encrypted += cipher.final("base64");
  return encrypted;
};

Node.User.prototype.decryptUserPassword = function (encrypted)
{
  let decipher = Node.crypto.createDecipheriv("aes-256-cbc", PASSWORD_KEY, PASSWORD_IV);
  let decrypted = decipher.update(encrypted, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
};


/**
 * Get the database name based on the user
 * @param {string} name - Optional database name
 * @return {string} database name
 */
Node.User.prototype.getDbName = function (name)
{
  return this.userName === "manager" ? name : `${this.userName}-${name}`;
};


/**
 * Returns the tablespace name for the user
 * @returns {string} The tablespace name
 */
Node.User.prototype.getDbTableSpace = function ()
{
  return this.userName === "manager" ? "indets" : this.userName;
};


/**
 * Returns the database owner name for the user
 * @returns {string} The database owner name
 */
Node.User.prototype.getDbOwner = function ()
{
  return this.userName === "manager" ? "inde" : this.userName;
};


/**
 * Returns the database role name for the user
 * @returns {string} The database role name
 */
Node.User.prototype.getDbRole = function ()
{
  return this.userName === "manager" ? "inde" : this.userName;
};


/**
 * List TeamWorks projects available for this organization
 * @param {object} params
 */
Node.User.prototype.listTeamWorksProjects = async function (params)
{
  try {
    // Check if TeamWorks module is active
    if (!this.config.isProductActive(Node.Utils.IdfModules.MOD_TW))
      throw new Error("TeamWorks module is not active");
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
      let projects = await driver.listProjects();
      return {msg: JSON.stringify(projects || [])};
    }
    catch (ex) {
      throw new Error(`Error listing TeamWorks projects: ${ex.message}`);
    }
  }
  catch (err) {
    this.log("ERROR", err.message || err, "User.listTeamWorksProjects");
    throw err;
  }
};


/**
 * Fork project from TeamWorks
 * @param {object} params
 */
Node.User.prototype.forkProjectFromTeamWorks = async function (params)
{
  let warning = false;
  try {
    // Check if TeamWorks module is active
    if (!this.config.isProductActive(Node.Utils.IdfModules.MOD_TW)) {
      warning = true;
      throw new Error("TeamWorks module is not active");
    }
    //
    let projectId = params.req.query.projectId;
    let projectName = params.req.query.projectName;
    //
    if (!projectId || !projectName) {
      warning = true;
      throw "Project to fork not found";
    }
    //
    // Generate fork name: projectName-fork, projectName-fork1, projectName-fork2, etc.
    let baseName = `${projectName}-fork`;
    let finalProjectName = baseName;
    let counter = 0;
    //
    // Check for existing forks and find available name
    while (this.getProject(finalProjectName)) {
      counter++;
      finalProjectName = baseName + counter;
    }
    //
    // Local path for the project (use the final fork name)
    let localPath = Node.path.join(this.config.directory, this.userName, finalProjectName);
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
      try {
        await driver.downloadProject(projectName, localPath);
      }
      catch (err) {
        throw new Error(`Error creating fork: ${err}`);
      }
      //
      // Create the project with the fork name
      try {
        await this.createProject(finalProjectName);
      }
      catch (err) {
        throw new Error(`Error creating fork: ${err}`);
      }
      //
      // Get the created project
      let newProject = this.getProject(finalProjectName);
      //
      // Set the project ID and TeamWorks properties
      newProject.updateInfo({twFork: true, lastSave: new Date()});
      //
      this.log("INFO", "Project forked from TeamWorks successfully", "User.forkProjectFromTeamWorks",
              {projectId, projectName, forkName: finalProjectName});
      //
      return {msg: "OK"};
    }
    catch (err) {
      throw new Error(`Error creating TeamWorks driver: ${err.message}`);
    }
  }
  catch (err) {
    this.log(warning ? "WARN" : "ERROR", err.message || err, "User.forkProjectFromTeamWorks");
    throw err;
  }
};

// Export module
module.exports = Node.User;
