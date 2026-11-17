/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
var Node = Node || {};

// Import modules
Node.fs = require("fs");
Node.path = require("path");
Node.Utils = require("./utils");


/**
 * @class Node.Logger
 * @classdesc
 * Centralized logging system for the Instant Developer Cloud framework.
 * Applies the common filtering rules and forwards each entry to the parent process:
 * the entries climb the chain of processes until they reach the root logger, that owns
 * the physical file.
 *
 * Key features:
 * - **Multi-process logging**: Routes logs from child processes to the main server
 * - **Level filtering**: Supports DEBUG, INFO, WARN, ERROR levels with configurable output
 * - **Resource monitoring**: Stops logging when disk space or file size limits are exceeded
 *
 * @property {Node.Server|Node.Childer|Node.Child} parent - The parent object that owns this logger
 * @property {Boolean} stopLogFileSize - Flag indicating logging stopped due to file size
 * @property {Boolean} stopLogDiskSize - Flag indicating logging stopped due to disk space
 * @property {Boolean} debug2log - Whether to write DEBUG messages to file
 * @see Node.ServerLogger - The logger of the root process
 */
Node.Logger = class Logger
{
  /**
   * Message type identifiers for inter-process logging communication.
   * @enum {String}
   */
  static msgTypeMap = {
    /** Log message type for routing between processes */
    log: "log"
  };


  /**
   * @param {Node.Server|Node.Childer|Node.Child} par - Parent object
   */
  constructor(par)
  {
    this.parent = par;
  }


  /**
   * Gets the configuration object from the parent.
   * Note: Only server and child processes have config.
   * @type {Node.Config}
   * @readonly
   */
  get config()
  {
    return this.parent.config;    // NOTE: only server and child have config
  }


  /**
   * Logs a message with the specified level and metadata.
   * Applies the filters shared by every process (deprecated warnings, resource limits, level)
   * and console output for local mode, then hands the message over to output().
   * @param {String} level - Message severity level (DEBUG, INFO, WARN, ERROR)
   * @param {String} message - The log message text
   * @param {String} [sender] - Function or module that generated the message
   * @param {Object} [data] - Additional structured data to log
   */
  log(level, message, sender, data)
  {
    // Force message as string
    message += "";
    // [DEP0005] DeprecationWarning: Buffer() is deprecated due to security and usability issues.
    // Please use the Buffer.alloc(), Buffer.allocUnsafe(), or Buffer.from() methods instead.
    //
    // Unfortunately we depend on more than 50 modules... and several have "new Buffer()" somewhere... We need to skip this message
    if (message.includes("Buffer() is deprecated due to security and usability issues"))
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
      catch {
        data = undefined;
        this.log("DEBUG", `Can't dump DATA for message ${message}`, sender);
      }
    }
    //
    // Add level-specific info
    if (this.parent.project) {  // For CHILD, add user and project
      data = data || {};
      data.prj = this.parent.project.name;
      data.user = this.parent.project.user.userName;
      data.sid = this.parent.sid;
    }
    //
    // If I'm running in "local" mode
    // - if level is DEBUG -> write to console.log
    // - if level is ERROR -> write to console.error
    if (this.config?.local && ["DEBUG", "ERROR"].includes(level)) {
      // Compute text message
      let s = `${new Date().toISOString()} - ${level} - ${message}`;
      if (sender || data) {
        s += " - (";
        if (sender)
          s += `sender: ${sender}`;
        if (data)
          s += (sender ? ", " : "") + `data: ${JSON.stringify(data)}`;
        s += ")";
      }
      //
      if (level === "DEBUG")
        console.log(s);
      else
        console.error(s);
    }
    //
    // Don't write DEBUG messages to file
    if (level === "DEBUG" && !this.debug2log)
      return;
    //
    this.output(level, message, sender, data);
  }


  /**
   * Delivers a message that passed the log() filters.
   * Asks the owner process to log it: only the root logger owns the physical file.
   * @param {String} level - Message severity level (DEBUG, INFO, WARN, ERROR)
   * @param {String} message - The log message text
   * @param {String} [sender] - Function or module that generated the message
   * @param {Object} [data] - Additional structured data to log
   */
  output(level, message, sender, data)
  {
    // Best-effort: during tab close the IPC channel may already be tearing down, and a
    // throwing send here would re-enter the child's uncaughtException handler (which logs
    // again) in a loop (issue #14680).
    Node.Utils.safeSend({
      type: Node.Logger.msgTypeMap.log,
      level,
      message,
      sender,
      data
    });
  }


  /**
   * Flushes the log stream to disk and closes it.
   * Resolves once the underlying WriteStream has drained its buffer, so callers
   * that exit immediately after (e.g. on a fatal disconnect) do not lose the last
   * log entries. A safety timeout prevents a stalled stream from blocking the
   * caller indefinitely. After flush() the logger no longer writes to file:
   * intended for pre-exit cleanup, not regular use.
   */
  flush()
  {
    return new Promise(resolve => {
      if (!this.stream)
        return resolve();
      //
      let timer = setTimeout(resolve, 1000);
      //
      this.stream.end(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }


};


/**
 * @class Node.ServerLogger
 * @classdesc
 * Logger of the root process: it is the only one that owns the physical log file.
 * Every other process forwards its entries up the chain until they reach this one.
 *
 * @extends Node.Logger
 * @property {WriteStream} stream - File stream for writing log entries
 * @property {String} ISOdate - Current log file date in ISO format (YYYY-MM-DD)
 * @property {Number} newLogTimer - Timer ID for daily log rotation
 */
Node.ServerLogger = class ServerLogger extends Node.Logger
{
  /**
   * @param {Node.Server} par - Parent object
   */
  constructor(par)
  {
    super(par);
    //
    this.init();
  }


  /**
   * Sets up exception handlers, creates the log file and starts resource monitoring.
   */
  init()
  {
    // If I need to log exceptions, add listener
    if (this.config.handleException) {
      let unhandledExceptionFnc = err => {
        this.log("ERROR", `Uncaught server exception : ${err.stack || err}`, "Logger.init");
        //
        let crashAll = true;
        if ((err.stack + "").includes("node_modules/gcloud"))
          crashAll = false;   // Do not exit if the problem was inside gcloud
        else if ((err.stack + "").includes("incorrect header check\n    at Zlib._handle.onerror (zlib.js:370:17)"))
          crashAll = false;   // Do not exit if the problem is due to an "incorrect header check from the Zlib bugged library"
        //
        // If I have to... let's do it!!!
        if (crashAll)
          process.exit(1);
      }
      process.on("unhandledRejection", unhandledExceptionFnc);
      process.on("uncaughtException", unhandledExceptionFnc);
    }
    //
    // Create the LOG file
    this.initLogFile();
    //
    // Create timer that checks if I need to stop writing due to disk space or file size
    this.startCheckTimer();
  }


  /**
   * Initializes or rotates the log file stream.
   * Creates a new log file for each day, maintains the log directory, and handles file rotation.
   */
  initLogFile()
  {
    let logPath = Node.path.resolve(__dirname, "..", "log");
    //
    // If LOG directory does not exist, create it
    if (!Node.fs.existsSync(logPath))
      Node.fs.mkdirSync(logPath);
    //
    // If I haven't done it yet
    if (!this.newLogTimer) {
      // Create a timer that will change LOG file each day
      this.newLogTimer = setInterval(() => this.initLogFile(), 60 * 1000);   // Check day change each minute
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
      this.stream = Node.fs.createWriteStream(Node.path.join(logPath, `${this.ISOdate}.log`), {"flags": "a", "mode": 0o600});
      //
      // Add first message
      this.log("INFO", `******* New log for server ${this.config.name} *******`);
      //
      // A new LOG file has been created -> delete old logs if any
      this.deleteOldLogs().catch(() => {});
    }
  }


  /**
   * Deletes log files older than 15 days.
   * Scans the log directory and removes outdated files to manage disk space.
   */
  async deleteOldLogs()
  {
    let logPath = Node.path.resolve(__dirname, "..", "log");
    //
    // Delete logs that are older than 15 days
    let files;
    try {
      files = await Node.fs.promises.readdir(logPath);
    }
    catch (err) {
      console.error(`[Logger::deleteOldLogs] Error while reading LOG directory: ${err}`);
      return;
    }
    //
    for (let fn of files) {
      // Skip files that are not in the form [year]-[month]-[day].log
      if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(fn))
        continue;
      //
      // Delete old logs (keep last 15 days logs)
      let fdt = new Date(fn.substring(0, 10));
      if ((new Date() - fdt) > 15 * 24 * 3600 * 1000) {
        try {
          await Node.fs.promises.rm(Node.path.join(logPath, fn), {force: true});
        }
        catch (err) {
          console.log(`[Logger::deleteOldLogs] Error deleting the file ${Node.path.join(logPath, fn)}: ${err}`);
        }
      }
    }
  }


  /**
   * Starts a timer that monitors logging resource limits.
   * Checks every minute for file size exceeding 200MB and disk space below configured threshold.
   * Automatically stops logging when limits are exceeded and resumes when conditions improve.
   */
  startCheckTimer()
  {
    // Start check timer
    setInterval(async () => {
      // If log has stopped due to file size, do nothing
      // (a new file will ha to be generated in order to check for something else)
      if (this.stopLogFileSize)
        return;
      //
      // Check file size
      if (this.stream)
        Node.fs.stat(this.stream.path, (err, stats) => {
          if (err)
            return this.log("ERROR", `Error getting the LOG size: ${err}`, "Logger.startCheckTimer");
          //
          // LOG file is too big... stop writing to disk
          if (stats.size > 200 * 1024 * 1024) {
            this.log("WARN", `LOG file is too big`, "Logger.startCheckTimer", {size: stats.size, path: this.stream.path});
            this.stopLogFileSize = true;
            return;
          }
        });
      //
      // If there is no limit, do nothing
      if (!this.config.lowDiskThreshold) {
        delete this.stopLogDiskSize;  // Maybe "they" changed the parameter when I was stopped
        return;
      }
      //
      // Check disk size
      let available;
      try {
        available = await Node.Utils.getFreeDiskSize();
      }
      catch (err) {
        return this.log("ERROR", `Can't get free disk space: ${err}`, "Logger.startCheckTimer");
      }
      //
      // If disk left is less than "lowDiskThreshold" stop writing
      if (available < this.config.lowDiskThreshold) {
        // LOG file is too big... stop writing to disk
        if (!this.stopLogDiskSize) {
          this.log("WARN", `Disk space left on device is too low`, "Logger.startCheckTimer", {available, lowDiskThreshold: this.config.lowDiskThreshold});
          this.stopLogDiskSize = true;
        }
      }
      else if (this.stopLogDiskSize) {
        // LOG file was too big... now it's good... restart log writing
        delete this.stopLogDiskSize;
        this.log("WARN", `Disk space left on device is enough -> resume logging`, "Logger.startCheckTimer", {available, lowDiskThreshold: this.config.lowDiskThreshold});
      }
    }, 60 * 1000);    // Every minute
  }


  /**
   * Writes the message to the physical log file.
   * @param {String} level - Message severity level (DEBUG, INFO, WARN, ERROR)
   * @param {String} message - The log message text
   * @param {String} [sender] - Function or module that generated the message
   * @param {Object} [data] - Additional structured data to log
   * @override
   */
  output(level, message, sender, data)
  {
    // Init LOG file if needed
    this.initLogFile();
    //
    let l = {
      dt: new Date().toISOString(),
      lev: level,
      msg: message.replace(/\n/g, ""),
      snd: sender,
      data
    };
    this.stream.write(JSON.stringify(l) + "\n");
  }
};


// Export module
module.exports = {
  Logger: Node.Logger,
  ServerLogger: Node.ServerLogger
};
