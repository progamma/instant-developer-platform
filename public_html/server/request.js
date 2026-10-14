/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
var Node = Node || {};

// Import Modules
Node.http = require("http");
Node.https = require("https");
Node.FormData = require("form-data");

// Import Classes
Node.Utils = require("./utils");


/**
 * @class Node.Request
 * @classdesc
 * HTTP request handler for the Instant Developer Cloud framework.
 * Manages all external HTTP/HTTPS communications including console interactions,
 * project synchronization, branch operations, and user management.
 *
 * Key features:
 * - **Request queuing**: Automatically queues and processes HTTP requests sequentially
 * - **Console integration**: Handles authentication and communication with the IDE console
 * - **Project management**: Supports branch operations, commits, and parent project queries
 * - **User collaboration**: Manages user invitations and online status checks
 * - **Remote operations**: Executes queries and operations on remote servers
 *
 * @property {Node.Config} config - Server configuration object
 * @property {Node.Logger} logger - Logger instance for request tracking
 * @property {Array} reqQueue - Queue of pending HTTP requests
 */
Node.Request = class Request
{
  /**
   * @param {Node.Config} config - Server configuration object
   * @param {Node.Logger} logger - Logger instance for request tracking
   */
  constructor(config, logger)
  {
    this.config = config;
    this.logger = logger;
  }


  /**
   * Executes a POST HTTP request.
   * Wrapper method that sets the HTTP method to POST and delegates to httpRequest.
   * @param {Object} options - HTTP request options (protocol, hostname, port, path, headers)
   * @param {Node.FormData} form - Form data to send with the POST request
   * @returns {Promise<{code: Number, data: String}>} Response status code and data
   */
  async postRequest(options, form)
  {
    options.method = "POST";
    return await this.httpRequest(options, form);
  }


  /**
   * Executes a GET HTTP request.
   * Wrapper method that sets the HTTP method to GET and delegates to httpRequest.
   * @param {Object} options - HTTP request options (protocol, hostname, port, path, headers)
   * @returns {Promise<{code: Number, data: String}>} Response status code and data
   */
  async getRequest(options)
  {
    options.method = "GET";
    return await this.httpRequest(options);
  }


  /**
   * Executes an HTTP request with automatic queuing for sequential processing.
   * Ensures requests are processed one at a time to prevent overload.
   * Sets a default timeout of 300 seconds if not specified.
   * @param {Object} options - HTTP request options (protocol, hostname, port, path, method, timeout, headers)
   * @param {Node.FormData} [form] - Optional form data to be sent with the request
   * @returns {Promise<{code: Number, data: String}>} Response status code and data
   * @throws {Error} Throws error if protocol is missing or request fails
   */
  async httpRequest(options, form)
  {
    // If procotol is missing
    if (!options.protocol) {
      this.logger.log("ERROR", "Missing protocol", "Request.httpRequest", {options});
      throw new Error("Missing protocol");
    }
    //
    this.reqQueue = this.reqQueue || [];
    //
    return await new Promise((resolve, reject) => {
      this.reqQueue.push({options, form, resolve, reject});
      //
      // If there is a pending GET/POST request, better wait
      if (this.reqQueue.length === 1)
        this.processNextHttpRequest();
      else
        this.logger.log("WARN", "Pending request -> enqueue", "Request.httpRequest", {options});
    });
  }


  /**
   * Processes all queued HTTP requests sequentially.
   * Dequeues and executes requests one by one, handling errors and timeouts.
   * Automatically cleans up the queue when empty.
   */
  async processNextHttpRequest()
  {
    while (this.reqQueue?.length > 0) {
      let {options, form, resolve, reject} = this.reqQueue[0];
      this.logger.log("INFO", "Handle http request", "Request.processNextHttpRequest", {options, form});
      //
      // Timeout (if not specified -> 300 sec)
      if (options.timeout === undefined)
        options.timeout = 300000;
      //
      try {
        resolve(await new Promise((resolve, reject) => {
          let proto = options.protocol.substring(0, options.protocol.length - 1);
          let req = Node[proto].request(options, res => {
            require("stream/consumers").text(res)
              .then(data => resolve({code: res.statusCode, data}), reject);
          });
          req.on("error", err => reject(err));
          req.on("timeout", () => req.destroy("request timeout"));
          //
          if (form)
            form.pipe(req);
          else
            req.end();
        }));
      }
      catch (err) {
        reject(err);
      }
      finally {
        this.reqQueue.shift();
        if (this.reqQueue.length === 0)
          delete this.reqQueue;
      }
    }
  }


  /**
   * Sends a new authentication token to the console.
   * Generates a unique token and registers this server with the console for remote management.
   */
  async sendTokenToConsole()
  {
    if (!this.config.name)
      return;
    //
    // Generate an AUTK token
    this.config.autk = Node.Utils.generateUID36();
    //
    // Create a form to be sent via post
    let form = new Node.FormData();
    form.append("server", this.config.name);
    form.append("tk", this.config.autk);
    if (this.config.server.version)
      form.append("version", this.config.server.version);
    if (process.env["DOCKER_NAME"])
      form.append("dockerName", process.env["DOCKER_NAME"]);
    //
    let err, code, data, options;
    try {
      // Check if consoleURL is valid before trying to parse it
      if (!this.config.consoleURL)
        throw new Error("Missing consoleURL configuration");
      //
      let consoleUrlParts = new URL(this.config.consoleURL);
      options = {
        protocol: consoleUrlParts.protocol,
        hostname: consoleUrlParts.hostname,
        port: consoleUrlParts.port,
        path: `${consoleUrlParts.pathname}?mode=rest&cmd=idetk`,
        method: "POST",
        headers: form.getHeaders()
      };
      //
      ({code, data} = await this.postRequest(options, form));
    }
    catch (e) {
      err = e;
    }
    //
    if (err || code !== 200)
      this.logger.log(err ? "ERROR" : "WARN", "POST reply error", "Request.sendTokenToConsole", {err, code, data, options});
  }


  /**
   * Sends the response of a command execution back to the console.
   * Used to report results of remote commands initiated by the console.
   * @param {String} RID - Request ID for tracking the response
   * @param {String} code - Response status code
   * @param {String} text - Response text content
   */
  async sendResponse(RID, code, text)
  {
    let form = new Node.FormData();
    form.append("code", code);
    form.append("text", text);
    //
    let err, respCode, data, options;
    try {
      if (!this.config.consoleURL)
        throw new Error("Missing consoleURL configuration");
      //
      let consoleUrlParts = new URL(this.config.consoleURL);
      options = {
        protocol: consoleUrlParts.protocol,
        hostname: consoleUrlParts.hostname,
        port: consoleUrlParts.port,
        path: `${consoleUrlParts.pathname}?mode=rest&cmd=rid&rid=${RID}&autk=${this.config.autk}`,
        method: "POST",
        headers: form.getHeaders()
      };
      //
      ({code: respCode, data} = await this.postRequest(options, form));
    }
    catch (e) {
      err = e;
    }
    //
    if (err || respCode !== 200)
      this.logger.log(err ? "ERROR" : "WARN", "POST reply error", "Request.sendResponse", {err, code: respCode, data, options});
    else
      this.logger.log("DEBUG", "POST reply", "Request.sendResponse", {code, data, options});
  }


  /**
   * Gets the parent project information from the console.
   * Retrieves the original project details for forked or cloned projects.
   * @param {String} userName - User name of the project owner
   * @param {String} projectName - Name of the project
   * @returns {Promise<Object>} Parent project data including server URL and authentication
   * @throws {Error} Throws error if project not found or invalid response
   */
  async getParentProject(userName, projectName)
  {
    let code, data, options, warning;
    try {
      if (!this.config.consoleURL)
        throw new Error("Missing consoleURL configuration");
      //
      let consoleUrlParts = new URL(this.config.consoleURL);
      options = {
        protocol: consoleUrlParts.protocol,
        hostname: consoleUrlParts.hostname,
        port: consoleUrlParts.port,
        path: `${consoleUrlParts.pathname}?mode=rest&cmd=parent&username=${userName}&projectname=${projectName}&company=${this.config.serverType}&autk=${this.config.autk}`,
        method: "GET"
      };
      //
      ({code, data} = await this.getRequest(options));
      //
      if (code === 404)
        throw new Error("Project not found");
      //
      if (code !== 200) {
        warning = true;
        throw new Error("Invalid response");
      }
      //
      // Maybe the system answered 200-OK but with an HTML file (like when it's updating)
      // Better check if the answer is a JSON string... I don't want to crash everything
      return JSON.parse(data);
    }
    catch (err) {
      this.logger.log(warning ? "WARN" : "ERROR", "GET reply error", "Request.getParentProject", {err, code, data, options});
      throw err;
    }
  }


  /**
   * Gets the list of active branches for a project.
   * Retrieves branch information from the parent project server.
   * @param {String} userName - User name of the project owner
   * @param {String} projectName - Name of the project
   * @returns {Promise<{branches: Array, user: String, project: String}>} Branch list and project info
   * @throws {Error} Throws error if server communication fails
   */
  async getBranches(userName, projectName)
  {
    // First ask the console where is the parent project
    let data = await this.getParentProject(userName, projectName);
    //
    if (!data)
      return;
    //
    let err, code, branches, options;
    try {
      if (!data.server)
        throw new Error("Missing server URL in parent project data");
      //
      // Parse SERVER url and perpare re
      let urlParts = new URL(data.server);
      options = {
        protocol: urlParts.protocol,
        hostname: urlParts.hostname,
        port: urlParts.port,
        path: `/${data.user}/${data.project}/branches?autk=${data.autk}`,
        method: "GET"
      };
      //
      ({code, data: branches} = await this.getRequest(options));
    }
    catch (e) {
      err = e;
    }
    //
    if (err || code !== 200) {
      this.logger.log(err ? "ERROR" : "WARN", "GET reply error", "Request.getBranches", {err, code, data: branches, options});
      if (!err)
        err = new Error("Invalid response");
    }
    //
    if (err)
      throw err;
    //
    return {
      branches: JSON.parse(branches),
      user: data.user,
      project: data.project
    };
  }


  /**
   * Gets the list of commits from the parent project.
   * Retrieves commit history for a specific branch from the parent server.
   * @param {String} userName - User name of the project owner
   * @param {String} projectName - Name of the project
   * @param {Object} params - Parameters including branch name
   * @returns {Promise<Array>} Array of commit IDs
   * @throws {Error} Throws error if request fails
   */
  async getParentCommits(userName, projectName, params)
  {
    let data = await this.getParentProject(userName, projectName);
    //
    if (!data)
      return [];
    //
    let err, code, commits, options;
    try {
      if (!data.server)
        throw new Error("Missing server URL in parent project data");
      //
      let urlParts = new URL(data.server);
      options = {
        protocol: urlParts.protocol,
        hostname: urlParts.hostname,
        port: urlParts.port,
        path: `/${data.user}/${data.project}/commits?onlyID=true&branch=${encodeURIComponent(params.branch)}&autk=${data.autk}`,
        method: "GET"
      };
      //
      ({code, data: commits} = await this.getRequest(options));
    }
    catch (e) {
      err = e;
    }
    //
    if (err || code !== 200) {
      this.logger.log(err ? "ERROR" : "WARN", "POST reply error", "Request.getCommits", {err, code, data: commits, options});
      if (!err)
        err = new Error("Invalid response");
    }
    //
    if (err)
      throw err;
    //
    return JSON.parse(commits).commits;
  }


  /**
   * Gets the list of components available to a user.
   * Retrieves component information from the console.
   * @param {String} userName - User name to get components for
   * @returns {Promise<Array>} Array of component objects
   * @throws {Error} Throws error if request fails
   */
  async getComponents(userName)
  {
    let err, code, data, options;
    try {
      if (!this.config.consoleURL)
        throw new Error("Missing consoleURL configuration");
      //
      let consoleUrlParts = new URL(this.config.consoleURL);
      options = {
        protocol: consoleUrlParts.protocol,
        hostname: consoleUrlParts.hostname,
        port: consoleUrlParts.port,
        path: `${consoleUrlParts.pathname}?mode=rest&cmd=compList&user=${userName}&company=${this.config.serverType}&autk=${this.config.autk}`,
        method: "GET"
      };
      //
      ({code, data} = await this.getRequest(options));
    }
    catch (e) {
      err = e;
    }
    //
    if (err || code !== 200) {
      this.logger.log(err ? "ERROR" : "WARN", "POST reply error", "Request.getComponents", {err, code, data, options});
      if (!err)
        err = new Error("Invalid response");
    }
    //
    if (err)
      throw err;
    //
    return JSON.parse(data).cmpList;
  }


  /**
   * Sends exported component information to the console.
   * Notifies the console about a component that has been exported from a project.
   * @param {String} userName - User name of the project owner
   * @param {String} projectName - Name of the project
   * @param {Object} component - Component object containing id, name, description, and version
   * @throws {Error} Throws error if request fails
   */
  async sendExportedComponent(userName, projectName, component)
  {
    let form = new Node.FormData();
    form.append("user", userName);
    form.append("project", projectName);
    form.append("company", this.config.serverType);
    form.append("componentName", component.name);
    if (component.description)
      form.append("componentDescription", component.description);
    form.append("componentID", component.id);
    if (component.version)
      form.append("componentVersion", component.version);
    //
    let err, code, data, options;
    try {
      if (!this.config.consoleURL)
        throw new Error("Missing consoleURL configuration");
      //
      let consoleUrlParts = new URL(this.config.consoleURL);
      options = {
        protocol: consoleUrlParts.protocol,
        hostname: consoleUrlParts.hostname,
        port: consoleUrlParts.port,
        path: `${consoleUrlParts.pathname}?mode=rest&cmd=comp&autk=${this.config.autk}`,
        method: "POST",
        headers: form.getHeaders()
      };
      //
      ({code, data} = await this.postRequest(options, form));
    }
    catch (e) {
      err = e;
    }
    //
    if (err || code !== 200) {
      this.logger.log(err ? "ERROR" : "WARN", "POST reply error", "Request.sendExportedComponent", {err, code, data, options});
      if (!err)
        err = new Error("Invalid response");
    }
    //
    if (err)
      throw err;
  }


  /**
   * Sends project information to the console.
   * Updates the console with current project metadata and status.
   * @param {String} userName - User name of the project owner
   * @param {String} projectName - Name of the project
   * @param {String} prjInfo - Serialized project information
   * @throws {Error} Throws error if request fails
   */
  async sendPrjInfo(userName, projectName, prjInfo)
  {
    let form = new Node.FormData();
    form.append("user", userName);
    form.append("project", projectName);
    form.append("company", this.config.serverType);
    form.append("prjInfo", prjInfo);
    //
    let err, code, data, options;
    try {
      if (!this.config.consoleURL)
        throw new Error("Missing consoleURL configuration");
      //
      let consoleUrlParts = new URL(this.config.consoleURL);
      options = {
        protocol: consoleUrlParts.protocol,
        hostname: consoleUrlParts.hostname,
        port: consoleUrlParts.port,
        path: `${consoleUrlParts.pathname}?mode=rest&cmd=prjInfo&autk=${this.config.autk}`,
        method: "POST",
        headers: form.getHeaders()
      };
      //
      ({code, data} = await this.postRequest(options, form));
    }
    catch (e) {
      err = e;
    }
    //
    if (err || code !== 200) {
      this.logger.log(err ? "ERROR" : "WARN", "POST reply error", "Request.sendPrjInfo", {err, code, data, options});
      if (!err)
        err = new Error("Invalid response");
    }
    //
    if (err)
      throw err;
  }


  /**
   * Sends pull request information to the console.
   * Notifies the console about a new or updated pull request.
   * @param {String} userName - User name of the project owner
   * @param {String} projectName - Name of the project
   * @param {Object} prInfo - Pull request information object
   * @throws {Error} Throws error if request fails
   */
  async sendTwPrInfo(userName, projectName, prInfo)
  {
    let form = new Node.FormData();
    form.append("user", userName);
    form.append("project", projectName);
    form.append("company", this.config.serverType);
    form.append("prInfo", JSON.stringify(prInfo));
    //
    let err, code, data, options;
    try {
      if (!this.config.consoleURL)
        throw new Error("Missing consoleURL configuration");
      //
      let consoleUrlParts = new URL(this.config.consoleURL);
      options = {
        protocol: consoleUrlParts.protocol,
        hostname: consoleUrlParts.hostname,
        port: consoleUrlParts.port,
        path: `${consoleUrlParts.pathname}?mode=rest&cmd=pr&autk=${this.config.autk}`,
        method: "POST",
        headers: form.getHeaders()
      };
      //
      ({code, data} = await this.postRequest(options, form));
    }
    catch (e) {
      err = e;
    }
    //
    if (err || code !== 200) {
      this.logger.log(err ? "ERROR" : "WARN", "POST reply error", "Request.sendTwPrInfo", {err, code, data, options});
      if (!err)
        err = new Error("Invalid response");
    }
    //
    if (err)
      throw err;
  }


  /**
   * Sends commit information to the console.
   * Notifies the console about a new commit in the project.
   * @param {String} userName - User name of the project owner
   * @param {String} projectName - Name of the project
   * @param {Object} commitInfo - Commit information object
   * @throws {Error} Throws error if request fails
   */
  async sendCommitInfo(userName, projectName, commitInfo)
  {
    let form = new Node.FormData();
    form.append("user", userName);
    form.append("project", projectName);
    form.append("company", this.config.serverType);
    form.append("commitInfo", JSON.stringify(commitInfo));
    //
    let err, code, data, options;
    try {
      if (!this.config.consoleURL)
        throw new Error("Missing consoleURL configuration");
      //
      let consoleUrlParts = new URL(this.config.consoleURL);
      options = {
        protocol: consoleUrlParts.protocol,
        hostname: consoleUrlParts.hostname,
        port: consoleUrlParts.port,
        path: `${consoleUrlParts.pathname}?mode=rest&cmd=commit&autk=${this.config.autk}`,
        method: "POST",
        headers: form.getHeaders()
      };
      //
      ({code, data} = await this.postRequest(options, form));
    }
    catch (e) {
      err = e;
    }
    //
    if (err || code !== 200) {
      this.logger.log(err ? "ERROR" : "WARN", "POST reply error", "Request.sendCommitInfo", {err, code, data, options});
      if (!err)
        err = new Error("Invalid response");
    }
    //
    if (err)
      throw err;
  }


  /**
   * Publishes the snapshot of a branch after a PR merge.
   * Counterpart of {@link Node.TwGCloudDriver#uploadMergedHead}, called by
   * TwManager.merge on whichever driver the project has.
   *
   * No-op here: the snapshot a fork starts from exists only on the IDS bucket.
   * On IDC the fork is created by the console from the project on the server,
   * so there is nothing to realign.
   * @param {String} branchName - Branch whose HEAD has just been realigned
   */
  async uploadMergedHead(branchName)
  {
  }


  /**
   * Sends course information to the console.
   * Reports course-related data back to the console using the request ID.
   * @param {String} RID - Request ID for tracking the response
   * @param {String} courseData - Serialized course data
   * @throws {Error} Throws error if request fails
   */
  async sendCourseInfo(RID, courseData)
  {
    let form = new Node.FormData();
    form.append("text", JSON.stringify({courseData: JSON.parse(courseData)}));
    form.append("code", "200");
    //
    let err, code, data, options;
    try {
      if (!this.config.consoleURL)
        throw new Error("Missing consoleURL configuration");
      //
      let consoleUrlParts = new URL(this.config.consoleURL);
      options = {
        protocol: consoleUrlParts.protocol,
        hostname: consoleUrlParts.hostname,
        port: consoleUrlParts.port,
        path: `${consoleUrlParts.pathname}?mode=rest&cmd=rid&rid=${RID}&autk=${this.config.autk}`,
        method: "POST",
        headers: form.getHeaders()
      };
      //
      ({code, data} = await this.postRequest(options, form));
    }
    catch (e) {
      err = e;
    }
    //
    if (err || code !== 200) {
      this.logger.log(err ? "ERROR" : "WARN", "POST reply error", "Request.sendCourseInfo", {err, code, data, options});
      if (!err)
        err = new Error("Invalid response");
    }
    //
    if (err)
      throw err;
  }


  /**
   * Backs up a branch to another project.
   * Creates a backup of the specified branch with its commits in the destination project.
   * @param {String} branchName - Name of the branch to backup
   * @param {Object} parentPrjData - Parent project data from getParentProject()
   * @param {Object} options - Backup options with commits, destination user and project
   * @throws {Error} Throws error if backup fails
   */
  async backupBranch(branchName, parentPrjData, options)
  {
    let form = new Node.FormData();
    form.append("branch", branchName);
    form.append("commits", options.commits);
    form.append("user", options.user);          // User that will receive this branch
    form.append("project", options.project);    // Project that will receive this branch
    //
    let err, code, data, postOpt;
    try {
      if (!parentPrjData.server)
        throw new Error("Missing server URL in parent project data");
      //
      let urlParts = new URL(parentPrjData.server);
      postOpt = {
        protocol: urlParts.protocol,
        hostname: urlParts.hostname,
        port: urlParts.port,
        path: `/${parentPrjData.user}/${parentPrjData.project}/backupBranch`,
        method: "POST",
        headers: form.getHeaders()
      };
      //
      ({code, data} = await this.postRequest(postOpt, form));
    }
    catch (e) {
      err = e;
    }
    //
    if (err || code !== 200) {
      this.logger.log(err ? "ERROR" : "WARN", "POST reply error", "Request.backupBranch", {err, code, data, options: postOpt});
      if (!err)
        err = new Error("Invalid response");
    }
    //
    if (err)
      throw err;
  }


  /**
   * Restores a branch from a backup.
   * Restores a previously backed up branch to the parent project, optionally creating a pull request.
   * @param {String} branchName - Name of the branch to restore
   * @param {Object} parentPrjData - Parent project data from getParentProject()
   * @param {Object} options - Restore options including message, PR flag, and source project info
   * @throws {Error} Throws error if restore fails
   */
  async restoreBranch(branchName, parentPrjData, options)
  {
    let form = new Node.FormData();
    form.append("branch", branchName);
    if (options.msg)
      form.append("message", options.msg);
    if (options.pr)
      form.append("pr", "1");
    //
    // Send owner's (i.e. src) data as well
    form.append("srcUser", options.srcUser);
    form.append("srcProject", options.srcProject);
    form.append("srcCompany", options.srcCompany);
    //
    let err, code, data, postOpt;
    try {
      if (!parentPrjData.server)
        throw new Error("Missing server URL in parent project data");
      //
      let urlParts = new URL(parentPrjData.server);
      postOpt = {
        protocol: urlParts.protocol,
        hostname: urlParts.hostname,
        port: urlParts.port,
        path: `/${parentPrjData.user}/${parentPrjData.project}/restoreBranch`,
        method: "POST",
        headers: form.getHeaders()
      };
      //
      ({code, data} = await this.postRequest(postOpt, form));
    }
    catch (e) {
      err = e;
    }
    //
    if (err || code !== 200) {
      this.logger.log(err ? "ERROR" : "WARN", "POST reply error", "Request.restoreBranch", {err, code, data, options: postOpt});
      if (!err)
        err = new Error("Invalid response");
    }
    //
    if (err)
      throw err;
  }


  /**
   * Invites users for telecollaboration.
   * Sends a request to the console to invite multiple users for remote collaboration sessions.
   * @param {Object} msg - Invitation message containing user information
   * @param {String} msg.userName - Username of the inviter
   * @param {Array} msg.users - Array of users to invite for telecollaboration
   * @throws {Error} Throws error if invitation fails
   */
  async inviteUsers(msg)
  {
    // Create a form to be sent via post
    let form = new Node.FormData();
    form.append("user", msg.userName);
    form.append("users", JSON.stringify(msg.users));
    //
    let err, code, data, options;
    try {
      if (!this.config.consoleURL)
        throw new Error("Missing consoleURL configuration");
      //
      let consoleUrlParts = new URL(this.config.consoleURL);
      options = {
        protocol: consoleUrlParts.protocol,
        hostname: consoleUrlParts.hostname,
        port: consoleUrlParts.port,
        path: `${consoleUrlParts.pathname}?mode=rest&cmd=inviteUsers&autk=${this.config.autk}`,
        method: "POST",
        headers: form.getHeaders()
      };
      //
      ({code, data} = await this.postRequest(options, form));
    }
    catch (e) {
      err = e;
    }
    //
    if (err || code !== 200) {
      this.logger.log(err ? "ERROR" : "WARN", "POST reply error", "Request.inviteUsers", {err, code, data, options});
      if (!err)
        err = new Error("Invalid response");
    }
    //
    if (err)
      throw err;
  }


  /**
   * Lists users from the console.
   * Retrieves a filtered list of users based on search criteria and organization settings.
   * @param {Object} msg - Search criteria for listing users
   * @param {String} msg.user - Current user making the request
   * @param {String} msg.matchingString - String to filter users by name or email
   * @param {Boolean} msg.organizationOnly - Whether to list only organization users
   * @param {Boolean} msg.onlineStatus - Whether to include online status information
   * @returns {Object} JSON object containing the list of matching users
   * @throws {Error} Throws error if the request fails
   */
  async listUsers(msg)
  {
    // Create a form to be sent via post
    let form = new Node.FormData();
    form.append("user", msg.user);
    form.append("company", this.config.serverType);
    form.append("matchingString", msg.matchingString);
    form.append("organizationOnly", (msg.organizationOnly ? 1 : 0));
    form.append("onlineStatus", (msg.onlineStatus ? 1 : 0));
    //
    let code, data, options, warning;
    try {
      if (!this.config.consoleURL)
        throw new Error("Missing consoleURL configuration");
      //
      let consoleUrlParts = new URL(this.config.consoleURL);
      options = {
        protocol: consoleUrlParts.protocol,
        hostname: consoleUrlParts.hostname,
        port: consoleUrlParts.port,
        path: `${consoleUrlParts.pathname}?mode=rest&cmd=listUsers&autk=${this.config.autk}`,
        method: "POST",
        headers: form.getHeaders()
      };
      //
      ({code, data} = await this.postRequest(options, form));
      //
      if (code !== 200) {
        warning = true;
        throw new Error("Invalid response");
      }
      //
      return JSON.parse(data);
    }
    catch (err) {
      this.logger.log(warning ? "WARN" : "ERROR", "POST reply error", "Request.listUsers", {err, code, data, options});
      throw err;
    }
  }


  /**
   * Checks if a user is online.
   * Queries the console to determine if a user with the given email address is currently online.
   * @param {String} address - Email address of the user to check
   * @returns {Object} JSON object containing the user's online status
   * @throws {Error} Throws error if the request fails
   */
  async isUserOnline(address)
  {
    let code, data, options, warning;
    try {
      if (!this.config.consoleURL)
        throw new Error("Missing consoleURL configuration");
      //
      let consoleUrlParts = new URL(this.config.consoleURL);
      options = {
        protocol: consoleUrlParts.protocol,
        hostname: consoleUrlParts.hostname,
        port: consoleUrlParts.port,
        path: `${consoleUrlParts.pathname}?mode=rest&cmd=isUserOnline&email=${address}&autk=${this.config.autk}`,
        method: "GET"
      };
      //
      ({code, data} = await this.getRequest(options));
      //
      if (code !== 200) {
        warning = true;
        throw new Error("Invalid response");
      }
      return JSON.parse(data);
    }
    catch (err) {
      this.logger.log(warning ? "WARN": "ERROR", "POST reply error", "Request.isUserOnline", {err, code, data, options});
      throw err;
    }
  }


  /**
   * Executes a query on a remote database server.
   * Sends a SQL query to be executed on a remote server through the console REST API.
   * @param {Object} options - Query execution options
   * @param {String} options.server - Database server identifier
   * @param {String} options.database - Database name
   * @param {String} options.sql - SQL query to execute
   * @returns {Object} Query result data from the remote server
   * @throws {Error} Throws error if query execution fails
   */
  async executeRemoteQuery(options)
  {
    // Create a form to be sent via post
    let form = new Node.FormData();
    form.append("server", options.server);
    form.append("database", options.database);
    form.append("sql", encodeURIComponent(options.sql));
    //
    let err, code, data, postOpt;
    try {
      if (!this.config.consoleURL)
        throw new Error("Missing consoleURL configuration");
      //
      let consoleUrlParts = new URL(this.config.consoleURL);
      postOpt = {
        protocol: consoleUrlParts.protocol,
        hostname: consoleUrlParts.hostname,
        port: consoleUrlParts.port,
        path: `${consoleUrlParts.pathname}?mode=rest&cmd=query&autk=${this.config.autk}`,
        method: "POST",
        headers: form.getHeaders()
      };
      //
      ({code, data} = await this.postRequest(postOpt, form));
    }
    catch (e) {
      err = e;
    }
    //
    if (err || code !== 200) {
      this.logger.log(err ? "ERROR" : "WARN", "POST reply error", "Request.executeRemoteQuery", {err, code, data, postOpt});
      if (!err)
        err = new Error("Invalid response");
    }
    //
    if (err)
      throw err;
    //
    return data;
  }


  /**
   * Manages issue notifications through the console.
   * Handles various issue notification commands including enabling/disabling notifications,
   * notifying about issues, and checking notification status.
   * @param {Object} msg - Issue notification message
   * @param {String} msg.cmd - Command type ('changeIssueNotification', 'notifyIssue', 'checkIssueNotification')
   * @param {String} [msg.username] - Username for notification changes
   * @param {String} [msg.projectName] - Project name
   * @param {String} [msg.projectJSONID] - Project JSON identifier
   * @param {String} [msg.issueID] - Issue identifier
   * @param {Boolean} [msg.enabled] - Whether notifications are enabled
   * @param {Object} [msg.issuesJSON] - JSON data for issues to notify
   * @param {String} [msg.issuesID] - Comma-separated issue IDs
   * @param {String} [msg.forkChainID] - Fork chain identifier
   * @returns {Object} JSON response from the console
   * @throws {Error} Throws error if notification command fails
   */
  async notifyIssueCommand(msg)
  {
    // Create a form to be sent via post
    let form = new Node.FormData();
    let cmd = msg.cmd;
    switch (cmd) {
      case "changeIssueNotification":
        form.append("username", msg.username);
        form.append("company", this.config.serverType);
        form.append("projectName", msg.projectName);
        form.append("projectID", msg.projectJSONID);
        form.append("issueID", msg.issueID);
        form.append("enabled", msg.enabled ? 1 : 0);
        if (msg.forkChainID)
          form.append("forkChainID", msg.forkChainID);
        break;

      case "notifyIssue":
        form.append("issuesJSON", JSON.stringify(msg.issuesJSON));
        break;

      case "checkIssueNotification":
        form.append("username", msg.username);
        form.append("company", this.config.serverType);
        form.append("projectName", msg.projectName);
        form.append("projectID", msg.projectJSONID);
        form.append("issuesID", msg.issuesID);
        if (msg.forkChainID)
          form.append("forkChainID", msg.forkChainID);
        break;
    }
    //
    let code, data, options, warning;
    try {
      if (!this.config.consoleURL)
        throw new Error("Missing consoleURL configuration");
      //
      let consoleUrlParts = new URL(this.config.consoleURL);
      options = {
        protocol: consoleUrlParts.protocol,
        hostname: consoleUrlParts.hostname,
        port: consoleUrlParts.port,
        path: `${consoleUrlParts.pathname}?mode=rest&cmd=${cmd}&autk=${this.config.autk}`,
        method: "POST",
        headers: form.getHeaders()
      };
      //
      ({code, data} = await this.postRequest(options, form));
      //
      if (code !== 200) {
        warning = true;
        throw new Error("Invalid response");
      }
      //
      return JSON.parse(data);
    }
    catch (err) {
      this.logger.log(warning ? "WARN" : "ERROR", "POST reply error", "Request.notifyIssueCommand", {err, code, data, options});
      throw err;
    }
  }


  /**
   * Sends feedback notification to the console.
   * Notifies the console about user feedback or issue updates.
   * @param {Object} msg - Feedback message containing issue information
   * @throws {Error} Throws error if notification fails
   */
  async notifyFeedback(msg)
  {
    // Create a form to be sent via post
    let form = new Node.FormData();
    form.append("issuesJSON", JSON.stringify(msg));
    //
    let err, code, data, options;
    try {
      if (!this.config.consoleURL)
        throw new Error("Missing consoleURL configuration");
      //
      let consoleUrlParts = new URL(this.config.consoleURL);
      options = {
        protocol: consoleUrlParts.protocol,
        hostname: consoleUrlParts.hostname,
        port: consoleUrlParts.port,
        path: `${consoleUrlParts.pathname}?mode=rest&cmd=notifyIssue&autk=${this.config.autk}`,
        method: "POST",
        headers: form.getHeaders()
      };
      //
      ({code, data} = await this.postRequest(options, form));
    }
    catch (e) {
      err = e;
    }
    //
    if (err || code !== 200) {
      this.logger.log(err ? "ERROR" : "WARN", "POST reply error", "Request.notifyFeedback", {err, code, data, options});
      if (!err)
        err = new Error("Invalid response");
    }
    //
    if (err)
      throw err;
    //
    return data;
  }
};


// Export module
module.exports = Node.Request;
