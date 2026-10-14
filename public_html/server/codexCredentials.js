/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2026
 * All rights reserved
 */
"use strict";
var Node = Node || {};

let {randomUUID} = require("node:crypto");
let fs = require("node:fs/promises");
let path = require("node:path");
let store = require("./devAgentOptionsStore");

/**
 * Checks that serialized credentials contain a ChatGPT login rather than an API key.
 * @param {String} auth - Serialized Codex authentication data.
 * @returns {String} Unmodified authentication data after validation.
 */
let validateAuth = auth => {
  if (typeof auth !== "string" || Buffer.byteLength(auth) > 24000)
    throw new Error("Credenziali Codex non valide");
  //
  let value;
  try {
    value = JSON.parse(auth);
  }
  catch {
    throw new Error("Credenziali Codex non valide");
  }
  if (value.OPENAI_API_KEY || typeof value.tokens?.access_token !== "string" ||
    typeof value.tokens?.refresh_token !== "string")
    throw new Error("È richiesto un login ChatGPT Codex");
  //
  return auth;
};

/**
 * Coordinates credential mutations across IDE sessions; model turns use independent tokens.
 * The encrypted DevAgent options in config.json remain the persistent source of truth.
 * @class Node.CodexCredentials
 * @param {Node.Config} config - Server configuration used to persist refreshed credentials.
 */
Node.CodexCredentials = function (config)
{
  this.config = config;
  this.users = new Map();
};

/**
 * Returns the owner's shared lease state, creating its queue on first use.
 * @param {Node.IDESession} session - IDE session whose project owns the account.
 * @returns {Object} Current owner, waiting requests and pending persistence operation.
 */
Node.CodexCredentials.prototype.entry = function (session)
{
  if (!session.project?.user)
    throw new Error("Operazione Codex non consentita");
  //
  let user = session.project.user;
  if (!this.users.has(user))
    this.users.set(user, {
      owner: null,
      queue: [],
      saving: Promise.resolve()
    });
  return this.users.get(user);
};

/**
 * Reads committed credentials or acquires, saves and releases their mutation lease.
 * Only the session holding the lease can persist or clear credentials.
 * @param {Node.IDESession} session - Session that sent the request.
 * @param {Object} request - Credential action, lease identifier and optional authentication data.
 * @returns {Promise<Object>} Action result or the credentials granted with a new lease.
 */
Node.CodexCredentials.prototype.handle = async function (session, request)
{
  let entry = this.entry(session);
  let {action, lease, auth} = request;
  //
  // Reading a committed login never reserves the account for a model turn.
  if (action === "read") {
    await entry.saving;
    if (entry.recoveryFailed)
      throw new Error("Recupero credenziali Codex non completato");
    //
    let current = store.decrypt(session.project.user.devAgentOptions) || {};
    return {auth: current.codexAuth || null};
  }
  //
  // Viewers use the owner's saved login, like the existing DevAgent. Native refresh
  // must still persist, but a viewer cannot disconnect or configure that account.
  if (session.options?.readOnly && action === "clear")
    throw new Error("Configurazione account non disponibile in sola lettura");
  //
  if (action === "acquire") {
    if (entry.owner?.session === session || entry.queue.some(q => q.session === session))
      throw new Error("Il runtime Codex di questa sessione è già occupato");
    //
    return new Promise((resolve, reject) => {
      let item = {
        session,
        authOnly: request.authOnly === true,
        resolve,
        reject
      };
      item.timer = setTimeout(() => {
        entry.queue = entry.queue.filter(q => q !== item);
        reject(new Error("Account Codex occupato da un'altra sessione: riprovare"));
      }, 120000);
      entry.queue.push(item);
      this.next(entry);
    });
  }
  //
  if (action === "cancel") {
    let pending = entry.queue.filter(q => q.session === session);
    entry.queue = entry.queue.filter(q => q.session !== session);
    for (let item of pending) {
      clearTimeout(item.timer);
      item.reject(new Error("Richiesta Codex annullata"));
    }
    return {};
  }
  //
  if (entry.owner?.session !== session || entry.owner.lease !== lease)
    throw new Error("Lease Codex non valido per questa sessione");
  //
  if (["save", "clear"].includes(action)) {
    if (action === "save")
      validateAuth(auth);
    //
    // The current server-side blob may have changed while the model was running.
    entry.saving = entry.saving.catch(() => {}).then(async () => {
      let user = session.project.user;
      let current = store.decrypt(user.devAgentOptions) || {};
      if (action === "clear")
        delete current.codexAuth;
      else
        current.codexAuth = auth;
      user.devAgentOptions = store.encrypt(current);
      await this.config.saveConfig();
      session.invalidateProfileCache?.();
      session.sendToChild?.({
        type: "codex_options",
        cnt: user.devAgentOptions
      });
      //
      // Connecting or disconnecting Codex changes onboarding immediately, like saving an API key.
      if (session.masterClientSod && session.sockets[session.masterClientSod]) {
        try {
          session.sockets[session.masterClientSod].emit(session.constructor.msgTypeMap.profile, session.getProfile());
        }
        catch (err) {
          console.log(`[CodexCredentials] profile push failed: ${err?.message}`);
        }
      }
    });
    await entry.saving;
    entry.recoveryFailed = false;
    return {
      saved: true
    };
  }
  //
  if (action === "release") {
    await entry.saving;
    entry.owner = null;
    this.next(entry);
    return {};
  }
  //
  throw new Error("Operazione credenziali sconosciuta");
};

/**
 * Grants the next waiting session exclusive access to the current credentials.
 * @param {Object} entry - Owner's lease state and waiting queue.
 */
Node.CodexCredentials.prototype.next = function (entry)
{
  if (entry.owner || !entry.queue.length)
    return;
  //
  let item = entry.queue.shift();
  clearTimeout(item.timer);
  let lease = randomUUID();
  entry.owner = {
    session: item.session,
    lease,
    authOnly: item.authOnly
  };
  let current = store.decrypt(item.session.project.user.devAgentOptions) || {};
  item.resolve({
    lease,
    auth: current.codexAuth || null
  });
};

/**
 * Recovers a final credential refresh before releasing a terminated session's lease.
 * A failed recovery blocks reads until a new login or logout is persisted.
 * @param {Node.IDESession} session - IDE session being detached.
 * @returns {Promise<void>} Resolves after recovery and release of the terminated session's lease.
 */
Node.CodexCredentials.prototype.detach = async function (session)
{
  let entry = this.users.get(session.project?.user);
  if (!entry)
    return;
  //
  let cancelled = entry.queue.filter(q => q.session === session);
  entry.queue = entry.queue.filter(q => q.session !== session);
  for (let item of cancelled) {
    clearTimeout(item.timer);
    item.reject(new Error("Sessione IDE chiusa"));
  }
  if (entry.owner?.session !== session)
    return;
  //
  // Recover a renewal written immediately before the child exited, before lending the profile.
  try {
    let home = path.join(session.path, "inde-agent", "codex");
    if (entry.owner.authOnly)
      home = path.join(home, "authentication");
    //
    let auth = await fs.readFile(path.join(home, "auth.json"), "utf8");
    await this.handle(session, {
      action: "save",
      lease: entry.owner.lease,
      auth
    });
    await fs.rm(path.join(home, "auth.json"), {
      force: true
    });
  }
  catch (error) {
    // Keep reads blocked on recovery errors, but allow another session to repair the login.
    if (error.code !== "ENOENT") {
      entry.recoveryFailed = true;
      this.config.logger?.log?.("ERROR", "Recupero credenziali Codex non completato; account in attesa", "CodexCredentials.detach");
    }
  }
  entry.owner = null;
  this.next(entry);
};

module.exports = {
  CodexCredentials: Node.CodexCredentials,
  validateAuth
};
