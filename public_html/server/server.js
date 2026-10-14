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
Node.BodyParser = require("body-parser");
Node.BodyParserXML = require("body-parser-xml")(Node.BodyParser);
Node.errorHandler = require("errorhandler");
Node.constants = require("crypto").constants;
Node.googleCloudCompute = require("@google-cloud/compute");
Node.mime = require("mime-types");


/**
 * @class Node.Server
 * @classdesc
 * Main server class for Instant Developer Cloud that manages the entire server infrastructure,
 * including IDE sessions, application sessions, child processes, socket connections, and system backups.
 *
 * Key features:
 * - **Session Management**: Manages both IDE and application sessions
 * - **Child Process Control**: Spawns and controls child processes through childer
 * - **WebSocket Handling**: Manages real-time connections with clients
 * - **Backup Services**: Handles automatic project and disk backups
 * - **SSL/TLS Support**: Manages HTTPS certificates including custom domains
 * - **Service Workers**: Provides PWA support for offline capabilities
 * - **MCP Server**: Integrates DevAgent remote control functionality
 *
 * @property {Object} IDESessions - Map of active IDE sessions indexed by session ID
 * @property {Object} appSessions - Map of active application sessions indexed by session ID
 * @property {Object} execPromises - Map of promises for system command execution
 * @property {Date} startTime - Server start timestamp
 * @property {Node.McpServer} mcpServer - MCP server instance for DevAgent remote control
 * @property {Node.Config} config - Server configuration instance
 * @property {Node.Logger} logger - Logger instance for server events
 * @property {Node.Request} request - Request handler for inter-server communication
 * @property {ChildProcess} childer - Child process manager for spawning IDE processes
 * @property {Object} backupInfo - Disk backup information and state
 */
Node.Server = class Server
{
  /**
   * Message type mapping for internal communication
   * @enum {String}
   */
  static msgTypeMap = {
    /** Process ID message */
    pid: "pid",
    /** Log message from child processes */
    log: "log",
    /** Session ID for IDE connections */
    sessionid: "sid",
    /** Disconnect child process command */
    disconnectChild: "dc",
    /** Forcibly kill a child process (and its descendants) that did not terminate */
    killChild: "kc",
    /** Application session ID */
    asid: "asid",
    /** Device communication message */
    deviceMessage: "deviceMessage",
    /** Synchronization message */
    sync: "sync",
    /** Cloud connector service message */
    cloudConnector: "cloudConnector",
    /** Redirect client to new location */
    redirect: "redirect",
    /** Session error notification */
    sessionError: "seser",
    /** Execute command request to childer */
    execCmdRequest: "exreq",
    /** Execute command response from childer */
    execCmdResponse: "exres",
    /** Execute a system command on the childer (e.g. reboot) */
    execCmd: "excmd",
    /** Notification message broadcast to IDE sessions */
    notify: "n",
    /** Design Time Testing message */
    dtt: "dtt",
  };


  /**
   * Creates and initializes a new server instance.
   * This is the main entry point for starting the Instant Developer server.
   */
  static async create()
  {
    Node.Utils.fixMimeTypes();
    Node.theServer = new Node.Server();
    await Node.theServer.init();
    await Node.theServer.start();
  }


  /**
   * Generates a new serviceWorker.json file with cached resources.
   * Parses HTML files to extract CSS and JS dependencies for offline support.
   * @returns {String} JSON string of files to cache
   */
  static async createServiceWorker(idePath)
  {
    // Defaults to the flat ide folder; multi-version callers pass a specific ides/ide_<version>/ide
    idePath = idePath || Node.Utils.resolveIdeDir();
    //
    // The servers my-cloud don't have the ide folder
    if (!Node.fs.existsSync(idePath))
      return;
    //
    let filesMap = {};
    // Match href/src attribute regardless of position among other attributes
    // and accept both " and ' as quote chars. External URLs (//, http(s)://) are skipped.
    let linkHrefRe = /<link\b[^>]*?\shref\s*=\s*["']([^"']+)["']/gi;
    let scriptSrcRe = /<script\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi;
    let parseHead = async (path, filename) => {
      let fullPath = Node.path.join(idePath, path ? path : "");
      let index = await Node.fs.promises.readFile(Node.path.join(fullPath, filename), "utf8");
      //
      for (let re of [linkHrefRe, scriptSrcRe]) {
        for (let m of index.matchAll(re)) {
          let file = m[1];
          // Skip absolute / protocol-relative URLs (e.g. fonts.googleapis.com)
          if (file.startsWith("//") || /^https?:\/\//i.test(file))
            continue;
          filesMap[`${fullPath}/${file}`] = (path ? `${path}/` : "") + file;
        }
      }
    }
    //
    // First, compute the list of needed files reading the index.html files
    await parseHead("", "index2.html");
    await parseHead("app/client", "index.html");
    //
    let filesArray = [];
    await Promise.all(Object.keys(filesMap).map(async filePath => {
      if (Node.fs.existsSync(filePath)) {
        let stats = await Node.fs.promises.stat(filePath);
        filesArray.push({url: filesMap[filePath], lastModified: stats.mtime.toUTCString()});
      }
    }));
    //
    let sw = JSON.stringify(filesArray, null, 2);
    await Node.fs.promises.writeFile(Node.path.join(idePath, "serviceWorker.json"), sw, "utf8");
    return sw;
  }


  constructor()
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
  }


  /**
   * Initializes the server configuration and sets up HTTP/HTTPS listeners.
   * Loads configuration, creates SSL contexts, sets up Express middleware,
   * and configures Socket.IO for real-time communication.
   */
  async init()
  {
    // Load the configuration from the json file
    this.config = new Node.Config(this);
    this.config.local = Node.fs.existsSync(Node.path.join(__dirname, "config.json")); // local if config.json is "close" to this file (server.js)
    await this.config.loadConfig();
    console.log(`Current server mode: ${this.config.local ? "LOCAL" : "PROD"}`);
    //
    // If local mode or HTTP protocol
    let server;
    if (this.config.local || this.config.protocol === "http") {
      // Create an http Server
      Node.httpServer = Node.http.createServer(Node.app);
      //
      server = Node.httpServer;
    }
    else {  // Use HTTPS server
      // Loads the ssl certificates
      let ca = [];
      if (this.config.SSLCABundles) {
        ca = await Promise.all(this.config.SSLCABundles.map(bundle =>
          Node.fs.promises.readFile(bundle, "utf8")
        ));
      }
      //
      let ssl = {
        key: await Node.fs.promises.readFile(this.config.SSLKey, "utf8"),
        cert: await Node.fs.promises.readFile(this.config.SSLCert, "utf8"),
        ca,
        minVersion: "TLSv1.2"
      };
      //
      // Handle custom certificates
      //   http://stackoverflow.com/questions/12219639/is-it-possible-to-dynamically-return-an-ssl-certificate-in-nodejs#answer-20285934
      //   https://www.digicert.com/ssl-support/apache-secure-multiple-sites-sni.htm
      //
      // Precompute the main SecureContext once: the ssl object is fixed after init,
      // so there's no need to rebuild it on every HTTPS connection.
      let mainContext = Node.tls.createSecureContext(ssl).context;
      ssl.SNICallback = (domain, cb) => {
        // If it's the "main" domain, use the ssl object to reply.
        // Two main-domain shapes are accepted:
        //   - InDeCloud: "${name}.${domain}" (e.g. "vapps.instantdevelopercloud.com")
        //   - MyCloud/Self-Managed: "${domain}" (no "name." prefix, e.g. "cliente.it")
        // If there are no custom certificates use the "main" domain as well.
        if (domain === `${this.config.name}.${this.config.domain}` || domain === this.config.domain || !this.config.customSSLCerts)
          return cb(null, mainContext);
        //
        // If the domain is a sub-domain of "instantdevelopercloud.com" use the "standard" certificate
        if (domain.endsWith(".instantdevelopercloud.com"))
          return cb(null, mainContext);
        //
        // I need to search the right certificate
        let certToUse = this.config.customSSLCerts.find(cert =>
          // If the certificate is a multi-domain certificate check only sub-domain part otherwise check full domain
          (cert.SSLDomain.startsWith("*") && cert.SSLDomain.split(".").slice(1).join(".") === domain.split(".").slice(1).join(".")) ||
          (!cert.SSLDomain.startsWith("*") && cert.SSLDomain === domain)
        );
        //
        // If not found
        if (!certToUse) {
          this.logger.log("WARN", `No valid certificate for domain ${domain}`, "Server.init");
          return cb(null, mainContext);
        }
        //
        // Reuse the previously built SecureContext for this custom certificate, if any:
        // the context is attached to the cert object itself, so it's automatically dropped
        // when the cert is revoked (splice from customSSLCerts).
        if (certToUse._secureContext)
          return cb(null, certToUse._secureContext);
        //
        // If I haven't read file data yet, do it now
        this.loadCustomCert(certToUse).then(() => {
          // I have all needed files.
          let cred = {
            key: certToUse.SSLKey_data,
            cert: certToUse.SSLCert_data,
            secureProtocol: ssl.secureProtocol,
            secureOptions: ssl.secureOptions,
            ca: []
          };
          if (certToUse.SSLCABundles_data)
            cred.ca = [...certToUse.SSLCABundles_data];
          //
          // Reply with TLS secure context
          try {
            certToUse._secureContext = Node.tls.createSecureContext(cred).context;
            cb(null, certToUse._secureContext);
          }
          catch (ex) {
            this.logger.log("ERROR", `Can't create secure context with given certificate for domain ${domain}: ${ex}`, "Server.init");
            return cb(`Can't create secure context with given certificate for domain ${domain}: ${ex}`);
          }
        }, err => {
          this.logger.log("ERROR", "Error while reading custom certificate's file", "Server.init");
          cb(null, mainContext);
        });
      };
      //
      // Create an https Server
      Node.httpsServer = Node.https.createServer(ssl, Node.app);
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
        // If config.corsOrigins is a non-empty array, reflect the request Origin only if allowed.
        // Otherwise fall back to "*" (legacy default).
        let allowed = this.config.corsOrigins;
        if (Array.isArray(allowed) && allowed.length) {
          // Always emit Vary: Origin when the response value depends on Origin,
          // even when the request Origin is rejected, so caches/proxies don't
          // serve a no-ACAO response to a permitted origin (or vice versa).
          res.header("Vary", "Origin");
          let origin = req.get("Origin");
          if (origin && allowed.includes(origin))
            res.header("Access-Control-Allow-Origin", origin);
        }
        else
          res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
      }
      next();
    });
    //
    // Set socket io on top of server. CORS origin is resolved per-handshake by
    // reading this.config.corsOrigins each time, so admin updates via configureServer
    // propagate without requiring a server restart.
    let resolveSocketCors = (requestOrigin, cb) => {
      let allowed = this.config.corsOrigins;
      if (Array.isArray(allowed) && allowed.length)
        cb(null, allowed.includes(requestOrigin));
      else
        cb(null, true); // legacy default: allow all
    };
    Node.io = require("socket.io")(server, {allowEIO3: true, maxHttpBufferSize: 1e8, cors: {origin: resolveSocketCors}, perMessageDeflate: {threshold: 50 * 1024}});
  }


  /**
   * Starts the server and initializes all core services.
   * Creates child process manager, sets up logging, starts backups,
   * configures Express middleware, and begins listening for connections.
   */
  async start()
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
    // First-boot migration to the multi-version layout (no-op on already-migrated or single-version
    // servers). Runs after the childer (npm/rm go through it as root) and before serving; on failure
    // the server keeps running single-version and retries on the next boot.
    try {
      await this.config.migrateToMultiVersion();
    }
    catch (err) {
      this.logger.log("WARN", `Multi-version migration failed, running single-version (will retry on next boot): ${err.message || err}`, "Server.start");
    }
    //
    // Reconcile the ides folders with the registry (issue #16466): backfill the install markers,
    // rebuild the entry of a fully-installed folder that lost it, remove the dead installs (kept
    // when some installed app is still linked to them)
    try {
      await this.config.reconcileIdeVersions();
    }
    catch (err) {
      this.logger.log("WARN", `IDE versions reconciliation failed: ${err.message || err}`, "Server.start");
    }
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
    // Onboarding telemetry: persistent prospect identifier as HttpOnly cookie.
    // Generated once for guest visitors on community servers (serverType =
    // "personal"); reused across reloads so a single visitor counts as one
    // prospect in the funnel even after closing the tab. Skipped for static
    // assets (.js/.css/.png/etc.) to avoid emitting Set-Cookie on cached
    // responses, which would defeat browser caching.
    Node.app.use((req, res, next) => {
      if (this.config.serverType === "personal" && !req.cookies?.idePuid) {
        let p = req.path;
        if (!/\.(js|css|map|png|jpe?g|gif|svg|ico|woff2?|ttf|otf|webp|webmanifest)(\?|$)/i.test(p)) {
          let crypto = require("crypto");
          let puid = crypto.randomUUID();
          let secure = !this.config.local && this.config.protocol === "https";
          res.cookie("idePuid", puid, {
            httpOnly: true,
            path: "/",
            maxAge: 180 * 24 * 60 * 60 * 1000, // 180 days
            sameSite: secure ? "none" : "lax",
            secure
          });
          // Make it visible to downstream handlers in the same request, so
          // IDESession.openConnection (which reads from socket.handshake) and
          // any read-the-cookie code in this request both see the value.
          if (!req.cookies) req.cookies = {};
          req.cookies.idePuid = puid;
        }
      }
      next();
    });
    //
    // Application/x-www-form-urlencoded post requests
    Node.app.use(Node.BodyParser.urlencoded({extended: true, limit: "5mb"}));
    //
    // Parse various different custom JSON types as JSON
    Node.app.use(Node.BodyParser.json({type: "application/json", limit: "5mb"}));
    //
    // Parse the body as XML in case of appropriate content-type
    Node.app.use(Node.BodyParser.xml({type: ["application/xml", "text/xml"], limit: "5mb"}));
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
    // Debug channel of an IDF application (local IDE only): at its first request a debug build
    // announces its session — URL and cookie — and the IDE hands it to the child whose project
    // owns the app, so the DevAgent can drive it and read its console (ide/tools/idfBridge.js)
    Node.app.post("/idf-debug/announce", (req, res) => this.handleIdfDebugAnnounce(req, res));
    //
    // App service worker
    try {
      await Node.Server.createServiceWorker();
    }
    catch (err) {
      this.logger.log("ERROR", `Error creating service worker: ${err}`, "Server.init")
    }
    //
    Node.app.get("/serviceWorker.js", this.sendServiceWorker.bind(this));
    Node.app.get(/^\/ide_[0-9A-Za-z.-]+\/serviceWorker\.js$/, this.sendServiceWorker.bind(this));   // multi-version IDE worker
    // Multi-version app-preview manifest: the page links it relatively, so the injected <base>
    // makes the browser ask for it under the version prefix
    Node.app.get(/^\/ide_[0-9A-Za-z.-]+\/app\/client\/app(Offline)?\.webmanifest$/, this.sendAppManifest.bind(this));
    // A versioned IDE main page requested with a session of another version (hand-edited URL):
    // redirect to the session's version, the only client that matches its child. Caches and
    // service workers are already isolated by the prefix; this closes the client/child pairing
    Node.app.get(/^\/ide_[0-9A-Za-z.-]+\/(index2|indexLocal2)\.html$/, (req, res, next) => {
      let session = this.IDESessions[req.query.sessionid];
      let sessionVersion = session?.options?.openParams?.version;
      let urlVersion = req.path.match(/^\/ide_([0-9A-Za-z.-]+)\//)[1];
      if (!sessionVersion || sessionVersion === urlVersion)
        return next();
      //
      let qs = req.originalUrl.split("?")[1];
      res.redirect(`${this.config.getMainFile(sessionVersion)}${qs ? `?${qs}` : ""}`);
    });
    Node.app.get("/:app/client/serviceWorker.js", this.sendServiceWorker.bind(this));
    Node.app.get("/:app/client/serviceWorkerOffline.js", this.sendServiceWorker.bind(this));
    Node.app.get("/:app/client/app.webmanifest", this.sendAppManifest.bind(this));
    Node.app.get("/:app/client/appOffline.webmanifest", this.sendAppManifest.bind(this));
    //
    // Invalidate old manifest used by 19.5-
    // (https://www.html5rocks.com/en/tutorials/appcache/beginner/
    // If the manifest itself returns a 404 or 410, the cache is deleted.)
    Node.app.get("/application.manifest", (req, res) => res.status(404).end());
    Node.app.get("/:app/client/application.manifest", (req, res) => res.status(404).end());
    //
    // RD3View (IDF)
    await this.registerIDFRoutes();
    //
    // Inizialize static file management for express with maxAge=5min (not for local servers)
    let expOpts = (this.config.local ? undefined : {index: false, redirect: false, maxAge: 300000});
    let idePath = Node.Utils.resolveIdeDir();
    if (Node.fs.existsSync(idePath)) { // IDE (flat single-version layout)
      this.logger.log("INFO", "Start EXPRESS for IDE", "Server.start", {path: idePath});
      Node.app.use(Node.express.static(idePath, expOpts));
    }
    //
    // Multi-version: serve each installed version's IDE client under its own /ide_<version>/ prefix.
    // The client uses only relative paths, so the prefix scopes all its resources (and its service
    // worker, registered relatively) to the right version — no client change, old versions included.
    // Per-version static handlers are created lazily and cached; concurrent tabs on different versions
    // stay isolated by their prefix.
    let ideStatics = {};
    Node.app.use((req, res, next) => {
      let m = req.path.match(/^\/ide_([0-9A-Za-z.-]+)(?:\/|$)/);
      if (!m)
        return next();
      //
      let version = m[1];
      if (!this.config.isIdeVersionInstalled(version))
        return next();
      //
      let handler = ideStatics[version] || (ideStatics[version] = Node.express.static(Node.Utils.resolveIdeDir(version), expOpts));
      let savedUrl = req.url;
      req.url = req.url.slice(`/ide_${version}`.length) || "/";   // strip the prefix so static serves the rest
      handler(req, res, () => {
        req.url = savedUrl;
        next();
      });
    });
    //
    // Multi-version: an unresolved /ide_<version>/ path of an installed version must NOT reach
    // Express' finalhandler, whose 404 carries a Content-Security-Policy "default-src 'none'"
    // header. Chain measured with probes on the real routes, without this middleware: the
    // two-segment path runs "/:user/:command" -> processCommand, which req.next()s on unknown
    // users; then "/:app/:cls" -> processRun, where isWebApiRequest is true (the :cls param is set
    // by that very route), the user is forced to "manager" and it is the APP lookup that misses,
    // req.next()ing in turn; no handler is left and the finalhandler answers 404 with the CSP
    // header. The FeBe preview breaks exactly there: it opens a deliberately non-existent page,
    // relative to the versioned IDE page, and document.write()s the two preview iframes into it —
    // under that CSP (a document property that survives the write) the written markup cannot
    // frame, style or load anything. On flat servers the popup
    // path has ONE segment and lands on "/:app" -> processRun, where :cls is undefined and the
    // unknown-app 404 carries no CSP: that missing header is the only equivalence this middleware
    // restores (body and content type do not mimic the flat response)
    Node.app.use((req, res, next) => {
      let m = req.path.match(/^\/ide_([0-9A-Za-z.-]+)(?:\/|$)/);
      if (!m || !this.config.isIdeVersionInstalled(m[1]))
        return next();
      //
      res.status(404).send("Not found");
    });
    //
    // Multi-version: the IDE page declares no <link rel="icon">, so the browser asks for the site
    // root /favicon.ico — served by the flat static mount on single-version servers, by nobody
    // once the flat ide folder is gone. The file is the same in every version: serve the highest's
    Node.app.get("/favicon.ico", (req, res, next) => {
      if (!this.config.isMultiVersion())
        return next();
      //
      res.sendFile(Node.path.join(Node.Utils.resolveIdeDir(this.config.getHighestIdeVersion()), "favicon.ico"), {maxAge: expOpts?.maxAge}, err => {
        // Missing file: fall through to the usual 404. A transfer aborted by the client has the
        // headers already out, and the routes below must not write on that response
        if (err && !res.headersSent)
          next();
      });
    });
    //
    // Multi-version: the app-preview client must be the LAUNCHING version's, not the highest one. Its
    // index.html hardcodes the "/app/client/" path (client-side location checks + the deliberate
    // service-worker skip), so we can't move it under a version prefix. Instead we serve that page from
    // the session's version and inject a <base> so its relative resources load from
    // /ide_<version>/app/client/ (handled by the version middleware above), while location.pathname
    // stays "/app/client/index.html". The version comes from the ?sid session, so concurrent previews
    // on different versions stay correct with no shared state. The socket connects to the origin, so the
    // <base> does not affect it.
    Node.app.get(["/app/client/index.html", "/app/client/indexLocal.html",
                  "/app/client/offline.html", "/app/client/offlineLocal.html"], async (req, res, next) => {
      if (!this.config.isMultiVersion())
        return next();   // flat single-version server: the static mount serves it unchanged
      //
      let session = this.IDESessions[req.query.sid];
      let version = session?.options?.openParams?.version || this.config.getHighestIdeVersion();
      let file = Node.path.join(Node.Utils.resolveIdeDir(version), "app", "client", Node.path.basename(req.path));
      let html;
      try {
        html = await Node.fs.promises.readFile(file, "utf8");
      }
      catch (err) {
        return next();
      }
      //
      html = html.replace(/<head>/i, `<head><base href="/ide_${version}/app/client/">`);
      // Remember this preview's version for the few absolute /app/client/... requests that bypass the
      // <base> (offline SQLite worker, OIDC callback, notifications); the fallback below reads it.
      res.setHeader("Set-Cookie", `mvIdeVersion=${version}; Path=/app/client; SameSite=Lax`);
      res.type("html").send(html);
    });
    //
    // Multi-version: a few app-client framework/plugin files are requested with an ABSOLUTE
    // /app/client/... URL baked into old releases (e.g. the offline SQLite worker imported as
    // location.origin + /app/client/sqlite-worker/index.js), so they bypass the <base>. Serve them
    // from the version of the preview that set the cookie above, falling back to the highest installed.
    // These are version-stable framework files, so a shared cookie across concurrent previews is fine.
    let appClientFallback = {};
    Node.app.use("/app/client", (req, res, next) => {
      if (!this.config.isMultiVersion())
        return next();   // flat: served by the static mount above
      //
      let m = (req.headers.cookie || "").match(/mvIdeVersion=([0-9A-Za-z.-]+)/);
      let version = (m && m[1]) || this.config.getHighestIdeVersion();
      let key = version || "flat";
      let handler = appClientFallback[key] ||
              (appClientFallback[key] = Node.express.static(Node.path.join(Node.Utils.resolveIdeDir(version), "app", "client"), expOpts));
      handler(req, res, next);
    });
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
        expOpts.setHeaders = (res, path) => {
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
  }


  /**
   * Creates a childer process which will spawn IDE processes.
   * The childer runs with root privileges while the main server runs as INDERT user.
   */
  createChilder()
  {
    // Fork the childer process
    this.childer = Node.child.fork(Node.path.join(__dirname, "childer.js"), Node.Utils.forkArgs());
    //
    // Childer listener
    this.childer.on("message", msg => this.handleChilderMessage(msg));
    this.childer.on("disconnect", async () => {
      this.logger.log("WARN", "Childer is dead -> restart server", "Server.createChilder");
      //
      // Flush the log stream before exiting: process.exit terminates the event loop
      // immediately, so without flush the WriteStream buffer may not reach disk and
      // the WARN above (the most important entry to understand a restart post-mortem)
      // would be lost.
      await this.logger.flush();
      //
      process.exit(1);
    });
  }


  /**
   * Processes all messages received from the childer process.
   * Routes log messages, command responses, and session messages appropriately.
   * @param {Object} msg - Message object from childer
   */
  async handleChilderMessage(msg)
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
        if (msg.cnt?.type === "mcp_test_response") {
          this.mcpServer.handleTestResponse(msg.id, msg.cnt.cnt);
          break;
        }
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
  }


  /**
   * Tells whether commands can be run with root privileges on this installation.
   * The helper is the childer: it is always there, but it runs as ROOT only on non-local
   * installations, because the fork inherits the user of the server. And every command it
   * runs (/bin/rm, /bin/chown, /usr/bin/find, /bin/chmod...) is a Unix path that does not
   * exist on Windows.
   * @type {Boolean}
   * @readonly
   */
  get canExecAsRoot()
  {
    return !this.config.local && !/^win/.test(process.platform);
  }


  /**
   * Executes a file or command with root privileges.
   * Handles special commands like ChownChmod, ChownDBFolder, and UpdNodePackages.
   * @param {String} cmd - Command to be executed
   * @param {Array} params - Command parameters
   * @param {Object} options - Node createChild options
   * @returns {Promise<String>} Command output
   * @throws {Error} Command execution error
   */
  async execFileAsRoot(cmd, params, options)
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
        // Target folder holding package.json/node_modules: defaults to public_html (flat layout),
        // a per-version folder (ides/ide_<version>) on multi-version servers.
        let nodeModulesPath = params[0] || Node.path.resolve(__dirname, "..");
        let stdout;
        //
        // Clean npm cache first to free disk space.
        // Every npm here runs with an explicit cwd: npm resolves its own cwd at startup and crashes
        // (uv_cwd ENOENT) when the inherited one is a deleted inode — which happens mid-update, after
        // the server folder swap of updateServerPart. The target folder always exists at this point
        try {
          await this.execFileAsRoot("/usr/local/bin/npm", ["cache", "clean", "--force"], {cwd: nodeModulesPath});
        }
        catch (err) {
          this.logger.log("WARN", `Error while executing NPM CACHE CLEAN: ${err}`, "Server.execFileAsRoot", params);
        }
        //
        try {
          stdout = await this.execFileAsRoot("/usr/local/bin/npm", ["--prefix", nodeModulesPath, "update", "--unsafe-perm=true"], {cwd: nodeModulesPath});
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
          try {
            await Node.fs.promises.rm(Node.path.join(nodeModulesPath, "etc"), {recursive: true, force: true})
          }
          catch {
          }
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
  }


  /**
   * Removes a directory tree, going through the root helper when the installation has one.
   * A plain `fs.rm` is not enough for the folders this server deletes: they hold content owned
   * by other users (a user's `db` tablespace, node_modules installed by npm as root) that the
   * server process cannot even traverse (EACCES).
   * @param {String} path - Directory to remove
   * @throws {Error} If the directory cannot be removed. The message always names `path`, so a
   * caller does not have to add that context itself
   */
  async removeDir(path)
  {
    try {
      if (this.canExecAsRoot)
        await this.execFileAsRoot("/bin/rm", ["-rf", path]);
      else
        await Node.fs.promises.rm(path, {recursive: true, force: true});
    }
    catch (err) {
      // The childer rejects with the command stderr, a string, and fs.rm names the entry deep
      // inside that failed: wrap both, so that whichever branch ran, the caller gets an Error
      // naming the directory it asked to remove
      throw new Error(`Error removing the directory ${path}: ${err.message || err}`, {cause: err});
    }
  }


  /**
   * Asks the childer (running as ROOT) to reboot the server.
   */
  reboot()
  {
    this.childer.send({
      type: Node.Server.msgTypeMap.execCmd,
      cmd: "reboot"
    });
  }


  /**
   * Broadcasts a message to all active IDE sessions or to a specific session.
   * Sends notifications with customizable text and style to connected users.
   * @param {Object} params - Request parameters with message text and style
   * @returns {String} Summary of notified sessions
   */
  sendMessage(params)
  {
    let txt = decodeURIComponent(params.req.query.txt ||
            "Il server sarà aggiornato tra 5 minuti. Salvare e chiudere la sessione di lavoro<br/><br/>\
     The server will be updated in 5 minutes. Please save and leave the session");
    //
    let tot = 0;
    let sessions = Object.values(this.IDESessions);
    for (let sess of sessions) {
      //
      // If I want to send a message to a single session and this is not the
      // right one, skip it
      if (params.req.query.sid && sess.id !== params.req.query.sid)
        continue;
      //
      let message = {
        type: params.req.query.type,
        text: txt,
        style: (params.req.query.style || "alert")
      };
      if (message.type === "telecollaboration") {
        message.acceptLink = params.req.query.acceptLink;
        message.refuseLink = params.req.query.refuseLink;
      }
      sess.sendToChild({
        type: Node.Server.msgTypeMap.notify,
        cnt: message
      });
      tot++;
    }
    //
    let safeTxt = txt.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    return `Text: '${safeTxt}'<br/><br/>Total sessions: ${sessions.length}<br/><br/>Notified sessions: ${tot}`;
  }


  /**
   * Sets up Socket.IO listeners for incoming client connections.
   * Registers handlers for session, device, sync, cloud connector, and DTT messages.
   */
  socketListener()
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
  }


  /**
   * Handles session ID messages from IDE clients.
   * Validates session existence and manages reconnection attempts.
   * @param {Socket} socket - Socket that received the message
   * @param {Object} msg - Message containing session ID
   */
  handleSessionSID(socket, msg)
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
  }


  /**
   * Handles application session ID messages from clients.
   * Routes connections to appropriate IDE or master app sessions.
   * @param {Socket} socket - Socket that received the message
   * @param {Object} msg - Message containing app session ID and client ID
   */
  handleSessionASID(socket, msg)
  {
    let session, appcli;
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
        socket.emit(Node.Server.msgTypeMap.redirect, Node.Utils.getAppRestartUrl(msg.appname, msg.appurl));
        return;
      }
      //
      // Get the app client for the received cid
      appcli = session.getAppClientById(msg.cid);
      if (!appcli) {
        this.logger.log("WARN", "AppClient not found", "Server.handleSessionASID", msg);
        socket.emit(Node.Server.msgTypeMap.redirect, Node.Utils.getAppRestartUrl(msg.appname, msg.appurl));
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
        socket.emit(Node.Server.msgTypeMap.redirect, Node.Utils.getAppRestartUrl(msg.appname, msg.appurl));
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
          socket.emit(Node.Server.msgTypeMap.redirect, Node.Utils.getAppRestartUrl(msg.appname, msg.appurl));
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
          socket.emit(Node.Server.msgTypeMap.redirect, Node.Utils.getAppRestartUrl(msg.appname, msg.appurl));
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
  }


  /**
   * Handles device connection messages.
   * Authenticates devices and registers them with their owner user.
   * @param {Socket} socket - Socket that received the message
   * @param {Object} msg - Device message with type and data
   */
  handleDeviceMessage(socket, msg)
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
  }


  /**
   * Handles synchronization messages from clients.
   * Manages sync connections and routes messages to appropriate sessions.
   * @param {Socket} socket - Socket that received the message
   * @param {Object} msg - Sync message with session and content data
   */
  handleSyncMessage(socket, msg)
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
        for (let appClient of session.appClients) {
          if (appClient.mode !== "offline") {
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
  }


  /**
   * Handles cloud connector messages from remote servers.
   * Routes connector initialization and messages to appropriate users.
   * @param {Socket} socket - Socket that received the message
   * @param {Object} msg - Cloud connector message
   */
  handleCloudConnectorMessage(socket, msg)
  {
    console.error("NOT SUPPORTED FOR SELF");
  }


  /**
   * Handles Design Time Testing (DTT) messages from remote IDE clients.
   * Retrieves and sends DTT session data for live or saved sessions.
   * @param {Socket} socket - Socket that received the message
   * @param {Object} msg - DTT message with session and app information
   */
  handleDttMessage(socket, msg)
  {
    // Security (issue #14643): msg.sid is a UID36 session id, never a path. Reject anything
    // that could traverse the filesystem before it reaches path.join (config.json disclosure).
    if (typeof msg.sid !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(msg.sid)) {
      socket.disconnect();
      return this.logger.log("WARN", "DTT refused: invalid sid", "Server.handleDttMessage", {sid: msg.sid});
    }
    //
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
    // Now search the file — defense-in-depth: the resolved path must stay inside the log dir
    let logDir = Node.path.join(this.config.appDirectory, "apps", app.name, "files", "private", "log");
    let fname = Node.path.join(logDir, `dtt_${msg.sid}.json`);
    if (!Node.path.resolve(fname).startsWith(Node.path.resolve(logDir) + Node.path.sep)) {
      socket.disconnect();
      return this.logger.log("WARN", "DTT refused: path escape", "Server.handleDttMessage", {sid: msg.sid});
    }
    //
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
  }


  /**
   * Creates a new IDE session for a project.
   * @param {Node.Project} project - Project to create session for
   * @param {Object} options - Session options (type defaults to "ide")
   * @returns {Node.IDESession} Newly created session
   */
  createSession(project, options)
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
  }


  /**
   * Closes an IDE session and notifies the childer process.
   * @param {Node.IDESession} session - Session to close
   * @param {Boolean} [force] - True when the session's termination watchdog fired (issue #14839):
   *   the childer disconnects the child and, if it does not exit within the grace period,
   *   SIGKILLs it together with its descendant processes (e.g. the Agent SDK's claude CLI)
   */
  closeSession(session, force)
  {
    delete this.IDESessions[session.id];
    //
    // Tell the childer that the session have been closed and he needs to forget about it
    this.childer.send({
      id: session.id,
      type: force ? Node.Server.msgTypeMap.killChild : Node.Server.msgTypeMap.disconnectChild
    });
  }


  /**
   * Returns an open session for the given project.
   * @param {Node.Project} project - Project to search sessions for
   * @param {Object} filter - Search parameters (type:"*|ide", request:request object with IP)
   * @returns {Node.IDESession} Matching session or undefined
   */
  getOpenSession(project, filter)
  {
    for (let sess of Object.values(this.IDESessions)) {
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
      for (let k of filterKeys) {
        if (!sessMatches)
          break;
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
            for (let device of sess.project.user.devices) {
              if (!device.socket)
                continue;
              //
              let devIP = (device.socket.conn ? device.socket.conn.remoteAddress : "!");
              if (devIP.startsWith("::ffff:"))
                devIP = devIP.substring(7);
              if (devIP === filterIP) {
                sessMatches = true;
                break;
              }
            }
            //
            if (!sessMatches)
              this.logger.log("WARN", "Request IP differs from web-socket IP -> request refused", "Server.getOpenSession",
                      {sessIP, filterIP, project: project.name, user: project.user.userName});
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
  }


  /**
   * Gets all sessions for a specific user.
   * @param {String} userName - Username to search sessions for
   * @returns {Array} Array of Node.IDESession objects
   */
  getSessionListByUser(userName)
  {
    let sessionList = [];
    for (let sess of Object.values(this.IDESessions)) {
      if (sess.project.user.userName === userName)
        sessionList.push(sess);
    }
    //
    return sessionList;
  }


  /**
   * Returns all online IDE sessions.
   * @returns {Array} Array of all active IDE sessions
   */
  getOnlineSessions()
  {
    return Object.values(this.IDESessions);
  }


  /**
   * Receives the announce of an IDF debug session (POST /idf-debug/announce, JSON body with app,
   * url, cookieName, cookie, dttLevel) and forwards it to every online child: the one whose
   * project owns the app keeps it (Node.IdfBridge.attach), the others ignore it. Loopback and
   * local mode only: the cookie in the body is the whole session of the app.
   * @param {express.Request} req
   * @param {express.Response} res
   */
  handleIdfDebugAnnounce(req, res)
  {
    let ip = req.socket?.remoteAddress || "";
    if (!this.config.local || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip))
      return res.status(403).end();
    //
    let cnt = req.body;
    if (!cnt || typeof cnt.app !== "string" || typeof cnt.url !== "string" || typeof cnt.cookie !== "string")
      return res.status(400).end();
    //
    let sessions = this.getOnlineSessions();
    for (let s of sessions)
      s.sendToChild({type: "idf_runtime_session", cnt});
    console.log(`[IdfDebug] session announced by ${cnt.app} (${cnt.url}) -> ${sessions.length} IDE session(s)`);
    res.json({ok: true});
  }


  /**
   * Starts periodic project backup timers or executes scheduled backups.
   * Backs up modified projects to Google Cloud Storage.
   * @param {Boolean} scheduled - True if this is a scheduled execution
   */
  async backupProjects(scheduled)
  {
    // If the backup is not enabled, do nothing
    if (!this.config.nightlyBucketGCloud || !this.config.daysBackups || !this.config.numMinBackups)
      return this.logger.log("INFO", "Automatic project backup not configured", "Server.backupProjects",
              {nightlyBucketGCloud: this.config.nightlyBucketGCloud || "", daysBackups: this.config.daysBackups || 0,
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
      // Cancel previous timers (in case backupProjects is called again after config changes)
      clearTimeout(this.backupPrjTimeoutID);
      clearInterval(this.backupPrjIntervalID);
      //
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
      this.backupPrjTimeoutID = setTimeout(() => {
        // First call in this day
        this.backupProjects(true);
        //
        // And schedule backup for following days
        this.backupPrjIntervalID = setInterval(() => {
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
    for (let user of this.config.users) {
      for (let prj of user.projects) {
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
        await this.cleanBucket(prj);
      }
      catch (err) {
        this.logger.log("ERROR", `Can't backup project: ${err.message || err}`, "Server.backupProjects", {project: prj.name, user: prj.user.userName});
      }
    }
  }


  /**
   * Removes old backup files from the Google Cloud Storage bucket.
   * Maintains minimum number of backups while deleting files older than configured days.
   * @param {Node.Project} prj - Project to clean backups for
   */
  async cleanBucket(prj)
  {
    let archiver = new Node.Archiver(this, true);
    let path = `users/${this.config.serverType}/${prj.user.userName}/backups/projects/${prj.name}/`;
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
    //
    if (files.length <= this.config.numMinBackups)
      return;
    //
    // Remove older ones, but keep at least numMinBackups files
    let msLimit = this.config.daysBackups * 24 * 3600 * 1000;   // Number of ms I have to keep the file for
    let now = new Date();
    let deletable = files.length - this.config.numMinBackups;
    for (let i = 0; i < files.length && deletable > 0; i++) {
      // Compute the file date
      let fn = files[i];
      //
      // File name format: [project]-[date].tar.gz
      // where [date] is in the ISO form without "-:T.Z" (thus YYYYMMDDHHMMSSmmm - see Node.Project#backup)
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
          deletable--;
        }
        catch (err) {
          this.logger.log("WARN", `Error removing file ${ftodelete} from the project backup bucket: ${err}`, "Server.cleanBucket",
                    {project: prj.name, user: prj.user.userName});
        }
      }
    }
  }


  /**
   * Unfreezes the disk after backup snapshot creation.
   * Calls the snapshot end handler to resume normal operations.
   */
  async unfreezeDisk()
  {
    // I unfreeze the disk only once.
    if (!this.backupInfo.snapshotName) {
      this.logger.log("WARN", "Can't unfreeze the disk, disk not freezed", "Server.unfreezeDisk");
      return;
    }
    delete this.backupInfo.snapshotName;
    //
    try {
      await this.config.handleSnapshot({req: {}, tokens: ["", "end"]});
    }
    catch (err) {
      this.logger.log("WARN", `Can't unfreeze the disk: ${err}`, "Server.unfreezeDisk");
    }
  }


  /**
   * Periodically checks disk backup status and unfreezes disk when ready.
   * @param {Object} gce - Google Cloud Compute instance
   */
  async checkDiskBackup(gce)
  {
    if (!this.backupInfo.snapshotName)
      return;
    //
    clearInterval(this.checkBackupInterval);
    //
    let checkedSnapshots;
    try {
      checkedSnapshots = await new Promise((resolve, reject) => {
        gce.getSnapshots({"filter": `name eq ${this.backupInfo.snapshotName}`}, (err, snapshots) => {
          if (err)
            reject(err);
          else
            resolve(snapshots);
        });
      });
    }
    catch {
      checkedSnapshots = [];
    }
    //
    // Stop checking the backup when I found that it's uploading, ready or failed (statuses after che completion of the backup itself).
    if (checkedSnapshots.length > 0) {
      let checkedSnapshot = checkedSnapshots[0];
      if (["UPLOADING", "READY", "FAILED"].includes(checkedSnapshot.metadata?.status))
        return await this.unfreezeDisk();
    }
    //
    // Backup's not ready (or error occurred), repeat.
    this.checkBackupInterval = setInterval(() => this.checkDiskBackup(gce), 1000);
  }


  /**
   * Starts periodic disk snapshot timers or executes scheduled snapshots.
   * Creates Google Cloud disk snapshots for disaster recovery.
   * @param {Boolean} scheduled - True if this is a scheduled execution
   */
  async backupDisk(scheduled)
  {
    // The snapshot goes through the root helper (sync, fsfreeze): without it, no backup
    if (!this.canExecAsRoot)
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
      this.checkBackupInterval = setInterval(() => this.checkDiskBackup(gce), 1000);
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
      await this.unfreezeDisk();
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
  }


  /**
   * Starts periodic log rotation for console.log and console.error files.
   * Runs every 30 seconds to check and rotate log files as needed.
   */
  startLogRotate()
  {
    // The rotation truncates the console files through the root helper: without it, no rotation
    if (!this.canExecAsRoot)
      return;
    //
    // Start log-rotate timer
    setInterval(async () => {
      for (let consoleName of ["out", "error"]) {
        try {
          await this.config.handleLogCommand({
            req: {
              query: {
                console: consoleName
              }
            },
            tokens: ["manager", "checkrotate"]
          });
        }
        catch {
        }
      }
    }, 30 * 1000);    // Every 30 seconds
  }


  /**
   * Sends the service worker JavaScript file to clients.
   * Combines configuration with service worker template for IDE and apps.
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */
  async sendServiceWorker(req, res)
  {
    try {
      let basePath;
      let isAppIDE = (req.params.app === "app");
      let isAppMaster = (req.params.app && !isAppIDE);
      let isIDE = (!isAppIDE && !isAppMaster);
      //
      // Multi-version: a /ide_<version>/serviceWorker.js request serves that version's worker, from
      // its own folder and with a version-specific cacheName (so each version's cache is isolated)
      let ideVersion = (req.path.match(/^\/ide_([0-9A-Za-z.-]+)\//) || [])[1];
      //
      if (isIDE || isAppIDE)
        basePath = Node.Utils.resolveIdeDir(ideVersion);   // versioned folder, or the flat ide as fallback
      else if (isAppMaster)
        basePath = Node.path.join(this.config.appDirectory, "apps", req.params.app, "client");
      //
      let swConf;
      let configPath = Node.path.join(basePath, `${req.url.split("/").pop()}on`);
      if (Node.fs.existsSync(configPath))
        swConf = await Node.fs.promises.readFile(configPath, "utf8");
      //
      // If the config does not exists create a new one
      if (!swConf && (isIDE || isAppIDE)) {
        // Do it only for IDE... The Master app config is created at build time
        // and it have to be there
        swConf = await Node.Server.createServiceWorker(basePath);
      }
      //
      // If I have a config, send it
      if (swConf) {
        let sw = `const precachingItems = ${swConf};\n`;
        sw += `const cacheName = "${isAppMaster ? req.params.app : (ideVersion ? `ide_${ideVersion}` : "ide")}";\n\n`;
        sw += await Node.fs.promises.readFile(Node.path.join(basePath, "serviceWorker.js"), "utf8");
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
  }


  /**
   * Sends the web manifest file to clients for PWA support.
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */
  async sendAppManifest(req, res)
  {
    try {
      let basePath;
      // A /ide_<version>/app/client/*.webmanifest request is the app-preview manifest reached
      // through the injected <base>: serve it like the flat /app/client one, from that version
      let ideVersion = (req.path.match(/^\/ide_([0-9A-Za-z.-]+)\//) || [])[1];
      let isAppIDE = (req.params.app === "app" || !!ideVersion);
      //
      if (isAppIDE)
        basePath = Node.Utils.resolveIdeDir(ideVersion);
      else
        basePath = Node.path.join(this.config.appDirectory, "apps", req.params.app, "client");
      //
      let manifest;
      let manifestPath = Node.path.join(basePath, req.url.split("/").pop());
      if (Node.fs.existsSync(manifestPath)) {
        manifest = await Node.fs.promises.readFile(manifestPath, "utf8");
        let stats = await Node.fs.promises.stat(manifestPath);
        res.header("Last-Modified", stats.mtime.toUTCString());
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
  }


  /**
   * Starts default server sessions for all configured applications.
   * Initializes background app instances for server-side processing.
   */
  startServerSessions()
  {
    for (let user of this.config.users)
      user.startServerSessions();
  }


  /**
   * Sets file ownership to INDERT user for all server directories.
   * Fixes ownership issues from previous ROOT execution on Docker/Linux.
   */
  async setOwnerToIndert()
  {
    // On Docker I want everything to run as "INDERT" as it was on freebsd
    // The problem is that on older docker's versions the setUID and setGID functions crashed... so everything was running as ROOT
    // Now they've fixed it... but several files are now owned by ROOT... I want everything to be owned by IndeRT
    if (process.platform === "linux" && !this.config.local) {
      // Only if it's a "standard" install (not for MyCloud)
      if (!Node.fs.existsSync("/mnt/disk"))
        return;
      //
      // Only the directories that exist: the flat ide is gone after the multi-version migration and
      // ides/ is not there before it (a missing operand would make the whole chown exit with error).
      // The ides/ folder is created by the migration, which on Linux runs while the process is still
      // ROOT (the privileges drop must wait for the HTTP/HTTPS listen): without this chown the
      // installIdeVersion command, running as INDERT, could not create new version folders inside it
      let dirs = [
        "/mnt/disk/IndeRT/ide",
        "/mnt/disk/IndeRT/ides",
        "/mnt/disk/IndeRT/server",
        "/mnt/disk/IndeRT/log",
        "/mnt/disk/IndeRT/node_modules",
        Node.path.join(this.config.appDirectory, "apps"),
        Node.path.join(this.config.appDirectory, "backups")].filter(dir => Node.fs.existsSync(dir));
      let params = ["-R", "indert:indert", ...dirs];
      try {
        await this.execFileAsRoot("/bin/chown", params);
        //
        this.logger.log("DEBUG", "File's ownership fixed", "Server.setOwnerToIndert");
      }
      catch (err) {
        this.logger.log("ERROR", `Error while fixing files ownership: ${err}`, "Server.setOwnerToIndert");
      }
    }
  }


  /**
   * Loads custom SSL certificate files for multi-domain support.
   * Reads certificate, key, and CA bundle files as needed.
   * @param {Object} cert - Certificate configuration object
   * @throws {Error} File reading error
   */
  async loadCustomCert(cert)
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
  }


  /**
   * Sends the IDF desktop HTML to IDE sessions.
   * Generates and returns desktop interface for IDF applications.
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */
  async sendDesktop(req, res)
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
      if (!prj) {
        res.status(404).send(`Project not found: ${prjId}`);
        return;
      }
      //
      // Let's see if there is any IDE session for this user or project
      let ideSess;
      for (let s of Object.values(this.IDESessions)) {
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
  }


  /**
   * Handles custom file requests from the IDE.
   * Validates session and serves custom files for IDF applications.
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async handleCustomFile(req, res, next)
  {
    let file = req.url.split("/").slice(3).join("/");
    //
    let ok = false;
    let sessionId = req.cookies?.ideSessionId;
    if (sessionId) {
      let ideSess;
      for (let s of Object.values(this.IDESessions)) {
        if (s.id === sessionId) {
          ideSess = s;
          break;
        }
      }
      if (ideSess) {
        ok = true;
        //
        // Strip optional query string from the relative URL
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
  }


  /**
   * Redirects to the first page for IDF.JS applications.
   * Delegates to config handler.
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */
  async redirectToFirstPage(req, res)
  {
    // Must be awaited: a floating rejection here would be caught by the process-wide
    // unhandledRejection handler, which kills the server
    await this.config.redirectToFirstPage(req, res);
  }


  /**
   * Registers all IDF-specific Express routes.
   * Sets up static file serving and route handlers for IDF themes and resources.
   */
  async registerIDFRoutes()
  {
    // IDF routes are IDE-only and must not be registered where the idf folder is missing
    // (otherwise reading the theme directory fails): the my-cloud servers don't have the
    // ide folder at all, while the IDC version package excludes ide/app/idf
    if (!Node.fs.existsSync(Node.path.resolve(__dirname, "..", "ide", "app", "idf")))
      return;
    //
    Node.app.get("/idf/:theme/desktop.htm", this.sendDesktop.bind(this));
    Node.app.get("/idf/:theme/desktopFluid.htm", this.sendDesktop.bind(this));
    //
    let clientPath = Node.path.resolve(__dirname, "..", "ide", "app", "client");
    Node.app.use(`/idf/fonts`, Node.express.static(Node.path.join(clientPath, "objects", "ionic", "fonts")));
    Node.app.use(`/idf/:theme/fonts`, Node.express.static(Node.path.join(clientPath, "objects", "fluid", "themes", "fonts")));
    //
    Node.app.get("/idfjs", this.redirectToFirstPage.bind(this));
    Node.app.get("/idf/wizards/welcome/welcome.htm", this.redirectToFirstPage.bind(this));
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
      Node.app.get("/idf/:theme/*any", this.handleCustomFile.bind(this));
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
      let files = await Node.fs.promises.readdir(themePath);
      await Promise.all(files.map(async file => {
        let fullPath = Node.path.join(themePath, file);
        let stats = await Node.fs.promises.stat(fullPath);
        if (stats.isDirectory())
          registerTheme(file, fullPath);
      }));
      //
      // Register custom themes from the working directory
      let customThemePath = Node.path.join(this.config.directory, "themes");
      if (Node.fs.existsSync(customThemePath)) {
        let customFiles = await Node.fs.promises.readdir(customThemePath);
        await Promise.all(customFiles.map(async file => {
          let fullPath = Node.path.join(customThemePath, file);
          let stats = await Node.fs.promises.stat(fullPath);
          if (stats.isDirectory())
            registerTheme(file, fullPath);
        }));
      }
    }
    catch (ex) {
      this.logger.log("ERROR", `Error while reading IDF template directory: ${ex.message}`, "Server.registerIDFRoutes");
    }
  }
};


// Starts the server
Node.Server.create();

Node.theServer.version = "26.3.2.20261001";
