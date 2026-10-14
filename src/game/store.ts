import {
  DEFAULT_SETTINGS,
  type ErrorCode,
  type Player,
  type RoomPreview,
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
/**
 * How long a host whose connection dropped keeps the role. A refresh reaches
 * the server as a disconnect, so handing the role over at once meant a host
 * who reloaded the page came back as a guest.
 */
export const HOST_GRACE_MS = 10_000;

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
  /** Pending host hand-offs, one per room, for hosts within their grace. */
  private hostHandoffs = new Map<string, NodeJS.Timeout>();
  /** Called when the host changes outside any client request (grace expiry). */
  onHostChange: ((room: Room) => void) | null = null;

  get(code: string): Room {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) throw new StoreError('ROOM_NOT_FOUND', `No room ${code}`);
    return room;
  }

  /** The seat a socket currently holds, via the socket index. */
  seatOf(socketId: string): { room: Room; player: PlayerRecord } | null {
    const ref = this.bySocket.get(socketId);
    if (!ref) return null;
    const room = this.rooms.get(ref.code);
    const player = room?.players.get(ref.playerId);
    if (!room || !player || player.socketId !== socketId) return null;
    return { room, player };
  }

  create(
    name: string,
    avatar: number,
    socketId: string,
    deviceId: string | null = null,
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
      strokeIndex: new Map(),
      pointCount: 0,
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
      drawerEarned: 0,
      reportedBy: new Set(),
    };
    this.rooms.set(code, room);
    const player = this.addPlayer(room, name, avatar, socketId, deviceId);
    room.hostId = player.id;
    player.isHost = true;
    return { room, player };
  }

  join(
    code: string,
    name: string,
    avatar: number,
    socketId: string,
    deviceId: string | null = null,
  ): { room: Room; player: PlayerRecord } {
    const room = this.get(code);
    const seats = [...room.players.values()];
    const sameName = (p: PlayerRecord) => p.name.toLowerCase() === name.toLowerCase();

    /*
     * Seats are deliberately kept for the whole game so scores survive a drop,
     * which means an abandoned seat holds its name and its place in the count.
     * Someone coming back without their token — cleared storage, another
     * browser, another device — would otherwise be locked out of their own name
     * for the rest of the game, in a room that reports itself full.
     *
     * Treat a name match on a disconnected seat as that player returning and
     * hand the seat back. Knowing the room code and the name is the whole of
     * the check: enough for a party game among people who were invited, and
     * worth stating plainly rather than leaving implied.
     */
    // The device is the stronger signal: it survives a cleared session token
    // and a changed name. Fall back to the name for browsers without one.
    const ghost =
      (deviceId && seats.find((p) => !p.connected && p.deviceId === deviceId)) ||
      seats.find((p) => !p.connected && sameName(p));
    if (ghost) {
      // Coming back under a new name is fine, as long as nobody else holds it.
      if (!sameName(ghost) && seats.some((p) => p !== ghost && sameName(p))) {
        throw new StoreError('NAME_TAKEN', 'That name is taken in this room');
      }
      ghost.name = name;
      ghost.deviceId = deviceId ?? ghost.deviceId;
      if (ghost.socketId) this.bySocket.delete(ghost.socketId);
      ghost.socketId = socketId;
      ghost.connected = true;
      ghost.avatar = avatar;
      ghost.lastSeen = Date.now();
      room.lastActivity = Date.now();
      this.bySocket.set(socketId, { code: room.code, playerId: ghost.id });
      this.claimVacantHost(room, ghost);
      return { room, player: ghost };
    }

    const present = seats.filter((p) => p.connected).length;
    if (present >= room.settings.maxPlayers) {
      throw new StoreError('ROOM_FULL', 'That room is full');
    }
    if (seats.some((p) => p.connected && sameName(p))) {
      throw new StoreError('NAME_TAKEN', 'That name is taken in this room');
    }
    const player = this.addPlayer(room, name, avatar, socketId, deviceId);
    this.claimVacantHost(room, player);
    return { room, player };
  }

  private addPlayer(
    room: Room,
    name: string,
    avatar: number,
    socketId: string,
    deviceId: string | null,
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
      deviceId,
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
    this.claimVacantHost(room, player);
    return { room, player };
  }

  /**
   * Anyone entering a room with no host takes the role — returning or new.
   * A host who is merely disconnected (within their grace) still holds it;
   * when that host is the one coming back, their hand-off is cancelled.
   */
  private claimVacantHost(room: Room, player: PlayerRecord): void {
    if (room.hostId === player.id) {
      this.cancelHandoff(room.code);
      player.isHost = true;
      return;
    }
    if (room.hostId && room.players.has(room.hostId)) return;
    this.setHost(room, player);
  }

  private setHost(room: Room, player: PlayerRecord | null): void {
    for (const p of room.players.values()) p.isHost = false;
    room.hostId = player?.id ?? '';
    if (player) player.isHost = true;
  }

  private cancelHandoff(code: string): void {
    const t = this.hostHandoffs.get(code);
    if (t) clearTimeout(t);
    this.hostHandoffs.delete(code);
  }

  /** After the grace, a host who has not come back passes the role on. */
  private scheduleHandoff(room: Room, hostId: string): void {
    this.cancelHandoff(room.code);
    const t = setTimeout(() => {
      this.hostHandoffs.delete(room.code);
      if (this.rooms.get(room.code) !== room) return; // room was collected
      if (room.hostId !== hostId || room.players.get(hostId)?.connected) return;
      this.reassignHost(room);
      this.onHostChange?.(room);
    }, HOST_GRACE_MS);
    t.unref();
    this.hostHandoffs.set(room.code, t);
  }

  /**
   * Marks the seat disconnected rather than deleting it — the sweep decides
   * whether it is really gone. Returns the room so callers can rebroadcast.
   *
   * `deliberate` is a player choosing to leave (the Leave button, entering
   * another room): the host role passes on at once. Anything else — a refresh,
   * a closed laptop, a wifi drop — gets HOST_GRACE_MS to come back first.
   */
  disconnect(
    socketId: string,
    deliberate = false,
  ): { room: Room; player: PlayerRecord } | null {
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
    if (room.hostId === player.id) {
      if (deliberate) {
        this.cancelHandoff(room.code);
        this.reassignHost(room);
      } else {
        this.scheduleHandoff(room, player.id);
      }
    }
    return { room, player };
  }

  /**
   * Host must be someone actually present, or the room freezes. With nobody
   * present the role is left vacant, for whoever enters next.
   */
  private reassignHost(room: Room): void {
    const next = room.order
      .map((id) => room.players.get(id))
      .find((p) => p?.connected);
    this.setHost(room, next ?? null);
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

  /**
   * Rename or re-avatar yourself. Only between games: mid-game the name is in
   * the chat history and the scoreboard, and changing it would confuse both.
   */
  updatePlayer(room: Room, player: PlayerRecord, patch: { name?: string; avatar?: number }): void {
    if (room.round.phase !== 'lobby' && room.round.phase !== 'finished') {
      throw new StoreError('BAD_PHASE', 'You can change your name before the game starts');
    }
    if (patch.name !== undefined) {
      const lower = patch.name.toLowerCase();
      const clash = [...room.players.values()].some(
        (p) => p !== player && p.name.toLowerCase() === lower,
      );
      if (clash) throw new StoreError('NAME_TAKEN', 'That name is taken in this room');
      player.name = patch.name;
    }
    if (patch.avatar !== undefined) player.avatar = patch.avatar;
    room.lastActivity = Date.now();
  }

  /** What an invite page needs to show, without joining. */
  preview(code: string): RoomPreview {
    const room = this.get(code);
    return {
      roomCode: room.code,
      hostName: room.players.get(room.hostId)?.name ?? null,
      players: [...room.players.values()].filter((p) => p.connected).length,
      maxPlayers: room.settings.maxPlayers,
      phase: room.round.phase,
    };
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
        this.cancelHandoff(code);
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
