/*
 * Instant Developer Cloud
 * Copyright Pro Gamma Spa 2000-2021
 * All rights reserved
 */
var Node = Node || {};

/**
 * @class Node.Device
 * @classdesc
 * Represents an Instant Developer Device paired with a server-side session.
 * Wraps the WebSocket used to talk to the physical device and holds the device and user
 * identification data received at registration time.
 *
 * Key features:
 * - **Socket ownership**: Keeps the reference to the WebSocket used to reach the device
 * - **Identity data**: Stores user name, device name, UUID, type and session id of the device
 * - **Command forwarding**: Sends commands from the server to the device via the WebSocket
 *
 * @property {Socket} socket - WebSocket used to communicate with the device
 * @property {String} userName - Name of the user associated with the device
 * @property {String} deviceName - Name of the device
 * @property {String} deviceUuid - Unique identifier of the device
 * @property {String} deviceType - Type of the device (e.g. platform/kind)
 * @property {String} deviceSID - Session identifier of the device (set by {@link Node.Device#init})
 */
Node.Device = class Device
{
  /**
   * @param {Socket} socket - WebSocket used to communicate with the device
   */
  constructor(socket)
  {
    this.socket = socket;
    //
    // Device's data
    this.userName = "";
    this.deviceName = "";
    this.deviceUuid = "";
    this.deviceType = "";
  }


  /**
   * Loads the device and user identity data into this instance.
   * Expected fields on data: userName, deviceName, deviceUuid, deviceType, deviceSID.
   * @param {Object} data - Data payload received from the device at registration
   */
  init(data)
  {
    this.userName = data.userName;
    this.deviceName = data.deviceName;
    this.deviceUuid = data.deviceUuid;
    this.deviceType = data.deviceType;
    this.deviceSID = data.deviceSID;
  }


  /**
   * Sends a command from the server to the device through the WebSocket.
   * Emits an event named after cnt.command carrying cnt.url as payload; if the
   * socket has already been released the call is a no-op.
   * @param {Object} cnt - Command envelope with command (event name) and url (payload) fields
   * @see InDe.Document#sendCommand - Upstream caller that builds the envelope
   */
  sendCommand(cnt)
  {
    this.socket?.emit(cnt.command, cnt.url);
  }
};


// Export module
module.exports = Node.Device;
