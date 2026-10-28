/**
 * The authoritative Thulla table, run by Nakama.
 *
 * Nakama only runs ES5 and looks up handlers by global function name, so this module is compiled
 * to ES5 CommonJS and `scripts/build-nakama.mjs` wraps it with the global functions Nakama calls.
 * Every rule comes from the engine; this file only seats players, routes messages and makes sure
 * each player receives their own view and nothing else.
 */
import { apply, isIllegalMoveError, setup, view, SEATS, ThullaEvent, ThullaState } from '../../engine/src/index';
import {
  JoinByCodeRequest,
  MODULE_NAME,
  OP_EVENT,
  OP_PLAY,
  OP_PROMPT,
  OP_REJECTED,
  OP_RESYNC,
  OP_SEATS,
  OP_START,
  OP_WELCOME,
  PlayMessage,
  SeatsMessage,
  WelcomeMessage,
} from './protocol';

const TICK_RATE = 5;
/** A table nobody is connected to closes after this long. */
const EMPTY_TICKS = TICK_RATE * 120;
/** A seat reserved by a join attempt that never completed is freed after this long. */
const RESERVE_TICKS = TICK_RATE * 10;

const CODE_COLLECTION = 'tables';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

interface Seat {
  userId: string;
  name: string;
  /** The player's current connection, or null while they are away (or before their join completes). */
  presence: nkruntime.Presence | null;
  reservedAt: number;
}

interface TableState {
  code: string;
  seats: (Seat | null)[];
  host: number;
  game: ThullaState | null;
  /** Every move of the current game, enough to replay it from game.seed. */
  moves: { seat: number; card: number }[];
  emptyTicks: number;
}

/* ------------------------------------------------------------ match handler */

export function matchInit(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  params: { [key: string]: any },
): { state: TableState; tickRate: number; label: string } {
  const code = String(params.code || '');
  const state: TableState = { code: code, seats: [null, null, null, null], host: -1, game: null, moves: [], emptyTicks: 0 };
  return { state: state, tickRate: TICK_RATE, label: label(state) };
}

export function matchJoinAttempt(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: TableState,
  presence: nkruntime.Presence,
  metadata: { [key: string]: any },
): { state: TableState; accept: boolean; rejectMessage?: string } {
  if (seatOf(state, presence.userId) >= 0) return { state: state, accept: true };
  if (state.game) return { state: state, accept: false, rejectMessage: 'That game has already started.' };
  let free = -1;
  for (let s = 0; s < SEATS && free < 0; s++) if (!state.seats[s]) free = s;
  if (free < 0) return { state: state, accept: false, rejectMessage: 'That table is full.' };
  state.seats[free] = { userId: presence.userId, name: cleanName(metadata && metadata.name, free), presence: null, reservedAt: tick };
  return { state: state, accept: true };
}

export function matchJoin(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: TableState,
  presences: nkruntime.Presence[],
): { state: TableState } | null {
  for (let i = 0; i < presences.length; i++) {
    const s = seatOf(state, presences[i].userId);
    if (s < 0) continue;
    (state.seats[s] as Seat).presence = presences[i];
    if (state.host < 0) state.host = s;
  }
  state.emptyTicks = 0;
  for (let i = 0; i < presences.length; i++) sendWelcome(dispatcher, state, presences[i]);
  broadcastSeats(dispatcher, state);
  if (state.game) sendPrompt(dispatcher, state);
  return { state: state };
}

export function matchLeave(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: TableState,
  presences: nkruntime.Presence[],
): { state: TableState } | null {
  for (let i = 0; i < presences.length; i++) {
    const s = seatOf(state, presences[i].userId);
    const seat = state.seats[s];
    // A reloaded page may join on a new connection before the old one is reported gone.
    if (!seat || !seat.presence || seat.presence.sessionId !== presences[i].sessionId) continue;
    if (state.game) seat.presence = null;
    else state.seats[s] = null;
  }
  if (!state.seats[state.host] || !(state.seats[state.host] as Seat).presence) state.host = firstConnected(state);
  dispatcher.matchLabelUpdate(label(state));
  broadcastSeats(dispatcher, state);
  return { state: state };
}

export function matchLoop(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: TableState,
  messages: nkruntime.MatchMessage[],
): { state: TableState } | null {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const seat = seatOf(state, m.sender.userId);
    if (seat < 0) continue;
    let body: any = null;
    try {
      body = JSON.parse(nk.binaryToString(m.data) || '{}');
    } catch (e) {
      body = null;
    }
    if (m.opCode === OP_START) start(nk, logger, dispatcher, state, seat, m.sender);
    else if (m.opCode === OP_PLAY) play(dispatcher, state, seat, m.sender, body as PlayMessage);
    else if (m.opCode === OP_RESYNC) sendWelcome(dispatcher, state, m.sender);
  }

  // Free seats whose join attempt was accepted but never followed by a join.
  if (!state.game) {
    let freed = false;
    for (let s = 0; s < SEATS; s++) {
      const seat = state.seats[s];
      if (seat && !seat.presence && tick - seat.reservedAt > RESERVE_TICKS) {
        state.seats[s] = null;
        freed = true;
      }
    }
    if (freed) broadcastSeats(dispatcher, state);
  }

  if (firstConnected(state) < 0) state.emptyTicks++;
  else state.emptyTicks = 0;
  if (state.emptyTicks > EMPTY_TICKS) {
    logger.info('Closing empty table %s', state.code);
    forgetCode(nk, state.code);
    return null;
  }
  return { state: state };
}

export function matchTerminate(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: TableState,
  graceSeconds: number,
): { state: TableState } | null {
  forgetCode(nk, state.code);
  return { state: state };
}

export function matchSignal(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: TableState,
  data: string,
): { state: TableState; data?: string } | null {
  return { state: state, data: '' };
}

/* ------------------------------------------------------------ server functions */

/** Opens a new table and returns its room code. The caller then joins it like anyone else. */
export function rpcCreateTable(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  if (!ctx.userId) throw new Error('Sign in first.');
  let code = '';
  for (let attempt = 0; attempt < 10 && !code; attempt++) {
    const candidate = newCode(nk);
    if (!lookupCode(nk, candidate)) code = candidate;
  }
  if (!code) throw new Error('Could not find a free room code. Try again.');
  const matchId = nk.matchCreate(MODULE_NAME, { code: code });
  nk.storageWrite([
    {
      collection: CODE_COLLECTION,
      key: code,
      userId: SYSTEM_USER,
      value: { matchId: matchId },
      permissionRead: 0,
      permissionWrite: 0,
    },
  ]);
  logger.info('Table %s opened as match %s', code, matchId);
  return JSON.stringify({ code: code, matchId: matchId });
}

/** Turns a room code into the match id to join. */
export function rpcJoinByCode(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  if (!ctx.userId) throw new Error('Sign in first.');
  let request: JoinByCodeRequest;
  try {
    request = JSON.parse(payload || '{}');
  } catch (e) {
    throw new Error('Send {"code": "..."}');
  }
  const code = String(request.code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const matchId = code ? lookupCode(nk, code) : null;
  if (!matchId) throw new Error('No table has the code ' + (code || '(blank)') + '.');
  return JSON.stringify({ code: code, matchId: matchId });
}

/* ------------------------------------------------------------ game flow */

function start(
  nk: nkruntime.Nakama,
  logger: nkruntime.Logger,
  dispatcher: nkruntime.MatchDispatcher,
  state: TableState,
  seat: number,
  sender: nkruntime.Presence,
): void {
  if (state.game && !state.game.over) return reject(dispatcher, sender, 'The game is already running.');
  if (seat !== state.host) return reject(dispatcher, sender, 'Only the host can start the game.');
  for (let s = 0; s < SEATS; s++) {
    const st = state.seats[s];
    if (!st || !st.presence) return reject(dispatcher, sender, 'Thulla needs four players at the table.');
  }
  // uuidv4 comes from a secure random source; the engine spreads it into the shuffle.
  state.game = setup(nk.uuidv4() + nk.uuidv4());
  state.moves = [];
  logger.info('Table %s: game started', state.code);
  dispatcher.matchLabelUpdate(label(state));
  for (let s = 0; s < SEATS; s++) sendWelcome(dispatcher, state, (state.seats[s] as Seat).presence as nkruntime.Presence);
  sendPrompt(dispatcher, state);
}

function play(dispatcher: nkruntime.MatchDispatcher, state: TableState, seat: number, sender: nkruntime.Presence, msg: PlayMessage): void {
  const game = state.game;
  if (!game) return reject(dispatcher, sender, 'The game has not started.');
  if (!msg || msg.seq !== game.moveCount) return reject(dispatcher, sender, 'The table has moved on since then.');
  let events: ThullaEvent[];
  try {
    const result = apply(game, seat, { type: 'play', card: msg.card });
    state.game = result.state;
    events = result.events;
  } catch (e) {
    return reject(dispatcher, sender, isIllegalMoveError(e) ? e.reason : 'That move failed.');
  }
  state.moves.push({ seat: seat, card: msg.card });
  const next = state.game as ThullaState;
  for (let s = 0; s < SEATS; s++) {
    const p = presenceAt(state, s);
    if (p) send(dispatcher, OP_EVENT, { seq: next.moveCount, events: events, view: view(next, s) }, p);
  }
  if (next.over) dispatcher.matchLabelUpdate(label(state));
  else sendPrompt(dispatcher, state);
}

/* ------------------------------------------------------------ messages */

function sendWelcome(dispatcher: nkruntime.MatchDispatcher, state: TableState, presence: nkruntime.Presence): void {
  const seat = seatOf(state, presence.userId);
  if (seat < 0) return;
  const seats = seatsMessage(state);
  const msg: WelcomeMessage = {
    seats: seats.seats,
    host: seats.host,
    started: seats.started,
    seat: seat,
    code: state.code,
    seq: state.game ? state.game.moveCount : 0,
    view: state.game ? view(state.game, seat) : null,
  };
  send(dispatcher, OP_WELCOME, msg, presence);
}

function sendPrompt(dispatcher: nkruntime.MatchDispatcher, state: TableState): void {
  const game = state.game;
  if (!game || game.over) return;
  const p = presenceAt(state, game.turn);
  if (p) send(dispatcher, OP_PROMPT, { legal: view(game, game.turn).legal, deadline: 0 }, p);
}

function broadcastSeats(dispatcher: nkruntime.MatchDispatcher, state: TableState): void {
  dispatcher.broadcastMessage(OP_SEATS, JSON.stringify(seatsMessage(state)), null, null, true);
}

function reject(dispatcher: nkruntime.MatchDispatcher, presence: nkruntime.Presence, reason: string): void {
  send(dispatcher, OP_REJECTED, { reason: reason }, presence);
}

/** Sends to one player only: views are never broadcast. */
function send(dispatcher: nkruntime.MatchDispatcher, opCode: number, body: object, presence: nkruntime.Presence): void {
  dispatcher.broadcastMessage(opCode, JSON.stringify(body), [presence], null, true);
}

function seatsMessage(state: TableState): SeatsMessage {
  const seats: SeatsMessage['seats'] = [];
  for (let s = 0; s < SEATS; s++) {
    const st = state.seats[s];
    seats.push(st ? { name: st.name, connected: !!st.presence } : null);
  }
  return { seats: seats, host: state.host, started: !!state.game };
}

/* ------------------------------------------------------------ helpers */

function seatOf(state: TableState, userId: string): number {
  for (let s = 0; s < SEATS; s++) {
    const st = state.seats[s];
    if (st && st.userId === userId) return s;
  }
  return -1;
}

function presenceAt(state: TableState, seat: number): nkruntime.Presence | null {
  const st = state.seats[seat];
  return st ? st.presence : null;
}

function firstConnected(state: TableState): number {
  for (let s = 0; s < SEATS; s++) if (presenceAt(state, s)) return s;
  return -1;
}

function label(state: TableState): string {
  let players = 0;
  for (let s = 0; s < SEATS; s++) if (state.seats[s]) players++;
  return JSON.stringify({ code: state.code, players: players, playing: !!state.game && !state.game.over });
}

function cleanName(value: unknown, seat: number): string {
  const name = String(value || '')
    .replace(/[\u0000-\u001f<>&"]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^ | $/g, '')
    .slice(0, 16);
  return name || 'Player ' + (seat + 1);
}

function newCode(nk: nkruntime.Nakama): string {
  const hex = nk.uuidv4().replace(/-/g, '');
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET.charAt(parseInt(hex.substr(i * 2, 2), 16) % CODE_ALPHABET.length);
  return code;
}

/** The match behind a room code, or null if there is none or it has closed. */
function lookupCode(nk: nkruntime.Nakama, code: string): string | null {
  const found = nk.storageRead([{ collection: CODE_COLLECTION, key: code, userId: SYSTEM_USER }]);
  if (!found.length) return null;
  const matchId = String(found[0].value.matchId || '');
  if (matchId && nk.matchGet(matchId)) return matchId;
  forgetCode(nk, code);
  return null;
}

function forgetCode(nk: nkruntime.Nakama, code: string): void {
  if (!code) return;
  try {
    nk.storageDelete([{ collection: CODE_COLLECTION, key: code, userId: SYSTEM_USER }]);
  } catch (e) {
    // Already gone.
  }
}
