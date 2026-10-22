/**
 * What players' connections have been like: which route they end up on,
 * why they passed over the faster ones, and how each route feels. Reads the
 * reports the game servers save (see game/netStats.ts).
 *
 *   docker compose exec backend node dist/tools/netReport.js [days=7]
 *   pnpm net:report [days]                       (development)
 */
import { NET_ROUTES, type NetRoute } from '../contract/index.js';
import { stmt } from '../db/index.js';

interface Row {
  at: number;
  route: NetRoute;
  rtt_p50: number;
  rtt_p95: number;
  samples: number;
  lost: number;
  reconnects: number;
  skipped: string;
  link: string;
}

const days = Math.max(1, Math.min(60, Number(process.argv[2]) || 7));
const since = Date.now() - days * 24 * 3600_000;

let rows: Row[];
try {
  rows = stmt(
    `SELECT at, route, rtt_p50, rtt_p95, samples, lost, reconnects, skipped, link
     FROM net_reports WHERE at >= ? ORDER BY at`,
  ).all(since) as Row[];
} catch {
  rows = [];
}
if (!rows.length) {
  console.log(`No connection reports in the last ${days} day(s).`);
  process.exit(0);
}

const pct = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!);
};
const share = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '-');
const pad = (s: string | number, n: number) => String(s).padStart(n);

function line(route: string, list: Row[], total: number): string {
  const timed = list.filter((r) => r.samples > 0);
  const lost = list.reduce((n, r) => n + r.lost, 0);
  const pings = list.reduce((n, r) => n + r.samples, 0) + lost;
  const reconnects = list.reduce((n, r) => n + r.reconnects, 0);
  return [
    route.padEnd(10),
    pad(list.length, 10),
    pad(share(list.length, total), 6),
    pad(`${pct(timed.map((r) => r.rtt_p50), 0.5)}ms`, 8),
    pad(`${pct(timed.map((r) => r.rtt_p95), 0.95)}ms`, 8),
    pad(pings ? `${((lost / pings) * 100).toFixed(1)}%` : '-', 6),
    pad(list.length ? (reconnects / (list.length / 60)).toFixed(1) : '-', 12),
  ].join(' ');
}

const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });
const byRoute = (list: Row[], route: NetRoute) => list.filter((r) => r.route === route);

console.log(`Player connections, last ${days} day(s), ${rows.length} player-minutes\n`);
console.log('route      player-min  share  rtt p50  rtt p95   lost  reconnect/h');
for (const route of NET_ROUTES) {
  const list = byRoute(rows, route);
  if (list.length) console.log(line(route, list, rows.length));
}

const reasons = new Map<string, number>();
for (const r of rows) for (const s of r.skipped ? r.skipped.split(',') : []) reasons.set(s, (reasons.get(s) ?? 0) + 1);
console.log('\nPassed over a faster route (player-minutes):');
console.log(
  reasons.size
    ? [...reasons].sort((a, b) => b[1] - a[1]).map(([s, n]) => `  ${s.replace(':', ' ')} ${n}`).join('\n')
    : '  none',
);

const told = rows.filter((r) => r.link);
if (told.length) {
  console.log(`\nNetwork, where the browser says (${share(told.length, rows.length)} of reports):`);
  for (const route of NET_ROUTES) {
    const list = byRoute(told, route);
    if (!list.length) continue;
    const kinds = new Map<string, number>();
    for (const r of list) kinds.set(r.link, (kinds.get(r.link) ?? 0) + 1);
    const parts = [...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${share(n, list.length)}`);
    console.log(`  ${route.padEnd(10)} ${parts.join(', ')}`);
  }
}

console.log('\nBy day (IST)   player-min  ' + NET_ROUTES.map((r) => r.padStart(16)).join(''));
const perDay = new Map<string, Row[]>();
for (const r of rows) {
  const d = day.format(r.at);
  const list = perDay.get(d);
  if (list) list.push(r);
  else perDay.set(d, [r]);
}
for (const [d, list] of perDay) {
  const cells = NET_ROUTES.map((route) => {
    const on = byRoute(list, route);
    const timed = on.filter((r) => r.samples > 0);
    return pad(on.length ? `${share(on.length, list.length)} ${pct(timed.map((r) => r.rtt_p50), 0.5)}ms` : '-', 16);
  });
  console.log(`${d.padEnd(14)} ${pad(list.length, 10)}  ${cells.join('')}`);
}
