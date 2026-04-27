/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
var Node = Node || {};

// Import classes
Node.Config = require("./config/config");
Node.IDESession = require("./idesession");
Node.AppSession = require("./master/appsession");
Node.Logger = require("./logger");
Node.Request = require("./request");
Node.Archiver = require("./archiver");
Node.Utils = require("./utils");
Node.McpServer = require("./mcpserver");

// Import modules
Node.express = require("express");
Node.useragent = require("express-useragent");
Node.app = Node.express();
Node.http = require("http");
Node.https = require("https");
Node.compress = require("compression");
Node.cookieParser = require("cookie-parser");
Node.helmet = require("helmet");
Node.fs = require("fs");
Node.path = require("path");
Node.os = require("os");
Node.tls = require("tls");
Node.child = require("child_process");
Node.url = require("url");
Node.BodyParser = require("body-parser");
Node.BodyParserXML = require("body-parser-xml")(Node.BodyParser);
Node.errorHandler = require("errorhandler");
Node.constants = require("crypto").constants;
Node.googleCloudCompute = require("@google-cloud/compute");
Node.mime = require("mime-types");


/**
 * @class Represents an Instant Developer Server
 */
Node.Server = function ()
{
  // List of sessions
  this.IDESessions = {};
  this.appSessions = {};
  //
  // Map of SYS commands promises
  this.execPromises = {};
  //
  // Remember start time
  this.startTime = new Date();
  //
  // MCP server for DevAgent remote control
  this.mcpServer = new Node.McpServer(this);
};


Node.Server.msgTypeMap = {
  pid: "pid",
  log: "log",
  sessionid: "sid",
  disconnectChild: "dc",
  asid: "asid",
  deviceMessage: "deviceMessage",
  sync: "sync",
  cloudConnector: "cloudConnector",
  redirect: "redirect",
  sessionError: "seser",
  execCmdRequest: "exreq",
  execCmdResponse: "exres",
  dtt: "dtt",
};


/**
 * Create a new Server
 */
Node.createServer = async function ()
{
  Node.Utils.fixMimeTypes();
  Node.theServer = new Node.Server();
  await Node.theServer.initServer();
  Node.theServer.start();
};


/**
 * Initialize the Server
 */
Node.Server.prototype.initServer = async function ()
{
  // Load the configuration from the json file
  this.config = new Node.Config(this);
  this.config.local = Node.fs.existsSync(__dirname + "/config.json"); // local if config.json is "close" to this file (server.js)
  await this.config.loadConfig();
  console.log(`Current server mode: ${this.config.local ? "LOCAL" : "PROD"}`);
  //
  // If local mode or HTTP protocol
  let server;
  if (this.config.local || this.config.protocol === "http") {
    // Create an http Server
    Node.httpServer = require("http").createServer(Node.app);
    //
    server = Node.httpServer;
  }
  else {  // Use HTTPS server
    // Loads the ssl certificates
    let ca = [];
    if (this.config.SSLCABundles)
      for (let i = 0; i < this.config.SSLCABundles.length; i++)
        ca.push(Node.fs.readFileSync(this.config.SSLCABundles[i], "utf8"));
    //
    // Ciphers are updated to May 11 node defaults
    // See https://github.com/nodejs/node/blob/master/doc/api/tls.markdown
    let ssl = {
      key: Node.fs.readFileSync(this.config.SSLKey, "utf8"),
      cert: Node.fs.readFileSync(this.config.SSLCert, "utf8"),
      ca: ca,
      minVersion: "TLSv1.2",
      ciphers: [
        "ECDHE-RSA-AES256-GCM-SHA384",
        "ECDHE-RSA-AES128-GCM-SHA256",
        "ECDHE-RSA-AES256-SHA384",
        "ECDHE-RSA-AES128-SHA256",
        "ECDHE-RSA-AES256-SHA",
        "ECDHE-RSA-AES128-SHA",
        "AES256-GCM-SHA384",
        "AES128-GCM-SHA256",
        "AES256-SHA256",
        "AES128-SHA256",
        "AES256-SHA",
        "AES128-SHA",
        "HIGH",
        "!DHE-RSA-AES256-GCM-SHA384",
        "!DHE-RSA-AES128-GCM-SHA256",
        "!aNULL",
        "!eNULL",
        "!EXPORT",
        "!DES",
        "!MD5",
        "!PSK",
        "!RC4",
        "!DHE-RSA-DES-CBC3-SHA",
        "!DHE-RSA-CAMELLIA256-SHA",
        "!DHE-RSA-CAMELLIA128-SHA",
        "!DHE-RSA-AES256-SHA256",
        "!DHE-RSA-AES128-SHA256",
        "!DHE-RSA-AES256-SHA",
        "!DHE-RSA-AES128-SHA"
      ].join(":")
    };
    //
    // Handle custom certificates
    //   http://stackoverflow.com/questions/12219639/is-it-possible-to-dynamically-return-an-ssl-certificate-in-nodejs#answer-20285934
    //   https://www.digicert.com/ssl-support/apache-secure-multiple-sites-sni.htm
    ssl.SNICallback = (domain, cb) => {
      // If it's the "main" domain, use the ssl object to reply
      // If there are no custom certicicates use the "main" domain as well
      if (domain === `${this.config.name}.${this.config.domain}` || !this.config.customSSLCerts)
        return cb(null, Node.tls.createSecureContext(ssl).context);
      //
      // If the domain is a sub-domain of "instantdevelopercloud.com" use the "standard" certificate
      if (domain.endsWith(".instantdevelopercloud.com"))
        return cb(null, Node.tls.createSecureContext(ssl).context);
      //
      // I need to search the right certificate
      let certToUse, cert;
      for (let i = 0; i < this.config.customSSLCerts.length && !certToUse; i++) {
        cert = this.config.customSSLCerts[i];
        //
        // If the certificate is a multi-domain certificate check only sub-domain part otherwise check full domain
        if ((cert.SSLDomain.startsWith("*") && cert.SSLDomain.split(".").slice(1).join(".") === domain.split(".").slice(1).join(".")) ||
                (!cert.SSLDomain.startsWith("*") && cert.SSLDomain === domain))
          certToUse = cert;
      }
      //
      // If not found
      if (!certToUse) {
        this.logger.log("WARN", `No valid certificate for domain ${domain}`, "Server.initServer");
        return cb(null, Node.tls.createSecureContext(ssl).context);
      }
      //
      // If I haven't read file data yet, do it now
      this.loadCustomCert(certToUse).then(() => {
        // I have all needed files.
        let cred = {
          key: certToUse.SSLKey_data,
          cert: certToUse.SSLCert_data,
          secureProtocol: ssl.secureProtocol,
          secureOptions: ssl.secureOptions,
          ciphers: ssl.ciphers,
          ca : []
        };
        if (cert.SSLCABundles)
          for (let j = 0; j < cert.SSLCABundles.length; j++)
            cred.ca.push(certToUse.SSLCABundles_data[j]);
        //
        // Reply with TLS secure context
        try {
          cb(null, Node.tls.createSecureContext(cred).context);
        }
        catch (ex) {
          this.logger.log("ERROR", `Can't create secure context with given certificate for domain ${domain}: ${ex}`, "Server.initServer");
          return cb(`Can't create secure context with given certificate for domain ${domain}: ${ex}`);
        }
      }, err => {
        this.logger.log("ERROR", "Error while reading custom certificate's file", "Server.initServer");
        cb(null, Node.tls.createSecureContext(ssl).context);
      });
    };
    //
    // Create an https Server
    Node.httpsServer = require("https").createServer(ssl, Node.app);
    //
    server = Node.httpsServer;
  }
  //
  Node.app.use((req, res, next) => {
    if (this.config.responseHeaders) {
      for (let headName in this.config.responseHeaders)
        res.header(headName, this.config.responseHeaders[headName]);
    }
    else {
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    }
    next();
  });
  //
  // Set socket io on top of server
  Node.io = require("socket.io")(server, {allowEIO3: true, maxHttpBufferSize: 1e8, cors: {origin: "*"}, perMessageDeflate: {threshold: 50 * 1024}});
};


/**
 * Start the server
 */
Node.Server.prototype.start = function ()
{
  // Create the childer
  this.createChilder();
  //
  // Remove the root privileges of the main process after the childer is born
  // (on FreeBSD we use 8081/8082 thus we do not need ROOT to be able to start HTTP/HTTPS listener)
  if (!this.config.local && process.platform === "freebsd") {
    process.setgid("indert");
    process.setuid("indert");
  }
  //
  // Create a new Logger
  this.logger = new Node.Logger(this, "SERVER");
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
  // Rotate logs (console.log and console.error)
  this.startLogRotate();
  //
  // Create a new AUTK token and send it (if needed)
  this.config.initTokenTimer();
  //
  // Initialize tracking (if active)
  this.config.initTracking();
  //
  // Get external IP (if available)
  this.config.getExternalIp();
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
  // Sets "Strict-Transport-Security: max-age=5184000000; includeSubDomains".
  Node.app.use(Node.helmet.hsts({maxAge: 5184000000}));     // 60 days
  //
  // Enable gzip compression
  Node.app.use(Node.compress());
  //
  // Enable user-agent parser
  Node.app.use(Node.useragent.express());
  //
  // Enable cookie parser
  Node.app.use(Node.cookieParser());
  //
  // Application/x-www-form-urlencoded post requests
  Node.app.use(Node.BodyParser.urlencoded({extended: true, limit: "5mb"}));
  //
  // Parse various different custom JSON types as JSON
  Node.app.use(Node.BodyParser.json({type: "application/json", limit: "5mb"}));
  //
  // Parse the body as XML in case of appropriate content-type
  Node.app.use(Node.BodyParser.xml({type: ["application/xml", "text/xml"], limit : "5mb"}));
  //
  // Parse all text bodies
  Node.app.use(Node.BodyParser.text({type: "text/*", limit: "5mb"}));
  //
  // Parse raw binary bodies (default: application/octet-stream; can be widened to application/*)
  Node.app.use(Node.BodyParser.raw({limit: "5mb"}));
  //
  // MCP endpoint for DevAgent remote control (Streamable HTTP transport)
  let mcpHandler = (req, res) => this.mcpServer.handleRequest(req, res);
  Node.app.post("/mcp", mcpHandler);
  Node.app.get("/mcp", mcpHandler);
  Node.app.delete("/mcp", mcpHandler);
  //
  // App service worker
  this.createServiceWorker();
  Node.app.get("/serviceWorker.js", Node.Server.prototype.sendServiceWorker.bind(this));
  Node.app.get("/:app/client/serviceWorker.js", Node.Server.prototype.sendServiceWorker.bind(this));
  Node.app.get("/:app/client/serviceWorkerOffline.js", Node.Server.prototype.sendServiceWorker.bind(this));
  Node.app.get("/:app/client/app.webmanifest", Node.Server.prototype.sendAppManifest.bind(this));
  Node.app.get("/:app/client/appOffline.webmanifest", Node.Server.prototype.sendAppManifest.bind(this));
  //
  // Invalidate old manifest used by 19.5-
  // (https://www.html5rocks.com/en/tutorials/appcache/beginner/
  // If the manifest itself returns a 404 or 410, the cache is deleted.)
  Node.app.get("/application.manifest", (req, res) => res.status(404).end());
  Node.app.get("/:app/client/application.manifest", (req, res) => res.status(404).end());
  //
  // RD3View (IDF)
  this.registerIDFRoutes();
  //
  // Inizialize static file management for express with maxAge=5min (not for local servers)
  let expOpts = (this.config.local ? undefined : {index: false, redirect: false, maxAge: 300000});
  let idePath = Node.path.resolve(__dirname, "..", "ide");
  if (Node.fs.existsSync(idePath)) { // IDE
    this.logger.log("INFO", "Start EXPRESS for IDE", "Server.start", {path: idePath});
    Node.app.use(Node.express.static(idePath, expOpts));
  }
  if (this.config.appDirectory) {    // MASTER
    this.logger.log("INFO", "Start EXPRESS for MASTER", "Server.start", {path: Node.path.join(this.config.appDirectory, "apps")});
    //
    // If there is a default app and the IDE path does not exist (MyCloud server)
    // route all SERVER/app/client/XXX requests that normally goes to the IDE side onto the default app
    if (this.config.defaultApp && !Node.fs.existsSync(idePath)) {
      let defAppPath = Node.path.join(this.config.appDirectory, "apps", this.config.defaultApp, "client");
      if (Node.fs.existsSync(defAppPath)) {
        this.logger.log("INFO", "Start EXPRESS for DEFAULT APP (IDE-like: /app/client path)", "Server.start", {path: defAppPath});
        Node.app.use("/app/client", Node.express.static(defAppPath, expOpts));
      }
    }
    //
    // Use, for every app, maxAge=1 year for uploaded and resources... if they change, their name will change
    if (expOpts)
      expOpts.setHeaders = function (res, path) {
        path = path.replace(/\\/g, "/").toLowerCase();    // Win junk
        if (path.includes("/uploaded/"))
          res.setHeader("Cache-Control", "public, max-age=31536000");
      };
    //
    // Protect SERVER's directories (for every app) before EXPRESS-STATIC kicks in
    // Protect APP's private files directoriy (for every app) before EXPRESS-STATIC kicks in
    // Protect PROJECT's private files directoriy (for every user/project) before EXPRESS-STATIC kicks in
    Node.app.use("/", (req, res, next) => {
      let pathParts = req.path.toLowerCase().replace(/\/{2,}/g, "/").split("/");
      let app = (pathParts.length > 1 ? this.config.getUser("manager").getApp(pathParts[1]) : null);
      if (pathParts.length > 2 && pathParts[2] === "server" && (!app || !app.params || !app.params.allowOffline)) {
        this.logger.log("WARN", "Access to app's server folder denied", "Server.start", {url: req.path, app: (app ? app.name : "<NULL>")});
        return res.sendStatus(404); // http://server/MyApp/server/app.js  ->  [ '', 'MyApp', 'server', 'app.js' ]
      }
      else if (pathParts.length > 4 && pathParts.slice(2, 4).join("/") === "files/private") {
        this.logger.log("WARN", "Access to app's private folder denied", "Server.start", {url: req.path, app: (app ? app.name : "<NULL>")});
        return res.sendStatus(404); // http://server/MyApp/files/private/file.png  ->  [ '', 'MyApp', 'files', 'private', 'file.png' ]
      }
      else if (pathParts.length > 5 && pathParts.slice(3, 5).join("/") === "files/private") {
        this.logger.log("WARN", "Access to project's private folder denied", "Server.start", {url: req.path, app: (app ? app.name : "<NULL>")});
        return res.sendStatus(404); // http://server/lucabaldini/testprj/files/private/file.png  ->  [ '', 'lucabaldini', 'testprj', 'files', 'private', 'file.png' ]
      }
      //
      next();
    });
    //
    // Serve APPS directory as static
    Node.app.use(Node.express.static(Node.path.join(this.config.appDirectory, "apps"), expOpts));
  }
  //
  // Handle letsencrypt challenge files (if it's a "standard" install (not for MyCloud))
  if (Node.fs.existsSync("/mnt/disk"))
    Node.app.use("/.well-known", Node.express.static("/mnt/disk/config/cert/letsencrypt/.well-known", {dotfiles: 'allow'}));
  //
  // Handle commands (config class does everything)
  Node.app.all("", (req, res) => this.config.processRun(req, res));
  Node.app.all("/:app", (req, res) => this.config.processRun(req, res));
  Node.app.all("/:sid/:appid/run", (req, res) => this.config.processRun(req, res));
  Node.app.all("/:user/:command", (req, res) => this.config.processCommand(req, res));
  Node.app.all("/:user/db/:dbname/:command", (req, res) => this.config.processCommand(req, res));
  //  Node.app.get("/:user/:appname/:command", (req, res) => {
  Node.app.all("/:user/:project/:command", (req, res) => this.config.processCommand(req, res));
  Node.app.all("/:user/:project/:command/*any", (req, res) => this.config.processCommand(req, res));
  Node.app.all("/:app/:cls", (req, res) => this.config.processRun(req, res));
  Node.app.all("/:app/:cls/*any", (req, res) => this.config.processRun(req, res));
  //
  // Main error-handler (this should come after all the routes)
  Node.app.use(Node.errorHandler({log: (err, str, req, res) => {
    this.logger.log("ERROR", `Server error: ${err}`, "Server.start", {met: req.method, url: req.url, str});
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
    let httpApp = Node.express();
    //
    // No redirect for letsencrypt's challenges (if it's a "standard" install (not for MyCloud))
    if (Node.fs.existsSync("/mnt/disk"))
      httpApp.use("/.well-known", Node.express.static("/mnt/disk/config/cert/letsencrypt/.well-known", {dotfiles: "allow"}));
    //
    // Create a new Router and use it in the App
    let httpRouter = Node.express.Router();
    httpApp.use("*any", httpRouter);
    //
    // For any get request, redirect to same HTTPS request
    httpRouter.get("*any", (req, res) => res.redirect(this.config.getUrl(req) + req.originalUrl));
    //
    // Create the http server
    Node.httpServer = Node.http.createServer(httpApp);
    Node.httpServer.listen(this.config.portHttp);
  }
  //
  // Remove the root privileges of the main process after done with childer and HTTP/HTTPS listen
  // (on Docker we use 80/443 thus we need ROOT to be able to listen to ports below 1024)
  if (!this.config.local && process.platform === "linux") {
    process.setgid("indert");
    process.setuid("indert");
    //
    this.setOwnerToIndert();
  }
  //
  // Start default server session of all apps
  this.startServerSessions();
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
  // Fork the childer process
  this.childer = Node.child.fork(__dirname + "/childer.js", Node.Utils.forkArgs());
  //
  // Childer listener
  this.childer.on("message", msg => this.handleChilderMessage(msg));
  this.childer.on("disconnect", () => {
    this.logger.log("WARN", "Childer is dead -> restart server", "Server.createChilder");
    process.exit(-1);
  });
};


/**
 * Process all messages coming from the childer process
 * @param {Object} msg - message
 */
Node.Server.prototype.handleChilderMessage = async function (msg)
{
  switch (msg.type) {
    case Node.Server.msgTypeMap.log:    // LOG message received by childer (either childer or child log message)
      this.logger.log(msg.level, msg.message, msg.sender, msg.data);
      break;

    case Node.Server.msgTypeMap.execCmdResponse: { // If this message is a response to an EXECUTE command
      // Report to callee
      let promise = this.execPromises[msg.cmdid];
      if (!promise)
        return this.logger.log("WARN", "Can't send CMD response to callee: no promise", "Server.handleChilderMessage", msg);
      //
      delete this.execPromises[msg.cmdid];
      if (msg.err)
        promise.reject(msg.stderr || msg.err);
      else
        promise.resolve(msg.stdout);
      break;
    }

    default: {
      // Check if this is an MCP response from the DevAgent (wrapped by childer as {id, cnt})
      if (msg.cnt?.type === "mcp_response") {
        this.mcpServer.handleChildResponse(msg.id, msg.cnt.cnt);
        break;
      }
      //
      // Re-route all other messages to the corresponding session
      if (await Node.Utils.process_on(msg)) {
        let session = this.IDESessions[msg.id];
        if (!session)
          return this.logger.log("WARN", "Can't send message: session not found", "Server.handleChilderMessage", msg);
        //
        session.processMessage(msg.cnt);
      }
      break;
    }
  }
};


/**
 * Executes a file (command) as ROOT - Async version
 * @param {string} cmd - command to be executed
 * @param {array} params - command parameters
 * @param {object} options - Node createChild options
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
Node.Server.prototype.execFileAsRoot = async function (cmd, params, options)
{
  // Handle "SPECIAL" commands
  switch (cmd) {
    case "ChownChmod": {
      let OSUser = params[0];
      let path = params[1];
      //
      try {
        await this.execFileAsRoot((process.platform === "freebsd" ? "/usr/sbin/chown" : "/bin/chown"),
                ["-R", `${OSUser}:${OSUser}`, path]);
      }
      catch (err) {
        this.logger.log("ERROR", `Error while executing CHOWN: ${err}`, "Server.execFileAsRoot", params);
        throw err;
      }
      //
      try {
        await this.execFileAsRoot("/usr/bin/find", [path, "-type", "d", "-exec", "/bin/chmod", "770", "{}", "+"]);
      }
      catch (err) {
        this.logger.log("ERROR", `Error while executing CHMOD for DIR: ${err}`, "Server.execFileAsRoot", params);
        throw err;
      }
      //
      try {
        return await this.execFileAsRoot("/usr/bin/find", [path, "-type", "f", "-exec", "/bin/chmod", "660", "{}", "+"]);
      }
      catch (err) {
        this.logger.log("ERROR", `Error while executing CHMOD for FILES: ${err}`, "Server.execFileAsRoot", params);
        throw err;
      }
    }

    case "ChownDBFolder": {
      let dbpath = params[0];
      //
      try {
        await this.execFileAsRoot((process.platform === "freebsd" ? "/usr/sbin/chown" : "/bin/chown"),
                ["-R", (process.platform === "freebsd" ? "pgsql:pgsql" : "postgres:postgres"), dbpath]);
      }
      catch (err) {
        this.logger.log("ERROR", `Error while executing CHOWN: ${err}`, "Server.execFileAsRoot", params);
        throw err;
      }
      //
      try {
        return await this.execFileAsRoot("/bin/chmod", ["-R", "770", dbpath]);
      }
      catch (err) {
        this.logger.log("ERROR", `Error while executing CHMOD: ${err}`, "Server.execFileAsRoot", params);
        throw err;
      }
    }

    case "UpdNodePackages": {
      let nodeModulesPath = Node.path.resolve(__dirname, "..") + "/";
      let stdout;
      //
      // Clean npm cache first to free disk space
      try {
        await this.execFileAsRoot("/usr/local/bin/npm", ["cache", "clean", "--force"]);
      }
      catch (err) {
        this.logger.log("WARN", `Error while executing NPM CACHE CLEAN: ${err}`, "Server.execFileAsRoot", params);
      }
      //
      try {
        stdout = await this.execFileAsRoot("/usr/local/bin/npm", ["--prefix", nodeModulesPath, "update", "--unsafe-perm=true"]);
      }
      catch (err) {
        this.logger.log("ERROR", `Error while executing NPM UPDATE: ${err}`, "Server.execFileAsRoot", params);
        throw err;
      }
      //
      // Log package update
      if (stdout)
        this.logger.log("INFO", `Package updated: ${stdout}`, "Server.execFileAsRoot");
      //
      // NPM PRUNE does not handle the --previx param... (https://github.com/npm/npm/issues/16337)
      try {
        let stdout = await this.execFileAsRoot("/usr/local/bin/npm", ["prune"], {cwd: nodeModulesPath});
        //
        // Hack: remove ETC folder (left over by previous commands)
        // (https://github.com/npm/npm/issues/11486)
        await Node.fs.promises.rm(nodeModulesPath + "etc", {recursive: true, force: true}).catch(() => {});
        //
        // Log package prune
        if (stdout)
          this.logger.log("INFO", `Package pruned: ${stdout}`, "Server.execFileAsRoot");
        //
        return stdout;
      }
      catch (err) {
        this.logger.log("ERROR", `Error while executing NPM PRUNE: ${err}`, "Server.execFileAsRoot", params);
        throw err;
      }
    }

    default: {
      // Not a special command... Handle it directly
      return await new Promise((resolve, reject) => {
        // Prepare the childer promise (will be resolved and deleted inside the handleChilderMessage method (see above))
        let cmdid = Math.floor(Math.random() * 1000000);
        this.execPromises[cmdid] = {resolve, reject};
        //
        // Ask the childer (that runs as ROOT) to execute the command
        this.childer.send({
          type: Node.Server.msgTypeMap.execCmdRequest,
          cmdid,
          cmd,
          params,
          options
        });
      });
    }
  }
};


/**
 * Listen for incoming connections through web sockets
 */
Node.Server.prototype.socketListener = function ()
{
  // Socket listener
  Node.io.on("connection", socket => {
    socket.on(Node.Server.msgTypeMap.sessionid, m => this.handleSessionSID(socket, m));
    socket.on(Node.Server.msgTypeMap.asid, m => this.handleSessionASID(socket, m));
    socket.on(Node.Server.msgTypeMap.deviceMessage, m => this.handleDeviceMessage(socket, m));
    socket.on(Node.Server.msgTypeMap.sync, m => this.handleSyncMessage(socket, m));
    socket.on(Node.Server.msgTypeMap.cloudConnector, m => this.handleCloudConnectorMessage(socket, m));
    socket.on(Node.Server.msgTypeMap.dtt, m => this.handleDttMessage(socket, m));
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
  let session = this.IDESessions[msg.sid];
  if (!session) {
    // If it's a reconnect... create a new session and tell the client to reload with this data
    if (socket.client.request._query.reconnect) {
      let auth = socket.handshake.auth || {};
      this.logger.log("WARN", "Session not found during reconnect", "Server.handleSessionSID",
              {sid: msg.sid});
      //
      // If a user and project was provided, try to search for them
      let user = this.config.getUser(auth.user);
      let prj = user?.getProject(auth.project);
      if (prj && auth.reconnectToken === prj.reconnectToken) {
        // Found project... by-pass standard checks and let the user come in with a default token
        prj.token = prj.reconnectToken;
        socket.emit(Node.Server.msgTypeMap.redirect, `${user.userName}/${prj.name}/edit?t=${prj.token}`);
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
  let session, appcli;
  //
  let qry = "";
  if (msg.appurl)
    qry = (Node.url.parse(msg.appurl, true).search || "");
  //
  if (msg.acid) {   // IDE case
    session = this.IDESessions[msg.sid];
    if (!session)
      return this.logger.log("WARN", "Session not found", "Server.handleSessionASID", msg);
    //
    // Get the app client for the received acid
    appcli = session.getAppClientById(msg.acid);
    if (!appcli)
      return this.logger.log("WARN", "AppClient not found", "Server.handleSessionASID", msg);
    //
    // Connect this socket with the app client
    appcli.openConnection(socket);
  }
  else {    // MASTER case
    // If the session is not valid, redirect to app entry point (i.e. app main url)
    session = this.appSessions[msg.sid];
    if (!session) {
      this.logger.log("WARN", "Session not found", "Server.handleSessionASID", msg);
      socket.emit(Node.Server.msgTypeMap.redirect, `/${Node.Utils.HTMLencode(msg.appname)}${qry}`);
      return;
    }
    //
    // Get the app client for the received cid
    appcli = session.getAppClientById(msg.cid);
    if (!appcli) {
      this.logger.log("WARN", "AppClient not found", "Server.handleSessionASID", msg);
      socket.emit(Node.Server.msgTypeMap.redirect, `/${Node.Utils.HTMLencode(msg.appname)}${qry}`);
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
      socket.emit(Node.Server.msgTypeMap.redirect, `/${Node.Utils.HTMLencode(msg.appname)}${qry}`);
      return;
    }
    //
    // This session exists and so does the client.
    // If I haven't done it yet create the physical process for the worker
    if (!session.worker.child)
      session.worker.createChild();
    //
    // If the app client is already connected with someone else
    if (appcli.socket) {
      // Check if it's the same session... on a new socket
      if (session.invalidSID(socket, appcli)) {
        this.logger.log("WARN", "AppClient already in use by someone else", "Server.handleSessionASID", msg);
        socket.emit(Node.Server.msgTypeMap.redirect, `/${Node.Utils.HTMLencode(msg.appname)}${qry}`);
        return;
      }
      //
      // I need to distinguish between two cases:
      // 1) change network (between wifi and phone network)
      // 2) tab duplicate
      // In both cases I get a new socket request with the same cookies
      // How can I distinguish between the two cases? I can't...
      // But I can try to ask the "old" socket if it's still alive... if so, refuse the new request...
      // Wait 500 ms the answer from the supposedly-dead socket
      //
      if (appcli.pingTimeout)
        return;
      //
      // Send PING and WAIT for PONG
      let pongFunct = () => {
        // PONG received -> socket is alive... tell the new socket that have to go away
        // Detach the pong listener
        appcli.socket.off("pong", pongFunct);
        //
        // Stop the ping timeout
        clearTimeout(appcli.pingTimeout);
        delete appcli.pingTimeout;
        //
        // Redirect to a new session
        socket.emit(Node.Server.msgTypeMap.redirect, `/${Node.Utils.HTMLencode(msg.appname)}${qry}`);
        this.logger.log("WARN", "AppClient already in use by someone else", "Server.handleSessionASID", msg);
        //
        // Nothing else to do...
      };
      //
      // Waif for PING and send PING
      appcli.socket.on("pong", pongFunct);
      appcli.socket.emit("ping");
      //
      // The PONG reply have to be here within 500 ms... otherwise the socket is dead
      // (normally it takes 20-30 ms)
      appcli.pingTimeout = setTimeout(() => {
        delete appcli.pingTimeout;
        // PONG not received -> socket is dead... replace the socket with the new one
        //
        // Detach the pong listener (if the socket is still connected)
        if (appcli.socket) {
          appcli.socket.off("pong", pongFunct);
          appcli.socket.disconnect();
        }
        //
        // Connect this new socket with the app client
        appcli.openConnection(socket, msg.lastMsg);
        //
        this.logger.log("WARN", "AppClient's socket replaced with a new socket with same ASID (valid SID)", "Server.handleSessionASID", msg);
      }, 500);
      //
      // Do nothing more.
      // Wait for the PONG message to arrive (reject and create a new session)
      // or for the timeout to terminate (accept the connection and replace the old socket)
      return;
    }
    else
      // Connect this socket with the app client
      appcli.openConnection(socket, msg.lastMsg);
  }
};


/**
 * Handle DEVICE message (received by the client)
 * @param {Node.Socket} socket - socket that received the message
 * @param {Object} msg
 */
Node.Server.prototype.handleDeviceMessage = function (socket, msg)
{
  // Read the kind of message sent
  let {type, data} = msg;
  //
  // This sorts of authenticates the device/owner pair
  let user = this.config.getUser(data.userName);
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
  // If sync is not enabled, tell it to callee
  if (msg.cnt.id === "connect" && (!this.config.services || !this.config.services.split(",").includes("sync")))
    msg.cnt.serviceDisabled = true;
  //
  // Search the session I've to route this message to
  let session = this.appSessions[msg.sid.sidsrv];
  if (!session) {
    session = this.IDESessions[msg.sid.sidcli];
    if (session) {
      // If there is at least an online app I use IDe session to open sync connection
      let onlineAppClient;
      for (let i = 0; i < session.appClients.length; i++) {
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
      let user = this.config.getUser(msg.sid.username || "manager");
      if (!user) {
        socket.disconnect();
        return this.logger.log("WARN", "Sync connect not handled: user not found", "Server.handleSyncMessage", msg);
      }
      //
      // Search the app
      let app = user.getApp(msg.sid.appname.toLowerCase());
      if (!app) {
        socket.disconnect();
        return this.logger.log("WARN", "Sync connect not handled: app not found", "Server.handleSyncMessage", msg);
      }
      //
      // If the app has been stopped
      if (app.stopped) {
        socket.disconnect();
        return this.logger.log("WARN", "Sync connect not handled: app stopped", "Server.handleSyncMessage", msg);
      }
      //
      // If the app is updating
      if (app.updating) {
        socket.disconnect();
        return this.logger.log("WARN", "Sync connect not handled: app updating", "Server.handleSyncMessage", msg);
      }
      //
      this.logger.log("DEBUG", "A new sync session begins", "Server.handleSyncMessage", msg);
      //
      // Ask the app to create a new AppSession
      session = app.createNewSession({type: "sync"});
      //
      // If a session can't be created -> do nothing
      if (!session) {
        socket.disconnect();
        return this.logger.log("WARN", "Session can't be created: too many users", "Server.handleSyncMessage", msg);
      }
      //
      // If needed ask the worker to create the physical child process
      if (!session.worker.child)
        session.worker.createChild();
      //
      // Insert the new session id into the message so that the sync object can store it somewhere
      msg.sid.sidsrv = session.id;
      //
      this.logger.log("DEBUG", "Created new sync session", "Server.handleSyncMessage", msg);
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
    //
    // Add useful info (see App.handleSync)
    msg.request = msg.request || {};
    if (socket.handshake?.address)
      msg.request.remoteAddress = socket.handshake.address.replace(/^.*:/, "");
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
  console.error("NOT SUPPORTED FOR SELF");
};


/**
 * Handle DTT message (received by a remote IDE client)
 * @param {Node.Socket} socket - socket that received the message
 * @param {Object} msg
 */
Node.Server.prototype.handleDttMessage = function (socket, msg)
{
  // If it's a live session, ask her to reply (use the appSessions map)
  let session = this.appSessions[msg.sid];
  if (session)
    return session.openDttConnection(socket, msg);
  //
  // Not a live session... check if it's a saved session
  let user = this.config.getUser("manager");
  if (!user) {
    socket.disconnect();
    return this.logger.log("WARN", "DTT message not handled: user not found", "Server.handleDttMessage", msg);
  }
  //
  let app = user.getApp(Node.Utils.clearName(msg.appName));
  if (!app) {
    socket.disconnect();
    return this.logger.log("WARN", "DTT message not handled: app not found", "Server.handleDttMessage", msg);
  }
  //
  // Now search the file
  let fname = Node.path.join(this.config.appDirectory, "apps", app.name, "files", "private", "log", `dtt_${msg.sid}.json`);
  if (Node.fs.existsSync(fname))
    return Node.fs.readFile(fname, {encoding: "utf-8"}, (err, content) => {
      content = `[${content}`;
      content = `${content.substring(0, content.length - 1)}]`;
      socket.emit("dtt", content);
    });
  //
  //
  // Nope... that's bad...
  socket.disconnect();
  this.logger.log("WARN", "DTT message not handled: session not found", "Server.handleDttMessage", msg);
};


/**
 * Create a new session for a project
 * @param {Node.Project} project
 * @param {Object} options
 * @returns {Node.IDESession}
 */
Node.Server.prototype.createSession = function (project, options)
{
  // No options means "default IDE session"
  options = options || {};
  options.type = options.type || "ide";
  //
  // Create a new session and add it to the session map
  let newSession = new Node.IDESession(project, options);
  this.IDESessions[newSession.id] = newSession;
  //
  // Log the operation
  this.logger.log("DEBUG", "Created new session", "Server.createSession",
          {sid: newSession.id, options, project: project.name, user: project.user.userName});
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
  this.childer.send({
    id: session.id,
    type: Node.Server.msgTypeMap.disconnectChild
  });
};


/**
 * Returns an open session for the given project
 * @param {Node.Project} project
 * @param {boolean} filter - search parameters (type:"*|ide", ip:IPADDRESS)
 */
Node.Server.prototype.getOpenSession = function (project, filter)
{
  let keys = Object.keys(this.IDESessions);
  for (let i = 0; i < keys.length; i++) {
    let sess = this.IDESessions[keys[i]];
    //
    // If it's not a session for the given project, skip it
    if (sess.project !== project)
      continue;
    //
    // If there is no filter, the search is over... this session is good enough
    // Project is the same and that is what callee was looking for
    if (!filter)
      return sess;
    //
    let sessMatches = true; // Be positive
    //
    let filterKeys = Object.keys(filter);
    for (let j = 0; j < filterKeys.length && sessMatches; j++) {
      let k = filterKeys[j];
      //
      let val = sess.options[k];
      if (k === "request") {
        // Here I need to check if REQUEST is valid...
        // Checking for IP address
        let sessIP = (sess.masterClientSod && sess.sockets[sess.masterClientSod] &&
                sess.sockets[sess.masterClientSod].conn ? sess.sockets[sess.masterClientSod].conn.remoteAddress : "!");  // Master's IP address
        let filterIP = (filter.request.connection ? filter.request.connection.remoteAddress : "?");
        //
        // https://serverfault.com/questions/840198/ipv6-are-there-actual-differences-between-local-addresses-1-and-ffff127-0
        if (sessIP.startsWith("::ffff:"))
          sessIP = sessIP.substring(7);
        if (filterIP.startsWith("::ffff:"))
          filterIP = filterIP.substring(7);
        //
        // ::1 is the true "local host" or "loopback" address, equivalent to 127.0.0.1 in IPv4.
        if (sessIP === "::1")
          sessIP = "127.0.0.1";
        if (filterIP === "::1")
          filterIP = "127.0.0.1";
        //
        if (sessIP !== filterIP) {
          sessMatches = false;
          //
          // It could be that a connected device is asking for this...
          for (let k = 0; k < sess.project.user.devices.length && !sessMatches; k++) {
            let device = sess.project.user.devices[k];
            if (device.socket) {
              let devIP = (device.socket.conn ? device.socket.conn.remoteAddress : "!");
              if (devIP.startsWith("::ffff:"))
                devIP = devIP.substring(7);
              if (devIP === filterIP)
                sessMatches = true;
            }
          }
          //
          if (!sessMatches)
            this.logger.log("WARN", "Request IP differs from web-socket IP -> request refused", "Server.getOpenSession",
                    {sessIP: sessIP, filterIP: filterIP, project: project.name, user: project.user.userName});
        }
        //
        // Request matched... next filter criteria
        continue;
      }
      //
      if (val !== filter[k])
        sessMatches = false;
    }
    //
    // If matches -> search completed!
    if (sessMatches)
      return sess;
  }
};


/**
 * Given a user name, list al its sessions
 * @param {String} userName
 * @returns {Array} array of Node.IDESession
 */
Node.Server.prototype.getSessionListByUser = function (userName)
{
  let sessionList = [];
  let keys = Object.keys(this.IDESessions);
  for (let i = 0; i < keys.length; i++) {
    let sess = this.IDESessions[keys[i]];
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
  let sessions = [];
  let keys = Object.keys(this.IDESessions);
  for (let i = 0; i < keys.length; i++)
    sessions.push(this.IDESessions[keys[i]]);
  //
  return sessions;
};


/**
 * Start timers that will backup projects periodically
 * @param {Boolean} scheduled - true if this is a "scheduled" call (the one that have to be actually
 * executed each day... see first setTimeout)
 */
Node.Server.prototype.backupProjects = async function (scheduled)
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
  let now = new Date();
  //
  // If not scheduled, schedule it
  if (!scheduled) {
    // Compute HOURS and MINUTES from timeBackup param
    let hours = Math.floor((this.config.timeBackup || 0) / 100);
    let mins = (this.config.timeBackup || 0) % 100;
    //
    // Compute how many ms there are from NOW to the expected backup time
    let backupTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, mins, 0, 0);
    let msTillBackupTime = backupTime - now;
    if (msTillBackupTime < 0)   // backup time is in the past... (less than 24h from now)
      msTillBackupTime += 86400000;
    //
    // Now I've all info that allows me to schedule backups
    setTimeout(() => {
      // First call in this day
      this.backupProjects(true);
      //
      // And schedule backup for following days
      setInterval(() => {
        // Calls for following days
        this.backupProjects(true);
      }, 86400000);
    }, msTillBackupTime);
    //
    // Scheduled
    return;
  }
  //
  // Compute which projects I have to backup
  let prjsToBackup = [];
  for (let i = 0; i < this.config.users.length; i++) {
    let user = this.config.users[i];
    for (let j = 0; j < user.projects.length; j++) {
      let prj = user.projects[j];
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
  while (prjsToBackup.length > 0) {
    // Get the first project that is not online
    let prj;
    let prjIndex;
    for (let i = 0; i < prjsToBackup.length; i++) {
      let p = prjsToBackup[i];
      if (p.isOnline())
        continue;   // Online -> wait...
      //
      // This project is not online... remove it from the list and back it up
      prj = p;
      prjIndex = i;
      break;
    }
    //
    // If all projects are online
    if (!prj) {
      // If 1 hour has passed since I've started -> give up
      if ((new Date() - now) > 3600000) {
        this.logger.log("DEBUG", "There are still projects online but 1 hour has passed since I've started -> give up", "Server.backupProjects",
                {numPrj: prjsToBackup.length});
        break;
      }
      //
      // Less than 1 hour -> wait 1 minute and re-check
      await new Promise(resolve => setTimeout(resolve, 60000));
      continue;
    }
    //
    // Remove the project from the list
    prjsToBackup.splice(prjIndex, 1);
    //
    this.logger.log("DEBUG", "Backup project", "Server.backupProjects", {project: prj.name, user: prj.user.userName});
    //
    // Backup the project (don't backup BUILD and FILE folders)
    try {
      await prj.nightlyBackup();
      //
      // Everything is fine -> remove old projects
      this.cleanBucket(prj);
    }
    catch (err) {
      this.logger.log("ERROR", `Can't backup project: ${err.message || err}`, "Server.backupProjects", {project: prj.name, user: prj.user.userName});
    }
  }
};


/**
 * Removes old projects from the backup bucket
 * @param {Node.Project} prj - project to clean up
 */
Node.Server.prototype.cleanBucket = async function (prj)
{
  let path = `users/${this.config.serverType}/${prj.user.userName}/backups/projects/${prj.name}/`;
  let msLimit = this.config.daysBackups * 24 * 3600 * 1000;   // Number of ms I have to keep the file for
  let now = new Date();
  //
  let archiver = new Node.Archiver(this, true);
  //
  // Get the list of all files in the cloud at the given project's backup path
  let files;
  try {
    files = await archiver.getFiles(path);
  }
  catch (err) {
    this.logger.log("WARN", `Can't enumerate files: ${err}`, "Server.cleanBucket", {project: prj.name, user: prj.user.userName});
    return;
  }
  //
  // If the number of files in the bucket is already at minimum, do nothing
  this.logger.log("DEBUG", `#files in bucket: ${files ? files.length : 0}/${this.config.numMinBackups}`, "Server.cleanBucket",
          {project: prj.name, user: prj.user.userName});
  if (files.length <= this.config.numMinBackups)
    return;
  //
  // Remove older ones
  for (let i = 0; i < files.length; i++) {
    // Compute the file date
    let fn = files[i];
    //
    // File name format: [project]-[date].tar.gz
    // where [date] is in the ISO form without "-:T.Z" (thus YYYYMMDDHHMMSSmmm - see Node.Project.prototype.backup)
    fn = fn.substring(0, fn.length - 7);     // Remove extension (.tar.gz)
    fn = fn.substring(fn.lastIndexOf("-") + 1); // Get the DATE part
    let dateFile = new Date(fn.substring(0, 4) + "-" + fn.substring(4, 6) + "-" + fn.substring(6, 8) + "T" +
            fn.substring(8, 10) + ":" + fn.substring(10, 12) + ":" + fn.substring(12, 14) + "." + fn.substring(15) + "Z");
    let msFileDelta = now - dateFile;
    //
    if (msFileDelta > msLimit) {
      let ftodelete = files[i];
      this.logger.log("DEBUG", `Remove older file ${ftodelete}`, "Server.cleanBucket", {project: prj.name, user: prj.user.userName});
      try {
        await archiver.deleteFile(ftodelete);
      }
      catch (err) {
        this.logger.log("WARN", `Error removing file ${ftodelete} from the project backup bucket: ${err}`, "Server.cleanBucket",
                  {project: prj.name, user: prj.user.userName});
      }
    }
  }
};


/**
 * Start timer that will create a periodic snapshot of the disk
 * @param {Boolean} scheduled - true if this is a "scheduled" call (the one that have to be actually
 * executed each day... see first setTimeout)
 */
Node.Server.prototype.backupDisk = async function (scheduled)
{
  // If I'm LOCAL or on a windows machine, backup is not supported
  if (this.config.local || /^win/.test(process.platform))
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
  else if (!scheduled)
    this.logger.log("INFO", "Automatic disk backup timer started", "Server.backupDisk",
            {numHoursSnapshot: this.config.numHoursSnapshot, numMaxSnapshot: this.config.numMaxSnapshot, timeSnapshot: this.config.timeSnapshot});
  //
  // This algorithm uses the following 3 config parameters:
  //  - "numHoursSnapshot": number of hours between snapshots (24 -> 1 snapshot per day)
  //  - "numMaxSnapshot": indicates the maximum number of files I have to keep
  //  - "timeSnapshot": indicates when I have to take a snapshot ([HOUR]*100 + MINUTES, 100 -> means 1 AM)
  let now = new Date();
  //
  // If not scheduled, schedule it
  if (!scheduled) {
    // Compute HOURS and MINUTES from timeBackup param
    let hours = Math.floor((this.config.timeSnapshot || 0) / 100);
    let mins = (this.config.timeSnapshot || 0) % 100;
    //
    // Compute how many ms there are from NOW to the expected backup time.
    // Starting from the first snapshot time (usually 2AM)
    // - if it's in the past we add hours depending on the numHoursSnapshot config, untile we reach a future date.
    // - if it's in the future and greater than the backup period, we remove the exceding hours.
    let snapshotTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, mins, 0, 0);
    let msTillSnapshotTime = snapshotTime - now;
    while (msTillSnapshotTime <= 0)
      msTillSnapshotTime += this.config.numHoursSnapshot * 60 * 60 * 1000;
    if (msTillSnapshotTime > this.config.numHoursSnapshot * 60 * 60 * 1000)
      msTillSnapshotTime = msTillSnapshotTime % (this.config.numHoursSnapshot * 60 * 60 * 1000);
    // 
    // I schedule the next snapshot to be configuration compliant, but I don't want to run it immediately on (re)boot,
    // for that freezing the disk while the server is starting up is not a good idea.
    // There are quite a few disk operations at startup (e.g., many chown on files) and it's safer to not block them.
    // In this case I add another this.config.numHoursSnapshot * hour to the schedule time, skipping the very first schedule, which is too near in time.
    while (msTillSnapshotTime < 5 * 60 * 1000) {
      this.logger.log("INFO", `Skipping snapshot ${msTillSnapshotTime} ms from now: it's too near.`, "Server.backupDisk");
      msTillSnapshotTime += this.config.numHoursSnapshot * 60 * 60 * 1000;
    }
    //
    // Now I've all info that allows me to schedule backups
    this.backupDiskTimeoutID = setTimeout(() => {
      // First call in this day
      this.backupDisk(true);
      //
      // And schedule future snapshots
      this.backupDiskIntervalID = setInterval(() => {
        // Calls for following days
        this.backupDisk(true);
      }, this.config.numHoursSnapshot * 3600 * 1000);
    }, msTillSnapshotTime);
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
    let options = {
      protocol: "http:",
      hostname: "metadata.google.internal",
      headers: {"Metadata-Flavor": "Google"}
    };
    //
    // Read Zone
    options.path = "/computeMetadata/v1/instance/zone";
    let err;
    let {code, data: zone} = await this.request.getRequest(options).catch(e => err = e) ?? {};
    if (code !== 200 || err)
      return this.logger.log("WARN", `Can't read metadata::zone: ${err || `ResponseCode: ${code}`}`,
              "Server.backupDisk", options);
    //
    // Format:
    //    projects/839082392750/zones/europe-west1-c
    this.backupInfo.cloudZone = zone.substring(zone.lastIndexOf("/") + 1);
    //
    // Read diskName
    {
      options.path = "/computeMetadata/v1/instance/disks/1/device-name";
      let {code, data: devName} = await this.request.getRequest(options).catch(e => err = e) ?? {};
      if (code !== 200 || err)
        return this.logger.log("WARN", `Can't read metadata::device-name: ${err || `ResponseCode: ${code}`}`,
                "Server.backupDisk", options);
      //
      this.backupInfo.diskName = devName;
    }
  }
  //
  // Helper function to unfreeze the disk
  let unfreezeDisk = async () => {
    // I unfreeze the disk only once.
    if (!this.backupInfo.snapshotName) {
      this.logger.log("WARN", "Can't unfreeze the disk, disk not freezed", "Server.backupDisk");
      return;
    }
    delete this.backupInfo.snapshotName;
    //
    try {
      await this.config.handleSnapshot({req: {}, tokens: ["", "end"]});
    }
    catch (err) {
      this.logger.log("WARN", `Can't unfreeze the disk: ${err}`, "Server.backupDisk");
    }
  };
  //
  // Helper function to check backup status periodically
  let checkBackup = (gce, checkBackupInterval) => {
    if (!this.backupInfo.snapshotName)
      return;
    //
    clearInterval(checkBackupInterval);
    //
    gce.getSnapshots({"filter": `name eq ${this.backupInfo.snapshotName}`}, (err, checkedSnapshots) => {
      // Stop checking the backup when I found that it's uploading, ready or failed (statuses after che completion of the backup itself).
      if (checkedSnapshots.length > 0) {
        let checkedSnapshot = checkedSnapshots[0];
        if (["UPLOADING", "READY", "FAILED"].includes(checkedSnapshot.metadata?.status))
          return unfreezeDisk();
      }
      //
      // Backup's not ready, repeat.
      checkBackupInterval = setInterval(() => checkBackup(gce, checkBackupInterval), 1000);
    });
  };
  //
  // Start disk backup
  this.logger.log("INFO", "Start disk backup", "Server.backupDisk", this.backupInfo);
  //
  try {
    await this.config.handleSnapshot({req: {}, unlockTimeout: 240000, tokens: ["", "start"]});
  }
  catch (err) {
    return this.logger.log("WARN", `Can't freeze the disk: ${err}`, "Server.backupDisk");
  }
  //
  let gce = new Node.googleCloudCompute(JSON.parse(JSON.stringify(this.config.configGCloudStorage)));
  let sdate = new Date().toISOString().replace(/-/g, "").replace(/:/g, "").replace("T", "").replace(".", "").replace("Z", "");
  let desc = `Snapshot created at ${new Date()} for server ${this.config.name}`;
  //
  this.backupInfo.snapshotName = `${this.backupInfo.diskName}-${sdate.substring(0, sdate.length - 3)}`; // Remove ms from time
  let snapshot = gce.zone(this.backupInfo.cloudZone).disk(this.backupInfo.diskName).snapshot(this.backupInfo.snapshotName);
  let checkBackupInterval;
  try {
    let operation;
    try {
      operation = await new Promise((resolve, reject) => {
        snapshot.create({"description": desc}, (err, _snapshot, operation) => err ? reject(err) : resolve(operation));
      });
    }
    catch (err) {
      this.logger.log("WARN", `Can't create the snapshot (1): ${err}`, "Server.backupDisk");
      throw err;
    }
    //
    // Check for an unfreezable backup status, the completion may need up to 60s (and more), so we want to unfreeze the disk
    // when the data are safe and we don't wait for the completion of whole operation, which includes the upload and the double check
    // of the snapshot.
    checkBackupInterval = setInterval(() => checkBackup(gce, checkBackupInterval), 1000);
    //
    // Wait for the operation's completion. This may neeed up to 60s (and more).
    // When it'is completed we handle the exceeding backups.
    try {
      await new Promise((resolve, reject) => {
        operation.on("error", reject);
        operation.on("complete", resolve);
      });
      this.logger.log("INFO", "Disk backup completed", "Server.backupDisk", this.backupInfo);
    }
    catch (err) {
      this.logger.log("WARN", `Can't create the snapshot (2): ${err}`, "Server.backupDisk");
      throw err;
    }
  }
  finally {
    await unfreezeDisk();
  }
  //
  // Snapshot created, now clean up (if needed)
  // List all snapshots for this disk
  let snapshots;
  try {
    snapshots = await new Promise((resolve, reject) => {
      gce.getSnapshots({"filter": `name eq ${this.backupInfo.diskName}-.*`}, (err, snapshots) => err ? reject(err) : resolve(snapshots));
    });
  }
  catch (err) {
    return this.logger.log("WARN", `Can't list all snapshots for this server: ${err}`, "Server.backupDisk");
  }
  //
  this.logger.log("DEBUG", `#snapshot: ${snapshots.length}/${this.config.numMaxSnapshot}`, "Server.backupDisk");
  if (snapshots.length > this.config.numMaxSnapshot) {
    // Remove older ones. First I need to sort them by date
    snapshots.sort((f1, f2) => {
      let dt1 = f1.name.substring(f1.name.lastIndexOf("-") + 1);
      let dt2 = f2.name.substring(f2.name.lastIndexOf("-") + 1);
      dt1 = new Date(dt1.substring(0, 4) + "-" + dt1.substring(4, 6) + "-" + dt1.substring(6, 8) + "T" +
              dt1.substring(8, 10) + ":" + dt1.substring(10, 12) + ":" + dt1.substring(12, 14));
      dt2 = new Date(dt2.substring(0, 4) + "-" + dt2.substring(4, 6) + "-" + dt2.substring(6, 8) + "T" +
              dt2.substring(8, 10) + ":" + dt2.substring(10, 12) + ":" + dt2.substring(12, 14));
      return (dt1 > dt2 ? -1 : (dt1 < dt2 ? 1 : 0));                  // Sort reversed (older is the last one)
    });
    //
    // Now I can remove older one
    for (let i = this.config.numMaxSnapshot; i < snapshots.length; i++) {
      let sname = snapshots[i].name;
      this.logger.log("DEBUG", `Delete old snapshot ${sname}`, "Server.backupDisk");
      //
      let snapshot = gce.snapshot(sname);
      snapshot.delete((err, operation) => {
        if (err)
          return this.logger.log("WARN", `Can't delete snapshot ${sname}: ${err}`, "Server.backupDisk", this.backupInfo);
        //
        operation.on("error", err => {
          this.logger.log("WARN", `Can't delete snapshot ${sname}: ${err}`, "Server.backupDisk", this.backupInfo);
        });
      });
    }
  }
};


/**
 * Rotate logs (console.log and console.error)
 */
Node.Server.prototype.startLogRotate = function ()
{
  // If I'm LOCAL or on a windows machine, log rotate is not supported
  if (this.config.local || /^win/.test(process.platform))
    return;
  //
  // Start log-rotate timer
  setInterval(async () => {
    this.config.handleLog({req: {query: {console: "out"}}, tokens: ["manager", "checkrotate"]}).catch(() => {});
    this.config.handleLog({req: {query: {console: "error"}}, tokens: ["manager", "checkrotate"]}).catch(() => {});
  }, 30 * 1000);    // Every 30 seconds
};


/**
 * Generates a new serviceWorker.json file
 */
Node.Server.prototype.createServiceWorker = function ()
{
  let idePath = Node.path.resolve(__dirname, "..", "ide");
  //
  // The servers my-cloud don't have the ide folder
  if (!Node.fs.existsSync(idePath))
    return;
  //
  let filesMap = {};
  let parseHead = (path, filename) => {
    let fullPath = Node.path.join(idePath, path ? path : "");
    let index = Node.fs.readFileSync(Node.path.join(fullPath, filename), "utf8");
    let cssList = index.split("<link href=\"");
    let jsList = index.split("<script src=\"");
    //
    for (let i = 0; i < 2; i++) {
      let list = (i === 0 ? cssList : jsList);
      for (let j = 1; j < list.length; j++) {
        let file = list[j].substring(0, list[j].indexOf("\"", 1));
        filesMap[fullPath + "/" + file] = (path ? path + "/" : "") + file;
      }
    }
  }
  //
  // First, compute the list of needed files reading the index.html files
  parseHead("", "index2.html");
  parseHead("app/client", "index.html");
  //
  let filesArray = [];
  Object.keys(filesMap).map(filePath => {
    if (Node.fs.existsSync(filePath))
      filesArray.push({url: filesMap[filePath], lastModified: Node.fs.statSync(filePath).mtime.toUTCString()});
  });
  //
  let sw = JSON.stringify(filesArray, null, 2);
  Node.fs.writeFileSync(Node.path.join(idePath, "serviceWorker.json"), sw, "utf8");
  return sw;
};


/**
 * Send the serviceWorker.js to client (IDE & APP)
 * @param {Request} req
 * @param {Response} res
 */
Node.Server.prototype.sendServiceWorker = function (req, res)
{
  try {
    let basePath;
    let isAppIDE = (req.params.app === "app");
    let isAppMaster = (req.params.app && !isAppIDE);
    let isIDE = (!isAppIDE && !isAppMaster);
    //
    if (isIDE || isAppIDE)
      basePath = Node.path.resolve(Node.path.join(__dirname, "..", "ide"));
    else if (isAppMaster)
      basePath = Node.path.join(this.config.appDirectory, "apps", req.params.app, "client");
    //
    let swConf;
    let configPath = Node.path.join(basePath, `${req.url.split("/").pop()}on`);
    if (Node.fs.existsSync(configPath))
      swConf = Node.fs.readFileSync(configPath, "utf8");
    //
    // If the config does not exists create a new one
    if (!swConf && (isIDE || isAppIDE)) {
      // Do it only for IDE... The Master app config is created at build time
      // and it have to be there
      swConf = this.createServiceWorker();
    }
    //
    // If I have a config, send it
    if (swConf) {
      let sw = `const precachingItems = ${swConf};\n`;
      sw += `const cacheName = "${isAppMaster ? req.params.app : "ide"}";\n\n`;
      sw += Node.fs.readFileSync(Node.path.join(basePath, "serviceWorker.js"), "utf8");
      //
      res.header("Content-Type", "text/javascript");
      res.header("Content-Length", Buffer.from(sw).length);
      res.status(200).send(sw);
    }
    else // No serviceWorker -> 404
      res.status(404).end();
  }
  catch (ex) {
    this.logger.log("ERROR", `Error while sending ${req.url.split("/").pop()}: ${ex.message}`, "Server.sendServiceWorker");
    res.status(500).end();
  }
};


/**
 * Send the app.webmanifest to client (IDE & APP)
 * @param {Request} req
 * @param {Response} res
 */
Node.Server.prototype.sendAppManifest = function (req, res)
{
  try {
    let basePath;
    let isAppIDE = (req.params.app === "app");
    //
    if (isAppIDE)
      basePath = Node.path.resolve(__dirname, "..", "ide");
    else
      basePath = Node.path.join(this.config.appDirectory, "apps", req.params.app, "client");
    //
    let manifest;
    let manifestPath = Node.path.join(basePath, req.url.split("/").pop());
    if (Node.fs.existsSync(manifestPath)) {
      manifest = Node.fs.readFileSync(manifestPath, "utf8");
      res.header("Last-Modified", Node.fs.statSync(manifestPath).mtime.toUTCString());
    }
    else
      manifest = JSON.stringify({name: ""});
    //
    res.header("Content-Type", "application/json");
    res.header("Content-Length", Buffer.from(manifest).length);
    res.status(200).send(manifest);
  }
  catch (ex) {
    this.logger.log("ERROR", `Error while sending ${req.url.split("/").pop()}: ${ex.message}`, "Server.sendAppManifest");
    res.status(500).end();
  }
};


/**
 * Start default server session of all apps
 */
Node.Server.prototype.startServerSessions = function ()
{
  for (let i = 0; i < this.config.users.length; i++)
    this.config.users[i].startServerSessions();
};


/**
 * Set owner to INDERT on every directory
 */
Node.Server.prototype.setOwnerToIndert = async function ()
{
  // On Docker I want everything to run as "INDERT" as it was on freebsd
  // The problem is that on older docker's versions the setUID and setGID functions crashed... so everything was running as ROOT
  // Now they've fixed it... but several files are now owned by ROOT... I want everything to be owned by IndeRT
  if (process.platform === "linux" && !this.config.local) {
    // Only if it's a "standard" install (not for MyCloud)
    if (!Node.fs.existsSync("/mnt/disk"))
      return;
    //
    let params = ["-R", "indert:indert",
      "/mnt/disk/IndeRT/ide",
      "/mnt/disk/IndeRT/server",
      "/mnt/disk/IndeRT/log",
      "/mnt/disk/IndeRT/node_modules",
      Node.path.join(this.config.appDirectory, "apps"),
      Node.path.join(this.config.appDirectory, "backups")];
    try {
      await this.execFileAsRoot("/bin/chown", params);
      //
      this.logger.log("DEBUG", "File's ownership fixed", "Server.setOwnerToIndert");
    }
    catch (err) {
      this.logger.log("ERROR", `Error while fixing files ownership: ${err}`, "Server.setOwnerToIndert");
    }
  }
};


/**
 * Load custom certificate's files if needed - Async version
 * @param {Object} cert
 */
Node.Server.prototype.loadCustomCert = async function (cert)
{
  let catCmd = (/^win/.test(process.platform) ? "more" : "/bin/cat");
  //
  if (cert.SSLKey && cert.SSLKey_data === undefined) {
    // Load missing file
    try {
      let stdout = await this.execFileAsRoot(catCmd, [cert.SSLKey]);
      if (cert.SSLKey_data === undefined)  // If still empty (no one else read it while I was reading...)
        cert.SSLKey_data = stdout || "";   // Got it!
    }
    catch (err) {
      this.logger.log("ERROR", `Error while reading SSLKey ${cert.SSLKey}: ${err}`, "Server.loadCustomCert");
      throw err;
    }
    //
    return await this.loadCustomCert(cert); // Re-check
  }
  //
  if (cert.SSLCert && cert.SSLCert_data === undefined) {
    // Load missing file
    try {
      let stdout = await this.execFileAsRoot(catCmd, [cert.SSLCert]);
      if (cert.SSLCert_data === undefined)  // If still empty (no one else read it while I was reading...)
        cert.SSLCert_data = stdout || "";   // Got it!
    }
    catch (err) {
      this.logger.log("ERROR", `Error while reading SSLCert ${cert.SSLCert}: ${err}`, "Server.loadCustomCert");
      throw err;
    }
    //
    return await this.loadCustomCert(cert); // Re-check
  }
  //
  if (cert.SSLCABundles) {
    cert.SSLCABundles_data = cert.SSLCABundles_data || [];
    for (let j = 0; j < cert.SSLCABundles.length; j++)
      if (cert.SSLCABundles[j] && cert.SSLCABundles_data[j] === undefined) {
        // Load missing file
        try {
          let stdout = await this.execFileAsRoot(catCmd, [cert.SSLCABundles[j]]);
          if (cert.SSLCABundles_data[j] === undefined)  // If still empty (no one else read it while I was reading...)
            cert.SSLCABundles_data[j] = stdout || "";   // Got it!
        }
        catch (err) {
          this.logger.log("ERROR", `Error while reading SSLCABundles(${j}) ${cert.SSLCABundles[j]}: ${err}`, "Server.loadCustomCert");
          throw err;
        }
        //
        return await this.loadCustomCert(cert); // Re-check
      }
  }
  //
  // I have all needed files!
};


/**
 * Send the desktop HTML to the IDE session
 * @param {Request} req
 * @param {Response} res
 */
Node.Server.prototype.sendDesktop = async function (req, res)
{
  try {
    // Get user object
    let user = this.config.getUser(req.query.username);
    if (!user) {
      res.status(404).send(`User not found: ${req.query.username}`);
      return;
    }
    //
    // Get project from user
    let prjId = req.query.prjid;
    let prj = user.getProject(prjId);
    //
    // Se il progetto non è stato trovato e c'è solo un progetto aperto,
    // usa quello
    if (!prj) {
      res.status(404).send(`Project not found: ${prjId}`);
      return;
    }
    //
    // Let's see if there is any IDE session for this user or project
    let ideSess;
    let list = Object.values(this.IDESessions);
    for (let s of list) {
      if (s.project.user === user && (!prj || s.project === prj)) {
        ideSess = s;
        break;
      }
    }
    //
    if (!ideSess)
      return res.status(404).send(`Project not open: ${prjId}`);
    //
    res.cookie("ideSessionId", ideSess.id, {
      httpOnly: true,
      sameSite: "strict",
      maxAge: 3600000 // 1 hour
    });
    //
    let data = await ideSess.sendApiCommand({
      command: "idf-desktop",
      objid: req.query.objid
    });
    //
    res.header("Content-Type", "text/html");
    res.header("Cache-Control", "no-cache");
    res.header("Pragma", "no-cache");
    res.header("Expires", "-1");
    //
    res.status(200).send(data);
  }
  catch (ex) {
    this.logger.log("ERROR", `Error while sending sendDesktop: ${ex.message}`, "Server.sendDesktop");
    res.status(500).end();
  }
};

/**
 * Handle custom file requests from the IDE
 * @param {Request} req
 * @param {Response} res
 * @param {Function} next
 */
Node.Server.prototype.handleCustomFile = async function (req, res, next)
{
  let file = req.url.split("/").slice(3).join("/");
  //
  let ok = false;
  let sessionId = req.cookies?.ideSessionId;
  if (sessionId) {
    let ideSess;
    let list = Object.values(this.IDESessions);
    for (let s of list) {
      if (s.id === sessionId) {
        ideSess = s;
        break;
      }
    }
    if (ideSess) {
      ok = true;
      //
      // Rimuovo l'eventuale query string dall'url relativo
      file = file.split("?")[0];
      //
      try {
        let result = await ideSess.sendApiCommand({
          command: "idf-customfile",
          file
        });
        //
        if (!result)
          return next();
        //
        res.header("Content-Type", Node.mime.lookup(file));
        res.header("Cache-Control", "no-cache");
        res.header("Pragma", "no-cache");
        res.header("Expires", "-1");
        //
        let data = result.content;
        if (result.path)
          data = await Node.fs.promises.readFile(result.path);
        //
        res.status(200).send(data);
      }
      catch (err) {
        return res.status(500).send(err.message || err);
      }
    }
  }
  //
  if (!ok) {
    this.logger.log("ERROR", `No IDE session is requesting for custom files`, "Server.handleCustomFile");
    res.status(500).send("No IDE session is requesting for custom files");
  }
};


/**
 * Send the first page to IDF.JS
 * @param {Request} req
 * @param {Response} res
 */
Node.Server.prototype.sendFirstPage = function (req, res)
{
  this.config.sendFirstPage(req, res);
};


/**
 * Register IDF routes
 */
Node.Server.prototype.registerIDFRoutes = function ()
{
  Node.app.get("/idf/:theme/desktop.htm", Node.Server.prototype.sendDesktop.bind(this));
  Node.app.get("/idf/:theme/desktopFluid.htm", Node.Server.prototype.sendDesktop.bind(this));
  //
  let clientPath = Node.path.resolve(__dirname, "..", "ide", "app", "client");
  Node.app.use(`/idf/fonts`, Node.express.static(Node.path.join(clientPath, "objects", "ionic", "fonts")));
  Node.app.use(`/idf/:theme/fonts`, Node.express.static(Node.path.join(clientPath, "objects", "fluid", "themes", "fonts")));
  //
  Node.app.get("/idfjs", Node.Server.prototype.sendFirstPage.bind(this));
  Node.app.get("/idf/wizards/welcome/welcome.htm", Node.Server.prototype.sendFirstPage.bind(this));
  Node.app.use("/idf/editor", Node.express.static(Node.path.resolve(__dirname, "..", "ide", "app", "idf", "editor")));
  Node.app.use("/idf/wizards", Node.express.static(Node.path.resolve(__dirname, "..", "ide", "app", "idf", "Wizards")));
  //
  // Access template files in a static way. Browser IDE needs this to retrieve data from template files
  Node.app.use("/idf/template", Node.express.static(Node.path.resolve(__dirname, "..", "ide", "app", "idf", "Template")));
  //
  // When browser ask for viewedit.js, serve ../ide/app/client/viewedit.js
  Node.app.use("/idf/editor/viewedit.js", Node.express.static(Node.path.join(clientPath, "viewedit.js")));
  //
  // I want to access the RD3 client folders without referencing template within the URL (same thing as runtime)
  try {
    Node.app.get("/idf/:theme/*any", Node.Server.prototype.handleCustomFile.bind(this));
    //
    let templatePath = Node.path.resolve(__dirname, "..", "ide", "app", "idf", "Template");
    let themePath = Node.path.join(templatePath, "Theme");
    //
    // Register routes for a theme directory
    let registerTheme = (file, fullPath) => {
      if (file === "bootstrap" || file === "bootstrapzen") {
        Node.app.use(`/idf/${file}/RD3`, Node.express.static(Node.path.join(templatePath, "Theme", "bootstrap", "RD3")));
        Node.app.use(`/idf/${file}/res`, Node.express.static(Node.path.join(templatePath, "Theme", "bootstrap", "res")));
      }
      else if (file === "ionic")
        Node.app.use(`/idf/${file}/RD3`, Node.express.static(Node.path.join(templatePath, "Theme", "ionic", "RD3")));
      else
        Node.app.use(`/idf/${file}/RD3`, Node.express.static(Node.path.join(templatePath, "RD3")));
      Node.app.use(`/idf/${file}/Fluid`, Node.express.static(clientPath));
      Node.app.use(`/idf/${file}`, Node.express.static(fullPath));
      Node.app.use(`/idf/${file}`, Node.express.static(Node.path.join(templatePath, "Common")));
    };
    //
    // Register built-in themes
    let files = Node.fs.readdirSync(themePath);
    files.forEach(file => {
      let fullPath = Node.path.join(themePath, file);
      if (Node.fs.statSync(fullPath).isDirectory())
        registerTheme(file, fullPath);
    });
    //
    // Register custom themes from the working directory
    let customThemePath = Node.path.join(this.config.directory, "themes");
    if (Node.fs.existsSync(customThemePath)) {
      let customFiles = Node.fs.readdirSync(customThemePath);
      customFiles.forEach(file => {
        let fullPath = Node.path.join(customThemePath, file);
        if (Node.fs.statSync(fullPath).isDirectory())
          registerTheme(file, fullPath);
      });
    }
  }
  catch (ex) {
    this.logger.log("ERROR", `Error while reading IDF template directory: ${ex.message}`, "Server.registerIDFRoutes");
  }
};


// Starts the server
Node.createServer();
