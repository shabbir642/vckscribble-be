#!/usr/bin/env node
/**
 * Who holds the host role, through every way a host can drop out.
 *
 * A refresh is simulated by killing the transport (the server sees
 * "transport close", as with a reload or a dropped connection). The Leave
 * button is a client-side disconnect() ("client namespace disconnect").
 *
 * Usage: node scripts/smoke-host.mjs [url]   (takes ~25 s: waits out the grace)
 */
import { io } from 'socket.io-client';

const URL = process.argv[2] ?? 'http://localhost:3001';
const GRACE_MS = 10_000;
let pass = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { failures.push(label); console.log(`  ✗ ${label} ${detail}`); }
}
const connect = () => new Promise((res, rej) => {
  const s = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
  s.once('connect', () => res(s)); s.once('connect_error', rej);
});
const emit = (s, ev, p) => new Promise((res) => s.emit(ev, p, res));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Like a page reload: the connection just dies. */
const refresh = (s) => s.io.engine.close();
const hostOf = (players) => players.find((p) => p.isHost);

/** Creates a room hosted by `name`; returns sockets and the latest roster. */
async function room(name) {
  const s = await connect();
  const roster = { players: [] };
  const r = await emit(s, 'room:create', { name, avatar: 0 });
  return { s, code: r.roomCode, token: r.token, roster };
}
async function joinAs(code, name) {
  const s = await connect();
  const latest = { players: [] };
  s.on('room:players', (p) => { latest.players = p.players; });
  s.on('room:state', (p) => { latest.players = p.players; latest.you = p.you.playerId; });
  const r = await emit(s, 'room:join', { roomCode: code, name, avatar: 1 });
  await sleep(150);
  return { s, token: r.token, latest };
}
async function resume(code, token) {
  const s = await connect();
  const latest = { players: [] };
  s.on('room:players', (p) => { latest.players = p.players; });
  s.on('room:state', (p) => { latest.players = p.players; latest.you = p.you.playerId; });
  const r = await emit(s, 'room:resume', { roomCode: code, token });
  await sleep(150);
  return { s, r, latest };
}

console.log(`\nHost role — ${URL}\n`);

// 1. Host refreshes with a guest present: keeps the role, guest never gets it.
{
  const h = await room('Hana');
  const g = await joinAs(h.code, 'Gus');
  refresh(h.s);
  await sleep(1000);
  check('refreshing host still holds the role during grace', hostOf(g.latest.players)?.name === 'Hana',
    JSON.stringify(g.latest.players.map((p) => [p.name, p.isHost, p.connected])));
  const back = await resume(h.code, h.token);
  check('host back within grace is still host', hostOf(back.latest.players)?.id === back.latest.you);
  check('host can start after a refresh', (await emit(back.s, 'room:start', {})).ok === true);
  await sleep(GRACE_MS + 500);
  check('no late hand-off after the host returned', hostOf(g.latest.players)?.name === 'Hana');
  back.s.close(); g.s.close();
}

// 2. Host drops and does not return: after the grace the guest takes over.
// 3. Host clicks Leave: hand-off is immediate.
// 4. Lone host leaves deliberately: next arrival takes the vacant role.
// (run in parallel with the grace wait of #2)
{
  const h2 = await room('Ivy');
  const g2 = await joinAs(h2.code, 'Jon');
  refresh(h2.s);

  const h3 = await room('Kai');
  const g3 = await joinAs(h3.code, 'Lea');
  h3.s.disconnect();
  await sleep(300);
  check('host who clicks Leave hands over at once', hostOf(g3.latest.players)?.name === 'Lea',
    JSON.stringify(g3.latest.players.map((p) => [p.name, p.isHost])));

  const h4 = await room('Mo');
  h4.s.disconnect();
  await sleep(200);
  const n4 = await joinAs(h4.code, 'Ned');
  check('newcomer to a host-less room becomes host', hostOf(n4.latest.players)?.name === 'Ned',
    JSON.stringify(n4.latest.players.map((p) => [p.name, p.isHost])));
  check('new host can start the game', (await emit(n4.s, 'room:start', {})).ok === false
    /* needs 2 players: proves the host check passed, not NOT_HOST */
    && (await emit(n4.s, 'room:start', {})).code !== 'NOT_HOST');

  await sleep(GRACE_MS + 700);
  check('absent host hands over after the grace', hostOf(g2.latest.players)?.name === 'Jon',
    JSON.stringify(g2.latest.players.map((p) => [p.name, p.isHost, p.connected])));
  const late = await resume(h2.code, h2.token);
  check('host returning after hand-off comes back as a guest',
    late.r.ok && !late.latest.players.find((p) => p.id === late.latest.you)?.isHost);
  late.s.close(); g2.s.close(); g3.s.close(); n4.s.close();
}

// 5. Lone host refreshes: still host (the original bug).
{
  const h = await room('Ola');
  refresh(h.s);
  await sleep(300);
  const back = await resume(h.code, h.token);
  check('lone host who refreshes is still host', hostOf(back.latest.players)?.id === back.latest.you);
  back.s.close();
}

// 6. Restart: host only, not before a game, and back to a clean lobby.
{
  const h = await room('Pia');
  const g = await joinAs(h.code, 'Quin');
  check('cannot restart before the game starts', (await emit(h.s, 'room:restart', {})).code === 'BAD_PHASE');
  await emit(h.s, 'room:start', {});
  await sleep(300);
  check('guest cannot restart', (await emit(g.s, 'room:restart', {})).code === 'NOT_HOST');
  const back = new Promise((res) => g.s.on('round:state', (r) => r.phase === 'lobby' && res(r)));
  check('host restarts mid-game', (await emit(h.s, 'room:restart', {})).ok === true);
  const r = await Promise.race([back, sleep(2000).then(() => null)]);
  check('everyone is back in the lobby', r?.phase === 'lobby' && r.round === 0, JSON.stringify(r));
  await sleep(200);
  check('scores are reset', g.latest.players.every((p) => p.score === 0));
  check('a new game can start', (await emit(h.s, 'room:start', {})).ok === true);
  h.s.close(); g.s.close();
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('failed:', failures.join('; ')); process.exit(1); }
process.exit(0);
