import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import {
  shardOf,
  DRAW_TIMES,
  MAX_PLAYERS,
  MAX_POINTS_PER_STROKE,
  MAX_TEAMS,
  MIN_PLAYERS,
  MIN_TEAMS,
  TEAMS,
  TEAM_NAME_MAX,
  WORD_PACKS,
  type WordPackId,
  type ChatMessage,
  type ClientToServerEvents,
  type Failure,
  type ServerToClientEvents,
  type TeamId,
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
import { MAX_ROUNDS, StoreError, store, tidyTeamName } from './store.js';
import type { PlayerRecord, Room } from './types.js';
import { isBlocked, parseCustomWords, reportWord } from './words.js';
import { recordNetReport } from './netStats.js';
import { SHARD, SHARDS } from '../shard.js';

type IO = Server<ClientToServerEvents, ServerToClientEvents>;
type Sock = Socket<ClientToServerEvents, ServerToClientEvents>;

const Name = z.string().trim().min(1, 'Name required').max(20);
const Avatar = z.number().int().min(0).max(11);
const Code = z.string().trim().toUpperCase().min(4).max(6);

/**
 * A room code this process owns, or WRONG_SHARD: another process has (or would
 * have) that room. "Not found" would be a lie the browser could not recover
 * from; this tells it to reconnect to the right process.
 */
function ownedCode(raw: unknown): string {
  const code = Code.parse(raw);
  if (shardOf(code, SHARDS) !== SHARD) {
    throw new StoreError('WRONG_SHARD', 'That room is on another game server — reconnecting to it');
  }
  return code;
}
/** Optional and untrusted: only ever compared for equality, never shown. */
const DeviceId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional().catch(undefined);

const PACK_IDS = WORD_PACKS.map((p) => p.id) as [WordPackId, ...WordPackId[]];
const SettingsPatch = z
  .object({
    rounds: z.number().int().min(1).max(MAX_ROUNDS),
    drawSeconds: z.number().int().refine((n) => DRAW_TIMES.includes(n), 'Pick one of the listed draw times'),
    selectSeconds: z.number().int().min(5).max(60),
    maxPlayers: z.number().int().min(MIN_PLAYERS).max(MAX_PLAYERS),
    allowCustomWords: z.boolean(),
    wordPacks: z.array(z.enum(PACK_IDS)).max(PACK_IDS.length).transform((a) => [...new Set(a)]),
    difficulty: z.enum(['easy', 'mixed', 'hard']),
    wordChoices: z.number().int().min(1).max(5),
    hints: z.number().int().min(0).max(5),
    customWordsOnly: z.boolean(),
    mode: z.enum(['classic', 'teams']),
    teamCount: z.number().int().min(MIN_TEAMS).max(MAX_TEAMS),
  })
  .partial()
  .strict();

const TeamIdField = z.enum(TEAMS.map((t) => t.id) as [TeamId, ...TeamId[]]);
const teamNameTooLong = `Team names can be up to ${TEAM_NAME_MAX} characters`;
/**
 * A team name, checked like a player's once tidied, so the limit counts what
 * shows; empty asks for the team's default back. The first limit only spares
 * the server tidying a huge payload.
 */
const TeamName = z
  .string()
  .max(TEAM_NAME_MAX * 10, teamNameTooLong)
  .transform(tidyTeamName)
  .pipe(z.string().max(TEAM_NAME_MAX, teamNameTooLong));

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
  const teams = store.publicTeams(room);
  for (const p of room.players.values()) {
    if (!p.socketId) continue;
    io.sockets.sockets.get(p.socketId)?.emit('room:state', {
      roomCode: room.code,
      players,
      settings: room.settings,
      round: room.round,
      teams,
      you: { playerId: p.id },
      ...(p.id === room.hostId ? { hostWords: room.customWords } : {}),
    });
  }
}

/**
 * Takes a player out for good: the seat goes, the browser is barred from
 * rejoining, and the round re-checks itself — a kicked drawer ends the turn.
 */
function kickOut(
  io: IO,
  engine: RoundEngine,
  room: Room,
  target: PlayerRecord,
  by: 'host' | 'vote',
): void {
  const socketId = store.removePlayer(room, target);
  const sock = socketId ? io.sockets.sockets.get(socketId) : undefined;
  if (sock) {
    sock.emit('room:kicked', { roomCode: room.code, by });
    void sock.leave(room.code);
  }
  io.to(room.code).emit(
    'chat:message',
    systemMessage(by === 'host' ? `${target.name} was kicked by the host` : `${target.name} was voted out`),
  );
  // Full state, not just the roster: kicking the host hands the role on, and
  // rounds that follow the room may change.
  store.followRoom(room);
  emitStateToEach(io, room);
  engine.playerLeft(room, 0);
  console.log(`[io] ${target.name} kicked from ${room.code} (${by})`);
}

/** A departure lowers the bar: anyone who now has a majority against them goes. */
export function applyDecidedKicks(io: IO, engine: RoundEngine, room: Room): void {
  for (const target of store.decidedKicks(room)) kickOut(io, engine, room, target, 'vote');
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
      teams: store.publicTeams(room),
      you: { playerId: player.id },
      // The custom list goes to the host alone: anyone else would be
      // reading the answers.
      ...(player.id === room.hostId ? { hostWords: room.customWords } : {}),
    });
  };
  /**
   * A finished game's results stay up until the host moves on, but its final
   * scores and summary went out once, when it ended. Anyone arriving since (a
   * refresh, a late invite) gets them straight after the room state, so the
   * results screen has them when it opens. The same goes for the final
   * scoreboard: its round state looks like any other scoreboard's, and only
   * these scores say it is the last.
   */
  const sendResults = (room: Room) => {
    const { phase } = room.round;
    if (phase !== 'finished' && !(phase === 'scoreboard' && room.finalScoreboard)) return;
    socket.emit('game:scores', { players: store.publicPlayers(room), final: true });
    // Only once the game has finished: it is built then.
    if (room.summary) socket.emit('game:summary', room.summary);
  };
  /**
   * The roster, to everyone. Rounds that follow the room may change with it
   * (see RoomStore.followRoom): then the whole state goes out too, as for a
   * settings change.
   */
  const broadcastPlayers = (room: Room) => {
    io.to(room.code).emit('room:players', { players: store.publicPlayers(room) });
    if (store.followRoom(room)) emitStateToEach(io, room);
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
    applyDecidedKicks(io, engine, prev.room);
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
      const code = ownedCode(payload?.roomCode);
      const name = Name.parse(payload?.name);
      const avatar = Avatar.parse(payload?.avatar);
      const deviceId = DeviceId.parse(payload?.deviceId) ?? null;
      const current = store.seatOf(socket.id);
      if (current && current.room.code !== code) leaveCurrent();
      const { room, player } = store.join(code, name, avatar, socket.id, deviceId);
      void socket.join(room.code);
      ack({ ok: true, token: player.token });
      sendState(room, player);
      sendResults(room);
      broadcastPlayers(room);
      if (room.strokes.length) socket.emit('draw:sync', { strokes: room.strokes });
      // As on a resume: a seat reclaimed without its token may be the drawer's,
      // and a newcomer may land on a team that watches knowing the word.
      engine.resendTurnContext(room, player);
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
      const code = ownedCode(payload?.roomCode);
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

  socket.on('player:kick', (payload, ack) => {
    try {
      if (!allow(socket.id, 'player:kick')) {
        ack(fail('RATE_LIMITED', 'Slow down a moment'));
        return;
      }
      const targetId = z.string().min(1).max(40).parse(payload?.playerId);
      const { room, player } = seatOf(socket);
      const res = store.kickRequest(room, player, targetId);
      ack({ ok: true, kicked: res.kicked, votes: res.votes, needed: res.needed });
      if (res.kicked) {
        kickOut(io, engine, room, res.target, res.by);
        return;
      }
      broadcastPlayers(room);
      const voted = room.kickVotes.get(targetId)?.has(player.id);
      const line = voted
        ? `${player.name} voted to kick ${res.target.name} (${res.votes}/${res.needed})`
        : `${player.name} took back their vote to kick ${res.target.name} (${res.votes}/${res.needed})`;
      io.to(room.code).emit(
        'chat:message',
        systemMessage(res.teamNeeded ? `${line}. It needs a vote from ${res.teamNeeded} too.` : line),
      );
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
      const code = ownedCode(payload?.roomCode);
      const token = z.string().min(8).max(64).parse(payload?.token);
      const takeover = z.boolean().optional().parse(payload?.takeover) ?? true;
      const current = store.seatOf(socket.id);
      if (current && current.room.code !== code) leaveCurrent();
      const { room, player } = store.resume(code, token, socket.id, takeover);
      void socket.join(room.code);
      ack({ ok: true, playerId: player.id });
      sendState(room, player);
      sendResults(room);
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
      // Back in the lobby, rounds that follow the room catch up with whoever
      // came and went during the game.
      if (store.followRoom(room)) emitStateToEach(io, room);
      io.to(room.code).emit(
        'chat:message',
        systemMessage(midGame ? `${player.name} restarted the game` : `${player.name} is setting up another game`),
      );
    } catch (e) {
      ack(toFailure(e));
    }
  });

  /* -------------------------------------------------------------- teams */

  socket.on('team:join', (payload, ack) => {
    try {
      // Every move re-sends the roster to the whole room.
      if (!allow(socket.id, 'team:join')) {
        ack(fail('RATE_LIMITED', 'Slow down a moment'));
        return;
      }
      const teamId = TeamIdField.parse(payload?.teamId);
      const { room, player } = seatOf(socket);
      const moved = store.joinTeam(room, player, teamId);
      ack({ ok: true });
      if (moved) broadcastPlayers(room);
    } catch (e) {
      ack(toFailure(e));
    }
  });

  socket.on('team:shuffle', (_payload, ack) => {
    try {
      if (!allow(socket.id, 'team:shuffle')) {
        ack(fail('RATE_LIMITED', 'Slow down a moment'));
        return;
      }
      const { room, player } = seatOf(socket);
      store.shuffleTeams(room, player.id);
      ack({ ok: true });
      broadcastPlayers(room);
      io.to(room.code).emit('chat:message', systemMessage(`${player.name} shuffled the teams`));
    } catch (e) {
      ack(toFailure(e));
    }
  });

  socket.on('team:rename', (payload, ack) => {
    try {
      if (!allow(socket.id, 'team:rename')) {
        ack(fail('RATE_LIMITED', 'Slow down a moment'));
        return;
      }
      const teamId = TeamIdField.parse(payload?.teamId);
      const name = TeamName.parse(payload?.name ?? '');
      const { room, player } = seatOf(socket);
      // Whether you may at all, before what you typed.
      store.assertCanRenameTeam(room, player, teamId);
      // A team's name is up on every screen: the filter for words applies.
      if (name && isBlocked(name)) throw new StoreError('WORD_BLOCKED', "That name isn't allowed");
      const renamed = store.renameTeam(room, player, teamId, name);
      ack({ ok: true });
      if (!renamed) return;
      io.to(room.code).emit('room:teams', { teams: store.publicTeams(room) });
      io.to(room.code).emit(
        'chat:message',
        systemMessage(`${player.name} renamed ${renamed.from} to ${renamed.to}`),
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
      // To the whole room, the drawer included (their client ignores its own
      // strokes): a broadcast that excludes the sender cannot use uWS's
      // one-call publish and falls back to a JavaScript send per player.
      io.to(room.code).emit('draw:stroke', { stroke });
    } catch (e) {
      toast(e);
    }
  });

  /**
   * The hot path: a live drag sends only its new points every ~40 ms. Relayed
   * as-is, so the cost per message is independent of how long the stroke is,
   * and to the whole room (see draw:stroke) so it is a single publish.
   */
  socket.on('draw:points', (payload) => {
    try {
      if (!allow(socket.id, 'draw:points')) return;
      const { room, player } = seatOf(socket);
      assertMayDraw(room, player);
      const id = z.string().min(1).max(40).parse(payload?.id);
      const points = parsePoints(payload?.points, MAX_POINTS_PER_STROKE);
      appendPoints(room, player.id, id, points);
      io.to(room.code).emit('draw:points', { strokeId: id, points });
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

  /** Answered at once: the client times the round trip. */
  socket.on('net:ping', (_payload, ack) => {
    if (!allow(socket.id, 'net:ping')) return;
    if (typeof ack === 'function') ack();
  });

  socket.on('net:report', (payload) => {
    if (!allow(socket.id, 'net:report', ip)) return;
    // Players only: reports are kept for weeks, and a seat costs a join
    // (limited per network), where a bare connection costs nothing.
    if (!store.seatOf(socket.id)) return;
    if (payload && typeof payload === 'object') recordNetReport(payload);
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
    applyDecidedKicks(io, engine, room);
    console.log(`[io] ${player.name} left ${room.code} (${reason})`);
  });
}

/** Resolves the socket back to its seat in O(1), or fails loudly. */
function seatOf(socket: Sock): { room: Room; player: PlayerRecord } {
  const seat = store.seatOf(socket.id);
  if (!seat) throw new StoreError('ROOM_NOT_FOUND', 'You are not in a room');
  return seat;
}
