import { customAlphabet } from 'nanoid';

/**
 * Ambiguous glyphs removed (I/1, O/0, S/5, B/8, Z/2) — room codes get read
 * aloud and typed from memory, so legibility beats keyspace. 26^4 of the
 * remaining alphabet is ~457k, far beyond concurrent-room needs. Joins are
 * rate limited per IP so live codes cannot be found by enumeration.
 */
const ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679';
const gen = customAlphabet(ALPHABET, 4);

export function roomCode(exists: (code: string) => boolean): string {
  for (let i = 0; i < 50; i++) {
    const code = gen();
    if (!exists(code)) return code;
  }
  // Keyspace pressure this severe means something is wrong; widen rather than loop.
  return customAlphabet(ALPHABET, 6)();
}

export const playerId = customAlphabet(
  '0123456789abcdefghijklmnopqrstuvwxyz',
  12,
);
export const token = customAlphabet(
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  32,
);
