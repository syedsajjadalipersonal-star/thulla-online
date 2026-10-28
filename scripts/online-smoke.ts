// Plays whole games on the local Nakama server with four scripted players, and checks
// that the table behaves: room codes, seating, turn order, rejections, rejoining, and that
// no player ever receives a card from another player's hand.
//
//   npm run server        (in another terminal, or once: it keeps running)
//   npm run smoke:online -- 3
import { randomBytes } from 'node:crypto';
import { SEATS, type Card, type ThullaView } from '@thulla/engine';
import { Table, errorText, type ServerAddress } from '../apps/web/src/net';
import type { WelcomeMessage } from '../packages/nakama/src/protocol';

const server: ServerAddress = { host: '127.0.0.1', port: '7350', ssl: false, serverKey: 'defaultkey' };
const games = Number(process.argv[2] || 1);

interface Player {
  table: Table;
  deviceId: string;
  seat: number;
  seq: number;
  view: ThullaView | null;
  /** The cards this seat was dealt. */
  dealt: Set<Card>;
  rejected: string[];
  welcome: WelcomeMessage | null;
}

function fail(message: string): never {
  throw new Error(message);
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function until(what: string, test: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) fail('Timed out waiting for ' + what);
    await wait(10);
  }
}

function track(p: Player, v: ThullaView | null) {
  if (!v) return;
  if ('hands' in v) fail('A view carried every hand');
  if (v.seat !== p.seat) fail(`Seat ${p.seat} was sent seat ${v.seat}'s view`);
  p.view = v;
  if (v.moveCount === 0) p.dealt = new Set(v.hand);
  for (const c of v.hand) {
    if (!p.dealt.has(c) && v.known[p.seat].indexOf(c) < 0) fail(`Seat ${p.seat} was shown card ${c}, which it never held`);
  }
}

function attach(p: Player) {
  p.table.handlers = {
    welcome: (w) => {
      p.welcome = w;
      p.seat = w.seat;
      p.seq = w.seq;
      track(p, w.view);
    },
    event: (e) => {
      if (e.seq !== p.seq + 1) fail(`Seat ${p.seat} expected move ${p.seq + 1} and got ${e.seq}`);
      p.seq = e.seq;
      track(p, e.view);
    },
    rejected: (r) => p.rejected.push(r.reason),
  };
}

async function newPlayer(name: string, deviceId = randomBytes(16).toString('hex')): Promise<Player> {
  const p: Player = { table: new Table(server, deviceId), deviceId, seat: -1, seq: 0, view: null, dealt: new Set(), rejected: [], welcome: null };
  attach(p);
  await p.table.connect();
  return p;
}

async function expectError(what: string, run: () => Promise<unknown>, pattern: RegExp) {
  try {
    await run();
  } catch (e) {
    const text = await errorText(e);
    if (!pattern.test(text)) fail(`${what}: unexpected error "${text}"`);
    return;
  }
  fail(what + ' should have failed');
}

async function playGame(n: number) {
  const players = [await newPlayer('Ann')];
  await players[0].table.create('Ann');
  const code = players[0].table.code;
  if (!/^[A-Z2-9]{5}$/.test(code)) fail('Odd room code ' + code);
  for (const name of ['Bo', 'Cy', 'Di']) {
    const p = await newPlayer(name);
    await p.table.joinByCode(code.toLowerCase(), name);
    players.push(p);
  }
  await until('four welcomes', () => players.every((p) => p.welcome));
  if (new Set(players.map((p) => p.seat)).size !== SEATS) fail('Seats were not all different');

  if (n === 0) {
    await expectError('a fifth player', async () => (await newPlayer('Ed')).table.joinByCode(code, 'Ed'), /full/);
    await expectError('a made-up code', async () => (await newPlayer('Fay')).table.joinByCode('ZZZZZ', 'Fay'), /No table/);
    players[1].table.start();
    await until('a non-host start to be rejected', () => players[1].rejected.length > 0);
  }

  const host = players.find((p) => p.welcome!.host === p.seat)!;
  for (const p of players) p.welcome = null;
  host.table.start();
  await until('the deal', () => players.every((p) => p.welcome && p.view));
  const dealt = new Set(players.flatMap((p) => p.view!.hand));
  if (dealt.size !== 52) fail(`The four hands hold ${dealt.size} distinct cards, not 52`);

  let moves = 0;
  let rejoined = false;
  while (!players[0].view!.over) {
    const turn = players[0].view!.turn;
    const mover = players.find((p) => p.seat === turn)!;
    await until('the mover to see its turn', () => mover.view!.turn === turn && mover.view!.legal.length > 0);

    if (n === 0 && moves === 3) {
      // Out of turn, and a move against a stale position.
      const other = players.find((p) => p.seat !== turn)!;
      const before = other.rejected.length;
      other.table.play(other.view!.hand[0], other.seq);
      mover.table.play(mover.view!.legal[0], mover.seq - 1);
      await until('both rejections', () => other.rejected.length > before && mover.rejected.length > 0);
    }

    if (n === 0 && moves === 10 && !rejoined) {
      // A player drops and comes back on the same device: same seat, same hand.
      rejoined = true;
      const i = players.indexOf(mover);
      const hand = mover.view!.hand.join(',');
      await mover.table.leave();
      await wait(300);
      const back = await newPlayer('again', mover.deviceId);
      back.dealt = mover.dealt;
      await back.table.join(mover.table.matchId || players[0].table.matchId, code, 'again');
      await until('the rejoin welcome', () => !!back.welcome);
      if (back.seat !== mover.seat || back.view!.hand.join(',') !== hand) fail('Rejoining did not restore the seat and hand');
      players[i] = back;
      continue;
    }

    const card = mover.view!.legal[Math.floor(Math.random() * mover.view!.legal.length)];
    const seqs = players.map((p) => p.seq);
    mover.table.play(card, mover.seq);
    await until('everyone to see the move', () => players.every((p, i) => p.seq === seqs[i] + 1));
    moves++;
  }

  const v = players[0].view!;
  console.log(`Game ${n + 1}: ${moves} moves, room ${code}, loser seat ${v.loser}${rejoined ? ', with a rejoin' : ''}`);
  for (const p of players) await p.table.leave();
}

for (let n = 0; n < games; n++) await playGame(n);
console.log('Online smoke test passed.');
process.exit(0);
