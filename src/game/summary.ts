import { nanoid } from 'nanoid';
import {
  BEST_DRAWING_MAX_POINTS,
  type Award,
  type AwardId,
  type GameMode,
  type GameSummary,
  type Stroke,
  type SummaryPlayer,
  type TeamResult,
} from '../contract/index.js';
import type { PlayerRecord, Room, Tally } from './types.js';

/**
 * The end-of-game summary: who did what, the fun awards and the drawing of the
 * game. The numbers are booked into the room's tally while the game runs,
 * because by the end a seat may have been kicked and every turn's round state
 * has been overwritten. The summary itself is built once, when the game ends,
 * and kept so it can be re-sent as it was.
 */

/** Awards go round the table: nobody collects more than this many. */
const MAX_AWARDS_EACH = 2;

/**
 * Drawings kept in the running for drawing of the game, each by a different
 * drawer, so one kick takes out at most one of them. Each is a finished
 * canvas, kept by reference: this also caps how many canvases a room holds on
 * to, and saves in a snapshot.
 */
const BEST_CANDIDATES = 3;

/**
 * More fills than this and a canvas never becomes the drawing of the game.
 * Every client in the room replays that drawing at full size the moment the
 * results open, and each fill reads and writes the whole bitmap: a canvas
 * flooded with them would freeze every tab, and again on each refresh. An
 * honest colourful picture needs a few dozen at most.
 */
const MAX_BEST_FILLS = 48;

/** Clients key the results' one-off effects (sounds, personal records) on it. */
export const newGameId = (): string => nanoid(12);

/** Forgets the last game's highlights, and gives the next game its own id. */
export function resetSummary(room: Room): void {
  room.gameId = newGameId();
  room.tally = new Map();
  room.bestTurns = [];
  room.summary = null;
}

/**
 * A player's line in the tally, created the first time they need one and
 * refreshed on every visit: the summary needs their name and score even if
 * their seat is gone by the end.
 */
export function tallyOf(room: Room, player: PlayerRecord): Tally {
  const known = room.tally.get(player.id);
  if (known) {
    known.name = player.name;
    known.avatar = player.avatar;
    known.score = player.score;
    known.teamId = player.teamId;
    return known;
  }
  const t: Tally = {
    name: player.name,
    avatar: player.avatar,
    score: player.score,
    guessed: 0,
    firstGuesses: 0,
    fastestMs: null,
    drew: 0,
    solvedByOthers: 0,
    likes: 0,
    teamId: player.teamId,
  };
  room.tally.set(player.id, t);
  return t;
}

/** A right guess. `place` 0 is the first to get it this turn. */
export function recordGuess(room: Room, guesser: PlayerRecord, place: number, elapsedMs: number): void {
  const t = tallyOf(room, guesser);
  t.guessed++;
  if (place === 0) t.firstGuesses++;
  const ms = Math.max(0, elapsedMs);
  t.fastestMs = t.fastestMs === null ? ms : Math.min(t.fastestMs, ms);
}

/** Something that shows on the canvas: an eraser on its own draws nothing. */
const leavesMark = (s: Stroke): boolean => s.tool !== 'eraser' && s.points.length > 0;

/**
 * Books the turn being drawn to its drawer, and keeps its canvas when it is
 * among the best drawings so far. Call it before the round state moves on: the
 * guesses and the votes are only there. A turn that ended while the drawer was
 * still choosing drew nothing, and counts for nothing.
 */
export function recordTurn(room: Room): void {
  const { active, round } = room;
  if (!active || !round.drawerId) return;
  const seat = room.players.get(round.drawerId);
  const solvers = round.guessedPlayerIds.length;
  const t = seat ? tallyOf(room, seat) : room.tally.get(round.drawerId);
  if (t) {
    t.drew++;
    t.solvedByOthers += solvers;
    t.likes += round.likes;
  }

  // Drawings by anyone kicked since will never be shown: they make way.
  room.bestTurns = room.bestTurns.filter((c) => room.players.has(c.drawing.drawerId));
  // A drawer whose seat went mid-turn was kicked, quite likely over this very
  // drawing: it must not become the picture everyone shares.
  if (!seat || !room.strokes.some(leavesMark)) return;
  if (room.strokes.filter((s) => s.tool === 'fill').length > MAX_BEST_FILLS) return;
  // Who could have guessed: the players here now, as `award` counts them,
  // plus anyone who got it and has left since. Never fewer than the solvers.
  // In a team game only the drawing team guesses; the others know the word.
  const guessers = new Set(round.guessedPlayerIds);
  for (const p of room.players.values()) {
    if (p.connected && p.id !== seat.id && (!round.teamId || p.teamId === round.teamId)) guessers.add(p.id);
  }
  const score =
    round.likes * 3 - round.dislikes + (guessers.size ? (solvers / guessers.size) * 2 : 0);
  // One each: a drawer's later drawing takes their place only by beating it.
  const theirs = room.bestTurns.find((c) => c.drawing.drawerId === seat.id);
  if (theirs && score <= theirs.score) return;
  const kept = room.bestTurns.filter((c) => c !== theirs);
  // Behind any equal score, so the first of equals stays ahead.
  const at = kept.findIndex((c) => c.score < score);
  kept.splice(at === -1 ? kept.length : at, 0, {
    score,
    drawing: {
      drawerId: seat.id,
      drawerName: seat.name,
      drawerAvatar: seat.avatar,
      word: active.text,
      likes: round.likes,
      dislikes: round.dislikes,
      solvers,
      guessers: guessers.size,
      // A reference, not a copy: clearing the canvas swaps in a new array, and
      // nobody can draw into this one once the turn is over.
      strokes: room.strokes,
    },
  });
  room.bestTurns = kept.slice(0, BEST_CANDIDATES);
}

/* ------------------------------------------------------- building it */

/**
 * The summary of the game that just ended, from the tally and the seats as
 * they stand. Only reads the room. `rounds` is how far the game got.
 */
export function buildSummary(room: Room, rounds: number, abandoned: boolean): GameSummary {
  // Join order: the seats, then anyone kicked mid-game (seat gone, line kept).
  const ids = [...new Set([...room.order, ...room.tally.keys()])];
  const entries = ids.flatMap((id, joined) => {
    const seat = room.players.get(id);
    const t = room.tally.get(id);
    const who = seat ?? t;
    if (!who) return [];
    const score = seat?.score ?? t?.score ?? 0;
    const drew = t?.drew ?? 0;
    const left = !seat?.connected;
    // Whoever is here at the end, and anyone gone who played a part.
    if (left && score <= 0 && drew === 0) return [];
    const player: SummaryPlayer = {
      id,
      name: who.name,
      avatar: who.avatar,
      score,
      rank: 0, // set below, once everyone is listed
      guessed: t?.guessed ?? 0,
      firstGuesses: t?.firstGuesses ?? 0,
      fastestMs: t?.fastestMs ?? null,
      drew,
      solvedByOthers: t?.solvedByOthers ?? 0,
      likes: t?.likes ?? 0,
      left,
    };
    return [{ joined, player }];
  });
  entries.sort(
    (a, b) =>
      b.player.score - a.player.score ||
      Number(a.player.left) - Number(b.player.left) ||
      a.joined - b.joined,
  );
  const players = entries.map((e) => e.player);
  // Competition ranking: equal scores share a place, and the next is skipped.
  for (const p of players) p.rank = 1 + players.filter((q) => q.score > p.score).length;

  let turns = 0;
  for (const t of room.tally.values()) turns += t.drew;

  // Nor a drawing by anyone kicked later on: the picture would carry their
  // name. The next best, by someone still here, takes its place.
  const pick = room.bestTurns.find((c) => room.players.has(c.drawing.drawerId));
  const drawer = pick ? room.players.get(pick.drawing.drawerId) : undefined;
  const best =
    pick && drawer
      ? {
          ...pick.drawing,
          drawerName: drawer.name,
          drawerAvatar: drawer.avatar,
          strokes: thinStrokes(pick.drawing.strokes),
        }
      : null;

  // Read with care: smoke-summary's unit checks build bare rooms, without settings.
  const mode: GameMode = room.settings?.mode ?? 'classic';
  return {
    id: room.gameId,
    players,
    awards: pickAwards(players, mode),
    best,
    rounds,
    turns,
    abandoned,
    mode,
    teams: mode === 'teams' ? teamResults(room, players) : null,
  };
}

/**
 * A team game's teams, best first (equals in TEAMS order, sharing a rank),
 * each listing everyone in `players` who played for it: by their seat's team,
 * or for anyone whose seat has gone, the team the tally last saw them on.
 */
function teamResults(room: Room, players: SummaryPlayer[]): TeamResult[] {
  const teams: TeamResult[] = room.teams
    .slice(0, room.settings.teamCount)
    .map(({ id, name, score }) => ({ id, name, score, rank: 0, memberIds: [] }));
  for (const p of players) {
    const teamId = room.players.get(p.id)?.teamId ?? room.tally.get(p.id)?.teamId;
    // Everyone has a team in a team game. Were a line ever without one, it
    // still belongs somewhere: the results must not lose a player.
    (teams.find((t) => t.id === teamId) ?? teams[0])?.memberIds.push(p.id);
  }
  teams.sort((a, b) => b.score - a.score);
  for (const t of teams) t.rank = 1 + teams.filter((q) => q.score > t.score).length;
  return teams;
}

interface AwardRule {
  id: AwardId;
  /** What the player has towards it; null when they have not earned it at all. */
  value: (p: SummaryPlayer) => number | null;
  /** The lowest value wins (a time) rather than the highest. */
  lowest?: true;
  minPlayers?: number;
  /** Means nothing in a team game. */
  classicOnly?: true;
}

/** At least one: an award for nothing is no award. */
const counted = (n: number): number | null => (n >= 1 ? n : null);

/** Handed out in this order, which matters once players reach the cap. */
const AWARD_RULES: AwardRule[] = [
  { id: 'artist', value: (p) => counted(p.likes) },
  { id: 'speedster', value: (p) => p.fastestMs, lowest: true },
  { id: 'sharpshooter', value: (p) => counted(p.guessed) },
  { id: 'storyteller', value: (p) => counted(p.solvedByOthers) },
  // With two players the only guesser is always the first to get it; in a
  // team game every right answer is the first, as it ends the turn.
  { id: 'trailblazer', value: (p) => counted(p.firstGuesses), minPlayers: 3, classicOnly: true },
];

/**
 * Each award goes to a player with the best value for it. Ties go to whoever
 * has fewer awards so far, then the better rank, then the order `players` is
 * in. Someone who already has two is passed over, and when that leaves nobody
 * with the best value the award is dropped rather than handed to a runner-up.
 */
export function pickAwards(players: SummaryPlayer[], mode: GameMode = 'classic'): Award[] {
  const held = new Map<string, number>();
  const count = (p: SummaryPlayer) => held.get(p.id) ?? 0;
  const awards: Award[] = [];
  for (const rule of AWARD_RULES) {
    if (players.length < (rule.minPlayers ?? 0)) continue;
    if (rule.classicOnly && mode !== 'classic') continue;
    let best: number | null = null;
    for (const p of players) {
      const v = rule.value(p);
      if (v !== null && (best === null || (rule.lowest ? v < best : v > best))) best = v;
    }
    if (best === null) continue;
    // A stable sort: players level on both keep their order.
    const [winner] = players
      .filter((p) => rule.value(p) === best && count(p) < MAX_AWARDS_EACH)
      .sort((a, b) => count(a) - count(b) || a.rank - b.rank);
    if (!winner) continue;
    awards.push({ id: rule.id, playerId: winner.id, value: best });
    held.set(winner.id, count(winner) + 1);
  }
  return awards;
}

/**
 * Strokes this short stay whole when a drawing is thinned. Shapes are short
 * strokes whose every point matters (a rectangle hangs each corner on one
 * point, a circle closes on its last); freehand is dense enough to lose some.
 */
const WHOLE_PAIRS = 80;

/**
 * A copy of `strokes` with at most `maxPairs` point pairs in all, for a payload
 * every client can take. Brush and eraser strokes longer than WHOLE_PAIRS keep
 * every k-th pair plus their first and last, with the smallest k that fits;
 * fills (a single pair) and short strokes stay as they are. The originals are
 * never touched.
 */
export function thinStrokes(strokes: readonly Stroke[], maxPairs = BEST_DRAWING_MAX_POINTS): Stroke[] {
  const pairs = (s: Stroke) => Math.floor(s.points.length / 2);
  const whole = (s: Stroke) => s.tool === 'fill' || pairs(s) <= WHOLE_PAIRS;
  // Pairs 0, k, 2k... plus the last one when the step does not land on it.
  const kept = (n: number, k: number) =>
    n === 0 ? 0 : Math.ceil(n / k) + ((n - 1) % k === 0 ? 0 : 1);
  const total = (k: number) =>
    strokes.reduce((sum, s) => sum + (whole(s) ? pairs(s) : kept(pairs(s), k)), 0);

  // Past the longest stroke every stroke is down to its first and last pair.
  const longest = strokes.reduce((n, s) => (whole(s) ? n : Math.max(n, pairs(s))), 1);
  let k = 1;
  while (k < longest && total(k) > maxPairs) k++;

  const out = strokes.map((s): Stroke => {
    if (whole(s) || k === 1) return { ...s, points: s.points.slice() };
    const n = pairs(s);
    const points: number[] = [];
    for (let i = 0; i < n; i++) {
      if (i % k === 0 || i === n - 1) points.push(s.points[2 * i]!, s.points[2 * i + 1]!);
    }
    return { ...s, points };
  });
  // Still too many only with far more strokes than a room may hold
  // (MAX_STROKES_PER_ROOM): then keep the strokes drawn first, as many as fit.
  let budget = maxPairs;
  return out.filter((s) => {
    budget -= pairs(s);
    return budget >= 0;
  });
}
