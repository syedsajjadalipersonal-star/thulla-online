/**
 * The authoritative Thulla table, run by Nakama.
 *
 * Nakama only runs ES5 and looks up handlers by global function name, so this module is compiled
 * to ES5 CommonJS and `scripts/build-nakama.mjs` wraps it with the global functions Nakama calls.
 * Every rule comes from the engine; this file only seats players, keeps time, routes messages and
 * makes sure each player (or bot) receives its own seat's view and nothing else.
 *
 * Time: each move has TURN_SECONDS (60 unless the runtime env says otherwise). When it runs out the
 * server plays a random legal card. Three timed-out turns in a row and a bot takes over the seat,
 * until its owner reconnects or asks for it back.
 */
import { apply, isIllegalMoveError, setup, view, SEATS, ThullaEvent, ThullaState } from '../../engine/src/index';
import {
  BOT_WANTED_CODE,
  BotWanted,
  JoinByCodeRequest,
  MODULE_NAME,
  OP_EVENT,
  OP_PLAY,
  OP_PROMPT,
  OP_REJECTED,
  OP_RELEASED,
  OP_RESYNC,
  OP_SEATS,
  OP_START,
  OP_TAKE_BACK,
  OP_VOTE,
  OP_WELCOME,
  PlayMessage,
  RegisterBotRunnerRequest,
  SeatsMessage,
  StartMessage,
  VoteInfo,
  VoteMessage,
  WelcomeMessage,
} from './protocol';

const TICK_RATE = 5;
/** A table nobody is connected to closes after this long. */
const EMPTY_TICKS = TICK_RATE * 120;
/** A seat reserved by a join attempt that never completed is freed after this long. */
const RESERVE_TICKS = TICK_RATE * 10;
const DEFAULT_TURN_SECONDS = 60;
/** Timed-out turns in a row before a bot takes over. */
const SKIPS_BEFORE_BOT = 3;
/** A connected bot that has not answered by then gets a random card played for it. */
const BOT_TURN_SECONDS = 15;
/** A bot seat whose bot has not (yet) joined plays a random card after this long. */
const NO_BOT_SECONDS = 3;
const VOTE_SECONDS = 30;

/** Names for bots filling seats that nobody took, as in the single-player game. */
const BOT_NAMES = ['Bilal', 'Hina', 'Zara', 'Kamran'];

const CODE_COLLECTION = 'tables';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const BOT_COLLECTION = 'bots';
const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

interface Seat {
  /** The person who owns the seat; '' for a seat a bot filled at the deal. */
  userId: string;
  name: string;
  /** The owner's current connection, or null while they are away (or before their join completes). */
  presence: nkruntime.Presence | null;
  reservedAt: number;
  /** The owner's join completed at least once. */
  joined: boolean;
  /** Turns in a row the owner let time run out on. */
  skips: number;
  /** A bot is playing this seat. */
  bot: boolean;
  /** The bot account invited to play it, once it has asked to join. */
  botUserId: string;
  botPresence: nkruntime.Presence | null;
}

interface Vote extends VoteInfo {
  endsTick: number;
}

interface TableState {
  matchId: string;
  code: string;
  seats: (Seat | null)[];
  host: number;
  game: ThullaState | null;
  /** Every move of the current game, enough to replay it from game.seed. */
  moves: { seat: number; card: number }[];
  emptyTicks: number;
  turnSeconds: number;
  /** When the awaited move is due: as a tick for the server, as a time for clients. */
  turnEndsTick: number;
  turnEndsAt: number;
  vote: Vote | null;
}

type Dispatcher = nkruntime.MatchDispatcher;

/* ------------------------------------------------------------ match handler */

export function matchInit(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  params: { [key: string]: any },
): { state: TableState; tickRate: number; label: string } {
  const seconds = parseInt((ctx.env && ctx.env.TURN_SECONDS) || '', 10);
  const state: TableState = {
    matchId: ctx.matchId || '',
    code: String(params.code || ''),
    seats: [null, null, null, null],
    host: -1,
    game: null,
    moves: [],
    emptyTicks: 0,
    turnSeconds: seconds > 0 ? seconds : DEFAULT_TURN_SECONDS,
    turnEndsTick: 0,
    turnEndsAt: 0,
    vote: null,
  };
  return { state: state, tickRate: TICK_RATE, label: label(state) };
}

export function matchJoinAttempt(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: Dispatcher,
  tick: number,
  state: TableState,
  presence: nkruntime.Presence,
  metadata: { [key: string]: any },
): { state: TableState; accept: boolean; rejectMessage?: string } {
  if (metadata && metadata.secret) {
    // A bot from the bot runner, coming to play a seat it was invited to.
    const secret = ctx.env && ctx.env.BOT_SECRET;
    const seat = state.seats[parseInt(metadata.seat, 10)];
    if (!secret || metadata.secret !== secret || !seat || !seat.bot || seat.botPresence) {
      return { state: state, accept: false, rejectMessage: 'No bot is wanted there.' };
    }
    seat.botUserId = presence.userId;
    return { state: state, accept: true };
  }

  if (ownSeat(state, presence.userId) >= 0) return { state: state, accept: true };
  if (running(state)) return { state: state, accept: false, rejectMessage: 'That game has already started.' };
  clearFinishedSeats(dispatcher, state);
  let free = -1;
  for (let s = 0; s < SEATS && free < 0; s++) if (!state.seats[s]) free = s;
  if (free < 0) return { state: state, accept: false, rejectMessage: 'That table is full.' };
  state.seats[free] = newSeat(presence.userId, cleanName(metadata && metadata.name, free), tick);
  cancelVote(dispatcher, state, 'Someone new sat down, so the vote to deal with bots was dropped.');
  return { state: state, accept: true };
}

export function matchJoin(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: Dispatcher,
  tick: number,
  state: TableState,
  presences: nkruntime.Presence[],
): { state: TableState } | null {
  for (let i = 0; i < presences.length; i++) {
    const p = presences[i];
    const own = ownSeat(state, p.userId);
    if (own >= 0) {
      const seat = state.seats[own] as Seat;
      seat.presence = p;
      seat.joined = true;
      if (state.host < 0) state.host = own;
      // Coming back to a game a bot was playing for you: the seat is yours again.
      if (running(state) && seat.bot) takeBack(dispatcher, state, own, tick);
    } else {
      const b = botSeat(state, p.userId);
      if (b >= 0) {
        (state.seats[b] as Seat).botPresence = p;
        if (running(state) && (state.game as ThullaState).turn === b) startTurnClock(state, tick);
      }
    }
  }
  state.emptyTicks = 0;
  for (let i = 0; i < presences.length; i++) sendWelcome(dispatcher, state, presences[i]);
  broadcastSeats(dispatcher, state);
  sendPrompt(dispatcher, state);
  return { state: state };
}

export function matchLeave(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: Dispatcher,
  tick: number,
  state: TableState,
  presences: nkruntime.Presence[],
): { state: TableState } | null {
  let personLeft = false;
  for (let i = 0; i < presences.length; i++) {
    const p = presences[i];
    for (let s = 0; s < SEATS; s++) {
      const seat = state.seats[s];
      if (!seat) continue;
      // A reloaded page may join on a new connection before the old one is reported gone.
      if (seat.presence && seat.presence.sessionId === p.sessionId) {
        personLeft = true;
        // Once a game has been dealt here, seats are kept for their owners until someone else needs them.
        if (state.game) seat.presence = null;
        else state.seats[s] = null;
      } else if (seat.botPresence && seat.botPresence.sessionId === p.sessionId) {
        seat.botPresence = null;
        seat.botUserId = '';
        if (running(state) && (state.game as ThullaState).turn === s) startTurnClock(state, tick);
      }
    }
  }
  if (!presenceAt(state, state.host)) state.host = firstConnected(state);
  if (personLeft) cancelVote(dispatcher, state, 'Someone left, so the vote to deal with bots was dropped.');
  dispatcher.matchLabelUpdate(label(state));
  broadcastSeats(dispatcher, state);
  return { state: state };
}

export function matchLoop(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: Dispatcher,
  tick: number,
  state: TableState,
  messages: nkruntime.MatchMessage[],
): { state: TableState } | null {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    let body: any = null;
    try {
      body = JSON.parse(nk.binaryToString(m.data) || '{}');
    } catch (e) {
      body = null;
    }
    const own = ownSeat(state, m.sender.userId);
    const bot = botSeat(state, m.sender.userId);
    if (m.opCode === OP_PLAY && bot >= 0) play(dispatcher, state, bot, m.sender, body as PlayMessage, tick, true);
    else if (own < 0) continue;
    else if (m.opCode === OP_START) start(nk, logger, dispatcher, state, own, m.sender, (body || {}) as StartMessage, tick);
    else if (m.opCode === OP_VOTE) vote(nk, logger, dispatcher, state, own, (body || {}) as VoteMessage, tick);
    else if (m.opCode === OP_PLAY) play(dispatcher, state, own, m.sender, body as PlayMessage, tick, false);
    else if (m.opCode === OP_TAKE_BACK) {
      if (running(state) && (state.seats[own] as Seat).bot) takeBack(dispatcher, state, own, tick);
    } else if (m.opCode === OP_RESYNC) sendWelcome(dispatcher, state, m.sender);
  }

  if (running(state) && tick >= state.turnEndsTick) timeOut(nk, logger, dispatcher, state, tick);

  if (state.vote && tick >= state.vote.endsTick) {
    cancelVote(dispatcher, state, 'Not everyone answered, so the cards were not dealt.');
    broadcastSeats(dispatcher, state);
  }

  // Free seats whose join attempt was accepted but never followed by a join.
  if (!running(state)) {
    let freed = false;
    for (let s = 0; s < SEATS; s++) {
      const seat = state.seats[s];
      if (seat && seat.userId && !seat.joined && tick - seat.reservedAt > RESERVE_TICKS) {
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
    releaseBots(dispatcher, state);
    forgetCode(nk, state.code);
    return null;
  }
  return { state: state };
}

export function matchTerminate(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: Dispatcher,
  tick: number,
  state: TableState,
  graceSeconds: number,
): { state: TableState } | null {
  releaseBots(dispatcher, state);
  forgetCode(nk, state.code);
  return { state: state };
}

export function matchSignal(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: Dispatcher,
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
    { collection: CODE_COLLECTION, key: code, userId: SYSTEM_USER, value: { matchId: matchId }, permissionRead: 0, permissionWrite: 0 },
  ]);
  logger.info('Table %s opened as match %s', code, matchId);
  return JSON.stringify({ code: code, matchId: matchId });
}

/** Turns a room code into the match id to join. */
export function rpcJoinByCode(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  if (!ctx.userId) throw new Error('Sign in first.');
  const request = parse(payload) as JoinByCodeRequest;
  const code = String((request && request.code) || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const matchId = code ? lookupCode(nk, code) : null;
  if (!matchId) throw new Error('No table has the code ' + (code || '(blank)') + '.');
  return JSON.stringify({ code: code, matchId: matchId });
}

/** The bot runner signs in with the shared secret; tables then send it their requests for bots. */
export function rpcRegisterBotRunner(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const request = parse(payload) as RegisterBotRunnerRequest;
  const secret = ctx.env && ctx.env.BOT_SECRET;
  if (!ctx.userId || !secret || !request || request.secret !== secret) throw new Error('Not allowed.');
  nk.storageWrite([
    { collection: BOT_COLLECTION, key: 'runner', userId: SYSTEM_USER, value: { userId: ctx.userId }, permissionRead: 0, permissionWrite: 0 },
  ]);
  logger.info('Bot runner registered as user %s', ctx.userId);
  return JSON.stringify({ ok: true });
}

/* ------------------------------------------------------------ game flow */

function start(
  nk: nkruntime.Nakama,
  logger: nkruntime.Logger,
  dispatcher: Dispatcher,
  state: TableState,
  seat: number,
  sender: nkruntime.Presence,
  msg: StartMessage,
  tick: number,
): void {
  if (running(state)) return reject(dispatcher, sender, 'The game is already running.');
  if (seat !== state.host) return reject(dispatcher, sender, 'Only the host can deal.');
  if (state.vote) return reject(dispatcher, sender, 'Still waiting for everyone to answer.');
  clearFinishedSeats(dispatcher, state);
  const others: number[] = [];
  for (let s = 0; s < SEATS; s++) if (s !== seat && presenceAt(state, s)) others.push(s);
  if (others.length === SEATS - 1) return deal(nk, logger, dispatcher, state, tick);
  if (!msg.bots) return reject(dispatcher, sender, 'Thulla needs four players at the table, or bots in the empty seats.');
  if (!others.length) return deal(nk, logger, dispatcher, state, tick);
  state.vote = { from: seat, voters: others, agreed: [], endsTick: tick + VOTE_SECONDS * TICK_RATE };
  broadcastSeats(dispatcher, state);
}

function vote(
  nk: nkruntime.Nakama,
  logger: nkruntime.Logger,
  dispatcher: Dispatcher,
  state: TableState,
  seat: number,
  msg: VoteMessage,
  tick: number,
): void {
  const v = state.vote;
  if (!v || indexOf(v.voters, seat) < 0 || indexOf(v.agreed, seat) >= 0) return;
  if (!msg.agree) {
    cancelVote(dispatcher, state, (state.seats[seat] as Seat).name + ' would rather wait for more players.');
    broadcastSeats(dispatcher, state);
    return;
  }
  v.agreed.push(seat);
  if (v.agreed.length === v.voters.length) {
    state.vote = null;
    deal(nk, logger, dispatcher, state, tick);
  } else broadcastSeats(dispatcher, state);
}

/** Deals a new game, putting bots in any empty seats. */
function deal(nk: nkruntime.Nakama, logger: nkruntime.Logger, dispatcher: Dispatcher, state: TableState, tick: number): void {
  state.vote = null;
  const used: string[] = [];
  for (let s = 0; s < SEATS; s++) if (state.seats[s]) used.push((state.seats[s] as Seat).name);
  for (let s = 0; s < SEATS; s++) {
    const seat = state.seats[s];
    if (seat) {
      seat.skips = 0;
      if (seat.bot) release(dispatcher, seat);
      continue;
    }
    let name = 'Bot';
    for (let n = 0; n < BOT_NAMES.length; n++) {
      if (indexOf(used, BOT_NAMES[n]) < 0) {
        name = BOT_NAMES[n];
        break;
      }
    }
    used.push(name);
    const filler = newSeat('', name, tick);
    filler.bot = true;
    state.seats[s] = filler;
  }
  // uuidv4 comes from a secure random source; the engine spreads it into the shuffle.
  state.game = setup(nk.uuidv4() + nk.uuidv4());
  state.moves = [];
  for (let s = 0; s < SEATS; s++) if ((state.seats[s] as Seat).bot) requestBot(nk, logger, state, s);
  startTurnClock(state, tick);
  logger.info('Table %s: game started', state.code);
  dispatcher.matchLabelUpdate(label(state));
  for (let s = 0; s < SEATS; s++) {
    const seat = state.seats[s] as Seat;
    if (seat.presence) sendWelcome(dispatcher, state, seat.presence);
  }
  broadcastSeats(dispatcher, state);
  sendPrompt(dispatcher, state);
}

function play(
  dispatcher: Dispatcher,
  state: TableState,
  seat: number,
  sender: nkruntime.Presence,
  msg: PlayMessage,
  tick: number,
  byBot: boolean,
): void {
  const game = state.game;
  if (!game || game.over) return reject(dispatcher, sender, 'No game is running.');
  if (!byBot && (state.seats[seat] as Seat).bot) return reject(dispatcher, sender, 'A bot is playing your seat. Take it back first.');
  if (!msg || msg.seq !== game.moveCount) return reject(dispatcher, sender, 'The table has moved on since then.');
  if (!byBot) (state.seats[seat] as Seat).skips = 0;
  move(dispatcher, state, seat, msg.card, false, tick, sender);
}

/** Time ran out: play a random legal card, and after three in a row let a bot take over. */
function timeOut(nk: nkruntime.Nakama, logger: nkruntime.Logger, dispatcher: Dispatcher, state: TableState, tick: number): void {
  const game = state.game as ThullaState;
  const s = game.turn;
  const seat = state.seats[s] as Seat;
  const legal = view(game, s).legal;
  const card = legal[Math.floor(Math.random() * legal.length)];
  let tookOver = false;
  if (!seat.bot) {
    seat.skips++;
    if (seat.skips >= SKIPS_BEFORE_BOT) {
      tookOver = true;
      seat.bot = true;
      logger.info('Table %s: a bot takes over seat %d after %d missed turns', state.code, s, seat.skips);
      requestBot(nk, logger, state, s);
    }
  }
  move(dispatcher, state, s, card, true, tick, null);
  if (tookOver) broadcastSeats(dispatcher, state);
}

function move(
  dispatcher: Dispatcher,
  state: TableState,
  seat: number,
  card: number,
  timedOut: boolean,
  tick: number,
  sender: nkruntime.Presence | null,
): void {
  let events: ThullaEvent[];
  try {
    const result = apply(state.game as ThullaState, seat, { type: 'play', card: card });
    state.game = result.state;
    events = result.events;
  } catch (e) {
    if (sender) reject(dispatcher, sender, isIllegalMoveError(e) ? e.reason : 'That move failed.');
    return;
  }
  state.moves.push({ seat: seat, card: card });
  const next = state.game as ThullaState;
  if (next.over) {
    state.turnEndsTick = 0;
    state.turnEndsAt = 0;
  } else startTurnClock(state, tick);
  for (let s = 0; s < SEATS; s++) {
    const targets = watchers(state, s);
    if (targets.length) {
      const msg = { seq: next.moveCount, events: events, view: view(next, s), timedOut: timedOut, deadline: state.turnEndsAt, now: Date.now() };
      dispatcher.broadcastMessage(OP_EVENT, JSON.stringify(msg), targets, null, true);
    }
  }
  if (next.over) {
    dispatcher.matchLabelUpdate(label(state));
    broadcastSeats(dispatcher, state);
  } else sendPrompt(dispatcher, state);
}

/** The owner plays their seat again; the bot that was playing it is sent away. */
function takeBack(dispatcher: Dispatcher, state: TableState, s: number, tick: number): void {
  const seat = state.seats[s] as Seat;
  if (!seat.userId) return;
  release(dispatcher, seat);
  seat.skips = 0;
  if ((state.game as ThullaState).turn === s) startTurnClock(state, tick);
  broadcastSeats(dispatcher, state);
  sendPrompt(dispatcher, state);
}

function release(dispatcher: Dispatcher, seat: Seat): void {
  if (seat.botPresence) dispatcher.broadcastMessage(OP_RELEASED, '{}', [seat.botPresence], null, true);
  seat.bot = false;
  seat.botPresence = null;
  seat.botUserId = '';
}

function releaseBots(dispatcher: Dispatcher, state: TableState): void {
  for (let s = 0; s < SEATS; s++) {
    const seat = state.seats[s];
    if (seat && seat.botPresence) dispatcher.broadcastMessage(OP_RELEASED, '{}', [seat.botPresence], null, true);
  }
}

/** Asks the bot runner, if one is registered, to send a bot to this seat. */
function requestBot(nk: nkruntime.Nakama, logger: nkruntime.Logger, state: TableState, s: number): void {
  let runner = '';
  try {
    const found = nk.storageRead([{ collection: BOT_COLLECTION, key: 'runner', userId: SYSTEM_USER }]);
    if (found.length) runner = String(found[0].value.userId || '');
  } catch (e) {
    runner = '';
  }
  if (!runner) {
    logger.warn('Table %s: no bot runner registered; seat %d will play random cards', state.code, s);
    return;
  }
  const wanted: BotWanted = { matchId: state.matchId, seat: s, name: (state.seats[s] as Seat).name };
  nk.notificationSend(runner, 'bot_wanted', wanted, BOT_WANTED_CODE, null, false);
}

/**
 * After a game: seats a bot filled, and seats whose owner has gone, become free again. The finished game
 * is then forgotten, so nobody who sits down in a freed seat is shown the cards left in it.
 */
function clearFinishedSeats(dispatcher: Dispatcher, state: TableState): void {
  if (!state.game) return;
  let freed = false;
  for (let s = 0; s < SEATS; s++) {
    const seat = state.seats[s];
    if (!seat) continue;
    if (seat.bot) release(dispatcher, seat);
    if (!seat.userId || !seat.presence) {
      state.seats[s] = null;
      freed = true;
    }
  }
  if (freed) {
    state.game = null;
    state.moves = [];
  }
  broadcastSeats(dispatcher, state);
}

function cancelVote(dispatcher: Dispatcher, state: TableState, reason: string): void {
  const v = state.vote;
  if (!v) return;
  state.vote = null;
  const host = presenceAt(state, v.from);
  if (host) reject(dispatcher, host, reason);
}

function startTurnClock(state: TableState, tick: number): void {
  const game = state.game as ThullaState;
  const seat = state.seats[game.turn] as Seat;
  const seconds = !seat.bot ? state.turnSeconds : seat.botPresence ? BOT_TURN_SECONDS : NO_BOT_SECONDS;
  state.turnEndsTick = tick + seconds * TICK_RATE;
  state.turnEndsAt = Date.now() + seconds * 1000;
}

/* ------------------------------------------------------------ messages */

function sendWelcome(dispatcher: Dispatcher, state: TableState, presence: nkruntime.Presence): void {
  let seat = ownSeat(state, presence.userId);
  if (seat < 0) seat = botSeat(state, presence.userId);
  if (seat < 0) return;
  const seats = seatsMessage(state);
  const msg: WelcomeMessage = {
    seats: seats.seats,
    host: seats.host,
    started: seats.started,
    vote: seats.vote,
    seat: seat,
    code: state.code,
    seq: state.game ? state.game.moveCount : 0,
    view: state.game ? view(state.game, seat) : null,
    deadline: running(state) ? state.turnEndsAt : 0,
    now: Date.now(),
  };
  send(dispatcher, OP_WELCOME, msg, presence);
}

/** Tells whoever is playing the seat to move that it is their turn. */
function sendPrompt(dispatcher: Dispatcher, state: TableState): void {
  const game = state.game;
  if (!game || game.over) return;
  const seat = state.seats[game.turn] as Seat;
  const p = seat.bot ? seat.botPresence : seat.presence;
  if (p) send(dispatcher, OP_PROMPT, { legal: view(game, game.turn).legal, deadline: state.turnEndsAt, now: Date.now() }, p);
}

function broadcastSeats(dispatcher: Dispatcher, state: TableState): void {
  dispatcher.broadcastMessage(OP_SEATS, JSON.stringify(seatsMessage(state)), null, null, true);
}

function reject(dispatcher: Dispatcher, presence: nkruntime.Presence, reason: string): void {
  send(dispatcher, OP_REJECTED, { reason: reason }, presence);
}

/** Sends to one player only: views are never broadcast. */
function send(dispatcher: Dispatcher, opCode: number, body: object, presence: nkruntime.Presence): void {
  dispatcher.broadcastMessage(opCode, JSON.stringify(body), [presence], null, true);
}

function seatsMessage(state: TableState): SeatsMessage {
  const seats: SeatsMessage['seats'] = [];
  for (let s = 0; s < SEATS; s++) {
    const st = state.seats[s];
    seats.push(st ? { name: st.name, connected: !!st.presence, bot: st.bot } : null);
  }
  const v = state.vote;
  return {
    seats: seats,
    host: state.host,
    started: !!state.game,
    vote: v ? { from: v.from, voters: v.voters.slice(), agreed: v.agreed.slice() } : null,
  };
}

/* ------------------------------------------------------------ helpers */

function newSeat(userId: string, name: string, tick: number): Seat {
  return { userId: userId, name: name, presence: null, reservedAt: tick, joined: false, skips: 0, bot: false, botUserId: '', botPresence: null };
}

function running(state: TableState): boolean {
  return !!state.game && !state.game.over;
}

/** Seat owned by this user. */
function ownSeat(state: TableState, userId: string): number {
  for (let s = 0; s < SEATS; s++) {
    const st = state.seats[s];
    if (st && st.userId && st.userId === userId) return s;
  }
  return -1;
}

/** Seat this user is playing as a bot. */
function botSeat(state: TableState, userId: string): number {
  for (let s = 0; s < SEATS; s++) {
    const st = state.seats[s];
    if (st && st.bot && st.botUserId && st.botUserId === userId) return s;
  }
  return -1;
}

/** Everyone who should see this seat's view: its owner, and the bot playing it. */
function watchers(state: TableState, s: number): nkruntime.Presence[] {
  const seat = state.seats[s];
  const out: nkruntime.Presence[] = [];
  if (seat && seat.presence) out.push(seat.presence);
  if (seat && seat.bot && seat.botPresence) out.push(seat.botPresence);
  return out;
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
  for (let s = 0; s < SEATS; s++) if (presenceAt(state, s)) players++;
  return JSON.stringify({ code: state.code, players: players, playing: running(state) });
}

function cleanName(value: unknown, seat: number): string {
  const name = String(value || '')
    .replace(/[\u0000-\u001f<>&"]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^ | $/g, '')
    .slice(0, 16);
  return name || 'Player ' + (seat + 1);
}

function indexOf(list: (number | string)[], value: number | string): number {
  for (let i = 0; i < list.length; i++) if (list[i] === value) return i;
  return -1;
}

function parse(payload: string): any {
  try {
    return JSON.parse(payload || '{}');
  } catch (e) {
    return null;
  }
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
