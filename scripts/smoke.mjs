#!/usr/bin/env node
/**
 * Drives real socket clients against a running server to exercise the M2 room
 * lifecycle — identity, host succession, reconnect. These are the paths that
 * are tedious to reproduce by hand and easy to regress.
 *
 * Usage: node scripts/smoke.mjs [url]
 */
import { io } from 'socket.io-client';

const URL = process.argv[2] ?? 'http://localhost:3001';
let pass = 0;
const failures = [];

function check(label, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label} ${detail}`);
  }
}

const connect = () =>
  new Promise((res, rej) => {
    const s = io(URL, { transports: ['websocket'], forceNew: true });
    s.once('connect', () => res(s));
    s.once('connect_error', rej);
  });

const emit = (s, ev, p) =>
  new Promise((res) => s.emit(ev, p, res));

const nextEvent = (s, ev, ms = 1500) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms);
    s.once(ev, (p) => {
      clearTimeout(t);
      res(p);
    });
  });

console.log(`\nM2 room lifecycle — ${URL}\n`);

// --- create -----------------------------------------------------------------
const host = await connect();
const hostState = nextEvent(host, 'room:state');
const created = await emit(host, 'room:create', { name: 'Alice', avatar: 0 });
check('create returns ok + code + token', created.ok && created.roomCode?.length >= 4 && created.token?.length > 8, JSON.stringify(created));
const code = created.roomCode;
const st = await hostState;
check('creator receives room:state', st.roomCode === code);
check('creator is host', st.players[0]?.isHost === true);
const hostPlayerId = st.you.playerId;

// --- validation -------------------------------------------------------------
const bad = await connect();
check('join unknown room -> ROOM_NOT_FOUND',
  (await emit(bad, 'room:join', { roomCode: 'ZZZZ', name: 'Nobody', avatar: 1 })).code === 'ROOM_NOT_FOUND');
check('empty name rejected',
  (await emit(bad, 'room:create', { name: '   ', avatar: 1 })).ok === false);
check('duplicate name -> NAME_TAKEN',
  (await emit(bad, 'room:join', { roomCode: code, name: 'alice', avatar: 1 })).code === 'NAME_TAKEN');
bad.disconnect();

// --- join -------------------------------------------------------------------
const guest = await connect();
const roster = nextEvent(host, 'room:players');
const joined = await emit(guest, 'room:join', { roomCode: code, name: 'Bob', avatar: 3 });
check('guest joins', joined.ok === true);
const guestState = await nextEvent(guest, 'room:state');
const guestId = guestState.you.playerId;
check('host sees 2 players', (await roster).players.length === 2);
check('guest is not host', guestState.players.find(p => p.id === guestId)?.isHost === false);

// --- authority --------------------------------------------------------------
check('non-host settings -> NOT_HOST',
  (await emit(guest, 'room:settings', { rounds: 9 })).code === 'NOT_HOST');
check('non-host start -> NOT_HOST',
  (await emit(guest, 'room:start', {})).code === 'NOT_HOST');
check('host settings accepted', (await emit(host, 'room:settings', { rounds: 5 })).ok === true);
const after = await nextEvent(host, 'room:state');
check('settings broadcast to room', after.settings.rounds === 5);
check('totalRounds follows settings', after.round.totalRounds === 5);
check('out-of-range setting rejected',
  (await emit(host, 'room:settings', { rounds: 999 })).code === 'INVALID');
check('host start with 2 players ok', (await emit(host, 'room:start', {})).ok === true);

// --- reconnect --------------------------------------------------------------
guest.disconnect();
await new Promise(r => setTimeout(r, 250));
const back = await connect();
const resumed = await emit(back, 'room:resume', { roomCode: code, token: joined.token });
check('resume with token restores identity', resumed.ok && resumed.playerId === guestId,
  JSON.stringify(resumed));
const resumedState = await nextEvent(back, 'room:state');
check('resumed player marked connected',
  resumedState.players.find(p => p.id === guestId)?.connected === true);
check('resume with bad token rejected',
  (await emit(back, 'room:resume', { roomCode: code, token: 'x'.repeat(32) })).code === 'INVALID');

// --- host succession --------------------------------------------------------
const succession = nextEvent(back, 'room:players', 2500);
host.disconnect();
const promoted = await succession;
const newHost = promoted.players.find(p => p.isHost);
check('host role passes to remaining player', newHost?.id === guestId,
  `got ${newHost?.name ?? 'none'}`);
check('old host shown disconnected',
  promoted.players.find(p => p.id === hostPlayerId)?.connected === false);
check('promoted player may now start',
  (await emit(back, 'room:start', {})).code === 'INVALID'); // only 1 connected
back.disconnect();

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('failed:', failures.join('; '));
  process.exit(1);
}
