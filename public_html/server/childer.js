/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
var Node = Node || {};

// Import Modules
Node.child = require("child_process");
Node.fs = require("fs");
Node.path = require("path");

// Import classes
Node.Logger = require("./logger");
Node.Utils = require("./utils");


/**
 * @class Node.Childer
 * @classdesc
 * Process manager responsible for creating and managing child processes for IDE sessions.
 * This class acts as an intermediary between the main server process and individual IDE child processes,
 * handling process forking, message routing, and lifecycle management.
 *
 * Key features:
 * - **Process isolation**: Creates separate child processes with specific user permissions (uid/gid)
 * - **Message routing**: Forwards messages between the server and child processes
 * - **Lifecycle management**: Handles child process creation, disconnection, and cleanup
 * - **Command execution**: Executes system commands with appropriate permissions
 *
 * @property {Object} children - Map of active child processes indexed by session ID
 * @property {Node.Logger} logger - Logger instance for debugging and monitoring
 */
Node.Childer = class Childer
{
  /**
   * Message type identifiers for inter-process communication between server, childer, and child processes.
   * @enum {String}
   */
  static msgTypeMap = {
    /** Process ID message */
    pid: "pid",
    /** Log message forwarding */
    log: "log",
    /** Request to create a new child process */
    createChild: "cc",
    /** Forward a message to a specific child process */
    forwardToChild: "fc",
    /** Disconnect a child process */
    disconnectChild: "dc",
    /** Forcibly kill a child process (and its descendants) that did not terminate */
    killChild: "kc",
    /** Session completion notification */
    sessionCompleted: "sc",
    /** Request to execute a command with elevated privileges */
    execCmdRequest: "exreq",
    /** Response from command execution */
    execCmdResponse: "exres",
    /** Execute a specific system command (e.g., reboot) */
    execCmd: "excmd"
  };

  /**
   * Time (ms) a child killed via killChild is given to exit after disconnect
   * before being SIGKILLed together with its descendants (issue #14839)
   * @type {Number}
   */
  static killGracePeriod = 10000;


  /**
   * Creates and initializes the global childer instance.
   * This function instantiates the childer and starts listening for messages from the parent process.
   * Should be called only once when the childer process is forked by the server.
   */
  static create()
  {
    Node.theChild = new Node.Childer();
    Node.theChild.start();
  }


  constructor()
  {
    this.children = {};
  }


  /**
   * Initializes the childer and starts listening for messages from the parent server process.
   * Sets up event handlers for process disconnection and incoming messages.
   * This method is called once when the childer is created.
   */
  start()
  {
    this.logger = new Node.Logger(this, "CHILDER");
    this.logger.log("INFO", "******* Childer started *******", "Childer.start", {pid: process.pid});
    //
    process.on("disconnect", async () => {
      this.logger.log("WARN", "Parent process disconnected me. Childer stopped", "Childer.start");
      //
      // Flush before exit (same reasoning as Server.createChilder disconnect).
      // The CHILDER logger normally forwards to the parent via process.send, but
      // here the parent is gone — flush is effectively a no-op unless the logger
      // has its own stream, but we keep the call for symmetry with the server
      // and to be safe against future logger changes.
      await this.logger.flush();
      //
      process.exit();
    });
    //
    process.on("message", m => this.handleMessage(m));
  }


  /**
   * Processes incoming messages from the parent server process and routes them appropriately.
   * Handles child process creation, disconnection, message forwarding, and command execution.
   * @param {Object} msg - The message object from the server
   * @param {String} msg.type - The message type (from msgTypeMap)
   * @param {String} [msg.id] - The child process session ID
   * @param {String} [msg.uid] - User ID for process creation
   * @param {String} [msg.gid] - Group ID for process creation
   * @param {String} [msg.path] - Path for child process working directory
   * @param {String} [msg.cmd] - Command to execute
   * @param {Array} [msg.params] - Command parameters
   * @param {Object} [msg.options] - Command execution options
   * @param {String} [msg.cmdid] - Command request identifier
   * @param {Object} [msg.msg] - Inner payload forwarded to the target child for forwardToChild
   */
  handleMessage(msg)
  {
    // The cwd inherited at fork time may no longer exist (the update's server/ folder swap deletes
    // that inode): node-based CLIs spawned from here with a dangling cwd (pm2 in the reboot script,
    // npm) crash at startup, silently breaking the post-update reboot. Re-enter our own path, which
    // the update just recreated. The chdir is UNCONDITIONAL on every message: probing with
    // process.cwd() first would silently stop working the day some module pulls in graceful-fs,
    // which replaces it with a memoized version that returns the cached string instead of throwing
    // (it already fooled the equivalent probe in the main server process); the chdir syscall costs
    // microseconds
    try {
      process.chdir(__dirname);
    }
    catch (err) {
      this.logger.log("WARN", `Can't recover the process cwd: ${err}`, "Childer.handleMessage");
    }
    //
    switch (msg.type) {
      case Node.Childer.msgTypeMap.createChild:
        this.createChild(msg);
        break;

      case Node.Childer.msgTypeMap.disconnectChild: { // If connected, disconnect the child
        let child = this.children[msg.id];
        if (child?.connected) {
          child.disconnect();
          this.logger.log("DEBUG", "Child disconnected", "Childer.handleMessage", {id: msg.id});
        }
        break;
      }

      case Node.Childer.msgTypeMap.killChild:  // Kill a child that did not complete the graceful shutdown
        this.killChild(msg.id);
        break;

      case Node.Childer.msgTypeMap.forwardToChild: { // If connected, forward the message to the child
        let child = this.children[msg.id];
        if (child?.connected)
          child.send(msg.msg);
        break;
      }

      case Node.Childer.msgTypeMap.execCmdRequest:  // Request to execute a command as ROOT
        // Fix HOME directory (see Childer::createChild)
        process.env.HOME = "/root";
        //
        // Execute the command and send back the response
        // https://nodejs.org/api/child_process.html#child_process_child_process_execfile_file_args_options_callback
        Node.child.execFile(msg.cmd, msg.params, msg.options, (err, stdout, stderr) => {
          process.send({
            type: Node.Childer.msgTypeMap.execCmdResponse,
            cmdid: msg.cmdid,
            err,
            stdout,
            stderr
          });
        });
        break;

      case Node.Childer.msgTypeMap.execCmd:
        switch (msg.cmd) {
          case "reboot":  // Request to reboot server
            if (!/^win/.test(process.platform)) {
              let sudo = (process.platform === "freebsd" ? "sudo -i " : "");
              let txt = `${sudo}pm2 stop inde\n`;
              txt += `rm ${__dirname}/../log/console.*.log\n`;
              txt += `${sudo}pm2 start ${__dirname}/inde.json\n`;
              txt += "rm /root/_reboot";
              Node.fs.writeFileSync("/root/_reboot", txt, {mode: 0o0777});
              //
              Node.child.spawn((process.platform === "freebsd" ? "csh" : "bash"), ["-c", "/root/_reboot"]).unref();
            }
            break;
        }
        break;
    }
  }


  /**
   * Creates a new child process for an IDE session with specific user permissions.
   * Forks a new process with the specified uid/gid, sets up message routing,
   * and handles the child process lifecycle including disconnection and errors.
   * @param {Object} m - The message containing child creation parameters
   * @param {String} m.id - The unique session ID for the child process
   * @param {String} [m.uid] - The user ID to run the child process as
   * @param {String} [m.gid] - The group ID to run the child process as
   * @param {String} m.path - The base path for the IDE session
   * @param {Boolean} [m.local] - Whether the server runs in local mode; when false, uid/gid are mandatory (the fork is refused otherwise, so the child can never run as the childer's root uid)
   * @param {String} [m.version] - IDE version whose folder to fork (multi-version layout); falls back to the flat `ide` folder when omitted
   */
  createChild(m)
  {
    // Fork the ide process with the OS user uid and group gid
    let params = {uid: m.uid ? parseInt(m.uid) : null, gid: m.gid ? parseInt(m.gid) : null};
    //
    // Security (issue #14643, I6): on a non-local server the child MUST drop to the project user.
    // Fail closed if uid/gid are missing, otherwise fork() would run the child with the childer's uid (root).
    if (!m.local && (params.uid === null || params.gid === null)) {
      this.logger.log("ERROR", "Refusing to fork child without uid/gid on non-local server", "Childer.createChild", {id: m.id});
      //
      // Notify the server so the orphaned session is closed gracefully instead of
      // hanging while waiting for a child that will never be created (same signal
      // the child "close" handler sends below).
      process.send({id: m.id, cnt: {type: Node.Childer.msgTypeMap.sessionCompleted}});
      return;
    }
    process.env.HOME = Node.path.join(m.path, "files", "temp");
    //
    // Run the versioned child with its version folder's server dir as cwd, mirroring the flat
    // geometry (cwd = <root>/server, ide at <root>/ide): cwd-based paths in the child code (e.g. the
    // app-build runtime copy resolving "../ide/app") land inside its own version folder, for every
    // version including already-released ones. On flat servers resolveIdeDir falls back to the flat
    // ide, so the cwd is the same the child would inherit today
    if (m.version)
      params.cwd = Node.path.join(Node.Utils.resolveIdeDir(m.version), "..", "server");
    let child = Node.child.fork(Node.path.join(Node.Utils.resolveIdeDir(m.version), "child.js"), Object.assign(params, Node.Utils.forkArgs()));
    //
    // Store the child in the map
    this.children[m.id] = child;
    //
    // Save the IDE session id in the child object
    let ide_session = m.id;
    //
    // Handle child messages
    child.on("message", m => {
      // Route LOG messages to my owner's process
      if (m.type === Node.Childer.msgTypeMap.log)
        return process.send(m);
      //
      // Send any messge (coming from the child) to the server process
      process.send({
        id: ide_session,
        cnt: m
      });
    });
    //
    // Child disconnection
    child.on("disconnect", () => {
      // Log the child disconnection
      this.logger.log("DEBUG", "Child terminated", "Childer.createChild", {id: ide_session});
      //
      // Remove child from children map
      delete this.children[ide_session];
    });
    //
    // Child dies
    child.on("close", () => {
      // Log the child death
      this.logger.log("WARN", "Child has been closed!", "Childer.createChild", {id: ide_session});
      //
      // Send a KILL message to session so that the session closes gracefully
      process.send({
        id: ide_session,
        cnt: {
          type: Node.Childer.msgTypeMap.sessionCompleted
        }
      });
      //
      // Remove child from children map
      delete this.children[ide_session];
    });
    //
    // Child error
    child.on("error", err => {
      // Log the child error
      this.logger.log("WARN", `Child error: ${err}`, "Childer.createChild", {id: ide_session});
    });
    //
    this.logger.log("DEBUG", "Child created", "Childer.createChild", {id: ide_session});
  }


  /**
   * Forcibly terminates a child process that did not complete the graceful shutdown
   * handshake (issue #14839). Disconnects the child first — its "disconnect" handler
   * performs the normal cleanup and exits — then, after a grace period, SIGKILLs it
   * together with its descendant processes: the claude CLI spawned by the Agent SDK
   * would otherwise survive as an orphan, because SIGKILL bypasses the SDK's
   * process-exit handler that normally terminates it.
   * @param {String} id - The child session ID
   */
  killChild(id)
  {
    let child = this.children[id];
    if (!child)
      return;
    //
    this.logger.log("WARN", "Force-killing child that did not terminate", "Childer.killChild", {id, pid: child.pid});
    //
    // Give the child one last chance to exit cleanly via its "disconnect" handler
    if (child.connected)
      child.disconnect();
    //
    setTimeout(() => {
      // Child already exited or was already killed. Do NOT test the children map here:
      // the disconnect() above fires the parent-side "disconnect" handler immediately,
      // which removes the entry from the map even though the process is still alive
      if (child.killed || child.exitCode !== null)
        return;
      //
      // Collect descendants BEFORE killing the child: once it dies its children are
      // re-parented and can no longer be found via the parent pid
      let descendants = this.getDescendantPids(child.pid);
      this.logger.log("WARN", "Child did not exit after disconnect -> SIGKILL", "Childer.killChild",
              {id, pid: child.pid, descendants});
      try {
        child.kill("SIGKILL");
      }
      catch (e) { /* already dead */ }
      //
      for (let pid of descendants) {
        try {
          process.kill(pid, "SIGKILL");
        }
        catch (e) { /* already dead */ }
      }
    }, Node.Childer.killGracePeriod);
  }


  /**
   * Returns the pids of all descendant processes (children, grandchildren, ...) of the
   * given pid, walking the process tree with pgrep. Empty on Windows, where pgrep is
   * unavailable (and the IDE child topology that needs reaping does not apply).
   * @param {Number} pid - Root pid whose descendants are collected
   * @returns {Array<Number>} Descendant pids
   */
  getDescendantPids(pid)
  {
    let result = [];
    if (/^win/.test(process.platform))
      return result;
    //
    let stack = [pid];
    while (stack.length) {
      let out;
      try {
        out = Node.child.execFileSync("pgrep", ["-P", String(stack.pop())], {encoding: "utf8"});
      }
      catch (e) {
        continue;  // pgrep exits non-zero when the process has no children
      }
      for (let line of out.split("\n")) {
        let p = parseInt(line, 10);
        if (p) {
          result.push(p);
          stack.push(p);
        }
      }
    }
    return result;
  }
};


Node.Childer.create();
