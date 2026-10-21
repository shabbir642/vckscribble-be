#!/usr/bin/env node
/**
 * Team games and rooms of up to 30, end to end. In the lobby: turning Teams
 * on and off (and on before anyone arrives, the rounds then following the
 * room), joining, shuffling and renaming teams (names that only look alike
 * included), changing how many there are, who may do what, and starting. In
 * play: whose turn it is and who draws (not always the host first), who
 * guesses, who is told the word and when, who hears what, how a turn ends
 * and what it scores, people leaving and arriving mid-game, and the results.
 * Also a room of 30 playing a turn, and what changed for everyone-for-
 * themselves games (the word re-sent on a rejoin, quieter reactions in big
 * rooms). Plus unit checks of the pure parts, imported straight from the
 * source: who draws next, a team game's results, and restoring a snapshot
 * saved before team games existed (on a scratch database, never the server's).
 *
 * The games run side by side, so the checks print by section at the end.
 *
 * Usage: node scripts/smoke-teams.mjs [url]   (~45 s: the longest game sets the pace)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { io } from './lib/io.mjs';

const URL = process.argv[2] ?? 'http://localhost:3001';
const TEAM_IDS = ['mango', 'grape', 'watermelon', 'kiwi'];

/** A section of checks; each section prints in the order it was opened. */
const sections = [];
function section(title) {
  const lines = [];
  sections.push({ title, lines });
  return (label, cond, detail = '') => {
    lines.push({ label, ok: Boolean(cond), detail });
    return Boolean(cond);
  };
}

const connect = () => new Promise((res, rej) => {
  const s = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
  // Everything the socket receives, in order: for what came first, and what never came.
  s.log = [];
  s.onAny((ev, p) => s.log.push({ ev, p }));
  // The room as this socket last heard it.
  s.players = [];
  s.teams = [];
  s.on('room:state', (p) => { s.players = p.players; s.teams = p.teams; s.settings = p.settings; });
  s.on('room:players', (p) => { s.players = p.players; });
  s.on('room:teams', (p) => { s.teams = p.teams; });
  s.once('connect', () => res(s));
  s.once('connect_error', rej);
});
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The first matching event from now on. */
const until = (s, ev, pred = () => true, ms = 8000) => new Promise((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error(`${s.name ?? 'a socket'}: no ${ev} in ${ms} ms`)); }, ms);
  const h = (p) => { if (pred(p)) { clearTimeout(t); s.off(ev, h); res(p); } };
  s.on(ev, h);
});
/** As until, but null rather than a failure when nothing comes. */
const maybe = (s, ev, pred = () => true, ms = 8000) => until(s, ev, pred, ms).catch(() => null);
/** Whichever socket is offered words next. */
const offerAmong = (socks, ms = 20_000) => new Promise((res, rej) => {
  const handlers = new Map();
  const done = () => { clearTimeout(t); for (const [s, h] of handlers) s.off('word:options', h); };
  const t = setTimeout(() => { done(); rej(new Error('no word:options')); }, ms);
  for (const s of socks) {
    const h = (p) => { done(); res({ drawer: s, ...p }); };
    handlers.set(s, h);
    s.on('word:options', h);
  }
});
/** What a socket received of one event since a mark in its log. */
const since = (s, mark, ev) => s.log.slice(mark).filter((e) => e.ev === ev).map((e) => e.p);
const at = (s, ev, pred = () => true) => s.log.findIndex((e) => e.ev === ev && pred(e.p));
/** The round state a socket last received. */
const lastRound = (s) => s.log.findLast((e) => e.ev === 'round:state')?.p;
const teamOf = (s, id = s.pid) => s.players.find((p) => p.id === id)?.teamId ?? null;
const scoreOf = (s, id) => s.players.find((p) => p.id === id)?.score;
/** Players here on each team, in the order asked. */
const hereOn = (players, ids) => ids.map((id) => players.filter((p) => p.teamId === id && p.connected).length);
const spread = (counts) => Math.max(...counts) - Math.min(...counts);
const closeAll = (socks) => socks.forEach((s) => s.close());

async function seat(code, name, avatar) {
  const s = await connect();
  s.name = name;
  const state = until(s, 'room:state');
  const r = code
    ? await emit(s, 'room:join', { roomCode: code, name, avatar })
    : await emit(s, 'room:create', { name, avatar });
  if (!r.ok) throw new Error(`${name} could not get in: ${r.message}`);
  s.code = r.roomCode ?? code;
  s.token = r.token;
  // Not `id`: that is the client's own, and it deletes it when the connection drops.
  s.pid = (await state).you.playerId;
  return s;
}
/** A room with one seat per name, the first the host. */
async function room(names) {
  const socks = [await seat(null, names[0], 0)];
  for (const [i, name] of names.slice(1).entries()) socks.push(await seat(socks[0].code, name, (i + 1) % 12));
  return socks;
}
/** A settings change, and the room's state once the host sees it applied. */
async function setting(host, patch, applied) {
  const state = until(host, 'room:state', applied);
  const r = await emit(host, 'room:settings', patch);
  if (!r.ok) throw new Error(`settings ${JSON.stringify(patch)}: ${r.message}`);
  return state;
}
const teamsOn = (host) => setting(host, { mode: 'teams' }, (p) => p.settings.mode === 'teams');

/** The rounds the server picks as Teams goes on: a game of about 15 minutes by the lobby's estimate. */
function quarterHourRounds(here, teamCount, largest, drawSeconds) {
  if (here >= 20) return 1;
  const round = teamCount * largest * (5 + 0.5 * drawSeconds + 4) + 5;
  let best = 1;
  for (let r = 2; r <= 10; r++) if (Math.abs(r * round - 900) < Math.abs(best * round - 900)) best = r;
  return best;
}
/** Polls until cond() holds or ms pass, for state that arrives in its own time; then says whether it holds. */
async function eventually(cond, ms = 4000) {
  for (const end = Date.now() + ms; !cond() && Date.now() < end;) await sleep(50);
  return cond();
}

/**
 * One team turn, quickly: the drawer takes the first word and, unless told
 * not to, a teammate gets it at once. Resolves at the reveal.
 */
async function teamTurn(socks, offer, team, { guess = true } = {}) {
  const { drawer, choices } = offer;
  const selecting = lastRound(drawer);
  const mates = socks.filter((s) => s !== drawer && s.connected && team(s) === selecting.teamId);
  const assigned = until(drawer, 'word:assigned');
  const drawing = until(drawer, 'round:state', (p) => p.phase === 'drawing');
  const reveal = until(drawer, 'round:state', (p) => p.phase === 'reveal', 25_000);
  await emit(drawer, 'word:choose', { wordId: choices[0].id });
  const word = (await assigned).text;
  await drawing;
  if (guess) mates[0].emit('chat:guess', { text: word });
  return { teamId: selecting.teamId, round: selecting.round, drawer, word, reveal: await reveal };
}

/** Every summary player on exactly one team, and every member a summary player. */
const partitioned = (summary) =>
  summary.players.every((p) => summary.teams.filter((t) => t.memberIds.includes(p.id)).length === 1) &&
  summary.teams.every((t) => t.memberIds.every((id) => summary.players.some((p) => p.id === id)));
const ranked = (teams) =>
  teams.every((t, i) => (i === 0 || teams[i - 1].score >= t.score) && t.rank === 1 + teams.filter((q) => q.score > t.score).length);

/* ------------------------------------------------------- the pure parts */

async function pureParts(check) {
  const { RoomStore, gameTeams, takeDrawer, teamHere, teamNameKey, teamQuota, tidyTeamName } =
    await tsImport('../src/game/store.ts', import.meta.url);
  const { buildSummary, pickAwards, recordGuess, recordTurn, resetSummary, tallyOf } =
    await tsImport('../src/game/summary.ts', import.meta.url);
  const { TEAMS } = await tsImport('../src/contract/index.ts', import.meta.url);
  let sockets = 0;
  const socket = () => `unit-${++sockets}`;
  /** A lobby of n, the first the host. */
  const lobbyOf = (n) => {
    const store = new RoomStore();
    const { room, player } = store.create('Host', 0, socket());
    const players = [player];
    for (let i = 1; i < n; i++) players.push(store.join(room.code, `P${i}`, 0, socket()).player);
    return { store, room, host: player, players };
  };
  const sizes = (room, seated = false) =>
    gameTeams(room).map((t) => (seated ? [...room.players.values()].filter((p) => p.teamId === t.id) : teamHere(room, t)).length);

  // How many teams, by how many are here.
  const counts = [9, 16, 17, 25, 30].map((n) => {
    const { store, room, host } = lobbyOf(n);
    store.updateSettings(room, host.id, { mode: 'teams' });
    return room.settings.teamCount;
  });
  check('Teams on: a team per 8 players or so, 2 to 4', counts.join() === '2,2,3,4,4', counts.join());

  {
    // Seats whose players are away are dealt by seats: even when they come back.
    const { store, room, host, players } = lobbyOf(10);
    for (const p of players.slice(6)) store.disconnect(p.socketId);
    store.updateSettings(room, host.id, { mode: 'teams' });
    check('Teams on with 6 here and 4 away: 3 against 3 here, 5 against 5 seats', sizes(room).join() === '3,3' &&
      sizes(room, true).join() === '5,5', `${sizes(room)} / ${sizes(room, true)}`);
  }
  {
    // A team added to lopsided teams: players move until no two differ by more than one.
    const { store, room, host, players } = lobbyOf(8);
    store.updateSettings(room, host.id, { mode: 'teams' });
    players.forEach((p, i) => store.joinTeam(room, p, i < 6 ? 'mango' : 'grape'));
    store.updateSettings(room, host.id, { teamCount: 3 });
    const three = sizes(room);
    check('a third team for 6 against 2: within one of each other, everyone on one', Math.max(...three) - Math.min(...three) <= 1 &&
      three.reduce((a, b) => a + b) === 8, three.join());
  }
  {
    // The host turns Teams on alone, before sharing the link, and the room fills.
    const { store, room, host } = lobbyOf(1);
    store.updateSettings(room, host.id, { mode: 'teams' });
    const alone = room.settings.rounds;
    let followed = 0;
    for (let i = 1; i < 10; i++) {
      store.join(room.code, `P${i}`, 0, socket());
      if (store.followRoom(room)) followed++;
    }
    check('Teams on alone, then 9 arrive: the rounds follow the room', room.autoRounds && followed > 0 && room.settings.rounds !== alone &&
      room.settings.rounds === quarterHourRounds(10, 2, 5, room.settings.drawSeconds) && room.round.totalRounds === room.settings.rounds,
      `${alone} -> ${room.settings.rounds}`);
    store.updateSettings(room, host.id, { rounds: 6 });
    store.join(room.code, 'P10', 0, socket());
    store.updateSettings(room, host.id, { drawSeconds: 60 });
    check('...until the host sets them', !room.autoRounds && !store.followRoom(room) && room.settings.rounds === 6);
    store.updateSettings(room, host.id, { mode: 'classic' });
    store.updateSettings(room, host.id, { mode: 'teams' });
    check('...or Teams goes off and on again', room.autoRounds && room.settings.rounds === quarterHourRounds(11, 2, 6, 60),
      `rounds ${room.settings.rounds}`);
    room.round = { ...room.round, phase: 'finished' };
    for (let i = 11; i < 20; i++) store.join(room.code, `P${i}`, 0, socket());
    check('...in the lobby only, as every setting', !store.followRoom(room) && room.settings.rounds === quarterHourRounds(11, 2, 6, 60));
    room.round = { ...room.round, phase: 'lobby' };
    check('...catching up with the room once back there', store.followRoom(room) && room.settings.rounds === 1);
    check('...and the number of teams is left alone', room.settings.teamCount === 2);
  }
  {
    const { store, room, host } = lobbyOf(3);
    store.updateSettings(room, host.id, { mode: 'teams', rounds: 2 });
    for (let i = 3; i < 12; i++) store.join(room.code, `P${i}`, 0, socket());
    check('Teams on with the rounds set in the same change: they stay as set', !room.autoRounds && !store.followRoom(room) &&
      room.settings.rounds === 2);
  }
  {
    // 15 and 15 from a game of two teams, switched off and on again: 4 teams for 30.
    const { store, room, host } = lobbyOf(1);
    store.updateSettings(room, host.id, { mode: 'teams' });
    for (let i = 1; i < 30; i++) store.join(room.code, `P${i}`, 0, socket());
    const two = sizes(room).join();
    store.updateSettings(room, host.id, { mode: 'classic' });
    store.updateSettings(room, host.id, { mode: 'teams' });
    const four = sizes(room);
    let start = 'ok';
    try {
      store.assertCanStart(room, host.id);
    } catch (e) {
      start = e.message;
    }
    check('Teams off and on again as 4 teams, remembered as 15 and 15: evened out, and the game can start', two === '15,15' &&
      four.length === 4 && spread(four) <= 1 && start === 'ok', `${two} -> ${four} (${start})`);
  }
  {
    const { store, room, host, players } = lobbyOf(10);
    store.updateSettings(room, host.id, { mode: 'teams' });
    players.forEach((p, i) => store.joinTeam(room, p, i < 7 ? 'mango' : 'grape'));
    store.updateSettings(room, host.id, { mode: 'classic' });
    store.updateSettings(room, host.id, { mode: 'teams' });
    check('...while teams that can all play come back as they were, lopsided or not', players.every((p, i) =>
      p.teamId === (i < 7 ? 'mango' : 'grape')), sizes(room).join());
  }

  // Team names, as they show and as they compare.
  const lookAlikes = ['Team  Grape', 'Team\u00a0Grape', 'Team Grape\u200b', '\u2066Team Grape\u2069', 'Ｔｅａｍ Ｇｒａｐｅ',
    'Team\u3000Grape', 'Team Grape\u3164', 'Team\u2800Grape', 'Team Gr\u200dape', 'Team\tGrape'];
  check('team names that only look different tidy to the same name', lookAlikes.every((n) => tidyTeamName(n) === 'Team Grape'),
    JSON.stringify(lookAlikes.map(tidyTeamName)));
  const joined = ['🧑\u200d💻 Devs', '🏳\ufe0f\u200d🌈 Pride', '❤\ufe0f\u200d🔥 Hot', 'ශ්\u200dරී', 'র\u200d্যাব', 'Équipe'];
  check('...an emoji or a conjunct keeping its joiners', joined.every((n) => tidyTeamName(n) === n), JSON.stringify(joined.map(tidyTeamName)));
  check('...a name that shows nothing is empty', ['\u200b', '\u200d\u2060', '\u3164 \u2800'].every((n) => tidyTeamName(n) === ''));
  check('...and names compare as they read: case, joiners and selectors aside', teamNameKey('🍇\u200d🍇 Squad') === teamNameKey('🍇🍇 squad') &&
    teamNameKey('Crème\ufe0f') === teamNameKey('CRÈME') && teamNameKey('Team Grape') !== teamNameKey('TeamGrape'));

  const store = new RoomStore();
  const { room, player: host } = store.create('Host', 0, socket());
  const [bea, cy, dot, eve] = ['Bea', 'Cy', 'Dot', 'Eve'].map((name) => store.join(room.code, name, 1, socket()).player);
  store.updateSettings(room, host.id, { mode: 'teams' });
  for (const p of [host, bea, cy]) store.joinTeam(room, p, 'mango');
  for (const p of [dot, eve]) store.joinTeam(room, p, 'grape');
  const [mango, grape] = gameTeams(room);
  const sorted = (ids) => [...ids].sort().join();
  check('each team keeps its players in a rotation', sorted(mango.rotation) === sorted([host.id, bea.id, cy.id]) &&
    sorted(grape.rotation) === sorted([dot.id, eve.id]), JSON.stringify([mango.rotation, grape.rotation]));
  check('a round is a turn for each player of the largest team here', teamQuota(room) === 3);

  mango.drawn.clear();
  const [r0, r1, r2] = mango.rotation;
  const picks = [takeDrawer(room, mango)?.id];
  const away = room.players.get(r1);
  store.disconnect(away.socketId);
  check('...one fewer while one of them is away', teamQuota(room) === 2);
  picks.push(takeDrawer(room, mango)?.id);
  store.resume(room.code, away.token, socket());
  picks.push(takeDrawer(room, mango)?.id, takeDrawer(room, mango)?.id);
  check('who draws: rotation order, someone away passed over but keeping their place, then round again',
    picks.join() === [r0, r2, r1, r0].join(), JSON.stringify({ picks, rotation: [r0, r1, r2] }));
  grape.drawn.clear();
  const twice = [0, 1, 2].map(() => takeDrawer(room, grape)?.id);
  check('a smaller team goes round again', twice[0] !== twice[1] && twice[2] === twice[0], JSON.stringify(twice));

  // A finished team game as the summary sees it: level at the top, and a
  // player kicked mid-game whose seat has gone.
  resetSummary(room);
  const fin = store.join(room.code, 'Fin', 2, socket()).player;
  check('a newcomer joins the team with the fewest players here', fin.teamId === 'grape');
  mango.score = 300;
  grape.score = 300;
  bea.score = host.score = 150;
  dot.score = fin.score = 150;
  recordGuess(room, bea, 0, 1200);
  recordGuess(room, dot, 0, 900);
  tallyOf(room, host).drew = 1;
  tallyOf(room, fin).drew = 1;
  // Mango's turn as it ends: only Mango could have guessed it.
  room.active = { wordId: null, text: 'cat', normalized: 'cat', custom: true };
  room.strokes = [{ id: 's1', drawerId: host.id, tool: 'brush', color: '#000000', size: 0.01, points: [1, 2, 3, 4] }];
  room.round = { ...room.round, drawerId: host.id, teamId: 'mango', guessedPlayerIds: [bea.id], likes: 1, dislikes: 0 };
  recordTurn(room);
  check('the drawing of the game counts only the drawing team as could-have-guessed',
    room.bestTurns[0]?.drawing.guessers === 2, JSON.stringify(room.bestTurns[0]?.drawing.guessers));
  store.removePlayer(room, fin);
  const summary = buildSummary(room, 1, false);
  check('a team game summary: mode and teams, best first, level teams sharing first place', summary.mode === 'teams' &&
    summary.teams.map((t) => `${t.id}:${t.score}:${t.rank}`).join() === 'mango:300:1,grape:300:1',
    JSON.stringify(summary.teams));
  check('...every player on exactly one team, every member a player', partitioned(summary), JSON.stringify(summary.teams));
  check('...one kicked mid-game listed with the team the tally saw them on', summary.players.some((p) => p.id === fin.id && p.left) &&
    summary.teams.find((t) => t.id === 'grape').memberIds.includes(fin.id));
  check('...and no "first in" award: every right answer is the first', !summary.awards.some((a) => a.id === 'trailblazer') &&
    pickAwards(summary.players).some((a) => a.id === 'trailblazer'), JSON.stringify(summary.awards));
  room.settings.mode = 'classic';
  const classic = buildSummary(room, 1, false);
  check('...while everyone-for-themselves summaries say so, with no teams', classic.mode === 'classic' && classic.teams === null);

  // A snapshot as contract 15 saved it, restored on a scratch database.
  const dir = mkdtempSync(join(tmpdir(), 'smoke-teams-'));
  process.env.DATABASE_URL = join(dir, 'game.db');
  try {
    const { ensureSnapshotTable, loadRooms, saveRooms } = await tsImport('../src/game/persist.ts', import.meta.url);
    ensureSnapshotTable();
    const old = new RoomStore();
    const done = old.create('Old', 0, socket()).room;
    const late = old.join(done.code, 'Late', 1, socket()).player;
    resetSummary(done);
    tallyOf(done, late).guessed = 1;
    done.round = { ...done.round, phase: 'finished', round: 1 };
    done.summary = buildSummary(done, 1, false);
    const lobby = old.create('Lobby', 0, socket()).room;
    for (const name of ['Mate', 'Pal', 'Kin']) old.join(lobby.code, name, 1, socket());
    // Saved today: a team lobby whose rounds follow it.
    const following = old.create('Follow', 0, socket()).room;
    old.updateSettings(following, following.hostId, { mode: 'teams' });
    for (const r of [done, lobby]) {
      for (const key of ['teams', 'teamGames', 'teamStart', 'teamQuota', 'autoRounds']) delete r[key];
      delete r.settings.mode;
      delete r.settings.teamCount;
      delete r.round.teamId;
      for (const p of r.players.values()) { delete p.teamId; delete p.lastTeamId; }
      for (const t of r.tally.values()) delete t.teamId;
      if (r.summary) { delete r.summary.mode; delete r.summary.teams; }
    }
    saveRooms([done, lobby, following]);
    const back = new Map(loadRooms().map(({ room: r }) => [r.code, r]));
    const d = back.get(done.code);
    const l = back.get(lobby.code);
    check('a snapshot from before team games is restored', Boolean(d && l));
    check('...with rounds that stay as they were set', d.autoRounds === false && l.autoRounds === false);
    check('a team lobby whose rounds follow it still does after a restart', back.get(following.code)?.autoRounds === true);
    check('...as a game of everyone for themselves', d.settings.mode === 'classic' && d.settings.teamCount === 2 && l.settings.mode === 'classic');
    check('...every seat, round and tally line on no team, explicitly', [...d.players.values(), ...l.players.values()].every((p) =>
      p.teamId === null && p.lastTeamId === null) && d.round.teamId === null && l.round.teamId === null &&
      d.tally.size === 1 && [...d.tally.values()].every((t) => t.teamId === null));
    check('...the four teams as a new room has them', l.teams.map((t) => `${t.id}:${t.name}:${t.score}:${t.rotation.length}:${t.drawn.size}`).join() ===
      TEAMS.map((t) => `${t.id}:${t.name}:0:0:0`).join() && l.teamGames === 0 && l.teamStart === 0 && l.teamQuota === 0);
    check('...its kept summary marked as everyone for themselves', d.summary.mode === 'classic' && d.summary.teams === null);
    const now = new RoomStore();
    now.adopt(d, 60_000);
    now.adopt(l, 60_000);
    check('...and served as one', now.publicPlayers(d).every((p) => p.teamId === null) && now.publicTeams(d).length === 0 &&
      now.preview(d.code).mode === 'classic');
    now.updateSettings(l, l.hostId, { mode: 'teams' });
    check('...in which Teams can go on: everyone dealt in, away or not', now.publicTeams(l).length === 2 &&
      [...l.players.values()].every((p) => p.teamId === 'mango' || p.teamId === 'grape'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------ the lobby */

async function lobby(check) {
  const socks = await room(['Ann', 'Ben', 'Cal', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo']);
  const [ann] = socks;
  const sockOf = (id) => socks.find((s) => s.pid === id);

  check('max players goes up to 30', (await emit(ann, 'room:settings', { maxPlayers: 30 })).ok === true);
  check('...and no further', (await emit(ann, 'room:settings', { maxPlayers: 31 })).code === 'INVALID');
  check('2 to 4 teams: not 5', (await emit(ann, 'room:settings', { teamCount: 5 })).code === 'INVALID');
  check('...nor 1', (await emit(ann, 'room:settings', { teamCount: 1 })).code === 'INVALID');
  check('no mode but the two', (await emit(ann, 'room:settings', { mode: 'pairs' })).code === 'INVALID');
  check('no joining a team while everyone plays for themselves', (await emit(socks[1], 'team:join', { teamId: 'mango' })).code === 'INVALID');

  let st = await teamsOn(ann);
  const halves = hereOn(st.players, ['mango', 'grape']);
  check('Teams on: 2 teams for 10 players', st.settings.teamCount === 2 && st.teams.map((t) => t.id).join() === 'mango,grape',
    JSON.stringify(st.teams));
  check('...with their own names and no points yet', st.teams.map((t) => `${t.name}:${t.score}`).join() === 'Team Mango:0,Team Grape:0');
  check('...everyone dealt in evenly', halves.join() === '5,5' && st.players.every((p) => p.teamId), halves.join());
  check('...and rounds for a game of about 15 minutes', st.settings.rounds === quarterHourRounds(10, 2, 5, st.settings.drawSeconds),
    `rounds ${st.settings.rounds}`);
  const visitor = await connect();
  const peek = await emit(visitor, 'room:peek', { roomCode: ann.code });
  visitor.close();
  check('an invite says it is a team game', peek.ok && peek.mode === 'teams' && peek.maxPlayers === 30, JSON.stringify(peek));

  // Two of Mango step away; seats are kept, but only players here count.
  const away = st.players.filter((p) => p.teamId === 'mango' && !p.isHost).slice(0, 2);
  const gone = until(ann, 'room:players', (p) => away.every((a) => !p.players.find((q) => q.id === a.id)?.connected));
  for (const a of away) sockOf(a.id).disconnect();
  await gone;
  const kim = await seat(ann.code, 'Kim', 10);
  socks.push(kim);
  check('a newcomer joins the team with the fewest players here (3 here and 2 away, against 5)', teamOf(kim) === 'mango',
    JSON.stringify(hereOn(kim.players, ['mango', 'grape'])));

  const ben = sockOf(st.players.find((p) => p.teamId === 'grape' && !p.isHost).id);
  const moved = maybe(ann, 'room:players', (p) => p.players.find((q) => q.id === ben.pid)?.teamId === 'mango');
  check('a player moves to another team', (await emit(ben, 'team:join', { teamId: 'mango' })).ok === true);
  check('...and everyone sees it', Boolean(await moved));
  check('...but not to a team outside the game', (await emit(ben, 'team:join', { teamId: 'kiwi' })).code === 'INVALID');
  check('...nor to one that does not exist', (await emit(ben, 'team:join', { teamId: 'banana' })).code === 'INVALID');
  const hopper = sockOf(ann.players.find((p) => p.teamId === 'grape' && p.connected && !p.isHost && p.id !== ben.pid).id);
  const hops = await Promise.all([0, 1, 2, 3, 4, 5, 6].map((i) => emit(hopper, 'team:join', { teamId: i % 2 ? 'grape' : 'mango' })));
  check('hopping between teams is rate limited', hops.some((r) => r.code === 'RATE_LIMITED'), JSON.stringify(hops.map((r) => r.code ?? 'ok')));
  await sleep(400); // the last hops' rosters

  const remembered = new Map(ann.players.map((p) => [p.id, p.teamId]));
  st = await setting(ann, { mode: 'classic' }, (p) => p.settings.mode === 'classic');
  check('Teams off: no teams, nobody on one', st.teams.length === 0 && st.players.every((p) => p.teamId === null));
  const lee = await seat(ann.code, 'Lee', 11);
  socks.push(lee);
  check('...nor anyone who joins now', teamOf(lee) === null);
  st = await teamsOn(ann);
  check('Teams back on: everyone is back on their own team, away or not', [...remembered].every(([id, team]) =>
    st.players.find((p) => p.id === id)?.teamId === team), JSON.stringify(st.players.map((p) => [p.name, p.teamId])));
  const others = st.players.filter((p) => p.id !== lee.pid);
  const need = (id) => [others.filter((p) => p.teamId === id && p.connected).length, others.filter((p) => p.teamId === id).length];
  const want = ['mango', 'grape'].sort((a, b) => need(a)[0] - need(b)[0] || need(a)[1] - need(b)[1])[0];
  check('...and the newcomer is dealt onto the team with the fewest here', st.players.find((p) => p.id === lee.pid)?.teamId === want,
    JSON.stringify({ want, mango: need('mango'), grape: need('grape') }));

  st = await setting(ann, { teamCount: 4 }, (p) => p.settings.teamCount === 4);
  check('4 teams: everyone on one of them', st.teams.map((t) => t.id).join() === TEAM_IDS.join() &&
    st.players.every((p) => TEAM_IDS.includes(p.teamId)));
  check('...the players here spread to within one of each other', spread(hereOn(st.players, TEAM_IDS)) <= 1,
    hereOn(st.players, TEAM_IDS).join());
  const leaver = st.players.find((p) => (p.teamId === 'watermelon' || p.teamId === 'kiwi') && p.connected && !p.isHost);
  const left = until(ann, 'room:players', (p) => !p.players.find((q) => q.id === leaver.id)?.connected);
  sockOf(leaver.id).disconnect();
  await left;
  st = await setting(ann, { teamCount: 2 }, (p) => p.settings.teamCount === 2);
  check('back to 2: every seat on one of them, someone away from a team that went too', st.teams.length === 2 &&
    st.players.every((p) => p.teamId === 'mango' || p.teamId === 'grape'), JSON.stringify(st.players.map((p) => [p.name, p.teamId])));

  const here = () => socks.filter((s) => s.connected);
  const guest = here().find((s) => s !== ann);
  check('only the host shuffles', (await emit(guest, 'team:shuffle', {})).code === 'NOT_HOST');
  // The line follows the new roster.
  const told = maybe(ann, 'chat:message', (m) => m.text === 'Ann shuffled the teams');
  check('the host shuffles', (await emit(ann, 'team:shuffle', {})).ok === true);
  check('...and everyone is told', Boolean(await told));
  check('...into even teams', spread(hereOn(ann.players, ['mango', 'grape'])) <= 1 &&
    ann.players.every((p) => p.teamId === 'mango' || p.teamId === 'grape'), hereOn(ann.players, ['mango', 'grape']).join());

  const onTeam = (id) => here().find((s) => s !== ann && teamOf(ann, s.pid) === id);
  const m = onTeam('mango');
  const g = onTeam('grape');
  const rename = (s, teamId, name) => emit(s, 'team:rename', { teamId, name });
  /** A rename everyone should then see. */
  const renamed = async (s, teamId, name, shown) => {
    const seen = maybe(ann, 'room:teams', (p) => p.teams.find((t) => t.id === teamId)?.name === shown);
    const r = await rename(s, teamId, name);
    return r.ok && Boolean(await seen);
  };
  check("a player can't rename another team", (await rename(g, 'mango', 'Grapes Rule')).code === 'NOT_HOST');
  const line = maybe(ann, 'chat:message', (msg) => msg.text === `${m.name} renamed Team Mango to Mango Lassi`);
  check('a player renames their own team, and everyone sees it', await renamed(m, 'mango', 'Mango Lassi', 'Mango Lassi'));
  check('...and is told', Boolean(await line));
  check('names are unique, ignoring case', (await rename(ann, 'grape', 'mango LASSI')).code === 'INVALID');
  check('...across all four teams, defaults included', (await rename(ann, 'grape', 'team kiwi')).code === 'INVALID');
  check('a name is trimmed', await renamed(g, 'grape', '  Grapes of Wrath  ', 'Grapes of Wrath'));
  check('the host renames any team, even to a name another team has given up', await renamed(ann, 'mango', 'Team Grape', 'Team Grape'));
  const taken = await rename(g, 'grape', '');
  check('an empty name brings the default back, but not while another team has it',
    taken.code === 'INVALID' && taken.message.includes('Team Grape'), JSON.stringify(taken));
  check('...and does once it is free', await renamed(m, 'mango', '', 'Team Mango'));
  check('the word filter applies', (await rename(m, 'mango', 'shit happens')).code === 'WORD_BLOCKED');
  check(`20 characters at most`, (await rename(m, 'mango', 'x'.repeat(21))).code === 'INVALID');
  check('no renaming a team outside the game', (await rename(ann, 'kiwi', 'Kiwis')).code === 'INVALID');
  closeAll(socks);
}

async function shortTeam(check) {
  const socks = await room(['Uma', 'Vic', 'Wes']);
  const [uma] = socks;
  await teamsOn(uma);
  let r = await emit(uma, 'room:start', {});
  check('a team one short cannot start, and the message names it', r.code === 'INVALID' && r.message === 'Team Grape needs 1 more player',
    JSON.stringify(r));
  await setting(uma, { teamCount: 3 }, (p) => p.settings.teamCount === 3);
  r = await emit(uma, 'room:start', {});
  check('...the first short team, in order', r.code === 'INVALID' && r.message === 'Team Mango needs 1 more player', JSON.stringify(r));
  closeAll(socks);
}

async function voteKick(check) {
  const socks = await room(['Ada', 'Bo', 'Cy', 'Di', 'Ed', 'Flo']);
  const [ada, bo, cy, di, ed, flo] = socks;
  await teamsOn(ada);
  for (const s of [bo, cy]) await emit(s, 'team:join', { teamId: 'mango' });
  for (const s of [ada, di, ed, flo]) await emit(s, 'team:join', { teamId: 'grape' });
  await sleep(300);
  check('Mango: Bo and Cy; Grape: the other four', ada.players.filter((p) => p.teamId === 'mango').map((p) => p.name).sort().join() === 'Bo,Cy');
  // 6 here: a majority is 3, which Grape has on its own.
  await emit(di, 'player:kick', { playerId: bo.pid });
  await emit(ed, 'player:kick', { playerId: bo.pid });
  const said = until(ada, 'chat:message', (m) => m.text.startsWith(`Flo voted to kick Bo`));
  let r = await emit(flo, 'player:kick', { playerId: bo.pid });
  check('the other team alone cannot vote a player out', r.ok && !r.kicked && r.votes === 3 && r.needed === 3, JSON.stringify(r));
  const line = (await said).text;
  check('...and the chat says what is missing', line === 'Flo voted to kick Bo (3/3). It needs a vote from Team Mango too.', line);
  const kicked = until(bo, 'room:kicked');
  r = await emit(cy, 'player:kick', { playerId: bo.pid });
  check('a vote from their own team carries it', r.ok && r.kicked === true, JSON.stringify(r));
  check('...and they are told', (await kicked).by === 'vote');
  closeAll(socks);
}

/**
 * Teams on before anyone arrives, the usual way: the host sets the room up,
 * then shares the link. The rounds follow the room as people come and go,
 * and the draw time, until the host sets them; the number of teams stays.
 */
async function earlyTeams(check) {
  const host = await seat(null, 'Hana', 0);
  const socks = [host];
  const inRoom = () => socks.filter((s) => s.connected && !s.kicked);
  const roundsEverywhere = (n) => eventually(() => inRoom().every((s) => s.settings?.rounds === n));
  const seen = () => JSON.stringify([...new Set(inRoom().map((s) => s.settings?.rounds))]);
  let st = await teamsOn(host);
  const alone = st.settings.rounds;
  check('Teams on alone: 2 teams, and rounds for a game of about 15 minutes', st.settings.teamCount === 2 &&
    alone === quarterHourRounds(1, 2, 1, st.settings.drawSeconds), `rounds ${alone}`);

  // Dealt as they come: the host and 4 more on Mango, 4 on Grape.
  for (let i = 1; i <= 8; i++) socks.push(await seat(host.code, `Early ${i}`, i % 12));
  let want = quarterHourRounds(9, 2, 5, st.settings.drawSeconds);
  check('8 arrive: the rounds follow the room, on every screen', want !== alone && await roundsEverywhere(want), seen());
  st = await setting(host, { drawSeconds: 60 }, (p) => p.settings.drawSeconds === 60);
  check('...and the draw time', st.settings.rounds === quarterHourRounds(9, 2, 5, 60) && st.settings.rounds !== want,
    `rounds ${st.settings.rounds}`);

  const mango = () => inRoom().filter((s) => s !== host && teamOf(host, s.pid) === 'mango');
  const leaver = mango()[0];
  leaver.disconnect();
  check('one of Mango leaving, 4 against 4: the rounds follow', await roundsEverywhere(quarterHourRounds(8, 2, 4, 60)), seen());
  const back = await connect();
  socks.push(back);
  const resumed = await emit(back, 'room:resume', { roomCode: host.code, token: leaver.token });
  check('...coming back', resumed.ok && await roundsEverywhere(quarterHourRounds(9, 2, 5, 60)), seen());
  const target = mango()[0];
  const gone = until(target, 'room:kicked');
  await emit(host, 'player:kick', { playerId: target.pid });
  await gone;
  target.kicked = true;
  check('...someone kicked', await roundsEverywhere(quarterHourRounds(8, 2, 4, 60)), seen());
  socks.push(await seat(host.code, 'Early 9', 9));
  check('...someone new', await roundsEverywhere(quarterHourRounds(9, 2, 5, 60)), seen());
  for (let i = 10; i <= 30; i++) socks.push(await seat(host.code, `Early ${i}`, i % 12));
  check('30 here: one round, on every screen', await roundsEverywhere(1), seen());
  check('...and still the 2 teams the host had, 15 against 15', await eventually(() =>
    hereOn(host.players, ['mango', 'grape']).join() === '15,15') && inRoom().every((s) => s.settings.teamCount === 2),
  hereOn(host.players, ['mango', 'grape']).join());

  st = await setting(host, { rounds: 3 }, (p) => p.settings.rounds === 3);
  const mark = host.log.length;
  const quitter = inRoom().at(-1);
  const left = until(host, 'room:players', (p) => !p.players.find((q) => q.id === quitter.pid)?.connected);
  quitter.disconnect();
  await left;
  socks.push(await seat(host.code, 'Early 31', 7));
  st = await setting(host, { drawSeconds: 30 }, (p) => p.settings.drawSeconds === 30);
  check('the host sets the rounds: they stay as set, whoever comes and goes', st.settings.rounds === 3 &&
    since(host, mark, 'room:state').length === 1, JSON.stringify(since(host, mark, 'room:state').map((p) => p.settings.rounds)));

  await setting(host, { mode: 'classic' }, (p) => p.settings.mode === 'classic');
  st = await teamsOn(host);
  const four = hereOn(st.players, TEAM_IDS);
  check('Teams off and on again: 4 teams for 30, evened out from 15 and 15', st.settings.teamCount === 4 && spread(four) <= 1 &&
    Math.min(...four) >= 2, four.join());
  check('...the rounds following the room again', st.settings.rounds === 1, `rounds ${st.settings.rounds}`);
  const started = await emit(host, 'room:start', {});
  check('...and the game starts', started.ok === true, JSON.stringify(started));
  closeAll(socks);
}

/** Team names that only look different are the same name. */
async function lookAlikes(check) {
  const socks = await room(['Ola', 'Pim', 'Quy', 'Rex']);
  const [ola] = socks;
  await teamsOn(ola);
  const mate = socks.find((s) => s !== ola && teamOf(ola, s.pid) === 'mango');
  const rename = (s, name) => emit(s, 'team:rename', { teamId: 'mango', name });
  // Grape is still Team Grape.
  for (const [s, but, name] of [
    [ola, 'two spaces', 'Team  Grape'],
    [ola, 'a non-breaking space', 'Team\u00a0Grape'],
    [ola, 'a zero-width space', 'Team Grape\u200b'],
    [mate, 'full-width letters', 'Ｔｅａｍ Ｇｒａｐｅ'],
    [mate, 'a direction mark and a filler', '\u200eTeam Grape\u3164'],
  ]) {
    const r = await rename(s, name);
    check(`a name that is another team's but for ${but} is taken`, r.code === 'INVALID', JSON.stringify(r));
  }
  const shown = (name) => maybe(ola, 'room:teams', (p) => p.teams.find((t) => t.id === 'mango')?.name === name, 3000);
  let seen = shown('🧑\u200d💻 Devs');
  check('an emoji that is joined up keeps its joiner', (await rename(mate, '🧑\u200d💻 Devs')).ok && Boolean(await seen));
  seen = shown('Mango Lassi');
  check('a name shows as it reads: spaces collapsed, nothing hidden', (await rename(ola, '  Mango\u200b  Lassi ')).ok &&
    Boolean(await seen));
  seen = shown('Team Mango');
  check('...one that shows nothing brings the default back', (await rename(ola, '\u200b\u2060')).ok && Boolean(await seen));
  check('...and the limit counts what shows', (await rename(mate, `${'x'.repeat(20)}\u200b\u200b`)).ok === true);
  closeAll(socks);
}

/* -------------------------------------------------------------- in play */

/**
 * A game of 3 against 2, one round: six turns. The first has every check on
 * who sees and hears what; in the second nobody guesses.
 */
async function threeAgainstTwo(check) {
  const socks = await room(['Ana', 'Bea', 'Cas', 'Dov', 'Eli']);
  const [host] = socks;
  await teamsOn(host);
  await setting(host, { rounds: 1, drawSeconds: 15, selectSeconds: 5 }, (p) => p.settings.rounds === 1 && p.settings.drawSeconds === 15);
  const team = (s) => teamOf(host, s.pid);
  const mango = socks.filter((s) => team(s) === 'mango');
  const grape = socks.filter((s) => team(s) === 'grape');
  check('5 players make 3 against 2', mango.length === 3 && grape.length === 2);

  const turns = [];
  let offer = offerAmong(socks);
  // The teams' scores follow the ack, with the roster.
  const started = Promise.all(socks.map((s) => maybe(s, 'room:teams')));
  check('the game starts', (await emit(host, 'room:start', {})).ok === true);
  check('...with the teams on no points, sent to everyone', (await started).every((p) =>
    p?.teams.length === 2 && p.teams.every((t) => t.score === 0)));

  /* Mango's turn. */
  {
    const o = await offer;
    const { drawer } = o;
    const selecting = lastRound(drawer);
    check('Mango starts the room\'s first game', selecting.teamId === 'mango' && team(drawer) === 'mango', JSON.stringify(selecting));
    check('...and everyone is told who is up', at(drawer, 'chat:message', (m) => m.text === `Team Mango is up: ${drawer.name} is choosing a word…`) !== -1);
    check('a drawer may not write their own word in a team game', o.allowCustom === false);
    check('...even by asking', (await emit(drawer, 'word:custom', { text: 'Quarterly Synergy Review' })).code === 'INVALID');
    const mates = mango.filter((s) => s !== drawer);
    const [w0, w1] = grape;
    const toast = until(w0, 'error:toast');
    w0.emit('chat:guess', { text: 'what will it be' });
    const t = await toast;
    check('the other team chats once the drawing starts', t.code === 'BAD_PHASE' && t.message === 'You can chat once they start drawing',
      JSON.stringify(t));

    const marks = new Map(socks.map((s) => [s, s.log.length]));
    const told = grape.map((w) => maybe(w, 'word:assigned').then((p) => p?.text ?? null));
    const assigned = until(drawer, 'word:assigned');
    const drawing = Promise.all(socks.map((s) => until(s, 'round:state', (p) => p.phase === 'drawing')));
    await emit(drawer, 'word:choose', { wordId: o.choices[0].id });
    const word = (await assigned).text;
    await drawing;
    check('the other team is told the word as the drawing starts', (await Promise.all(told)).every((w) => w === word));

    const wrong = Promise.all(socks.map((s) => until(s, 'chat:message', (m) => m.text === 'definitely not it')));
    mates[0].emit('chat:guess', { text: 'definitely not it' });
    check('a wrong guess is shown to everyone', (await wrong).every((m) => m.channel === 'guess' && m.tone === 'wrong'));

    const near = word.slice(0, -1) + (word.endsWith('x') ? 'y' : 'x');
    const notes = mango.map((s) => maybe(s, 'chat:close').then((p) => p?.text ?? null));
    mates[0].emit('chat:guess', { text: near });
    const heard = await Promise.all(notes);
    check('a near miss is told to the whole drawing team, the drawer too', heard.every((n) => n === `${mates[0].name}'s “${near}” is close!`),
      JSON.stringify(heard));

    const talk = Promise.all(grape.map((s) => until(s, 'chat:message', (m) => m.text === 'they will never get it')));
    w0.emit('chat:guess', { text: 'they will never get it' });
    check("a watcher's message reaches every watcher, the sender too", (await talk).every((m) => m.channel === 'watchers' && m.playerId === w0.pid));
    const spoken = Promise.all(grape.map((s) => until(s, 'chat:message', (m) => m.channel === 'watchers' && m.text === word)));
    w1.emit('chat:guess', { text: word });
    await spoken;
    const reacted = until(drawer, 'draw:reaction');
    w0.emit('draw:react', { reaction: 'up' });
    await reacted;
    await sleep(400);
    check('...and never reaches the drawing team', mango.every((s) => !since(s, marks.get(s), 'chat:message').some((m) => m.channel === 'watchers')));
    check('a watcher typing the word is no guess: the turn goes on, nobody scores',
      !since(drawer, marks.get(drawer), 'round:state').some((p) => p.phase !== 'drawing') && socks.every((s) => !since(s, marks.get(s), 'room:teams').length));
    check('a reaction gets no line in the chat in a team game', !since(host, marks.get(host), 'chat:message').some((m) => m.text.includes('liked the drawing')));
    check('the drawing team\'s guessers are never told the word', mates.every((s) => !s.log.some((e) => e.ev === 'word:assigned')));

    const ended = until(host, 'chat:message', (m) => m.text === `Team Mango got it! The word was “${word}”.`);
    const before = mates[1].log.length;
    mates[0].emit('chat:guess', { text: word });
    await ended;
    const points = host.teams.find((x) => x.id === 'mango')?.score ?? 0;
    check('the first right answer wins the turn: the same points to the team, the guesser and the drawer', points > 0 &&
      scoreOf(host, mates[0].pid) === points && scoreOf(host, drawer.pid) === points && scoreOf(host, mates[1].pid) === 0 &&
      grape.every((s) => scoreOf(host, s.pid) === 0), JSON.stringify({ points, players: host.players.map((p) => [p.name, p.score]) }));
    check('...announced as "guessed it" for the team', at(host, 'chat:message', (m) => m.text === `${mates[0].name} guessed it for Team Mango!`) !== -1);
    const reveal = at(mates[1], 'round:state', (p) => p.phase === 'reveal');
    const scores = at(mates[1], 'room:teams', (p) => p.teams.some((x) => x.score > 0));
    check('...the team\'s new score arriving before the reveal', scores >= before && scores < reveal, `${scores} < ${reveal}`);
    check('...which still names the team', lastRound(host)?.teamId === 'mango' && lastRound(host)?.solution === word);
    turns.push({ teamId: 'mango', drawer: drawer.pid });
  }

  /* Grape's turn: nobody gets it. */
  {
    const o = await offerAmong(socks);
    const selecting = lastRound(o.drawer);
    const assigned = until(o.drawer, 'word:assigned');
    const drawing = until(o.drawer, 'round:state', (p) => p.phase === 'drawing');
    await emit(o.drawer, 'word:choose', { wordId: o.choices[0].id });
    const word = (await assigned).text;
    await drawing;
    const scores = new Map(host.players.map((p) => [p.id, p.score]));
    const ended = until(host, 'chat:message', (m) => m.text === `Time's up! Nobody on Team Grape got “${word}”.`, 25_000);
    mango[0].emit('chat:guess', { text: word }); // a watcher: no guess
    await ended;
    check('Grape next: time runs out, and nobody scores', selecting.teamId === 'grape' &&
      host.teams.find((x) => x.id === 'grape')?.score === 0 && host.players.every((p) => scores.get(p.id) === p.score));
    turns.push({ teamId: 'grape', drawer: o.drawer.pid });
  }

  for (let t = 2; t < 6; t++) {
    const turn = await teamTurn(socks, await offerAmong(socks), team);
    turns.push({ teamId: turn.teamId, drawer: turn.drawer.pid });
  }
  const summaryP = until(host, 'game:summary', () => true, 20_000);
  const finishedP = until(host, 'round:state', (p) => p.phase === 'finished', 20_000);
  const summary = await summaryP;
  await finishedP;

  check('the teams take turns', turns.map((t) => t.teamId).join() === 'mango,grape,mango,grape,mango,grape',
    turns.map((t) => t.teamId).join());
  const drew = (id) => turns.filter((t) => t.teamId === id).map((t) => t.drawer);
  check('everyone on the bigger team draws once in the round', new Set(drew('mango')).size === 3);
  check('...and the smaller team draws as often, going round again', drew('grape').length === 3 && new Set(drew('grape')).size === 2,
    JSON.stringify(drew('grape')));
  check('the scoreboard names no team', host.log.some((e) => e.ev === 'round:state' && e.p.phase === 'scoreboard' && e.p.teamId === null));
  check('the summary is a team game\'s', summary.mode === 'teams' && summary.teams?.length === 2 && summary.turns === 6 &&
    summary.rounds === 1 && !summary.abandoned, JSON.stringify({ ...summary, best: undefined }));
  check('...teams best first, with their scores and ranks', ranked(summary.teams) &&
    summary.teams.every((t) => t.score === host.teams.find((x) => x.id === t.id)?.score), JSON.stringify(summary.teams));
  check('...every player on exactly one team, every member a player', partitioned(summary) &&
    summary.teams.every((t) => t.memberIds.every((id) => team({ pid: id }) === t.id)), JSON.stringify(summary.teams));
  check('...and no "first in" award', !summary.awards.some((a) => a.id === 'trailblazer'), JSON.stringify(summary.awards));
  const best = summary.best;
  check('...a drawing of the game guessable by its own team only', !best ||
    best.guessers === (team({ pid: best.drawerId }) === 'mango' ? 2 : 1), JSON.stringify(best && { by: best.drawerName, guessers: best.guessers }));
  check('...and the game ends with no team up', lastRound(host)?.teamId === null);

  // Play again, straight from the results.
  const before = host.teams.map((t) => t.score);
  const zeroed = until(host, 'room:teams');
  offer = offerAmong(socks);
  check('play again', (await emit(host, 'room:start', {})).ok === true);
  check('...the teams back on no points', before.some((n) => n > 0) && (await zeroed).teams.every((t) => t.score === 0),
    JSON.stringify(before));
  const again = await offer;
  check('...and the next game starts with the next team', lastRound(again.drawer)?.teamId === 'grape' && team(again.drawer) === 'grape',
    JSON.stringify(lastRound(again.drawer)));
  closeAll(socks);
}

/**
 * Teams on before anyone arrives: the host is dealt first, onto the team that
 * starts, and the rest in the order they come. Anyone on it may draw first.
 */
async function firstDrawer(check) {
  const firsts = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
    const socks = [await seat(null, `Host ${i + 1}`, 0)];
    const [host] = socks;
    await teamsOn(host);
    for (let n = 1; n < 8; n++) socks.push(await seat(host.code, `Guest ${i + 1}.${n}`, n));
    const offer = offerAmong(socks);
    const started = await emit(host, 'room:start', {});
    const o = await offer;
    closeAll(socks);
    return { started: started.ok, teamId: lastRound(o.drawer)?.teamId, host: o.drawer === host };
  }));
  check('8 rooms with Teams on before anyone came, 4 against 4: each starts with Mango', firsts.every((f) =>
    f.started && f.teamId === 'mango'), JSON.stringify(firsts));
  // The host draws first in a room 1 time in 4: in all 8, 1 time in 65,536.
  check("...and it isn't always the host who draws first", firsts.some((f) => !f.host), JSON.stringify(firsts.map((f) => f.host)));
}

/** Two rounds of 2 against 2: the teams keep alternating across the round boundary. */
async function twoRounds(check) {
  const socks = await room(['Gia', 'Hu', 'Ira', 'Jun']);
  const [host] = socks;
  await teamsOn(host);
  await setting(host, { rounds: 2, drawSeconds: 15, selectSeconds: 5 }, (p) => p.settings.rounds === 2 && p.settings.drawSeconds === 15);
  const team = (s) => teamOf(host, s.pid);
  let offer = offerAmong(socks);
  await emit(host, 'room:start', {});
  const turns = [];
  for (let t = 0; t < 8; t++) {
    const turn = await teamTurn(socks, await offer, team);
    turns.push(turn);
    if (t < 7) offer = offerAmong(socks);
  }
  check('the teams alternate, across the round boundary too', turns.map((t) => t.teamId).join() ===
    'mango,grape,mango,grape,mango,grape,mango,grape', turns.map((t) => t.teamId).join());
  check('...four turns a round', turns.map((t) => t.round).join() === '1,1,1,1,2,2,2,2');
  check('...everyone drawing once in each', [0, 4].every((i) => new Set(turns.slice(i, i + 4).map((t) => t.drawer.pid)).size === 4));
  closeAll(socks);
}

/** Three teams of two: one loses its guesser mid-turn, then its next turn is skipped. */
async function nobodyLeft(check) {
  const socks = await room(['Kai', 'Lia', 'Max', 'Noa', 'Oz', 'Pia']);
  const [host] = socks;
  await teamsOn(host);
  const st = await setting(host, { teamCount: 3 }, (p) => p.settings.teamCount === 3);
  check('a third team takes players from the bigger ones: 2, 2 and 2', hereOn(st.players, ['mango', 'grape', 'watermelon']).join() === '2,2,2');
  await setting(host, { rounds: 1, drawSeconds: 15, selectSeconds: 5 }, (p) => p.settings.rounds === 1 && p.settings.drawSeconds === 15);
  const team = (s) => teamOf(host, s.pid);
  const offer = offerAmong(socks);
  await emit(host, 'room:start', {});
  const o = await offer;
  const mate = socks.find((s) => s !== o.drawer && team(s) === 'mango');
  const watcher = socks.find((s) => team(s) === 'grape');
  const drawing = until(watcher, 'round:state', (p) => p.phase === 'drawing');
  await emit(o.drawer, 'word:choose', { wordId: o.choices[0].id });
  await drawing;
  const from = Date.now();
  const reveal = until(watcher, 'round:state', (p) => p.phase === 'reveal', 20_000);
  const said = until(watcher, 'chat:message', (m) => m.text.startsWith('Nobody on Team Mango is left to guess.'), 20_000);
  mate.disconnect();
  const rev = await reveal;
  const line = (await said).text;
  check("the drawing team's only guesser leaves: the turn ends after the grace, before time is up", Date.now() - from < 14_500,
    `${Date.now() - from} ms`);
  check('...saying so, with the word', line === `Nobody on Team Mango is left to guess. The word was “${rev.solution}”.`, line);
  check('...and nobody scores', watcher.teams.every((t) => t.score === 0) && watcher.players.every((p) => p.score === 0));

  const live = socks.filter((s) => s !== mate);
  for (const id of ['grape', 'watermelon']) {
    const turn = await teamTurn(live, await offerAmong(live), team);
    check(`then ${id === 'grape' ? 'Grape' : 'Watermelon'}, who get theirs`, turn.teamId === id, turn.teamId);
  }
  const skipped = maybe(watcher, 'chat:message', (m) => m.text === "Team Mango's turn is skipped: nobody there to guess", 10_000);
  const next = await offerAmong(live);
  check("Mango's turn again, with one player: skipped, and everyone told", Boolean(await skipped));
  check('...so Grape is up', lastRound(next.drawer)?.teamId === 'grape', JSON.stringify(lastRound(next.drawer)));
  closeAll(socks);
}

/** 2 against 2, and one team drops to one player: no game left. */
async function downToOne(check) {
  const socks = await room(['Qi', 'Ro', 'Sy', 'Ty']);
  const [host] = socks;
  await teamsOn(host);
  await setting(host, { rounds: 1, drawSeconds: 30, selectSeconds: 5 }, (p) => p.settings.drawSeconds === 30);
  const team = (s) => teamOf(host, s.pid);
  const offer = offerAmong(socks);
  await emit(host, 'room:start', {});
  const o = await offer;
  await emit(o.drawer, 'word:choose', { wordId: o.choices[0].id });
  const leaver = socks.find((s) => team(s) === 'grape' && s !== host);
  const stay = socks.find((s) => s !== leaver && s !== o.drawer);
  const summary = until(stay, 'game:summary', () => true, 20_000);
  const finished = until(stay, 'round:state', (p) => p.phase === 'finished', 20_000);
  const said = maybe(stay, 'chat:message', (m) => m.text === 'Not enough players left for two teams, so the game is over.', 20_000);
  leaver.disconnect();
  const s = await summary;
  await finished;
  check('a team down to one player: the game is over after the grace, and everyone is told', Boolean(await said));
  check('...an abandoned team game', s.abandoned === true && s.mode === 'teams' && s.teams.length === 2 && partitioned(s),
    JSON.stringify({ abandoned: s.abandoned, mode: s.mode, teams: s.teams }));
  closeAll(socks);
}

/** Arriving mid-game: a newcomer, a refresh and a rejoin by name, each told what their team may know. */
async function arrivals(check) {
  const socks = await room(['Uli', 'Val', 'Wim', 'Xan', 'Yas']);
  const [host] = socks;
  await teamsOn(host);
  await setting(host, { rounds: 1, drawSeconds: 60, selectSeconds: 5 }, (p) => p.settings.drawSeconds === 60);
  const team = (s) => teamOf(host, s.pid);
  const offer = offerAmong(socks);
  await emit(host, 'room:start', {});
  const o = await offer;
  const guest = socks.find((s) => s !== host);
  check('no changing teams once the game is on', (await emit(guest, 'team:join', { teamId: team(guest) === 'mango' ? 'grape' : 'mango' })).code === 'BAD_PHASE');
  check('...nor names', (await emit(host, 'team:rename', { teamId: 'mango', name: 'Late Mangoes' })).code === 'BAD_PHASE');
  check('...nor shuffling', (await emit(host, 'team:shuffle', {})).code === 'BAD_PHASE');
  check('...nor the number of teams', (await emit(host, 'room:settings', { teamCount: 3 })).code === 'BAD_PHASE');
  const assigned = until(o.drawer, 'word:assigned');
  const drawing = until(host, 'round:state', (p) => p.phase === 'drawing');
  await emit(o.drawer, 'word:choose', { wordId: o.choices[0].id });
  const word = (await assigned).text;
  await drawing;
  check('Mango draws, 3 against 2', team(o.drawer) === 'mango' && socks.filter((s) => team(s) === 'grape').length === 2);

  const nia = await connect();
  const niaState = until(nia, 'room:state');
  const niaWord = maybe(nia, 'word:assigned', () => true, 4000);
  const r = await emit(nia, 'room:join', { roomCode: host.code, name: 'Nia', avatar: 6 });
  const ns = await niaState;
  check('someone joining mid-game lands on the team with the fewest here', r.ok && ns.players.find((p) => p.id === ns.you.playerId)?.teamId === 'grape',
    JSON.stringify(ns.players.map((p) => [p.name, p.teamId])));
  check('...and, watching Mango draw, is told the word', (await niaWord)?.text === word);

  const [w, v] = socks.filter((s) => team(s) === 'grape');
  w.io.engine.close(); // a refresh: the connection just dies
  await sleep(200);
  const w2 = await connect();
  const w2Word = maybe(w2, 'word:assigned', () => true, 4000);
  check('a watcher refreshes', (await emit(w2, 'room:resume', { roomCode: host.code, token: w.token })).ok === true);
  check('...and is told the word again', (await w2Word)?.text === word);

  // Seen from the drawer, who stays: the host may be on Grape, and be one of these two.
  const vGone = until(o.drawer, 'room:players', (p) => !p.players.find((q) => q.id === v.pid)?.connected);
  v.io.engine.close();
  await vGone;
  const v2 = await connect();
  const v2State = until(v2, 'room:state');
  const v2Word = maybe(v2, 'word:assigned', () => true, 4000);
  const back = await emit(v2, 'room:join', { roomCode: host.code, name: v.name, avatar: 2 });
  const vs = await v2State;
  check('a watcher who lost their session rejoins by name, into their seat on their team', back.ok && vs.you.playerId === v.pid &&
    vs.players.find((p) => p.id === v.pid)?.teamId === 'grape');
  check('...and is told the word', (await v2Word)?.text === word);

  const m = socks.find((s) => s !== o.drawer && team(s) === 'mango');
  m.io.engine.close();
  await sleep(200);
  const m2 = await connect();
  const m2Word = maybe(m2, 'word:assigned', () => true, 1500);
  check('a guesser on the drawing team refreshes', (await emit(m2, 'room:resume', { roomCode: host.code, token: m.token })).ok === true);
  check('...and is not told the word', (await m2Word) === null);
  closeAll([...socks, nia, w2, v2, m2]);
}

/** A room of 30: full, dealt into 4 teams, and a turn played. */
async function thirty(check) {
  const socks = await room(Array.from({ length: 30 }, (_, i) => `Player ${i + 1}`));
  const [host] = socks;
  const extra = await connect();
  const full = await emit(extra, 'room:join', { roomCode: host.code, name: 'Player 31', avatar: 0 });
  extra.close();
  check('a room holds 30 by default: the 31st is turned away', full.code === 'ROOM_FULL', JSON.stringify(full));
  const st = await teamsOn(host);
  check('Teams on with 30: 4 teams, 8, 8, 7 and 7', st.settings.teamCount === 4 && hereOn(st.players, TEAM_IDS).join() === '8,8,7,7',
    hereOn(st.players, TEAM_IDS).join());
  check('...and one round, with 20 or more here', st.settings.rounds === 1);
  await setting(host, { drawSeconds: 15, selectSeconds: 5 }, (p) => p.settings.drawSeconds === 15);
  const team = (s) => teamOf(host, s.pid);
  const offer = offerAmong(socks);
  check('30 start a team game', (await emit(host, 'room:start', {})).ok === true);
  const o = await offer;
  const mates = socks.filter((s) => s !== o.drawer && team(s) === 'mango');
  const watchers = socks.filter((s) => team(s) !== 'mango');
  check('Mango is up', team(o.drawer) === 'mango' && mates.length === 7 && watchers.length === 22);
  const told = watchers.map((w) => maybe(w, 'word:assigned').then((p) => p?.text ?? null));
  const assigned = until(o.drawer, 'word:assigned');
  const drawing = until(mates[0], 'round:state', (p) => p.phase === 'drawing');
  await emit(o.drawer, 'word:choose', { wordId: o.choices[0].id });
  const word = (await assigned).text;
  await drawing;
  check('all 22 watching are told the word', (await Promise.all(told)).every((t) => t === word));
  const ended = until(host, 'chat:message', (m) => m.text === `Team Mango got it! The word was “${word}”.`, 10_000);
  mates[3].emit('chat:guess', { text: word });
  await ended;
  const points = host.teams.find((t) => t.id === 'mango')?.score ?? 0;
  check('a teammate gets it: Mango, the guesser and the drawer score the same', points > 0 &&
    scoreOf(host, mates[3].pid) === points && scoreOf(host, o.drawer.pid) === points &&
    host.teams.filter((t) => t.id !== 'mango').every((t) => t.score === 0));
  check('...nobody else on Mango having been told the word', mates.every((s) => !s.log.some((e) => e.ev === 'word:assigned')));
  closeAll(socks);
}

/* ---------------------------------------------- everyone for themselves */

async function classicDrawerRejoins(check) {
  const socks = await room(['Abe', 'Bix', 'Cleo']);
  const [host] = socks;
  check('a new room: everyone for themselves, up to 30, no teams', host.settings.mode === 'classic' &&
    host.settings.maxPlayers === 30 && host.teams.length === 0 && host.players.every((p) => p.teamId === null));
  await setting(host, { rounds: 1, drawSeconds: 60, selectSeconds: 5 }, (p) => p.settings.drawSeconds === 60);
  const offer = offerAmong(socks);
  await emit(host, 'room:start', {});
  const o = await offer;
  check('drawers may write their own word', o.allowCustom === true);
  check('...and no team is up', lastRound(o.drawer)?.teamId === null);
  const assigned = until(o.drawer, 'word:assigned');
  const g = socks.find((s) => s !== o.drawer);
  const drawing = until(g, 'round:state', (p) => p.phase === 'drawing');
  await emit(o.drawer, 'word:choose', { wordId: o.choices[0].id });
  const word = (await assigned).text;
  await drawing;
  const line = maybe(o.drawer, 'chat:message', (m) => m.channel === 'system' && m.text === `${g.name} liked the drawing`, 3000);
  g.emit('draw:react', { reaction: 'up' });
  check('in a room of 12 or fewer every vote still gets a line in the chat', Boolean(await line));

  const dropped = until(g, 'room:players', (p) => !p.players.find((q) => q.id === o.drawer.pid)?.connected);
  o.drawer.io.engine.close();
  await dropped;
  const back = await connect();
  const state = until(back, 'room:state');
  const again = maybe(back, 'word:assigned', () => true, 4000);
  const r = await emit(back, 'room:join', { roomCode: host.code, name: o.drawer.name, avatar: 0 });
  const st = await state;
  check('a drawer who lost their session rejoins by name, into their seat', r.ok && st.you.playerId === o.drawer.pid);
  check('...and is told the word again, to carry on drawing', (await again)?.text === word);
  closeAll([...socks, back]);
}

async function bigClassic(check) {
  const socks = await room(Array.from({ length: 13 }, (_, i) => `Guest ${i + 1}`));
  const [host] = socks;
  await setting(host, { rounds: 1, drawSeconds: 60, selectSeconds: 5 }, (p) => p.settings.drawSeconds === 60);
  const offer = offerAmong(socks);
  await emit(host, 'room:start', {});
  const o = await offer;
  const g = socks.find((s) => s !== o.drawer);
  const drawing = until(g, 'round:state', (p) => p.phase === 'drawing');
  await emit(o.drawer, 'word:choose', { wordId: o.choices[0].id });
  await drawing;
  const mark = o.drawer.log.length;
  const reacted = maybe(o.drawer, 'draw:reaction');
  g.emit('draw:react', { reaction: 'up' });
  check('with 13 here a vote is still counted', (await reacted)?.likes === 1);
  await sleep(500);
  check('...but gets no line in the chat', !since(o.drawer, mark, 'chat:message').some((m) => m.text.includes('liked the drawing')));
  closeAll(socks);
}

console.log(`\nTeam games and rooms of up to 30 — ${URL}\n`);

await pureParts(section('The pure parts')).catch((e) => sections[0].lines.push({ label: 'the pure parts run', ok: false, detail: e.stack }));
const runs = [
  ['In the lobby', lobby],
  ['Starting with a team short', shortTeam],
  ['A vote kick in a team game', voteKick],
  ['Teams on before anyone arrives', earlyTeams],
  ['Team names that only look alike', lookAlikes],
  ['Who draws first', firstDrawer],
  ['A game of 3 against 2', threeAgainstTwo],
  ['Two rounds of 2 against 2', twoRounds],
  ['Three teams, one left with nobody to guess', nobodyLeft],
  ['A team down to one player', downToOne],
  ['Arriving mid-game', arrivals],
  ['A room of 30', thirty],
  ['Everyone for themselves', classicDrawerRejoins],
  ['Everyone for themselves, 13 of them', bigClassic],
];
await Promise.all(runs.map(async ([title, run]) => {
  const check = section(title);
  try {
    await run(check);
  } catch (e) {
    check('ran to the end', false, e.stack ?? String(e));
  }
}));

let pass = 0;
const failures = [];
for (const { title, lines } of sections) {
  console.log(title);
  for (const l of lines) {
    if (l.ok) { pass++; console.log(`  ✓ ${l.label}`); }
    else { failures.push(l.label); console.log(`  ✗ ${l.label} ${l.detail}`); }
  }
}
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('failed:', failures.join('; ')); process.exit(1); }
process.exit(0);
