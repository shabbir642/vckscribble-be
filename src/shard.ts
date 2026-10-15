import { availableParallelism } from 'node:os';

/**
 * This process's place among the game-server processes: SHARD of SHARDS. One
 * process runs per CPU core (index.ts starts them); each owns the rooms whose
 * code hashes to it (shardOf in the contract). SHARDS=auto means one per core.
 * Unset, it is 1: a single process, as in development.
 */
function count(raw: string | undefined): number {
  if (raw === 'auto') return Math.max(1, availableParallelism());
  const n = Number(raw ?? 1);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 64) : 1;
}

export const SHARDS = count(process.env.SHARDS);
export const SHARD = Math.min(Math.max(0, Number(process.env.SHARD ?? 0) || 0), SHARDS - 1);
