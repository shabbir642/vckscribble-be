#!/usr/bin/env node
/**
 * The end-of-game summary, end to end: a game of three played to the finish,
 * the summary every player is sent, the final scores and summary re-sent to
 * whoever arrives on the final scoreboard or after the end, and play again.
 * Alongside it, a game of two whose liked drawer is kicked once every turn
 * has been played. Plus unit checks of the pure parts (thinning the drawing of
 * the game, the award rules, which drawings stay in the running), imported
 * straight from the source.
 *
 * Usage: node scripts/smoke-summary.mjs [url]   (~35 s: a whole game, then part of another)
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
  // Everything the socket receives, in order, for the checks on what comes first.
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
/** Waits for the first matching event — intermediate ones are expected. */
const until = (s, ev, pred, ms = 8000) => new Promise((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error(`timeout: ${ev}`)); }, ms);
  const h = (p) => { if (pred(p)) { clearTimeout(t); s.off(ev, h); res(p); } };
  s.on(ev, h);
});
/** Resolves with whichever socket is offered words: turn order is shuffled. */
const firstOffer = (socks, ms = 8000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout: word:options')), ms);
  for (const sock of socks) sock.once('word:options', (p) => { clearTimeout(t); res({ sock, ...p }); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** How long the bots wait into a drawing before guessing. */
const THINK_MS = 150;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Where in a socket's log the first (or last) matching event landed; -1 if none. */
const firstAt = (s, ev, pred = () => true) => s.log.findIndex((e) => e.ev === ev && pred(e.p));
const lastAt = (s, ev, pred = () => true) => s.log.findLastIndex((e) => e.ev === ev && pred(e.p));
const received = (s, ev) => s.log.filter((e) => e.ev === ev).map((e) => e.p);
const pairs = (strokes) => strokes.reduce((n, s) => n + s.points.length / 2, 0);
const stroke = (id, i) => ({
  id, drawerId: 'z', tool: 'brush', color: '#000000', size: 0.01,
  points: [1000 + i * 500, 2000, 1500 + i * 500, 2600, 2000 + i * 500, 2000],
});

/**
 * The award rules, as a check on any summary: each award goes to a player
 * with the best value for it, ties to whoever has fewer awards so far, then
 * the better rank, then list order; nobody gets more than two; an award whose
 * best players are all capped is dropped; first-in needs three players.
 */
const RULES = [
  ['artist', 'likes', 'most'],
  ['speedster', 'fastestMs', 'least'],
  ['sharpshooter', 'guessed', 'most'],
  ['storyteller', 'solvedByOthers', 'most'],
  ['trailblazer', 'firstGuesses', 'most'],
];
function awardProblems(summary) {
  const problems = [];
  const held = new Map();
  const count = (p) => held.get(p.id) ?? 0;
  const order = RULES.map(([id]) => id);
  if (!same(summary.awards.map((a) => a.id), order.filter((id) => summary.awards.some((a) => a.id === id)))) {
    problems.push('awards out of order or repeated');
  }
  for (const [id, field, dir] of RULES) {
    const award = summary.awards.find((a) => a.id === id);
    const values = summary.players.map((p) => p[field]).filter((v) => v !== null && (dir === 'least' || v >= 1));
    const allowed = values.length > 0 && (id !== 'trailblazer' || summary.players.length >= 3);
    const best = dir === 'least' ? Math.min(...values) : Math.max(...values);
    const open = allowed ? summary.players.filter((p) => p[field] === best && count(p) < 2) : [];
    if (!open.length) {
      if (award) problems.push(`${id} given when it should be dropped`);
      continue;
    }
    const fewest = Math.min(...open.map(count));
    const pick = open.filter((p) => count(p) === fewest).sort((a, b) => a.rank - b.rank)[0];
    if (!award) problems.push(`${id} missing`);
    else if (award.playerId !== pick.id || award.value !== best) {
      problems.push(`${id} to ${award.playerId} (${award.value}), expected ${pick.id} (${best})`);
    }
    if (award) held.set(award.playerId, (held.get(award.playerId) ?? 0) + 1);
  }
  if ([...held.values()].some((n) => n > 2)) problems.push('someone has more than two awards');
  return problems;
}

console.log(`\nEnd-of-game summary — ${URL}\n`);

/* --- the pure parts ------------------------------------------------------- */
{
  const { thinStrokes, pickAwards, recordTurn, buildSummary, resetSummary } =
    await tsImport('../src/game/summary.ts', import.meta.url);
  const { BEST_DRAWING_MAX_POINTS: MAX } = await tsImport('../src/contract/index.ts', import.meta.url);

  // A room's whole budget, 60,000 pairs: 100 long strokes (some erasers) and
  // ten fills. Every pair is unique, so kept pairs can be told apart.
  const log = [];
  for (let s = 0; s < 100; s++) {
    const pts = [];
    for (let i = 0; i < (s === 99 ? 590 : 600); i++) pts.push(s, i);
    log.push({ ...stroke(`s${s}`, 0), tool: s % 7 ? 'brush' : 'eraser', points: pts });
    if (s % 10 === 0) log.push({ ...stroke(`f${s}`, 0), tool: 'fill', points: [5000, 5000] });
  }
  const before = JSON.stringify(log);
  const thin = thinStrokes(log);
  check(`thinStrokes: 60,000 pairs down to ${pairs(thin)}, within ${MAX}`, pairs(log) === 60_000 && pairs(thin) <= MAX);
  check('thinStrokes: every stroke keeps its first and last pair', thin.every((s, i) =>
    same(s.points.slice(0, 2), log[i].points.slice(0, 2)) && same(s.points.slice(-2), log[i].points.slice(-2))));
  check('thinStrokes: fills kept', same(thin.filter((s) => s.tool === 'fill'), log.filter((s) => s.tool === 'fill')));
  check('thinStrokes: same strokes in the same order', same(thin.map((s) => s.id), log.map((s) => s.id)));
  check('thinStrokes: the originals are untouched', JSON.stringify(log) === before);

  const sp = (id, rank, o) => ({ id, name: id, avatar: 0, score: 0, rank, guessed: 0, firstGuesses: 0,
    fastestMs: null, drew: 0, solvedByOthers: 0, likes: 0, left: false, ...o });
  const capped = pickAwards([
    sp('A', 1, { likes: 5, fastestMs: 1000, guessed: 5, solvedByOthers: 1, firstGuesses: 4 }),
    sp('B', 2, { likes: 1, fastestMs: 2000, guessed: 3, solvedByOthers: 6, firstGuesses: 1 }),
    sp('C', 3, { guessed: 1 }),
  ]);
  check('awards: two each at most, and a capped best value drops the award', same(capped, [
    { id: 'artist', playerId: 'A', value: 5 },
    { id: 'speedster', playerId: 'A', value: 1000 },
    { id: 'storyteller', playerId: 'B', value: 6 },
  ]), JSON.stringify(capped));
  const two = pickAwards([sp('A', 1, { firstGuesses: 2, guessed: 2 }), sp('B', 2)]);
  check('awards: no "first in" with two players', same(two.map((a) => a.id), ['sharpshooter']), JSON.stringify(two));

  // Which drawings stay in the running for drawing of the game. A room as
  // recordTurn and buildSummary see it, where everyone guesses every word:
  // a drawing scores 2, plus 3 a like.
  const table = (ids) => {
    const room = { players: new Map(ids.map((id) => [id, { id, name: id, avatar: 0, score: 0, connected: true }])), order: [...ids] };
    resetSummary(room);
    return room;
  };
  const drawTurn = (room, drawerId, word, likes = 0, canvas = [stroke(`${word}0`, 0)]) => {
    room.active = { text: word };
    room.strokes = canvas;
    room.round = { drawerId, likes, dislikes: 0, guessedPlayerIds: room.order.filter((id) => id !== drawerId) };
    recordTurn(room);
  };
  const kick = (room, id) => {
    room.players.delete(id);
    room.order = room.order.filter((x) => x !== id);
  };
  const bestWord = (room) => buildSummary(room, 1, false).best?.word ?? null;
  const kept = (room) => room.bestTurns.map((c) => c.drawing.word).join();

  let room = table(['A', 'B', 'C', 'D']);
  drawTurn(room, 'A', 'cat', 2);
  kick(room, 'A');
  for (const [id, word] of [['B', 'dog'], ['C', 'sun'], ['D', 'car']]) drawTurn(room, id, word);
  check('best drawing: its drawer kicked, the next best stands in', bestWord(room) === 'dog', bestWord(room));
  room = table(['A', 'B', 'C', 'D']);
  for (const [id, word] of [['A', 'cat'], ['B', 'dog'], ['C', 'sun']]) drawTurn(room, id, word);
  drawTurn(room, 'D', 'car', 2);
  kick(room, 'D');
  check('...even when kicked after the last turn', bestWord(room) === 'cat', bestWord(room));

  room = table(['A', 'B', 'C', 'D', 'E']);
  drawTurn(room, 'A', 'owl');
  drawTurn(room, 'B', 'emu', 1);
  drawTurn(room, 'C', 'yak');
  drawTurn(room, 'D', 'cod'); // level with owl and yak, drawn later
  drawTurn(room, 'A', 'ant'); // no better than A's owl
  check('candidates: three at most, best first, the first of equals ahead', kept(room) === 'emu,owl,yak', kept(room));
  const bee = [stroke('bee0', 0)];
  drawTurn(room, 'A', 'bee', 2, bee);
  check('...one each: a better drawing takes its drawer\'s place', kept(room) === 'bee,emu,yak', kept(room));
  check('...the canvas itself, not a copy', room.bestTurns[0].drawing.strokes === bee);
  kick(room, 'B');
  drawTurn(room, 'E', 'elk');
  check('...a kicked drawer\'s makes way', kept(room) === 'bee,yak,elk', kept(room));

  // Every client replays the drawing of the game, and each fill costs a
  // whole-bitmap read and write: a canvas flooded with them never competes.
  const fills = (n) => Array.from({ length: n }, (_, i) => ({ ...stroke(`f${i}`, 0), tool: 'fill', points: [5000, 5000] }));
  for (const n of [49, 48]) {
    room = table(['A', 'B']);
    drawTurn(room, 'A', 'cat');
    drawTurn(room, 'B', 'dog', 1, [stroke('d0', 0), ...fills(n)]);
    check(n > 48 ? 'best drawing: never one with more than 48 fills' : '...48 are fine',
      bestWord(room) === (n > 48 ? 'cat' : 'dog'), bestWord(room));
  }
}

/* --- a game of three, played to the end ------------------------------------ */
const seats = [];
for (const [i, name] of ['Ann', 'Ben', 'Cal'].entries()) {
  const s = await connect();
  s.name = name;
  const state = next(s, 'room:state');
  const r = i === 0
    ? await emit(s, 'room:create', { name, avatar: i })
    : await emit(s, 'room:join', { roomCode: seats[0].code, name, avatar: i });
  s.code = i === 0 ? r.roomCode : seats[0].code;
  s.token = r.token;
  s.id = (await state).you.playerId;
  seats.push(s);
}
const [ann, ben] = seats;
let cal = seats[2];
const code = ann.code;
await emit(ann, 'room:settings', { rounds: 1, drawSeconds: 15, selectSeconds: 5 });

/**
 * One turn: the drawer takes the first word and draws a few strokes, the last
 * guesser likes it (if `liked` says so), then the guessers get it one after
 * another — in join order, so who was first each turn is known.
 */
async function playTurn(offer, tag, table = seats, liked = () => true) {
  const { sock: drawer, choices } = offer;
  const guessers = table.filter((s) => s !== drawer);
  const assigned = next(drawer, 'word:assigned');
  const drawing = until(guessers[0], 'round:state', (p) => p.phase === 'drawing');
  await emit(drawer, 'word:choose', { wordId: choices[0].id });
  const word = (await assigned).text;
  await drawing;
  // The drawer's socket and the guessers' are separate queues on the server:
  // nobody guesses before the last stroke has been seen.
  const strokes = [0, 1, 2].map((i) => stroke(`${tag}s${i}`, i));
  const drawn = until(guessers[0], 'draw:stroke', (p) => p.stroke.id === strokes.at(-1).id);
  for (const s of strokes) drawer.emit('draw:stroke', { stroke: s });
  await drawn;
  if (liked(drawer)) {
    const like = until(drawer, 'draw:reaction', (p) => p.reaction === 'up');
    guessers.at(-1).emit('draw:react', { reaction: 'up' });
    await like;
  }
  // A moment's thought, so the fastest guess has something real to measure.
  await sleep(THINK_MS);
  const reveal = until(drawer, 'round:state', (p) => p.phase === 'reveal');
  for (const g of guessers) {
    const solved = next(g, 'word:assigned'); // a solver is shown the word
    g.emit('chat:guess', { text: word });
    await solved;
  }
  await reveal;
  // Ids as they are now: closing a socket clears its id.
  return { drawer, drawerId: drawer.id, word, strokes, first: guessers[0].id };
}

// The game of two (at the end) runs alongside, in a room of its own.
const gameOfTwo = kickedAtTheEnd().catch((error) => ({ error }));

let offer = firstOffer(seats);
check('game starts', (await emit(ann, 'room:start', {})).ok === true);
const turns = [];
let finalBoard;
for (let t = 0; t < 3; t++) {
  const current = await offer;
  // What follows this turn's reveal, the next offer or the final scoreboard:
  // listen for it now.
  if (t < 2) offer = firstOffer(seats, 15_000);
  else finalBoard = until(ann, 'round:state', (p) => p.phase === 'scoreboard', 15_000);
  turns.push(await playTurn(current, `t${t}`));
}
console.log(`  (words: ${turns.map((t) => `"${t.word}"`).join(', ')})`);

/* --- arriving on the final scoreboard: a refresh and a late invite --------- */
/**
 * Its round state reads like any scoreboard's, so the final scores have to
 * come right behind it: room:state, then game:scores final, then the roster.
 */
const finalOnArrival = (s) => {
  const state = firstAt(s, 'room:state', (p) => p.round.phase === 'scoreboard');
  const scores = firstAt(s, 'game:scores', (p) => p.final);
  return state !== -1 && state < scores && scores < firstAt(s, 'room:players');
};
await finalBoard;
const finished = [ann, ben].map((s) => until(s, 'round:state', (p) => p.phase === 'finished', 15_000));

const calSeat = { name: cal.name, code, token: cal.token, id: cal.id }; // closing it clears the id
cal.io.engine.close(); // a refresh: the connection just dies
await sleep(300);
const calBack = await connect();
const calBackSynced = next(calBack, 'draw:sync');
check('a player refreshing on the final scoreboard resumes',
  (await emit(calBack, 'room:resume', { roomCode: code, token: calSeat.token })).ok === true);
await calBackSynced;
check('...and is sent the final scores', finalOnArrival(calBack), calBack.log.map((e) => e.ev).join(' '));
check('...but no summary yet', received(calBack, 'game:summary').length === 0);
cal = seats[2] = Object.assign(calBack, calSeat);
finished.push(until(cal, 'round:state', (p) => p.phase === 'finished', 15_000));

const fay = await connect();
const fayIn = next(fay, 'room:players');
check('someone joins on the final scoreboard', (await emit(fay, 'room:join', { roomCode: code, name: 'Fay', avatar: 5 })).ok === true);
await fayIn;
check('...and is sent the final scores', finalOnArrival(fay), fay.log.map((e) => e.ev).join(' '));
fay.disconnect(); // and gone before the end, having done nothing

await Promise.all(finished);
await sleep(300); // the final scores follow the phase change

const summaries = seats.map((s) => received(s, 'game:summary'));
const summary = summaries[0][0];
check('every player is sent the summary once', summaries.every((l) => l.length === 1), summaries.map((l) => l.length).join());
check('...the same one, with an id', typeof summary?.id === 'string' && summary.id.length > 0 && summaries.every((l) => same(l[0], summary)));
check('...before the round turns to finished', seats.every((s) =>
  firstAt(s, 'game:summary') !== -1 && firstAt(s, 'game:summary') < firstAt(s, 'round:state', (p) => p.phase === 'finished')));
check('...and before the final scores that follow it', seats.every((s) =>
  firstAt(s, 'game:summary') < lastAt(s, 'game:scores', (p) => p.final)));

const byId = new Map(summary.players.map((p) => [p.id, p]));
const finalScores = received(ann, 'game:scores').at(-1).players;
check('three players, all still here', summary.players.length === 3 && seats.every((s) => byId.get(s.id)?.left === false));
check('scores as in the final scores', summary.players.every((p) => finalScores.find((q) => q.id === p.id)?.score === p.score));
check('...which list Fay too, who is not in the summary: she left with nothing',
  finalScores.some((p) => p.name === 'Fay' && !p.connected) && !summary.players.some((p) => p.name === 'Fay'));
check('best first, ranks by score (ties share)', summary.players.every((p, i, all) =>
  (i === 0 || all[i - 1].score >= p.score) && p.rank === 1 + all.filter((q) => q.score > p.score).length),
  JSON.stringify(summary.players.map((p) => [p.name, p.score, p.rank])));
check('3 turns of 1 round, not abandoned', summary.turns === 3 && summary.rounds === 1 && summary.abandoned === false,
  JSON.stringify({ turns: summary.turns, rounds: summary.rounds, abandoned: summary.abandoned }));
check('each drew once, guessed twice, was solved twice, got one like', summary.players.every((p) =>
  p.drew === 1 && p.guessed === 2 && p.solvedByOthers === 2 && p.likes === 1),
  JSON.stringify(summary.players.map((p) => [p.name, p.drew, p.guessed, p.solvedByOthers, p.likes])));
const firsts = new Map(seats.map((s) => [s.id, turns.filter((t) => t.first === s.id).length]));
check('first guesses counted', summary.players.every((p) => p.firstGuesses === firsts.get(p.id)),
  JSON.stringify(summary.players.map((p) => [p.name, p.firstGuesses])));
check('every guesser has a fastest guess, timed from the drawing\'s start', summary.players.every((p) =>
  p.fastestMs !== null && p.fastestMs >= THINK_MS && p.fastestMs < 15_000),
  JSON.stringify(summary.players.map((p) => [p.name, p.fastestMs])));
const problems = awardProblems(summary);
check(`awards follow the rules (${summary.awards.map((a) => a.id).join(', ')})`, problems.length === 0, problems.join('; '));

const best = summary.best;
check('a drawing of the game, with strokes', best !== null && best.strokes.length > 0);
check('...one of the words drawn, with its like', turns.some((t) => t.word === best?.word) && best?.likes >= 1);
// Every turn scored the same (one like, solved by both): the first one stands.
check('...the first of equals, as drawn on the server', best?.word === turns[0].word && best.drawerId === turns[0].drawerId &&
  same(best.strokes.map((s) => s.points), turns[0].strokes.map((s) => s.points)) && best.strokes.every((s) => s.drawerId === best.drawerId));
check('...solved by 2 of 2', best?.solvers === 2 && best.guessers === 2 && best.dislikes === 0);

/* --- arriving after the end: a refresh and a late invite ------------------- */
/** room:state, then the final scores and the summary, then the roster and the canvas. */
const resentInOrder = (s) => {
  const state = firstAt(s, 'room:state', (p) => p.round.phase === 'finished');
  const scores = firstAt(s, 'game:scores', (p) => p.final);
  const sum = firstAt(s, 'game:summary');
  return state !== -1 && state < scores && scores < sum && sum < firstAt(s, 'room:players') && sum < firstAt(s, 'draw:sync');
};

cal.io.engine.close(); // a refresh: the connection just dies
await sleep(300);
const cal2 = await connect();
const calSynced = next(cal2, 'draw:sync');
check('a player refreshing on the results resumes', (await emit(cal2, 'room:resume', { roomCode: code, token: cal.token })).ok === true);
await calSynced;
check('...and is sent the final scores', received(cal2, 'game:scores').some((p) =>
  p.final && summary.players.every((sp) => p.players.some((q) => q.id === sp.id))));
check('...and the same summary', received(cal2, 'game:summary').length === 1 && same(received(cal2, 'game:summary')[0], summary));
check('...straight after the room state', resentInOrder(cal2), cal2.log.map((e) => e.ev).join(' '));

const dan = await connect();
const danSynced = next(dan, 'draw:sync');
check('someone new joins the finished room', (await emit(dan, 'room:join', { roomCode: code, name: 'Dan', avatar: 3 })).ok === true);
await danSynced;
check('...and is sent the final scores', received(dan, 'game:scores').some((p) => p.final));
check('...and the same summary, which does not list them', same(received(dan, 'game:summary')[0], summary) &&
  !summary.players.some((p) => p.name === 'Dan'));
check('...straight after the room state', resentInOrder(dan), dan.log.map((e) => e.ev).join(' '));

/* --- play again: the summary goes, and the next game gets its own ----------- */
cal2.disconnect();
dan.disconnect(); // leaving Ann and Ben
await sleep(300);
const offer2 = firstOffer([ann, ben]);
check('the host plays again from the results', (await emit(ann, 'room:start', {})).ok === true);
const { sock: d2, choices: c2 } = await offer2;
const g2 = d2 === ann ? ben : ann;
const assigned2 = next(d2, 'word:assigned');
const drawing2 = until(g2, 'round:state', (p) => p.phase === 'drawing');
await emit(d2, 'word:choose', { wordId: c2[0].id });
const word2 = (await assigned2).text;
await drawing2;

const eve = await connect();
const eveState = next(eve, 'room:state');
await emit(eve, 'room:join', { roomCode: code, name: 'Eve', avatar: 4 });
await eveState;
await sleep(800);
check('joining the next game brings no summary', received(eve, 'game:summary').length === 0);
check('...and no final scores', !received(eve, 'game:scores').some((p) => p.final));

// The drawer draws and is liked, then everyone else leaves: the game is
// abandoned mid-drawing, after the departure grace, and keeps that drawing.
const strokes2 = [0, 1].map((i) => stroke(`g2s${i}`, i));
const drawn2 = until(g2, 'draw:stroke', (p) => p.stroke.id === strokes2.at(-1).id);
for (const s of strokes2) d2.emit('draw:stroke', { stroke: s });
await drawn2;
const liked2 = until(d2, 'draw:reaction', (p) => p.reaction === 'up');
g2.emit('draw:react', { reaction: 'up' });
await liked2;
const summary2P = until(d2, 'game:summary', () => true, 20_000);
const finished2 = until(d2, 'round:state', (p) => p.phase === 'finished', 20_000);
g2.disconnect();
eve.disconnect();
const summary2 = await summary2P;
await finished2;
check('the next game\'s summary has a new id', summary2.id !== summary.id);
check('...arriving before its finished state', lastAt(d2, 'game:summary') < lastAt(d2, 'round:state', (p) => p.phase === 'finished'));
check('...abandoned after 1 turn', summary2.abandoned === true && summary2.turns === 1 && summary2.rounds === 1,
  JSON.stringify({ abandoned: summary2.abandoned, turns: summary2.turns, rounds: summary2.rounds }));
check('...keeping the drawing it was cut short on', summary2.best?.word === word2 && summary2.best.drawerId === d2.id &&
  summary2.best.likes === 1 && same(summary2.best.strokes.map((s) => s.points), strokes2.map((s) => s.points)),
  JSON.stringify(summary2.best && { word: summary2.best.word, likes: summary2.best.likes, strokes: summary2.best.strokes.length }));
check('...listing only who took part', summary2.players.length === 1 && summary2.players[0].id === d2.id &&
  summary2.players[0].drew === 1 && summary2.players[0].likes === 1 && summary2.players[0].rank === 1,
  JSON.stringify(summary2.players.map((p) => [p.name, p.score, p.drew, p.left])));
check('...with only the awards that fit two players', same(summary2.awards, [{ id: 'artist', playerId: d2.id, value: 1 }]),
  JSON.stringify(summary2.awards));
d2.disconnect();

/* --- a game of two, its liked drawer kicked at the very end ------------------ */
/**
 * Two rounds of Hal and Ivy, and Hal likes only Ivy's drawings. Between the
 * rounds a second tab takes over Ivy's seat, landing on a scoreboard that is
 * not the last. In the reveal of the last turn Hal kicks Ivy: no turn is left
 * to play, so the game still ends complete, and Ivy's drawings can't be the
 * drawing of the game any more, so Hal's is. Started alongside the game of
 * three; returns what it saw.
 */
async function kickedAtTheEnd() {
  const hal = await connect();
  const halState = next(hal, 'room:state');
  const made = await emit(hal, 'room:create', { name: 'Hal', avatar: 5 });
  hal.id = (await halState).you.playerId;
  let ivy = await connect();
  const ivyState = next(ivy, 'room:state');
  const joined = await emit(ivy, 'room:join', { roomCode: made.roomCode, name: 'Ivy', avatar: 6 });
  Object.assign(ivy, { id: (await ivyState).you.playerId, token: joined.token });
  await emit(hal, 'room:settings', { rounds: 2, drawSeconds: 15, selectSeconds: 5 });
  const isIvy = (s) => s.id === ivy.id;

  const turns = [];
  let table = [hal, ivy];
  let offer = firstOffer(table);
  await emit(hal, 'room:start', {});
  const between = until(hal, 'round:state', (p) => p.phase === 'scoreboard', 30_000);
  for (let t = 0; t < 2; t++) {
    const current = await offer;
    if (t === 0) offer = firstOffer(table, 15_000);
    turns.push(await playTurn(current, `k${t}`, table, isIvy));
  }
  await between;
  const tab = await connect();
  const tabSynced = next(tab, 'draw:sync');
  const resumed = await emit(tab, 'room:resume', { roomCode: made.roomCode, token: ivy.token });
  await tabSynced;
  const betweenRounds = tab.log.slice();
  Object.assign(tab, { id: ivy.id, token: ivy.token });
  ivy.disconnect(); // the old tab: the seat has moved on, so this changes nothing
  ivy = tab;
  table = [hal, ivy];
  offer = firstOffer(table, 15_000);
  for (let t = 2; t < 4; t++) {
    const current = await offer;
    if (t === 2) offer = firstOffer(table, 15_000);
    turns.push(await playTurn(current, `k${t}`, table, isIvy));
  }

  const summary = until(hal, 'game:summary', () => true, 15_000);
  const finished = until(hal, 'round:state', (p) => p.phase === 'finished', 15_000);
  const kicked = await emit(hal, 'player:kick', { playerId: ivy.id });
  const afterKick = hal.log.length;
  const seen = { turns, halId: hal.id, ivyId: ivy.id, resumed, betweenRounds, kicked, summary: await summary };
  await finished;
  hal.disconnect();
  return { ...seen, sinceKick: hal.log.slice(afterKick), halLog: hal.log };
}

const duo = await gameOfTwo;
if (duo.error) check('the game of two runs', false, duo.error.message);
else {
  const tab = duo.betweenRounds;
  check('a second tab takes over a seat between rounds', duo.resumed.ok === true);
  check('...landing on a scoreboard that is not the last: no final scores',
    tab.some((e) => e.ev === 'room:state' && e.p.round.phase === 'scoreboard') && !tab.some((e) => e.ev === 'game:scores'),
    tab.map((e) => e.ev).join(' '));
  check('the host kicks the player with the liked drawings, in the last turn\'s reveal', duo.kicked.ok && duo.kicked.kicked === true);
  const s = duo.summary;
  check('...and the game still ends complete: 4 turns of 2 rounds, not abandoned',
    s.abandoned === false && s.turns === 4 && s.rounds === 2, JSON.stringify({ abandoned: s.abandoned, turns: s.turns, rounds: s.rounds }));
  check('...on schedule, through its final scoreboard', same(
    duo.sinceKick.filter((e) => e.ev === 'round:state').map((e) => e.p.phase), ['scoreboard', 'finished']),
    duo.sinceKick.map((e) => e.ev).join(' '));
  check('...never saying "Not enough players left"',
    !duo.halLog.some((e) => e.ev === 'chat:message' && e.p.text.startsWith('Not enough players left')));
  const halsFirst = duo.turns.find((t) => t.drawerId === duo.halId);
  check('the drawing of the game is still there: the best by someone still here, the first of equals',
    s.best?.drawerId === duo.halId && s.best.word === halsFirst.word && s.best.likes === 0 && s.best.strokes.length === 3,
    JSON.stringify(s.best && { by: s.best.drawerName, word: s.best.word, likes: s.best.likes }));
  check('...and the kicked player is listed, as left, with both likes',
    s.players.some((p) => p.id === duo.ivyId && p.left && p.drew === 2 && p.likes === 2),
    JSON.stringify(s.players.map((p) => [p.name, p.drew, p.likes, p.left])));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('failed:', failures.join('; ')); process.exit(1); }
process.exit(0);
