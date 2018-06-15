/*
 * Instant Developer Next
 * Copyright Pro Gamma Spa 2000-2016
 * All rights reserved
 */
/* global require, process, __dirname */

var Node = Node || {};

// Import Modules
Node.child = require("child_process");
Node.fs = require("fs");

// Import classes
Node.Logger = require("./logger");
Node.Utils = require("./utils");


/**
 * @class Represents the main childer (i.e. the class that generates childs)
 */
Node.Childer = function ()
{
  this.children = {};
};


Node.Childer.msgTypeMap = {
  pid: "pid",
  log: "log",
  createChild: "cc",
  forwardToChild: "fc",
  disconnectChild: "dc",
  sessionCompleted: "sc",
  execCmdRequest: "exreq",
  execCmdResponse: "exres",
  execCmd: "excmd"
};


/**
 * Create the childer and start it
 */
Node.createChilder = function ()
{
  Node.theChild = new Node.Childer();
  Node.theChild.start();
};


/**
 * Process all messages coming from the server
 */
Node.Childer.prototype.start = function ()
{
  var pthis = this;
  //
  this.logger = new Node.Logger(this, "CHILDER");
  this.logger.log("INFO", "******* Childer started *******", "Childer.start", {pid: process.pid});
  //
  process.on("disconnect", function () {
    pthis.logger.log("WARN", "Parent process disconnected me. Childer stopped", "Childer.start");
    process.exit();
  });
  //
  process.on("message", function (m) {
    pthis.handleMessage(m);
  });
};


/**
 * Process all messages coming from the server
 * @param {Object} msg - message
 */
Node.Childer.prototype.handleMessage = function (msg)
{
  var child;
  //
  switch (msg.type) {
    case Node.Childer.msgTypeMap.createChild:
      this.createChild(msg);
      break;

    case Node.Childer.msgTypeMap.disconnectChild: // If connected, disconnect the child
      child = this.children[msg.id];
      if (child && child.connected) {
        child.disconnect();
        this.logger.log("DEBUG", "Child disconnected", "Childer.handleMessage", {id: msg.id});
      }
      break;

    case Node.Childer.msgTypeMap.forwardToChild: // If connected, forward the message to the child
      child = this.children[msg.id];
      if (child && child.connected)
        child.send(msg.msg);
      break;

    case Node.Childer.msgTypeMap.execCmdRequest:  // Request to execute a command as ROOT
      // Fix HOME directory (see Childer::createChild)
      process.env.HOME = "/root";
      //
      // Execute the command and send back the response
      Node.child.execFile(msg.cmd, msg.params, function (err, stdout, stderr) {
        process.send({type: Node.Childer.msgTypeMap.execCmdResponse, cmdid: msg.cmdid, err: err, stdout: stdout, stderr: stderr});
      });
      break;

    case Node.Childer.msgTypeMap.execCmd:
      switch (msg.cmd) {
        case "reboot":  // Request to reboot server
          if (!/^win/.test(process.platform)) {
            var sudo = (process.platform === "freebsd" ? "sudo -i " : "");
            var txt = sudo + "pm2 stop inde\n";
            txt += "rm " + __dirname + "/../log/console.*.log\n";
            txt += sudo + "pm2 start " + __dirname + "/inde.json\n";
            txt += "rm /root/_reboot";
            Node.fs.writeFileSync("/root/_reboot", txt, {mode: 0777});
            //
            Node.child.spawn((process.platform === "freebsd" ? "csh" : "bash"), ["-c", "/root/_reboot"]).unref();
          }
          break;
      }
      break;
  }
};


/**
 * Create a new child
 * @param {Object} m - message
 */
Node.Childer.prototype.createChild = function (m)
{
  var pthis = this;
  //
  // Fork the ide process with the OS user uid and group gid
  var params = {uid: m.uid ? parseInt(m.uid) : null, gid: m.gid ? parseInt(m.gid) : null};
  process.env.HOME = m.path + "/files/temp";
  var child = Node.child.fork(__dirname + "/../ide/child.js", Object.assign(params, Node.Utils.forkArgs()));
  //
  // Store the child in the map
  this.children[m.id] = child;
  //
  // Save the IDE session id in the child object
  var ide_session = m.id;
  //
  // Handle child messages
  child.on("message", function (m) {
    // Route LOG messages to my owner's process
    if (m.type === Node.Childer.msgTypeMap.log)
      return process.send(m);
    //
    // Send any messge (coming from the child) to the server process
    process.send({id: ide_session, cnt: m});
  });
  //
  // Child disconnection
  child.on("disconnect", function () {
    // Log the child disconnection
    pthis.logger.log("DEBUG", "Child terminated", "Childer.createChild", {id: ide_session});
    //
    // Remove child from children map
    delete pthis.children[ide_session];
  });
  //
  // Child dies
  child.on("close", function () {
    // Log the child death
    pthis.logger.log("WARN", "Child has been closed!", "Childer.createChild", {id: ide_session});
    //
    // Send a KILL message to session so that the session closes gracefully
    process.send({id: ide_session, cnt: {type: Node.Childer.msgTypeMap.sessionCompleted}});
    //
    // Remove child from children map
    delete pthis.children[ide_session];
  });
  //
  // Child error
  child.on("error", function (err) {
    // Log the child error
    pthis.logger.log("WARN", "Child error: " + err, "Childer.createChild", {id: ide_session});
  });
  //
  this.logger.log("DEBUG", "Child created", "Childer.createChild", {id: ide_session});
};


Node.createChilder();
