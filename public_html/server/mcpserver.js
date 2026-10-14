/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2025
 * All rights reserved
 */

var Node = Node || {};


/**
 * @class Node.McpServer
 * @classdesc
 * MCP Server for DevAgent remote control. Exposes the DevAgent as an MCP
 * server so external tools (Claude Code, etc.) can send messages and receive
 * responses via the Streamable HTTP transport.
 *
 * Architecture:
 * - Claude Code → POST /mcp → Express → McpServer → `sendToChild("mcp_chat")`
 * - Child process → `DevAgent.handleChat()` → accumulates response
 * - Child process → IPC `"mcp_response"` → McpServer → MCP response
 *
 * Tools (local/user level — full set):
 * - **get_status**: returns project name, user, devAgent status, and what is in flight
 *   (never guarded by the project locks — it is the probe for a step that looks stuck);
 *   with user+project or all:true it reports PER PROJECT (session, origin, lock, pendings)
 * - **send_message**: sends a message to the DevAgent, waits for complete response
 * - **stop_execution**: stops the turn in progress (presses the chat's Stop button; unguarded)
 * - **save_project**: saves the current project
 * - **close_project**: closes the project without saving (`force` aborts an in-flight step)
 * - **reset_project**: resets the project to the last commit (discards uncommitted changes)
 * - **start_prospect_session**: opens a project (default 'nuovo progetto') with onboarding flag on (test harness entry-point)
 * - **start_test / run_step / promote_to_gold / finalize_test**: gold-standard test session lifecycle
 * - **capture_ide_tab**: returns a PNG of the headless IDE tab (works even while a run_step is in flight)
 * - **run_tests**: runs the project's test scripts (M3) on the session that has it open, no DevAgent
 *   turn involved; opens the project read-only (and closes it after) when nobody has it open
 *
 * Concurrency model (docs/mcp-multiproject-concurrency-analysis.md, decisions 14-08):
 * admission lives in the MASTER (per-project fail-fast locks, `_projectLocks`), truth in the
 * CHILD (activeQueryId + the scalar MCP tag guard); one headless browser PER PROJECT; every
 * session carries an `origin` (console/test/human) and foreign sessions are refused by name.
 *
 * Tools (console level — Bearer = server AUTK, see _authenticate/_registerConsoleTools):
 * - **get_status**: per-project status of the open projects (unguarded)
 * - **stop_execution**: stops the turn in progress on a project (unguarded)
 * - **open_project**: opens a project in a headless IDE session (explicit user+project);
 *   refuses by name a project already open by another client
 * - **send_message**: sends a message to an open project's DevAgent (explicit user+project)
 * - **close_project**: saves (optional) and closes an open project session
 * - **run_tests**: runs the project's test scripts (explicit user+project, targets = apps and/or
 *   scripts); the project is opened read-only for the run when it is not open
 *
 * @property {Node.Server} server - The IDE server instance
 * @property {Object} _McpServer - McpServer class (lazy ESM import)
 * @property {Object} _StreamableHTTPServerTransport - Transport class (lazy ESM import)
 * @property {Object} pendingRequests - Map of pending DevAgent requests indexed by `mcpRequestId`
 * @property {Object} pendingTestRequests - Map of pending test requests indexed by `testRequestId`
 * @property {Object} _headless - Map of headless Puppeteer instances indexed by "user/project":
 *   one browser + one page PER PROJECT, so no project's tab shares its fate with another's
 * @property {Object} _projectLocks - Map of per-project admission locks indexed by "user/project"
 */
Node.McpServer = class McpServer
{
  /**
   * @param {Node.Server} server - The IDE server instance
   */
  constructor(server)
  {
    this.server = server;
    this._McpServer = null;         // McpServer class (lazy ESM import)
    this._StreamableHTTPServerTransport = null; // Transport class (lazy ESM import)
    this.pendingRequests = {};      // mcpRequestId → {resolve, reject, text, timeout, session, label}
    this.pendingTestRequests = {};  // testRequestId → {resolve, reject, timeout, session, label}
    this._headless = {};            // "user/project" → {browser, browserPromise, page} (one Chrome per project)
    this._projectLocks = {};        // "user/project" → {kind, since, label} — fail-fast admission (master side)
    this._consoleOpening = new Set(); // "user/project" keys with an open_project still in flight
    this._livenessTimer = null;     // Interval checking that pending requests still have someone able to answer
  }


  /**
   * Whether a run_step is in flight on any project. Kept as a DERIVED view over the
   * per-project locks so get_status and the test skills keep their contract, while the
   * truth lives in the map (one lock per project, not one boolean per process).
   * @type {Boolean}
   * @readonly
   */
  get _runStepInFlight()
  {
    return Object.values(this._projectLocks).some(lock => lock.kind === "run_step");
  }


  /**
   * Acquire the admission lock of a project. Fail-fast by design (decision 14-08): there is
   * no queue — whoever finds the project busy is told so at once, and the only way past a
   * turn in progress is stop_execution.
   * @param {String} key - "user/project"
   * @param {String} kind - What holds the project ("run_step", "send_message")
   * @returns {Boolean} true when acquired, false when the project is already held
   * @private
   */
  _acquireProjectLock(key, kind)
  {
    if (this._projectLocks[key])
      return false;
    //
    this._projectLocks[key] = {kind, since: Date.now(), label: key};
    return true;
  }


  /**
   * Release the admission lock of a project.
   * @param {String} key - "user/project"
   * @private
   */
  _releaseProjectLock(key)
  {
    delete this._projectLocks[key];
  }


  /**
   * The refusal a tool answers when its target project is locked, or null when it is free.
   * The run_step wording is the historical one the test skills already know.
   * @param {String} [key] - "user/project" of the target project (null → no lock to hit)
   * @returns {Object|null} MCP error result, or null when the project is free
   * @private
   */
  _projectBusyError(key)
  {
    let lock = key ? this._projectLocks[key] : null;
    if (!lock)
      return null;
    //
    let text;
    if (lock.kind === "run_step")
      text = "A run_step is currently in progress on this project. Wait for it to complete before calling other test tools.";
    else if (lock.kind === "run_tests")
      text = `A run_tests is already in progress on ${key} (started ${Math.round((Date.now() - lock.since) / 1000)}s ago). ` +
        "Wait for its report, or call stop_execution to abort it.";
    else
      text = `A DevAgent turn is already in progress on ${key} (started ${Math.round((Date.now() - lock.since) / 1000)}s ago). ` +
        "It will answer its own caller — resend this command when it completes, or call stop_execution to abort it.";
    return {isError: true, content: [{type: "text", text}]};
  }


  /**
   * Keeps the MCP transport alive across a call that lasts longer than the client is willing
   * to wait, and hands back the way to stop it.
   *
   * MCP clients — Claude Code included — enforce a per-tool-call timeout of about 60 seconds and
   * DROP THE TRANSPORT when nothing arrives, while the server keeps working: the turn completes,
   * the answer is composed, and there is no longer a channel to deliver it on. The caller gets
   * neither the answer nor an error saying what happened. A `notifications/progress` resets that
   * timeout on the client, so one every 20s is what buys the call the time it needs.
   *
   * It lives here, and not inline in a handler, because it was inline in ONE — `run_step`, the
   * automatic path, where the answer is re-read from the artifacts anyway — while the tools a
   * person waits on had none (#15440). A protection that has to be remembered at each call site
   * is a protection the next tool will not have.
   *
   * @param {Object} extra - The handler's second argument, as the MCP SDK passes it
   * @param {String} label - What the notification says is in progress
   * @returns {Function} Stop function; always callable, a no-op when no heartbeat was armed
   * @private
   */
  _startProgressHeartbeat(extra, label)
  {
    // No token means the client did not ask to be kept informed — there is nothing to send it to,
    // and arming a timer that notifies nobody would only leak. Same when the SDK gives us no way
    // to notify: both are the ordinary case for a client that does not implement progress.
    let progressToken = extra?._meta?.progressToken;
    if (progressToken === undefined || !extra?.sendNotification)
      return () => {};
    //
    let progress = 0;
    let timer = setInterval(() => {
      extra.sendNotification({
        method: "notifications/progress",
        params: {progressToken, progress: ++progress, message: `${label} in progress`}
      }).catch(() => {/* client may disconnect; don't crash the handler */});
    }, 20000);
    return () => clearInterval(timer);
  }


  /**
   * The "user/project" key of a project.
   * @param {String} userName - User name
   * @param {String} projectName - Project name
   * @returns {String} The key
   * @private
   */
  _projectKey(userName, projectName)
  {
    return `${userName}/${projectName}`;
  }


  /**
   * Whether a session belongs to someone else than the given MCP flow.
   * The session's `origin` field (set at creation from the /edit URL) is the mechanism;
   * for legacy sessions born before the field existed, the fallback is whether OUR
   * headless page is the one driving the tab — the only opener we can vouch for.
   * @param {Node.IDESession} session - The session to test
   * @param {String} expectedOrigin - The origin this flow stamps on its own sessions ("console"/"test")
   * @returns {Boolean} true when the session is not ours to drive
   * @private
   */
  _isForeignSession(session, expectedOrigin)
  {
    if (session?.origin)
      return session.origin !== expectedOrigin;
    //
    let page = this._headless[this._sessionLabel(session)]?.page;
    return !(page && !page.isClosed());
  }


  /**
   * The refusal to return when a tool would ACT on a session that is not ours, or null when it may
   * proceed. The doors (`open_project`, `start_test`) already checked ownership; the tools that
   * type into the chat, close the project or stop a turn did not, and they are the ones whose
   * effect lands under someone else's hands.
   * @param {Node.IDESession} session - The session the tool resolved
   * @param {String} expectedOrigin - The origin this flow stamps on its own sessions
   * @param {String} key - Label for the message ("user/project")
   * @param {String} action - What the tool was about to do, for the message
   * @returns {Object|null} An isError result, or null when the session is ours to drive
   * @private
   */
  _refuseIfForeign(session, expectedOrigin, key, action)
  {
    if (!this._isForeignSession(session, expectedOrigin))
      return null;
    return {content: [{type: "text",
      text: `Error: project ${key} is open by another client (origin: ${session?.origin || "unknown"}), ` +
        `so ${action} was not performed — it would have acted inside that person's session. ` +
        "Ask the owner to close it, or retry later."}], isError: true};
  }


  /**
   * The refusal to return when a tool would act inside a session owned by an account OTHER than
   * the one that authenticated the request, or null when the target is the caller's own.
   *
   * This answers a different question from `_refuseIfForeign`, and the origin does not cover it:
   * `_isForeignSession` compares `session.origin` against "test", and "test" is what EVERY
   * account's own test flow stamps on its sessions — it is `_openProject`'s default and the
   * start_test/run_step callers never override it. So a named project of another account, open by
   * that account's own test run, passes the origin check untouched. The target, meanwhile, is not
   * restricted to the caller: `_resolveLocalTarget` searches every online session and filters by
   * project name and, when given, by account name — neither is tied to who authenticated.
   *
   * NOT folded into `_refuseIfForeign`, and the reason is measured: that helper is also called by
   * four console-level tools (:1240 :1289 :1322 :1604), and at console level `_authenticate`
   * returns `{level: "console", session: null}` — the caller is the server, not an account, so
   * `_activeSession` is null and every one of those four would start refusing.
   *
   * Closed by default: a missing owner on either side is a refusal, not a pass. The comparison is
   * fail-closed by construction — `IDESession` dereferences `this.project.user` without optional
   * chaining in its constructor (`idesession.js:194`), so a session that reached `IDESessions`
   * always has an owner, while the caller's can go missing (the latch is nulled wherever the
   * session it points at goes away, and these handlers cross awaits after the request parked it).
   * @param {Node.IDESession} session - The session the tool resolved
   * @param {String} key - Label for the message ("user/project")
   * @param {String} action - What the tool did NOT do, for the message
   * @param {String} [detail] - What the call would have done inside that account, for the message
   * @returns {Object|null} An isError result, or null when the target belongs to the caller
   * @private
   */
  _refuseIfOtherAccount(session, key, action, detail)
  {
    return this._refuseIfOtherAccountName(session?.project?.user?.userName, key, action, detail);
  }


  /**
   * The same refusal, for a tool whose target is an account NAME instead of a resolved session.
   * The three testId-driven tools (`run_step`, `promote_to_gold`, `finalize_test`) never receive
   * a project: they read it from `_readTestStatus`, which scans EVERY account's home for
   * `<user>/<project>/test/<testId>/status.json` and hands back `status.user` — so the name they
   * act on is whichever account owns that testId, with nothing tying it to who authenticated.
   * Test ids are globally progressive (`_startTest` guarantees it), hence enumerable.
   *
   * Checking the name rather than the session is what makes this reachable at all on those tools:
   * their destructive branches run BEFORE any session is resolved — `run_step` with `reset` closes
   * the pre-existing session without saving and resets the project to its last commit, and with
   * `refresh` it force-closes the session and wipes `projected/` — so a check on the session it
   * ends up driving arrives after the damage. Called before `_acquireProjectLock`, it also refuses
   * without a lock to release.
   * The comparison itself is NOT here: it is `_callerOwns`, which every door of the family goes
   * through. What lives here is the refusal — the message, and the one knob a door is allowed to
   * turn on it. `detail` names the damage the call would have done inside that account, for the
   * doors whose damage is not "acting inside the project" (run_tests restores baselines over that
   * account's data); omitted, the sentence is the one the other nine doors share.
   * @param {String} userName - The account name the tool is about to act on
   * @param {String} key - Label for the message ("user/project")
   * @param {String} action - What the tool did NOT do, for the message
   * @param {String} [detail] - What the call would have done inside that account, for the message
   * @returns {Object|null} An isError result, or null when the target belongs to the caller
   * @private
   */
  _refuseIfOtherAccountName(userName, key, action, detail)
  {
    if (this._callerOwns(userName))
      return null;
    let owner = this._callerAccountName();
    return {content: [{type: "text",
      text: `Error: project ${key} belongs to another account ` +
        (owner ? `(this key authenticates ${owner})` : "(this key authenticates nobody)") +
        `, so ${action} — ${detail || "the call would have acted on that person's own project"}. ` +
        "Name a project of your own account."}], isError: true};
  }


  /**
   * Whether the account this request authenticates may act on `userName`'s projects.
   *
   * The comparison of the whole family is written HERE, once, and so is the condition that
   * governs it. Both used to be written at the door: eleven copies of `userName === owner` and
   * of the `!config.local` shell around it, one per tool, and two of the eleven were not calls
   * to the helper at all — run_tests had the comparison and the refusal object copied inline,
   * which is how a door joins this family without the census noticing.
   *
   * `config.local` belongs here rather than at each door: on a development machine there is one
   * person at the keyboard, the project is legitimately open in the browser under origin `human`,
   * and refusing by name would refuse the very call this tool set exists to serve. It is a
   * property of the SERVER, not of the door, so no door gets to decide it again.
   *
   * Closed by default: a missing owner is a NO, not a pass. `IDESession` dereferences
   * `this.project.user` without optional chaining in its constructor (`idesession.js:194`), so a
   * session that reached `IDESessions` always has an owner, while the caller's can go missing —
   * the latch is nulled wherever the session it points at goes away, and these handlers cross
   * awaits after the request parked it.
   * @param {String} userName - The account name the tool is about to act on
   * @returns {Boolean} true when the caller may act on that account's projects
   * @private
   */
  _callerOwns(userName)
  {
    if (this.server.config?.local)
      return true;
    let owner = this._callerAccountName();
    return !!owner && userName === owner;
  }


  /**
   * The refusal to return when a resolved session is not one this caller may drive — for the
   * five test-side doors that reach a session BY NAME (`send_message`, `close_project`,
   * `reset_project`, `stop_execution` and the open-project branch of `run_tests`).
   *
   * ACCOUNT first, origin second: they answer different questions and the origin does not cover
   * the first one. `_isForeignSession` compares `session.origin` against "test", and "test" is
   * what EVERY account's own test flow stamps on its sessions — it is `_openProject`'s default
   * and the start_test/run_step callers never override it. So a named project of another account,
   * open by that account's own test run, passes the origin check untouched.
   *
   * The order is the reason the two are joined here instead of being left side by side at each
   * door: written out five times, it was five chances to write them the other way round, and the
   * comment that explains it was copied verbatim five times with them.
   * @param {Node.IDESession} session - The session the tool resolved
   * @param {String} key - Label for the message ("user/project")
   * @param {String} action - What the tool did NOT do, for the message
   * @param {String} [detail] - What the call would have done inside that account, for the message
   * @returns {Object|null} An isError result, or null when the session is the caller's to drive
   * @private
   */
  _refuseIfNotOurs(session, key, action, detail)
  {
    if (this.server.config?.local)
      return null;
    let mine = this._refuseIfOtherAccount(session, key, action, detail);
    if (mine)
      return mine;
    return this._refuseIfForeign(session, "test", key, action);
  }


  /**
   * The account this request authenticates, when the access level has one — the yardstick the
   * READ doors of the local/user tool set measure against.
   * At level `user` `_authenticate` matches the token against ONE account's `mcpApiKey` and
   * returns that account's session, which `handleRequest` parks here: on the cloud the latch
   * names the caller. At level `local` it does not — there the latch falls back to `sessions[0]`,
   * whatever project a browser tab opened first — and at level `console` `handleRequest`
   * deliberately leaves it alone, so it still holds some earlier caller's session. Hence every
   * use of this sits behind `!config.local` and inside the local/user tool set: the one level
   * where the answer means something.
   * Undefined is a legitimate answer, not an accident: the latch is nulled wherever the session
   * it points at goes away. Callers must read it as "show nothing" — never as "no filter", which
   * is the whole list again.
   * @returns {String|undefined} The account name this key authenticates, or undefined
   * @private
   */
  _callerAccountName()
  {
    return this._activeSession?.project?.user?.userName;
  }


  /**
   * The account a tool acts on when the caller did not name one.
   *
   * On the cloud it is the account the key authenticates ({@link _callerAccountName}), and it has
   * to be: the gates of this family judge the very name these tools resolve, so a default naming
   * somebody else measures the caller against a stranger. `start_test({project})` — the natural
   * form, the one every skill writes — was refused as "belongs to another account" on the
   * caller's OWN project, quoting an account they never wrote; `capture_ide_tab({project})` went
   * looking for that person's tab and reported "no headless tab" while the caller's was alive.
   *
   * On a LOCAL server it is {@link Node.McpServer.LOCAL_ACCOUNT}, and the latch is deliberately
   * NOT consulted there — not even when it holds something. `_authenticate` fills it with
   * `sessions[0]` on that path, whatever project a browser tab opened first, which is why every
   * account gate in this file sits behind `!config.local`: the same value that is not trustworthy
   * enough to judge a caller is not trustworthy enough to name one. Reading it would also make
   * the default of `start_test` depend on which tab happens to be open, on a server where these
   * tools are called before any tab exists. What the name decides there is which project gets
   * opened, never who is allowed to open it.
   *
   * Undefined is a legitimate answer on the cloud and must stay one: a call with no caller to
   * name is refused by the gate below it, which is the direction to fail in.
   * @returns {String|undefined} The account name, or undefined when the cloud latch is empty
   * @private
   */
  _defaultAccountName()
  {
    return this.server.config?.local ? Node.McpServer.LOCAL_ACCOUNT : this._callerAccountName();
  }


  /**
   * Create a fresh McpServer instance with the tools for the given access level.
   * Called per-request because the SDK requires 1:1 McpServer↔Transport connection.
   * @param {String} level - Access level from _authenticate: "local"/"user" get the
   *   full tool set; "console" gets only the console management tools
   * @returns {Object} McpServer instance ready to connect
   * @private
   */
  _createMcpServer(level)
  {
    let {z} = require("zod");
    //
    let mcpServer = new this._McpServer({
      name: "InDe DevAgent",
      version: "1.0.0"
    });
    //
    // Console callers manage projects remotely on behalf of accounts: they get their
    // own minimal tool set (explicit user/project on every call, no test tools)
    if (level === "console") {
      this._registerConsoleTools(mcpServer, z);
      return mcpServer;
    }
    //
    // Per-project admission guard. A run_step (or a console-driven turn) holds its
    // project's lock for minutes — during that window any other mutating call on the SAME
    // project (or a duplicate run_step triggered by an MCP client timeout retry) would race
    // the active session, close the project mid-step, corrupt the test, or steal the answer.
    // The lock lives in the master because the master is the single-threaded admission
    // point: a check-and-set here is atomic within the tick. Other projects are other
    // locks — parallelism between projects is the design, not an accident.
    //
    // The rule for who gets the guard: every tool that MUTATES the session or its project —
    // sending a message, saving, closing, resetting — plus the test lifecycle. Read-only
    // tools stay out (get_status, capture_ide_tab): a probe that cannot do harm is exactly
    // what an operator needs while a step is stuck, and guarding it turns a stuck step into
    // a server that looks hung. Deliberate aborts have their own doors (`close_project`
    // with `force`, and `stop_execution`) instead of being refused (#15276).
    // The latch-keyed guard that used to live here (`activeKey`/`checkNotInFlight`) had exactly
    // two callers, `send_message` and `reset_project`, and both now key their guard on the
    // TARGET they resolved. A guard on the latch would have been the same defect as the tools
    // it guarded: it refuses on behalf of a project the caller may not have named.
    //
    // --- Tool: get_status ---
    mcpServer.tool("get_status",
      "Returns the current IDE status: open project, user, DevAgent state, and whether a run_step is in flight. "
      + "With `user`+`project` (or `all: true`) it answers PER PROJECT instead: for each open project its session, "
      + "origin (console/test/human), admission lock, pending requests, and whether a headless page drives it. "
      + "On a cloud server those two shapes report on the account this key authenticates, and on no other.",
      {
        user: z.string().optional().describe("With `project`: user owning the project to report on"),
        project: z.string().optional().describe("Report on this project only (requires `user` or defaults to the local user)"),
        all: z.boolean().optional().describe("Report on ALL open projects (on a cloud server: all of yours)")
      },
      async ({user, project, all}) => {
        // The no-argument call keeps the historical single-project shape — the test
        // skills read it and their contract does not change (decision 14-08, point D).
        // It reports the latch, which at this level IS the caller's own session: it
        // discloses nobody, so it stays outside the scoping below.
        if (!all && !project)
          return {content: [{type: "text", text: JSON.stringify(this._getStatus(), null, 2)}]};
        //
        // The two ENUMERATING shapes answer about the caller's account only. A key at level
        // `user` authenticates exactly one account, so `all` means "all of MINE": the inventory
        // of who else is online is the first step of the scenario the account gates on the
        // acting tools refuse — those tools are driven by `user`+`project` names, and this is
        // where the names came from. Scoped, not refused: the probe keeps answering, it just
        // stops answering about other people. `user`+`project` gets the same scope as `all`,
        // because a gate on one shape of a call leaves the shape that names the target open.
        // Behind `local` like every other account check in this file: on a development machine
        // every session is the operator's own and the latch names no caller.
        let scope;
        if (!this.server.config?.local) {
          scope = this._callerAccountName();
          // Fail closed: with nobody to compare against, an unscoped answer is the whole list
          // again — the one outcome this must never fall back to.
          if (!scope)
            return {content: [{type: "text", text: "Error: this key authenticates no open session, "
              + "so there is nothing to report on. Open a project and ask again."}], isError: true};
        }
        //
        let status = all ? this._getProjectsStatus(undefined, undefined, scope)
          : this._getProjectsStatus(user, project, scope);
        return {content: [{type: "text", text: JSON.stringify(status, null, 2)}]};
      }
    );
    //
    // --- Tool: stop_execution ---
    this._registerStopTool(mcpServer, z, false);
    //
    // --- Tool: run_tests ---
    this._registerRunTestsTool(mcpServer, z, false);
    //
    // --- Tool: send_message ---
    mcpServer.tool("send_message",
      "Sends a natural language message to the DevAgent. The message appears in the IDE chat. Returns the agent's "
      + "complete response. Without `project` it talks to the session the test tools latched onto — with more than "
      + "one project open that latch may belong to another caller, and an unnamed message starts an agent editing "
      + "a project you did not mean. Pass `project` (and `user`) to name one.",
      {
        message: z.string().describe("The message to send to the DevAgent"),
        user: z.string().optional().describe("With `project`: account owning the project to send to"),
        project: z.string().optional().describe("Send to this project's DevAgent instead of the latched session"),
        selection: z.string().optional().describe("IDE selection context (e.g. 'AppName > ViewName > $element')"),
        model: z.enum(["claude-fable-5-1[1m]", "claude-opus-5[1m]", "claude-opus-4-8[1m]", "claude-sonnet-5[1m]"]).optional()
            .describe("Override the AI model for this message only (does not change persistent settings)"),
        thinkingEffort: z.enum(["medium", "high", "xhigh", "max"]).optional()
            .describe("Override the thinking effort for this message only (xhigh and max are only valid for Opus 5, Opus 4.8, Fable 5.1 and Sonnet 5)"),
      },
      async ({message, user, project, selection, model, thinkingEffort}, extra) => {
        // Same resolver as save_project and close_project (#15429): what this tool starts is an
        // AGENT EDITING, so following the latch blind is the most expensive of the family to get
        // wrong. The resolver also turns the no-latch case into an answer that says what to do —
        // its own comment names this send as the caller that used to come back with "No browser
        // client connected", a socket symptom standing in for the cause.
        let target = this._resolveLocalTarget(user, project);
        if (target.error) return target.error;
        //
        // A NAMED send can now reach a project this flow never opened, and what it sends is a
        // turn that EDITS: the same rule close_project applies on its named path, and for the
        // higher stake the console variant of this tool already names — the message would be
        // typed into that person's chat. Un-named still reaches the latch alone, as it always
        // did, and save_project stays unguarded because persisting someone's work destroys
        // nothing. The `local` gate is inside the helper, where the whole family reads it.
        if (project) {
          let refusal = this._refuseIfNotOurs(target.session, target.label, "the message was not sent");
          if (refusal)
            return refusal;
        }
        //
        // The lock of the TARGET, not of the latched session: keyed on the latch, a run_step on
        // another project would refuse a message this caller asked for by name.
        // One turn per project: the lock is what makes the second caller FAIL FAST instead
        // of silently losing its message to a streaming composer (analysis §B). Acquiring IS
        // the check — it fails on exactly the condition _projectBusyError reports, and there is
        // no await in between for anything to change — so asking twice could only ever answer
        // the same thing.
        let key = target.label;
        if (!this._acquireProjectLock(key, "send_message"))
          return this._projectBusyError(key);
        // A DevAgent turn is minutes, not seconds: without this the client drops the transport
        // at ~60s and the answer, composed and complete, has nowhere to go (#15440).
        let stopHeartbeat = this._startProgressHeartbeat(extra, `send_message ${key}`);
        try {
          let result = await this._sendMessage(message, selection, {model, thinkingEffort}, target.session);
          return {content: [{type: "text", text: result.text}]};
        }
        catch (e) {
          return {content: [{type: "text", text: this._describeSendFailure(e)}], isError: true};
        }
        finally {
          stopHeartbeat();
          this._releaseProjectLock(key);
        }
      }
    );
    //
    // --- Tool: save_project ---
    mcpServer.tool("save_project",
      "Saves an open project, persisting the changes made by the DevAgent. Without arguments it saves the "
      + "session the test tools latched onto; pass `project` (and `user`) to save a named project instead. "
      + "The answer always says WHICH project it saved — read it: with more than one project open the latch "
      + "may belong to another caller, and an unnamed save follows the latch, not your intention.",
      {
        user: z.string().optional().describe("With `project`: account owning the project to save"),
        project: z.string().optional().describe("Save this project instead of the latched session")
      },
      async ({user, project}) => {
        let target = this._resolveLocalTarget(user, project);
        if (target.error) return target.error;
        //
        // The lock of the TARGET, not of the latched session: a step in flight on another
        // project must not refuse a save this caller asked for by name.
        let busy = this._projectBusyError(target.label);
        if (busy) return busy;
        try {
          this._saveProject(target.session);
          // Wait 1s for the IDE save to flush to disk. The save is IPC fire-and-forget
          // toward the browser (saveDocument runs server-side + client-side in parallel),
          // typical flush is ~100ms on small projects. Without this wait, a subsequent
          // close_project on a Refresh:true step can reopen pre-save state and silently
          // lose the most recent edits (observed in T0095 — Product.onValidate lost
          // between step 7 and step 8). 10x margin on the typical case covers p99.
          // TODO: replace the fixed 1s heuristic with an explicit save-done signal
          // (e.g. promise resolved by Document.saveDone, or lock-file timestamp poll)
          // so we don't pay 1s on small projects and don't risk under-waiting on huge ones.
          await new Promise(r => setTimeout(r, 1000));
          return {content: [{type: "text", text: `Project saved: ${target.label} (1s flush wait)`}]};
        }
        catch (e) {
          return {content: [{type: "text", text: `Error saving ${target.label}: ${e.message}`}], isError: true};
        }
      }
    );
    //
    // --- Tool: close_project ---
    mcpServer.tool("close_project",
      "Closes an open project without saving. Use this after testing to discard all changes made by the DevAgent. "
      + "Without arguments it closes the session the test tools latched onto; pass `project` (and `user`) to close "
      + "a named project instead. The answer always says WHICH project it closed.",
      {
        user: z.string().optional().describe("With `project`: account owning the project to close"),
        project: z.string().optional().describe("Close this project instead of the latched session"),
        force: z.boolean().optional().default(false)
            .describe("Close even while a run_step is in flight, aborting it. Without this the call is refused, "
              + "because closing the project mid-step corrupts the test. Use it to abandon a step deliberately: "
              + "the in-flight request is failed at once, so the step unwinds instead of waiting out its 30-minute "
              + "timeout — provided a request really was pending. The answer distinguishes three outcomes and is "
              + "the thing to read: it counts the requests it freed when there were any; it says the step is inside "
              + "an internal wait that force does NOT interrupt, and may reopen the project and carry on; or it says "
              + "there was nothing pending at all, i.e. no step to wait for. Only the first of the three carries a "
              + "number — the other two spell the zero out in words.")
      },
      async ({user, project, force}) => {
        let target = this._resolveLocalTarget(user, project);
        if (target.error) return target.error;
        //
        // A NAMED close can now reach a project this flow never opened, and closing discards
        // whatever is unsaved: refuse another client's session, the rule the console tools already
        // apply. Only on the named path — un-named still reaches the latch alone, as it always did,
        // and save_project stays unguarded because persisting someone's work does not destroy it.
        // The `local` gate is inside the helper, where the whole family reads it: on a development
        // machine the project is legitimately open in the browser under origin `human`, so without
        // it naming the project would refuse the very call this tool set is there to serve.
        if (project) {
          let refusal = this._refuseIfNotOurs(target.session, target.label, "the project was not closed");
          if (refusal)
            return refusal;
        }
        //
        let busy = force ? null : this._projectBusyError(target.label);
        if (busy) return busy;
        try {
          // Capture the session identity BEFORE sending the close — `project` is cleared
          // on the session while the deferred cleanup below still needs the pair
          let projName = target.session.project?.name;
          let userName = target.session.project?.user?.userName;
          //
          // A forced close makes the answer impossible: free the waiters here, naming the
          // cause. Leaving it to the liveness watch would work too, but an abort the operator
          // asked for should read as such in the error, not as a session that died (#15276)
          let note = "";
          if (force) {
            let closing = target.session;
            let failed = this._failPending(pending => pending.session &&
              (pending.session === closing || (closing?.id && pending.session.id === closing.id))
              ? "close_project(force) closed the project while its answer was still pending" : null);
            if (failed)
              console.warn(`[MCP] close_project(force): ${failed} pending request(s) failed`);
            // Whoever forces the close does it because a step LOOKS stuck, and the two outcomes
            // are not the same thing: the step unwinds now, or nothing was waiting on an answer
            // and it is sitting in one of the waits that live outside the pending maps (the
            // reset/refresh preamble, _waitForSessionEnd, _openProject), where only its own
            // timeout can end it. Saying so here is the only place the operator is still looking:
            // get_status counts the waiters, and after the close there is nothing left to count.
            if (failed)
              note = ` (${failed} pending request(s) failed)`;
            // The lock of THIS project, not the global flag: with per-project steps, another
            // project's run_step must not make this close read as "your step is waiting"
            else if (this._projectLocks[target.label]?.kind === "run_step")
              // No promise about WHEN it ends, because this code cannot keep one: two of those
              // waits — `_openProject` and the `_waitForSession` after it — are the steps that
              // REOPEN the project and re-latch `_activeSession`, and `force` cancels neither the
              // step nor the flag. If the step is sitting before one of them, the project the
              // operator just closed comes back up and the run carries on to `_sendMessage`, whose
              // pending has a 30-minute timeout. State the fact instead, which is knowable.
              note = " (no request was waiting for an answer: the step is inside an internal wait, " +
                "so force did NOT interrupt it — it may reopen the project and carry on)";
            else
              // Names the step too, and not only the pending request: without the second half this
              // note is character for character the PREFIX of the one above, so the operator would
              // separate the two cases by noticing that the colon and its clause do not arrive —
              // an inference by subtraction, which is what the answer exists to remove.
              //
              // It closes on "nothing to wait for", not on "nothing to abandon": the skill pairs
              // the second outcome with abandoning and this one with waiting, and an operator who
              // matches the phrase instead of reading the clause before it would take the other
              // case's instruction — which here is the wrong one.
              note = " (no request was waiting for an answer: no run_step was in flight, " +
                "so there is nothing to wait for)";
          }
          //
          // Awaited on purpose, where it used to be fire-and-forget: the answer below claims the
          // project is closed, and the only thing the emit proved was that a socket was there.
          // The wait costs nothing on a healthy session — it ends as soon as the session is torn
          // down — and the seconds it can cost are exactly the case in which the old answer lied.
          // Declared out here because the answer below reads it: inside the `if` it would be out
          // of scope at the return, and `outcome?.` does not save an undeclared name.
          let outcome = null;
          if (projName) {
            outcome = await this._closeAndConfirm(target.session, projName, userName);
            if (outcome.reopened)
              // Neither a failure nor a close: the project is up again under a session this
              // flow never closed. Saying "the browser ignored the close" here would be the
              // wrong diagnosis of a healthy case, with the wrong instruction attached.
              // States WHY, not WHAT: the first line of the answer now carries the outcome, so
              // repeating "the project is open again" here would say it twice in one sentence.
              note += " (the session registered on it now is NOT the one that was closed, so something " +
                "reopened it — the step above, most likely. The server-side eviction was skipped on " +
                "purpose: it resolves by name and would have killed that new session)";
            else if (!outcome.closed)
              // `note` travels into the error too. On the forced path it carries the count of
              // requests this close abandoned, and after the close there is nothing left to
              // count — dropping it here loses it at the exact moment the operator is deciding.
              return {content: [{type: "text",
                text: `Error: ${target.label} did not close.${note} The close command reached its browser but ` +
                  `nothing acted on it — the page is no longer running the IDE — and the server-side ` +
                  `eviction ${outcome.forced ? "ran but the session is still registered" : "found no session to evict"}. ` +
                  `The session stays registered, so opening the project from the IDE will be refused as busy. ` +
                  `Kill the headless browser of that project to clear it.`}], isError: true};
            else if (outcome.forced)
              note += " (the browser ignored the close: the session was evicted server-side)";
          }
          else
            this._closeProject(target.session);
          //
          // The first line has to state the outcome it actually got, not the one this branch used
          // to share with the success. On the `reopened` path `closed` is false on purpose — with a
          // live session on that project, "closed" would be the unverified claim this whole change
          // removes — but that value has no consumer here: the branch appends to `note` and falls
          // into the common exit, so the sentence said "closed" ten words before the clause saying
          // it is open. `finalize_test` already gets this right (its `reopened` warning opens with
          // the state instead of contradicting it); this is the same shape.
          //
          // `isError` stays false: nothing failed. The close was sent and acted on — what is on the
          // project now is a session this flow never closed, most often opened by the caller's own
          // step. Turning that into an error would make close_project report a failure that is not
          // its own, which is a decision about the tool's contract, not about this sentence.
          return {content: [{type: "text", text: outcome?.reopened
            ? `Close sent to ${target.label}, but the project is open again under a different session${note}`
            : `Project closed without saving: ${target.label}${note}`}]};
        }
        catch (e) {
          return {content: [{type: "text", text: `Error closing ${target.label}: ${e.message}`}], isError: true};
        }
      }
    );
    //
    // --- Tool: reset_project ---
    mcpServer.tool("reset_project",
      "Resets a project to the last commit, DISCARDING all uncommitted changes. Use this to restore a project to a "
      + "known state before running tests. Without `project` it resets the session the test tools latched onto — "
      + "with more than one project open that latch may belong to another caller, and what an unnamed reset throws "
      + "away is someone else's unsaved work. Pass `project` (and `user`) to name one. The answer says WHICH project "
      + "it reset: read it.",
      {
        user: z.string().optional().describe("With `project`: account owning the project to reset"),
        project: z.string().optional().describe("Reset this project instead of the latched session")
      },
      async ({user, project}) => {
        let target = this._resolveLocalTarget(user, project);
        if (target.error) return target.error;
        //
        // A NAMED reset can now reach a project this flow never opened, and resetting DISCARDS
        // every uncommitted change — more destructive than close_project, which at least leaves
        // the work on disk. Same rule and same gate as that named path.
        if (project) {
          let refusal = this._refuseIfNotOurs(target.session, target.label, "nothing was reset");
          if (refusal)
            return refusal;
        }
        //
        // The lock of the TARGET, for the same reason as save_project: a step in flight on
        // another project must not refuse a reset this caller asked for by name.
        let busy = this._projectBusyError(target.label);
        if (busy) return busy;
        try {
          this._resetProject(target.session);
          return {content: [{type: "text", text: `Project reset to last commit: ${target.label}`}]};
        }
        catch (e) {
          return {content: [{type: "text", text: `Error resetting ${target.label}: ${e.message}`}], isError: true};
        }
      }
    );
    //
    // --- Tool: start_prospect_session ---
    mcpServer.tool("start_prospect_session",
      "Opens a project for a simulated prospect (test harness) and activates onboarding mode on the DevAgent. Defaults to opening the empty 'nuovo progetto' template. Returns the project name, user, and prospectUuid. Use this as the first call of a prospect-test run; pair with `send_message` for the conversational turns and `close_project` at the end.",
      {
        project: z.string().optional().default("nuovo progetto").describe("Project name to open (default: 'nuovo progetto', the empty onboarding template)"),
        user: z.string().optional().describe("User name owning the project (default: the account this key authenticates)"),
        prospectUuid: z.string().optional().describe("Optional UUID to tag this prospect session (telemetry). If omitted, no UUID is set."),
        browser: z.enum(["headless", "chrome"]).optional()
            .describe("Browser driving the IDE tab: 'headless' (default \u2014 invisible Puppeteer Chrome) or "
              + "'chrome' (visible tab in Google Chrome). If omitted, the INDE_MCP_BROWSER env var applies.")
      },
      async ({project, user, prospectUuid, browser}, extra) => {
        user = user || this._defaultAccountName();
        // The THIRD door of the family, and the census had left it out: same two parameters as
        // `start_test`, same default on `user`, and nothing above it but the lock. What it does
        // with the name it is handed is not "open and stop there" — `_openProject` takes the
        // `/edit` road, so the other account's project opens for WRITING under a headless tab of
        // ours; `force_onboarding` then reaches whatever session `_waitForSession` finds for that
        // user/project, the tab that person opened by hand included, flipping their DevAgent into
        // onboarding while they work in it; and `_waitForSession` latches, which repoints
        // `_activeSession` — the very field every account gate reads as the caller's identity.
        // Before the lock, like `start_test`: an ownership refusal dressed as "project busy"
        // sends the caller back to retry in a minute.
        let mine = this._refuseIfOtherAccountName(user, this._projectKey(user, project), "no prospect session was started");
        if (mine)
          return mine;
        //
        let busy = this._projectBusyError(this._projectKey(user, project));
        if (busy) return busy;
        // Launches a browser and opens a project: minutes, not seconds — the same window in
        // which the client would drop the transport (#15440).
        let stopHeartbeat = this._startProgressHeartbeat(extra, `start_prospect_session ${project}`);
        try {
          // No eviction of the other open projects, for the reason written out in start_test:
          // what it protected was the latch, and nothing on this path reads the latch either —
          // the session driven below is the one `_waitForSession` returns, and `force_onboarding`
          // is addressed to that one. A prospect run and a test run can now share the server.
          //
          // Open the prospect target project and wait until the IDE session + devAgent
          // are ready. _waitForSession latches onto `_activeSession` for subsequent
          // tool calls (send_message, save_project, close_project).
          await this._openProject(user, project, browser);
          let session = await this._waitForSession(15000, project, user);
          // Browser-init grace period (DevAgentView registers IPC listeners only AFTER
          // the CLIENT_READY/SERVER_READY handshake, same as the reset path of run_step).
          await new Promise(r => setTimeout(r, 5000));
          //
          // Send the force_onboarding IPC. The child sets devAgent._isOnboarding = true
          // (transient, scoped to this session) and tags the prospectUuid if provided.
          if (!session || typeof session.sendToChild !== "function")
            throw new Error("Session opened but sendToChild not available");
          let uuid = prospectUuid || `prospect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          session.sendToChild({
            type: "force_onboarding",
            cnt: {onboarding: true, prospectUuid: uuid}
          });
          //
          let info = {
            project,
            user,
            prospectUuid: uuid,
            onboarding: true,
            message: "Prospect session ready: project open, onboarding flag active. Send messages with `send_message`, end with `close_project`."
          };
          return {content: [{type: "text", text: JSON.stringify(info, null, 2)}]};
        }
        catch (e) {
          return {content: [{type: "text", text: `Error: ${e.message}`}], isError: true};
        }
        finally {
          stopHeartbeat();
        }
      }
    );
    //
    // ═══════════════════════════════════════════════════════════════════
    // Gold Standard Test Tools
    // ═══════════════════════════════════════════════════════════════════
    //
    // --- Tool: start_test ---
    mcpServer.tool("start_test",
      "Starts a new gold-standard test session. Creates the test folder and returns the test ID.",
      {
        project: z.string().describe("Project name (e.g., 'nwind-test')"),
        user: z.string().optional().describe("User name (default: the account this key authenticates)"),
        model: z.string().trim().min(1).max(200).optional()
            .describe("Native model ID for all steps, e.g. gpt-5.6-sol or claude-opus-5[1m]. Selects its provider for this test only."),
        provider: z.enum(["codex", "anthropic", "vertex", "deepseek", "mimo", "openrouter"]).optional()
            .describe("Optional route override, e.g. vertex for Claude; otherwise inferred from model."),
        thinkingEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional()
            .describe("Thinking effort for all steps; validated against the selected model's supported levels."),
        browser: z.enum(["headless", "chrome"]).optional()
            .describe("Browser driving the IDE tab for ALL steps of this test: 'headless' (default — invisible "
              + "Puppeteer Chrome, doesn't touch the desktop) or 'chrome' (visible tab in Google Chrome, for visual "
              + "debugging; screenshots require user consent). If omitted, the INDE_MCP_BROWSER env var applies.")
      },
      async ({project, user, model, provider, thinkingEffort, browser}) => {
        user = user || this._defaultAccountName();
        // ACCOUNT gate, first of all and on the NAME: `user` is a parameter the CALLER chooses, and
        // `_startTest` wipes `<home>/<user>/<project>/inde-agent/projects` and `flightlog` before
        // anything else — the conversation transcripts, tool-results, memory and the whole flight
        // recorder of whoever owns that home. Nothing upstream looked at the account:
        // `_projectBusyError` reads the lock, and the only other precondition is that the target
        // have `test/prompts.md`, which is precisely the set of projects this family exists to
        // drive. Before the busy check so a refusal cannot be mistaken for a busy project.
        let mine = this._refuseIfOtherAccountName(user, this._projectKey(user, project), "no test was started");
        if (mine)
          return mine;
        //
        let key = this._projectKey(user, project);
        if (!this._acquireProjectLock(key, "start_test"))
          return this._projectBusyError(key);
        try {
          // Validate routing before resetting any live state or deleting test files.
          this._getTestModelOptions(project, user, model, provider);
          // NOTHING is evicted here. This used to close every OTHER project the user had open,
          // and the reason was the latch: run_step took whatever `_activeSession` pointed at, so
          // a second session online meant the step could land on the wrong child ("Step folder
          // not found: step-01", T0286). Decision F removed that dependency — run_step resolves
          // its project from status.json and hands the session explicitly to every command — and
          // with it the only thing the eviction bought. What it still COST was a turn: on 26-08
          // it closed step 4 of a CRM campaign mid-answer, 37 requests and $2.79, and the step
          // still reported green because what it measured was the compile, not the turn.
          //
          // Leaving the other projects open is what makes CONCURRENT tests possible, and every
          // piece each test needs is already keyed per project: one child, one browser page, one
          // admission lock, one status.json resolved by testId. A test closes ITS OWN project in
          // `finalize_test`, which resolves it the same way — so the cleanup this eviction used
          // to stand in for has an owner that cannot hit anybody else's run.
          let session = this._findSession(user, project);
          if (session) {
            let refusal = this._refuseIfNotOurs(session, key, "no test was started");
            if (refusal)
              return refusal;
            let prepared = await this._sendTestCommand("test_prepare_new", {}, session);
            if (prepared.error || !prepared.prepared)
              throw new Error(`Test preparation failed: ${prepared.error || "completion not confirmed"}`);
          }
          let result = this._startTest(project, user, model, thinkingEffort, browser, provider);
          return {content: [{type: "text", text: JSON.stringify(result, null, 2)}]};
        }
        catch (e) {
          return {content: [{type: "text", text: `Error: ${e.message}`}], isError: true};
        }
        finally {
          this._releaseProjectLock(key);
        }
      }
    );
    //
    // --- Tool: run_step ---
    mcpServer.tool("run_step",
      "Runs a complete test step: resets project (if needed), sends prompt to agent, waits for completion, saves snapshot, runs build test, computes diff vs gold. Returns all results.",
      {
        testId: z.string().describe("Test ID returned by start_test"),
        step: z.number().int().min(1).describe("Step number (1-based)"),
        reset: z.boolean().optional().default(false)
            .describe("Reset project to LAST COMMIT before starting, re-import every cloud package (not on IDF projects, so the base libraries are the shipped ones and not the commit's), then (step > 1 with gold) restore projected from gold step N-1 and reconcile it back in. Off by default: a run is cumulative, and the commit is usually far older than the step being run, so a reset silently throws away every step since — including model-only state the projected files cannot carry back, such as resources. Pass true for step 1, or when the starting state is unknown."),
        refresh: z.boolean().optional()
            .describe("Force close and reopen the project (fresh agent context, no reset). Useful when the project is not open or after a server restart. If omitted, the server reads the `**Refresh**: true` marker from prompts.md for this step — the prompts file declares which steps need a fresh context.")
      },
      async ({testId, step, reset, refresh}, extra) => {
        // Resolve the test's project FIRST: the lock is per project, and its key comes from
        // status.json — not from a latch that anyone may have rewritten in the meantime (T0286)
        let statusInfo = this._readTestStatus(testId);
        if (!statusInfo)
          return {content: [{type: "text", text: `Error: test ${testId} not found`}], isError: true};
        let projectName = statusInfo.project;
        let userName = statusInfo.user;
        let key = this._projectKey(userName, projectName);
        //
        // ACCOUNT gate on the NAME, here and not further down: `reset` closes the pre-existing
        // session without saving and resets the project to its last commit, `refresh` force-closes
        // it and wipes `projected/` — both before any session is resolved, and both on the account
        // `_readTestStatus` returned. A check on the session this step ends up driving would run
        // after those. Before `_acquireProjectLock`, so a refusal leaves no lock behind.
        let mine = this._refuseIfOtherAccountName(userName, key, "the step was not run");
        if (mine)
          return mine;
        //
        // Fail-fast admission: a duplicate run_step (MCP client timeout retry) or any other
        // turn on this project is refused at once. Other projects run in parallel.
        if (!this._acquireProjectLock(key, "run_step"))
          return this._projectBusyError(key);
        //
        // A run_step can take 10+ minutes (agent query + reconciliation + build validation).
        let stopHeartbeat = this._startProgressHeartbeat(extra, `run_step ${testId}/step-${step}`);
        let session = null;
        let attemptId = null;
        let stage = "prepare";
        try {
          // Browser mode chosen at start_test (persisted in status.json) — every open
          // of this test uses it, so a whole run is coherently headless or visible
          let browserMode = statusInfo.browser || null;
          // The session this step drives. Set by the reset/refresh reopen below, or resolved
          // by lookup when the project is already open. Every command of the step goes to
          // THIS session explicitly — there is no "current project" left to get wrong (F)
          //
          // Context refresh resolution: if the caller passed `refresh` explicitly (true
          // or false), that wins; otherwise consult the prompts.md marker for this step
          // (**Refresh**: true). This lets each test project declare its own refresh
          // policy per step, without hard-coding it in the skill or in the server.
          //
          // `reset` wins over `refresh`: a reset already performs open → close → reopen,
          // so any refresh is redundant. Skip the marker lookup entirely when reset is on —
          // but SAY SO (below): a step whose prompts.md declares `**Refresh**: true` and that
          // silently got a reset instead reads, in the result, as the refresh it asked for.
          let needsRefresh = refresh;
          if (needsRefresh === undefined && !reset) {
            try {
              let cfg = await this._sendTestCommand("test_get_prompt_config", {testId, step},
                this._findSession(userName, projectName));
              if (cfg?.error) {
                console.log(`[MCP] step ${step}: could not read refresh marker (${cfg.error}), defaulting to false`);
                needsRefresh = false;
              }
              else {
                needsRefresh = cfg?.refresh === true;
                if (needsRefresh)
                  console.log(`[MCP] step ${step}: refresh enabled via prompts.md marker`);
              }
            }
            catch (e) {
              console.log(`[MCP] step ${step}: could not read refresh marker (${e.message}), defaulting to false`);
              needsRefresh = false;
            }
          }
          else if (needsRefresh === undefined) {
            needsRefresh = false; // reset path — refresh is redundant
            if (reset)
              console.log(`[MCP] step ${step}: reset requested — the prompts.md refresh marker is not consulted`);
          }
          //
          // Phase 0: reset or refresh (open/close cycle with browser)
          if (reset) {
            // Reset: open → reset to commit → close → reopen
            let t0 = Date.now();
            //
            // If the project is already open (user had it in a browser tab, or a previous
            // test left it open), close the existing session first. Otherwise _openProject
            // would spawn a SECOND Chrome tab and a parallel IDE session for the same project,
            // leaving two concurrent sessions fighting over state.
            let existingSessions = this.server.getOnlineSessions() || [];
            let preExisting = existingSessions.find(s =>
              s.project?.name === projectName && s.project?.user?.userName === userName);
            // Authoritative close of someone ELSE's session is a developer-machine
            // convenience only: on an organization server it would close a programmer's
            // work without saving (decision A)
            if (preExisting && !this.server.config?.local && this._isForeignSession(preExisting, "test"))
              return {content: [{type: "text",
                text: `Error: project ${userName}/${projectName} is already open by another client ` +
                  `(origin: ${preExisting.origin || "unknown"}) — the step cannot evict it`}], isError: true};
            if (preExisting) {
              console.log(`[MCP] reset step ${step}: project ${projectName} already open, closing without saving first...`);
              let outcome = await this._closeAndConfirm(preExisting, projectName, userName);
              if (!outcome.closed)
                throw new Error("Project session did not close before reset");
            }
            //
            console.log(`[MCP] reset step ${step}: opening project...`);
            await this._openProject(userName, projectName, browserMode);
            session = await this._waitForSession(15000, projectName, userName);
            console.log(`[MCP] reset step ${step}: sending reset (+${Date.now() - t0}ms)...`);
            let resetResult = await this._sendTestCommand("test_reset_project", {}, session);
            if (resetResult.error || !resetResult.resetDone)
              throw new Error(`Project reset failed: ${resetResult.error || "completion not confirmed"}`);
            console.log(`[MCP] reset step ${step}: closing project (+${Date.now() - t0}ms)...`);
            //
            // Reloading the reset model can leave the browser unable to process the close.
            // Confirm server-side cleanup before opening a fresh session.
            let outcome = await this._closeAndConfirm(session, projectName, userName);
            if (!outcome.closed)
              throw new Error("Project session did not close after reset");
            console.log(`[MCP] reset step ${step}: reopening project (+${Date.now() - t0}ms)...`);
            await this._openProject(userName, projectName, browserMode);
            session = await this._waitForSession(15000, projectName, userName);
            await new Promise(r => setTimeout(r, 5000));
            console.log(`[MCP] reset step ${step}: ready (+${Date.now() - t0}ms)`);
          }
          else if (needsRefresh) {
            // Refresh: close (without saving) → reopen (fresh agent context, keep code)
            let t0 = Date.now();
            let closed = false;
            //
            // Attempt 1 — graceful, browser-driven close. This only works while the
            // master socket is alive: _waitForSession latches a session that still has
            // a live socket, then _closeProject emits mcp_close_project to the tab.
            try {
              let closing = await this._waitForSession(10000, projectName, userName);
              console.log(`[MCP] refresh step ${step}: closing without saving (+${Date.now() - t0}ms)...`);
              this._closeProject(closing);
              closed = await this._waitForSessionEnd(projectName, userName, 15000);
              console.log(`[MCP] refresh step ${step}: graceful close ${closed ? "completed" : "did NOT end the session"} (+${Date.now() - t0}ms)`);
            }
            catch (e) {
              console.log(`[MCP] refresh step ${step}: graceful close unavailable (${e.message})`);
            }
            //
            // Attempt 2 (fallback) — force-close by SESSION LOOKUP, not socket presence.
            // A refresh runs precisely when the master tab has degraded, so attempt 1
            // typically either (a) throws because the master socket is already gone
            // (_waitForSession times out), or (b) emits mcp_close_project into an
            // unresponsive tab that never tears the session down (_waitForSessionEnd
            // returns false). In BOTH cases the IDESession stays registered on the
            // master with masterClientSod set, so the plain /edit tab opened below is
            // rejected with `busySession` (idesession.js:490). Evict the lingering
            // session server-side so the reopened tab starts clean as the new master.
            if (!closed) {
              let forced = this._forceCloseLingeringSession(projectName, userName);
              if (forced) {
                console.log(`[MCP] refresh step ${step}: force-closed lingering session server-side (+${Date.now() - t0}ms)`);
                await this._waitForSessionEnd(projectName, userName, 15000);
              }
            }
            //
            // Refresh discards unsaved work and reopens from the saved model
            // (project.json + trans). The close above does NOT prune projected/,
            // so source files written by an aborted/unsaved attempt survive as
            // ORPHANS — files on disk with no backing model object (e.g. a document
            // class whose creation was rolled back). The next agent reads them and
            // assumes they exist ("already created — good"), but their contentType
            // never resolves at runtime (observed: nwind-shadow Shippers doc →
            // "OrderDetail.addDOFilter is not a function"). Wiping projected/ forces a
            // clean full re-projection from the model on the next chat message.
            let homeDir = this.server.config?.directory;
            if (homeDir) {
              let fs = require("fs");
              let path = require("path");
              let projectedDir = path.join(homeDir, userName, projectName, "projected");
              try {
                fs.rmSync(projectedDir, {
                  recursive: true,
                  force: true
                });
                console.log(`[MCP] refresh step ${step}: wiped projected/ to force clean re-projection (+${Date.now() - t0}ms)`);
              }
              catch (e) {
                console.warn(`[MCP] refresh step ${step}: could not wipe projected/ (${e.message})`);
              }
            }
            //
            console.log(`[MCP] refresh step ${step}: opening (+${Date.now() - t0}ms)...`);
            await this._openProject(userName, projectName, browserMode);
            session = await this._waitForSession(15000, projectName, userName);
            await new Promise(r => setTimeout(r, 5000));
            console.log(`[MCP] refresh step ${step}: ready (+${Date.now() - t0}ms)`);
          }
          //
          // Neither reset nor refresh reopened the project: it must already be online.
          // Resolved by LOOKUP, never by latch — the latch is whatever project some other
          // flow touched last, and a step that trusts it can land on the wrong child (T0286)
          if (!session) {
            session = this._findSession(userName, projectName);
            if (!session)
              return {content: [{type: "text",
                text: `Error: project ${userName}/${projectName} is not open — rerun with reset or refresh`}], isError: true};
            // The reset branch already checks this (:631); the lookup branch drives a session it
            // did not open, so it has to check too. Gated on `local` like the other test-side
            // checks: on a development machine the project is legitimately open in the browser.
            if (!this.server.config?.local) {
              // Only the ORIGIN here: the account was settled on the NAME before the lock, which
              // covers this branch and the two reopening ones alike. What is left to ask is whether
              // the session found belongs to another CLIENT of the same account.
              let foreign = this._refuseIfForeign(session, "test", `${userName}/${projectName}`, "the step was not run");
              if (foreign)
                return foreign;
            }
          }
          //
          // Phase 1: prepare the step (create folder, enable tracking, get prompt).
          // The parent's CURRENT devAgentOptions blob travels with the command: the child's
          // snapshot dates back to its spawn, so a settings change (e.g. provider switch)
          // made after that would otherwise be invisible until a full server restart
          let devAgentOptions = session.project?.user?.devAgentOptions || null;
          // With a reset the child also re-imports every cloud package before projecting
          // (TestHarness._handleTestStartStep): four archives fetched and copied into the model
          // do not fit the two minutes that a bare prepare needs
          attemptId = require("crypto").randomUUID();
          let prep = await this._sendTestCommand("test_start_step", {testId, step, reset, devAgentOptions, attemptId}, session,
            reset ? 600000 : 120000);
          if (prep.error)
            throw new Error(`Error preparing step: ${prep.error}`);
          //
          // Phase 2: send prompt to agent and wait for completion.
          // The reference-audit footer is appended only to the message sent to the agent —
          // result.prompt stays the original prompts.md text, comparable with the gold runs
          let overrides = {};
          if (prep.model)
            overrides.model = prep.model;
          if (prep.thinkingEffort)
            overrides.thinkingEffort = prep.thinkingEffort;
          //
          stage = "agent";
          let agentResult = await this._sendMessage(prep.prompt + Node.McpServer.REFERENCE_AUDIT_FOOTER, "none", overrides, session);
          //
          // Phase 3: end the step (save snapshot, build test, diff)
          stage = "end-step";
          let result = await this._sendTestCommand("test_end_step", {testId, step, attemptId}, session);
          if (result.error && !result.partialAttemptPath)
            Object.assign(result, await this._captureIncompleteTestStep(session, testId, step, attemptId, result.error, stage));
          // The caller decides from this field whether the step produced work or only a plan
          // (`/test-auto` § "solo piano, nessun file modificato"), and the reference-audit
          // section the footer asks for is the LAST thing in the answer. At 500 characters
          // both were routinely cut: two recorded steps whose answer was complete on disk
          // (4759 and 3214 bytes) came through as abandoned. The cap is a context guard, not
          // a storage one — `agent-response.txt` in the step folder is always the whole text.
          result.agentResponse = agentResult.text?.substring(0, Node.McpServer.AGENT_RESPONSE_CAP)
            + (agentResult.text?.length > Node.McpServer.AGENT_RESPONSE_CAP ? "..." : "");
          result.prompt = prep.prompt;
          result.resetDone = prep.resetDone || false;
          result.packagesUpdate = prep.packagesUpdate || null;
          result.refreshDone = needsRefresh;
          //
          // End-of-turn IDE tab snapshot (headless only): save the tab as PNG into the
          // step folder so the test artifacts show the IDE state when the turn ended.
          // After test_end_step, so the child's snapshot phase can't overwrite the folder
          result.ideTabScreenshot = await this._saveIdeTabScreenshot(testId, step);
          //
          return {content: [{type: "text", text: JSON.stringify(result, null, 2)}], isError: !!result.error};
        }
        catch (e) {
          // Best-effort snapshot on failures too — seeing the IDE at the moment the
          // step died (error popup, blank editor, stuck dialog) is prime diagnostics
          let partial = await this._captureIncompleteTestStep(session, testId, step, attemptId, e.message, stage);
          await this._saveIdeTabScreenshot(testId, step);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({error: e.message, ...partial})
            }],
            isError: true
          };
        }
        finally {
          stopHeartbeat();
          this._releaseProjectLock(key);
        }
      }
    );
    //
    // --- Tool: promote_to_gold ---
    mcpServer.tool("promote_to_gold",
      "Promotes a test step's results as the new gold standard.",
      {
        testId: z.string().describe("Test ID"),
        step: z.number().int().min(1).describe("Step number to promote")
      },
      async ({testId, step}) => {
        // The command goes to the CHILD OF THE TEST'S PROJECT, resolved from the testId —
        // not to whatever project happens to be open (that routing promoted the wrong
        // project's snapshot when another project was active)
        let statusInfo = this._readTestStatus(testId);
        if (!statusInfo)
          return {content: [{type: "text", text: `Error: test ${testId} not found`}], isError: true};
        let userName = statusInfo.user;
        // Same testId-driven resolution as run_step, same gate: the command below goes to the
        // child of whatever account owns that testId
        let mine = this._refuseIfOtherAccountName(userName, this._projectKey(userName, statusInfo.project),
          "nothing was promoted");
        if (mine)
          return mine;
        let busy = this._projectBusyError(this._projectKey(userName, statusInfo.project));
        if (busy) return busy;
        try {
          let session = this._findSession(userName, statusInfo.project);
          if (!session)
            return {content: [{type: "text",
              text: `Error: project ${userName}/${statusInfo.project} is not open — open it before promoting`}], isError: true};
          let result = await this._sendTestCommand("test_promote_gold", {testId, step}, session);
          return {content: [{type: "text", text: JSON.stringify(result, null, 2)}]};
        }
        catch (e) {
          return {content: [{type: "text", text: `Error: ${e.message}`}], isError: true};
        }
      }
    );
    //
    // --- Tool: finalize_test ---
    mcpServer.tool("finalize_test",
      "Finalizes the test identified by testId, updates test-log.md, and closes only that test project if it is still open. Other open projects are not closed. Works when the test project is already closed.",
      {
        testId: z.string().describe("Test ID"),
        notes: z.string().optional().describe("Optional notes for the test log entry")
      },
      async ({testId, notes}) => {
        let finalStatus = this._readTestStatus(testId);
        // Same gate as the other two testId-driven tools: this one CLOSES the resolved project
        if (finalStatus) {
          let owner = finalStatus.user;
          let mine = this._refuseIfOtherAccountName(owner, this._projectKey(owner, finalStatus.project),
            "the test was not finalized");
          if (mine)
            return mine;
        }
        let busy = finalStatus
          ? this._projectBusyError(this._projectKey(finalStatus.user, finalStatus.project)) : null;
        if (busy) return busy;
        try {
          // Resolve the test's project/user via filesystem scan (testPath stored in
          // status.json's parent dir). This is independent of the currently-open IDE
          // session — finalize_test must work even if the IDE is on a different
          // project, or no project at all (multi-project test workflows).
          let result = this._finalizeTest(testId, notes);
          let closeWarning = "";
          let closedSession = null;
          //
          // Close THE TEST'S project (resolved by lookup, not the latch) so the next test
          // starts clean and no leftover session lingers with unsaved test-run state.
          try {
            let userName = finalStatus?.user;
            let session = finalStatus ? this._findSession(userName, finalStatus.project) : null;
            closedSession = session;
            let socket = session?.sockets?.[session?.masterClientSod];
            if (session && socket) {
              // The outcome used to go to the log only, so a test could be finalized while its
              // project stayed registered and unopenable (#15763).
              let outcome = await this._closeAndConfirm(session, finalStatus.project, userName);
              console.log(`[MCP] finalize_test: close of ${finalStatus.project} after ` +
                `T${testId.replace(/^T/, "")} — closed=${outcome.closed}, forced=${outcome.forced}`);
              if (outcome.reopened)
                // Not reachable through this tool today — _projectBusyError above refuses while a
                // run_step holds the lock, and nothing else reopens a project mid-finalize. It is
                // here because the branch below would otherwise state the opposite of the truth:
                // that project is open and usable, not stuck behind a leftover session.
                closeWarning = `\n\n⚠️ The test is finalized, but ${userName}/${finalStatus.project} is open ` +
                  `again under a session other than the one the test used — nothing was evicted. Whatever ` +
                  `reopened it is still running.`;
              else if (!outcome.closed)
                closeWarning = `\n\n⚠️ The test is finalized, but ${userName}/${finalStatus.project} did NOT close: ` +
                  `its session is still registered, so opening that project from the IDE will be refused as busy. ` +
                  `Kill the headless browser of that project to clear it.`;
            }
          }
          catch (closeErr) {
            console.log(`[MCP] finalize_test: close project failed (${closeErr.message}), continuing`);
          }
          //
          // Drop the cached session reference, but ONLY when it points at the session this test
          // just closed — the rule _waitForSessionEnd and the force-close already apply, and this
          // line used to disfare it. It could not matter while the ports evicted: there was one
          // session, so the latch could only ever be one's own. With two tests running, finalizing
          // A cleared a latch that belonged to B, and the next request fell back to `sessions[0]`
          // (_authenticate) — the project that opened a tab first, which need be neither. From
          // there every un-named call of B worked on the wrong project in silence, reset_project
          // included. Next auth will pick a fresh one (or return the no-session stub); run_step
          // opens the target project explicitly either way.
          if (this._activeSession === closedSession)
            this._activeSession = null;
          //
          // Appended to the summary, not logged: whoever reads a finalize_test answer is deciding
          // what to do next, and "the project you just tested is unopenable" belongs there.
          return {content: [{type: "text", text: JSON.stringify(result, null, 2) + closeWarning}]};
        }
        catch (e) {
          return {content: [{type: "text", text: `Error: ${e.message}`}], isError: true};
        }
      }
    );
    //
    // --- Tool: capture_ide_tab ---
    // Deliberately NOT guarded by an in-flight check: page.screenshot() is a pure read
    // of the headless tab (no session state is touched), so this tool is safe — and
    // useful — to monitor what the IDE is doing while a run_step is in progress.
    mcpServer.tool("capture_ide_tab",
      "Captures a PNG screenshot of the IDE browser tab driven by the headless test browser and returns it as an image. "
      + "Safe to call while a run_step is in progress — use it to monitor what the IDE is doing during long steps. "
      + "Fails when the IDE tab is not headless-driven (e.g. the project is open in the user's desktop Chrome).",
      {
        project: z.string().optional().describe("Project name (defaults to the active session's project, or the only open headless tab)"),
        user: z.string().optional().describe("User name owning the project (default: the account this key authenticates)")
      },
      async ({project, user}) => {
        try {
          // The gate goes on the RESOLVED key, not on the `user` parameter, and that is the whole
          // point: with no project named the resolver falls back to the single live tab — whoever
          // owns it — so a check on `user` would wave that branch straight through, whatever the
          // parameter defaults to. What this tool hands back is not a list of names like the two
          // doors #15848 closed: it is the SCREEN of the tab, so the model, the code and the data
          // on it travel with it (#15858).
          // The default is resolved ONCE, into `user`, the way the two other tools of #15862 do
          // it: the key the gate judges and the page the tool returns must be resolved from the
          // same name, and two separate `|| this._defaultAccountName()` would be two chances for
          // them to name different accounts.
          user = user || this._defaultAccountName();
          let key = this._resolveHeadlessKey(user, project);
          if (key && !this.server.config?.local) {
            let mine = this._refuseIfOtherAccountName(key.slice(0, key.indexOf("/")), key,
              "no screenshot was taken");
            if (mine)
              return mine;
          }
          let page = this._resolveHeadlessPage(user, project);
          if (!page) {
            return {content: [{type: "text",
              text: "No headless IDE tab available. The project must be opened by the MCP harness "
                + "(run_step / start_test / start_prospect_session) with the headless browser active."}], isError: true};
          }
          //
          let buf = await page.screenshot({type: "png"});
          return {content: [{
            type: "image",
            data: Buffer.from(buf).toString("base64"),
            mimeType: "image/png"
          }]};
        }
        catch (e) {
          return {content: [{type: "text", text: `Error: ${e.message}`}], isError: true};
        }
      }
    );
    //
    return mcpServer;
  }


  /**
   * Register the console-facing tool set: remote project management on behalf of
   * accounts (self-healing cycle, phase 1). Every tool takes user+project explicitly
   * and resolves the session per-request — the test latch (_activeSession) is never
   * read nor written on this path, so console calls and a running test coexist.
   * Tools: get_status, stop_execution, open_project, send_message, close_project.
   * @param {Object} mcpServer - McpServer instance to register tools on
   * @param {Object} z - zod instance for input schemas
   * @private
   */
  _registerConsoleTools(mcpServer, z)
  {
    // A project can be held by a run_step or by another console turn: either way the
    // per-project lock is the single admission point — same map, same refusals, and the
    // parallelism between different projects stays natural.
    let checkNotBusy = (user, project) => this._projectBusyError(this._projectKey(user, project));
    //
    // --- Tool: get_status ---
    // Unguarded on purpose: it is the probe an operator reaches for when everything else
    // answers "in progress" — a console that governs N projects asks about each of them
    mcpServer.tool("get_status",
      "Returns the status of the open projects: for each one its session, origin (console/test/human), "
        + "admission lock, pending requests, and whether a headless page drives it. "
        + "With user+project it reports on that project only.",
      {
        user: z.string().optional().describe("With `project`: user owning the project to report on"),
        project: z.string().optional().describe("Report on this project only"),
        all: z.boolean().optional().describe("Report on ALL open projects (default when no filter is given)")
      },
      async ({user, project, all}) => {
        // `all` was declared in the schema and never read, so it could not override the filters —
        // and with the filters now effective it is the only way to ask for everything explicitly.
        let status = all ? this._getProjectsStatus() : this._getProjectsStatus(user, project);
        return {content: [{type: "text", text: JSON.stringify(status, null, 2)}]};
      }
    );
    //
    // --- Tool: stop_execution ---
    this._registerStopTool(mcpServer, z, true);
    //
    // --- Tool: run_tests ---
    this._registerRunTestsTool(mcpServer, z, true);
    //
    // --- Tool: open_project ---
    mcpServer.tool("open_project",
      "Opens a project in a headless IDE session so its internal DevAgent can work on it. "
        + "Idempotent: if the project is already open BY THE CONSOLE, returns the existing session state. "
        + "A project open by anyone else (a programmer's browser, a test harness) is refused by name: "
        + "the same project cannot be edited from two clients. Call this before send_message.",
      {
        user: z.string().describe("Account (user name) owning the project"),
        project: z.string().describe("Project name to open")
      },
      async ({user, project}, extra) => {
        let busy = checkNotBusy(user, project);
        if (busy) return busy;
        // Stesso criterio di start_prospect_session, e con margini piu' larghi: apre lo stesso
        // browser, poi aspetta la sessione 30s (contro 15) piu' 5s di grazia — e sul percorso
        // lento `_openProject` chiude il browser, lo rilancia e riprova, con un `goto` da 30s per
        // tentativo. Si passano i 60s del client senza che sia successo niente di anomalo. Ed e'
        // la PRIMA chiamata di ogni giro console: se il trasporto cade qui, il progetto resta
        // aperto lato server e il chiamante non ha ne' il sessionId ne' un errore (#15440).
        let stopHeartbeat = this._startProgressHeartbeat(extra, `open_project ${user}/${project}`);
        try {
          // Already open. "Already open BY US" and "already open by a programmer" are
          // opposite cases and must not share an answer: in the second one, a send_message
          // would land IN THAT PERSON'S CHAT while the agent edits under their hands.
          // The server would refuse the second browser anyway (busySession) — but as a
          // 30-second timeout; this refusal is immediate and names the fact.
          let existing = this._findSession(user, project);
          if (existing) {
            if (this._isForeignSession(existing, "console"))
              return {content: [{type: "text",
                text: `Error: project ${user}/${project} is already open by another client ` +
                  `(origin: ${existing.origin || "unknown"}). The same project cannot be edited from two ` +
                  "browsers — ask the owner to close it, or retry later."}], isError: true};
            console.log(`[MCP][console] open_project: ${user}/${project} already open (session=${existing.id})`);
            return {content: [{type: "text", text: JSON.stringify({user, project, sessionId: existing.id, status: "already-open"}, null, 2)}]};
          }
          //
          // Guard against two concurrent opens of the same project: the second
          // _openProjectHeadless would close the page the first one is still loading
          let key = this._projectKey(user, project);
          if (this._consoleOpening.has(key))
            return {content: [{type: "text", text: `Error: an open_project for ${key} is already in progress`}], isError: true};
          this._consoleOpening.add(key);
          try {
            await this._openProject(user, project, null, "console");
            let session = await this._waitForSession(30000, project, user, false);
            // Browser-init grace period: DevAgentView registers the MCP listeners only
            // AFTER the CLIENT_READY/SERVER_READY handshake (same as the prospect flow)
            await new Promise(r => setTimeout(r, 5000));
            //
            console.log(`[MCP][console] open_project: ${user}/${project} ready (session=${session.id})`);
            return {content: [{type: "text", text: JSON.stringify({user, project, sessionId: session.id, status: "ready"}, null, 2)}]};
          }
          finally {
            this._consoleOpening.delete(key);
          }
        }
        catch (e) {
          console.warn(`[MCP][console] open_project FAILED: ${user}/${project} — ${e.message}`);
          return {content: [{type: "text", text: `Error: ${e.message}`}], isError: true};
        }
        finally {
          stopHeartbeat();
        }
      }
    );
    //
    // --- Tool: send_message ---
    mcpServer.tool("send_message",
      "Sends a natural language message to the DevAgent of an open project and returns its complete response. "
        + "The project must have been opened with open_project first. May take several minutes.",
      {
        user: z.string().describe("Account (user name) owning the project"),
        project: z.string().describe("Project name (must be open)"),
        message: z.string().describe("The message for the project's DevAgent")
      },
      async ({user, project, message}, extra) => {
        // One turn per project, fail-fast (decision 14-08): without the lock the second
        // message is silently dropped by the streaming composer while its tag overwrites
        // the first one's — and the FIRST answer is delivered to the SECOND caller
        let key = this._projectKey(user, project);
        if (!this._acquireProjectLock(key, "send_message"))
          return this._projectBusyError(key);
        let stopHeartbeat = () => {};
        try {
          let session = this._findSession(user, project);
          if (!session)
            return {content: [{type: "text", text: `Error: project ${user}/${project} is not open — call open_project first`}], isError: true};
          // open_project refuses a foreign session; this tool has to refuse it too, and here the
          // stake is higher: the message would be typed into that person's chat.
          let foreign = this._refuseIfForeign(session, "console", `${user}/${project}`, "the message was not sent");
          if (foreign)
            return foreign;
          //
          console.log(`[MCP][console] send_message: ${user}/${project} — "${message.substring(0, 80)}..."`);
          // This tool's own description promises "May take several minutes": without the
          // heartbeat that promise is one the transport cannot keep (#15440).
          stopHeartbeat = this._startProgressHeartbeat(extra, `send_message ${user}/${project}`);
          let result = await this._sendMessage(message, null, {}, session);
          //
          let content = [{type: "text", text: result.text}];
          if (result.usage)
            content.push({type: "text", text: "Usage: " + JSON.stringify(result.usage)});
          return {content};
        }
        catch (e) {
          console.warn(`[MCP][console] send_message FAILED: ${user}/${project} — ${e.message}`);
          return {content: [{type: "text", text: this._describeSendFailure(e)}], isError: true};
        }
        finally {
          stopHeartbeat();
          this._releaseProjectLock(key);
        }
      }
    );
    //
    // --- Tool: save_project ---
    mcpServer.tool("save_project",
      "Saves an open project, persisting the changes its DevAgent made, and LEAVES IT OPEN. "
        + "Until now the only way to persist from this tool set was close_project, which saves and then ends the "
        + "session: a console driving a long job had to close and reopen — throwing away the agent's context — "
        + "just to get a checkpoint on disk. Saving twice writes the same model, so it is safe to call between turns.",
      {
        user: z.string().describe("Account (user name) owning the project"),
        project: z.string().describe("Project name to save")
      },
      async ({user, project}) => {
        let busy = checkNotBusy(user, project);
        if (busy) return busy;
        try {
          let session = this._findSession(user, project);
          if (!session)
            return {content: [{type: "text",
              text: `Error: project ${user}/${project} is not open — there is nothing to save.`}], isError: true};
          //
          // The ownership rule the rest of this set applies. The local twin goes deliberately
          // unguarded, on the ground that persisting somebody's work destroys nothing — but this
          // set governs accounts it does not own, and there a save commits a state whose owner may
          // still be deciding to discard it.
          let foreign = this._refuseIfForeign(session, "console", `${user}/${project}`, "the project was not saved");
          if (foreign)
            return foreign;
          //
          this._saveProject(session);
          // The same flush heuristic close_project and the local save_project use: the save is
          // fire-and-forget toward the browser, and an answer that returns before the write lands
          // reads as a checkpoint that is not on disk yet.
          await new Promise(r => setTimeout(r, 1000));
          console.log(`[MCP][console] save_project: ${user}/${project}`);
          return {content: [{type: "text", text: JSON.stringify({user, project, status: "saved"}, null, 2)}]};
        }
        catch (e) {
          console.warn(`[MCP][console] save_project FAILED: ${user}/${project} — ${e.message}`);
          return {content: [{type: "text", text: `Error: ${e.message}`}], isError: true};
        }
      }
    );
    //
    // --- Tool: close_project ---
    mcpServer.tool("close_project",
      "Closes an open project session, optionally saving it first. Idempotent: closing a project that is not open succeeds.",
      {
        user: z.string().describe("Account (user name) owning the project"),
        project: z.string().describe("Project name to close"),
        save: z.boolean().optional().default(true).describe("Save the project before closing (default true). Pass false to discard the DevAgent's changes.")
      },
      async ({user, project, save}) => {
        let busy = checkNotBusy(user, project);
        if (busy) return busy;
        try {
          let session = this._findSession(user, project);
          if (session) {
            let foreign = this._refuseIfForeign(session, "console", `${user}/${project}`, "the project was not closed");
            if (foreign)
              return foreign;
          }
          if (!session) {
            console.log(`[MCP][console] close_project: ${user}/${project} already closed`);
            return {content: [{type: "text", text: JSON.stringify({user, project, status: "already-closed"}, null, 2)}]};
          }
          //
          if (save) {
            this._saveProject(session);
            // Same flush heuristic as the local save_project tool: the save is
            // fire-and-forget toward the browser, closing right away can lose edits
            await new Promise(r => setTimeout(r, 1000));
          }
          this._closeProject(session);
          // Teardown of a headless IDE tab (client disconnect → session auto-kill) can run
          // well past 15s. We wait a bounded time for a definitive "closed", but a timeout
          // is NOT an error: the close command was delivered and the session tears down in
          // the background. Report "closing" so the console distinguishes it from a failure.
          let closed = await this._waitForSessionEnd(project, user, 20000);
          //
          console.log(`[MCP][console] close_project: ${user}/${project} saved=${save} closed=${closed}`);
          return {content: [{type: "text", text: JSON.stringify({user, project, saved: save, closed, status: closed ? "closed" : "closing"}, null, 2)}]};
        }
        catch (e) {
          console.warn(`[MCP][console] close_project FAILED: ${user}/${project} — ${e.message}`);
          return {content: [{type: "text", text: `Error: ${e.message}`}], isError: true};
        }
      }
    );
  }


  /**
   * Resolve the session a local save_project/close_project has to act on.
   * Without `project` it answers with the latched session — the shape the test skills use,
   * and the right one while a single project is open. With it, the project is looked up
   * among the online sessions, so a caller that knows its own project stops depending on a
   * latch that only start_test and refresh move, and that another session can have taken
   * over in the meantime (#15429).
   * @param {String} [user] - Account owning the project; narrows a name open on more than one
   * @param {String} [project] - Project to act on; when omitted the latched session is used
   * @returns {Object} `{session, label}` when resolved, `{error}` carrying the MCP payload
   *   otherwise — the caller returns that one unchanged
   * @private
   */
  _resolveLocalTarget(user, project)
  {
    let sessions = this.server.getOnlineSessions() || [];
    let fail = text => ({error: {content: [{type: "text", text}], isError: true}});
    // Every miss names what IS open: out of a bare "not found" the caller cannot correct the
    // call, and this answer is the only channel back to it. What it may name is the caller's
    // OWN account: on the cloud this list used to hand the whole tenant inventory — account
    // names and project names, the arguments every acting tool takes — to anyone who mistyped
    // a project name (#15843). It stays the diagnosis it was, because the projects a caller can
    // legitimately name are its own. Only the LIST narrows: `matches` below still searches every
    // session, so nothing about which project a call resolves to changes here — refusing to act
    // inside another account is a different door (#15827).
    let visible = sessions;
    if (!this.server.config?.local) {
      let owner = this._callerAccountName();
      visible = owner ? sessions.filter(s => s.project?.user?.userName === owner) : [];
    }
    let open = visible.map(s => this._sessionLabel(s)).join(", ") || "none";
    //
    if (!project) {
      // `user` alone would be read as a target and silently ignored — the same shape of defect
      // this resolver exists to remove, one argument further in.
      if (user)
        return fail("Error: `user` alone does not name a project — pass `project` too, or neither.");
      //
      // The latch is validated against what is ONLINE, not for truthiness: local auth hands out a
      // `{id: "no-session"}` placeholder when nothing is open, and a latch left on a session that
      // has since gone offline is truthy too. Both used to reach the send and come back as
      // "No browser client connected" — a socket symptom standing in for the cause.
      if (!sessions.includes(this._activeSession))
        return fail(`Error: no project is latched. Pass \`project\` (and \`user\`) to name one. Open projects: ${open}`);
      //
      return {session: this._activeSession, label: this._sessionLabel(this._activeSession)};
    }
    //
    let matches = sessions.filter(s => s.project?.name === project &&
      (!user || s.project?.user?.userName === user));
    if (matches.length === 1)
      return {session: matches[0], label: this._sessionLabel(matches[0])};
    //
    if (!matches.length)
      return fail(`Error: project ${user ? `${user}/${project}` : project} is not open. Open projects: ${open}`);
    //
    return fail(`Error: project ${project} is open on more than one account — pass \`user\` to choose. Open projects: ${open}`);
  }


  /**
   * Find the online IDE session for a given user/project pair.
   * @param {String} userName - User name owning the session
   * @param {String} projectName - Project name
   * @returns {Node.IDESession|null} The matching session, or null
   * @private
   */
  _findSession(userName, projectName)
  {
    let sessions = this.server.getOnlineSessions() || [];
    return sessions.find(s =>
      s.project?.name === projectName && s.project?.user?.userName === userName) || null;
  }


  /**
   * Register the run_tests tool on a tool set: the M3 test scripts run from OUTSIDE the chat
   * — a console, a CI job, a person driving the IDE from Claude Code — on the session that has
   * the project open, with no DevAgent turn and no reconciliation (the run tests the model as
   * it is; the reconciliation serves the agent's own run_test, after the files it wrote).
   * The machine lives in the child (runtimeTools.runTestTargets), so this is one IPC request
   * on the gold-command channel, with the long timeout a whole project needs.
   * When nobody has the project open it is opened READ-ONLY in a headless session for the run
   * and closed afterwards (nothing of the run writes the model, and a read-only session is one
   * the server creates beside any other instead of refusing).
   * @param {Object} mcpServer - McpServer instance to register the tool on
   * @param {Object} z - zod instance for the input schema
   * @param {Boolean} consoleLevel - true for the console set (explicit user/project),
   *   false for the local set (project optional: the latched session)
   * @private
   */
  _registerRunTestsTool(mcpServer, z, consoleLevel)
  {
    let schema = {
      user: consoleLevel
        ? z.string().describe("Account (user name) owning the project")
        : z.string().optional().describe("Account owning the project; needed to OPEN a project that is not open"),
      project: consoleLevel
        ? z.string().describe("Project whose test scripts run")
        : z.string().optional().describe("Project whose test scripts run; omitted → the latched session's project"),
      targets: z.array(z.string()).optional().describe(
        "App names and/or test script names, in any mix: an app runs every script it has, a script "
        + "runs alone (looked up across the apps — a name two apps share must be given through its app). "
        + "Empty or omitted: every script of every app."),
      stopOnFail: z.boolean().optional().describe("Stop at the first script that does not pass (default false)"),
      skipRestore: z.boolean().optional().describe(
        "Run on the current data instead of restoring the baselines the scripts declare (default false)")
    };
    mcpServer.tool("run_tests",
      "Runs the project's test scripts (test framework M3) and returns the report; isError when any "
        + "script fails or nothing could run. Runs on the IDE session that has the project open, WITHOUT "
        + "a DevAgent turn and without reconciling pending edits. A project nobody has open is opened "
        + "read-only in a headless session for the run and closed afterwards. May take many minutes.",
      schema,
      async ({user, project, targets, stopOnFail, skipRestore}, extra) => {
        let session = null;
        if (!consoleLevel) {
          // Local set: an open project may be named without its user, or not named at all
          // (the latch) — the same resolution save/close use. A project that is NOT open needs
          // the user to build the URL that opens it
          let target = this._resolveLocalTarget(user, project);
          if (target.session) {
            // Ownership, the same gate and the same shape as the siblings that share this resolver.
            // This tool is NOT the set's reading one: `skipRestore` defaults to false, so a run
            // RESTORES the baselines the scripts declare over the target project's data — the
            // category of reset_project, which is gated, and the opposite of save_project, whose
            // exemption rests on persisting somebody's work destroying nothing. It also holds the
            // project lock for the whole run ("may take many minutes"), so it blocks whoever is
            // working in there. Named, it would do all that inside another account's session: the
            // resolver searches every online session, and at auth level `user` on the cloud
            // `config.local` is false while those sessions still belong to other people. Un-named
            // still reaches the latch alone, as it always did.
            if (project) {
              // The same pair as the four siblings, through the same helper — this branch used to
              // write the comparison and the refusal object out by hand, which is how it stayed
              // out of every census of the family. What it keeps of its own is the damage the
              // sentence names: this door restores baselines over that account's data.
              let refusal = this._refuseIfNotOurs(target.session, target.label, "no test was run",
                "the run would have restored the declared baselines over that person's data, " +
                "inside their own session");
              if (refusal)
                return refusal;
            }
            session = target.session;
            user = session.project?.user?.userName;
            project = session.project?.name;
          }
          else if (!project || !user)
            return target.error;
          else if (this._findSession(user, project)) {
            // The resolver fails in two ways that are not the same fact: nobody has it open, and
            // more than one session has. Only the first is this branch's premise — the tool then
            // opens the project ITSELF. On the second the project IS open, and dropping the error
            // would fall through to `_findSession` below, which returns the FIRST match and runs
            // there with no `_refuseIfForeign` behind it: a second session would REMOVE the origin
            // gate that one session gets. Two sessions on one user/project is not a corner — the
            // read-only /view session this tool opens and a person's /edit tab coexist, because
            // `editProject` filters on `readOnly: undefined` and never matches a `readOnly: true`
            // one (server.js:1600). Hand back what the resolver composed: it names what is open,
            // which is the caller's only channel to correct the call. Local server too — the
            // ambiguity is the same there and the choice of session stays undetermined.
            return target.error;
          }
          else if (!this._callerOwns(user)) {
            // Nobody has it open, and this is the one tool of the set that then opens the project
            // ITSELF (`_openProject` below): read-only for the IDE, but `skipRestore` still defaults
            // to false, so the run restores the baselines the scripts declare over that account's
            // data. No session exists yet, so `_refuseIfForeign` has nothing to judge — the only
            // link between this caller and an account is the session whose `mcpApiKey` matched in
            // `_authenticate`, which `handleRequest` parks in the latch. On the cloud a caller may
            // name any user, so the two names are compared here. Local server: unchanged, as above.
            // Closed by default: `owner` missing is a refusal, not a pass. At this level — not
            // console, not local — an authenticated account must exist, and the latch can lose it
            // (it is set to null wherever the session it points at goes away, and this handler
            // crosses awaits after the request parked it). With nothing to compare against there
            // is no way to tell whose project this is, and the operation writes.
            // The comparison is `_callerOwns` in the branch condition — the message is this door's
            // own, because no session exists to name and the refusal has to say so.
            let owner = this._callerAccountName();
            return {content: [{type: "text",
              text: `Error: project ${this._projectKey(user, project)} does not belong to the ` +
                (owner ? `authenticated account (this key authenticates ${owner})` : "authenticated account") +
                " and nobody has it open, so no test was run — the run would have opened it and " +
                "restored the declared baselines over that person's data. Name a project of your " +
                "own account."}], isError: true};
          }
        }
        //
        let key = this._projectKey(user, project);
        if (!this._acquireProjectLock(key, "run_tests"))
          return this._projectBusyError(key);
        let stopHeartbeat = this._startProgressHeartbeat(extra, `run_tests ${key}`);
        let opened = false;
        try {
          if (!session)
            session = this._findSession(user, project);
          // Console set: the session found here is someone's own tab, and run_tests was the only
          // one of the five console tools without the gate the other four have. It is not the
          // least invasive of them: `skipRestore` is false by default, so the run RESTORES the
          // baselines the scripts declare — on that person's data — and holds their project lock
          // for a run the tool's own description calls "many minutes". A hand-opened /edit tab
          // carries no `origin`, so _isForeignSession falls back to "is our headless page driving
          // that tab" and answers no: the siblings all refuse it, this one used to run inside it.
          // It judges ALL of them, not the one `_findSession` happened to return first: it answers
          // `sessions.find(...)`, so with two sessions on the same user/project the protection
          // would depend on which came first — and the pair is one this very function produces.
          // Its `finally` closes the headless tab and waits; when the wait runs out it logs
          // `${key} still online 20s after its tab was closed` and OUR read-only session stays
          // online. The person then opens their own /edit tab, `IDESessions` is a string-keyed
          // object so `Object.values` renders it in insertion order, and ours — older — comes
          // first: the gate would look at ours, find it its own, and let the run restore the
          // baselines on the data of the person working in the other tab.
          // Dying sessions stay out of the SCAN (`!s.killSessionTimer`): one that is ending is not
          // one this tool acts on — a fresh read-only session is opened below — so refusing for it
          // would be a refusal with no damage to prevent, stricter than the four siblings for
          // nothing. That exclusion is what lets the check sit HERE, before the death window
          // instead of after it: judging the set rather than the resolved session, the order no
          // longer matters, and waiting first only delays a verdict already decided. Measured with
          // ours dying and the person's tab alive: the refusal arrived after 20041ms, holding that
          // project's lock the whole time, behind two log lines announcing an open that never
          // happened. The refusal is inside the try, so the finally releases the lock.
          if (consoleLevel) {
            let stranger = (this.server.getOnlineSessions() || []).find(s =>
              s?.project?.name === project && s.project?.user?.userName === user &&
              !s.killSessionTimer && this._isForeignSession(s, "console"));
            if (stranger) {
              let foreign = this._refuseIfForeign(stranger, "console", key, "no test was run");
              if (foreign)
                return foreign;
            }
          }
          // A session in its death window (a close_project answered "closing" moments ago —
          // the tab tears down, the server keeps the session for a few seconds so an F5 can
          // reclaim it) is still online and is not one to run on: the command would ride into
          // a child that is being torn down ("the IDE session ended while waiting", measured).
          // Wait for it to go, then open a fresh one like any project nobody has open
          if (session?.killSessionTimer) {
            console.log(`[MCP] run_tests: ${key} is closing — waiting for that session to end before opening a fresh one`);
            let ended = await this._waitForSessionEnd(project, user, 20000);
            if (!ended)
              console.warn(`[MCP] run_tests: ${key} did not end within 20s — opening a fresh session anyway`);
            session = null;
          }
          if (!session) {
            // Same guard as open_project: two concurrent opens of one project would close
            // each other's page while it is still loading
            if (this._consoleOpening.has(key))
              return {content: [{type: "text", text: `Error: an open of ${key} is already in progress`}], isError: true};
            this._consoleOpening.add(key);
            try {
              console.log(`[MCP] run_tests: ${key} is not open — opening it read-only for the run`);
              // Armed BEFORE the open, not after the session answers: from this line on a tab
              // (and the browser behind it) can exist, so whatever goes wrong next is this
              // call's to close — _openProject throwing after its own retry launched a browser,
              // or _waitForSession running out its 30s and THROWING (it does not return null).
              // Armed after, a session slower than that left an open tab and a live session
              // with nobody left to close them: no close_project knows about a tab this tool
              // opened for itself. _closeHeadless is keyed by pageKey, which _openProject
              // registers, so it works on a tab whose session never arrived — and is a no-op
              // when there is no entry at all
              opened = true;
              // The origin follows the LEVEL because the GATES are split by level: the six of the
              // local set compare against "test" (`:346` `:445` `:576` `:904`, the one below at
              // `:1494`, and `:1710`), the four of the console set against "console" (`:1240`
              // `:1289` `:1322` `:1683`). Until now both levels stamped "console", which made the
              // sessions this tool opens FOREIGN TO ITS OWN GATE at the local level: a run whose
              // `finally` cannot see the session go — the 20s wait times out, or the close throws,
              // both logged below — left the project open by an `origin: "console"` session of this
              // very tool, and the NEXT named call was refused with "is open by another client
              // (origin: console) … Ask the owner to close it". The owner is this tool, and the
              // caller has no move that matches the advice. `_isForeignSession`'s fallback ("the
              // headless page driving that tab is ours") cannot rescue it: it fires only when
              // `origin` is ABSENT, and this stamp supplied it. The console branch is NOT dead
              // code — collapsing this ternary onto "test" would make the console set's own
              // sessions foreign to those four gates, i.e. the same defect one level over.
              await this._openProject(user, project, null, consoleLevel ? "console" : "test", true);
              session = await this._waitForSession(30000, project, user, false);
              // Browser-init grace period, as in open_project: the client registers the MCP
              // listeners (the close below rides on one) only after the READY handshake
              await new Promise(r => setTimeout(r, 5000));
            }
            finally {
              this._consoleOpening.delete(key);
            }
          }
          //
          let result = await this._sendTestCommand("run_test_scripts",
            {targets: targets || [], stopOnFail: !!stopOnFail, skipRestore: !!skipRestore},
            session, Node.McpServer.RUN_TESTS_TIMEOUT_MS);
          if (result.error)
            return {content: [{type: "text", text: `Error: ${result.error}`}], isError: true};
          //
          console.log(`[MCP] run_tests: ${key} — ${result.ran} script(s), ${result.failed} failed`);
          return {content: [{type: "text", text: result.text}], isError: result.failed > 0};
        }
        catch (e) {
          console.warn(`[MCP] run_tests FAILED: ${key} — ${e.message}`);
          return {content: [{type: "text", text: `Error: ${e.message}`}], isError: true};
        }
        finally {
          // A session this call opened is this call's to close — whatever the run answered.
          // Closing the headless tab is the road, not the socket close the console's
          // close_project sends: on a /view tab `terminateSession` navigates away without
          // ending the session (measured: still online after 20s), while a closed tab is a
          // disconnect the server turns into the session's auto-kill within seconds — the
          // path a person closing the tab takes. Nothing to save: the session is read-only
          if (opened) {
            try {
              await this._closeHeadless(key);
              let closed = await this._waitForSessionEnd(project, user, 20000);
              if (!closed)
                console.warn(`[MCP] run_tests: ${key} still online 20s after its tab was closed`);
            }
            catch (e) {
              console.warn(`[MCP] run_tests: could not close ${key} after the run — ${e.message}`);
            }
          }
          stopHeartbeat();
          this._releaseProjectLock(key);
        }
      }
    );
  }


  /**
   * Register the stop_execution tool on a tool set. It is the complement of the fail-fast
   * lock: without it, a command gone wrong holds the project for the 30-minute timeout and
   * whoever commands has no way to take control back (decision 14-08, point G).
   * Deliberately UNGUARDED (a tool that exists to unblock cannot be refused by what it must
   * unblock) and idempotent (whoever sends it usually cannot know if the turn is still alive).
   * @param {Object} mcpServer - McpServer instance to register the tool on
   * @param {Object} z - zod instance for the input schema
   * @param {Boolean} consoleLevel - true for the console set (user/project required),
   *   false for the local set (both optional: omitted → the latched session)
   * @private
   */
  _registerStopTool(mcpServer, z, consoleLevel)
  {
    let schema = consoleLevel ? {
      user: z.string().describe("Account (user name) owning the project"),
      project: z.string().describe("Project whose DevAgent turn must be stopped")
    } : {
      user: z.string().optional().describe("With `project`: account owning the project to stop"),
      project: z.string().optional().describe("Stop the turn on this project instead of the latched session")
    };
    //
    mcpServer.tool("stop_execution",
      "Stops the DevAgent turn in progress on a project, by pressing the chat's own Stop button in its IDE tab. "
        + "The aborted turn still emits its completion, so the pending send_message resolves on its own with the "
        + "partial text (aborted). Idempotent: with no turn in progress it succeeds and does nothing. "
        + "Never refused by the project lock — this is the tool that frees it. "
        + "Known limit: while the agent is compacting its context the stop is a no-op — if nothing stops, retry "
        + "after the compaction ends. Name the project: with more than one turn running, an unnamed stop follows "
        + "the latch, and the turn it aborts is as likely to be somebody else's as yours.",
      schema,
      async ({user, project}) => {
        try {
          let session;
          let key;
          if (consoleLevel) {
            session = this._findSession(user, project);
            key = this._projectKey(user, project);
            // Only on the console path: below, the resolver has already read the session out of
            // what is online, so there is nothing left to look up.
            if (session) {
              let foreign = this._refuseIfForeign(session, "console", key, "the turn was not stopped");
              if (foreign)
                return foreign;
            }
          }
          else {
            // The same resolver send_message, save and close use (#15429). This tool used to take
            // NO argument at all and press Stop on `_activeSession`: the one tool of the set that
            // could not be aimed was also the one whose whole purpose is to interrupt a specific
            // turn. With two tests running, the turn it hit was whichever project the latch had
            // last been moved to — and the refusal a busy eviction printed used to say so, which
            // is how a gap gets documented instead of closed.
            let target = this._resolveLocalTarget(user, project);
            if (target.error)
              return target.error;
            //
            // The rule the three siblings that share this resolver apply, in the same shape and on
            // the same gate. It is NOT the lock the docblock talks about — that one this tool must
            // be able to break, because breaking it is what it exists for — it is OWNERSHIP: the
            // resolver searches every online session, and at auth level `user` on the cloud
            // (_authenticate: match on the account's mcpApiKey) `config.local` is false while the
            // sessions it can see still belong to other accounts. Naming one presses Stop in
            // somebody else's chat. The one deliberate exception of this set is save_project, and
            // its ground — persisting somebody's work destroys nothing — is the opposite of what
            // happens here: an aborted turn is work thrown away, which is this PR's own thesis.
            // Un-named still reaches the latch alone, as it always did.
            if (project) {
              let refusal = this._refuseIfNotOurs(target.session, target.label, "the turn was not stopped");
              if (refusal)
                return refusal;
            }
            //
            session = target.session;
            key = target.label;
          }
          if (!session?.sockets?.[session.masterClientSod])
            return {content: [{type: "text",
              text: `Project ${key} is not open (or has no browser client) — nothing to stop.`}]};
          //
          this._stopExecution(session);
          return {content: [{type: "text",
            text: `Stop sent to ${key}. If a turn was streaming it is being aborted: its pending request ` +
              "resolves on its own with the partial text (aborted). With no active turn this was a no-op. " +
              "Note: during context compaction the stop is ignored — if nothing stops, retry after it ends."}]};
        }
        catch (e) {
          return {content: [{type: "text", text: `Error: ${e.message}`}], isError: true};
        }
      }
    );
  }


  /**
   * Press the Stop button of a session's DevAgent chat.
   * Goes through the CLIENT (like the messages do, decision G): handleStopExecution both
   * aborts the server-side turn and puts the tab back into a coherent state — closing the
   * NLUX observer, draining the queued bubbles, restoring the composer. An abort injected
   * child-side would stop the turn while the tab still believes it is streaming, and the
   * next injected message would be dropped in silence — the §B defect through the back door.
   * @param {Node.IDESession} session - Target session
   * @private
   */
  _stopExecution(session)
  {
    let socket = session?.sockets?.[session.masterClientSod];
    if (!socket)
      throw new Error("No browser client connected");
    //
    socket.emit("gc", {
      type: "dev-agent",
      cnt: {type: "mcp_stop_execution"}
    });
    //
    console.log(`[MCP] stop_execution sent to browser: ${session.project?.name}`);
  }


  /**
   * The error text a failed send_message answers. One case is translated instead of
   * relayed: between the master seeing `complete` (lock released) and the child's
   * handleChat reaching its `finally` (activeQueryId released) there is a window where
   * the child refuses with "a query is already in progress". That refusal is the truth,
   * and the caller must read "the previous turn is finishing — resend", not a generic error.
   * @param {Error} e - The failure
   * @returns {String} The text for the tool result
   * @private
   */
  _describeSendFailure(e)
  {
    if (/query is already in progress|query è già in corso/i.test(e.message || ""))
      return "The IDE refused the message because the previous turn is still completing. " +
        "Wait a few seconds and resend the command.";
    return `Error: ${e.message}`;
  }


  /**
   * Per-project status: what a console governing N projects asks about each of them.
   * @param {String} [userName] - Filter: user owning the project (with projectName)
   * @param {String} [projectName] - Filter: report on this project only
   * @param {String} [scopeUser] - The caller's own account: what it may be told about at all.
   *   Passed by the local/user tool set on a non-local server, never by the console one — a
   *   console governs N accounts by definition
   * @returns {Object} {projects: [{user, project, sessionId, origin, devAgentActive, lock,
   *   pendingAgentRequests, pendingTestRequests, headlessPageAlive}], runStepInFlight}
   * @private
   */
  _getProjectsStatus(userName, projectName, scopeUser)
  {
    let sessions = this.server.getOnlineSessions() || [];
    // Both filters apply on their own. `user` alone used to be ignored — the whole condition hung
    // off `projectName` — so a console asking about one account got every project of every account.
    if (projectName)
      sessions = sessions.filter(s => s.project?.name === projectName);
    if (userName)
      sessions = sessions.filter(s => s.project?.user?.userName === userName);
    // The caller's own account ANDs with the two filters above instead of replacing them: a
    // `user` naming somebody else must find NOTHING, not quietly answer about a project of the
    // caller's that happens to carry the same name.
    if (scopeUser)
      sessions = sessions.filter(s => s.project?.user?.userName === scopeUser);
    //
    let countPending = (map, key) =>
      Object.values(map).filter(pending => pending.label === key).length;
    //
    let projects = sessions.map(session => {
      let key = this._sessionLabel(session);
      let lock = this._projectLocks[key];
      let page = this._headless[key]?.page;
      return {
        user: session.project?.user?.userName || "unknown",
        project: session.project?.name || "unknown",
        sessionId: session.id,
        origin: session.origin || "unknown",
        devAgentActive: !!session.project?.user?.devAgentOptions,
        lock: lock ? {kind: lock.kind, sinceMs: Date.now() - lock.since} : null,
        pendingAgentRequests: countPending(this.pendingRequests, key),
        pendingTestRequests: countPending(this.pendingTestRequests, key),
        headlessPageAlive: !!(page && !page.isClosed())
      };
    });
    //
    return {projects, runStepInFlight: this._runStepInFlight};
  }


  /**
   * Express handler for MCP requests (POST /mcp, GET /mcp, DELETE /mcp).
   * @param {Request} req - Express request
   * @param {Response} res - Express response
   */
  async handleRequest(req, res)
  {
    try {
      // Authenticate — returns the access level along with the session (if any)
      let auth = this._authenticate(req);
      if (!auth) {
        res.status(401).json({error: "Unauthorized — invalid or missing API key"});
        return;
      }
      //
      // Store active session for tool handlers. Console-level requests never touch
      // the latch: their tools resolve the session per-request from explicit
      // user/project parameters, so a console call can't re-route an in-flight test
      if (auth.level !== "console")
        this._activeSession = auth.session;
      //
      // Lazy-load ESM modules once
      if (!this._McpServer) {
        let mcpMod = await import("@modelcontextprotocol/sdk/server/mcp.js");
        let httpMod = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
        this._McpServer = mcpMod.McpServer;
        this._StreamableHTTPServerTransport = httpMod.StreamableHTTPServerTransport;
      }
      //
      // Create fresh McpServer + transport per request (SDK requires 1:1 connect).
      // The tool set depends on the access level (console sees only its own tools)
      let mcpServer = this._createMcpServer(auth.level);
      let transport = new this._StreamableHTTPServerTransport({sessionIdGenerator: undefined});
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      transport.close?.();
    }
    catch (e) {
      console.error("[MCP] Request error:", e.message);
      if (!res.headersSent)
        res.status(500).json({error: e.message});
    }
  }


  /**
   * Authenticate request via Bearer token in Authorization header.
   * Returns the access level along with the resolved session:
   * - **local**: auto-generated key saved to filesystem (config.local only) — full tool set
   * - **console**: the server AUTK — the secret the IDE pushes to the Console on every
   *   rotation (Request.sendTokenToConsole), so a matching Bearer proves the caller is
   *   the Console. Sees only the console tool set; never latches _activeSession
   * - **user**: user's mcpApiKey matched against an online session
   * @param {Request} req
   * @returns {Object|null} {level: "local"|"console"|"user", session} or null
   * @private
   */
  _authenticate(req)
  {
    let authHeader = req.headers.authorization || "";
    let token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token)
      return null;
    //
    let sessions = this.server.getOnlineSessions();
    let who = `${req.method} ${req.path || "/"} ua="${(req.headers["user-agent"] || "").substring(0, 60)}" from=${req.ip || req.connection?.remoteAddress || "?"}`;
    //
    // Local server: validate against auto-generated key (stored in filesystem)
    // Auth is at server level, not session level — a valid key grants access
    // even without an active session. Individual tools check for session when needed.
    if (this.server.config?.local) {
      let localKey = this._getLocalKey();
      if (token === localKey) {
        // Prefer the session already latched by _waitForSession/tool flows when it is
        // still online: sessions[0] is whatever project a browser tab happens to have
        // opened first, so re-picking it on every request (keep-alive GETs included)
        // would silently re-route in-flight test commands to another project's child
        // mid-run (T0286 step 3: end_step hit gattini-test → "Step folder not found").
        // Project switches still update the latch explicitly via _waitForSession.
        let sess = null;
        if (this._activeSession && typeof this._activeSession.sendToChild === "function")
          sess = sessions.find(s => s === this._activeSession) || null;
        if (!sess)
          sess = sessions.length > 0 ? sessions[0] : null;
        // Include client identification so multiple concurrent MCP clients
        // (Claude Code CLI, MCP Inspector, second IDE, etc.) can be told apart.
        if (sess)
          console.log(`[MCP] Local auth: user=${sess.project?.user?.userName}, project=${sess.project?.name} — ${who}`);
        else
          console.log(`[MCP] Local auth: valid key, no active session — ${who}`);
        return {level: "local", session: sess || {id: "no-session"}};  // Minimal object so auth passes
      }
      // No return here: a local server with auth enabled can also serve the Console
      // (and the collaudo clone) — fall through to the console/user checks below
    }
    //
    // Console: Bearer must match the CURRENT server AUTK, and only when the server
    // actually enforces it (config.auth). An empty autk never matches (token is
    // non-empty here), and after a rotation the old token stops working immediately —
    // the Console retries with the fresh one it just received via idetk.
    let config = this.server.config;
    if (config?.auth && config.autk && token === config.autk) {
      console.log(`[MCP] Console auth (autk) — ${who}`);
      return {level: "console", session: null};
    }
    //
    // Cloud server: match token against user's mcpApiKey
    for (let sess of sessions) {
      let mcpKey = sess.project?.user?.mcpApiKey;
      if (mcpKey && mcpKey === token) {
        console.log(`[MCP] Authenticated: user=${sess.project.user.userName}, project=${sess.project.name}`);
        return {level: "user", session: sess};
      }
    }
    //
    return null;
  }


  /**
   * Get or create the local MCP API key.
   * Stored in a file alongside the server config — only readable by the local user.
   * @returns {String} The API key
   * @private
   */
  _getLocalKey()
  {
    if (this._localKey)
      return this._localKey;
    //
    let fs = require("fs");
    let path = require("path");
    let keyPath = path.join(__dirname, ".mcp-key");
    //
    try {
      this._localKey = fs.readFileSync(keyPath, "utf8").trim();
    }
    catch (e) {
      // Generate a new key on first use
      this._localKey = require("crypto").randomUUID();
      fs.writeFileSync(keyPath, this._localKey, {encoding: "utf8", mode: 0o600});
      console.log(`[MCP] Generated local API key in ${keyPath}`);
    }
    //
    return this._localKey;
  }


  /**
   * Save the current project.
   * Sends saveDocument command to the child process via the general channel.
   * @param {Node.IDESession} [session] - Target session (defaults to the latched _activeSession)
   * @private
   */
  _saveProject(session)
  {
    session = session || this._activeSession;
    if (!session)
      throw new Error("No active IDE session");
    //
    // Send save command to the browser client — same pattern as close_project
    // The browser calls InDe.theApp.saveDocument() which handles both client and server save
    let socket = session.sockets?.[session.masterClientSod];
    if (!socket) {
      // Diagnostic: masterClientSod is undefined after a master disconnect (see
      // idesession.js disconnect handler); sockets=0 means every client is gone, sockets>0
      // means the master dropped but others remain. Cross-reference the WARN "IDE socket
      // disconnected" entry (with its reason) at the same timestamp.
      console.warn(`[MCP] save_project FAILED — no browser client connected: project=${session.project?.name}, masterClientSod=${session.masterClientSod}, sockets=${Object.keys(session.sockets || {}).length}`);
      throw new Error("No browser client connected");
    }
    //
    socket.emit("gc", {
      type: "dev-agent",
      cnt: {type: "mcp_save_project"}
    });
    //
    console.log(`[MCP] save_project sent to browser: ${session.project?.name}`);
  }


  /**
   * Close the current project without saving.
   * Sends a command to the browser client, which closes the document properly.
   * @param {Node.IDESession} [session] - Target session (defaults to the latched _activeSession)
   * @private
   */
  _closeProject(session)
  {
    session = session || this._activeSession;
    if (!session)
      throw new Error("No active IDE session");
    //
    let socket = session.sockets?.[session.masterClientSod];
    if (!socket)
      throw new Error("No browser client connected");
    //
    // Send close command to browser — the early MCP listener in DevAgentView
    // activates the tab if needed, then calls InDe.theApp.closeDocument()
    socket.emit("gc", {
      type: "dev-agent",
      cnt: {type: "mcp_close_project"}
    });
    //
    console.log(`[MCP] close_project sent to browser: ${session.project?.name}`);
  }


  /**
   * Close a project and CONFIRM it is gone, falling back to the server-side eviction when the
   * socket-driven close was accepted but nobody acted on it.
   *
   * `_closeProject` only proves the emit left: it throws when there is no socket, and succeeds
   * whenever one is there — including when the tab has navigated away from the IDE and no
   * DevAgentView is listening for `mcp_close_project` any more. In that state the IDESession
   * stays registered with masterClientSod set, and the user's next plain /edit open is rejected
   * with `busySession` (#15763: three times on 26-08, each needing the headless Chrome killed
   * by hand). This is the same two-attempt shape run_step's refresh recovery already uses.
   * @param {Node.IDESession} session - Session to close
   * @param {String} projectName - Project the session belongs to
   * @param {String} userName - Account owning it
   * @param {Number} [timeout] - Milliseconds to wait for the session to end, per attempt
   * @returns {Promise<Object>} `{closed, forced, reopened}` — `closed` false means it is STILL
   *   registered; `reopened` means the session found on it is not the one we closed, so nothing
   *   was evicted and the caller must not report a leftover
   * @private
   */
  async _closeAndConfirm(session, projectName, userName, timeout = 15000)
  {
    this._closeProject(session);
    let closed = await this._waitForSessionEnd(projectName, userName, timeout);
    if (closed)
      return {closed: true, forced: false};
    //
    // Both the wait above and the eviction below resolve by NAME, so "a session is still
    // there" cannot tell a leftover from a session someone opened meanwhile. On the forced
    // path that second case is real and documented: close_project's third `note` branch says
    // force does NOT interrupt a step sitting in an internal wait, and two of those waits
    // (_openProject and the _waitForSession after it) are the ones that REOPEN the project.
    // Evicting then would kill the run we only meant to close, and report it as a browser
    // that ignored the close. The caller holds the session it asked to close: compare it.
    let now = (this.server.getOnlineSessions() || []).find(s =>
      s.project?.name === projectName && s.project?.user?.userName === userName);
    if (now && now !== session)
      return {closed: false, forced: false, reopened: true};
    //
    // The graceful close was accepted and ignored. Evict server-side, then confirm again:
    // the eviction is what makes the project openable, so reporting it without re-checking
    // would trade one unverified claim for another.
    let forced = this._forceCloseLingeringSession(projectName, userName);
    if (forced)
      closed = await this._waitForSessionEnd(projectName, userName, timeout);
    return {closed, forced: !!forced};
  }


  /**
   * Force-close a lingering IDE session by project/user LOOKUP, without relying on a
   * live master socket. Used by the refresh recovery path (run_step): when the master
   * tab has degraded, the socket-driven close (_closeProject) is impossible or ignored,
   * yet the IDESession stays registered with masterClientSod set — so the next plain
   * /edit open would be rejected with `busySession` (idesession.js:490). This evicts the
   * lingering session server-side so a fresh tab can take ownership as the new master.
   * @param {String} projectName - project whose lingering session must be evicted
   * @param {String} userName - user owning the session
   * @returns {Boolean} true if a matching session was found and evicted, false otherwise
   * @private
   */
  _forceCloseLingeringSession(projectName, userName)
  {
    let sessions = this.server.getOnlineSessions() || [];
    let sess = sessions.find(s =>
      s.project?.name === projectName && s.project?.user?.userName === userName);
    if (!sess)
      return false;
    //
    // Evicting is legitimate on a session of OURS left hanging; on an organization server a
    // session someone else opened is their work, not our lingering state (decision A)
    if (!this.server.config?.local && this._isForeignSession(sess, "test")) {
      console.warn(`[MCP] force-close REFUSED: session of ${userName}/${projectName} belongs to another client (origin: ${sess.origin || "unknown"})`);
      return false;
    }
    //
    console.log(`[MCP] force-close: evicting lingering session project=${projectName}, id=${sess.id}`);
    // closeAllConnections(): disconnect every socket (the disconnect handler clears
    // masterClientSod), stop the auto-kill timer, and ask the child to terminate so the
    // reopen gets a fresh agent context — matching graceful-close semantics.
    try {
      sess.closeAllConnections();
    }
    catch (e) {
      console.warn(`[MCP] force-close: closeAllConnections failed (${e.message})`);
    }
    // closeSession(): remove it from the master registry immediately and tell the childer
    // to forget it, so getOnlineSessions() no longer returns it and _waitForSessionEnd
    // observes the session gone right away. It sends to the childer, which in the force-close
    // scenario may already be degraded — an exception here must not abort the refresh recovery,
    // and _activeSession must be cleared regardless.
    try {
      this.server.closeSession(sess);
    }
    catch (e) {
      console.warn(`[MCP] force-close: closeSession failed (${e.message})`);
    }
    if (this._activeSession === sess)
      this._activeSession = null;
    return true;
  }


  /**
   * Resolves test options with the IDE that owns the session or will open the project.
   * @param {String} projectName - Project name
   * @param {String} userName - Account name
   * @param {String} [model] - Test model override
   * @param {String} [provider] - Test provider override
   * @returns {Object} Provider options supported by the target IDE
   * @private
   */
  _getTestModelOptions(projectName, userName, model, provider)
  {
    let session = this._findSession(userName, projectName);
    let project = session?.project || this.server.config.getUser(userName)?.getProject(projectName);
    if (!project)
      throw new Error(`Project not found: ${userName}/${projectName}`);
    //
    let version = session ? session.options.openParams?.version : project.resolveSessionVersion();
    let ideDir = require("./utils").resolveIdeDir(version);
    let modulePath = require("path").join(ideDir, "agent", "TestModelOptions.js");
    if (require("fs").existsSync(modulePath))
      return require(modulePath)(model, provider);
    //
    // Older IDEs accepted Claude model overrides, but had no per-test provider routing.
    if (provider || (model && !model.startsWith("claude-")))
      throw new Error("La versione IDE del progetto non supporta queste opzioni modello/provider del test");
    //
    return {model};
  }


  /**
   * Start a new test session — operates directly on the filesystem, no IDE session needed.
   * @param {String} project - Project name
   * @param {String} user - User name
   * @param {String} [model] - AI model override
   * @param {String} [thinkingEffort] - Thinking effort override
   * @param {String} [browser] - Browser mode for all steps: "headless" (default) or "chrome"
   * @param {String} [provider] - Test-only provider route; inferred from model when omitted
   * @returns {Object} Test identity, gold availability and scoped model/provider/effort/browser options
   * @private
   */
  _startTest(project, user, model, thinkingEffort, browser, provider)
  {
    let selection = this._getTestModelOptions(project, user, model, provider);
    model = selection.codexModel || selection.openrouterModel || selection.mimoModel || selection.model || model;
    provider = selection.provider;
    let fs = require("fs");
    let path = require("path");
    let homeDir = this.server.config?.directory;
    if (!homeDir)
      throw new Error("Server directory not configured");
    //
    let testDir = path.join(homeDir, user, project, "test");
    if (!fs.existsSync(testDir))
      throw new Error("Test directory not found: " + testDir + " — create test/prompts.md first");
    //
    // Read prompts
    let promptsPath = path.join(testDir, "prompts.md");
    if (!fs.existsSync(promptsPath))
      throw new Error("prompts.md not found at " + promptsPath);
    //
    let content = fs.readFileSync(promptsPath, "utf8");
    let promptCount = (content.match(/^###\s+\d+\./gm) || []).length;
    //
    // Generate next test ID — must be GLOBALLY unique across all projects, because
    // _readTestStatus does a global filesystem scan keyed on testId alone. If two
    // projects each had their own T0012, the resolver would return whichever appears
    // first alphabetically and run_step would target the wrong project.
    let maxId = 0;
    let scanForMaxId = function (dir) {
      if (!fs.existsSync(dir))
        return;
      let entries = fs.readdirSync(dir, {withFileTypes: true});
      for (let e of entries) {
        if (!e.isDirectory())
          continue;
        let m = e.name.match(/^T(\d+)$/);
        if (m) {
          let id = parseInt(m[1]);
          if (id > maxId)
            maxId = id;
        }
      }
    };
    //
    // Scan local test/ folder + log first (cheap path)
    let logPath = path.join(testDir, "test-log.md");
    if (fs.existsSync(logPath)) {
      let logContent = fs.readFileSync(logPath, "utf8");
      let matches = logContent.matchAll(/\|\s*T(\d+)\s*\|/g);
      for (let m of matches) {
        let id = parseInt(m[1]);
        if (id > maxId)
          maxId = id;
      }
    }
    scanForMaxId(testDir);
    //
    // Also scan ALL other projects across all users — global uniqueness guard.
    // Pre-existing per-project numbering means historical testIds collide; this
    // ensures any new testId is higher than the max anywhere on disk.
    // Wrap each user-level readdir in try/catch: a single user directory with
    // permission issues or unexpected entries must NOT prevent any other user
    // from starting tests. The uniqueness guard is best-effort across users.
    let userEntries = fs.readdirSync(homeDir, {withFileTypes: true});
    for (let userEntry of userEntries) {
      if (!userEntry.isDirectory())
        continue;
      let userProjectsDir = path.join(homeDir, userEntry.name);
      let projEntries;
      try {
        projEntries = fs.readdirSync(userProjectsDir, {withFileTypes: true});
      }
      catch (e) {
        console.warn(`[MCP] _startTest: skipping user "${userEntry.name}" — readdir failed: ${e.message}`);
        continue;
      }
      for (let projEntry of projEntries) {
        if (!projEntry.isDirectory())
          continue;
        scanForMaxId(path.join(userProjectsDir, projEntry.name, "test"));
      }
    }
    //
    let testId = "T" + String(maxId + 1).padStart(4, "0");
    let testPath = path.join(testDir, testId);
    fs.mkdirSync(testPath, {recursive: true});
    //
    // Clean slate AND no peeking at previous runs. The agent can grep its whole
    // project tree, so any prior-run artifact left under it leaks earlier solutions.
    // A failed cleanup invalidates the test: do not continue with previous state.
    //   - inde-agent/projects/ : per-project agent state — the <uuid>.jsonl session
    //     transcripts (full prior conversations), tool-results/ (cached prior tool
    //     outputs = prior projected file contents) and memory/.
    //   - flightlog/           : flight recorder — conversation + projection snapshots
    //     of previous runs (the originally-observed grep leak).
    //   - projected/          : generated files and the previous model's sync state.
    //   - inde-agent/codex-history/ and codex/ : Astra conversations and runtime state.
    // We deliberately KEEP the inde-agent top level: it holds the model auth
    // (.vertex-sa.json), .claude.json and plugins/ the agent needs to launch — wiping
    // those would break the run, not just clear history.
    let projectDir = path.join(homeDir, user, project);
    let wipeDir = (dir, label) => {
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, {recursive: true, force: true});
          console.log(`[MCP] _startTest: wiped ${label} (${dir})`);
        }
      }
      catch (e) {
        throw new Error(`Failed to clean ${label}: ${e.message}`);
      }
    };
    wipeDir(path.join(projectDir, "projected"), "projected workspace");
    wipeDir(path.join(projectDir, "inde-agent", "projects"), "agent state");
    wipeDir(path.join(projectDir, "inde-agent", "codex-history"), "Codex conversation history");
    // The live runtime was closed by test_prepare_new. Keep the authentication
    // recovery cache: it may be the only copy of a refresh not yet persisted.
    let codexDir = path.join(projectDir, "inde-agent", "codex");
    let preservedCodexFiles = ["auth.json", "config.toml"];
    if (fs.existsSync(codexDir)) {
      for (let name of fs.readdirSync(codexDir)) {
        if (!preservedCodexFiles.includes(name))
          wipeDir(path.join(codexDir, name), "Codex runtime state");
      }
    }
    wipeDir(path.join(projectDir, "flightlog"), "flight-log");
    //
    // Check for gold standard
    let goldDir = path.join(testDir, "gold");
    let goldSteps = [];
    if (fs.existsSync(goldDir)) {
      let goldEntries = fs.readdirSync(goldDir, {withFileTypes: true});
      for (let e of goldEntries) {
        if (e.isDirectory() && e.name.startsWith("step-")) {
          let stepNum = parseInt(e.name.replace("step-", ""));
          if (!isNaN(stepNum))
            goldSteps.push(stepNum);
        }
      }
      goldSteps.sort((a, b) => a - b);
    }
    //
    // Write status.json
    let status = {
      testId: testId,
      project: project,
      user: user,
      model: model || null,
      provider: provider || null,
      modelRequested: !!model || !!provider,
      thinkingEffort: thinkingEffort || null,
      browser: browser || null,
      startedAt: new Date().toISOString(),
      currentStep: 0,
      steps: []
    };
    fs.writeFileSync(path.join(testPath, "status.json"), JSON.stringify(status, null, 2));
    //
    console.log(`[MCP] Started test ${testId} for ${user}/${project}, ${promptCount} prompts, ${goldSteps.length} gold steps`);
    //
    return {
      testId: testId,
      testPath: testPath,
      promptCount: promptCount,
      hasGold: goldSteps.length > 0,
      goldSteps: goldSteps,
      model: model || null,
      provider: provider || null,
      modelRequested: !!model || !!provider,
      thinkingEffort: thinkingEffort || null,
      browser: browser || null
    };
  }


  /**
   * Finalize a test session: compute summary, append to test-log.md.
   * Filesystem-only — does NOT require an active IDE session, so it works
   * regardless of which project (if any) is currently open. Mirrors what
   * Node.Child.prototype._handleTestFinalize used to do in the IDE child,
   * which was tied to the open project's `_getTestDir()` and broke the
   * cross-project finalize workflow.
   * @param {String} testId - Test ID (e.g., "T0050")
   * @param {String} [notes] - Optional notes for the log entry
   * @returns {Object} {testId, totalSteps, totalDuration (minutes), matches, improvements, regressions}
   * @private
   */
  _finalizeTest(testId, notes)
  {
    let fs = require("fs");
    let path = require("path");
    //
    // Resolve testPath via global filesystem scan keyed on testId.
    let status = this._readTestStatus(testId);
    if (!status)
      throw new Error("status.json not found for " + testId);
    //
    let homeDir = this.server.config?.directory;
    if (!homeDir)
      throw new Error("Server directory not configured");
    let testDir = path.join(homeDir, status.user, status.project, "test");
    let testPath = path.join(testDir, testId);
    let statusPath = path.join(testPath, "status.json");
    //
    // Compute summary
    // `superseded` entries describe a run that was set aside (its artifacts live in <step>.prev):
    // they are kept so the backup stays promotable, but they are not steps of this campaign. One
    // entry per step used to be an invariant of status.json, and these two lines rested on it —
    // counted here, a retried step would appear twice in test-log.md and its abandoned duration
    // would be added to the good one. That line is appended once and never recomputed.
    let realSteps = (status.steps || []).filter(s => s.status !== "superseded");
    let totalSteps = realSteps.length;
    let totalDuration = realSteps.reduce((sum, s) => sum + (s.totalDuration || 0), 0);
    let durationMin = Math.round(totalDuration / 60);
    let matches = realSteps.filter(s => s.verdict === "match").length;
    let improvements = realSteps.filter(s => s.verdict === "improvement").length;
    let regressions = realSteps.filter(s => s.verdict === "regression").length;
    //
    // Append entry to test-log.md. Use appendFileSync rather than read+write so
    // two concurrent finalize_test calls (improbable in single-user, possible in
    // multi-project workflow) can't lose an entry. If the file is missing we
    // seed the header first; afterwards every write is append-only.
    let logPath = path.join(testDir, "test-log.md");
    if (!fs.existsSync(logPath))
      fs.writeFileSync(logPath, "# Test Log\n\n| ID | Data | Durata | Step | Match | Migliori | Regressioni | Note |\n|----|------|--------|------|-------|----------|-------------|------|\n");
    //
    let dateStr = new Date().toISOString().slice(0, 16).replace("T", " ");
    let notesStr = notes || "";
    if (status.model)
      notesStr = (status.model + (status.thinkingEffort ? "/" + status.thinkingEffort : "") + " " + notesStr).trim();
    // Escape pipes so notes containing `|` don't break the Markdown table layout.
    // Sanitize for the Markdown table row: escape pipes to avoid breaking the
    // column layout, AND collapse newlines so multi-line notes (autoMode-supplied
    // captions) don't split across rows.
    notesStr = notesStr.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
    let logLine = `| ${testId} | ${dateStr} | ${durationMin}min | ${totalSteps} | ${matches} | ${improvements} | ${regressions} | ${notesStr} |\n`;
    fs.appendFileSync(logPath, logLine);
    //
    // Mark status.json as finalized so subsequent calls are idempotent (and visible in UI).
    status.finalizedAt = new Date().toISOString();
    if (notes)
      status.finalNotes = notes;
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
    //
    console.log(`[MCP] Finalized ${testId}: ${totalSteps} steps, ${matches} match, ${improvements} improved, ${regressions} regression`);
    //
    return {
      testId: testId,
      totalSteps: totalSteps,
      totalDuration: durationMin,
      matches: matches,
      improvements: improvements,
      regressions: regressions
    };
  }


  /**
   * Read test status.json directly from filesystem (no active session needed).
   * Scans all user/project directories under inderthome for the testId.
   *
   * `user` is the DIRECTORY the file was found in, always, and it overwrites whatever the file
   * itself declares. That is the invariant the three testId-driven tools rest on: the account
   * their gate measures cannot be written into a status.json, and it cannot be missing — 9 of the
   * park's 226 files carry no `user` field and are still attributed to their own account, which
   * is why the `|| "<account>"` fallbacks these call sites used to carry never once ran (#15862).
   * @param {String} testId - Test ID (e.g., "T0001")
   * @returns {Object|null} Parsed status.json whose 'user' is the owning directory, or null
   * @private
   */
  _readTestStatus(testId)
  {
    let fs = require("fs");
    let path = require("path");
    let homeDir = this.server.config?.directory;
    if (!homeDir)
      return null;
    //
    // Collect ALL matches across user/project tree, then disambiguate by `startedAt`
    // (most recent wins). New testIds allocated by _startTest are globally unique,
    // so this only matters for legacy/colliding testIds created before the fix:
    // alphabetical-first behavior could pick the wrong project (e.g. gattini-test
    // before nwind-shadow). Most-recent-wins matches "the test the user just started".
    let candidates = [];
    let users = fs.readdirSync(homeDir, {withFileTypes: true});
    for (let userEntry of users) {
      if (!userEntry.isDirectory())
        continue;
      let userDir = path.join(homeDir, userEntry.name);
      let projects = fs.readdirSync(userDir, {withFileTypes: true});
      for (let projEntry of projects) {
        if (!projEntry.isDirectory())
          continue;
        let statusPath = path.join(userDir, projEntry.name, "test", testId, "status.json");
        if (fs.existsSync(statusPath)) {
          let status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
          status.user = userEntry.name;
          candidates.push(status);
        }
      }
    }
    if (candidates.length === 0)
      return null;
    if (candidates.length === 1)
      return candidates[0];
    //
    // Multiple matches — pick the most recently started.
    candidates.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
    console.log(`[MCP] _readTestStatus: ${candidates.length} matches for ${testId}, picked ${candidates[0].project} (startedAt ${candidates[0].startedAt})`);
    return candidates[0];
  }


  /**
   * Open a project's IDE tab by navigating a browser to the project URL.
   * Default: a page in the shared headless (Puppeteer) browser, so tests run without
   * touching the user's desktop Chrome. Mode resolution: explicit `browser` argument
   * (from start_test / start_prospect_session) → INDE_MCP_BROWSER env var → headless.
   * "chrome" opens a visible tab in Google Chrome (legacy behavior); the same path is
   * used as fallback if the headless browser cannot be launched.
   * @param {String} userName - User name
   * @param {String} projectName - Project name
   * @param {String} [browser] - "headless" (default) or "chrome"
   * @param {String} [origin="test"] - Origin stamped on the session about to be created
   *   ("test" for the harness flows, "console" for the console flow). Travels in the /edit
   *   URL so it reaches the IDESession constructor on EVERY opening path — headless and
   *   visible Chrome alike (decision A)
   * @param {Boolean} [readOnly=false] - Open through /view instead of /edit: a READ-ONLY session
   *   that the server creates beside any existing one instead of refusing it (run_tests on a
   *   project nobody has open — nothing of the run writes the model)
   * @private
   */
  async _openProject(userName, projectName, browser, origin, readOnly)
  {
    // encodeURIComponent on each path segment so shell-special chars in user/project
    // names (quotes, backticks, $, ;) can't break out of the URL.
    let safeUser = encodeURIComponent(userName);
    let safeProj = encodeURIComponent(projectName);
    let url = `http://localhost:${this.server.config?.portHttp || 8081}/${safeUser}/${safeProj}/${readOnly ? "view" : "edit"}` +
        `?mcpOrigin=${encodeURIComponent(origin || "test")}`;
    let pageKey = this._projectKey(userName, projectName);
    //
    let mode = browser || process.env.INDE_MCP_BROWSER || "headless";
    if (mode !== "chrome") {
      try {
        await this._openProjectHeadless(url, pageKey);
        return;
      }
      catch (e) {
        console.warn(`[MCP] Headless open failed (${e.message}) — relaunching the browser and retrying once`);
      }
      //
      // Retry once on a FRESH browser: the typical failure is a dead or half-dead
      // instance (browser process gone, page.goto timeout). Close THIS project's browser
      // and relaunch from scratch — the other projects' browsers are not involved.
      await this._closeHeadless(pageKey);
      //
      // No silent fallback to the desktop Chrome here: it breaks the headless contract
      // (no ide-tab.png, capture_ide_tab fails, the prompt injection lands on a tab nobody
      // drives) and costs a full DevAgent timeout before anyone notices (T0311). If this
      // retry throws, the caller gets the error right away and can rerun the step.
      await this._openProjectHeadless(url, pageKey);
      return;
    }
    //
    console.log(`[MCP] Opening project in Google Chrome: ${url}`);
    // `execFile` passes arguments as an array, so no shell interpolation on top of the URL encoding
    require("child_process").execFile("open", ["-a", "Google Chrome", url]);
  }


  /**
   * Open the project URL in a new page of the project's own headless browser.
   * One page per project: a page already driving the same project is closed first,
   * otherwise two IDE tabs would race for the same session.
   * @param {String} url - IDE /edit URL to load
   * @param {String} pageKey - "user/project" key for the headless map
   * @private
   */
  async _openProjectHeadless(url, pageKey)
  {
    let browser = await this._getBrowser(pageKey);
    await this._closeBrowserPage(pageKey);
    //
    let page = await browser.newPage();
    // The entry can have been torn down while newPage was in flight (a close racing the
    // open): re-create it rather than dereferencing a hole
    (this._headless[pageKey] = this._headless[pageKey] || {browser}).page = page;
    //
    // Mark the IDE tab as harness-driven BEFORE navigation: the IDE client checks
    // this flag to auto-approve consent toasts and to switch screen capture to tab
    // capture (see DevAgentView.isHeadlessCapture)
    await page.evaluateOnNewDocument(() => {
      window.INDE_MCP_HEADLESS = true;
    });
    //
    // No user sits in front of a headless page: accept whatever dialog the IDE raises
    // (e.g. beforeunload on close), or it would block the tab forever
    page.on("dialog", dialog => dialog.accept().catch(() => {}));
    page.on("pageerror", err => console.warn(`[MCP] Headless page error (${pageKey}): ${err.message}`));
    //
    console.log(`[MCP] Opening project headless: ${url}`);
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    //
    // The IDE client checks tab visibility in places; make this the active target
    await page.bringToFront();
  }


  /**
   * The user agent the headless browser presents to the IDE server: the browser's own, without
   * the "Headless" tag that makes the app child die before the login (see _cleanUserAgent, which
   * is what applies it, and _launchBrowser, which is where it has to be applied).
   * Only the product token changes, so everything else the client reads from the user agent
   * (platform, engine, version) stays what the real browser reports.
   * @param {String} ua - user agent as reported by browser.userAgent()
   * @returns {String} the same user agent with HeadlessChrome/N read as Chrome/N
   */
  static headlessUserAgent(ua)
  {
    return ua.replace("HeadlessChrome/", "Chrome/");
  }


  /**
   * The user agent every headless browser must be LAUNCHED with: the browser's own, minus the
   * "Headless" token. Learned once per process with a throwaway launch and cached.
   *
   * It has to be a launch flag, and this is the whole point: page.setUserAgent overrides ONE
   * page, and the app never runs in the page we open. Both previews open a NEW WINDOW —
   * FCliApp.startApp with window.open (FCliApp.js:18352, the agent's preview popup being
   * idfPreview.html with the app in an iframe of that popup) and AApp.startClientApp with
   * open(previewUrl) (AApp.js:1306) — so the request Config.processRun classifies as a bot
   * leaves from the popup, which the IDE tab's override never touched. Measured on Chrome 152:
   * with the per-page override the popup still reports HeadlessChrome, with this flag both the
   * tab and the popup report Chrome. Hooking targetcreated instead loses the race with the
   * popup's first request.
   *
   * A failure to learn it is not fatal: we launch without the flag, which is what happened
   * before this existed.
   * @returns {Promise<String|null>} the cured user agent, or null when it could not be learned
   * @private
   */
  static _cleanUserAgent()
  {
    if (!Node.McpServer._cleanUaPromise)
    {
      Node.McpServer._cleanUaPromise = (async () => {
        let puppeteer = require("puppeteer");
        let probe = null;
        try
        {
          probe = await puppeteer.launch({headless: true});
          return Node.McpServer.headlessUserAgent(await probe.userAgent());
        }
        catch (ex)
        {
          // Only the SUCCESS is worth caching. Leaving the rejection in the cache would let one
          // transient failure disable the flag for the whole life of the process, and the symptom
          // is the very one this exists to remove — "the app runtime never answered", long after
          // the single warn scrolled out of the log. Nulling it here costs one extra launch on the
          // next browser and buys a retry.
          Node.McpServer._cleanUaPromise = null;
          console.warn(`[MCP] Could not learn the headless user agent, launching without it: ${ex.message}`);
          return null;
        }
        finally
        {
          if (probe)
            await probe.close().catch(() => {});
        }
      })();
    }
    return Node.McpServer._cleanUaPromise;
  }


  /**
   * Get a project's headless browser instance, launching it on first use.
   * ONE BROWSER PER PROJECT (decision 14-08, point C): there is no shared instance for two
   * opens to race over, and the death of a browser touches by construction only the project
   * that used it. Costs ~1s of launch and one Chrome per open project — the entry to reread
   * when the capacity ceiling gets on the table.
   * Kept alive across steps; relaunched automatically if the previous instance died.
   * @param {String} pageKey - "user/project" key for the headless map
   * @returns {Promise<Object>} Puppeteer Browser instance
   * @private
   */
  async _getBrowser(pageKey)
  {
    let entry = this._headless[pageKey] = this._headless[pageKey] || {};
    //
    // The launch promise is stored SYNCHRONOUSLY, before any await: two concurrent opens of
    // the same project must share one launch, not spawn two Chromes (race C1)
    // The claim above holds on the FIRST launch, but not on a relaunch: there the assignment comes
    // after an await, so two callers that both find the browser dead would both assign, and the
    // second would overwrite the first — two Chromes, one of them orphaned with nobody holding its
    // handle. Only the caller that still finds ITS OWN promise in the entry relaunches; whoever
    // lost the race goes back to await the winner's. Bounded because each turn awaits a different
    // promise: this is a retry, not a spin.
    for (let attempt = 0; attempt < 3; attempt++) {
      let pending = entry.browserPromise;
      if (pending) {
        let browser = await pending.catch(() => null);
        if (browser?.connected)
          return browser;
        if (entry.browserPromise !== pending)
          continue;                       // someone else already relaunched: await theirs
      }
      entry.browserPromise = this._launchBrowser(pageKey);
      try {
        return await entry.browserPromise;
      }
      catch (e) {
        // A failed launch must not poison the entry: the next call retries from scratch
        if (this._headless[pageKey] === entry)
          entry.browserPromise = null;
        throw e;
      }
    }
    throw new Error(`[MCP] Could not obtain a headless browser for ${pageKey}: it died three times in a row`);
  }


  /**
   * Launch a fresh headless browser for a project's IDE tab.
   * @param {String} pageKey - "user/project" whose tab this browser will drive
   * @returns {Promise<Object>} Puppeteer Browser instance
   * @private
   */
  async _launchBrowser(pageKey)
  {
    let puppeteer = require("puppeteer");
    //
    // user-agent: see _cleanUserAgent. It goes here and not on the page because the app runs in
    // a window the preview opens, not in the page we drive.
    let cleanUa = await Node.McpServer._cleanUserAgent();
    let args = [
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--mute-audio",
      "--auto-accept-this-tab-capture",
      "--disable-popup-blocking",
      "--window-size=1600,900"
    ];
    if (cleanUa)
      args.push(`--user-agent=${cleanUa}`);
    //
    let browser = await puppeteer.launch({
      headless: true,
      // Chrome's own stdout/stderr piped to this console: the only way to see WHY the browser
      // process exits when it dies mid-step (T0311: repeated silent deaths, no crash report)
      dumpio: true,
      defaultViewport: {
        width: 1600,
        height: 900
      },
      // The IDE tab does socket + timer work: Chrome must not throttle it when occluded/backgrounded.
      // auto-accept-this-tab-capture: getDisplayMedia({preferCurrentTab}) resolves without the
      // picker — required for capture_screenshot, since nobody can answer a dialog in headless.
      // disable-popup-blocking: the preview of a WEB app is launched with window.open (see
      // DevAgentView.handlePreviewApp), which Chrome swallows as an unsolicited popup when the
      // call doesn't come from a user gesture — and in headless nobody can allow it from the
      // omnibox. Without this flag app_preview fails on web apps ("Preview bloccata dal popup
      // blocker"), while mobile apps keep working: their preview renders in a device frame
      // inside the IDE tab, no window.open involved — which is why the test campaigns, run on
      // mobile projects, never surfaced this.
      args: args
    });
    //
    let entry = this._headless[pageKey];
    if (entry)
      entry.browser = browser;
    browser.on("disconnected", () => this._onBrowserDisconnected(pageKey, browser));
    //
    console.log(`[MCP] Headless browser launched for ${pageKey} (${await browser.version()})`);
    return browser;
  }


  /**
   * Resolve the headless page driving a project's IDE tab.
   * Resolution order: explicit user/project → active session's project → the only
   * open headless tab. Closed pages never match.
   * @param {String} [userName] - User name (used only when projectName is given)
   * @param {String} [projectName] - Project name
   * @returns {Object|null} Puppeteer Page, or null when no live headless tab matches
   * @private
   */
  _resolveHeadlessKey(userName, projectName)
  {
    let alive = key => {
      let page = this._headless[key]?.page;
      return page && !page.isClosed() ? key : null;
    };
    //
    if (projectName)
      return alive(`${userName}/${projectName}`);
    //
    let sess = this._activeSession;
    if (sess?.project?.name) {
      let own = alive(`${sess.project.user?.userName}/${sess.project.name}`);
      if (own)
        return own;
    }
    //
    let liveKeys = Object.keys(this._headless).filter(alive);
    return liveKeys.length === 1 ? liveKeys[0] : null;
  }


  /**
   * The headless page for a project, or null. Thin over {@link _resolveHeadlessKey} on purpose: a
   * caller that must also DECIDE something about the tab needs the key — the fallback branch picks
   * the single live one out of the map, so the owner is nowhere in the arguments — and the two
   * answers have to come from the same three branches. One resolves, the other reads.
   * @param {String} [userName] - Account name (used only when projectName is given, as in the twin)
   * @param {String} [projectName] - Project name; absent, the latch and then the single live tab
   * @returns {Object|null} The puppeteer page, or null
   * @private
   */
  _resolveHeadlessPage(userName, projectName)
  {
    let key = this._resolveHeadlessKey(userName, projectName);
    return key ? this._headless[key]?.page : null;
  }


  /**
   * Save a PNG screenshot of the headless IDE tab into a test step folder.
   * Called at the end of every run_step turn so the step artifacts show what the
   * IDE looked like when the turn ended. Best-effort: never throws, and it's a
   * no-op when the project is not headless-driven (desktop Chrome) or the step
   * folder does not exist yet.
   * @param {String} testId - Test ID (e.g., "T0306")
   * @param {Number} step - Step number (1-based)
   * @returns {Promise<String|null>} Saved file path, or null when skipped/failed
   * @private
   */
  async _saveIdeTabScreenshot(testId, step)
  {
    try {
      let statusInfo = this._readTestStatus(testId);
      if (!statusInfo)
        return null;
      //
      let userName = statusInfo.user;
      let page = this._headless[`${userName}/${statusInfo.project}`]?.page;
      if (!page || page.isClosed())
        return null;
      //
      let homeDir = this.server.config?.directory;
      if (!homeDir)
        return null;
      //
      let fs = require("fs");
      let path = require("path");
      let stepDir = path.join(homeDir, userName, statusInfo.project, "test", testId,
          `step-${String(step).padStart(2, "0")}`);
      // The step folder is created by test_start_step — if it's missing the step never
      // started (or the path is wrong): don't invent folders the evaluators won't scan
      if (!fs.existsSync(stepDir))
        return null;
      //
      let buf = await page.screenshot({type: "png"});
      let filePath = path.join(stepDir, "ide-tab.png");
      fs.writeFileSync(filePath, buf);
      console.log(`[MCP] IDE tab screenshot saved: ${filePath}`);
      return filePath;
    }
    catch (e) {
      console.warn(`[MCP] IDE tab screenshot failed (${testId}/step-${step}): ${e.message}`);
      return null;
    }
  }


  /**
   * Close (if any) the headless page driving a project's IDE tab, keeping the browser
   * alive for a reopen. Idempotent: the page is detached from the entry before the async
   * close, so concurrent calls for the same key are harmless.
   * @param {String} pageKey - "user/project" key in the headless map
   * @private
   */
  async _closeBrowserPage(pageKey)
  {
    let entry = this._headless[pageKey];
    let page = entry?.page;
    if (entry)
      entry.page = null;
    if (!page || page.isClosed())
      return;
    //
    try {
      await page.close();
      console.log(`[MCP] Headless page closed: ${pageKey}`);
    }
    catch (e) {
      console.warn(`[MCP] Headless page close failed (${pageKey}): ${e.message}`);
    }
  }


  /**
   * Tear down a project's whole headless entry: its page AND its browser.
   * Used when the project closes (its browser has no other tab to serve) and by the
   * open retry path to start from scratch. Idempotent.
   * @param {String} pageKey - "user/project" key in the headless map
   * @private
   */
  async _closeHeadless(pageKey)
  {
    let entry = this._headless[pageKey];
    delete this._headless[pageKey];
    if (!entry)
      return;
    //
    await this._closeBrowserPageOf(entry, pageKey);
    try {
      let browser = entry.browser || await entry.browserPromise?.catch(() => null);
      await browser?.close();
    }
    catch (e) {
      console.warn(`[MCP] Headless browser close failed (${pageKey}): ${e.message}`);
    }
  }


  /**
   * Close the page of a detached headless entry (helper of _closeHeadless, which removes
   * the entry from the map before closing — _closeBrowserPage would no longer find it).
   * @param {Object} entry - The detached {browser, page} entry
   * @param {String} pageKey - Its "user/project" key, for the log
   * @private
   */
  async _closeBrowserPageOf(entry, pageKey)
  {
    let page = entry.page;
    entry.page = null;
    if (!page || page.isClosed())
      return;
    //
    try {
      await page.close();
    }
    catch (e) {
      console.warn(`[MCP] Headless page close failed (${pageKey}): ${e.message}`);
    }
  }


  /**
   * Wait until an active IDE session with devAgent is available.
   * When projectName/userName are provided, waits specifically for that project's
   * session — required after _openProject to avoid latching onto a stale session
   * of the previous project (e.g. when switching test between different projects,
   * the previous test's browser tab is still online when the new one is opening).
   * Polls every second until timeout.
   * @param {Number} timeoutMs - Max wait time in milliseconds
   * @param {String} [projectName] - if provided, only sessions for this project match
   * @param {String} [userName] - if provided, only sessions for this user match
   * @param {Boolean} [latch=true] - store the session in _activeSession (test/local flows);
   *   console flows pass false and use the returned session instead
   * @returns {Promise<Node.IDESession>} The ready session
   * @private
   */
  async _waitForSession(timeoutMs, projectName, userName, latch = true)
  {
    let start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let sessions = this.server.getOnlineSessions() || [];
      // When called with project/user filter, pick only the matching session.
      // Otherwise fall back to the first online session (legacy callers).
      let sess = projectName
        ? sessions.find(s =>
          s.project?.name === projectName &&
          (!userName || s.project?.user?.userName === userName))
        : sessions[0];
      if (sess) {
        //
        // Check if devAgent is ready AND browser socket is connected
        let socket = sess.sockets?.[sess.masterClientSod];
        if (sess.project?.user?.devAgentOptions && socket) {
          if (latch)
            this._activeSession = sess;
          console.log(`[MCP] Session ready: project=${sess.project.name}, socket=${sess.masterClientSod}`);
          return sess;
        }
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    let target = projectName ? ` for ${projectName}` : "";
    throw new Error("Timeout waiting for IDE session" + target + " (" + timeoutMs + "ms)");
  }


  /**
   * Wait for the current session for a given project to fully terminate.
   * A close command is fire-and-forget: the browser tab tears down, socket disconnects,
   * master cleans up the session — all async. If we immediately reopen, the new tab
   * can race with the old one's cleanup (double sessions, lost state). Poll until the
   * session disappears from getOnlineSessions(), then add a small grace period so the
   * master finishes any pending finalization.
   * @param {String} projectName - project whose session we're waiting to end
   * @param {String} userName - user owning the session
   * @param {Number} timeoutMs - max wait time (after that we fall through — caller decides)
   * @returns {Promise<Boolean>} true if the session ended cleanly, false on timeout
   * @private
   */
  async _waitForSessionEnd(projectName, userName, timeoutMs)
  {
    let start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let sessions = this.server.getOnlineSessions() || [];
      let stillOpen = sessions.find(s =>
        s.project?.name === projectName && s.project?.user?.userName === userName);
      if (!stillOpen) {
        console.log(`[MCP] Session for ${projectName} ended (+${Date.now() - start}ms)`);
        // Grace period: the master may still be finalizing after the socket dropped
        await new Promise(r => setTimeout(r, 1500));
        // Clear the latch only when it points to the session that just ended — a
        // console-driven close on another project must not unlatch an in-flight test
        if (!this._activeSession?.project ||
            (this._activeSession.project.name === projectName &&
             this._activeSession.project.user?.userName === userName))
          this._activeSession = null;
        //
        // The session is gone: the headless page that drove it (if any) is a dead tab, and
        // with one browser per project its browser has nothing left to serve either
        await this._closeHeadless(`${userName}/${projectName}`);
        return true;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`[MCP] Timeout waiting for session to end after ${timeoutMs}ms — proceeding anyway`);
    return false;
  }


  /**
   * Reset a project to the last commit.
   * Sends the reset command to the browser, which saves pending changes first,
   * then sends the "reset" branch command to the server — same as clicking the
   * Reset button in the Dashboard, but without the confirmation popup.
   * @param {Node.IDESession} [session] - Target session (defaults to the latched _activeSession)
   * @private
   */
  _resetProject(session)
  {
    session = session || this._activeSession;
    if (!session)
      throw new Error("No active IDE session");
    //
    let socket = session.sockets?.[session.masterClientSod];
    if (!socket)
      throw new Error("No browser client connected");
    //
    socket.emit("gc", {
      type: "dev-agent",
      cnt: {type: "mcp_reset_project"}
    });
    //
    console.log(`[MCP] reset_project sent to browser: ${session.project?.name}`);
  }


  /**
   * Get current IDE status
   * @returns {Object}
   * @private
   */
  _getStatus()
  {
    // What the harness is doing right now travels even when no project is open: this is
    // the probe an operator reaches for when the test tools answer "a run_step is in
    // progress", and the answer must say whether that is still true (#15276)
    let inFlight = {
      runStepInFlight: !!this._runStepInFlight,
      pendingAgentRequests: Object.keys(this.pendingRequests).length,
      pendingTestRequests: Object.keys(this.pendingTestRequests).length
    };
    //
    let session = this._activeSession;
    if (!session)
      return {error: "No active session", ...inFlight};
    //
    return {
      project: session.project?.name || "unknown",
      user: session.project?.user?.userName || "unknown",
      ideServerUrl: this.server.config?.getUrl?.() || "unknown",
      devAgentActive: !!session.project?.user?.devAgentOptions,
      sessionId: session.id,
      ...inFlight
    };
  }


  /**
   * A project's headless browser process died: ITS tab died with it — and only its.
   * Fails that project's in-flight DevAgent requests, so the caller (run_step, console
   * send_message) gets a named cause instead of hanging until the 30-minute response
   * timeout (T0311: four mid-step browser deaths, each costing a full timeout wait before
   * recovery could even start). With one browser per project, an incident on one project
   * is no longer an incident for all: the other projects' waiters are left alone.
   * Test commands are spared too: they travel by IPC to the session's child process,
   * which the death of a browser does not touch.
   * @param {String} pageKey - "user/project" whose browser died
   * @param {Object} [browser] - The dead browser (guards against a stale handler firing
   *   after the entry was already replaced by a relaunch)
   * @private
   */
  _onBrowserDisconnected(pageKey, browser)
  {
    let entry = this._headless[pageKey];
    // A stale handler can fire for a browser a relaunch already replaced: only the death
    // of the CURRENT browser drops the entry and fails the project's waiters
    if (entry && browser && entry.browser && entry.browser !== browser)
      return;
    //
    console.warn(`[MCP] Headless browser disconnected (${pageKey})`);
    delete this._headless[pageKey];
    //
    this._failPending(pending => pending.kind === "devagent" && pending.label === pageKey
      ? `Headless browser of ${pageKey} disconnected while waiting for the DevAgent response` : null);
  }


  /**
   * Fail the pending requests selected by `reason`, so their callers learn now that
   * the answer can no longer arrive instead of waiting out their own timeout.
   * The two maps have different contracts and are honoured as such: a DevAgent request
   * rejects, a test command resolves with `{error}` (see `_sendTestCommand`, which never
   * throws by design).
   * @param {String|Function} reason - the failure message, or `(pending) => message`
   *   returning a falsy value for the pendings that must be left alone
   * @returns {Number} How many requests were failed
   * @private
   */
  _failPending(reason)
  {
    let failed = 0;
    let reasonOf = typeof reason === "function" ? reason : () => reason;
    //
    for (let id of Object.keys(this.pendingRequests)) {
      let pending = this.pendingRequests[id];
      let text = reasonOf(pending);
      if (!text)
        continue;
      delete this.pendingRequests[id];
      clearTimeout(pending.timeout);
      failed++;
      console.warn(`[MCP] Pending DevAgent request failed: ${text} (${id})`);
      pending.reject(new Error(text));
    }
    //
    for (let id of Object.keys(this.pendingTestRequests)) {
      let pending = this.pendingTestRequests[id];
      let text = reasonOf(pending);
      if (!text)
        continue;
      delete this.pendingTestRequests[id];
      clearTimeout(pending.timeout);
      failed++;
      console.warn(`[MCP] Pending test command failed: ${text} (${id})`);
      pending.resolve({error: text, sessionLost: true});
    }
    //
    return failed;
  }


  /**
   * Start watching the liveness of whoever must answer the pending requests.
   * Idempotent, and self-stopping: the first tick that finds nothing pending clears
   * the interval, so the watch costs nothing while the server is idle.
   * @private
   */
  _startLivenessWatch()
  {
    if (this._livenessTimer)
      return;
    //
    this._livenessTimer = setInterval(() => this._checkPendingLiveness(), Node.McpServer.LIVENESS_POLL_MS);
    // A supervisor must never be the reason the process stays up
    this._livenessTimer.unref?.();
  }


  /**
   * Stop the liveness watch.
   * @private
   */
  _stopLivenessWatch()
  {
    if (!this._livenessTimer)
      return;
    //
    clearInterval(this._livenessTimer);
    this._livenessTimer = null;
  }


  /**
   * Fail every pending request whose session can no longer deliver an answer.
   *
   * The wait is on a message arriving, not on the liveness of whoever must send it: the
   * response travels from the session's child process, triggered through the master socket
   * of its browser tab. There are three ways to lose it — the browser process dies, the tab
   * is closed, the project is closed — and until #15276 only the first was detected, by a
   * handler on the Puppeteer browser object that is inert when the test drives a visible
   * Chrome. This watch is keyed on the session instead, which is the level the answer
   * actually depends on, and therefore covers all three in either browser mode.
   * @private
   */
  _checkPendingLiveness()
  {
    if (!Object.keys(this.pendingRequests).length && !Object.keys(this.pendingTestRequests).length) {
      this._stopLivenessWatch();
      return;
    }
    //
    let online = this.server.getOnlineSessions?.() || [];
    this._failPending(pending => {
      let session = pending.session;
      let waitingFor = pending.kind === "test" ? "the test command" : "the DevAgent response";
      // No owner recorded (legacy callers): only its own timeout can free this one
      if (!session)
        return null;
      //
      if (!online.some(s => s === session || (s?.id && s.id === session.id)))
        return `the IDE session for ${pending.label} ended while waiting for ${waitingFor}`;
      //
      if (session.sockets?.[session.masterClientSod]) {
        pending.socketLostAt = null;
        return null;
      }
      //
      // A master socket can vanish and come back — reloading the tab does exactly that.
      // Only a loss that outlives the grace window means nobody is left to answer.
      pending.socketLostAt = pending.socketLostAt || Date.now();
      if (Date.now() - pending.socketLostAt < Node.McpServer.SOCKET_GRACE_MS)
        return null;
      return `the browser client of ${pending.label} disconnected while waiting for ${waitingFor}`;
    });
  }


  /**
   * Human-readable identity of a session, for the messages of failed requests.
   * @param {Node.IDESession} session - The session
   * @returns {String} "user/project", or the session id when the project is unknown
   * @private
   */
  _sessionLabel(session)
  {
    let projectName = session?.project?.name;
    if (!projectName)
      return session?.id ? `session ${session.id}` : "an unknown session";
    //
    return `${session.project.user?.userName || "unknown"}/${projectName}`;
  }


  /**
   * Send a message to the DevAgent via the browser.
   * The message is sent to the browser via WebSocket, injected into the NLUX chat,
   * and processed by the DevAgent normally. This ensures the chat UI shows everything.
   * The response is collected via IPC ("mcp_response") from the child process.
   * @param {String} message - The user message
   * @param {String} [selection] - IDE selection context
   * @param {Object} [overrides] - Optional `{model, thinkingEffort}` overrides for this message
   * @param {Node.IDESession} [session] - Target session (defaults to the latched _activeSession)
   * @returns {Promise<Object>} {text, usage, reconciliation}
   * @private
   */
  async _sendMessage(message, selection, overrides, session)
  {
    session = session || this._activeSession;
    if (!session)
      throw new Error("No active IDE session");
    //
    // Find the master socket (the browser client that owns the session)
    let socket = session.sockets?.[session.masterClientSod];
    if (!socket)
      throw new Error("No browser client connected to the IDE session");
    //
    let mcpRequestId = "mcp-" + Date.now() + "-" + Math.random().toString(36).substring(2, 8);
    //
    // Create promise for the response
    let resultPromise = new Promise((resolve, reject) => {
      // 30 minute timeout — agent queries can involve tool calls, reconciliation, app testing;
      // fully-dictated campaign prompts (multi-form steps) routinely run past 15 minutes
      let timeout = setTimeout(() => {
        delete this.pendingRequests[mcpRequestId];
        reject(new Error("DevAgent response timeout (30 min)"));
      }, 1800000);
      //
      // The session travels with the pending request: it is what the liveness watch
      // checks, and the only way to know WHICH waiters a dead session must free (#15276)
      this.pendingRequests[mcpRequestId] = {resolve, reject, text: "", timeout,
        session, label: this._sessionLabel(session), kind: "devagent"};
    });
    this._startLivenessWatch();
    //
    // Build MCP tag with optional model/effort overrides
    let mcpTag = {mcpRequestId};
    if (overrides?.model)
      mcpTag.model = overrides.model;
    if (overrides?.thinkingEffort)
      mcpTag.thinkingEffort = overrides.thinkingEffort;
    //
    // Tell the child process to tag the next DevAgent response for MCP collection
    session.sendToChild({
      type: "mcp_tag",
      cnt: mcpTag
    });
    //
    // Send the message to the browser via the general channel ("gc") — same protocol
    // used by all IDE ↔ browser communication. The DevAgentView listens on "dev-agent" type.
    socket.emit("gc", {
      type: "dev-agent",
      cnt: {
        type: "mcp_inject_message",
        message: message,
        selection: selection || "none",
        // The tag rides ALONG with the message so the child can check that the turn opening on it
        // is this injection and not whatever else reached the composer while the tag waited.
        // The id alone, not the whole `mcpTag`: model and thinkingEffort went over IPC already.
        mcpRequestId: mcpRequestId
      }
    });
    //
    console.log(`[MCP] Injected message via browser: mcpRequestId=${mcpRequestId}, message="${message.substring(0, 80)}..."`);
    //
    return resultPromise;
  }


  /**
   * Handle response from child process (called by server.handleChilderMessage).
   * Matches responses by mcpRequestId (set by mcp_tag before the browser injects the message).
   * @param {String} sessionId - IDE session ID
   * @param {Object} data - {mcpRequestId, type, chunk?, usage?, reconciliation?, error?}
   */
  handleChildResponse(sessionId, data)
  {
    let pending = this.pendingRequests[data.mcpRequestId];
    if (!pending)
      return;
    //
    // The response must come from the session that owes it: a child knowing (or colliding
    // with) a request id must not resolve another session's wait (race C3)
    if (pending.session?.id && sessionId && pending.session.id !== sessionId)
      return console.warn(`[MCP] mcp_response for ${data.mcpRequestId} from session ${sessionId} ignored — the pending belongs to ${pending.session.id}`);
    //
    switch (data.type) {
      case "chunk":
        pending.text += data.chunk || "";
        break;
      //
      case "complete":
        clearTimeout(pending.timeout);
        delete this.pendingRequests[data.mcpRequestId];
        pending.resolve({text: pending.text, usage: data.usage, reconciliation: data.reconciliation});
        console.log(`[MCP] Response complete: mcpRequestId=${data.mcpRequestId}, length=${pending.text.length}`);
        break;
      //
      case "error":
        clearTimeout(pending.timeout);
        delete this.pendingRequests[data.mcpRequestId];
        pending.reject(new Error(data.error || "DevAgent error"));
        console.log(`[MCP] Response error: mcpRequestId=${data.mcpRequestId}, error=${data.error}`);
        break;
    }
  }


  /**
   * Ask only the process of this attempt for partial evidence; failure must preserve the original error.
   * @param {Node.IDESession} session - Explicit project session, never the active-session latch.
   * @param {String} testId - Test identifier.
   * @param {Number} step - Step number.
   * @param {String} attemptId - Identity created before preparing the step.
   * @param {String} error - Original failure.
   * @param {String} stage - Failing phase.
   * @returns {Promise<Object>} Partial archive path or capture error.
   */
  async _captureIncompleteTestStep(session, testId, step, attemptId, error, stage)
  {
    if (!session || !attemptId)
      return {partialCaptureError: "No prepared attempt session is available"};
    //
    try {
      let result = await this._sendTestCommand("test_capture_incomplete", {
        testId,
        step,
        attemptId,
        error,
        stage
      }, session, 10000);
      return result.error ? {partialCaptureError: result.error} : result;
    }
    catch (e) {
      return {partialCaptureError: e.message};
    }
  }


  /**
   * Send a test command to the child process and await the response.
   * Same pattern as _sendMessage but for test lifecycle commands (start_step, end_step, etc.),
   * handled child-side by ide/testHarness.js (loaded lazily on the first command).
   * Never throws on failure: both timeout and child-side errors resolve with an
   * `{error}` object. Callers check `result.error` — this keeps the API symmetric
   * and avoids unhandled-rejection crashes if a caller is no longer awaiting.
   * @param {String} type - IPC message type (e.g., "test_start_step")
   * @param {Object} data - Command-specific data
   * @param {Node.IDESession} [session] - Target session; run_step passes the session of
   *   ITS test explicitly (there is no "current project" to get wrong — T0286), and an
   *   explicit null means "the target is not online" and throws — it must NOT fall back to
   *   the latch, which is whatever project some other flow touched last. Omitting the
   *   argument keeps the latch as default for the tools invoked by hand without parameters
   * @param {Number} [timeoutMs=120000] - How long to wait for the child's answer; the gold
   *   commands fit in 2 minutes, a run_tests over a whole project does not
   * @returns {Promise<Object>} Result from child process, or {error, ...} on failure
   * @private
   */
  async _sendTestCommand(type, data, session, timeoutMs = 120000)
  {
    session = session !== undefined ? session : this._activeSession;
    // _authenticate may store the sentinel `{id: "no-session"}` in _activeSession
    // so the auth handshake itself can succeed before a project is opened. The
    // sentinel is truthy but lacks `sendToChild`, which would otherwise throw a
    // generic TypeError here. Reject explicitly with the real cause.
    if (!session || typeof session.sendToChild !== "function")
      throw new Error("No active IDE session");
    //
    let testRequestId = "test-" + Date.now() + "-" + Math.random().toString(36).substring(2, 8);
    //
    let resultPromise = new Promise(resolve => {
      // 2 minute timeout by default — reset/reproject/build can take time.
      let minutes = Math.round(timeoutMs / 60000);
      let timeout = setTimeout(() => {
        delete this.pendingTestRequests[testRequestId];
        console.log(`[MCP] Test command timeout (${minutes} min): ${type}, testRequestId=${testRequestId}`);
        resolve({error: `Test command timeout (${minutes} min): ` + type, timeout: true});
      }, timeoutMs);
      //
      this.pendingTestRequests[testRequestId] = {resolve, timeout,
        session, label: this._sessionLabel(session), kind: "test"};
    });
    this._startLivenessWatch();
    //
    session.sendToChild({
      type: type,
      cnt: {testRequestId, ...data}
    });
    //
    console.log(`[MCP] Test command sent: type=${type}, testRequestId=${testRequestId}`);
    //
    return resultPromise;
  }


  /**
   * Handle test response from child process (called by server.handleChilderMessage).
   * @param {String} sessionId - IDE session ID
   * @param {Object} data - {testRequestId, ...result}
   */
  handleTestResponse(sessionId, data)
  {
    let pending = this.pendingTestRequests[data.testRequestId];
    if (!pending)
      return;
    //
    clearTimeout(pending.timeout);
    delete this.pendingTestRequests[data.testRequestId];
    //
    // Uniform path: always resolve. Errors travel inside the resolved value as
    // `data.error`, matching the timeout shape. This lets callers do a single
    // `if (result.error)` check without mixing throw-paths and value-paths.
    if (data.error)
      console.log(`[MCP] Test command error: testRequestId=${data.testRequestId}, error=${data.error}`);
    else
      console.log(`[MCP] Test command complete: testRequestId=${data.testRequestId}`);
    pending.resolve(data);
  }
};


/**
 * How often the liveness watch checks that the sessions owing an answer are still alive.
 * Cheap (an array scan over the online sessions) and only running while something is pending,
 * so the interval is chosen for how fast a human notices, not for cost.
 */
Node.McpServer.LIVENESS_POLL_MS = 2000;


/**
 * How long a pending request tolerates the disappearance of its session's master socket
 * before being failed. A socket can drop and come back — reloading the IDE tab does exactly
 * that — so an instantaneous check would kill legitimate waits; a loss that outlives this
 * window means nobody is left to answer.
 */
Node.McpServer.SOCKET_GRACE_MS = 15000;


/**
 * Standing instruction appended by run_step to every test step prompt sent to the agent
 * under test. Asks the agent to surface inconsistencies it notices in the reference docs
 * in a dedicated "Incoerenze reference" section of its final answer, where the step
 * evaluators collect and verify them (see skills test-auto / test-interactive / test-fast).
 * Kept harness-level so the per-project prompts.md files stay identical to the ones the
 * gold snapshots were generated with.
 */
Node.McpServer.REFERENCE_AUDIT_FOOTER = "\n\nNota di servizio: se durante il lavoro noti incoerenze nella documentazione di reference " +
        "(regole che si contraddicono tra loro o con gli esempi, valori o nomi discordanti tra sezioni, esempi che violano le regole dichiarate), " +
        "segnalale in fondo alla tua risposta in una sezione \"Incoerenze reference\", citando per ciascuna il file e la sezione. " +
        "Se non ne hai notate, ometti la sezione. Questa nota non cambia il lavoro richiesto.";


/**
 * How much of the agent's answer `run_step` hands back to its caller. The full text is
 * always on disk in the step folder (`agent-response.txt`); this cap protects the caller's
 * context, and the caller reads the field to decide whether the step did work or only
 * proposed a plan. Sized above the longest answers recorded so far (~4.8 KB) so that
 * decision, and the reference-audit section that closes the answer, are made on the whole
 * text rather than on a head of it.
 */
Node.McpServer.AGENT_RESPONSE_CAP = 10000;


/**
 * The account the local/user tool set falls back to on a LOCAL server when no session is open —
 * the development account these tools have defaulted to since they existed.
 * It survives only there, and only as a fallback: on the cloud the default is the account the
 * key authenticates ({@link Node.McpServer#_defaultAccountName}), because that is the name the
 * account gates judge. On a local server they are all disabled (`config.local`), so this name
 * chooses which project gets opened, never who is allowed to open it.
 * @type {String}
 */
Node.McpServer.LOCAL_ACCOUNT = "andreamaioli";


// Export
/**
 * How long run_tests waits for the child's report: a whole project's scripts, each with
 * its own step timeouts and one app child per app, is not a 2-minute command.
 * @type {Number}
 */
Node.McpServer.RUN_TESTS_TIMEOUT_MS = 30 * 60 * 1000;

module.exports = Node.McpServer;
