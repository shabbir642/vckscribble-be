#!/usr/bin/env node
/**
 * Mid-game joiners must get a turn.
 *
 * The draw order used to be snapshotted at kickoff, so anyone arriving after
 * that sat out the whole game — invisible to every other test here, because
 * they all start with a fixed roster and never add to it.
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
const next = (s, ev, ms = 20000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout: ${ev}`)), ms);
  s.once(ev, (p) => { clearTimeout(t); res(p); });
});

console.log(`\nMid-game joiners — ${URL}\n`);

const a = await connect();
const aState = next(a, 'room:state');
const { roomCode: code } = await emit(a, 'room:create', { name: 'Ann', avatar: 0 });
await aState;

const b = await connect();
const bState = next(b, 'room:state');
await emit(b, 'room:join', { roomCode: code, name: 'Ben', avatar: 1 });
await bState;

await emit(a, 'room:settings', { rounds: 1, drawSeconds: 30, selectSeconds: 5 });

// Turn 1 of 1 round, with only Ann and Ben on the roster. Turn order is
// shuffled, so `first` is whichever of them is offered words.
const firstOffer = new Promise((res) => [a, b].forEach((s) => s.once('word:options', () => res(s))));
await emit(a, 'room:start', {});
const first = await firstOffer;
const second = first === a ? b : a;
const firstAssigned = next(first, 'word:assigned');

// Cal arrives after the game is under way — the whole point of the test.
const c = await connect();
const cState = next(c, 'room:state');
await emit(c, 'room:join', { roomCode: code, name: 'Cal', avatar: 2 });
check('late joiner is admitted mid-game', (await cState).players.length === 3);

/**
 * Everyone but the drawer guesses correctly, which ends the turn at once.
 * The pending `word:assigned` promise is passed in rather than subscribed to
 * here: the drawer may have been handed a word before this runs, and a
 * listener registered after the event has already fired waits forever.
 */
const solveTurn = async (assignedPromise, guessers) => {
  const assigned = await assignedPromise;
  for (const g of guessers) g.emit('chat:guess', { text: assigned.text });
  return assigned.text;
};

// The first drawer never picks; the selection timer auto-chooses after 5s.
await solveTurn(firstAssigned, [second, c]);

// Turn 2: the other original player.
await next(second, 'word:options');
check('turn 2 goes to the second original player', true);
const secondAssigned = next(second, 'word:assigned');
await emit(second, 'word:custom', { text: 'Stakeholder Alignment Sync' });
await solveTurn(secondAssigned, [first, c]);

// Turn 3: Cal. Before the fix this timed out — Cal was never in the queue.
let calGotATurn = true;
try {
  await next(c, 'word:options', 20000);
} catch {
  calGotATurn = false;
}
check('late joiner gets a turn in the round they joined', calGotATurn);

a.disconnect(); b.disconnect(); c.disconnect();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('failed:', failures.join('; ')); process.exit(1); }
