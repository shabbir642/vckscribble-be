/**
 * Entry point. With one game-server process (SHARDS unset or 1: development,
 * or a one-core server) this process is the server. With more, it is a small
 * supervisor that prepares the database once, then runs one game-server
 * process per shard (SHARDS=auto: one per CPU core) — Node runs JavaScript on
 * one core per process, and rooms never interact, so each process owns a
 * share of the rooms (see shardOf in the contract) and nothing is shared.
 */
import { SHARDS } from './shard.js';

if (SHARDS > 1 && process.env.SHARD === undefined) {
  await import('./cluster.js');
} else {
  await import('./worker.js');
}
