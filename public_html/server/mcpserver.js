/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2025
 * All rights reserved
 */

/*
 * MCP Server for DevAgent remote control.
 * Exposes the DevAgent as an MCP server so external tools (Claude Code, etc.)
 * can send messages and receive responses via the Streamable HTTP transport.
 *
 * Architecture:
 *   Claude Code → POST /mcp → Express → McpServer → sendToChild("mcp_chat")
 *   Child process → DevAgent.handleChat() → accumulates response
 *   Child process → IPC "mcp_response" → McpServer → MCP response
 *
 * Tools:
 *   get_status     — returns project name, user, devAgent status
 *   send_message   — sends a message to the DevAgent, waits for complete response
 *   save_project   — saves the current project
 *   close_project  — closes the project without saving
 *   reset_project  — resets the project to the last commit (discards uncommitted changes)
 */

var Node = Node || {};


/**
 * @class MCP Server for DevAgent
 * @param {Node.Server} server - The IDE server instance
 */
Node.McpServer = function (server)
{
  this.server = server;
  this._McpServer = null;         // McpServer class (lazy ESM import)
  this._StreamableHTTPServerTransport = null; // Transport class (lazy ESM import)
  this.pendingRequests = {};      // mcpRequestId → {resolve, reject, text, timeout}
};


/**
 * Create a fresh McpServer instance with all tools registered.
 * Called per-request because the SDK requires 1:1 McpServer↔Transport connection.
 * @returns {Object} McpServer instance ready to connect
 * @private
 */
Node.McpServer.prototype._createMcpServer = function ()
{
  let {z} = require("zod");
  //
  let mcpServer = new this._McpServer({
    name: "InDe DevAgent",
    version: "1.0.0"
  });
  //
  // --- Tool: get_status ---
  mcpServer.tool("get_status",
    "Returns the current IDE status: open project, user, DevAgent state",
    {},
    async () => {
      let status = this._getStatus();
      return {content: [{type: "text", text: JSON.stringify(status, null, 2)}]};
    }
  );
  //
  // --- Tool: send_message ---
  mcpServer.tool("send_message",
    "Sends a natural language message to the DevAgent. The message appears in the IDE chat. Returns the agent's complete response.",
    {
      message: z.string().describe("The message to send to the DevAgent"),
      selection: z.string().optional().describe("IDE selection context (e.g. 'AppName > ViewName > $element')"),
      model: z.enum(["claude-opus-4-6[1m]", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]).optional()
          .describe("Override the AI model for this message only (does not change persistent settings)"),
      thinkingEffort: z.enum(["low", "medium", "high"]).optional()
          .describe("Override the thinking effort for this message only")
    },
    async ({message, selection, model, thinkingEffort}) => {
      try {
        let result = await this._sendMessage(message, selection, {model, thinkingEffort});
        return {content: [{type: "text", text: result.text}]};
      }
      catch (e) {
        return {content: [{type: "text", text: `Error: ${e.message}`}], isError: true};
      }
    }
  );
  //
  // --- Tool: save_project ---
  mcpServer.tool("save_project",
    "Saves the current project. Use this to persist changes made by the DevAgent.",
    {},
    async () => {
      try {
        this._saveProject();
        return {content: [{type: "text", text: "Project save command sent"}]};
      }
      catch (e) {
        return {content: [{type: "text", text: `Error: ${e.message}`}], isError: true};
      }
    }
  );
  //
  // --- Tool: close_project ---
  mcpServer.tool("close_project",
    "Closes the current project without saving. Use this after testing to discard all changes made by the DevAgent.",
    {},
    async () => {
      try {
        this._closeProject();
        return {content: [{type: "text", text: "Project closed without saving"}]};
      }
      catch (e) {
        return {content: [{type: "text", text: `Error: ${e.message}`}], isError: true};
      }
    }
  );
  //
  // --- Tool: reset_project ---
  mcpServer.tool("reset_project",
    "Resets the current project to the last commit. Discards all uncommitted changes. Use this to restore the project to a known state before running tests.",
    {},
    async () => {
      try {
        this._resetProject();
        return {content: [{type: "text", text: "Project reset to last commit"}]};
      }
      catch (e) {
        return {content: [{type: "text", text: `Error: ${e.message}`}], isError: true};
      }
    }
  );
  //
  return mcpServer;
};


/**
 * Express handler for MCP requests (POST /mcp, GET /mcp, DELETE /mcp).
 * @param {Request} req - Express request
 * @param {Response} res - Express response
 */
Node.McpServer.prototype.handleRequest = async function (req, res)
{
  try {
    // Authenticate
    let session = this._authenticate(req);
    if (!session) {
      res.status(401).json({error: "Unauthorized — invalid or missing API key"});
      return;
    }
    //
    // Store active session for tool handlers
    this._activeSession = session;
    //
    // Lazy-load ESM modules once
    if (!this._McpServer) {
      let mcpMod = await import("@modelcontextprotocol/sdk/server/mcp.js");
      let httpMod = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
      this._McpServer = mcpMod.McpServer;
      this._StreamableHTTPServerTransport = httpMod.StreamableHTTPServerTransport;
    }
    //
    // Create fresh McpServer + transport per request (SDK requires 1:1 connect)
    let mcpServer = this._createMcpServer();
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
};


/**
 * Authenticate request via Bearer token in Authorization header.
 * - Local server (config.local): auto-generated key saved to filesystem
 * - Cloud server: validates against user's mcpApiKey (future)
 * @param {Request} req
 * @returns {Node.IDESession|null}
 * @private
 */
Node.McpServer.prototype._authenticate = function (req)
{
  let authHeader = req.headers.authorization || "";
  let token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token)
    return null;
  //
  let sessions = this.server.getOnlineSessions();
  //
  // Local server: validate against auto-generated key (stored in filesystem)
  if (this.server.config?.local) {
    let localKey = this._getLocalKey();
    if (token === localKey && sessions.length > 0) {
      let sess = sessions[0];
      console.log(`[MCP] Local auth: user=${sess.project?.user?.userName}, project=${sess.project?.name}`);
      return sess;
    }
    return null;
  }
  //
  // Cloud server: match token against user's mcpApiKey
  for (let sess of sessions) {
    let mcpKey = sess.project?.user?.mcpApiKey;
    if (mcpKey && mcpKey === token) {
      console.log(`[MCP] Authenticated: user=${sess.project.user.userName}, project=${sess.project.name}`);
      return sess;
    }
  }
  //
  return null;
};


/**
 * Get or create the local MCP API key.
 * Stored in a file alongside the server config — only readable by the local user.
 * @returns {String} The API key
 * @private
 */
Node.McpServer.prototype._getLocalKey = function ()
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
};


/**
 * Save the current project.
 * Sends saveDocument command to the child process via the general channel.
 * @private
 */
Node.McpServer.prototype._saveProject = function ()
{
  let session = this._activeSession;
  if (!session)
    throw new Error("No active IDE session");
  //
  // Send save command to the browser client — same pattern as close_project
  // The browser calls InDe.theApp.saveDocument() which handles both client and server save
  let socket = session.sockets?.[session.masterClientSod];
  if (!socket)
    throw new Error("No browser client connected");
  //
  socket.emit("gc", {
    type: "dev-agent",
    cnt: {type: "mcp_save_project"}
  });
  //
  console.log(`[MCP] save_project sent to browser: ${session.project?.name}`);
};


/**
 * Close the current project without saving.
 * Sends a command to the browser client, which closes the document properly.
 * @private
 */
Node.McpServer.prototype._closeProject = function ()
{
  let session = this._activeSession;
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
};


/**
 * Reset the current project to the last commit.
 * Sends the reset command to the browser, which saves pending changes first,
 * then sends the "reset" branch command to the server — same as clicking the
 * Reset button in the Dashboard, but without the confirmation popup.
 * @private
 */
Node.McpServer.prototype._resetProject = function ()
{
  let session = this._activeSession;
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
};


/**
 * Get current IDE status
 * @returns {Object}
 * @private
 */
Node.McpServer.prototype._getStatus = function ()
{
  let session = this._activeSession;
  if (!session)
    return {error: "No active session"};
  //
  return {
    project: session.project?.name || "unknown",
    user: session.project?.user?.userName || "unknown",
    ideServerUrl: this.server.config?.getUrl?.() || "unknown",
    devAgentActive: !!session.project?.user?.devAgentOptions,
    sessionId: session.id
  };
};


/**
 * Send a message to the DevAgent via the browser.
 * The message is sent to the browser via WebSocket, injected into the NLUX chat,
 * and processed by the DevAgent normally. This ensures the chat UI shows everything.
 * The response is collected via IPC ("mcp_response") from the child process.
 * @param {String} message - The user message
 * @param {String} [selection] - IDE selection context
 * @returns {Promise<Object>} {text, usage, reconciliation}
 * @private
 */
Node.McpServer.prototype._sendMessage = async function (message, selection, overrides)
{
  let session = this._activeSession;
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
    // 10 minute timeout — agent queries can involve tool calls, reconciliation, app testing
    let timeout = setTimeout(() => {
      delete this.pendingRequests[mcpRequestId];
      reject(new Error("DevAgent response timeout (10 min)"));
    }, 600000);
    //
    this.pendingRequests[mcpRequestId] = {resolve, reject, text: "", timeout};
  });
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
      selection: selection || "none"
    }
  });
  //
  console.log(`[MCP] Injected message via browser: mcpRequestId=${mcpRequestId}, message="${message.substring(0, 80)}..."`);
  //
  return resultPromise;
};


/**
 * Handle response from child process (called by server.handleChilderMessage).
 * Matches responses by mcpRequestId (set by mcp_tag before the browser injects the message).
 * @param {String} sessionId - IDE session ID
 * @param {Object} data - {mcpRequestId, type, chunk?, usage?, reconciliation?, error?}
 */
Node.McpServer.prototype.handleChildResponse = function (sessionId, data)
{
  let pending = this.pendingRequests[data.mcpRequestId];
  if (!pending)
    return;
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
};


// Export
module.exports = Node.McpServer;
