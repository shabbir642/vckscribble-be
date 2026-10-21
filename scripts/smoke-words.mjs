#!/usr/bin/env node
/**
 * Word settings end to end: packs, difficulty, number of choices, hints,
 * the host's custom list (and who may see it), and the scoring of a turn.
 *
 * Usage: node scripts/smoke-words.mjs [url]   (~25 s: plays a 15 s turn)
 */
import { existsSync } from 'node:fs';
import { io } from './lib/io.mjs';

const URL = process.argv[2] ?? 'http://localhost:3001';
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
const next = (s, ev, ms = 3000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms);
  s.once(ev, (p) => { clearTimeout(t); res(p); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A room of three with each socket's latest room:state recorded. */
async function room(names) {
  const socks = [];
  for (const [i, name] of names.entries()) {
    const s = await connect();
    s.state = null;
    s.on('room:state', (p) => { s.state = p; });
    s.on('room:players', (p) => { if (s.state) s.state.players = p.players; });
    const r = i === 0
      ? await emit(s, 'room:create', { name, avatar: i })
      : await emit(s, 'room:join', { roomCode: socks[0].code, name, avatar: i });
    s.code = i === 0 ? r.roomCode : socks[0].code;
    s.name = name;
    socks.push(s);
  }
  await sleep(200);
  return socks;
}
/** Resolves with whichever socket is offered words: turn order is shuffled. */
const firstOffer = (socks, ms = 4000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout waiting for word:options')), ms);
  for (const sock of socks) sock.once('word:options', (p) => { clearTimeout(t); res({ sock, ...p }); });
});
const scoreOf = (s, name) => s.state.players.find((p) => p.name === name)?.score ?? 0;

console.log(`\nWord settings, hints & scoring — ${URL}\n`);

const [host, b, c] = await room(['Hana', 'Bo', 'Cy']);

// --- settings -----------------------------------------------------------------
check('guest cannot change settings', (await emit(b, 'room:settings', { hints: 1 })).code === 'NOT_HOST');
check('off-list draw time rejected', (await emit(host, 'room:settings', { drawSeconds: 17 })).code === 'INVALID');
check('unknown setting rejected', (await emit(host, 'room:settings', { turbo: true })).code === 'INVALID');
check('client cannot set customWordCount', (await emit(host, 'room:settings', { customWordCount: 99 })).code === 'INVALID');
const bSees = next(b, 'room:state');
check('host sets packs, difficulty, choices, hints, time', (await emit(host, 'room:settings', {
  wordPacks: ['animals'], difficulty: 'easy', wordChoices: 5, hints: 2, drawSeconds: 15,
})).ok === true);
const seen = (await bSees).settings;
check('settings broadcast to the room', seen.wordChoices === 5 && seen.hints === 2 && seen.difficulty === 'easy'
  && seen.wordPacks.join() === 'animals' && seen.drawSeconds === 15, JSON.stringify(seen));

// --- custom words: host-only --------------------------------------------------
const bState = next(b, 'room:state');
const cw = await emit(host, 'room:customWords', { text: 'cat, dog, fuck, Dog' });
await sleep(300); // the per-player room:state follows the ack
check('custom list: valid accepted, deduped', cw.ok && cw.accepted === 2, JSON.stringify(cw));
check('custom list: blocked word reported back', cw.rejected?.join() === 'fuck');
const [hs, bs] = [host.state, await bState];
check('host receives the list', hs.hostWords?.join() === 'cat,dog', JSON.stringify(hs.hostWords));
check('guests never receive the list', bs.hostWords === undefined && bs.settings.customWordCount === 2);
check('guest cannot set custom words', (await emit(b, 'room:customWords', { text: 'x y z' })).code === 'NOT_HOST');
await emit(host, 'room:settings', { customWordsOnly: true });
check('custom-only needs 10 words to start', (await emit(host, 'room:start', {})).code === 'INVALID');
await emit(host, 'room:settings', { customWordsOnly: false });
await emit(host, 'room:customWords', { text: '' });

// --- a real turn ----------------------------------------------------------------
const offer = firstOffer([host, b, c]);
check('game starts', (await emit(host, 'room:start', {})).ok === true);
const { sock: drawer, choices } = await offer;
const [gA, gB] = [host, b, c].filter((x) => x !== drawer);
check('drawer is offered 5 words', choices.length === 5, String(choices.length));
check('all offered words are easy to draw', choices.every((w) => w.drawability === 1),
  JSON.stringify(choices.map((w) => [w.text, w.drawability])));
if (existsSync('data/game.db')) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database('data/game.db', { readonly: true });
  // A word can be in a pack as its second one (also_pack): "whale" is slang first, animals too.
  const packs = choices.map((w) => db.prepare('SELECT pack, also_pack FROM words WHERE id = ?').get(w.id));
  check('all offered words come from the chosen pack', packs.every((p) => p?.pack === 'animals' || p?.also_pack === 'animals'),
    packs.map((p) => `${p?.pack}/${p?.also_pack}`).join());
  db.close();
}

const word = choices[0].text;
const hints = [];
gA.on('round:hint', (p) => hints.push(p.maskedWord));
const drawing = next(gA, 'round:state', 3000);
await emit(drawer, 'word:choose', { wordId: choices[0].id });
const start = await drawing;
const started = Date.now();

// Hints at 15 s with hints=2 land around 7.8 s and 10.3 s.
await sleep(11_500);
const letters = [...word].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).length;
const expected = Math.min(2, [...word.split(' ')].reduce((n, w) => n + Math.floor(w.replace(/[^\p{L}\p{N}]/gu, '').length / 2), 0));
check(`hints revealed: ${hints.length} (expected ${expected} for "${word}")`, hints.length === expected,
  JSON.stringify({ start: start.maskedWord, hints }));
const last = hints.at(-1) ?? start.maskedWord;
const shown = [...last.replace(/\s/g, '')].filter((ch) => ch !== '_' && /[\p{L}\p{N}]/u.test(ch)).length;
check('at least half of the letters stay hidden', shown <= Math.floor(letters / 2), `${shown}/${letters} shown: ${last}`);

// Scoring: Bo guesses first, Cy second.
const before = { d: scoreOf(drawer, drawer.name), a: scoreOf(drawer, gA.name), b: scoreOf(drawer, gB.name) };
// Time left as the guess goes out: the server scores it on arrival, a moment
// later, so this is the upper bound for the speed share.
const frac1 = Math.max(0, (start.endsAt - Date.now()) / 15_000);
gA.emit('chat:guess', { text: word });
await sleep(300);
gB.emit('chat:guess', { text: word.toUpperCase() });
await sleep(400);
const gainB = scoreOf(drawer, gA.name) - before.a;
const gainC = scoreOf(drawer, gB.name) - before.b;
const gainDrawer = scoreOf(drawer, drawer.name) - before.d;
check(`first guesser: speed + 50 bonus (got ${gainB})`, gainB >= 50 + 50 && gainB <= 50 + Math.round(250 * frac1) + 50 + 5);
check(`second guesser: speed + 30 bonus, less than first (got ${gainC})`, gainC >= 50 + 30 && gainC < gainB);
check(`drawer: two guessers out of two = full 250 (got ${gainDrawer})`, gainDrawer === 250);
host.close(); b.close(); c.close();

// --- custom words only ----------------------------------------------------------
const [h2, g2] = await room(['Ivo', 'Jen']);
const list = 'rubber duck, laptop, pizza, cactus, kite, igloo, robot, rainbow, volcano, penguin, trophy, umbrella';
check('12 custom words accepted', (await emit(h2, 'room:customWords', { text: list })).accepted === 12);
await emit(h2, 'room:settings', { customWordsOnly: true, wordChoices: 3 });
const offer2 = firstOffer([h2, g2]);
check('custom-only game starts with 10+ words', (await emit(h2, 'room:start', {})).ok === true);
const { sock: drawer2, choices: c2 } = await offer2;
const listSet = new Set(list.split(', '));
check('every choice comes from the custom list', c2.length === 3 && c2.every((w) => w.id < 0 && listSet.has(w.text)),
  JSON.stringify(c2));
const assigned = next(drawer2, 'word:assigned');
await emit(drawer2, 'word:choose', { wordId: c2[1].id });
check('a custom word can be chosen and drawn', (await assigned).text === c2[1].text);

// Next turn: the other player draws. Passed-over offers are spent, and the
// word just drawn cannot be typed in again.
const other = drawer2 === h2 ? g2 : h2;
const nextOffer = firstOffer([other], 9000);
other.emit('chat:guess', { text: c2[1].text }); // everyone guessed -> turn ends
const { choices: c3 } = await nextOffer;
const spent = new Set(c2.map((w) => w.text));
check('words offered last turn are not offered again', c3.every((w) => !spent.has(w.text)),
  JSON.stringify({ before: [...spent], now: c3.map((w) => w.text) }));
check('a word already drawn cannot be written in again',
  (await emit(other, 'word:custom', { text: c2[1].text })).code === 'INVALID');
h2.close(); g2.close();

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('failed:', failures.join('; ')); process.exit(1); }
process.exit(0);
