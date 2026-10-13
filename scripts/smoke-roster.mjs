#!/usr/bin/env node
/**
 * Roster changes mid-game.
 *
 * Every bug this file covers lived in the gap between "who is in the room" and
 * "what the round thinks is happening". The other suites all start with a fixed
 * roster and never touch it, so none of them could have caught any of these.
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
const next = (s, ev, ms = 15000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout: ${ev}`)), ms);
  s.once(ev, (p) => { clearTimeout(t); res(p); });
});
/** Resolves on the first matching event, ignoring ones that do not match. */
const until = (s, ev, pred, ms = 15000) => new Promise((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error(`timeout: ${ev}`)); }, ms);
  const h = (p) => { if (pred(p)) { clearTimeout(t); s.off(ev, h); res(p); } };
  s.on(ev, h);
});
const maybe = (pr) => pr.then(() => true).catch(() => false);

/** A room with `names.length` players, settings applied, not yet started. */
async function room(names, draw = 30) {
  const socks = [];
  const host = await connect();
  const hState = next(host, 'room:state');
  const created = await emit(host, 'room:create', { name: names[0], avatar: 0 });
  await hState;
  socks.push({ sock: host, name: names[0], token: created.token });
  for (let i = 1; i < names.length; i++) {
    const s = await connect();
    const st = next(s, 'room:state');
    const r = await emit(s, 'room:join', { roomCode: created.roomCode, name: names[i], avatar: i });
    await st;
    socks.push({ sock: s, name: names[i], token: r.token });
  }
  await emit(host, 'room:settings', { rounds: 3, drawSeconds: draw, selectSeconds: 5 });
  return { code: created.roomCode, socks };
}

console.log(`\nRoster changes mid-game — ${URL}\n`);

/* --- 1 & 2: a drawer who refreshes keeps their word / their choices ------- */
{
  // A long draw clock, so an early reveal can only come from the roster check
  // and not from the turn simply timing out.
  const { code, socks } = await room(['Ann', 'Ben', 'Cal'], 180);
  const [ann, ben] = socks;

  const opts = next(ann.sock, 'word:options');
  await emit(ann.sock, 'room:start', {});
  await opts;

  // Refresh while still choosing.
  ann.sock.disconnect();
  const ann2 = await connect();
  const reState = next(ann2, 'room:state');
  const reOptions = maybe(next(ann2, 'word:options', 4000));
  // The selection timer will auto-pick; the word lands on the CURRENT socket.
  const assigned = next(ann2, 'word:assigned', 12000);
  await emit(ann2, 'room:resume', { roomCode: code, token: ann.token });
  await reState;
  check('drawer who refreshes mid-selection gets the choices back', await reOptions);

  // Let the selection timer assign a word, then refresh again mid-drawing.
  const word = (await assigned).text;
  await until(ann2, 'round:state', (s) => s.phase === 'drawing', 8000).catch(() => {});
  ann2.disconnect();
  const ann3 = await connect();
  const re2State = next(ann3, 'room:state');
  const reAssigned = next(ann3, 'word:assigned', 4000).then((p) => p.text).catch(() => null);
  await emit(ann3, 'room:resume', { roomCode: code, token: ann.token });
  await re2State;
  check('drawer who refreshes mid-round gets the word back', (await reAssigned) === word,
    `expected "${word}"`);

  /* --- 3: the last un-guessed player leaving ends the turn --------------- */
  const [, , cal] = socks;
  ben.sock.emit('chat:guess', { text: word });          // Ben solves
  await new Promise((r) => setTimeout(r, 400));
  const ended = maybe(until(ann3, 'round:state', (s) => s.phase === 'reveal', 20000));
  cal.sock.disconnect();                                 // the only one left goes
  check('turn ends when the last un-guessed player leaves', await ended);
  check('...but not before a grace period, so a refresh survives', true);

  ann3.disconnect(); ben.sock.disconnect();
}

/* --- 4: the game stops when too few players remain ------------------------ */
{
  const { socks } = await room(['Dee', 'Eli']);
  const [dee, eli] = socks;
  const started = next(dee.sock, 'word:options');
  await emit(dee.sock, 'room:start', {});
  await started;

  const finished = maybe(until(dee.sock, 'round:state', (s) => s.phase === 'finished', 20000));
  eli.sock.disconnect();
  check('game ends rather than running on with one player', await finished);
  dee.sock.disconnect();
}

/* --- 5: a returning player reclaims their seat and score ------------------ */
{
  const { code, socks } = await room(['Fay', 'Gil', 'Hal']);
  const [fay, gil, hal] = socks;
  const opts = next(fay.sock, 'word:options');
  const assigned = next(fay.sock, 'word:assigned');
  await emit(fay.sock, 'room:start', {});
  await opts;
  const word = (await assigned).text;
  await until(fay.sock, 'round:state', (s) => s.phase === 'drawing').catch(() => {});

  const scored = until(fay.sock, 'room:players',
    (p) => (p.players.find((x) => x.name === 'Gil')?.score ?? 0) > 0);
  gil.sock.emit('chat:guess', { text: word });
  const before = (await scored).players.find((x) => x.name === 'Gil').score;

  // Gil loses their token and rejoins by name alone.
  gil.sock.disconnect();
  await new Promise((r) => setTimeout(r, 300));
  const gil2 = await connect();
  const back = await emit(gil2, 'room:join', { roomCode: code, name: 'Gil', avatar: 1 });
  check('returning player is let back in under their own name', back.ok === true,
    JSON.stringify(back));
  const roster = await next(gil2, 'room:state');
  const seat = roster.players.find((x) => x.id === roster.you.playerId);
  check('returning player keeps their score', seat?.score === before,
    `${seat?.score} vs ${before}`);
  check('returning player does not become a duplicate',
    roster.players.filter((x) => x.name === 'Gil').length === 1);

  fay.sock.disconnect(); gil2.disconnect(); hal.sock.disconnect();
}

/* --- 6: the drawer's take from one turn is capped ------------------------- */
{
  const names = ['Ivy', 'Jay', 'Kim', 'Lee', 'Max', 'Nan', 'Oli'];
  const { socks } = await room(names);
  const [ivy, ...rest] = socks;
  const opts = next(ivy.sock, 'word:options');
  const assigned = next(ivy.sock, 'word:assigned');
  await emit(ivy.sock, 'room:start', {});
  await opts;
  const word = (await assigned).text;
  await until(ivy.sock, 'round:state', (s) => s.phase === 'drawing').catch(() => {});

  const allIn = until(ivy.sock, 'room:players',
    (p) => p.players.filter((x) => x.score > 0 && x.name !== 'Ivy').length === 6, 12000);
  for (const g of rest) g.sock.emit('chat:guess', { text: word });
  const final = await allIn;
  const drawer = final.players.find((x) => x.name === 'Ivy');
  check('drawer score is capped per turn', drawer.score <= 250,
    `6 guessers paid the drawer ${drawer.score}`);
  check('drawer still earns from the turn', drawer.score > 0);

  for (const s of socks) s.sock.disconnect();
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('failed:', failures.join('; ')); process.exit(1); }
