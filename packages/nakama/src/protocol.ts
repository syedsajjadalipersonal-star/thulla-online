/**
 * Messages between the Thulla match handler and its clients.
 * Shared by the server (ES5, inside Nakama) and the web page, so it holds only constants and types.
 */
import type { Card, ThullaEvent, ThullaView } from '../../engine/src/index';

export const MODULE_NAME = 'thulla';

/** Client to server. */
export const OP_START = 1;
export const OP_PLAY = 2;
export const OP_RESYNC = 3;

/** Server to client. */
export const OP_WELCOME = 10;
export const OP_EVENT = 11;
export const OP_PROMPT = 12;
export const OP_REJECTED = 13;
export const OP_SEATS = 14;

export interface StartMessage {}

export interface PlayMessage {
  card: Card;
  /** The move number the client last saw. A play made against an older position is rejected. */
  seq: number;
}

export interface ResyncMessage {
  fromSeq: number;
}

export interface SeatInfo {
  name: string;
  connected: boolean;
}

export interface SeatsMessage {
  /** Indexed by seat; null for an empty seat. */
  seats: (SeatInfo | null)[];
  /** Seat of the player who may start the game. */
  host: number;
  started: boolean;
}

/** Sent when a player joins, after a resync, and to everyone when a game starts: a full picture. */
export interface WelcomeMessage extends SeatsMessage {
  seat: number;
  code: string;
  /** Moves applied so far; the next event will carry seq + 1. */
  seq: number;
  /** This seat's view of the game, or null before the first game starts. */
  view: ThullaView | null;
}

/** One move: everything the engine reported for it, and this seat's view afterwards. */
export interface EventMessage {
  seq: number;
  events: ThullaEvent[];
  view: ThullaView;
}

export interface PromptMessage {
  legal: Card[];
  /** When the move is due, in milliseconds since the epoch; 0 means no time limit. */
  deadline: number;
}

export interface RejectedMessage {
  reason: string;
}

export interface CreateTableResponse {
  code: string;
  matchId: string;
}

export interface JoinByCodeRequest {
  code: string;
}

export interface JoinByCodeResponse {
  code: string;
  matchId: string;
}
