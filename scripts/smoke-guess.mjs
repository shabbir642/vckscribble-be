#!/usr/bin/env node
/** M5: guess matching, scoring, leak prevention, early finish. */
import { io } from 'socket.io-client';

const URL = process.argv[2] ?? 'http://localhost:3001';
let pass = 0; const failures = [];
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { failures.push(l); console.log(`  ✗ ${l} ${d}`); } };
const connect = () => new Promise((res, rej) => { const s = io(URL, { transports: ['websocket'], forceNew: true }); s.once('connect', () => res(s)); s.once('connect_error', rej); });
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const next = (s, ev, ms = 6000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`timeout: ${ev}`)), ms); s.once(ev, (p) => { clearTimeout(t); res(p); }); });
/** Waits for the first matching event — intermediate ones are expected. */
const until = (s, ev, pred, ms = 8000) => new Promise((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error(`timeout: ${ev}`)); }, ms);
  const h = (p) => { if (pred(p)) { clearTimeout(t); s.off(ev, h); res(p); } };
  s.on(ev, h);
});
const collect = (s, ev, ms) => new Promise((res) => { const out = []; const h = (p) => out.push(p); s.on(ev, h); setTimeout(() => { s.off(ev, h); res(out); }, ms); });

console.log(`\nM5 guessing & scoring — ${URL}\n`);

const drawer = await connect();
const { roomCode: code } = await emit(drawer, 'room:create', { name: 'Dee', avatar: 0 });
await next(drawer, 'room:state');
const g1 = await connect();
await emit(g1, 'room:join', { roomCode: code, name: 'Gus', avatar: 1 });
await next(g1, 'room:state');
const g2 = await connect();
await emit(g2, 'room:join', { roomCode: code, name: 'Hal', avatar: 2 });
await next(g2, 'room:state');

await emit(drawer, 'room:settings', { rounds: 1, drawSeconds: 60, selectSeconds: 20 });
const opts = next(drawer, 'word:options');
await emit(drawer, 'room:start', {});
const { choices } = await opts;
// Listeners must be registered BEFORE the emit that triggers them.
const assigned = next(drawer, 'word:assigned');
const drawingState = next(g1, 'round:state');
await emit(drawer, 'word:choose', { wordId: choices[0].id });
const solution = (await assigned).text;
await drawingState;
console.log(`  (word: "${solution}")`);

// wrong guess is public
const publicWrong = next(g2, 'chat:message');
g1.emit('chat:guess', { text: 'definitely not it' });
const wrongMsg = await publicWrong;
check('wrong guess is broadcast', wrongMsg.text === 'definitely not it' && wrongMsg.channel === 'guess');

// near miss is private
const close = next(g1, 'chat:close', 3000);
const nearMiss = solution.slice(0, -1) + (solution.endsWith('x') ? 'y' : 'x');
g1.emit('chat:guess', { text: nearMiss });
check('near miss gets private "close" hint', (await close).text.includes('close'));

// drawer cannot chat
const drawerToast = next(drawer, 'error:toast', 3000);
drawer.emit('chat:guess', { text: solution });
check('drawer is blocked from chat', (await drawerToast).code === 'NOT_DRAWER');

// correct guess: system message, not the word itself
const sys = next(g2, 'chat:message');
const scored = next(g2, 'room:players');
g1.emit('chat:guess', { text: solution.toUpperCase() });
const sysMsg = await sys;
check('correct guess announced without revealing word',
  sysMsg.channel === 'system' && sysMsg.text.includes('Gus') && !sysMsg.text.includes(solution));
const players = (await scored).players;
const gus = players.find(p => p.name === 'Gus');
const dee = players.find(p => p.name === 'Dee');
check('guesser scored', gus.score > 0, `score=${gus.score}`);
check('drawer scored for the guess', dee.score > 0, `score=${dee.score}`);
check('case-insensitive matching', gus.score > 0);

// leak prevention: solver chat must not reach the unsolved player
const leaked = collect(g2, 'chat:message', 900);
const solverSaw = collect(drawer, 'chat:message', 900);
g1.emit('chat:guess', { text: 'it was so obvious lol' });
check('solver chat hidden from unsolved players',
  !(await leaked).some(m => m.text.includes('obvious')));
check('solver chat reaches the drawer',
  (await solverSaw).some(m => m.text.includes('obvious')));

// last guesser ends the turn early
const reveal = until(g2, 'round:state', (p) => p.phase === 'reveal', 8000);
g2.emit('chat:guess', { text: solution });
const rev = await reveal;
check('round ends once everyone has guessed', rev.phase === 'reveal', rev.phase);
check('solution revealed at round end', rev.solution === solution);

drawer.disconnect(); g1.disconnect(); g2.disconnect();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('failed:', failures.join('; ')); process.exit(1); }
