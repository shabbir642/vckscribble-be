import type { Statement } from 'better-sqlite3';
import { sqlite } from '../db/index.js';

/**
 * Event names are a closed set on purpose. A free-form string would drift into
 * near-duplicates ("game_end", "gameEnded") and quietly break every query that
 * reads them.
 */
export type EventType =
  | 'room_created'
  | 'player_joined'
  | 'player_reclaimed_seat'
  | 'player_reconnected'
  | 'player_dropped'
  | 'game_started'
  | 'turn_started'
  | 'turn_ended'
  | 'custom_word'
  | 'word_reported'
  | 'game_finished'
  | 'client_error';

export interface EventFields {
  roomCode?: string | null;
  playerId?: string | null;
  playerName?: string | null;
  data?: Record<string, unknown>;
}

/** Keeps one oversized payload from bloating the table. */
const MAX_DATA_CHARS = 2000;

/**
 * Prepared on first use, not at import. Module initialisation runs before
 * `ensureSchema()` has created the table, so preparing here eagerly throws at
 * startup — and takes the whole server with it.
 */
let insert: Statement | null = null;
function stmt(): Statement {
  insert ??= sqlite.prepare(`
    INSERT INTO events (type, room_code, player_id, player_name, data)
    VALUES (?, ?, ?, ?, ?)
  `);
  return insert;
}

/**
 * Record something that happened.
 *
 * Never throws: observability that can break the game it observes is worse than
 * none, so a failure here is logged and swallowed. better-sqlite3 is
 * synchronous, which keeps this a single indexed insert with no queue to lose
 * on shutdown — at party-game volumes that is cheaper than the machinery to
 * avoid it.
 */
export function track(type: EventType, fields: EventFields = {}): void {
  try {
    const json = fields.data ? JSON.stringify(fields.data) : null;
    stmt().run(
      type,
      fields.roomCode ?? null,
      fields.playerId ?? null,
      fields.playerName ?? null,
      json && json.length > MAX_DATA_CHARS ? json.slice(0, MAX_DATA_CHARS) : json,
    );
  } catch (e) {
    console.error('[events] failed to record', type, e);
  }
}

/**
 * Drop events past their useful life. These answer "is the game frustrating
 * people lately", a question nobody asks about last quarter, and the table
 * would otherwise grow without bound on a small Fly volume.
 */
export function pruneEvents(days = 30): number {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - days * 86_400;
    return sqlite.prepare('DELETE FROM events WHERE at < ?').run(cutoff).changes;
  } catch (e) {
    console.error('[events] prune failed', e);
    return 0;
  }
}

/** Counts by type over a recent window, for /api/health. */
export function recentCounts(hours = 24): Record<string, number> {
  try {
    const since = Math.floor(Date.now() / 1000) - hours * 3600;
    const rows = sqlite
      .prepare('SELECT type, COUNT(*) AS c FROM events WHERE at >= ? GROUP BY type')
      .all(since) as { type: string; c: number }[];
    return Object.fromEntries(rows.map((r) => [r.type, r.c]));
  } catch {
    return {};
  }
}
