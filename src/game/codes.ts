import { customAlphabet } from 'nanoid';
import { shardOf } from '../contract/index.js';

/**
 * Ambiguous glyphs removed (I/1, O/0, S/5, B/8, Z/2) — room codes get read
 * aloud and typed from memory, so legibility beats keyspace. 26^4 of the
 * remaining alphabet is ~457k, far beyond concurrent-room needs. Joins are
 * rate limited per IP so live codes cannot be found by enumeration.
 */
const ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679';
const gen = customAlphabet(ALPHABET, 4);

/**
 * A free code that hashes to this process (see shardOf), so every other
 * process knows the room is not theirs. With N processes about N draws are
 * needed per code — microseconds.
 */
export function roomCode(
  exists: (code: string) => boolean,
  shard = 0,
  shards = 1,
): string {
  for (let i = 0; i < 100 * Math.max(1, shards); i++) {
    const code = gen();
    if (shardOf(code, shards) === shard && !exists(code)) return code;
  }
  // Keyspace pressure this severe means something is wrong; widen rather than loop.
  const wide = customAlphabet(ALPHABET, 6);
  for (;;) {
    const code = wide();
    if (shardOf(code, shards) === shard && !exists(code)) return code;
  }
}

export const playerId = customAlphabet(
  '0123456789abcdefghijklmnopqrstuvwxyz',
  12,
);
export const token = customAlphabet(
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  32,
);
