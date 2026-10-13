/**
 * SHARED CONTRACT — SOURCE OF TRUTH.
 *
 * This file is vendored into the frontend repo by `scripts/sync-contract.mjs`
 * there. Do not edit the copy in the FE repo; edit this file and re-sync.
 * FE CI fails if its vendored copy has drifted from this one.
 *
 * Keep this file dependency-free so both repos can consume it as-is.
 */

export const CONTRACT_VERSION = 4;

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
}

export interface Point {
  x: number;
  y: number;
}

export interface Stroke {
  id: string;
  drawerId: string;
  tool: Tool;
  color: string;
  size: number;
  points: Point[];
}

export interface RoomSettings {
  rounds: number;
  drawSeconds: number;
  selectSeconds: number;
  maxPlayers: number;
  allowCustomWords: boolean;
}

export const DEFAULT_SETTINGS: RoomSettings = {
  rounds: 3,
  drawSeconds: 80,
  selectSeconds: 15,
  maxPlayers: 12,
  allowCustomWords: true,
};

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
}

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
  'room:create': (
    p: { name: string; avatar: number },
    ack: (r: Result<{ roomCode: string; token: string }>) => void,
  ) => void;

  'room:join': (
    p: { roomCode: string; name: string; avatar: number },
    ack: (r: Result<{ token: string }>) => void,
  ) => void;

  'room:resume': (
    p: { roomCode: string; token: string },
    ack: (r: Result<{ playerId: string }>) => void,
  ) => void;

  'room:settings': (p: Partial<RoomSettings>, ack: Ack) => void;
  'room:start': (p: Record<string, never>, ack: Ack) => void;

  /** Pick one of the three offered words. */
  'word:choose': (p: { wordId: number }, ack: Ack) => void;
  /** Requirement 1: drawer writes their own instead. */
  'word:custom': (p: { text: string }, ack: Ack) => void;

  'draw:stroke': (p: { stroke: Stroke }) => void;
  'draw:undo': (p: Record<string, never>) => void;
  'draw:clear': (p: Record<string, never>) => void;

  'chat:guess': (p: { text: string }) => void;
  'word:report': (p: { reason: string }, ack: Ack) => void;
}

/* ----------------------------------------------- server -> client events */

export interface ServerToClientEvents {
  'room:state': (p: {
    roomCode: string;
    players: Player[];
    settings: RoomSettings;
    round: RoundState;
    you: { playerId: string };
  }) => void;

  'room:players': (p: { players: Player[] }) => void;
  'round:state': (p: RoundState) => void;
  'round:tick': (p: { secondsLeft: number }) => void;
  'round:hint': (p: { maskedWord: string }) => void;

  /** Drawer only. */
  'word:options': (p: { choices: WordChoice[]; allowCustom: boolean }) => void;
  /** Drawer only — the solution they must draw. */
  'word:assigned': (p: { text: string }) => void;

  'draw:stroke': (p: { stroke: Stroke }) => void;
  'draw:undo': (p: { strokeId: string }) => void;
  'draw:clear': (p: Record<string, never>) => void;
  /** Full replay for late joiners / reconnects. */
  'draw:sync': (p: { strokes: Stroke[] }) => void;

  'chat:message': (p: ChatMessage) => void;
  /** Private to one guesser — near-miss feedback. */
  'chat:close': (p: { text: string }) => void;

  'game:scores': (p: { players: Player[]; final: boolean }) => void;
  'error:toast': (p: { code: ErrorCode; message: string }) => void;
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

/** Structural mask: word count and lengths are given away for free. */
export function maskWord(word: string, revealed: Set<number> = new Set()): string {
  return [...word]
    .map((ch, i) => (ch === ' ' ? '  ' : revealed.has(i) ? ch : '_'))
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
