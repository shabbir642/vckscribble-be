import { chmodSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Server, type ServerOptions } from 'socket.io';
import type * as UWS from 'uWebSockets.js';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from './contract/index.js';
import { CONTRACT_VERSION } from './contract/index.js';
import { ensureSchema, sqlite, stmt } from './db/index.js';
import { seedWords } from './db/seed.js';
import { clientLog, sweepClientLog } from './http/clientLog.js';
import { certFiles, present, waitForCerts, watchRenewal, type TlsConfig } from './http/tls.js';
import {
  clientIp,
  corsHeaders,
  normalizeIp,
  parseJson,
  readBody,
  readRequest,
  send,
  type Reply,
  type Request,
} from './http/uws.js';
import { wordsHandler } from './http/words.js';
import { registerHandlers } from './game/handlers.js';
import { closeConnection, openConnection, sweepLimits } from './game/limits.js';
import { netSummary } from './game/netStats.js';
import { SHARD, SHARDS } from './shard.js';
import { ensureSnapshotTable, loadRooms, saveRooms } from './game/persist.js';
import { RoundEngine } from './game/round.js';
import { store } from './game/store.js';

/** Each process listens on its own port and socket: base + its shard number. */
const PORT = Number(process.env.PORT ?? 3001) + SHARD;
/**
 * When set, listen on this Unix socket instead of PORT. In production Caddy
 * reaches the backend through it (a shared volume): no TCP stack, no Docker
 * network in between, for every frame of every game.
 */
const SOCKET_PATH = (() => {
  const raw = process.env.SOCKET_PATH?.trim();
  if (!raw) return null;
  // "/run/vmock/backend-{shard}.sock", or a plain path: "-N" before ".sock".
  if (raw.includes('{shard}')) return raw.replace('{shard}', String(SHARD));
  return SHARD === 0 ? raw : raw.replace(/(\.sock)?$/, `-${SHARD}$1`);
})();
/**
 * With TLS_CERT_DIR and TLS_DOMAIN set, this process serves HTTPS itself and
 * players' browsers connect straight to DIRECT_PORT, skipping Caddy for game
 * traffic. The Unix socket stays, for players whose network only allows 443:
 * Caddy proxies them over it (TLS too, as both share one server).
 */
const TLS: TlsConfig | null = (() => {
  const dir = process.env.TLS_CERT_DIR?.trim();
  // Comma-separated: every site name players may connect to; the first is
  // the default certificate.
  const domains = (process.env.TLS_DOMAIN ?? '').split(',').map((d) => d.trim()).filter(Boolean);
  return dir && domains.length ? { dir, domains } : null;
})();
const DIRECT_BASE = Number(process.env.DIRECT_PORT ?? 8443);
const DIRECT_PORT = DIRECT_BASE + SHARD;
/** Set to 1 only when a reverse proxy (Caddy in deploy/) is the sole ingress. */
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
/**
 * Comma-separated so one deployment can serve several origins — in practice
 * localhost plus the machine's LAN address, which is how anyone else on the
 * wifi reaches a dev server. CORS needs the exact origin string, so the LAN
 * address has to be listed explicitly rather than inferred.
 */
const CLIENT_ORIGIN = (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

ensureSchema();
const report = seedWords();
console.log(
  `[db] dictionary ready — ${report.inserted} new, ${report.skipped} existing, ${report.total} seed entries`,
);

// Loaded as CommonJS: the package's ESM wrapper (v20.71.0) imports a file
// it does not ship.
const uWS = createRequire(import.meta.url)('uWebSockets.js') as typeof UWS;
if (TLS) await waitForCerts(TLS);
const app = TLS ? uWS.SSLApp(certFiles(TLS.dir, TLS.domains[0]!)) : uWS.App();

/**
 * Event-loop delay is the number that matters for a single-threaded relay:
 * every room shares this one loop, so when it stalls, everyone lags at once.
 */
const LOOP_RESOLUTION_MS = 20;
const loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
loopDelay.enable();
/** The histogram includes the sampling interval itself; report only the lag. */
const lagMs = (ns: number) => Math.max(0, +(ns / 1e6 - LOOP_RESOLUTION_MS).toFixed(1));
const enabledWords = stmt('SELECT COUNT(*) AS c FROM words WHERE enabled = 1');

function health(): Reply {
  const { c } = enabledWords.get() as { c: number };
  return { status: 200, body: {
    ok: true,
    contractVersion: CONTRACT_VERSION,
    enabledWords: c,
    rooms: store.size,
    sockets: io.engine.clientsCount,
    // Players connected straight to this process, not through Caddy.
    direct: directSockets,
    heapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
    // Players' own view of their connections, last 15 minutes.
    network: netSummary(),
    shard: SHARD,
    shards: SHARDS,
    // Every process's load, as the supervisor last heard it (several processes only).
    ...(SHARDS > 1 ? { cluster: clusterStats } : {}),
    loopLagMs: {
      p50: lagMs(loopDelay.percentile(50)),
      p99: lagMs(loopDelay.percentile(99)),
      max: lagMs(loopDelay.max),
    },
  } };
}

/**
 * How the browser finds the process that owns a room: SHARDS processes, the
 * Nth on DIRECT_PORT + N (and behind the proxy at /s/N/socket.io).
 */
const shardsInfo = (): Reply => ({
  status: 200,
  body: { shards: SHARDS, directPort: TLS ? DIRECT_BASE : null },
});

/* Load of every process, relayed by the supervisor (index.ts). */
interface ShardStats { shard: number; rooms: number; sockets: number; loopLagP99: number }
let clusterStats: ShardStats[] = [];
if (process.send) {
  process.on('message', (m: { type?: string; shards?: ShardStats[] }) => {
    if (m?.type === 'cluster' && Array.isArray(m.shards)) clusterStats = m.shards;
  });
  const report = setInterval(() => {
    process.send?.({
      type: 'stats',
      stats: { shard: SHARD, rooms: store.size, sockets: io.engine.clientsCount, loopLagP99: lagMs(loopDelay.percentile(99)) },
    });
  }, 5000);
  report.unref();
}

const API_BODY_LIMIT = 256 * 1024;
const words = wordsHandler();
const routes: Record<string, (req: Request, body: unknown) => Reply> = {
  'GET /api/health': () => health(),
  'GET /api/shards': () => shardsInfo(),
  'POST /api/words': words,
  'POST /api/client-log': clientLog,
};

app.any('/api/*', (res, req) => {
  const r = readRequest(res, req, TRUST_PROXY);
  const cors = corsHeaders(r.headers['origin'], CLIENT_ORIGIN);
  if (r.method === 'OPTIONS') {
    send(res, { status: 204, body: null }, [
      ...cors,
      ['Access-Control-Allow-Methods', 'GET,POST'],
      ['Access-Control-Allow-Headers', 'content-type,authorization'],
    ]);
    return;
  }
  const route = routes[`${r.method} ${r.url}`];
  if (!route) {
    res.onAborted(() => undefined);
    send(res, { status: 404, body: { ok: false, error: 'Not found' } }, cors);
    return;
  }
  void readBody(res, r.method === 'GET' ? 0 : API_BODY_LIMIT).then((raw) => {
    if (raw === null) return; // the client went away
    if (raw === 'too-large') {
      send(res, { status: 413, body: { ok: false, error: 'Body too large' } }, cors);
      return;
    }
    const body = parseJson(raw, r.headers['content-type']);
    if (body === undefined) {
      send(res, { status: 400, body: { ok: false, error: 'Invalid JSON' } }, cors);
      return;
    }
    try {
      send(res, route(r, body), cors);
    } catch (e) {
      console.error('[http] route failed', e);
      send(res, { status: 500, body: { ok: false } }, cors);
    }
  });
});

export const io = new Server<ClientToServerEvents, ServerToClientEvents>({
  cors: { origin: CLIENT_ORIGIN, credentials: true },
  // Socket.IO parses a message before any handler (and so any rate limit)
  // sees it. The default 1 MB let one client make the server parse junk
  // for free; the largest legitimate message is a 600-point stroke, ~8 KB.
  // On uWS this is also the WebSocket frame limit.
  maxHttpBufferSize: 100_000,
  // The client is bundled with the frontend; nothing should fetch it here.
  serveClient: false,
});
/**
 * How much a slow socket may have queued before uWS starts skipping messages
 * to it, silently (its default is 64 KB). A finished game's summary carries a
 * drawing of a few hundred KB, and the messages right behind it must still
 * arrive.
 */
const MAX_BACKPRESSURE = 1 << 20;
// socket.io's type for these options leaves out engine.io's uWS ones, but it
// hands the whole object to the engine, which passes this one on to uWS.
const uwsOptions: Partial<ServerOptions> & { maxBackpressure: number } = {
  maxBackpressure: MAX_BACKPRESSURE,
};
// Rooms become uWS pub/sub topics: a broadcast to a room is one C++ publish.
io.attachApp(app, uwsOptions);

/**
 * Behind the reverse proxy every socket comes from the proxy's address; the
 * real client is the last X-Forwarded-For hop, which the proxy appends. Only
 * trusted with TRUST_PROXY=1 — exposed directly, a client could forge it and
 * dodge the per-IP limits.
 */
let directSockets = 0;
io.use((socket, next) => {
  const { 'x-forwarded-for': xff, 'cf-connecting-ip': cf } = socket.handshake.headers;
  const ip = clientIp(
    socket.handshake.address,
    Array.isArray(xff) ? xff.join(',') : xff,
    TRUST_PROXY,
    Array.isArray(cf) ? cf[0] : cf,
  );
  if (!openConnection(ip)) {
    next(new Error('Too many connections from your network'));
    return;
  }
  (socket.data as { ip?: string }).ip = ip;
  // A TCP peer is a player on the direct port; the Unix socket is Caddy.
  const direct = Boolean(normalizeIp(socket.handshake.address));
  if (direct) directSockets++;
  socket.once('disconnect', () => {
    closeConnection(ip);
    if (direct) directSockets--;
  });
  next();
});

const engine = new RoundEngine(io);

/**
 * Games interrupted by the last shutdown pick up where they left off. The
 * grace is generous because every client is reconnecting at once.
 */
const RESTORE_GRACE_MS = 30_000;
ensureSnapshotTable();
const restored = loadRooms();
for (const { room, downtimeMs } of restored) {
  store.adopt(room, RESTORE_GRACE_MS);
  engine.resumeRoom(room, downtimeMs);
  engine.playerLeft(room, RESTORE_GRACE_MS);
}
if (restored.length) {
  console.log(`[restore] resumed ${restored.length} room(s) from the last shutdown`);
}

// A host who did not come back within their grace has handed the role on.
store.onHostChange = (room) => {
  io.to(room.code).emit('room:players', { players: store.publicPlayers(room) });
};

io.on('connection', (socket) => {
  registerHandlers(io, socket, engine);
});

/**
 * One second tick per live room. Clients could derive this from `endsAt`, but
 * a server tick keeps everyone agreeing despite clock skew and sleeping tabs.
 */
const ticker = setInterval(() => {
  const now = Date.now();
  for (const room of store.all()) {
    if (!room.round.endsAt) continue;
    const secondsLeft = Math.max(0, Math.ceil((room.round.endsAt - now) / 1000));
    io.to(room.code).emit('round:tick', { secondsLeft });
  }
}, 1000);
ticker.unref();

/**
 * Every 5 minutes with players around, one line on what their connections are
 * like — the log is where to look back at a session that "felt laggy".
 */
const netLogger = setInterval(() => {
  const n = netSummary();
  if (!n.reports) return;
  console.log(
    `[net] ${n.reports} reports/15min: rtt p50 ${n.rttP50}ms p95 ${n.rttP95}ms, ` +
      `${n.lostPings} lost pings, ${n.reconnects} reconnects, ${Math.round(n.directShare * 100)}% direct`,
  );
}, 5 * 60_000);
netLogger.unref();

/** Reaps abandoned lobby seats and dead rooms; see RoomStore.sweep. */
const sweeper = setInterval(() => {
  const { droppedPlayers, droppedRooms } = store.sweep();
  sweepLimits();
  loopDelay.reset();
  sweepClientLog();
  // A collected room must not leave round timers running.
  for (const code of droppedRooms) engine.dispose(code);
  if (droppedPlayers || droppedRooms.length) {
    console.log(
      `[sweep] dropped ${droppedPlayers} players, ${droppedRooms.length} rooms`,
    );
  }
}, 30_000);
sweeper.unref();

/**
 * The other site names on the direct port. Each gets its own certificate by
 * SNI — and, in uWS, its own routes, so the game's are added for it too.
 * They share the one engine, so a room spans every name. Last before
 * listening: app.domain() points every later route at that name.
 */
if (TLS) {
  for (const name of TLS.domains.slice(1)) {
    if (!present(TLS.dir, name)) {
      console.log(`[tls] no certificate for ${name} yet; serving it once one arrives`);
      continue;
    }
    app.addServerName(name, certFiles(TLS.dir, name));
    (io.engine as unknown as { attach(app: UWS.TemplatedApp, o: object): void })
      .attach(app.domain(name), { path: io.path(), maxBackpressure: MAX_BACKPRESSURE });
  }
}

const listenSockets: UWS.us_listen_socket[] = [];
const onListen = (where: string) => (sock: UWS.us_listen_socket | false) => {
  if (!sock) {
    // A port collision is otherwise easy to miss: an old server keeps
    // answering with ITS configuration. Say so plainly and stop.
    console.error(`[http] could not listen on ${where} — is another server still running? Stop it first.`);
    process.exit(1);
  }
  listenSockets.push(sock);
  // The proxy in the other container connects as a different user.
  if (where === SOCKET_PATH) chmodSync(SOCKET_PATH, 0o666);
  console.log(`[http] listening on ${where} — client origin ${CLIENT_ORIGIN.join(', ')}`);
  if (!process.env.WORDS_API_TOKEN) {
    console.log('[http] POST /api/words disabled (WORDS_API_TOKEN unset)');
  }
};
if (SOCKET_PATH) {
  // A socket file left by the previous run would make the listen fail.
  rmSync(SOCKET_PATH, { force: true });
  app.listen_unix(onListen(SOCKET_PATH), SOCKET_PATH);
}
if (TLS) app.listen(DIRECT_PORT, onListen(`:${DIRECT_PORT} (HTTPS, direct, shard ${SHARD}/${SHARDS})`));
else if (!SOCKET_PATH) app.listen(PORT, onListen(`:${PORT}`));

/**
 * SQLite in WAL mode needs a clean close, or the -wal file is left for the next
 * boot to recover. Platforms send SIGTERM on deploy, so handle both.
 */
function shutdown(signal: string): void {
  console.log(`[http] ${signal} — shutting down`);
  // Before anything disconnects: the rooms as they stand right now.
  try {
    const saved = saveRooms(store.all());
    if (saved) console.log(`[http] saved ${saved} room(s) to resume after restart`);
  } catch (e) {
    console.error('[http] could not save rooms', e);
  }
  clearInterval(ticker);
  clearInterval(sweeper);
  io.close();
  for (const sock of listenSockets) uWS.us_listen_socket_close(sock);
  try {
    sqlite.close();
  } catch (e) {
    console.error('[db] close failed', e);
  }
  if (SOCKET_PATH) rmSync(SOCKET_PATH, { force: true });
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
// Exits like a deploy would; Docker's restart policy brings it straight back.
if (TLS) watchRenewal(TLS, () => io.engine.clientsCount === 0, (reason) => shutdown(reason));
process.on('SIGINT', () => shutdown('SIGINT'));
