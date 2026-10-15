#!/usr/bin/env node
/**
 * Several game-server processes (SHARDS > 1), each owning the rooms whose code
 * hashes to it. Run against a server started with e.g.
 *   SHARDS=3 PORT=3201 node dist/index.js
 * as: node scripts/smoke-shards.mjs http://localhost:3201
 * Process N listens on PORT + N.
 */
import { io } from './lib/io.mjs';

const BASE = new URL(process.argv[2] ?? 'http://localhost:3201');
const urlOf = (shard) => `${BASE.protocol}//${BASE.hostname}:${Number(BASE.port) + shard}`;
let pass = 0;
const failures = [];
const check = (l, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${l}`); }
  else { failures.push(l); console.log(`  ✗ ${l} ${d}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The contract's shardOf, re-implemented: the browser's copy must agree with the server's. */
function shardOf(code, shards) {
  if (shards <= 1) return 0;
  let h = 0x811c9dc5;
  for (const ch of code.toUpperCase()) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % shards;
}
const connect = (shard) => new Promise((res, rej) => {
  const s = io(urlOf(shard), { transports: ['websocket'], forceNew: true, reconnection: false });
  s.once('connect', () => res(s));
  s.once('connect_error', rej);
});
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));

const info = await (await fetch(`${urlOf(0)}/api/shards`)).json();
const N = info.shards;
check('/api/shards reports the process count', N > 1, JSON.stringify(info));

console.log('rooms land on the process that created them');
const rooms = [];
for (let shard = 0; shard < N; shard++) {
  const s = await connect(shard);
  const r = await emit(s, 'room:create', { name: `Host${shard}`, avatar: 0 });
  rooms.push({ shard, code: r.roomCode, token: r.token, sock: s });
  check(`room created on process ${shard} hashes to it (${r.roomCode})`, r.ok && shardOf(r.roomCode, N) === shard, JSON.stringify(r));
}

console.log('the wrong process says so');
const target = rooms[1];
const wrong = await connect(0);
const j = await emit(wrong, 'room:join', { roomCode: target.code, name: 'Lost', avatar: 1 });
check('join on the wrong process -> WRONG_SHARD', !j.ok && j.code === 'WRONG_SHARD', JSON.stringify(j));
const pk = await emit(wrong, 'room:peek', { roomCode: target.code });
check('invite preview on the wrong process -> WRONG_SHARD', !pk.ok && pk.code === 'WRONG_SHARD', JSON.stringify(pk));
const rs = await emit(wrong, 'room:resume', { roomCode: target.code, token: target.token });
check('resume on the wrong process -> WRONG_SHARD', !rs.ok && rs.code === 'WRONG_SHARD', JSON.stringify(rs));
const right = await connect(1);
const j2 = await emit(right, 'room:join', { roomCode: target.code, name: 'Found', avatar: 1 });
check('join on the owning process works', j2.ok, JSON.stringify(j2));
const ghost = await emit(right, 'room:peek', { roomCode: 'ZZZZ'.slice(0, 4) });
check('an unknown code on its own process is still ROOM_NOT_FOUND',
  shardOf('ZZZZ', N) !== 1 ? ghost.code === 'WRONG_SHARD' : ghost.code === 'ROOM_NOT_FOUND', JSON.stringify(ghost));

console.log('the supervisor relays every process\'s load to process 0');
await sleep(11_000);
const h0 = await (await fetch(`${urlOf(0)}/api/health`)).json();
check('process 0 health lists every process', Array.isArray(h0.cluster) && h0.cluster.length === N, JSON.stringify(h0.cluster));
check('each process reports its own rooms', h0.cluster?.every((c) => c.rooms >= 1), JSON.stringify(h0.cluster));

for (const r of rooms) r.sock.close();
wrong.close(); right.close();
console.log(failures.length ? `\n${failures.length} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(failures.length ? 1 : 0);
