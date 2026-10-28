/**
 * The bot runner: fills seats at online tables.
 *
 * It signs in to Nakama, registers with the shared BOT_SECRET, and waits. When a table needs a bot
 * (an empty seat at the deal, or a player who missed three turns) the server sends it a notification,
 * and it joins that match as an ordinary player for that one seat. Like any player, a bot only ever
 * receives its own seat's view. Thinking happens on worker threads.
 *
 *   npm run bots
 *
 * Settings come from the environment or .env: BOT_SECRET (required), NAKAMA_HOST, NAKAMA_PORT, NAKAMA_SSL,
 * and for tests BOT_THINK_MS (thinking budget, default 1500) and BOT_MIN_MOVE_MS (default 700).
 */
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { Client } from '@heroiclabs/nakama-js';
import { quickCard, type BotOptions } from '@thulla/bot';
import type { Card, ThullaView } from '@thulla/engine';
import { Table, errorText, type ServerAddress } from '../../web/src/net';
import { BOT_WANTED_CODE, type BotWanted } from '../../../packages/nakama/src/protocol';


function loadEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  try {
    for (const line of readFileSync(new URL('../../../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) env[m[1]] = m[2];
    }
  } catch {
    /* no .env: use the environment only */
  }
  return { ...env, ...process.env };
}

const env = loadEnv();
const secret = env.BOT_SECRET;
if (!secret) {
  console.error('BOT_SECRET is not set. Put it in .env (see .env.example).');
  process.exit(1);
}
const server: ServerAddress = {
  host: env.NAKAMA_HOST || '127.0.0.1',
  port: env.NAKAMA_PORT || '7350',
  ssl: env.NAKAMA_SSL === 'true',
  serverKey: env.NAKAMA_SERVER_KEY || 'defaultkey',
};
const THINK: BotOptions = { ms: Number(env.BOT_THINK_MS) || 1500, samples: 5000, minSamples: 60 };
/** Bots wait at least this long before playing, so people can follow the table. */
const MIN_MOVE_MS = Number(env.BOT_MIN_MOVE_MS ?? 700);

/* ------------------------------------------------------------ thinking */

const workers: Worker[] = [];
const waiting = new Map<number, (card: number) => void>();
let nextId = 0;
for (let i = 0; i < Math.max(1, Math.min(4, availableParallelism() - 1)); i++) {
  const w = new Worker(new URL('./worker.ts', import.meta.url), { execArgv: ['--import', 'tsx'] });
  w.on('message', (m: { id: number; card: number }) => {
    waiting.get(m.id)?.(m.card);
    waiting.delete(m.id);
  });
  workers.push(w);
}

function think(view: ThullaView): Promise<Card> {
  if (view.legal.length === 1) return Promise.resolve(view.legal[0]);
  const id = ++nextId;
  return new Promise((resolve) => {
    const done = (card: number) => resolve(view.legal.indexOf(card) >= 0 ? card : quickCard(view));
    waiting.set(id, done);
    workers[id % workers.length].postMessage({ id, view, opts: THINK });
    setTimeout(() => {
      if (waiting.delete(id)) done(-1);
    }, (THINK.ms ?? 1500) + 4000);
  });
}

/* ------------------------------------------------------------ bots */

const active = new Map<string, Table>();

async function seatBot(w: BotWanted) {
  const key = w.matchId + ':' + w.seat;
  if (active.has(key)) return;
  const table = new Table(server, 'bot-' + w.matchId + '-' + w.seat);
  active.set(key, table);
  let view: ThullaView | null = null;
  let seq = 0;
  let thinking = false;

  const leave = () => {
    if (active.get(key) !== table) return;
    active.delete(key);
    void table.leave();
    console.log(`${w.name} left seat ${w.seat} of ${w.matchId.slice(0, 8)}`);
  };
  const move = async () => {
    if (!view || thinking || view.over || view.turn !== view.seat || !view.legal.length) return;
    thinking = true;
    const at = seq;
    const started = Date.now();
    const card = await think(view);
    await new Promise((r) => setTimeout(r, Math.max(0, MIN_MOVE_MS - (Date.now() - started))));
    thinking = false;
    if (at === seq && active.get(key) === table) table.play(card, seq);
  };

  table.handlers = {
    welcome: (m) => {
      seq = m.seq;
      view = m.view;
      if (view?.over) leave();
    },
    event: (m) => {
      seq = m.seq;
      view = m.view;
      if (view.over) leave();
    },
    prompt: () => void move(),
    rejected: (r) => console.warn(`${w.name}: ${r.reason}`),
    released: leave,
    disconnected: () => active.get(key) === table && active.delete(key),
  };
  try {
    await table.connect();
    await table.join(w.matchId, '', w.name, { secret: secret!, seat: String(w.seat) });
    console.log(`${w.name} sat in seat ${w.seat} of ${w.matchId.slice(0, 8)}`);
    void move();
  } catch (e) {
    active.delete(key);
    console.warn(`${w.name} could not join ${w.matchId.slice(0, 8)}: ${await errorText(e)}`);
  }
}

/* ------------------------------------------------------------ control connection */

async function run() {
  const client = new Client(server.serverKey, server.host, server.port, server.ssl);
  const session = await client.authenticateDevice('thulla-bot-runner', true);
  const socket = client.createSocket(server.ssl, false);
  socket.onnotification = (n) => {
    if (n.code === BOT_WANTED_CODE && n.content) void seatBot(n.content as BotWanted);
  };
  socket.ondisconnect = () => {
    console.warn('Lost the connection to Nakama; reconnecting…');
    setTimeout(start, 3000);
  };
  await socket.connect(session, false);
  await client.rpc(session, 'register_bot_runner', { secret });
  console.log(`Bot runner ready at ${server.host}:${server.port} with ${workers.length} thinking thread(s).`);
}

function start() {
  run().catch(async (e) => {
    console.warn('Could not reach Nakama: ' + (await errorText(e)) + '. Trying again in 3 s.');
    setTimeout(start, 3000);
  });
}
start();
