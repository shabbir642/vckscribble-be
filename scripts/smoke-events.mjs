#!/usr/bin/env node
/**
 * Observability is only worth having if it records what actually happened, so
 * this plays a short game and then reads the events table back.
 */
import { io } from 'socket.io-client';
import Database from 'better-sqlite3';

const URL = process.argv[2] ?? 'http://localhost:3001';
const DB = process.env.DATABASE_URL ?? './data/game.db';
let pass = 0;
const failures = [];
const check = (l, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${l}`); }
  else { failures.push(l); console.log(`  ✗ ${l} ${d}`); }
};
const connect = () => new Promise((res, rej) => {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  s.once('connect', () => res(s)); s.once('connect_error', rej);
});
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const next = (s, ev, ms = 15000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout: ${ev}`)), ms);
  s.once(ev, (p) => { clearTimeout(t); res(p); });
});
const until = (s, ev, pred, ms = 15000) => new Promise((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error(`timeout: ${ev}`)); }, ms);
  const h = (p) => { if (pred(p)) { clearTimeout(t); s.off(ev, h); res(p); } };
  s.on(ev, h);
});

console.log(`\nEvent tracking — ${URL}\n`);

const a = await connect();
const aSt = next(a, 'room:state');
const { roomCode: code } = await emit(a, 'room:create', { name: 'Obs', avatar: 0 });
await aSt;
const b = await connect();
const bSt = next(b, 'room:state');
await emit(b, 'room:join', { roomCode: code, name: 'Watcher', avatar: 1 });
await bSt;
await emit(a, 'room:settings', { rounds: 1, drawSeconds: 30, selectSeconds: 5 });

const opts = next(a, 'word:options');
const assigned = next(a, 'word:assigned');
await emit(a, 'room:start', {});
await opts;
check('custom word rejection is recorded',
  (await emit(a, 'word:custom', { text: 'ab' })).ok === false);
// Subscribe before the guess, not after: `word:assigned` already means the
// drawing phase has been published, so a listener added later never sees it.
const revealed = until(a, 'round:state', (s) => s.phase === 'reveal', 15000);
const word = (await assigned).text;
b.emit('chat:guess', { text: word });
await revealed;

// A client error with no socket involvement, via the beacon.
const beacon = await fetch(`${URL}/api/client-log`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ source: 'window', message: 'smoke beacon', roomCode: code }),
});
check('beacon endpoint accepts a report', beacon.status === 200, `status=${beacon.status}`);
a.emit('client:error', { source: 'render', message: 'smoke socket error' });
await new Promise((r) => setTimeout(r, 500));

const db = new Database(DB, { readonly: true });
const rows = db.prepare('SELECT type, player_name, data FROM events WHERE room_code = ?').all(code);
const types = rows.map((r) => r.type);
const has = (t) => types.includes(t);

check('room_created recorded', has('room_created'));
check('player_joined recorded', has('player_joined'));
check('game_started recorded', has('game_started'));
check('turn_started recorded', has('turn_started'));
check('turn_ended recorded', has('turn_ended'));
check('rejected custom word recorded', rows.some(
  (r) => r.type === 'custom_word' && JSON.parse(r.data).accepted === false));
check('client error recorded from both paths',
  rows.filter((r) => r.type === 'client_error').length === 2,
  `${rows.filter((r) => r.type === 'client_error').length} of 2`);
check('player names are captured', rows.some((r) => r.player_name === 'Obs'));

const ended = rows.find((r) => r.type === 'turn_ended');
const d = ended ? JSON.parse(ended.data) : {};
check('turn_ended carries the outcome',
  d.reason === 'all-guessed' && d.solved === 1 && d.guessers === 1,
  JSON.stringify(d));

db.close();
a.disconnect(); b.disconnect();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('failed:', failures.join('; ')); process.exit(1); }
