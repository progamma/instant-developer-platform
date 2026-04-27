/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */

var Node = Node || {};
//
// Import modules
Node.fs = require("fs");
Node.os = require("os");
Node.Utils = require("../utils");
Node.Archiver = require("../archiver");
/**
 * @class Definition of TestAuto object
 * @param {Node.App} app
 * @param {Object} options
 *                 - name
 *                 - suit: test parent suit
 *                 - mode: "r" (rec), "sbs" (step-by-step), "l" (load), "nr" (non-regression)
 * */
Node.TestAuto = function (app, options)
{
  this.app = app;
  this.consoleRequest = this.app.server.request;
  this.id = options.id;
  this.mode = options.mode;
  this.pathList = [];
  if (options.pathList) {
    let decodedPaths = decodeURIComponent(options.pathList);
    this.pathList = JSON.parse(decodedPaths);
  }
  this.rid = options.rid;
  this.recDuration = 0;
  this.totPauseTime = 0;
  this.replayDuration = options.duration ? parseInt(options.duration) : 0;
  this.maxSessions = options.maxSessions ? parseInt(options.maxSessions) : 1;
  this.requests = [];
  this.inputMessages = [];
  this.outputMessages = [];
  this.delays = [];
  this.consoleTest = [];
  this.testResult = {
    cpu: [],
    memory: [],
    activeSessions: [],
    exceptions: [],
    tagErrors: [],
    noResponseErrors: [],
    consoleTestErrors: [],
    totErrors: [],
    slownessWarnings: [],
    percentageCompleted: 0,
    nonCreatedSessions: 0
  };
  this.lastCPUValues = [];
  this.reqIndex = 0;
  this.startTime = 0;
  this.totalSessionsDuration = 0;
  this.totalSessionsError = 0;
  //
  this.slowTimer = options.slowTimer ? parseInt(options.slowTimer) : null;
  this.killTimer = options.killTimer ? parseInt(options.killTimer) : null;
  //
  // Map of objects involved in recording. The values of this map are objects having two properties:
  // oldId and newId. Both the two properties represent the auto-generated objects ids
  // (i.e. the ones which change at each app execution). The first one (oldId) represent the
  // auto-generated object id at recording time; the second one (newId) represent the same at replay time.
  // Intstead, the map's keys are the objects pids (that never change). Into the input messages I collect,
  // there are the auto-generated ids (i.e. oldId). The trick is to update map values with new auto-generated ids
  // every time a message comes from server. At recording time I put these ids into oldId property,
  // while at replay time I use newId to store the id. In this way, before sending a message at replay time,
  // I can use this map to replace oldId references I find inside that message with the corredsponding newId
  this.objectsMap = {};
  //
  // Children test autos for non regression/load mode
  this.children = {};
};


Node.TestAuto.ModeMap = {
  rec: "r",
  stepByStep: "sbs",
  load: "l",
  nonReg: "nr"
};


Node.TestAuto.msgTypeMap = {
  appmsg: "appmsg",
  testStart: "test"
};


/**
 * Initialize this test
 * @param {Node.AppClient} appClient
 * */
Node.TestAuto.prototype.init = function (appClient)
{
  this.appClient = appClient;
  this.session = appClient.session;
  //
  // If there isn't a real session I need to create it
  if (!this.session.id) {
    this.session = this.app.createNewSession();
    //
    // If needed ask the worker to create the physical child process
    if (!this.session.worker.child)
      this.session.worker.createChild();
  }
  //
  // Tell app this is a test auto
  this.session.sendToChild({
    type: Node.TestAuto.msgTypeMap.appmsg,
    sid: this.session.id,
    content: [{
      id: "setTestAuto"
    }]
  }); 
  //
  // Tell app to update its dbs
  if (this.mode !== Node.TestAuto.ModeMap.rec)
    this.session.sendToChild({
      type: Node.TestAuto.msgTypeMap.testStart,
      sid: this.session.id,
      cnt: {
        testAutoId: this.id
      }
    });
};


/**
 * Handle update schema result
 * @param {object} res
 * */
Node.TestAuto.prototype.handleUpdateSchemaResult = function (res)
{
  if (res?.err) {
    this.consoleRequest.sendResponse(this.rid, 500, `Update schema failed: ${res.err}`);
    return;
  }
  //
  // If I want to replay a test, get recorded file/files for this test
  if (this.mode !== Node.TestAuto.ModeMap.rec) {
    this.recFiles = [];
    //
    this.getRecording();
  }
};


/**
 * Sniff a command sent or received
 * @param {Array} req - array of commands
 * @param {bool} cts - if true, it is a client command, otherwise a server command
 * */
Node.TestAuto.prototype.sniff = function (req, cts)
{
  // If I receive an initTestAuto request in replay mode, I start the replay
  for (let i = 0; i < req.length; i++) {
    // Add an entry to objects map for each element found inside current request content
    if (req[i].cnt)
      this.addObjToMap(req[i].cnt);
    //
    if (req[i].id === "initTestAuto" && !this.realInitTestAuto) {
      this.realInitTestAuto = true;
      this.startTime = new Date().getTime();
      //
      // In step by step mode, check if need to wait for files to be read
      if (this.mode === Node.TestAuto.ModeMap.stepByStep) {
        if (!this.filesReady) {
          this.waitFilesInterval = setInterval(() => {
            if (this.filesReady) {
              this.playRequest();
              clearInterval(this.waitFilesInterval);
              delete this.waitFilesInterval;
            }
          }, 200);
        }
        else
          this.playRequest();
      }
      continue;
    }
    //
    if (req[i].id === "playTestAuto") {
      // Remember a playTestAuto msg arrived
      if (req[i].content.play)
        this.play();
      else
        this.pause();
      return;
    }
    //
    if (req[i].id === "consoleTest") {
      // Compare console.test value with the saved ones
      if (this.mode !== Node.TestAuto.ModeMap.rec)
        this.saveConsoleTestResults(req[i].cnt);
      else // Save console.test value
        this.consoleTest.push(req[i].cnt);
      //
      if (req.length === 1)
        return;
      else {
        req.splice(i--, 1);
        continue;
      }
    }
    //
    if (req[i].id === "stepForwardTestAuto") {
      if (this.mode !== Node.TestAuto.ModeMap.rec)
        this.stepForward();
      //
      if (req.length === 1)
        return;
      else {
        req.splice(i--, 1);
        continue;
      }
    }
    //
    if (req[i].id === "sendExceptionToTestAuto") {
      this.saveException(req[i].cnt);
      //
      if (req.length === 1)
        return;
      else {
        req.splice(i--, 1);
        continue;
      }
    }
    //
    if (req[i].id === "getTaggingDataResults") {
      this.saveTagResults(req[i].cnt);
      //
      if (req.length === 1)
        return;
      else {
        req.splice(i--, 1);
        continue;
      }
    }
    //
    if (["setTestAuto", "calculateTagResults", "setTaggingData", "closePopup", "onPause", "onResume", "getTestProperties", "sendMessageToTestAuto"].includes(req[i].id)) {
      if (req.length === 1)
        return;
      else {
        req.splice(i--, 1);
        continue;
      }
    }
    //
    if (["alertCB", "confirmCB", "promptCB"].includes(req[i].id))
      this.session.sendMessageToClientApp({type: Node.TestAuto.msgTypeMap.appmsg, content: [{id: "closePopup"}]});
    //
    // Save the last opened popup callback id. In record mode I saved a popupBoxReturn message having a certain cbId
    // as a parameter. But this cbId is a "record-time" value. So I save the current cbId in order to replace the cbId into
    // popupBoxReturn message when I'll go to send it
    if (["popup", "confirm", "prompt"].includes(req[i].id)) {
      if (!this.lastPopupCbId)
        this.lastPopupCbId = req[i].cnt.cbId;
    }
    //
    // Cookies are in the client and server ask it for them. But in case of non reg or load test,
    // I have not a client. So save cookies in onStart request to simulate cookies request in those kind of tests
    if (req[i].id === "onStart") {
      this.onStartArrived = true;
      //
      if (this.mode === Node.TestAuto.ModeMap.rec) {
        req[i].cookies = req[i].cookies || this.session.cookies;
        this.playTime = new Date().getTime();
      }
    }
  }
  //
  // In recording mode, don't save requests arriving before onStart (they could be onPause/onResume...)
  if (this.mode === Node.TestAuto.ModeMap.rec && !this.onStartArrived)
    return;
  //
  let currentTime = new Date().getTime();
  //
  // Client event
  if (cts) {
    if (this.mode === Node.TestAuto.ModeMap.rec) {
      // Check if I received saveTestAuto request, because I don't want to save it
      for (let i = 0; i < req.length; i++) {
        if (req[i].id === "saveTestAuto") {
          this.needToSave = true;
          this.desc = req[i].content;
          if (req.length === 1)
            return;
        }
      }
      //
      // No input messages yet: this is the first request or the previous request was closed.
      // Anyway open a new request.
      if (this.inputMessages.length === 0)
        this.inputMessages.push({content: req, time: currentTime});
      else {
        let delay;
        //
        // If I didn't receive any output message yet, calculate the delay since last input message
        if (this.outputMessages.length === 0)
          delay = currentTime - this.inputMessages[this.inputMessages.length - 1].time;
        else // Otherwise use last output message to calculate the delay
          delay = currentTime - this.outputMessages[this.outputMessages.length - 1].time;
        //
        // Use the delay to check if a request need to be closed
        if (delay > 200) {
          // Close the request
          this.requests.push({input: this.inputMessages, output: this.outputMessages});
          //
          // Reset inputMessages && outputMessages for a new request
          this.inputMessages = [];
          this.outputMessages = [];
          //
          if (req && req.length > 0) {
            // This is the first message of new request
            this.inputMessages.push({content: req, time: currentTime});
            //
            // Add current delay to delays list. In case of first request,
            // add 0 before adding current delay because first request has no delay.
            if (this.delays.length === 0)
              this.delays.push(0);
            //
            //
            if (this.paused)
              this.totPauseTime += currentTime - this.pauseTimeStamp;
            //
            let delayToPush = (delay - this.totPauseTime) > 0 ? (delay - this.totPauseTime) : 0;
            this.delays.push(delayToPush);
            this.reqClosed = true;
            this.totPauseTime = 0;
          }
        }
        else // Otherwise simply add this message as input of current opened request
          this.inputMessages.push({content: req, time: currentTime});
      }
    }
  }
  else { // Server command
    let syntReq = this.synthesizeReq(req);
    this.outputMessages.push({content: syntReq, time: currentTime});
    //
    // Process next request
    if (this.mode !== Node.TestAuto.ModeMap.rec) {
      this.expectedResponses -= syntReq.length;
      //
      // When all expected responses arrived, process next request
      if (this.expectedResponses <= 0 && !this.paused && !this.playTimeout)
        this.playRequest();
    }
  }
};


/**
 * Synthesize a request removing unnecessary properties
 * @param {Array} req - req to synthesize
 * */
Node.TestAuto.prototype.synthesizeReq = function (req)
{
  return req.map(r => ({id: r.id, obj: r.obj}));
};


/**
 * Save an exception received from the application during test execution
 * @param {Exception} ex - Exception object containing:
 *                        - msg: error message
 *                        - stack: error stack trace (optional)
 * */
Node.TestAuto.prototype.saveException = function (ex)
{
  // Create exception object with initial occurrence counter
  let exception = {
    occurr: 1,
    msg: ex.msg
  };
  //
  // Extract method name from stack trace if available
  if (ex.stack) {
    let atPos = ex.stack.indexOf("at") + 3;
    let wholeStackMsg = ex.stack.substring(atPos);
    let stackMsg = wholeStackMsg.substring(0, wholeStackMsg.indexOf(" "));
    exception.method = stackMsg;
  }
  //
  // Save exception to parent test results
  // (in step-by-step mode the parent is the test itself)
  let testAuto = this.parent || this;
  //
  // Check if an identical exception already exists (same message and method)
  let existingException = testAuto.testResult.exceptions.find(e =>
    e.msg === exception.msg && e.method === exception.method
  );
  //
  // Increment counter if exception exists, otherwise add it to the list
  if (existingException)
    existingException.occurr++;
  else
    testAuto.testResult.exceptions.push(exception);
};


/**
 * Save recorded session
 * */
Node.TestAuto.prototype.save = async function ()
{
  // Sometimes there are client messages without a releted server response.
  // These will result in a pending request, so close it.
  if (this.inputMessages.length > 0)
    this.requests.push({input: this.inputMessages, output: this.outputMessages});
  //
  delete this.needToSave;
  //
  // Cut all delays greater than 1000 ms
  let totDelays = 0;
  for (let i = 0; i < this.delays.length - 1; i++) {
    this.delays[i] = this.delays[i] > 1000 ? 1000 : this.delays[i];
    totDelays += this.delays[i];
  }
  //
  this.delays[this.delays.length - 1] = 1000;
  //
  // Create recorded session object
  let rec = {
    requests : this.requests,
    delays : this.delays,
    description : this.desc,
    duration : totDelays + 1000,
    consoleTest : this.consoleTest,
    objectsMap : this.objectsMap
  };
  //
  // Upload file to GCloud
  let archiver = new Node.Archiver(this.app.server);
  try {
    await archiver.saveObject(this.pathList[0], JSON.stringify(rec));
    //
    // Send response to console
    let responseText = JSON.stringify({duration: parseInt(rec.duration / 1000), description: rec.description});
    this.consoleRequest.sendResponse(this.rid, 200, responseText);
  }
  catch (err) {
    // Send error to console
    this.consoleRequest.sendResponse(this.rid, 500, err);
  }
  //
  // Terminate test session
  this.terminate();
};


/**
 * Get mode
 * */
Node.TestAuto.prototype.getMode = function ()
{
  return this.mode;
};


/**
 * Play a recorded client request
 * @param {Boolean} stepForward - true if I'm playing step by step
 * */
Node.TestAuto.prototype.playRequest = function (stepForward)
{
  clearTimeout(this.playTimeout);
  delete this.playTimeout;
  clearTimeout(this.slowSessionTimeout);
  delete this.slowSessionTimeout;
  clearTimeout(this.killSessionTimeout);
  delete this.killSessionTimeout;
  //
  // Check if test is ended
  if (this.reqIndex === this.requests.length) {
    this.paused = true;
    //
    // If a browser is involved in testing send info about test to it
    if (this.mode === Node.TestAuto.ModeMap.stepByStep) {
      let msgContent = {
        id: "endTest",
        exceptions: this.testResult.exceptions,
        consoleTestErrors: this.testResult.consoleTestErrors,
        tagErrors: this.testResult.tagErrors,
        noResponseErrors: this.testResult.noResponseErrors,
        slownessWarnings: this.testResult.slownessWarnings
      };
      this.session.sendMessageToClientApp({
        type: Node.TestAuto.msgTypeMap.appmsg,
        content: [{
          id: "sendMessageToTestAuto",
          cnt: {
            type: "testAutoMsg",
            content: msgContent
          }
        }]
      });
      //
      this.testResult.duration = parseInt(this.recDuration / 1000);
      this.testResult.percentageCompleted = 100;
      delete this.testResult.cpu;
      delete this.testResult.memory;
      delete this.testResult.activeSessions;
      delete this.testResult.totErrors;
      //
      this.saveResults(this.testResult);
    }
    else // Otherwise notify parent I terminated test execution
      this.parent.onTerminateTest(this.childId);
    //
    // Reset test auto
    this.reset({id: this.id, mode: this.mode});
    return;
  }
  //
  let req = [];
  let delay = 0;
  //
  // If play request is caused by a step forward command, tell preview to update its timer adding giving value
  if (this.mode === Node.TestAuto.ModeMap.stepByStep && stepForward) {
    this.session.sendMessageToClientApp({
      type: Node.TestAuto.msgTypeMap.appmsg,
      content: [{
        id: "sendMessageToTestAuto",
        cnt: {
          type: "testAutoMsg",
          content: {
            id: "updateTimer",
            millisecToAdd: this.delays[this.reqIndex]
          }
        }
      }]
    });
  }
  //
  // Get next delay
  delay = !this.paused ? this.delays[this.reqIndex] : 0;
  //
  this.playTimeout = setTimeout(() => {
    // Clear timeouts
    clearTimeout(this.playTimeout);
    delete this.playTimeout;
    clearTimeout(this.slowSessionTimeout);
    delete this.slowSessionTimeout;
    clearTimeout(this.killSessionTimeout);
    delete this.killSessionTimeout;
    //
    // Get next request
    req = this.requests[this.reqIndex];
    //
    this.reqIndex++;
    //
    // Tell preview to update its requests counter
    if (this.mode === Node.TestAuto.ModeMap.stepByStep) {
      this.session.sendMessageToClientApp({
        type: Node.TestAuto.msgTypeMap.appmsg,
        content: [{
          id: "sendMessageToTestAuto",
          cnt: {
            type: "testAutoMsg",
            content: {
              id: "updateReqNumber",
              reqIndex: this.reqIndex,
              reqTotal: this.requests.length
            }
          }
        }]
      });
    }
    //
    // Set expected number of responses
    this.expectedResponses = 0;
    for (let i = 0; i < req.output.length; i++)
      this.expectedResponses += req.output[i].content.length;
    //
    // this.expectedResponses changes every time a response come from server.
    // So I need another property to save total expected responses for each request in order to compare
    // its value with this.expectedResponses when killSessionTimeout fired
    this.outputLength = this.expectedResponses;
    //
    // Process request
    let processRequest = (request, i, timer) => {
      setTimeout(() => {
        for (let j = 0; j < request.input[i].content.length; j++) {
          if (request.input[i].content[j].id === "saveTaggingData") {
            // In step-by-step mode, when I'm processing saveTaggingData command
            // I send recorded taggingData to client, so it can compare values with
            // current elements' values and check if there are some differences
            if (this.mode === Node.TestAuto.ModeMap.stepByStep)
              this.paused = true;
            //
            // If needed, convert remelems id to the new ones
            let tagValues = request.input[i].content[j].content;
            if (tagValues) {
              let newId;
              for (let k = 0; k < tagValues.length; k++) {
                // Skip popup elements
                if (tagValues[k].elId === "popup")
                  continue;
                //
                newId = this.getNewIdFromOldId(tagValues[k].elId);
                //
                // If current object has a new id, replace the old one
                tagValues[k].elId = newId || tagValues[k].elId;
                //
                // If I didn't find new id, it means I haven't got the object in the map
                if (!newId)
                  tagValues[k].elNotFound = true;
              }
              //
              // Tell client to calculate tag results
              this.session.sendToChild({
                type: Node.TestAuto.msgTypeMap.appmsg,
                sid: this.session.id,
                content: [{
                  id: "calculateTagResults",
                  content: tagValues
                }]
              });
            }
          }
          else if (request.input[i].content[j].id === "popupBoxReturn") {
            if (request.input[i].content[j].content && this.lastPopupCbId) {
              request.input[i].content[j].content.cbId = this.lastPopupCbId;
              delete this.lastPopupCbId;
            }
          }
        }
        //
        // If needed, convert remelems id to the new ones
        let input = request.input[i].content;
        for (let k = 0; k < input.length; k++)
          input[k].obj = this.getNewIdFromOldId(input[k].obj) || input[k].obj;
        //
        this.session.sendToChild({
          type: Node.TestAuto.msgTypeMap.appmsg,
          sid: this.session.id,
          content: input,
          request: {}
        });
      }, timer);
    };
    //
    // A client request can be multiple (i.e. it can consists of more sub-request).
    // Process all them
    let reqDelay = 0;
    for (let i = 0; i < req.input.length; i++) {
      let timeout = req.input[i - 1] ? req.input[i].time - req.input[i - 1].time : 0;
      reqDelay += timeout;
      processRequest(req, i, reqDelay);
    }
    //
    // Set response timeout only if replay is not paused.
    // When replay is paused it means I'm replay step-by-step, so I don't want to automatically play next request
    if (!this.paused) {
      // Try to play next request if test has not done yet by itself
      let reqDuration = this.getReqDuration(req);
      //
      // Set min delay to 1 second
      let nextDelay = Math.max(1000, reqDuration * 5);
      //
      // Set max delay to 10 seconds (or to reqDuration * 2 if this calculation is greater than 10 seconds)
      nextDelay = Math.min(Math.max(10000, reqDuration * 2), nextDelay);
      //
      // For long request (i.e. more than 10 seconds), set delay to 2 * req duration
      nextDelay = (reqDuration >= 10000) ? reqDuration * 2 : nextDelay;
      //
      // Get slow and kill timer from parent (load or non-reg test) or from test itself (step-by-step test)
      let st = this.parent ? this.parent.slowTimer : this.slowTimer;
      let kt = this.parent ? this.parent.killTimer : this.killTimer;
      //
      // Calculate delays to notify session slowness or session killing
      let slowDelay = st ? Math.max(st, nextDelay) : nextDelay;
      let killDelay = kt ? Math.max(kt, nextDelay) : nextDelay;
      //
      // If the delayes are the same, posticipate killDelay
      if (slowDelay === killDelay)
        killDelay = slowDelay + 500;
      //
      this.slowSessionTimeout = setTimeout(() => {
        clearTimeout(this.slowSessionTimeout);
        delete this.slowSessionTimeout;
        //
        if (this.outputLength !== 0 && this.outputLength === this.expectedResponses)
          this.saveNoResponse(req, slowDelay, true);
      }, slowDelay);
      //
      this.killSessionTimeout = setTimeout(() => {
        clearTimeout(this.killSessionTimeout);
        delete this.killSessionTimeout;
        //
        if (this.outputLength !== 0 && this.outputLength === this.expectedResponses) {
          this.saveNoResponse(req, killDelay);
          //
          if (this.mode !== Node.TestAuto.ModeMap.stepByStep) {
            this.parent.onTerminateTest(this.childId);
            //
            // Reset test auto
            this.reset({id: this.id, mode: this.mode});
            return;
          }
        }
        //
        this.playRequest();
      }, killDelay);
      //
      // No need to wait for response. Process next request
      if (req.output.length === 0)
        this.playRequest();
    }
  }, delay);
};


/**
 * Process next request
 * */
Node.TestAuto.prototype.stepForward = function ()
{
  this.pause();
  this.playRequest(true);
};


/**
 * Pause test auto
 * */
Node.TestAuto.prototype.pause = function ()
{
  if (!this.paused)
    this.recDuration += new Date().getTime() - this.startTime;
  //
  if (this.mode !== Node.TestAuto.ModeMap.rec) {
    clearTimeout(this.playTimeout);
    clearTimeout(this.slowSessionTimeout);
    clearTimeout(this.killSessionTimeout);
    delete this.playTimeout;
    delete this.slowSessionTimeout;
    delete this.killSessionTimeout;
  }
  else
    this.pauseTimeStamp = new Date().getTime();
  //
  this.paused = true;
};


/**
 * Play test auto
 * */
Node.TestAuto.prototype.play = function ()
{
  this.startTime = new Date().getTime();
  this.paused = false;
  if (this.mode !== Node.TestAuto.ModeMap.rec)
    this.playRequest();
  else {
    if (!this.reqClosed || this.totPauseTime === 0)
      this.totPauseTime += this.startTime - this.pauseTimeStamp;
    this.reqClosed = false;
  }
};


/**
 * Get recording file/files to replay
 * */
Node.TestAuto.prototype.getRecording = async function ()
{
  let archiver = new Node.Archiver(this.app.server);
  for (let i = 0; i < this.pathList.length; i++) {
    try {
      // Read file from GCloud
      this.recFiles.push(await archiver.readObject(this.pathList[i]));
    }
    catch (err) {
      // Send error to console
      this.consoleRequest.sendResponse(this.rid, 500, err);
      //
      // Terminate test session
      this.terminate();
      return;
    }
  }
  //
  // Prepare test replay
  this.prepareReplay();
};


/**
 * Prepare replay creating sessions
 * */
Node.TestAuto.prototype.prepareReplay = function ()
{
  this.watchdog();
  //
  // Set start test time
  this.startTime = new Date().getTime();
  //
  // I use current session (i.e. this.session) as entry point for test auto.
  // In case of step-by-step test I don't need to create any other sessions.
  // Simply use current session to communicate with client and to replay recorded commands.
  // In case of load or non-regression test current session is not used to communicate with
  // client. In fact I'll create a session for each recording I want to replay and they
  // will do the work.
  switch (this.mode) {
    case Node.TestAuto.ModeMap.stepByStep: {
      this.requests = this.recFiles[0].requests;
      this.delays = this.recFiles[0].delays;
      this.consoleTest = this.recFiles[0].consoleTest;
      this.recDuration = this.recFiles[0].duration;
      this.objectsMap = this.recFiles[0].objectsMap || {};
      this.filesReady = true;
      //
      // Tell client test replay is ready to start
      this.session.sendMessageToClientApp({
        type: Node.TestAuto.msgTypeMap.appmsg,
        content: [{
          id: "sendMessageToTestAuto",
          cnt: {
            type: "testAutoMsg",
            content: {
              id: "readyToStart"
            }
          }
        }]
      });
      break;
    }

    case Node.TestAuto.ModeMap.nonReg: {
      let test = {
        requests: this.recFiles[0].requests,
        delays: this.recFiles[0].delays,
        consoleTest: this.recFiles[0].consoleTest,
        recDuration: this.recFiles[0].duration,
        objectsMap: this.recFiles[0].objectsMap || {}
      };
      //
      // Create a child test auto to execute test
      this.createChild(test);
      break;
    }

    case Node.TestAuto.ModeMap.load: {
      for (let i = 0; i < this.recFiles.length; i++)
        this.consoleTest = this.consoleTest.concat(this.recFiles[i].consoleTest);
      //
      // Set slot duration
      let slotDuration = parseFloat(this.replayDuration / 5);
      //
      let currentSlot = 0;
      //
      // Set children number to create in first slot (10% of total)
      let slotChildren = parseFloat((this.maxSessions * 10) / 100);
      //
      // Set child time for first slot (i.e. delay between two consecutives children creation)
      let childTime = parseInt((slotDuration / slotChildren) * 1000);
      //
      // Number of children created into current slot
      let currentSlotChildren = 0;
      //
      // Total children created
      this.totalChildren = 0;
      //
      // Callback for create child timeout
      let loadCallback = () => {
        // If I created all requested children, do nothing else
        if (this.totalChildren === this.maxSessions) {
          clearTimeout(this.loadTimeout);
          delete this.loadTimeout;
          return;
        }
        //
        let fileIndexToUse = this.totalChildren % this.recFiles.length;
        //
        let test = {
          requests: this.recFiles[fileIndexToUse].requests,
          delays: this.recFiles[fileIndexToUse].delays,
          recDuration: this.recFiles[fileIndexToUse].duration,
          consoleTest: this.recFiles[fileIndexToUse].consoleTest,
          objectsMap: this.recFiles[fileIndexToUse].objectsMap || {}
        };
        //
        currentSlotChildren++;
        this.totalChildren++;
        //
        // Create a child test auto to execute test
        this.createChild(test);
        //
        // If I created all children for this slot
        if (currentSlotChildren === slotChildren) {
          // Go to next slot
          currentSlot++;
          //
          // Reset slot children count
          currentSlotChildren = 0;
          //
          // Set children number to create in next slot
          switch (currentSlot) {
            case 1:
            case 3:
              slotChildren = parseFloat((this.maxSessions * 20) / 100);
              break;

            case 2:
              slotChildren = parseFloat((this.maxSessions * 40) / 100);
              break;

            case 4:
              slotChildren = parseFloat((this.maxSessions * 10) / 100);
              break;
          }
          //
          // Set child time for next slot
          childTime = parseInt((slotDuration / slotChildren) * 1000);
        }
        //
        // Create next child
        this.loadTimeout = setTimeout(loadCallback, childTime);
      };
      //
      // Start creating children
      this.loadTimeout = setTimeout(loadCallback, childTime);
      break;
    }
  }
  //
  // Set 1 sec interval to get results
  if ([Node.TestAuto.ModeMap.load, Node.TestAuto.ModeMap.nonReg].includes(this.mode)) {
    this.resultInterval = setInterval(() => {
      // Calculate cpu usage
      Node.Utils.getCPUload().then(cpuUsage => {
        // Save last 10 cpu usage values
        if (this.lastCPUValues.length > 10)
          this.lastCPUValues.splice(0, 1);
        //
        this.lastCPUValues.push(cpuUsage);
        //
        let sum = 0;
        for (let i = 0; i < this.lastCPUValues.length; i++)
          sum += this.lastCPUValues[i];
        //
        let cpuAvg = Math.round((sum / this.lastCPUValues.length) * 100) / 100;    // 2 dec digits
        this.testResult.cpu.push(cpuAvg);
      });
      //
      // Calculate memory usage
      let freeMem = (Node.os.freemem() / (1024 * 1024)).toFixed(2);
      let totalMem = (Node.os.totalmem() / (1024 * 1024)).toFixed(2);
      let memoryUsage = ((totalMem - freeMem) * 100 / totalMem).toFixed(2);
      this.testResult.memory.push(memoryUsage);
      //
      let childrenIds = Object.keys(this.children);
      //
      this.testResult.activeSessions.push(childrenIds.length);
      //
      // Update percentage completed
      if (this.mode === Node.TestAuto.ModeMap.load)
        this.testResult.percentageCompleted = (((this.testsEnded || 0) + this.totalChildren) * 100) / (this.maxSessions * 2);
      else
        this.testResult.percentageCompleted = (this.children[childrenIds[0]].reqIndex * 100) / this.children[childrenIds[0]].requests.length;
    }, 1000);
  }
};


/**
 * Reset test auto
 * @param {Object} options
 * */
Node.TestAuto.prototype.reset = function (options)
{
  this.id = options.id;
  this.mode = options.mode;
  this.recDuration = 0;
  this.replayDuration = options.duration ? parseInt(options.duration) : 0;
  this.maxSessions = options.maxSessions ? parseInt(options.maxSessions) : 1;
  this.inputMessages = [];
  this.outputMessages = [];
  this.delays = [];
  this.consoleTest = [];
  this.testResult = {
    cpu: [],
    memory: [],
    activeSessions: [],
    exceptions: [],
    tagErrors: [],
    noResponseErrors: [],
    slownessWarnings: [],
    consoleTestErrors: [],
    totErrors: [],
    percentageCompleted: 0,
    nonCreatedSessions: 0
  };
  this.lastCPUValues = [];
  this.reqIndex = 0;
  this.startTime = 0;
  this.totalSessionsDuration = 0;
  this.totalSessionsError = 0;
  delete this.desc;
  delete this.needToSave;
  clearTimeout(this.slowSessionTimeout);
  clearTimeout(this.killSessionTimeout);
  clearTimeout(this.playTimeout);
  clearTimeout(this.loadTimeout);
  clearInterval(this.resultInterval);
  clearInterval(this.waitFilesInterval);
  delete this.slowSessionTimeout;
  delete this.killSessionTimeout;
  delete this.playTimeout;
  delete this.loadTimeout;
  delete this.resultInterval;
  this.waitFilesInterval;
};


/**
 * Fired when appClient is disconnected
 * */
Node.TestAuto.prototype.onDisconnectClient = function ()
{
  if (this.needToSave)
    this.save();
  else if ([Node.TestAuto.ModeMap.rec, Node.TestAuto.ModeMap.stepByStep].includes(this.mode) && !this.terminated) {
    // Send response to console
    this.consoleRequest.sendResponse(this.rid, 499, "Client disconnected");
    //
    // Terminate test session
    this.terminate();
  }
};


/**
 * Create a new test auto with a new session where execute a test
 * @param {Object} test
 *                  - requests: list of requests to replay
 *                  - delays: delays between requests
 * */
Node.TestAuto.prototype.createChild = function (test)
{
  let options = {
    id: this.id,
    mode: this.mode,
    duration: this.replayDuration ? parseInt(this.replayDuration) : 0,
    maxSessions: this.maxSessions ? parseInt(this.maxSessions) : 1
  };
  //
  // Create new test session
  let session = this.app.createNewSession();
  //
  // If there isn't a session it means numbers of active sessions has reached the maximum number of sessions
  // server can handle. So it's not possible to create another session
  if (!session) {
    this.testResult.nonCreatedSessions++;
    this.onTerminateTest();
    return;
  }
  session.testAutoId = this.id;
  //
  // Create app client
  let req = {query: {}};
  let res = {};
  res.redirect = () => {
  };
  let appClient = session.createAppClient(req, res);
  //
  // If needed ask the worker to create the physical child process
  if (!session.worker.child)
    session.worker.createChild();
  //
  // Clear killClient timeout. I don't have a browser, so appClient will never receive response
  // and it would be killed
  if (appClient.killClient) {
    clearTimeout(appClient.killClient);
    delete appClient.killClient;
  }
  //
  // Create a child test auto
  let childTestAuto = new Node.TestAuto(this.app, options);
  childTestAuto.childId = Node.Utils.generateUID24();
  childTestAuto.parent = this;
  childTestAuto.session = session;
  childTestAuto.appClient = appClient;
  childTestAuto.requests = JSON.parse(JSON.stringify(test.requests || []));
  childTestAuto.delays = JSON.parse(JSON.stringify(test.delays || []));
  childTestAuto.recDuration = test.recDuration;
  childTestAuto.consoleTest = JSON.parse(JSON.stringify(test.consoleTest || []));
  childTestAuto.objectsMap = JSON.parse(JSON.stringify(test.objectsMap || {}));
  childTestAuto.startTime = new Date().getTime();
  //
  // Save new test auto into children map
  this.children[childTestAuto.childId] = childTestAuto;
  //
  // Tell app this is a test auto
  childTestAuto.session.sendToChild({
    type: Node.TestAuto.msgTypeMap.appmsg,
    sid: childTestAuto.session.id,
    content: [{
      id: "setTestAuto"
    }]
  }); 
  //
  // Starting play requests
  this.children[childTestAuto.childId].playRequest();
};


/**
 * Called by a child when its test is ended
 * @param {String} id - test to execute
 * */
Node.TestAuto.prototype.onTerminateTest = function (id)
{
  // Terminate child testauto
  if (this.children[id]) {
    this.children[id].session.deleteAppClient(this.children[id].appClient);
    delete this.children[id];
  }
  //
  if (!this.testsEnded)
    this.testsEnded = 0;
  this.testsEnded++;
  //
  // Update percentage completed
  if (this.mode === Node.TestAuto.ModeMap.load)
    this.testResult.percentageCompleted = ((this.testsEnded + this.totalChildren) * 100) / (this.maxSessions * 2);
  //
  // Calculate total exceptions occurred
  let totExceptions = 0, totTagErrors = 0, totConsoleTestErrors = 0, totNoResponseErrors = 0;
  for (let i = 0; i < this.testResult.exceptions.length; i++)
    totExceptions += this.testResult.exceptions[i].occurr;
  //
  // Calculate total tag errors occurred
  for (let i = 0; i < this.testResult.tagErrors.length; i++)
    totTagErrors += this.testResult.tagErrors[i].occurr;
  //
  // Calculate total console test errors occurred
  for (let i = 0; i < this.testResult.consoleTestErrors.length; i++)
    totConsoleTestErrors += this.testResult.consoleTestErrors[i].occurr;
  //
  // Calculate total no response errors occurred
  for (let i = 0; i < this.testResult.noResponseErrors.length; i++)
    totNoResponseErrors += this.testResult.noResponseErrors[i].occurr;
  //
  // Calculate error average for ended session
  this.totalSessionsError = totExceptions + totTagErrors + totConsoleTestErrors + totNoResponseErrors;
  let totChildren = this.mode === Node.TestAuto.ModeMap.load ? this.totalChildren : 1;
  let totErrors = this.totalSessionsError / totChildren;
  this.testResult.totErrors.push(totErrors.toFixed(2));
  //
  if (this.testsEnded === this.maxSessions) {
    clearInterval(this.resultInterval);
    delete this.resultInterval;
    this.testResult.duration = parseInt(Math.round((new Date().getTime() - this.startTime) / 1000));
    //
    delete this.testsEnded;
    //
    if (this.mode === Node.TestAuto.ModeMap.nonReg) {
      delete this.testResult.cpu;
      delete this.testResult.memory;
      delete this.testResult.activeSessions;
      delete this.testResult.totErrors;
    }
    //
    this.saveResults(this.testResult);
  }
};


/**
 * Save tag results
 * @param {Object} res - test results
 * */
Node.TestAuto.prototype.saveTagResults = function (res)
{
  // If not res, do nothing..
  if (!res)
    return;
  //
  // Save tag as parent result. In case of step-by-step the parent is myself
  let testAuto = this.parent || this;
  //
  // Save just tag with errors
  for (let i = 0; i < res.length; i++) {
    if (res[i].error && res[i].props) {
      for (let k = 0; k < res[i].props.length; k++) {
        if ((res[i].props[k].oldValue !== res[i].props[k].newValue) || res[i].elNotFound) {
          let insert = true;
          let tagErr = {
            requestNumber: testAuto.reqIndex - 1,
            elId: res[i].elId,
            elName: res[i].elName,
            viewName: res[i].viewName,
            error: true,
            elNotFound: res[i].elNotFound,
            propName: res[i].props[k].propName,
            oldValue: res[i].props[k].oldValue,
            newValue: res[i].props[k].newValue,
            occurr: 1
          };
          //
          for (let j = 0; j < testAuto.testResult.tagErrors.length; j++) {
            let occurr = testAuto.testResult.tagErrors[j].occurr;
            testAuto.testResult.tagErrors[j].occurr = 1;
            if (JSON.stringify(testAuto.testResult.tagErrors[j]) === JSON.stringify(tagErr)) {
              insert = false;
              testAuto.testResult.tagErrors[j].occurr = occurr + 1;
              break;
            }
            else
              testAuto.testResult.tagErrors[j].occurr = occurr;
          }
          if (insert)
            testAuto.testResult.tagErrors.push(tagErr);
        }
      }
    }
  }
};


/**
 * Save console test results
 * @param {Object} consoleTest
 *                             - name
 *                             - value
 * */
Node.TestAuto.prototype.saveConsoleTestResults = function (consoleTest)
{
  // If not consoleTest, do nothing..
  if (!consoleTest)
    return;
  //
  // Save consoleTestResults as parent result. In case of step-by-step the parent is myself
  let testAuto = this.parent || this;
  for (let i = 0; i < this.consoleTest.length; i++) {
    // If I found the same console test into my saved list, don't save this console test as error
    if (this.consoleTest[i].name === consoleTest.name && this.consoleTest[i].value === consoleTest.value)
      return;
  }
  //
  for (let i = 0; i < this.consoleTest.length; i++) {
    if (this.consoleTest[i].name === consoleTest.name && this.consoleTest[i].value !== consoleTest.value) {
      let obj = {
        name: consoleTest.name,
        oldValue: this.consoleTest[i].value,
        newValue: consoleTest.value,
        occurr: 1
      };
      //
      let insert = true;
      for (let j = 0; j < testAuto.testResult.consoleTestErrors.length; j++) {
        // Save old occurr value and temporarily set it to 1 to compare console tests without this property
        let occurr = testAuto.testResult.consoleTestErrors[j].occurr;
        testAuto.testResult.consoleTestErrors[j].occurr = 1;
        if (JSON.stringify(testAuto.testResult.consoleTestErrors[j]) === JSON.stringify(obj)) {
          insert = false;
          testAuto.testResult.consoleTestErrors[j].occurr = occurr + 1;
          break;
        }
        else
          testAuto.testResult.consoleTestErrors[j].occurr = occurr;
      }
      if (insert)
        testAuto.testResult.consoleTestErrors.push(obj);
      //
      break;
    }
  }
};


/**
 * Save a "no response" error
 * @param {Object} req
 * @param {Integer} timeout
 * @param {String} slowness - true if the reason of no response is session slowness
 * */
Node.TestAuto.prototype.saveNoResponse = function (req, timeout, slowness)
{
  let testAuto = this.parent || this;
  //
  // Extract object and operation from req
  let operation, object;
  if (req?.input) {
    for (let i = 0; i < req.input.length; i++) {
      let exit = false;
      if (req.input[i].content) {
        for (let j = 0; j < req.input[i].content.length; j++) {
          operation = req.input[i].content[j].id;
          object = req.input[i].content[j].obj;
          exit = true;
          break;
        }
        if (exit)
          break;
      }
      break;
    }
  }
  //
  let obj = {
    requestNumber: this.reqIndex - 1,
    originalRequestDuration: this.getReqDuration(req),
    message: slowness ? "Session was slow" : "Server didn't respond",
    operation,
    object,
    timeout,
    occurr: 1
  };
  //
  // Check if need to save this error
  let insert = true;
  let arr = slowness ? testAuto.testResult.slownessWarnings : testAuto.testResult.noResponseErrors;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].requestNumber === obj.requestNumber) {
      insert = false;
      arr[i].occurr++;
      break;
    }
  }
  //
  if (insert)
    arr.push(obj);
  //
  // When I save a no response error I have to remove an occurrencies from slowness warnings
  // because what was previously a warning is now an error
  if (!slowness) {
    for (let i = 0; i < testAuto.testResult.slownessWarnings.length; i++) {
      if (testAuto.testResult.slownessWarnings[i].requestNumber === obj.requestNumber) {
        testAuto.testResult.slownessWarnings[i].occurr--;
        //
        // If there are no more occurrencies for this item, remove it from array
        if (testAuto.testResult.slownessWarnings[i].occurr === 0)
          testAuto.testResult.slownessWarnings.splice(i, 1);
        break;
      }
    }
  }
};


/**
 * Save results
 * @param {Object} res
 * @param {Boolean} overload
 * */
Node.TestAuto.prototype.saveResults = function (res, overload)
{
  // Test completed
  res.percentageCompleted = 100;
  //
  if (overload)
    res.overloadError = true;
  //
  // Send response to console
  this.consoleRequest.sendResponse(this.rid, 200, JSON.stringify(res));
  //
  // Terminate test session.
  this.terminated = true;
  this.terminate();
};


/**
 * Terminate a test
 * */
Node.TestAuto.prototype.terminate = function ()
{
  // Terminate children
  let ids = Object.keys(this.children);
  for (let i = 0; i < ids.length; i++) {
    let child = this.children[ids[i]];
    if (child.session && child.session.worker)
      child.session.worker.deleteSession(child.session);
  }
  //
  // Terminate session
  if (this.session)
    this.session.worker.deleteSession(this.session);
  //
  // Reset all (clear and delete all timeouts, reset all properties and so on)
  this.reset({id: this.id, mode: this.mode});
  //
  // Stop watchdog
  this.watchdog(true);
  //
  // Delete test
  if (this.app.testAuto)
    delete this.app.testAuto[this.id];
};


/**
 * Get child by sid
 * @param {String} sid
 * */
Node.TestAuto.prototype.getChildBySID = function (sid)
{
  let ids = Object.keys(this.children);
  for (let i = 0; i < ids.length; i++) {
    if (this.children[ids[i]].session && this.children[ids[i]].session.id === sid)
      return this.children[ids[i]];
  }
};


/**
 * Add an object to map (key: pid; value: {oldId: id || newId: id})
 * @param {Object} obj
 * */
Node.TestAuto.prototype.addObjToMap = function (obj)
{
  if (obj.pid) {
    // The objectsMap elements have to be arrays, because there are some objects having
    // the same pid (i.e. dataMap rows or cloned objects)
    this.objectsMap[obj.pid] = this.objectsMap[obj.pid] || [];
    //
    let oldIdPos = -1;
    for (let i = 0; i < this.objectsMap[obj.pid].length; i++) {
      if (this.objectsMap[obj.pid][i].oldId === obj.id) {
        oldIdPos = i;
        break;
      }
    }
    if (this.mode === Node.TestAuto.ModeMap.rec) {
      if (!this.objectsMap[obj.pid][oldIdPos])
        this.objectsMap[obj.pid].push({oldId: obj.id});
    }
    else {
      for (let i = 0; i < this.objectsMap[obj.pid].length; i++) {
        if (this.objectsMap[obj.pid][i].newId === obj.id)
          break;
        else if (!this.objectsMap[obj.pid][i].newId) {
          this.objectsMap[obj.pid][i].newId = obj.id;
          break;
        }
      }
    }
  }
  //
  if (obj.children) {
    for (let i = 0; i < obj.children.length; i++)
      this.addObjToMap(obj.children[i]);
  }
  //
  if (obj.elements) {
    for (let i = 0; i < obj.elements.length; i++)
      this.addObjToMap(obj.elements[i]);
  }
  //
  if (obj.child) {
    this.addObjToMap(obj.child);
  }
  //
  return;
};


/**
 * Get new id related to old id from the objects map
 * @param {String} oldId
 * */
Node.TestAuto.prototype.getNewIdFromOldId = function (oldId)
{
  let pids = Object.keys(this.objectsMap);
  for (let i = 0; i < pids.length; i++) {
    for (let j = 0; j < this.objectsMap[pids[i]].length; j++) {
      if (this.objectsMap[pids[i]][j].oldId === oldId)
        return this.objectsMap[pids[i]][j].newId;
    }
  }
};


/**
 * Get request duration (i.e. time occurred between first input item and last output item)
 * @param {Object} req
 * */
Node.TestAuto.prototype.getReqDuration = function (req)
{
  if (!req || !req?.input || !req.output)
    return 0;
  //
  // Get first input item and last output item
  let firstInputItem = req.input[0];
  let lastOutputItem = req.output[req.output.length - 1] || req.input[req.input.length - 1];
  //
  let startTimeStamp = firstInputItem?.time || 0;
  let endTimeStamp = lastOutputItem?.time || 0;
  //
  return endTimeStamp - startTimeStamp;
};


/**
 * Check if server is in a safe status
 * @param {Boolean} stop
 * */
Node.TestAuto.prototype.watchdog = function (stop)
{
  if (stop) {
    clearTimeout(this.watchdogTimeout);
    return;
  }
  //
  let lastTimeStamp = new Date().getTime();
  this.watchdogTimeout = setTimeout(() => {
    clearTimeout(this.watchdogTimeout);
    //
    let now = new Date().getTime();
    //
    // The server is becoming too slow. Stop the test and send results to console
    if (now - lastTimeStamp > 1000)
      this.saveResults(this.testResult, true);
    else
      this.watchdog();
  }, 500);
};


//export module for node
if (module)
  module.exports = Node.TestAuto;
