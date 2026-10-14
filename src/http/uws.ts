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
  const xff = headers['x-forwarded-for']?.split(',').pop()?.trim();
  const direct = Buffer.from(res.getRemoteAddressAsText()).toString() || 'unknown';
  return {
    method: req.getCaseSensitiveMethod().toUpperCase(),
    url: req.getUrl(),
    headers,
    ip: trustProxy && xff ? xff : direct,
  };
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
