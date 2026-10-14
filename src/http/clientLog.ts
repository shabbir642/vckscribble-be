import { z } from 'zod';
import type { Reply, Request } from './uws.js';

const Body = z.object({
  source: z.enum(['render', 'window', 'promise', 'socket']),
  message: z.string().min(1).max(500),
  detail: z.string().max(2000).optional(),
  url: z.string().max(500).optional(),
  roomCode: z.string().max(12).optional(),
  playerName: z.string().max(40).optional(),
});

/** Crude per-IP cap: enough to stop a loop filling the table, no more. */
const seen = new Map<string, { n: number; since: number }>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

/** Forget addresses whose window has lapsed, so the map stays bounded. */
export function sweepClientLog(now = Date.now()): void {
  for (const [ip, rec] of seen) if (now - rec.since > WINDOW_MS) seen.delete(ip);
}

function overLimit(ip: string): boolean {
  const now = Date.now();
  const rec = seen.get(ip);
  if (!rec || now - rec.since > WINDOW_MS) {
    seen.set(ip, { n: 1, since: now });
    return false;
  }
  rec.n++;
  return rec.n > MAX_PER_WINDOW;
}

/**
 * A beacon for failures that happen before — or instead of — a socket
 * connection.
 *
 * The socket carries client errors once it is up, but the failures that matter
 * most are the ones that stop it coming up at all: a CORS misconfiguration, a
 * bad build, a blocked websocket. Those are invisible from the server side,
 * which is exactly how an outage can coexist with a clean log. Unauthenticated
 * by necessity, so it is rate limited and everything in it is treated as
 * untrusted text.
 */
export function clientLog(req: Request, body: unknown): Reply {
  if (overLimit(req.ip)) return { status: 429, body: { ok: false } };
  const parsed = Body.safeParse(body);
  if (!parsed.success) return { status: 400, body: { ok: false } };
  const { roomCode, playerName, source, message } = parsed.data;
  console.warn(
    `[client] ${source} from ${playerName ?? 'anon'}@${roomCode ?? '-'}: ${message}`,
  );
  return { status: 200, body: { ok: true } };
}
