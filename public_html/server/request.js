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
 * @class Represents an Instant Developer Request module
 * @param {Node.Config} config
 * @param {Node.Logger} logger
 */
Node.Request = function (config, logger)
{
  this.config = config;
  this.logger = logger;
};


/**
 * POST request
 * @param {obj} options
 * @param {form} form
 * @returns {Promise<{code, data}>}
 */
Node.Request.prototype.postRequest = async function (options, form)
{
  options.method = "POST";
  return await this.httpRequest(options, form);
};


/**
 * GET request
 * @param {obj} options
 * @returns {Promise<{code, data}>}
 */
Node.Request.prototype.getRequest = async function (options)
{
  options.method = "GET";
  return await this.httpRequest(options);
};


/**
 * Executes an HTTP request and queues it if there are pending requests
 * @param {object} options - HTTP request options (protocol, hostname, port, path, method, etc.)
 * @param {FormData} form - Optional form data to be sent with the request
 * @returns {Promise<{code: number, data: string}>} Promise that resolves with status code and response data
 */
Node.Request.prototype.httpRequest = async function (options, form)
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
};


/**
 * Processes all queued HTTP requests sequentially
 */
Node.Request.prototype.processNextHttpRequest = async function ()
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
          let data = "";
          res.on("data", chunk => data += chunk);
          res.on("end", () => resolve({code: res.statusCode, data}));
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
};


/*
 * Send a new auth token to the console
 */
Node.Request.prototype.sendTokenToConsole = async function ()
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
};


/**
 * Send the response of a command to the console
 * @param {string} RID
 * @param {string} code
 * @param {string} text
 */
Node.Request.prototype.sendResponse = async function (RID, code, text)
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
};


/**
 * Send an http request to the console in order to get the parent project name
 * @param {string} userName
 * @param {string} projectName
 */
Node.Request.prototype.getParentProject = async function (userName, projectName)
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
};


/**
 * Send an http request to a server and gets the list of active branches
 * @param {string} userName
 * @param {string} projectName
 */
Node.Request.prototype.getBranches = async function (userName, projectName)
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
};


/**
 * Send an http request to the given server/user/project asking him to send the list of all commits
 * @param {string} userName
 * @param {string} projectName
 * @param {object} params
 */
Node.Request.prototype.getParentCommits = async function (userName, projectName, params)
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
};


/**
 * Get the list of the component
 * @param {string} userName
 */
Node.Request.prototype.getComponents = async function (userName)
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
};


/**
 * Send information to console about the sent application
 * @param {string} userName
 * @param {string} projectName
 * @param {InDe.AComponent} component - component to export
 */
Node.Request.prototype.sendExportedComponent = async function (userName, projectName, component)
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
};


/**
 * Send project information to console
 * @param {string} userName
 * @param {string} projectName
 * @param {string} prjInfo
 */
Node.Request.prototype.sendPrjInfo = async function (userName, projectName, prjInfo)
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
};


/**
 * Send create PR message to console
 * @param {string} userName
 * @param {string} projectName
 * @param {object} prInfo
 */
Node.Request.prototype.sendTwPrInfo = async function (userName, projectName, prInfo)
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
};


/**
 *  Send create commit message to console
 * @param {string} userName
 * @param {string} projectName
 * @param {object} commitInfo
 */
Node.Request.prototype.sendCommitInfo = async function (userName, projectName, commitInfo)
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
};


/**
 * Send course information to console
 * @param {string} RID
 * @param {string} courseData
 */
Node.Request.prototype.sendCourseInfo = async function (RID, courseData)
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
};


/**
 * Send an http request to a server to backup a branch
 * @param {string} branchName
 * @param {object} parentPrjData - data of the parent project (see getParentProject)
 * @param {object} options {commits, user(destination), project(destination)}
 */
Node.Request.prototype.backupBranch = async function (branchName, parentPrjData, options)
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
};


/**
 * Send an http request to a server asking him to restore a branch
 * @param {string} branchName - name of the branch
 * @param {object} parentPrjData - data of the parent project (see getParentProject)
 * @param {object} options - options to be used {msg: message}
 */
Node.Request.prototype.restoreBranch = async function (branchName, parentPrjData, options)
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
};


/*
 * Send request to console to invite users for telecollaboration
 * @param {Object} msg
 */
Node.Request.prototype.inviteUsers = async function (msg)
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
};


/*
 * Ask to console users list
 * @param {Object} msg
 */
Node.Request.prototype.listUsers = async function (msg)
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
};


/**
 * Ask to console if user with given address is online
 * @param {string} address
 */
Node.Request.prototype.isUserOnline = async function (address)
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
};


/*
 * Ask the console to execute a query on a remote server
 * @param {Object} options
 */
Node.Request.prototype.executeRemoteQuery = async function (options)
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
};


/*
 * Ask to console to manage the notification of an issue
 * @param {Object} msg
 */
Node.Request.prototype.notifyIssueCommand = async function (msg)
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
};


/*
 * Ask to console users list
 * @param {Object} msg
 */
Node.Request.prototype.notifyFeedback = async function (msg)
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
};


// Export module
module.exports = Node.Request;
