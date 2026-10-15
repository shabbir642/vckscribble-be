import type { HttpRequest, HttpResponse } from 'uWebSockets.js';

/**
 * The few HTTP routes the backend has, served by uWebSockets.js directly.
 *
 * The game's traffic is all WebSocket, and uWS sends a frame to a room of
 * players from C++ in one call where Node's own server made a JavaScript call
 * per player. Express cannot sit on a uWS server, and three small routes did
 * not justify a second listener, so they are written against uWS here. The
 * rules that come with uWS: read everything from `req` before the first
 * `await` (it is only valid synchronously), register `onAborted` before
 * reading a body, and write a response inside `cork` once anything async
 * happened.
 */

export interface Request {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Client address: the proxy's X-Forwarded-For entry when trusted. */
  ip: string;
}

export interface Reply {
  status: number;
  body: unknown;
}

const STATUS: Record<number, string> = {
  200: '200 OK',
  204: '204 No Content',
  400: '400 Bad Request',
  401: '401 Unauthorized',
  404: '404 Not Found',
  413: '413 Payload Too Large',
  429: '429 Too Many Requests',
  500: '500 Internal Server Error',
  503: '503 Service Unavailable',
};

export function readRequest(res: HttpResponse, req: HttpRequest, trustProxy: boolean): Request {
  const headers: Record<string, string> = {};
  req.forEach((k, v) => {
    headers[k] = v;
  });
  return {
    method: req.getCaseSensitiveMethod().toUpperCase(),
    url: req.getUrl(),
    headers,
    ip: clientIp(Buffer.from(res.getRemoteAddressAsText()).toString(), headers['x-forwarded-for'], trustProxy),
  };
}

/**
 * Who is on the other end. A TCP connection — a player connecting directly —
 * has a real address that cannot be forged, so it wins. The Unix socket has
 * none: that is Caddy, and the client is the last X-Forwarded-For hop it
 * appended, trusted only with `trustProxy` (a direct client could otherwise
 * send any X-Forwarded-For it liked to dodge per-IP limits).
 */
export function clientIp(remote: string, xff: string | undefined, trustProxy: boolean): string {
  const direct = normalizeIp(remote);
  if (direct) return direct;
  const forwarded = trustProxy ? xff?.split(',').pop()?.trim() : undefined;
  return forwarded || 'unknown';
}

/**
 * uWS reports addresses as eight full hex groups, IPv4 included
 * (0000:…:ffff:7f00:0001). Caddy writes the usual forms (127.0.0.1, ::1).
 * Rate limits key on the address, so a player must look the same either way.
 */
export function normalizeIp(raw: string): string {
  if (!raw || raw.includes('.')) return raw;
  const groups = raw.split(':');
  if (groups.length !== 8) return raw;
  const n = groups.map((g) => parseInt(g, 16));
  if (n.some((x) => Number.isNaN(x))) return raw;
  if (n.slice(0, 5).every((x) => x === 0) && n[5] === 0xffff) {
    return `${n[6]! >> 8}.${n[6]! & 255}.${n[7]! >> 8}.${n[7]! & 255}`;
  }
  // RFC 5952: the longest run of two or more zero groups becomes "::".
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (n[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && n[j] === 0) j++;
    if (j - i >= 2 && j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = n.map((x) => x.toString(16));
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

/**
 * Collects a body up to `limit` bytes. Resolves null when the client went
 * away or sent too much — the caller has nothing left to answer.
 */
export function readBody(res: HttpResponse, limit: number): Promise<Buffer | 'too-large' | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    res.onAborted(() => {
      done = true;
      resolve(null);
    });
    res.onData((ab, isLast) => {
      if (done) return;
      size += ab.byteLength;
      if (size > limit) {
        done = true;
        resolve('too-large');
        return;
      }
      // uWS reuses the buffer after this callback returns: copy it.
      chunks.push(Buffer.from(ab.slice(0)));
      if (isLast) {
        done = true;
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

/** Parses a JSON body the way express.json() did: only when declared JSON. */
export function parseJson(body: Buffer, contentType: string | undefined): unknown {
  if (!contentType?.toLowerCase().includes('application/json')) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** CORS for the API: echo an allowed origin, as the `cors` package did. */
export function corsHeaders(origin: string | undefined, allowed: string[]): [string, string][] {
  if (!origin || !allowed.includes(origin)) return [];
  return [
    ['Access-Control-Allow-Origin', origin],
    ['Access-Control-Allow-Credentials', 'true'],
    ['Vary', 'Origin'],
  ];
}

export function send(
  res: HttpResponse,
  reply: Reply,
  extraHeaders: [string, string][] = [],
): void {
  res.cork(() => {
    res.writeStatus(STATUS[reply.status] ?? `${reply.status}`);
    for (const [k, v] of extraHeaders) res.writeHeader(k, v);
    if (reply.status === 204) {
      res.end();
      return;
    }
    res.writeHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(reply.body));
  });
}
