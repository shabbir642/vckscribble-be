import { normalizeWord } from '../contract/index.js';
import { sqlite, stmt } from './index.js';
import { packRows } from './packs.seed.js';
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
 *
 * A word listed in a second pack keeps its first and joins the second as its
 * `also_pack` (one extra pack at most, set once, so a hand edit stays).
 */
export function seedWords(): SeedReport {
  const insert = stmt(
    `INSERT OR IGNORE INTO words (text, normalized, category, pack, drawability, source)
     VALUES (?, ?, ?, ?, ?, 'seed')`,
  );
  const join = stmt(
    `UPDATE words SET also_pack = ? WHERE normalized = ? AND pack <> ? AND also_pack IS NULL`,
  );
  // Slang first: where a word appears twice, the first pack keeps it.
  const rows: [string, string, string, number][] = [
    ...SEED_WORDS.map(([text, category, d]) => [text, category, 'slang', d] as [string, string, string, number]),
    ...packRows().map(([text, pack, d]) => [text, pack, pack, d] as [string, string, string, number]),
  ];
  let inserted = 0;
  const run = sqlite.transaction(() => {
    for (const [text, category, pack, drawability] of rows) {
      const added = insert.run(text, normalizeWord(text), category, pack, drawability).changes;
      if (!added) join.run(pack, normalizeWord(text), pack);
      inserted += added;
    }
  });
  run();
  return { inserted, skipped: rows.length - inserted, total: rows.length };
}
