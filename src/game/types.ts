import type {
  Player,
  RoomSettings,
  RoundState,
  Stroke,
} from '../contract/index.js';

export interface PlayerRecord extends Player {
  /** Reconnect secret. Never leaves the server except to its own owner. */
  token: string;
  socketId: string | null;
  lastSeen: number;
}

export interface ActiveWord {
  /** null for a drawer-supplied custom word — it has no dictionary row yet. */
  wordId: number | null;
  text: string;
  normalized: string;
  custom: boolean;
}

export interface Room {
  code: string;
  hostId: string;
  players: Map<string, PlayerRecord>;
  /** Join order — drives drawer rotation in M4. */
  order: string[];
  settings: RoomSettings;
  round: RoundState;
  strokes: Stroke[];
  createdAt: number;
  lastActivity: number;

  /* --- round machine (M4) --- */
  /** Bumped on every phase change; stale timers compare against it and bail. */
  seq: number;
  /** Whose turn it is within the current round. */
  turnIndex: number;
  /** Snapshot of player order taken at game start, so mid-game joins don't shuffle turns. */
  drawOrder: string[];
  usedWordIds: number[];
  /** The solution, server-side only. Never serialized into RoundState while drawing. */
  active: ActiveWord | null;
  offered: { id: number; text: string }[];
  /** Indices of revealed letters, grown as the clock runs down. */
  revealed: number[];
  /** playerId -> count of custom words this game, for rate limiting. */
  customCounts: Record<string, number>;
}
