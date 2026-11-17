/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2026
 * All rights reserved
 */
var Node = Node || {};

Node.fs = require("fs").promises;
Node.path = require("path");
Node.Utils = require("./utils");


/**
 * Account-wide onboarding allowance. The master serializes requests from all project workers.
 * Project indices retain gross costs; durable high-water marks prevent deletion/rollback of an
 * index from refunding the account. Gifts credit the shared balance without erasing history.
 */
Node.OnboardingBudget = class OnboardingBudget
{
  static queues = new Map();
  static providerIndices = ["codex-history", "codex-deepseek-history", "codex-mistral-history"];
  static resetFlags = {
    share: "lifetimeResetUsedShare",
    book: "lifetimeResetUsedBook",
    connector: "lifetimeResetUsedConnector"
  };


  /**
   * Read, claim a threshold warning, or consume a gift for the authenticated session's user.
   * User, project and limit come from the master, never from the worker's request payload.
   * The day uses UTC, consistently with the existing daily cost indices.
   * @param {Node.User} user
   * @param {Node.Project} project
   * @param {Object} command - {action: "read"|"warn"|"reset", resetType?: String}
   * @returns {Promise<Object>} Shared balance, canonical flags, and optional grant/warning
   */
  static request(user, project, command)
  {
    if (!["read", "warn", "reset"].includes(command?.action) ||
        (command.action === "reset" && !Object.hasOwn(this.resetFlags, command.resetType)))
      return Promise.reject(new Error("Invalid onboarding budget command"));
    // Account files belong to the user directory even when IdsPrjDir is shared.
    let filename = Node.path.resolve(user.config.directory, user.userName, ".devagent-onboarding-budget.json");
    let previous = this.queues.get(filename) || Promise.resolve();
    let operation = previous.catch(() => {}).then(() => this.update(filename, user, project, command));
    this.queues.set(filename, operation);
    operation.finally(() => {
      if (this.queues.get(filename) === operation)
        this.queues.delete(filename);
    }).catch(() => {});
    return operation;
  }


  /** Perform one serialized transaction, reloading durable state after any previous failure. */
  static async update(filename, user, project, command)
  {
    let today = new Date().toISOString().substring(0, 10);
    let ledger;
    try {
      ledger = JSON.parse(await Node.fs.readFile(filename, "utf8"));
      if (ledger.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(ledger.day) ||
          !ledger.streams || typeof ledger.streams !== "object" || Array.isArray(ledger.streams) ||
          Object.values(ledger.streams).some(v => !Number.isFinite(v) || v < 0) ||
          !Number.isFinite(ledger.creditsUsd) || ledger.creditsUsd < 0 ||
          !Array.isArray(ledger.warningsSent) || !ledger.lifetimeResets)
        throw new Error("Invalid onboarding budget ledger");
    }
    catch (err) {
      if (err.code !== "ENOENT")
        throw err;
      ledger = {
        version: 1,
        lifetimeResets: {}
      };
    }
    if (ledger.day !== today) {
      ledger.day = today;
      ledger.streams = {};
      ledger.creditsUsd = 0;
      ledger.warningsSent = [];
    }
    // Existing lifetime gifts survive migration, day rollover, and stale worker snapshots.
    for (let [type, flag] of Object.entries(this.resetFlags)) {
      if (user.onboardingState?.[flag])
        ledger.lifetimeResets[type] = true;
    }
    //
    let projects = new Map((user.projects || []).map(p => [p.id || p.name, p]));
    projects.set(project.id || project.name, project);
    for (let [id, p] of projects) {
      let agentDir = Node.path.join(user.getProjectsDir(), p.name, "inde-agent");
      let claudeDir = Node.path.join(agentDir, "projects");
      let entries;
      try {
        entries = await Node.fs.readdir(claudeDir, {
          withFileTypes: true
        });
      }
      catch (err) {
        if (err.code !== "ENOENT")
          throw err;
        entries = [];
      }
      let indices = entries.filter(e => e.isDirectory()).map(e => `projects/${e.name}`);
      indices.push(...this.providerIndices);
      for (let relative of indices) {
        let index;
        try {
          index = JSON.parse(await Node.fs.readFile(Node.path.join(agentDir, relative, "sessions-index.json"), "utf8"));
        }
        catch (err) {
          if (err.code === "ENOENT" || err instanceof SyntaxError)
            continue;
          //
          throw err;
        }
        let cost = index.dailyCosts?.[today]?.costUsd ?? 0;
        if (!Number.isFinite(cost) || cost < 0)
          throw new Error("Invalid onboarding daily cost");
        let key = JSON.stringify([id, relative]);
        ledger.streams[key] = Math.max(ledger.streams[key] || 0, cost);
      }
    }
    //
    let grossCost = parseFloat(Object.values(ledger.streams).reduce((sum, cost) => sum + cost, 0).toFixed(6));
    let maxDaily = user.config.devAgentDailyBudget || 8;
    let dailyCost = parseFloat(Math.max(0, grossCost - ledger.creditsUsd).toFixed(6));
    let granted = false;
    if (command.action === "reset" && dailyCost >= maxDaily && !ledger.lifetimeResets[command.resetType]) {
      ledger.lifetimeResets[command.resetType] = true;
      ledger.creditsUsd = grossCost;
      ledger.warningsSent = [];
      dailyCost = 0;
      granted = true;
    }
    let percent = dailyCost / maxDaily * 100;
    let warning = null;
    if (command.action === "warn") {
      let threshold = [90, 70].find(t => percent >= t && !ledger.warningsSent.includes(t));
      if (threshold) {
        // A 90% warning also covers 70%; never send the lower warning afterwards.
        ledger.warningsSent = [70, 90].filter(t => t <= threshold || ledger.warningsSent.includes(t));
        warning = {
          threshold,
          percent: Math.round(percent),
          spentUsd: parseFloat(dailyCost.toFixed(2)),
          budgetUsd: maxDaily,
          remainingUsd: parseFloat((maxDaily - dailyCost).toFixed(2))
        };
      }
    }
    await Node.fs.mkdir(Node.path.dirname(filename), {
      recursive: true
    });
    await Node.Utils.saveObject(filename, ledger);
    // Mirror only monotonic gift flags; progress still belongs to saveOnboardingState.
    let flags = {};
    let changed = false;
    user.onboardingState = user.onboardingState || {};
    for (let [type, flag] of Object.entries(this.resetFlags)) {
      flags[flag] = !!ledger.lifetimeResets[type];
      if (flags[flag] && !user.onboardingState[flag]) {
        user.onboardingState[flag] = true;
        changed = true;
      }
    }
    if (changed) {
      // The ledger already committed the grant. A config mirror failure cannot grant it twice.
      user.config.saveConfig().catch(err => console.error("[OnboardingBudget] Flag mirror failed:", err.message));
    }
    return {
      dailyCost,
      maxDaily,
      percent,
      exhausted: dailyCost >= maxDaily,
      flags,
      granted,
      warning
    };
  }
};

module.exports = Node.OnboardingBudget;
