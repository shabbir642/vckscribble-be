import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureSchema, sqlite } from './db/index.js';
import { seedWords } from './db/seed.js';
import { SHARDS } from './shard.js';

/**
 * Supervisor for SHARDS game-server processes (see index.ts).
 *
 * - Prepares the database first, alone: migrations run once, not raced by
 *   every process at boot.
 * - Restarts a process that dies, with a growing delay if it keeps dying.
 * - Relays each process's load to process 0, which reports it in /api/health.
 * - On SIGTERM (a deploy) asks every process to stop — each saves its own
 *   rooms — and exits once they have.
 */
ensureSchema();
const report = seedWords();
console.log(
  `[cluster] dictionary ready — ${report.inserted} new; starting ${SHARDS} game-server processes`,
);
sqlite.close();

// In development (tsx) this file is .ts and so is the worker; built, both .js.
const workerFile = fileURLToPath(
  new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url),
);

interface Stats { shard: number; rooms: number; sockets: number; loopLagP99: number }
const workers = new Map<number, ChildProcess>();
const stats = new Map<number, Stats>();
const failures = new Map<number, number>();
let stopping = false;

function start(shard: number): void {
  const child = fork(workerFile, [], {
    env: { ...process.env, SHARD: String(shard), SHARDS: String(SHARDS) },
  });
  workers.set(shard, child);
  const startedAt = Date.now();
  child.on('message', (m: { type?: string; stats?: Stats }) => {
    if (m?.type === 'stats' && m.stats) stats.set(shard, m.stats);
  });
  child.on('exit', (code, signal) => {
    workers.delete(shard);
    stats.delete(shard);
    if (stopping) {
      if (workers.size === 0) process.exit(0);
      return;
    }
    // A process that ran a while and died is restarted at once; one that dies
    // at boot again and again waits longer each time (up to 30 s).
    const n = Date.now() - startedAt > 60_000 ? 0 : (failures.get(shard) ?? 0) + 1;
    failures.set(shard, n);
    const delay = Math.min(30_000, n === 0 ? 0 : 1000 * 2 ** (n - 1));
    console.error(`[cluster] shard ${shard} exited (${signal ?? code}); restarting in ${delay} ms`);
    setTimeout(() => start(shard), delay);
  });
}

for (let shard = 0; shard < SHARDS; shard++) start(shard);

setInterval(() => {
  const all = [...stats.values()].sort((a, b) => a.shard - b.shard);
  workers.get(0)?.send({ type: 'cluster', shards: all });
}, 5000).unref();

function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  console.log(`[cluster] ${signal} — stopping ${workers.size} processes`);
  for (const w of workers.values()) w.kill('SIGTERM');
  if (workers.size === 0) process.exit(0);
  // Each process exits within 5 s on its own; this is the backstop.
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
