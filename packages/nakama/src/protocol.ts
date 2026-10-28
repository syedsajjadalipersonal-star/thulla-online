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
/** Answer to a request to deal with bots in the empty seats. */
export const OP_VOTE = 4;
/** Take your seat back from the bot that is playing it. */
export const OP_TAKE_BACK = 5;

/** Server to client. */
export const OP_WELCOME = 10;
export const OP_EVENT = 11;
export const OP_PROMPT = 12;
export const OP_REJECTED = 13;
export const OP_SEATS = 14;
/** To a bot: the seat is no longer yours; leave the match. */
export const OP_RELEASED = 15;

/** Notification sent to the bot runner when a seat needs a bot. */
export const BOT_WANTED_CODE = 100;

export interface BotWanted {
  matchId: string;
  seat: number;
  name: string;
}

export interface StartMessage {
  /** Deal even with empty seats, which bots then fill. Needs every other player to agree. */
  bots?: boolean;
}

export interface VoteMessage {
  agree: boolean;
}

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
  /** The person who owns this seat is connected. False for a seat that only a bot has ever filled. */
  connected: boolean;
  /** A bot is playing this seat: it was empty at the deal, or its owner missed three turns in a row. */
  bot: boolean;
}

/** The host asked to deal with bots in the empty seats; every other player must agree. */
export interface VoteInfo {
  from: number;
  /** Seats whose answer is needed. */
  voters: number[];
  agreed: number[];
}

export interface SeatsMessage extends TurnInfo {
  /** Indexed by seat; null for an empty seat. */
  seats: (SeatInfo | null)[];
  /** Seat of the player who may start the game. */
  host: number;
  started: boolean;
  vote: VoteInfo | null;
}

/** Whose move it is and when it is due. Times are server clock milliseconds; `now` lets clients correct for their own clock. */
export interface TurnInfo {
  /** 0 when no move is awaited. */
  deadline: number;
  now: number;
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
export interface EventMessage extends TurnInfo {
  seq: number;
  events: ThullaEvent[];
  view: ThullaView;
  /** The mover ran out of time and the server played a random card for them. */
  timedOut: boolean;
}

export interface PromptMessage extends TurnInfo {
  legal: Card[];
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

export interface RegisterBotRunnerRequest {
  secret: string;
}

export interface JoinByCodeResponse {
  code: string;
  matchId: string;
}
