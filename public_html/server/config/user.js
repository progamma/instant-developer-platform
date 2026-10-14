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


// Reversible-cipher key/IV used by encryptUserPassword / decryptUserPassword
const PASSWORD_KEY = Buffer.from("", "utf8"); // 32 bytes (256 bit)
const PASSWORD_IV = Buffer.from("", "utf8"); // 16 bytes (128 bit)


/**
 * @class Node.User
 * @classdesc
 * Represents an Instant Developer user hosted by the server.
 * A user owns a set of projects, databases, apps, connected devices and cloud connectors,
 * and is coupled with an OS system user (on non-local installations) under which user-owned
 * processes run. The special `manager` user acts as a system-wide administrator and has
 * reduced capabilities (no projects, no OS coupling, no filesystem area).
 *
 * Key features:
 * - **Lifecycle**: creation/initialization, OS user coupling, backup/restore, config checks
 * - **Resource ownership**: projects, databases, apps, devices, cloud connectors
 * - **Profile management**: display name, avatar picture, encrypted IDF credentials
 * - **Command dispatch**: routes HTTP commands to user, project, database or app
 * - **Realtime**: broadcasts device and cloud-connector list updates to live sessions
 *
 * @property {Node.Config} parent - Parent configuration
 * @property {String} userName - Unique user name
 * @property {String} dbPassword - Random password used for the user's database account
 * @property {Node.Project[]} projects - Projects owned by the user
 * @property {Node.Database[]} databases - Databases owned by the user
 * @property {Node.App[]} apps - Apps installed for the user
 * @property {Node.Device[]} devices - Devices currently connected to the user
 * @property {Object[]} cloudConnectors - Cloud connectors currently connected to the user
 * @property {Object} idfdata - IDF profile data (password, group, email, language, phone, guid)
 * @property {Boolean} [folderExisted] - True if the user folder was already on disk when the user
 *   was created. Transient (not persisted): it lets the restore command tell data predating the
 *   command from data it created itself
 * @property {String} [OSUser] - Coupled OS user name (only on non-local installations)
 * @property {String} [uid] - UID of the coupled OS user
 * @property {String} [gid] - GID of the coupled OS user
 * @property {String} [name] - User's first name
 * @property {String} [surname] - User's surname
 * @property {String} [IID] - Identifier of the profile picture file
 * @property {Object} [devAgentOptions] - DevAgent configuration options
 * @property {Object} [onboardingState] - DevAgent onboarding progress summary
 *   ({examplesActivated, a2Completed, connectorConfigured, lastSessionAt}); null until the
 *   user has run an onboarding session. Plain (not encrypted) — it is not sensitive.
 */
Node.User = class User
{
  /**
   * Map of message types exchanged with child sessions.
   * @enum {String}
   */
  static msgTypeMap = {
    /** Device-related notification (e.g. connected device list) */
    deviceMsg: "dm",
    /** Cloud connector-related notification (e.g. connector list, responses) */
    cloudConnectorMsg: "ccm"
  };


  /**
   * Fields accepted from a cloud connector's `init` handshake. Only these are
   * copied onto the internal connector record, so caller-supplied data can never
   * overwrite internal fields such as `socket` or `pendingCallers`.
   * @type {String[]}
   */
  static cloudConnectorFields = [
    "name",
    "id",
    "version",
    "nodeVersion",
    "hostname",
    "dmlist",
    "fslist",
    "pluginslist"
  ];


  /**
   * @param {Node.Config} par - Parent configuration that owns this user
   */
  constructor(par)
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
    this.onboardingState = null;
    this.idfdata = {
      guid: "00000000-0000-0000-0000-000000000000",
      password: "",
      group: "",
      email: "",
      language: "",
      phone: ""
    };
  }


  /**
   * Gets the server instance that owns this user (grandparent).
   * @type {Node.Server}
   * @readonly
   */
  get server()
  {
    return this.parent.parent;
  }


  /**
   * Gets the configuration that owns this user (parent).
   * @type {Node.Config}
   * @readonly
   */
  get config()
  {
    return this.parent;
  }


  /**
   * Gets the shared logger instance used by the server.
   * @type {Node.Logger}
   * @readonly
   */
  get logger()
  {
    return this.server.logger;
  }


  /**
   * Logs a message through the shared logger, automatically decorating
   * the payload with the user name so every entry can be attributed to this user.
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
      user: this.userName
    };
    //
    this.logger.log(level, message, sender, data);
  }


  /**
   * Serializes the user into a plain object suitable for JSON persistence.
   * Includes children arrays (projects, databases, apps) and the `cl` discriminator
   * used by the restore machinery to rebuild the right class instances.
   * @returns {Object} Plain object representation of the user
   */
  save()
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
      devAgentOptions: this.devAgentOptions,
      onboardingState: this.onboardingState
    };
  }


  /**
   * Restores the user state from a previously saved plain object.
   * Note: legacy installations may have been saved without `dbPassword`;
   * in that case the property remains empty and DB access will fail with the
   * native Postgres error until the admin resets the password.
   * @param {Object} v - Object that contains the serialized user data
   */
  load(v)
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
    if (v.onboardingState)
      this.onboardingState = v.onboardingState;
  }


  /**
   * Serializes the user's own properties without any children (no projects, databases or apps).
   * Useful when callers need just the user "profile" slice of the state.
   * @returns {Object} Plain object with the user's own properties only
   */
  saveProperties()
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
  }


  /**
   * Sets the parent of this user and recursively propagates the new parent chain
   * to all owned projects, databases and apps.
   * @param {Node.Config} par - New parent configuration
   */
  setParent(par)
  {
    this.parent = par;
    //
    this.projects?.forEach(project => project.setParent(this));
    this.databases?.forEach(database => database.setParent(this));
    this.apps?.forEach(app => app.setParent(this));
  }


  /**
   * Serializes the user (and its children) to a JSON string using the class-aware
   * replacer that delegates to each object's `save` method.
   * Used by backup to write the `index.json` descriptor.
   * @returns {String} JSON representation of the user
   */
  saveUser()
  {
    return JSON.stringify(this, (k, v) => {
      if (v instanceof Node.User || v instanceof Node.Project || v instanceof Node.Database || v instanceof Node.App)
        return v.save();
      else
        return v;
    });
  }


  /**
   * Rehydrates the user from a JSON string, reconstructing child databases,
   * projects and apps based on the embedded `cl` discriminator.
   * Note: the `OSUser`, `uid`, `gid` and `apps` array present in the JSON may be
   * stale (cross-server restore or aged backup), so the current "system" values
   * are preserved and the apps array is cleared — apps are not restored by design.
   * @param {String} s - JSON data produced by {@link Node.User#saveUser}
   */
  loadUser(s)
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
  }


  /**
   * Initializes a freshly created user: assigns the user name, generates a random
   * database password and — unless this is the special `manager` user — couples
   * the user with an OS system user, creates its filesystem area and initializes
   * the PostgreSQL environment (login role + tablespace) so the user can connect
   * even before any database is created (e.g. when an onboarding example is
   * restored from a backup without going through `Database.createDb`).
   * @param {String} userName - Name of the user being initialized
   */
  async init(userName)
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
    this.folderExisted = await this.createUserFolder();
    //
    // Initialize the PostgreSQL environment (role + tablespace). initDbEnv is
    // idempotent (existing role/tablespace are tolerated), so the lazy call from
    // Database.init keeps working unchanged.
    await Node.Database.initDbEnv(this);
  }


  /**
   * Starts the default server session of every app owned by the user.
   * Invoked at server startup so that apps with a default server session are reachable immediately.
   */
  startServerSessions()
  {
    // Notify event to my apps
    if (this.apps)
      for (let app of this.apps)
        app.startDefaultServerSession();
  }


  /**
   * Couples this user with an OS system user, picking the first free slot (up to 300)
   * and then resolving its UID and GID via `/usr/bin/id`.
   * Note: it is a no-op on LOCAL installations. On FreeBSD the slot is named
   * `indeuser-N`, elsewhere `user-N`.
   * @throws {Error} If no OS user slot is available or if querying UID/GID fails
   */
  async assignOsUser()
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
            reject(new Error(`Error getting UID: ${err.message || err}`, {cause: err}));
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
            reject(new Error(`Error getting GID: ${err.message || err}`, {cause: err}));
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
  }


  /**
   * Creates the user folder and its `db` subfolder if missing, then fixes ownership
   * and permissions so that the coupled OS user (and the DB process for the `db`
   * folder) can access them. Permission fixing happens only where the root helper is
   * available ({@link Node.Server#canExecAsRoot}).
   * @returns {Promise<Boolean>} True if the user folder was already on disk
   * @throws {Error} If folder creation or permission adjustment fails
   */
  async createUserFolder()
  {
    let path = Node.path.join(this.config.directory, this.userName);
    let folderExisted = false;
    let logData;
    //
    try {
      // Create user folder
      try {
        await Node.fs.promises.mkdir(path);
      }
      catch (err) {
        if (err.code !== "EEXIST")
          throw new Error(`Error creating the user folder ${path}: ${err.message || err}`, {cause: err});
        //
        folderExisted = true;
      }
      //
      // Create DB directory
      try {
        await Node.fs.promises.mkdir(Node.path.join(path, "db"));
      }
      catch (err) {
        if (err.code !== "EEXIST")
          throw new Error(`Error creating the db folder ${path}/db: ${err.message || err}`, {cause: err});
      }
      //
      // Only where the root helper is available: the ownership of the folders is meaningful
      // on the servers that run the user as a real OS user
      if (this.server.canExecAsRoot) {
        // Set ownership of all files and directories
        try {
          await this.server.execFileAsRoot("ChownChmod", [this.OSUser, path]);
        }
        catch (err) {
          logData = {OSUser: this.OSUser, path};
          throw new Error(`Error changing user folder permissions: ${err.message || err}`, {cause: err});
        }
        //
        try {
          await this.server.execFileAsRoot("ChownDBFolder", [Node.path.join(path, "db")]);
        }
        catch (err) {
          logData = {path: Node.path.join(path, "db")};
          throw new Error(`Error changing the database folder permissions: ${err.message || err}`, {cause: err});
        }
      }
    }
    catch (err) {
      this.log("ERROR", err.message || err, "User.createUserFolder", logData);
      throw err;
    }
    //
    return folderExisted;
  }


  /**
   * Finds one of the user's projects by its name or id.
   * @param {String} name - Project name or id
   * @returns {Node.Project|undefined} The matching project, or `undefined` if not found
   */
  getProject(name)
  {
    return this.projects.find(prj => prj.name === name || prj.id === name);
  }


  /**
   * Creates a new project for this user, initializes it on disk, registers it in
   * the user's projects list and persists the updated configuration.
   * @param {String} projectName - Name of the project to create
   * @throws {Error} If a project with the same name already exists
   */
  async createProject(projectName)
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
    await this.config.saveConfig();
    //
    // Log the project creation
    this.log("INFO", "Project created", "User.createProject", {project: projectName});
  }


  /**
   * Deletes an existing project: removes its folder, drops it from the projects
   * list and persists the updated configuration.
   * Note: refuses to delete if there is an open IDE session on the project
   * (HTTP 409) and returns 404 if the project is not found.
   * @param {String} projectName - Name of the project to delete
   * @throws {Error} With `code` set to 404 (not found) or 409 (open session)
   */
  async deleteProject(projectName)
  {
    let project = this.getProject(projectName);
    if (!project) {
      this.log("WARN", "Project not found", "User.deleteProject", {project: projectName});
      let err = new Error("Project not found");
      err.code = 404;
      throw err;
    }
    //
    // If there is an open session I can't delete the project!
    if (this.server.getOpenSession(project)) {
      let err = new Error("Can't delete the project: open IDE session");
      err.code = 409;
      throw err;
    }
    //
    // Delete the project folder
    await project.deleteProjectFolder();
    //
    // Delete the project from the projects array
    let index = this.projects.indexOf(project);
    this.projects.splice(index, 1);
    //
    // Save the new configuration
    await this.config.saveConfig();
    //
    // Log the project deletion
    this.log("INFO", "Project removed", "User.deleteProject", {project: projectName});
  }


  /**
   * Finds one of the user's databases by its name.
   * @param {String} name - Database name
   * @returns {Node.Database|undefined} The matching database, or `undefined` if not found
   */
  getDatabase(name)
  {
    return this.databases.find(db => db.name === name);
  }


  /**
   * Creates a new database for this user, initializes it and persists the
   * updated configuration.
   * @param {String} dbName - Name of the database to create
   * @throws {Error} If a database with the same name already exists
   */
  async createDatabase(dbName)
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
    await this.config.saveConfig();
    //
    // Log the database creation
    this.log("INFO", "Database created", "User.createDatabase", {database: dbName});
  }


  /**
   * Drops the named database and removes it from the user's list.
   * @param {String} dbName - Name of the database to delete
   * @throws {Error} With `code` 404 if the database is not found
   */
  async deleteDatabase(dbName)
  {
    let database = this.getDatabase(dbName);
    if (!database) {
      this.log("WARN", "Database not found", "User.deleteDatabase", {database: dbName});
      let err = new Error("Database not found");
      err.code = 404;
      throw err;
    }
    //
    await database.dropDb();
    //
    let index = this.databases.indexOf(database);
    this.databases.splice(index, 1);
    //
    // Save the new configuration
    await this.config.saveConfig();
    //
    // Log the db deletion
    this.log("INFO", "Database removed", "User.deleteDatabase", {database: dbName});
  }


  /**
   * Drops every database owned by the user and then tears down the user's
   * database environment (tablespace, role, owner...).
   */
  async deleteAllDatabases()
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
  }


  /**
   * Deletes the whole user folder, including the `db` tablespace subfolder, plus a
   * leftover `.$$$` restore backup if one survived.
   * The tablespace and the backup go through {@link Node.Server#removeDir}, which picks
   * the elevated removal where it is available, and permissions on the folder are fixed
   * beforehand to ensure the final recursive delete can succeed.
   * @throws {Error} If the tablespace or user folder cannot be removed
   */
  async deleteUserFolder()
  {
    // Deliberately the local per-user folder, NOT getProjectsDir(): when IdsPrjDir (#14585) is set it is
    // a folder shared by all workstations, so an rm -rf here would wipe every station's projects.
    let path = Node.path.join(this.config.directory, this.userName);
    let logData;
    //
    try {
      // The tablespace belongs to the DB user: the server process cannot delete it on its own.
      // The error of removeDir already names the folder, so it travels as it is: what it does
      // not know is whose tablespace that was, and that goes into logData
      try {
        await this.server.removeDir(Node.path.join(path, "db"));
      }
      catch (err) {
        logData = {OSUser: this.OSUser, path: Node.path.join(path, "db")};
        throw err;
      }
      //
      // Before deleting the user folder I want to be sure I'm able to do it -> fix permissions
      if (this.server.canExecAsRoot) {
        try {
          await this.server.execFileAsRoot("ChownChmod", [this.OSUser, path]);
        }
        catch (err) {
          logData = {OSUser: this.OSUser, path};
          throw new Error(`Error changing user folder permissions: ${err.message || err}`, {cause: err});
        }
      }
      //
      // Delete the user directory
      try {
        await Node.fs.promises.rm(path, {recursive: true, force: true});
      }
      catch (err) {
        throw new Error(`Error deleting the user folder ${path}: ${err.message || err}`, {cause: err});
      }
      //
      // Collect a leftover restore backup: Archiver.restore renames the user folder to <user>.$$$
      // and can leave it behind when its own cleanup fails. No other code names that path, and it
      // holds a tablespace the Node process cannot traverse, so without this it would stay forever.
      // Best-effort: it is garbage, and its removal must not fail the deletion of the user
      try {
        await this.server.removeDir(`${path}.$$$`);
      }
      catch (err) {
        this.log("WARN", `Error deleting the leftover restore backup: ${err.message || err}`, "User.deleteUserFolder");
      }
    }
    catch (err) {
      this.log("ERROR", err.message || err, "User.deleteUserFolder", logData);
      throw err;
    }
  }


  /**
   * Backs up the user on the cloud: stages the user folder (minus `db`) in a
   * temporary directory, writes an `index.json` descriptor, uploads a tarball,
   * then triggers the backup of every owned database. The temporary staging
   * folder is always cleaned up, and the first failure (backup error or cleanup
   * error) is re-thrown to the caller.
   * @param {Object} params - Command parameters (currently unused by this method)
   * @throws {Error} If staging, upload or database backup fails
   */
  async backup(params)
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
            throw new Error(`Error creating the folder ${this.config.directory}/tmp: ${err.message || err}`, {cause: err});
        }
        //
        // Fix permissions if needed before backing up the user
        if (this.server.canExecAsRoot) {
          try {
            await this.server.execFileAsRoot("ChownChmod", [this.OSUser, path]);
          }
          catch (err) {
            logData = {OSUser: this.OSUser, path};
            throw new Error(`Error changing user folder permissions: ${err.message || err}`, {cause: err});
          }
          //
          try {
            await this.server.execFileAsRoot("ChownDBFolder", [`${path}/db`]);
          }
          catch (err) {
            logData = {path: `${path}/db`};
            throw new Error(`Error changing database folder permissions: ${err.message || err}`, {cause: err});
          }
        }
        //
        // Copy all the user folder except the db directory into the tmp folder
        let skipdb = item => item !== `${path}/db`;
        await new Promise((resolve, reject) => {
          Node.ncp(path, Node.path.join(tempPath, this.userName), {filter: skipdb}, err => {
            if (err)
              reject(new Error(`Error copying the user folder ${path}: ${err.message || err}`, {cause: err}));
            else
              resolve();
          });
        });
        //
        // Write user's info into an index.json file
        let indexPath = Node.path.join(tempPath, this.userName, "index.json");
        try {
          await Node.fs.promises.writeFile(indexPath, this.saveUser(), "utf8");
        }
        catch (err) {
          throw new Error(`Error writing the file ${indexPath}: ${err.message || err}`, {cause: err});
        }
        //
        // Backup the tmp folder int the cloud
        let archiver = new Node.Archiver(this.server);
        try {
          await archiver.backup(Node.path.join(tempPath, this.userName), pathCloud);
        }
        catch (err) {
          throw new Error(`Error backing up the files: ${err.message || err}`, {cause: err});
        }
        //
        // Last, backup all user's databases
        try {
          await this.backupDatabases();
        }
        catch (err) {
          throw new Error(`Error backing up databases: ${err.message || err}`, {cause: err});
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
  }


  /**
   * Backs up every database owned by this user, in sequence.
   */
  async backupDatabases()
  {
    for (let db of this.databases)
      await db.backup();
  }


  /**
   * Restores the user from the cloud backup: downloads and extracts the tarball
   * into the user folder, recreates the `db` directory, fixes permissions, loads
   * the `index.json` descriptor, saves the configuration and then restores every
   * database described in it.
   * @param {Object} params - Command parameters (currently unused by this method)
   * @throws {Error} If restore of files or databases fails. The error carries `dataOnDisk` when the
   * backup had already been extracted, so that the caller does not undo the failure by deleting the user
   */
  async restore(params)
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
          throw new Error(`Error creating the user folder ${path}/db: ${err.message || err}`, {cause: err});
      }
      //
      // Fix permissions if needed then restore user directory
      if (this.server.canExecAsRoot) {
        try {
          await this.server.execFileAsRoot("ChownChmod", [this.OSUser, path]);
        }
        catch (err) {
          logData = {OSUser: this.OSUser, path};
          throw new Error(`Error changing the user folder permissions: ${err.message || err}`, {cause: err});
        }
        //
        try {
          await this.server.execFileAsRoot("ChownDBFolder", [Node.path.join(path, "db")]);
        }
        catch (err) {
          logData = {path: Node.path.join(path, "db")};
          throw new Error(`Error changing the database folder permissions: ${err.message || err}`, {cause: err});
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
        throw new Error(`Error reading the file ${pathJSON}: ${err.message || err}`, {cause: err});
      }
      //
      // Load the user from the JSON file and save the current configuration
      this.loadUser(file);
      await this.config.saveConfig();
      //
      // Delete the JSON file
      try {
        await Node.fs.promises.rm(pathJSON, {force: true});
      }
      catch (err) {
        throw new Error(`Error deleting the file ${pathJSON}: ${err.message || err}`, {cause: err});
      }
      //
      // Restore all user's DBs
      try {
        await this.restoreDatabases();
      }
      catch (err) {
        throw new Error(`Error restoring databases: ${err.message || err}`, {cause: err});
      }
      //
      // Log the user restore
      this.log("INFO", "Restore of user succeeded", "User.restore");
    }
    catch (err) {
      this.log("ERROR", err.message || err, "User.restore", logData);
      //
      // The backup is already extracted: from here on a failure leaves valid data on disk
      err.dataOnDisk = true;
      throw err;
    }
  }


  /**
   * Re-initializes and restores every database owned by the user.
   */
  async restoreDatabases()
  {
    for (let db of this.databases) {
      await db.init(db.name);
      await db.restore();
    }
  }


  /**
   * Performs a startup sanity check on the user: couples it with an OS user if
   * needed, (re)creates the user folder, and runs the same check on each of its
   * projects. Errors raised by individual project checks are logged but do not
   * abort the overall check. The `manager` user is exempt.
   */
  async check()
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
        catch (err) {
          this.log("ERROR", `Error while checking the project folder ${prj.name}: ${err}`, "User.check", {project: prj.name});
        }
      }
    }
  }


  /**
   * Creates a new app for this user, initializes it and persists the configuration.
   * @param {String} appName - Name of the app to create
   * @returns {Promise<Node.App>} The newly created app
   */
  async createApp(appName)
  {
    let app = new Node.App(this);
    this.apps.push(app);
    //
    // Init the app
    app.initApp(appName);
    //
    // Save the new configuration
    await this.config.saveConfig();
    //
    return app;
  }


  /**
   * Removes an app from the user's list and persists the configuration.
   * If the app is not part of the user's list, logs a warning and does nothing.
   * @param {Node.App} app - App to remove
   */
  async deleteApp(app)
  {
    let idx = this.apps.indexOf(app);
    if (idx === -1)
      return this.log("WARN", "App not found", "User.deleteApp", {app: app.name});
    //
    this.apps.splice(idx, 1);
    //
    // Save the new configuration
    await this.config.saveConfig();
  }


  /**
   * Finds one of the user's apps by name (case-insensitive comparison).
   * @param {String} name - App name to search for
   * @returns {Node.App|undefined} The matching app, or `undefined` if not found
   */
  getApp(name)
  {
    let lname = name.toLowerCase();
    return this.apps.find(app => app.name.toLowerCase() === lname);
  }


  /**
   * Returns runtime status information about the user, currently the on-disk size
   * of the user folder (in bytes) computed via `du -sh`. The metric is unavailable, and the
   * method returns `undefined`, when the server is local or running on Windows.
   * @param {Object} params - Command parameters (unused by this method)
   * @returns {Promise<Object|undefined>} `{diskSize}` in bytes, or `undefined` where `du` is unavailable
   * @throws {Error} If the folder size cannot be computed
   */
  async getStatus(params)
  {
    // The size comes from du, run through the root helper: without it, no size
    if (!this.server.canExecAsRoot)
      return;
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
      return {
        diskSize: size
      };
    }
    catch (err) {
      this.log("ERROR", `Error getting the size of user folder: ${err}`, "User.getStatus", {path});
      throw new Error(`Error getting the size of user folder: ${err.message || err}`, {cause: err});
    }
  }


  /**
   * Returns the status object of each database owned by the user.
   * @param {Object} params - Forwarded to {@link Node.Database#getStatus}
   * @returns {Promise<Object[]>} Array of per-database status objects
   */
  async getDatabasesList(params)
  {
    let databases = [];
    for (let db of this.databases)
      databases.push(await db.getStatus(params));
    //
    return databases;
  }


  /**
   * Returns the status object of each app owned by the user.
   * @param {Object} params - Forwarded to {@link Node.App#getStatus}
   * @returns {Promise<Object[]>} Array of per-app status objects
   */
  async getAppsList(params)
  {
    let apps = [];
    for (let app of this.apps)
      apps.push(await app.getStatus(params));
    //
    return apps;
  }


  /**
   * Returns the root folder that holds this user's projects: the configured projects directory
   * (`IdsPrjDir`, e.g. a network share / cloud drive - #14585) when set, so the same projects are
   * reachable from multiple workstations; otherwise the default per-user work folder
   * (`<directory>/<userName>`).
   * Use this ONLY to build paths to project files/folders (the content we want shared). User-level
   * and lifecycle paths (create/delete user folder, user backup/restore, profile image, DB tablespace)
   * must keep using the local `<directory>/<userName>` folder: when `IdsPrjDir` is set it is shared by
   * all workstations, so an `rm -rf` of that root during user deletion would wipe everyone's projects.
   * @returns {String} Absolute path of the projects root folder
   */
  getProjectsDir()
  {
    let prjDir = this.config.idfoptions ? this.config.idfoptions.IdsPrjDir : undefined;
    return prjDir || Node.path.join(this.config.directory, this.userName);
  }


  /**
   * Confines a path received from the client to the folders this user owns: the per-user work folder
   * (`<directory>/<userName>`) and, when configured, the projects directory (`IdsPrjDir`, #14585).
   * Commands taking a path from the query string must go through here: without it the client can walk
   * out of its home and have the server read/write any file, config.json included (issue #14062).
   * @param {String} reqPath - Path received from the client
   * @param {Boolean} [anyPathIfLocal] - Skip the confinement on a local server (IDS), where the client
   * picks files from the very machine the server runs on
   * @returns {Promise<String>} The real absolute path, the one the check was made on
   * @throws {Error} If the path is missing or resolves outside the allowed roots
   */
  async checkUserPath(reqPath, anyPathIfLocal)
  {
    if (!reqPath || typeof reqPath !== "string")
      throw new Error("Invalid 'path' parameter");
    //
    // Resolve the symlinks the path crosses and check that one, so what gets used is what was
    // checked: a symlink is followed by the file system on both reads and writes
    let target = await Node.Utils.realPath(reqPath);
    if (anyPathIfLocal && this.config.local)
      return target;
    //
    let roots = [Node.path.join(this.config.directory, this.userName), this.getProjectsDir()];
    if (!Node.Utils.isPathInside(target, await Promise.all(roots.map(r => Node.Utils.realPath(r)))))
      throw new Error("Path is outside the allowed directory");
    //
    return target;
  }


  /**
   * Returns the list of project names owned by the user.
   * @param {Object} params - Command parameters (unused by this method)
   * @returns {String[]} Array of project names
   */
  getProjectsList(params)
  {
    return this.projects.map(prj => prj.name);
  }


  /**
   * Returns the project list as an array of rich descriptors including name,
   * last save timestamp, base path and — when a recovery snapshot exists — the
   * modification time of the associated `project.json.good` file.
   * @param {Object} params - Command parameters (unused by this method)
   * @returns {Promise<Object[]>} Array of `{name, lastSave, lastOpen, path, restoreDT?}` objects
   */
  async getProjectsListJson(params)
  {
    let prjDir = this.getProjectsDir();
    let projects = [];
    for (let prj of this.projects) {
      let prjData = {
        name: prj.name,
        lastSave: prj.lastSave,
        lastOpen: prj.lastOpen,
        path: prjDir
      };
      //
      let goodName = Node.path.join(prjDir, prj.name, "project.json.good");
      if (Node.fs.existsSync(goodName))
        prjData.restoreDT = (await Node.fs.promises.stat(goodName)).mtime.toISOString();
      //
      projects.push(prjData);
    }
    //
    // When a projects directory is configured (IdsPrjDir, e.g. a shared network drive - #14585), also
    // discover the projects that exist on disk but this workstation does not know yet (created from
    // another workstation): adopt them by registering them in the user's project list with fresh id
    // and ivAES, like Project.init does (the on-disk project is not encrypted: id/ivAES are per-install
    // secrets for the ChromeFS cache, regenerable, and must be unique so adopted projects don't collide).
    // This way a second workstation pointing at the same drive can see and open them.
    if (this.config.idfoptions?.IdsPrjDir) {
      let adopted = false;
      let entries = await Node.fs.promises.readdir(prjDir, {withFileTypes: true}).catch(() => []);
      for (let entry of entries) {
        // It is a project only if it is a folder holding a project.json and it is not known yet.
        // Skip tmp_* folders: they are transient backup/restore staging dirs that may momentarily
        // hold a project.json and would otherwise be adopted as phantom projects.
        if (!entry.isDirectory() || entry.name.startsWith("tmp_") || this.getProject(entry.name))
          continue;
        //
        // Skip the folders still carrying a project extension: they are what an interrupted import
        // leaves behind, they do hold a project.json and would therefore be adopted, but a project
        // named "foo.prj" cannot be opened - it would just sit in the list as a phantom (#15005)
        if ([".prj", ".idm", ".idp"].includes(Node.path.extname(entry.name).toLowerCase()))
          continue;
        //
        if (!Node.fs.existsSync(Node.path.join(prjDir, entry.name, "project.json")))
          continue;
        //
        let prj = new Node.Project(this);
        prj.id = Node.Utils.generateUID36().substring(0, 32);
        prj.name = entry.name;
        prj.ivAES = Array.from(Node.crypto.randomBytes(16));
        this.projects.push(prj);
        adopted = true;
        //
        projects.push({name: prj.name, path: prjDir});
      }
      //
      if (adopted)
        await this.config.saveConfig();
    }
    //
    return projects;
  }


  /**
   * Imports a new project from a zipped IDF file already present on the server.
   * The file path and optional target project name are taken from the query
   * string (`path`, `prjname`). After unzipping the archive the extracted folder
   * is looked up by trying known project extensions (`.prj`, `.idm`, `.idp`) or
   * by scanning the target directory, then renamed to the final project name and
   * registered through {@link Node.User#createProject}.
   * @param {Object} params - Command parameters (expects `params.req.query.path` and optional `prjname`)
   * @throws {Error} If the path is missing or (on a remote server) outside the user's folders, if the
   * archive cannot be unzipped or if the extracted folder is not found
   */
  async importPrj(params)
  {
    // Get the file path from query parameters. On a local server (IDS) the archive can sit anywhere:
    // the file picker hands over the path of a file the user chose on their own machine, and the
    // server runs on that same machine. A remote server instead only ever imports what has been
    // uploaded into the user's own folders, so there the path must stay confined (issue #14062)
    let filePath = await this.checkUserPath(params.req.query.path, true);
    //
    // Declared out here so the catch can clean up the extracted folder
    let oldPath, newPath;
    //
    try {
      // Extract the file name from the path
      let fileName = Node.path.basename(filePath, Node.path.extname(filePath));
      //
      // Get the project name from query or filename
      let prjName = params.req.query.prjname || fileName;
      //
      // Refuse right away if the name is taken. createProject would throw anyway, but only at the
      // very end, with the archive already extracted and renamed on disk (issue #15005)
      if (this.getProject(prjName))
        throw new Error(`A project named "${prjName}" is already in your project list: import it under a different name`);
      //
      // Define target directory (user's directory)
      let targetDir = this.getProjectsDir();
      //
      // Unzip the project file to the target directory
      let archiver = new Node.Archiver(this.server);
      let ok = await archiver.unzip(filePath, targetDir);
      if (!ok)
        throw new Error(`Unable to unzip file ${filePath}`);
      //
      // Wait for file system to settle after unzip
      await new Promise(resolve => setTimeout(resolve, 1000));
      //
      // Find the extracted folder — try known extensions with the zip filename first,
      // then look for any newly created folder with a project extension
      oldPath = Node.path.join(targetDir, `${fileName}.prj`);
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
      newPath = Node.path.join(targetDir, prjName);
      //
      // On Windows rename fails with EPERM when the destination exists, even when it is empty - and
      // the destination usually IS there, because at startup the server creates the folder skeleton
      // (branches, build, files, resources) for every registered project. So what matters is what is
      // inside, not mere existence: a project.json means a real project, and that one is never
      // overwritten - with a configured projects directory (#14585) it may belong to another
      // workstation sharing the drive. An empty skeleton instead can go (issue #15005)
      if (Node.fs.existsSync(newPath)) {
        if (Node.fs.existsSync(Node.path.join(newPath, "project.json")))
          throw new Error(`A project named "${prjName}" already exists in ${targetDir}: remove it, or import the project under a different name`);
        //
        // No project.json, but make sure it holds no files at all before removing it: the skeleton
        // is only empty directories, anything else is somebody's data and must not be touched
        let holdsFiles = async dir => {
          for (let e of await Node.fs.promises.readdir(dir, {withFileTypes: true})) {
            if (!e.isDirectory() || await holdsFiles(Node.path.join(dir, e.name)))
              return true;
          }
          //
          return false;
        };
        //
        if (await holdsFiles(newPath))
          throw new Error(`The folder ${newPath} already exists and is not empty: remove it, or import the project under a different name`);
        //
        await Node.fs.promises.rm(newPath, {recursive: true, force: true});
      }
      //
      // Rename the unzipped folder to the project name
      try {
        await Node.fs.promises.rename(oldPath, newPath);
      }
      catch (err) {
        throw new Error(`Error renaming the extracted folder ${oldPath} to ${newPath}: ${err.code || err.message || err}`, {cause: err});
      }
      //
      // Create the project in the user's project list
      await this.createProject(prjName);
      //
      // Update project's last save timestamp and save configuration
      this.getProject(prjName).lastSave = new Date();
      //
      await this.config.saveConfig();
    }
    catch (err) {
      // The extracted folder still carries the .prj suffix, so leaving it behind would litter the
      // projects directory and, worse, get picked up by the adoption scan in getProjectsListJson as
      // a project that cannot be opened. Best effort: if this fails too there is nothing more to do
      if (oldPath && oldPath !== newPath)
        await Node.fs.promises.rm(oldPath, {recursive: true, force: true}).catch(() => {});
      //
      // Not always the unzip: it may just as well be the rename or the project registration, and
      // blaming the unzip sends whoever reads the message looking in the wrong place (issue #15005)
      throw new Error(`Error importing the project from ${filePath}: ${err.message || err}`, {cause: err});
    }
  }


  /**
   * Exports a project as a zip archive. The source folder path is taken from
   * the query string (`path`); the archive carries a `.prj` suffix.
   * @param {Object} params - Command parameters (expects `params.req.query.path`)
   * @returns {Promise<Boolean>} Whether the archive was produced successfully
   * @throws {Error} If the path is missing, falls outside the user's folders, or the archiver fails
   */
  async exportPrj(params)
  {
    // The archive is written next to its source, so an unconfined path is both an arbitrary read and
    // an arbitrary write. What gets exported is always a project folder of this user (issue #14062)
    let fullPath = await this.checkUserPath(params.req.query.path);
    let archiver = new Node.Archiver(this.server);
    try {
      return await archiver.zip(fullPath, {suffix: ".prj"});
    }
    catch (err) {
      throw new Error(`Error while exporting project ${fullPath}: ${err.message || err}`, {cause: err});
    }
  }


  /**
   * Returns a detailed session breakdown across all apps owned by the user.
   * The resulting object has a top-level `sessions` counter plus one entry per
   * app, each containing its own session count and an array of worker details.
   * @param {Object} params - Forwarded to {@link Node.App#getSessions}
   * @returns {Promise<Object>} Aggregated session map `{sessions, [appName]: {sessions, workers}}`
   */
  async getAppSessions(params)
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
    let appSessions = {sessions: 0};
    //
    // Add app's details
    for (let app of this.apps) {
      // Add app's sessions
      let appdata = await app.getSessions(params);
      appSessions[app.name] = appdata;
      appSessions.sessions += appdata.sessions;
    }
    //
    return appSessions;
  }


  /**
   * Updates the user's profile from a multipart form: accepts optional `name`,
   * `surname` text fields and a profile picture (`file` field). When the `file`
   * string field is present (with no attachment) the existing picture is
   * removed; otherwise an uploaded image replaces the previous one, stored in
   * the user folder under a freshly generated IID, with the old file deleted.
   * @param {Object} params - Command parameters (expects `params.req` as an HTTP request)
   */
  async profileUser(params)
  {
    let form = new Node.multiparty.Form({uploadDir: Node.path.join(this.config.directory, this.userName)});
    //
    // Parse the multipart form data
    let {fields, files} = await new Promise((resolve, reject) => {
      form.parse(params.req, (err, fields, files) => {
        if (err) {
          this.log("ERROR", `Error while parsing request data: ${err}`, "User.profileUser");
          reject(new Error(`Error while parsing request data: ${err.message || err}`, {cause: err}));
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
        throw new Error(`Error changing user picture permissions: ${err.message || err}`, {cause: err});
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
    await this.config.saveConfig();
    //
    // Invalidate the profile cache on any open IDE session bound to this user:
    // IDESession.getProfile() captures name/surname/idfdata.language at first call
    // and would otherwise broadcast stale values to subsequently-connected sockets
    // (telecollab peers, reconnections) until the session is restarted.
    for (let sess of Object.values(this.server.IDESessions)) {
      if (sess.project.user === this)
        sess.invalidateProfileCache();
    }
  }


  /**
   * Streams the current profile picture to the HTTP response, or terminates the
   * response with no body if the user has no picture set.
   * @param {Object} params - Command parameters (expects `params.res` as the HTTP response)
   * @throws {Error} If reading the profile picture file fails
   */
  async downloadProfilePic(params)
  {
    // If the user has no IID, do nothing
    if (!this.IID) {
      params.res.end();
      return;
    }
    //
    // Path where the profile img is located
    let path = Node.path.join(this.config.directory, this.userName, this.IID);
    try {
      params.res.end(await Node.fs.promises.readFile(path));
    }
    catch (err) {
      this.log("ERROR", `Error reading the file ${path}: ${err}`, "User.downloadProfilePic");
      throw new Error(`Error reading the profile pic: ${err.message || err}`, {cause: err});
    }
  }


  /**
   * Registers a device that has connected over the given socket.
   * Note: a pending disconnect-removal timer (within 3 seconds) is reused so
   * a quickly reconnecting device is silently re-attached to the new socket;
   * duplicate UUID without a pending removal is rejected by disconnecting the
   * socket. The display name is auto-suffixed (" 1", " 2", ...) when the user
   * already owns a device with the same name.
   * @param {Socket} socket - Socket.IO socket created by the device
   * @param {Object} data - Connection payload `{deviceUuid, deviceName, deviceType, sid}`
   */
  addDevice(socket, data)
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
  }


  /**
   * Removes a device from the user's list and broadcasts an updated device
   * list to every live session. Does nothing if the device is not owned.
   * @param {Node.Device} device - Device to remove
   */
  removeDevice(device)
  {
    let idx = this.devices.indexOf(device);
    if (idx !== -1) {
      this.devices.splice(idx, 1);
      //
      this.updateAvailableDevicesList("disconnected");
    }
  }


  /**
   * Broadcasts the current device list to every live session owned by this user,
   * tagging the message with the given event name so clients can show a
   * user-friendly notification.
   * @param {String} event - Event name used by the UI (e.g. "connected", "disconnected")
   */
  updateAvailableDevicesList(event)
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
  }


  /**
   * Builds the device list suitable for the PropertyView of the given session.
   * Devices bound to a specific session id are included only for that session;
   * session-agnostic devices are included only on "true" (non-readonly) IDE sessions.
   * @param {Node.IDESession} ses - IDE session that will receive this list
   * @returns {Object[]} Array of `{deviceName, deviceUuid, deviceType}` descriptors
   */
  getUiDeviceList(ses)
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
  }


  /**
   * Finds one of the user's connected devices by its UUID.
   * @param {String} uuid - Device UUID
   * @returns {Node.Device|undefined} The matching device, or `undefined` if not found
   */
  getDeviceByUuid(uuid)
  {
    return this.devices.find(device => device.deviceUuid === uuid);
  }


  /**
   * Finds one of the user's connected devices by its display name.
   * @param {String} deviceName - Device display name
   * @returns {Node.Device|undefined} The matching device, or `undefined` if not found
   */
  getDeviceByName(deviceName)
  {
    return this.devices.find(device => device.deviceName === deviceName);
  }


  /**
   * Registers a cloud connector for this user.
   * If a connector with the same `name` is already present, the behaviour
   * depends on the `id` field:
   * - missing/different ids cause the new connection to be rejected;
   * - matching ids mean it's a reconnection — the old socket is marked "old"
   *   and replaced by the new one.
   * Otherwise a new connector record is pushed to the list; in every case the
   * connector list is re-broadcast to all interested sessions with an `event`
   * describing whether it was a connect or a change.
   * @param {Socket} socket - Socket.IO socket opened by the cloud connector
   * @param {Object} data - Handshake payload (at minimum `{name, id, ...}`)
   */
  addCloudConnector(socket, data)
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
    // Copy only the expected handshake fields, never internal ones (socket, pendingCallers)
    for (let field of Node.User.cloudConnectorFields)
      if (data[field] !== undefined)
        connector[field] = data[field];
    //
    this.updateAvailableCloudConnectorsList(event);
  }


  /**
   * Removes the cloud connector associated with the given socket and notifies
   * every IDE session of the disconnection. Sockets flagged as "old" (replaced
   * by a reconnection handled in {@link Node.User#addCloudConnector}) are
   * ignored. For the `manager` user, all app sessions on the server also
   * receive the disconnect notification.
   * @param {Socket} socket - The disconnected socket
   */
  removeCloudConnector(socket)
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
  }


  /**
   * Broadcasts the current cloud-connector list to every live session owned by
   * this user, annotating the message with the triggering event so the UI can
   * show a contextual notification.
   * @param {Object} event - Event descriptor, e.g. `{name: <connectorName>, connected: true|false}` or `{name, changed: true}`
   */
  updateAvailableCloudConnectorsList(event)
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
  }


  /**
   * Builds the cloud-connector list suitable for the PropertyView.
   * @returns {Object[]} Array of `{name, version, nodeVersion, hostname, dmlist}` descriptors
   */
  getUiCloudConnectorsList()
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
  }


  /**
   * Resolves the cloud connector targeted by a message.
   * The connector is matched by `msg.conn` name and then validated against the
   * payload: depending on which of `dm`, `fs`, `plugin` or `app` is set in
   * `msg.data`, the proper sub-list is scanned for an object matching `name`
   * and `key`. For `app` commands any named connector is returned as-is.
   * @param {Object} msg - Cloud connector message (`{conn, key, data: {dm|fs|plugin|app, ...}}`)
   * @returns {Object|undefined} The matching connector record, or `undefined` if none
   */
  getCloudConnector(msg)
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
  }


  /**
   * Routes a cloud-connector protocol message coming from a session/worker/socket.
   * Supported message types:
   * - `connectorListRequest`: replies with the current UI connector list;
   * - `remoteCmd`: forwards a command to the target connector, with special
   *   handling for the `listCC` meta command, plus rejection of commands
   *   addressed to pre-21.0 connectors that don't expose `nodeVersion`; hex-
   *   encoded buffer arguments are restored before dispatch, and callers with
   *   a `cbid` are memorized in `pendingCallers`;
   * - `response`: matches the reply to the waiting caller through `cbid`,
   *   normalizing any Buffer payload to `{_t: "buffer", data: base64}`.
   * @param {Object} msg - Cloud connector message
   * @param {Node.IDESession|Node.Worker|Socket} sender - Originator of the message
   * @returns {Boolean|undefined} `true` when a `response` has been successfully relayed, `false` otherwise
   */
  handleCloudConnectorMessage(msg, sender)
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
              data: {
                error: `Command '${msg.data.cmd}' not supported by cloud connectors in versions prior to 21.0`
              }
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
  }


  /**
   * Routes an HTTP command to the proper owner (user, project, database or app).
   *
   * URL shapes:
   * - `/username/<command>` → delegates to {@link Node.User#execCommand}
   * - `/username/<prjName>/<command>` → project command
   * - `/username/db/<dbName>/<command>` → database command
   * - `/username/app/<appName>/<command>` → app command
   * - `/manager/<appName>/<command>` → app command (the `app` token is optional for `manager`)
   *
   * Applies authorization via the user-specific auth key on the `create`, `restore`
   * and `delete` verbs, and forbids those same verbs against the `manager` user
   * for projects. On a failing `restore` of a freshly-created database/project/app,
   * the newly created object is rolled back.
   * @param {Object} params - Command parameters (must include `params.req` and `params.tokens`)
   * @throws {Error} With `code` set to 401 (unauthorized) or 404 (target not found),
   * or a plain Error for command-level failures
   */
  async processCommand(params)
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
    // Check the authorization key only for "CREATE", "RESTORE" and "DELETE" commands
    // ('cause other commands will handle it where it's needed)
    if (["create", "restore", "delete"].includes(command))
      this.config.checkAuthorization(params, "User.processCommand");
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
            app = await this.createApp(objName);
            isNew = true;
          }
          //
          try {
            await app.processCommand(params);
          }
          catch (err) {
            if (isNew)
              await this.deleteApp(app);
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
            app = await this.createApp(objName);
            isNew = true;  // Remember that I've created a new app
          }
          //
          try {
            await app.processCommand(params);
          }
          catch (err) {
            if (isNew)
              await this.deleteApp(app);    // There is a problem and I've created the app  -> delete it
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
            let err = new Error("Database not found");
            err.code = 404;
            throw err;
          }
          //
          return await database.processCommand(params);
        }
        else if (isAPP) {
          let app = this.getApp(objName);
          if (!app) {
            this.log("WARN", "App not found", "User.processCommand",
                    {cmd: command, app: objName, url: params.req.originalUrl});
            let err = new Error("App not found");
            err.code = 404;
            throw err;
          }
          //
          return await app.processCommand(params);
        }
        else {
          let project = this.getProject(objName);
          if (!project) {
            this.log("WARN", "Project not found", "User.processCommand",
                    {cmd: command, project: objName, url: params.req.originalUrl});
            let err = new Error("Project not found");
            err.code = 404;
            throw err;
          }
          //
          return await project.processCommand(params);
        }
    }
  }


  /**
   * Returns the IDF profile data for the user, enriched with first/last name
   * and a pipe-separated `version` string carrying the IDE version plus legacy
   * revision fields required by the IDF client. The encrypted password is
   * stripped from the returned object.
   * @param {Object} params - Command parameters (unused by this method)
   * @returns {Object} Profile data (`{name, surname, version, ...idfdata}` without `password`)
   */
  getData(params)
  {
    let version = this.parent.getIndeVersion(); // e.g. 25.5.9620
    version += " r1"; // EXE version
    version += "|0"; // installed revision number (always 0)
    version += "|https://www.progamma.com/doc"; // release notes
    version += "|1"; // current version
    version += "|0"; // number of available revisions (always 0)
    //
    let data = Object.assign({
      name: this.name,
      surname: this.surname,
      version
    }, this.idfdata);
    delete data.password;
    return data;
  }


  /**
   * Updates the IDF profile data (including first/last name and password) from
   * the `data` JSON blob in the query string, pushes the change to the license
   * server via `licSrvUpdateUser`, re-encrypts the password before persistence
   * and saves the configuration. If anything fails, the previous state is
   * restored so a later `saveConfig()` cannot flush partial or plaintext data
   * and the error is re-thrown to the caller.
   * @param {Object} params - Command parameters (expects `params.req.query.data` as a JSON string)
   * @returns {Promise<*>} The license-server result code
   * @throws {Error} If the data cannot be parsed, the license-server call fails
   * unexpectedly or the configuration cannot be saved
   */
  async setData(params)
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
      data.password = data.password || this.decryptStoredPassword();
      //
      this.idfdata = data;
      //
      let errCode = await this.config.licSrvUpdateUser(this);
      //
      // Restore the encrypted password after the call
      this.idfdata.password = this.encryptUserPassword(this.idfdata.password);
      await this.config.saveConfig();
      //
      // Invalidate the profile cache on any open IDE session bound to this user:
      // IDESession.getProfile() captures name/surname/idfdata.language at first call
      // and would otherwise broadcast stale values to subsequently-connected sockets
      // (telecollab peers, reconnections) until the session is restarted.
      for (let sess of Object.values(this.server.IDESessions)) {
        if (sess.project.user === this)
          sess.invalidateProfileCache();
      }
      //
      return errCode;
    }
    catch (ex) {
      // Restore previous state so that a later saveConfig() won't save partial/plaintext data
      this.idfdata = oldIdfdata;
      this.name = oldName;
      this.surname = oldSurname;
      //
      throw ex;
    }
  }


  /**
   * Executes a user-scoped command dispatched from {@link Node.User#processCommand}.
   * The `manager` user is restricted to `apps`, `databases` and `appsessions`.
   * The `picture` command bypasses the authorization check; every other command
   * is gated by the server-wide AUTK when enabled.
   *
   * Supported verbs: `status`, `apps`, `databases`, `projects`, `projects2`,
   * `importPrj`, `exportPrj`, `appsessions`, `profile`, `backup`, `restore`,
   * `getdata`, `setdata`, `twListPrjs`, `twForkPrj`.
   * @param {Object} params - Command parameters (must include `params.req` and `params.tokens`)
   * @returns {Promise<*>} The command-specific result
   * @throws {Error} For invalid commands, unauthorized access (code 401), or propagated failures
   */
  async execCommand(params)
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
    this.config.checkAuthorization(params, "User.execCommand");
    //
    // Valid AUTK (or AUTK not enabled)
    switch (command) {
      case "status":
        return await this.getStatus(params);

      case "apps":
        return await this.getAppsList(params);

      case "databases":
        return await this.getDatabasesList(params);

      case "projects":
        return this.getProjectsList(params);

      case "projects2":
        return await this.getProjectsListJson(params);

      case "importPrj":
        return await this.importPrj(params);

      case "exportPrj":
        return await this.exportPrj(params);

      case "appsessions":
        return await this.getAppSessions(params);

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

      case "twMasterPrj":
        return await this.downloadMasterFromTeamWorks(params);

      default:
        this.log("WARN", "Invalid command", "User.execCommand", {cmd: command, url: params.req.originalUrl});
        throw new Error("Invalid Command");
    }
  }


  /**
   * Reversibly encrypts the user password using AES-256-CBC with the module-level
   * key and IV, so that the configuration file never persists the password in
   * plaintext.
   * @param {String} password - Plaintext password to protect
   * @returns {String} Base64-encoded ciphertext
   */
  encryptUserPassword(password)
  {
    let cipher = Node.crypto.createCipheriv("aes-256-cbc", PASSWORD_KEY, PASSWORD_IV);
    let encrypted = cipher.update(password, "utf8", "base64");
    encrypted += cipher.final("base64");
    return encrypted;
  }


  /**
   * Reverses {@link Node.User#encryptUserPassword} to recover the plaintext
   * password, e.g. before handing it off to the license server.
   * @param {String} encrypted - Base64-encoded ciphertext produced by {@link Node.User#encryptUserPassword}
   * @returns {String} Decrypted plaintext password
   */
  decryptUserPassword(encrypted)
  {
    let decipher = Node.crypto.createDecipheriv("aes-256-cbc", PASSWORD_KEY, PASSWORD_IV);
    let decrypted = decipher.update(encrypted, "base64", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  }


  /**
   * Plaintext of the password stored in `idfdata`, whatever form it has. A user created before
   * the password was cipher-protected still holds it in plaintext, and one who never set it
   * holds the constructor default "": neither is a ciphertext, and decrypting them throws
   * (ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH), which made every `setdata` of the IDF config wizard
   * fail with a 500 before anything was saved. Those values are handed back as they are;
   * `setData` re-encrypts whatever it persists, so the stored form migrates at the first save.
   * @returns {String} Plaintext password, or "" when none is stored
   */
  decryptStoredPassword()
  {
    let stored = this.idfdata?.password;
    if (!stored)
      return "";
    //
    try {
      return this.decryptUserPassword(stored);
    }
    catch (ex) {
      return stored;
    }
  }


  /**
   * Returns the fully qualified database name. The `manager` user uses the
   * database name as-is; regular users get a `<userName>-<name>` prefix to
   * avoid collisions across users.
   * @param {String} name - Plain database name
   * @returns {String} Fully qualified database name
   */
  getDbName(name)
  {
    return this.userName === "manager" ? name : `${this.userName}-${name}`;
  }


  /**
   * Returns the tablespace name used by this user: the shared `indets`
   * tablespace for the `manager` user, otherwise the user name itself.
   * @returns {String} Tablespace name
   */
  getDbTableSpace()
  {
    return this.userName === "manager" ? "indets" : this.userName;
  }


  /**
   * Returns the database owner role used by this user: the shared `inde`
   * account for the `manager` user, otherwise the user name itself.
   * @returns {String} Database owner name
   */
  getDbOwner()
  {
    return this.userName === "manager" ? "inde" : this.userName;
  }


  /**
   * Returns the database role used by this user: the shared `inde` role for
   * the `manager` user, otherwise the user name itself.
   * @returns {String} Database role name
   */
  getDbRole()
  {
    return this.userName === "manager" ? "inde" : this.userName;
  }


  /**
   * Lists the TeamWorks projects available to the organization.
   * Requires the TeamWorks module to be active on the install; when enabled,
   * instantiates a minimal {@link TwGCloudDriver} and delegates the actual
   * listing to it.
   * @param {Object} params - Command parameters (unused by this method)
   * @returns {Promise<Object[]>} Array of TeamWorks project descriptors (empty when the driver returns nothing)
   * @throws {Error} If the TeamWorks module is disabled or the listing fails
   */
  async listTeamWorksProjects(params)
  {
    try {
      // Check if TeamWorks module is active
      if (!this.config.isProductActive(Node.Utils.IdfModules.MOD_TW))
        throw new Error("TeamWorks module is not active");
      //
      try {
        // Import TwGCloudDriver from the highest installed IDE version: the TW modules load the InDe
        // model from their ../../ide sibling, which next to the shared server doesn't exist on
        // multi-version servers. On flat servers this resolves to the usual server/TW folder
        let TwGCloudDriver = require(Node.path.join(Node.Utils.resolveIdeDir(this.config.getHighestIdeVersion()), "..", "server", "TW", "TwGCloudDriver"));
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
        return await driver.listProjects() || [];
      }
      catch (err) {
        throw new Error(`Error listing TeamWorks projects: ${err.message || err}`, {cause: err});
      }
    }
    catch (err) {
      this.log("ERROR", err.message || err, "User.listTeamWorksProjects");
      throw err;
    }
  }


  /**
   * Forks a TeamWorks project into the user's workspace. The destination name
   * is derived from `<projectName>-fork`, automatically incremented with a
   * numeric suffix to avoid collisions with existing forks. The remote project
   * is downloaded through {@link TwGCloudDriver}, registered via
   * {@link Node.User#createProject} and tagged with `twFork: true`.
   * Note: expected errors (TeamWorks disabled, missing inputs) are logged as
   * warnings rather than errors to keep noise low on the operations log.
   * @param {Object} params - Command parameters (expects `params.req.query.projectId` and `projectName`)
   * @throws {Error} If the TeamWorks module is disabled, inputs are missing, or the fork fails
   */
  async forkProjectFromTeamWorks(params)
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
      let localPath = Node.path.join(this.getProjectsDir(), finalProjectName);
      //
      try {
        // Import TwGCloudDriver from the highest installed IDE version: the TW modules load the InDe
        // model from their ../../ide sibling, which next to the shared server doesn't exist on
        // multi-version servers. On flat servers this resolves to the usual server/TW folder
        let TwGCloudDriver = require(Node.path.join(Node.Utils.resolveIdeDir(this.config.getHighestIdeVersion()), "..", "server", "TW", "TwGCloudDriver"));
        //
        // Create a minimal driver instance pointed at the master's bucket space
        let driver = new TwGCloudDriver({
          originalPrjName: projectName,
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
          throw new Error(`Error creating fork: ${err.message || err}`, {cause: err});
        }
        //
        // Forking is how a user joins a project: record them among the users
        // known to the master (best-effort — the fork stands anyway)
        try {
          await driver.registerKnownUser();
        }
        catch (err) {
          this.log("WARN", `Can't record the user among the project's known users: ${err.message || err}`, "User.forkProjectFromTeamWorks");
        }
        //
        // Create the project with the fork name
        try {
          await this.createProject(finalProjectName);
        }
        catch (err) {
          throw new Error(`Error creating fork: ${err.message || err}`, {cause: err});
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
      }
      catch (err) {
        throw new Error(`Error creating TeamWorks driver: ${err.message || err}`, {cause: err});
      }
    }
    catch (err) {
      this.log(warning ? "WARN" : "ERROR", err.message || err, "User.forkProjectFromTeamWorks");
      throw err;
    }
  }


  /**
   * Downloads the MASTER of a TeamWorks project into the user's workspace:
   * a replica of the bucket master the user can accept PRs from, provided they are
   * in the project's maintainer list (verified here and again at runtime on
   * every publish operation). The local name is `<projectName>-master`
   * (numeric suffix on collision — the replica addresses its bucket space
   * through `originalPrjName`); the project is tagged with `twMaster: true`.
   * @param {Object} params - Command parameters (expects `params.req.query.projectName`)
   * @throws {Error} If the TeamWorks module is disabled, inputs are missing,
   *   the user is not a maintainer, or the download fails
   */
  async downloadMasterFromTeamWorks(params)
  {
    let warning = false;
    try {
      // Check if TeamWorks module is active
      if (!this.config.isProductActive(Node.Utils.IdfModules.MOD_TW)) {
        warning = true;
        throw new Error("TeamWorks module is not active");
      }
      //
      let projectName = params.req.query.projectName;
      if (!projectName) {
        warning = true;
        throw "Project to download not found";
      }
      //
      // Generate the local name: projectName-master, projectName-master1, ...
      let baseName = `${projectName}-master`;
      let finalProjectName = baseName;
      let counter = 0;
      while (this.getProject(finalProjectName)) {
        counter++;
        finalProjectName = baseName + counter;
      }
      //
      // Local path for the project (use the final name)
      let localPath = Node.path.join(this.getProjectsDir(), finalProjectName);
      //
      try {
        // Import TwGCloudDriver from the highest installed IDE version: the TW modules load the InDe
        // model from their ../../ide sibling, which next to the shared server doesn't exist on
        // multi-version servers. On flat servers this resolves to the usual server/TW folder
        let TwGCloudDriver = require(Node.path.join(Node.Utils.resolveIdeDir(this.config.getHighestIdeVersion()), "..", "server", "TW", "TwGCloudDriver"));
        //
        // Create a minimal driver instance
        let driver = new TwGCloudDriver({
          child: {
            config: this.config,
            project: {
              user: this
            }
          }
        });
        //
        // Only maintainers may download the master: check against the
        // project's remote TwConfig (missing list = master user alone)
        let userGuid = driver.getCurrentUserGuid();
        let twConfigData = await driver.downloadFile(`${projectName}/TwConfig.json`);
        let twConfig = twConfigData ? JSON.parse(twConfigData) : null;
        let maintainers = TwGCloudDriver.maintainersFrom(twConfig);
        if (!maintainers.some(m => m.id === userGuid)) {
          warning = true;
          throw new Error("Current user is not a maintainer of the project");
        }
        //
        // Download project from TeamWorks
        try {
          await driver.downloadProject(projectName, localPath);
        }
        catch (err) {
          throw new Error(`Error downloading master: ${err.message || err}`, {cause: err});
        }
        //
        // Create the project with the local name
        try {
          await this.createProject(finalProjectName);
        }
        catch (err) {
          throw new Error(`Error creating master: ${err.message || err}`, {cause: err});
        }
        //
        // Tag the project as a master replica
        let newProject = this.getProject(finalProjectName);
        newProject.updateInfo({twMaster: true, lastSave: new Date()});
        //
        this.log("INFO", "Master downloaded from TeamWorks successfully", "User.downloadMasterFromTeamWorks",
                {projectName, localName: finalProjectName});
      }
      catch (err) {
        // The maintainer denial is a message of its own: don't rewrap it
        if (warning)
          throw err;
        //
        throw new Error(`Error creating TeamWorks driver: ${err.message || err}`, {cause: err});
      }
    }
    catch (err) {
      this.log(warning ? "WARN" : "ERROR", err.message || err, "User.downloadMasterFromTeamWorks");
      throw err;
    }
  }
};


// Export module
module.exports = Node.User;
