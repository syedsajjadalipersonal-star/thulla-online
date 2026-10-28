# Thulla Online

Thulla (also called Bhabhi) for four players, on the way to online multiplayer on a
[Nakama](https://github.com/heroiclabs/nakama) game server hosted on Oracle Cloud's free
tier, with an Android app.

This repository is **phase 1 of 5**: the Thulla rules are now a standalone engine, and the
single-player page (you against three bots) runs on it with no visible change.

## Layout

| Path | What it is |
| --- | --- |
| `packages/engine` | The Thulla rules as a pure state machine. ES5-safe, so it can run inside Nakama. |
| `packages/bot` | The bot. It sees only what its seat could see (a `ThullaView`) and picks a card by Monte Carlo search. |
| `apps/web` | The single-player table page: classic cards, four seats, animations. |
| `scripts` | Build, ES5 check and bot self-play scripts. |

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
| `npm run selfplay` | Pits the search bot against the quick bot to check bot strength |

TypeScript is pinned to 6.0.3 because TypeScript 7 no longer compiles to ES5, which Nakama's
JavaScript runtime requires.

## What the tests check

- **Dealing:** 13 distinct cards each, the same deal for the same seed, and the ace of spades always opens.
- **Card accounting:** across 300 random games, every card is in exactly one place after every move.
- **Replays:** a recorded game replays to identical states and events.
- **Rules:** following suit, first-round discards, thullas and pickups, safe players, passing the lead, and the end of the game.
- **Redaction:** no seat's view ever contains another seat's hidden cards.
- **Bot:** always plays a legal card, and loses far less than its fair share against random players.

The ported bot was also checked against the original single-player bot: over 400 games with
equal thinking budgets, one ported bot against three originals lost 22% of games, where 25%
would be even. Its strength is unchanged.

## Roadmap

1. **Thulla engine** (this phase): rules as a pure engine, built for ES5; today's page runs on it.
2. **Nakama on your PC:** Docker Compose with Nakama and Postgres, the match handler and room codes.
3. **Bots and rejoining:** a bot runner fills seats; reconnect tokens bring players back; turn timers.
4. **Oracle server:** a free Arm server, domain, Caddy, firewall and nightly backups.
5. **Android app:** a Capacitor app, and Google Play's 12-tester closed test.

The full design is in the Card Table Multiplayer Design document.
