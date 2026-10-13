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
import { allow, forgetSocket } from './limits.js';
import { track } from '../obs/events.js';
import type { RoundEngine } from './round.js';
import { StoreError, store } from './store.js';
import type { PlayerRecord, Room } from './types.js';
import { reportSuggestion } from './words.js';

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

const ClientError = z.object({
  source: z.enum(['render', 'window', 'promise', 'socket']),
  message: z.string().min(1).max(500),
  detail: z.string().max(2000).optional(),
  url: z.string().max(500).optional(),
});

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

export function registerHandlers(io: IO, socket: Sock, engine: RoundEngine): void {
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
      if (!allow(socket.id, 'room:create')) {
        ack(fail('RATE_LIMITED', 'Too many rooms, too fast'));
        return;
      }
      const name = Name.parse(payload?.name);
      const avatar = Avatar.parse(payload?.avatar);
      const { room, player } = store.create(name, avatar, socket.id);
      void socket.join(room.code);
      ack({ ok: true, roomCode: room.code, token: player.token });
      sendState(room, player);
      track('room_created', { roomCode: room.code, playerId: player.id, playerName: name });
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
      const before = (() => {
        try {
          return store.get(code).players.size;
        } catch {
          return -1;
        }
      })();
      const { room, player } = store.join(code, name, avatar, socket.id);
      const reclaimed = room.players.size === before;
      void socket.join(room.code);
      ack({ ok: true, token: player.token });
      sendState(room, player);
      broadcastPlayers(room);
      if (room.strokes.length) socket.emit('draw:sync', { strokes: room.strokes });
      // A reclaimed seat means someone came back without their token. A spike
      // here is a sign the session is being lost, not that people are leaving.
      track(reclaimed ? 'player_reclaimed_seat' : 'player_joined', {
        roomCode: room.code,
        playerId: player.id,
        playerName: name,
        data: { phase: room.round.phase, players: room.players.size },
      });
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
      // ...and a returning drawer needs the word or the choices back.
      engine.resendTurnContext(room, player);
      track('player_reconnected', {
        roomCode: room.code,
        playerId: player.id,
        playerName: player.name,
        data: { phase: room.round.phase, wasDrawer: room.round.drawerId === player.id },
      });
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
      io.to(room.code).emit('chat:message', systemMessage('Game starting…'));
      engine.startGame(room);
    } catch (e) {
      ack(toFailure(e));
    }
  });

  /* ------------------------------------------------------- word choice */

  socket.on('word:choose', (payload, ack) => {
    try {
      const { room, player } = seatOf(socket);
      const wordId = z.number().int().positive().parse(payload?.wordId);
      engine.choose(room, player, wordId);
      ack({ ok: true });
    } catch (e) {
      ack(toFailure(e));
    }
  });

  /** Requirement 1: drawer writes their own word. Validated synchronously —
   *  the round starts immediately, so there is no review window. */
  socket.on('word:custom', (payload, ack) => {
    try {
      if (!allow(socket.id, 'word:custom')) {
        ack(fail('RATE_LIMITED', 'Slow down a moment'));
        return;
      }
      const { room, player } = seatOf(socket);
      const text = z.string().min(1).max(60).parse(payload?.text);
      try {
        engine.custom(room, player, text);
      } catch (e) {
        // Rejections are the interesting half: they are the filter getting in
        // someone's way, which is invisible from the accepted ones alone.
        track('custom_word', {
          roomCode: room.code,
          playerId: player.id,
          playerName: player.name,
          data: { accepted: false, text, reason: toFailure(e).code },
        });
        throw e;
      }
      track('custom_word', {
        roomCode: room.code,
        playerId: player.id,
        playerName: player.name,
        data: { accepted: true, text },
      });
      ack({ ok: true });
    } catch (e) {
      ack(toFailure(e));
    }
  });

  socket.on('word:report', (payload, ack) => {
    try {
      const { room } = seatOf(socket);
      z.string().max(200).parse(payload?.reason ?? '');
      if (room.active) {
        reportSuggestion(room.active.normalized);
        const { player } = seatOf(socket);
        track('word_reported', {
          roomCode: room.code,
          playerId: player.id,
          playerName: player.name,
          data: {
            word: room.active.text,
            custom: room.active.custom,
            reason: String(payload?.reason ?? ''),
          },
        });
      }
      ack({ ok: true });
    } catch (e) {
      ack(toFailure(e));
    }
  });

  socket.on('chat:guess', (payload) => {
    try {
      if (!allow(socket.id, 'chat:guess')) return;
      const { room, player } = seatOf(socket);
      const text = z.string().min(1).max(120).parse(payload?.text);
      engine.guess(room, player, text);
    } catch (e) {
      const f = toFailure(e);
      socket.emit('error:toast', { code: f.code, message: f.message });
    }
  });

  /* ------------------------------------------------------------ drawing */

  socket.on('draw:stroke', (payload) => {
    try {
      if (!allow(socket.id, 'draw:stroke')) return;
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

  socket.on('client:error', (payload) => {
    try {
      if (!allow(socket.id, 'client:error')) return;
      const body = ClientError.parse(payload);
      let roomCode: string | null = null;
      let player: PlayerRecord | null = null;
      try {
        const seat = seatOf(socket);
        roomCode = seat.room.code;
        player = seat.player;
      } catch {
        /* not seated yet — still worth recording */
      }
      track('client_error', {
        roomCode,
        playerId: player?.id ?? null,
        playerName: player?.name ?? null,
        data: { ...body, via: 'socket' },
      });
    } catch {
      /* a broken error report must not become a second error */
    }
  });

  socket.on('disconnect', (reason) => {
    forgetSocket(socket.id);
    const res = store.disconnect(socket.id);
    if (!res) return;
    const { room, player } = res;
    broadcastPlayers(room);
    io.to(room.code).emit('chat:message', systemMessage(`${player.name} disconnected`));
    engine.playerLeft(room);
    track('player_dropped', {
      roomCode: room.code,
      playerId: player.id,
      playerName: player.name,
      data: { reason, phase: room.round.phase, wasDrawer: room.round.drawerId === player.id },
    });
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
