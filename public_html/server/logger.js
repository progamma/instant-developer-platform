/*
 * Instant Developer Next
 * Copyright Pro Gamma Spa 2000-2016
 * All rights reserved
 */
/* global require, process, module, __dirname */

var Node = Node || {};

// Import modules
Node.fs = require("fs");
Node.rimraf = require("rimraf");
Node.child = require("child_process");
Node.path = require("path");


/**
 * Class Logger
 * @param {Node.Server/Node.Childer/Node.Child/App} par - (SERVER, CHILDER, CHILD, APP)
 * @param {string} type - type of parent (can't use prototype.constructor)
 */
Node.Logger = function (par, type)
{
  this.parent = par;
  this.parentType = type;
  //
  this.init();
};


// Define usefull properties for this object
Object.defineProperties(Node.Logger.prototype, {
  config: {
    get: function () {
      return this.parent.config;    // NOTE: only server and child have config
    }
  }
});


/**
 *  Initialize the logger
 */
Node.Logger.prototype.init = function ()
{
  var pthis = this;
  //
  // If I need to log SERVER exceptions, log them
  if (this.parentType === "SERVER" && this.config.handleException) {
    process.on("uncaughtException", function (err) {
      pthis.log("ERROR", "Uncaught server exception : " + (err.stack || err), "Logger.init");
      //
      // Do not exit if the problem was inside gcloud
      if ((err.stack + "").indexOf("node_modules/gcloud") === -1)
        process.exit(1);
    });
  }
  //
  // Create the LOG file
  this.initLogFile();
};


/**
 *  Initialize file stream if needed
 */
Node.Logger.prototype.initLogFile = function ()
{
  var pthis = this;
  //
  // Create LOG folder if missing (server is the first to enter here and will create a new LOG dir if needed
  // but that directory will have ROOT:INDERT owner... Childer will fix it later)
  var logPath = Node.path.resolve(__dirname + "/../log");
  if (!Node.fs.existsSync(logPath))
    Node.fs.mkdirSync(logPath);
  //
  // Now create a new LOG file every day (only server can do it otherwise the LOG file
  // will have bad permissions)
  // If there is no DATE (it happens on start up)
  if (!this.date) {
    // Create a new log file... SERVER will create a new file with ROOT:INDERT owner,
    // childer will fix it with INDERT:INDERT owner
    this.date = (new Date()).toISOString().substring(0, 10);
    //
    // If I'm the childer
    if (this.parentType === "CHILDER") {
      // Create a day timer that will "force" the logger to create a new file with the right ownership
      var now = new Date();
      var msTillNewFile = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0) - new Date();
      setTimeout(function () {
        // First call in this day
        pthis.initLogFile();
        //
        // And schedule backup for following days
        setInterval(function () {
          // Calls for following days
          pthis.initLogFile();
        }, 86400000);
      }, msTillNewFile);
    }
    else if (this.parentType === "SERVER")
      this.log("INFO", "******* Server " + this.config.name + " started *******");
  }
  else if ((new Date()).toISOString().substring(0, 10) !== this.date) {
    // There is a date and the day has changed
    // If I'm the SERVER (that runs as INDERT) or the CHILDER (that runs as ROOT) I can change/create a new file
    // But if I'm not SERVER nor CHILDER I can't change to the new file unless the new file is already there
    var newDate = (new Date()).toISOString().substring(0, 10);
    if (this.parentType === "SERVER" || this.parentType === "CHILDER" || Node.fs.existsSync(logPath + "/" + newDate + ".log")) {
      this.date = newDate;
      delete this.stream;   // A new file is required
    }
  }
  //
  // If needed, create a new file for the given date
  if (!this.stream) {
    this.stream = Node.fs.createWriteStream(logPath + "/" + this.date + ".log", {"flags": "a"});
    //
    // If I'm the CHILDER logger (root)
    if (this.parentType === "CHILDER") {
      // Fix file permissions when opened (not on a windows machine)
      if (!/^win/.test(process.platform))
        this.stream.on("open", function () {
          Node.child.execFile("/bin/chmod", ["-R", 777, logPath], function (err, stdout, stderr) {    // jshint ignore:line
            if (err)
              console.log("[Logger.initLogFile] Can't chmod to 777 the log file: " + err);
            //
            Node.child.execFile("/usr/sbin/chown", ["-R", "indert:indert", logPath], function (err, stdout, stderr) {    // jshint ignore:line
              if (err)
                console.log("[Logger.initLogFile] Can't chown the log file: " + err);
            });
          });
        });
      //
      // Delete old logs
      this.deleteOldLogs();
    }
    else if (this.parentType === "SERVER")
      this.log("INFO", "******* New log for server " + this.config.name + " *******");
  }
};


/**
 * Delete old logs
 */
Node.Logger.prototype.deleteOldLogs = function ()
{
  // Delete logs that are older than 15 days
  var oldDate = new Date();
  oldDate.setDate(oldDate.getDate() - 15);
  oldDate = oldDate.toISOString().substring(0, 10);
  //
  var filename = "../log/" + oldDate + ".log";
  Node.rimraf(filename, function (err) {
    if (err)
      console.log("Error deleting the file " + filename + ": " + err);
  });
};


/**
 * Log a new message
 * @param {string} level - message level (DEBUG, INFO, WARN, ERROR)
 * @param {string} message - text message
 * @param {string} sender - function that generated the message
 * @param {object} data - optional data to log
 */
Node.Logger.prototype.log = function (level, message, sender, data)
{
  // Protect for un-serializable data
  if (data) {
    try {
      JSON.stringify(data);
    }
    catch (ex) {
      data = undefined;
      this.log("DEBUG", "Can't dump DATA for message " + message, sender);
    }
  }
  //
  // For CHILD, add user and project
  if (this.parentType === "CHILD") {
    data = data || {};
    data.prj = this.parent.project.name;
    data.user = this.parent.project.user.userName;
    data.sid = this.parent.sid;
  }
  //
  // If level is DEBUG -> use console.log
  // If level is ERROR -> use console.error AND log file
  if (level === "DEBUG" || level === "ERROR") {
    var s = new Date().toISOString() + " - " + level + " - " + message;
    //
    if (sender || data) {
      s += " - (";
      if (sender)
        s += "sender: " + sender;
      if (data)
        s += (sender ? ", " : "") + "data: " + JSON.stringify(data);
      s += ")";
    }
    //
    // Debug goes only to console.log
    if (level === "DEBUG") {
      // For APPS use always ERROR console (otherwise it sends this message to "app-dtt-console")
      if (this.parentType === "IDEAPP")
        console.error(s);
      else
        console.log(s);
      return;
    }
    //
    // Error goes to console.error and continue with log file
    if (level === "ERROR")
      console.error(s);
  }
  //
  // Init LOG file if needed
  this.initLogFile();
  //
  // Log to file
  var l = {dt: new Date().toISOString(), lev: level, msg: message.replace(/\n/g, ""), snd: sender, data: data};
  this.stream.write(JSON.stringify(l) + "\n");
};


// Export module
module.exports = Node.Logger;
