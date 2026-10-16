import { shardOf } from '../contract/index.js';
import { sqlite, stmt } from '../db/index.js';
import { SHARD, SHARDS } from '../shard.js';
import type { Room } from './types.js';

/**
 * Rooms live in memory, so a deploy used to end every game in progress.
 * On shutdown they are written to SQLite (the persistent volume) and on boot
 * read back, with every deadline shifted by the downtime: to players a deploy
 * is a pause of a few seconds while their clients reconnect and resume.
 *
 * Only a graceful stop (SIGTERM / SIGINT — what `docker compose up` and
 * `docker stop` send) runs this. A hard crash still loses the games.
 */

/** Snapshots older than this are stale: the players have long gone. */
const MAX_AGE_MS = 15 * 60_000;

/** JSON has no Map or Set; tag them so they come back as what they were. */
function replacer(key: string, value: unknown): unknown {
  // Rebuilt from `strokes` on load: it must index the very same objects.
  if (key === 'strokeIndex') return undefined;
  if (value instanceof Map) return { __map: [...value] };
  if (value instanceof Set) return { __set: [...value] };
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object') {
    if ('__map' in value) return new Map((value as { __map: [unknown, unknown][] }).__map);
    if ('__set' in value) return new Set((value as { __set: unknown[] }).__set);
  }
  return value;
}

export function ensureSnapshotTable(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS room_snapshots (
      code TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      saved_at INTEGER NOT NULL
    );
  `);
}

/**
 * Writes every room with anyone in it. Returns how many were saved. Each
 * process writes only its own rooms; the others' snapshots are theirs.
 */
export function saveRooms(rooms: Room[]): number {
  const now = Date.now();
  const insert = stmt('INSERT OR REPLACE INTO room_snapshots (code, data, saved_at) VALUES (?, ?, ?)');
  let saved = 0;
  sqlite.transaction(() => {
    for (const room of rooms) {
      if (room.players.size === 0) continue;
      insert.run(room.code, JSON.stringify(room, replacer), now);
      saved++;
    }
  })();
  return saved;
}

/**
 * Reads back the snapshots of the rooms this process owns — by the current
 * process count, so after a server with more cores comes up each room lands
 * on its new owner — and deletes them, so a room is restored once. Everyone
 * comes back disconnected: their seats wait for them to resume.
 */
export function loadRooms(now = Date.now()): { room: Room; downtimeMs: number }[] {
  const rows = (
    stmt('SELECT code, data, saved_at FROM room_snapshots').all() as {
      code: string;
      data: string;
      saved_at: number;
    }[]
  ).filter((r) => shardOf(r.code, SHARDS) === SHARD);
  const remove = stmt('DELETE FROM room_snapshots WHERE code = ?');
  sqlite.transaction(() => {
    for (const r of rows) remove.run(r.code);
    // Anything this old is stale whoever owns it.
    stmt('DELETE FROM room_snapshots WHERE saved_at < ?').run(now - MAX_AGE_MS);
  })();

  const out: { room: Room; downtimeMs: number }[] = [];
  for (const row of rows) {
    if (now - row.saved_at > MAX_AGE_MS) continue;
    try {
      const room = JSON.parse(row.data, reviver) as Room;
      room.strokeIndex = new Map(room.strokes.map((s) => [s.id, s]));
      // Snapshots from before vote kicks existed.
      room.kickVotes ??= new Map();
      room.banned ??= new Set();
      // Snapshots from before custom words were paced.
      room.customOffered ??= new Map();
      room.turnNo ??= 0;
      for (const p of room.players.values()) {
        p.connected = false;
        p.socketId = null;
        p.lastSeen = now;
      }
      room.lastActivity = now;
      out.push({ room, downtimeMs: Math.max(0, now - row.saved_at) });
    } catch (e) {
      console.error(`[restore] skipped room ${row.code}`, e);
    }
  }
  return out;
}
