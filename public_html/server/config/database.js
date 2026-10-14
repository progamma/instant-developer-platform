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
Node.Utils = require("../utils");


/**
 * @class Node.Database
 * @classdesc
 * Represents a PostgreSQL database managed by an Instant Developer user.
 * Each instance wraps a named database and exposes the full lifecycle
 * (creation, drop, rename, backup, restore) plus query execution and status
 * introspection. The class also handles the preparation of the shared
 * environment (role, tablespace) required before user databases can be created.
 *
 * Key features:
 * - **Lifecycle management**: create, rename and drop the underlying database
 * - **Environment bootstrap**: initialize/cleanup PostgreSQL role and tablespace
 * - **Backup & restore**: dump to and restore from cloud storage via Archiver
 * - **Remote databases**: optional `remoteUrl` to target an external instance
 * - **Web command dispatch**: execute status/query/config/backup/restore/rename from HTTP requests
 *
 * @property {Node.User} parent - Owner user of this database
 * @property {String} name - Logical name of the database (without user prefix)
 * @property {String} [remoteUrl] - Optional connection string pointing to an external PostgreSQL instance
 */
Node.Database = class Database
{
  /**
   * @param {Node.User} par - Owner user for this database
   */
  constructor(par)
  {
    this.parent = par;
    this.name = "";
  }


  /**
   * Initialize the PostgreSQL environment for a user: create the login ROLE,
   * create the user's TABLESPACE under the user directory (or the app directory
   * when the user is `manager`) and set it as default tablespace for the session.
   * Errors due to pre-existing role/tablespace (codes 42710 and 23505) are
   * silently ignored so the method is idempotent.
   * @param {Node.User} user - User whose environment must be prepared
   * @throws {Error} When connection fails or a CREATE/SET statement fails
   */
  static async initDbEnv(user)
  {
    // Path where the tablespace will be stored. This always lives on the local per-user folder,
    // never on the configurable projects directory (IdsPrjDir, #14585): a PostgreSQL tablespace on
    // a network share / cloud-sync drive is unsupported and the local Postgres server may not even
    // reach the path (CREATE TABLESPACE would fail). Only project sources follow getProjectsDir().
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
        throw new Error(`Error connecting to the database: ${err.message || err}`, {cause: err});
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
          throw new Error(`Error while creating ROLE: ${err.message || err}`, {cause: err});
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
          throw new Error(`Error while creating TABLESPACE: ${err.message || err}`, {cause: err});
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
          throw new Error(`Error while setting default tablespace for user: ${err.message || err}`, {cause: err});
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
  }


  /**
   * Clean up the PostgreSQL environment of a user: drop the tablespace and
   * the role. The `manager` user is forbidden from running this operation
   * because it would tear down the shared production environment.
   * @param {Node.User} user - User whose environment must be removed
   * @throws {Error} When called for the `manager` user, or when connection/DROP statements fail
   */
  static async cleanDbEnv(user)
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
        throw new Error(`Error connecting to the database: ${err.message || err}`, {cause: err});

      }
      //
      // Drop the table space
      let query = `DROP TABLESPACE IF EXISTS "${user.getDbTableSpace()}";`;
      try {
        await client.query(query);
      }
      catch (err) {
        logData = {query};
        throw new Error(`Error while dropping TABLESPACE: ${err.message || err}`, {cause: err});
      }
      //
      // Drop the role
      query = `DROP ROLE IF EXISTS "${user.userName}";`;
      try {
        await client.query(query);
      }
      catch (err) {
        logData = {query};
        throw new Error(`Error while dropping ROLE: ${err.message || err}`, {cause: err});
      }
    }
    catch (err) {
      user.log("ERROR", err.message || err, "Database.cleanDbEnv", logData);
      throw err;
    }
    finally {
      client?.end();
    }
  }


  /**
   * Build a PostgreSQL connection URL from the server configuration.
   * If a database name is provided it is appended as path component.
   * @param {Node.Config} config - Configuration holding user, password, address and port
   * @param {String} [dbname] - Optional fully-qualified database name to append to the URL
   * @returns {String} PostgreSQL connection URL
   */
  static getURL(config, dbname)
  {
    let conString = `postgres://${config.dbUser}:${config.dbPassword}@${config.dbAddress}:${config.dbPort}`;
    if (dbname)
      conString += `/${dbname}`;
    return conString;
  }


  /**
   * Open a new connection to PostgreSQL and return a connected client.
   * When `config` is a string it is treated as a full connection URL
   * (e.g. a `remoteUrl`); otherwise a URL is built from the config object.
   * The caller is responsible for calling `client.end()` when done.
   * @param {Node.Config|String} config - Configuration object or connection string
   * @param {String} [dbname] - Database name to append to the URL (ignored when `config` is a string)
   * @returns {Promise<Object>} Connected `pg.Client` instance
   * @throws {Error} When the underlying connect call fails
   */
  static async openConnection(config, dbname)
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
  }


  /**
   * Gets the user that owns this database.
   * @type {Node.User}
   * @readonly
   */
  get user()
  {
    return this.parent;
  }


  /**
   * Gets the top-level server instance.
   * @type {Node.Server}
   * @readonly
   */
  get server()
  {
    return this.parent.parent.parent;
  }


  /**
   * Gets the server configuration object.
   * @type {Node.Config}
   * @readonly
   */
  get config()
  {
    return this.parent.parent;
  }


  /**
   * Gets the shared logger from the server.
   * @type {Node.Logger}
   * @readonly
   */
  get logger()
  {
    return this.server.logger;
  }


  /**
   * Log a new message enriched with database and user context.
   * The `data` object is deep-cloned before augmenting it with `database` and `user`
   * fields so the caller's payload is not mutated.
   * @param {String} level - Message level (DEBUG, INFO, WARN, ERROR)
   * @param {String} message - Text message
   * @param {String} sender - Name of the function that generated the message
   * @param {Object} [data] - Optional data object to log
   */
  log(level, message, sender, data)
  {
    // Add "local" info
    data = {
      ...data,
      database: this.name,
      user: this.user.userName
    };
    //
    this.logger.log(level, message, sender, data);
  }


  /**
   * Serialize the database instance to a plain JSON-friendly object.
   * The `cl` property holds the class name used by the loader to rebuild
   * the instance.
   * @returns {Object} Serialized representation of the database
   */
  save()
  {
    return {
      cl: "Node.Database",
      name: this.name,
      remoteUrl: this.remoteUrl
    };
  }


  /**
   * Restore the database state from a previously saved object.
   * @param {Object} v - Serialized data produced by {@link Node.Database#save}
   */
  load(v)
  {
    this.name = v.name;
    if (v.remoteUrl)
      this.remoteUrl = v.remoteUrl;
  }


  /**
   * Serialize only the own properties of this database (no class marker).
   * Produced by calling {@link Node.Database#save} and stripping the `cl` field,
   * so the result is suitable for merging into a parent's serialized payload.
   * @returns {Object} Plain object with the database properties
   */
  saveProperties()
  {
    let r = this.save();
    //
    // Delete children
    delete r.cl;
    //
    return r;
  }


  /**
   * Set the parent user of this database (and propagate to children if any).
   * @param {Node.User} par - New parent user
   */
  setParent(par)
  {
    this.parent = par;
  }


  /**
   * Initialize this database: store the name, prepare the PostgreSQL
   * environment (role and tablespace) for the owner user, then create
   * the physical database.
   * @param {String} dbName - Logical name to assign to the database
   */
  async init(dbName)
  {
    this.name = dbName;
    //
    // Initialize environment
    await Node.Database.initDbEnv(this.user);
    //
    // Create the physical database
    await this.createDb();
  }


  /**
   * Build the PostgreSQL connection URL for this database, including the
   * fully-qualified database name (user prefix + logical name).
   * Useful to hand over to `psql` / `pg_dump` via the command line.
   * @returns {String} PostgreSQL connection URL
   */
  getURL()
  {
    return Node.Database.getURL(this.config, this.user.getDbName(this.name));
  }


  /**
   * Lazily loads the IDE Postgres driver (only its static `resolvePgBinary` helper is used here, to
   * resolve the absolute path of pg_dump / psql). Loaded on first use instead of at module load, so
   * the IDE folder is resolved when the installed-versions registry is available: it resolves to the
   * highest installed version's ide (on a flat server the registry is empty and `resolveIdeDir`
   * falls back to the single `public_html/ide`). Without a driver a minimal fallback keeps the
   * pre-26.3 behavior for the pg binaries (the fixed install path, then the bare name resolved
   * through the PATH): on servers with no ide folder at all (my-cloud and self-managed production)
   * the fallback is cached on the class like the driver, since that state is permanent; when the
   * ide folder exists but its modules are not resolvable yet (the flat >= 26.3 window before the
   * migration completes, logged once) the fallback is returned WITHOUT caching, so the real driver
   * is retried at the next call.
   * @returns {Function} The App.Postgres driver class (or the minimal fallback)
   */
  getAppPostgres()
  {
    if (!Node.Database.appPostgres) {
      // Minimal fallback keeping the pre-26.3 behavior for the pg binaries
      let fallback = {resolvePgBinary: name => Node.fs.existsSync(`/usr/local/bin/${name}`) ? `/usr/local/bin/${name}` : name};
      let ideDir = Node.Utils.resolveIdeDir(this.config.getHighestIdeVersion());
      if (!Node.fs.existsSync(ideDir))
        Node.Database.appPostgres = fallback;   // No ide folder on this server (my-cloud/self-managed): permanent, cache it
      else {
        try {
          Node.Database.appPostgres = require(Node.path.join(ideDir, "app", "server", "requireAll")).Postgres;
        }
        catch (err) {
          // The ide folder exists but its modules don't resolve: the window of a flat >= 26.3 server
          // (between the transition update, whose npm pruned the shared node_modules to the server
          // set, and the completed migration). Warn once: getStatus calls this in a loop over every
          // database, and the window would flood the log with identical lines at every status poll
          if (!Node.Database.appPostgresWarned) {
            Node.Database.appPostgresWarned = true;
            this.log("WARN", `Can't load the IDE Postgres driver, using the pg-binaries fallback: ${err.message || err}`, "Database.getAppPostgres");
          }
          //
          // Transient state: return the fallback WITHOUT caching it, so the real driver is retried
          // at the next call (e.g. right after the migration completes)
          return fallback;
        }
      }
    }
    //
    return Node.Database.appPostgres;
  }


  /**
   * Get the current status of the database.
   * Returns at least the name and the (optional) remote URL.
   * For non-local configurations it also computes the on-disk size
   * by running `psql` with `pg_database_size` on the underlying database.
   * @param {Object} params - Command parameters (reserved for future use)
   * @returns {Promise<Object>} Status object with `name`, `remoteUrl` and optionally `diskSize`
   * @throws {Error} When the size query fails
   */
  async getStatus(params)
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
        let psql = this.getAppPostgres().resolvePgBinary("psql");
        let stdout = await new Promise((resolve, reject) => {
          Node.child.execFile(psql, [`--dbname=${this.getURL()}`, "-t", "-c", sqlcmd], (err, stdout, stderr) => err ? reject(err) : resolve(stdout));
        });
        //
        status.diskSize = stdout.trim();
      }
      catch (err) {
        this.log("ERROR", `Error getting the size of user's DB: ${err.message || err}`, "Database.getStatus", {sqlcmd});
        throw new Error(`Error getting the size of user's DB folder: ${err.message || err}`, {cause: err});
      }
    }
    //
    return status;
  }


  /**
   * Create the physical PostgreSQL database owned by the user in the
   * user's tablespace with UTF-8 encoding. Errors with SQLSTATE 42P04
   * (database already exists) are ignored, so the call is idempotent.
   * On non-Windows platforms the `vector` extension is also enabled on
   * the newly created database to support App.AI features.
   * @throws {Error} When connection fails or the CREATE DATABASE / extension statement fails
   */
  async createDb()
  {
    // Create a new client to communicate with the db
    let client, logData;
    try {
      try {
        client = await Node.Database.openConnection(this.config);
      }
      catch (err) {
        logData = {conString: this.getURL()};
        throw new Error(`Error connecting to the database: ${err.message || err}`, {cause: err});
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
          throw new Error(`Error while creating database: ${err.message || err}`, {cause: err});
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
          throw new Error(`Error while creating vector extension on database: ${err.message || err}`, {cause: err});
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
  }


  /**
   * Drop the physical PostgreSQL database associated with this instance.
   * Uses `DROP DATABASE IF EXISTS`, so the call is safe when the database
   * was never created or was already removed.
   * @throws {Error} When connection fails or the DROP DATABASE statement fails
   */
  async dropDb()
  {
    // Create a new client to communicate with the db
    let client, logData;
    try {
      try {
        client = await Node.Database.openConnection(this.config);
      }
      catch (err) {
        logData = {conString: this.getURL()};
        throw new Error(`Error connecting to the database: ${err.message || err}`, {cause: err});
      }
      //
      // Drop the database
      let query = `DROP DATABASE IF EXISTS "${this.user.getDbName(this.name)}";`;
      try {
        await client.query(query);
      }
      catch (err) {
        logData = {query};
        throw new Error(`Error while dropping the database: ${err.message || err}`, {cause: err});
      }
    }
    catch (err) {
      this.log("ERROR", err.message || err, "Database.dropDb", logData);
      throw err;
    }
    finally {
      client?.end();
    }
  }


  /**
   * Execute an SQL statement against this database.
   * The query text is URL-decoded from `params.req.query.query` and sent to
   * the underlying database through a dedicated client; if `remoteUrl` is set
   * the connection is opened against the remote instance instead.
   * The returned object is the raw `pg` result, with a few internal-only
   * fields stripped and an `executionTime` (milliseconds) added.
   * @param {Object} params - Command parameters; `params.req.query.query` must contain the (URL-encoded) SQL
   * @returns {Promise<Object>} The `pg` result object with `executionTime` in milliseconds
   * @throws {Error} When the query text is empty, the connection fails or the statement errors out
   */
  async query(params)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Update database configuration properties supplied on the request query
   * string. Currently only `remoteUrl` is honored; any other property is
   * accepted in the payload but ignored. On success the updated configuration
   * is persisted via the parent config.
   * @param {Object} params - Command parameters; `params.req.query` holds the property assignments
   * @throws {Error} When the query string contains no properties
   */
  async configure(params)
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
    await this.config.saveConfig();
    //
    // Log the operation
    this.log("DEBUG", "Updated database configuration", "Database.configure", {config: query});
  }


  /**
   * Rename the physical database using the `newName` value from the
   * request query string (e.g. `/username/db/dbname/rename?newName=...`).
   * After the `ALTER DATABASE ... RENAME TO` succeeds the in-memory name
   * is updated and the configuration is persisted.
   * @param {Object} params - Command parameters; `params.req.query.newName` must contain the new logical name
   * @throws {Error} When the new name is missing/equal to the current one, or when connection/ALTER fail
   */
  async renameDb(params)
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
        throw new Error(`Error connecting to the database: ${err.message || err}`, {cause: err});
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
        throw new Error(`Error while renaming the database: ${err.message || err}`, {cause: err});
      }
      //
      // Update the DB name
      this.name = newName;
      await this.config.saveConfig();
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
  }


  /**
   * Dump the database with `pg_dump` into a temporary folder and upload the
   * resulting archive to cloud storage via {@link Node.Archiver}.
   * The destination path is taken from `params.req.query.path` when provided
   * (either a full `.tar.gz` file path or a folder) and otherwise falls back
   * to the standard user backup location. The `manager` user requires an
   * explicit path because there is no default bucket for production databases.
   * The temporary folder is always cleaned up, even on failure.
   * @param {Object} params - Command parameters; `params.req.query.path` is an optional cloud destination
   * @throws {Error} When the temporary folder cannot be prepared, `pg_dump` fails, or the cloud upload fails
   */
  async backup(params)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Restore the database from a cloud backup.
   * Downloads the archive via {@link Node.Archiver}, expands it into a
   * temporary folder and replays the SQL dump with `psql`. For non-manager
   * users a final `REASSIGN OWNED BY indert TO ...` reassigns the objects
   * to the expected database owner, because the dump is created with
   * `--no-owner`. The temporary folder is always cleaned up, even on failure.
   * The cloud path follows the same rules as {@link Node.Database#backup}.
   * @param {Object} params - Command parameters; `params.req.query.path` is an optional cloud source
   * @throws {Error} When the archive cannot be downloaded/expanded or `psql` fails to apply the dump
   */
  async restore(params)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Entry point invoked by the HTTP router to handle database-scoped commands.
   * Simply forwards to {@link Node.Database#execCommand}; kept as a separate
   * hook so subclasses/callers can intercept the dispatch.
   * @param {Object} params - Command parameters forwarded from the router
   * @returns {Promise<*>} The value returned by the handler for the resolved command
   */
  async processCommand(params)
  {
    return await this.execCommand(params);
  }


  /**
   * Resolve and execute the command identified by `params.tokens[0]`.
   * Supported commands are `status`, `query`, `config`, `backup`, `restore`
   * and `rename`. When the server is configured with an authorization key
   * the request must provide a matching `autk` query parameter, otherwise
   * the call is rejected with a 401 error.
   * @param {Object} params - Command parameters; `params.tokens[0]` holds the command name
   * @returns {Promise<*>} The value returned by the invoked handler
   * @throws {Error} With `code === 401` when unauthorized, or a generic error for unknown commands
   */
  async execCommand(params)
  {
    let command = params.tokens[0];
    //
    this.config.checkAuthorization(params, "Database.execCommand");
    //
    switch (command) {
      case "status":
        return await this.getStatus(params);

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
  }
};


// Export module
module.exports = Node.Database;
