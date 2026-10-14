/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
var Node = Node || {};

// Import modules
Node.fs = require("fs");
Node.crypto = require("crypto");
Node.mime = require("mime-types");
Node.ncp = require("../ncp_fixed");
Node.multiparty = require("multiparty");
Node.child = require("child_process");
Node.path = require("path");

// Import Classes
Node.Archiver = require("../archiver");
Node.Utils = require("../utils");


/**
 * @class Node.Project
 * @classdesc
 * Represents an Instant Developer project owned by a user on the server.
 * Encapsulates the project's persisted metadata, its on-disk folder structure,
 * and all HTTP/command entry points that the server routes towards a single project
 * (edit, view, download, upload, backup, restore, rename, teamworks, build, etc.).
 *
 * Key features:
 * - **Session orchestration**: creates/retrieves IDE, viewer and worker sessions for the project.
 * - **File-system management**: creates, deletes and fixes permissions on the project folder tree.
 * - **Resource I/O**: serves project files (resources, files) and accepts uploads.
 * - **Cloud backup/restore**: archives the project tree to cloud storage and restores it back (including branches).
 * - **TeamWorks integration**: forwards branch/commit commands to a worker session.
 * - **Web command dispatching**: `execCommand` maps URL tokens to the proper project action.
 *
 * @property {String} id - Unique identifier of the project
 * @property {String} name - Project name (also the folder name on disk)
 * @property {String} version - Current project version
 * @property {Boolean} public - True when the project can be viewed without an authorization token
 * @property {Boolean} twMaster - True when this project is the TeamWorks master of a fork chain
 * @property {Boolean} twFork - True when this project is a TeamWorks fork
 * @property {Date} lastSave - Timestamp of the last save operation
 * @property {String} lastSaveID - Identifier of the last save
 * @property {String} lastSaveVersion - IDE version the project was last saved with (session version default, realigned by backup/restore)
 * @property {Date} lastOpen - Timestamp of the last edit-open operation (issue #11034)
 * @property {Array<Number>} ivAES - AES initialization vector used to encrypt the project when stored in ChromeFS
 * @property {Array<Number>} ivAESdtt - AES initialization vector used for DTT project encryption
 * @property {String} token - One-shot token released by the console that grants edit access to the project
 * @property {String} reconnectToken - Last edit token, kept to let a long-disconnected client reopen a new session
 */
Node.Project = class Project
{
  /**
   * Map of message types exchanged with child (session) processes.
   * @enum {String}
   */
  static msgTypeMap = {
    /** A branch has been restored from the cloud and TeamWorks UI must be refreshed */
    branchRestored: "brarst",
    /** A new resource file has been uploaded and is ready to be processed by the session */
    resourceUploaded: "ru"
  };


  /**
   * @param {Node.User} par - Parent user that owns this project
   */
  constructor(par)
  {
    this.parent = par;
  }


  /**
   * Owner of this project.
   * @type {Node.User}
   * @readonly
   */
  get user()
  {
    return this.parent;
  }


  /**
   * Root server instance this project belongs to.
   * @type {Node.Server}
   * @readonly
   */
  get server()
  {
    return this.parent.parent.parent;
  }


  /**
   * Server configuration that owns the user of this project.
   * @type {Node.Config}
   * @readonly
   */
  get config()
  {
    return this.parent.parent;
  }


  /**
   * Shared logger inherited from the server.
   * @type {Node.Logger}
   * @readonly
   */
  get logger()
  {
    return this.server.logger;
  }


  /**
   * Write a message to the shared logger enriching it with project and user metadata.
   * Note: the `data` object is deep-cloned so enriching it does not mutate the caller's reference.
   * @param {String} level - Severity level: "DEBUG", "INFO", "WARN" or "ERROR"
   * @param {String} message - Human readable message
   * @param {String} sender - Name of the function emitting the message
   * @param {Object} [data] - Extra structured data to log
   */
  log(level, message, sender, data)
  {
    // Add "local" info
    data = {
      ...data,
      project: this.name,
      user: this.user.userName
    };
    //
    this.logger.log(level, message, sender, data);
  }


  /**
   * Serialize the persistent state of the project into a plain object that can be
   * stored in the server configuration.
   * @returns {Object} Plain representation of the project
   */
  save()
  {
    let r = {
      cl: "Node.Project",
      id: this.id,
      name: this.name,
      version: this.version,
      public: this.public,
      twMaster: this.twMaster,
      twFork: this.twFork,
      lastSave: this.lastSave,
      lastSaveID: this.lastSaveID,
      lastSaveVersion: this.lastSaveVersion,
      lastOpen: this.lastOpen,
      ivAES: this.ivAES,
      ivAESdtt: this.ivAESdtt
    };
    return r;
  }


  /**
   * Rehydrate the project from a plain object previously produced by {@link Node.Project#save}.
   * @param {Object} v - Object that contains the persisted project data
   */
  load(v)
  {
    this.id = v.id;
    this.name = v.name;
    this.version = v.version;
    this.public = v.public;
    this.twMaster = v.twMaster;
    this.twFork = v.twFork;
    this.lastSave = v.lastSave;
    this.lastSaveID = v.lastSaveID;
    this.lastSaveVersion = v.lastSaveVersion;
    this.lastOpen = v.lastOpen;
    this.ivAES = v.ivAES;
    this.ivAESdtt = v.ivAESdtt;
  }


  /**
   * Serialize the project's flat properties (no children) enriched with a few
   * extra fields useful to external consumers (parent user, company, cloud path, reconnect token).
   * @returns {Object} Plain representation of the project properties
   */
  saveProperties()
  {
    let r = this.save();
    //
    // Delete children
    delete r.cl;
    //
    // Add usefull properties
    r.user = this.user.saveProperties();
    r.company = this.config.serverType;
    r.cloudPath = `users/${this.config.serverType}/${this.user.userName}/${this.name}`;
    r.reconnectToken = this.reconnectToken;
    //
    return r;
  }


  /**
   * Set the parent user of this project.
   * @param {Node.User} p - Parent user
   */
  setParent(p)
  {
    this.parent = p;
  }


  /**
   * Verify the project layout on disk, creating the folder structure when missing.
   */
  async check()
  {
    await this.createProjectFolder();
  }


  /**
   * Merge updates coming from the session's child process into this project.
   * Properties set to `null` are removed; after the merge the configuration is persisted.
   * @param {Object} info - Map of property names to new values (use `null` to delete a property)
   */
  updateInfo(info)
  {
    for (let k in info) {
      if (info[k] === null)
        delete this[k];
      else
        this[k] = info[k];
    }
    //
    // Save CONFIG (fire-and-forget: caller may be a sync message dispatcher)
    this.config.saveConfig().catch(err => this.log("ERROR", `Save config failed: ${err.message || err}`, "Project.updateInfo"));
  }


  /**
   * Initialize a newly created project: assign its name, generate the ChromeFS
   * encryption material and create the on-disk folder tree.
   * @param {String} projectName - Name of the project
   */
  async init(projectName)
  {
    this.name = projectName;
    //
    // Generate data for saving the project into ChromeFS
    this.id = Node.Utils.generateUID36().substring(0, 32);
    this.ivAES = Array.from(Node.crypto.randomBytes(16));
    //
    // Create the project folder if needed
    await this.createProjectFolder();
  }


  /**
   * Check whether this project is currently "online", i.e. if at least one IDE
   * session on the server is opened on it.
   * @returns {Boolean} True if an IDE session is currently open on this project
   */
  isOnline()
  {
    let skeys = Object.keys(this.server.IDESessions);
    for (let i = 0; i < skeys.length; i++) {
      let sess = this.server.IDESessions[skeys[i]];
      if (sess.project === this)
        return true;
    }
  }


  /**
   * Create the project folder and all the inner folders (branches, build, files, files/blobs,
   * files/private, files/temp, files/uploaded, resources) if they do not exist.
   * Where the root helper is available ({@link Node.Server#canExecAsRoot}), ownership and
   * permissions are fixed via {@link Node.Server#execFileAsRoot} with the `ChownChmod` script.
   * @throws {Error} When a folder cannot be created or permissions cannot be fixed
   */
  async createProjectFolder()
  {
    let path = Node.path.join(this.user.getProjectsDir(), this.name);
    let foldersToCreate = [
      "",
      "branches",
      "build",
      "files",
      "files/blobs",
      "files/private",
      "files/temp",
      "files/uploaded",
      "resources"
    ];
    //
    let logData;
    try {
      // Create all folders
      for (let p of foldersToCreate) {
        let pathToCreate = Node.path.join(path, p);
        try {
          await Node.fs.promises.mkdir(pathToCreate);
        }
        catch (err) {
          if (err.code !== "EEXIST")
            throw new Error(`Error creating the project folder ${pathToCreate}: ${err.message || err}`, {cause: err});
        }
      }
      //
      // Fix permissions where the root helper is available
      if (this.server.canExecAsRoot) {
        try {
          await this.server.execFileAsRoot("ChownChmod", [this.user.OSUser, path]);
        }
        catch (err) {
          logData = {OSUser: this.user.OSUser, path};
          throw new Error(`Error changing project folder permissions: ${err.message || err}`, {cause: err});
        }
      }
    }
    catch (err) {
      this.log("ERROR", err, "Project.createProjectFolder", logData);
      throw err;
    }
  }


  /**
   * Delete the project folder with all its content.
   * Where the root helper is available, permissions are fixed first to ensure the folder
   * can be removed.
   * @throws {Error} When the folder cannot be removed or permissions cannot be fixed
   */
  async deleteProjectFolder()
  {
    let path = Node.path.join(this.user.getProjectsDir(), this.name);
    let logData;
    try {
      // Before deleting the project folder I need to be sure I'm able to do it -> fix permissions
      if (this.server.canExecAsRoot && Node.fs.existsSync(path)) {
        try {
          await this.server.execFileAsRoot("ChownChmod", [this.user.OSUser, path]);
        }
        catch (err) {
          logData = {OSUser: this.user.OSUser, path};
          throw new Error(`Error changing the project folder permissions: ${err.message || err}`, {cause: err});
        }
      }
      //
      // Delete the project folder
      try {
        await Node.fs.promises.rm(path, {recursive: true, force: true});
      }
      catch (err) {
        throw new Error(`Error deleting the project folder ${path}: ${err.message || err}`, {cause: err});
      }
    }
    catch (err) {
      this.log("ERROR", err, "Project.deleteProjectFolder", logData);
      throw err;
    }
  }


  /**
   * Resolves the IDE version a session of this project must run with on multi-version servers.
   * The explicitly requested version wins (not installed is an error, unless tolerant); without one,
   * the version the project was last saved with keeps the session consistent with the project content
   * (matched on the release part against the installed versions); the highest installed version is
   * the last resort.
   * On flat single-version servers every step resolves to undefined, so nothing changes.
   * @param {String} [requested] - Version explicitly requested by the command
   * @param {Boolean} [tolerant] - When the requested version is not installed, fall back to the resolution below instead of throwing. For callers whose version is a claim about content, not an open request (e.g. the restore parameter): the session then runs with the best available version
   * @returns {String} Version to fork the session child with (undefined on flat servers)
   * @throws {Error} With code 400 when the requested version is not installed (unless tolerant)
   */
  resolveSessionVersion(requested, tolerant)
  {
    if (requested) {
      if (this.config.isIdeVersionInstalled(requested))
        return requested;
      //
      if (!tolerant) {
        this.log("WARN", `Requested IDE version ${requested} is not installed`, "Project.resolveSessionVersion", {version: requested});
        let err = new Error(`IDE version ${requested} is not installed on this server`);
        err.code = 400;
        throw err;
      }
    }
    //
    // Matched by release, not by identity: lastSaveVersion carries the version string of the saving
    // session, and the registry may hold a different build of the same release (the accessor prefers
    // the exact key when present). The registry key is what gets returned — it is the name of the
    // version folder to fork from
    if (this.lastSaveVersion) {
      let installed = this.config.getIdeVersionByRelease(this.lastSaveVersion);
      if (installed)
        return installed.version;
    }
    //
    return this.config.getHighestIdeVersion();
  }


  /**
   * Open the project for editing by creating (or reusing) an IDE session and
   * redirecting the client to the IDE main page.
   *
   * Behavior highlights:
   * - Honors the optional edit-project token when {@link Node.Config#editPrjToken} is enabled.
   * - Reuses a live IDE session when present; if the session was scheduled to die, revives it
   *   when death was scheduled less than 3 seconds ago, otherwise kills it and creates a fresh one.
   * - Falls back to read-only mode when the free disk space drops below
   *   {@link Node.Config#lowDiskThreshold}.
   * - Supports the `bck=true` flag that restores the `project.json.good` backup before opening.
   * - Propagates `maxViews` from the license data when running inside IDF.
   *
   * @param {Object} params - Request/response envelope
   * @param {Object} params.req - Express request
   * @param {Object} params.res - Express response
   * @throws {Error} With code 401 when the edit token does not match
   */
  async editProject(params)
  {
    // If needed, check the edit prj token
    if (this.config.editPrjToken && (!this.token || params.req.query.t !== this.token)) {
      this.log("WARN", "Unauthorized", "Project.editProject");
      let err = new Error("Unauthorized");
      err.code = 401;
      throw err;
    }
    //
    // Remember the token I've received for editing.
    // It must be used by a client that has long-disconnected if the editing session is gone and
    // the client asks to create a new session
    this.reconnectToken = this.token;
    //
    // Invalidate the token (if it was there)
    delete this.token;
    //
    // Update last-open timestamp so the recent projects list can be sorted
    // by last open instead of last save (issue #11034, aligned to IDFC++).
    this.lastOpen = new Date();
    this.config.saveConfig().catch(err => this.log("WARN", `Cannot persist lastOpen: ${err.message || err}`, "Project.editProject"));
    //
    // First try to see if there is an open session for this project...
    let session = this.server.getOpenSession(this, {type: "ide", readOnly: undefined});
    //
    // If there is already a session
    if (session) {
      this.log("DEBUG", "Found old open session", "Project.editProject", {sid: session.id});
      //
      // If the session is dying
      if (session.killSessionTimer) {
        // Note: I want to handle REFRESH (F5) but I don't want the user to use this dying session if it has been disconnected too long ago
        //
        // If this session has been killed more than 3 seconds ago
        if ((new Date() - session.killSessionTimer.start) > 3000) {
          this.log("WARN", "Previous session scheduled to die MORE than 3 seconds ago... replace it with a new one", "Project.editProject",
                  {sid: session.id, deathDelta: (new Date() - session.killSessionTimer.start)});
          //
          // I can't leave this session alive and create a new one... there would be two sessions
          // and if the "old" (dying) session gets back I'll get in trouble!!!
          // Kill the dying session NOW so that I can replace it with a new one...
          session.closeAllConnections();
          session = undefined;
        }
        else { // The session has been killed less than 3 seconds ago. Use it
          this.log("DEBUG", "Previous session scheduled to die LESS than 3 seconds ago... stop death and use it", "Project.editProject",
                  {sid: session.id, deathDelta: (new Date() - session.killSessionTimer.start)});
          //
          // Restart kill timer... otherwise this session will be dead soon!
          session.startAutoKillTimer(60000);
        }
      }
    }
    //
    // Check free space on disk... if it's too low open the project as readonly (so that
    // the developer will be unable to save)
    let available;
    if (!this.config.lowDiskThreshold)
      available = 1E12; // Do not check if there is no limit...
    else
      try {
        available = await Node.Utils.getFreeDiskSize();
      }
      catch (err) {
        this.log("ERROR", `Can't get free disk space: ${err.message || err}`, "Project.editProject");
        throw new Error(`Can't get free disk space: ${err.message || err}`, {cause: err});
      }
    //
    let openParams = (Object.keys(params.req.query).length ? params.req.query : undefined);
    let readOnly;
    if (available < this.config.lowDiskThreshold) {
      this.log("WARN", `Disk space left on device is too low -> project opened as readonly`, "Project.editProject", {available, lowDiskThreshold: this.config.lowDiskThreshold});
      readOnly = true;
      openParams = openParams || {};
      openParams.lowDiskSpace = true;  // Tell the process that we are low on disk space (it will tell the user)
      //
      // If I had a session but it was not readonly, I can't use that!
      if (session && !session.options.readOnly) {
        session.closeAllConnections();  // Don't live it alive
        session = undefined;
      }
    }
    //
    let bck = (openParams?.bck === "true");
    let jsonpath = Node.path.join(this.user.getProjectsDir(), this.name, "project.json");
    if (bck && !Node.fs.existsSync(`${jsonpath}.good`)) {
      bck = false;
      this.log("DEBUG", "Restore stopped (.good file does not exist)", "Project.editProject");
    }
    //
    if (bck) {
      // The .good file takes the project's name in ONE step: rename replaces the destination by
      // itself, so removing project.json first only opened a window in which the project had no
      // file at all. Dying in there is worse here than during a save, because there is no
      // temporary file to promote: getDocument would find nothing, recoverInterruptedSave would
      // return at once, and the project would open EMPTY on a WARN — with the .good still on disk
      // and nobody looking for it, since this branch runs only when the Console asks for it.
      await Node.fs.promises.rename(`${jsonpath}.good`, jsonpath);
    }
    //
    // Resolve the IDE version to open this project with on multi-version servers.
    // The Console sends the desired version in the edit command (not installed is an error)
    let version = this.resolveSessionVersion(openParams?.version);
    if (version && !openParams?.version) {
      openParams = openParams || {};
      openParams.version = version;
      this.log("WARN", `No IDE version requested, defaulting to ${version}`, "Project.editProject", {version});
    }
    //
    // If not found, create a new session for this project
    if (!session) {
      this.log("DEBUG", "Create a new IDE session", "Project.editProject");
      if (openParams?.maxViews === undefined && this.config.licdata?.maxtables && Node.Utils.isIDF()) {
        openParams = openParams || {};
        openParams.maxViews = parseInt(this.config.licdata.maxtables);
      }
      session = this.server.createSession(this, {readOnly, openParams});
    }
    //
    // Protects SID cookie
    session.protectSID(params.req, params.res);
    //
    // The client must be served from the version the session's child was forked with: a reused
    // session keeps its original version, whatever the current request asked (a mismatch would
    // pair the /ide_<requested>/ client with the other version's child)
    let sessionVersion = session.options?.openParams?.version;
    if (sessionVersion !== version)
      this.log("WARN", `Reusing an open session with IDE version ${sessionVersion}: the requested version ${version} is ignored`, "Project.editProject", {requested: version, session: sessionVersion});
    //
    // Redirect to the MAIN page with the sid as querystring
    params.res.redirect(`${this.config.getMainFile(sessionVersion)}?sessionid=${session.id}${bck ? "&bck=true" : ""}`);
  }


  /**
   * Create a read-only session used to view the project (no editing allowed)
   * and redirect the client to the main page.
   * Non-public projects require a matching edit-project token when
   * {@link Node.Config#editPrjToken} is enabled. When the request includes
   * `showDtt`, a per-project AES IV for DTT encryption is generated on demand.
   * @param {Object} params - Request/response envelope
   * @param {Object} params.req - Express request
   * @param {Object} params.res - Express response
   * @throws {Error} With code 401 when the project is not public and the token does not match
   */
  async viewProject(params)
  {
    // If the project is not public and the edit prj token is enabled it must match
    if (!this.public && this.config.editPrjToken && (!this.token || params.req.query.t !== this.token)) {
      this.log("WARN", "Unauthorized", "Project.viewProject");
      let err = new Error("Unauthorized");
      err.code = 401;
      throw err;
    }
    //
    // Create a new session for this project (READONLY mode)
    // Pass query string params if any
    let qry = (Object.keys(params.req.query).length ? params.req.query : undefined);
    //
    // Resolve the IDE version like editProject: an uninstalled requested version must not
    // fork a child from a missing version folder
    let viewVersion = this.resolveSessionVersion(qry?.version);
    if (viewVersion) {
      qry = qry || {};
      qry.version = viewVersion;
    }
    //
    // If this is an openDTT operation
    if (qry?.showDtt) {
      // If needed generate key for dtt projects crypting
      if (!this.ivAESdtt) {
        this.ivAESdtt = [];
        for (let i = 0; i < 16; i++)
          this.ivAESdtt[i] = Math.floor((Math.random() * 256) + 1);
        //
        // Save the new configuration
        await this.config.saveConfig();
      }
      //
      // Send them to client so that it can save/load DTT projects
      qry.ivAESdtt = this.ivAESdtt;
    }
    let session = this.server.createSession(this, {readOnly: true, openParams: qry});
    //
    // Protects SID cookie
    session.protectSID(params.req, params.res);
    //
    // Redirect to the page with the sid as querystring
    params.res.redirect(`${this.config.getMainFile(qry?.version)}?sessionid=${session.id}`);
    //
    // If it's a course forget about RID (the document will send the "RID" reply when the
    // project will be closed (see InDe.Document.prototype.sendPrjInfoToConsole))
    if (qry?.course)
      delete params.req.query.rid;
  }


  /**
   * Stream a file from one of the project's public folders (resources, files)
   * to the HTTP client. The URL is expected in the form
   * `/username/projectname/folder/filename`.
   *
   * Behavior highlights:
   * - Requires an open session (except for the polled `resources/libusage.json` file).
   * - Rejects any path resolving outside the project's folder.
   * - Translates resource paths pointing inside a branch (PR) to the corresponding on-disk location.
   * - Supports HTTP Range requests for audio/video mime types.
   *
   * @param {Object} params - Request context
   * @param {Object} params.req - Express request
   * @param {Object} params.res - Express response
   * @param {Array<String>} params.tokens - URL tokens, the last one being the filename
   * @throws {Error} On missing session, invalid path, missing file (code 404) or streaming errors
   */
  async downloadFile(params)
  {
    // The URL is in the following form:
    //   http://servername/username/projectname/folder/filename
    let folder = params.tokens.slice(0, params.tokens.length - 1).join("/").replace(/\+/g, " ");   // resources, files (with AUTK)
    let filename = decodeURIComponent(params.tokens[params.tokens.length - 1].replace(/\+/g, " "));
    let path = Node.path.join(this.user.getProjectsDir(), this.name, folder, filename);
    //
    try {
      // Send the file only if there is an editing session
      // (don't check resources/libusage.json... that file is asked whenever the callee needs it)
      if (folder !== "resources" || filename !== "libusage.json") {
        let session = this.server.getOpenSession(this, {request: params.req});
        if (!session) {
          let err = new Error("No session is asking for this file");
          err.isWarning = true;
          throw err;
        }
      }
      //
      // If it's a resource inside a branch (PR)
      //   resources/branches/OTHERUSER_FORKEDPROJECT_FORKEDBRANCH/resources
      // translates to
      //   [DIRECTORY]/[USERNAME]/[PRJNAME]/branches/OTHERUSER_FORKEDPROJECT_FORKEDBRANCH/resources/[FILENAME]
      let sfolder = folder.split("/");
      if (sfolder.length === 4 && sfolder[0] === "resources" && sfolder[1] === "branches" && sfolder[3] === "resources")  // resources/branhces/[BRANCH_NAME]/resources
        path = Node.path.join(this.user.getProjectsDir(), this.name, folder.substring("resources/".length), filename);
      //
      // The whole URL is client-provided, so the file must be confined to this project's folder -
      // with a configured projects directory (#14585) the folder above is shared with other users.
      // Counting the ".." in the raw tokens is not enough (path.join has already collapsed them) and
      // the Console does use one: what matters is where the path lands, not how it was written. The
      // URL always starts with the resources/files folder, so a legitimate ".." can at most walk back
      // to the project root and no request that used to work is refused now. realPath is what keeps
      // this aligned with the files folder jail: the same folder is writable through the filesystem
      // command, and createReadStream would happily follow a symlink planted there (issue #14062)
      let prjDir = await Node.Utils.realPath(Node.path.join(this.user.getProjectsDir(), this.name));
      if (!Node.Utils.isPathInside(await Node.Utils.realPath(path), [prjDir], true)) {
        let err = new Error("Path is outside the allowed directory");
        err.isWarning = true;
        throw err;
      }
      //
      // Full path must be valid and not a directory
      let pathStats;
      try {
        pathStats = await Node.fs.promises.stat(path);
      }
      catch (err) {
        let err1 = new Error(`Can't get file info (file is missing?): ${err.message || err}`, {cause: err});
        err1.code = 404;
        err1.isWarning = true;
        throw err1;
      }
      //
      if (pathStats.isDirectory()) {
        let err = new Error("Invalid path (file is a directory)");
        err.isWarning = true;
        throw err;
      }
      //
      // Compute the mimetype
      let mimetype = Node.mime.lookup(filename);
      //
      // If the file is an AUDIO or a VIDEO resource and a RANGE was provided
      if (mimetype && (mimetype.includes("audio") || mimetype.includes("video")) && params.req.headers.range) {
        let positions = params.req.headers.range.replace(/bytes=/, "").split("-");
        //
        let stats;
        try {
          stats = await Node.fs.promises.stat(path);
        }
        catch (err) {
          let err1 = new Error(`Error while reading file ${path}'s stats: ${err.message || err}`, {cause: err});
          err1.code = 404;
          throw err1;
        }
        //
        let total = stats.size;
        let start = parseInt(positions[0], 10);
        let end = positions[1] ? parseInt(positions[1], 10) : total - 1;
        //
        // Send the requested file slice
        params.res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Accept-Ranges": "bytes",
          "Content-Length": (end - start) + 1,
          "Content-Type": mimetype
        });
        //
        try {
          let stream = Node.fs.createReadStream(path, {start, end});
          await require("stream/promises").pipeline(stream, params.res);
          return;
        }
        catch (err) {
          // A client abort (typically a video seek closing the range connection) is routine here
          // and not a real error: pipeline has already torn the file stream down.
          if (Node.Utils.isClientAbortError(err))
            return;
          //
          let err1 = new Error(`Error while streaming file ${path}: ${err.message || err}`, {cause: err});
          err1.code = 404;
          throw err1;
        }
      }
      //
      // Send the full file
      params.res.writeHead(200, {"Content-Type": mimetype});
      try {
        let stream = Node.fs.createReadStream(path);
        await require("stream/promises").pipeline(stream, params.res);
      }
      catch (err) {
        // A client abort (connection closed mid-download) is not a real error: pipeline has
        // already torn the file stream down.
        if (Node.Utils.isClientAbortError(err))
          return;
        //
        let err1 = new Error(`Error while sending the file ${path}: ${err.message || err}`, {cause: err});
        err1.code = 404;
        err1.isWarning = true;
        throw err1;
      }
    }
    catch (e) {
      let {isWarning} = e;
      this.log(isWarning ? "WARN" : "ERROR", e.message || e, "Project.downloadFile");
      delete e.isWarning;
      throw e;
    }
  }


  /**
   * Streams a one-shot backup file out of `files/temp/` and unlinks it as soon as the response
   * stream closes (regardless of success/failure/cancellation). Used by the IDE "Backup database
   * → Download" flow (see InDe.ADataModel.exportDataBackup, mode "download"). Bypassing the static
   * serve avoids: orphan files on Windows (where unlink-while-streaming fails) and the arbitrary
   * setTimeout cleanup window. The static serve is also undesirable because the temp file would
   * appear in the project tree as a real resource.
   *
   * URL: `http://servername/username/projectname/downloadBackup/filename`
   *
   * @param {Object} params - Request context
   * @param {Object} params.req - Express request
   * @param {Object} params.res - Express response
   * @param {Array<String>} params.tokens - URL tokens; `tokens[1]` is the temp filename
   * @throws {Error} On missing session, invalid filename, or missing file (code 404)
   */
  async downloadBackupFile(params)
  {
    let filename = decodeURIComponent(params.tokens[1].replace(/\+/g, " "));
    let filePath = Node.path.join(this.user.getProjectsDir(), this.name, "files", "temp", filename);
    //
    try {
      // Require an active IDE session — same check downloadFile does for resources.
      let session = this.server.getOpenSession(this, {request: params.req});
      if (!session) {
        let err = new Error("No session is asking for this backup");
        err.isWarning = true;
        throw err;
      }
      //
      // Filename must be a plain basename — no traversal allowed.
      if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
        let err = new Error("Invalid filename");
        err.isWarning = true;
        throw err;
      }
      //
      // res.download sets Content-Disposition: attachment and pipes the file. Wrap the callback in
      // a Promise so `await` covers the actual streaming (errors propagate to the caller, same
      // pattern used by downloadFile above). The finally block guarantees cleanup right after the
      // response closes — no Windows lock issue, no setTimeout window.
      try {
        await new Promise((resolve, reject) => {
          params.res.download(filePath, filename, err => err ? reject(err) : resolve());
        });
      }
      finally {
        Node.fs.promises.unlink(filePath).catch(() => { /* already gone */ });
      }
    }
    catch (e) {
      let {isWarning} = e;
      this.log(isWarning ? "WARN" : "ERROR", e.message || e, "Project.downloadBackupFile");
      delete e.isWarning;
      throw e;
    }
  }


  /**
   * Dispatch a generic file-system command (list/put/get/del/move) on the
   * project `files` folder through {@link Node.Utils#handleFileSystem}.
   * Permissions on the files folder are fixed before write operations
   * (`put`, `del`, `move`) and again after `put` to make the new files
   * owned by the OS user.
   * @param {Object} params - Request context
   * @param {Object} params.req - Express request (with optional `path` query string)
   * @param {Array<String>} params.tokens - URL tokens; `tokens[1]` is the command name
   * @returns {Promise<Object>} Command result as produced by {@link Node.Utils#handleFileSystem}
   * @throws {Error} When the command fails or permissions cannot be fixed
   */
  async handleFileSystem(params)
  {
    let prjFilesPath = Node.path.join(this.user.getProjectsDir(), this.name, "files");
    let objPath = params.req.query.path || "";    // (optional; array for a batch "del")
    let logData;
    try {
      let options = {
        path: Array.isArray(objPath) ? objPath.map(p => Node.path.join(prjFilesPath, p)) : Node.path.join(prjFilesPath, objPath),
        command: params.tokens[1],
        basePath: prjFilesPath,
        tempPath: Node.path.join(prjFilesPath, "temp")
      };
      //
      this.log("DEBUG", "Handle file system command", "Project.handleFileSystem", options);
      //
      // Append original params map
      options.params = params;
      //
      // Function for fixing permissions
      let fixPathPermissions = async () => {
        if (/^win/.test(process.platform))
          return;
        //
        try {
          await this.server.execFileAsRoot("ChownChmod", [this.user.OSUser, prjFilesPath]);
        }
        catch (err) {
          logData = {OSUser: this.user.OSUser, path: prjFilesPath};
          throw new Error(`Error changing folder permissions: ${err.message || err}`, {cause: err});
        }
      };
      //
      // If it's a WRITE operation, I need to fix permissions BEFORE I execute the command
      if (["put", "del", "move"].includes(options.command))
        await fixPathPermissions();
      //
      // Handle the command
      let res = await Node.Utils.handleFileSystem(options);
      //
      // If it's a PUT operation, fix permissions after I've executed the command
      if (options.command === "put")
        await fixPathPermissions();
      //
      return res;
    }
    catch (err) {
      this.log("WARN", `Error while handling file system command: ${err.message || err}`, "Project.handleFileSystem", logData);
      throw err;
    }
  }


  /**
   * Accept a multipart upload and store the received file into the project's
   * `resources` folder. The filename must be a valid GUID (optionally followed
   * by an extension). An active IDE session (or a course session) must be
   * waiting for the resource; when the upload completes the session is notified
   * via the `resourceUploaded` message so that the IDE can process the new resource.
   * @param {Object} params - Request context
   * @param {Object} params.req - Express request carrying the multipart body
   * @param {Array<String>} params.tokens - URL tokens; `tokens[1]` is the GUID filename
   * @throws {Error} On invalid filename, missing session, permission or upload failure
   */
  async uploadResource(params)
  {
    // The URL is in the following form:
    //   http://servername/username/projectname/upload/filename
    let filename = params.tokens[1];
    let path = Node.path.join(this.user.getProjectsDir(), this.name, "resources", filename);
    //
    let logData;
    let warning = false;
    try {
      // filename must be a valid GUID followed by "." and the extension
      if (!filename.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.?\w*$/i)) {
        warning = true;
        throw new Error("Invalid file name (not a GUID)");
      }
      //
      // Get the session that will receive this resource
      let session = this.server.getOpenSession(this, {type: "ide", readOnly: undefined, request: params.req});
      if (!session) {
        // Session is not there... check if it's a course... he is allowed to upload files
        // (course is IDE, readonly with openParams.course)
        session = this.server.getOpenSession(this, {type: "ide", readOnly: true, request: params.req});
        if (session && (!session.options.openParams || !session.options.openParams.course))
          session = null;
      }
      if (!session) {
        warning = true;
        throw new Error("No session is waiting for this resource");
      }
      //
      // Parse the request
      let form = new Node.multiparty.Form();
      await new Promise((resolve, reject) => {
        form.on("part", async part => {
          try {
            // Write content of post request in the file
            try {
              await require("stream/promises").pipeline(part, Node.fs.createWriteStream(path));
            }
            catch (err) {
              return reject(new Error(`Error while writing the file ${path}: ${err.message || err}`, {cause: err}));
            }
            //
            // Fix permissions where the root helper is available
            if (this.server.canExecAsRoot) {
              try {
                await this.server.execFileAsRoot("ChownChmod", [this.user.OSUser, path]);
              }
              catch (err) {
                logData = {OSUser: this.user.OSUser, path};
                return reject(new Error(`Error changing the resource permissions: ${err.message || err}`, {cause: err}));
              }
            }
            //
            // Done -> tell the session that a new resource has been uploaded
            session.sendToChild({
              type: Node.Project.msgTypeMap.resourceUploaded,
              guid: filename
            });
            resolve();
          }
          catch (err) {
            reject(err);
          }
        });
        form.on("error", err => reject(new Error(`Error in form parsing: ${err.message || err}`, {cause: err})));
        form.parse(params.req);
      });
    }
    catch (err) {
      this.log(warning ? "WARN": "ERROR", err.message || err, "Project.uploadResource", logData);
      throw err;
    }
  }


  /**
   * Compute and return the current status of the project: version, publish flag,
   * last save timestamp and per-folder disk usage.
   * Note: directory sizes are computed via `du` and are therefore only available
   * when the server is not local and not running on Windows.
   * @param {Object} params - Request context (unused, kept for signature consistency)
   * @returns {Promise<Object>} Status snapshot with fields `version`, `public`, `lastSave`,
   *   `lastSaveVersion`, `diskSize` and the `pathSizes` sub-object (`twSize`, `prjSize`, `buildSize`, `filesSize`, `resSize`)
   * @throws {Error} When `du` fails while computing folder sizes
   */
  async getStatus(params)
  {
    let status = {
      version: this.version,
      public: this.public,
      lastSave: this.lastSave,
      lastSaveVersion: this.lastSaveVersion
    };
    //
    // The sizes come from du, run through the root helper: without it, no sizes
    if (this.server.canExecAsRoot) {
      // Get the size of the project directory
      let stdout;
      let path = Node.path.join(this.user.getProjectsDir(), this.name);
      try {
        stdout = await this.server.execFileAsRoot("/usr/bin/du", ["-k", "-a", "-d", "1", path]);
      }
      catch (err) {
        this.log("ERROR", `Error getting the size of project folder: ${err.message || err}`, "Project.getStatus", {path});
        throw new Error(`Error getting the size of project folder: ${err.message || err}`, {cause: err});
      }
      //
      status.pathSizes = {};
      let sizes = stdout.split("\n");
      for (let i = 0; i < sizes.length - 1; i++) {                        // Last one is an empty row
        let size = Math.ceil(parseFloat(sizes[i].split("\t")[0]) * 1024);
        let dir = sizes[i].split("\t")[1].substring(path.length + 1);     // Remove path
        //
        switch (dir) {
          case "branches":
          case "trans":
          case "TwConfig.json":
          case "TwConfig.json.bak":
            status.pathSizes.twSize = (status.pathSizes.twSize || 0) + size;
            break;

          case "project.json":
            status.pathSizes.prjSize = size;
            break;

          case "build":
            status.pathSizes.buildSize = size;
            break;

          case "files":
            status.pathSizes.filesSize = size;
            break;

          case "resources":
            status.pathSizes.resSize = size;
            break;

          case "":
            status.diskSize = size;
            break;
        }
      }
    }
    //
    return status;
  }


  /**
   * Apply project configuration changes sent as query-string parameters.
   * The `public` flag is applied inline; changes that must be reflected inside
   * the project (such as `description` or `iconUrl`) require no live IDE session
   * and are forwarded to a short-lived `configProject` worker session that applies
   * them into the `project.json`.
   * @param {Object} params - Request context
   * @param {Object} params.req - Express request; `req.query` holds the properties to update
   * @throws {Error} When no property is specified or an IDE session prevents the configuration change
   */
  async configure(params)
  {
    // Compute the array of properties provided via url
    let query = params.req.query;
    let queryProps = Object.getOwnPropertyNames(query);
    if (queryProps.length === 0) {
      this.log("WARN", "No property specified", "Project.configure");
      throw new Error("No property specified");
    }
    //
    if (query.public) {
      if (query.public === "false")
        this.public = false;
      else if (query.public === "true")
        this.public = true;
    }
    //
    // Save the new configuration
    await this.config.saveConfig();
    //
    // Log the operation
    this.log("DEBUG", "Updated project configuration", "Project.configure", {config: query});
    //
    // If the user changed DESCRIPTION or ICONURL I need to send this information to a new IDE session that
    // have to "apply" that configuration change into the project. If everything is fine I can report to callee
    if (query.description !== undefined || query.iconUrl !== undefined) {
      // Configure the project. If there is an open session it can't be done
      if (this.server.getOpenSession(this)) {
        this.log("WARN", "Can't configure the project: open IDE session", "Project.configure");
        throw new Error("Can't configure the project: open IDE session");
      }
      //
      // No session available. Use a "worker" session
      let session = this.server.createSession(this, {type: "configProject", params: params.req.query, openParams: {version: this.resolveSessionVersion(params.req?.query.version)}});
      await session.waitCompleted();
    }
  }


  /**
   * Forward a generic TeamWorks command (e.g. `branches`, `commits`) to a
   * short-lived worker session that reads the TeamWorks state and returns the result.
   * @param {Object} params - Request context
   * @param {Object} params.req - Express request carrying the TW parameters in `req.query`
   * @param {Array<String>} params.tokens - URL tokens; `tokens[0]` is the TW command
   * @returns {Promise<Object>} Data produced by the worker session for the requested command
   */
  async teamworksCmd(params)
  {
    let command = params.tokens[0];
    let session = this.server.createSession(this, {type: "teamworksCmd", twcommand: command, twparams: params.req.query, openParams: {version: this.resolveSessionVersion(params.req?.query.version)}});
    let result = await session.waitCompleted();
    return result.data;
  }


  /**
   * Store the edit token issued by the console. Holding this token is what later
   * authorizes the call to {@link Node.Project#editProject}.
   * @param {Object} params - Request context
   * @param {Request} params.req - Express request; the token is read from `req.query.t`
   */
  setToken(params)
  {
    // Read and store the token
    this.token = params.req.query.t;
  }


  /**
   * Reset the encryption keys used to store the project inside the browser's file system,
   * forcing the client to rewrite the project on next save.
   * @param {Object} params - Request context (unused, kept for signature consistency)
   */
  resetKeys(params)
  {
    this.log("INFO", "Reset encryption keys", "Project.resetKeys");
    this.updateInfo({lastSaveID: null, ivAES: null});
  }


  /**
   * Archive the project folder to cloud storage through {@link Node.Archiver}.
   *
   * Behavior highlights:
   * - Fixes ownership/permissions of the project folder before archiving, where the root helper is available.
   * - If `path` or `exclude` are provided, the project is first copied into a temp folder
   *   (applying the exclude filter) and the temp folder is archived instead.
   * - The destination path on cloud defaults to
   *   `users/<serverType>/<user>/backups/projects/<name>/<name>.tar.gz`.
   * - The temp folder is always removed in the `finally` block.
   *
   * @param {Object} params - Request context
   * @param {Request} [params.req] - Express request; `req.query` accepts `path`, `exclude`, `nigthly`
   * @throws {Error} When permissions, filtering, copying, archiving or cleanup fail
   */
  async backup(params)
  {
    let archiver = new Node.Archiver(this.server, params.req?.query.nigthly);
    let path = Node.path.join(this.user.getProjectsDir(), this.name);
    let pathTemp = Node.path.join(this.user.getProjectsDir(), `tmp_${this.name}`);
    //
    let pathCloud;
    if (params.req?.query.path) {
      // Given path could be a full file path (with .tar.gz extension) or a folder
      pathCloud = params.req.query.path;
      if (!pathCloud.endsWith(".tar.gz"))
        pathCloud += `/${this.name}.tar.gz`;   // Was a folder
    }
    else
      pathCloud = `users/${this.config.serverType}/${this.user.userName}/backups/projects/${this.name}/${this.name}.tar.gz`;
    //
    this.log("DEBUG", "Project backup", "Project.backup", {pathCloud, params: (params.req ? params.req.query : undefined)});
    //
    try {
      let err;
      try {
        // Stamp the version the project is saved with into the archive (backupInfo.json), so that a
        // restore can realign the project's lastSaveVersion with the restored content. The file lives
        // in the project folder only for the time of the backup (removed in the finally below)
        try {
          await Node.Utils.saveObject(Node.path.join(path, "backupInfo.json"), {lastSaveVersion: this.lastSaveVersion});
        }
        catch (err) {
          throw new Error(`Error writing the backupInfo file: ${err.message || err}`, {cause: err});
        }
        //
        // If we are in the server adjust files permissions to 770 and files ownership to owner (user) BEFORE backing up
        if (this.server.canExecAsRoot) {
          try {
            await this.server.execFileAsRoot("ChownChmod", [this.user.OSUser, path]);
          }
          catch (err) {
            throw new Error(`Error changing the project folder permissions: ${err.message || err}`, {cause: err});
          }
        }
        //
        // If no path nor exclude were given
        let pathToBackup;
        if (params.req?.query.path || params.req?.query.exclude) {
          // If an exclude list was provided, define filter function
          let filterFnc;
          if (params.req.query.exclude) {
            let exclList = params.req.query.exclude.split(";");
            filterFnc = fileName => {
              fileName = fileName.replace(/\\/g, "/");   // Windows
              //
              let copyFile = true;
              for (let i = 0; i < exclList.length && copyFile; i++) {
                let excl = Node.path.join(path, exclList[i]).replace(/\\/g, "/");
                //
                // If the exclude path is a directory exclude the directory itself
                let fn = fileName;
                if (excl.endsWith("/"))
                  fn += "/";
                if (fn.startsWith(excl))
                  copyFile = false;
              }
              return copyFile;
            };
          }
          //
          // Remove the temp folder if present (due to a failed previous backup)
          try {
            await Node.fs.promises.rm(pathTemp, {recursive: true, force: true});
          }
          catch (err) {
            throw new Error(`Error removing the previous temp folder (${pathTemp}): ${err.message || err}`, {cause: err});
          }
          //
          // Create a temp folder
          try {
            await Node.fs.promises.mkdir(pathTemp);
          }
          catch (err) {
            throw new Error(`Error creating the ${pathTemp} folder: ${err.message || err}`, {cause: err});
          }
          //
          // Copy the project folder with filter function
          pathToBackup = Node.path.join(pathTemp, this.name);
          try {
            await new Promise((resolve, reject) => {
              Node.ncp(path, pathToBackup, {filter: filterFnc}, e => e ? reject(e) : resolve());
            });
          }
          catch (err) {
            throw new Error(`Error copying the folder: ${err.message || err}`, {cause: err});
          }
          //
        }
        else // Simply backup the entire directory
          pathToBackup = path;
        //
        // Do backup
        try {
          await archiver.backup(pathToBackup, pathCloud);
        }
        catch (err) {
          throw new Error(`Error while backing up project ${this.name}: ${err.message || err}`, {cause: err});
        }
      }
      catch (e) {
        err = e;
        throw e;
      }
      finally {
        // Delete the temp folder
        try {
          await Node.fs.promises.rm(pathTemp, {recursive: true, force: true});
        }
        catch (e) {
          if (!err)
            err = Error(`Error removing the temp folder (${pathTemp}): ${e.message || e}`);
        }
        //
        // The backupInfo file belongs to the archives only, not to the live project folder
        try {
          await Node.fs.promises.rm(Node.path.join(path, "backupInfo.json"), {force: true});
        }
        catch (e) {
          this.log("WARN", `Can't remove the backupInfo file: ${e.message || e}`, "Project.backup");
        }
      }
      //
      if (err)
        throw err;
      //
      this.log("INFO", "Backup of the project succeeded", "Project.backup");
    }
    catch (err) {
      this.log("ERROR", err.message || err, "Project.backup");
      throw err;
    }
  }


  /**
   * Restore the project folder from a cloud archive through {@link Node.Archiver}.
   *
   * Behavior highlights:
   * - The archive is extracted into a temp folder, then the first inner directory
   *   (the original project folder) is copied on top of the current project folder.
   * - Permissions are fixed via `ChownChmod` when running on the server.
   * - On `mode=clone` or `mode=fork` a `TWrestore` worker session is run to
   *   finalize the TeamWorks state; on `clone` the TeamWorks state is also wiped
   *   (branches/, trans/, TwConfig.json).
   * - The temp folder is always removed in the `finally` block.
   *
   * @param {Object} params - Request context
   * @param {Request} [params.req] - Express request; `req.query` accepts `path`, `mode`, `nigthly`,
   *   `version` (IDE version to write as the project's lastSaveVersion when the archive has no
   *   backupInfo), `skipSaveVersion` ("true" skips the lastSaveVersion realignment from the
   *   archive's backupInfo)
   * @throws {Error} When extraction, copy, permissions or cleanup fail
   */
  async restore(params)
  {
    let archiver = new Node.Archiver(this.server, params.req?.query.nigthly);
    let path = Node.path.join(this.user.getProjectsDir(), this.name);
    let pathTemp = Node.path.join(this.user.getProjectsDir(), `tmp_${this.name}`);
    //
    // Optional explicit version for the restored content. Like the archive's backupInfo, it is a
    // claim about the content, not about this server: it is accepted even when not installed (the
    // sessions would then fall back to the highest installed version, and their first save would
    // re-stamp lastSaveVersion — to make the value stick, install the version first)
    let version = params.req?.query.version;
    //
    let pathCloud;
    if (params.req?.query.path) {
      // Given path could be a full file path (with .tar.gz extension) or a folder
      pathCloud = params.req.query.path;
      if (!pathCloud.endsWith(".tar.gz"))
        pathCloud += `/${this.name}.tar.gz`;   // Was a folder
    }
    else
      pathCloud = `users/${this.config.serverType}/${this.user.userName}/backups/projects/${this.name}/${this.name}.tar.gz`;
    //
    this.log("DEBUG", "Project restore", "Project.restore", {pathCloud, params: (params.req ? params.req.query : undefined)});
    //
    try {
      let err;
      try {
        // Create a temp folder
        try {
          await Node.fs.promises.mkdir(pathTemp);
        }
        catch (err) {
          throw new Error(`Error creating the ${pathTemp} folder: ${err.message || err}`, {cause: err});
        }
        //
        // Restore files from the cloud
        await archiver.restore(Node.path.join(pathTemp, this.name), pathCloud);
        //
        // Get the directory inside the temporary folder (should be the name of the "original"
        // project). Picked by type, since readdir does not order its entries and the downloaded
        // archive is a sibling of the directory when the restore could not delete it
        let srcDir;
        try {
          let entries = await Node.fs.promises.readdir(pathTemp, {withFileTypes: true});
          srcDir = entries.find(entry => entry.isDirectory())?.name;
        }
        catch (err) {
          throw new Error(`Error retrieving the first file: ${err.message || err}`, {cause: err});
        }
        //
        // Remove a possible backupInfo leftover (a backup killed before its cleanup): the ncp below
        // merges onto the existing folder, and the archive content must be the only source of the
        // restored version
        await Node.fs.promises.rm(Node.path.join(path, "backupInfo.json"), {force: true});
        //
        // Copy all files from the "original" directory to the project directory
        await new Promise((resolve, reject) => {
          Node.ncp(Node.path.join(pathTemp, srcDir), path, err => {
            if (err)
              reject(new Error(`Error copying the folder: ${err.message || err}`));
            else
              resolve();
          });
        });
        //
        // Realign lastSaveVersion with the restored content. The archive's backupInfo.json always
        // wins when present: it is the version recorded by the server at backup time, i.e. the truth
        // about the archived content. The caller's version parameter covers the archives that don't
        // have it (created before the file existed): the Console can dictate the version it knows,
        // and with a valued lastSaveVersion even the automatic open+save that may follow the restore
        // resolves to that version instead of the highest installed, so the stamp survives it. With
        // neither source the version becomes unknown, which is the honest state.
        // With skipSaveVersion=true (and no version) the whole realignment is skipped and
        // lastSaveVersion stays as it is
        if (version || params.req?.query.skipSaveVersion !== "true") {
          let backupInfo = {};
          try {
            backupInfo = await Node.Utils.loadObject(Node.path.join(path, "backupInfo.json")) || {};
          }
          catch (e) {
            // Corrupt backupInfo in the archive: the restored content's version is unknown
          }
          if (backupInfo.lastSaveVersion) {
            if (version && version !== backupInfo.lastSaveVersion)
              this.log("WARN", `Restore version parameter ${version} differs from the archive's backupInfo ${backupInfo.lastSaveVersion}: the archive wins`, "Project.restore");
            this.lastSaveVersion = backupInfo.lastSaveVersion;
          }
          else if (version)
            this.lastSaveVersion = version;
          else
            delete this.lastSaveVersion;
          //
          // Best-effort: a persist failure must not abort the restore (files are already in place and
          // the steps below have to run); the in-memory value is correct and any later saveConfig
          // will persist it
          try {
            await this.config.saveConfig();
          }
          catch (e) {
            this.log("WARN", `Can't persist lastSaveVersion after restore: ${e.message || e}`, "Project.restore");
          }
        }
        //
        // The backupInfo file belongs to the archives only, not to the live project folder
        try {
          await Node.fs.promises.rm(Node.path.join(path, "backupInfo.json"), {force: true});
        }
        catch (e) {
          this.log("WARN", `Can't remove the backupInfo file: ${e.message || e}`, "Project.restore");
        }
        //
        // Done file extraction. Fix permissions then complete the restore procedure
        if (this.server.canExecAsRoot)
          await this.server.execFileAsRoot("ChownChmod", [this.user.OSUser, path]);
        //
        // If not CLONE nor FORK -> I've done!
        let mode = (params.req ? params.req.query.mode : "");
        if (mode === "clone" || mode === "fork") {
          // Create a new session for setting properly the TW. Tolerant resolution: the restore's
          // version parameter is a claim about the restored content (it may not be installed, see
          // the plain-restore branch above), so the TWrestore worker must not fail on it — it runs
          // with the best available version, while lastSaveVersion keeps the declared value
          let session = this.server.createSession(this, {type: "TWrestore", mode, openParams: {version: this.resolveSessionVersion(params.req?.query.version, true)}});
          await session.waitCompleted();
          //
          if (mode === "clone") {
            // It was a CLONE -> I need to clean TW
            try {
              await Node.fs.promises.rm(Node.path.join(path, "branches"), {recursive: true, force: true});
            }
            catch (err) {
              throw new Error(`Error deleting the BRANCHES folder: ${err.message || err}`, {cause: err});
            }
            //
            try {
              await Node.fs.promises.rm(Node.path.join(path, "trans"), {recursive: true, force: true});
            }
            catch (err) {
              throw new Error(`Error deleting the TRANS folder: ${err.message || err}`, {cause: err});
            }
            //
            try {
              await Node.fs.promises.rm(Node.path.join(path, "TwConfig.json"), {force: true});
            }
            catch (err) {
              throw new Error(`Error deleting the TwConfig.json file: ${err.message || err}`, {cause: err});
            }
          }
        }
      }
      catch (e) {
        err = e;
        throw e;
      }
      finally {
        // Delete the temp folder
        try {
          await Node.fs.promises.rm(pathTemp, {recursive: true, force: true});
        }
        catch (e) {
          if (!err)
            err = new Error(`Error removing the temp folder (${pathTemp}): ${e.message || e}`);
        }
      }
      //
      if (err)
        throw err;
      //
      this.log("INFO", "Restore of the project succeeded", "Project.restore");
    }
    catch (err) {
      this.log("ERROR", err, "Project.restore");
      throw err;
    }
  }


  /**
   * Run an automatic nightly backup of the project.
   * The archive is stored under
   * `users/<serverType>/<user>/backups/projects/<name>/<name>-<timestamp>.tar.gz`
   * and excludes the `build/` and `files/` folders.
   * @see Node.Project#backup
   */
  async nightlyBackup()
  {
    // Backup in a specific place and with a specific name
    let date = new Date().toISOString().replace(/-/g, "").replace(/:/g, "").replace("T", "").replace(".", "").replace("Z", "");
    let prjPath = `users/${this.config.serverType}/${this.user.userName}/backups/projects/${this.name}/${this.name}-${date}.tar.gz`;
    //
    let params = {req: {query: {nigthly: true, exclude: "build/;files/", path: prjPath}}};
    await this.backup(params);
  }


  /**
   * Rename this project by renaming its folder and updating the persisted configuration.
   * The new name is read from `req.query.newName` and sanitized via
   * {@link Node.Utils#clearName}. The operation fails if the new name is empty,
   * equal to the current one or if an IDE session is open on the project.
   * A folder still held by a closing child process or by a file watcher is retried
   * a few times with growing waits before giving up (#14823).
   * @param {Object} params - Request context
   * @param {Request} params.req - Express request providing `newName` via `req.query`
   * @throws {Error} On empty/equal new name, open IDE session, a folder that stays busy
   *   after the retries, or other filesystem rename errors
   */
  async renameProject(params)
  {
    // Command is in the form
    // (http://servername/username/prjname/rename?newName=newName)
    let newName = Node.Utils.clearName(params.req.query.newName);
    let oldName = this.name;
    let warning = false;
    //
    try {
      // If a new name was not provided or it's the same as the old one
      if (!newName) {
        warning = true;
        throw new Error("Can't rename project: new name not specified");
      }
      if (newName === oldName) {
        warning = true;
        throw new Error("Can't rename project: new name and old name are the same");
      }
      //
      // If there is an open session I can't rename the project!
      if (this.server.getOpenSession(this)) {
        warning = true;
        throw new Error("Can't rename the project: open IDE session");
      }
      //
      // Rename the folder
      let path = this.user.getProjectsDir();
      let oldPath = Node.path.join(path, oldName);
      let newPath = Node.path.join(path, newName);
      //
      // On Windows the folder can't be renamed while something still holds a handle on it, and the
      // handle outlives what getOpenSession can see: closeSession drops the session before the child
      // process actually exits, and the DevAgent's recursive watcher locks every ancestor of the
      // folder it watches. Both are transient, hence the retry with growing waits (#14823)
      let busyCodes = ["EPERM", "EBUSY", "EACCES"];
      let lastErr;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await Node.fs.promises.rename(oldPath, newPath);
          lastErr = null;
          break;
        }
        catch (err) {
          lastErr = err;
          if (!busyCodes.includes(err?.code))
            break;
          //
          if (attempt < 4)
            await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt)));
        }
      }
      //
      if (lastErr) {
        // Still busy after the retries: tell the user what to do about it, the raw filesystem
        // error says nothing. It's a temporary condition, so it goes in the log as a warning
        if (busyCodes.includes(lastErr.code)) {
          warning = true;
          throw new Error(`Can't rename the project: the folder ${oldPath} is still in use, close the project and retry in a few seconds`, {cause: lastErr});
        }
        //
        throw new Error(`Error renaming the project folder ${oldPath} to ${newPath}: ${lastErr.message || lastErr}`, {cause: lastErr});
      }
      //
      // Update the name
      this.name = newName;
      await this.config.saveConfig();
      //
      // Log the operation
      this.log("DEBUG", `Project ${oldName} renamed to ${newName}`, "Project.renameProject");
    }
    catch (err) {
      this.log(warning ? "WARN" : "ERROR", err.message || err, "Project.renameProject");
      throw err;
    }
  }


  /**
   * Reset the TeamWorks state by removing `branches`, `trans`, `TwConfig.json`
   * and `TwConfig.json.bak`, then recreating an empty `branches` folder with
   * correct ownership.
   * @param {Object} params - Request context (unused, kept for signature consistency)
   * @throws {Error} When permissions, removals or folder creation fail
   */
  async resetTW(params)
  {
    let path = Node.path.join(this.user.getProjectsDir(), this.name);
    let warning = false;
    let logData;
    //
    try {
      // First I need to "fix" permissions
      try {
        await this.server.execFileAsRoot("ChownChmod", [this.user.OSUser, path]);
      }
      catch (err) {
        logData = {OSUser: this.user.OSUser, path};
        throw new Error(`Error changing project folder permissions: ${err.message || err}`, {cause: err});
      }
      //
      // I've to delete all this objects
      let objectsToRemove = ["branches", "trans", "TwConfig.json", "TwConfig.json.bak"];
      for (let objPath of objectsToRemove) {
        let obj = Node.path.join(path, objPath);
        try {
          await Node.fs.promises.rm(obj, {recursive: true, force: true});
        }
        catch (err) {
          warning = true;
          throw new Error(`Error while deleting ${obj}: ${err.message || err}`, {cause: err});
        }
      }
      //
      // Create a new branches directory
      try {
        await Node.fs.promises.mkdir(Node.path.join(path, "branches"));
      }
      catch (err) {
        warning = true;
        throw new Error(`Error creating an empty branches directory: ${err.message || err}`, {cause: err});
      }
      //
      // Fix branches directory (it's created by me... I'm not the OSUser)
      try {
        await this.server.execFileAsRoot("ChownChmod", [this.user.OSUser, Node.path.join(path, "branches")]);
      }
      catch (err) {
        logData = {OSUser: this.user.OSUser, path};
        throw new Error(`Error changing branches folder permissions: ${err.message || err}`, {cause: err});
      }
      //
      // Log the operation
      this.log("INFO", "TeamWorks cleared", "Project.resetTW");
    }
    catch (err) {
      this.log(warning ? "WARN" : "ERROR", err.message || err, "Project.resetTW", logData);
      throw err;
    }
  }


  /**
   * Archive a TeamWorks branch to the cloud.
   * The request body is a multipart form whose `branch`, `commits`, `user` and
   * `project` fields describe the branch to archive; the actual work is delegated
   * to a `backupBranch` worker session.
   * @param {Object} params - Request context
   * @param {Request} params.req - Express request carrying the multipart form
   * @throws {Error} When form parsing or the worker session fail
   */
  async backupBranch(params)
  {
    let form = new Node.multiparty.Form();
    //
    // Parse form data
    let fields;
    try {
      fields = await new Promise((resolve, reject) => {
        form.parse(params.req, (err, fields) => err ? reject(err) : resolve(fields));
      });
    }
    catch (err) {
      this.log("ERROR", `Error in form parsing: ${err.message || err}`, "Project.backupBranch");
      throw new Error(`Error in form parsing: ${err.message || err}`, {cause: err});
    }
    //
    // Extract POST data (see request::backupBranch)
    let branch = fields.branch[0];
    let commits = fields.commits[0];
    let user = fields.user[0];
    let project = fields.project[0];
    //
    // Creates a new session that backes up the given branch
    let session = this.server.createSession(this, {type: "backupBranch", branch, commits, user, project, openParams: {version: this.resolveSessionVersion(params.req?.query.version)}});
    await session.waitCompleted();
  }


  /**
   * Restore a TeamWorks branch from the cloud.
   * The request body is a multipart form whose `branch`, optional `message`, optional `pr`,
   * `srcUser`, `srcProject` and `srcCompany` fields describe which branch to restore.
   * The actual work is delegated to a `restoreBranch` worker session; when the operation
   * completes, any live IDE session is notified via the `branchRestored` message so that
   * the TeamWorks UI can refresh.
   * @param {Object} params - Request context
   * @param {Request} params.req - Express request carrying the multipart form
   * @throws {Error} When form parsing fails (the inner session error is propagated via `finally`)
   */
  async restoreBranch(params)
  {
    let form = new Node.multiparty.Form();
    //
    // Parse form data
    let fields;
    try {
      fields = await new Promise((resolve, reject) => {
        form.parse(params.req, (err, fields) => err ? reject(err) : resolve(fields));
      });
    }
    catch (err) {
      this.log("ERROR", `Error in form parsing: ${err.message || err}`, "Project.restoreBranch");
      throw new Error(`Error in form parsing: ${err.message || err}`, {cause: err});
    }
    //
    // Extract POST data (see request::restoreBranch)
    let branch = fields.branch[0];
    let msg = (fields.message ? fields.message[0] : undefined);   // The MESSAGE field is sent only if it was user specified
    let pr = (fields.pr ? fields.pr[0] : undefined);                  // The PR field is sent only if the branch is a PR
    //
    let srcUser = fields.srcUser[0];
    let srcProject = fields.srcProject[0];
    let srcCompany = fields.srcCompany[0];
    //
    // Check if there is an open session for this project. If so, when I've finisched, I can tell
    // the session that it has to update its TeamWorks UI
    let ideSession = this.server.getOpenSession(this, {type: "ide", readOnly: undefined});
    //
    let session = this.server.createSession(this,  {type: "restoreBranch", branch, msg, pr, srcUser, srcProject, srcCompany, openParams: {version: this.resolveSessionVersion(params.req?.query.version)}});
    try {
      await session.waitCompleted();
    }
    finally {
      // If there was an open session, tell her that I need to update TW UI
      ideSession?.sendToChild({
        type: Node.Project.msgTypeMap.branchRestored
      });
    }
  }


  /**
   * Trigger a project build by spawning a `buildProject` worker session and
   * waiting for it to complete. Query-string parameters are forwarded to the session.
   * @param {Object} params - Request context
   * @param {Request} params.req - Express request providing build parameters via `req.query`
   */
  async buildProject(params)
  {
    // Resolve the IDE version to build with on multi-version servers (same rules as editProject).
    // The version selects the child that runs the build, so the app embeds that version's runtime.
    // The parameter is ideVersion (not version) because in the build context "version" would be
    // ambiguous with the app build number (buildVersion)
    let version = this.resolveSessionVersion(params.req.query.ideVersion);
    //
    let session = this.server.createSession(this, {type: "buildProject", params: params.req.query, openParams: {version}});
    await session.waitCompleted();
  }


  /**
   * Remove a previously built output file (`build/project_<version>.json`).
   * @param {Object} params - Request context
   * @param {Request} params.req - Express request; `req.query.buildVersion` identifies the build
   * @throws {Error} When `buildVersion` is missing, contains `..` or the file cannot be removed
   */
  async removeBuild(params)
  {
    let prjBuildPath = Node.path.join(this.user.getProjectsDir(), this.name, "build");
    let buildVersion = params.req.query.buildVersion;
    let warning = false;
    //
    try {
      if (!buildVersion) {
        warning = true;
        throw new Error("Missing buildVersion parameter");
      }
      if ((buildVersion || "").includes("..")) {
        warning = true;
        throw new Error("Double dot operator (..) not allowed");
      }
      //
      let fname = Node.path.join(prjBuildPath, `project_${buildVersion}.json`);
      try {
        await Node.fs.promises.rm(fname, {force: true});
      }
      catch (err) {
        throw new Error(`Error deleting the build ${fname}: ${err.message || err}`, {cause: err});
      }
    }
    catch (err) {
      this.log(warning ? "WARN" : "ERROR", err.message || err, "Project.removeBuild");
      throw err;
    }
  }


  /**
   * Entry point used by the request router to dispatch a command to this project.
   * Thin wrapper around {@link Node.Project#execCommand}.
   * @param {Object} params - Request context
   * @returns {Promise<*>} Whatever the executed command returns
   */
  async processCommand(params)
  {
    return await this.execCommand(params);
  }


  /**
   * Dispatch a project-scoped URL command to the matching handler.
   *
   * Public commands (no AUTK required): `edit`, `view`, `resources`,
   * `files`, `upload`, `backupBranch`, `restoreBranch`.
   *
   * Protected commands (AUTK validated when {@link Node.Config#auth} is enabled):
   * `status`, `config`, `branches`, `commits`, `token`, `resetkeys`, `backup`,
   * `restore`, `rename`, `resetTW`, `build`, `removeBuild`, `filesystem`.
   *
   * @param {Object} params - Request context
   * @param {Request} params.req - Express request
   * @param {Array<String>} params.tokens - URL tokens; `tokens[0]` is the command name
   * @returns {Promise<*>} Whatever the dispatched handler returns
   * @throws {Error} With code 401 when the AUTK does not match, or `Invalid Command` for unknown commands
   */
  async execCommand(params)
  {
    let command = params.tokens[0];
    //
    // Handle commands
    switch (command) {
      case "edit":
        return await this.editProject(params);

      case "view":
        return await this.viewProject(params);

      case "resources":
      case "files":
        return await this.downloadFile(params);

      case "upload":
        return await this.uploadResource(params);

      case "downloadBackup":
        return await this.downloadBackupFile(params);

      case "backupBranch":
        return await this.backupBranch(params);

      case "restoreBranch":
        return await this.restoreBranch(params);

      default:
        this.config.checkAuthorization(params, "Project.execCommand");
        //
        // Valid AUTK (or AUTK not enabled)
        switch (command) {
          case "status":
            return await this.getStatus(params);

          case "config":
            return await this.configure(params);

          case "branches":
          case "commits":
            return await this.teamworksCmd(params);

          case "token":
            return this.setToken(params);

          case "resetkeys":
            return this.resetKeys(params);

          case "backup":
            return await this.backup(params);

          case "restore":
            return await this.restore(params);

          case "rename":
            return await this.renameProject(params);

          case "resetTW":
            return await this.resetTW(params);

          case "build":
            return await this.buildProject(params);

          case "removeBuild":
            return await this.removeBuild(params);

          case "filesystem":
            return await this.handleFileSystem(params);

          default:
            this.log("WARN", "Invalid Command", "Project.execCommand", {cmd: command, url: params.req.originalUrl});
            throw new Error("Invalid Command");
        }
    }
  }
};


// Export module
module.exports = Node.Project;
