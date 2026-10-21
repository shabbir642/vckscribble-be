import {
  DEFAULT_SETTINGS,
  MAX_TEAMS,
  MIN_CUSTOM_WORDS,
  MIN_PLAYERS_FOR_KICK_VOTE,
  MIN_TEAMS,
  MIN_TEAM_SIZE,
  TEAMS,
  kickVotesNeeded,
  type ErrorCode,
  type Player,
  type RoomPreview,
  type RoomSettings,
  type RoundState,
  type Team,
  type TeamId,
} from '../contract/index.js';
import { playerId as newPlayerId, roomCode, token as newToken } from './codes.js';
import { SHARD, SHARDS } from '../shard.js';
import { newGameId } from './summary.js';
import type { PlayerRecord, Room, TeamState } from './types.js';

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
/** The most rounds a host can set. */
export const MAX_ROUNDS = 10;

/**
 * Turning Teams on picks a team for every 8 players or so: 4 to 8 a team
 * keeps everyone in reach of a guess, where 15 against 15 leaves most of a
 * team watching the fastest typist.
 */
const PLAYERS_PER_TEAM = 8;
/**
 * ...and the rounds that make a game of about this long. A turn in a team game
 * is about 5 s choosing, half the draw time (the first right answer ends it)
 * and the 4 s reveal; each round adds a 5 s scoreboard. This is the lobby's
 * estimate, so the host sees the number it was picked by.
 */
const TEAM_GAME_TARGET_S = 15 * 60;
/** From this many players one round is game enough. */
const ONE_ROUND_FROM = 20;

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
    teamId: null,
    likes: 0,
    dislikes: 0,
  };
}

/* ---------------------------------------------------------------- teams */

/** Every team a room can have, as a new room has them: default names, nobody on them. */
export function freshTeams(): TeamState[] {
  return TEAMS.map((t) => ({ id: t.id, name: t.name, score: 0, rotation: [], drawn: new Set<string>() }));
}

/** The teams in a team game: the first `settings.teamCount`. */
export function gameTeams(room: Room): TeamState[] {
  return room.teams.slice(0, room.settings.teamCount);
}

/** The players on a team who are here right now. */
export function teamHere(room: Room, team: TeamState): PlayerRecord[] {
  return [...room.players.values()].filter((p) => p.connected && p.teamId === team.id);
}

/** A team plays with someone to draw and someone to guess. */
export function canPlay(room: Room, team: TeamState): boolean {
  return teamHere(room, team).length >= MIN_TEAM_SIZE;
}

/**
 * Turns each team gets in a round: one for every player of the largest team
 * here, so everyone draws and the teams draw equally often.
 */
export function teamQuota(room: Room): number {
  return Math.max(1, ...gameTeams(room).map((t) => teamHere(room, t).length));
}

/**
 * Who draws for a team now: the first player here, in rotation order, who has
 * not drawn since the rotation last came round; when everyone here has, it
 * comes round again. Someone away is passed over and keeps their place.
 * Books the turn to them.
 */
export function takeDrawer(room: Room, team: TeamState): PlayerRecord | null {
  const here = team.rotation
    .map((id) => room.players.get(id))
    .filter((p): p is PlayerRecord => Boolean(p?.connected && p.teamId === team.id));
  const first = here[0];
  if (!first) return null;
  let next = here.find((p) => !team.drawn.has(p.id));
  if (!next) {
    team.drawn.clear();
    next = first;
  }
  team.drawn.add(next.id);
  return next;
}

/** Takes a seat out of every team's rotation: it has moved, or gone. */
function leaveTeams(room: Room, id: string): void {
  for (const t of room.teams) {
    if (t.rotation.includes(id)) t.rotation = t.rotation.filter((x) => x !== id);
    t.drawn.delete(id);
  }
}

function shuffled<T>(items: readonly T[]): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** The order seats are dealt in: the players here first, as they make the teams even. */
function byPresence(seats: Iterable<PlayerRecord>): PlayerRecord[] {
  const all = [...seats];
  return [...shuffled(all.filter((p) => p.connected)), ...shuffled(all.filter((p) => !p.connected))];
}

/**
 * Characters that show nothing: control codes (but tabs and line breaks,
 * which show as a space), and those Unicode says to leave out where they
 * can't be shown (zero-width spaces, joiners, direction marks, fillers,
 * variation selectors…).
 */
const HIDDEN = /(?![\t\n\v\f\r])[\p{Cc}\p{Default_Ignorable_Code_Point}]/u;
const SELECTOR = /\p{Variation_Selector}/u;
const JOINER = /[\u200c\u200d]/;
/** A character a selector or joiner can belong to: one that shows, and isn't plain text. */
const glyph = (c: string | undefined) => c !== undefined && !/[\s\0-\x7F]/.test(c) && !HIDDEN.test(c);

/**
 * A team name as it will show. Compatibility forms fold into the plain ones
 * (NFKC: a non-breaking or full-width space is a space, Ｔｅａｍ is Team), what
 * shows nothing goes, spaces collapse to one (the blank braille cell looks
 * like one too) and the ends are trimmed. Otherwise "Team  Grape", or Team
 * Grape with a zero-width space on the end, passed for a name other than
 * Team Grape. A selector or joiner within an emoji or a conjunct stays: it is
 * part of what shows (❤️, 🧑‍💻, ශ්‍රී).
 */
export function tidyTeamName(raw: string): string {
  const chars = [...raw.normalize('NFKC')];
  const out: string[] = [];
  chars.forEach((c, i) => {
    const prev = out.at(-1);
    if (!HIDDEN.test(c)) out.push(c);
    else if (SELECTOR.test(c) ? glyph(prev) : JOINER.test(c) && (glyph(prev) || SELECTOR.test(prev ?? '')) && glyph(chars[i + 1])) {
      out.push(c);
    }
  });
  return out.join('').replace(/[\s\u2800]+/g, ' ').trim();
}

/**
 * How team names compare: as they read, so case and anything that shows
 * nothing aside. An emoji joined up or not, or a letter with a selector after
 * it, would pass for the same name.
 */
export function teamNameKey(name: string): string {
  return [...tidyTeamName(name)].filter((c) => !HIDDEN.test(c)).join('').normalize('NFKC').toLowerCase();
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class RoomStore {
  private rooms = new Map<string, Room>();
  /** socketId -> (roomCode, playerId), so disconnects resolve in O(1). */
  private bySocket = new Map<string, { code: string; playerId: string }>();
  /**
   * Takes back a room restored from a snapshot. Its host gets a longer grace
   * than a refresh would: every client is reconnecting at once.
   */
  adopt(room: Room, hostGraceMs: number): void {
    this.rooms.set(room.code, room);
    if (room.hostId) this.scheduleHandoff(room, room.hostId, hostGraceMs);
  }

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
    const code = roomCode((c) => this.rooms.has(c), SHARD, SHARDS);
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
      reactions: new Map(),
      customWords: [],
      usedCustom: new Set(),
      customOffered: new Map(),
      turnNo: 0,
      drawn: new Set(),
      hintPlan: [],
      finalScoreboard: false,
      kickVotes: new Map(),
      banned: new Set(),
      teams: freshTeams(),
      teamGames: 0,
      teamStart: 0,
      teamQuota: 0,
      autoRounds: false,
      gameId: newGameId(),
      tally: new Map(),
      bestTurns: [],
      summary: null,
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
    if (deviceId && room.banned.has(deviceId)) {
      throw new StoreError('KICKED', 'You were kicked from that room');
    }
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
      // Back on their own team.
      this.ensureTeam(room, ghost);
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
      teamId: null,
      token: newToken(),
      socketId,
      lastSeen: Date.now(),
      deviceId,
      lastTeamId: null,
    };
    room.players.set(id, player);
    room.order.push(id);
    room.lastActivity = Date.now();
    this.bySocket.set(socketId, { code: room.code, playerId: id });
    // In the lobby, between games or mid-game alike: a team game has no
    // bystanders.
    this.ensureTeam(room, player);
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
    takeover = true,
  ): { room: Room; player: PlayerRecord } {
    const room = this.get(code);
    const player = [...room.players.values()].find((p) => p.token === token);
    if (!player) throw new StoreError('INVALID', 'Unknown session for that room');
    if (!takeover && player.connected && player.socketId && player.socketId !== socketId) {
      throw new StoreError('SEAT_IN_USE', 'That seat is open in another tab');
    }
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
    // Votes cast against them before they took over no longer count.
    if (player) room.kickVotes.delete(player.id);
  }

  private cancelHandoff(code: string): void {
    const t = this.hostHandoffs.get(code);
    if (t) clearTimeout(t);
    this.hostHandoffs.delete(code);
  }

  /** After the grace, a host who has not come back passes the role on. */
  private scheduleHandoff(room: Room, hostId: string, graceMs = HOST_GRACE_MS): void {
    this.cancelHandoff(room.code);
    const t = setTimeout(() => {
      this.hostHandoffs.delete(room.code);
      if (this.rooms.get(room.code) !== room) return; // room was collected
      if (room.hostId !== hostId || room.players.get(hostId)?.connected) return;
      this.reassignHost(room);
      this.onHostChange?.(room);
    }, graceMs);
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

  /* ------------------------------------------------------------- kicking */

  private present(room: Room): PlayerRecord[] {
    return [...room.players.values()].filter((p) => p.connected);
  }

  /** Votes that still count: only from players who are here. */
  private liveVotes(room: Room, targetId: string): string[] {
    const voters = room.kickVotes.get(targetId);
    if (!voters) return [];
    return [...voters].filter((id) => id !== targetId && room.players.get(id)?.connected);
  }

  /**
   * In a team game the other teams can be a majority on their own (15 of 29),
   * so a vote kick also needs a vote from the player's own team. Returns that
   * team while no one on it has voted; null when nothing more is needed.
   */
  private teamVoteMissing(room: Room, target: PlayerRecord): TeamState | null {
    if (room.settings.mode !== 'teams' || !target.teamId) return null;
    const own = this.liveVotes(room, target.id).some((id) => room.players.get(id)?.teamId === target.teamId);
    return own ? null : (room.teams.find((t) => t.id === target.teamId) ?? null);
  }

  /**
   * The host removes a player outright; anyone else casts (or, sent again,
   * withdraws) a vote. Returns the player to remove once it is decided —
   * the caller does the removal, which needs the socket layer. `teamNeeded`
   * names the team whose vote is still missing once a majority has voted.
   */
  kickRequest(
    room: Room,
    actor: PlayerRecord,
    targetId: string,
  ): {
    target: PlayerRecord;
    kicked: boolean;
    by: 'host' | 'vote';
    votes: number;
    needed: number;
    teamNeeded: string | null;
  } {
    const target = room.players.get(targetId);
    if (!target) throw new StoreError('INVALID', 'That player is not in the room');
    if (target.id === actor.id) throw new StoreError('INVALID', "You can't kick yourself");
    // It is their room. A host who walks away hands it on by themselves.
    if (target.id === room.hostId) throw new StoreError('INVALID', "The host can't be kicked");
    const needed = kickVotesNeeded(this.present(room).length);
    if (room.hostId === actor.id) {
      return { target, kicked: true, by: 'host', votes: 0, needed, teamNeeded: null };
    }
    if (this.present(room).length < MIN_PLAYERS_FOR_KICK_VOTE) {
      throw new StoreError(
        'INVALID',
        `Vote kicks need at least ${MIN_PLAYERS_FOR_KICK_VOTE} players — ask the host instead`,
      );
    }
    const voters = room.kickVotes.get(targetId) ?? new Set<string>();
    if (voters.has(actor.id)) voters.delete(actor.id);
    else voters.add(actor.id);
    if (voters.size) room.kickVotes.set(targetId, voters);
    else room.kickVotes.delete(targetId);
    room.lastActivity = Date.now();
    const votes = this.liveVotes(room, targetId).length;
    const missing = votes >= needed ? this.teamVoteMissing(room, target) : null;
    return { target, kicked: votes >= needed && !missing, by: 'vote', votes, needed, teamNeeded: missing?.name ?? null };
  }

  /**
   * After someone leaves, fewer votes may be needed: anyone who now has a
   * majority against them is out. Returns who should be removed.
   */
  decidedKicks(room: Room): PlayerRecord[] {
    const presentCount = this.present(room).length;
    if (presentCount < MIN_PLAYERS_FOR_KICK_VOTE) return [];
    const needed = kickVotesNeeded(presentCount);
    const out: PlayerRecord[] = [];
    for (const targetId of room.kickVotes.keys()) {
      const target = room.players.get(targetId);
      if (
        target?.connected &&
        targetId !== room.hostId &&
        this.liveVotes(room, targetId).length >= needed &&
        !this.teamVoteMissing(room, target)
      ) {
        out.push(target);
      }
    }
    return out;
  }

  /**
   * Deletes the seat for good — unlike a disconnect, which keeps it — and
   * bars the browser from walking back in. Returns the socket that held it.
   */
  removePlayer(room: Room, target: PlayerRecord): string | null {
    const socketId = target.socketId;
    if (socketId) this.bySocket.delete(socketId);
    room.players.delete(target.id);
    room.order = room.order.filter((id) => id !== target.id);
    if (target.deviceId) room.banned.add(target.deviceId);
    room.kickVotes.delete(target.id);
    for (const voters of room.kickVotes.values()) voters.delete(target.id);
    room.reactions.delete(target.id);
    leaveTeams(room, target.id);
    room.lastActivity = Date.now();
    if (room.hostId === target.id) {
      this.cancelHandoff(room.code);
      this.reassignHost(room);
    }
    return socketId;
  }

  /** The host's list; only its size is public (settings.customWordCount). */
  setCustomWords(room: Room, words: string[]): void {
    room.customWords = words;
    room.usedCustom = new Set();
    room.customOffered = new Map();
    room.settings = { ...room.settings, customWordCount: words.length };
    room.lastActivity = Date.now();
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
    // customWordCount follows the list itself, never a client's claim.
    const { customWordCount: _ignored, ...rest } = patch;
    const before = room.settings;
    room.settings = { ...room.settings, ...rest };
    // Rounds the host has set are theirs: they no longer follow the room.
    if (rest.rounds !== undefined) room.autoRounds = false;
    if (room.settings.mode === 'teams' && before.mode !== 'teams') {
      // What the host sets in the same change stands; the rest is picked to
      // suit the room, and the host can change it.
      if (rest.teamCount === undefined) {
        const here = this.present(room).length;
        room.settings.teamCount = Math.min(MAX_TEAMS, Math.max(MIN_TEAMS, Math.ceil(here / PLAYERS_PER_TEAM)));
      }
      this.formTeams(room);
      // Until the host sets them, the rounds follow the room as it fills.
      room.autoRounds = rest.rounds === undefined;
    } else if (room.settings.mode === 'teams' && room.settings.teamCount !== before.teamCount) {
      this.rebalance(room, before.teamCount);
    } else if (room.settings.mode !== 'teams' && before.mode === 'teams') {
      // Everyone for themselves. Each seat's team is remembered for next time.
      for (const p of room.players.values()) p.teamId = null;
    }
    // Picked for the teams just formed, or again for a new draw time or team count.
    this.followRoom(room);
    room.round.totalRounds = room.settings.rounds;
    room.lastActivity = Date.now();
    return room.settings;
  }

  /* --------------------------------------------------------------- teams */

  /** The game's teams as everyone sees them; none while everyone plays for themselves. */
  publicTeams(room: Room): Team[] {
    if (room.settings.mode !== 'teams') return [];
    return gameTeams(room).map(({ id, name, score }) => ({ id, name, score }));
  }

  /**
   * In a team game every seat is on one of its teams: a newcomer joins the
   * team with the fewest players here, wherever the game is. Seats already on
   * one stay put.
   */
  ensureTeam(room: Room, player: PlayerRecord): void {
    if (room.settings.mode !== 'teams') return;
    if (gameTeams(room).some((t) => t.id === player.teamId)) return;
    this.dealIn(room, player);
  }

  /** Team changes are for the lobby, like every other setting. */
  private assertTeamLobby(room: Room): void {
    if (room.settings.mode !== 'teams') {
      throw new StoreError('INVALID', 'Teams are off in this room');
    }
    if (room.round.phase !== 'lobby') {
      throw new StoreError('BAD_PHASE', 'Teams are set in the lobby, before the game starts');
    }
  }

  private gameTeam(room: Room, teamId: TeamId): TeamState {
    const team = gameTeams(room).find((t) => t.id === teamId);
    if (!team) throw new StoreError('INVALID', "That team isn't in this game");
    return team;
  }

  /**
   * Moves you to another of the game's teams. No balance check: the readiness
   * line tells everyone if the teams are lopsided. Returns whether you moved.
   */
  joinTeam(room: Room, player: PlayerRecord, teamId: TeamId): boolean {
    this.assertTeamLobby(room);
    const team = this.gameTeam(room, teamId);
    if (player.teamId === team.id) return false;
    this.setTeam(room, player, team);
    room.lastActivity = Date.now();
    return true;
  }

  /** The host deals everyone into even teams at random, the players here first. */
  shuffleTeams(room: Room, actorId: string): void {
    if (room.hostId !== actorId) {
      throw new StoreError('NOT_HOST', 'Only the host can shuffle the teams');
    }
    this.assertTeamLobby(room);
    // New teams, from scratch: whoever drew for their old team starts afresh.
    for (const t of room.teams) {
      t.rotation = [];
      t.drawn = new Set();
    }
    for (const p of room.players.values()) {
      p.teamId = null;
      p.lastTeamId = null;
    }
    for (const p of byPresence(room.players.values())) this.dealIn(room, p);
    room.lastActivity = Date.now();
  }

  /** The host may rename any of the game's teams; anyone else only their own. */
  assertCanRenameTeam(room: Room, player: PlayerRecord, teamId: TeamId): TeamState {
    this.assertTeamLobby(room);
    const team = this.gameTeam(room, teamId);
    if (room.hostId !== player.id && player.teamId !== team.id) {
      throw new StoreError('NOT_HOST', "Only the host or the team's own players can rename it");
    }
    return team;
  }

  /**
   * Renames a team. `name` arrives tidied (tidyTeamName), short enough and
   * clean (the handler checks it like any typed-in word); empty restores the
   * default. Names are unique across all four teams as they read (see
   * teamNameKey), defaults included: two teams called the same would be
   * impossible to tell apart. Returns the old and new name, or null when
   * nothing changed.
   */
  renameTeam(room: Room, player: PlayerRecord, teamId: TeamId, name: string): { from: string; to: string } | null {
    const team = this.assertCanRenameTeam(room, player, teamId);
    const fallback = TEAMS.find((t) => t.id === teamId)!.name;
    const next = name || fallback;
    const key = teamNameKey(next);
    if (room.teams.some((t) => t.id !== team.id && teamNameKey(t.name) === key)) {
      throw new StoreError(
        'INVALID',
        name ? 'Another team is already called that' : `Another team is called ${fallback} now, so pick a new name`,
      );
    }
    room.lastActivity = Date.now();
    if (next === team.name) return null;
    const from = team.name;
    team.name = next;
    return { from, to: next };
  }

  /** Puts a seat on a team, at the back of its rotation, and off any other. */
  private setTeam(room: Room, player: PlayerRecord, team: TeamState): void {
    if (player.lastTeamId !== team.id || !team.rotation.includes(player.id)) {
      leaveTeams(room, player.id);
      team.rotation.push(player.id);
    }
    player.teamId = team.id;
    player.lastTeamId = team.id;
  }

  /**
   * Deals a seat onto the game's team that needs it most: the fewest players
   * here (they are who plays), then the fewest seats, then TEAMS order. A
   * seat whose player is away goes by seats first, so the teams are still
   * even when they come back.
   */
  private dealIn(room: Room, player: PlayerRecord): void {
    let best: TeamState | null = null;
    let bestKey: [number, number] = [Infinity, Infinity];
    for (const team of gameTeams(room)) {
      let here = 0;
      let seats = 0;
      for (const p of room.players.values()) {
        if (p === player || p.teamId !== team.id) continue;
        seats++;
        if (p.connected) here++;
      }
      const key: [number, number] = player.connected ? [here, seats] : [seats, here];
      if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
        best = team;
        bestKey = key;
      }
    }
    if (best) this.setTeam(room, player, best);
  }

  /**
   * Teams on: seats remembered on one of the game's teams go back to it;
   * everyone else is dealt in, the players here first. A team formed afresh
   * draws in the order it was dealt, which is random.
   *
   * Remembered teams can leave a team without enough players: 15 and 15 from
   * a game of two teams, switched back on as four, left two teams empty and
   * the game unable to start. Then the teams are evened out, as when teams
   * are added.
   */
  private formTeams(room: Room): void {
    const teams = gameTeams(room);
    const stray: PlayerRecord[] = [];
    for (const p of room.players.values()) {
      const remembered = teams.find((t) => t.id === p.lastTeamId);
      if (remembered) this.setTeam(room, p, remembered);
      else stray.push(p);
    }
    for (const p of byPresence(stray)) this.dealIn(room, p);
    if (teams.some((t) => !canPlay(room, t))) this.evenOut(room, teams);
  }

  /**
   * A new team count. With fewer teams, the seats on the teams that went are
   * dealt into the smallest; with more, the teams are evened out. Every seat
   * ends on one of the game's teams, and each team gets a fresh drawing order.
   */
  private rebalance(room: Room, from: number): void {
    const teams = gameTeams(room);
    const stray = [...room.players.values()].filter((p) => !teams.some((t) => t.id === p.teamId));
    for (const p of byPresence(stray)) this.dealIn(room, p);
    if (teams.length > from) this.evenOut(room, teams);
    for (const t of teams) t.rotation = shuffled(t.rotation);
  }

  /**
   * Players move from the biggest teams to the smallest until no two differ
   * by more than one (counting players here): then every team that can have
   * enough players to play has.
   */
  private evenOut(room: Room, teams: TeamState[]): void {
    for (;;) {
      const sizes = teams.map((team) => ({ team, here: teamHere(room, team) }));
      const big = sizes.reduce((a, b) => (b.here.length > a.here.length ? b : a));
      const small = sizes.reduce((a, b) => (b.here.length < a.here.length ? b : a));
      if (big.here.length - small.here.length <= 1) break;
      this.setTeam(room, big.here[Math.floor(Math.random() * big.here.length)]!, small.team);
    }
  }

  /**
   * Rounds that follow the room (`autoRounds`) picked again for it as it is
   * now; called whenever who is here, the teams or the draw time may have
   * changed. In the lobby only, like every setting. Returns whether they
   * changed, for the caller to tell everyone. The number of teams is the
   * host's: it never changes by itself.
   */
  followRoom(room: Room): boolean {
    if (!room.autoRounds || room.settings.mode !== 'teams' || room.round.phase !== 'lobby') return false;
    const rounds = this.roundsForTeams(room);
    if (rounds === room.settings.rounds) return false;
    room.settings = { ...room.settings, rounds };
    room.round.totalRounds = rounds;
    return true;
  }

  /**
   * Rounds for a team game of about TEAM_GAME_TARGET_S, by the lobby's
   * estimate: per round, every team draws once per player of the largest.
   */
  private roundsForTeams(room: Room): number {
    if (this.present(room).length >= ONE_ROUND_FROM) return 1;
    const turn = 5 + 0.5 * room.settings.drawSeconds + 4;
    const round = gameTeams(room).length * teamQuota(room) * turn + 5;
    let best = 1;
    for (let r = 2; r <= MAX_ROUNDS; r++) {
      if (Math.abs(r * round - TEAM_GAME_TARGET_S) < Math.abs(best * round - TEAM_GAME_TARGET_S)) best = r;
    }
    return best;
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
      mode: room.settings.mode,
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
    const s = room.settings;
    if (s.mode === 'teams') {
      // Every team needs someone to draw and someone to guess. Uneven teams
      // may start: the host is asked about those on their screen.
      for (const team of gameTeams(room)) {
        const short = MIN_TEAM_SIZE - teamHere(room, team).length;
        if (short > 0) throw new StoreError('INVALID', `${team.name} needs ${plural(short, 'more player')}`);
      }
    }
    if (s.customWordsOnly && room.customWords.length < MIN_CUSTOM_WORDS) {
      throw new StoreError(
        'INVALID',
        `Add at least ${MIN_CUSTOM_WORDS} custom words, or turn off "custom words only"`,
      );
    }
    if (!s.customWordsOnly && s.wordPacks.length === 0) {
      throw new StoreError('INVALID', 'Pick at least one word pack');
    }
  }

  publicPlayers(room: Room): Player[] {
    return room.order
      .map((id) => room.players.get(id))
      .filter((p): p is PlayerRecord => Boolean(p))
      .map(({ id, name, avatar, score, connected, isHost, teamId }) => ({
        id,
        name,
        avatar,
        score,
        connected,
        isHost,
        kickVotes: this.liveVotes(room, id),
        teamId,
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
            room.kickVotes.delete(id);
            leaveTeams(room, id);
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
