/**
 * Token buckets. Socket.IO has no built-in flood protection, and a single
 * client can otherwise pin the server by spamming strokes or chat. Limits are
 * generous enough that normal play never touches them.
 *
 * Two scopes:
 *  - per socket, for in-game actions — fair per player, but a reconnect resets
 *    them, so they only stop accidental floods;
 *  - per IP, for room entry, where a reconnect-and-retry loop is the attack
 *    (enumerating room codes, mass-creating rooms). Kept generous because an
 *    office NAT puts every colleague behind one address.
 */
interface Bucket {
  tokens: number;
  updated: number;
}

type Limit = { perSecond: number; burst: number };

const SOCKET_LIMITS: Record<string, Limit> = {
  'chat:guess': { perSecond: 4, burst: 8 },
  'draw:stroke': { perSecond: 20, burst: 40 },
  // A drag flushes new points every ~40 ms; this leaves headroom for a
  // stroke-start and pointer-up in the same window.
  'draw:points': { perSecond: 40, burst: 80 },
  'draw:undo': { perSecond: 6, burst: 10 },
  'draw:react': { perSecond: 1, burst: 4 },
  'draw:clear': { perSecond: 2, burst: 4 },
  // Failed validation burns budget too, and rejections are expected here
  // (typos, blocked words). Accepted customs are already capped per game by
  // MAX_CUSTOM_PER_GAME, so this only needs to stop raw flooding.
  'word:custom': { perSecond: 2, burst: 8 },
  'word:report': { perSecond: 0.5, burst: 3 },
  'room:settings': { perSecond: 5, burst: 10 },
  'player:update': { perSecond: 1, burst: 5 },
  'room:resume': { perSecond: 2, burst: 5 },
  'room:create': { perSecond: 1, burst: 3 },
  'room:join': { perSecond: 2, burst: 5 },
  // A render loop can throw continuously; record a trickle, drop the rest.
  'client:error': { perSecond: 0.2, burst: 5 },
};

/**
 * Sized for a whole office behind one NAT address joining at once: hundreds of
 * colleagues share an IP. `IP_LIMIT_SCALE` multiplies every per-IP allowance
 * for bigger events (or load tests) without a code change.
 */
const IP_SCALE = Math.max(1, Number(process.env.IP_LIMIT_SCALE ?? 1) || 1);
const IP_LIMITS: Record<string, Limit> = {
  'room:create': { perSecond: 2 * IP_SCALE, burst: 100 * IP_SCALE },
  'room:join': { perSecond: 20 * IP_SCALE, burst: 400 * IP_SCALE },
  'room:resume': { perSecond: 20 * IP_SCALE, burst: 400 * IP_SCALE },
};

/** Concurrent sockets per address. An office NAT is the reason this is high. */
export const MAX_CONNECTIONS_PER_IP = 1000 * IP_SCALE;

const socketBuckets = new Map<string, Map<string, Bucket>>();
const ipBuckets = new Map<string, Map<string, Bucket>>();
const connections = new Map<string, number>();

function take(
  store: Map<string, Map<string, Bucket>>,
  key: string,
  event: string,
  limit: Limit,
): boolean {
  let perKey = store.get(key);
  if (!perKey) {
    perKey = new Map();
    store.set(key, perKey);
  }
  const now = Date.now();
  const b = perKey.get(event) ?? { tokens: limit.burst, updated: now };
  b.tokens = Math.min(limit.burst, b.tokens + ((now - b.updated) / 1000) * limit.perSecond);
  b.updated = now;
  perKey.set(event, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

export function allow(socketId: string, event: string, ip?: string): boolean {
  const ipLimit = ip ? IP_LIMITS[event] : undefined;
  if (ipLimit && !take(ipBuckets, ip!, event, ipLimit)) return false;
  const limit = SOCKET_LIMITS[event];
  return limit ? take(socketBuckets, socketId, event, limit) : true;
}

export function forgetSocket(socketId: string): void {
  socketBuckets.delete(socketId);
}

/** Returns false when the address already holds too many sockets. */
export function openConnection(ip: string): boolean {
  const n = connections.get(ip) ?? 0;
  if (n >= MAX_CONNECTIONS_PER_IP) return false;
  connections.set(ip, n + 1);
  return true;
}

export function closeConnection(ip: string): void {
  const n = (connections.get(ip) ?? 1) - 1;
  if (n <= 0) connections.delete(ip);
  else connections.set(ip, n);
}

/** Drops idle per-IP buckets so the map cannot grow without bound. */
export function sweepLimits(now = Date.now()): void {
  for (const [ip, perIp] of ipBuckets) {
    let idle = true;
    for (const b of perIp.values()) if (now - b.updated < 10 * 60_000) idle = false;
    if (idle) ipBuckets.delete(ip);
  }
}
