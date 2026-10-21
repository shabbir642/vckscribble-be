#!/usr/bin/env node
/**
 * However a right answer is typed, it is right: spaces, capitals and
 * punctuation never cost a guess. A drawer writes "Ice Cream", and four
 * guessers get it with "icecream", "ICE CREAM", "ice-cream" and
 * " ice   cream "; a near miss ("icecrem") is told it is close, and the right
 * letters in the wrong order ("cream ice") stay wrong. Plus unit checks of
 * guessKey and isCloseGuess, imported straight from the contract.
 *
 * Usage: node scripts/smoke-spelling.mjs [url]   (~1 s)
 */
import { tsImport } from 'tsx/esm/api';
import { io } from './lib/io.mjs';

const URL = process.argv[2] ?? 'http://localhost:3001';
let pass = 0;
const failures = [];
const check = (l, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${l}`); }
  else { failures.push(l); console.log(`  ✗ ${l} ${d}`); }
};
const connect = () => new Promise((res, rej) => {
  const s = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
  // Everything the socket receives, in order, for the checks on what never came.
  s.log = [];
  s.onAny((ev, p) => s.log.push({ ev, p }));
  s.once('connect', () => res(s));
  s.once('connect_error', rej);
});
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const next = (s, ev, ms = 6000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout: ${ev}`)), ms);
  s.once(ev, (p) => { clearTimeout(t); res(p); });
});
/**
 * The first matching event, or null if none comes in time: a guess judged
 * the wrong way round fails its check rather than the whole script.
 */
const until = (s, ev, pred, ms = 4000) => new Promise((res) => {
  const t = setTimeout(() => { s.off(ev, h); res(null); }, ms);
  const h = (p) => { if (pred(p)) { clearTimeout(t); s.off(ev, h); res(p); } };
  s.on(ev, h);
});
/** Resolves with whichever socket is offered words: turn order is shuffled. */
const firstOffer = (socks, ms = 6000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout: word:options')), ms);
  for (const sock of socks) sock.once('word:options', (p) => { clearTimeout(t); res({ sock, ...p }); });
});
const received = (s, ev) => s.log.filter((e) => e.ev === ev).map((e) => e.p);

console.log(`\nSpaces, capitals and near misses — ${URL}\n`);

/* --- the pure parts ------------------------------------------------------- */
{
  const { guessKey, isCloseGuess, normalizeWord } =
    await tsImport('../src/contract/index.ts', import.meta.url);
  const forms = ['IceCream', 'ice  cream', 'ICE-CREAM', 'icecream', ' ice   cream ', 'Ice Cream'];
  check('guessKey: every spacing and capitalisation of "ice cream" is the same',
    forms.every((f) => guessKey(f) === guessKey('ice cream')), JSON.stringify(forms.map(guessKey)));
  check('guessKey: "tajmahal" is "Taj Mahal"', guessKey('tajmahal') === guessKey('Taj Mahal'));
  check('guessKey: the order of the words still matters', guessKey('cream ice') !== guessKey('ice cream'));
  check('normalizeWord keeps the space, for storage and duplicates',
    normalizeWord('Ice  Cream') === 'ice cream' && normalizeWord('icecream') !== 'ice cream');
  check('isCloseGuess: "icecrem" is close to "ice cream"', isCloseGuess('icecrem', 'ice cream'));
  check('isCloseGuess: a match but for the spaces is never merely close',
    forms.every((f) => !isCloseGuess(f, 'Ice Cream')));
  // 15 letters (17 characters with the spaces): one letter off, not two.
  check('isCloseGuess: thresholds count letters, not spaces',
    isCloseGuess('lowhangingfrut', 'low hanging fruit') && !isCloseGuess('low hangng frut', 'low hanging fruit'));
}

/* --- a live turn ---------------------------------------------------------- */

// A drawer and four guessers: one guesser for each way of typing it.
const socks = [];
let code = null;
for (const [i, name] of ['Ira', 'Jo', 'Kit', 'Lou', 'Max'].entries()) {
  const s = await connect();
  s.name = name;
  // room:state follows the ack immediately, so the listener goes on first.
  const state = next(s, 'room:state');
  if (i === 0) ({ roomCode: code } = await emit(s, 'room:create', { name, avatar: i }));
  else await emit(s, 'room:join', { roomCode: code, name, avatar: i });
  s.playerId = (await state).you.playerId;
  socks.push(s);
}
const [host] = socks;
await emit(host, 'room:settings', { rounds: 1, drawSeconds: 60, selectSeconds: 20 });
const offer = firstOffer(socks);
await emit(host, 'room:start', {});
const { sock: drawer, allowCustom } = await offer;
const guessers = socks.filter((s) => s !== drawer);
const [g1, g2] = guessers;
check('the drawer may write their own word (on by default)', allowCustom === true);

const assigned = next(drawer, 'word:assigned');
const drawing = until(g1, 'round:state', (p) => p.phase === 'drawing');
const custom = await emit(drawer, 'word:custom', { text: 'Ice Cream' });
check('the drawer writes "Ice Cream"', custom.ok === true, JSON.stringify(custom));
check('and is given it as written', (await assigned).text === 'Ice Cream');
// Hints and the mask keep the space: guessers can see it is two words.
const shown = await drawing;
check('guessers see the blanks of two words', shown?.maskedWord === '_ _ _   _ _ _ _ _', shown?.maskedWord);

// The right letters in the wrong order: wrong, said in public, and not close.
const wrong = until(drawer, 'chat:message', (m) => m.channel === 'guess' && m.text === 'cream ice');
g1.emit('chat:guess', { text: 'cream ice' });
check('"cream ice" stays a wrong guess', (await wrong)?.tone === 'wrong', JSON.stringify(await wrong));

// One letter off is a near miss, told privately; the room sees a wrong guess.
const close = until(g2, 'chat:close', () => true);
const near = until(drawer, 'chat:message', (m) => m.channel === 'guess' && m.text === 'icecrem');
g2.emit('chat:guess', { text: 'icecrem' });
check('"icecrem" is told it is close', (await close)?.text.includes('close'), JSON.stringify(await close));
check('and is still a wrong guess to the room', (await near)?.tone === 'wrong', JSON.stringify(await near));

// Every way of typing it is right. The last one ends the turn.
const answers = ['icecream', 'ICE CREAM', 'ice-cream', ' ice   cream '];
const reveals = socks.map((s) => until(s, 'round:state', (p) => p.phase === 'reveal', 6000));
const scored = until(drawer, 'room:players', (p) =>
  guessers.every((g) => (p.players.find((x) => x.id === g.playerId)?.score ?? 0) > 0), 6000);
for (const [i, g] of guessers.entries()) {
  const text = answers[i];
  const solved = until(g, 'word:assigned', () => true);
  const told = until(drawer, 'chat:message', (m) => m.channel === 'system' && m.text.startsWith(`${g.name} `));
  g.emit('chat:guess', { text });
  check(`${JSON.stringify(text)} is a right answer`, (await told)?.tone === 'correct', JSON.stringify(await told));
  check('and the solver is shown the word', (await solved)?.text === 'Ice Cream', JSON.stringify(await solved));
}
check('each of them scored', (await scored) !== null);
const reveal = await reveals[socks.indexOf(drawer)];
check('everyone got it, so the turn ends early',
  reveal?.guessedPlayerIds.length === 4 && guessers.every((g) => reveal.guessedPlayerIds.includes(g.playerId)),
  JSON.stringify(reveal?.guessedPlayerIds));
check('the reveal shows the word as the drawer wrote it', reveal?.solution === 'Ice Cream', reveal?.solution);

// Each socket's own reveal comes after anything else it was sent this turn.
await Promise.all(reveals);
check('a right answer is never "close"',
  received(g2, 'chat:close').length === 1 && guessers.every((g) => g === g2 || received(g, 'chat:close').length === 0),
  JSON.stringify(guessers.map((g) => received(g, 'chat:close').length)));
// The server trims a guess before anything else, so look for it trimmed.
const typed = new Set(answers.map((a) => a.trim()));
check('a right answer never reaches the chat',
  socks.every((s) => !received(s, 'chat:message').some((m) => typed.has(m.text))));

for (const s of socks) s.disconnect();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('failed:', failures.join('; ')); process.exit(1); }
