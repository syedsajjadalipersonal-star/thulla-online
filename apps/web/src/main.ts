/**
 * Single-player Thulla table: you against three bots.
 *
 * The rules live in @thulla/engine. This file only keeps the committed game state,
 * asks the engine what happened after each move, and turns the events into
 * messages, pauses and animations.
 */
import {
  apply,
  Card,
  cardName,
  cloneState,
  rankOf,
  setup,
  suitOf,
  ThullaEvent,
  ThullaState,
  topOfTrick,
  view,
} from '@thulla/engine';
import { chooseCard, quickCard, type BotOptions } from '@thulla/bot';
import { CardArt } from './cardArt';

declare const BOT_WORKER_SOURCE: string;

const NAMES = ['You', 'Bilal', 'Hina', 'Zara'];
const PLACE = ['1st', '2nd', '3rd'];
const DISPLAY_ORDER = [0, 1, 3, 2]; // spades, hearts, clubs, diamonds: colours alternate

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const nm = (p: number) => (p === 0 ? 'You' : NAMES[p]);
const B = (p: number) => (p === 0 ? '<b>You</b>' : '<b>' + NAMES[p] + '</b>');

/* ---------------------------------------------------------------- state */

interface Pause {
  /** What the table shows while the finished trick is on display. */
  shown: ThullaState;
  /** Seat with the highest card, highlighted during the pause. */
  top: number;
}

let game: ThullaState;
let pause: Pause | null = null;
let msg = '';
let thinking = false;
let speed = 1;
let gameId = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function loadTally(): { played: number; lost: number } {
  try {
    return JSON.parse(localStorage.getItem('thulla-tally') || '') || { played: 0, lost: 0 };
  } catch {
    return { played: 0, lost: 0 };
  }
}
function saveTally(t: { played: number; lost: number }) {
  try {
    localStorage.setItem('thulla-tally', JSON.stringify(t));
  } catch {
    /* private mode */
  }
}

function newSeed(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/* ----------------------------------------------------------------- bots */

let worker: Worker | null = null;
let requestId = 0;
const waiting = new Map<number, (card: number) => void>();
try {
  const url = URL.createObjectURL(new Blob([BOT_WORKER_SOURCE], { type: 'text/javascript' }));
  worker = new Worker(url);
  worker.onmessage = (e: MessageEvent<{ id: number; card: number }>) => {
    const done = waiting.get(e.data.id);
    if (done) {
      waiting.delete(e.data.id);
      done(e.data.card);
    }
  };
  worker.onerror = () => {
    worker = null;
  };
} catch {
  worker = null;
}

function think(seat: number, opts: BotOptions): Promise<Card> {
  const v = view(game, seat);
  return new Promise((resolve) => {
    const fallback = () => {
      try {
        resolve(chooseCard(v, { ...opts, ms: Math.min(opts.ms ?? 500, 500) }));
      } catch {
        resolve(quickCard(v));
      }
    };
    if (!worker) {
      setTimeout(fallback, 20);
      return;
    }
    const id = ++requestId;
    waiting.set(id, (card) => (v.legal.indexOf(card) >= 0 ? resolve(card) : fallback()));
    worker.postMessage({ id, view: v, opts });
    setTimeout(() => {
      if (waiting.has(id)) {
        waiting.delete(id);
        fallback();
      }
    }, (opts.ms ?? 1500) + 4000);
  });
}

function schedule() {
  clearTimeout(timer);
  if (game.over || pause || game.turn === 0) return;
  const seat = game.turn;
  const gid = gameId;
  const moveAt = game.moveCount;
  const started = performance.now();
  const minDelay = (game.hands[0].length ? 700 : 250) / speed;
  const legal = view(game, seat).legal;
  const go = (card: Card) => {
    if (gid !== gameId || game.moveCount !== moveAt || pause) return;
    const wait = Math.max(0, minDelay - (performance.now() - started));
    timer = setTimeout(() => play(seat, card), wait);
  };
  if (legal.length === 1) {
    go(legal[0]);
    return;
  }
  thinking = true;
  render();
  think(seat, { ms: speed > 1 ? 700 : 1500, samples: 5000, minSamples: 60 }).then(go);
}

/* ----------------------------------------------------------------- play */

function newGame() {
  clearTimeout(timer);
  gameId++;
  pause = null;
  thinking = false;
  game = setup(newSeed());
  const o = game.turn;
  msg = `${o === 0 ? '<b>You</b> hold' : B(o) + ' holds'} the A♠ and open${o === 0 ? '' : 's'}. No thullas on this first round.`;
  render();
  schedule();
}

function play(seat: number, card: Card) {
  if (game.over || pause || game.turn !== seat) return;
  if (view(game, seat).legal.indexOf(card) < 0) return;
  thinking = false;
  const before = game;
  const result = apply(before, seat, { type: 'play', card });
  game = result.state;
  const ended = result.events.filter((e) => e.type === 'pickup' || e.type === 'trickToPile');

  if (!ended.length) {
    msg = game.turn === 0 ? 'Your turn.' : '';
    render();
    schedule();
    return;
  }

  // Show the finished trick for a moment before the cards move.
  const shown = cloneState(before);
  shown.hands[seat].splice(shown.hands[seat].indexOf(card), 1);
  shown.trick.push({ seat, card });
  if (shown.lead < 0) shown.lead = suitOf(card);
  pause = { shown, top: topOfTrick(shown) };
  const thulla = ended[0].type === 'pickup';
  if (thulla) {
    msg = `<span class="hit">Thulla!</span> ${seat === 0 ? 'You cut' : nm(seat) + ' cuts'} with the ${cardName(card)}.`;
  } else {
    msg = shown.trick.some((t) => suitOf(t.card) !== shown.lead)
      ? 'First round, so no thulla. Off-suit cards just go to the pile.'
      : 'Everyone followed suit.';
  }
  render();
  const gid = gameId;
  timer = setTimeout(
    () => {
      if (gid !== gameId) return;
      pause = null;
      msg = describe(result.events);
      if (game.over) {
        const t = loadTally();
        t.played++;
        if (game.loser === 0) t.lost++;
        saveTally(t);
      }
      render();
      schedule();
    },
    (thulla ? 1600 : 1250) / speed,
  );
}

/** Turn the end-of-trick events into the message under the table. */
function describe(events: ThullaEvent[]): string {
  let text = '';
  for (const e of events) {
    if (e.type === 'pickup') {
      const top = e.seat;
      text = `${e.cutter === 0 ? 'You' : nm(e.cutter)} hit ${top === 0 ? '<b>you</b>' : B(top)} with a thulla. ${top === 0 ? 'You pick' : nm(top) + ' picks'} up ${e.cards.length} cards`;
    } else if (e.type === 'trickToPile') {
      text = 'Trick goes to the pile.';
    } else if (e.type === 'lead') {
      const picked = events.some((x) => x.type === 'pickup' && x.seat === e.seat);
      text += picked ? ` and lead${e.seat === 0 ? '' : 's'}.` : ` ${B(e.seat)} lead${e.seat === 0 ? '' : 's'} next.`;
    } else if (e.type === 'safe') {
      text += e.seat === 0 ? " <b>You're safe!</b>" : ` ${B(e.seat)} is safe.`;
    }
  }
  if (events.some((e) => e.type === 'pickup') && !events.some((e) => e.type === 'lead')) text += '.';
  return text.trim();
}

/* --------------------------------------------------------------- render */

const svgOf = (c: Card) => CardArt.face(c);
const sortForDisplay = (h: Card[]) =>
  h.slice().sort((a, b) => DISPLAY_ORDER[suitOf(a)] - DISPLAY_ORDER[suitOf(b)] || a - b);

function seatStatus(s: ThullaState, i: number): string {
  if (s.over && s.loser === i) return 'Lost';
  const place = s.finished.indexOf(i);
  if (place >= 0) return 'Safe · ' + PLACE[place];
  if (!s.over && !pause && s.turn === i) return i === 0 ? 'Your turn' : thinking ? 'Thinking…' : 'Playing';
  return ' ';
}

function renderFan(el: HTMLElement, n: number, vertical: boolean) {
  el.innerHTML = '';
  if (!n) return;
  const span = vertical ? 140 : 150;
  const size = 28;
  const step = n > 1 ? Math.min(vertical ? 9 : 10, (span - size) / (n - 1)) : 0;
  const total = size + step * (n - 1);
  if (vertical) el.style.height = total + 'px';
  else el.style.width = total + 'px';
  const frag = document.createDocumentFragment();
  for (let k = 0; k < n; k++) {
    const b = document.createElement('div');
    b.className = 'back';
    b.style[vertical ? 'top' : 'left'] = k * step + 'px';
    frag.appendChild(b);
  }
  el.appendChild(frag);
}

function render() {
  const s = pause ? pause.shown : game;
  for (let i = 0; i < 4; i++) {
    const seat = $('seat' + i);
    seat.className =
      'seat ' +
      ['bottom', 'left', 'top', 'right'][i] +
      (!s.over && !pause && s.turn === i ? ' turn' : '') +
      (s.finished.indexOf(i) >= 0 ? ' safe' : '') +
      (s.over && s.loser === i ? ' lost' : '');
    (seat.querySelector('small') as HTMLElement).textContent = seatStatus(s, i);
    if (i > 0) renderFan(seat.querySelector('.fan') as HTMLElement, s.hands[i].length, i !== 2);
  }

  const center = $('center');
  const want = new Set(s.trick.map((t) => t.seat + ':' + t.card));
  Array.from(center.children).forEach((ch) => {
    const el = ch as HTMLElement;
    if (!el.classList.contains('tcard') || !want.has(el.dataset.k || '')) el.remove();
  });
  for (const t of s.trick) {
    const k = t.seat + ':' + t.card;
    let el = center.querySelector(`.tcard[data-k="${k}"]`) as HTMLElement | null;
    if (!el) {
      el = document.createElement('div');
      el.className = 'tcard p' + t.seat;
      el.dataset.k = k;
      el.innerHTML = svgOf(t.card);
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', nm(t.seat) + ' played the ' + cardName(t.card));
      if (s.lead >= 0 && suitOf(t.card) !== s.lead) {
        const st = document.createElement('span');
        st.className = 'stamp' + (s.firstTrick ? ' soft' : '');
        st.textContent = s.firstTrick ? 'discard' : 'thulla';
        el.appendChild(st);
      }
      center.appendChild(el);
    }
    el.classList.toggle('high', !!pause && pause.top === t.seat);
  }
  if (!s.trick.length && !s.over) {
    const n = document.createElement('div');
    n.className = 'lead-note';
    n.textContent = s.turn === 0 ? 'Your lead' : nm(s.turn) + ' to lead';
    center.appendChild(n);
  }

  $('msg').innerHTML = msg || (s.turn === 0 ? 'Your turn.' : '');

  const endBox = $('endBox');
  if (s.over) {
    const t = loadTally();
    const head =
      s.loser === 0
        ? "You're left holding cards. You lose this one."
        : s.loser < 0
          ? 'Everyone went out together. No loser.'
          : `${nm(s.loser)} is left holding cards. You survived!`;
    const order =
      s.finished.map((i) => `<li>${i === 0 ? '<b>You</b>' : nm(i)}</li>`).join('') +
      (s.loser >= 0 ? `<li>${s.loser === 0 ? '<b>You</b>' : nm(s.loser)} (lost)</li>` : '');
    endBox.innerHTML = `<div class="end"><h2>${head}</h2><ol>${order}</ol><div class="tally">Games on this device: ${t.played} · Lost: ${t.lost}</div><div><button class="btn primary" type="button" id="againBtn">Deal again</button></div></div>`;
    $('againBtn').onclick = newGame;
  } else endBox.innerHTML = '';
  renderHand(s);
}

function renderHand(s: ThullaState) {
  const me = sortForDisplay(s.hands[0]);
  const hand = $('hand');
  const myTurn = !s.over && !pause && s.turn === 0 && me.length > 0;
  hand.className = 'hand' + (myTurn ? ' myturn' : '');
  hand.innerHTML = '';
  if (!me.length) {
    hand.style.height = '';
    hand.innerHTML = `<div class="empty">${s.finished.indexOf(0) >= 0 && !s.over ? "You're out and safe. Watching the rest play…" : ''}</div>`;
    return;
  }
  const W = hand.clientWidth || 340;
  const hw = Math.max(58, Math.min(84, W * 0.2));
  const hh = hw * 1.4;
  const minStep = hw * 0.3;
  let rows = 1;
  while (rows < 4 && (W - hw) / (Math.ceil(me.length / rows) - 1 || 1) < minStep) rows++;
  const per = Math.ceil(me.length / rows);
  const legal = myTurn ? view(game, 0).legal : [];
  const rowGap = hh * 0.52;
  hand.style.height = 12 + hh + (rows - 1) * rowGap + 'px';
  hand.style.setProperty('--hw', hw + 'px');
  me.forEach((c, idx) => {
    const r = Math.floor(idx / per);
    const k = idx % per;
    const nInRow = Math.min(per, me.length - r * per);
    const step = nInRow > 1 ? Math.min(hw * 0.62, (W - hw) / (nInRow - 1)) : 0;
    const rowW = hw + step * (nInRow - 1);
    const b = document.createElement('button');
    b.type = 'button';
    const ok = legal.indexOf(c) >= 0;
    b.className = 'hcard ' + (ok ? 'ok' : 'no');
    b.style.left = (W - rowW) / 2 + k * step + 'px';
    b.style.top = 12 + r * rowGap + 'px';
    b.innerHTML = svgOf(c);
    b.setAttribute('aria-label', cardName(c) + ` (${rankOf(c)})`);
    b.disabled = !ok;
    if (ok) b.onclick = () => play(0, c);
    hand.appendChild(b);
  });
}

/* ------------------------------------------------------------- controls */

window.addEventListener('resize', () => {
  if (game) render();
});
$('newBtn').onclick = newGame;
const speeds: [number, string][] = [
  [1, 'normal'],
  [2, 'fast'],
  [0.6, 'slow'],
];
let speedIndex = 0;
$('speedBtn').onclick = () => {
  speedIndex = (speedIndex + 1) % speeds.length;
  speed = speeds[speedIndex][0];
  $('speedBtn').textContent = 'Speed: ' + speeds[speedIndex][1];
};

/* ------------------------------------------- keep the game across page updates */

interface Snapshot {
  game?: ThullaState;
  msg?: string;
  speed?: number;
}
interface HotHost {
  snapshot?(fn: () => Snapshot): void;
  ready?(fn: (data: Snapshot) => void): void;
  data?: Snapshot;
}
const hot: HotHost | undefined = (window as unknown as { claude?: { hot?: HotHost } }).claude?.hot;

function start(data: Snapshot) {
  if (data && data.game && data.game.version === 1) {
    game = data.game;
    msg = data.msg || '';
    speed = data.speed || 1;
    gameId++;
    render();
    schedule();
  } else newGame();
}
hot?.snapshot?.(() => ({ game, msg, speed }));
if (hot?.ready) hot.ready(start);
else start(hot?.data ?? {});
