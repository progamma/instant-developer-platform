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
Node.Utils = require("../utils");
InDe.rh = require("../../ide/common/resources");
InDe.Transaction = require("../../ide/model/Transaction");


/*
 * @param {Node.Branch} parent
 */
Node.Commit = function (parent)
{
  this.parent = parent;
  //
  this.id = Node.Utils.generateUID36();
  this.date = new Date();
  this.author = this.parent.parent.child.project.user.userName;
};


/**
 * Save the object
 */
Node.Commit.prototype.save = function ()
{
  var r = {cl: "Node.Commit", id: this.id, date: this.date, author: this.author,
    originBranch: this.originBranch, message: this.message, pushed: this.pushed, merged: this.merged, workdays: this.workdays};
  return r;
};


/**
 * Load the object
 * @param {Object} v - the object that contains my data
 */
Node.Commit.prototype.load = function (v)
{
  this.date = v.date;
  this.id = v.id;
  this.originBranch = v.originBranch;
  this.author = v.author;
  this.message = v.message;
  this.pushed = v.pushed;
  this.merged = v.merged;
  this.workdays = v.workdays;
};


/**
 * Loads the commit (i.e. the list of all transactions)
 * (do it synchronously because it's used where asynch it's not needed)
 */
Node.Commit.prototype.loadCommit = function ()
{
  var twManager = this.parent.parent;
  //
  var pathCommit = twManager.path + "/branches/" + this.parent.name + "/" + this.id;
  var com = JSON.parse(Node.fs.readFileSync(pathCommit));
  return com;
};


/**
 * Creates a new commit where all transactions are "reversed"
 * @param {array} transList - array that have to be populated with inverted transactions
 */
Node.Commit.prototype.reverseCommit = function (transList)
{
  var twManager = this.parent.parent;
  //
  // Load all transactions in this commit
  var trans = this.loadCommit();
  //
  // For each transaction in the commit
  for (var i = trans.length - 1; i >= 0; i--) {
    // Load the transaction from disk
    var tr = new InDe.Transaction(twManager.doc.transManager);
    tr.load(trans[i]);
    //
    // Undo the transaction (here I'm not expecting conflicts, so I'm auto-resolving them)
    // Ask the transaction to give back inverted items
    var options = {confilcts: [], revertItems: []};
    tr.twOperation = true;    // Inform the client that this transaction can be UNDOED even if he does not have it
    tr.undo(undefined, options);
    delete tr.twOperation;    // Don't need to save it
    //
    tr.transItems = options.revertItems;  // Replace transItems with the list of inverted items
    tr.id = Node.Utils.generateUID24();   // Change transaction's ID (I don't want this transaction to be equal to the original one)
    tr.date = new Date();                 // Update transaction's date
    //
    // Add the inverted transaction the given trans list
    tr.tw = true;
    transList.push(tr.save());
    delete tr.tw;
  }
};


/**
 * Undo the commit
 * @param {boolean} checkConflicts - true if the undo have to check for conflicts
 */
Node.Commit.prototype.undo = function (checkConflicts)
{
  var twManager = this.parent.parent;
  //
  // Load the transactions in the commit
  var trans = this.loadCommit();
  //
  // Undo all the transactions in the commit (do it backwards!)
  for (var i = trans.length - 1; i >= 0; i--) {
    var tr = new InDe.Transaction(twManager.doc.transManager);
    tr.load(trans[i]);
    //
    try {
      // Inform the client that this transaction can be UNDOED even if he does not have it and UNDO it
      tr.twOperation = true;
      tr.undo(undefined, (checkConflicts ? {conflicts: true} : undefined));
    }
    catch (ex) {
      twManager.logger.log("ERROR", "Exception in commit UNDO", "Commit.undo",
              {trNum: i, trTot: trans.length, tr: tr.save(), stack: ex.stack});
      throw ex;
    }
  }
};


/**
 * Redo the commit
 * @param {boolean} checkConflicts - true if the redo have to check for conflicts
 */
Node.Commit.prototype.redo = function (checkConflicts)
{
  // jshint maxdepth:10
  var twManager = this.parent.parent;
  var reSaveCommit;
  //
  // Load the transactions in the commit
  var trans = this.loadCommit();
  //
  // Redo all the transactions in the commit
  for (var i = 0; i < trans.length; i++) {
    var tr = new InDe.Transaction(twManager.doc.transManager);
    tr.load(trans[i]);
    //
    // Redo the transaction
    try {
      // If I need to check for conflicts (checkConflicts = true), do check for conflicts
      // If I don't need to check for conflicts (checkConflicts = false), do check for conflicts and forget about them (i.e. auto-accept them)
      // If I don't know if I need to check for conflicts (checkConflicts === undefined), do not check for conflicts
      var conflictItems;
      if (checkConflicts)
        conflictItems = (twManager.actualBranch.conflictTrans ? twManager.actualBranch.conflictTrans.transItems : []);
      else if (checkConflicts === false)
        conflictItems = [];     // Check for conflicts but forget about them
      //
      // Inform the client that this transaction can be REDOED even if he does not have it
      // then REDO it looking for conflicts and missing objects if requested
      tr.twOperation = true;
      tr.redo(undefined, {conflicts: conflictItems});
      //
      // If I need to check for conflicts
      // (If I don't need to check for conflicts, forget about them)
      if (checkConflicts) {
        // Check if there are conflicts for objects that have desapeared... If so, remove the conflict
        // Don't remove conflicts that have to do with objects that would have been inserted by the conflict!
        var ACconfl = {};
        var k;
        for (var j = 0; j < conflictItems.length; j++) {
          var confl = conflictItems[j];
          if (confl.obj && !twManager.doc.getObjectById(confl.obj.id) && !ACconfl[confl.obj.id]) {
            conflictItems.splice(j--, 1);
            continue;
          }
          //
          // Remember new AC that have not been executed due to conflicts
          if (confl.ac)
            ACconfl[confl.ac.id] = confl.ac;
          //
          // Do better than that... try to remove all AC-RC conflicts (it could happen for code if the user makes several (useless) attempts)
          if (confl.rc && ACconfl[confl.rc.id]) {
            // This object was added and now has been deleted... forget about it
            // Remove all items that have something to do with this object
            var oToDel = confl.rc.id;
            for (k = 0; k <= j; k++) {      // Stop at me (RC)
              var confl1 = conflictItems[k];
              if ((confl1.obj && confl1.obj.id === oToDel) || (confl1.ac && confl1.ac.id === oToDel) || (confl1.rc && confl.rc.id === oToDel)) {
                conflictItems.splice(k--, 1);
                j--;      // Decrement also the "main" counter
              }
            }
            //
            // Forget about the new AC... now is gone...
            delete ACconfl[oToDel];
          }
        }
        //
        // If there are conflicts update actual branch's conflicts list
        if (conflictItems.length)
          twManager.actualBranch.putConflicts(conflictItems);
        //
        // If I'm merging I needed update the transaction in the list if it contains RC items.
        // Reason: if the FORKED project deleted an object the entire FORKED object is inside the saved transaction.
        // Now, when the transaction is relinked (during REDO) the object is searched inside the project so that
        // my object gets removed as well. But if the transaction is undoed the RC object resurrect as it was
        // into the FORKED project and not as it was inside my project (see Transaction::relinkItem).
        // Thus, if I'm merging this commit I need to replace the transaction if it contains at least one RC item so that
        // if I'll undo this transaction my object will resurrect and not the FORKED one
        // Check if the commit contains an RC
        var hasRC = false;
        for (k = 0; k < tr.transItems.length && !hasRC; k++)
          if (tr.transItems[k].rc || tr.transItems[k].rc_id)    // Either true or missing obj
            hasRC = true;
        //
        // If this trasaction contains an RC
        if (hasRC) {
          // I need to update the i-th transaction so that if it will be undoed
          // all RC objects resurrect as they are now in my project
          tr.tw = true;
          trans[i] = tr.save();
          delete tr.tw;
          //
          // This commit has changed -> I need to re-save it at the end
          reSaveCommit = true;
        }
      }
      else if (checkConflicts === false && conflictItems.length) {
        // The REDO generated conflicts but I'm not interested in them -> log but forget about them
        tr = new InDe.Transaction(twManager.doc.transManager);
        tr.tw = true;
        tr.transItems = conflictItems;
        //
        twManager.logger.log("WARN", "The fetch resulted with auto-accepted conflicts", "Commit.redo",
                {commit: this.id, conflicts: tr.save()});
      }
    }
    catch (ex) {
      twManager.logger.log("ERROR", "Exception in commit REDO", "Commit.redo",
              {commit: this.id, trNum: i, trTot: trans.length, tr: tr.save(), stack: ex.stack});
      throw ex;
    }
  }
  //
  // If needed, resave the commit
  if (reSaveCommit) {
    twManager.logger.log("DEBUG", "Update commit", "Commit.redo", {commit: this.id});
    //
    var pathCommit = twManager.path + "/branches/" + twManager.actualBranch.name + "/" + this.id;
    Node.fs.writeFile(pathCommit, JSON.stringify(trans), function (err) {
      if (err)
        twManager.logger.log("WARN", "Error while re-saving commit: " + err, "Commit.redo", {pathCommit: pathCommit});
    });
  }
};


/*
 * Merge this commit inside the actual branch
 * @param {boolean} checkConflicts - true if the merge have to check for conflicts
 * @param {function} callback - function(err)
 */
Node.Commit.prototype.merge = function (checkConflicts, callback)
{
  var pthis = this;
  var twManager = this.parent.parent;
  //
  // Copy the commit-file into the actual branch
  var rin = twManager.path + "/branches/" + pthis.parent.name + "/" + pthis.id;
  var rout = twManager.path + "/branches/" + twManager.actualBranch.name + "/" + pthis.id;
  twManager.copyFile(rin, rout, function (errin, errout) {
    if (errin) {
      twManager.logger.log("ERROR", "Error reading the commit " + rin + ": " + errin, "Commit.merge");
      return callback(errin);
    }
    else if (errout) {
      twManager.logger.log("ERROR", "Error writing the commit " + rout + ": " + errout, "Commit.merge");
      return callback(errout);
    }
    //
    // First REDO this commit
    pthis.redo(checkConflicts);
    //
    // Now create the new commit inside the actual branch
    var message = InDe.rh.t((checkConflicts ? "tw_merge_msg" : "tw_fetch_msg"), {_cmnm_: pthis.parent.name, _cmmsg_: (pthis.message || "")});
    var newCommit = twManager.actualBranch.createCommit(message);
    //
    // Use the same ID
    newCommit.id = pthis.id;
    //
    // Copy my details to new commit
    newCommit.date = pthis.date;
    newCommit.author = pthis.author;
    newCommit.workdays = pthis.workdays;
    //
    // Remember when this commit was merged
    newCommit.merged = new Date();
    //
    // Done merging... report to callee
    callback();
  });
};


// Export module
module.exports = Node.Commit;
