/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
var Node = Node || {};

// Import modules
Node.querystring = require("querystring");

// Import Classes
Node.Utils = require("../utils");


/**
 * @class Node.AppClient
 * @classdesc
 * Represents a client connection (browser tab, device view, invited slave) attached
 * to an Instant Developer {@link Node.AppSession}. A session can hold one MASTER
 * client plus any number of SLAVE clients invited through a `cTokens` list.
 * The AppClient owns the Socket.IO socket that ferries `appmsg` messages to/from
 * the client app.js, buffers outgoing messages so they can be re-synched on
 * reconnect, and handles the grace period around disconnect/reconnect.
 *
 * Key features:
 * - **MASTER/SLAVE role**: the first non-invited client becomes master; invited
 *   clients (their id is in `session.cTokens`) attach as slaves.
 * - **Reconnect-safe messaging**: `sendAppMessage` keeps a bounded `sentMsgs`
 *   buffer so messages can be replayed after a transient disconnect.
 * - **Grace periods**: an `init` timer (10 s) kills the client if it never
 *   calls openConnection; a disconnect timer (15 s) waits for refreshes before
 *   removing the client.
 *
 * @property {Node.AppSession} parent - Parent session
 * @property {String} id - Unique client id (CID) — pre-computed CID from the session or a fresh UID24
 * @property {Boolean} [startUnsecured] - `true` when the client was started with SID/CID in the query string
 * @property {Socket} [socket] - Active Socket.IO socket (set in openConnection, cleared on disconnect)
 * @property {Object[]} [sentMsgs] - Messages sent to the client whose receipt has not been acked yet (each stamped with `_seq`)
 * @property {Number} _nextSeq - Monotonic counter stamped as `_seq` on each sent message for reconnect replay
 * @property {Number} _trimmedUpTo - Highest `_seq` dropped by the `sentMsgs` cap, used to detect reconnect gaps
 * @property {Object} [killClient] - `setTimeout` handle used for init/disconnect grace periods
 */
Node.AppClient = class AppClient
{
  /**
   * Map of socket message types exchanged with the client app.
   * @enum {String}
   */
  static msgTypeMap = {
    /** Redirect the client to a given URL (e.g. exitUrl) */
    redirect: "redirect",
    /** Application-level message routed between child and client app.js */
    appmsg: "appmsg"
  };


  /**
   * @param {Node.AppSession} par - Parent application session
   */
  constructor(par)
  {
    this.parent = par;
    //
    // If the CID of the new client has been already computed, use it here (see Config::processRun)
    if (par.newCid) {
      this.id = par.newCid;
      delete par.newCid;
    }
    else
      this.id = Node.Utils.generateUID24();
    //
    // Monotonic per-client sequence: stamped as _seq on each sent message and used
    // to replay strictly-following messages on reconnect (see #13531)
    this._nextSeq = 0;
    //
    // Highest _seq dropped by the sentMsgs cap; lets a reconnect below it flag a real gap
    this._trimmedUpTo = 0;
  }


  /**
   * Gets the owning session (alias of `parent`).
   * @type {Node.AppSession}
   * @readonly
   */
  get session()
  {
    return this.parent;
  }


  /**
   * Gets the app this client belongs to.
   * @type {Node.App}
   * @readonly
   */
  get app()
  {
    return this.session.app;
  }


  /**
   * Gets the configuration shared through the session.
   * @type {Node.Config}
   * @readonly
   */
  get config()
  {
    return this.session.config;
  }


  /**
   * Gets the shared logger instance.
   * @type {Node.Logger}
   * @readonly
   */
  get logger()
  {
    return this.session.logger;
  }


  /**
   * Logs a message through the owning session, automatically attaching the
   * client id (`cid`) so every entry can be attributed back to this client.
   * @param {String} level - Message level (DEBUG, INFO, WARN, ERROR)
   * @param {String} message - Text of the message
   * @param {String} sender - Function that generated the message
   * @param {Object} [data] - Optional data payload to log
   */
  log(level, message, sender, data)
  {
    // Add "local" info
    data = {
      ...data,
      cid: this.id
    };
    //
    this.session.log(level, message, sender, data);
  }


  /**
   * Bootstraps the client by redirecting the browser to the app's main page
   * and arming a 10-second watchdog timer that will delete the client if no
   * `openConnection` arrives. Recognized query parameters:
   * - `testid`: associates the client with a test-auto run;
   * - `addsid`: makes the server include SID/CID in the redirect URL and marks
   *   the client as `startUnsecured`;
   * - `mode=offline`: accepted only when the app declares `allowOffline: true`,
   *   otherwise it is silently cleared and a warning is logged.
   * @param {Request} req - HTTP request (with `query` and optionally `testid`, `addsid`, `mode`)
   * @param {Response} res - HTTP response used to issue the redirect
   */
  init(req, res)
  {
    // Save test auto id
    if (req.query.testid)
      this.session.testAutoId = req.query.testid;
    //
    // If requested, send SID and CID via query string
    let qrys = "";
    if (req.query.addsid !== undefined) {
      qrys = `?${Node.querystring.stringify({sid: this.session.id, cid: this.id})}`;
      //
      // Remember that a new client has been started "unsecured"
      this.startUnsecured = true;
    }
    //
    // If there was a query string, add it
    let qryKeys = Object.assign({}, req.query);
    delete qryKeys.addsid;
    if (Object.keys(qryKeys).length)
      qrys += `${qrys ? "&" : "?"}${Node.querystring.stringify(qryKeys)}`;
    //
    // If the app has been started in OFFLINE mode and the app CAN'T be started in offline mode
    let mode = req.query.mode;
    if (mode === "offline" && (!this.app.params || !this.app.params.allowOffline)) {
      this.log("WARN", "Requested OFFLINE mode but the app does not allow it (apps' allowOffline parameter must be true for the app to work in offline mode)", "AppClient.init");
      mode = undefined;
    }
    //
    // Redirect to the main app page
    let appPage = this.app.params?.startPage || this.config.getAppMainFile(mode);
    res.redirect(`/${this.app.name}/${appPage}${qrys}`);
    //
    // Create a timer. If an openConnection does not arrive within 10 seconds,
    // the app client is deleted
    this.killClient = setTimeout(() => {
      this.log("DEBUG", "Client did not confirm its connection within 10 sec -> deleted", "AppClient.init");
      this.session.deleteAppClient(this, true);
    }, 10000);
  }


  /**
   * Binds the Socket.IO socket to this client and finalizes its role in the session.
   *
   * Role resolution:
   * - If this client's id is present in `session.cTokens`, the client was invited
   *   and becomes a SLAVE; the matching token is consumed. If the session has no
   *   master, the slave is redirected to `exitUrl`.
   * - Otherwise the SID is validated and, if acceptable, this client becomes the
   *   session MASTER. Conflicts (busy session, invalid SID) redirect to `exitUrl`.
   *
   * The method then wires two socket listeners:
   * - `appmsg`: forwards the event payload to the child process, keeping
   *   request/cookies alive through test-auto startup;
   * - `disconnect`: clears the socket, notifies the test-auto, drops master
   *   ownership when appropriate, and arms a 15-second reconnect grace (or
   *   deletes immediately when the app is updating).
   *
   * Finally, initializes any active test-auto and — on a reconnect — replays
   * messages from `sentMsgs` that the client had not yet acknowledged.
   * @param {Socket} socket - Socket.IO socket attached to the client
   * @param {Object} [lastMsg] - On reconnect, the last message the client confirmed to have handled
   */
  openConnection(socket, lastMsg)
  {
    if (!this.acceptRole(socket))
      return;
    //
    this.attachSocket(socket);
    //
    // Get test auto of this session and initialize it giving session, so that it can send recorded message to client in case of replay mode
    this.app.getTestById(this.session.testAutoId)?.init(this);
    //
    // If it's a reconnect, resynch with client
    if (lastMsg)
      this.replayUnsentMessages(socket, lastMsg);
  }


  /**
   * Resolves the role of the connecting client (SLAVE if invited via a cToken,
   * MASTER otherwise) and enforces the session invariants. On rejection:
   * - missing master for an invited slave / session already busy → redirect to `exitUrl`
   * - invalid SID (stale client cookies) → redirect to the app entry so the client
   *   discards stale sessionStorage/cookies and starts a fresh session, preserving
   *   application parameters from the socket handshake referer, excluding session identifiers
   *   and invitation tokens so that initial params like `lang` survive the restart.
   *   Mirrors {@link Node.Server#handleSessionASID} when the session is missing.
   * Returns `false` so the caller can abort the connection setup.
   * @param {Socket} socket - Socket.IO socket opened by the client
   * @returns {Boolean} `true` when the client has been accepted, `false` when redirected
   * @private
   */
  acceptRole(socket)
  {
    // If my ID is inside the cTokens array, my ID is a CTOKEN
    let ctoken = this.session.cTokens.includes(this.id) ? this.id : undefined;
    if (ctoken) { // I've been invited...
      // I've been invited: if this session has not a master -> that's not allowed
      if (!this.session.masterAppClient) {
        this.redirectToExit(socket, "Master, that invited me, is gone", {ctoken});
        return false;
      }
      //
      // "Eat" the token from the list of valid tokens
      let id = this.session.cTokens.indexOf(ctoken);
      this.session.cTokens.splice(id, 1);
      //
      this.log("DEBUG", "A new client is SLAVE for session", "AppClient.openConnection");
    }
    else { // I've not been invited
      // If the SID is invalid (stale client cookies, e.g. after a browser restart that
      // preserved sessionStorage on Edge/Safari) redirect to the app entry instead of
      // kicking the user to exitUrl: the client clears its storage and starts a fresh session.
      if (this.session.invalidSID(socket, this)) {
        this.log("WARN", "Invalid SID -> redirect to app entry for a fresh session", "AppClient.acceptRole", {sid: this.session.id});
        socket.emit(Node.AppClient.msgTypeMap.redirect,
                Node.Utils.getAppRestartUrl(this.app.name, socket.handshake?.headers?.referer));
        return false;
      }
      //
      // I've not been invited: if this session has already a master (and it's not me) -> that's not allowed
      if (this.session.masterAppClient && this.session.masterAppClient !== this) {
        this.redirectToExit(socket, "Session is busy");
        return false;
      }
      //
      // Now I'm the client master
      this.log("DEBUG", "A new client is MASTER for session", "AppClient.openConnection");
      this.session.masterAppClient = this;
    }
    //
    return true;
  }


  /**
   * Logs a WARN and redirects the socket to the session `exitUrl`. Used by
   * {@link Node.AppClient#acceptRole} to reject an incoming connection on
   * every failure path (missing master for an invited slave, invalid SID,
   * session already busy).
   * @param {Socket} socket - Socket.IO socket to reject
   * @param {String} reason - Human-readable reason, logged at WARN level
   * @param {Object} [logData] - Optional structured data attached to the log entry
   * @private
   */
  redirectToExit(socket, reason, logData)
  {
    let exitUrl = this.config.saveProperties().exitUrl;
    this.log("WARN", `${reason} -> redirect to ${exitUrl}`, "AppClient.redirectToExit", logData);
    socket.emit(Node.AppClient.msgTypeMap.redirect, exitUrl);
  }


  /**
   * Binds the active socket to this client: stores it on the instance,
   * cancels the init-timer watchdog set by {@link Node.AppClient#init}, and
   * wires the `appmsg` and `disconnect` listeners that drive the session.
   * @param {Socket} socket - Socket.IO socket already accepted by {@link Node.AppClient#acceptRole}
   * @private
   */
  attachSocket(socket)
  {
    this.socket = socket;
    //
    // Stop killClient timer (see AppClient::init)
    if (this.killClient) {
      clearTimeout(this.killClient);
      delete this.killClient;
    }
    //
    // Recovery timeout: how long the session survives a client disconnection before being
    // destroyed (see the "disconnect" handler below). Configurable via config, default 120s.
    // Send it to the client so it can align its own reconnect timer (issue #13951)
    let recoveryTimeout = this.config.recoveryTimeout ?? 120000;
    socket.emit("init", {recoveryTimeout});
    //
    // Listen for "appmsg" (sent by client app.js)
    socket.on("appmsg", (msg, callback) => {
      // Update query string
      if (msg.appurl && this.session.request) {
        let query = URL.parse(msg.appurl)?.search.slice(1);
        this.session.request.query = (query ? Node.querystring.parse(query) : {});
      }
      //
      // Route this message to the child
      this.session.sendToChild({
        type: Node.AppClient.msgTypeMap.appmsg,
        sid: msg.sid,
        cid: this.id,
        content: msg.events,
        master: this.session.masterAppClient === this,
        request: this.session.request,
        cookies: this.session.cookies
      });
      //
      // During a test auto some requests may arrive before onStart (for example onPause/onResume...).
      // So I don't have to delete request and cookies until onStart message arrives
      let testAuto = this.app.getTestById(this.session.testAutoId);
      if (testAuto && !testAuto.onStartArrived)
        return;
      //
      // Delete the content of the request after it has been sent
//    delete this.session.request;
      delete this.session.cookies;
      //
      if (callback) // Old apps does not provide the callback
        callback(); // Message received
    });
    //
    // Listen for disconnect
    socket.on("disconnect", reason => {
      // Log disconnection (reason drives the recovery grace below)
      this.log("DEBUG", `Received disconnect (${reason}) from ${this.session.masterAppClient === this ? "MASTER" : "SLAVE"} client socket`, "AppClient.openConnection");
      //
      // Socket is not connected anymore
      delete this.socket;
      //
      let testAuto = this.app.getTestById(this.session.testAutoId);
      testAuto?.onDisconnectClient();
      //
      // If the disconnected client was the session master, the session looses the master
      if (this.session.masterAppClient === this)
        delete this.session.masterAppClient;
      //
      // If the app is updating... die immediately (no wait for reconnect... I'm installing!!!)
      if (this.app.updating) {
        this.log("DEBUG", "App is updating -> delete session", "AppClient.openConnection");
        return this.session.deleteAppClient(this);
      }
      //
      // Ask my parent to delete me
      // Wait for the recovery timeout before actually deleting this session...
      // So that if the client has been disconnected and comes back I'm here waiting for him
      // The grace is overridable per-session: the OIDC redirect login bumps it while the user is at the
      // IdP (a cold login can exceed the recovery timeout) and restores it on return.
      //
      // Otherwise discriminate on the socket.io disconnect reason (#13951 follow-up). We release the
      // session quickly ONLY for a deliberate close explicitly signalled by the client: a tab close /
      // navigation / refresh triggers a client-side socket.disconnect() (see app.js pagehide handler),
      // which reaches us as "client namespace disconnect" (or "server namespace disconnect" when the
      // server forces it). 15s is enough for a refresh to reconnect and frees closed-tab sessions
      // promptly (#7357). Every other reason keeps the long, configurable recovery timeout: a genuine
      // network drop leaves the page open (no pagehide fires), so it surfaces as "transport close" /
      // "ping timeout" and the session must survive while the client reconnects (#13951). We cannot tell
      // a dropped "transport close" from a closed-tab one on the server alone — hence the client signal.
      // The per-session killClientGrace override (OIDC bump) still wins, being evaluated first.
      let refreshGrace = 15000;   // 15 sec for deliberate close / REFRESH handling
      let deliberateClose = reason === "client namespace disconnect" || reason === "server namespace disconnect";
      let killGrace = this.session.killClientGrace || (deliberateClose ? refreshGrace : recoveryTimeout);
      this.killClient = setTimeout(() => {
        this.log("DEBUG", `Client did not return within ${killGrace / 1000} sec -> deleted`, "AppClient.openConnection");
        this.session.deleteAppClient(this);
      }, killGrace);
    });
  }


  /**
   * Replays, on reconnect, the messages still buffered in `sentMsgs` that the
   * client has not yet received, identified by the monotonic `_seq` the client
   * echoes back inside `lastMsg`. Replays strictly the messages with `_seq`
   * greater than the reported one; a missing `_seq` or a reconnect below the
   * trim horizon is logged instead of silently collapsing to "replay all"
   * (see issue #13531).
   * @param {Socket} socket - Reconnected Socket.IO socket
   * @param {Object} lastMsg - Last message the client confirmed to have handled (carries `_seq`)
   * @private
   */
  replayUnsentMessages(socket, lastMsg)
  {
    if (!this.sentMsgs)
      return;
    //
    // The client reports the last message it received as an object carrying the _seq
    // we stamped: replay only the strictly-following buffered messages
    let lastSeq = lastMsg?._seq;
    //
    // No usable _seq (old client, or the first message was lost before being stamped):
    // don't collapse onto a blind "replay all" silently -> log it, then replay everything
    if (typeof lastSeq !== "number")
      this.log("WARN", "Reconnect without a valid _seq -> replaying the whole buffer", "AppClient.replayUnsentMessages", {lastMsg});
    //
    // The cap dropped messages the client never acked: a reconnect below the trim
    // horizon means a real, unrecoverable gap -> make it diagnosable
    else if (lastSeq < this._trimmedUpTo)
      this.log("WARN", `Reconnect gap: client at _seq ${lastSeq} but messages up to ${this._trimmedUpTo} were trimmed and lost`, "AppClient.replayUnsentMessages");
    //
    for (let msg of this.sentMsgs) {
      // Skip what the client already received (its _seq is <= the reported one)
      if (typeof lastSeq === "number" && msg._seq <= lastSeq)
        continue;
      //
      socket.emit("appmsg", msg, () => {
        let index = this.sentMsgs.indexOf(msg);
        if (index > -1) {
          this.sentMsgs.splice(index, 1);
          if (this.sentMsgs.length === 0)
            delete this.sentMsgs;
        }
      });
    }
  }


  /**
   * Sends an `appmsg` to the client counterpart, called by the owning session.
   * The message is also pushed onto the `sentMsgs` buffer so it can be replayed
   * if the socket drops before the client acks it; the ack removes the entry.
   * Note: the buffer is capped at 1000 entries (trimmed back to 500) to avoid
   * unbounded growth when ack callbacks never arrive. Logs a warning and does
   * nothing if the socket is currently absent.
   * @param {Object} msg - Message payload to deliver to the client
   */
  sendAppMessage(msg)
  {
    if (!this.socket)
      return this.log("WARN", "Can't send message to app client (no socket)", "AppClient.sendAppMessage", msg);
    //
    // Remember the messages that have been sent to client
    this.sentMsgs = this.sentMsgs || [];
    //
    // Cap the list to avoid unbounded growth if callbacks are never called
    if (this.sentMsgs.length > 1000) {
      let removeCount = this.sentMsgs.length - 500;
      //
      // Track the highest dropped _seq so a reconnect below it is flagged as a real gap
      this._trimmedUpTo = this.sentMsgs[removeCount - 1]._seq;
      this.sentMsgs.splice(0, removeCount);
    }
    //
    // msg is shared across clients (session.sendMessageToClientApp passes the same object
    // to every app client), so never mutate it: stamp _seq on a per-client shallow copy
    let out = {...msg, _seq: ++this._nextSeq};
    this.sentMsgs.push(out);
    //
    this.socket.emit("appmsg", out, () => {
      // Client received the message -> remove from the sent messages list
      let index = this.sentMsgs.indexOf(out);
      if (index > -1)
        this.sentMsgs.splice(index, 1);
    });
  }


  /**
   * Closes the client by disconnecting its Socket.IO socket, if still attached.
   */
  close()
  {
    this.socket?.disconnect();
  }
};


// Export module
module.exports = Node.AppClient;
