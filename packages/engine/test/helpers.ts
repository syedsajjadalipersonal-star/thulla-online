import {
  apply,
  Card,
  legalCards,
  seededRandom,
  setup,
  ThullaEvent,
  ThullaState,
  TrickPlay,
} from '@thulla/engine';

export interface PlayedGame {
  seed: string;
  moves: { seat: number; card: Card }[];
  states: ThullaState[];
  events: ThullaEvent[][];
}

/** Play a whole game with random legal moves chosen from a seeded random source. */
export function playRandomGame(seed: string, check?: (s: ThullaState) => void): PlayedGame {
  const random = seededRandom('moves:' + seed);
  let state = setup(seed);
  const game: PlayedGame = { seed, moves: [], states: [state], events: [] };
  check?.(state);
  for (let guard = 0; !state.over; guard++) {
    if (guard > 5000) throw new Error('game did not finish: ' + seed);
    const seat = state.turn;
    const legal = legalCards(state, seat);
    const card = legal[Math.floor(random() * legal.length)];
    const r = apply(state, seat, { type: 'play', card });
    game.moves.push({ seat, card });
    game.events.push(r.events);
    state = r.state;
    game.states.push(state);
    check?.(state);
  }
  return game;
}

/** Build a state by hand for rule tests. Hands are sorted for you. */
export function makeState(hands: Card[][], leader: number, opts: Partial<ThullaState> = {}): ThullaState {
  const sorted = hands.map((h) => h.slice().sort((a, b) => a - b));
  const parts: number[] = [];
  for (let k = 0; k < 4; k++) {
    const s = (leader + k) % 4;
    if (sorted[s].length) parts.push(s);
  }
  return {
    version: 1,
    seed: 'hand-made',
    hands: sorted,
    known: [[], [], [], []],
    voids: [0, 1, 2, 3].map(() => [false, false, false, false]),
    pile: [],
    trick: [] as TrickPlay[],
    lead: -1,
    parts,
    turn: leader,
    firstTrick: false,
    finished: [],
    loser: -1,
    over: false,
    moveCount: 0,
    ...opts,
  };
}

/** Every card is in exactly one place: a hand, the pile, or the current trick. */
export function assertCardsAccountedFor(s: ThullaState): void {
  const seen = new Array<number>(52).fill(0);
  for (const h of s.hands) for (const c of h) seen[c]++;
  for (const c of s.pile) seen[c]++;
  for (const t of s.trick) seen[t.card]++;
  for (let c = 0; c < 52; c++) {
    if (seen[c] !== 1) throw new Error(`card ${c} appears ${seen[c]} times after move ${s.moveCount}`);
  }
  for (let p = 0; p < 4; p++) {
    for (const c of s.known[p]) {
      if (s.hands[p].indexOf(c) < 0) throw new Error(`known card ${c} is not in seat ${p}'s hand`);
    }
  }
}
