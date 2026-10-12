import {
  DEFAULT_SETTINGS,
  type ErrorCode,
  type Player,
  type RoomSettings,
  type RoundState,
} from '../contract/index.js';
import { playerId as newPlayerId, roomCode, token as newToken } from './codes.js';
import type { PlayerRecord, Room } from './types.js';

export class StoreError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** A disconnected player keeps their lobby seat this long before being dropped. */
const LOBBY_GRACE_MS = 60_000;
/** An entirely empty room is collected after this long. */
const EMPTY_ROOM_MS = 10 * 60_000;

function freshRound(): RoundState {
  return {
    phase: 'lobby',
    round: 0,
    totalRounds: DEFAULT_SETTINGS.rounds,
    drawerId: null,
    maskedWord: null,
    solution: null,
    endsAt: null,
    guessedPlayerIds: [],
  };
}

export class RoomStore {
  private rooms = new Map<string, Room>();
  /** socketId -> (roomCode, playerId), so disconnects resolve in O(1). */
  private bySocket = new Map<string, { code: string; playerId: string }>();

  get(code: string): Room {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) throw new StoreError('ROOM_NOT_FOUND', `No room ${code}`);
    return room;
  }

  create(
    name: string,
    avatar: number,
    socketId: string,
  ): { room: Room; player: PlayerRecord } {
    const code = roomCode((c) => this.rooms.has(c));
    const room: Room = {
      code,
      hostId: '',
      players: new Map(),
      order: [],
      settings: { ...DEFAULT_SETTINGS },
      round: freshRound(),
      strokes: [],
      createdAt: Date.now(),
      lastActivity: Date.now(),
      seq: 0,
      turnIndex: 0,
      drawOrder: [],
      usedWordIds: [],
      active: null,
      offered: [],
      revealed: [],
      customCounts: {},
    };
    this.rooms.set(code, room);
    const player = this.addPlayer(room, name, avatar, socketId);
    room.hostId = player.id;
    player.isHost = true;
    return { room, player };
  }

  join(
    code: string,
    name: string,
    avatar: number,
    socketId: string,
  ): { room: Room; player: PlayerRecord } {
    const room = this.get(code);
    if (room.players.size >= room.settings.maxPlayers) {
      throw new StoreError('ROOM_FULL', 'That room is full');
    }
    const taken = [...room.players.values()].some(
      (p) => p.name.toLowerCase() === name.toLowerCase(),
    );
    if (taken) throw new StoreError('NAME_TAKEN', 'That name is taken in this room');
    const player = this.addPlayer(room, name, avatar, socketId);
    return { room, player };
  }

  private addPlayer(
    room: Room,
    name: string,
    avatar: number,
    socketId: string,
  ): PlayerRecord {
    const id = newPlayerId();
    const player: PlayerRecord = {
      id,
      name,
      avatar,
      score: 0,
      connected: true,
      isHost: false,
      token: newToken(),
      socketId,
      lastSeen: Date.now(),
    };
    room.players.set(id, player);
    room.order.push(id);
    room.lastActivity = Date.now();
    this.bySocket.set(socketId, { code: room.code, playerId: id });
    return player;
  }

  /**
   * Rebind an existing seat to a new socket. This is what makes a page refresh
   * survivable: identity lives in the token, not the socket.
   */
  resume(
    code: string,
    token: string,
    socketId: string,
  ): { room: Room; player: PlayerRecord } {
    const room = this.get(code);
    const player = [...room.players.values()].find((p) => p.token === token);
    if (!player) throw new StoreError('INVALID', 'Unknown session for that room');
    if (player.socketId && player.socketId !== socketId) {
      this.bySocket.delete(player.socketId);
    }
    player.socketId = socketId;
    player.connected = true;
    player.lastSeen = Date.now();
    room.lastActivity = Date.now();
    this.bySocket.set(socketId, { code: room.code, playerId: player.id });
    return { room, player };
  }

  /**
   * Marks the seat disconnected rather than deleting it — the sweep decides
   * whether it is really gone. Returns the room so callers can rebroadcast.
   */
  disconnect(socketId: string): { room: Room; player: PlayerRecord } | null {
    const ref = this.bySocket.get(socketId);
    if (!ref) return null;
    this.bySocket.delete(socketId);
    const room = this.rooms.get(ref.code);
    if (!room) return null;
    const player = room.players.get(ref.playerId);
    if (!player) return null;
    player.connected = false;
    player.socketId = null;
    player.lastSeen = Date.now();
    room.lastActivity = Date.now();
    if (room.hostId === player.id) this.reassignHost(room);
    return { room, player };
  }

  /** Host must be someone actually present, or the room freezes. */
  private reassignHost(room: Room): void {
    const next = room.order
      .map((id) => room.players.get(id))
      .find((p) => p?.connected);
    for (const p of room.players.values()) p.isHost = false;
    if (next) {
      room.hostId = next.id;
      next.isHost = true;
    } else {
      room.hostId = '';
    }
  }

  updateSettings(
    room: Room,
    actorId: string,
    patch: Partial<RoomSettings>,
  ): RoomSettings {
    if (room.hostId !== actorId) {
      throw new StoreError('NOT_HOST', 'Only the host can change settings');
    }
    if (room.round.phase !== 'lobby') {
      throw new StoreError('BAD_PHASE', 'Settings are locked once the game starts');
    }
    room.settings = { ...room.settings, ...patch };
    room.round.totalRounds = room.settings.rounds;
    room.lastActivity = Date.now();
    return room.settings;
  }

  assertCanStart(room: Room, actorId: string): void {
    if (room.hostId !== actorId) {
      throw new StoreError('NOT_HOST', 'Only the host can start the game');
    }
    // 'finished' is allowed so the host can run it back without everyone
    // having to leave and rebuild the room.
    if (room.round.phase !== 'lobby' && room.round.phase !== 'finished') {
      throw new StoreError('BAD_PHASE', 'The game is already running');
    }
    const present = [...room.players.values()].filter((p) => p.connected).length;
    if (present < 2) {
      throw new StoreError('INVALID', 'Need at least 2 players to start');
    }
  }

  publicPlayers(room: Room): Player[] {
    return room.order
      .map((id) => room.players.get(id))
      .filter((p): p is PlayerRecord => Boolean(p))
      .map(({ id, name, avatar, score, connected, isHost }) => ({
        id,
        name,
        avatar,
        score,
        connected,
        isHost,
      }));
  }

  /**
   * Drops abandoned lobby seats and collects dead rooms. Seats are kept for the
   * whole game once it has started — a player who rejoins should find their
   * score intact.
   */
  sweep(now = Date.now()): { droppedPlayers: number; droppedRooms: string[] } {
    let droppedPlayers = 0;
    const droppedRooms: string[] = [];
    for (const [code, room] of this.rooms) {
      if (room.round.phase === 'lobby') {
        for (const [id, p] of room.players) {
          if (!p.connected && now - p.lastSeen > LOBBY_GRACE_MS) {
            room.players.delete(id);
            room.order = room.order.filter((x) => x !== id);
            droppedPlayers++;
            if (room.hostId === id) this.reassignHost(room);
          }
        }
      }
      const anyConnected = [...room.players.values()].some((p) => p.connected);
      if (!anyConnected && now - room.lastActivity > EMPTY_ROOM_MS) {
        this.rooms.delete(code);
        droppedRooms.push(code);
      }
    }
    return { droppedPlayers, droppedRooms };
  }

  get size(): number {
    return this.rooms.size;
  }

  all(): Room[] {
    return [...this.rooms.values()];
  }
}

export const store = new RoomStore();
