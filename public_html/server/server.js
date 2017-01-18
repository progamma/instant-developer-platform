/*
 * Instant Developer Next
 * Copyright Pro Gamma Spa 2000-2016
 * All rights reserved
 */
/* global require, __dirname, process */

var Node = Node || {};

// Import classes
Node.Config = require("./config/config");
Node.IDESession = require("./idesession");
Node.AppSession = require("./master/appsession");
Node.Logger = require("./logger");
Node.Request = require("./request");
Node.Archiver = require("./archiver");
Node.Utils = require("./utils");

// Import modules
Node.express = require("express");
Node.app = Node.express();
Node.http = require("http");
Node.https = require("https");
Node.compress = require("compression");
Node.cookieParser = require("cookie-parser");
Node.helmet = require("helmet");
Node.expressPeerServer = require("peer").ExpressPeerServer;
Node.fs = require("fs");
Node.path = require("path");
Node.os = require("os");
Node.tls = require("tls");
Node.child = require("child_process");
Node.rimraf = require("rimraf");
Node.BodyParser = require("body-parser");
Node.errorHandler = require("errorhandler");


/**
 * @class Represents an Instant Developer Server
 */
Node.Server = function ()
{
  // List of sessions
  this.IDESessions = {};
  this.appSessions = {};
  //
  // Map of SYS commands callbacks
  this.execCallback = {};
  //
  // Remember start time
  this.startTime = new Date();
};


Node.Server.msgTypeMap = {
  pid: "pid",
  sessionid: "sid",
  disconnectChild: "dc",
  asid: "asid",
  clientToken: "clientToken",
  deviceMessage: "deviceMessage",
  sync: "sync",
  cloudConnector: "cloudConnector",
  redirect: "redirect",
  sessionError: "seser",
  execCmdRequest: "exreq",
  execCmdResponse: "exres"
};


/**
 * Create a new Server
 */
Node.createServer = function ()
{
  Node.theServer = new Node.Server();
  Node.theServer.initServer();
  Node.theServer.start();
};


/**
 * Initialize the Server
 */
Node.Server.prototype.initServer = function ()
{
  // Detect server type: production, local
  var srvtype;
  try {
    if (Node.fs.existsSync("/mnt/disk/IndeRT"))
      srvtype = "prod";
    else
      srvtype = "local";
    console.log("Current server mode: " + srvtype);
  }
  catch (ex) {
    console.log("Error while detecting server type. Switching to LOCAL mode: " + ex.message);
    srvtype = "local";
  }
  //
  // Load the configuration from the json file
  this.config = new Node.Config(this);
  this.config.local = (srvtype === "local");
  this.config.loadConfig();
  //
  // If local mode or HTTP protocol
  var server;
  if (this.config.local || this.config.protocol === "http") {
    // Create an http Server
    Node.httpServer = require("http").createServer(Node.app);
    //
    server = Node.httpServer;
  }
  else {  // Use HTTPS server
    // Loads the ssl certificates
    var ca = [];
    for (var i = 0; i < this.config.SSLCABundles.length; i++)
      ca.push(Node.fs.readFileSync(this.config.SSLCABundles[i], "utf8"));
    //
    // Ciphers are updated to May 11 node defaults
    // See https://github.com/nodejs/node/blob/master/doc/api/tls.markdown
    var ssl = {
      key: Node.fs.readFileSync(this.config.SSLKey, "utf8"),
      cert: Node.fs.readFileSync(this.config.SSLCert, "utf8"),
      ca: ca,
      ciphers: [
        "ECDHE-RSA-AES128-GCM-SHA256",
        "ECDHE-ECDSA-AES128-GCM-SHA256",
        "ECDHE-RSA-AES256-GCM-SHA384",
        "ECDHE-ECDSA-AES256-GCM-SHA384",
        "DHE-RSA-AES128-GCM-SHA256",
        "ECDHE-RSA-AES128-SHA256",
        "DHE-RSA-AES128-SHA256",
        "ECDHE-RSA-AES256-SHA384",
        "DHE-RSA-AES256-SHA384",
        "ECDHE-RSA-AES256-SHA256",
        "DHE-RSA-AES256-SHA256",
        "HIGH",
        "!aNULL",
        "!eNULL",
        "!EXPORT",
        "!DES",
        "!RC4",
        "!MD5",
        "!PSK",
        "!SRP",
        "!CAMELLIA"
      ].join(":")
    };
    //
    // If there are custom certificates
    if (this.config.customSSLCerts) {
      //   http://stackoverflow.com/questions/12219639/is-it-possible-to-dynamically-return-an-ssl-certificate-in-nodejs#answer-20285934
      //   https://www.digicert.com/ssl-support/apache-secure-multiple-sites-sni.htm
      ssl.SNICallback = function (domain, cb) {
        // If it's the "main" domain, use the ssl object to reply
        if (domain === this.config.name + "." + this.config.domain)
          return cb(null, Node.tls.createSecureContext(ssl).context);
        //
        // I need to search the right certificate
        var certToUse, i;
        for (i = 0; i < this.config.customSSLCerts.length && !certToUse; i++) {
          var cert = this.config.customSSLCerts[i];
          if (cert.SSLDomain === domain)
            certToUse = cert;
        }
        //
        // If not found
        if (!certToUse) {
          this.logger.log("WARN", "No valid certificate for domain " + domain, "Server.initServer");
          return cb("No valid certificate for domain " + domain);
        }
        //
        // Prepare certificate
        var cred = {key: Node.fs.readFileSync(certToUse.SSLKey, "utf8"),
          cert: Node.fs.readFileSync(certToUse.SSLCert, "utf8"), ciphers: ssl.ciphers};
        cred.ca = [];
        for (i = 0; i < certToUse.SSLCABundles.length; i++)
          cred.ca.push(Node.fs.readFileSync(certToUse.SSLCABundles[i], "utf8"));
        //
        // Reply with TLS secure context
        cb(null, Node.tls.createSecureContext(cred).context);
      }.bind(this);
    }
    //
    // Create an https Server
    Node.httpsServer = require("https").createServer(ssl, Node.app);
    //
    server = Node.httpsServer;
  }
  //
  // Set peerjs server
  Node.app.use("/peerjs", Node.expressPeerServer(server));
  Node.app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
  });
  //
  // Set socket io on top of server
  Node.io = require("socket.io")(server);
};


/**
 * Start the server
 */
Node.Server.prototype.start = function ()
{
  var pthis = this;
  //
  // Create a new Logger
  this.logger = new Node.Logger(this, "SERVER");
  //
  // Create the childer
  this.createChilder();
  //
  // Create a request object (used for communicating with other servers and with the console)
  this.request = new Node.Request(this.config, this.logger);
  //
  // Start the periodic back-up of all projects
  this.backupProjects();
  //
  // Start the periodic back-up of the disk
  this.backupDisk();
  //
  // Create a new AUTK token and send it (if needed)
  this.config.initTokenTimer();
  //
  // Activate HELMET: hide "powered by express"
  Node.app.use(Node.helmet.hidePoweredBy());
  //
  // Prevent mimetypes sniff
  Node.app.use(Node.helmet.noSniff());
  //
  // prevent the webpage being put in a frame. Avoid clickjacking attacks
  // It conflicts with loading the app from the devices iframe, but we
  // should find a better way to fix this than disableing everywhere
  //Node.app.use(Node.helmet.frameguard("sameorigin"));
  //
  // Adds some small XSS protections
  Node.app.use(Node.helmet.xssFilter());
  //
  // Enable gzip compression
  Node.app.use(Node.compress());
  //
  // Enable cookie parser
  Node.app.use(Node.cookieParser());
  //
  // Application/x-www-form-urlencoded post requests
  Node.app.use(Node.BodyParser.urlencoded({extended: true}));
  //
  // Parse various different custom JSON types as JSON
  Node.app.use(Node.BodyParser.json({type: "application/*+json"}));
  //
  // Parse various different custom JSON types as JSON
  Node.app.use(Node.BodyParser.text({type: "text/*"}));
  //
  // Parse various different custom JSON types as JSON
  Node.app.use(Node.BodyParser.raw()); // it will only parse application/octet-stream, could do application/*
  //
  // App cache manifest
  this.createManifest();
  Node.app.get("/application.manifest", function (req, res) {
    pthis.sendManifest(req, res);
  });
  Node.app.get("/:app/client/application.manifest", function (req, res) {
    pthis.sendManifest(req, res);
  });
  //
  // Inizialize static file management for express with maxAge=5min (not for local servers)
  var expOpts = (this.config.local ? undefined : {index: false, maxAge: 300000});
  var idePath = Node.path.resolve(__dirname + "/../ide");
  if (Node.fs.existsSync(idePath)) { // IDE
    this.logger.log("INFO", "Start EXPRESS for IDE", "Server.start", {path: idePath});
    Node.app.use(Node.express.static(idePath, expOpts));
  }
  if (this.config.appDirectory) {    // MASTER
    this.logger.log("INFO", "Start EXPRESS for MASTER", "Server.start", {path: this.config.appDirectory + "/apps"});
    //
    // Use, for every app, maxAge=1 year for uploaded and resources... if they change, their name will change
    if (expOpts)
      expOpts.setHeaders = function (res, path) {
        path = path.replace(/\\/g, "/").toLowerCase();    // Win junk
        if (path.indexOf("/uploaded/") !== -1 || path.indexOf("/resources/") !== -1)
          res.setHeader("Cache-Control", "public, max-age=31536000");
      };
    //
    Node.app.use(Node.express.static(this.config.appDirectory + "/apps", expOpts));
  }
  //
  // Handle commands (config class does everything)
  Node.app.all("", function (req, res) {
    pthis.config.processRun(req, res);
  });
  Node.app.all("/:app", function (req, res) {
    pthis.config.processRun(req, res);
  });
  Node.app.all("/:sid/:appid/run", function (req, res) {
    pthis.config.processRun(req, res);
  });
  Node.app.all("/:user/:command", function (req, res) {
    pthis.config.processCommand(req, res);
  });
  Node.app.get("/:user/db/:dbname/:command", function (req, res) {
    pthis.config.processCommand(req, res);
  });
//  Node.app.get("/:user/:appname/:command", function (req, res) {
  Node.app.all("/:user/:project/:command", function (req, res) {
    pthis.config.processCommand(req, res);
  });
  Node.app.all("/:user/:project/:command/*", function (req, res) {
    pthis.config.processCommand(req, res);
  });
  //
  // Main error-handler (this should come after all the routes)
  Node.app.use(Node.errorHandler({log: function (err, str, req, res) {  // jshint ignore:line
      pthis.logger.log("ERROR", "Server error: " + err, "Server.start", {met: req.method, url: req.url, str: str});
    }}));
  //
  // Start main listener
  if (Node.httpServer)
    Node.httpServer.listen(this.config.portHttp);
  else
    Node.httpsServer.listen(this.config.portHttps);
  //
  // If I'm using HTTPS server, create an HTTP server that redirects to the HTTPS server
  if (Node.httpsServer) {
    // Create a new App
    var httpApp = Node.express();
    //
    // Create a new Router and use it in the App
    var httpRouter = Node.express.Router();
    httpApp.use("*", httpRouter);
    //
    // For any get request
    httpRouter.get("*", function (req, res) {
      // I need the HOST to create the redirect
      var host = req.get("Host");
      if (!host) {
        pthis.logger.log("WARN", "Host not received during an HTTP request. Can't route to HTTPS", "Server.start", {url: req.originalUrl});
        res.status(404).end();
        return;
      }
      //
      // Replace the port in the host with the HTTPS port
      host = host.replace(/:\d+$/, ":" + pthis.config.portHttps);
      //
      // Compute the final redirect destination
      var destination = ["https://", host, req.originalUrl].join("");
      //
      // Redirect
      return res.redirect(destination);
    });
    //
    // Create the http server
    Node.httpServer = Node.http.createServer(httpApp);
    Node.httpServer.listen(this.config.portHttp);
  }
  //
  // Start socket listener
  this.socketListener();
};


/**
 * Create a childer process which will be used to give bith to ide processes
 * (this process will run as ROOT whereas the server will run as INDERT)
 */
Node.Server.prototype.createChilder = function ()
{
  var pthis = this;
  //
  // Change home variable to /tmp. This is done in order to let the child processes to have an home
  // directory where they can write temporary data (eg. gcloud does this when uploading)
  process.env.HOME = "/tmp";
  //
  // Fork the childer process
  this.childer = Node.child.fork("childer.js");
  //
  // Childer listener
  this.childer.on("message", function (msg) {
    pthis.handleChilderMessage(msg);
  });

  this.childer.on("disconnect", function () {
    pthis.logger.log("WARN", "Childer is dead -> restart server", "Server.createChilder");
    process.exit(-1);
  });
  //
  // Remove the root privileges of the main process after the childer is born
  // (do it only if it can be done... on windows there is no setgid method)
  if (!this.config.local && process.setgid) {
    process.setgid("indert");
    process.setuid("indert");
  }
};


/**
 * Process all messages coming from the childer process
 * @param {Object} msg - message
 */
Node.Server.prototype.handleChilderMessage = function (msg)
{
  var pthis = this;
  //
  switch (msg.type) {
    case Node.Server.msgTypeMap.execCmdResponse:  // If this message is a response to an EXECUTE command
      // Report to callee
      if (!this.execCallback[msg.cmdid])
        return this.logger.log("WARN", "Can't send CMD response to callee: no callback", "Server.handleChilderMessage", msg);
      //
      this.execCallback[msg.cmdid](msg.err, msg.stdout, msg.stderr);
      delete this.execCallback[msg.cmdid];
      break;

    default: // Re-route all other messages to the corresponding session
      Node.Utils.process_on(msg, function (msg) {
        var session = pthis.IDESessions[msg.id];
        if (!session)
          return pthis.logger.log("WARN", "Can't send message: session not found", "Server.handleChilderMessage", msg);
        //
        session.processMessage(msg.cnt);
      });
      break;
  }
};


/**
 * Executes a file (command) as ROOT
 * @param {string} cmd - command to be executed
 * @param {array} params - command parameters
 * @param {function} callback - function(err, stdout, stderr)
 */
Node.Server.prototype.execFileAsRoot = function (cmd, params, callback)
{
  var pthis = this;
  //
  // Handle "SPECIAL" commands
  switch (cmd) {
    case "ChownChmod":
      var OSUser = params[0];
      var path = params[1];
      this.execFileAsRoot("/usr/sbin/chown", ["-R", OSUser + ":" + OSUser, path], function (err, stdout, stderr) {   // jshint ignore:line
        if (err) {
          pthis.logger.log("ERROR", "Error while executing CHOWN: " + (stderr || err), "Server.execFileAsRoot", params);
          return callback(err, stdout, stderr);
        }
        //
        pthis.execFileAsRoot("/bin/chmod", ["-R", "770", path], function (err, stdout, stderr) {   // jshint ignore:line
          if (err)
            pthis.logger.log("ERROR", "Error while executing CHMOD: " + (stderr || err), "Server.execFileAsRoot", params);
          callback(err, stdout, stderr);
        });
      });
      break;

    case "ChownDBFolder":
      var dbpath = params[0];
      this.execFileAsRoot("/usr/sbin/chown", ["-R", "pgsql:pgsql", dbpath], function (err, stdout, stderr) {   // jshint ignore:line
        if (err) {
          pthis.logger.log("ERROR", "Error while executing CHOWN: " + (stderr || err), "Server.execFileAsRoot", params);
          return callback(err, stdout, stderr);
        }
        //
        pthis.execFileAsRoot("/bin/chmod", ["-R", "770", dbpath], function (err, stdout, stderr) {   // jshint ignore:line
          if (err)
            pthis.logger.log("ERROR", "Error while executing CHMOD: " + (stderr || err), "Server.execFileAsRoot", params);
          callback(err, stdout, stderr);
        });
      });
      break;

    case "UpdNodePackages":
      var nodeModulesPath = Node.path.resolve(__dirname + "/../") + "/";
      this.execFileAsRoot("/usr/local/bin/npm", ["--prefix", nodeModulesPath, "update"], function (err, stdout, stderr) {   // jshint ignore:line
        if (err) {
          pthis.logger.log("ERROR", "Error while executing NPM UPDATE: " + (stderr || err), "Server.execFileAsRoot", params);
          return callback(err, stdout, stderr);
        }
        //
        // Log package update
        if (stdout)
          pthis.logger.log("INFO", "Package updated: " + stdout, "Server.execFileAsRoot");
        //
        pthis.execFileAsRoot("/usr/local/bin/npm", ["--prefix", nodeModulesPath, "prune"], function (err, stdout, stderr) {   // jshint ignore:line
          if (err)
            pthis.logger.log("ERROR", "Error while executing NPM PRUNE: " + (stderr || err), "Server.execFileAsRoot", params);
          //
          // Hack: remove ETC folder (left over by previous commands)
          // (https://github.com/npm/npm/issues/11486)
          Node.rimraf(nodeModulesPath + "etc", function (err) {   // jshint ignore:line
          });
          //
          // Log package prune
          if (stdout)
            pthis.logger.log("INFO", "Package pruned: " + stdout, "Server.execFileAsRoot");
          //
          callback(err, stdout, stderr);
        });
      });
      break;

    default:  // Not a special command... Handle it directly
      // Prepare the childer callback (will be called and deleted inside the handleChilderMessage method (see above))
      var cmdid = Math.floor(Math.random() * 1000000);
      this.execCallback[cmdid] = function (err, stdout, stderr) {
        callback(err, stdout, stderr);
      };
      //
      // Ask the childer (that runs as ROOT) to execute the command
      this.childer.send({type: Node.Server.msgTypeMap.execCmdRequest, cmdid: cmdid, cmd: cmd, params: params});
      break;
  }
};


/**
 * Listen for incoming connections through web sockets
 */
Node.Server.prototype.socketListener = function ()
{
  var pthis = this;
  //
  // Socket listener
  Node.io.on("connection", function (socket) {
    socket.on(Node.Server.msgTypeMap.sessionid, function (m) {
      pthis.handleSessionSID(socket, m);
    });
    socket.on(Node.Server.msgTypeMap.asid, function (m) {
      pthis.handleSessionASID(socket, m);
    });
    socket.on(Node.Server.msgTypeMap.clientToken, function (m) {
      pthis.handleClientToken(socket, m);
    });
    socket.on(Node.Server.msgTypeMap.deviceMessage, function (m) {
      pthis.handleDeviceMessage(socket, m);
    });
    socket.on(Node.Server.msgTypeMap.sync, function (m) {
      pthis.handleSyncMessage(socket, m);
    });
    socket.on(Node.Server.msgTypeMap.cloudConnector, function (m) {
      pthis.handleCloudConnectorMessage(socket, m);
    });
  });
};


/**
 * Handle SID message (received by the client)
 * @param {Node.Socket} socket - socket that received the message
 * @param {Object} msg - message
 */
Node.Server.prototype.handleSessionSID = function (socket, msg)
{
  // If the session is not there, tell the client that the session is gone
  var session = this.IDESessions[msg.sid];
  if (!session) {
    // If it's a reconnect... create a new session and tell the client to reload with this data
    if (socket.client.request._query.reconnect) {
      this.logger.log("WARN", "Session not found during reconnect", "Server.handleSessionSID",
              {sid: msg.sid, data: socket.client.request._query});
      //
      // If a user and project was provided, try to search for them
      var user = this.config.getUser(socket.client.request._query.user);
      var prj = (user ? user.getProject(socket.client.request._query.project) : undefined);
      if (prj && socket.client.request._query.reconnectToken === prj.reconnectToken) {
        // Found project... by-pass standard checks and let the user come in with a default token
        prj.token = prj.reconnectToken;
        socket.emit(Node.Server.msgTypeMap.redirect, user.userName + "/" + prj.name + "/edit?t=" + prj.token);
        //
        this.logger.log("INFO", "Offline client authorized for a new editing session", "Server.handleSessionSID",
                {sid: msg.sid, user: user.userName, project: prj.name, token: prj.token});
        return;
      }
    }
    //
    // No session -> error
    this.logger.log("WARN", "Session not found", "Server.handleSessionSID", {sid: msg.sid});
    socket.emit(Node.Server.msgTypeMap.sessionError, {type: "noSession"});
    return;
  }
  //
  session.openConnection(socket, msg);
};


/**
 * Handle ASID message (received by the client)
 * @param {Node.Socket} socket - socket that received the message
 * @param {Object} msg - message
 */
Node.Server.prototype.handleSessionASID = function (socket, msg)
{
  var session, appcli;
  //
  if (msg.acid) {   // IDE case
    session = this.IDESessions[msg.sid];
    if (!session)
      return this.logger.log("WARN", "Session not found", "Server.handleSessionASID", {sid: msg.sid});
    //
    // Get the app client for the received acid
    appcli = session.getAppClientById(msg.acid);
    if (!appcli)
      return this.logger.log("WARN", "AppClient not found", "Server.handleSessionASID", {sid: msg.sid, acid: msg.acid});
    //
    // Connect this socket with the app client
    appcli.openConnection(socket);
  }
  else {    // MASTER case
    // If the session is not valid, redirect to app entry point (i.e. app main url)
    session = this.appSessions[msg.sid];
    if (!session) {
      this.logger.log("WARN", "Session not found", "Server.handleSessionASID", {sid: msg.sid});
      socket.emit(Node.Server.msgTypeMap.redirect, this.config.getUrl() + "/" + msg.appname);
      return;
    }
    //
    // Get the app client for the received cid
    appcli = session.getAppClientById(msg.cid);
    if (!appcli) {
      this.logger.log("WARN", "AppClient not found", "Server.handleSessionASID", {sid: msg.sid, cid: msg.cid});
      socket.emit(Node.Server.msgTypeMap.redirect, this.config.getUrl() + "/" + msg.appname);
      return;
    }
    //
    // If there is a session but the socket message comes from a different app redirect to right app
    // (this could happen if the user uses the same TAB switching between two different apps;
    // due to the sessionStorage we receive a SID and CID from the "old" app)
    if (session.worker.app.name !== msg.appname) {
      // The session is there but it's from a different app. This could happen if the user
      // uses the same TAB switching between two different apps. Due to the sessionStorage we receive
      // a SID and CID from the "old" app. If that's the case, redirect to the right app
      this.logger.log("WARN", "Session mismatch for app", "Server.handleSessionASID",
              {sid: msg.sid, app: msg.appname, oldapp: session.worker.app.name});
      socket.emit(Node.Server.msgTypeMap.redirect, this.config.getUrl() + "/" + msg.appname);
      return;
    }
    //
    // This session exists and so does the client.
    // If I haven't done it yet create the physical process for the worker
    if (!session.worker.child)
      session.worker.createChild();
    //
    // Connect this socket with the app client
    appcli.openConnection(socket);
  }
};


/**
 * Handle client token message (received by the client when inviting a user)
 * @param {Node.Socket} socket - socket that received the message
 * @param {object} msg
 */
Node.Server.prototype.handleClientToken = function (socket, msg)
{
  // If the session is not there, tell the client that the session is gone
  var session = this.IDESessions[msg.sid];
  if (!session)
    return this.logger.log("WARN", "Session not found", "Server.handleClientToken", {sid: msg.sid});
  //
  session.addCToken(msg.ctoken);
  //
  this.logger.log("DEBUG", "Added CToken", "Server.handleClientToken", {sid: msg.sid, ctoken: msg.ctoken});
};


/**
 * Handle DEVICE message (received by the client)
 * @param {Node.Socket} socket - socket that received the message
 * @param {Object} msg
 */
Node.Server.prototype.handleDeviceMessage = function (socket, msg)
{
  // Read the kind of message sent
  var type = msg.type; // a string
  var data = msg.data; // a json object
  //
  // This sorts of authenticates the device/owner pair
  var user = this.config.getUser(data.userName);
  if (!user) {
    socket.emit("indeError", {type: "auth", msg: "user not found"});
    return this.logger.log("WARN", "User not found", "Server.handleDeviceMessage", {user: data.userName});
  }
  //
  if (type === "handShake")
    user.addDevice(socket, data);
  else
    this.logger.log("WARN", "Wrong message type for device", "Server.handleDeviceMessage", msg);
};


/**
 * Handle SYNC message (received by the client)
 * @param {Node.Socket} socket - socket that received the message
 * @param {Object} msg
 */
Node.Server.prototype.handleSyncMessage = function (socket, msg)
{
  // Search the session I've to route this message to
  var session = this.appSessions[msg.sid.sidsrv];
  if (!session) {
    session = this.IDESessions[msg.sid.sidcli];
    if (session) {
      // If there is at least an online app I use IDe session to open sync connection
      var onlineAppClient;
      for (var i = 0; i < session.appClients.length; i++) {
        if (session.appClients[i].mode !== "offline") {
          // This is a sync message in febe mode
          msg.sid.febe = true;
          //
          // I want to merge sync session with online preview session
          msg.sid.sidsrv = msg.sid.sidcli;
          //
          onlineAppClient = true;
          break;
        }
      }
      if (!onlineAppClient)
        session = undefined;
    }
  }
  //
  // Handle CONNECT
  if (msg.cnt.id === "connect") {
    // If there is no session try to connect
    if (!session) {
      // First get the user that owns the app (or use MANAGER)
      var user = this.config.getUser(msg.sid.username || "manager");
      if (!user) {
        socket.disconnect();
        return this.logger.log("WARN", "Sync connect not handled: user not found", "Server.handleSyncMessage", msg);
      }
      //
      // Search the app
      var app = user.getApp(msg.sid.appname);
      if (!app) {
        socket.disconnect();
        return this.logger.log("WARN", "Sync connect not handled: app not found", "Server.handleSyncMessage", msg);
      }
      //
      // Ask the app to create a new AppSession
      session = app.createNewSession();
      //
      // If needed ask the worker to create the physical child process
      if (!session.worker.child)
        session.worker.createChild();
      //
      // Insert the new session id into the message so that the sync object can store it somewhere
      msg.sid.sidsrv = session.id;
    }
    else if (session.syncSocket && session.syncSocket !== socket) {
      // This session had a socket: client had gone offline and returned online;
      // It was born a new socket, and old socket had not yet triggered the disconnect timeout.
      // I unplug the old socket not notifying the onDisconnect.
      session.syncSocket.removeAllListeners("disconnect");
      session.syncSocket.disconnect();
      delete session.syncSocket;
    }
    //
    // Open the sync connection (if not already connected)
    if (!session.syncSocket)
      session.openSyncConnection(socket, msg);
  }
  //
  // If I don't have a session I can't continue
  if (!session) {
    socket.disconnect();
    return this.logger.log("WARN", "Sync message not handled: session not found", "Server.handleSyncMessage", msg);
  }
  //
  // Assign a message type and route it to the proper child process
  msg.type = Node.Server.msgTypeMap.sync;
  session.sendToChild(msg);
};


/**
 * Handle CLOUD CONNECTOR message (received by a remote cloud connector server)
 * @param {Node.Socket} socket - socket that received the message
 * @param {Object} msg
 */
Node.Server.prototype.handleCloudConnectorMessage = function (socket, msg)
{
  var pthis = this;
  //
  var sendErrorToClient = function (errmsg) {
    pthis.logger.log("WARN", "Error handling a cloudConnector msg: " + errmsg, "Server.handleCloudConnectorMessage",
            {clientip: socket.handshake.address});
    //
    socket.emit("indeError", {type: "auth", msg: errmsg});
  };
  //
  if (msg.type === "init") {
    // Without username add to all users
    if (!msg.userName) {
      var i;
      for (i = 0; i < pthis.config.users.length; i++)
        pthis.config.users[i].addCloudConnector(socket, msg.data);
      //
      socket.on("disconnect", function () {
        for (i = 0; i < pthis.config.users.length; i++)
          pthis.config.users[i].removeCloudConnector(socket);
      });
      return;
    }
    //
    var user = pthis.config.getUser(msg.userName);
    if (!user)
      return sendErrorToClient("user " + msg.userName + " not found");
    //
    user.addCloudConnector(socket, msg.data);
    //
    socket.on("disconnect", function () {
      user.removeCloudConnector(socket);
    });
  }
  else {
    // First try IDE sessions. If not found try with app (MASTER) sessions
    var session = pthis.IDESessions[msg.sid];
    if (!session)
      session = pthis.appSessions[msg.sid];
    //
    if (!session)
      return sendErrorToClient("session not found");
    //
    session.sendToChild({type: "ccm", cnt: msg});
  }
};


/**
 * Create a new session for a project
 * @param {Node.Project} project
 * @param {Object} options
 * @param {Function} callback - (optional) function(result) called when session completed its job
 * @returns {Node.IDESession}
 */
Node.Server.prototype.createSession = function (project, options, callback)
{
  var pthis = this;
  //
  // No options means "default IDE session"
  options = options || {};
  options.type = options.type || "ide";
  //
  // Create a new session and add it to the session map
  var newSession = new Node.IDESession(project, options, function (result) {
    // The session has completed it's job -> delete it
    pthis.closeSession(newSession);
    //
    // Report to callee (if any)
    if (callback)
      callback(result || {});
  });
  this.IDESessions[newSession.id] = newSession;
  //
  // Log the operation
  this.logger.log("DEBUG", "Created new session", "Server.createSession",
          {sid: newSession.id, options: options, project: project.name, user: project.user.userName});
  //
  return newSession;
};


/**
 * Close a session
 * @param {Node.IDESession} session
 */
Node.Server.prototype.closeSession = function (session)
{
  delete this.IDESessions[session.id];
  //
  // Tell the childer that the session have been closed and he needs to forget about it
  this.childer.send({id: session.id, type: Node.Server.msgTypeMap.disconnectChild});
};


/**
 * Finds if there exist a open session given a project (used in the method getSessionByProject)
 * @param {Node.Project} project
 * @returns {Array} array of Node.IDESession
 */
Node.Server.prototype.getOpenSession = function (project)
{
  var keys = Object.keys(this.IDESessions);
  for (var i = 0; i < keys.length; i++) {
    var sess = this.IDESessions[keys[i]];
    //
    // If this session is for the project I'm looking for and its
    // an IDE session and it's not readOnly (VIEW)
    if (sess.project === project && sess.options.type === "ide" && !sess.options.readOnly)
      return sess;
  }
};


/**
 * Given a user name, list al its sessions
 * @param {string} userName
 * @returns {Array} array of Node.IDESession
 */
Node.Server.prototype.getSessionListByUser = function (userName)
{
  var sessionList = [];
  var keys = Object.keys(this.IDESessions);
  for (var i = 0; i < keys.length; i++) {
    var sess = this.IDESessions[keys[i]];
    if (sess.project.user.userName === userName)
      sessionList.push(sess);
  }
  //
  return sessionList;
};


/**
 * Return the list of the online sessions
 * (for every session list user, project, number of active clients and session type)
 * @returns {Array} array of sessions
 */
Node.Server.prototype.getOnlineSessions = function ()
{
  var sessions = [];
  var keys = Object.keys(this.IDESessions);
  for (var i = 0; i < keys.length; i++)
    sessions.push(this.IDESessions[keys[i]]);
  //
  return sessions;
};


/**
 * Start timers that will backup projects periodically
 * @param {boolean} scheduled - true if this is a "scheduled" call (the one that have to be actually
 * executed each day... see first setTimeout)
 */
Node.Server.prototype.backupProjects = function (scheduled)
{
  // If the backup is not enabled, do nothing
  if (!this.config.nigthlybucketGCloud || !this.config.daysBackups || !this.config.numMinBackups)
    return this.logger.log("INFO", "Automatic project backup not configured", "Server.backupProjects",
            {nigthlybucketGCloud: this.config.nigthlybucketGCloud || "", daysBackups: this.config.daysBackups || 0,
              numMinBackups: this.config.numMinBackups || 0});
  //
  // This algorithm uses the following 3 config parameters:
  //  - "timeBackup": indicates when I have to backup the project ([HOUR]*100 + MINUTES)
  //  - "daysBackups": indicates the maximum number of days I have to keep backup for (i.e. backup of the last 30 days)
  //  - "numMinBackups": indicates the minimum number of file I have to keep
  var pthis = this;
  var now = new Date();
  var i, j, prj;
  //
  // If not scheduled, schedule it
  if (!scheduled) {
    // Compute HOURS and MINUTES from timeBackup param
    var hours = Math.floor((this.config.timeBackup || 0) / 100);
    var mins = (this.config.timeBackup || 0) % 100;
    //
    // Compute how many ms there are from NOW to the expected backup time
    var backupTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, mins, 0, 0);
    var msTillBackupTime = backupTime - now;
    if (msTillBackupTime < 0)   // backup time is in the past... (less than 24h from now)
      msTillBackupTime += 86400000;
    //
    // Now I've all info that allows me to schedule backups
    setTimeout(function () {
      // First call in this day
      pthis.backupProjects(true);
      //
      // And schedule backup for following days
      setInterval(function () {
        // Calls for following days
        pthis.backupProjects(true);
      }, 86400000);
    }, msTillBackupTime);
    //
    // Scheduled
    return;
  }
  //
  // Compute which projects I have to backup
  var prjsToBackup = [];
  for (i = 0; i < this.config.users.length; i++) {
    var user = this.config.users[i];
    for (j = 0; j < user.projects.length; j++) {
      prj = user.projects[j];
      //
      // If the project is online I'll check it when I have to back it up
      if (prj.isOnline()) {
        prjsToBackup.push(prj);
        continue;
      }
      //
      // Skip projects that have never been saved
      if (!prj.lastSave)
        continue;
      //
      // Skip projects that have not been modified in the last 24 hours
      if ((new Date() - new Date(prj.lastSave)) >= 86400000)
        continue;
      //
      // I have to backup this project
      prjsToBackup.push(prj);
    }
  }
  //
  // Do backup (loop until all projects have been backed up)
  // Do it serially because GCloud complains if I do it in parallel
  var backupLoop = function () {
    // If there are no probjects to backup, I've done
    if (prjsToBackup.length === 0)
      return;
    //
    // Get the first project that is not online
    prj = null;
    for (i = 0; i < prjsToBackup.length; i++) {
      var p = prjsToBackup[i];
      if (p.isOnline())
        continue;   // Online -> wait...
      //
      // This project is not online... remove it from the list and back it up
      prjsToBackup.splice(i, 1);
      prj = p;
      break;
    }
    //
    // If all projects are online
    if (!prj) {
      // If 1 hour has passed since I've started -> give up
      if ((new Date() - now) > 3600000) {
        pthis.logger.log("DEBUG", "There are still projects online but 1 hour has passed since I've started -> give up", "Server.backupProjects",
                {numPrj: prjsToBackup.length});
        return;
      }
      //
      // Less than 1 hour -> wait 1 minute and re-check
      setTimeout(backupLoop, 60000);
      return;
    }
    //
    pthis.logger.log("DEBUG", "Backup project", "Server.backupProjects", {project: prj.name, user: prj.user.userName});
    //
    // Backup the project (don't backup BUILD and FILE folders)
    prj.nightlyBackup(function (err) {
      if (err)
        pthis.logger.log("ERROR", "Can't backup project: " + err, "Server.backupProjects", {project: prj.name, user: prj.user.userName});
      else // Everything is fine -> remove old projects
        pthis.cleanBucket(prj);
      //
      // Next project
      backupLoop();
    });
  };
  backupLoop();
};


/**
 * Removes old projects from the backup bucket
 * @param {Node.Project} prj - project to clean up
 */
Node.Server.prototype.cleanBucket = function (prj)
{
  var pthis = this;
  var path = "users/" + this.config.serverType + "/" + prj.user.userName + "/backups/projects/" + prj.name + "/";
  var msLimit = this.config.daysBackups * 24 * 3600 * 1000;   // Number of ms I have to keep the file for
  var now = new Date();
  //
  // Get the list of all files in the cloud at the given project's backup path
  var archiver = new Node.Archiver(this, true);
  archiver.getFiles(path, function (err, files) {
    if (err)
      return pthis.logger.log("WARN", "Can't enumerate files: " + err, "Server.cleanBucket", {project: prj.name, user: prj.user.userName});
    //
    // If the number of files in the bucket is already at minimum, do nothing
    pthis.logger.log("DEBUG", "#files in bucket: " + (files ? files.length : 0) + "/" + pthis.config.numMinBackups, "Server.cleanBucket",
            {project: prj.name, user: prj.user.userName});
    if (!files || files.length <= pthis.config.numMinBackups)
      return;
    //
    // Remove older ones
    for (var i = 0; i < files.length; i++) {
      // Compute the file date
      var fn = files[i];
      //
      // File name format: [project]-[date].tar.gz
      // where [date] is in the ISO form without "-:T.Z" (thus YYYYMMDDHHMMSSmmm - see Node.Project.prototype.backup)
      fn = fn.substring(0, fn.length - 7);     // Remove extension (.tar.gz)
      fn = fn.substring(fn.lastIndexOf("-") + 1); // Get the DATE part
      var dateFile = new Date(fn.substring(0, 4) + "-" + fn.substring(4, 6) + "-" + fn.substring(6, 8) + "T" +
              fn.substring(8, 10) + ":" + fn.substring(10, 12) + ":" + fn.substring(12, 14) + "." + fn.substring(15) + "Z");
      var msFileDelta = now - dateFile;
      //
      if (msFileDelta > msLimit) {
        var ftodelete = files[i];
        pthis.logger.log("DEBUG", "Remove older file " + ftodelete, "Server.cleanBucket", {project: prj.name, user: prj.user.userName});
        archiver.deleteFile(ftodelete, function (err) {
          if (err)
            pthis.logger.log("WARN", "Error removing file " + ftodelete + " from the project backup bucket: " + err, "Server.cleanBucket",
                    {project: prj.name, user: prj.user.userName});
        });   // jshint ignore:line
      }
    }
  });
};


/*
 * Start timer that will create a periodic snapshot of the disk
 * @param {boolean} scheduled - true if this is a "scheduled" call (the one that have to be actually
 * executed each day... see first setTimeout)
 */
Node.Server.prototype.backupDisk = function (scheduled)
{
  // If I'm on a windows machine, backup is not supported
  if (/^win/.test(process.platform))
    return;
  //
  // If I need to reschedule and the backup was previously started, stop everything
  // (this could happen if the user changed configuration, see config::configureServer)
  if (!scheduled && this.backupDiskTimeoutID) {
    clearTimeout(this.backupDiskTimeoutID);
    delete this.backupDiskTimeoutID;
    //
    clearInterval(this.backupDiskIntervalID);
    delete this.backupDiskIntervalID;
  }
  //
  // If not configured, do nothing
  if (!this.config.numHoursSnapshot || !this.config.numMaxSnapshot)
    return this.logger.log("INFO", "Automatic disk backup not configured", "Server.backupDisk",
            {numHoursSnapshot: this.config.numHoursSnapshot || 0, numMaxSnapshot: this.config.numMaxSnapshot || 0});
  //
  // This algorithm uses the following 3 config parameters:
  //  - "numHoursSnapshot": number of hours between snapshots (24 -> 1 snapshot per day)
  //  - "numMaxSnapshot": indicates the maximum number of files I have to keep
  //  - "timeSnapshot": indicates when I have to take a snapshot ([HOUR]*100 + MINUTES, 100 -> means 1 AM)
  var now = new Date();
  //
  // If not scheduled, schedule it
  if (!scheduled) {
    // Compute HOURS and MINUTES from timeBackup param
    var hours = Math.floor((this.config.timeSnapshot || 0) / 100);
    var mins = (this.config.timeSnapshot || 0) % 100;
    //
    // Compute how many ms there are from NOW to the expected backup time
    var snapshotTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, mins, 0, 0);
    var msTillSnapshotTime = snapshotTime - now;
    if (msTillSnapshotTime < 0)   // snapshot time is in the past... (less than 24h from now)
      msTillSnapshotTime += 86400000;
    //
    // Now I've all info that allows me to schedule backups
    this.backupDiskTimeoutID = setTimeout(function () {
      // First call in this day
      this.backupDisk(true);
      //
      // And schedule future snapshots
      this.backupDiskIntervalID = setInterval(function () {
        // Calls for following days
        this.backupDisk(true);
      }.bind(this), this.config.numHoursSnapshot * 3600 * 1000);
    }.bind(this), msTillSnapshotTime);
    //
    // Scheduled
    return;
  }
  //
  // If I've not yet done it retrieve needed info
  if (!this.backupInfo) {
    // Store backup info
    this.backupInfo = {};
    //
    var options = {
      protocol: "http:",
      hostname: "metadata.google.internal",
      headers: {"Metadata-Flavor": "Google"}
    };
    //
    // Read Zone
    options.path = "/computeMetadata/v1/instance/zone";
    this.request.getRequest(options, function (code, zone, err) {
      if (code !== 200 || err)
        return this.logger.log("WARN", "Can't read metadata::zone: " + (err || "ResponseCode: " + code),
                "Server.backupDisk", options);
      //
      // Format:
      //    projects/839082392750/zones/europe-west1-c
      this.backupInfo.cloudZone = zone.substring(zone.lastIndexOf("/") + 1);
      //
      // Read diskName
      options.path = "/computeMetadata/v1/instance/disks/1/device-name";
      this.request.getRequest(options, function (code, devName, err) {
        if (code !== 200 || err)
          return this.logger.log("WARN", "Can't read metadata::device-name: " + (err || "ResponseCode: " + code),
                  "Server.backupDisk", options);
        //
        this.backupInfo.diskName = devName;
        //
        // Now, continue with backup
        doBackup();
      }.bind(this));
    }.bind(this));
  }
  else {
    // I have backup info, continue with backup
    setImmediate(function () {      // N.B.: use setImmediate so that I can define the doBackup function after this block
      doBackup();
    });
  }
  //
  // Function that schedules the backup of the data disk and clean up old snapshots
  var doBackup = function () {
    this.logger.log("DEBUG", "Start disk backup", "Server.backupDisk", this.backupInfo);
    //
    var sdate = new Date().toISOString().replace(/-/g, "").replace(/:/g, "").replace("T", "").replace(".", "").replace("Z", "");
    var cmdSnapPars = ["-q", "compute", "disks", "snapshot", this.backupInfo.diskName,
      "--description", "Snapshot created at " + new Date() + "for server " + this.config.name,
      "--snapshot-names", this.backupInfo.diskName + "-" + sdate.substring(0, sdate.length - 3), // Remove ms from time,
      "--zone", this.backupInfo.cloudZone];
    this.execFileAsRoot("gcloud", cmdSnapPars, function (err, stdout, stderr) {
      if (err)
        return this.logger.log("WARN", "Can't create the snapshot: " + (stderr || err), "Server.backupDisk");
      //
      // Snapshot created, now clean up (if needed)
      // List all snapshots for this disk
      var cmdCleanPars = ["-q", "compute", "snapshots", "list", "--regexp", this.backupInfo.diskName + "-.*", "--format", "json"];
      this.execFileAsRoot("gcloud", cmdCleanPars, function (err, stdout, stderr) {
        if (err)
          return this.logger.log("WARN", "Can't list all snapshots for this server: " + (stderr || err), "Server.backupDisk");
        //
        // If there are too many snapshot, delete older ones
        var snapList = JSON.parse(stdout);
        this.logger.log("DEBUG", "#snapshot: " + snapList.length + "/" + this.config.numMaxSnapshot, "Server.backupDisk");
        if (snapList.length > this.config.numMaxSnapshot) {
          // Remove older ones. First I need to sort them by date
          snapList.sort(function (f1, f2) {
            var dt1 = f1.name.substring(f1.name.lastIndexOf("-") + 1);
            var dt2 = f2.name.substring(f2.name.lastIndexOf("-") + 1);
            dt1 = new Date(dt1.substring(0, 4) + "-" + dt1.substring(4, 6) + "-" + dt1.substring(6, 8) + "T" +
                    dt1.substring(8, 10) + ":" + dt1.substring(10, 12) + ":" + dt1.substring(12, 14));
            dt2 = new Date(dt2.substring(0, 4) + "-" + dt2.substring(4, 6) + "-" + dt2.substring(6, 8) + "T" +
                    dt2.substring(8, 10) + ":" + dt2.substring(10, 12) + ":" + dt2.substring(12, 14));
            return (dt1 > dt2 ? -1 : (dt1 < dt2 ? 1 : 0));                  // Sort reversed (older is the last one)
          });
          //
          // Now I can remove older one
          for (var i = this.config.numMaxSnapshot; i < snapList.length; i++) {
            (function (sname) {
              this.logger.log("DEBUG", "Delete old snapshot " + sname, "Server.backupDisk");
              //
              var cmdDelPars = ["-q", "compute", "snapshots", "delete", sname];
              this.execFileAsRoot("gcloud", cmdDelPars, function (err, stdout, stderr) {
                if (err)
                  return this.logger.log("WARN", "Can't delete snapshot " + sname + ": " + (stderr || err), "Server.backupDisk", this.backupInfo);
              }.bind(this));
            }.bind(this))(snapList[i].name);    // jshint ignore:line
          }
        }
        //
        this.logger.log("DEBUG", "Disk backup completed", "Server.backupDisk");
      }.bind(this));
    }.bind(this));
  }.bind(this);
};


/**
 * Generates a new application.manifest file
 * @param {string} manifType - (if undefined create both)
 */
Node.Server.prototype.createManifest = function (manifType)
{
  // If type was not given, create both manifests
  if (manifType === undefined) {
    this.createManifest("ide");
    this.createManifest("ideapp");
    return;
  }
  //
  var i;
  var basePath, indexPath;
  if (manifType === "ide") {
    basePath = Node.path.resolve(__dirname + "/../ide");
    indexPath = basePath + "/index2.html";
  }
  else if (manifType === "ideapp") {
    basePath = Node.path.resolve(__dirname + "/../ide/app/client");
    indexPath = basePath + "/index.html";
  }
  //
  if (!Node.fs.existsSync(basePath))
    return;
  //
  // If manifest exists, delete it
  if (Node.fs.existsSync(basePath + "/application.manifest"))
    Node.fs.unlinkSync(basePath + "/application.manifest");
  //
  // Create a new one
  // First, compute the list of needed files reading the index.html file
  var files = [];
  var index = Node.fs.readFileSync(indexPath, "utf8");
  var cssList = index.split("<link href=\"");
  var jsList = index.split("<script src=\"");
  //
  for (i = 0; i < 2; i++) {
    var list = (i === 0 ? cssList : jsList);
    for (var j = 1; j < list.length; j++) {
      var file = list[j].substring(0, list[j].indexOf("\"", 1));
      if (Node.fs.existsSync(basePath + "/" + file))
        files.push(file);
    }
  }
  //
  // Compute lastModified of all files
  var lastModified = 0;
  for (i = 0; i < files.length; i++) {
    var stats = Node.fs.statSync(basePath + "/" + files[i]);
    if (stats.mtime > lastModified)
      lastModified = stats.mtime;
  }
  //
  var mf = [];
  mf.push("CACHE MANIFEST");
  mf.push("# " + lastModified);
  mf.push("");
  mf.push("CACHE:");
  files.forEach(function (fn) {
    mf.push(fn);
  });
  mf.push("");
  mf.push("NETWORK:");
  mf.push("*");
  //
  var manifest = mf.join("\n");
  Node.fs.writeFileSync(basePath + "/application.manifest", manifest);
  return manifest;
};


/**
 * Send the application.manifest to client (IDE & APP)
 * @param {Request} req
 * @param {Response} res
 */
Node.Server.prototype.sendManifest = function (req, res)
{
  try {
    var basePath;
    var isAppIDE = (req.params.app === "app");
    var isAppMaster = (req.params.app && !isAppIDE);
    var isIDE = (!isAppIDE && !isAppMaster);
    //
    if (isIDE)
      basePath = Node.path.resolve(__dirname + "/../ide");
    else if (isAppIDE)
      basePath = Node.path.resolve(__dirname + "/../ide/app/client");
    else if (isAppMaster)
      basePath = this.config.appDirectory + "/apps/" + req.params.app + "/client";
    //
    var manifest;
    if (Node.fs.existsSync(basePath + "/application.manifest"))
      manifest = Node.fs.readFileSync(basePath + "/application.manifest", "utf8");
    //
    // If the manifest does not exists create a new one
    if (!manifest) {
      // Do it only for IDE... The Master app manifest is created at build time
      // and it have to be there
      if (isIDE)
        manifest = this.createManifest("ide");
      else if (isAppIDE)
        manifest = this.createManifest("ideapp");
    }
    //
    // If I have a manifest, send it
    if (manifest) {
      res.header("Content-Type", "text/cache-manifest");
      res.header("Expires", new Date(new Date().getTime() + 300000));     // 5 minutes
      res.header("Content-Length", manifest.length);
      res.status(200).send(manifest);
    }
    else // No manifest -> 404
      res.status(404).end();
  }
  catch (ex) {
    this.logger.log("ERROR", "Error while sending MANIFEST: " + ex.message, "Server.sendManifest");
    res.status(500).end();
  }
};


// Starts the server
Node.createServer();
