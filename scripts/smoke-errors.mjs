#!/usr/bin/env node
/**
 * Client error reporting.
 *
 * Nothing is stored — these only become log lines — so this checks that both
 * paths accept a report and neither can be used to flood the server. The beacon
 * matters more than it looks: a socket that never connects is the one failure
 * the backend cannot otherwise see.
 */
import { io } from 'socket.io-client';

const URL = process.argv[2] ?? 'http://localhost:3001';
let pass = 0;
const failures = [];
const check = (l, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${l}`); }
  else { failures.push(l); console.log(`  ✗ ${l} ${d}`); }
};
const post = (body) =>
  fetch(`${URL}/api/client-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

console.log(`\nClient error reporting — ${URL}\n`);

const ok = await post({ source: 'window', message: 'smoke test' });
check('beacon accepts a report', ok.status === 200, `status=${ok.status}`);

const bad = await post({ source: 'nonsense', message: '' });
check('beacon rejects a malformed report', bad.status === 400, `status=${bad.status}`);

let limited = false;
for (let i = 0; i < 25; i++) {
  const r = await post({ source: 'window', message: `flood ${i}` });
  if (r.status === 429) { limited = true; break; }
}
check('beacon rate limits a flood', limited);

const s = io(URL, { transports: ['websocket'], forceNew: true });
await new Promise((res, rej) => { s.once('connect', res); s.once('connect_error', rej); });
// Unseated and malformed reports must both be survivable, not just accepted.
s.emit('client:error', { source: 'render', message: 'smoke socket report' });
s.emit('client:error', { nonsense: true });
await new Promise((r) => setTimeout(r, 300));
check('server survives reports from an unseated socket', s.connected);

const health = await (await fetch(`${URL}/api/health`)).json();
check('health still responds after the flood', health.ok === true);
check('health no longer carries event counts', health.events24h === undefined);

s.disconnect();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('failed:', failures.join('; ')); process.exit(1); }
