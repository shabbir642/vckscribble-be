import { z } from 'zod';
import { WORD_PACKS, normalizeWord, type WordPackId } from '../contract/index.js';
import { sqlite, stmt } from '../db/index.js';
import type { Reply, Request } from './uws.js';

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
export function wordsHandler(): (req: Request, body: unknown) => Reply {
  const token = process.env.WORDS_API_TOKEN?.trim();
  // Prepared once, not per request (see the note on statements in game/words.ts).
  const insert = stmt(
    `INSERT OR IGNORE INTO words (text, normalized, category, pack, drawability, source)
     VALUES (?, ?, ?, ?, ?, 'owner')`,
  );

  return (req, body) => {
    if (!token) {
      return {
        status: 503,
        body: { ok: false, error: 'WORDS_API_TOKEN is not configured; the endpoint is disabled.' },
      };
    }
    const header = req.headers['authorization'] ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!presented || !safeEqual(presented, token)) {
      return { status: 401, body: { ok: false, error: 'Unauthorized' } };
    }

    const parsed = Body.safeParse(body);
    if (!parsed.success) {
      return { status: 400, body: { ok: false, error: parsed.error.issues[0]?.message } };
    }

    let inserted = 0;
    const run = sqlite.transaction((rows: z.infer<typeof WordInput>[]) => {
      for (const w of rows) {
        inserted += insert.run(w.text, normalizeWord(w.text), w.category, w.pack, w.drawability).changes;
      }
    });
    run(parsed.data.words);

    return {
      status: 200,
      body: {
        ok: true,
        inserted,
        skipped: parsed.data.words.length - inserted,
        received: parsed.data.words.length,
      },
    };
  };
}

/** Constant-time compare so the token cannot be recovered by timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
