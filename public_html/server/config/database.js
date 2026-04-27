/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
var Node = Node || {};

// Import modules
Node.pg = require("pg");
Node.fs = require("fs");
Node.child = require("child_process");
Node.path = require("path");

// Import classes
Node.Archiver = require("../archiver");


/**
 * @class Represents an Instant Developer Database
 * @param {Node.User} par
 */
Node.Database = function (par)
{
  this.parent = par;
  this.name = "";
};


// Define usefull properties for this object
Object.defineProperties(Node.Database.prototype, {
  user: {
    get() {
      return this.parent;
    }
  },
  server: {
    get() {
      return this.parent.parent.parent;
    }
  },
  config: {
    get() {
      return this.parent.parent;
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
Node.Database.prototype.log = function (level, message, sender, data)
{
  // Add "local" info
  data = (data ? JSON.parse(JSON.stringify(data)) : {});
  data.database = this.name;
  data.user = this.user.userName;
  //
  this.logger.log(level, message, sender, data);
};

/**
 * Save the object
 */
Node.Database.prototype.save = function ()
{
  return {
    cl: "Node.Database",
    name: this.name,
    remoteUrl: this.remoteUrl
  };
};


/**
 * Load the object
 * @param {Object} v - the object that contains my data
 */
Node.Database.prototype.load = function (v)
{
  this.name = v.name;
  if (v.remoteUrl)
    this.remoteUrl = v.remoteUrl;
};


/**
 * Save the object's properties (i.e. no children objects)
 */
Node.Database.prototype.saveProperties = function ()
{
  let r = this.save();
  //
  // Delete children
  delete r.cl;
  //
  return r;
};


/**
 * Set the parent of this object (and its children)
 * @param {Node.User} par
 */
Node.Database.prototype.setParent = function (par)
{
  this.parent = par;
};


/**
 * Initialize database enviroment
 * @param {string} dbName
 */
Node.Database.prototype.init = async function (dbName)
{
  this.name = dbName;
  //
  // Initialize environment
  await Node.Database.initDbEnv(this.user);
  //
  // Create the physical database
  await this.createDb();
};


/**
 * Initialize the database enviroment (create tablespace, role)
 * @param {user} user
 */
Node.Database.initDbEnv = async function (user)
{
  // Path where the tablespace will be stored
  let dbPath;
  if (user.userName === "manager")
    dbPath = Node.path.join(user.config.appDirectory, "db");
  else
    dbPath = Node.path.join(user.config.directory, user.userName, "db");
  //
  // Create a new client to communicate with the db
  let client, logData;
  try {
    try {
      client = await Node.Database.openConnection(user.config);
    }
    catch (err) {
      logData = {conString: Node.Database.getURL(user.config)};
      throw new Error(`Error connecting to the database: ${err}`);
    }
    //
    // Create the role
    let query = `CREATE ROLE "${user.getDbRole()}" CREATEDB LOGIN PASSWORD '${user.dbPassword}' NOINHERIT VALID UNTIL 'infinity';`;
    try {
      await client.query(query);
    }
    catch (err) {
      if (err.code !== "42710" && err.code !== "23505") { // 42710: role already exists, 23505: duplicate key value violates unique constraint
        logData = {query};
        throw new Error(`Error while creating ROLE: ${err}`);
      }
    }
    //
    // Create a tablespace
    let owner = user.getDbOwner();
    let tableSpace = user.getDbTableSpace();
    query = `CREATE TABLESPACE "${tableSpace}" OWNER "${owner}" LOCATION '${dbPath}';`;
    //
    try {
      await client.query(query);
    }
    catch (err) {
      if (err.code !== "42710" && err.code !== "23505") {    // 42710/23505: tablespace already exists
        logData = {query};
        throw new Error(`Error while creating TABLESPACE: ${err}`);
      }
    }
    //
    query = `SET default_tablespace = "${tableSpace}";`;
    //
    try {
      await client.query(query);
    }
    catch (err) {
      if (err.code !== "42710") {    // 42710: default tablespace already set
        logData = {query};
        throw new Error(`Error while setting default tablespace for user: ${err}`);
      }
    }
  }
  catch (err) {
    user.log("ERROR", err.message || err, "Database.initDbEnv", logData);
    throw err;
  }
  finally {
    client?.end();
  }
};


/**
 * Clean the database enviroment (remove tablespace, role)
 * @param {user} user
 */
Node.Database.cleanDbEnv = async function (user)
{
  let client, logData;
  try {
    // MANAGER user can't clean up DB environment!
    if (user.userName === "manager")
      throw new Error("Can't clean DB environment for MANAGER user");
    //
    // Create a new client to communicate with the db
    try {
      client = await Node.Database.openConnection(user.config);
    }
    catch (err) {
      logData = {conString: Node.Database.getURL(user.config)};
      throw new Error(`Error connecting to the database: ${err}`);

    }
    //
    // Drop the table space
    let query = `DROP TABLESPACE IF EXISTS "${user.getDbTableSpace()}";`;
    try {
      await client.query(query);
    }
    catch (err) {
      logData = {query};
      throw new Error(`Error while dropping TABLESPACE: ${err}`);
    }
    //
    // Drop the role
    query = `DROP ROLE IF EXISTS "${user.userName}";`;
    try {
      await client.query(query);
    }
    catch (err) {
      logData = {query};
      throw new Error(`Error while dropping ROLE: ${err}`);
    }
  }
  catch (err) {
    user.log("ERROR", err.message || err, "Database.cleanDbEnv", logData);
    throw err;
  }
  finally {
    client?.end();
  }
};


/**
 * Get the database's URL (needed for direct connection via command line)
 */
Node.Database.prototype.getURL = function ()
{
  return Node.Database.getURL(this.config, this.user.getDbName(this.name));
};


/**
  * Get the database's URL (needed for direct connection via command line)
  * @param {object} config
  * @return {string} dnmane - if provided the database name is added to the URL
  */
Node.Database.getURL = function (config, dbname)
{
  let conString = `postgres://${config.dbUser}:${config.dbPassword}@${config.dbAddress}:${config.dbPort}`;
  if (dbname)
    conString += `/${dbname}`;
  return conString;
};


/**
 * Open a new connection to the database
 * @param {Object|String} config - configuration object or connection string
 * @param {String} dbname - if provided the database name is added to the URL (ignored if config is a string)
 * @return {Promise<Object>} pg.Client
 */
Node.Database.openConnection = async function (config, dbname)
{
  let conString;
  //
  // If config is already a connection string (remoteUrl), use it directly
  if (typeof config === "string")
    conString = config;
  else // Otherwise build the connection string from the config object
    conString = Node.Database.getURL(config, dbname);
  //
  let client = new Node.pg.Client(conString);
  await client.connect();
  return client;
};


/**
 * Get the status of the database
 * @param {object} params
 */
Node.Database.prototype.sendStatus = async function (params)
{
  let status = {
    name: this.name,
    remoteUrl: this.remoteUrl
  };
  //
  // If local -> can't compute DB size
  if (!this.config.local) {
    // Get the size of the db
    let dbName = this.user.getDbName(this.name);
    let sqlcmd = `select pg_database_size('${dbName}')`;
    //
    try {
      let stdout = await new Promise((resolve, reject) => {
        Node.child.execFile("/usr/local/bin/psql", [`--dbname=${this.getURL()}`, "-t", "-c", sqlcmd], (err, stdout, stderr) => err ? reject(err) : resolve(stdout));
      });
      //
      status.diskSize = stdout.trim();
    }
    catch (err) {
      this.log("ERROR", `Error getting the size of user's DB: ${err}`, "Database.sendStatus", {sqlcmd});
      throw new Error(`Error getting the size of user's DB folder: ${err}`);
    }
  }
  //
  return {msg: JSON.stringify(status)};
};


/**
 * Create a new database
 */
Node.Database.prototype.createDb = async function ()
{
  // Create a new client to communicate with the db
  let client, logData;
  try {
    try {
      client = await Node.Database.openConnection(this.config);
    }
    catch (err) {
      logData = {conString: this.getURL()};
      throw new Error(`Error connecting to the database: ${err}`);
    }
    //
    // Create the database in the right tablespace
    let dbName = this.user.getDbName(this.name);
    let dbOwner = this.user.getDbOwner();
    let dbTableSpace = this.user.getDbTableSpace();
    let query = `CREATE DATABASE "${dbName}" WITH ENCODING='UTF8' OWNER="${dbOwner}" TABLESPACE="${dbTableSpace}";`;
    //
    try {
      await client.query(query);
    }
    catch (err) {
      if (err.code !== "42P04") {    // 42P04 -> database already exists
        logData = {query};
        throw new Error(`Error while creating database: ${err}`);
      }
    }
    // Create vector extension (for app.ai features) if not on Windows (not supported)
    // Must connect to the newly created database, as extensions are per-database
    if (!process.platform.startsWith("win")) {
      let dbClient;
      try {
        dbClient = await Node.Database.openConnection(this.config, dbName);
        await dbClient.query("CREATE EXTENSION IF NOT EXISTS vector;");
      }
      catch (err) {
        logData = {query: "CREATE EXTENSION IF NOT EXISTS vector;"};
        throw new Error(`Error while creating vector extension on database: ${err}`);
      }
      finally {
        dbClient?.end();
      }
    }
  }
  catch (err) {
    this.log("ERROR", err.message || err, "Database.createDb", logData);
    throw err;
  }
  finally {
    client?.end();
  }
};


/**
 * Delete the database
 */
Node.Database.prototype.dropDb = async function ()
{
  // Create a new client to communicate with the db
  let client, logData;
  try {
    try {
      client = await Node.Database.openConnection(this.config);
    }
    catch (err) {
      logData = {conString: this.getURL()};
      throw new Error(`Error connecting to the database: ${err}`);
    }
    //
    // Drop the database
    let query = `DROP DATABASE IF EXISTS "${this.user.getDbName(this.name)}";`;
    try {
      await client.query(query);
    }
    catch (err) {
      logData = {query};
      throw new Error(`Error while dropping the database: ${err}`);
    }
  }
  catch (err) {
    this.log("ERROR", err.message || err, "Database.dropDb", logData);
    throw err;
  }
  finally {
    client?.end();
  }
};


/**
 * Execute a query in the database
 * @param {object} params
 * @return {Promise<{msg: string}>}
 */
Node.Database.prototype.query = async function (params)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Change the app configuration via web commands
 * @param {object} params
 */
Node.Database.prototype.configure = async function (params)
{
  // Compute the array of properties provided via url
  let query = params.req.query;
  let queryProps = Object.getOwnPropertyNames(query);
  if (queryProps.length === 0) {
    this.log("WARN", "No property specified", "Database.configure");
    throw new Error("No property specified");
  }
  //
  if (query.remoteUrl !== undefined)
    this.remoteUrl = query.remoteUrl;
  //
  // Save the new configuration
  this.config.saveConfig();
  //
  // Log the operation
  this.log("DEBUG", "Updated database configuration", "Database.configure", {config: query});
};


/**
 * Rename an existing database
 * @param {object} params
 */
Node.Database.prototype.renameDb = async function (params)
{
  // Command is in the form
  // (http://servername/username/db/dbname/rename?newName=newName)
  let newName = params.req.query.newName;
  let oldName = this.name;
  let client, logData;
  let warning = false;
  //
  try {
    // If a new name was not provided or it's the same as the old one
    if (!newName) {
      warning = true;
      throw new Error("Can't rename database: new name not specified");
    }
    if (newName === oldName) {
      warning = true;
      throw new Error("Can't rename database: new name and old name are the same");
    }
    //
    // Create a new client to communicate with the db
    try {
      client = await Node.Database.openConnection(this.config);
    }
    catch (err) {
      logData = {conString: Node.Database.getURL(this.config)};
      throw new Error(`Error connecting to the database: ${err}`);
    }
    //
    // Change the db name
    let oldDbName = this.user.getDbName(this.name);
    let newDbName = this.user.getDbName(newName);
    let query = `ALTER DATABASE "${oldDbName}" RENAME TO "${newDbName}";`;
    try {
      await client.query(query);
    }
    catch (err) {
      logData = {query};
      throw new Error(`Error while renaming the database: ${err}`);
    }
    //
    // Update the DB name
    this.name = newName;
    this.config.saveConfig();
    //
    // Log the rename operation
    this.log("INFO", "Database renamed", "Database.renameDb", {old: oldName, new: newName});
  }
  catch (err) {
    this.log(warning ? "WARN" : "ERROR", err.message || err, "Database.renameDb", logData);
    throw err;
  }
  finally {
    client?.end();
  }
};


/**
 * Backup Db and gives a .gz file
 * @param {object} params
 */
Node.Database.prototype.backup = async function (params)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Restore a db from a cloud backup
 * @param {object} params
 */
Node.Database.prototype.restore = async function (params)
{
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Call the execution of the commands related to a database
 * @param {object} params
 */
Node.Database.prototype.processCommand = async function (params)
{
  return await this.execCommand(params);
};


/**
 * Execute command for the database
 * @param {object} params
 */
Node.Database.prototype.execCommand = async function (params)
{
  let command = params.tokens[0];
  //
  // If the authorization key is enabled and the given one does not match -> error
  if (this.config.auth && params.req.query.autk !== this.config.autk) {
    this.log("WARN", "Unauthorized", "Database.execCommand", {url: params.req.originalUrl});
    throw {err: "Unauthorized", code: 401};
  }
  //
  switch (command) {
    case "status":
      return await this.sendStatus(params);

    case "query":
      return await this.query(params);

    case "config":
      return await this.configure(params);

    case "backup":
      return await this.backup(params);

    case "restore":
      return await this.restore(params);

    case "rename":
      return await this.renameDb(params);
      
    default:
      this.log("WARN", "Invalid Command", "Database.execCommand", {cmd: command, url: params.req.originalUrl});
      throw new Error("Invalid Command");
  }
};


// Export module
module.exports = Node.Database;
