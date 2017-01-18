/*
 * Instant Developer Next
 * Copyright Pro Gamma Spa 2000-2016
 * All rights reserved
 */
/* global module */

var Node = Node || {};

/**
 * @class Represents an Instant Developer Device
 * @param {Socket} socket
 */
Node.Device = function (socket)
{
  this.socket = socket; // Websocket we are using
  //
  // Device's data
  this.userName = "";
  this.deviceName = "";
  this.deviceUuid = "";
  this.deviceType = "";
};


/*
 * Loads data from the device
 * @param {object} data
 */
Node.Device.prototype.init = function (data)
{
  this.userName = data.userName;
  this.deviceName = data.deviceName;
  this.deviceUuid = data.deviceUuid;
  this.deviceType = data.deviceType;
  this.deviceSID = data.deviceSID;
};


/*
 * Sends data from the server to the device. It is used by InDe.Document.sendCommand
 * @param {object} cnt
 */
Node.Device.prototype.sendCommand = function (cnt)
{
  if (this.socket)
    this.socket.emit(cnt.command, cnt.url);
};


// Export module
module.exports = Node.Device;
