import { z } from 'zod';
import type { Stroke } from '../contract/index.js';
import type { PlayerRecord, Room } from './types.js';
import { StoreError } from './store.js';

/**
 * Coordinates are normalized 0..1 rather than pixels, and `size` is a fraction
 * of canvas width. Clients render at whatever resolution they have, so a
 * drawing made on a 27" monitor arrives intact on a laptop.
 */
/** One continuous drag. Beyond this the client should start a new stroke. */
const MAX_POINTS = 1200;

export const StrokeSchema = z.object({
  id: z.string().min(1).max(40),
  drawerId: z.string().min(1).max(40),
  tool: z.enum(['brush', 'eraser', 'fill']),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be #rrggbb'),
  size: z.number().min(0.001).max(0.2),
  points: z
    .array(z.object({ x: z.number().min(-0.1).max(1.1), y: z.number().min(-0.1).max(1.1) }))
    .min(1)
    .max(MAX_POINTS),
});

/** Memory guard: a full round of frantic scribbling is well under this. */
export const MAX_STROKES_PER_ROOM = 3000;

/**
 * During a round only the drawer may draw. In the lobby anyone may — it makes
 * the canvas usable while waiting, and gives the drawing stack something to
 * exercise before the round machine exists.
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

/**
 * Upsert by stroke id, not append.
 *
 * A drag streams to the server repeatedly as it grows, under one stable id, so
 * watchers see it develop live instead of only on pointer-up. Replacing by id
 * keeps one drag as one entry in the log, which is what makes undo remove a
 * whole stroke rather than the last 60ms of it.
 *
 * Cost: the full point array is resent each tick. Strokes are short enough
 * that this is cheap; if it ever bites, add an append-only delta event.
 */
export function upsertStroke(room: Room, stroke: Stroke): void {
  const at = room.strokes.findIndex((s) => s.id === stroke.id);
  if (at >= 0) {
    if (room.strokes[at]!.drawerId !== stroke.drawerId) {
      throw new StoreError('INVALID', 'That stroke belongs to someone else');
    }
    room.strokes[at] = stroke;
    room.lastActivity = Date.now();
    return;
  }
  if (room.strokes.length >= MAX_STROKES_PER_ROOM) {
    throw new StoreError('RATE_LIMITED', 'Too many strokes this round');
  }
  room.strokes.push(stroke);
  room.lastActivity = Date.now();
}

/** Undo removes the caller's own last stroke — not whatever happened to be last. */
export function undoStroke(room: Room, playerId: string): string | null {
  for (let i = room.strokes.length - 1; i >= 0; i--) {
    if (room.strokes[i]!.drawerId === playerId) {
      const [removed] = room.strokes.splice(i, 1);
      room.lastActivity = Date.now();
      return removed!.id;
    }
  }
  return null;
}

export function clearStrokes(room: Room): void {
  room.strokes = [];
  room.lastActivity = Date.now();
}
