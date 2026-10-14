import { Router } from 'express';
import { z } from 'zod';
import { WORD_PACKS, normalizeWord, type WordPackId } from '../contract/index.js';
import { sqlite, stmt } from '../db/index.js';

const PACKS = WORD_PACKS.map((p) => p.id) as [WordPackId, ...WordPackId[]];
const WordInput = z.object({
  text: z.string().trim().min(3).max(40),
  category: z.string().trim().max(32).default('owner'),
  pack: z.enum(PACKS).default('slang'),
  drawability: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
});

const Body = z.object({
  words: z.array(WordInput).min(1).max(500),
});

/**
 * M8: the convenience path for adding words without shell access to the
 * volume. SQL against the database remains the primary interface (see
 * PLAN.md §7a) — this exists so a word can be added from a phone.
 *
 * Guarded by a static bearer token. If WORDS_API_TOKEN is unset the route
 * refuses every request rather than running open: an unconfigured deploy
 * should fail closed, not expose a public write endpoint.
 */
export function wordsRouter(): Router {
  const router = Router();
  const token = process.env.WORDS_API_TOKEN?.trim();
  // Prepared once, not per request (see the note on statements in game/words.ts).
  const insert = stmt(
    `INSERT OR IGNORE INTO words (text, normalized, category, pack, drawability, source)
     VALUES (?, ?, ?, ?, ?, 'owner')`,
  );

  router.post('/words', (req, res) => {
    if (!token) {
      res.status(503).json({
        ok: false,
        error: 'WORDS_API_TOKEN is not configured; the endpoint is disabled.',
      });
      return;
    }
    const header = req.get('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!presented || !safeEqual(presented, token)) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message });
      return;
    }

    let inserted = 0;
    const run = sqlite.transaction((rows: z.infer<typeof WordInput>[]) => {
      for (const w of rows) {
        inserted += insert.run(w.text, normalizeWord(w.text), w.category, w.pack, w.drawability).changes;
      }
    });
    run(parsed.data.words);

    res.json({
      ok: true,
      inserted,
      skipped: parsed.data.words.length - inserted,
      received: parsed.data.words.length,
    });
  });

  return router;
}

/** Constant-time compare so the token cannot be recovered by timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
