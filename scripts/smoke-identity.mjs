#!/usr/bin/env node
/**
 * Identity between games: invite previews, renaming in the lobby, and a
 * returning device reclaiming its seat without its session token.
 *
 * Usage: node scripts/smoke-identity.mjs [url]
 */
import { io } from 'socket.io-client';

const URL = process.argv[2] ?? 'http://localhost:3001';
let pass = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { failures.push(label); console.log(`  ✗ ${label} ${detail}`); }
}
const connect = () => new Promise((res, rej) => {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  s.once('connect', () => res(s)); s.once('connect_error', rej);
});
const emit = (s, ev, p) => new Promise((res) => s.emit(ev, p, res));
const next = (s, ev, ms = 2000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms);
  s.once(ev, (p) => { clearTimeout(t); res(p); });
});

console.log(`\nIdentity & invites — ${URL}\n`);

const host = await connect();
const created = await emit(host, 'room:create', { name: 'Ann', avatar: 1, deviceId: 'device-ann-0001' });
const code = created.roomCode;

// --- invite preview -----------------------------------------------------------
const visitor = await connect();
const peek = await emit(visitor, 'room:peek', { roomCode: code.toLowerCase() });
check('peek describes the room', peek.ok && peek.roomCode === code && peek.hostName === 'Ann' && peek.players === 1 && peek.phase === 'lobby',
  JSON.stringify(peek));
check('peek of a dead code -> ROOM_NOT_FOUND',
  (await emit(visitor, 'room:peek', { roomCode: 'QQQQ' })).code === 'ROOM_NOT_FOUND');
check('peek does not seat you', (await emit(visitor, 'player:update', { name: 'X' })).code === 'ROOM_NOT_FOUND');

// --- rename in lobby ----------------------------------------------------------
const bob = await connect();
const bobState = next(bob, 'room:state');
const hostSawJoin = next(host, 'room:players');
const hostSawJoinMsg = next(host, 'chat:message');
const joined = await emit(bob, 'room:join', { roomCode: code, name: 'Bob', avatar: 2, deviceId: 'device-bob-0001' });
const bobId = (await bobState).you.playerId;
await hostSawJoin; await hostSawJoinMsg; // drain the join broadcast first

const roster = next(host, 'room:players');
const sys = next(host, 'chat:message');
check('rename in lobby accepted', (await emit(bob, 'player:update', { name: 'Robert', avatar: 5 })).ok === true);
const renamed = (await roster).players.find((p) => p.id === bobId);
check('rename broadcast to room', renamed?.name === 'Robert' && renamed?.avatar === 5, JSON.stringify(renamed));
check('rename announced in chat', (await sys).text === 'Bob is now Robert');
check('rename to a taken name -> NAME_TAKEN',
  (await emit(bob, 'player:update', { name: 'ann' })).code === 'NAME_TAKEN');
check('blank rename rejected', (await emit(bob, 'player:update', { name: '   ' })).ok === false);

// --- device reclaims its seat without the token -------------------------------
bob.disconnect();
await new Promise((r) => setTimeout(r, 200));
const bob2 = await connect();
const back = next(bob2, 'room:state');
const rejoin = await emit(bob2, 'room:join', { roomCode: code, name: 'Bobby', avatar: 5, deviceId: 'device-bob-0001' });
const backState = await back;
check('same device reclaims its seat under a new name',
  rejoin.ok && backState.you.playerId === bobId && backState.players.find((p) => p.id === bobId)?.name === 'Bobby',
  JSON.stringify(rejoin));
check('no duplicate seat for the device', backState.players.length === 2);

// --- names lock once the game starts ------------------------------------------
check('host starts', (await emit(host, 'room:start', {})).ok === true);
check('rename mid-game -> BAD_PHASE',
  (await emit(bob2, 'player:update', { name: 'Late' })).code === 'BAD_PHASE');

// --- a lone host who refreshes stays host ------------------------------------
const solo = await connect();
const soloRoom = await emit(solo, 'room:create', { name: 'Solo', avatar: 0 });
solo.disconnect();
await new Promise((r) => setTimeout(r, 200));
const solo2 = await connect();
const soloState = next(solo2, 'room:state');
await emit(solo2, 'room:resume', { roomCode: soloRoom.roomCode, token: soloRoom.token });
const ss = await soloState;
check('lone host who refreshes is still host',
  ss.players.find((p) => p.id === ss.you.playerId)?.isHost === true);
solo2.disconnect();

host.disconnect(); visitor.disconnect(); bob2.disconnect();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('failed:', failures.join('; ')); process.exit(1); }
