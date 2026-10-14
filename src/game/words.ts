import type { Statement } from 'better-sqlite3';
import { sqlite } from '../db/index.js';
import {
  WORD_MAX,
  WORD_MIN,
  type Drawability,
  type WordChoice,
  normalizeWord,
} from '../contract/index.js';
import { StoreError } from './store.js';
import type { ActiveWord } from './types.js';

/**
 * better-sqlite3 is synchronous, so every query here runs on the event loop
 * that also relays strokes for every room. Statements are compiled once and
 * reused; the word-choice SQL varies with the exclusion list, so it is cached
 * by text.
 */
const stmtCache = new Map<string, Statement<unknown[]>>();
function stmt(sql: string): Statement<unknown[]> {
  let s = stmtCache.get(sql);
  if (!s) {
    s = sqlite.prepare(sql);
    if (stmtCache.size > 500) stmtCache.clear();
    stmtCache.set(sql, s);
  }
  return s;
}

/**
 * Deliberately small and explicit. It blocks the obvious, and the in-game
 * report button plus post-hoc review of `suggestions` is the real backstop —
 * a custom word goes live the instant it is submitted, so nothing here can be
 * a complete defence. Swap in a maintained library (e.g. `obscenity`) before
 * this is exposed to strangers.
 */
const BLOCKED = [
  'fuck', 'shit', 'cunt', 'bitch', 'bastard', 'dick', 'cock', 'pussy',
  'nigger', 'nigga', 'faggot', 'fag', 'retard', 'spastic', 'tranny',
  'kike', 'chink', 'spic', 'wetback', 'paki', 'coon',
  'rape', 'rapist', 'nazi', 'hitler', 'kys',
];

/** Catches "f u c k" and "fuuuck" without flagging "Scunthorpe"-style words. */
function deObfuscate(normalized: string): string {
  return normalized
    .replace(/\s+/g, '')
    .replace(/(.)\1{2,}/g, '$1$1')
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/@/g, 'a')
    .replace(/\$/g, 's');
}

export function isBlocked(text: string): boolean {
  const n = normalizeWord(text);
  const squashed = deObfuscate(n);
  return BLOCKED.some(
    (bad) => n.split(' ').includes(bad) || squashed.includes(bad),
  );
}

interface WordRow {
  id: number;
  text: string;
  drawability: number;
}

/**
 * Three candidates, biased toward drawable words: tier 3 is abstract and
 * punishing, so it appears rarely rather than never. Words already used this
 * game are excluded, and ties break toward words the room has seen least.
 */
export function pickChoices(usedIds: number[], count = 3): WordChoice[] {
  const tiers: Drawability[] = [];
  for (let i = 0; i < count; i++) {
    const r = Math.random();
    tiers.push(r < 0.45 ? 1 : r < 0.85 ? 2 : 3);
  }

  const chosen: WordChoice[] = [];
  const exclude = new Set(usedIds);

  const take = (tier: Drawability | null): WordRow | undefined => {
    const skip = [...exclude];
    // `id NOT IN (NULL)` is NULL for every row, i.e. matches nothing. The
    // clause has to be omitted entirely when there is nothing to exclude.
    const notIn = skip.length
      ? `AND id NOT IN (${skip.map(() => '?').join(',')})`
      : '';
    const sql = `
      SELECT id, text, drawability FROM words
      WHERE enabled = 1
        ${notIn}
        ${tier === null ? '' : 'AND drawability = ?'}
      ORDER BY times_drawn ASC, RANDOM()
      LIMIT 1`;
    const args = tier === null ? skip : [...skip, tier];
    return stmt(sql).get(...args) as WordRow | undefined;
  };

  for (const tier of tiers) {
    const row = take(tier) ?? take(null);
    if (!row) break;
    exclude.add(row.id);
    chosen.push({
      id: row.id,
      text: row.text,
      drawability: row.drawability as Drawability,
    });
  }
  return chosen;
}

export function wordById(id: number): WordChoice | null {
  const row = stmt('SELECT id, text, drawability FROM words WHERE id = ? AND enabled = 1')
    .get(id) as WordRow | undefined;
  return row
    ? { id: row.id, text: row.text, drawability: row.drawability as Drawability }
    : null;
}

export function markDrawn(wordId: number | null): void {
  if (wordId === null) return;
  stmt('UPDATE words SET times_drawn = times_drawn + 1 WHERE id = ?').run(wordId);
}

export function markGuessed(wordId: number | null): void {
  if (wordId === null) return;
  stmt('UPDATE words SET times_guessed = times_guessed + 1 WHERE id = ?').run(wordId);
}

/**
 * Validates a drawer-supplied word and records it for later review.
 * Returns the cleaned text; throws StoreError with a player-facing message.
 */
export function acceptCustomWord(
  text: string,
  submittedBy: string,
  roomCode: string,
): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  const normalized = normalizeWord(clean);

  if (normalized.length < WORD_MIN) {
    throw new StoreError('WORD_TOO_SHORT', `At least ${WORD_MIN} characters`);
  }
  if (clean.length > WORD_MAX) {
    throw new StoreError('WORD_TOO_LONG', `At most ${WORD_MAX} characters`);
  }
  if (!/[a-z]/.test(normalized)) {
    throw new StoreError('WORD_NO_LETTERS', 'Needs at least one letter');
  }
  if (isBlocked(clean)) {
    throw new StoreError('WORD_BLOCKED', 'That word is not allowed');
  }

  // A disabled word was retired on purpose; let it stay retired.
  const retired = stmt('SELECT 1 FROM words WHERE normalized = ? AND enabled = 0')
    .get(normalized);
  if (retired) {
    throw new StoreError('WORD_RETIRED', 'That word was retired — pick another');
  }

  stmt(
    `INSERT INTO suggestions (text, normalized, submitted_by, room_code)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(normalized) DO UPDATE SET times_used = times_used + 1`,
  ).run(clean, normalized, submittedBy, roomCode);

  return clean;
}

export function markSuggestionGuessed(normalized: string): void {
  stmt('UPDATE suggestions SET times_guessed = times_guessed + 1 WHERE normalized = ?')
    .run(normalized);
}

/**
 * A report lands on whichever table the word came from. It used to touch only
 * `suggestions`, so reporting a dictionary word silently did nothing.
 */
export function reportWord(active: ActiveWord): void {
  if (active.custom || active.wordId === null) {
    stmt('UPDATE suggestions SET reported = reported + 1 WHERE normalized = ?')
      .run(active.normalized);
  } else {
    stmt('UPDATE words SET reported = reported + 1 WHERE id = ?').run(active.wordId);
  }
}
