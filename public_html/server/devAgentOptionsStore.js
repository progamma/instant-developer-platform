/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2026
 * All rights reserved
 */
"use strict";
var Node = Node || {};


/**
 * Encrypts and merges the existing server-owned DevAgent settings.
 * @namespace Node.DevAgentOptionsStore
 */
Node.DevAgentOptionsStore = {};

// The existing DevAgent cipher and config.json remain the only persistent settings store.
let crypto = require("node:crypto");
let key = crypto.scryptSync("", "salt", 32);


/**
 * Reads DevAgent settings using the existing IDC cipher and returns null for invalid data.
 * @param {String} value - Encrypted settings stored in config.json.
 * @returns {Object|null} Decrypted options or null.
 */
Node.DevAgentOptionsStore.decrypt = function (value)
{
  if (!value)
    return null;
  //
  try {
    let bytes = Buffer.from(value, "base64");
    let cipher = crypto.createDecipheriv("aes-256-cbc", key, bytes.subarray(0, 16));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(16)), cipher.final()]).toString("utf8"));
  }
  catch {
    return null;
  }
};


/**
 * Encrypts DevAgent settings using the existing config.json representation.
 * @param {Object} value - Complete settings to persist.
 * @returns {String} Base64 initialization vector and encrypted JSON.
 */
Node.DevAgentOptionsStore.encrypt = function (value)
{
  let iv = crypto.randomBytes(16);
  let cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([iv, cipher.update(JSON.stringify(value), "utf8"), cipher.final()]).toString("base64");
};


/**
 * Merges a settings update with current server options while preserving server-owned credentials.
 * @param {Object} current - Latest server-side options.
 * @param {Object} incoming - Browser-submitted settings.
 * @param {String[]} [keys] - Changed settings; absent for the legacy replacement protocol.
 * @returns {Object} Updated options without client-controlled credentials or prototype keys.
 */
Node.DevAgentOptionsStore.merge = function (current, incoming, keys)
{
  // Older IDE versions send the complete blob, without patchKeys: preserve their replacement
  // semantics, while credential renewals remain exclusively owned by the Codex coordinator.
  let result = keys ? {
    ...current
  } : {
    ...incoming
  };
  let protectedKeys = ["__proto__", "constructor", "prototype", "codexAuth"];
  for (let name of protectedKeys)
    delete result[name];
  if (Object.hasOwn(current, "codexAuth"))
    result.codexAuth = current.codexAuth;
  for (let name of keys || Object.keys(incoming)) {
    if (protectedKeys.includes(name))
      continue;
    //
    if (Object.hasOwn(incoming, name))
      result[name] = incoming[name];
    else if (name === "apiKey")
      delete result.apiKey;
  }
  if (result.apiKey === null)
    delete result.apiKey;
  return result;
};

module.exports = Node.DevAgentOptionsStore;
