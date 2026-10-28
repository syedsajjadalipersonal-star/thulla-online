/**
 * The Thulla bot.
 *
 * It sees exactly what a person in its seat would see (a ThullaView): its own hand,
 * the discard pile, the current trick, which cards others picked up after a thulla,
 * and which suits each player has run out of. It never sees other hands.
 *
 * To choose a card it repeatedly deals the unseen cards in ways that fit everything
 * it knows, plays each candidate card to the end of the game with a tactical policy,
 * and picks the card that leaves it safe most often (Monte Carlo search).
 *
 * This runs in Node.js and browsers (it uses Set and performance.now), not in Nakama.
 * Internally a trick is a flat array [seat, card, seat, card, ...] for speed.
 */
import { ACE_OF_SPADES, Card, rankOf, suitOf, ThullaView } from '@thulla/engine';

export interface BotOptions {
  /** Thinking time budget in milliseconds. */
  ms?: number;
  /** Maximum number of sampled deals. */
  samples?: number;
  /** Always sample at least this many deals, even past the time budget. */
  minSamples?: number;
  /** Random source, so tests can be repeatable. Defaults to Math.random. */
  random?: () => number;
}

/** Tactical weights, found by self-play tuning in the single-player version. */
export const TUNE = {
  topApprox: true,
  topCheck: true,
  leadAll: true,
  safeLow: false,
  overMax: false,
  bossW: 9,
  shortW: 6,
  passBonus: 0,
  dumpLeadW: 1.5,
};
const PICK_PENALTY = 0.04;

type Hands = Card[][];
type FlatTrick = number[];

const now: () => number =
  typeof performance !== 'undefined' && performance.now ? () => performance.now() : () => Date.now();

function hasSuit(h: Card[], s: number): boolean {
  for (let i = 0; i < h.length; i++) if (suitOf(h[i]) === s) return true;
  return false;
}

function shuffleInPlace<T>(a: T[], random: () => number): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/* ------------- tactical policy used for every player inside simulations ------------- */

/** How much p wants to get rid of card c when giving a thulla or discarding. */
function dumpScore(hands: Hands, p: number, c: Card, cnt: number[]): number {
  const s = suitOf(c);
  const r = rankOf(c);
  let higherOut = 0;
  for (let q = 0; q < 4; q++) {
    if (q === p) continue;
    for (const x of hands[q]) if (suitOf(x) === s && x > c) higherOut++;
  }
  return (
    r +
    (higherOut === 0 ? TUNE.bossW : higherOut === 1 ? TUNE.bossW * 0.45 : 0) +
    (cnt[s] === 1 ? TUNE.shortW : cnt[s] === 2 ? TUNE.shortW / 3 : 0)
  );
}

function followPick(hands: Hands, p: number, trick: FlatTrick, lead: number, first: boolean, parts: number[]): Card {
  const h = hands[p];
  const pos = trick.length / 2;
  let curMax = 0;
  for (let i = 1; i < trick.length; i += 2) {
    const c = trick[i];
    if (suitOf(c) === lead && rankOf(c) > curMax) curMax = rankOf(c);
  }
  let maxF = -1;
  let minF = -1;
  let maxBelow = -1;
  for (const c of h) {
    if (suitOf(c) !== lead) continue;
    if (maxF < 0 || c > maxF) maxF = c;
    if (minF < 0 || c < minF) minF = c;
    if (rankOf(c) < curMax && (maxBelow < 0 || c > maxBelow)) maxBelow = c;
  }
  if (maxF < 0) {
    // Void: thulla (or first-round discard) with the most dangerous card.
    const cnt = [0, 0, 0, 0];
    for (const c of h) cnt[suitOf(c)]++;
    let best = h[0];
    let bs = -1;
    for (const c of h) {
      const sc = dumpScore(hands, p, c, cnt);
      if (sc > bs) {
        bs = sc;
        best = c;
      }
    }
    return best;
  }
  let cutComing = false;
  if (!first) {
    for (let k = pos + 1; k < parts.length; k++) {
      if (!hasSuit(hands[parts[k]], lead)) {
        cutComing = true;
        break;
      }
    }
  }
  if (!cutComing) {
    // The trick goes to the pile: shed the biggest card, unless that leaves only dangerous leads.
    if (TUNE.topCheck) {
      let laterMax = 0;
      for (let k = pos + 1; k < parts.length; k++) {
        for (const x of hands[parts[k]]) if (suitOf(x) === lead && rankOf(x) > laterMax) laterMax = rankOf(x);
      }
      const bar = Math.max(curMax, laterMax);
      if (rankOf(maxF) > bar) {
        const idx = h.indexOf(maxF);
        h.splice(idx, 1);
        let safe = false;
        if (h.length === 0) safe = true;
        else if (TUNE.topApprox) {
          for (let s = 0; s < 4 && !safe; s++) {
            if (!hasSuit(h, s)) continue;
            let ok = true;
            for (let q = 0; q < 4 && ok; q++) {
              if (q === p || !hands[q].length) continue;
              if (!hasSuit(hands[q], s)) ok = false;
            }
            if (ok) safe = true;
          }
        } else {
          const np = [p];
          for (let k = 1; k < 4; k++) {
            const q = (p + k) % 4;
            if (hands[q].length) np.push(q);
          }
          for (let s = 0; s < 4 && !safe; s++) {
            let lo = -1;
            for (const x of h) if (suitOf(x) === s && (lo < 0 || x < lo)) lo = x;
            if (lo >= 0 && leadCost(hands, p, lo, np).cost === 0) safe = true;
          }
        }
        h.splice(idx, 0, maxF);
        if (!safe) {
          let alt = -1;
          for (const x of h) if (suitOf(x) === lead && rankOf(x) < bar && (alt < 0 || x > alt)) alt = x;
          if (alt >= 0) return alt;
        }
      }
    }
    return maxF;
  }
  return maxBelow >= 0 ? maxBelow : TUNE.overMax ? maxF : minF;
}

/** Cards p would pick up if p led c now (one-trick lookahead). */
function leadCost(hands: Hands, p: number, c: Card, parts: number[]): { cost: number; top: number } {
  const h = hands[p];
  const idx = h.indexOf(c);
  h.splice(idx, 1);
  const trick: FlatTrick = [p, c];
  const lead = suitOf(c);
  let cut = false;
  const removed: number[] = [];
  for (let k = 1; k < parts.length; k++) {
    const q = parts[k];
    const x = followPick(hands, q, trick, lead, false, parts);
    const hq = hands[q];
    hq.splice(hq.indexOf(x), 1);
    removed.push(q, x);
    trick.push(q, x);
    if (suitOf(x) !== lead) {
      cut = true;
      break;
    }
  }
  for (let i = 0; i < removed.length; i += 2) hands[removed[i]].push(removed[i + 1]);
  h.splice(idx, 0, c);
  if (!cut) return { cost: 0, top: -1 };
  let top = -1;
  let tr = -1;
  for (let i = 0; i < trick.length; i += 2) {
    const y = trick[i + 1];
    if (suitOf(y) === lead && rankOf(y) > tr) {
      tr = rankOf(y);
      top = trick[i];
    }
  }
  return { cost: top === p ? trick.length / 2 : 0, top };
}

function leadPick(hands: Hands, p: number, parts: number[]): Card {
  const h = hands[p];
  const lo = [-1, -1, -1, -1];
  const hi = [-1, -1, -1, -1];
  const cnt = [0, 0, 0, 0];
  for (const c of h) {
    const s = suitOf(c);
    cnt[s]++;
    if (lo[s] < 0 || c < lo[s]) lo[s] = c;
    if (hi[s] < 0 || c > hi[s]) hi[s] = c;
  }
  let best = -1;
  let bestKey = -1e9;
  for (let s = 0; s < 4; s++) {
    if (!cnt[s]) continue;
    const cands = TUNE.leadAll ? h.filter((x) => suitOf(x) === s) : lo[s] === hi[s] ? [lo[s]] : [lo[s], hi[s]];
    for (const c of cands) {
      const r = leadCost(hands, p, c, parts);
      let key = -r.cost * 20;
      if (r.top >= 0 && r.top !== p) key += TUNE.passBonus;
      if (r.cost === 0) key += TUNE.safeLow ? -rankOf(c) * 0.6 : dumpScore(hands, p, c, cnt) * TUNE.dumpLeadW;
      else key -= rankOf(c) * 0.1;
      if (key > bestKey) {
        bestKey = key;
        best = c;
      }
    }
  }
  return best;
}

function rolloutPick(hands: Hands, p: number, trick: FlatTrick, lead: number, first: boolean, parts: number[]): Card {
  if (trick.length === 0) {
    const h = hands[p];
    if (first) return h.indexOf(ACE_OF_SPADES) >= 0 ? ACE_OF_SPADES : h[0];
    return leadPick(hands, p, parts);
  }
  return followPick(hands, p, trick, lead, first, parts);
}

export function legalFrom(hand: Card[], lead: number, first: boolean, trickLen: number): Card[] {
  if (first && trickLen === 0) return hand.indexOf(ACE_OF_SPADES) >= 0 ? [ACE_OF_SPADES] : hand.slice();
  if (lead < 0) return hand.slice();
  const f = hand.filter((c) => suitOf(c) === lead);
  return f.length ? f : hand.slice();
}

/* ------------------------------------- playouts ------------------------------------- */

/** Score for `me` at the end of a playout: safe early beats safe late beats losing. */
function settle(hands: Hands, me: number, outCount: number, picked: number): number | null {
  if (hands[me].length === 0) return 1 - 0.06 * outCount - PICK_PENALTY * picked;
  let rem = 0;
  for (let q = 0; q < 4; q++) if (hands[q].length) rem++;
  if (rem <= 1) return 0;
  return null;
}

function rollout(
  hands: Hands,
  trick: FlatTrick,
  lead: number,
  parts: number[],
  first: boolean,
  me: number,
  outCount: number,
): number {
  let tricks = 0;
  let picked = 0;
  for (;;) {
    let thulla = false;
    while (trick.length / 2 < parts.length) {
      const p = parts[trick.length / 2];
      const c = rolloutPick(hands, p, trick, lead, first, parts);
      const h = hands[p];
      h.splice(h.indexOf(c), 1);
      trick.push(p, c);
      if (lead < 0) lead = suitOf(c);
      else if (suitOf(c) !== lead && !first) {
        thulla = true;
        break;
      }
    }
    let top = -1;
    let tr = -1;
    for (let i = 0; i < trick.length; i += 2) {
      const c = trick[i + 1];
      if (suitOf(c) === lead && rankOf(c) > tr) {
        tr = rankOf(c);
        top = trick[i];
      }
    }
    if (thulla) {
      for (let i = 1; i < trick.length; i += 2) hands[top].push(trick[i]);
      if (top === me) picked += trick.length / 2;
    }
    first = false;
    const val = settle(hands, me, outCount, picked);
    if (val !== null) return val;
    let rem = 0;
    for (let q = 0; q < 4; q++) if (hands[q].length) rem++;
    outCount = 4 - rem;
    let leader = top;
    if (!hands[leader].length) {
      for (let k = 1; k < 4; k++) {
        const q = (top + k) % 4;
        if (hands[q].length) {
          leader = q;
          break;
        }
      }
    }
    parts = [];
    for (let k = 0; k < 4; k++) {
      const q = (leader + k) % 4;
      if (hands[q].length) parts.push(q);
    }
    trick = [];
    lead = -1;
    if (++tricks > 120) {
      let bigger = 0;
      for (let q = 0; q < 4; q++) if (q !== me && hands[q].length > hands[me].length) bigger++;
      return bigger > 0 ? 0.7 : 0.2;
    }
  }
}

/* ---------------------------- dealing what the bot cannot see ---------------------------- */

interface Knowledge {
  me: number;
  myHand: Card[];
  sizes: number[];
  known: Card[][];
  voids: boolean[][];
  gone: Set<Card>;
}

function knowledgeFrom(v: ThullaView): Knowledge {
  const gone = new Set<Card>(v.pile);
  for (const t of v.trick) gone.add(t.card);
  return { me: v.seat, myHand: v.hand.slice(), sizes: v.handSizes.slice(), known: v.known, voids: v.voids, gone };
}

/** A random deal of the unseen cards that fits everything the bot knows. */
function sampleHands(k: Knowledge, random: () => number): Hands | null {
  const b = k.me;
  const hands: Hands = [[], [], [], []];
  hands[b] = k.myHand.slice();
  const taken = new Set<Card>(k.gone);
  for (const c of k.myHand) taken.add(c);
  for (let q = 0; q < 4; q++) if (q !== b) for (const c of k.known[q]) taken.add(c);
  const pool: Card[] = [];
  for (let c = 0; c < 52; c++) if (!taken.has(c)) pool.push(c);
  const others: { q: number; need: number }[] = [];
  for (let q = 0; q < 4; q++) {
    if (q === b) continue;
    hands[q] = k.known[q].slice();
    const need = k.sizes[q] - k.known[q].length;
    if (need > 0) others.push({ q, need });
  }
  others.sort((a, c) => k.voids[c.q].filter(Boolean).length - k.voids[a.q].filter(Boolean).length);
  for (let attempt = 0; attempt < 40; attempt++) {
    const relax = attempt >= 30;
    shuffleInPlace(pool, random);
    const used = new Uint8Array(pool.length);
    const out: { [q: number]: Card[] } = {};
    let ok = true;
    for (const o of others) {
      const got: Card[] = [];
      for (let i = 0; i < pool.length && got.length < o.need; i++) {
        if (used[i]) continue;
        const c = pool[i];
        if (!relax && k.voids[o.q][suitOf(c)]) continue;
        used[i] = 1;
        got.push(c);
      }
      if (got.length < o.need) {
        ok = false;
        break;
      }
      out[o.q] = got;
    }
    if (ok) {
      for (const o of others) hands[o.q] = hands[o.q].concat(out[o.q]);
      return hands;
    }
  }
  return null;
}

/* ----------------------------------------- choose ----------------------------------------- */

/**
 * Choose a card for the seat described by `v`. `v.legal` must be non-empty
 * (it is the bot's turn). Always returns one of `v.legal`.
 */
export function chooseCard(v: ThullaView, opts: BotOptions = {}): Card {
  const legal = v.legal;
  if (!legal.length) throw new Error('chooseCard called when it is not this seat’s turn');
  if (legal.length === 1) return legal[0];
  const random = opts.random || Math.random;
  const k = knowledgeFrom(v);
  const b = v.seat;
  const flatTrick: FlatTrick = [];
  for (const t of v.trick) flatTrick.push(t.seat, t.card);
  const lead = v.lead;
  const first = v.firstTrick;
  const parts = v.parts;

  // Treat cards with no unseen card between them as one choice.
  const moves: Card[] = [];
  const bySuit: Card[][] = [[], [], [], []];
  for (const c of legal) bySuit[suitOf(c)].push(c);
  for (const arr of bySuit) {
    arr.sort((x, y) => x - y);
    let prev = -1;
    for (const c of arr) {
      if (prev >= 0) {
        let gap = false;
        for (let x = prev + 1; x < c; x++) {
          if (!k.gone.has(x) && k.myHand.indexOf(x) < 0) {
            gap = true;
            break;
          }
        }
        if (!gap) {
          moves[moves.length - 1] = c;
          prev = c;
          continue;
        }
      }
      moves.push(c);
      prev = c;
    }
  }
  if (moves.length === 1) return moves[0];

  const budget = opts.ms ?? 350;
  const maxS = opts.samples ?? 500;
  const minS = opts.minSamples ?? 40;
  const outCount = v.finished.length;
  const score = new Array<number>(moves.length).fill(0);
  let n = 0;
  const t0 = now();
  while (n < maxS && (n < minS || now() - t0 < budget)) {
    const deal = sampleHands(k, random);
    if (!deal) break;
    for (let m = 0; m < moves.length; m++) {
      const hands: Hands = [deal[0].slice(), deal[1].slice(), deal[2].slice(), deal[3].slice()];
      const c = moves[m];
      hands[b].splice(hands[b].indexOf(c), 1);
      const trick = flatTrick.slice();
      trick.push(b, c);
      const leadNow = lead < 0 ? suitOf(c) : lead;
      let r: number | null;
      if (suitOf(c) !== leadNow && !first) {
        // A thulla ends the trick at once.
        let top = -1;
        let tr = -1;
        for (let i = 0; i < trick.length; i += 2) {
          const y = trick[i + 1];
          if (suitOf(y) === leadNow && rankOf(y) > tr) {
            tr = rankOf(y);
            top = trick[i];
          }
        }
        for (let i = 1; i < trick.length; i += 2) hands[top].push(trick[i]);
        r = settle(hands, b, outCount, 0);
        if (r === null) {
          let rem = 0;
          for (let q = 0; q < 4; q++) if (hands[q].length) rem++;
          const np: number[] = [];
          for (let j = 0; j < 4; j++) {
            const q = (top + j) % 4;
            if (hands[q].length) np.push(q);
          }
          r = rollout(hands, [], -1, np, false, b, 4 - rem);
        }
      } else {
        r = rollout(hands, trick, leadNow, parts.slice(), first, b, outCount);
      }
      score[m] += r;
    }
    n++;
  }

  // The tactical choice breaks near-ties.
  let tactical = -1;
  const tmp = sampleHands(k, random);
  if (tmp) tactical = rolloutPick(tmp, b, flatTrick, lead, first, parts);
  let best = 0;
  for (let m = 1; m < moves.length; m++) if (score[m] > score[best]) best = m;
  const ti = moves.indexOf(tactical);
  if (ti >= 0 && n > 0 && (score[best] - score[ti]) / n < 0.01) return moves[ti];
  return moves[best];
}

/** The fast tactical choice alone, without search. Useful as a fallback and in tests. */
export function quickCard(v: ThullaView, random: () => number = Math.random): Card {
  if (v.legal.length === 1) return v.legal[0];
  const k = knowledgeFrom(v);
  const deal = sampleHands(k, random);
  if (!deal) return v.legal[v.legal.length - 1];
  const flatTrick: FlatTrick = [];
  for (const t of v.trick) flatTrick.push(t.seat, t.card);
  const c = rolloutPick(deal, v.seat, flatTrick, v.lead, v.firstTrick, v.parts);
  return v.legal.indexOf(c) >= 0 ? c : v.legal[v.legal.length - 1];
}


