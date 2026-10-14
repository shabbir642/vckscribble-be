/**
 * socket.io-client, but delivering messages the way a browser does: one per
 * task. Node's `ws` otherwise fires every message that arrived in the same
 * network packet in one go, before an `await` on the first can attach a
 * listener for the next. uWebSockets.js batches a reply and the events that
 * follow it into one packet, so "emit, await the ack, then wait for the
 * event" would miss the event in a test, where a browser never would.
 */
import { createRequire } from 'node:module';
import { io as baseIo } from 'socket.io-client';

const require = createRequire(createRequire(import.meta.url).resolve('socket.io-client'));
const { NodeWebSocket } = require('engine.io-client');

class BrowserLikeWebSocket extends NodeWebSocket {
  createSocket(uri, protocols, opts) {
    return super.createSocket(uri, protocols, { ...opts, allowSynchronousEvents: false });
  }
}

export function io(url, opts = {}) {
  const wantsWs = !opts.transports || opts.transports.includes('websocket');
  return baseIo(url, wantsWs ? { ...opts, transports: [BrowserLikeWebSocket] } : opts);
}
