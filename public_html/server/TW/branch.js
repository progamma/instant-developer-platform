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
//
// Import Classes
Node.Commit = require("./commit");
Node.Utils = require("../utils");
InDe.rh = require("../../ide/common/resources");
Node.Archiver = require("../archiver");
InDe.Transaction = require("../../ide/model/Transaction");
InDe.TreeWalker = require("../../ide/model/common/TreeWalker");
InDe.Document = require("../../ide/model/Document");
InDe.AObject = require("../../ide/model/common/AObject");
InDe.AFormula = require("../../ide/model/objects/AFormula");
InDe.AToken = require("../../ide/model/objects/AToken");


/*
 * @param {Node.TwManager} parent
 */
Node.Branch = function (parent)
{
  if (!Node.TwManager)
    Node.TwManager = require("./TwManager");
  //
  this.parent = parent;
};

Node.Branch.PR = "pr";    // type: PullRequest

Node.Branch.ResolveTypeMap = {
  ACCEPT: -1,
  FIXLATER: 0,
  REFUSE: 1
};

/**
 * Save the object
 */
Node.Branch.prototype.save = function ()
{
  var r = {cl: "Node.Branch", name: this.name, owner: this.owner, conflict: this.conflict, type: this.type};
  //
  // If it's a PR, save PR details
  if (this.type === Node.Branch.PR) {
    r.message = this.message;
    r.date = this.date;
    r.id = this.id;
    r.uid = this.uid;
  }
  //
  return r;
};


/**
 * Load the object
 * @param {Object} v - the object that contains my data
 */
Node.Branch.prototype.load = function (v)
{
  this.name = v.name;
  this.owner = v.owner;
  this.conflict = v.conflict;
  this.type = v.type;
  //
  // If it's a PR, load PR details
  if (this.type === Node.Branch.PR) {
    this.message = v.message;
    this.date = v.date;
    this.id = v.id;
    this.uid = v.uid;
  }
};


/**
 * Create a new commit obj and initilize it
 * @param {string} message - message of the commit
 * @return {Node.Commit} the new commit
 */
Node.Branch.prototype.createCommit = function (message)
{
  // Create a new commit
  var commit = new Node.Commit(this);
  commit.message = message;
  //
  // Add the new commit to the list
  this.loadCommitsList();
  this.commits.push(commit);
  //
  return commit;
};


/**
 * Create the branch folder (if does not exist)
 * @param {function} callback - function(err)
 */
Node.Branch.prototype.createBranchFolder = function (callback)
{
  var pthis = this;
  var twManager = this.parent;
  var path = twManager.path + "/branches/";
  //
  // First, create the directory that contain all branches (if needed)
  Node.fs.mkdir(path, function (err) {
    if (err && err.code !== "EEXIST") {
      twManager.logger.log("ERROR", "Error creating the branch folder " + path + ": " + err, "Branch.createBranchFolder");
      return callback(err);
    }
    //
    // Then create the branch directory itself (if needed)
    path += pthis.name;
    Node.fs.mkdir(path, function (err) {
      if (err && err.code !== "EEXIST") {
        twManager.logger.log("ERROR", "Error creating the branch folder " + path + ": " + err, "Branch.createBranchFolder");
        return callback(err);
      }
      //
      callback();
    });
  });
};


/**
 * Flag all commits in this branch as pushed
 * @param {Function} callback - function(err)
 */
Node.Branch.prototype.setPushed = function (callback)
{
  var twManager = this.parent;
  //
  // Load all commits (if not loaded yet)
  this.loadCommitsList();
  //
  // Flag all commits as pushed
  // (if I've a list of parent commits flag only the commits I've not in that list)
  var updateList;
  for (var i = 0; i < this.commits.length; i++) {
    var com = this.commits[i];
    if (!twManager.parentCommits || twManager.parentCommits.indexOf(com.id) === -1) {
      updateList = true;
      com.pushed = new Date();
    }
  }
  //
  // If needed update commit list
  if (updateList)
    this.saveCommitsList(callback);
  else
    callback();
};


/**
 * Returns the list of commits that have not yet been pushed
 */
Node.Branch.prototype.getNotPushedCommits = function ()
{
  var res = [];
  //
  // Load all commits (if not loaded yet)
  this.loadCommitsList();
  //
  // Check if all commits have been pushed
  for (var i = 0; i < this.commits.length; i++) {
    var com = this.commits[i];
    //
    // Skip commits that are links to other branches
    if (com.originBranch)
      continue;
    //
    // If this commit was not pushed the branch is not fully pushed
    if (!com.pushed)
      res.push(com);
  }
  //
  return res;
};


/**
 * Delete the branch folder and all the files
 * @param {function} callback - function(err)
 */
Node.Branch.prototype.deleteBranchFolder = function (callback)
{
  var twManager = this.parent;
  var path = twManager.path + "/branches/" + this.name;
  //
  Node.rimraf(path, function (err) {
    if (err)
      twManager.logger.log("ERROR", "Error deleting the branch folder " + path + ": " + err, "Branch.deleteBranchFolder");
    callback(err);
  });
};


/**
 * Gets all commits that have to do with the given object
 * (each commit contains
 * @param {object} filter - filter to use {objid, start/end, commitid}
 * @param {function} callback - function (commits, err)
 */
Node.Branch.prototype.getCommitsTransItemsByID = function (filter, callback)
{
  var twManager = this.parent;
  //
  // Return an array af all commits that contains transactions with trans items that have something
  // to do with the given object
  var result = [];
  //
  // Compute the requested commits list
  var allCommits = this.loadAllCommits();
  var commitsToSend;
  //
  // If a commit ID was provided, try to search for that commit
  if (filter.commitid) {
    for (var i = 0; i < allCommits.length; i++) {
      var com = allCommits[i];
      if (com.id === filter.commitid) {
        // Remove all commits after the current one
        commitsToSend = allCommits.slice(i);
        break;
      }
    }
  }
  //
  // If not found (or no commitID was provided) use the requested limits
  if (!commitsToSend) {
    // Here I need to use the filter the client gave me. I need to account for the fact that the client counts backwards
    // Suppose I have 25 commits (from 0 to 24). That is what should happen:
    // - the client asks for the START=undefined   ->   I have to send the last 10 commits (i.e. commits 15 to 24)
    // - the client asks for the START=10          ->   I have to send other 10 commits (i.e. commits 5 to 14)
    // - the client asks for the START=20          ->   I have to send the last 5 commits (i.e. commits 0 to 4)
    // So, the START filter option indicates (on my side) the last commit to send
    var lastCommitIdx = (allCommits.length - 1) - (filter.start || 0);
    var firstCommitIdx = Math.max(lastCommitIdx - 10 + 1, 0);      // pageSize = 10
    //
    // Compute the requested commits block to be sent
    commitsToSend = allCommits.slice(firstCommitIdx, lastCommitIdx + 1);
    //
    // Append "more-items" if there are more items to show than the ones sent (i.e. if I've not sent the last commit)
    if (firstCommitIdx !== 0)
      result.moreItems = true;
  }
  //
  // Read each commit and check if it contains changes relative to the given object (do it backwards)
  var readLastCommit = function () {
    // If there are no more commits
    if (commitsToSend.length === 0)
      return callback(result);      // Return to callee
    //
    // Read last commit in the list
    var commit = commitsToSend.pop();
    var commitPath = twManager.path + "/branches/" + commit.parent.name + "/" + commit.id;
    //
    // Load the commit and check if it contains interesting data
    twManager.readJSONFile(commitPath, function (trlist, err) {
      if (err) {
        twManager.logger.log("ERROR", "Error reading the file " + commitPath + ": " + err, "Branch.getCommitsTransItemsByID");
        return callback(null, err);
      }
      //
      // Check if there are items inside this commit: load all its transactions
      var trCommit = new InDe.Transaction(twManager.doc.transManager);
      for (var i = trlist.length - 1; i >= 0; i--) {
        var tr = new InDe.Transaction(twManager.doc.transManager);
        tr.load(trlist[i]);
        //
        // Relink all transaction's items. Here I'm watching "old" transactions
        // Moreover I'm interested in an object that is already in the document thus
        // I don't care about RC nor AC... (i.e. the operation (undo/redo) should not be that important)
        tr.preview("undo", true);   // Note: callee will clear the preview
        //
        // Add all items to resultTr transaction
        for (var j = tr.transItems.length - 1; j >= 0; j--)
          trCommit.transItems.unshift(tr.transItems[j]);
      }
      //
      // Filter items using given object
      var items = trCommit.getItemsForObj(filter.objid);
      if (items.length) {
        var commitClone = new Node.Commit(this);
        commitClone.load(commit.save());
        //
        // Add items
        commitClone.transItems = items;
        //
        // Add the commit to the result array
        result.push(commitClone);
      }
      //
      readLastCommit();
    }.bind(this));
  }.bind(this);
  //
  readLastCommit();
};


/**
 * Save the commits
 * @param {function} callback - function(err)
 */
Node.Branch.prototype.saveCommitsList = function (callback)
{
  var twManager = this.parent;
  //
  // If there are no commits, don't save anything
  if (!this.commits)
    return callback();
  //
  var clist = JSON.stringify(this.commits, function (k, v) {
    if (v instanceof Node.Commit)
      return v.save();
    else
      return v;
  });
  //
  var path = twManager.path + "/branches/" + this.name + "/index.json";
  Node.fs.writeFile(path, clist, function (err) {
    if (err)
      twManager.logger.log("ERROR", "Error writing the file " + path + ": " + err, "Branch.saveCommitsList");
    //
    callback(err);
  });
};


/**
 * Load the commits from the configuration file
 * (N.B.: some of the commits are pointers to other commits in other branches)
 */
Node.Branch.prototype.loadCommitsList = function ()
{
  var twManager = this.parent;
  //
  // If already loaded, do nothing
  if (this.commits)
    return;
  //
  // Load index.json file
  var pthis = this;
  //
  var path = twManager.path + "/branches/" + this.name + "/index.json";
  if (Node.fs.existsSync(path)) {
    var text = Node.fs.readFileSync(path, {encoding: "utf8"});
    pthis.commits = JSON.parse(text, function (k, v) {
      if (v instanceof Object && v.cl !== undefined) {
        if (v.cl === "Node.Commit") {
          var obj = new Node.Commit(pthis);
          obj.load(v);
          return obj;
        }
      }
      else
        return v;
    });
  }
  else
    this.commits = [];
};


/**
 * Returns the FULL list of all commits in this branch
 * (if this branch has a parent branch, load also its parent's commits)
 */
Node.Branch.prototype.loadAllCommits = function ()
{
  var twManager = this.parent;
  //
  // First load the commits list
  this.loadCommitsList();
  //
  // Now, loop over all commits
  var result = [];
  for (var i = 0; i < this.commits.length; i++) {
    var comm = this.commits[i];
    //
    if (comm.originBranch) {
      // The commit is a link to the commit into the parent branch
      // Add all commits in the parent branch, up to this commit
      var parentBranch = twManager.getBranchByName(comm.originBranch);
      //
      var parcommits = parentBranch.loadAllCommits();
      for (var j = 0; j < parcommits.length; j++) {
        var parcomm = parcommits[j];
        result.push(parcomm);
        //
        if (parcomm.id === comm.id)
          break;    // Found the corresponding commit -> stop
      }
    }
    else
      result.push(comm);
  }
  return result;
};


/**
 * Returns the last commit in this branch (if any)
 */
Node.Branch.prototype.getLastCommit = function ()
{
  this.loadCommitsList();
  return this.commits[this.commits.length - 1];
};


/**
 * Returns TRUE if the branch is empty (i.e. it has no commits or it contains a single commit
 * that links this branch with the parent branch)
 */
Node.Branch.prototype.isEmpty = function ()
{
  this.loadCommitsList();
  //
  // If I have no commits -> I'm empty
  if (this.commits.length === 0)
    return true;
  //
  // The I have only 1 commit and that one is a "connection" with parent branch -> I'm empty
  var com = this.commits[0];
  if (this.commits.length === 1 && com.originBranch)
    return true;
};


/**
 * Returns an array with all commits' descriptions
 */
Node.Branch.prototype.getCommitsMessages = function ()
{
  this.loadCommitsList();
  //
  var result = [];
  for (var i = 0; i < this.commits.length; i++) {
    var com = this.commits[i];
    //
    // Skip commits that are links to other branches
    if (com.originBranch)
      continue;
    //
    // If this commit has no message -> skip it
    if (!com.message)
      continue;
    //
    // Skip commits that I haven't created
    if (com.author !== this.parent.child.project.user.userName)
      continue;
    //
    // Skip pushed/merged commits
    if (com.pushed || com.merged)
      continue;
    //
    result.push(com.message);
  }
  return result;
};


/**
 * Returns the list of all given branch's commits that are not inside this branch
 * @param {Node.Branch} branch
 */
Node.Branch.prototype.getDiffBranch = function (branch)
{
  // Load all the commits in both branches
  var myCommits = this.loadAllCommits();
  var branchCommits = branch.loadAllCommits();
  //
  // Returns all the commits that are not in this branch
  var commits = [];
  for (var i = 0; i < branchCommits.length; i++) {
    var com = branchCommits[i];
    //
    var found = false;
    for (var j = 0; j < myCommits.length && !found; j++)
      found = (myCommits[j].id === com.id);
    //
    // If it's not inside my commits, add it to the list
    if (!found)
      commits.push(com);
  }
  //
  return commits;
};


/**
 * Save all the current doc resources inside this branch
 * @param  {array}   resources
 * @param  {function} callback - function(err)
 */
Node.Branch.prototype.saveResources = function (resources, callback)
{
  var twManager = this.parent;
  //
  // First read the current resource list
  var pathIndex = twManager.path + "/branches/" + this.name + "/resources.json";
  twManager.readJSONFile(pathIndex, function (oldResources, err) {
    // If there is an error but it's not "file does not exists", stop
    if (err && err.code !== "ENOENT") {
      twManager.logger.log("ERROR", "Error reading the file" + pathIndex + ": " + err, "Branch.saveResources");
      return callback(err);
    }
    //
    // First merge the resources with the given list
    var i;
    if (oldResources) {
      for (i = 0; i < oldResources.length; i++) {
        var res = oldResources[i];
        if (resources.indexOf(res) === -1)
          resources.push(res);
      }
    }
    //
    // Now purge the unused resources
    var docres = twManager.doc.getResources();
    for (i = 0; i < resources.length; i++)
      if (docres.indexOf(resources[i]) === -1)
        resources.splice(i--, 1);
    //
    twManager.writeJSONFile(pathIndex, resources, function (err) {
      if (err)
        twManager.logger.log("ERROR", "Error writing the file" + pathIndex + ": " + err, "Branch.saveResources");
      callback(err);
    });
  });
};


/**
 * Merge resources from the this branch to the actualBranch (used by the merge method)
 * @param {function} callback - function(err)
 */
Node.Branch.prototype.mergeResources = function (callback)
{
  var twManager = this.parent;
  //
  var srcBranch = twManager.path + "/branches/" + this.name;
  var dstBranch = twManager.path + "/branches/" + twManager.actualBranch.name;
  //
  // Read the resource index in the source branch
  twManager.readJSONFile(srcBranch + "/resources.json", function (reslist, err) {
    // If the file does not exist, there are no resources... go back to the callee
    // otherwise if there are read errors, report the error
    if (err && err.code === "ENOENT")
      return callback();      // Source branch has no resources
    else if (err) {
      twManager.logger.log("ERROR", "Error reading the file " + srcBranch + "/resources.json: " + err, "TwManager.mergeResources");
      return callback(err);
    }
    //
    // If there are no resources to copy, I've done
    if (!reslist.length)
      return callback();
    //
    // The file exists and there have been no read errors
    var copyResource = function (i) {
      var res = reslist[i];
      //
      // Copy this resource into the resources main folder
      var resSrc = srcBranch + "/resources/" + res;
      var resDst = twManager.path + "/resources/" + res;
      twManager.copyFile(resSrc, resDst, function (errin, errout) {
        if (errin) {
          twManager.logger.log("ERROR", "Error reading the file " + resSrc + ": " + errin, "TwManager.mergeResources");
          return callback(errin);
        }
        else if (errout) {
          twManager.logger.log("ERROR", "Error writing the file " + resDst + ": " + errout, "TwManager.mergeResources");
          return callback(errout);
        }
        //
        // If it's not the last one, continue with the next resource,
        // otherwise update the list and report to callee
        if (i < reslist.length - 1)
          copyResource(i + 1);
        else
          updateList();
      });
    };
    //
    var updateList = function () {
      // Update the dstBranch index with all new resources
      twManager.readJSONFile(dstBranch + "/resources.json", function (reslistUpd, err) {
        if (err && err.code !== "ENOENT") {
          twManager.logger.log("ERROR", "Error reading the file " + srcBranch + "/resources.json (2): " + err, "TwManager.mergeResources");
          return callback(err);
        }
        else if (err && err.code === "ENOENT")
          reslistUpd = [];    // Destination branch has no resources
        //
        var toAdd = [];
        for (var i = 0; i < reslist.length; i++) {
          var res = reslist[i];
          //
          // Check if this resource exists already in the list
          var exists = false;
          for (var j = 0; j < reslistUpd.length && !exists; j++)
            exists = (reslistUpd[j] === res);
          if (!exists)
            toAdd.push(res);
        }
        //
        if (toAdd.length) {
          reslistUpd = reslistUpd.concat(toAdd);
          //
          // Write updated file
          twManager.writeJSONFile(dstBranch + "/resources.json", reslistUpd, function (err) {
            if (err)
              twManager.logger.log("ERROR", "Error writing the file " + dstBranch + "/resources.json (2): " + err, "TwManager.mergeResources");
            callback(err);
          });
        }
        else
          callback();
      });
    };
    //
    // This function is called when a PR is merged, when a branch is fetched but also when the
    // user wants to merge a local branch with the master one.
    // In the later case the resources folder is not inside the branch... if that's the case
    // I don't need to copy resources at all... I just need to merge the resources.json files...
    Node.fs.access(srcBranch + "/resources/", function (err) {
      // So, if the resources directory does not exists, jump to updateList function (i.e. merge resources.json)
      // Otherwise start with the first one (that will continue with the next one) and when finisced continue with updateList function
      if (err)
        updateList();
      else
        copyResource(0);
    });
  });
};


/**
 * Merge this branch into the actual one
 * @param {boolean} checkConfl - if true check for conflicts during merge
 * @param {function} callback - function(err)
 */
Node.Branch.prototype.merge = function (checkConfl, callback)
{
  var pthis = this;
  var twManager = this.parent;
  //
  // First, merge resources
  this.mergeResources(function (err) {
    if (err)
      return callback(err);
    //
    // Define some functions
    var mergeNextCommit = function () {
      var commit = pthis.mergeList[0];    // Commit I have to merge
      //
      twManager.logger.log("DEBUG", "Merge commit " + commit.id, "TwManager.merge", {checkConfl: checkConfl});
      commit.merge(checkConfl, function (err) {   // Merge checking for conflicts is needed
        if (err) {
          twManager.logger.log("WARN", "Error merging commit " + commit.id + ": " + err, "TwManager.merge");
          return callback(err);
        }
        //
        // Remove the merged commit and if there are more, continue with the next commit
        pthis.mergeList.splice(0, 1);
        if (pthis.mergeList.length)
          mergeNextCommit();
        else { // Merge completed
          // Clean up
          delete pthis.mergeList;
          //
          // If there have been conflicts but they have been resolved, forget about them!
          if (twManager.actualBranch.conflictTrans && twManager.actualBranch.conflictTrans.transItems.length === 0)
            delete twManager.actualBranch.conflictTrans;
          //
          // If the merge generated conflicts, save them
          if (twManager.actualBranch.conflictTrans) {
            twManager.actualBranch.saveConflict(function (err) {
              callback(err);
            });
          }
          else
            callback();
        }
      });
    };
    //
    // Get all the commits to be merged
    pthis.mergeList = twManager.actualBranch.getDiffBranch(pthis);
    //
    // If there is nothing to merge
    if (pthis.mergeList.length === 0)
      callback();
    else // Something have to be merged... Merge the first one (that will merge the following ones)
      mergeNextCommit();
  });
};


/**
 * Rebase this branch using the given one
 * @param {Node.Branch} branch - branch to be used to rebase this branch
 * @param {function} callback - function(err)
 */
Node.Branch.prototype.rebase = function (branch, callback)
{
  var pthis = this;
  var twManager = this.parent;
  var i, j, com;
  //
  // Compute the list of all commits that will be merged
  // After the operation is completed I'll set all them as "PUSHED"
  // so that the system knows I don't need to push them (I've received them from my parent's project)
  var mergeList = this.getDiffBranch(branch);
  //
  // If the list of commits that will be merged is empty, there is nothing I have to do
  if (mergeList.length === 0) {
    twManager.logger.log("INFO", "The branch added nothing to current branch", "TwManager.rebase", {branch: branch.name});
    return callback();
  }
  //
  // The REBASE works as follows:
  // 1) compute the list of commits I have and my parent project has not
  // 2) compute the list of commits that I need to dismount
  // 3) undo all commits found at step 2
  // 4) merge the given branch without checking for conflicts (merge also some of the commits
  //    I've dismounted at step 2 if the server had them already)
  // 5) redo commits undoed at step 3 but only the commits the parent project had not (the commits I've undoed at step 3 that
  //    the server had already have been already redoed in step 4)
  // 6) set all "new" commits as pushed (so that the system knows that there are no new commits to push)
  //
  // Step 1: compute list of commits that I have and my parent project has not (I will have to
  // redo them at the end checking for conflicts)
  var commitsParentDontHave = branch.getDiffBranch(this);
  //
  // Step 2: compute the list of commits I need to dismount (I have to dismount all commits until I find
  // the first commit I have to merge, i.e. a common point)
  // How to search for the common point? I need to compute the first commit I don't have to merge
  // (i.e. the commit that comes before the first I have to merge)
  // Then I can search inside my commit list and stop if I find that commit. That is the common point
  var commitIDontHaveToMerge = branch.commits[branch.commits.indexOf(mergeList[0]) - 1];
  var commitsToUndo = [];
  if (commitIDontHaveToMerge) {
    twManager.logger.log("DEBUG", "Step2: commit " + commitIDontHaveToMerge.id + " is common point", "TwManager.rebase");

    for (i = this.commits.length - 1; i >= 0; i--) {      // NOTE: search commits backwards, starting from the last one
      com = this.commits[i];
      //
      // If I've found the first commit I have to merge, stop unmounting
      if (com.id === commitIDontHaveToMerge.id)
        break;
      //
      // I need to dismount this commit (add them backwards, so that the commitsToUndo has the same order
      // as the commits array)
      commitsToUndo.unshift(com);
      //
      twManager.logger.log("DEBUG", "Step2: add commit " + com.id + " to undo list", "TwManager.rebase");
    }
  }
  else { // No common point -> undo all commits I have
    commitsToUndo = commitsToUndo.concat(this.commits);
    twManager.logger.log("DEBUG", "Step2: no common point -> add all commits to undo list", "TwManager.rebase");
  }
  //
  // Step 3: undo all commits (backwards!!!)
  for (i = commitsToUndo.length - 1; i >= 0; i--) {
    com = commitsToUndo[i];
    twManager.logger.log("DEBUG", "Step3: undo commit " + com.id, "TwManager.rebase");
    com.undo(true);
    //
    // Remove this commit from my commit list
    // (it will be inserted back by the MERGE method in the same order the parent has it)
    var cidx = this.commits.indexOf(com);
    if (cidx !== -1)
      this.commits.splice(cidx, 1);
    //
    // Some of this commits to undo were on the server but the server did not send it to me
    // because he knew I had them already. But not I want to undo/redo them.
    // I need to copy the commit's file into the branch I'm merging otherwise, during the BRANCH.MERGE method,
    // the system will not be able to load the merge that commit
    var parentHadIt = false;
    for (j = 0; j < branch.commits.length && !parentHadIt; j++) {
      if (branch.commits[j].id === com.id)
        parentHadIt = true;
    }
    if (parentHadIt) {
      // I have that commit and the server had it as well. Probably the server did not send it
      // thus I need to copy it
      var pathMyCommit = twManager.path + "/branches/" + this.name + "/" + com.id;
      var pathParentCommit = twManager.path + "/branches/" + branch.name + "/" + com.id;
      //
      twManager.logger.log("DEBUG", "Step3a: copy commit " + com.id + " -> " +
              (Node.fs.existsSync(pathParentCommit)), "TwManager.rebase", {src: pathMyCommit, tgt: pathParentCommit});
      //
      var comText = Node.fs.readFileSync(pathMyCommit, {encoding: "utf8"});
      Node.fs.writeFileSync(pathParentCommit, comText);
    }
  }
  //
  // Step 4: merge the given branch withoud checking for conflicts
  branch.merge(false, function (err) {
    if (err) {
      twManager.logger.log("WARN", "Error during rebase: " + err, "TwManager.rebase");
      return callback(err);
    }
    //
    // Step 5: redo all undoed commits backward checking for conflicts
    // (I need to redo only the commits that my parent project has not, all other commits
    // I've redoed them already during the MERGE method)
    for (i = 0; i < commitsParentDontHave.length; i++) {
      com = commitsParentDontHave[i];
      twManager.logger.log("DEBUG", "Step5: redo commit " + com.id + " with conflicts check enabled", "TwManager.rebase");
      com.redo(true);
      //
      // If this commit (I had and I had to remove it before the MERGE) it's not in my list
      // I need to restore it
      if (pthis.commits.indexOf(com) === -1)
        pthis.commits.push(com);
    }
    //
    // The BRANCH.MERGE above, probably changed the message and pushed property of branches
    // that we (me and my parent) had... I need to restore them
    var mycom;
    for (i = 0; i < commitsToUndo.length; i++) {
      com = commitsToUndo[i];
      //
      for (j = 0; j < pthis.commits.length; j++) {
        mycom = pthis.commits[j];
        if (mycom.id === com.id) {
          pthis.commits[j] = com;     // Replace the commit with the commit I had
          //
          twManager.logger.log("DEBUG", "Step5: restored commit " + com.id + " as was before the merge", "TwManager.rebase");
          break;
        }
      }
    }
    //
    // Step 6: set all commits the parent project has not as pushed
    // (as if I've pushed them)
    for (i = 0; i < mergeList.length; i++) {
      com = mergeList[i];
      //
      // Search corresponding commit inside me
      for (j = 0; j < pthis.commits.length; j++) {
        mycom = pthis.commits[j];
        if (mycom.id === com.id) {
          twManager.logger.log("DEBUG", "Step6: declare commit " + com.id + " as pushed", "TwManager.rebase");
          mycom.pushed = new Date();
          break;
        }
      }
    }
    //
    // If the redo generated conflicts, save them
    if (pthis.conflictTrans) {
      pthis.saveConflict(function (err) {
        callback(err);
      });
    }
    else
      callback();
  });
};


/**
 * Copy resources from this branch to another one
 * @param  {string} targetBranchName
 * @param {function} callback - function(err)
 */
Node.Branch.prototype.copyResources = function (targetBranchName, callback)
{
  var twManager = this.parent;
  //
  var srcBranch = twManager.path + "/branches/" + this.name;
  var dstBranch = twManager.path + "/branches/" + targetBranchName;
  //
  // Read the resource index in the source branch
  twManager.readJSONFile(srcBranch + "/resources.json", function (reslist, err) {
    // If the file does not exist, there are no resources... go back to the callee
    // otherwise if there are read errors, report the error
    if (err && err.code === "ENOENT")
      return callback();
    else if (err) {
      twManager.logger.log("ERROR", "Error reading the file " + srcBranch + "/resources.json: " + err, "TwManager.copyResources");
      return callback(err);
    }
    //
    // The file exists and there have been no read errors
    var copyResource = function (i) {
      var res = reslist[i];
      //
      // Copy this resource into the destination branch
      var resSrc = twManager.path + "/resources/" + res;
      var resDst = dstBranch + "/resources/" + res;
      twManager.copyFile(resSrc, resDst, function (errin, errout) {
        if (errin) {
          twManager.logger.log("ERROR", "Error reading the file " + resSrc + ": " + errin, "TwManager.copyResources");
          return callback(errin);
        }
        else if (errout) {
          twManager.logger.log("ERROR", "Error writing the file " + resDst + ": " + errout, "TwManager.copyResources");
          return callback(errout);
        }
        //
        // If it's not the last one, continue with the next resource,
        // otherwise update the list and report to callee
        if (i < reslist.length - 1)
          copyResource(i + 1);
        else {
          // Done. Now copy the indexes between the two branches
          twManager.copyFile(srcBranch + "/resources.json", dstBranch + "/resources.json", function (errin, errout) {
            if (errin) {
              twManager.logger.log("ERROR", "Error reading the file " + srcBranch + "/resources.json: " + errin, "TwManager.copyResources");
              return callback(errin);
            }
            else if (errout) {
              twManager.logger.log("ERROR", "Error writing the file " + dstBranch + "/resources.json: " + errout, "TwManager.copyResources");
              return callback(errout);
            }
            //
            callback();
          });
        }
      });
    };
    //
    // If there are resources to copy, start with the first one (that will continue with the next one)
    // otherwise report success to callee
    if (reslist.length)
      copyResource(0);
    else
      callback();
  });
};


/**
 * Backup this branch in the cloud
 * @param {string} pathCloud - file path in the cloud
 * @param {function} callback - function(err)
 */
Node.Branch.prototype.backup = function (pathCloud, callback)
{
  var pthis = this;
  var twManager = this.parent;
  //
  // Log the operation
  twManager.logger.log("DEBUG", "Backup branch " + this.name + " to cloud", "Branch.backupBranch",
          {project: twManager.child.project.name, user: twManager.child.project.user.userName, pathCloud: pathCloud});
  //
  var newBranchName = twManager.child.project.user.userName + "_" + twManager.child.project.name + "_" + this.name;
  var pathTgtBranch = twManager.path + "/branches/" + newBranchName;
  //
  // Compute the list of files to be copied
  var filesToCopy = [];
  var computeCommitsToCopy = function () {
    // Copy INDEX.json and RESOURCES.json (if they are there)
    if (Node.fs.existsSync(twManager.path + "/branches/" + pthis.name + "/index.json"))
      filesToCopy.push(twManager.path + "/branches/" + pthis.name + "/index.json");
    if (Node.fs.existsSync(twManager.path + "/branches/" + pthis.name + "/resources.json"))
      filesToCopy.push(twManager.path + "/branches/" + pthis.name + "/resources.json");
    //
    // Add all (missing) commits file
    var branchCommits = pthis.loadAllCommits();
    for (var i = 0; i < branchCommits.length; i++) {
      var com = branchCommits[i];
      //
      // If missing send it
      if (!twManager.parentCommits || twManager.parentCommits.indexOf(com.id) === -1) {
        var pathCom = twManager.path + "/branches/" + com.parent.name + "/" + com.id;
        filesToCopy.push(pathCom);
      }
    }
    //
    copyCommits();
  };
  //
  // Error function (+ cleanup)
  var errorFnc = function (level, err) {
    twManager.logger.log(level, err, "Branch.backupBranch");
    callback(err);
    //
    // Cleanup
    Node.rimraf(pathTgtBranch, function (err) {
      if (err)
        twManager.logger.log("ERROR", "Error clearning the folder " + pathTgtBranch + ": " + err, "Branch.backupBranch");
    });
  };
  //
  // Function that copies a single commit and completes backup when finished
  var copyCommits = function () {
    // If there are no more files to copy complete backup
    if (filesToCopy.length === 0)
      return completeBackup();
    //
    // Copy the file in the temporary branch
    var fin = filesToCopy[0];
    var fout = pathTgtBranch + "/" + fin.substring(fin.lastIndexOf("/") + 1);
    twManager.copyFile(fin, fout, function (errin, errout) {
      if (errin)
        return errorFnc("ERROR", "Error reading the commit " + fin + ": " + errin);
      else if (errout)
        return errorFnc("ERROR", "Error writing the commit " + fout + ": " + errout);
      //
      // Remove the copied file from the list of files to copy
      filesToCopy.splice(0, 1);
      //
      // Next file
      copyCommits();
    });
  };
  //
  // Function that completes the backup operation
  var completeBackup = function () {
    // Create the resources directory inside the new branch
    Node.fs.mkdir(pathTgtBranch + "/resources", function (err) {
      if (err)
        return errorFnc("ERROR", "Error creating the folder" + pathTgtBranch + "/resources: " + err);
      //
      // Copy all resources from the source branch to the temporary branch
      pthis.copyResources(newBranchName, function (err) {
        if (err)
          return errorFnc("WARN", "Error copying the resources in the new branch: " + err);
        //
        // Upload the file in the cloud
        var archiver = new Node.Archiver(twManager.child);
        archiver.backup(pathTgtBranch, pathCloud, function (err) {
          if (err)
            return errorFnc("WARN", "Error backing up folder " + pathTgtBranch + " to cloud " + pathCloud + ": " + err);
          //
          // Delete the temporary brannch
          Node.rimraf(pathTgtBranch, function (err) {
            if (err)
              return errorFnc("ERROR", "Error removing the folder " + pathTgtBranch + ": " + err);
            //
            // Done
            callback();
            //
            // Log the operation
            twManager.logger.log("DEBUG", "Branch backed up", "Branch.backupBranch", {branch: pthis.name});
          });
        });
      });
    });
  };
  //
  // First, if the target path exists, remove it... I want to start in "clean" mode
  // (it could happen if a previous push failed due to an unexpected condition)
  Node.rimraf(pathTgtBranch, function (err) {
    if (err)
      return errorFnc("WARN", "Error pre-clearning the folder " + pathTgtBranch + ": " + err);
    //
    // Create the target directory and start copying commits
    Node.fs.mkdir(pathTgtBranch, function (err) {
      if (err)
        return errorFnc("ERROR", "Error creating the folder " + pathTgtBranch + ": " + err);
      //
      // If I don't have parent commits, ask for them, so that I can compute what my parent needs
      twManager.getParentCommits(function (commits) {   // jshint ignore:line
        computeCommitsToCopy();
      });
    });
  });
};


/**
 * Restore this branch from the cloud
 * @param {string} pathCloud - file path in the cloud
 * @param {function} callback - function(err)
 */
Node.Branch.prototype.restore = function (pathCloud, callback)
{
  var pthis = this;
  var twManager = this.parent;
  //
  // Path where the branch will be restored
  var path = twManager.path + "/branches/" + this.name;
  //
  var archiver = new Node.Archiver(twManager.child);
  archiver.restore(path, pathCloud, function (err) {
    if (err) {
      twManager.logger.log("WARN", "Error while restoring the cloud file " + pathCloud + " to path " + path + ": " + err, "Branch.restore");
      return callback("Error while restoring the cloud file " + pathCloud + " to path " + path + ": " + err);
    }
    //
    // Now that the branch has been succesfully restored, delete it
    archiver.deleteFile(pathCloud, function (err) {
      if (err)    // If error -> continue... who cares
        twManager.logger.log("WARN", "Can't delete branch backup: " + err, "Branch.restore", {pathCloud: pathCloud});
      //
      // Done
      callback();
      //
      // Log the operation
      twManager.logger.log("DEBUG", "Branch restored", "Branch.restore", {branch: pthis.name});
    });
  });
};


/**
 * Reverts this branch to the given commit
 * (for every commit between the last one and the given one,
 * create new commits that do the opposite operations)
 * @param {object} options - {commitID: commit to revert to, message: message to be used for the new commit}
 * @param {function} callback - function(err)
 */
Node.Branch.prototype.revert = function (options, callback)
{
  var twManager = this.parent;
  //
  // First, load branch's commit and search the given commit
  this.loadCommitsList();
  var i, commidx;
  if (options.commitID) {
    // A commitID was provided -> search the commit in my commit list
    for (i = 0; i < this.commits.length && commidx === undefined; i++)
      if (this.commits[i].id === options.commitID)
        commidx = i;
    //
    // If not found -> report the error
    if (commidx === undefined) {
      twManager.logger.log("WARN", "Commit not found", "Branch.revert");
      return callback(InDe.rh.t("tw_revert_err"));
    }
  }
  else  // No commitID provided -> revert all commits
    commidx = 0;
  //
  // Compute the list of commits to revert
  var commitsToRevert = this.commits.slice(commidx);
  if (commitsToRevert.length === 0) {
    twManager.logger.log("WARN", "No commits found to revert", "Branch.revert");
    return callback(InDe.rh.t("tw_norevert"));
  }
  //
  // Now, reverse all commits that have to be reversed
  // (loop backward 'cause I need to move back in time)
  var transList = [];
  for (i = commitsToRevert.length - 1; i >= 0; i--) {
    twManager.logger.log("DEBUG", "Revert commit " + commitsToRevert[i].id, "Branch.revert");
    commitsToRevert[i].reverseCommit(transList);
  }
  //
  // Create a new commit
  var newCommit = this.createCommit(InDe.rh.t("tw_revert_commit_msg", {_msg_: options.message || ""}));
  twManager.logger.log("DEBUG", "Created new revert commit " + newCommit.id, "Branch.revert");
  //
  // Save the commit and report to callee
  var pathNewCommit = twManager.path + "/branches/" + this.name + "/" + newCommit.id;
  Node.fs.writeFile(pathNewCommit, JSON.stringify(transList), function (err) {
    if (err) {
      twManager.logger.log("WARN", "Error while saving the new commit: " + err, "Branch.revert", {pathNewCommit: pathNewCommit});
      //
      // Delete the useless file
      Node.rimraf(pathNewCommit, function (err) {   // jshint ignore:line
      });
      //
      // Report error to callee
      return callback(InDe.rh.t("tw_norevert"));
    }
    //
    // Save the list of commits and report to callee
    this.saveCommitsList(callback);
  }.bind(this));
};


/**
 * Saves the conflict transaction to disk
 * @param {function} callback - function(err)
 */
Node.Branch.prototype.saveConflict = function (callback)
{
  var pthis = this;
  var twManager = this.parent;
  //
  // Create a new ID for conflict if it's the first time I save this conflict
  if (!this.conflict)
    this.conflict = Node.Utils.generateUID36();
  //
  // First create directory, if needed
  var path = twManager.path + "/branches/" + this.name + "/conflicts";
  Node.fs.mkdir(path, function (err) {
    if (err && err.code !== "EEXIST") {
      twManager.logger.log("ERROR", "Error creating the conflict folder " + path + ": " + err, "Branch.saveConflict");
      return callback(err);
    }
    //
    // Next, save the conflict transaction
    var pathConflict = path + "/" + pthis.conflict;
    var s = pthis.conflictTrans.save();
    twManager.writeJSONFile(pathConflict, s, function (err) {
      if (err)
        twManager.logger.log("ERROR", "Error writing conflict file " + pathConflict + ": " + err, "Branch.saveConflict");
      callback(err);
    });
  });
};


/**
 * Load the conflicts
 * @param {function} callback - function(err)
 */
Node.Branch.prototype.loadConflicts = function (callback)
{
  var pthis = this;
  var twManager = this.parent;
  //
  // If already loaded, do nothing
  if (this.conflictTrans)
    return callback();
  //
  // If there are no conflict, do nothing
  if (!this.conflict)
    return callback();
  //
  var pathConflict = twManager.path + "/branches/" + this.name + "/conflicts/" + this.conflict;
  var rsFile = Node.fs.createReadStream(pathConflict);
  rsFile.read();
  //
  var txt = "";
  rsFile.on("data", function (chunk) {
    txt += chunk;
  });
  rsFile.on("end", function () {
    pthis.conflictTrans = new InDe.Transaction(twManager.doc.transManager);
    pthis.conflictTrans.load(txt);
    //
    callback();
  });
  rsFile.on("error", function (err) {
    twManager.logger.log("ERROR", "Error reading conflict file " + pathConflict + ": " + err, "Branch.loadConflicts");
    callback(null, err);
  });
};


/**
 * Attaches conflicts to this branch
 * @param {Array} list - list of conflicts to add
 */
Node.Branch.prototype.putConflicts = function (list)
{
  var twManager = this.parent;
  //
  // If this is the first conflict, create the transaction "container"
  if (!this.conflictTrans) {
    this.conflictTrans = new InDe.Transaction(twManager.doc.transManager);
    this.conflictTrans.tw = true;
  }
  //
  // Append conflicts
  this.conflictTrans.transItems = list;
};


/**
 * Return the conflicts in the actual branch (if any)
 * @param {function} callback - function(confTr, err)
 */
Node.Branch.prototype.getConflicts = function (callback)
{
  var pthis = this;
  var twManager = this.parent;
  //
  // First, load them... if needed
  this.loadConflicts(function (err) {
    if (err)
      return callback(null, err);
    //
    // If there are no conflicts, do nothing
    if (!pthis.conflictTrans)
      return callback();
    //
    // Preview the transaction. Each commit would be undoed if the user wants to undo changes
    pthis.conflictTrans.preview("undo");
    //
    // Next, check them and remove all conflicts that are not there anymore
    var updated;
    for (var i = 0; i < pthis.conflictTrans.transItems.length; i++) {
      var ti = pthis.conflictTrans.transItems[i];
      //
      // (see Node.Commit.prototype.checkConflicts)
      // 1) if the object is no longer in the document, the conflict is gone
      // 2) if the object's property is not the new value (the target of the conflict) the conflict is gone
      // 3) if the object moved (i.e. object's parent property) is not the new value (the target of the conflict) the conflict is gone
      if (!ti.obj || // The object is not in the document
              (ti.prop && (ti.obj[ti.prop] || "") !== (ti.new || "")) || // The object is not in conflict
              (ti.np && ti.obj.parent !== ti.np) || // The object is not in conflict
              (!ti.ac && ti.ac_id)) {   // The object was added but it does not exist anymore and it can't be deleted if the conflict is refused
        // Log conflict removal
        twManager.logger.log("DEBUG", "Removed conflict (auto-resolved?)", "Branch.getConflicts", {idx: i, n: pthis.conflictTrans.transItems.length});
        pthis.conflictTrans.transItems.splice(i--, 1);
        updated = true;
      }
    }
    //
    // Clean up
    pthis.conflictTrans.cleanupPreview();
    //
    // If all conflicts are gone, delete the conflict
    if (pthis.conflictTrans.transItems.length === 0) {
      twManager.logger.log("DEBUG", "All conflicts have been auto-resolved", "Branch.getConflicts");
      //
      pthis.removeConflict(function (err) {
        callback(null, err);
      });
    }
    else if (updated) // If something has changed, update conflicts
      pthis.saveConflict(function (err) {
        callback(pthis.conflictTrans, err);
      });
    else
      callback(pthis.conflictTrans);
  });
};


/**
 * Remove the conflict deleting the file and folder related to it
 * @param {function} callback - function(err)
 */
Node.Branch.prototype.removeConflict = function (callback)
{
  var pthis = this;
  var twManager = this.parent;
  //
  var path = twManager.path + "/branches/" + this.name + "/conflicts";
  Node.rimraf(path, function (err) {
    if (err) {
      twManager.logger.log("ERROR", "Error deleting the conflict folder " + path + ": " + err, "Branch.removeConflict");
      return callback(err);
    }
    //
    delete pthis.conflict;
    delete pthis.conflictTrans;
    //
    // Save the configuration
    twManager.saveConfig(callback);
  });
};


/**
 * Accepts/deletes one or more conflicts (called by the client when the
 * user wants to accepts or refuse one or more conflicts)
 * @param {InDe.Transaction} trConfl - transaction received by the user
 * @param {function} callback - function(err)
 */
/* jshint maxstatements:70 */
Node.Branch.prototype.resolveConflicts = function (trConfl, callback)
{
  // jshint maxcomplexity:40
  var pthis = this;
  var twManager = this.parent;
  //
  // Note: trConfl is a list of transItems that sould be equal to the transItems list of the conflict transaction.
  // Each trConfl transItem has property "resolve" that tells me how the user wants to resolve the conflict.
  // Possible values are:
  //   Node.Branch.ResolveTypeMap.ACCEPT:
  //        the user accepts the conflicts and wants to live it as it is (i.e. the conflict item is forgotten)
  //   Node.Branch.ResolveTypeMap.FIXLATER:
  //        the user wants to fix the conflict later (the system will "wrap" the conflicting formula into a /* */ block)
  //   Node.Branch.ResolveTypeMap.REFUSE:
  //        the user wants to refuse the conflict (i.e. the system will revert the change that generated the conflict,
  //        restoring the method as it was before the operation that generated the conflict)
  //
  // Load the conflicts
  this.loadConflicts(function (err) {
    // jshint maxdepth:8
    if (err) {
      twManager.logger.log("WARN", "Error while loading conflicts: " + err, "Branch.resolveConflicts");
      return callback(InDe.rh.t("tw_resconfl_err"));
    }
    //
    // If conflicts lists do not match, there is a problem... I can't manage conflicts
    if (!pthis.conflictTrans || trConfl.transItems.length !== pthis.conflictTrans.transItems.length) {
      if (!pthis.conflictTrans)
        twManager.logger.log("WARN", "Error while resolving conflicts: there are no conflicts", "Branch.resolveConflicts");
      else
        twManager.logger.log("WARN", "Error while resolving conflicts: the number of conflicts do not match", "Branch.resolveConflicts",
                {nitem: pthis.conflictTrans.transItems.length, recv: trConfl.transItems.length});
      return callback(InDe.rh.t("tw_resconfl_err"));
    }
    //
    // Before I start I need to "clean" the conflict transaction.
    // I'm trying to fix this: suppose the user wants to resolve a conflict that contained the following operations:
    //     add Formula
    //     add Token1 inside the Formula
    //     add Token2 inside the Formula
    // and he (the user) wants to undo the operation (i.e. he has clicked the red X).
    // Doing it backward I'll undo the Token2 add (thus I delete it). Then I'll undo the Token1 add (delete) and,
    // finally, I'll undo the Formula add (delete). Thus I get three RC items:
    //     delete Token2
    //     delete Token1
    //     delete Formula
    // Now suppose that, later on, the system needs to undo this transaction (rebase with TW).
    // The system restores the Formula, then it restores the Token1 and, finally, it restores the Token2.
    // Then the system needs to tell the counterpart to undo the transaction as well. For this the system
    // saves the transaction and sends it to the counterpart. But when the transaction is saved
    // the Formula will contain all its childrens. This because the save happens at the end of the transaction
    // when the Formula has both childrens inside and the Formula is saved in the state it has when the
    // transaction is completed and not when the RC item was executed). Thus I get this:
    //     delete Token2
    //     delete Token1
    //     delete Formula with children [Token1, Token2]
    // Now the counterpart tryies to undo this (backward) and the Token1 and Token2 will resurrect twice!
    //
    // Solution: if the user wants to undo an AC I need to "skip" it if I'll undo it's parent AC.
    var i, tiUser, ti;
    var objToUndo = {};
    for (i = 0; i < trConfl.transItems.length; i++) {   // Loop forward as it was done when all conflicts were generated
      tiUser = trConfl.transItems[i];
      ti = pthis.conflictTrans.transItems[i];
      //
      if (tiUser.resolve === Node.Branch.ResolveTypeMap.REFUSE && // User wants to undo this item
              ti.obj && ti.ac) { // This was an ADD (that will become a DELETE later on)
        objToUndo[ti.ac.id] = ti.ac;    // Remember that this object will be deleted
        //
        // If the the AC's parent was previously deleted (i.e. added and undoed) skip it
        if (objToUndo[ti.obj.id])
          tiUser.resolve = Node.Branch.ResolveTypeMap.ACCEPT;    // (i.e. resove, but don't execute the item)
      }
    }
    //
    // I'm undoing one or more item thus I have to do it backward
    var tr, frm, tk, frmFixLater = [];
    for (i = trConfl.transItems.length - 1; i >= 0; i--) {
      tiUser = trConfl.transItems[i];
      ti = pthis.conflictTrans.transItems[i];
      //
      // If the user said nothing about this item, skip it
      if (tiUser.resolve === undefined)
        continue;
      //
      // If the user wants to REFUSE the change I need to revert the conflict
      // If the user wants to FIXLATER and the confilct was an RC I first need to resurrect the object then I can wrap it
      if (tiUser.resolve === Node.Branch.ResolveTypeMap.REFUSE || (ti.rc && tiUser.resolve === Node.Branch.ResolveTypeMap.FIXLATER)) {
        if (!tr)
          tr = twManager.doc.transManager.beginTransaction();
        //
        // If the user refuses the change it means that he wants to go back to previous value
        // I need to create a transItem that will be executed in the child projects
        // when they will fetch all changes
        if (ti.ac)
          tr.del(ti.ac);
        else if (ti.rc) {
          // Here I need to resurrect the RC through several AC and one MOVE at the end
          var objsToAdd = new InDe.TreeWalker().getList(ti.rc);
          for (var j = 0; j < objsToAdd.length; j++) {
            // Don't save parent/children properties
            var obj = objsToAdd[j];
            var Cls = InDe.Document.TypeMap[obj.typeName()];      // obj CLASS
            //
            // Create ACP object
            var objprops = undefined;     // jshint ignore:line
            var objkeys = Object.keys(obj);
            var k, p;
            for (k = 0; k < objkeys.length; k++) {
              p = objkeys[k];
              if (p === "parent" || p === "children")
                continue;
              //
              objprops = objprops || {};
              objprops[p] = obj[p];
            }
            //
            // Add the object
            var newpar = twManager.doc.objMap[obj.parent.id];
            var newobj = tr.ac(newpar, Cls, objprops);
            //
            // A new object is born. If this new object has been used by preceding conflicts
            // I need to relink those items to this new object. From now on I must use the new
            // object and not the temporary one that was created when the conflict transaction was loaded
            for (var i1 = i - 1; i1 >= 0; i1--) {   // Relink only preceding trans items not all of them
              var ti1 = pthis.conflictTrans.transItems[i1];
              //
              var tik = Object.keys(ti1);
              for (k = 0; k < tik.length; k++) {
                p = tik[k];
                if (ti1[p] instanceof InDe.AObject && ti1[p].id === newobj.id)
                  ti1[p] = newobj;
              }
            }
          }
          //
          // Then I need to move the "root" object (i.e. the RC) where it was
          var rootObj = twManager.doc.objMap[ti.rc.id];
          tr.move(ti.obj, rootObj, ti.idx);
        }
        else if (ti.prop)
          tr.sp(ti.obj, ti.prop, ti.old);
        else if (ti.np)
          tr.move(ti.op, ti.obj, ti.sidx);
      }
      //
      // If the user wants to fix it later
      if (tiUser.resolve === Node.Branch.ResolveTypeMap.FIXLATER) {
        // I need to wrap the formula into a /* */, thus I'll need to add a new token at the beginning and one at the end
        // Add this formula to the list of formulas to fix later
        frm = ti.ac || ti.rc || ti.obj;
        if (frm && !(frm instanceof InDe.AFormula))
          frm = frm.getParent(InDe.AFormula);
        //
        if (frm && frmFixLater.indexOf(frm) === -1)
          frmFixLater.unshift(frm);
      }
      //
      trConfl.transItems.splice(i, 1);
      pthis.conflictTrans.transItems.splice(i, 1);
    }
    //
    // Now, fix formulas I had to fix later (if any)
    if (frmFixLater.length) {
      if (!tr)
        tr = twManager.doc.transManager.beginTransaction();
      //
      // Group fix-later blocks
      var lastfrm, insideFixLaterBlock;
      for (i = 0; i < frmFixLater.length; i++) {
        frm = frmFixLater[i];
        //
        // Create a new token at the beginning (do it only if I've not yet opened a fix-later block)
        if (!insideFixLaterBlock) {
          tk = tr.ac(frm, InDe.AToken, {code: "/* BEGIN-CONFLICT\n  "});
          tr.move(frm, tk, 0);
          //
          insideFixLaterBlock = true;   // Remember that now I'm inside a fix-later block
        }
        //
        // Create a new token at the end (do it only if the formula is not the last formula's next sibling,
        // I want to concatenate fix-later blocks)
        if (lastfrm && lastfrm.getNextSibling() !== frm) {
          tk = tr.ac(frm, InDe.AToken, {code: "\n  END-CONFLICT */"});
          insideFixLaterBlock = false;    // I'm not inside a fix-later block anymore
        }
        //
        lastfrm = frm;
      }
      //
      // If I was still inside a fix-later block, I need to close it
      if (insideFixLaterBlock)
        tk = tr.ac(frm, InDe.AToken, {code: "\n  END-CONFLICT */"});
    }
    //
    if (tr)
      tr.commit();
    //
    // Save the document
    twManager.saveDocument(function (err) {
      if (err) {
        twManager.logger.log("WARN", "Error while saving the document: " + err, "Branch.resolveConflicts");
        return callback(InDe.rh.t("tw_resconfl_err"));
      }
      //
      // Done. Now, if there are no more conflicts, delete them
      if (pthis.conflictTrans.transItems.length === 0) {
        pthis.removeConflict(function (err) {
          if (err) {
            twManager.logger.log("WARN", "Error while removing conflicts: " + err, "Branch.resolveConflicts");
            return callback(InDe.rh.t("tw_resconfl_err"));
          }
          //
          // If there are local modifications
          if (twManager.localModif()) {
            // Create a new COMMIT that "definitely closes the conflict issue"
            twManager.commit(InDe.rh.t("tw_resconfl_commmsg"), function (err) {
              if (err) {
                twManager.logger.log("WARN", "Error while creating auto-commit: " + err, "Branch.resolveConflicts");
                return callback(InDe.rh.t("tw_resconfl_err"));
              }
              //
              // Operation completed
              callback();
            });
          }
          else // No local modifications -> no need for a COMMIT
            callback();
        });
      }
      else // There are still conflicts, update them
        pthis.saveConflict(function (err) {
          callback(err);
        });
    });
  });
};


// Export module
module.exports = Node.Branch;
