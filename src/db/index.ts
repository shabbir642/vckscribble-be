import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

const url = process.env.DATABASE_URL ?? './data/game.db';
mkdirSync(dirname(url), { recursive: true });

export const sqlite: Database.Database = new Database(url);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });
export { schema };

/**
 * Tables are created here rather than via drizzle-kit migrations: the schema is
 * two tables with no destructive history, and a single-file SQLite deployment
 * gains nothing from a migration ledger. `drizzle-kit push` stays available for
 * schema edits during development.
 */
export function ensureSchema(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS words (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      normalized TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      drawability INTEGER NOT NULL DEFAULT 2,
      enabled INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'seed',
      times_drawn INTEGER NOT NULL DEFAULT 0,
      times_guessed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS words_normalized_idx ON words (normalized);
    CREATE INDEX IF NOT EXISTS words_enabled_drawability_idx ON words (enabled, drawability);

    CREATE TABLE IF NOT EXISTS suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      normalized TEXT NOT NULL,
      submitted_by TEXT NOT NULL,
      room_code TEXT NOT NULL,
      times_used INTEGER NOT NULL DEFAULT 1,
      times_guessed INTEGER NOT NULL DEFAULT 0,
      reported INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS suggestions_normalized_idx ON suggestions (normalized);
  `);
}
