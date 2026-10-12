import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { Server } from 'socket.io';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from './contract/index.js';
import { CONTRACT_VERSION } from './contract/index.js';
import { ensureSchema, sqlite } from './db/index.js';
import { seedWords } from './db/seed.js';
import { registerHandlers } from './game/handlers.js';
import { RoundEngine } from './game/round.js';
import { store } from './game/store.js';

const PORT = Number(process.env.PORT ?? 3001);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';

ensureSchema();
const report = seedWords();
console.log(
  `[db] dictionary ready — ${report.inserted} new, ${report.skipped} existing, ${report.total} seed entries`,
);

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));
app.use(express.json({ limit: '64kb' }));

app.get('/api/health', (_req, res) => {
  const { c } = sqlite
    .prepare('SELECT COUNT(*) AS c FROM words WHERE enabled = 1')
    .get() as { c: number };
  res.json({
    ok: true,
    contractVersion: CONTRACT_VERSION,
    enabledWords: c,
    rooms: store.size,
  });
});

const httpServer = createServer(app);

export const io = new Server<ClientToServerEvents, ServerToClientEvents>(
  httpServer,
  { cors: { origin: CLIENT_ORIGIN, credentials: true } },
);

const engine = new RoundEngine(io);

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
  // A collected room must not leave round timers running.
  for (const code of droppedRooms) engine.dispose(code);
  if (droppedPlayers || droppedRooms.length) {
    console.log(
      `[sweep] dropped ${droppedPlayers} players, ${droppedRooms.length} rooms`,
    );
  }
}, 30_000);
sweeper.unref();

httpServer.listen(PORT, () => {
  console.log(`[http] listening on :${PORT} — client origin ${CLIENT_ORIGIN}`);
});
