/**
 * Thulla rules as a pure state machine.
 *
 *   setup(seed)                  -> a dealt game
 *   pending(state)               -> whose turn it is, or null when the game is over
 *   legalActions(state, seat)    -> the moves that seat may make now
 *   apply(state, seat, action)   -> the next state plus events describing what happened
 *   view(state, seat)            -> what one seat is allowed to see
 *
 * No timers, no screen code, no hidden randomness: the same seed and the same
 * actions always produce the same game. `apply` never changes its input.
 *
 * This file must stay ES5-safe because Nakama runs it in its JavaScript runtime:
 * no Set/Map, Array.prototype.find/includes/fill, Object.assign, or other ES2015
 * built-ins. `npm run check:es5` enforces this.
 */
import { ACE_OF_SPADES, Card, cardName, isCard, rankOf, suitOf } from './cards';
import { seededRandom, shuffle } from './rng';

export const SEATS = 4;

export interface TrickPlay {
  seat: number;
  card: Card;
}

export interface ThullaState {
  version: 1;
  seed: string;
  /** Cards in each seat's hand, sorted ascending. Secret: never sent to clients whole. */
  hands: Card[][];
  /** Cards in each hand that every player knows about, because they were picked up after a thulla. */
  known: Card[][];
  /** voids[seat][suit] = true once that seat has failed to follow that suit. Public. */
  voids: boolean[][];
  /** Cards that have gone to the discard pile, in order. Public. */
  pile: Card[];
  /** Cards played so far in the current trick. Public. */
  trick: TrickPlay[];
  /** Suit led in the current trick, or -1 before the lead. */
  lead: number;
  /** Seats taking part in the current trick, in playing order. */
  parts: number[];
  /** Seat whose move is awaited, or -1 when the game is over. */
  turn: number;
  /** True during the opening trick, when off-suit cards are discards rather than thullas. */
  firstTrick: boolean;
  /** Seats that emptied their hands, in the order they did. */
  finished: number[];
  /** The losing seat once the game is over; -1 if everyone went out together or the game is still running. */
  loser: number;
  over: boolean;
  /** Number of moves applied so far. */
  moveCount: number;
}

export interface PlayAction {
  type: 'play';
  card: Card;
}

export type ThullaAction = PlayAction;

export type ThullaEvent =
  | { type: 'played'; seat: number; card: Card; offSuit: boolean }
  | { type: 'trickToPile'; cards: TrickPlay[]; top: number }
  | { type: 'pickup'; seat: number; cutter: number; cards: TrickPlay[] }
  | { type: 'safe'; seat: number; place: number }
  | { type: 'lead'; seat: number }
  | { type: 'gameOver'; loser: number; order: number[] };

export interface ApplyResult {
  state: ThullaState;
  events: ThullaEvent[];
}

/** Everything one seat may see. Built only from that seat's hand and public facts. */
export interface ThullaView {
  seat: number;
  hand: Card[];
  handSizes: number[];
  known: Card[][];
  voids: boolean[][];
  pile: Card[];
  trick: TrickPlay[];
  lead: number;
  parts: number[];
  turn: number;
  firstTrick: boolean;
  finished: number[];
  loser: number;
  over: boolean;
  moveCount: number;
  /** Cards this seat may play now; empty when it is not this seat's turn. */
  legal: Card[];
}

/** Thrown by `apply` for a move that `checkAction` rejects. `code` is always 'illegal_move'. */
export interface IllegalMoveError extends Error {
  code: 'illegal_move';
  reason: string;
}

export function isIllegalMoveError(error: unknown): error is IllegalMoveError {
  return !!error && (error as IllegalMoveError).code === 'illegal_move';
}

function illegalMove(reason: string): IllegalMoveError {
  const error = new Error(reason) as IllegalMoveError;
  error.code = 'illegal_move';
  error.reason = reason;
  return error;
}

/* ---------------------------------------------------------------- setup */

export function setup(seed: string): ThullaState {
  const deck: Card[] = [];
  for (let c = 0; c < 52; c++) deck.push(c);
  shuffle(deck, seededRandom(seed));

  const hands: Card[][] = [[], [], [], []];
  for (let i = 0; i < deck.length; i++) hands[i % SEATS].push(deck[i]);
  for (let s = 0; s < SEATS; s++) sortCards(hands[s]);

  let opener = 0;
  for (let s = 0; s < SEATS; s++) if (indexOf(hands[s], ACE_OF_SPADES) >= 0) opener = s;

  const state: ThullaState = {
    version: 1,
    seed: seed,
    hands: hands,
    known: [[], [], [], []],
    voids: [newVoids(), newVoids(), newVoids(), newVoids()],
    pile: [],
    trick: [],
    lead: -1,
    parts: [],
    turn: opener,
    firstTrick: true,
    finished: [],
    loser: -1,
    over: false,
    moveCount: 0,
  };
  startTrick(state, opener);
  return state;
}

/* -------------------------------------------------------------- queries */

export function pending(state: ThullaState): { seat: number; kind: 'play' } | null {
  if (state.over) return null;
  return { seat: state.turn, kind: 'play' };
}

/** The cards `seat` may play now. Empty when it is not that seat's turn. */
export function legalCards(state: ThullaState, seat: number): Card[] {
  if (state.over || seat !== state.turn) return [];
  const hand = state.hands[seat];
  if (state.firstTrick && state.trick.length === 0) {
    return indexOf(hand, ACE_OF_SPADES) >= 0 ? [ACE_OF_SPADES] : hand.slice();
  }
  if (state.lead < 0) return hand.slice();
  const follow: Card[] = [];
  for (let i = 0; i < hand.length; i++) if (suitOf(hand[i]) === state.lead) follow.push(hand[i]);
  return follow.length ? follow : hand.slice();
}

export function legalActions(state: ThullaState, seat: number): ThullaAction[] {
  const cards = legalCards(state, seat);
  const actions: ThullaAction[] = [];
  for (let i = 0; i < cards.length; i++) actions.push({ type: 'play', card: cards[i] });
  return actions;
}

/** Why a move is not allowed, or null if it is. */
export function checkAction(state: ThullaState, seat: number, action: unknown): string | null {
  if (state.over) return 'The game is over.';
  if (seat !== state.turn) return 'It is not your turn.';
  const a = action as PlayAction;
  if (!a || a.type !== 'play' || !isCard(a.card)) return 'That is not a valid move.';
  if (indexOf(state.hands[seat], a.card) < 0) return 'That card is not in your hand.';
  if (indexOf(legalCards(state, seat), a.card) < 0) {
    if (state.firstTrick && state.trick.length === 0) return 'The first card must be the ace of spades.';
    return 'You must follow suit with ' + suitWord(state.lead) + '.';
  }
  return null;
}

/* ---------------------------------------------------------------- apply */

export function apply(previous: ThullaState, seat: number, action: ThullaAction): ApplyResult {
  const problem = checkAction(previous, seat, action);
  if (problem) throw illegalMove(problem);

  const state = cloneState(previous);
  const events: ThullaEvent[] = [];
  const card = action.card;

  removeCard(state.hands[seat], card);
  removeCard(state.known[seat], card);
  state.trick.push({ seat: seat, card: card });
  state.moveCount++;

  let offSuit = false;
  let thulla = false;
  if (state.lead < 0) {
    state.lead = suitOf(card);
  } else if (suitOf(card) !== state.lead) {
    offSuit = true;
    state.voids[seat][state.lead] = true;
    if (!state.firstTrick) thulla = true;
  }
  events.push({ type: 'played', seat: seat, card: card, offSuit: offSuit });

  if (thulla || state.trick.length === state.parts.length) {
    resolveTrick(state, thulla, events);
  } else {
    state.turn = state.parts[state.trick.length];
  }
  return { state: state, events: events };
}

function resolveTrick(state: ThullaState, thulla: boolean, events: ThullaEvent[]): void {
  const top = topOfTrick(state);
  const cards = state.trick.slice();
  if (thulla) {
    const cutter = cards[cards.length - 1].seat;
    for (let i = 0; i < cards.length; i++) {
      state.hands[top].push(cards[i].card);
      state.known[top].push(cards[i].card);
    }
    sortCards(state.hands[top]);
    sortCards(state.known[top]);
    events.push({ type: 'pickup', seat: top, cutter: cutter, cards: cards });
  } else {
    for (let i = 0; i < cards.length; i++) state.pile.push(cards[i].card);
    events.push({ type: 'trickToPile', cards: cards, top: top });
  }
  state.firstTrick = false;
  state.trick = [];
  state.lead = -1;

  for (let s = 0; s < SEATS; s++) {
    if (state.hands[s].length === 0 && indexOf(state.finished, s) < 0) {
      state.finished.push(s);
      events.push({ type: 'safe', seat: s, place: state.finished.length });
    }
  }

  const remaining: number[] = [];
  for (let s = 0; s < SEATS; s++) if (state.hands[s].length > 0) remaining.push(s);
  if (remaining.length <= 1) {
    state.over = true;
    state.turn = -1;
    state.parts = [];
    state.loser = remaining.length ? remaining[0] : -1;
    events.push({ type: 'gameOver', loser: state.loser, order: state.finished.slice() });
    return;
  }

  let leader = top;
  if (state.hands[leader].length === 0) {
    for (let k = 1; k < SEATS; k++) {
      const q = (top + k) % SEATS;
      if (state.hands[q].length > 0) {
        leader = q;
        break;
      }
    }
  }
  startTrick(state, leader);
  events.push({ type: 'lead', seat: leader });
}

/* ----------------------------------------------------------------- view */

export function view(state: ThullaState, seat: number): ThullaView {
  const handSizes: number[] = [];
  for (let s = 0; s < SEATS; s++) handSizes.push(state.hands[s].length);
  return {
    seat: seat,
    hand: state.hands[seat].slice(),
    handSizes: handSizes,
    known: copyGrid(state.known),
    voids: copyGrid(state.voids),
    pile: state.pile.slice(),
    trick: copyTrick(state.trick),
    lead: state.lead,
    parts: state.parts.slice(),
    turn: state.turn,
    firstTrick: state.firstTrick,
    finished: state.finished.slice(),
    loser: state.loser,
    over: state.over,
    moveCount: state.moveCount,
    legal: legalCards(state, seat),
  };
}

/** The seat whose lead-suit card is currently highest in the trick. */
export function topOfTrick(state: { trick: TrickPlay[]; lead: number }): number {
  let best = -1;
  let bestRank = -1;
  for (let i = 0; i < state.trick.length; i++) {
    const t = state.trick[i];
    if (suitOf(t.card) === state.lead && rankOf(t.card) > bestRank) {
      bestRank = rankOf(t.card);
      best = t.seat;
    }
  }
  return best;
}

/** Play out a whole game from a seed and a list of moves (used for replays and tests). */
export function replay(seed: string, moves: { seat: number; card: Card }[]): ApplyResult[] {
  let state = setup(seed);
  const results: ApplyResult[] = [];
  for (let i = 0; i < moves.length; i++) {
    const r = apply(state, moves[i].seat, { type: 'play', card: moves[i].card });
    results.push(r);
    state = r.state;
  }
  return results;
}

/* -------------------------------------------------------------- helpers */

function startTrick(state: ThullaState, leader: number): void {
  const parts: number[] = [];
  for (let k = 0; k < SEATS; k++) {
    const s = (leader + k) % SEATS;
    if (state.hands[s].length > 0) parts.push(s);
  }
  state.parts = parts;
  state.turn = leader;
  state.trick = [];
  state.lead = -1;
}

export function cloneState(state: ThullaState): ThullaState {
  return JSON.parse(JSON.stringify(state)) as ThullaState;
}

function sortCards(cards: Card[]): void {
  cards.sort(function (a, b) {
    return a - b;
  });
}

function indexOf(cards: Card[] | number[], value: number): number {
  for (let i = 0; i < cards.length; i++) if (cards[i] === value) return i;
  return -1;
}

function removeCard(cards: Card[], card: Card): void {
  const i = indexOf(cards, card);
  if (i >= 0) cards.splice(i, 1);
}

function newVoids(): boolean[] {
  return [false, false, false, false];
}

function copyGrid<T>(grid: T[][]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < grid.length; i++) out.push(grid[i].slice());
  return out;
}

function copyTrick(trick: TrickPlay[]): TrickPlay[] {
  const out: TrickPlay[] = [];
  for (let i = 0; i < trick.length; i++) out.push({ seat: trick[i].seat, card: trick[i].card });
  return out;
}

function suitWord(suit: number): string {
  return ['spades', 'hearts', 'diamonds', 'clubs'][suit] || 'the led suit';
}

export { cardName };
