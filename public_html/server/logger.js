/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
/* global require, process, module, __dirname, __filename */

var Node = Node || {};

// Import modules
Node.fs = require("fs");
Node.rimraf = require("rimraf");
Node.child = require("child_process");
Node.path = require("path");
Node.Utils = require("./utils");


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


Node.Logger.msgTypeMap = {
  log: "log"
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
  // If I'm the SERVER
  if (this.parentType === "SERVER") {
    // If I need to log exceptions, add listener
    if (this.config.handleException) {
      process.on("uncaughtException", function (err) {
        this.log("ERROR", "Uncaught server exception : " + (err.stack || err), "Logger.init");
        //
        var crashAll = true;
        if ((err.stack + "").indexOf("node_modules/gcloud") !== -1)
          crashAll = false;   // Do not exit if the problem was inside gcloud
        else if ((err.stack + "").indexOf("incorrect header check\n    at Zlib._handle.onerror (zlib.js:370:17)") !== -1)
          crashAll = false;   // Do not exit if the problem is due to an "incorrect header check from the Zlib bugged library"
        //
        // If I have to... let's do it!!!
        if (crashAll)
          process.exit(1);
      }.bind(this));
    }
    //
    // Create the LOG file
    this.initLogFile();
    //
    // Create timer that checks if I need to stop writing due to disk space or file size
    this.startCheckTimer();
  }
};


/**
 *  Initialize file stream if needed
 *  (only SERVER calls this method)
 */
Node.Logger.prototype.initLogFile = function ()
{
  var logPath = Node.path.resolve(__dirname + "/../log");
  //
  // If LOG directory does not exist, create it
  if (!Node.fs.existsSync(logPath))
    Node.fs.mkdirSync(logPath);
  //
  // If I haven't done it yet
  if (!this.newLogTimer) {
    // Create a timer that will change LOG file each day
    this.newLogTimer = setInterval(function () {
      this.initLogFile();
    }.bind(this), 60 * 1000);   // Check day change each minute
  }
  //
  // If day has changed, create a new LOG
  if (this.ISOdate && (new Date()).toISOString().substring(0, 10) !== this.ISOdate) {
    // If I had an open file better close it
    if (this.stream)
      this.stream.end();
    //
    delete this.ISOdate;
    delete this.stream;
    //
    // Recheck stop logging file size
    delete this.stopLogFileSize;
  }
  //
  // If there is no DATE -> date is NOW()
  if (!this.ISOdate)
    this.ISOdate = (new Date()).toISOString().substring(0, 10);
  //
  // If needed, create a new file for the given date
  if (!this.stream) {
    this.stream = Node.fs.createWriteStream(logPath + "/" + this.ISOdate + ".log", {"flags": "a", "mode": 0600});
    //
    // Add first message
    this.log("INFO", "******* New log for server " + this.config.name + " *******");
    //
    // A new LOG file has been created -> delete old logs if any
    this.deleteOldLogs();
  }
};


/**
 * Delete old logs
 */
Node.Logger.prototype.deleteOldLogs = function ()
{
  var logPath = Node.path.resolve(__dirname + "/../log");
  //
  // Delete logs that are older than 15 days
  Node.fs.readdir(logPath, function (err, files) {
    if (err)
      return console.error("[Logger::deleteOldLogs] Error while reading LOG directory: " + err);
    //
    for (var i = 0; i < files.length; i++) {
      var fn = files[i];
      //
      // Skip files that are not in the form [year]-[month]-[day].log
      if (fn.split("-").length !== 3 || fn.indexOf(".") === -1 || fn.substring(fn.lastIndexOf(".")) !== ".log")
        continue;
      //
      // Delete old logs (keep last 15 days logs)
      var fdt = new Date(fn.substring(0, 10));
      if ((new Date() - fdt) > 15 * 24 * 3600 * 1000) {
        Node.rimraf(logPath + "/" + fn, function (err) {
          if (err)
            console.log("[Logger::deleteOldLogs] Error deleting the file " + logPath + "/" + fn + ": " + err);
        });   // jshint ignore:line
      }
    }
  }.bind(this));
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
  // [DEP0005] DeprecationWarning: Buffer() is deprecated due to security and usability issues.
  // Please use the Buffer.alloc(), Buffer.allocUnsafe(), or Buffer.from() methods instead.
  //
  // Unfortunately we depend on more than 50 modules... and several have "new Buffer()" somewhere... We need to skip this message
  if (message.indexOf("Buffer() is deprecated due to security and usability issues") !== -1)
    return;
  //
  // If log has stopped, do nothing
  if (this.stopLogFileSize || this.stopLogDiskSize)
    return;
  //
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
  // Add level-specific info
  if (this.parentType === "CHILD") {  // For CHILD, add user and project
    data = data || {};
    data.prj = this.parent.project.name;
    data.user = this.parent.project.user.userName;
    data.sid = this.parent.sid;
  }
  //
  // If I'm running in "local" mode
  // - if level is DEBUG -> write to console.log (or console.error if IDE message)
  // - if level is ERROR -> write to console.error
  if (this.config && this.config.local && (level === "DEBUG" || level === "ERROR")) {
    // Compute text message
    var s = new Date().toISOString() + " - " + level + " - " + message;
    if (sender || data) {
      s += " - (";
      if (sender)
        s += "sender: " + sender;
      if (data)
        s += (sender ? ", " : "") + "data: " + JSON.stringify(data);
      s += ")";
    }
    //
    if (level === "DEBUG") {
      // For IDEAPP always use console.error (otherwise user sees this into "app-dtt-console")
      if (this.parentType === "IDEAPP")
        console.error(s);
      else
        console.log(s);
    }
    else if (level === "ERROR")
      console.error(s);
  }
  //
  // Don't write DEBUG messages to file
  if (level === "DEBUG" && !this.debug2log)
    return;
  //
  // If I'm not the SERVER, ask my owner if he can log this for me
  if (this.parentType !== "SERVER") {
    if (process.connected)
      process.send({type: Node.Logger.msgTypeMap.log, level: level, message: message, sender: sender, data: data});
    return;
  }
  //
  // I'm the SERVER -> init LOG file if needed
  this.initLogFile();
  //
  // Log message to physical file
  var l = {dt: new Date().toISOString(), lev: level, msg: message.replace(/\n/g, ""), snd: sender, data: data};
  this.stream.write(JSON.stringify(l) + "\n");
};


/**
 * Starts an interval that checks if:
 * - file size is bigger than 200 MB
 * - left disk space is less than 1GB
 */
Node.Logger.prototype.startCheckTimer = function ()
{
  // Start check timer
  setInterval(function () {
    // If log has stopped due to file size, do nothing
    // (a new file will ha to be generated in order to check for something else)
    if (this.stopLogFileSize)
      return;
    //
    // Check file size
    if (this.stream)
      Node.fs.stat(this.stream.path, function (err, stats) {
        if (err)
          return this.log("ERROR", "Error getting the LOG size: " + err, "Logger.startCheckTimer");
        //
        // LOG file is too big... stop writing to disk
        if (stats.size > 200 * 1024 * 1024) {
          this.log("WARN", "LOG file is too big", "Logger.startCheckTimer", {size: stats.size, path: this.stream.path});
          this.stopLogFileSize = true;
          return;
        }
      }.bind(this));
    //
    // If there is no limit, do nothing
    if (!this.config.lowDiskThreshold) {
      delete this.stopLogDiskSize;  // Maybe "they" changed the parameter when I was stopped
      return;
    }
    //
    // Check disk size
    Node.Utils.getFreeDiskSize(function (available, err) {
      if (err)
        return this.log("ERROR", "Can't get free disk space: " + err, "Logger.startCheckTimer");
      //
      // If disk left is less than "lowDiskThreshold" stop writing
      if (available < this.config.lowDiskThreshold) {
        // LOG file is too big... stop writing to disk
        if (!this.stopLogDiskSize) {
          this.log("WARN", "Disk space left on device is too low", "Logger.startCheckTimer", {available: available, lowDiskThreshold: this.config.lowDiskThreshold});
          this.stopLogDiskSize = true;
        }
      }
      else if (this.stopLogDiskSize) {
        // LOG file was too big... now it's good... restart log writing
        delete this.stopLogDiskSize;
        this.log("WARN", "Disk space left on device is enough -> resume logging", "Logger.startCheckTimer", {available: available, lowDiskThreshold: this.config.lowDiskThreshold});
      }
    }.bind(this));
  }.bind(this), 60 * 1000);    // Every minute
};


// Export module
module.exports = Node.Logger;
