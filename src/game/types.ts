import type {
  BestDrawing,
  Drawability,
  GameSummary,
  Player,
  RoomSettings,
  RoundState,
  Stroke,
  TeamId,
} from '../contract/index.js';

export interface PlayerRecord extends Omit<Player, 'kickVotes'> {
  /** Reconnect secret. Never leaves the server except to its own owner. */
  token: string;
  socketId: string | null;
  lastSeen: number;
  /** The browser's persistent id, if it sent one; reclaims seats. */
  deviceId: string | null;
  /**
   * The team this seat was last on. `teamId` is null while everyone plays for
   * themselves; this is kept, so turning Teams back on puts people back where
   * they were. In a team game the two are the same.
   */
  lastTeamId: TeamId | null;
}

/** A team as the server keeps it: the public Team, plus who draws next. */
export interface TeamState {
  id: TeamId;
  /** The default from TEAMS, or a rename. Lasts the room's life, mode or not. */
  name: string;
  /** Points this game. */
  score: number;
  /**
   * Its members in drawing order (the seats whose lastTeamId is this team):
   * shuffled whenever the teams are dealt, newcomers at the back.
   */
  rotation: string[];
  /**
   * Members who have drawn since the rotation last came round. Kept across
   * rounds and games, so the next game starts with whoever is still to draw.
   */
  drawn: Set<string>;
}

export interface ActiveWord {
  /** null for a drawer-supplied custom word — it has no dictionary row yet. */
  wordId: number | null;
  text: string;
  normalized: string;
  custom: boolean;
}

/**
 * What one player has done this game, booked as it happens (see summary.ts):
 * by the end their seat may be gone and the round state has moved on.
 */
export interface Tally {
  /** As last seen: the seat can be kicked before the game ends. */
  name: string;
  avatar: number;
  /** Last known, for the same reason. */
  score: number;
  guessed: number;
  firstGuesses: number;
  /** Quickest right guess, in ms after the drawing started. */
  fastestMs: number | null;
  drew: number;
  /** Right guesses on their drawings, all their turns together. */
  solvedByOthers: number;
  /** 👍 on their drawings, all their turns together. */
  likes: number;
  /** The team they played for, as last seen: a team game's results list them by team. */
  teamId: TeamId | null;
}

export interface Room {
  code: string;
  hostId: string;
  players: Map<string, PlayerRecord>;
  /** Join order — drives drawer rotation in M4. */
  order: string[];
  settings: RoomSettings;
  round: RoundState;
  strokes: Stroke[];
  /** id -> stroke, so appends and restarts resolve in O(1). */
  strokeIndex: Map<string, Stroke>;
  /** Sum of points across `strokes`, checked against MAX_POINTS_PER_ROOM. */
  pointCount: number;
  createdAt: number;
  lastActivity: number;

  /* --- round machine (M4) --- */
  /** Bumped on every phase change; stale timers compare against it and bail. */
  seq: number;
  /**
   * Whose turn it is within the current round: a place in `drawOrder`, or in
   * a team game the turn's number in the round, counting every team's turns.
   */
  turnIndex: number;
  /**
   * The drawing queue (everyone for themselves; a team game draws from each
   * team's rotation). Seeded from `order` at kickoff, extended as players
   * arrive, and rebuilt from the live roster at each round boundary.
   */
  drawOrder: string[];
  usedWordIds: number[];
  /** The solution, server-side only. Never serialized into RoundState while drawing. */
  active: ActiveWord | null;
  /** Kept whole, not just ids: a drawer who reconnects mid-selection needs the
   *  same three choices re-sent, drawability and all. */
  offered: { id: number; text: string; drawability: Drawability }[];
  /** Indices of revealed letters, grown as the clock runs down. */
  revealed: number[];
  /** playerId -> count of custom words this game, for rate limiting. */
  customCounts: Record<string, number>;
  /** Points the drawer has earned this turn, for the per-turn cap. */
  drawerEarned: number;
  /** Each guesser's vote on the drawing in progress; cleared every turn. */
  reactions: Map<string, 'up' | 'down'>;
  /** Players who reported the current word; one report each per turn. */
  reportedBy: Set<string>;
  /** The host's custom word list. Never broadcast — guessers would see it. */
  customWords: string[];
  /** Indices into `customWords` already drawn this game. */
  usedCustom: Set<number>;
  /** Index into `customWords` -> the turn it was last offered on. */
  customOffered: Map<number, number>;
  /** Turns begun this game, counting from 1; paces the custom words. */
  turnNo: number;
  /** Normalized text of every word drawn this game, from any source. */
  drawn: Set<string>;
  /**
   * This turn's hints as data — which letter, at what time — rather than only
   * as timers, so a restored room can re-arm the ones still to come.
   */
  hintPlan: { idx: number; at: number }[];
  /** Whether the scoreboard on show is the last one (then the game ends). */
  finalScoreboard: boolean;
  /** target playerId -> ids of the players voting to kick them. */
  kickVotes: Map<string, Set<string>>;
  /** Device ids (and tokens) of kicked players, refused at the door. */
  banned: Set<string>;

  /* --- team games --- */
  /**
   * Every team a room can have, in TEAMS order, whatever the mode: a team game
   * plays the first `settings.teamCount`. Names and rotations outlast a switch
   * to everyone for themselves.
   */
  teams: TeamState[];
  /** Team games started in this room: each one starts with the next team. */
  teamGames: number;
  /** The team this game started with, as an index into its teams. */
  teamStart: number;
  /**
   * Turns each team gets this round: as many as the largest team had players
   * here when the round began, so everyone draws once and the teams draw
   * equally often (a smaller team goes round its rotation again).
   */
  teamQuota: number;
  /**
   * Whether the rounds follow the room: from Teams going on until the host
   * sets them, the lobby re-picks them as people come and go (see
   * RoomStore.followRoom). Hosts turn Teams on alone, before sharing the
   * link; rounds picked for one player made a game of hours for thirty.
   */
  autoRounds: boolean;

  /* --- end-of-game summary (summary.ts) --- */
  /** Fresh for every game: the summary's id, the same in every re-send. */
  gameId: string;
  /** player id -> what they did this game; kept for players who have left. */
  tally: Map<string, Tally>;
  /**
   * The best drawings so far this game, best first, each with the score it
   * won on: a few, from different drawers, so kicking one drawer still leaves
   * a drawing of the game (see recordTurn).
   */
  bestTurns: { drawing: BestDrawing; score: number }[];
  /** The finished game's summary, kept to re-send; null while a game runs. */
  summary: GameSummary | null;
}
