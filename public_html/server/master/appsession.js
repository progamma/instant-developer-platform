/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
var Node = Node || {};

// Import modules
Node.fs = require("fs");
Node.path = require("path");
Node.cookie = require("cookie");

// Import Classes
Node.Utils = require("../utils");
Node.AppClient = require("./appclient");
Node.Session = require("../session");


/**
 * @class Node.AppSession
 * @classdesc
 * Represents an Instant Developer application session running inside a
 * {@link Node.Worker}. A session groups one or more {@link Node.AppClient}s
 * (browser tabs, invited slaves, REST callers) that share the same child
 * process and communicates with it through the worker's IPC channel.
 *
 * Key features:
 * - **Lifecycle**: handles master/slave client deletion, triggers child-side
 *   session teardown, terminates orphan sessions, and schedules auto-death
 *   for "pure" REST sessions.
 * - **Test automation sniffing**: overrides the I/O path to feed recorded
 *   messages to the matching {@link Node.TestAuto} (if the session is being
 *   recorded/replayed).
 * - **DTT channel**: optional Device Test socket used by the IDE to preview
 *   live events; supports message caching until the socket is attached.
 * - **Secure SID**: on top of the base SID validation, accepts "unsecured"
 *   connections started via the `ADDSID` query parameter when there are no
 *   cookies at all.
 *
 * @extends Node.Session
 * @property {Node.Worker} parent - Parent worker
 * @property {Date} created - Creation timestamp
 * @property {String} [testAutoId] - Identifier of the test-auto run bound to this session (if any)
 * @property {Node.AppClient[]} appClients - Clients currently attached to the session
 * @property {Node.AppClient} [masterAppClient] - Master client of the session, if one has been elected
 * @property {Object} [killClient] - `setTimeout` handle for REST auto-kill
 * @property {Number} [sessionTimeout] - Override for the REST auto-kill timeout (ms)
 * @property {String} [sessionName] - Optional human-readable name set by the running app
 * @property {Socket} [syncSocket] - Socket used when this session is a sync session
 * @property {Socket} [dttSocket] - Active DTT socket, when DTT is enabled for this session
 * @property {Object[]} [dttCachedMessages] - DTT messages buffered before the DTT socket is attached
 */
Node.AppSession = class AppSession extends Node.Session
{
  /**
   * Map of IPC message types exchanged with the worker's child process.
   * @enum {String}
   */
  static msgTypeMap = {
    /** Application-level message routed between child and client app.js */
    appmsg: "appmsg",
    /** Tells the child process to tear down the app session identified by `sid` */
    deleteChildAppSession: "dcas"
  };


  /**
   * @param {Node.Worker} par - Parent worker that owns this session
   */
  constructor(par)
  {
    // Call base constructor
    super();
    //
    this.parent = par;
    this.created = new Date();
  }


  /**
   * Gets the owning worker (alias of `parent`).
   * @type {Node.Worker}
   * @readonly
   */
  get worker()
  {
    return this.parent;
  }


  /**
   * Gets the app this session belongs to.
   * @type {Node.App}
   * @readonly
   */
  get app()
  {
    return this.worker.app;
  }


  /**
   * Gets the configuration shared through the worker.
   * @type {Node.Config}
   * @readonly
   */
  get config()
  {
    return this.worker.config;
  }


  /**
   * Gets the server instance.
   * @type {Node.Server}
   * @readonly
   */
  get server()
  {
    return this.config.server;
  }


  /**
   * Gets the shared logger instance.
   * @type {Node.Logger}
   * @readonly
   */
  get logger()
  {
    return this.worker.logger;
  }


  /**
   * Returns the object used as target when logging messages from this session
   * (the owning app). Implements the abstract hook defined by {@link Node.Session}.
   * @returns {Node.App} The app that owns this session
   * @override
   */
  getLogTarget()
  {
    return this.app;
  }


  /**
   * Forwards an inbound/outbound message to the matching {@link Node.TestAuto}
   * so it can be recorded (record mode) or compared against the expected stream
   * (replay mode). When the test-auto has a child bound to this session id, the
   * child is used in place of the parent.
   * @param {Object} msg - Message being routed
   * @param {Boolean} fromClient - `true` if the message flows client → server, `false` if server → client
   * @private
   */
  sniffTestMessage(msg, fromClient)
  {
    let testAuto = this.app.getTestById(this.testAutoId);
    if (testAuto && msg.content) {
      let child = testAuto.getChildBySID(this.id);
      testAuto = child || testAuto;
      testAuto.sniff(msg.content, fromClient);
    }
  }


  /**
   * Sends a message to the worker's child process and feeds it to the
   * test-auto sniffer as a client-originated event.
   * @param {Object} msg - Message to send to the child
   */
  sendToChild(msg)
  {
    this.worker.sendToChild(msg);
    //
    // Sniff messages from client
    this.sniffTestMessage(msg, true);
  }


  /**
   * Returns the SID payload used when signalling a sync disconnect to the
   * server counterpart. Implements the abstract hook defined by
   * {@link Node.Session}.
   * @returns {Object} `{sidsrv}` identifying this session as the server side
   * @override
   */
  getSyncDisconnectSid()
  {
    return {
      sidsrv: this.id
    };
  }


  /**
   * Delegates to the base implementation to deliver a message to an online app,
   * then feeds the message to the test-auto sniffer as a server-originated event.
   * @param {Object} msg - Message to deliver to the client
   * @override
   */
  sendMessageToClientApp(msg)
  {
    super.sendMessageToClientApp(msg);
    //
    // Sniff messages to client
    this.sniffTestMessage(msg, false);
  }


  /**
   * Starts the app in REST mode: stores the request/response via the base
   * implementation, spawns the worker's child process if it wasn't started
   * yet, dispatches the initial `appmsg` carrying request and cookies, and
   * arms the REST auto-kill timer.
   * @param {Request} req - HTTP request that triggered the REST call
   * @param {Response} res - HTTP response used to return the reply
   * @override
   */
  startRest(req, res)
  {
    // Call base implementation to store req/res
    super.startRest(req, res);
    //
    // If I haven't done it yet create the physical process for the worker
    if (!this.worker.child)
      this.worker.createChild();
    //
    this.sendToChild({
      type: Node.AppSession.msgTypeMap.appmsg,
      sid: this.id,
      request: this.request,
      cookies: this.cookies
    });
    //
    // Schedule session death
    this.scheduleRESTDeath();
  }


  /**
   * Returns the class used to instantiate new app clients for this session.
   * Implements the abstract hook defined by {@link Node.Session}.
   * @returns {Function} The {@link Node.AppClient} constructor
   * @override
   */
  getAppClientClass()
  {
    return Node.AppClient;
  }


  /**
   * Removes an app client from the session.
   *
   * When the removed client was the master (or no master was set), the child
   * process is told to tear down the session, every remaining slave is closed,
   * and the worker is asked to delete the session. For a slave client, the
   * method just logs and leaves the session alive.
   *
   * If `neverAck` is truthy and the initial request carried uploaded files,
   * those files are removed from the `apps/<app>/files` folder — the app never
   * had a chance to consume them, and they should not linger on disk.
   * @param {Node.AppClient} appClient - Client to remove
   * @param {Boolean} [neverAck] - `true` if the client never completed its first round-trip (see {@link Node.AppClient#init})
   */
  deleteAppClient(appClient, neverAck)
  {
    // Delete the app client from the array
    let idx = this.appClients.indexOf(appClient);
    this.appClients.splice(idx, 1);
    //
    // If this session has no master client or the master client has been deleted -> ask the worker to delete the session
    if (!this.masterAppClient || this.masterAppClient === appClient) {
      this.log("DEBUG", "Terminated MASTER client from session", "AppSession.deleteAppClient", {cid: appClient.id});
      //
      this.sendToChild({
        type: Node.AppSession.msgTypeMap.deleteChildAppSession,
        sid: this.id
      });
      //
      // Disconnect all other clients (if any)
      this.log("DEBUG", "Terminate all remaining app clients for this session", "AppSession.deleteAppClient");
      //
      for (let i = 0; i < this.appClients.length; i++)
        this.appClients[i].close();
      //
      // Ask the worker to terminate this session
      this.worker.deleteSession(this);
    }
    else
      this.log("DEBUG", `Terminated SLAVE client ${idx} from session`, "AppSession.deleteAppClient");
    //
    // If the client never acknowleged and there are uploaded files -> delete them
    // (app never responded and I don't want those files to sit on my HD forever)
    if (neverAck && this.request.files) {
      this.request.files.forEach(f => {
        let fp = Node.path.join(this.config.appDirectory, "apps", this.app.name, "files", f.path);
        Node.fs.rm(fp, {force: true}, err => {
          if (err)
            this.log("WARN", `Can't delete file ${fp}: ${err}`, "AppSession.deleteAppClient");
        });
      });
    }
  }


  /**
   * Terminates the session. Cancels the REST auto-kill timer if any, then:
   * - if the session has no clients, disconnects the sync socket (when present)
   *   and asks the worker to delete the session;
   * - otherwise closes every attached client, which in turn will trigger the
   *   normal disconnect flow leading to deletion.
   */
  terminate()
  {
    // Stop REST autokill timer
    if (this.killClient) {
      this.log("DEBUG", "Stop REST auto-kill timer", "AppSession.terminate");
      clearTimeout(this.killClient);
    }
    //
    // If this session have no clients, terminate it
    if (!this.appClients.length) {
      if (this.syncSocket) {
        this.log("DEBUG", "Sync session -> disconnect socket", "AppSession.terminate");
        this.syncSocket.disconnect();
      }
      //
      this.log("DEBUG", "Session has no clients -> terminate", "AppSession.terminate");
      this.worker.deleteSession(this);
      return;
    }
    //
    // This session has clients -> close them
    this.log("DEBUG", "Terminate all app clients", "AppSession.terminate");
    //
    for (let i = 0; i < this.appClients.length; i++)
      this.appClients[i].close();
  }


  /**
   * Checks whether the incoming socket carries an invalid SID (i.e. the
   * `secureSID` cookie does not match the expected value). Adds an extra
   * allowance on top of the base implementation: if the client was started
   * "unsecured" via the `ADDSID` query parameter and the socket has no cookies
   * at all, the connection is accepted (used by clients that can't share cookies).
   * @param {Socket} socket - Incoming Socket.IO socket
   * @param {Node.AppClient} client - App client attempting to connect
   * @returns {Boolean} `true` if the SID is invalid and the socket must be rejected
   * @override
   */
  invalidSID(socket, client)
  {
    // If there are no cookies and this session was started "unsecured" (see appclient::init)
    if (!socket.request.headers.cookie && client.startUnsecured) {
      this.log("INFO", "Missing cookies with ADDSID -> 'unsecure' connection accepted", "AppSession.invalidSID");
      return false;
    }
    //
    return super.invalidSID(socket);
  }


  /**
   * Arms (or re-arms) the auto-kill timer for a "pure" REST session — one that
   * has no MASTER client and therefore would never be torn down by a client
   * disconnect. When the timer fires, a pending REST request (if any) is closed
   * with a timeout reply via {@link Node.Session#sendRESTTimeout} and the child
   * process is told to delete the session. If the session has a master client it
   * is not a pure REST session and the method is a no-op. Calling the method
   * again resets the timer so repeated REST calls extend the session's life.
   */
  scheduleRESTDeath()
  {
    // If this session has a valid MASTER client it means that this is not a "pure" REST
    // but it a "true" session that received a "REST" command (like an image upload for instance)
    // In this case do nothing... session will die when the client disconnects (see appclient::init)
    if (this.masterAppClient)
      return;
    //
    // This is a "pure" REST session -> prepare a timer that will automatically kill this session
    // If this REST session has been used more than once... procrastinate timer
    if (this.killClient)
      clearTimeout(this.killClient);
    //
    // Compute new timeout
    let sessTimeout = this.sessionTimeout || 60000;
    this.killClient = setTimeout(() => {
      this.log("DEBUG", `REST session did not send a reply within ${sessTimeout / 1000} sec -> deleted`, "AppSession.scheduleRESTDeath");
      //
      // Timer expired
      delete this.killClient;
      //
      // The session is about to be deleted: if the caller is still waiting for a reply nobody would
      // ever answer it -> close the request with an explicit timeout instead of leaving it hanging
      this.sendRESTTimeout(sessTimeout);
      //
      // Ask the worker to terminate this session
      this.sendToChild({type: Node.AppSession.msgTypeMap.deleteChildAppSession, sid: this.id});
    }, sessTimeout);
  }


  /**
   * Applies a session-parameter change requested by the running app.
   * Currently supports:
   * - `sessionTimeout`: updates the REST auto-kill timeout and re-arms the
   *   timer via {@link Node.AppSession#scheduleRESTDeath};
   * - `sessionName`: updates the human-readable session name.
   * @param {Object} params - Parameter bag (`{sessionTimeout?, sessionName?}`)
   */
  handleSessionParams(params)
  {
    this.log("DEBUG", "Session params changed for session", "AppSession.handleSessionParams", params);
    //
    // If param is session timeout
    if (params.sessionTimeout !== undefined) {
      // Change session timeout
      this.sessionTimeout = params.sessionTimeout;
      //
      // If this session is a "pure" REST session... I need to "re-schedule" my death
      this.scheduleRESTDeath();
    }
    else if (params.sessionName !== undefined)    // Session name
      this.sessionName = params.sessionName;
    else if (params.killClientGrace !== undefined)    // OIDC redirect login: extend/restore the post-disconnect kill grace (0 = back to default)
      this.killClientGrace = params.killClientGrace || undefined;
  }


  /**
   * Attaches a DTT (Developer Tracing Tool) socket to this session.
   * The method stores the socket, enables DTT on this session — which also
   * disables it on every other session of the same app — and flushes any
   * messages that were buffered in `dttCachedMessages` while waiting for the
   * socket. On socket disconnect the binding is cleared and DTT is globally
   * disabled for the app.
   * @param {Socket} socket - Socket opened by the IDE to receive DTT events
   * @param {Object} msg - Opening payload (carries `sid` used to enable DTT)
   */
  openDttConnection(socket, msg)
  {
    this.dttSocket = socket;
    //
    socket.on("disconnect", () => {
      this.log("DEBUG", "DTT socket disconnected", "AppSession.openDttConnection");
      //
      // Forget about the DTT socket
      delete this.dttSocket;
      //
      // Disable DTT for all sessions
      this.app.handleChangedAppParamMsg({par: "enableDtt"}, true);
    });
    //
    // Enable DTT for this session (and disable DTT for every other session)
    this.app.handleChangedAppParamMsg({par: "enableDtt", new: msg.sid}, true);
    //
    // If I already have cached one or more DTT messages it's the right time to send them (now that I've the socket)
    if (this.dttCachedMessages) {
      this.dttCachedMessages.forEach(m => {
        this.dttSocket.emit("dtt", m.content);
      });
      //
      delete this.dttCachedMessages;
    }
  }


  /**
   * Sends a DTT message to the attached IDE client. If the DTT socket is not
   * attached yet, the message is buffered in `dttCachedMessages` and flushed
   * later by {@link Node.AppSession#openDttConnection}.
   * @param {Object} msg - DTT message (`{content, ...}`)
   */
  sendDttMessage(msg)
  {
    // If there is a socket, use it
    if (this.dttSocket)
      return this.dttSocket.emit("dtt", msg.content);
    //
    // No socket... Cache messages... when socket will be available I'll send them
    this.log("WARN", "No socket connected -> DTT message cached", "AppSession.sendDttMessage");
    this.dttCachedMessages = this.dttCachedMessages || [];
    this.dttCachedMessages.push(msg);
  }


  /**
   * Returns the number of clients currently attached to this session
   * (i.e. the number of active app-client sockets).
   * @returns {Number} Client count
   */
  countClients()
  {
    return this.appClients.length;
  }
};


// Export module
module.exports = Node.AppSession;
