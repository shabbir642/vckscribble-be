import type {
  Drawability,
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
  /** The browser's persistent id, if it sent one; reclaims seats. */
  deviceId: string | null;
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
  /** id -> stroke, so appends and restarts resolve in O(1). */
  strokeIndex: Map<string, Stroke>;
  /** Sum of points across `strokes`, checked against MAX_POINTS_PER_ROOM. */
  pointCount: number;
  createdAt: number;
  lastActivity: number;

  /* --- round machine (M4) --- */
  /** Bumped on every phase change; stale timers compare against it and bail. */
  seq: number;
  /** Whose turn it is within the current round. */
  turnIndex: number;
  /**
   * The drawing queue. Seeded from `order` at kickoff, extended as players
   * arrive, and rebuilt from the live roster at each round boundary.
   */
  drawOrder: string[];
  usedWordIds: number[];
  /** The solution, server-side only. Never serialized into RoundState while drawing. */
  active: ActiveWord | null;
  /** Kept whole, not just ids: a drawer who reconnects mid-selection needs the
   *  same three choices re-sent, drawability and all. */
  offered: { id: number; text: string; drawability: Drawability }[];
  /** Indices of revealed letters, grown as the clock runs down. */
  revealed: number[];
  /** playerId -> count of custom words this game, for rate limiting. */
  customCounts: Record<string, number>;
  /** Points the drawer has earned this turn, for the per-turn cap. */
  drawerEarned: number;
  /** Players who reported the current word; one report each per turn. */
  reportedBy: Set<string>;
}
