import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * The dictionary. Managed with plain SQL (see PLAN.md §7a) — there is no admin
 * UI by design. `POST /api/words` arrives at M8 as a convenience, not a
 * capability.
 */
export const words = sqliteTable(
  'words',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    text: text('text').notNull(),
    /** Normalized form — the uniqueness key, so "Circle Back" can't be re-added. */
    normalized: text('normalized').notNull(),
    category: text('category').notNull().default('general'),
    /** The word pack a host can switch on or off (see WORD_PACKS). */
    pack: text('pack').notNull().default('slang'),
    /**
     * 1 = draws itself, 3 = abstract. For corporate slang this tracks
     * DRAWABILITY, not obscurity — see PLAN.md §1. Correct it against
     * guess_pct once real rounds have been played.
     */
    drawability: integer('drawability').notNull().default(2),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    source: text('source', { enum: ['seed', 'owner', 'player'] })
      .notNull()
      .default('seed'),
    timesDrawn: integer('times_drawn').notNull().default(0),
    timesGuessed: integer('times_guessed').notNull().default(0),
    /** In-game reports; review alongside guess_pct when retiring words. */
    reported: integer('reported').notNull().default(0),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex('words_normalized_idx').on(t.normalized),
    index('words_enabled_drawability_idx').on(t.enabled, t.drawability),
  ],
);

/**
 * Words players invented mid-game (requirement 1). Untrusted until promoted
 * into `words` with a SQL INSERT. No status column: presence in `words` IS the
 * state, so there is nothing to keep in sync.
 */
export const suggestions = sqliteTable(
  'suggestions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    text: text('text').notNull(),
    normalized: text('normalized').notNull(),
    submittedBy: text('submitted_by').notNull(),
    roomCode: text('room_code').notNull(),
    /** Bumped when the same phrase is submitted again — the promotion signal. */
    timesUsed: integer('times_used').notNull().default(1),
    timesGuessed: integer('times_guessed').notNull().default(0),
    reported: integer('reported').notNull().default(0),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [uniqueIndex('suggestions_normalized_idx').on(t.normalized)],
);

export type Word = typeof words.$inferSelect;
export type NewWord = typeof words.$inferInsert;
export type Suggestion = typeof suggestions.$inferSelect;
