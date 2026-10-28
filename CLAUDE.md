# CLAUDE.md

Project notes for Claude Code. Read this first, then `README.md`.

## What this is

Thulla (also called Bhabhi), a four-player card game, being taken from a single-player web
page (you against three bots) to online multiplayer:

- **Server:** Nakama (open source, Apache 2.0) running an authoritative match handler.
- **Hosting:** one Oracle Cloud Always Free Arm server (2 OCPUs, 12 GB since Oracle's June 2026 cut).
- **Clients:** the web page, and later an Android app made by wrapping the same page with Capacitor.
- **Scope:** Thulla only. Dukki and A Hand of Three come later on the same server and engine contract.
- **Empty seats:** bots fill empty seats and stand in for players who drop.

Full design: the "Card Table Multiplayer Design" doc, https://claude.ai/artifact/9GioMRXTeBnJzybWKTuFkS

## Thulla rules as implemented

1. All 52 cards are dealt, 13 each. The holder of the ace of spades must open with it.
2. Play goes clockwise. Players must follow the suit led. Ace is high, 2 is low.
3. If everyone follows, the trick goes to the discard pile and the highest card of the led suit leads next.
4. **First trick only:** a player with no spades plays any card as a discard. It is not a thulla; the trick continues and goes to the pile.
5. **After that:** a player who cannot follow plays any card. That is a thulla. The trick stops at once and the
   player with the highest card of the led suit picks up every card on the table, then leads.
6. A player who empties their hand is safe. If the player due to lead has no cards, the next player clockwise with cards leads.
7. The last player holding cards loses. If everyone goes out on the same trick, there is no loser.

Cards picked up after a thulla are public knowledge: everyone saw them on the table.

## Layout and conventions

| Path | Contents |
| --- | --- |
| `packages/engine` | Rules as a pure state machine. Must stay ES5-safe. |
| `packages/bot` | Monte Carlo bot. Reads only a `ThullaView`. Node and browsers only, not Nakama. |
| `apps/web` | Single-player table page: classic SVG cards, four seats, animations. |
| `scripts` | Web build, ES5 check, bot self-play. |

- Cards are integers 0 to 51: `suit = floor(card / 13)` (0 spades, 1 hearts, 2 diamonds, 3 clubs), `rank = card % 13 + 2` (14 is the ace).
- Seats are 0 to 3, clockwise. In the UI, seat 0 is the local player at the bottom, 1 is left (Bilal), 2 is across (Hina), 3 is right (Zara).
- Engine API: `setup(seed)`, `pending(state)`, `legalCards(state, seat)`, `checkAction`, `apply(state, seat, action)` returning `{ state, events }`, and `view(state, seat)`.
- `apply` never mutates its input and throws an error with `code: 'illegal_move'` for an illegal move.
- States are plain JSON. The same seed and moves always replay to the same states and events.
- Events: `played`, `trickToPile`, `pickup`, `safe`, `lead`, `gameOver`. Clients animate from events, not from rules.

## Hard constraints

- **ES5 for Nakama.** Nakama's TypeScript runtime (goja) runs ES5 only, from a single `build/index.js`,
  with no Node packages, no threads and no state kept in globals between calls. In `packages/engine`:
  no `Set`, `Map`, `Array.prototype.find/includes/fill`, `Object.assign`, `Math.imul`, `Object.setPrototypeOf`
  or other ES2015 built-ins. `npm run check:es5` compiles it against the ES5 standard library only and
  parses the output as ES5. Keep it passing.
- **TypeScript is pinned to 6.0.3.** TypeScript 7 removed the ES5 target. `tsconfig.es5.json` sets
  `ignoreDeprecations: "6.0"` for that reason.
- **Hidden cards never leave the server.** Clients and bots get `view(state, seat)` only. The redaction
  test in `packages/engine/test` must keep passing. Bots must never receive full state.
- **Bots do not run inside Nakama.** They simulate hundreds of games per move. Plan: a separate Node.js
  bot runner that joins matches as an ordinary player over Nakama's JavaScript client and thinks in worker threads.
- **Keep the look.** The table, cards and animations were approved as they are. Change rendering only when asked.

## Commands

```sh
npm install
npm run verify      # typecheck, ES5 check, tests, web build
npm run selfplay -- 100 60   # search bot vs three quick bots; it should lose well under 25%
```

Bot strength reference: over 400 games with equal budgets, one ported bot against three copies of the
original single-player bot lost 22% (even is 25%). Run a comparison like this after any bot change.

## Plan

| Phase | Delivers | Gate | Status |
| --- | --- | --- | --- |
| 1. Thulla engine | Pure engine built for ES5; the page runs on it | Page plays as before; replays match | Done |
| 2. Nakama on your PC | Docker Compose with Nakama and Postgres; match handler; room codes | Four browser tabs finish a game | Next |
| 3. Bots and rejoining | Bot runner; reconnect tokens; turn timers | A dropped player rejoins and reclaims the seat | |
| 4. Oracle server | Arm server, domain, Caddy, firewall, nightly backups | The table opens over HTTPS from any phone | |
| 5. Android app | Capacitor app; Google Play 12-tester, 14-day closed test | The app goes on Google Play | |

### Phase 2 checklist

- [ ] `docker-compose.yml` with Nakama and Postgres. Production runs on Arm (Oracle Ampere): Nakama
      publishes arm64 builds, but an official arm64 Docker image was not confirmed, so check before relying on it.
- [ ] `packages/nakama`: the match handler plus the engine, built to one ES5 `build/index.js`. Confirm a
      bundling route that produces ES5 (Nakama's docs use `tsc` or Rollup with Babel; esbuild cannot fully lower to ES5).
- [ ] Server functions `create_table` (returns a short room code) and `join_by_code` (returns the match id).
- [ ] Opcodes: client to server 1 `start`, 2 `play {card, seq}`, 3 `resync {fromSeq}`; server to client
      10 `welcome`, 11 `event {seq, event, view}`, 12 `prompt {legal, deadline}`, 13 `rejected`, 14 `seats`.
- [ ] Send each seat its own view with targeted messages to that player only.
- [ ] Online mode in `apps/web` using Nakama's JavaScript client, reusing the existing table UI.
- [ ] Change Nakama's console login from the default `admin` / `password`.

## Open questions (ask the owner)

- Turn timer length, and the grace period before a bot stands in for a dropped player.
- Whether a player who left can take back their seat mid-game.
- Domain name: an owned domain, or a free dynamic DNS name.
- Whether upgrading the Oracle account to Pay As You Go avoids idle reclamation while staying free.
- Which Google Play developer account to publish under.
