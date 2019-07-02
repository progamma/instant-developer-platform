/*
 * Instant Developer Next
 * Copyright Pro Gamma Spa 2000-2016
 * All rights reserved
 */
/* global require, module */

var Node = Node || {};

// Import Modules
Node.http = require("http");
Node.https = require("https");
Node.url = require("url");
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
 * @param {callback} callback - function(statusCode, data, err)
 */
Node.Request.prototype.postRequest = function (options, form, callback)
{
  // Set method to POST
  options.method = "POST";
  //
  var readReply = function (res) {
    var data = "";
    res.on("data", function (chunk) {
      data += chunk;
    });
    res.on("end", function () {
      callback(res.statusCode, data);
    });
  };
  //
  // If procotol is missing
  if (!options.protocol) {
    this.logger.log("ERROR", "Missing protocol", "Request.postRequest", {options: options});
    return callback(null, null, "Missing protocol");
  }
  //
  var proto = options.protocol.substring(0, options.protocol.length - 1);
  var req = Node[proto].request(options, readReply);
  req.on("error", function (err) {
    callback(null, null, err);
  });
  //
  form.pipe(req);
};


/**
 * GET request
 * @param {obj} options
 * @param {callback} callback - function(statusCode, data, err)
 */
Node.Request.prototype.getRequest = function (options, callback)
{
  // Set method to GET
  options.method = "GET";
  //
  var readReply = function (res) {
    var data = "";
    res.on("data", function (chunk) {
      data += chunk;
    });
    res.on("end", function () {
      callback(res.statusCode, data);
    });
  };
  //
  // If procotol is missing
  if (!options.protocol) {
    this.logger.log("ERROR", "Missing protocol", "Request.getRequest", {options: options});
    return callback(null, null, "Missing protocol");
  }
  //
  var proto = options.protocol.substring(0, options.protocol.length - 1);
  var req = Node[proto].request(options, readReply);
  req.on("error", function (err) {
    callback(null, null, err);
  });
  req.end();
};


/*
 * Send a new auth token to the console
 */
Node.Request.prototype.sendTokenToConsole = function ()
{
  var pthis = this;
  //
  // Generate an AUTK token
  this.config.autk = Node.Utils.generateUID36();
  //
  // Create a form to be sent via post
  var form = new Node.FormData();
  form.append("server", this.config.name);
  form.append("tk", this.config.autk);
  //
  var consoleUrlParts = Node.url.parse(this.config.consoleURL || "");
  var options = {
    protocol: consoleUrlParts.protocol,
    hostname: consoleUrlParts.hostname,
    port: consoleUrlParts.port,
    path: consoleUrlParts.pathname + "?mode=rest&cmd=idetk",
    method: "POST",
    headers: form.getHeaders()
  };
  //
  this.postRequest(options, form, function (code, data, err) {
    if (err || code !== 200)
      pthis.logger.log((err ? "ERROR" : "WARN"), "POST reply error", "Request.sendTokenToConsole",
              {err: err, code: code, data: data, options: options});
  });
};


/**
 * Send the response of a command to the console
 * @param {string} RID
 * @param {string} code
 * @param {string} text
 */
Node.Request.prototype.sendResponse = function (RID, code, text)
{
  var pthis = this;
  //
  var form = new Node.FormData();
  form.append("code", code);
  form.append("text", text);
  //
  var consoleUrlParts = Node.url.parse(this.config.consoleURL || "");
  var options = {
    protocol: consoleUrlParts.protocol,
    hostname: consoleUrlParts.hostname,
    port: consoleUrlParts.port,
    path: consoleUrlParts.pathname + "?mode=rest&cmd=rid&rid=" + RID + "&autk=" + this.config.autk,
    method: "POST",
    headers: form.getHeaders()
  };
  //
  this.postRequest(options, form, function (code, data, err) {
    if (err || code !== 200)
      pthis.logger.log((err ? "ERROR" : "WARN"), "POST reply error", "Request.sendResponse",
              {err: err, code: code, data: data, options: options});
    else
      pthis.logger.log("DEBUG", "POST reply", "Request.sendResponse", {code: code, data: data, options: options});
  });
};


/**
 * Send an http request to the console in order to get the parent project name
 * @param {string} userName
 * @param {string} projectName
 * @param {function} callback - function(data, err)
 */
Node.Request.prototype.getParentProject = function (userName, projectName, callback)
{
  // TODO: Eliminare
  if (this.config.local && projectName.substring(0, 27) === "cloud-control-center-forked")
    return callback({server: "http://127.0.0.1:8081", project: "cloud-control-center", user: "lucabaldini"});
  if (this.config.local && projectName.substring(0, 16) === "cccmaster-forked")
    return callback({server: "http://127.0.0.1:8081", project: "cccmaster", user: "diego"});
  if (this.config.local && projectName.substring(0, 17) === "cccmaster-forked2")
    return callback({server: "http://127.0.0.1:8081", project: "cccmaster", user: "diego"});
  //
  var pthis = this;
  //
  var consoleUrlParts = Node.url.parse(this.config.consoleURL || "");
  var options = {
    protocol: consoleUrlParts.protocol,
    hostname: consoleUrlParts.hostname,
    port: consoleUrlParts.port,
    path: consoleUrlParts.pathname + "?mode=rest&cmd=parent&username=" + userName + "&projectname=" +
            projectName + "&company=" + this.config.serverType + "&autk=" + this.config.autk,
    method: "GET"
  };
  this.getRequest(options, function (code, data, err) {
    if (code === 404)
      callback(null, "Project not found");
    else if (err || code !== 200) {
      pthis.logger.log((err ? "ERROR" : "WARN"), "GET reply error", "Request.getParentProject", {err: err, code: code, data: data, options: options});
      callback(null, err || "Invalid response");
    }
    else {
      // Maybe the system answered 200-OK but with an HTML file (like when it's updating)
      // Better check if the answer is a JSON string... I don't want to crash everything
      try {
        callback(JSON.parse(data));
      }
      catch (ex) {
        pthis.logger.log("ERROR", "GET reply error", "Request.getParentProject", {data: data, code: code, options: options});
        callback(null, "Invalid response");
      }
    }
  });
};


/**
 * Send an http request to a server and gets the list of active branches
 * @param {string} userName
 * @param {string} projectName
 * @param {function} callback - function(data, err)
 */
Node.Request.prototype.getBranches = function (userName, projectName, callback)
{
  var pthis = this;
  //
  // First ask the console where is the parent project
  this.getParentProject(userName, projectName, function (data, err) {
    if (err)
      return callback(null, err);
    //
    if (data) {
      // Parse SERVER url and perpare re
      var urlParts = Node.url.parse(data.server);
      var options = {
        protocol: urlParts.protocol,
        hostname: urlParts.hostname,
        port: urlParts.port,
        path: "/" + data.user + "/" + data.project + "/branches?autk=" + data.autk,
        method: "GET"
      };
      //
      pthis.getRequest(options, function (code, branches, err) {
        if (err || code !== 200) {
          pthis.logger.log((err ? "ERROR" : "WARN"), "GET reply error", "Request.getBranches",
                  {err: err, code: code, data: branches, options: options});
          callback(null, err || "Invalid response");
        }
        else
          callback({branches: JSON.parse(branches), user: data.user, project: data.project});
      });
    }
  });
};


/**
 * Send an http request to the given server/user/project asking him to send the list of all commits
 * @param {string} userName
 * @param {string} projectName
 * @param {object} params
 * @param {function} callback - function(data, err)
 */
Node.Request.prototype.getParentCommits = function (userName, projectName, params, callback)
{
  var pthis = this;
  //
  this.getParentProject(userName, projectName, function (data, err) {
    if (err)
      return callback(null, err);
    //
    if (data) {
      var urlParts = Node.url.parse(data.server);
      var options = {
        protocol: urlParts.protocol,
        hostname: urlParts.hostname,
        port: urlParts.port,
        path: "/" + data.user + "/" + data.project + "/commits?onlyID=true&branch=" + encodeURIComponent(params.branch) + "&autk=" + data.autk,
        method: "GET"
      };
      //
      pthis.getRequest(options, function (code, commits, err) {
        if (err || code !== 200) {
          pthis.logger.log((err ? "ERROR" : "WARN"), "GET reply error", "Request.getCommits",
                  {err: err, code: code, data: commits, options: options});
          callback(null, err || "Invalid response");
        }
        else
          callback(JSON.parse(commits).commits);
      });
    }
  });
};


/**
 * Get the list of the component
 * @param {string} userName
 * @param {function} callback - function(data, err)
 */
Node.Request.prototype.getComponents = function (userName, callback)
{
  var pthis = this;
  //
  var consoleUrlParts = Node.url.parse(this.config.consoleURL || "");
  var options = {
    protocol: consoleUrlParts.protocol,
    hostname: consoleUrlParts.hostname,
    port: consoleUrlParts.port,
    path: consoleUrlParts.pathname + "?mode=rest&cmd=compList&user=" + userName + "&company=" + this.config.serverType + "&autk=" + this.config.autk,
    method: "GET"
  };
  this.getRequest(options, function (code, data, err) {
    if (err || code !== 200) {
      pthis.logger.log((err ? "ERROR" : "WARN"), "GET reply error", "Request.getComponents", {err: err, code: code, data: data, options: options});
      callback(null, err || "Invalid response");
    }
    else {
      // Maybe the system answered 200-OK but with an HTML file (like when it's updating)
      // Better check if the answer is a JSON string... I don't want to crash everything
      try {
        var cmpList = JSON.parse(data).cmpList;
        callback(cmpList);
      }
      catch (ex) {
        pthis.logger.log("ERROR", "GET reply error", "Request.getComponents", {data: data, code: code, options: options});
        callback(null, "Invalid response");
      }
    }
  });
};


/**
 * Send information to console about the sent application
 * @param {string} userName
 * @param {string} projectName
 * @param {InDe.AComponent} component - component to export
 * @param {function} callback - function(err)
 */
Node.Request.prototype.sendExportedComponent = function (userName, projectName, component, callback)
{
  var pthis = this;
  //
  var form = new Node.FormData();
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
  var consoleUrlParts = Node.url.parse(this.config.consoleURL || "");
  var options = {
    protocol: consoleUrlParts.protocol,
    hostname: consoleUrlParts.hostname,
    port: consoleUrlParts.port,
    path: consoleUrlParts.pathname + "?mode=rest&cmd=comp&autk=" + this.config.autk,
    method: "POST",
    headers: form.getHeaders()
  };
  this.postRequest(options, form, function (code, data, err) {
    if (err || code !== 200) {
      pthis.logger.log((err ? "ERROR" : "WARN"), "POST reply error", "Request.sendExportedComponent",
              {err: err, code: code, data: data, options: options});
      callback(err || "Invalid response");
    }
    else
      callback();
  });
};


/**
 * Send project information to console
 * @param {string} userName
 * @param {string} projectName
 * @param {string} prjInfo
 * @param {function} callback - function(err)
 */
Node.Request.prototype.sendPrjInfo = function (userName, projectName, prjInfo, callback)
{
  var pthis = this;
  //
  var form = new Node.FormData();
  form.append("user", userName);
  form.append("project", projectName);
  form.append("company", this.config.serverType);
  form.append("prjInfo", prjInfo);
  //
  var consoleUrlParts = Node.url.parse(this.config.consoleURL || "");
  var options = {
    protocol: consoleUrlParts.protocol,
    hostname: consoleUrlParts.hostname,
    port: consoleUrlParts.port,
    path: consoleUrlParts.pathname + "?mode=rest&cmd=prjInfo&autk=" + this.config.autk,
    method: "POST",
    headers: form.getHeaders()
  };
  this.postRequest(options, form, function (code, data, err) {
    if (err || code !== 200) {
      pthis.logger.log((err ? "ERROR" : "WARN"), "POST reply error", "Request.sendPrjInfo",
              {err: err, code: code, data: data, options: options});
      callback(err || "Invalid response");
    }
    else
      callback();
  });
};


/**
 * Send create PR message to console
 * @param {string} userName
 * @param {string} projectName
 * @param {Object} prInfo
 * @param {function} callback - function(err)
 */
Node.Request.prototype.sendTwPrInfo = function (userName, projectName, prInfo, callback)
{
  var pthis = this;
  //
  var form = new Node.FormData();
  form.append("user", userName);
  form.append("project", projectName);
  form.append("company", this.config.serverType);
  form.append("prInfo", JSON.stringify(prInfo));
  //
  var consoleUrlParts = Node.url.parse(this.config.consoleURL || "");
  var options = {
    protocol: consoleUrlParts.protocol,
    hostname: consoleUrlParts.hostname,
    port: consoleUrlParts.port,
    path: consoleUrlParts.pathname + "?mode=rest&cmd=pr&autk=" + this.config.autk,
    method: "POST",
    headers: form.getHeaders()
  };
  this.postRequest(options, form, function (code, data, err) {
    if (err || code !== 200) {
      pthis.logger.log((err ? "ERROR" : "WARN"), "POST reply error", "Request.sendTwPrInfo",
              {err: err, code: code, data: data, options: options});
      callback(null, err || "Invalid response");
    }
    else
      callback();
  });
};


/**
 * Send course information to console
 * @param {string} RID
 * @param {string} courseData
 * @param {function} callback - function(err)
 */
Node.Request.prototype.sendCourseInfo = function (RID, courseData, callback)
{
  var pthis = this;
  //
  var form = new Node.FormData();
  form.append("text", JSON.stringify({courseData: JSON.parse(courseData)}));
  form.append("code", "200");
  //
  var consoleUrlParts = Node.url.parse(this.config.consoleURL || "");
  var options = {
    protocol: consoleUrlParts.protocol,
    hostname: consoleUrlParts.hostname,
    port: consoleUrlParts.port,
    path: consoleUrlParts.pathname + "?mode=rest&cmd=rid&rid=" + RID + "&autk=" + this.config.autk,
    method: "POST",
    headers: form.getHeaders()
  };
  this.postRequest(options, form, function (code, data, err) {
    if (err || code !== 200) {
      pthis.logger.log((err ? "ERROR" : "WARN"), "POST reply error", "Request.sendCourseInfo",
              {err: err, code: code, data: data, options: options});
      callback(err || "Invalid response");
    }
    else
      callback();
  });
};


/**
 * Send an http request to a server to backup a branch
 * @param {string} branchName
 * @param {object} parentPrjData - data of the parent project (see getParentProject)
 * @param {object} options {commits, user(destination), project(destination)}
 * @param {function} callback - function(err)
 */
Node.Request.prototype.backupBranch = function (branchName, parentPrjData, options, callback)
{
  var pthis = this;
  //
  var form = new Node.FormData();
  form.append("branch", branchName);
  form.append("commits", options.commits);
  form.append("user", options.user);          // User that will receive this branch
  form.append("project", options.project);    // Project that will receive this branch
  //
  var urlParts = Node.url.parse(parentPrjData.server);
  var postOpt = {
    protocol: urlParts.protocol,
    hostname: urlParts.hostname,
    port: urlParts.port,
    path: "/" + parentPrjData.user + "/" + parentPrjData.project + "/backupBranch",
    method: "POST",
    headers: form.getHeaders()
  };
  //
  this.postRequest(postOpt, form, function (code, data, err) {
    if (err || code !== 200) {
      pthis.logger.log((err ? "ERROR" : "WARN"), "POST reply error", "Request.backupBranch",
              {err: err, code: code, data: data, options: postOpt});
      callback(err || "Invalid response");
    }
    else
      callback();
  });
};


/**
 * Send an http request to a server asking him to restore a branch
 * @param {string} branchName - name of the branch
 * @param {object} parentPrjData - data of the parent project (see getParentProject)
 * @param {object} options - options to be used {msg: message}
 * @param {function} callback - function(err)
 */
Node.Request.prototype.restoreBranch = function (branchName, parentPrjData, options, callback)
{
  var pthis = this;
  //
  var form = new Node.FormData();
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
  var urlParts = Node.url.parse(parentPrjData.server);
  var postOpt = {
    protocol: urlParts.protocol,
    hostname: urlParts.hostname,
    port: urlParts.port,
    path: "/" + parentPrjData.user + "/" + parentPrjData.project + "/restoreBranch",
    method: "POST",
    headers: form.getHeaders()
  };
  //
  this.postRequest(postOpt, form, function (code, data, err) {
    if (err || code !== 200) {
      pthis.logger.log((err ? "ERROR" : "WARN"), "POST reply error", "Request.restoreBranch",
              {err: err, code: code, data: data, options: postOpt});
      callback(err || "Invalid response");
    }
    else
      callback();
  });
};


/*
 * Send request to console to invite users for telecollaboration
 * @param {Object} msg
 * @param {function} callback - function(data, err)
 */
Node.Request.prototype.inviteUsers = function (msg, callback)
{
  var pthis = this;
  //
  // Create a form to be sent via post
  var form = new Node.FormData();
  form.append("user", msg.userName);
  form.append("users", JSON.stringify(msg.users));
  //
  var consoleUrlParts = Node.url.parse(this.config.consoleURL || "");
  var options = {
    protocol: consoleUrlParts.protocol,
    hostname: consoleUrlParts.hostname,
    port: consoleUrlParts.port,
    path: consoleUrlParts.pathname + "?mode=rest&cmd=inviteUsers&autk=" + this.config.autk,
    method: "POST",
    headers: form.getHeaders()
  };
  //
  this.postRequest(options, form, function (code, data, err) {
    if (err || code !== 200) {
      pthis.logger.log((err ? "ERROR" : "WARN"), "POST reply error", "Request.inviteUsers",
              {err: err, code: code, data: data, options: options});
      callback(err || "Invalid response");
    }
    else
      callback();
  });
};


/*
 * Ask to console users list
 * @param {Object} msg
 * @param {function} callback - function(data, err)
 */
Node.Request.prototype.listUsers = function (msg, callback)
{
  var pthis = this;
  //
  // Create a form to be sent via post
  var form = new Node.FormData();
  form.append("user", msg.user);
  form.append("company", this.config.serverType);
  form.append("matchingString", msg.matchingString);
  form.append("organizationOnly", (msg.organizationOnly ? 1 : 0));
  //
  var consoleUrlParts = Node.url.parse(this.config.consoleURL || "");
  var options = {
    protocol: consoleUrlParts.protocol,
    hostname: consoleUrlParts.hostname,
    port: consoleUrlParts.port,
    path: consoleUrlParts.pathname + "?mode=rest&cmd=listUsers&autk=" + this.config.autk,
    method: "POST",
    headers: form.getHeaders()
  };
  //
  this.postRequest(options, form, function (code, data, err) {
    if (err || code !== 200) {
      pthis.logger.log((err ? "ERROR" : "WARN"), "POST reply error", "Request.listUsers",
              {err: err, code: code, data: data, options: options});
      callback(undefined, err || "Invalid response");
    }
    else {
      try {
        callback(JSON.parse(data));
      }
      catch (ex) {
        pthis.logger.log("ERROR", "GET reply error", "Request.listUsers", {data: data, code: code, options: options});
        callback(null, "Invalid response");
      }
    }
  });
};


/**
 * Ask to console if user with given address is online
 * @param {string} address
 * @param {function} callback - function(data, err)
 */
Node.Request.prototype.isUserOnline = function (address, callback)
{
  var pthis = this;
  //
  var consoleUrlParts = Node.url.parse(this.config.consoleURL || "");
  var options = {
    protocol: consoleUrlParts.protocol,
    hostname: consoleUrlParts.hostname,
    port: consoleUrlParts.port,
    path: consoleUrlParts.pathname + "?mode=rest&cmd=isUserOnline&email=" + address + "&autk=" + this.config.autk,
    method: "GET"
  };
  this.getRequest(options, function (code, data, err) {
    if (err || code !== 200) {
      pthis.logger.log((err ? "ERROR" : "WARN"), "GET reply error", "Request.isUserOnline", {err: err, code: code, data: data, options: options});
      callback(null, err || "Invalid response");
    }
    else {
      // Maybe the system answered 200-OK but with an HTML file (like when it's updating)
      // Better check if the answer is a JSON string... I don't want to crash everything
      try {
        callback(JSON.parse(data));
      }
      catch (ex) {
        pthis.logger.log("ERROR", "GET reply error", "Request.isUserOnline", {data: data, code: code, options: options});
        callback(null, "Invalid response");
      }
    }
  });
};


/*
 * Ask the console to execute a query on a remote server
 * @param {Object} options
 * @param {function} callback - function(data, err)
 */
Node.Request.prototype.executeRemoteQuery = function (options, callback)
{
  // Create a form to be sent via post
  var form = new Node.FormData();
  form.append("server", options.server);
  form.append("database", options.database);
  form.append("sql", options.sql);
  //
  var consoleUrlParts = Node.url.parse(this.config.consoleURL || "");
  var options = {
    protocol: consoleUrlParts.protocol,
    hostname: consoleUrlParts.hostname,
    port: consoleUrlParts.port,
    path: consoleUrlParts.pathname + "?mode=rest&cmd=query&autk=" + this.config.autk,
    method: "POST",
    headers: form.getHeaders()
  };
  //
  this.postRequest(options, form, function (code, data, err) {
    if (err || code !== 200) {
      this.logger.log((err ? "ERROR" : "WARN"), "POST reply error", "Request.executeRemoteQuery",
              {err: err, code: code, data: data, options: options});
      callback(undefined, err || "Invalid response");
    }
    else
      callback(data);
  }.bind(this));
};


/*
 * Ask to console to manage the notification of an issue
 * @param {Object} msg
 * @param {function} callback - function(data, err)
 */
Node.Request.prototype.notifyIssueCommand = function (msg, callback)
{
  var pthis = this;
  //
  // Create a form to be sent via post
  var form = new Node.FormData();
  var cmd = msg.cmd;
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
  var consoleUrlParts = Node.url.parse(this.config.consoleURL || "");
  var options = {
    protocol: consoleUrlParts.protocol,
    hostname: consoleUrlParts.hostname,
    port: consoleUrlParts.port,
    path: consoleUrlParts.pathname + "?mode=rest&cmd=" + cmd + "&autk=" + this.config.autk,
    method: "POST",
    headers: form.getHeaders()
  };
  //
  this.postRequest(options, form, function (code, data, err) {
    if (err || code !== 200) {
      pthis.logger.log((err ? "ERROR" : "WARN"), "POST reply error", "Request.notifyIssueCommand",
              {err: err, code: code, data: data, options: options});
      callback(undefined, err || "Invalid response");
    }
    else {
      try {
        callback(JSON.parse(data));
      }
      catch (ex) {
        pthis.logger.log("ERROR", "GET reply error", "Request.notifyIssueCommand", {data: data, code: code, options: options});
        callback(null, "Invalid response");
      }
    }
  });
};


/*
 * Ask to console users list
 * @param {Object} msg
 * @param {function} callback - function(data, err)
 */
Node.Request.prototype.notifyFeedback = function (msg, callback)
{
  var pthis = this;
  //
  // Create a form to be sent via post
  var form = new Node.FormData();
  form.append("issuesJSON", JSON.stringify(msg));
  //
  var consoleUrlParts = Node.url.parse(this.config.consoleURL);
  var options = {
    protocol: consoleUrlParts.protocol,
    hostname: consoleUrlParts.hostname,
    port: consoleUrlParts.port,
    path: consoleUrlParts.pathname + "?mode=rest&cmd=notifyIssue&autk=" + this.config.autk,
    method: "POST",
    headers: form.getHeaders()
  };
  //
  this.postRequest(options, form, function (code, data, err) {
    if (err || code !== 200) {
      pthis.logger.log((err ? "ERROR" : "WARN"), "POST reply error", "Request.notifyFeedback",
              {err: err, code: code, data: data, options: options});
      callback(undefined, err || "Invalid response");
    }
    else
      callback(data);
  });
};


// Export module
module.exports = Node.Request;
