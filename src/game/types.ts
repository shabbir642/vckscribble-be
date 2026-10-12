import type {
  Player,
  RoomSettings,
  RoundState,
  Stroke,
} from '../contract/index.js';

export interface PlayerRecord extends Player {
  /** Reconnect secret. Never leaves the server except to its own owner. */
  token: string;
  socketId: string | null;
  lastSeen: number;
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
  createdAt: number;
  lastActivity: number;
}
