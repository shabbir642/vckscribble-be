import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import type {
  ChatMessage,
  ClientToServerEvents,
  Failure,
  ServerToClientEvents,
} from '../contract/index.js';
import {
  StrokeSchema,
  upsertStroke,
  assertMayDraw,
  clearStrokes,
  undoStroke,
} from './drawing.js';
import { StoreError, store } from './store.js';
import type { PlayerRecord, Room } from './types.js';

type IO = Server<ClientToServerEvents, ServerToClientEvents>;
type Sock = Socket<ClientToServerEvents, ServerToClientEvents>;

const Name = z.string().trim().min(1, 'Name required').max(20);
const Avatar = z.number().int().min(0).max(11);
const Code = z.string().trim().toUpperCase().min(4).max(6);

const SettingsPatch = z
  .object({
    rounds: z.number().int().min(1).max(10),
    drawSeconds: z.number().int().min(30).max(180),
    selectSeconds: z.number().int().min(5).max(60),
    maxPlayers: z.number().int().min(2).max(16),
    allowCustomWords: z.boolean(),
  })
  .partial();

function fail(code: Failure['code'], message: string): Failure {
  return { ok: false, code, message };
}

/** Maps thrown StoreErrors and zod issues onto the ack shape the client expects. */
function toFailure(e: unknown): Failure {
  if (e instanceof StoreError) return fail(e.code, e.message);
  if (e instanceof z.ZodError) {
    return fail('INVALID', e.issues[0]?.message ?? 'Invalid input');
  }
  console.error('[io] unhandled', e);
  return fail('INTERNAL', 'Something went wrong');
}

function systemMessage(text: string): ChatMessage {
  return {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    channel: 'system',
    playerId: null,
    playerName: null,
    text,
    at: Date.now(),
  };
}

export function registerHandlers(io: IO, socket: Sock): void {
  /** Full snapshot to one socket; everyone else just needs the roster. */
  const sendState = (room: Room, player: PlayerRecord) => {
    socket.emit('room:state', {
      roomCode: room.code,
      players: store.publicPlayers(room),
      settings: room.settings,
      round: room.round,
      you: { playerId: player.id },
    });
  };
  const broadcastPlayers = (room: Room) => {
    io.to(room.code).emit('room:players', { players: store.publicPlayers(room) });
  };

  socket.on('room:create', (payload, ack) => {
    try {
      const name = Name.parse(payload?.name);
      const avatar = Avatar.parse(payload?.avatar);
      const { room, player } = store.create(name, avatar, socket.id);
      void socket.join(room.code);
      ack({ ok: true, roomCode: room.code, token: player.token });
      sendState(room, player);
      io.to(room.code).emit('chat:message', systemMessage(`${name} created the room`));
    } catch (e) {
      ack(toFailure(e));
    }
  });

  socket.on('room:join', (payload, ack) => {
    try {
      const code = Code.parse(payload?.roomCode);
      const name = Name.parse(payload?.name);
      const avatar = Avatar.parse(payload?.avatar);
      const { room, player } = store.join(code, name, avatar, socket.id);
      void socket.join(room.code);
      ack({ ok: true, token: player.token });
      sendState(room, player);
      broadcastPlayers(room);
      if (room.strokes.length) socket.emit('draw:sync', { strokes: room.strokes });
      io.to(room.code).emit('chat:message', systemMessage(`${name} joined`));
    } catch (e) {
      ack(toFailure(e));
    }
  });

  /** Refresh survival: the token identifies the seat, the socket is disposable. */
  socket.on('room:resume', (payload, ack) => {
    try {
      const code = Code.parse(payload?.roomCode);
      const token = z.string().min(8).parse(payload?.token);
      const { room, player } = store.resume(code, token, socket.id);
      void socket.join(room.code);
      ack({ ok: true, playerId: player.id });
      sendState(room, player);
      broadcastPlayers(room);
      // Mid-round joiners need the drawing so far (M3 fills strokes).
      if (room.strokes.length) {
        socket.emit('draw:sync', { strokes: room.strokes });
      }
    } catch (e) {
      ack(toFailure(e));
    }
  });

  socket.on('room:settings', (payload, ack) => {
    try {
      const patch = SettingsPatch.parse(payload ?? {});
      const { room, player } = seatOf(socket);
      const settings = store.updateSettings(room, player.id, patch);
      ack({ ok: true });
      io.to(room.code).emit('room:state', {
        roomCode: room.code,
        players: store.publicPlayers(room),
        settings,
        round: room.round,
        you: { playerId: player.id },
      });
    } catch (e) {
      ack(toFailure(e));
    }
  });

  socket.on('room:start', (_payload, ack) => {
    try {
      const { room, player } = seatOf(socket);
      store.assertCanStart(room, player.id);
      ack({ ok: true });
      // The round state machine is M4. Validation is real; the loop is not yet.
      io.to(room.code).emit(
        'chat:message',
        systemMessage('Ready to start — the round loop arrives in M4.'),
      );
    } catch (e) {
      ack(toFailure(e));
    }
  });

  /* ------------------------------------------------------------ drawing */

  socket.on('draw:stroke', (payload) => {
    try {
      const { room, player } = seatOf(socket);
      assertMayDraw(room, player);
      const stroke = StrokeSchema.parse(payload?.stroke);
      // Trust the seat, not the claim: a client could assert any drawerId.
      stroke.drawerId = player.id;
      upsertStroke(room, stroke);
      socket.to(room.code).emit('draw:stroke', { stroke });
    } catch (e) {
      const f = toFailure(e);
      socket.emit('error:toast', { code: f.code, message: f.message });
    }
  });

  socket.on('draw:undo', () => {
    try {
      const { room, player } = seatOf(socket);
      assertMayDraw(room, player);
      const strokeId = undoStroke(room, player.id);
      if (strokeId) io.to(room.code).emit('draw:undo', { strokeId });
    } catch (e) {
      const f = toFailure(e);
      socket.emit('error:toast', { code: f.code, message: f.message });
    }
  });

  socket.on('draw:clear', () => {
    try {
      const { room, player } = seatOf(socket);
      assertMayDraw(room, player);
      clearStrokes(room);
      io.to(room.code).emit('draw:clear', {});
    } catch (e) {
      const f = toFailure(e);
      socket.emit('error:toast', { code: f.code, message: f.message });
    }
  });

  socket.on('disconnect', (reason) => {
    const res = store.disconnect(socket.id);
    if (!res) return;
    const { room, player } = res;
    broadcastPlayers(room);
    io.to(room.code).emit('chat:message', systemMessage(`${player.name} disconnected`));
    console.log(`[io] ${player.name} left ${room.code} (${reason})`);
  });
}

/** Resolves the socket back to its seat, or fails loudly. */
function seatOf(socket: Sock): { room: Room; player: PlayerRecord } {
  for (const code of socket.rooms) {
    if (code === socket.id) continue;
    try {
      const room = store.get(code);
      const player = [...room.players.values()].find(
        (p) => p.socketId === socket.id,
      );
      if (player) return { room, player };
    } catch {
      /* not a game room */
    }
  }
  throw new StoreError('ROOM_NOT_FOUND', 'You are not in a room');
}
