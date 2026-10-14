import { stmt } from '../db/index.js';
import {
  MAX_CUSTOM_WORDS,
  WORD_MAX,
  WORD_MIN,
  type Drawability,
  type WordChoice,
  type WordDifficulty,
  type WordPackId,
  normalizeWord,
} from '../contract/index.js';
import { StoreError } from './store.js';
import type { ActiveWord } from './types.js';

/*
 * better-sqlite3 is synchronous, so every query here runs on the event loop
 * that also relays strokes for every room — and every statement comes from
 * the shared, never-evicted cache in db/index.ts (see why there).
 */

/**
 * One statement for every word choice. Packs, tiers and the exclusion list
 * arrive as JSON arrays; an empty exclusion list is simply an empty set,
 * which also retires the old `id NOT IN (NULL)` trap.
 */
const PICK_SQL = `
  SELECT id, text, drawability FROM words
  WHERE enabled = 1
    AND pack IN (SELECT value FROM json_each(?))
    AND drawability IN (SELECT value FROM json_each(?))
    AND id NOT IN (SELECT value FROM json_each(?))
  ORDER BY times_drawn ASC, RANDOM()
  LIMIT 1`;

/**
 * Deliberately small and explicit. It blocks the obvious, and the in-game
 * report button plus post-hoc review of `suggestions` is the real backstop —
 * a custom word goes live the instant it is submitted, so nothing here can be
 * a complete defence. Swap in a maintained library (e.g. `obscenity`) before
 * this is exposed to strangers.
 */
const BLOCKED = [
  'fuck', 'shit', 'cunt', 'bitch', 'bitchy', 'bastard', 'dick', 'cock', 'pussy',
  'nigger', 'nigga', 'faggot', 'fag', 'retard', 'spastic', 'tranny',
  'kike', 'chink', 'spic', 'wetback', 'paki', 'coon',
  'rape', 'rapist', 'nazi', 'hitler', 'kys',
];
/** Endings that turn a blocked word into another blocked word. */
const SUFFIXES = ['', 's', 'es', 'ed', 'er', 'ers', 'ing', 'ty', 'head', 'face'];
/**
 * The strongest words also match inside compounds ("motherfucker"), or as an
 * ending ("bullshit"). Not "cunt" or "shit" anywhere-inside: "Scunthorpe" and
 * "shiitake" (squashed to "shitake") would trip it.
 */
const ANYWHERE = ['fuck', 'nigger', 'nigga', 'faggot'];
const ENDINGS = ['shit', 'cunt'];

const LEET: Record<string, string> = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
/** "fuuuck" -> "fuck", "f4gg0t" -> "fagot": compared against equally collapsed bad words. */
const squash = (w: string) => w.replace(/[0134578@$]/g, (c) => LEET[c] ?? c).replace(/(.)\1+/g, '$1');
const BLOCKED_FORMS = new Set(BLOCKED.flatMap((b) => SUFFIXES.map((x) => squash(b + x))));

/**
 * Whole words only. Matching substrings of the squashed text (as this did)
 * rejected "peacock", "cockroach", "spicy" and "Dickens" — real words a host
 * will type into a custom list. Letters spelled out one per token ("f u c k")
 * are rejoined first, which was the reason for squashing in the first place.
 */
export function isBlocked(text: string): boolean {
  const tokens = normalizeWord(text).split(' ').filter(Boolean);
  const words: string[] = [];
  let run = '';
  for (const t of tokens) {
    if (t.length === 1) { run += t; continue; }
    if (run) { words.push(run); run = ''; }
    words.push(t);
  }
  if (run) words.push(run);
  return words.some((w) => {
    const sq = squash(w);
    return (
      BLOCKED_FORMS.has(sq) ||
      ANYWHERE.some((b) => sq.includes(squash(b))) ||
      ENDINGS.some((b) => sq.endsWith(squash(b)))
    );
  });
}

/**
 * The rules every typed-in word must pass, wherever it comes from: a drawer
 * writing their own, or a host's custom list. Returns the cleaned text.
 */
export function validateWord(text: string): string {
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
  return clean;
}

/**
 * Parses a host's custom list: comma or newline separated, deduplicated on
 * the normalized form, capped at MAX_CUSTOM_WORDS. Invalid entries are
 * returned rather than failing the whole list.
 */
export function parseCustomWords(text: string): { words: string[]; rejected: string[] } {
  const words: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[,\n]/)) {
    const entry = raw.trim();
    if (!entry) continue;
    try {
      const clean = validateWord(entry);
      const key = normalizeWord(clean);
      if (seen.has(key)) continue;
      if (words.length >= MAX_CUSTOM_WORDS) { rejected.push(entry); continue; }
      seen.add(key);
      words.push(clean);
    } catch {
      rejected.push(entry);
    }
  }
  return { words, rejected };
}

interface WordRow {
  id: number;
  text: string;
  drawability: number;
}

/** Which drawability tiers each difficulty allows, and how often each comes up. */
const TIER_ODDS: Record<WordDifficulty, [Drawability, number][]> = {
  easy: [[1, 1]],
  mixed: [[1, 0.6], [2, 0.4]],
  hard: [[1, 0.3], [2, 0.4], [3, 0.3]],
};

function rollTier(difficulty: WordDifficulty): Drawability {
  let r = Math.random();
  for (const [tier, p] of TIER_ODDS[difficulty]) {
    if ((r -= p) < 0) return tier;
  }
  return TIER_ODDS[difficulty][0]![0];
}

export interface ChoiceOptions {
  packs: WordPackId[];
  difficulty: WordDifficulty;
  count: number;
  /** Dictionary ids already drawn this game. */
  usedIds: number[];
  /** The host's custom list, and which of its entries were drawn already. */
  custom: string[];
  usedCustom: Set<number>;
  customOnly: boolean;
}

/**
 * Custom words have no dictionary row, so they travel as negative ids:
 * entry `i` of the room's list is id `-(i + 1)`.
 */
export const customId = (index: number) => -(index + 1);
export const customIndex = (id: number) => -id - 1;

/**
 * The words a drawer chooses between. Drawn from the room's packs at its
 * difficulty, mixed with (or limited to) the host's custom list, and never
 * repeating within a game while there is anything fresh left. A room that
 * has used up everything starts reusing words rather than ending the game.
 */
export function pickChoices(o: ChoiceOptions): WordChoice[] {
  const chosen: WordChoice[] = [];
  const exclude = new Set(o.usedIds);
  const takenCustom = new Set<number>();
  const packs = o.packs.length ? o.packs : (['everyday'] as WordPackId[]);
  const allowedTiers = TIER_ODDS[o.difficulty].map(([t]) => t);

  const packsJson = JSON.stringify(packs);
  const take = (tiers: Drawability[], fresh: boolean): WordRow | undefined => {
    // Fresh: nothing used this game. Otherwise only avoid repeating a word
    // already in this set of choices.
    const skip = fresh ? [...exclude] : chosen.map((c) => c.id).filter((id) => id > 0);
    return stmt(PICK_SQL).get(packsJson, JSON.stringify(tiers), JSON.stringify(skip)) as
      | WordRow
      | undefined;
  };

  const takeCustom = (): WordChoice | undefined => {
    const pool = o.custom.map((_, i) => i).filter((i) => !takenCustom.has(i));
    const fresh = pool.filter((i) => !o.usedCustom.has(i));
    const from = fresh.length ? fresh : pool;
    if (!from.length) return undefined;
    const i = from[Math.floor(Math.random() * from.length)]!;
    takenCustom.add(i);
    return { id: customId(i), text: o.custom[i]!, drawability: 2 };
  };

  for (let n = 0; n < o.count; n++) {
    const wantCustom = o.customOnly || (o.custom.length > 0 && Math.random() < 0.5);
    if (wantCustom) {
      const c = takeCustom();
      if (c) { chosen.push(c); continue; }
      if (o.customOnly) break;
    }
    const tier = rollTier(o.difficulty);
    const row =
      take([tier], true) ?? take(allowedTiers, true) ?? take([1, 2, 3], true) ?? take(allowedTiers, false);
    if (!row) break;
    exclude.add(row.id);
    chosen.push({ id: row.id, text: row.text, drawability: row.drawability as Drawability });
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
  const clean = validateWord(text);
  const normalized = normalizeWord(clean);

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
