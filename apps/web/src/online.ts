/**
 * Helpers for playing at an online table: where the server is, who this browser tab is,
 * and how to turn the server's seat numbers into table positions with you at the bottom.
 */
import type { ThullaEvent, ThullaState, ThullaView } from '@thulla/engine';
import type { ServerAddress } from './net';

/** Set by scripts/build-web.mjs from the NAKAMA_SERVER_KEY environment variable. */
declare const NAKAMA_SERVER_KEY: string;

/** The Nakama server: `?server=host:port` in the page address, else the host that served the page. */
export function serverAddress(): ServerAddress {
  const ssl = location.protocol === 'https:';
  const param = new URLSearchParams(location.search).get('server');
  const [host, port] = (param || '').split(':');
  return {
    host: host || location.hostname || '127.0.0.1',
    port: port || (ssl ? '443' : '7350'),
    ssl,
    serverKey: typeof NAKAMA_SERVER_KEY === 'string' ? NAKAMA_SERVER_KEY : 'defaultkey',
  };
}

function storage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? localStorage : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Each browser tab signs in as its own player, so four tabs make four players.
 * The id lives in sessionStorage, which survives a reload of the tab but not a new tab.
 */
export function deviceId(): string {
  const s = storage('session');
  let id = s?.getItem('thulla-device') || '';
  if (!id) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    id = 'web-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    s?.setItem('thulla-device', id);
  }
  return id;
}

export function savedName(): string {
  return storage('local')?.getItem('thulla-name') || '';
}

export function saveName(name: string): void {
  storage('local')?.setItem('thulla-name', name);
}

/** The table this tab was sitting at, so a reload can sit back down. */
export function savedTable(): { matchId: string; code: string } | null {
  try {
    const t = JSON.parse(storage('session')?.getItem('thulla-table') || 'null');
    return t && t.matchId ? t : null;
  } catch {
    return null;
  }
}

export function saveTable(table: { matchId: string; code: string } | null): void {
  const s = storage('session');
  if (!s) return;
  if (table) s.setItem('thulla-table', JSON.stringify(table));
  else s.removeItem('thulla-table');
}

/** Table position of a server seat when `me` sits at the bottom (position 0). */
export function rotate(seat: number, me: number): number {
  return seat < 0 ? seat : (seat - me + 4) % 4;
}

/** Server seat at a table position. */
export function seatAt(position: number, me: number): number {
  return (position + me) % 4;
}

/**
 * Builds a table state from one seat's view, turned so that seat is at the bottom.
 * Other hands hold placeholder cards (-1): only their sizes are known, and only sizes are drawn.
 */
export function stateFromView(v: ThullaView, me: number): ThullaState {
  const r = (s: number) => rotate(s, me);
  const byPosition = <T>(f: (seat: number) => T) => [0, 1, 2, 3].map((p) => f(seatAt(p, me)));
  return {
    version: 1,
    seed: '',
    hands: byPosition((s) => (s === v.seat ? v.hand.slice() : new Array<number>(v.handSizes[s]).fill(-1))),
    known: byPosition((s) => v.known[s].slice()),
    voids: byPosition((s) => v.voids[s].slice()),
    pile: v.pile.slice(),
    trick: v.trick.map((t) => ({ seat: r(t.seat), card: t.card })),
    lead: v.lead,
    parts: v.parts.map(r),
    turn: r(v.turn),
    firstTrick: v.firstTrick,
    finished: v.finished.map(r),
    loser: r(v.loser),
    over: v.over,
    moveCount: v.moveCount,
  };
}

/** A table with nobody's cards on it, shown while players gather. */
export function emptyState(): ThullaState {
  return {
    version: 1,
    seed: '',
    hands: [[], [], [], []],
    known: [[], [], [], []],
    voids: [0, 1, 2, 3].map(() => [false, false, false, false]),
    pile: [],
    trick: [],
    lead: -1,
    parts: [],
    turn: -1,
    firstTrick: true,
    finished: [],
    loser: -1,
    over: false,
    moveCount: 0,
  };
}

/** The same events with every seat number turned to a table position. */
export function rotateEvents(events: ThullaEvent[], me: number): ThullaEvent[] {
  const r = (s: number) => rotate(s, me);
  const plays = (cards: { seat: number; card: number }[]) => cards.map((t) => ({ seat: r(t.seat), card: t.card }));
  return events.map((e): ThullaEvent => {
    switch (e.type) {
      case 'played':
        return { ...e, seat: r(e.seat) };
      case 'trickToPile':
        return { ...e, cards: plays(e.cards), top: r(e.top) };
      case 'pickup':
        return { ...e, seat: r(e.seat), cutter: r(e.cutter), cards: plays(e.cards) };
      case 'safe':
        return { ...e, seat: r(e.seat) };
      case 'lead':
        return { ...e, seat: r(e.seat) };
      case 'gameOver':
        return { ...e, loser: r(e.loser), order: e.order.map(r) };
    }
  });
}
