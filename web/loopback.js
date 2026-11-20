'use strict';
/*
 * loopback.js - preload for ws-scrcpy: pin its HTTP server to loopback.
 *
 * ws-scrcpy ends up calling server.listen(port) with no host, so node binds
 * 0.0.0.0 and anyone on the LAN can drive the phone over http://<host>:8000,
 * walking straight around the token gate on :9443. run.sh loads this file with
 * `node --require`, so the upstream is only reachable through the gate.
 *
 * Override with WS_BIND_HOST=0.0.0.0 if you really want it exposed (don't).
 */

const net = require('net');

const HOST = process.env.WS_BIND_HOST || '127.0.0.1';
const originalListen = net.Server.prototype.listen;

net.Server.prototype.listen = function listen(...args) {
  const first = args[0];
  if (typeof first === 'number') {
    // listen(port[, host][, backlog][, callback])
    if (typeof args[1] === 'undefined' || typeof args[1] === 'function' || typeof args[1] === 'number') {
      args.splice(1, 0, HOST);
    }
  } else if (first && typeof first === 'object' && 'port' in first && !first.host) {
    // listen({ port }[, callback])
    args[0] = Object.assign({ host: HOST }, first);
  }
  return originalListen.apply(this, args);
};
