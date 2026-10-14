import {
  COORD_SCALE,
  MAX_POINTS_PER_ROOM,
  MAX_POINTS_PER_STROKE,
  type Stroke,
  type Tool,
} from '../contract/index.js';
import type { PlayerRecord, Room } from './types.js';
import { StoreError } from './store.js';

/**
 * Coordinates are quantized 0..COORD_SCALE rather than pixels, and `size` is a
 * fraction of canvas width. Clients render at whatever resolution they have, so
 * a drawing made on a 27" monitor arrives intact on a laptop.
 */

/** Memory guard on entry count; MAX_POINTS_PER_ROOM bounds the actual size. */
export const MAX_STROKES_PER_ROOM = 3000;

const TOOLS: ReadonlySet<string> = new Set<Tool>(['brush', 'eraser', 'fill']);
const COLOR = /^#[0-9a-fA-F]{6}$/;
const ID = /^[A-Za-z0-9_-]{1,40}$/;

function invalid(message: string): never {
  throw new StoreError('INVALID', message);
}

/**
 * Hand-rolled rather than zod: this runs for every stroke message in every
 * room, and a schema that allocates a fresh object per point was the single
 * largest CPU cost on the server. A flat loop over integers allocates nothing.
 */
export function parsePoints(raw: unknown, maxPairs: number): number[] {
  if (!Array.isArray(raw)) invalid('points must be an array');
  const n = raw.length;
  if (n === 0 || n % 2 !== 0) invalid('points must be non-empty x,y pairs');
  if (n > maxPairs * 2) invalid(`at most ${maxPairs} points per stroke`);
  for (let i = 0; i < n; i++) {
    const v = raw[i];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > COORD_SCALE) {
      invalid('points must be integers in 0..10000');
    }
  }
  return raw as number[];
}

export function parseStroke(raw: unknown): Stroke {
  if (!raw || typeof raw !== 'object') invalid('stroke required');
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== 'string' || !ID.test(s.id)) invalid('bad stroke id');
  if (typeof s.tool !== 'string' || !TOOLS.has(s.tool)) invalid('bad tool');
  if (typeof s.color !== 'string' || !COLOR.test(s.color)) invalid('color must be #rrggbb');
  if (typeof s.size !== 'number' || !(s.size >= 0.001 && s.size <= 0.2)) invalid('bad size');
  const points = parsePoints(s.points, s.tool === 'fill' ? 1 : MAX_POINTS_PER_STROKE);
  return {
    id: s.id,
    drawerId: '', // filled from the seat by the caller, never from the client
    tool: s.tool as Tool,
    color: s.color,
    size: s.size,
    points,
  };
}

/**
 * During a round only the drawer may draw. In the lobby anyone may — it makes
 * the canvas usable while waiting.
 */
export function assertMayDraw(room: Room, player: PlayerRecord): void {
  if (room.round.phase === 'lobby') return;
  if (room.round.phase !== 'drawing') {
    throw new StoreError('BAD_PHASE', 'Not a drawing phase');
  }
  if (room.round.drawerId !== player.id) {
    throw new StoreError('NOT_DRAWER', 'Only the drawer can draw');
  }
}

function budget(room: Room, addPairs: number): void {
  if (room.pointCount + addPairs > MAX_POINTS_PER_ROOM) {
    throw new StoreError('RATE_LIMITED', 'The canvas is full — clear it to keep drawing');
  }
}

/**
 * Starts a stroke. Re-sending an id you already own replaces it, which keeps a
 * retried start idempotent.
 */
export function startStroke(room: Room, stroke: Stroke): void {
  const existing = room.strokeIndex.get(stroke.id);
  if (existing) {
    if (existing.drawerId !== stroke.drawerId) {
      throw new StoreError('INVALID', 'That stroke belongs to someone else');
    }
    const delta = stroke.points.length / 2 - existing.points.length / 2;
    budget(room, Math.max(0, delta));
    room.pointCount += delta;
    const at = room.strokes.indexOf(existing);
    room.strokes[at] = stroke;
    room.strokeIndex.set(stroke.id, stroke);
  } else {
    if (room.strokes.length >= MAX_STROKES_PER_ROOM) {
      throw new StoreError('RATE_LIMITED', 'Too many strokes this round');
    }
    budget(room, stroke.points.length / 2);
    room.pointCount += stroke.points.length / 2;
    room.strokes.push(stroke);
    room.strokeIndex.set(stroke.id, stroke);
  }
  room.lastActivity = Date.now();
}

/** Appends to one of the caller's own strokes. O(1) via the id index. */
export function appendPoints(
  room: Room,
  playerId: string,
  id: string,
  points: number[],
): Stroke {
  const stroke = room.strokeIndex.get(id);
  if (!stroke || stroke.drawerId !== playerId) invalid('Unknown stroke');
  if (stroke.tool === 'fill') invalid('A fill has a single point');
  const pairs = points.length / 2;
  if (stroke.points.length / 2 + pairs > MAX_POINTS_PER_STROKE) {
    invalid(`at most ${MAX_POINTS_PER_STROKE} points per stroke`);
  }
  budget(room, pairs);
  for (let i = 0; i < points.length; i++) stroke.points.push(points[i]!);
  room.pointCount += pairs;
  room.lastActivity = Date.now();
  return stroke;
}

/** Undo removes the caller's own last stroke — not whatever happened to be last. */
export function undoStroke(room: Room, playerId: string): string | null {
  for (let i = room.strokes.length - 1; i >= 0; i--) {
    const s = room.strokes[i]!;
    if (s.drawerId === playerId) {
      room.strokes.splice(i, 1);
      room.strokeIndex.delete(s.id);
      room.pointCount -= s.points.length / 2;
      room.lastActivity = Date.now();
      return s.id;
    }
  }
  return null;
}

export function clearStrokes(room: Room): void {
  room.strokes = [];
  room.strokeIndex = new Map();
  room.pointCount = 0;
  room.lastActivity = Date.now();
}
