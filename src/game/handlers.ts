import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import {
  DRAW_TIMES,
  MAX_POINTS_PER_STROKE,
  WORD_PACKS,
  type WordPackId,
  type ChatMessage,
  type ClientToServerEvents,
  type Failure,
  type ServerToClientEvents,
} from '../contract/index.js';
import {
  appendPoints,
  assertMayDraw,
  clearStrokes,
  parsePoints,
  parseStroke,
  startStroke,
  undoStroke,
} from './drawing.js';
import { allow, forgetSocket } from './limits.js';
import type { RoundEngine } from './round.js';
import { StoreError, store } from './store.js';
import type { PlayerRecord, Room } from './types.js';
import { parseCustomWords, reportWord } from './words.js';

type IO = Server<ClientToServerEvents, ServerToClientEvents>;
type Sock = Socket<ClientToServerEvents, ServerToClientEvents>;

const Name = z.string().trim().min(1, 'Name required').max(20);
const Avatar = z.number().int().min(0).max(11);
const Code = z.string().trim().toUpperCase().min(4).max(6);
/** Optional and untrusted: only ever compared for equality, never shown. */
const DeviceId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional().catch(undefined);

const PACK_IDS = WORD_PACKS.map((p) => p.id) as [WordPackId, ...WordPackId[]];
const SettingsPatch = z
  .object({
    rounds: z.number().int().min(1).max(10),
    drawSeconds: z.number().int().refine((n) => DRAW_TIMES.includes(n), 'Pick one of the listed draw times'),
    selectSeconds: z.number().int().min(5).max(60),
    maxPlayers: z.number().int().min(2).max(16),
    allowCustomWords: z.boolean(),
    wordPacks: z.array(z.enum(PACK_IDS)).max(PACK_IDS.length).transform((a) => [...new Set(a)]),
    difficulty: z.enum(['easy', 'mixed', 'hard']),
    wordChoices: z.number().int().min(1).max(5),
    hints: z.number().int().min(0).max(5),
    customWordsOnly: z.boolean(),
  })
  .partial()
  .strict();

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

/**
 * `room:state` carries `you`, so it can never be a room-wide broadcast: sent
 * that way, every recipient was told it was whoever triggered the change — the
 * host, after any settings edit — and every guest's client then believed it was
 * the host for the rest of the game. Each seat gets its own copy instead.
 */
export function emitStateToEach(io: IO, room: Room): void {
  const players = store.publicPlayers(room);
  for (const p of room.players.values()) {
    if (!p.socketId) continue;
    io.sockets.sockets.get(p.socketId)?.emit('room:state', {
      roomCode: room.code,
      players,
      settings: room.settings,
      round: room.round,
      you: { playerId: p.id },
      ...(p.id === room.hostId ? { hostWords: room.customWords } : {}),
    });
  }
}

export function registerHandlers(io: IO, socket: Sock, engine: RoundEngine): void {
  const ip = (socket.data as { ip?: string }).ip ?? socket.handshake.address;

  /** Full snapshot to one socket; everyone else just needs the roster. */
  const sendState = (room: Room, player: PlayerRecord) => {
    socket.emit('room:state', {
      roomCode: room.code,
      players: store.publicPlayers(room),
      settings: room.settings,
      round: room.round,
      you: { playerId: player.id },
      // The custom list goes to the host alone: anyone else would be
      // reading the answers.
      ...(player.id === room.hostId ? { hostWords: room.customWords } : {}),
    });
  };
  const broadcastPlayers = (room: Room) => {
    io.to(room.code).emit('room:players', { players: store.publicPlayers(room) });
  };
  const toast = (e: unknown) => {
    const f = toFailure(e);
    socket.emit('error:toast', { code: f.code, message: f.message });
  };

  /**
   * One socket, one seat. Entering a second room without leaving the first
   * used to keep the socket subscribed to both, so it received — and applied —
   * the old room's strokes and ticks, which carry no room code.
   */
  const leaveCurrent = () => {
    const prev = store.disconnect(socket.id, true);
    if (!prev) return;
    void socket.leave(prev.room.code);
    broadcastPlayers(prev.room);
    engine.playerLeft(prev.room);
  };

  socket.on('room:create', (payload, ack) => {
    try {
      if (!allow(socket.id, 'room:create', ip)) {
        ack(fail('RATE_LIMITED', 'Too many rooms, too fast'));
        return;
      }
      const name = Name.parse(payload?.name);
      const avatar = Avatar.parse(payload?.avatar);
      const deviceId = DeviceId.parse(payload?.deviceId) ?? null;
      leaveCurrent();
      const { room, player } = store.create(name, avatar, socket.id, deviceId);
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
      if (!allow(socket.id, 'room:join', ip)) {
        ack(fail('RATE_LIMITED', 'Too many attempts — wait a moment'));
        return;
      }
      const code = Code.parse(payload?.roomCode);
      const name = Name.parse(payload?.name);
      const avatar = Avatar.parse(payload?.avatar);
      const deviceId = DeviceId.parse(payload?.deviceId) ?? null;
      const current = store.seatOf(socket.id);
      if (current && current.room.code !== code) leaveCurrent();
      const { room, player } = store.join(code, name, avatar, socket.id, deviceId);
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

  /** Invite pages ask what a code points at before showing a join button. */
  socket.on('room:peek', (payload, ack) => {
    try {
      // Shares the join budget: peeking is the cheap way to probe codes.
      if (!allow(socket.id, 'room:join', ip)) {
        ack(fail('RATE_LIMITED', 'Too many attempts — wait a moment'));
        return;
      }
      const code = Code.parse(payload?.roomCode);
      ack({ ok: true, ...store.preview(code) });
    } catch (e) {
      ack(toFailure(e));
    }
  });

  socket.on('player:update', (payload, ack) => {
    try {
      if (!allow(socket.id, 'player:update')) {
        ack(fail('RATE_LIMITED', 'Slow down a moment'));
        return;
      }
      const patch = z
        .object({ name: Name.optional(), avatar: Avatar.optional() })
        .parse(payload ?? {});
      const { room, player } = seatOf(socket);
      const before = player.name;
      store.updatePlayer(room, player, patch);
      ack({ ok: true });
      broadcastPlayers(room);
      if (player.name !== before) {
        io.to(room.code).emit('chat:message', systemMessage(`${before} is now ${player.name}`));
      }
    } catch (e) {
      ack(toFailure(e));
    }
  });

  /** Refresh survival: the token identifies the seat, the socket is disposable. */
  socket.on('room:resume', (payload, ack) => {
    try {
      if (!allow(socket.id, 'room:resume', ip)) {
        ack(fail('RATE_LIMITED', 'Too many attempts — wait a moment'));
        return;
      }
      const code = Code.parse(payload?.roomCode);
      const token = z.string().min(8).max(64).parse(payload?.token);
      const takeover = z.boolean().optional().parse(payload?.takeover) ?? true;
      const current = store.seatOf(socket.id);
      if (current && current.room.code !== code) leaveCurrent();
      const { room, player } = store.resume(code, token, socket.id, takeover);
      void socket.join(room.code);
      ack({ ok: true, playerId: player.id });
      sendState(room, player);
      broadcastPlayers(room);
      // Always the authoritative drawing, even when it is empty: whatever the
      // client drew while offline was never seen here, and a canvas cleared
      // during the drop must come back cleared.
      socket.emit('draw:sync', { strokes: room.strokes });
      // ...and a returning drawer needs the word or the choices back.
      engine.resendTurnContext(room, player);
    } catch (e) {
      ack(toFailure(e));
    }
  });

  socket.on('room:settings', (payload, ack) => {
    try {
      if (!allow(socket.id, 'room:settings')) {
        ack(fail('RATE_LIMITED', 'Slow down a moment'));
        return;
      }
      const patch = SettingsPatch.parse(payload ?? {});
      const { room, player } = seatOf(socket);
      store.updateSettings(room, player.id, patch);
      ack({ ok: true });
      emitStateToEach(io, room);
    } catch (e) {
      ack(toFailure(e));
    }
  });

  socket.on('room:customWords', (payload, ack) => {
    try {
      if (!allow(socket.id, 'room:settings')) {
        ack(fail('RATE_LIMITED', 'Slow down a moment'));
        return;
      }
      const text = z.string().max(20_000).parse(payload?.text ?? '');
      const { room, player } = seatOf(socket);
      if (room.hostId !== player.id) {
        throw new StoreError('NOT_HOST', 'Only the host can set custom words');
      }
      if (room.round.phase !== 'lobby' && room.round.phase !== 'finished') {
        throw new StoreError('BAD_PHASE', 'Custom words are locked once the game starts');
      }
      const { words, rejected } = parseCustomWords(text);
      store.setCustomWords(room, words);
      ack({ ok: true, accepted: words.length, rejected });
      emitStateToEach(io, room);
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

  socket.on('room:restart', (_payload, ack) => {
    try {
      const { room, player } = seatOf(socket);
      if (room.hostId !== player.id) {
        throw new StoreError('NOT_HOST', 'Only the host can restart the game');
      }
      if (room.round.phase === 'lobby') {
        throw new StoreError('BAD_PHASE', 'The game has not started yet');
      }
      const midGame = room.round.phase !== 'finished';
      engine.reset(room);
      ack({ ok: true });
      io.to(room.code).emit(
        'chat:message',
        systemMessage(midGame ? `${player.name} restarted the game` : `${player.name} is setting up another game`),
      );
    } catch (e) {
      ack(toFailure(e));
    }
  });

  /* ------------------------------------------------------- word choice */

  socket.on('word:choose', (payload, ack) => {
    try {
      const { room, player } = seatOf(socket);
      // Dictionary words have positive ids; the host's custom words negative.
      const wordId = z.number().int().refine((n) => n !== 0, 'Unknown word').parse(payload?.wordId);
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
      engine.custom(room, player, text);
      ack({ ok: true });
    } catch (e) {
      ack(toFailure(e));
    }
  });

  /** One report per player per turn, for dictionary and custom words alike. */
  socket.on('word:report', (payload, ack) => {
    try {
      if (!allow(socket.id, 'word:report')) {
        ack(fail('RATE_LIMITED', 'Slow down a moment'));
        return;
      }
      const { room, player } = seatOf(socket);
      z.string().max(200).parse(payload?.reason ?? '');
      if (room.active && !room.reportedBy.has(player.id)) {
        room.reportedBy.add(player.id);
        reportWord(room.active);
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
      toast(e);
    }
  });

  socket.on('draw:react', (payload) => {
    try {
      if (!allow(socket.id, 'draw:react')) return;
      const reaction = z.enum(['up', 'down']).parse(payload?.reaction);
      const { room, player } = seatOf(socket);
      engine.react(room, player, reaction);
    } catch (e) {
      toast(e);
    }
  });

  /* ------------------------------------------------------------ drawing */

  socket.on('draw:stroke', (payload) => {
    try {
      if (!allow(socket.id, 'draw:stroke')) return;
      const { room, player } = seatOf(socket);
      assertMayDraw(room, player);
      const stroke = parseStroke(payload?.stroke);
      // Trust the seat, not the claim: a client could assert any drawerId.
      stroke.drawerId = player.id;
      startStroke(room, stroke);
      socket.to(room.code).emit('draw:stroke', { stroke });
    } catch (e) {
      toast(e);
    }
  });

  /**
   * The hot path: a live drag sends only its new points every ~40 ms. Relayed
   * as-is, so the cost per message is independent of how long the stroke is.
   */
  socket.on('draw:points', (payload) => {
    try {
      if (!allow(socket.id, 'draw:points')) return;
      const { room, player } = seatOf(socket);
      assertMayDraw(room, player);
      const id = z.string().min(1).max(40).parse(payload?.id);
      const points = parsePoints(payload?.points, MAX_POINTS_PER_STROKE);
      appendPoints(room, player.id, id, points);
      socket.to(room.code).emit('draw:points', { strokeId: id, points });
    } catch (e) {
      toast(e);
    }
  });

  socket.on('draw:undo', () => {
    try {
      if (!allow(socket.id, 'draw:undo')) return;
      const { room, player } = seatOf(socket);
      assertMayDraw(room, player);
      const strokeId = undoStroke(room, player.id);
      if (strokeId) io.to(room.code).emit('draw:undo', { strokeId });
    } catch (e) {
      toast(e);
    }
  });

  socket.on('draw:clear', () => {
    try {
      if (!allow(socket.id, 'draw:clear')) return;
      const { room, player } = seatOf(socket);
      assertMayDraw(room, player);
      clearStrokes(room);
      io.to(room.code).emit('draw:clear', {});
    } catch (e) {
      toast(e);
    }
  });

  /**
   * A browser-side failure, logged and nothing more. The server cannot see one
   * otherwise: a connection that never establishes leaves the backend log
   * perfectly clean while every player stares at a broken page.
   */
  socket.on('client:error', (payload) => {
    try {
      if (!allow(socket.id, 'client:error')) return;
      const body = ClientError.parse(payload);
      const seat = store.seatOf(socket.id);
      const who = seat ? `${seat.player.name}@${seat.room.code}` : 'unseated';
      console.warn(`[client] ${body.source} from ${who}: ${body.message}`);
    } catch {
      /* a broken error report must not become a second error */
    }
  });

  socket.on('disconnect', (reason) => {
    forgetSocket(socket.id);
    // The client calling disconnect() is the Leave button; anything else (a
    // refresh, a dropped connection) may come straight back.
    const res = store.disconnect(socket.id, reason === 'client namespace disconnect');
    if (!res) return;
    const { room, player } = res;
    broadcastPlayers(room);
    io.to(room.code).emit('chat:message', systemMessage(`${player.name} disconnected`));
    engine.playerLeft(room);
    console.log(`[io] ${player.name} left ${room.code} (${reason})`);
  });
}

/** Resolves the socket back to its seat in O(1), or fails loudly. */
function seatOf(socket: Sock): { room: Room; player: PlayerRecord } {
  const seat = store.seatOf(socket.id);
  if (!seat) throw new StoreError('ROOM_NOT_FOUND', 'You are not in a room');
  return seat;
}
