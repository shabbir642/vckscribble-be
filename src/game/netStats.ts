import type { NetReport } from '../contract/index.js';

/**
 * Real players' connection quality, as their browsers report it once a
 * minute. The server sees only its own side of a connection; whether players
 * actually feel lag — slow round trips, drops — shows up only here.
 * Kept in memory for WINDOW_MS: a rolling picture, not a history.
 */
const WINDOW_MS = 15 * 60_000;

interface Entry extends NetReport {
  at: number;
}

let entries: Entry[] = [];

const clamp = (n: unknown, max: number) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(Math.max(0, n), max) : 0;

export function recordNetReport(r: Partial<NetReport>): void {
  entries.push({
    at: Date.now(),
    rttP50: clamp(r.rttP50, 60_000),
    rttP95: clamp(r.rttP95, 60_000),
    rttMax: clamp(r.rttMax, 60_000),
    samples: clamp(r.samples, 1000),
    lost: clamp(r.lost, 1000),
    reconnects: clamp(r.reconnects, 1000),
    direct: r.direct === true,
  });
  // Bounded even with a flood of reports between sweeps.
  if (entries.length > 20_000) entries = entries.slice(-10_000);
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!);
}

export interface NetSummary {
  /** Reports in the window: roughly player-minutes. */
  reports: number;
  /** Typical player's typical round trip. */
  rttP50: number;
  /** The slow end: 95th percentile of players' own 95th percentiles. */
  rttP95: number;
  lostPings: number;
  reconnects: number;
  /** Share of reports from players on the direct connection, 0..1. */
  directShare: number;
}

export function netSummary(now = Date.now()): NetSummary {
  entries = entries.filter((e) => now - e.at < WINDOW_MS);
  const withRtt = entries.filter((e) => e.samples > 0);
  const p50s = withRtt.map((e) => e.rttP50).sort((a, b) => a - b);
  const p95s = withRtt.map((e) => e.rttP95).sort((a, b) => a - b);
  return {
    reports: entries.length,
    rttP50: pct(p50s, 0.5),
    rttP95: pct(p95s, 0.95),
    lostPings: entries.reduce((n, e) => n + e.lost, 0),
    reconnects: entries.reduce((n, e) => n + e.reconnects, 0),
    directShare: entries.length
      ? +(entries.filter((e) => e.direct).length / entries.length).toFixed(2)
      : 0,
  };
}
