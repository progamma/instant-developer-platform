/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
var Node = Node || {};


/**
 * @class Node.IdeVersion
 * @classdesc
 * Represents an IDE version installed on a multi-version server. Each instance is
 * an entry of the `ides` array in `config.json` (sibling of `users`/`projects`/
 * `apps`) and is the authoritative record that a given IDE version is installed,
 * together with the custom NPM packages declared for that version.
 *
 * The `version` string is the one provided by the Console at install time and is
 * also the name of the version folder (`ides/ide_<version>`).
 *
 * @property {Node.Config} parent - Parent configuration object
 * @property {String} version - Installed IDE version (also the `ides/ide_<version>` folder name)
 * @property {Array<String>} customPackages - Custom NPM packages declared for this IDE version
 */
Node.IdeVersion = class IdeVersion
{
  /**
   * @param {Node.Config} par - Parent configuration object
   */
  constructor(par)
  {
    this.parent = par;
    //
    this.customPackages = [];
  }


  /**
   * Gets the parent configuration object.
   * @type {Node.Config}
   * @readonly
   */
  get config()
  {
    return this.parent;
  }


  /**
   * Serializes the IDE version entry for persistence in `config.json`.
   * @returns {Object} Plain representation of the IDE version
   */
  save()
  {
    return {
      cl: "Node.IdeVersion",
      version: this.version,
      customPackages: this.customPackages
    };
  }


  /**
   * Rehydrates the IDE version from a plain object produced by {@link Node.IdeVersion#save}.
   * @param {Object} v - Persisted IDE version data
   */
  load(v)
  {
    this.version = v.version;
    this.customPackages = v.customPackages || [];
  }


  /**
   * Sets the parent configuration object.
   * @param {Node.Config} p - Parent configuration object
   */
  setParent(p)
  {
    this.parent = p;
  }
};


// Export module
module.exports = Node.IdeVersion;
