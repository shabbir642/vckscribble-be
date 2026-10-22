import { NET_ROUTES, type NetReport, type NetRoute } from '../contract/index.js';
import { sqlite, stmt } from '../db/index.js';
import { SHARD } from '../shard.js';

/**
 * Real players' connection quality, as their browsers report it once a
 * minute. The server sees only its own side of a connection; whether players
 * actually feel lag — slow round trips, drops — shows up only here.
 *
 * Kept two ways: the last WINDOW_MS in memory, a rolling picture for
 * /api/health and the log; and every report saved to SQLite (net_reports),
 * which survives deploys, for looking back over weeks — which route players
 * end up on, why, and how each one feels (dist/tools/netReport.js prints
 * it). Anonymous: no player, room or address is stored.
 */
const WINDOW_MS = 15 * 60_000;
/** How long saved reports are kept. */
const KEEP_MS = 60 * 24 * 3600_000;
/**
 * Bounds on the disk, whatever arrives: reports saved per minute by one
 * process (a thousand players reporting once a minute fit), and rows kept in
 * all (about 100 MB; the oldest go first).
 */
const MAX_SAVED_PER_MINUTE = 2000;
const MAX_ROWS = 1_000_000;

interface Entry {
  at: number;
  route: NetRoute;
  rttP50: number;
  rttP95: number;
  rttMax: number;
  samples: number;
  lost: number;
  reconnects: number;
  /** "direct:blocked,direct443:lossy"; empty when it took the fastest route. */
  skipped: string;
  /** "wifi", "cellular"…; empty when the browser does not say. */
  link: string;
}

let entries: Entry[] = [];
/** Reports not yet saved to SQLite. */
let pending: Entry[] = [];

const clamp = (n: unknown, max: number) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(Math.max(0, n), max) : 0;

function routeOf(r: Partial<NetReport>): NetRoute {
  if (typeof r.route === 'string' && (NET_ROUTES as readonly string[]).includes(r.route)) return r.route;
  // Clients from before direct443 had two routes, told apart by `direct`.
  return r.direct === true ? 'direct' : 'proxied';
}

function skippedOf(r: Partial<NetReport>): string {
  const s = r.skipped;
  if (!s || typeof s !== 'object') return '';
  const parts: string[] = [];
  for (const route of ['direct', 'direct443'] as const) {
    const why = (s as Record<string, unknown>)[route];
    if (why === 'blocked' || why === 'lossy') parts.push(`${route}:${why}`);
  }
  return parts.join(',');
}

const linkOf = (r: Partial<NetReport>): string =>
  typeof r.link === 'string' && /^[a-z0-9-]{1,16}$/.test(r.link) ? r.link : '';

export function recordNetReport(r: Partial<NetReport>): void {
  const entry: Entry = {
    at: Date.now(),
    route: routeOf(r),
    rttP50: clamp(r.rttP50, 60_000),
    rttP95: clamp(r.rttP95, 60_000),
    rttMax: clamp(r.rttMax, 60_000),
    samples: clamp(r.samples, 1000),
    lost: clamp(r.lost, 1000),
    reconnects: clamp(r.reconnects, 1000),
    skipped: skippedOf(r),
    link: linkOf(r),
  };
  entries.push(entry);
  // Bounded even with a flood of reports between sweeps.
  if (entries.length > 20_000) entries = entries.slice(-10_000);
  if (pending.length < MAX_SAVED_PER_MINUTE) pending.push(entry);
}

/* --------------------------------------------------------------- saving */

export function ensureNetTable(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS net_reports (
      at INTEGER NOT NULL,
      shard INTEGER NOT NULL,
      route TEXT NOT NULL,
      rtt_p50 INTEGER NOT NULL,
      rtt_p95 INTEGER NOT NULL,
      rtt_max INTEGER NOT NULL,
      samples INTEGER NOT NULL,
      lost INTEGER NOT NULL,
      reconnects INTEGER NOT NULL,
      skipped TEXT NOT NULL DEFAULT '',
      link TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS net_reports_at_idx ON net_reports (at);
  `);
}

const INSERT = `INSERT INTO net_reports
  (at, shard, route, rtt_p50, rtt_p95, rtt_max, samples, lost, reconnects, skipped, link)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
let saveRows: ((rows: Entry[]) => void) | null = null;
let lastPrune = 0;

/**
 * Writes the reports that came in since the last call, in one transaction:
 * once a minute and on shutdown. A batch that cannot be written (the disk,
 * a lock held too long) is dropped rather than retried forever.
 */
export function saveNetReports(now = Date.now()): number {
  if (!pending.length) return 0;
  const rows = pending;
  pending = [];
  try {
    saveRows ??= sqlite.transaction((batch: Entry[]) => {
      const insert = stmt(INSERT);
      for (const e of batch) {
        insert.run(e.at, SHARD, e.route, e.rttP50, e.rttP95, e.rttMax, e.samples, e.lost, e.reconnects, e.skipped, e.link);
      }
    });
    saveRows(rows);
    if (now - lastPrune > 3600_000) {
      lastPrune = now;
      stmt('DELETE FROM net_reports WHERE at < ?').run(now - KEEP_MS);
      stmt('DELETE FROM net_reports WHERE rowid <= (SELECT MAX(rowid) FROM net_reports) - ?').run(MAX_ROWS);
    }
    return rows.length;
  } catch (e) {
    console.error(`[net] could not save ${rows.length} reports`, e);
    return 0;
  }
}

/* -------------------------------------------------------------- summary */

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!);
}

export interface RouteSummary {
  /** Reports in the window: roughly player-minutes. */
  reports: number;
  /** Typical player's typical round trip. */
  rttP50: number;
  /** The slow end: 95th percentile of players' own 95th percentiles. */
  rttP95: number;
  lostPings: number;
  reconnects: number;
}

export interface NetSummary extends RouteSummary {
  /** Share of reports from players on the direct connection, 0..1. */
  directShare: number;
  /** The same, for each route players are on. */
  routes: Partial<Record<NetRoute, RouteSummary>>;
}

function summarize(list: Entry[]): RouteSummary {
  const withRtt = list.filter((e) => e.samples > 0);
  return {
    reports: list.length,
    rttP50: pct(withRtt.map((e) => e.rttP50).sort((a, b) => a - b), 0.5),
    rttP95: pct(withRtt.map((e) => e.rttP95).sort((a, b) => a - b), 0.95),
    lostPings: list.reduce((n, e) => n + e.lost, 0),
    reconnects: list.reduce((n, e) => n + e.reconnects, 0),
  };
}

export function netSummary(now = Date.now()): NetSummary {
  entries = entries.filter((e) => now - e.at < WINDOW_MS);
  const routes: NetSummary['routes'] = {};
  for (const route of NET_ROUTES) {
    const list = entries.filter((e) => e.route === route);
    if (list.length) routes[route] = summarize(list);
  }
  return {
    ...summarize(entries),
    directShare: entries.length
      ? +(entries.filter((e) => e.route === 'direct').length / entries.length).toFixed(2)
      : 0,
    routes,
  };
}
