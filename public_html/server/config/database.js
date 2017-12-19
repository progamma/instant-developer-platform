/*
 * Instant Developer Next
 * Copyright Pro Gamma Spa 2000-2016
 * All rights reserved
 */
/* global require, module */

var Node = Node || {};

// Import modules
Node.pg = require("pg");
Node.fs = require("fs");
Node.child = require("child_process");
Node.rimraf = require("rimraf");

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
    get: function () {
      return this.parent;
    }
  },
  server: {
    get: function () {
      return this.parent.parent.parent;
    }
  },
  config: {
    get: function () {
      return this.parent.parent;
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
  var r = {cl: "Node.Database", name: this.name, remoteUrl: this.remoteUrl};
  return r;
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
  var r = this.save();
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
 * @param {function} callback - function(err)
 */
Node.Database.prototype.init = function (dbName, callback)
{
  var pthis = this;
  this.name = dbName;
  //
  // Initialize environment
  Node.Database.initDbEnv(this.user, function (err) {
    if (err)
      return callback(err);
    //
    // Create the physical database
    pthis.createDb(callback);
  });
};


/**
 * Initialize the database enviroment (create tablespace, role)
 * @param {user} user
 * @param {function} callback - function(err)
 */
Node.Database.initDbEnv = function (user, callback)
{
  // Create a new client to communicate with the db
  var conString = "postgres://" + user.config.dbUser + ":" + user.config.dbPassword + "@" +
          user.config.dbAddress + ":" + user.config.dbPort;
  var client = new Node.pg.Client(conString);
  //
  // Path where the tablespace will be stored
  var dbPath;
  if (user.userName === "manager")
    dbPath = user.config.appDirectory + "/db";
  else
    dbPath = user.config.directory + "/" + user.userName + "/db";
  //
  // Open the DB connection
  client.connect(function (err) {
    if (err) {
      client.end();
      //
      user.log("ERROR", "Error connecting to the database: " + err, "Database.initDbEnv", {conString: conString});
      return callback("Error connecting to the database: " + err);
    }
    //
    // Crate the role
    var query;
    if (user.userName === "manager")
      query = "CREATE ROLE inde CREATEDB LOGIN PASSWORD '" + user.dbPassword + "' NOINHERIT VALID UNTIL 'infinity';";
    else
      query = "CREATE ROLE \"" + user.userName + "\" CREATEDB LOGIN PASSWORD '" + user.dbPassword + "' NOINHERIT VALID UNTIL 'infinity';";

    client.query(query, function (err) {
      if (err && err.code !== "42710" && err.code !== "23505") { // 42710: role already exists, 23505: duplicate key value violates unique constraint
        client.end();
        //
        user.log("ERROR", "Error while creating ROLE: " + err, "Database.initDbEnv", {query: query});
        return callback("Error while creating ROLE: " + err);
      }
      //
      // Create a tablespace
      if (user.userName === "manager")
        query = "CREATE TABLESPACE indets OWNER inde LOCATION " + "'" + dbPath + "';";
      else
        query = "CREATE TABLESPACE \"" + user.userName + "\" OWNER \"" + user.userName +
                "\" LOCATION " + "'" + dbPath + "';";
      client.query(query, function (err) {
        if (err && err.code !== "42710" && err.code !== "23505") {    // 42710/23505: tablespace already exists
          client.end();
          //
          user.log("ERROR", "Error while creating TABLESPACE: " + err, "Node.initDbEnv", {query: query});
          return callback("Error while creating TABLESPACE: " + err);
        }
        //
        if (user.userName === "manager")
          query = "SET default_tablespace = indets;";
        else
          query = "SET default_tablespace = \"" + user.userName + "\";";
        client.query(query, function (err) {
          if (err && err.code !== "42710") {    // 42710: default tablespace already set
            client.end();
            //
            user.log("ERROR", "Error while setting default tablespace for user: " + err, "Database.initDbEnv", {query: query});
            return callback("Error while setting default tablespace for user: " + err);
          }
          //
          client.end();
          //
          // Done
          callback();
        });
      });
    });
  });
};


/**
 * Clean the database enviroment (remove tablespace, role)
 * @param {user} user
 * @param {function} callback - function (err)
 */
Node.Database.cleanDbEnv = function (user, callback)
{
  // MANAGER user can't clean up DB environment!
  if (user.userName === "manager") {
    user.log("ERROR", "Can't clean DB environment for MANAGER user", "Database.cleanDbEnv");
    return callback("Can't clean DB environment for MANAGER user");
  }
  //
  // Create a new client to communicate with the db
  var conString = "postgres://" + user.config.dbUser + ":" + user.config.dbPassword + "@" +
          user.config.dbAddress + ":" + user.config.dbPort;
  var client = new Node.pg.Client(conString);
  //
  client.connect(function (err) {
    if (err) {
      client.end();
      //
      user.log("ERROR", "Error connecting to the database: " + err, "Database.cleanDbEnv", {conString: conString});
      return callback("Error connecting to the database: " + err);
    }
    //
    // Drop the table space
    var query = "DROP TABLESPACE IF EXISTS \"" + user.userName + "\";";
    client.query(query, function (err) {
      if (err) {
        client.end();
        //
        user.log("ERROR", "Error while dropping TABLESPACE: " + err, "Database.cleanDbEnv", {query: query});
        return callback("Error while dropping TABLESPACE: " + err);
      }
      //
      // Drop the role
      query = "DROP ROLE IF EXISTS \"" + user.userName + "\";";
      client.query(query, function (err) {
        if (err) {
          client.end();
          //
          user.log("ERROR", "Error while dropping ROLE: " + err, "Database.cleanDbEnv", {query: query});
          return callback("Error while dropping ROLE: " + err);
        }
        //
        client.end();
        //
        // Done
        callback();
      });
    });
  });
};


/**
 * Get the database's URL (needed for direct connection via command line)
 */
Node.Database.prototype.getURL = function ()
{
  var dbname;
  if (this.user.userName === "manager")
    dbname = this.name;
  else
    dbname = this.user.userName + "-" + this.name;
  return "postgresql://" + this.config.dbUser + ":" + this.config.dbPassword + "@" + this.config.dbAddress + ":" + this.config.dbPort + "/" + dbname;
};


/**
 * Get the status of the database
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Database.prototype.sendStatus = function (params, callback)
{
  var status = {name: this.name, remoteUrl: this.remoteUrl};
  //
  // If local -> can't compute DB size
  if (this.config.local)
    return callback({msg: JSON.stringify(status)});
  //
  // Get the size of the db
  var sqlcmd;
  if (this.user.userName === "manager")
    sqlcmd = "select pg_database_size('" + this.name + "')";
  else
    sqlcmd = "select pg_database_size('" + this.user.userName + "-" + this.name + "')";
  Node.child.execFile("/usr/local/bin/psql", ["--dbname=" + this.getURL(), "-t", "-c", sqlcmd], function (err, stdout, stderr) {   // jshint ignore:line
    if (err) {
      this.log("ERROR", "Error getting the size of user's DB: " + err, "Database.sendStatus", {sqlcmd: sqlcmd});
      return callback("Error getting the size of user's DB folder: " + err);
    }
    //
    status.diskSize = stdout.trim();
    callback({msg: JSON.stringify(status)});
  }.bind(this));
};


/**
 * Create a new database
 * @param {function} callback - function(err)
 */
Node.Database.prototype.createDb = function (callback)
{
  var pthis = this;
  //
  // Create a new client to communicate with the db
  var conString = "postgres://" + this.config.dbUser + ":" + this.config.dbPassword + "@" +
          this.config.dbAddress + ":" + this.config.dbPort;
  var client = new Node.pg.Client(conString);
  //
  client.connect(function (err) {
    if (err) {
      client.end();
      //
      pthis.log("ERROR", "Error connecting to the database: " + err, "Database.createDb", {conString: conString});
      return callback("Error connecting to the database: " + err);
    }
    //
    // Create the database in the right tablespace
    var query;
    if (pthis.user.userName === "manager")
      query = "CREATE DATABASE " + "\"" + pthis.name + "\"" +
              " WITH ENCODING='UTF8' OWNER=inde TABLESPACE=indets;";
    else
      query = "CREATE DATABASE " + "\"" + pthis.user.userName + "-" + pthis.name + "\"" +
              " WITH ENCODING='UTF8' OWNER=\"" + pthis.user.userName + "\" TABLESPACE=\"" + pthis.user.userName + "\";";
    client.query(query, function (err) {
      if (err && err.code !== "42P04") {    // 42P04 -> database already exists
        client.end();
        //
        pthis.log("ERROR", "Error while creating database: " + err, "Database.createDb", {query: query});
        return callback("Error while creating database: " + err);
      }
      //
      client.end();
      //
      // Done
      callback();
    });
  });
};


/**
 * Delete the database
 * @param {function} callback - function(err)
 */
Node.Database.prototype.dropDb = function (callback)
{
  var pthis = this;
  //
  // Create a new client to communicate with the db
  var conString = "postgres://" + this.config.dbUser + ":" + this.config.dbPassword + "@" +
          this.config.dbAddress + ":" + this.config.dbPort;
  var client = new Node.pg.Client(conString);
  //
  client.connect(function (err) {
    if (err) {
      client.end();
      //
      pthis.log("ERROR", "Error connecting to the database: " + err, "Database.dropDb", {conString: conString});
      return callback("Error connecting to the database: " + err);
    }
    //
    // Drop the database
    var query;
    if (pthis.user.userName === "manager")
      query = "DROP DATABASE IF EXISTS" + "\"" + pthis.name + "\";";
    else
      query = "DROP DATABASE IF EXISTS" + "\"" + pthis.user.userName + "-" + pthis.name + "\";";
    client.query(query, function (err) {
      if (err) {
        client.end();
        //
        pthis.log("ERROR", "Error while dropping the database: " + err, "Database.dropDb", {query: query});
        return callback("Error while dropping the database: " + err);
      }
      //
      client.end();
      //
      // Done
      callback();
    });
  });
};


/**
 * Execute a query in the database
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Database.prototype.query = function (params, callback)
{
  var pthis = this;
  //
  var query = decodeURIComponent(params.req.query.query);
  var dbName;
  if (pthis.user.userName === "manager")
    dbName = this.name;
  else
    dbName = this.user.userName + "-" + this.name;
  //
  if (!query) {
    this.log("WARN", "Empty query text", "Database.query");
    return callback("Empty query text");
  }
  //
  // Create a new client to communicate with the db
  var conString = this.remoteUrl || "postgres://" + this.config.dbUser + ":" + this.config.dbPassword + "@" +
          this.config.dbAddress + ":" + this.config.dbPort + "/" + dbName;
  var client = new Node.pg.Client(conString);
  //
  client.connect(function (err) {
    if (err) {
      client.end();
      //
      pthis.log("ERROR", "Error connecting to the database: " + err, "Database.query", {conString: conString});
      return callback("Error connecting to the database: " + err);
    }
    //
    client.query(query, function (err, result) {
      if (err) {
        client.end();
        //
        pthis.log("WARN", "Error in database query: " + err, "Database.query", {query: query, conString: conString});
        return callback("Error while executing query: " + err);
      }
      //
      client.end();
      //
      // Done
      callback({msg: JSON.stringify(result)});
    });
  });
};


/**
 * Change the app configuration via web commands
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Database.prototype.configure = function (params, callback)
{
  // Compute the array of properties provided via url
  var query = params.req.query;
  var queryProps = Object.getOwnPropertyNames(query);
  if (queryProps.length === 0) {
    this.log("WARN", "No property specified", "Database.configure");
    return callback("No property specified");
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
  //
  callback();
};


/**
 * Rename an existing database
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Database.prototype.renameDb = function (params, callback)
{
  var pthis = this;
  //
  // Command is in the form
  // (http://servername/username/db/dbname/rename?newName=newName)
  var newName = params.req.query.newName;
  var oldName = this.name;
  //
  // If a new name was not provided or it's the same as the old one
  if (!newName) {
    this.log("WARN", "Can't rename database: new name not specified", "Database.renameDb");
    return callback("Can't rename database: new name not specified");
  }
  if (newName === oldName) {
    this.log("WARN", "Can't rename database: new name and old name are the same", "Database.renameDb");
    return callback("Can't rename database: new name and old name are the same");
  }
  //
  // Create a new client to communicate with the db
  var conString = "postgres://" + this.config.dbUser + ":" + this.config.dbPassword + "@" +
          this.config.dbAddress + ":" + this.config.dbPort;
  var client = new Node.pg.Client(conString);
  //
  client.connect(function (err) {
    if (err) {
      client.end();
      //
      pthis.log("ERROR", "Error connecting to the database: " + err, "Database.renameDb", {conString: conString});
      return callback("Error connecting to the database: " + err);
    }
    //
    // Change the db name
    var query;
    if (pthis.user.userName === "manager")
      query = "ALTER DATABASE " + "\"" + pthis.name +
              "\"" + " RENAME TO " + "\"" + newName + "\"" + ";";
    else
      query = "ALTER DATABASE " + "\"" + pthis.user.userName + "-" + pthis.name +
              "\"" + " RENAME TO " + "\"" + pthis.user.userName + "-" + newName + "\"" + ";";
    client.query(query, function (err) {
      if (err) {
        client.end();
        //
        pthis.log("ERROR", "Error while renaming the database: " + err, "Database.renameDb", {query: query});
        return callback("Error while renaming the database: " + err);
      }
      //
      client.end();
      //
      // Update the DB name
      pthis.name = newName;
      pthis.config.saveConfig();
      //
      // Log the rename operation
      pthis.log("INFO", "Database renamed", "Database.renameDb", {old: oldName, new : newName});
      //
      // Done
      callback();
    });
  });
};


/**
 * Backup Db and gives a .gz file
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Database.prototype.backup = function (params, callback)
{
  var pthis = this;
  //
  var pathDB;
  if (this.user.userName === "manager")
    pathDB = this.config.appDirectory + "/backups/tmp_" + this.name;
  else
    pathDB = this.config.directory + "/" + this.user.userName + "/tmp_" + this.name;
  //
  var pathCloud;
  if (params.req && params.req.query.path) {
    // Given path could be a full file path (with .tar.gz extension) or a folder
    pathCloud = params.req.query.path;
    if (pathCloud.substr(-7) !== ".tar.gz")
      pathCloud += "/" + this.name + ".tar.gz";   // Was a folder
  }
  else {
    // If the DB is a production DB a path on the query string is needed
    // (there is no "default" bucket for productions DB)
    if (this.user.userName === "manager") {
      this.log("WARN", "Can't backup a MANAGER database without a PATH", "Database.backup");
      return callback("Can't backup a MANAGER database without a PATH");
    }
    //
    pathCloud = "users/" + this.config.serverType + "/" + this.user.userName + "/backups/databases/" + this.name + "/" + this.name + ".tar.gz";
  }
  //
  this.log("DEBUG", "Database backup", "Database.backup", {pathCloud: pathCloud, params: (params.req ? params.req.query : undefined)});
  //
  var errorFnc = function (msg) {
    pthis.log("ERROR", msg, "Database.backup");
    callback(msg);
    //
    // Operation failed -> clean up
    Node.rimraf(pathDB, function () {
    });
  };
  //
  // Remove the temp folder if present (due to a failed previous backup)
  Node.rimraf(pathDB, function (err) {
    if (err)
      return errorFnc("Error removing the previous temp folder (" + pathDB + "): " + err);
    //
    // Create the directory
    Node.fs.mkdir(pathDB, function (err) {
      if (err)
        return errorFnc("Can't create temporary directory " + pathDB + ": " + err);
      //
      // Dump the database
      var params = ["--no-owner", "-f", pathDB + "/backup", "--dbname=" + pthis.getURL()];
      Node.child.execFile("/usr/local/bin/pg_dump", params, function (err, stdout, stderr) {   // jshint ignore:line
        if (err)
          return errorFnc("Error backing up the database: " + err);
        //
        // Backup in the cloud
        var archiver = new Node.Archiver(pthis.server);
        archiver.backup(pathDB, pathCloud, function (err) {
          if (err)
            return errorFnc("Error while backing up in the cloud: " + err);
          //
          // Remove the temp folder
          Node.rimraf(pathDB, function (err) {
            if (err)
              return errorFnc("Error removing the temp database files: " + err);
            //
            // Log the operation
            pthis.log("INFO", "Database backed up", "Database.backup");
            //
            // Done
            callback();
          });
        });
      });
    });
  });
};


/**
 * Restore a db from a cloud backup
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Database.prototype.restore = function (params, callback)
{
  var pthis = this;
  //
  var pathDB;
  if (this.user.userName === "manager")
    pathDB = this.config.appDirectory + "/backups/tmp_" + this.name;
  else
    pathDB = this.config.directory + "/" + this.user.userName + "/tmp_" + this.name;
  //
  var pathCloud;
  if (params.req && params.req.query.path) {
    // Given path could be a full file path (with .tar.gz extension) or a folder
    pathCloud = params.req.query.path;
    if (pathCloud.substr(-7) !== ".tar.gz")
      pathCloud += "/" + this.name + ".tar.gz";   // Was a folder
  }
  else {
    // If the DB is a production DB a path on the query string is needed
    // (there is no "default" bucket for productions DB)
    if (this.user.userName === "manager") {
      this.log("WARN", "Can't restore a MANAGER database without a PATH", "Database.restore");
      return callback("Can't restore a MANAGER database without a PATH");
    }
    //
    pathCloud = "users/" + this.config.serverType + "/" + this.user.userName + "/backups/databases/" + this.name + "/" + this.name + ".tar.gz";
  }
  //
  this.log("DEBUG", "Database restore", "Database.restore", {pathCloud: pathCloud, params: (params.req ? params.req.query : undefined)});
  //
  var errorFnc = function (msg) {
    pthis.log("ERROR", msg, "Database.restore");
    callback(msg);
    //
    // Operation failed -> clean up
    Node.rimraf(pathDB, function () {
    });
  };
  //
  // Restore
  var archiver = new Node.Archiver(this.server);
  archiver.restore(pathDB, pathCloud, function (err) {
    if (err)
      return errorFnc("Error while restoring database cloud files: " + err);
    //
    // Restore the database dump
    var params = ["--dbname=" + pthis.getURL(), "-f", pathDB + "/backup"];
    Node.child.execFile("/usr/local/bin/psql", params, function (err, stdout, stderr) {   // jshint ignore:line
      if (err)
        return errorFnc("Error while restoring database: " + err);
      //
      // Now If the database's owner is a specific user (IDE case) set the owner
      // Note: everything should be owned by indert because I (indert process) restored it and inside
      // the backup there is no owner information (see Database::backup "--no-owner" command line parameter)
      if (pthis.user.userName !== "manager") {
        params = ["--dbname=" + pthis.getURL(), "-c", "REASSIGN OWNED BY indert TO \"" + pthis.user.userName + "\""];
        Node.child.execFile("/usr/local/bin/psql", params, function (err, stdout, stderr) {   // jshint ignore:line
          if (err)
            return errorFnc("Error while changing database object's owner: " + err);
          //
          completeRestore();
        });
      }
      else
        completeRestore();
    });
  });
  //
  // Cleanup and report to callee
  var completeRestore = function () {
    Node.rimraf(pathDB, function (err) {
      if (err)
        return errorFnc("Error removing the temp database files: " + err);
      //
      // Log the operation
      pthis.log("INFO", "Database restored", "Database.restore");
      //
      // Done
      callback();
    });
  };
};


/**
 * Call the execution of the commands related to a database
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Database.prototype.processCommand = function (params, callback)
{
  this.execCommand(params, callback);
};


/**
 * Execute command for the database
 * @param {object} params
 * @param {function} callback (err or {err, msg, code})
 */
Node.Database.prototype.execCommand = function (params, callback)
{
  var command = params.tokens[0];
  //
  // If the authorization key is enabled and the given one does not match -> error
  if (this.config.auth && params.req.query.autk !== this.config.autk) {
    this.log("WARN", "Unauthorized", "Database.execCommand", {url: params.req.originalUrl});
    return callback({err: "Unauthorized", code: 401});
  }
  //
  switch (command) {
    case "status":
      this.sendStatus(params, callback);
      break;
    case "query":
      this.query(params, callback);
      break;
    case "config":
      this.configure(params, callback);
      break;
    case "backup":
      this.backup(params, callback);
      break;
    case "restore":
      this.restore(params, callback);
      break;
    case "rename":
      this.renameDb(params, callback);
      break;
    default:
      this.log("WARN", "Invalid Command", "Database.execCommand", {cmd: command, url: params.req.originalUrl});
      callback("Invalid Command");
      break;
  }
};


// Export module
module.exports = Node.Database;
