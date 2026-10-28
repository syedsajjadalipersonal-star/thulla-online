# Thulla Online

Thulla (also called Bhabhi) for four players, on the way to online multiplayer on a
[Nakama](https://github.com/heroiclabs/nakama) game server hosted on Oracle Cloud's free
tier, with an Android app.

This repository is at **phase 3 of 5**: the rules are a standalone engine, the page plays
against three bots as before, and up to four people can play together through a Nakama server
running on your own PC, with bots in empty seats, a 60-second turn timer, and rejoining.

## Layout

| Path | What it is |
| --- | --- |
| `packages/engine` | The Thulla rules as a pure state machine. ES5-safe, so it can run inside Nakama. |
| `packages/bot` | The bot. It sees only what its seat could see (a `ThullaView`) and picks a card by Monte Carlo search. |
| `packages/nakama` | The Nakama match handler: seats players, runs the engine, sends each player only their own view. ES5-safe. |
| `apps/web` | The table page: classic cards, four seats, animations. Solo against bots, or online. |
| `apps/bots` | The bot runner: plays bot seats at online tables, each bot seeing only its own seat. |
| `scripts` | Builds, ES5 check, local page server, online smoke test and bot self-play. |
| `docker-compose.yml` | Nakama and Postgres for playing on your PC. |

## The engine contract

```ts
setup(seed)                    // a dealt game, the same every time for the same seed
pending(state)                 // whose turn it is, or null when the game is over
legalCards(state, seat)        // the cards that seat may play now
apply(state, seat, action)     // { state, events }; never changes its input, throws on an illegal move
view(state, seat)              // what one seat may see: its hand plus public facts only
```

Every state is plain JSON, so Nakama can hold it as match state, and a game can be replayed
exactly from its seed and its list of moves.

Events (`played`, `trickToPile`, `pickup`, `safe`, `lead`, `gameOver`) describe what happened,
so a client can animate a move without knowing the rules.

## Commands

Requires Node.js 22 or later.

```sh
npm install
npm run verify      # typecheck, ES5 check, tests and web build, in that order
```

| Command | What it does |
| --- | --- |
| `npm run typecheck` | Type-checks everything |
| `npm run check:es5` | Compiles the engine with only the ES5 standard library, then parses the output as ES5 |
| `npm test` | Engine and bot tests |
| `npm run build:web` | Builds `dist/index.html`, one self-contained page; open it in a browser to play |
| `npm run build:nakama` | Builds `packages/nakama/build/index.js`, the ES5 module Nakama loads |
| `npm run server` | Builds the module and starts Nakama and Postgres in Docker (reloads the module if already running) |
| `npm run bots` | Starts the bot runner (needs `BOT_SECRET` in `.env`) |
| `npm run serve` | Serves the built page at http://127.0.0.1:8080 |
| `npm run smoke:online` | Scripted players play whole games on the local server and check its behaviour, including bots, votes and timers |
| `npm run selfplay` | Pits the search bot against the quick bot to check bot strength |

TypeScript is pinned to 6.0.3 because TypeScript 7 no longer compiles to ES5, which Nakama's
JavaScript runtime requires.

## Playing online on your PC

Needs Docker Desktop as well as Node.js.

1. Copy `.env.example` to `.env` and set the passwords and `BOT_SECRET` to something random.
2. `npm install`, then `npm run server` to start Nakama, `npm run bots` in a second terminal, and `npm run build:web` and `npm run serve`.
3. Open http://127.0.0.1:8080 in four browser tabs (new tabs, not duplicates: each tab is its own player).
4. In one tab choose **Play online**, then **Open a table**. Join from the other tabs with the room code.
5. The player who opened the table deals once all four are there, or deals sooner with bots in the empty
   seats if everyone at the table agrees. A host on their own can deal straight away against three bots.

Each move has 60 seconds (30 if you have lost your connection). When time runs out a random card is played
for you, and after three in a row a bot takes over your seat. Reconnect, or press **Take my seat back**, to play it again.

Nakama's admin console is at http://127.0.0.1:7351 (user `admin`, password from `.env`).

## What the tests check

- **Dealing:** 13 distinct cards each, the same deal for the same seed, and the ace of spades always opens.
- **Card accounting:** across 300 random games, every card is in exactly one place after every move.
- **Replays:** a recorded game replays to identical states and events.
- **Rules:** following suit, first-round discards, thullas and pickups, safe players, passing the lead, and the end of the game.
- **Redaction:** no seat's view ever contains another seat's hidden cards.
- **Bot:** always plays a legal card, and loses far less than its fair share against random players.
- **Online seats:** the page turns server seats so you sit at the bottom, and builds the table from your view alone.
- **Online smoke test** (against a running server): room codes, a full table, a bad code, a non-host start,
  out-of-turn and stale moves, a player rejoining with the same seat and hand, and on every message that no
  player is sent a card from another hand. Then: a game alone against the bot runner's bots, a newcomer after
  a game seeing a fresh table, a vote refused and then agreed, three timed-out turns bringing in a bot, and
  the seat taken back by button and by reconnecting.

The ported bot was also checked against the original single-player bot: over 400 games with
equal thinking budgets, one ported bot against three originals lost 22% of games, where 25%
would be even. Its strength is unchanged.

## Roadmap

1. **Thulla engine** (done): rules as a pure engine, built for ES5; today's page runs on it.
2. **Nakama on your PC** (done): Docker Compose with Nakama and Postgres, the match handler and room codes.
3. **Bots and rejoining** (done): a bot runner fills seats; reconnect tokens bring players back; turn timers.
4. **Oracle server:** a free Arm server, domain, Caddy, firewall and nightly backups.
5. **Android app:** a Capacitor app, and Google Play's 12-tester closed test.

The full design is in the Card Table Multiplayer Design document.
