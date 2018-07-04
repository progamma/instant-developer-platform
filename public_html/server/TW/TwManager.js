/*
 * Instant Developer Next
 * Copyright Pro Gamma Spa 2000-2016
 * All rights reserved
 */
/* global require, module */

var Node = Node || {};
var InDe = InDe || {};

// Import Modules
Node.fs = require("fs");
Node.rimraf = require("rimraf");
Node.ncp = require("../ncp_fixed");
//
// Import Classes
Node.Branch = require("./branch");
Node.Commit = require("./commit");
Node.Utils = require("../utils");
InDe.Transaction = require("../../ide/model/Transaction");
InDe.TransManager = require("../../ide/model/TransManager");
InDe.rh = require("../../ide/common/resources");
InDe.AMethod = require("../../ide/model/objects/AMethod");
InDe.AQuery = require("../../ide/model/objects/AQuery");


/*
 * @class TwManager
 * @param {chidl} child
 */
Node.TwManager = function (child)
{
  this.child = child;
  this.doc = child.doc;
  this.path = child.path;
  this.numPR = 1;
  this.branches = [];
  //
  // Generate a new guid (used for saving this work session)
  this.id = Node.Utils.generateUID36();
  //
  // Load the configuration
  this.loadConfig();
  //
  // Check the installation (branches, directories, ...)
  this.check();
  //
  // Attach listeners
  this.attachListeners();
};


Node.TwManager.msgTypeMap = {
  requestSavedModifications: "rsm",
  savedModifications: "sm",
  //
  requestBranchList: "reqbl",
  branchList: "bl",
  //
  requestDiffBranch: "rdb",
  diffBranch: "db",
  //
  requestConflicts: "reqconf",
  conflictsItems: "conf",
  resolveConflict: "resconf",
  //
  requestCommitHistory: "rch",
  commitHistory: "ch",
  requestCommitHistoryItems: "rchit",
  commitHistoryItems: "chit",
  //
  requestTWstatus: "rtws",
  TWstatus: "tws",
  //
  emptyTransList: "etl",
  //
  requestPushDescription: "rpd",
  pushDescription: "pd"
};


// Define usefull properties for this object
Object.defineProperties(Node.TwManager.prototype, {
  logger: {
    get: function () {
      return this.child.logger;
    }
  }
});


/**
 * Save the object
 */
Node.TwManager.prototype.save = function ()
{
  var r = {cl: "Node.TwManager", actualBranch: this.actualBranch.name, branches: this.branches,
    numPR: this.numPR};
  return r;
};


/**
 * Load the object
 * @param {Object} v - the object that contains my data
 */
Node.TwManager.prototype.load = function (v)
{
  this.actualBranch = v.actualBranch;
  this.branches = v.branches;
  this.numPR = v.numPR;
};


/**
 * Save the configuration (makes a JSON that will be saved in the file TwConfig.json)
 */
Node.TwManager.prototype.saveAll = function ()
{
  return JSON.stringify(this, function (k, v) {
    if (v instanceof Node.TwManager || v instanceof Node.Branch)
      return v.save();
    else
      return v;
  });
};


/**
 * Load the configiguration (parse the JSON that comes from the file TwConfig.json)
 * @param {String} s - JSON data to load
 */
Node.TwManager.prototype.loadAll = function (s)
{
  var pthis = this;
  //
  this.config = JSON.parse(s, function (k, v) {
    if (v instanceof Object && v.cl !== undefined) {
      if (v.cl === "Node.TwManager") {
        pthis.load(v);
        return pthis;
      }
      if (v.cl === "Node.Branch") {
        var obj = new Node.Branch(pthis);
        obj.load(v);
        return obj;
      }
    }
    else
      return v;
  });
};


/**
 * Save the current configuration
 * @param {function} callback - function(err)
 */
Node.TwManager.prototype.saveConfig = function (callback)
{
  var pthis = this;
  //
  // This method is called in several points and it's asynchronous, thus we can have problems
  // if two different clients calls this method in the same time.... better protect multiple calls
  if (this.savingConf) {
    // I'm already saving the config file... procrastinate
    setTimeout(function () {
      pthis.saveConfig(callback);
    }, 100);
    //
    return;
  }
  //
  this.savingConf = true;   // Start save
  var configFile = this.path + "/TwConfig.json";
  var docjson = this.saveAll();
  //
  var writeConf = function () {
    // Write the config file
    Node.fs.writeFile(configFile, docjson, function (err) {
      if (err) {
        delete pthis.savingConf;  // End save
        pthis.logger.log("ERROR", "Error saving the configuration file " + configFile + ": " + err, "TwManager.saveConfig");
        return callback(err);
      }
      //
      delete pthis.savingConf;  // End save
      pthis.logger.log("DEBUG", "Configuration file saved with success", "TwManager.saveConfig");
      callback();
    });
  };
  //
  // Remove the old BACK if present
  Node.rimraf(configFile + ".bak", function (err) {
    if (err) {
      delete pthis.savingConf;  // End save
      pthis.logger.log("ERROR", "Error removing the old CONFIG file " + configFile + ".bak: " + err, "TwManager.saveConfig");
      return callback(err);
    }
    //
    // If the file does not exists, write the file directly
    if (!Node.fs.existsSync(configFile))
      writeConf();
    else {
      // The file exists. Backup the the config file into a .bak file
      Node.fs.rename(configFile, configFile + ".bak", function (err) {
        if (err) {
          delete pthis.savingConf;  // End save
          pthis.logger.log("ERROR", "Error renaming the CONFIG file " + configFile + " to " + configFile + ".bak: " + err, "TwManager.saveConfig");
          return callback(err);
        }
        //
        // And write the file
        writeConf();
      });
    }
  });
};


/**
 * Load the current configuration
 * (do it synchronously because it's executed only once during TwManager startup)
 */
Node.TwManager.prototype.loadConfig = function ()
{
  var configFile = this.path + "/TwConfig.json";
  if (Node.fs.existsSync(configFile)) {
    try {
      // Load the configuration file
      var data = Node.fs.readFileSync(configFile, {encoding: "utf8"});
      this.loadAll(data);
    }
    catch (err) {
      this.logger.log("ERROR", "Error reading the file " + configFile + ": " + err, "TwManager.loadConfig");
    }
  }
};


/**
 * Attach all the listeners
 */
Node.TwManager.prototype.attachListeners = function ()
{
  var pthis = this;
  //
  this.doc.onMessage(Node.TwManager.msgTypeMap.requestBranchList, this, function () {
    pthis.sendBranchesList();
  });
  this.doc.onMessage(Node.TwManager.msgTypeMap.requestSavedModifications, this, function () {
    pthis.sendSavedModifications();
  });
  this.doc.onMessage(Node.TwManager.msgTypeMap.requestDiffBranch, this, function (msg) {
    pthis.sendDiffBranch(msg.branch);
  });
  this.doc.onMessage(Node.TwManager.msgTypeMap.requestCommitHistory, this, function (msg) {
    pthis.sendCommitHistory(msg);
  });
  this.doc.onMessage(Node.TwManager.msgTypeMap.requestCommitHistoryItems, this, function (msg) {
    pthis.sendCommitHistoryItems(msg.commitid);
  });
  this.doc.onMessage(Node.TwManager.msgTypeMap.requestTWstatus, this, function () {
    pthis.sendTWstatus();
  });
  this.doc.onMessage(Node.TwManager.msgTypeMap.requestConflicts, this, function () {
    pthis.sendConflicts();
  });
  this.doc.onMessage(Node.TwManager.msgTypeMap.resolveConflict, this, function (msg) {
    var tr = new InDe.Transaction(pthis.doc.transManager);
    tr.load(msg.tr);
    //
    pthis.doc.showUIMessage({text: InDe.rh.t("tw_conflict_solving"), locktype: "critical"});
    pthis.actualBranch.resolveConflicts(tr, function () {
      pthis.doc.showUIMessage({text: InDe.rh.t("tw_conflict_solved"), style: "positive", unlock: "critical"});
      //
      pthis.sendTWstatus();
    });
  });
  this.doc.onMessage(Node.TwManager.msgTypeMap.requestPushDescription, this, function () {
    var descr = pthis.actualBranch.getCommitsMessages().join("\n");
    pthis.doc.sendMessage({type: Node.TwManager.msgTypeMap.pushDescription, cnt: {text: descr}});
  });
};


/**
 * Check current configuration
 * (check if the master branch exists and if all branches are fine)
 */
Node.TwManager.prototype.check = function ()
{
  var emptyfun = function () {
  };
  //
  // First check if there is a MASTER branch (there have to be one)
  var mst = this.getBranchByName("master");
  if (!mst) {
    // The master is not here... it happens the first time the server starts
    // Create a new master branch and activate it
    this.actualBranch = new Node.Branch(this);
    this.actualBranch.name = "master";
    this.branches.push(this.actualBranch);
    //
    // The number of branches have changed... save the current configuration
    this.saveConfig(emptyfun);
  }
  else // Search the active branch
    this.actualBranch = this.getBranchByName(this.actualBranch);
  //
  // Check if all branches have their branch folder (don't wait for completion)
  for (var i = 0; i < this.branches.length; i++)
    this.branches[i].createBranchFolder(emptyfun);
};


/**
 * Send the branches status to the client
 */
Node.TwManager.prototype.sendBranchesList = function ()
{
  this.doc.sendMessage({type: Node.TwManager.msgTypeMap.branchList,
    cnt: {actual: this.actualBranch.name, list: this.getBranchList(), PRs: this.getBranchList(true)}});
};


/**
 * Send all saved modifications to the client
 */
Node.TwManager.prototype.sendSavedModifications = function ()
{
  var pthis = this;
  //
  // Get all saved modifications
  this.getAllSavedModifications(function (trans, err) {
    if (err)
      return pthis.doc.sendMessage({type: Node.TwManager.msgTypeMap.savedModifications, cnt: {err: err}});
    //
    // Cerate a Shuttle transaction (used to send the transitems to the callee)
    var trShuttle = new InDe.Transaction(pthis.doc.transManager);
    trShuttle.tw = true;
    //
    for (var i = 0; i < trans.length; i++) {
      var tr = new InDe.Transaction(pthis.doc.transManager);
      tr.load(trans[i]);
      //
      // Merge this transaction inside the shuttle transaction
      trShuttle.transItems = trShuttle.transItems.concat(tr.transItems);
    }
    //
    // Purge the transaction
//    trShuttle = InDe.TransManager.purge(trShuttle);
    //
    // Send the shuttle transaction to the client
    pthis.doc.sendMessage({type: Node.TwManager.msgTypeMap.savedModifications, cnt: {tr: trShuttle.save()}});
  });
};


/**
 * Sends the conflicts for the current branch (if any) to the client
 */
Node.TwManager.prototype.sendConflicts = function ()
{
  var pthis = this;
  //
  // If the current branch has conflicts... send them to the client
  this.actualBranch.getConflicts(function (confTr, err) {
    if (err)
      pthis.doc.sendMessage({type: Node.TwManager.msgTypeMap.conflictsItems, cnt: {err: err}});
    else if (confTr)
      pthis.doc.sendMessage({type: Node.TwManager.msgTypeMap.conflictsItems, cnt: {tr: confTr.save()}});
    else
      pthis.doc.sendMessage({type: Node.TwManager.msgTypeMap.conflictsItems, cnt: {tr: (new InDe.Transaction(pthis.doc.transManager)).save()}});
  });
};


/**
 * Sends to the client the differences between the given branch and the current branch
 * @param {String} branchName - name of the branch for which the client is requesting the differences
 */
Node.TwManager.prototype.sendDiffBranch = function (branchName)
{
  var pthis = this;
  //
  // First, check if the branch exists
  var branch = this.getBranchByName(branchName);
  if (!branch) {
    this.logger.log("WARN", "Branch " + branchName + " not found", "TwManager.sendDiffBranch", {branch: branchName});
    return this.doc.sendMessage({type: Node.TwManager.msgTypeMap.diffBranch, cnt:
              {err: InDe.rh.t("tw_branch_not_exists_err", {_b: branchName})}});
  }
  //
  var i, j, k, tr, ti;
  //
  // Cerate a Shuttle transaction (used to send the transitems to the callee)
  var trShuttle = new InDe.Transaction(this.doc.transManager);
  trShuttle.tw = true;
  //
  // Get the commits
  var commits;
  if (branch.type === Node.Branch.PR)
    commits = {undoList: [], redoList: this.getDiffBranch(branchName)};   // PUSH/PULL -> REDO of all commits that are not in the actual branch
  else
    commits = this.getDiffBranchSwitch(branchName);                       // Normal -> UNDO until common point then REDO of other transactions
  //
  // Load all the commits that have to be undoed
  for (i = 0; i < commits.undoList.length; i++) {
    var ullist = commits.undoList[i].loadCommit();
    for (j = 0; j < ullist.length; j++) {
      tr = new InDe.Transaction(this.doc.transManager);
      tr.load(ullist[j]);
      //
      // This transaction must be undoed... thus I need to invert each transitem
      for (k = 0; k < tr.transItems.length; k++) {
        ti = tr.transItems[k];
        //
        // Relink the item
        tr.relinkItem(ti, "undo");
        //
        // Invert the item
        InDe.Transaction.invertTransItem(ti);
        //
        // Append all transitems to the shuttle transaction (this is an UNDO item, thus I add it backward)
        trShuttle.transItems.unshift(ti);
      }
    }
  }
  //
  // Load all the commits that have to be redoed
  for (i = 0; i < commits.redoList.length; i++) {
    var rllist = commits.redoList[i].loadCommit();
    for (j = 0; j < rllist.length; j++) {
      tr = new InDe.Transaction(this.doc.transManager);
      tr.load(rllist[j]);
      //
      // Append all transitems to the shuttle transaction (this is a REDO transaction, thus I add
      // all items at the end and in the same order)
      trShuttle.transItems = trShuttle.transItems.concat(tr.transItems);
    }
  }
  //
  var sendResponse = function () {
    // Purge the transaction
//    trShuttle = InDe.TransManager.purge(trShuttle);
    trShuttle.purgeAToken();
    //
    pthis.doc.sendMessage({type: Node.TwManager.msgTypeMap.diffBranch, cnt: {tr: trShuttle.save()}});
  };
  //
  // If the branch is NOT a PR, add saved and memory modifications to the undo list
  if (branch.type !== Node.Branch.PR) {
    pthis.getAllSavedModifications(function (trans, err) {
      if (err) {
        pthis.logger.log("WARN", "Error while retrieving the saved modifications: " + err, "TwManager.sendDiffBranch");
        return this.doc.sendMessage({type: Node.TwManager.msgTypeMap.diffBranch, cnt:
                  {err: InDe.rh.t("tw_diffbranch_err", {_b: branchName})}});
      }
      //
      // Load all saved transactions
      for (j = 0; j < trans.length; j++) {
        tr = new InDe.Transaction(pthis.doc.transManager);
        tr.load(trans[j]);
        //
        // This transaction must be undoed... thus I need to invert each transitem
        for (k = 0; k < tr.transItems.length; k++) {
          ti = tr.transItems[k];
          //
          // Relink the item
          tr.relinkItem(ti, "undo");
          //
          // Invert the item
          InDe.Transaction.invertTransItem(ti);
          //
          // Append all transitems to the shuttle transaction (this is an UNDO item, thus I add it backward)
          trShuttle.transItems.unshift(ti);
        }
      }
      //
      // Last: add memory modifications
      var translist = pthis.doc.transManager.translist;
      for (i = 0; i < translist.length; i++) {
        tr = translist[i];
        //
        // If this transaction is inside the saved modifications, skip it
        if (trans.indexOf(tr.id) !== -1)
          continue;
        //
        // I need to invert the tr's items, thus I can't just use the "original" one. Thus I need a clone
        var newtr = tr.clone();
        for (k = 0; k < tr.transItems.length; k++) {
          ti = newtr.transItems[k];
          InDe.Transaction.invertTransItem(ti);
          //
          // Append all transitems to the shuttle transaction (this is an UNDO item, thus I add it backward)
          trShuttle.transItems.unshift(ti);
        }
      }
      //
      // Done -> send the reply to the client
      sendResponse();
    });
  }
  else  // It's a PR -> send the reply to the client
    sendResponse();
};


/**
 * Sends to the client all the commits that contain changes relative to the given object
 * @param {object} filter - options to be used for commits loading
 */
Node.TwManager.prototype.sendCommitHistory = function (filter)
{
  var history = [];
  //
  // Save the result of this method into a local variable so that when the client will ask for
  // a specific commit I'll use this local variable
  this.commitHistory = {};
  //
  // Error + clean up function
  var errorFnc = function (err) {
    // Clean up preview
    (new InDe.Transaction(this.doc.transManager)).cleanupPreview();
    //
    // Report error to client
    this.doc.sendMessage({type: Node.TwManager.msgTypeMap.commitHistory, cnt: {err: err}});
  }.bind(this);
  //
  // Retrieve all commits and send reply
  var sendCommits = function () {
    // Last, retrieve all the commits that have to do with the given object (last 30 days)
    this.actualBranch.getCommitsTransItemsByID(filter, function (commits, err) {
      if (err)
        return errorFnc(err);
      //
      // Add all commits to history array
      // (don't add commits[i] directly because it contains also all trans items)
      for (var i = 0; i < commits.length; i++) {
        var com = commits[i];
        history.push({id: com.id, message: com.message, date: com.date, author: com.author});
        //
        this.commitHistory[com.id] = com;
      }
      //
      // Clean up preview
      (new InDe.Transaction(this.doc.transManager)).cleanupPreview();
      //
      // Send the reply to the client
      this.doc.sendMessage({type: Node.TwManager.msgTypeMap.commitHistory, cnt: {history: history, moreItems: commits.moreItems}});
    }.bind(this));
  }.bind(this);
  //
  // If the callee asked for a specific "page" of commits, just send that page
  if (filter.start !== undefined)
    return sendCommits();
  //
  // First if there are changes inside the working transactions (not saved) that have something to do
  // with the given object, add an item to the history for that
  this.getMemoryTransItemsById(filter.objid, function (items) {
    // If the memory modifications contains something, add a "fake-commit" that tells the user that
    // there are changes inside the memory modifications
    if (items.length) {
      var fakeMemCom = {id: "memMod", message: InDe.rh.t("tw_comhist_mem"), date: new Date(), author: this.child.project.user.userName};
      history.push(fakeMemCom);
      //
      this.commitHistory[fakeMemCom.id] = {transItems: items};
    }
    //
    // If inside the saved modifications there are transactions that have to do with the object,
    // append another item to the history
    this.getAllSavedTransItemsById(filter.objid, function (items, err) {
      if (err)
        return errorFnc(err);
      //
      // If the saved modifications contains something, add a "fake-commit" that tells the user that
      // there are changes inside the saved modifications
      if (items && items.length) {
        var fakeSavedCom = {id: "savedMod", message: InDe.rh.t("tw_comhist_saved"), date: items.date, author: this.child.project.user.userName};
        history.push(fakeSavedCom);
        //
        this.commitHistory[fakeSavedCom.id] = {transItems: items};
      }
      //
      // Send commits
      sendCommits();
    }.bind(this));
  }.bind(this));
};


/**
 * Sends to the client the changes that have been performed on the given object
 * @param {String} commid - id of the commit the client is interested to
 */
Node.TwManager.prototype.sendCommitHistoryItems = function (commid)
{
  // If I haven't the temporary object calculated above, I can't answer
  if (!this.commitHistory) {
    this.logger.log("WARN", "Error while sending commit history: no calculation has been made", "TwManager.sendCommitHistoryItems", {commit: commid});
    return this.doc.sendMessage({type: Node.TwManager.msgTypeMap.commitHistoryItems, cnt: {err: InDe.rh.t("tw_comhist_err")}});
  }
  //
  var items = (this.commitHistory[commid] ? this.commitHistory[commid].transItems : null);
  if (!items) {
    this.logger.log("WARN", "Error while sending commit history: commit not found", "TwManager.sendCommitHistoryItems", {commit: commid});
    return this.doc.sendMessage({type: Node.TwManager.msgTypeMap.commitHistoryItems, cnt: {err: InDe.rh.t("tw_comhist_err")}});
  }
  //
  var trShuttle = new InDe.Transaction(this.doc.transManager);
  trShuttle.tw = true;
  trShuttle.transItems = items;
  //
  this.doc.sendMessage({type: Node.TwManager.msgTypeMap.commitHistoryItems, cnt: {tr: trShuttle.save()}});
};


/**
 * Asks the server if I have a parent project and cache the response
 * @param {function} callback - function(result)
 */
Node.TwManager.prototype.hasParentProject = function (callback)
{
  var pthis = this;
  //
  // If I have already an answer, respond immediately
  if (this.parentProject !== undefined)
    return callback(this.parentProject);
  //
  // Ask the console if I have a parent project
  this.child.request.getParentProject(this.child.project.user.userName, this.child.project.name, function (data, err) {
    // Cache the response and respond to callee
    pthis.parentProject = (err || !data ? false : data);
    callback(pthis.parentProject);
  });
};


/**
 * Asks the parent project (if any) the list of all commits
 * @param {function} callback - function(commits)
 */
Node.TwManager.prototype.getParentCommits = function (callback)
{
  var pthis = this;
  //
  // Cache the info for this session... it takes time to compute
  // and the client asks for it every time the uses sees the Dashboard
  if (this.parentCommits !== undefined)
    return callback(this.parentCommits);
  //
  // If I don't have a parent project I need nothing
  if (this.parentProject === false)
    return callback([]);
  else if (this.parentProject === undefined) {
    // I don't know if I have a parent project... I need to ask
    this.hasParentProject(function () {
      // Now I know something about my parent project... I can compute needed commits
      return pthis.getParentCommits(callback);
    });
    return;
  }
  //
  // I have a parent, project... I can ask for missing commits
  var opts = {branch: this.actualBranch.name};
  this.child.request.getParentCommits(this.child.project.user.userName, this.child.project.name, opts, function (commits, err) {
    if (err) {
      pthis.logger.log("WARN", "Error while reading parent commits: " + err, "TwManager.getParentCommits");
      return callback([]);
    }
    //
    // Cache the response (keep only commit's ID)
    pthis.parentCommits = [];
    for (var i = 0; i < commits.length; i++)
      pthis.parentCommits.push(commits[i].id);
    //
    // Report to callee
    callback(pthis.parentCommits);
  });
};


/**
 * Sends the current TW status to the client
 */
Node.TwManager.prototype.sendTWstatus = function ()
{
  var status = {};
  //
  // TRUE if there are saved modifications
  Node.fs.exists(this.path + "/trans/save.json", function (exists) {
    status.savedModif = exists;
    this.doc.sendMessage({type: Node.TwManager.msgTypeMap.TWstatus, cnt: status});
  }.bind(this));
  //
  // TRUE if there is a parent project (i.e. this project has been forked)
  this.hasParentProject(function (result) {
    status.parentPrj = (result ? true : false);
    //
    // If I have a parent project, I can ask for parent commits
    status.parentCommits = 0;
    status.notPushedCommits = 0;
    if (result) {
      this.getParentCommits(function (commits) {
        var actCommits = this.actualBranch.loadAllCommits();
        var actNotPushed = this.actualBranch.getNotPushedCommits();
        //
        // Compute the number of commits I would like to have from parent project (parent commits I don't have)
        commits.forEach(function (parCom) {
          var iHaveIt = actCommits.find(function (myCom) {
            return (myCom.id === parCom);
          });
          if (!iHaveIt)
            status.parentCommits++;   // I don't have this commit...
        });
        //
        // Compute the number of commits I'd like to send to my parent project (un-pushed commits the parent doesn't have)
        actNotPushed.forEach(function (myCom) {
          var heHasIt = commits.find(function (parCom) {
            return (parCom === myCom.id);
          });
          if (!heHasIt)
            status.notPushedCommits++;   // He does not have this commit...
        });
        //
        this.doc.sendMessage({type: Node.TwManager.msgTypeMap.TWstatus, cnt: status});
      }.bind(this));
    }
    else    // No parent project -> send result to UI
      this.doc.sendMessage({type: Node.TwManager.msgTypeMap.TWstatus, cnt: status});
  }.bind(this));
  //
  // Number of PRs
  var PRs = this.getBranchList(true);
  status.nPR = PRs.length;
  this.doc.sendMessage({type: Node.TwManager.msgTypeMap.TWstatus, cnt: status});
  //
  // Function needed to count conflicts
  var countConfl = function (transItems) {
    // Count every method's or query's children as 1
    var dummyObj = {};
    for (var k = 0; k < transItems.length; k++) {
      var cobj = transItems[k].obj;
      var par = cobj.getParent(InDe.AMethod);
      if (!par)
        par = cobj.getParent(InDe.AQuery);
      dummyObj[(par ? par.id : cobj.id)] = cobj;
    }
    return Object.keys(dummyObj).length;
  };
  //
  // Send number of conflicts in actual branch
  // If I don't know if the actualBranch has conflicts ask it to load them
  if (!this.actualBranch.conflictTrans) {
    this.actualBranch.getConflicts(function (confTr, err) {
      if (err)
        status.nConfl = -1;
      else if (confTr)
        status.nConfl = countConfl(confTr.transItems);
      else
        status.nConfl = 0;
      this.doc.sendMessage({type: Node.TwManager.msgTypeMap.TWstatus, cnt: status});
    }.bind(this));
  }
  else {
    // The actual branch has conflicts...
    status.nConfl = countConfl(this.actualBranch.conflictTrans.transItems);
    this.doc.sendMessage({type: Node.TwManager.msgTypeMap.TWstatus, cnt: status});
  }
};


/**
 * Save the transactions
 * @param {function} callback - function(err)
 */
Node.TwManager.prototype.saveTrans = function (callback)
{
  var pthis = this;
  var i;
  //
  var pathStaging = this.path + "/trans/";
  var pathSave = pathStaging + "save.json";  // Index
  var pathTrans = pathStaging + this.id;     // Session file (that contains all transactions for this session)
  //
  // Prepare trans list
  var translist = this.doc.transManager.translist;
//  var translist = this.doc.transManager.purge(this.doc.transManager.translist);     // TODO: attivare quando funziona
  //
  // Prepare transaction array
  var TL = [];
  for (i = 0; i < translist.length; i++) {
    var tr = translist[i];
    //
    // Skip empty transactions
    if (!tr.transItems.length) {
      this.logger.log("DEBUG", "Transaction not saved (empty)", "TwManager.saveTrans", {trid: tr.id, trStatus: tr.status, tr: tr.save()});
      continue;
    }
    //
    // Skip transactions that are not COMMITTED nor REDONE (only those two are interested)
    if (tr.status !== InDe.Transaction.Status.COMMITTED && tr.status !== InDe.Transaction.Status.REDONE) {
      this.logger.log("DEBUG", "Transaction not saved (invalid state)", "TwManager.saveTrans", {trid: tr.id, trStatus: tr.status, tr: tr.save()});
      continue;
    }
    //
    // Remove transMessages... I don't need them
    tr.transMessages = [];
    //
    // Clear item I don't want to be saved (those changes are not handed by TW)
    for (var j = 0; j < tr.transItems.length; j++)
      if (tr.transItems[j].obj instanceof InDe.AMethod && tr.transItems[j].prop === "watches")
        tr.transItems.splice(j--, 1);
    //
    // Save transaction
    tr.tw = true;
    TL.push(tr.save());
    delete tr.tw;
    //
    // Remember that this transaction has been saved
    tr.saved = true;
  }
  //
  // If there is nothing to save
  if (TL.length === 0) {
    // If there was a file for this session, I need to delete it
    if (Node.fs.existsSync(pathTrans)) {
      pthis.readJSONFile(pathSave, function (files, err) {
        // The session file exists, thus it must exist also the index file
        if (err) {
          pthis.logger.log("ERROR", "Error reading the file " + pathSave + ": " + err, "TwManager.saveTrans");
          return callback(err);
        }
        //
        // Remove the file
        for (i = 0; i < files.length; i++) {
          if (files[i].id === pthis.id) {
            files.splice(i, 1);
            break;
          }
        }
        //
        // If there are no more files, delete the entire staging area
        if (files.length === 0) {
          Node.rimraf(pathStaging, function (err) {
            if (err)
              pthis.logger.log("ERROR", "Error removing the staging area " + pathStaging + ": " + err, "TwManager.saveTrans");
            callback(err);
            //
            // I'had a staging area and not I've removed it, thus changing from a
            // "hasLocalChanges" to a safer "hasNoLocalChanges" status -> I need to update UI
            // (user can no longer commit but he/she is allowed to fetch)
            pthis.sendTWstatus();
          });
        }
        else {
          // There are files left... save the updated index
          pthis.writeJSONFile(pathSave, files, function (err) {
            if (err) {
              pthis.logger.log("ERROR", "Error writing the file " + pathSave + ": " + err, "TwManager.saveTrans");
              return callback(err);
            }
            //
            // Now remove the useless session file
            Node.rimraf(pathTrans, function (err) {
              if (err)
                pthis.logger.log("ERROR", "Error removing the transaction file " + pathTrans + ": " + err, "TwManager.saveTrans");
              callback(err);
            });
          });
        }
      });
    }
    else // The file was not there... do nothing
      callback();
    //
    return;
  }
  //
  // Remove the resources that are not in the document (i.e., resources added then removed)
  //   this.doc.resources contains the list of GUID of files that have been uploaded in this session
  //   this.doc.getResources() returns the list of all fileguid of AResource that are still in the project
  var docres = this.doc.getResources();
  for (i = 0; i < this.doc.resources.length; i++) {
    if (docres.indexOf(this.doc.resources[i]) === -1)
      this.doc.resources.splice(i, 1);
  }
  //
  // Create the staging area folder if needed
  Node.fs.mkdir(this.path + "/trans", function (err) {
    if (err && err.code !== "EEXIST") {
      pthis.logger.log("ERROR", "Error creating the folder " + pthis.path + "/trans: " + err, "TwManager.saveTrans");
      return callback(err);
    }
    //
    // First, write all transactions inside the session file
    pthis.writeJSONFile(pathTrans, TL, function (err) {
      // If failed, stop
      if (err) {
        pthis.logger.log("ERROR", "Error writing the file " + pathTrans + ": " + err, "TwManager.saveTrans");
        return callback(err);
      }
      //
      // Update save.json file by appending this session (if not already present)
      pthis.readJSONFile(pathSave, function (files, err) {
        // Continue only if the error is "file does not exist" (this happens normally after a commit)
        if (err && err.code !== "ENOENT") {
          pthis.logger.log("ERROR", "Error reading the file " + pathSave + ": " + err, "TwManager.saveTrans");
          return callback(err);
        }
        //
        // If the pathSave file is missing, create a new file array
        // otherwise search the session id inside the list and add/update it
        if (!files)
          files = [{id: pthis.id, date: new Date(), resources: pthis.doc.resources}];
        else {
          // Search the current GUID in the list
          var fil;
          for (i = 0; i < files.length && !fil; i++) {
            if (files[i].id === pthis.id)
              fil = files[i];
          }
          //
          // If not found, add the session to the SAVE file
          if (!fil)
            files.push({id: pthis.id, date: new Date(), resources: pthis.doc.resources});
          else {
            // Update the date and the list of resources
            fil.date = new Date();
            fil.resources = pthis.doc.resources;
          }
        }
        //
        // Write updated pathSave file
        pthis.writeJSONFile(pathSave, files, function (err) {
          callback(err);
          //
          // Update UI
          pthis.sendTWstatus();
          //
          if (err)
            pthis.logger.log("ERROR", "Error writing the file " + pathSave + ": " + err, "TwManager.saveTrans");
        });
      });
    });
  });
};


/**
 * Returns the branch with the given name
 * @param {string} branchName
 */
Node.TwManager.prototype.getBranchByName = function (branchName)
{
  for (var i = 0; i < this.branches.length; i++) {
    var bra = this.branches[i];
    if (bra.name === branchName)
      return bra;
  }
};


/**
 * Get all the branches
 * @param {boolean} PR - if TRUE returns only PR branches; if FALSE returns only "true" branches
 */
Node.TwManager.prototype.getBranchList = function (PR)
{
  var list = [];
  //
  for (var i = 0; i < this.branches.length; i++) {
    var bra = this.branches[i];
    //
    if (!PR && bra.type !== Node.Branch.PR)
      list.push({name: bra.name, owner: bra.owner});
    else if (PR && bra.type === Node.Branch.PR)
      list.push({id: bra.id, prid: bra.uid, name: bra.name, message: bra.message, date: bra.date});
  }
  //
  return list;
};


/**
 * Returns TRUE if there are local modifications
 */
Node.TwManager.prototype.localModif = function ()
{
  return Node.fs.existsSync(this.path + "/trans/save.json");
};


/**
 * Returns TRUE if there are unsaved (memory) modifications
 */
Node.TwManager.prototype.memoryModif = function ()
{
  var translist = this.doc.transManager.translist;
  for (var i = 0; i < translist.length; i++)
    if (!translist[i].saved)
      return true;
};


/**
 * Empty the translist and redolist(both client and server side)
 */
Node.TwManager.prototype.emptyTransList = function ()
{
  // Tell the client to clear its trans lists
  this.doc.sendMessage({type: Node.TwManager.msgTypeMap.emptyTransList});
  //
  // Clear server-side trans lists
  var tm = this.doc.transManager;
  tm.translist = [];
  tm.redolist = [];
};


/**
 * Create a new branch
 * @param {string} newBranchName
 * @param {function} callback - function(err)
 */
Node.TwManager.prototype.createBranch = function (newBranchName, callback)
{
  var pthis = this;
  //
  // If the branch exists already, do nothing
  if (this.getBranchByName(newBranchName)) {
    this.logger.log("WARN", "Branch already exists", "TwManager.createBranch", {branch: newBranchName});
    return callback(InDe.rh.t("tw_branch_exists_err"));
  }
  //
  var branchCreated = function () {
    // Operation completed
    pthis.saveConfig(function (err) {
      if (err) {
        pthis.logger.log("WARN", "Error while saving config file: " + err, "TwManager.createBranch");
        return callback(InDe.rh.t("tw_branch_create_err"));
      }
      //
      // Inform the client that a branch has been created
      pthis.sendBranchesList();
      //
      // Log the branch creation
      pthis.logger.log("DEBUG", "Branch created", "TwManager.createBranch", {branch: newBranchName});
      //
      // Operation completed
      callback();
    });
  };
  //
  // Create the new branch obj
  var branch = new Node.Branch(this);
  branch.name = newBranchName;
  branch.owner = this.actualBranch.name;
  //
  // Create the branch folder
  branch.createBranchFolder(function (err) {
    if (err)
      return callback(InDe.rh.t("tw_branch_create_err"));
    //
    // Add the new branch to the list
    pthis.branches.push(branch);
    //
    // Now, if the actualBranch contains at least a commit, I need to create a commit in the new branch
    // and point that commit to the last commit
    var lastCommit = pthis.actualBranch.getLastCommit();
    if (lastCommit) {
      // There is a last commit... create a new commit inside this branch that tells me where
      // my parent branch was when I was born
      var commitMsg = InDe.rh.t("tw_new_branch", {_b: pthis.actualBranch.name});
      var newCommit = branch.createCommit(commitMsg);
      //
      // Replace the commit ID with the lastCommit ID of the original branch
      newCommit.id = lastCommit.id;
      newCommit.originBranch = pthis.actualBranch.name;
      //
      // Save the branch... a new commit is born
      branch.saveCommitsList(function (err) {
        if (err) {
          pthis.logger.log("WARN", "Error while saving commit list: " + err, "TwManager.createBranch", {branch: newBranchName});
          return callback(InDe.rh.t("tw_branch_create_err"));
        }
        //
        // Last, copy resource.json file from the original branch (if exists)
        var srcRes = pthis.path + "/branches/" + pthis.actualBranch.name + "/resources.json";
        var dstRes = pthis.path + "/branches/" + newBranchName + "/resources.json";
        Node.fs.exists(srcRes, function (exists) {
          if (exists) {
            pthis.copyFile(srcRes, dstRes, function (err) {
              if (err) {
                pthis.logger.log("WARN", "Error while copying resources.json between branches: " + err, "TwManager.createBranch",
                        {branch: newBranchName, srcRes: srcRes, dstRes: dstRes});
                return callback(InDe.rh.t("tw_branch_create_err"));
              }
              //
              // Operation completed
              branchCreated();
            });
          }
          else  // File resurces.json does not exist -> operation completed
            branchCreated();
        });
      });
    }
    else  // Last commit not found -> operation completed
      branchCreated();
  });
};


/**
 * Delete an existing branch
 * @param {string} branchName
 * @param {function} callback - function(err)
 */
Node.TwManager.prototype.deleteBranch = function (branchName, callback)
{
  var pthis = this;
  //
  // Check if I'm requested to delete the actual branch
  if (branchName === this.actualBranch.name) {
    this.logger.log("WARN", "Can't delete active branch", "TwManager.deleteBranch", {branch: branchName});
    return callback(InDe.rh.t("tw_delete_actbranch_err"));
  }
  //
  // Check if the branch to be deleted exists
  var branch = this.getBranchByName(branchName);
  if (!branch) {
    this.logger.log("WARN", "Branch not found", "TwManager.deleteBranch", {branch: branchName});
    return callback(InDe.rh.t("tw_branch_not_exists_err", {_b: branchName}));
  }
  //
  // If the branch is someone else's parent the deletion is not (yet) supported
  for (var i = 0; i < this.branches.length; i++) {
    var bra = this.branches[i];
    if (bra.owner === branchName) {
      this.logger.log("WARN", "Can't delete branch because it's " + bra.name + "'s parent", "TwManager.deleteBranch", {branch: branchName});
      return callback(InDe.rh.t("tw_delete_branch_not_leaf_err", {_b: branchName, _ow: bra.name}));
    }
  }
  //
  // Delete the branch folder
  branch.deleteBranchFolder(function (err) {
    if (err) {
      pthis.logger.log("WARN", "Can't delete branch folder: " + err, "TwManager.deleteBranch", {branch: branchName});
      return callback(InDe.rh.t("tw_delete_err"));
    }
    //
    // Delete the branch obj from the array and save the configuration
    var index = pthis.branches.indexOf(branch);
    pthis.branches.splice(index, 1);
    //
    // Inform the client that a branch has been deleted
    pthis.sendBranchesList();
    //
    // If the deleted branch is a PR
    if (branch.type === Node.Branch.PR) {
      // If the PR has not been merged, tell the console that a PR has been rejected
      if (!branch.merged) {   // See TwManager::merge
        var prInfo = {uid: branch.uid, status: "rejected"};
        pthis.child.request.sendTwPrInfo(pthis.child.project.user.userName, pthis.child.project.name, prInfo, function (err) {
          if (err)
            pthis.logger.log("WARN", "Can't send TwPrInfo to console: " + err, "TwManager.deleteBranch", {prInfo: prInfo});
        });
      }
      //
      // Update UI
      pthis.sendTWstatus();
    }
    //
    // Operation completed
    pthis.saveConfig(function (err) {
      if (err) {
        pthis.logger.log("WARN", "Error while saving config file: " + err, "TwManager.deleteBranch");
        return callback(InDe.rh.t("tw_delete_err"));
      }
      //
      // Log the branch deletion
      pthis.logger.log("DEBUG", "Branch removed", "TwManager.deleteBranch", {branch: branchName});
      //
      // Operation completed
      callback();
    });
  });
};


/**
 * Rename a branch
 * @param {string} branchName
 * @param {string} newBranchName
 * @param {function} callback - function(err)
 */
Node.TwManager.prototype.renameBranch = function (branchName, newBranchName, callback)
{
  var pthis = this;
  //
  // Check if the branch to be renamed is the MASTER
  if (branchName === "master") {
    this.logger.log("WARN", "Can't rename MASTER branch", "TwManager.renameBranch", {branch: branchName});
    return callback(InDe.rh.t("tw_branch_rename_master_err", {_b: branchName}));
  }
  //
  // Check if the branch to be renamed exists
  var branch = this.getBranchByName(branchName);
  if (!branch) {
    this.logger.log("WARN", "Branch not found", "TwManager.renameBranch", {branch: branchName});
    return callback(InDe.rh.t("tw_branch_not_exists_err", {_b: branchName}));
  }
  //
  // Rename the branch folder
  var path = this.path + "/branches/" + branch.name;
  var newPath = this.path + "/branches/" + newBranchName;
  Node.fs.rename(path, newPath, function (err) {
    if (err) {
      pthis.logger.log("WARN", "Can't rename branch folder: " + err, "TwManager.renameBranch", {branch: branchName, newBranch: newBranchName});
      return callback(InDe.rh.t("tw_rename_err"));
    }
    //
    // Update branhc's name
    branch.name = newBranchName;
    //
    // Inform the client that a branch has been updated
    pthis.sendBranchesList();
    //
    // Operation completed
    pthis.saveConfig(function (err) {
      if (err) {
        pthis.logger.log("WARN", "Error while saving config file: " + err, "TwManager.renameBranch");
        return callback(InDe.rh.t("tw_rename_err"));
      }
      //
      // Log the branch deletion
      pthis.logger.log("DEBUG", "Branch renamed", "TwManager.renameBranch", {branch: branchName, newBranch: newBranchName});
      //
      // Operation completed
      callback();
    });
  });
};


/**
 * Switch to the given branch
 * @param {sring} branchName
 * @param {function} callback - function(err)
 */
Node.TwManager.prototype.switchBranch = function (branchName, callback)
{
  var pthis = this;
  //
  // First, check if the branch exists
  var branch = this.getBranchByName(branchName);
  if (!branch) {
    this.logger.log("WARN", "Branch not found", "TwManager.switchBranch", {branch: branchName});
    return callback(InDe.rh.t("tw_branch_not_exists_err", {_b: branchName}));
  }
  //
  // If there are unsaved modifications -> can't continue
  if (this.memoryModif()) {
    this.logger.log("WARN", "Can't switch: there are unsaved modifications", "TwManager.switchBranch");
    return callback(InDe.rh.t("tw_memory_mod"));
  }
  //
  // If there are unresolved conflicts, can't switch branch
  if (this.actualBranch.conflict) {
    this.logger.log("WARN", "Can't switch due to conflicts", "TwManager.switchBranch", {branch: branchName});
    return callback(InDe.rh.t("tw_switch_confl_err", {_n: branchName}));
  }
  //
  // Get the list of commits to execute in order to switch from current branch to the requested one
  var commits = this.getDiffBranchSwitch(branchName);
  //
  // If there are local modifications and there is something to do I can't switch... I would have to undo the local modifications as well
  // But if there is nothing to be done (the new branch is aligned with the current branch) I can switch like Git does
  if (this.localModif() && (commits.undoList.length || commits.redoList.length)) {
    this.logger.log("WARN", "Can't switch: there are local modifications", "TwManager.switchBranch", {branch: branchName});
    return callback(InDe.rh.t("tw_switch_locmod_err"));
  }
  //
  // Undo the commits that have to be undoed (backward)
  for (var i = commits.undoList.length - 1; i >= 0; i--)
    commits.undoList[i].undo(true);   // Handle conflicts (i.e. missing objects)
  //
  // Redo the commits that have to be redoed
  for (var j = 0; j < commits.redoList.length; j++)
    commits.redoList[j].redo(false);  // Handle any conflict (but don't report them)
  //
  // Now the actual branch has changed
  this.actualBranch = this.getBranchByName(branchName);
  //
  // Function that completes the operation: save config & update UI
  var completeSwitch = function () {
    pthis.saveConfig(function (err) {
      if (err) {
        pthis.logger.log("WARN", "Error while saving config file: " + err, "TwManager.switchBranch", {branch: branchName});
        return callback(InDe.rh.t("tw_switch_err"));
      }
      //
      // Send the updated branch list to the client
      pthis.sendBranchesList();
      //
      // Log the branch switch
      pthis.logger.log("DEBUG", "Switched branch", "TwManager.switchBranch", {branch: branchName});
      //
      // Operation completed
      callback();
    });
  };
  //
  // If I've done something
  if (commits.undoList.length || commits.redoList.length) {
    // Remove all transactions and save the document
    this.emptyTransList();
    this.saveDocument(function (err) {
      if (err) {
        pthis.logger.log("WARN", "Error while saving document: " + err, "TwManager.switchBranch", {branch: branchName});
        return callback(InDe.rh.t("tw_switch_err"));
      }
      //
      // Invalidate list of parent commits... I've changed branch and the list must be refreshed using
      // the new branch as parameter
      delete pthis.parentCommits;
      //
      // Update UI
      pthis.sendTWstatus();
      //
      // Done -> complete switch
      completeSwitch();
    });
  }
  else  // Nothing changed -> complete switch
    completeSwitch();
};


/**
 * Returns the list of all given branch's commits that are not inside the active branch
 * @param {string} branchName
 */
Node.TwManager.prototype.getDiffBranch = function (branchName)
{
  var branch = this.getBranchByName(branchName);
  if (!branch) {
    this.logger.log("WARN", "Branch not found", "TwManager.getDiffBranch", {branch: branchName});
    return [];
  }
  //
  // Returns all the commits that are in the given branch but that are NOT in the actual branch
  var commits = this.actualBranch.getDiffBranch(branch);
  return commits;
};


/**
 * Get the difference between the given branch and the active branch
 * @param {string} branchName
 */
Node.TwManager.prototype.getDiffBranchSwitch = function (branchName)
{
  // It's a diff-branch thus I need to compute the list of transactions that have to be undoed
  // and the list of transactions that have to be redoed in order to "move" from the active branch
  // to the given branch
  //
  // Get all the commits in the target branch
  var newBranch = this.getBranchByName(branchName);
  if (!newBranch) {
    this.logger.log("WARN", "Branch not found", "TwManager.getDiffBranchSwitch", {branch: branchName});
    return {undoList: [], redoList: []};
  }
  //
  var commitsActual = this.actualBranch.loadAllCommits();
  var commitsNew = newBranch.loadAllCommits();
  //
  // The idea is the following: search the "common point" inside both list
  // ( i.e. the index in the array where both lists have the same commit)
  var undoList = [];
  var redoList = [];
  var commonCommitIdx;
  var i, j, idx;
  for (i = 0; i < commitsActual.length; i++) {
    var comm = commitsActual[i];
    //
    // If I still haven't found the first non common element
    if (commonCommitIdx === undefined) {
      // Search inside the other branch if this commit exists
      idx = undefined;
      for (j = 0; j < commitsNew.length && idx === undefined; j++)
        if (commitsNew[j].id === comm.id)
          idx = j;
      if (idx === i)
        continue;   // This commit was already inside the branch and in the same position -> continue the search
      else
        commonCommitIdx = i; // The commit is not inside the branch or is not in the same position -> this is the first non common element
    }
    //
    // This must be undoed
    undoList.push(comm);
  }
  //
  // Prepare the list of commits that have to be redoed
  for (j = (commonCommitIdx !== undefined ? commonCommitIdx : commitsActual.length); j < commitsNew.length; j++)
    redoList.push(commitsNew[j]);
  //
  return {undoList: undoList, redoList: redoList};
};


/**
 * Commit the local modifications
 * @param {string} message
 * @param {function} callback - function(err)
 */
Node.TwManager.prototype.commit = function (message, callback)
{
  var pthis = this;
  //
  // If there are unsaved modifications -> can't continue
  if (this.memoryModif()) {
    this.logger.log("WARN", "Can't commit: there are unsaved modifications", "TwManager.commit");
    return callback(InDe.rh.t("tw_memory_mod"));
  }
  //
  // If there are no local modifications, do nothing
  if (!this.localModif()) {
    this.logger.log("WARN", "Can't commit: nothing to commit", "TwManager.commit");
    return callback(InDe.rh.t("tw_no_commit"));
  }
  //
  // Create a new commit with the given message
  var newCommit = pthis.actualBranch.createCommit(message);
  //
  // Copy the staging area inside the new commit
  var pathCommit = pthis.path + "/branches/" + pthis.actualBranch.name + "/" + newCommit.id;
  pthis.getAllSavedModifications(function (trans, err) {
    if (err) {
      pthis.logger.log("WARN", "Error while getting local modifications: " + err, "TwManager.commit");
      return callback(InDe.rh.t("tw_commit_err"));
    }
    //
    pthis.writeJSONFile(pathCommit, trans, function (err) {
      if (err) {
        pthis.logger.log("ERROR", "Error writing to the file" + pathCommit + ": " + err, "TwManager.commit");
        return callback(InDe.rh.t("tw_commit_err"));
      }
      //
      // Compute work-days
      newCommit.workdays = pthis.doc.transManager.computeWorkDays(trans);
      //
      // OK. Now let's take care of resources
      pthis.getWorkingResources(function (resources, err) {
        if (err)
          return callback(InDe.rh.t("tw_commit_err"));
        //
        // Ask the branch to "merge" the resources that are in the staging area inside the branch
        // (the resources array have been filtered thus only the used ones are actually in there)
        pthis.actualBranch.saveResources(resources, function (err) {
          if (err)
            return callback(InDe.rh.t("tw_commit_err"));
          //
          // Remove staging area
          Node.rimraf(pthis.path + "/trans", function (err) {
            if (err) {
              pthis.logger.log("ERROR", "Error removing the staging area " + pthis.path + "/trans: " + err, "TwManager.commit");
              return callback(InDe.rh.t("tw_commit_err"));
            }
            //
            // Clear the resources array for this sessions
            pthis.doc.resources = [];
            //
            // Now, that everything if fine, save the list of the commits in the branch
            pthis.actualBranch.saveCommitsList(function (err) {
              if (err) {
                pthis.logger.log("WARN", "Error while saving commit list: " + err, "TwManager.commit");
                return callback(InDe.rh.t("tw_commit_err"));
              }
              //
              // Empty the list of in-memory changes
              pthis.emptyTransList();
              //
              // Update UI
              pthis.sendTWstatus();
              //
              // Invalidate list of parent commits... Now that I've committed it's the right time to re-check
              // if I can fetch changes from the parent project
              delete pthis.parentCommits;
              //
              // Log the commit
              pthis.logger.log("DEBUG", "Branch committed", "TwManager.commit", {branch: pthis.actualBranch.name, commit: newCommit.id});
              //
              // Operation completed
              callback();
            });
          });
        });
      });
    });
  });
};


/**
 * Merge the actual branch with the given one
 * @param {string} branchName - branch to be merged
 * @param {function} callback - function(err)
 */
Node.TwManager.prototype.merge = function (branchName, callback)
{
  var pthis = this;
  //
  var branch = this.getBranchByName(branchName);
  if (!branch) {
    this.logger.log("WARN", "Branch not found", "TwManager.merge", {branch: branchName});
    return callback(InDe.rh.t("tw_branch_not_exists_err", {_b: branchName}));
  }
  //
  // If there are unsaved modifications -> can't continue
  if (this.memoryModif()) {
    this.logger.log("WARN", "Can't merge: there are unsaved modifications", "TwManager.merge");
    return callback(InDe.rh.t("tw_memory_mod"));
  }
  //
  // If there are local modifications -> can't continue
  if (this.localModif()) {
    this.logger.log("WARN", "Can't switch: there are local modifications", "TwManager.merge");
    return callback(InDe.rh.t("tw_switch_locmod_err"));
  }
  //
  // If there are unresolved conflicts, can't merge
  if (this.actualBranch.conflict) {
    this.logger.log("WARN", "Can't merge: branch has conflicts", "TwManager.merge", {branch: branchName});
    return callback(InDe.rh.t("tw_merge_confl_err", {_b: branchName}));
  }
  //
  // Do merge (checking for conflicts)
  branch.merge(true, function (err) {
    if (err) {
      pthis.logger.log("WARN", "Merge failed: " + err, "TwManager.merge", {branch: branchName});
      return callback(InDe.rh.t("tw_merge_err"));
    }
    //
    // If the source branch was a PR, remove it
    if (branch.type === Node.Branch.PR) {
      // Remember that this branch has been merged
      // (used inside the deleteBranch: if the branch is a PR and has been deleted
      // without merging I need to tell the console that the branch has been rejected)
      branch.merged = true;
      //
      pthis.deleteBranch(branch.name, function (err) {
        if (err) {
          pthis.logger.log("WARN", "Can't delete a PR branch: " + err, "TwManager.merge", {branch: branchName});
          return callback(InDe.rh.t("tw_merge_err"));
        }
        //
        // Tell the console that a PR has been merged
        var prInfo = {uid: branch.uid, status: "accepted"};
        pthis.child.request.sendTwPrInfo(pthis.child.project.user.userName, pthis.child.project.name, prInfo, function (err) {
          if (err)
            pthis.logger.log("WARN", "Can't send TwPrInfo to console: " + err, "TwManager.merge", {prInfo: prInfo});
          //
          mergeCompleted();
        });
      });
    }
    else
      mergeCompleted();
  });
  //
  var mergeCompleted = function () {
    // Remove all transactions and save the document
    pthis.emptyTransList();
    pthis.saveDocument();
    //
    // Save the list of commits (new commits have been added to the actual branch)
    pthis.actualBranch.saveCommitsList(function (err) {
      if (err) {
        pthis.logger.log("WARN", "Error while saving commit list: " + err, "TwManager.merge");
        return callback(InDe.rh.t("tw_merge_err"));
      }
      //
      // Save the configuration file
      pthis.saveConfig(function (err) {
        if (err) {
          pthis.logger.log("WARN", "Error while saving config: " + err, "TwManager.merge");
          return callback(InDe.rh.t("tw_merge_err"));
        }
        //
        // Update UI (there could be conflicts)
        pthis.sendTWstatus();
        //
        // Log the branch merge
        pthis.logger.log("DEBUG", "Branch merged", "TwManager.merge", {branch: branchName});
        //
        // Operation completed
        callback();
      });
    });
  };
};


/**
 * Rebase the actual branch using the given one
 * @param {string} branchName - branch to be used for rebase
 * @param {function} callback - function(err)
 */
Node.TwManager.prototype.rebase = function (branchName, callback)
{
  var pthis = this;
  //
  // If there are unsaved modifications -> can't continue
  if (this.memoryModif()) {
    this.logger.log("WARN", "Can't rebase: there are unsaved modifications", "TwManager.rebase");
    return callback(InDe.rh.t("tw_memory_mod"));
  }
  //
  // Check if there are local modifications
  // (the rebase works unmounting commits, merging with brute force then redoing commits...
  // it does not take into account local changes... better don't do it if there are any)
  if (this.localModif()) {
    this.logger.log("WARN", "Can't rebase: there are local modifications", "TwManager.rebase", {branch: branchName});
    return callback(InDe.rh.t("tw_switch_locmod_err"));
  }
  //
  var branch = this.getBranchByName(branchName);
  if (!branch) {
    this.logger.log("WARN", "Branch not found", "TwManager.rebase", {branch: branchName});
    return callback(InDe.rh.t("tw_branch_not_exists_err", {_b: branchName}));
  }
  //
  // If there are unresolved conflicts, can't merge
  if (this.actualBranch.conflict) {
    this.logger.log("WARN", "Can't rebase branch due to conflicts", "TwManager.rebase", {branch: branchName});
    return callback(InDe.rh.t("tw_merge_confl_err", {_b: branchName}));
  }
  //
  var rebaseCompleted = function () {
    // Remove all transactions and save the document
    pthis.emptyTransList();
    pthis.saveDocument();
    //
    // Save the list of commits (new commits have been added to this branch)
    pthis.actualBranch.saveCommitsList(function (err) {
      if (err) {
        pthis.logger.log("WARN", "Error while saving commit list: " + err, "TwManager.rebase");
        return callback(InDe.rh.t("tw_merge_err"));
      }
      //
      // Save the configuration file
      pthis.saveConfig(function (err) {
        if (err) {
          pthis.logger.log("WARN", "Can't save config: " + err, "TwManager.rebase");
          return callback(InDe.rh.t("tw_merge_err"));
        }
        //
        // If the branch was a PR, update UI
        if (branch.type === Node.Branch.PR)
          pthis.sendTWstatus();
        //
        // Log the branch merge
        pthis.logger.log("DEBUG", "Actual branch rebased", "TwManager.rebase", {actBranch: pthis.actualBranch.name, branch: branchName});
        //
        // Operation completed
        callback();
      });
    });
  };
  //
  // Rebase
  this.actualBranch.rebase(branch, function (err) {
    if (err) {
      pthis.logger.log("WARN", "Rebase failed: " + err, "TwManager.rebase", {actBranch: pthis.actualBranch.name, branch: branchName});
      return callback(InDe.rh.t("tw_merge_err"));
    }
    //
    // If the source branch was a PR, remove it
    if (branch.type === Node.Branch.PR)
      pthis.deleteBranch(branch.name, function (err) {
        if (err) {
          pthis.logger.log("WARN", "Can't delete a PR branch: " + err, "TwManager.rebase", {branch: branchName});
          return callback(InDe.rh.t("tw_merge_err"));
        }
        //
        rebaseCompleted();
      });
    else
      rebaseCompleted();
  });
};


/**
 * Get all saved transactions
 * @param {function} callback - function(trans, err)
 */
Node.TwManager.prototype.getAllSavedModifications = function (callback)
{
  var pthis = this;
  //
  // Read the SAVE.json file and list all transactions in all sessions
  var pathSave = this.path + "/trans/save.json";
  Node.fs.exists(pathSave, function (exists) {
    if (exists) {
      // Read the file
      pthis.readJSONFile(pathSave, function (sessions, err) {
        if (err) {
          pthis.logger.log("ERROR", "Error reading the file " + pathSave + ": " + err, "TwManager.getAllSavedModifications");
          return callback(null, err);
        }
        //
        // Concat all the transactions for all sessions
        var trans = [];
        var addSession = function (i) {
          // If there are no more sessions -> I've done
          if (i >= sessions.length)
            return callback(trans);
          //
          var pathSession = pthis.path + "/trans/" + sessions[i].id;
          pthis.readJSONFile(pathSession, function (trlist, err) {
            if (err) {
              pthis.logger.log("ERROR", "Error reading the file " + pathSession + ": " + err, "TwManager.getAllSavedModifications");
              return callback(null, err);
            }
            //
            trans = trans.concat(trlist);
            //
            addSession(i + 1);   // Next one
          });
        };
        //
        // Start with the first session
        addSession(0);
      });
    }
    else
      callback([]);
  });
};


/**
 * Returns an array of trans items relative to the given object
 * @param {string} objid - id of the object I'm interested in
 * @param {function} callback - function(items)
 */
Node.TwManager.prototype.getMemoryTransItemsById = function (objid, callback)
{
  var trMemory = new InDe.Transaction(this.doc.transManager);
  var translist = this.doc.transManager.translist;
  for (var i = translist.length - 1; i >= 0; i--) {     // Move back in time starting from the last transaction
    var tr = translist[i];
    if (tr.saved)   // If this has been saved, I've already checked for it above
      continue;
    //
    // Preview the transaction as UNDO
    tr.preview("undo", true);   // Note: callee will clear the preview
    //
    // Add all items to trMemory transaction
    for (var j = tr.transItems.length - 1; j >= 0; j--)
      trMemory.transItems.unshift(tr.transItems[j]);
  }
  //
  // Now filter all items using the given object id
  var items = trMemory.getItemsForObj(objid);
  //
  // Return to callee
  callback(items);
};


/**
 * Returns an array of trans items relative to the given object
 * @param {string} objid - id of the object I'm interested in
 * @param {function} callback - function(items, err)
 */
Node.TwManager.prototype.getAllSavedTransItemsById = function (objid, callback)
{
  var trSaved = new InDe.Transaction(this.doc.transManager);
  //
  var pathSave = this.path + "/trans/save.json";
  Node.fs.exists(pathSave, function (exists) {
    if (exists) {
      // Read all transactions and get only relevant items
      this.readJSONFile(pathSave, function (sessions, err) {
        if (err) {
          this.logger.log("ERROR", "Error reading the file " + pathSave + ": " + err, "TwManager.getAllSavedTransItemsById");
          return callback(null, err);
        }
        //
        // Read each session and check if it contains changes relative to the given object (do it backwards)
        var readLastSession = function () {
          // If there are no more sessions
          if (sessions.length === 0) {
            // Filter items using given object
            var items = trSaved.getItemsForObj(objid);
            //
            // Copy date into items array (so that callee can get it from there)
            items.date = trSaved.date;
            //
            // Return to callee
            return callback(items);
          }
          //
          // Read last session in the list
          var sess = sessions.pop();
          var sessionFile = this.path + "/trans/" + sess.id;
          this.readJSONFile(sessionFile, function (trlist, err) {
            if (err) {
              this.logger.log("ERROR", "Error reading the file " + sessionFile + ": " + err, "TwManager.getAllSavedTransItemsById");
              return callback(null, err);
            }
            //
            // Read all session's transactions
            for (var i = trlist.length - 1; i >= 0; i--) {
              var tr = new InDe.Transaction(this.doc.transManager);
              tr.load(trlist[i]);
              //
              // Relink all transaction's items. Here I'm watching "old" transactions
              // Moreover I'm interested in an object that is already in the document thus
              // I don't care about RC nor AC... (i.e. the operation (undo/redo) should not be that important)
              tr.preview("undo", true);   // Note: callee will clear the preview
              //
              // Store date of latest transaction
              if (!trSaved.date)
                trSaved.date = tr.date;
              //
              // Add all items to resultTr transaction
              for (var j = tr.transItems.length - 1; j >= 0; j--)
                trSaved.transItems.unshift(tr.transItems[j]);
            }
            //
            readLastSession();      // Next one
          }.bind(this));
        }.bind(this);
        //
        readLastSession();
      }.bind(this));
    }
    else
      callback();
  }.bind(this));
};


/**
 * Reset all the local modifications
 * @param {function} callback - function(err)
 */
Node.TwManager.prototype.reset = function (callback)
{
  var pthis = this;
  //
  // If there are unsaved modifications -> can't continue
  if (this.memoryModif()) {
    this.logger.log("WARN", "Can't commit: there are unsaved modifications", "TwManager.reset");
    return callback(InDe.rh.t("tw_memory_mod"));
  }
  //
  var pathSave = this.path + "/trans/save.json";
  Node.fs.exists(pathSave, function (exists) {
    // If there are no saved modifications and no local modifications, do nothing
    if (!exists && pthis.doc.transManager.translist.length === 0) {
      pthis.logger.log("INFO", "Nothing to reset", "TwManager.reset");
      return callback(InDe.rh.t("tw_no_reset"));
    }
    //
    // First undo all local modifications (backward)
    var translist = pthis.doc.transManager.translist;
    for (var i = translist.length - 1; i >= 0; i--)
      translist[i].undo();
    //
    // Then undo all saved modifications (backward)
    pthis.getAllSavedModifications(function (trans, err) {
      if (err) {
        pthis.logger.log("WARN", "Error while retrieving the saved modifications: " + err, "TwManager.reset");
        return callback(InDe.rh.t("tw_reset_err"));
      }
      //
      for (var j = trans.length - 1; j >= 0; j--) {
        var tr = new InDe.Transaction(pthis.doc.transManager);
        tr.load(trans[j]);
        //
        // Check if this is inside the local modifications list (that I've already undoed before)
        var skip = false;
        for (var i = 0; i < translist.length && !skip; i++) {
          if (tr.id === translist[i].id)
            skip = true;
        }
        if (!skip) {
          // Inform the client that this transaction can be UNDOED even if he does not have it
          tr.twOperation = true;
          tr.undo();
        }
      }
      //
      // Remove the saved modifications folder
      Node.rimraf(pthis.path + "/trans", function (err) {
        if (err) {
          pthis.logger.log("ERROR", "Error removing the " + pthis.path + "/trans directory: " + err, "TwManager.reset");
          return callback(InDe.rh.t("tw_reset_err"));
        }
        else {
          // Remove all transactions and save the document
          pthis.emptyTransList();
          pthis.saveDocument(function (err) {
            if (err) {
              pthis.logger.log("WARN", "Error while saving the document after reset: " + err, "TwManager.reset");
              return callback(InDe.rh.t("tw_reset_err"));
            }
            //
            // Log the reset
            pthis.logger.log("DEBUG", "Project resetted", "TwManager.reset");
            //
            callback();
            //
            // Update TW status (now there is nothing more to commit)
            pthis.sendTWstatus();
          });
        }
      });
    });
  });
};


/**
 * Reverts all the local modifications
 * (for every commit between the last one and the given one,
 * create new commits that do the opposite operations)
 * @param {object} options - {commitID: commit to revert to, message: message to be used for the new commit}
 * @param {function} callback - function(err)
 */
Node.TwManager.prototype.revert = function (options, callback)
{
  this.logger.log("DEBUG", "Reverting project", "TwManager.revert", options);
  //
  // Start by resetting to the last commit
  this.reset(function (err) {
    // If there are errors (and the error is not "nothing to reset"), stop
    if (err && err !== InDe.rh.t("tw_no_reset")) {
      this.logger.log("WARN", "Error while resetting changes: " + err, "TwManager.revert");
      return callback(InDe.rh.t("tw_revert_err"));
    }
    //
    // Revert
    this.actualBranch.revert(options, function (err) {
      if (err) {
        this.logger.log("WARN", "Error while reverting changes: " + err, "TwManager.revert");
        return callback(InDe.rh.t("tw_revert_err"));
      }
      //
      // Remove all transactions and save the document
      this.emptyTransList();
      this.saveDocument(function (err) {
        if (err) {
          this.logger.log("WARN", "Error while saving the document after revert: " + err, "TwManager.revert");
          return callback(InDe.rh.t("tw_revert_err"));
        }
        //
        // Log the reset
        this.logger.log("DEBUG", "Project reverted", "TwManager.revert");
        //
        callback();
        //
        // Update TW status (now there is nothing more to commit)
        this.sendTWstatus();
      }.bind(this));
    }.bind(this));
  }.bind(this));
};


/**
 * Returns the list of all resources in the staging area
 * @param {function} callback - function(resources, err)
 */
Node.TwManager.prototype.getWorkingResources = function (callback)
{
  var pthis = this;
  //
  var pathTrans = this.path + "/trans/save.json";
  Node.fs.exists(pathTrans, function (exists) {
    if (exists) {
      var resources = [];
      pthis.readJSONFile(pathTrans, function (sess, err) {
        if (err) {
          pthis.logger.log("ERROR", "Error reading the file " + pathTrans + ": " + err, "TwManager.getWorkingResources");
          return callback(null, err);
        }
        //
        for (var i = 0; i < sess.length; i++) {
          var se = sess[i];
          for (var j = 0; j < se.resources.length; j++) {
            var res = se.resources[j];
            if (resources.indexOf(res) === -1)
              resources.push(res);
          }
        }
        //
        callback(resources);
      });
    }
    else
      callback([]);
  });
};


/**
 * Pushes the current branch to the parent project
 * @param {object} options - options to be used {msg: message, pr: true if is a PR}
 * @param {function} callback - function(err)
 */
Node.TwManager.prototype.pushBranch = function (options, callback)
{
  var pthis = this;
  //
  // If I don't have a parent project, I can do nothing
  if (this.parentProject === false) {
    this.logger.log("WARN", "The project has no parent project", "TwManager.pushBranch");
    return callback(InDe.rh.t("tw_backup_err"));
  }
  else if (this.parentProject === undefined) {
    // I don't know if I have a parent project... I need to ask
    this.hasParentProject(function () {
      // Now I know something abount my parent project... I can push the branch
      return pthis.pushBranch(options, callback);
    });
    return;
  }
  //
  // I have a parent project... I now can backup my branch under target's (parent) user cloud space
  // (NOTE: backup the given branch in the parent's cloud space)
  var newBranchName = this.child.project.user.userName + "_" + this.child.project.name + "_" + this.actualBranch.name;
  var pathCloud = "users/" + this.child.config.serverType + "/" +
          this.parentProject.user + "/" + this.parentProject.project + "/branches/" + newBranchName + ".tar.gz";
  this.actualBranch.backup(pathCloud, function (err) {
    if (err) {
      pthis.logger.log("WARN", "Error while backing up the branch " + pthis.actualBranch.name + ": " + err, "TwManager.pushBranch");
      return callback(InDe.rh.t("tw_backup_err"));
    }
    //
    // Now I have a backup. Ask the parent project to restore it
    // (Note: this calls the following TwManager::handleRestoreBranch method on the parent project)
    // (Note2: send also source info (user, project, company, the one that is pushing this branch) required by console)
    var opt = {msg: options.msg, pr: options.pr, srcUser: pthis.child.project.user.userName, srcProject: pthis.child.project.name,
      srcCompany: pthis.child.config.serverType};
    pthis.child.request.restoreBranch(newBranchName, pthis.parentProject, opt, function (err) {
      if (err) {
        pthis.logger.log("ERROR", "Error while restoring branch inside parent project: " + err, "TwManager.pushBranch");
        return callback(InDe.rh.t("tw_backup_err"));
      }
      //
      // Declare all sent commits as pushed
      pthis.actualBranch.setPushed(function (err) {
        if (err) {
          pthis.logger.log("WARN", "Can't set all commits as pushed: " + err, "TwManager.pushBranch", {branch: pthis.actualBranch.name});
          return callback(InDe.rh.t("tw_backup_err"));
        }
        //
        // Operation completed
        callback();
        //
        // Update TW status (now there is nothing more to push)
        pthis.sendTWstatus();
      });
    });
  });
};


/**
 * Handles a push from the child project (NOTE: I'm on the parent project side)
 * (called by child.js when a restoreBranch has been asked through an HTTP request)
 * @param {object} options - options to be used {branch, msg, pr, user, project}
 * @param {function} callback - function(err)
 */
Node.TwManager.prototype.handleRestoreBranch = function (options, callback)
{
  var pthis = this;
  var branch;
  //
  // Cloud path where the branch is to be downloaded
  var pathCloud = "users/" + this.child.config.serverType + "/" + this.child.project.user.userName +
          "/" + this.child.project.name + "/branches/" + options.branch + ".tar.gz";
  //
  // Define function that does the actual work (i.e. restore)
  var doRestore = function () {
    branch.restore(pathCloud, function (err) {
      if (err) {
        pthis.logger.log("WARN", "Error while restoring the branch: " + err, "TwManager.handleRestoreBranch", {pathCloud: pathCloud});
        return callback(err);
      }
      //
      // Update the client status
      pthis.sendTWstatus();
      //
      // A new branch has been received. Update document's branch list
      pthis.sendBranchesList();
      //
      // Operation completed
      pthis.saveConfig(function (err) {
        if (err) {
          pthis.logger.log("WARN", "Error while saving the config file: " + err, "TwManager.handleRestoreBranch");
          return callback(err);
        }
        //
        // If this is a PR, tell the console that a new PR has been created
        if (branch.type === Node.Branch.PR) {
          var prInfo = {id: branch.id, uid: branch.uid, status: "created", message: branch.message, branch: pthis.actualBranch.name,
            user: options.srcUser, project: options.srcProject, company: options.srcCompany};
          pthis.child.request.sendTwPrInfo(pthis.child.project.user.userName, pthis.child.project.name, prInfo, function (err) {
            if (err)
              pthis.logger.log("WARN", "Can't send TwPrInfo to console: " + err, "TwManager.handleRestoreBranch", {prInfo: prInfo});
            //
            callback(err);
          });
        }
        else  // Not a PR -> don't need to say anything to the console
          callback();
      });
    });
  };
  //
  // Delete the branch if it is already here
  branch = this.getBranchByName(options.branch);
  if (branch) {
    // "Elevate" if needed (if this was a push and now is a PR, change it to PR type)
    if (options.pr)
      branch.type = Node.Branch.PR;
    //
    // Append message (if given and if there was a previous message)
    if (branch.message && options.msg && branch.message !== options.msg)
      branch.message = branch.message + "\n" + options.msg;
    //
    // Delete previous branch folder
    branch.deleteBranchFolder(function (err) {
      if (err) {
        pthis.logger.log("WARN", "Error while deleting the old branch: " + err, "TwManager.handleRestoreBranch", {branch: branch.name});
        return callback(err);
      }
      //
      doRestore();
    });
  }
  else {
    // Branch does not exist. Create a new one
    branch = new Node.Branch(pthis);
    branch.name = options.branch;
    if (options.pr)
      branch.type = Node.Branch.PR;
    branch.message = options.msg;
    branch.date = new Date();
    //
    // Give this PR a number and add it to the list.
    branch.id = this.numPR++;
    branch.uid = Node.Utils.generateUID36();      // Unique identifier (for the console)
    this.branches.push(branch);
    //
    doRestore();
  }
};


/**
 * Pulls the given branch from the parent project and merges it into the current branch
 * @param {string} branchName - branch to backup
 * @param {object} options - options to be used {diff: true/false} (if TRUE don't merge but show differences)
 * @param {function} callback - function(err)
 */
Node.TwManager.prototype.pullBranch = function (branchName, options, callback)
{
  var pthis = this;
  //
  // If I don't have a parent project, I can do nothing
  if (this.parentProject === false) {
    this.logger.log("WARN", "The project has no parent project", "TwManager.pullBranch");
    return callback(InDe.rh.t("tw_fetch_err"));
  }
  else if (this.parentProject === undefined) {
    // I don't know if I have a parent project... I need to ask
    this.hasParentProject(function () {
      // Now I know something abount my parent project... I can push the branch
      return pthis.pullBranch(branchName, options, callback);
    });
    return;
  }
  //
  // Add the list of my commits (IDs) so that the partner can send me only what I really need
  var commitsList = [];
  var commits = this.actualBranch.loadAllCommits();
  for (var i = 0; i < commits.length; i++)
    commitsList.push(commits[i].id);
  commitsList = commitsList.join(",");    // Send a list of commitsIDs separated by comma (,)
  //
  // I have a parent project... Now I can ask my parent project to backup the given branch
  // (Note: this calls the following TwManager::handleBackupBranch method on the parent project)
  var opt = {commits: commitsList, user: this.child.project.user.userName, project: this.child.project.name};
  this.child.request.backupBranch(branchName, this.parentProject, opt, function (err) {
    if (err) {
      pthis.logger.log("ERROR", "Error backing up the parent project branch: " + err, "TwManager.pullBranch", {branch: branchName});
      return callback("Error backing up the parent project branch " + branchName + ": " + err);
    }
    //
    // Delete the branch if it is already here (it could happen if it's a true PULL and I've pulled that branch before)
    var branch = pthis.getBranchByName(pthis.parentProject.user + "_" + pthis.parentProject.project + "_" + branchName);
    if (branch) {
      branch.deleteBranchFolder(function (err) {
        if (err) {
          pthis.logger.log("WARN", "Error while deleting the old branch: " + err, "TwManager.pullBranch", {branch: branch.name});
          return callback("Error while deleting the old branch: " + err);
        }
        //
        // Remove it from the list of branches (when restored a new one will replace this copy)
        var index = pthis.branches.indexOf(branch);
        pthis.branches.splice(index, 1);
        //
        // Continue with restore
        doRestore();
      });
    }
    else { // Branch does not exists...
      setImmediate(function () {    // Use setImmediate so that I can write the doRestore code after this block
        doRestore();
      });
    }
    //
    var doRestore = function () {
      // Now I can restore it from the cloud
      branch = new Node.Branch(pthis);
      branch.name = pthis.parentProject.user + "_" + pthis.parentProject.project + "_" + branchName;
      var pathCloud = "users/" + pthis.child.config.serverType + "/" +
              pthis.child.project.user.userName + "/" + pthis.child.project.name + "/branches/" + branch.name + ".tar.gz";
      branch.restore(pathCloud, function (err) {
        if (err) {
          pthis.logger.log("WARN", "Error restoring branch: " + err, "TwManager.pullBranch", {branch: branchName});
          return callback("Error restoring branch " + branch.name + ": " + err);
        }
        //
        // Now it's one of my branches
        pthis.branches.push(branch);
        //
        // Now if I wanted only DIFF
        if (options.diff === true) {
          // First: this branch is not a PR but it's "like" a PR. Reasons:
          // - this branch will be merged (with rebase, see above), and it will not be used like a normal branch for switching
          // - the sendDiffBranch does not have to send saved/memory modifications (like it would do for any normal branch)
          branch.type = Node.Branch.PR;
          pthis.sendDiffBranch(branch.name);
          delete branch.type;
          //
          // Delete the received (temporary) branch
          pthis.deleteBranch(branch.name, function (err) {
            if (err) {
              pthis.logger.log("WARN", "Error while deleting the diff branch: " + err, "TwManager.pullBranch", {branch: branch.name});
              return callback("Error while deleting the diff branch " + branch.name + ": " + err);
            }
            //
            // Operation completed
            callback();
          });
        }
        else if (options.diff === false) {  // Fetch
          // Rebase the restored branch
          pthis.rebase(branch.name, function (err) {
            if (err) {
              pthis.logger.log("WARN", "Error while rebasing the branch: " + err, "TwManager.pullBranch", {branch: branch.name});
              return callback("Error while rebasing the branch " + branch.name + ": " + err);
            }
            //
            // Delete the new branch
            pthis.deleteBranch(branch.name, function (err) {
              if (err) {
                pthis.logger.log("WARN", "Error while deleting the merged branch: " + err, "TwManager.pullBranch", {branch: branch.name});
                return callback("Error while deleting the merged branch " + branch.name + ": " + err);
              }
              //
              // Something has been fetched from my parent server...
              // Now I need nothing from my parent
              delete pthis.parentCommits;
              //
              // Update the client status
              pthis.sendTWstatus();
              //
              // Operation completed
              callback();
            });
          });
        }
        else {    // Simple pull: operation completed
          // Done, save config (I've a new branch)
          pthis.saveConfig(function (err) {
            if (err) {
              pthis.logger.log("WARN", "Error while saving config file: " + err, "TwManager.pullBranch", {branch: branch.name});
              return callback("Error while saving config file: " + err);
            }
            //
            // Inform the client that a branch has been created
            pthis.sendBranchesList();
            //
            // Operation completed
            callback();
          });
        }
      });
    };
  });
};


/**
 * Handles a fetch/diff_fetch from the child project (NOTE: I'm on the parent project side)
 * (called by child.js when a backupBranch has been asked through an HTTP request)
 * @param {object} options - options to be used {branch, commits, user, project}
 * @param {function} callback - function(err)
 */
Node.TwManager.prototype.handleBackupBranch = function (options, callback)
{
  var pthis = this;
  //
  // Populate the list of "partner"'s commits (so that the backupBranch operates in a differential way)
  this.parentCommits = options.commits.split(",");
  //
  // Check if the branch exists
  var branch = this.getBranchByName(options.branch);
  if (!branch) {
    this.logger.log("WARN", "Branch " + options.branch + " does not exist", "TwManager.handleBackupBranch", {branch: options.branch});
    return callback("Branch " + options.branch + " does not exist");
  }
  //
  // Backup the given branch and store it inside the user/project that requested this backup
  var branchName = this.child.project.user.userName + "_" + this.child.project.name + "_" + branch.name;
  var pathCloud = "users/" + this.child.config.serverType + "/" + options.user + "/" + options.project + "/branches/" + branchName + ".tar.gz";
  branch.backup(pathCloud, function (err) {
    // Cleanup
    delete pthis.parentCommits;
    //
    if (err) {
      pthis.logger.log("WARN", "Error backing up branch: " + err, "TwManager.handleBackupBranch", {branch: branch.name});
      return callback(err);
    }
    //
    // Done!
    callback();
  });
};


/**
 * Save document server-side
 * @param {function} callback - (optional) function(err)
 */
Node.TwManager.prototype.saveDocument = function (callback)
{
  var pthis = this;
  this.doc.saveDocument(function (err) {
    // If there are no errors invalidate keys used for crypting on the client-side
    if (!err)
      pthis.doc.regenerateSaveKeys();
    //
    // Report to callee (if any)
    if (callback)
      callback(err);
  });
};


/**
 * Handles request commands received via HTTP call (see project.js)
 * @param {String} command - command to execute
 * @param {Object} params - optional parameters
 * @param {function} callback - function({data, err})
 */
Node.TwManager.prototype.teamworksCmd = function (command, params, callback)
{
  var i;
  switch (command) {
    case "branches":
      // Return an array with all branches (used by my son during a Fetch)
      var list = [];
      for (i = 0; i < this.branches.length; i++) {
        var bra = this.branches[i];
        list.push({name: bra.name, type: bra.type, conflict: bra.conflict});
      }
      //
      callback({data: list});
      break;

    case "commits":
      var result = {};
      result.actualBranch = this.actualBranch.name;
      if (this.localModif())
        result.localModif = true;
      //
      // Search the given branch
      var branch = this.getBranchByName(params.branch);
      if (!branch) {
        this.logger.log("WARN", "Branch not found", "TwManager.teamworksCmd", {command: command, params: params});
        return callback({err: "Branch not found"});
      }
      //
      // If a date filter was provided, convert it to Date object
      if (params.fromDate)
        params.fromDate = new Date(params.fromDate);
      //
      // Add list of commits of the given branch
      result.commits = [];
      var commits = branch.loadAllCommits();
      for (i = 0; i < commits.length; i++) {
        var com = commits[i];
        //
        // If there is a date filter, use it
        if (params.fromDate && new Date(com.date) < params.fromDate)
          continue;
        //
        // Send back only requested info
        if (params.onlyID)
          result.commits.push({id: com.id});
        else
          result.commits.push({id: com.id, author: com.author, date: com.date, workdays: com.workdays,
            message: com.message, branch: com.parent.name});
      }
      callback({data: result});
      break;

    default:
      this.logger.log("WARN", "Unknown command", "TwManager.teamworksCmd", {command: command, params: params});
      callback({err: "Unknown command " + command});
      break;
  }
};


/**
 * Reads a file using an asynchronous stream
 * @param {string} filename
 * @param {Function} callback - function(res, err)
 */
Node.TwManager.prototype.readJSONFile = function (filename, callback)
{
  var rsFile = Node.fs.createReadStream(filename);
  rsFile.read();
  //
  var txt = "";
  rsFile.on("data", function (chunk) {
    txt += chunk;
  });
  rsFile.on("end", function () {
    callback(txt ? JSON.parse(txt) : {});
  });
  rsFile.on("error", function (err) {
    callback(null, err);
  });
};


/**
 * Writes an object to file using an asynchronous stream
 * @param {string} filename
 * @param {object} obj - object to be saved (if complext type save it as a JSON string)
 * @param {Function} callback - function(err)
 */
Node.TwManager.prototype.writeJSONFile = function (filename, obj, callback)
{
  var wsFile = Node.fs.createWriteStream(filename);
  //
  wsFile.on("finish", function () {
    callback();
  });
  wsFile.on("error", function (err) {
    callback(err);
  });
  //
  if (typeof obj === "object")
    wsFile.write(JSON.stringify(obj));
  else
    wsFile.write(obj);
  wsFile.end();
};


/**
 * Copy a file using streams
 * @param {string} srcFile
 * @param {string} dstFile
 * @param {Function} callback - function(errin, errout)
 */
Node.TwManager.prototype.copyFile = function (srcFile, dstFile, callback)
{
  var rstream = Node.fs.createReadStream(srcFile);
  var wstream = Node.fs.createWriteStream(dstFile);
  //
  rstream.pipe(wstream);
  //
  rstream.on("error", function (err) {
    callback(err);
  });
  wstream.on("error", function (err) {
    callback(null, err);
  });
  wstream.on("finish", function () {
    callback();
  });
};


// Export module
module.exports = Node.TwManager;
