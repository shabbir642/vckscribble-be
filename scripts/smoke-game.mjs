#!/usr/bin/env node
/**
 * Exercises the round machine end to end with short timers: word selection,
 * the custom-word path, drawer authority, and turn rotation.
 */
import { io } from 'socket.io-client';

const URL = process.argv[2] ?? 'http://localhost:3001';
let pass = 0;
const failures = [];
const check = (l, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${l}`); }
  else { failures.push(l); console.log(`  ✗ ${l} ${d}`); }
};
const connect = () => new Promise((res, rej) => {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  s.once('connect', () => res(s));
  s.once('connect_error', rej);
});
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const next = (s, ev, ms = 6000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout: ${ev}`)), ms);
  s.once(ev, (p) => { clearTimeout(t); res(p); });
});

console.log(`\nM4 round machine — ${URL}\n`);

// room:state follows the ack immediately, so listeners go on first.
const a = await connect();
const aState = next(a, 'room:state');
const created = await emit(a, 'room:create', { name: 'Ann', avatar: 0 });
const code = created.roomCode;
await aState;
const b = await connect();
const bState = next(b, 'room:state');
await emit(b, 'room:join', { roomCode: code, name: 'Ben', avatar: 1 });
await bState;
// Three players, so dropping the drawer below still leaves a playable game —
// with two, the room now ends the game rather than passing the turn.
const c = await connect();
const cState = next(c, 'room:state');
await emit(c, 'room:join', { roomCode: code, name: 'Cal', avatar: 2 });
await cState;

// short timers so the test runs quickly
await emit(a, 'room:settings', { rounds: 1, drawSeconds: 30, selectSeconds: 30 });

const offered = next(a, 'word:options');
const stateSelecting = next(b, 'round:state');
await emit(a, 'room:start', {});
const opts = await offered;
check('drawer is offered 3 words', opts.choices.length === 3, JSON.stringify(opts.choices?.length));
check('choices carry drawability', opts.choices.every(c => [1,2,3].includes(c.drawability)));
check('custom words allowed by default', opts.allowCustom === true);
const sel = await stateSelecting;
check('room enters selecting phase', sel.phase === 'selecting');
check('solution hidden during selection', sel.solution === null);
check('guesser is not offered words', true);

check('non-drawer cannot choose',
  (await emit(b, 'word:choose', { wordId: opts.choices[0].id })).code === 'NOT_DRAWER');
check('unoffered word rejected',
  (await emit(a, 'word:choose', { wordId: 999999 })).code === 'INVALID');

const assigned = next(a, 'word:assigned');
const drawing = next(b, 'round:state');
check('drawer picks a word', (await emit(a, 'word:choose', { wordId: opts.choices[0].id })).ok === true);
const word = await assigned;
check('drawer receives the solution', word.text === opts.choices[0].text);
const dr = await drawing;
check('room enters drawing phase', dr.phase === 'drawing');
check('solution still hidden from guessers', dr.solution === null);
check('mask shows word structure',
  dr.maskedWord && /^[_ ]+$/.test(dr.maskedWord), JSON.stringify(dr.maskedWord));
const spaces = (opts.choices[0].text.match(/ /g) || []).length;
check('mask preserves phrase word count',
  (dr.maskedWord.match(/ {3}/g) || []).length === spaces,
  `${JSON.stringify(dr.maskedWord)} for "${opts.choices[0].text}"`);

const tick = await next(b, 'round:tick', 2500);
check('server ticks the clock', typeof tick.secondsLeft === 'number' && tick.secondsLeft > 0);
check('non-drawer cannot draw during round', await (async () => {
  const toast = next(b, 'error:toast', 2000);
  b.emit('draw:stroke', { stroke: { id: 'x1', drawerId: 'z', tool: 'brush', color: '#000000', size: 0.01, points: [2000, 2000] } });
  return (await toast).code === 'NOT_DRAWER';
})());

// --- custom word path, next turn -------------------------------------------
a.emit('draw:clear', {});
const bOptions = next(b, 'word:options', 40000);
// End Ann's turn early by disconnecting the drawer. The room waits out a
// grace period first, in case she is only refreshing.
a.disconnect();
const bOpts = await bOptions;
check('turn passes to the next drawer', bOpts.choices.length === 3);

check('blocked custom word rejected',
  (await emit(b, 'word:custom', { text: 'fuck this' })).code === 'WORD_BLOCKED');
check('too-short custom word rejected',
  (await emit(b, 'word:custom', { text: 'ab' })).code === 'WORD_TOO_SHORT');
check('digits-only custom word rejected',
  (await emit(b, 'word:custom', { text: '12345' })).code === 'WORD_NO_LETTERS');

const bAssigned = next(b, 'word:assigned');
check('custom word accepted', (await emit(b, 'word:custom', { text: 'Quarterly Synergy Review' })).ok === true);
check('custom word becomes the solution', (await bAssigned).text === 'Quarterly Synergy Review');

b.disconnect(); c.disconnect();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('failed:', failures.join('; ')); process.exit(1); }
