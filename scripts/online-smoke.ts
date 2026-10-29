// Plays whole games on the local Nakama server with four scripted players, and checks
// that the table behaves: room codes, seating, turn order, rejections, rejoining, and that
// no player ever receives a card from another player's hand. Then the Phase 3 behaviour: dealing
// with bots (alone, and after a vote), the turn timer, a bot taking over after three missed turns,
// and taking the seat back by button and by reconnecting.
//
//   npm run server        (once: it keeps running; TURN_SECONDS=3 in .env makes the timer tests quick)
//   npm run bots          (in another terminal)
//   npm run smoke:online -- 3
//
// Against another server, set NAKAMA_HOST, NAKAMA_PORT, NAKAMA_SSL=true and NAKAMA_SERVER_KEY, as for the bot runner.
import { randomBytes } from 'node:crypto';
import { SEATS, type Card, type ThullaView } from '@thulla/engine';
import { Table, errorText, type ServerAddress } from '../apps/web/src/net';
import type { SeatsMessage, WelcomeMessage } from '../packages/nakama/src/protocol';

const env = process.env;
const server: ServerAddress = {
  host: env.NAKAMA_HOST || '127.0.0.1',
  port: env.NAKAMA_PORT || '7350',
  ssl: env.NAKAMA_SSL === 'true',
  serverKey: env.NAKAMA_SERVER_KEY || 'defaultkey',
};
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
  seats: SeatsMessage | null;
  /** Who played each move this player saw, and whether the server played it after a timeout. */
  moves: { seat: number; timedOut: boolean }[];
  /** Leave turns alone, to let the timer run out. */
  idle: boolean;
  playedAt: number;
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
      p.seats = w;
      p.seat = w.seat;
      p.seq = w.seq;
      track(p, w.view);
    },
    event: (e) => {
      if (e.seq !== p.seq + 1) fail(`Seat ${p.seat} expected move ${p.seq + 1} and got ${e.seq}`);
      p.seq = e.seq;
      track(p, e.view);
      const first = e.events[0];
      if (first && first.type === 'played') p.moves.push({ seat: first.seat, timedOut: e.timedOut });
    },
    seats: (m) => (p.seats = m),
    rejected: (r) => p.rejected.push(r.reason),
  };
}

async function newPlayer(name: string, deviceId = randomBytes(16).toString('hex')): Promise<Player> {
  const p: Player = { table: new Table(server, deviceId), deviceId, seat: -1, seq: 0, view: null, dealt: new Set(), rejected: [], welcome: null, seats: null, moves: [], idle: false, playedAt: -1 };
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
      const matchId = players[0].table.matchId;
      await mover.table.leave();
      await wait(300);
      const back = await newPlayer('again', mover.deviceId);
      back.dealt = mover.dealt;
      await back.table.join(matchId, code, 'again');
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

/* ------------------------------------------------------------ Phase 3 */

/** Plays a random legal card for every player whose turn it is, unless it is idle. */
function drive(players: Player[]) {
  const timer = setInterval(() => {
    for (const p of players) {
      const v = p.view;
      if (p.idle || !v || v.over || v.turn !== p.seat || !v.legal.length || p.playedAt === p.seq) continue;
      if (p.seats?.seats[p.seat]?.bot) continue;
      p.playedAt = p.seq;
      p.table.play(v.legal[Math.floor(Math.random() * v.legal.length)], p.seq);
    }
  }, 20);
  return () => clearInterval(timer);
}

async function table(names: string[]): Promise<Player[]> {
  const players = [await newPlayer(names[0])];
  await players[0].table.create(names[0]);
  for (const name of names.slice(1)) {
    const p = await newPlayer(name);
    await p.table.joinByCode(players[0].table.code, name);
    players.push(p);
  }
  await until('everyone seated', () => players.every((p) => p.seats && p.seats.seats.filter((x) => x && x.connected).length === names.length));
  return players;
}

async function dealAloneWithBots() {
  const [ann] = await table(['Ann']);
  ann.table.start();
  await until('a deal without bots to be refused', () => ann.rejected.some((r) => /four players/.test(r)));
  ann.table.start(true);
  await until('the deal with bots', () => !!ann.view);
  const bots = ann.seats!.seats.filter((x) => x && x.bot).map((x) => x!.name);
  if (bots.length !== 3) fail('Expected three bots, got ' + JSON.stringify(ann.seats));
  const stop = drive([ann]);
  await until('the game with bots to finish', () => ann.view!.over, 180000);
  stop();
  const byBots = ann.moves.filter((m) => m.seat !== ann.seat);
  const real = byBots.filter((m) => !m.timedOut).length;
  console.log(`Alone with bots (${bots.join(', ')}): ${ann.moves.length} moves, ${real} of ${byBots.length} bot moves made by the bot runner`);
  if (!real) fail('No bot runner moves: is `npm run bots` running?');

  // Someone new sits down after the game: they must not be shown the finished game or its cards.
  const ed = await newPlayer('Ed');
  await ed.table.joinByCode(ann.table.code, 'Ed');
  await until('Ed to be seated', () => !!ed.welcome);
  if (ed.welcome!.view) fail('A newcomer was sent the finished game');
  await until('the bots to leave', () => ann.seats!.seats.filter((x) => x).length === 2);
  console.log('After the game: the bots left, and a newcomer saw a fresh table');
  await ed.table.leave();
  await ann.table.leave();
}

async function voteForBots() {
  const [ann, bo] = await table(['Ann', 'Bo']);
  ann.table.start(true);
  await until('Bo to be asked', () => !!bo.seats?.vote && bo.seats.vote.voters.indexOf(bo.seat) >= 0);
  bo.table.vote(false);
  await until('Ann to hear Bo would rather wait', () => ann.rejected.some((r) => /rather wait/.test(r)));
  if (ann.view) fail('Dealt despite a refusal');
  ann.table.start(true);
  await until('Bo to be asked again', () => !!bo.seats?.vote);
  bo.table.vote(true);
  await until('the deal after agreeing', () => !!ann.view && !!bo.view);
  const bots = ann.seats!.seats.filter((x) => x && x.bot).length;
  if (bots !== 2) fail(`Expected two bots after the vote, got ${bots}`);
  console.log('Vote: a refusal kept the cards in the box; agreement dealt with two bots');
  await ann.table.leave();
  await bo.table.leave();
}

async function timerAndTakeover() {
  const players = await table(['Ann', 'Bo', 'Cy', 'Di']);
  const [ann, , , di] = players;
  ann.table.start();
  await until('the deal', () => players.every((p) => p.view));
  const turnMs = ann.welcome!.deadline - ann.welcome!.now;
  if (turnMs > 10000) {
    console.log(`Timer tests skipped: turns last ${Math.round(turnMs / 1000)} s here. Set TURN_SECONDS=3 in .env and run npm run server.`);
    for (const p of players) await p.table.leave();
    return;
  }
  const stop = drive(players);
  const diBot = () => !!ann.seats?.seats[di.seat]?.bot;
  const diMoves = () => ann.moves.filter((m) => m.seat === di.seat);

  // Di sits still: three timed-out turns, then a bot plays for her.
  di.idle = true;
  await until('a bot to take over Di', diBot, 60000);
  const timedOut = diMoves().filter((m) => m.timedOut).length;
  if (timedOut !== 3) fail(`Expected the bot after 3 timeouts, saw ${timedOut}`);
  await until('the bot to play for Di', () => diMoves().some((m, i) => i >= 3 && !m.timedOut) || ann.view!.over, 60000);

  // Taking the seat back by button.
  di.table.takeBack();
  await until('Di to have her seat back', () => !diBot());
  di.idle = false;
  const before = diMoves().length;
  await until('Di to play for herself', () => diMoves().length > before || ann.view!.over, 30000);
  console.log(`Timer: ${timedOut} missed turns brought in a bot; Di took the seat back with the button`);

  // Again, and this time Di comes back by reconnecting.
  if (!ann.view!.over) {
    di.idle = true;
    await until('a bot to take over Di again', () => diBot() || ann.view!.over, 60000);
    if (!ann.view!.over) {
      await di.table.leave();
      const back = await newPlayer('Di', di.deviceId);
      back.dealt = di.dealt;
      await back.table.join(ann.table.matchId, ann.table.code, 'Di');
      await until('the seat to come back on rejoining', () => !!back.welcome && !diBot());
      players[3] = back;
      console.log('Rejoin: reconnecting gave Di her seat back from the bot');
    }
  }
  stop();
  const finish = drive(players);
  await until('the game to finish', () => ann.view!.over, 120000);
  finish();
  for (const p of players) await p.table.leave();
}

async function awayTimer() {
  const players = await table(['Ann', 'Bo', 'Cy', 'Di']);
  const [ann] = players;
  ann.table.start();
  await until('the deal', () => players.every((p) => p.view));
  const left = (m: { deadline: number; now: number }) => m.deadline - m.now;
  if (left(ann.welcome!) <= 31000) {
    console.log('Away timer test skipped: it needs turns longer than 30 s (the normal 60).');
  } else {
    // The player whose turn it is drops: the rest of their turn shrinks to 30 seconds.
    const mover = players.find((p) => p.seat === ann.view!.turn)!;
    ann.seats = null;
    await mover.table.leave();
    await until('the seat to show as away', () => !!ann.seats && !ann.seats.seats[mover.seat]!.connected);
    const ms = left(ann.seats!);
    if (ms > 30500 || ms < 25000) fail(`Expected about 30 s for an away player, got ${ms} ms`);
    console.log(`Away: a player who dropped on their turn has ${Math.round(ms / 1000)} s left, not 60`);
  }
  for (const p of players) await p.table.leave();
}

for (let n = 0; n < games; n++) await playGame(n);
await dealAloneWithBots();
await voteForBots();
await timerAndTakeover();
await awayTimer();
console.log('Online smoke test passed.');
process.exit(0);
