import { normalizeWord } from '../contract/index.js';
import { sqlite } from './index.js';
import { SEED_WORDS } from './words.seed.js';

export interface SeedReport {
  inserted: number;
  skipped: number;
  total: number;
}

/**
 * Idempotent on `normalized`. INSERT OR IGNORE means hand-edited rows — a
 * corrected drawability, a word you disabled — survive every redeploy. Adding
 * entries to words.seed.ts is therefore always safe.
 */
export function seedWords(): SeedReport {
  const stmt = sqlite.prepare(
    `INSERT OR IGNORE INTO words (text, normalized, category, drawability, source)
     VALUES (?, ?, ?, ?, 'seed')`,
  );
  let inserted = 0;
  const run = sqlite.transaction(() => {
    for (const [text, category, drawability] of SEED_WORDS) {
      const r = stmt.run(text, normalizeWord(text), category, drawability);
      inserted += r.changes;
    }
  });
  run();
  return {
    inserted,
    skipped: SEED_WORDS.length - inserted,
    total: SEED_WORDS.length,
  };
}
