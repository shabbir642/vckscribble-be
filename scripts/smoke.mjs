#!/usr/bin/env node
/**
 * Drives real socket clients against a running server to exercise the M2 room
 * lifecycle — identity, host succession, reconnect. These are the paths that
 * are tedious to reproduce by hand and easy to regress.
 *
 * Usage: node scripts/smoke.mjs [url]
 */
import { io } from './lib/io.mjs';

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
const guestSees = nextEvent(guest, 'room:state');
check('host settings accepted', (await emit(host, 'room:settings', { rounds: 5 })).ok === true);
const after = await nextEvent(host, 'room:state');
check('settings broadcast to room', after.settings.rounds === 5);
check('totalRounds follows settings', after.round.totalRounds === 5);
// Regression: the broadcast used to carry the HOST's id as everyone's `you`,
// so every guest believed it was the host for the rest of the game.
const seen = await guestSees;
check('settings broadcast keeps each player\'s own identity',
  seen.settings.rounds === 5 && seen.you.playerId === guestId,
  `guest told it is ${seen.you.playerId}, expected ${guestId}`);
check('host keeps its own identity', after.you.playerId === hostPlayerId);
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
// `room:start` became real in M4, so the room is mid-game by now: starting
// again is a phase error, not a player-count error.
check('cannot restart a running game',
  (await emit(back, 'room:start', {})).code === 'BAD_PHASE')
back.disconnect();

// --- M3 drawing ---------------------------------------------------------
const d1 = await connect();
const dCreate = await emit(d1, 'room:create', { name: 'Drawer', avatar: 2 });
const dCode = dCreate.roomCode;
await nextEvent(d1, 'room:state');
const d2 = await connect();
await emit(d2, 'room:join', { roomCode: dCode, name: 'Watcher', avatar: 4 });
await nextEvent(d2, 'room:state');

// Points are flat, quantized pairs: [x0, y0, x1, y1, ...] on a 0..10000 grid.
const stroke = (id) => ({
  id, drawerId: 'spoofed', tool: 'brush', color: '#2f6f4f', size: 0.01,
  points: [1000, 1000, 5000, 6000],
});

const relayed = nextEvent(d2, 'draw:stroke');
d1.emit('draw:stroke', { stroke: stroke('s1') });
const got = await relayed;
check('stroke relays to other players', got.stroke.id === 's1');
check('server overrides spoofed drawerId', got.stroke.drawerId !== 'spoofed');

const badStroke = nextEvent(d1, 'error:toast');
d1.emit('draw:stroke', { stroke: { ...stroke('s2'), color: 'red' } });
check('malformed stroke rejected', (await badStroke).code === 'INVALID');

const badPoints = nextEvent(d1, 'error:toast');
d1.emit('draw:stroke', { stroke: { ...stroke('s2'), points: [0.1, 0.2] } });
check('non-integer points rejected', (await badPoints).code === 'INVALID');

// a live drag sends only its new points, under the same id
const appended = nextEvent(d2, 'draw:points');
d1.emit('draw:points', { id: 's1', points: [9000, 2000] });
const app = await appended;
check('appended points relay as a delta', app.strokeId === 's1' && app.points.length === 2);

const foreign = nextEvent(d1, 'error:toast');
d1.emit('draw:points', { id: 'nope', points: [1, 1] });
check('append to unknown stroke rejected', (await foreign).code === 'INVALID');

const tooLong = nextEvent(d1, 'error:toast');
d1.emit('draw:points', { id: 's1', points: new Array(1200).fill(5000) });
check('per-stroke point cap enforced', (await tooLong).code === 'INVALID');

d1.emit('draw:stroke', { stroke: stroke('s3') });
await new Promise(r => setTimeout(r, 120));
const undone = nextEvent(d2, 'draw:undo');
d1.emit('draw:undo', {});
check('undo removes own last stroke', (await undone).strokeId === 's3');

// late joiner replay
const d3 = await connect();
const sync = nextEvent(d3, 'draw:sync');
await emit(d3, 'room:join', { roomCode: dCode, name: 'Latecomer', avatar: 5 });
const synced = await sync;
check('late joiner receives stroke log',
  synced.strokes.length === 1 && synced.strokes[0].id === 's1',
  JSON.stringify(synced.strokes.map(s => s.id)));
check('stroke log includes appended points', synced.strokes[0].points.length === 6,
  `got ${synced.strokes[0].points.length / 2} points`);

const cleared = nextEvent(d2, 'draw:clear');
d1.emit('draw:clear', {});
await cleared;
check('clear broadcasts', true);

// one socket, one seat: entering a new room must unsubscribe from the old one
const roster2P = nextEvent(d1, 'room:players');
const hopState = nextEvent(d3, 'room:state');
const hop = await emit(d3, 'room:create', { name: 'Hopper', avatar: 1 });
await hopState;
let leaked = false;
d3.on('chat:message', (m) => { if (m.text.includes('still here')) leaked = true; });
const roster2 = await roster2P;
check('room hop marks old seat away', roster2.players.find((p) => p.name === 'Latecomer')?.connected === false);
d1.emit('chat:guess', { text: 'still here' });
await new Promise(r => setTimeout(r, 200));
check('room hop stops old room traffic', hop.ok && !leaked);
d1.disconnect(); d2.disconnect(); d3.disconnect();

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('failed:', failures.join('; '));
  process.exit(1);
}
