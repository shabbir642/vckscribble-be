#!/usr/bin/env node
/**
 * The proxy's per-process routes: /s/N/socket.io must reach process N.
 * node scripts/smoke-proxy-shards.mjs http://localhost:8081
 */
import { io } from './lib/io.mjs';
const BASE = process.argv[2] ?? 'http://localhost:8081';
let pass = 0; const failures = [];
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { failures.push(l); console.log(`  ✗ ${l} ${d}`); } };
function shardOf(code, shards) { if (shards <= 1) return 0; let h = 0x811c9dc5; for (const ch of code.toUpperCase()) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h % shards; }
const N = (await (await fetch(`${BASE}/api/shards`)).json()).shards;
const via = (n) => new Promise((res, rej) => { const s = io(BASE, { path: `/s/${n}/socket.io`, transports: ['websocket'], forceNew: true, reconnection: false }); s.once('connect', () => res(s)); s.once('connect_error', rej); });
for (let n = 0; n < N; n++) {
  const s = await via(n);
  const r = await new Promise((res) => s.emit('room:create', { name: `P${n}`, avatar: 0 }, res));
  check(`/s/${n}/socket.io reaches process ${n} (room ${r.roomCode})`, r.ok && shardOf(r.roomCode, N) === n, JSON.stringify(r));
  s.close();
}
console.log(failures.length ? `\n${failures.length} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(failures.length ? 1 : 0);
