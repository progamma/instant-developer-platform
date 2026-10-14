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
 * @class Node.TestAuto
 * @classdesc
 * Orchestrates a single test-auto run for an {@link Node.App}. A TestAuto
 * instance can either record the stream of client/server messages or replay
 * a previously recorded stream, optionally spawning child instances for
 * load and non-regression tests.
 *
 * Key features:
 * - **Record (`rec`)**: sniffs every message exchanged with the session,
 *   bucketing them into requests separated by >200 ms idle gaps, and
 *   persists them on Google Cloud via {@link Node.Archiver}.
 * - **Step-by-step (`sbs`)**: replays a single recording driven by the IDE
 *   preview, pausing on tagging-data comparisons and emitting progress
 *   events to the browser.
 * - **Non-regression (`nr`)**: spawns a single child TestAuto per recording
 *   and collects exceptions / tag errors / console-test errors.
 * - **Load (`l`)**: ramps up to `maxSessions` child sessions over 5 slots
 *   (10 / 20 / 40 / 20 / 10 %) and keeps a sliding average of CPU/memory
 *   usage every second until every child terminates.
 * - **Object id remapping**: auto-generated object ids change between
 *   record and replay; `objectsMap` tracks the `oldId → newId` mapping
 *   keyed by the stable `pid`, and {@link Node.TestAuto#getNewIdFromOldId}
 *   rewrites ids on outgoing messages.
 * - **Watchdog**: detects a stalled event loop (>1 s between two checks)
 *   and stops the test with an overload error.
 *
 * @property {Node.App} app - Owning app
 * @property {Object} consoleRequest - Pending console request used to return results
 * @property {String} id - Test identifier
 * @property {String} mode - Execution mode (see {@link Node.TestAuto.ModeMap})
 * @property {String[]} pathList - Cloud paths of the recordings being replayed
 * @property {String} [rid] - Console request id
 * @property {Number} recDuration - Recorded session duration in ms (updated on pause)
 * @property {Number} totPauseTime - Cumulative time spent paused during recording
 * @property {Number} replayDuration - Target replay duration in ms (load mode)
 * @property {Number} maxSessions - Maximum concurrent sessions for load/non-reg modes
 * @property {Object[]} requests - Recorded requests (`{input, output}`) to play back
 * @property {Object[]} inputMessages - Client-originated events of the current open request
 * @property {Object[]} outputMessages - Server-originated events of the current open request
 * @property {Number[]} delays - Delays (ms) between consecutive requests during replay
 * @property {Object[]} consoleTest - `console.test` values recorded for baseline comparison
 * @property {Object} testResult - Aggregated result payload returned to the console
 * @property {Number[]} lastCPUValues - Sliding window used to smooth CPU-usage samples
 * @property {Number} reqIndex - Index of the next request to play
 * @property {Number} startTime - Epoch ms marking the current play start
 * @property {Number} totalSessionsDuration - Accumulated session duration across children
 * @property {Number} totalSessionsError - Accumulated error count across children
 * @property {Number} [slowTimer] - Slow-response threshold (ms)
 * @property {Number} [killTimer] - Kill-response threshold (ms)
 * @property {Object} objectsMap - `pid → [{oldId, newId}]` map for cross-run object id remapping
 * @property {Object.<String, Node.TestAuto>} children - Map of child test autos keyed by `childId`
 * @property {Node.TestAuto} [parent] - Parent test auto (set on child instances)
 * @property {String} [childId] - Unique id within the parent's `children` map (set on child instances)
 * @property {Node.AppClient} [appClient] - Entry-point app client attached via {@link Node.TestAuto#init}
 * @property {Node.AppSession} [session] - Entry-point session attached via {@link Node.TestAuto#init}
 * @property {Boolean} [paused] - `true` while playback is paused
 * @property {Boolean} [terminated] - `true` once the test has been terminated
 */
Node.TestAuto = class TestAuto
{
  /**
   * Execution modes supported by TestAuto.
   * @enum {String}
   */
  static ModeMap = {
    /** Record: capture client/server messages and persist them as a recording */
    rec: "r",
    /** Step-by-step: interactive replay driven by the IDE preview */
    stepByStep: "sbs",
    /** Load: ramp up many concurrent sessions replaying the same recording(s) */
    load: "l",
    /** Non-regression: single-session replay that collects exceptions and tag errors */
    nonReg: "nr"
  };


  /**
   * IPC message types exchanged with the app child process.
   * @enum {String}
   */
  static msgTypeMap = {
    /** Application-level message routed as a regular session `appmsg` */
    appmsg: "appmsg",
    /** Start-of-test notification carrying the `testAutoId` */
    testStart: "test"
  };


  /**
   * @param {Node.App} app - App this test belongs to
   * @param {Object} options - Test options
   * @param {String} options.id - Test identifier
   * @param {String} options.mode - One of `r` (rec), `sbs` (step-by-step), `l` (load), `nr` (non-regression)
   * @param {String} [options.rid] - Console request id used to return the outcome
   * @param {String} [options.pathList] - URI-encoded JSON array of cloud paths of the recordings to replay
   * @param {String|Number} [options.duration] - Overall replay duration in seconds (load mode)
   * @param {String|Number} [options.maxSessions=1] - Maximum number of sessions to spawn (load mode)
   * @param {String|Number} [options.slowTimer] - Custom slow-response threshold in ms
   * @param {String|Number} [options.killTimer] - Custom kill-response threshold in ms
   */
  constructor(app, options)
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
  }


  /**
   * Attaches an app client to the test, wiring the underlying session used as
   * the entry point. If the incoming client has no real session yet (load /
   * non-reg modes), a new session is spawned and the worker's child process
   * is created. Then the child is told this session is under a test-auto,
   * and — for every non-record mode — a `testStart` notification is sent so
   * the app can refresh its DBs.
   * @param {Node.AppClient} appClient - App client that opens the session
   */
  init(appClient)
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
  }


  /**
   * Handles the result of the app-side schema update. On error, returns HTTP
   * 500 to the console and aborts; on success — and only when not in record
   * mode — begins downloading the recorded files needed to replay.
   * @param {Object} res - Schema-update result (`{err}`)
   */
  handleUpdateSchemaResult(res)
  {
    if (res.err) {
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
  }


  /**
   * Main message interception hook, called by {@link Node.AppSession} on every
   * `appmsg` it handles. Performs four orthogonal jobs:
   * 1. **Object map maintenance**: feeds every inbound content into
   *    {@link Node.TestAuto#addObjToMap} so `pid → oldId/newId` mappings stay
   *    current.
   * 2. **Control-message dispatch**: reacts to protocol-only ids
   *    (`initTestAuto`, `playTestAuto`, `stepForwardTestAuto`, `consoleTest`,
   *    `sendExceptionToTestAuto`, `getTaggingDataResults`, popup callbacks…)
   *    and strips them from the message array so they are not persisted as
   *    normal events.
   * 3. **Record-mode bucketing**: on client events, groups them into requests
   *    — closing the current request when the gap between the last output
   *    and the new input exceeds 200 ms — and records the actual delay
   *    (net of paused time).
   * 4. **Replay-mode pacing**: on server events, decrements `expectedResponses`
   *    and, once the expected reply stream for the current request has been
   *    received, triggers {@link Node.TestAuto#playRequest} for the next one.
   *
   * Record-mode also swallows messages arriving before `onStart` (e.g.
   * `onPause`/`onResume`) to keep the recording deterministic.
   * @param {Object[]} req - Array of content commands being sniffed (mutated in place)
   * @param {Boolean} cts - `true` for client → server messages, `false` for server → client
   */
  sniff(req, cts)
  {
    // If I receive an initTestAuto request in replay mode, I start the replay
    for (let i = 0; i < req.length; i++) {
      // Add an entry to objects map for each element found inside current request content
      if (req[i].cnt)
        this.addObjToMap(req[i].cnt);
      //
      let drop = false;
      switch (req[i].id) {
        case "initTestAuto":
          if (this.realInitTestAuto)
            break;
          //
          this.realInitTestAuto = true;
          this.startTime = Date.now();
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
          break;

        case "playTestAuto":
          // Remember a playTestAuto msg arrived
          if (req[i].content.play)
            this.play();
          else
            this.pause();
          return;

        case "consoleTest":
          // Compare console.test value with the saved ones
          if (this.mode !== Node.TestAuto.ModeMap.rec)
            this.saveConsoleTestResults(req[i].cnt);
          else // Save console.test value
            this.consoleTest.push(req[i].cnt);
          drop = true;
          break;

        case "stepForwardTestAuto":
          if (this.mode !== Node.TestAuto.ModeMap.rec)
            this.stepForward();
          drop = true;
          break;

        case "sendExceptionToTestAuto":
          this.saveException(req[i].cnt);
          drop = true;
          break;

        case "getTaggingDataResults":
          this.saveTagResults(req[i].cnt);
          drop = true;
          break;

        case "setTestAuto":
        case "calculateTagResults":
        case "setTaggingData":
        case "closePopup":
        case "onPause":
        case "onResume":
        case "getTestProperties":
        case "sendMessageToTestAuto":
          drop = true;
          break;

        case "alertCB":
        case "confirmCB":
        case "promptCB":
          this.session.sendMessageToClientApp({type: Node.TestAuto.msgTypeMap.appmsg, content: [{id: "closePopup"}]});
          break;

        // Save the last opened popup callback id. In record mode I saved a popupBoxReturn message having a certain cbId
        // as a parameter. But this cbId is a "record-time" value. So I save the current cbId in order to replace the cbId into
        // popupBoxReturn message when I'll go to send it
        case "popup":
        case "confirm":
        case "prompt":
          if (!this.lastPopupCbId)
            this.lastPopupCbId = req[i].cnt.cbId;
          break;

        // Cookies are in the client and server ask it for them. But in case of non reg or load test,
        // I have not a client. So save cookies in onStart request to simulate cookies request in those kind of tests
        case "onStart":
          this.onStartArrived = true;
          //
          if (this.mode === Node.TestAuto.ModeMap.rec) {
            req[i].cookies = req[i].cookies || this.session.cookies;
            this.playTime = Date.now();
          }
          break;
      }
      //
      // Drop the processed entry from req; bail out if it was the last one
      if (drop) {
        if (req.length === 1)
          return;
        //
        req.splice(i--, 1);
      }
    }
    //
    // In recording mode, don't save requests arriving before onStart (they could be onPause/onResume...)
    if (this.mode === Node.TestAuto.ModeMap.rec && !this.onStartArrived)
      return;
    //
    let currentTime = Date.now();
    //
    // Client event
    if (cts) {
      if (this.mode === Node.TestAuto.ModeMap.rec) {
        // Check if I received saveTestAuto request, because I don't want to save it
        for (let item of req) {
          if (item.id === "saveTestAuto") {
            this.needToSave = true;
            this.desc = item.content;
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
            if (req.length > 0) {
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
  }


  /**
   * Produces a compact version of a server response by keeping only `id` and
   * `obj` fields. Used to shrink the `outputMessages` buffer and the stored
   * recording on disk.
   * @param {Object[]} req - Server-originated content array to synthesize
   * @returns {Object[]} New array of `{id, obj}` entries, one per input item
   */
  synthesizeReq(req)
  {
    return req.map(r => ({id: r.id, obj: r.obj}));
  }


  /**
   * Records an exception raised by the app under test. Deduplicates the entry
   * by `msg + method` (method is extracted from the first `at` frame of the
   * stack trace if present) and increments its `occurr` counter. Always
   * targets the parent's `testResult` in load/non-reg modes; in step-by-step
   * mode the parent is the test itself.
   * @param {Object} ex - Exception payload (`{msg, stack?}`)
   */
  saveException(ex)
  {
    // Create exception object with initial occurrence counter
    let exception = {
      occurr: 1,
      msg: ex.msg
    };
    //
    // Extract method name from the first stack frame if available
    exception.method = ex.stack?.match(/^\s*at\s+(\S+)/m)?.[1];
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
  }


  /**
   * Persists the current recording to Google Cloud. Closes any dangling
   * pending request, caps every inter-request delay to 1000 ms (and forces
   * the last one to 1000 ms), serializes the full payload (`requests`,
   * `delays`, `description`, `duration`, `consoleTest`, `objectsMap`) and
   * uploads it via {@link Node.Archiver}. The console is notified with the
   * session duration and description on success, or with the error message
   * on failure. The test session is terminated afterwards.
   */
  async save()
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
      requests: this.requests,
      delays: this.delays,
      description: this.desc,
      duration: totDelays + 1000,
      consoleTest: this.consoleTest,
      objectsMap: this.objectsMap
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
  }


  /**
   * Returns the current execution mode.
   * @returns {String} One of the values in {@link Node.TestAuto.ModeMap}
   */
  getMode()
  {
    return this.mode;
  }


  /**
   * Plays the next recorded request, scheduling slow/kill watchdogs and the
   * auto-advance to the following one.
   *
   * Flow:
   * - Clears all pending timers and, when the recording is exhausted, marks
   *   the test as paused and either dispatches a final `endTest` summary
   *   (step-by-step) or notifies the parent (load / non-reg), then resets.
   * - Waits for the recorded delay, then replays every sub-request with
   *   the original relative timings, remapping object ids via
   *   {@link Node.TestAuto#getNewIdFromOldId} and rewriting the `cbId` of
   *   `popupBoxReturn` when needed.
   * - Computes `expectedResponses` from the recorded output length so
   *   {@link Node.TestAuto#sniff} can know when the request has been fully
   *   answered and chain into the next call.
   * - Arms the slow-session warning timer (default: 1× `nextDelay`) and the
   *   kill-session timer (forced at least 500 ms after slow), with
   *   `nextDelay` derived from the recorded request duration.
   * @param {Boolean} [stepForward] - `true` when the advance is driven by the user "step forward" command
   */
  playRequest(stepForward)
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
    let req = [];
    //
    // Get next delay
    let delay = !this.paused ? this.delays[this.reqIndex] : 0;
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
      for (let out of req.output)
        this.expectedResponses += out.content.length;
      //
      // this.expectedResponses changes every time a response come from server.
      // So I need another property to save total expected responses for each request in order to compare
      // its value with this.expectedResponses when killSessionTimeout fired
      this.outputLength = this.expectedResponses;
      //
      // A client request can be multiple (i.e. it can consists of more sub-request).
      // Process all them
      let reqDelay = 0;
      for (let i = 0; i < req.input.length; i++) {
        let timeout = req.input[i - 1] ? req.input[i].time - req.input[i - 1].time : 0;
        reqDelay += timeout;
        setTimeout(() => this.playInput(req.input[i]), reqDelay);
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
  }


  /**
   * Dispatches a single sub-request from a replay recording: rewrites object
   * ids and popup callbacks on the entry and forwards it to the app. In
   * step-by-step mode, processing a `saveTaggingData` command pauses the
   * test so the client can compare the recorded tag values with the current
   * ones. The caller is responsible for scheduling the invocation.
   * @param {Object} inputReq - Input sub-request entry (`{content, time}`)
   */
  playInput(inputReq)
  {
    for (let cmd of inputReq.content) {
      // If needed, convert remelems id to the new ones
      cmd.obj = this.getNewIdFromOldId(cmd.obj) || cmd.obj;
      //
      switch (cmd.id) {
        case "saveTaggingData": {
          // In step-by-step mode, when I'm processing saveTaggingData command
          // I send recorded taggingData to client, so it can compare values with
          // current elements' values and check if there are some differences
          if (this.mode === Node.TestAuto.ModeMap.stepByStep)
            this.paused = true;
          //
          // If needed, convert remelems id to the new ones
          let tagValues = cmd.content;
          if (tagValues) {
            for (let tag of tagValues) {
              // Skip popup elements
              if (tag.elId === "popup")
                continue;
              //
              let newId = this.getNewIdFromOldId(tag.elId);
              //
              // If current object has a new id, replace the old one
              tag.elId = newId || tag.elId;
              //
              // If I didn't find new id, it means I haven't got the object in the map
              if (!newId)
                tag.elNotFound = true;
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
          break;
        }

        case "popupBoxReturn":
          if (cmd.content && this.lastPopupCbId) {
            cmd.content.cbId = this.lastPopupCbId;
            delete this.lastPopupCbId;
          }
          break;
      }
    }
    //
    this.session.sendToChild({
      type: Node.TestAuto.msgTypeMap.appmsg,
      sid: this.session.id,
      content: inputReq.content,
      request: {}
    });
  }


  /**
   * Pauses the test and immediately triggers the next request with the
   * `stepForward` flag so the preview advances its timer.
   */
  stepForward()
  {
    this.pause();
    this.playRequest(true);
  }


  /**
   * Pauses the test. During a recording, the pause timestamp is snapped so
   * the elapsed paused time can be subtracted from future delays; during a
   * replay, all slow/kill/play timers are cleared and the `paused` flag is
   * raised so {@link Node.TestAuto#sniff} stops chaining requests.
   */
  pause()
  {
    if (!this.paused)
      this.recDuration += Date.now() - this.startTime;
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
      this.pauseTimeStamp = Date.now();
    //
    this.paused = true;
  }


  /**
   * Resumes the test. In replay modes calls {@link Node.TestAuto#playRequest}
   * to restart the request pump; in record mode accumulates the time spent
   * paused into `totPauseTime` so subsequent delay calculations stay accurate.
   */
  play()
  {
    this.startTime = Date.now();
    this.paused = false;
    if (this.mode !== Node.TestAuto.ModeMap.rec)
      this.playRequest();
    else {
      if (!this.reqClosed || this.totPauseTime === 0)
        this.totPauseTime += this.startTime - this.pauseTimeStamp;
      this.reqClosed = false;
    }
  }


  /**
   * Downloads every recording listed in `pathList` from Google Cloud via
   * {@link Node.Archiver} and stores them in `recFiles`. On the first failure
   * the test is terminated and the console is notified with HTTP 500;
   * otherwise {@link Node.TestAuto#prepareReplay} is invoked.
   */
  async getRecording()
  {
    let archiver = new Node.Archiver(this.app.server);
    for (let path of this.pathList) {
      try {
        // Read file from GCloud
        this.recFiles.push(await archiver.readObject(path));
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
  }


  /**
   * Prepares the replay branch selected by the current mode:
   * - **step-by-step**: loads the single recording into this TestAuto and
   *   notifies the client app with a `readyToStart` preview message.
   * - **non-regression**: spawns one child TestAuto for the single recording.
   * - **load**: ramps up children across 5 slots of `replayDuration / 5`
   *   each, with percentages 10 / 20 / 40 / 20 / 10 of `maxSessions`, so
   *   creation is denser in the middle and lighter on the edges.
   *
   * For load and non-reg modes also starts a 1-second sampler that pushes
   * CPU (sliding window over the last 10 samples), memory usage and active
   * session count into `testResult`, along with a rolling
   * `percentageCompleted` value.
   */
  prepareReplay()
  {
    this.watchdog();
    //
    // Set start test time
    this.startTime = Date.now();
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
        for (let recFile of this.recFiles)
          this.consoleTest.push(...recFile.consoleTest);
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
          for (let cpu of this.lastCPUValues)
            sum += cpu;
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
  }


  /**
   * Resets the test state so the instance can be reused. Clears every timer
   * and interval, wipes message buffers / results / delays / maps and
   * re-initialises a blank `testResult` shell. The `id` and `mode` to carry
   * over must be supplied in `options`.
   * @param {Object} options - Overrides for the next run
   * @param {String} options.id - Test id to restore
   * @param {String} options.mode - Execution mode to restore
   * @param {String|Number} [options.duration] - Optional replay duration (ms)
   * @param {String|Number} [options.maxSessions] - Optional max sessions
   */
  reset(options)
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
  }


  /**
   * Event handler called when the attached app client disconnects.
   * If a `saveTestAuto` had been requested, the recording is saved before
   * teardown; otherwise — in record or step-by-step mode — the console is
   * answered with HTTP 499 (client disconnected) and the test is terminated.
   * Non-reg / load modes ignore the disconnect since children drive the test.
   */
  onDisconnectClient()
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
  }


  /**
   * Spawns a child TestAuto running inside a brand-new session so it can
   * replay the given recording in parallel with the parent (load and
   * non-regression modes).
   *
   * When the app has reached its session cap, `createNewSession` returns
   * `undefined`: the parent records a `nonCreatedSessions` bump and
   * short-circuits through `onTerminateTest`. Otherwise a dummy HTTP
   * request/response is synthesized to build an app client without a
   * browser (the init watchdog is cleared for the same reason), the worker
   * child process is spawned if missing, and the child begins replaying
   * through {@link Node.TestAuto#playRequest}.
   * @param {Object} test - Recording payload (`{requests, delays, recDuration, consoleTest, objectsMap}`)
   */
  createChild(test)
  {
    let options = {
      id: this.id,
      mode: this.mode,
      duration: this.replayDuration,
      maxSessions: this.maxSessions
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
    childTestAuto.requests = structuredClone(test.requests || []);
    childTestAuto.delays = structuredClone(test.delays || []);
    childTestAuto.recDuration = test.recDuration;
    childTestAuto.consoleTest = structuredClone(test.consoleTest || []);
    childTestAuto.objectsMap = structuredClone(test.objectsMap || {});
    childTestAuto.startTime = Date.now();
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
  }


  /**
   * Called by a child when its replay is finished. Deletes the child's app
   * client and drops it from the `children` map, updates `percentageCompleted`
   * (load mode), aggregates the error counters (`exceptions + tagErrors +
   * consoleTestErrors + noResponseErrors`) into the parent's `totErrors`
   * rolling history, and — once every expected child has terminated — stops
   * the sampling interval, fills in the final duration and calls
   * {@link Node.TestAuto#saveResults}.
   * @param {String} [id] - Child id (`childTestAuto.childId`) that finished, or omitted when called internally due to a failed spawn
   */
  onTerminateTest(id)
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
    // Sum occurrences across each error bucket
    let sumOccurr = (s, e) => s + e.occurr;
    let totExceptions = this.testResult.exceptions.reduce(sumOccurr, 0);
    let totTagErrors = this.testResult.tagErrors.reduce(sumOccurr, 0);
    let totConsoleTestErrors = this.testResult.consoleTestErrors.reduce(sumOccurr, 0);
    let totNoResponseErrors = this.testResult.noResponseErrors.reduce(sumOccurr, 0);
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
      this.testResult.duration = Math.round((Date.now() - this.startTime) / 1000);
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
  }


  /**
   * Upserts `entry` into `arr`: if an entry with identical fields (ignoring
   * `occurr`) already exists, its `occurr` counter is incremented; otherwise
   * `entry` is pushed as a new record. Equality is tested via `JSON.stringify`
   * on both sides after zeroing `occurr`, so callers can pass a fresh entry
   * with any initial `occurr` value.
   * @param {Object[]} arr - Target bucket (e.g. `tagErrors`, `consoleTestErrors`)
   * @param {Object} entry - Candidate record
   */
  upsertError(arr, entry)
  {
    let key = JSON.stringify({...entry, occurr: 0});
    let match = arr.find(e => JSON.stringify({...e, occurr: 0}) === key);
    if (match)
      match.occurr++;
    else
      arr.push(entry);
  }


  /**
   * Collects tag (visual regression) comparison results and converts the
   * differing properties into `tagErrors` entries on the parent's `testResult`.
   * Entries are keyed by `{requestNumber, elId, propName, oldValue, newValue}`
   * and deduplicated by {@link Node.TestAuto#upsertError}.
   * @param {Object[]} res - Tag comparison results (`[{elId, props:[{propName, oldValue, newValue}], error, elNotFound, ...}]`)
   */
  saveTagResults(res)
  {
    // If not res, do nothing..
    if (!res)
      return;
    //
    // Save tag as parent result. In case of step-by-step the parent is myself
    let testAuto = this.parent || this;
    //
    // Save just tag with errors
    for (let r of res) {
      if (r.error && r.props) {
        for (let prop of r.props) {
          if ((prop.oldValue !== prop.newValue) || r.elNotFound) {
            let tagErr = {
              requestNumber: testAuto.reqIndex - 1,
              elId: r.elId,
              elName: r.elName,
              viewName: r.viewName,
              error: true,
              elNotFound: r.elNotFound,
              propName: prop.propName,
              oldValue: prop.oldValue,
              newValue: prop.newValue,
              occurr: 1
            };
            //
            testAuto.upsertError(testAuto.testResult.tagErrors, tagErr);
          }
        }
      }
    }
  }


  /**
   * Compares an incoming `console.test` value with the baseline captured at
   * recording time. If the same `{name, value}` is already in the baseline
   * the method returns silently; if the name exists with a different value
   * a `consoleTestErrors` entry is pushed onto the parent's `testResult`,
   * deduplicated by {@link Node.TestAuto#upsertError}.
   * @param {Object} consoleTest - Runtime console-test sample (`{name, value}`)
   */
  saveConsoleTestResults(consoleTest)
  {
    // If not consoleTest, do nothing..
    if (!consoleTest)
      return;
    //
    // Save consoleTestResults as parent result. In case of step-by-step the parent is myself
    let testAuto = this.parent || this;
    //
    // If the same {name, value} is already in the baseline, this is not an error
    if (this.consoleTest.some(ct => ct.name === consoleTest.name && ct.value === consoleTest.value))
      return;
    //
    // Otherwise look for a baseline entry with the same name but a different value
    let match = this.consoleTest.find(ct => ct.name === consoleTest.name && ct.value !== consoleTest.value);
    if (!match)
      return;
    //
    let obj = {
      name: consoleTest.name,
      oldValue: match.value,
      newValue: consoleTest.value,
      occurr: 1
    };
    //
    testAuto.upsertError(testAuto.testResult.consoleTestErrors, obj);
  }


  /**
   * Records a "no response" outcome for the currently playing request.
   * Extracts the first `(operation, object)` pair from the request input and
   * pushes an entry either into `slownessWarnings` (slow timeout fired but
   * kill did not) or `noResponseErrors` (kill timeout fired), deduplicating
   * by `requestNumber`. When a real error is saved the matching slowness
   * warning (if any) is decremented and removed if it drops to zero, so the
   * same request never counts both as a warning and as an error.
   * @param {Object} req - Request that was playing when the timer fired (`{input, output}`)
   * @param {Number} timeout - Timer value that fired (ms)
   * @param {Boolean} [slowness] - `true` when the slow timer fired, `false`/omitted when the kill timer fired
   */
  saveNoResponse(req, timeout, slowness)
  {
    let testAuto = this.parent || this;
    //
    // Extract object and operation from the first command of the first input sub-request
    let operation = req?.input?.[0]?.content?.[0]?.id;
    let object = req?.input?.[0]?.content?.[0]?.obj;
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
    for (let entry of arr) {
      if (entry.requestNumber === obj.requestNumber) {
        insert = false;
        entry.occurr++;
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
  }


  /**
   * Finalises the test by marking it 100 % completed, optionally flagging an
   * `overloadError`, returning the result to the console via
   * `consoleRequest.sendResponse(rid, 200, ...)` and tearing the test down.
   * @param {Object} res - Aggregated test result (normally `this.testResult`)
   * @param {Boolean} [overload] - `true` when termination was forced by the watchdog due to server overload
   */
  saveResults(res, overload)
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
  }


  /**
   * Tears the test down: asks the worker to delete every child's session and
   * the parent's session, stops the watchdog, runs {@link Node.TestAuto#reset}
   * to clear timers and buffers, and finally unregisters the test from
   * `app.testAuto[id]` so it becomes eligible for garbage collection.
   */
  terminate()
  {
    // Terminate children
    for (let child of Object.values(this.children))
      child.session?.worker?.deleteSession(child.session);
    //
    // Terminate session
    this.session?.worker.deleteSession(this.session);
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
  }


  /**
   * Finds the child TestAuto whose session id matches the given SID.
   * Used by {@link Node.AppSession#sniffTestMessage} to route events of a
   * worker session to the correct child.
   * @param {String} sid - Session id to look up
   * @returns {Node.TestAuto|undefined} The matching child, or `undefined` if none
   */
  getChildBySID(sid)
  {
    return Object.values(this.children).find(child => child.session?.id === sid);
  }


  /**
   * Recursively walks the given message content and maintains
   * `objectsMap[pid]` so the test can later translate recorded object ids
   * into the current run's ids.
   *
   * The value at each `pid` is an **array** because more than one object can
   * share the same `pid` (dataMap rows, cloned objects). In record mode a
   * new `{oldId}` entry is appended when unseen; in replay mode the first
   * slot still missing a `newId` is filled with the incoming id so the next
   * occurrence of the same logical object gets the fresh id.
   *
   * Recursion follows the `children`, `elements` and `child` collections.
   * @param {Object} obj - Content node to scan (`{pid, id, children?, elements?, child?}`)
   */
  addObjToMap(obj)
  {
    if (obj.pid) {
      // The objectsMap elements have to be arrays, because there are some objects having
      // the same pid (i.e. dataMap rows or cloned objects)
      this.objectsMap[obj.pid] = this.objectsMap[obj.pid] || [];
      //
      if (this.mode === Node.TestAuto.ModeMap.rec) {
        if (!this.objectsMap[obj.pid].some(e => e.oldId === obj.id))
          this.objectsMap[obj.pid].push({oldId: obj.id});
      }
      else {
        for (let entry of this.objectsMap[obj.pid]) {
          if (entry.newId === obj.id)
            break;
          else if (!entry.newId) {
            entry.newId = obj.id;
            break;
          }
        }
      }
    }
    //
    if (obj.children)
      for (let child of obj.children)
        this.addObjToMap(child);
    //
    if (obj.elements)
      for (let elem of obj.elements)
        this.addObjToMap(elem);
    //
    if (obj.child)
      this.addObjToMap(obj.child);
  }


  /**
   * Looks up the runtime id (`newId`) associated with a recorded id
   * (`oldId`) in {@link Node.TestAuto#objectsMap}.
   * @param {String} oldId - Object id from the recording
   * @returns {String|undefined} The corresponding runtime id, or `undefined` if the mapping is missing
   */
  getNewIdFromOldId(oldId)
  {
    for (let entries of Object.values(this.objectsMap)) {
      for (let entry of entries) {
        if (entry.oldId === oldId)
          return entry.newId;
      }
    }
  }


  /**
   * Returns the recorded duration of a request: the interval between the
   * timestamp of the first input item and that of the last output item
   * (falling back to the last input when the request had no output).
   * @param {Object} req - Request (`{input:[{time}], output:[{time}]}`)
   * @returns {Number} Duration in milliseconds, or `0` when `req` is missing or malformed
   */
  getReqDuration(req)
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
  }


  /**
   * Periodic sanity check on the event loop: schedules itself every 500 ms
   * and, if the actual wall-clock gap exceeds 1 s, considers the server
   * overloaded and short-circuits the test through
   * {@link Node.TestAuto#saveResults} with `overload: true`. Passing `stop`
   * cancels the pending timer (used by {@link Node.TestAuto#terminate}).
   * @param {Boolean} [stop] - `true` to cancel the watchdog
   */
  watchdog(stop)
  {
    if (stop) {
      clearTimeout(this.watchdogTimeout);
      return;
    }
    //
    let lastTimeStamp = Date.now();
    this.watchdogTimeout = setTimeout(() => {
      clearTimeout(this.watchdogTimeout);
      //
      let now = Date.now();
      //
      // The server is becoming too slow. Stop the test and send results to console
      if (now - lastTimeStamp > 1000)
        this.saveResults(this.testResult, true);
      else
        this.watchdog();
    }, 500);
  }
};


//export module for node
if (module)
  module.exports = Node.TestAuto;
