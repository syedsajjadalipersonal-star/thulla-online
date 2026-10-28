import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { apply, seededRandom, setup, ThullaState, view } from '@thulla/engine';
import { chooseCard, quickCard } from '@thulla/bot';

type Player = (state: ThullaState, seat: number) => number;

function playGame(seed: string, players: Player[]): ThullaState {
  let state = setup(seed);
  while (!state.over) {
    const seat = state.turn;
    const card = players[seat](state, seat);
    state = apply(state, seat, { type: 'play', card }).state; // apply throws on an illegal card
  }
  return state;
}

function randomPlayer(seed: string): Player {
  const random = seededRandom(seed);
  return (state, seat) => {
    const legal = view(state, seat).legal;
    return legal[Math.floor(random() * legal.length)];
  };
}

function searchBot(seed: string, samples: number): Player {
  const random = seededRandom(seed);
  return (state, seat) => chooseCard(view(state, seat), { ms: 0, minSamples: samples, samples, random });
}

describe('bot', () => {
  it('always plays a legal card, for both the search bot and the quick bot', () => {
    for (let i = 0; i < 6; i++) {
      const players = [searchBot('a' + i, 20), (s: ThullaState, p: number) => quickCard(view(s, p)), searchBot('b' + i, 20), randomPlayer('r' + i)];
      const end = playGame('legal-' + i, players);
      assert.equal(end.over, true);
    }
  });

  it('only ever reads the view for its own seat', () => {
    const state = setup('view-only');
    const v = view(state, state.turn);
    // A view carries no other hands, so the bot cannot cheat even by accident.
    assert.equal((v as unknown as { hands?: unknown }).hands, undefined);
    assert.equal(chooseCard(v, { ms: 0, minSamples: 5, samples: 5 }), v.legal[0]);
  });

  it('loses far less often than its fair share against three random players', () => {
    const games = 40;
    let losses = 0;
    for (let g = 0; g < games; g++) {
      const hero = g % 4;
      const players = [0, 1, 2, 3].map((p) => (p === hero ? searchBot('hero' + g, 40) : randomPlayer('rnd' + g + ':' + p)));
      if (playGame('strength-' + g, players).loser === hero) losses++;
    }
    // A random player loses 25% of the time. The bot should lose at most 10% here.
    assert.ok(losses <= games * 0.1, `bot lost ${losses} of ${games}`);
  });
});
