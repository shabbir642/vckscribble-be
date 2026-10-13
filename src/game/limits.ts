/**
 * Per-socket token buckets. Socket.IO has no built-in flood protection, and a
 * single client can otherwise pin the server by spamming strokes or chat.
 * Limits are generous enough that normal play never touches them.
 */
interface Bucket {
  tokens: number;
  updated: number;
}

const buckets = new Map<string, Map<string, Bucket>>();

const LIMITS: Record<string, { perSecond: number; burst: number }> = {
  'chat:guess': { perSecond: 4, burst: 8 },
  'draw:stroke': { perSecond: 40, burst: 80 },
  'draw:undo': { perSecond: 6, burst: 10 },
  'draw:clear': { perSecond: 2, burst: 4 },
  // Failed validation burns budget too, and rejections are expected here
  // (typos, blocked words). Accepted customs are already capped per game by
  // MAX_CUSTOM_PER_GAME, so this only needs to stop raw flooding.
  'word:custom': { perSecond: 2, burst: 8 },
  'room:create': { perSecond: 1, burst: 3 },
  'room:join': { perSecond: 2, burst: 5 },
  // A render loop can throw continuously; record a trickle, drop the rest.
  'client:error': { perSecond: 0.2, burst: 5 },
};

export function allow(socketId: string, event: string): boolean {
  const limit = LIMITS[event];
  if (!limit) return true;
  const perSocket = buckets.get(socketId) ?? new Map<string, Bucket>();
  buckets.set(socketId, perSocket);

  const now = Date.now();
  const b = perSocket.get(event) ?? { tokens: limit.burst, updated: now };
  b.tokens = Math.min(limit.burst, b.tokens + ((now - b.updated) / 1000) * limit.perSecond);
  b.updated = now;

  if (b.tokens < 1) {
    perSocket.set(event, b);
    return false;
  }
  b.tokens -= 1;
  perSocket.set(event, b);
  return true;
}

export function forgetSocket(socketId: string): void {
  buckets.delete(socketId);
}
