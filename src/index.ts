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
  res.json({ ok: true, contractVersion: CONTRACT_VERSION, enabledWords: c });
});

const httpServer = createServer(app);

export const io = new Server<ClientToServerEvents, ServerToClientEvents>(
  httpServer,
  { cors: { origin: CLIENT_ORIGIN, credentials: true } },
);

io.on('connection', (socket) => {
  // Rooms land in M2, the game loop in M4. Connection lifecycle only for now.
  console.log(`[io] connect ${socket.id}`);
  socket.on('disconnect', (reason) => {
    console.log(`[io] disconnect ${socket.id} (${reason})`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`[http] listening on :${PORT} — client origin ${CLIENT_ORIGIN}`);
});
