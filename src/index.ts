import { chmodSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Server } from 'socket.io';
import type * as UWS from 'uWebSockets.js';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from './contract/index.js';
import { CONTRACT_VERSION } from './contract/index.js';
import { ensureSchema, sqlite, stmt } from './db/index.js';
import { seedWords } from './db/seed.js';
import { clientLog, sweepClientLog } from './http/clientLog.js';
import {
  corsHeaders,
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
import { ensureSnapshotTable, loadRooms, saveRooms } from './game/persist.js';
import { RoundEngine } from './game/round.js';
import { store } from './game/store.js';

const PORT = Number(process.env.PORT ?? 3001);
/**
 * When set, listen on this Unix socket instead of PORT. In production Caddy
 * reaches the backend through it (a shared volume): no TCP stack, no Docker
 * network in between, for every frame of every game.
 */
const SOCKET_PATH = process.env.SOCKET_PATH?.trim() || null;
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
const app = uWS.App();

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
    heapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
    loopLagMs: {
      p50: lagMs(loopDelay.percentile(50)),
      p99: lagMs(loopDelay.percentile(99)),
      max: lagMs(loopDelay.max),
    },
  } };
}

const API_BODY_LIMIT = 256 * 1024;
const words = wordsHandler();
const routes: Record<string, (req: Request, body: unknown) => Reply> = {
  'GET /api/health': () => health(),
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
// Rooms become uWS pub/sub topics: a broadcast to a room is one C++ publish.
io.attachApp(app);

/**
 * Behind the reverse proxy every socket comes from the proxy's address; the
 * real client is the last X-Forwarded-For hop, which the proxy appends. Only
 * trusted with TRUST_PROXY=1 — exposed directly, a client could forge it and
 * dodge the per-IP limits.
 */
function clientIp(headers: Record<string, string | string[] | undefined>, fallback: string) {
  if (!TRUST_PROXY) return fallback;
  const xff = headers['x-forwarded-for'];
  const last = (Array.isArray(xff) ? xff.join(',') : xff)?.split(',').pop()?.trim();
  return last || fallback;
}

io.use((socket, next) => {
  const ip = clientIp(socket.handshake.headers, socket.handshake.address);
  if (!openConnection(ip)) {
    next(new Error('Too many connections from your network'));
    return;
  }
  (socket.data as { ip?: string }).ip = ip;
  socket.once('disconnect', () => closeConnection(ip));
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


let listenSocket: UWS.us_listen_socket | null = null;
const onListen = (where: string) => (sock: UWS.us_listen_socket | false) => {
  if (!sock) {
    // A port collision is otherwise easy to miss: an old server keeps
    // answering with ITS configuration. Say so plainly and stop.
    console.error(`[http] could not listen on ${where} — is another server still running? Stop it first.`);
    process.exit(1);
  }
  listenSocket = sock;
  // The proxy in the other container connects as a different user.
  if (SOCKET_PATH) chmodSync(SOCKET_PATH, 0o666);
  console.log(`[http] listening on ${where} — client origin ${CLIENT_ORIGIN.join(', ')}`);
  if (!process.env.WORDS_API_TOKEN) {
    console.log('[http] POST /api/words disabled (WORDS_API_TOKEN unset)');
  }
};
if (SOCKET_PATH) {
  // A socket file left by the previous run would make the listen fail.
  rmSync(SOCKET_PATH, { force: true });
  app.listen_unix(onListen(SOCKET_PATH), SOCKET_PATH);
} else {
  app.listen(PORT, onListen(`:${PORT}`));
}

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
  if (listenSocket) uWS.us_listen_socket_close(listenSocket);
  try {
    sqlite.close();
  } catch (e) {
    console.error('[db] close failed', e);
  }
  if (SOCKET_PATH) rmSync(SOCKET_PATH, { force: true });
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
