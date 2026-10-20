/**
 * SHARED CONTRACT — SOURCE OF TRUTH.
 *
 * This file is vendored into the frontend repo by `scripts/sync-contract.mjs`
 * there. Do not edit the copy in the FE repo; edit this file and re-sync.
 * FE CI fails if its vendored copy has drifted from this one.
 *
 * Keep this file dependency-free so both repos can consume it as-is.
 */

export const CONTRACT_VERSION = 14;

/* ---------------------------------------------------------------- domain */

export type Drawability = 1 | 2 | 3;
export type WordSource = 'seed' | 'owner' | 'player';
export type Tool = 'brush' | 'eraser' | 'fill';

export type RoundPhase =
  | 'lobby'
  | 'selecting'
  | 'drawing'
  | 'reveal'
  | 'scoreboard'
  | 'finished';

export interface Player {
  id: string;
  name: string;
  avatar: number;
  score: number;
  connected: boolean;
  isHost: boolean;
  /** Ids of the present players voting to kick this one. */
  kickVotes: string[];
}

/**
 * Votes needed to kick a player: a majority of everyone else present. A vote
 * needs at least 3 players in the room, or one person could throw out the
 * other; the host can kick outright in any room. The host cannot be kicked.
 */
export const MIN_PLAYERS_FOR_KICK_VOTE = 3;
export function kickVotesNeeded(presentPlayers: number): number {
  const others = presentPlayers - 1;
  return Math.floor(others / 2) + 1;
}

/**
 * Coordinates are quantized to integers on a 0..COORD_SCALE grid and packed
 * flat: `[x0, y0, x1, y1, ...]`. Integers serialize to 1-5 characters instead
 * of a 17-digit double, and a flat array of small ints is a packed SMI array in
 * V8 rather than one heap object per point — roughly 4x smaller on the wire and
 * far smaller in memory. 10000 steps is finer than any canvas renders.
 */
export const COORD_SCALE = 10_000;
/** A drag longer than this is split by the client into consecutive strokes. */
export const MAX_POINTS_PER_STROKE = 600;
/** Total budget per room, across all strokes: the real memory guard. */
export const MAX_POINTS_PER_ROOM = 60_000;

export interface Stroke {
  id: string;
  drawerId: string;
  tool: Tool;
  color: string;
  size: number;
  /** Flat quantized pairs: [x0, y0, x1, y1, ...], each 0..COORD_SCALE. */
  points: number[];
}

/* ------------------------------------------------------------ word packs */

export type WordPackId =
  | 'everyday' | 'animals' | 'food' | 'office' | 'actions' | 'places'
  | 'nature' | 'sports' | 'tech' | 'jobs' | 'fantasy' | 'desi' | 'slang';

/** What a host can pick from, in display order. */
export const WORD_PACKS: { id: WordPackId; label: string; emoji: string }[] = [
  { id: 'everyday', label: 'Everyday things', emoji: '🧦' },
  { id: 'animals', label: 'Animals', emoji: '🐼' },
  { id: 'food', label: 'Food & drink', emoji: '🍕' },
  { id: 'desi', label: 'Desi', emoji: '🪔' },
  { id: 'office', label: 'Office stuff', emoji: '📎' },
  { id: 'actions', label: 'Actions', emoji: '🤸' },
  { id: 'places', label: 'Places', emoji: '🏰' },
  { id: 'nature', label: 'Nature & weather', emoji: '🌋' },
  { id: 'sports', label: 'Sports & games', emoji: '⚽' },
  { id: 'tech', label: 'Tech & gadgets', emoji: '💻' },
  { id: 'jobs', label: 'Jobs & people', emoji: '👩‍🚒' },
  { id: 'fantasy', label: 'Fantasy & fun', emoji: '🦄' },
  { id: 'slang', label: 'Corporate slang', emoji: '💼' },
];

/**
 * Easy: words that draw themselves (cat, pizza). Mixed: mostly easy, some
 * medium. Hard: anything goes, including the abstract (synergy).
 */
export type WordDifficulty = 'easy' | 'mixed' | 'hard';

export interface RoomSettings {
  rounds: number;
  drawSeconds: number;
  selectSeconds: number;
  maxPlayers: number;
  /** The drawer may write their own word instead of picking one. */
  allowCustomWords: boolean;
  wordPacks: WordPackId[];
  difficulty: WordDifficulty;
  /** How many words the drawer chooses between. */
  wordChoices: number;
  /** Most letters revealed as hints during a turn (0 = no hints). */
  hints: number;
  /** Draw only from the host's custom word list. */
  customWordsOnly: boolean;
  /** How many custom words the host has added. The words stay with the host. */
  customWordCount: number;
}

export const DEFAULT_SETTINGS: RoomSettings = {
  rounds: 3,
  drawSeconds: 25,
  selectSeconds: 15,
  maxPlayers: 12,
  allowCustomWords: true,
  wordPacks: ['everyday', 'animals', 'food', 'office', 'slang'],
  difficulty: 'mixed',
  wordChoices: 3,
  hints: 3,
  customWordsOnly: false,
  customWordCount: 0,
};

/** Selectable draw times, in seconds. */
export const DRAW_TIMES = [15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 120, 150, 180, 210, 240];
/** Custom-words-only needs at least this many, or games run dry fast. */
export const MIN_CUSTOM_WORDS = 10;
export const MAX_CUSTOM_WORDS = 500;

/** Public round state. Never contains the solution while drawing is live. */
export interface RoundState {
  phase: RoundPhase;
  round: number;
  totalRounds: number;
  drawerId: string | null;
  /** Masked form, e.g. "_ _ _ _ _ _   _ _ _ _" — structure is not a spoiler. */
  maskedWord: string | null;
  /** Revealed only at `reveal`/`scoreboard`. */
  solution: string | null;
  endsAt: number | null;
  guessedPlayerIds: string[];
  /** Guessers' 👍 / 👎 on the current drawing; reset every turn. */
  likes: number;
  dislikes: number;
}

export type Reaction = 'up' | 'down';

export type ChatChannel = 'guess' | 'post-guess' | 'system';

/**
 * How the client should colour a message. The server knows whether a guess was
 * wrong; the client would otherwise have to infer it by matching the text of
 * system messages, which breaks the moment the wording changes.
 */
export type ChatTone = 'correct' | 'wrong' | 'neutral';

export interface ChatMessage {
  id: string;
  channel: ChatChannel;
  tone?: ChatTone;
  playerId: string | null;
  playerName: string | null;
  text: string;
  at: number;
}

export interface RoomPreview {
  roomCode: string;
  hostName: string | null;
  /** Players currently connected. */
  players: number;
  maxPlayers: number;
  phase: RoundPhase;
}

/**
 * Which game-server process owns a room. With one process per CPU core, each
 * owns the rooms whose code hashes to it, so the browser can connect straight
 * to the right one from the code alone. FNV-1a: tiny, and the same in both
 * repos. The server stays the authority (WRONG_SHARD if asked about a room it
 * does not own, e.g. after the process count changed).
 */
export function shardOf(roomCode: string, shards: number): number {
  if (shards <= 1) return 0;
  let h = 0x811c9dc5;
  for (const ch of roomCode.toUpperCase()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % shards;
}

/** Canonical invite link for a room: `<origin>/?room=CODE`. */
export function inviteUrl(origin: string, roomCode: string): string {
  return `${origin}/?room=${encodeURIComponent(roomCode.toUpperCase())}`;
}

export interface WordChoice {
  id: number;
  text: string;
  drawability: Drawability;
}

/* ----------------------------------------------- client -> server events */

export interface ClientToServerEvents {
  /**
   * Something broke in the browser. The server cannot see a client-side failure
   * otherwise, which is how a total connection outage once looked like a
   * perfectly healthy log.
   */
  'client:error': (p: {
    source: 'render' | 'window' | 'promise' | 'socket';
    message: string;
    detail?: string;
    url?: string;
  }) => void;
  /**
   * What an invite link points at, before joining: lets the invite page say
   * "Join Ann's room (3 players)" — or "this link has expired" — up front.
   */
  'room:peek': (
    p: { roomCode: string },
    ack: (r: Result<RoomPreview>) => void,
  ) => void;

  /**
   * `deviceId` is a random id the browser keeps forever. It lets a returning
   * player reclaim their seat even after their session token is gone.
   */
  'room:create': (
    p: { name: string; avatar: number; deviceId?: string },
    ack: (r: Result<{ roomCode: string; token: string }>) => void,
  ) => void;

  'room:join': (
    p: { roomCode: string; name: string; avatar: number; deviceId?: string },
    ack: (r: Result<{ token: string }>) => void,
  ) => void;

  /**
   * `takeover: false` — this tab found the token in shared storage, not its
   * own: if the seat is in use by another tab, leave it there (SEAT_IN_USE)
   * rather than stealing it. A tab resuming its own seat (a refresh) takes it.
   */
  'room:resume': (
    p: { roomCode: string; token: string; takeover?: boolean },
    ack: (r: Result<{ playerId: string }>) => void,
  ) => void;

  'room:settings': (
    p: Partial<Omit<RoomSettings, 'customWordCount'>>,
    ack: Ack,
  ) => void;
  /**
   * Host only: replace the room's custom word list (comma or newline
   * separated). Invalid entries come back in `rejected`.
   */
  'room:customWords': (
    p: { text: string },
    ack: (r: Result<{ accepted: number; rejected: string[] }>) => void,
  ) => void;
  /**
   * Kick a player. The host's request removes them at once; anyone else's is
   * a vote (sending it again withdraws it), and a majority removes them. A
   * kicked player cannot rejoin the room from the same browser. The host
   * cannot be kicked.
   */
  'player:kick': (
    p: { playerId: string },
    ack: (r: Result<{ kicked: boolean; votes: number; needed: number }>) => void,
  ) => void;
  /** Change your own name/avatar. Only before a game starts (lobby/finished). */
  'player:update': (p: { name?: string; avatar?: number }, ack: Ack) => void;
  'room:start': (p: Record<string, never>, ack: Ack) => void;
  /**
   * Host only: stop the game (or leave the final podium) and return everyone
   * to the lobby, where settings and words can be changed again.
   */
  'room:restart': (p: Record<string, never>, ack: Ack) => void;

  /** Pick one of the three offered words. */
  'word:choose': (p: { wordId: number }, ack: Ack) => void;
  /** Requirement 1: drawer writes their own instead. */
  'word:custom': (p: { text: string }, ack: Ack) => void;

  /** Starts a stroke (or replaces one of your own by id). */
  'draw:stroke': (p: { stroke: Stroke }) => void;
  /**
   * Appends points to one of your own strokes. Only the new points travel —
   * resending the whole stroke made a drag's upload grow quadratically.
   */
  'draw:points': (p: { id: string; points: number[] }) => void;
  'draw:undo': (p: Record<string, never>) => void;
  'draw:clear': (p: Record<string, never>) => void;

  'chat:guess': (p: { text: string }) => void;
  /** A guesser rates the drawing in progress. One vote per turn; may switch. */
  'draw:react': (p: { reaction: Reaction }) => void;
  'word:report': (p: { reason: string }, ack: Ack) => void;

  /** Round-trip probe: the server acks at once; the client times it. */
  'net:ping': (p: Record<string, never>, ack: () => void) => void;
  /**
   * What this browser's connection has been like over the last minute, so the
   * server can tell whether real players see lag (it cannot measure their side).
   */
  'net:report': (p: NetReport) => void;
}

export interface NetReport {
  /** Round trips measured this period, in ms, summarized. */
  rttP50: number;
  rttP95: number;
  rttMax: number;
  samples: number;
  /** Pings that got no answer within 5 s. */
  lost: number;
  /** Times the connection dropped and came back this period. */
  reconnects: number;
  /** Connected straight to the game server rather than through the proxy. */
  direct: boolean;
}

/* ----------------------------------------------- server -> client events */

export interface ServerToClientEvents {
  'room:state': (p: {
    roomCode: string;
    players: Player[];
    settings: RoomSettings;
    round: RoundState;
    you: { playerId: string };
    /** The custom word list — sent to the host only, never to guessers. */
    hostWords?: string[];
  }) => void;

  'room:players': (p: { players: Player[] }) => void;
  'round:state': (p: RoundState) => void;
  'round:tick': (p: { secondsLeft: number }) => void;
  'round:hint': (p: { maskedWord: string }) => void;

  /** Drawer only. */
  'word:options': (p: { choices: WordChoice[]; allowCustom: boolean }) => void;
  /**
   * The solution, privately: to the drawer when the turn starts, and to each
   * guesser the moment they get it (and again on reconnect), so solvers see
   * the word instead of the blanks for the rest of the turn.
   */
  'word:assigned': (p: { text: string }) => void;

  /**
   * Sent to the whole room, the drawer included, so the server can broadcast
   * each one with a single publish. The drawer has already drawn its own
   * stroke locally and must ignore the echo of it.
   */
  'draw:stroke': (p: { stroke: Stroke }) => void;
  /** As draw:stroke: the drawer receives, and ignores, its own points. */
  'draw:points': (p: { strokeId: string; points: number[] }) => void;
  'draw:undo': (p: { strokeId: string }) => void;
  'draw:clear': (p: Record<string, never>) => void;
  /** Full replay for late joiners / reconnects. */
  'draw:sync': (p: { strokes: Stroke[] }) => void;

  'chat:message': (p: ChatMessage) => void;
  /** Someone rated the drawing; carries the new totals. */
  'draw:reaction': (p: {
    playerId: string;
    playerName: string;
    reaction: Reaction;
    likes: number;
    dislikes: number;
  }) => void;
  /** Private to one guesser — near-miss feedback. */
  'chat:close': (p: { text: string }) => void;

  'game:scores': (p: { players: Player[]; final: boolean }) => void;
  'error:toast': (p: { code: ErrorCode; message: string }) => void;
  /** You were removed from the room; your seat is gone. */
  'room:kicked': (p: { roomCode: string; by: 'host' | 'vote' }) => void;
}

/* --------------------------------------------------------------- results */

export type ErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'NAME_TAKEN'
  | 'NOT_HOST'
  | 'NOT_DRAWER'
  | 'BAD_PHASE'
  | 'WORD_TOO_SHORT'
  | 'WORD_TOO_LONG'
  | 'WORD_NO_LETTERS'
  | 'WORD_BLOCKED'
  | 'WORD_RETIRED'
  | 'RATE_LIMITED'
  | 'SEAT_IN_USE'
  | 'KICKED'
  | 'WRONG_SHARD'
  | 'INVALID'
  | 'INTERNAL';

export interface Failure {
  ok: false;
  code: ErrorCode;
  message: string;
}

/**
 * Defaults to `{}` rather than `Record<string, never>`: intersecting
 * `{ ok: true }` with `Record<string, never>` collapses `ok` to `never`, making
 * a success ack impossible to construct.
 */
export type Result<T extends object = {}> = ({ ok: true } & T) | Failure;

export type Ack = (r: Result) => void;

/* --------------------------------------------- word rules (both sides) */

export const WORD_MIN = 3;
export const WORD_MAX = 40;

/**
 * Normalization used for guess matching AND duplicate detection.
 * Lives here so the client can preview a guess with exactly the server's
 * logic — the server stays authoritative regardless.
 *
 * Articles are deliberately NOT stripped: it would collapse "the ask" into
 * "ask", which are different pieces of slang.
 */
export function normalizeWord(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A character a hint can reveal, and a guesser has to type. */
export const isHintable = (ch: string): boolean => /[\p{L}\p{N}]/u.test(ch);

/**
 * Structural mask: word count and lengths are given away for free, and so is
 * punctuation — "follow-up" shows its hyphen rather than reading as one
 * nine-letter word.
 */
export function maskWord(word: string, revealed: Set<number> = new Set()): string {
  return [...word]
    .map((ch, i) => (ch === ' ' ? '  ' : revealed.has(i) || !isHintable(ch) ? ch : '_'))
    .join(' ')
    .replace(/\s{4,}/g, '   ');
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length]!;
}

/** Phrases get a looser threshold; short words must be near-exact. */
export function isCloseGuess(guess: string, solution: string): boolean {
  const g = normalizeWord(guess);
  const s = normalizeWord(solution);
  if (g === s) return false;
  const threshold = s.length > 15 ? 2 : 1;
  return levenshtein(g, s) <= threshold;
}
