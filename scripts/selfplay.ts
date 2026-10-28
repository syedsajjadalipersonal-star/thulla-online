// Bot strength check: one search bot against three quick (tactics-only) bots.
// Usage: npm run selfplay -- [games] [samples]
import { apply, setup, view } from '@thulla/engine';
import { chooseCard, quickCard } from '@thulla/bot';

const games = Number(process.argv[2] || 100);
const samples = Number(process.argv[3] || 60);
let lost = 0;
const started = Date.now();
for (let g = 0; g < games; g++) {
  const hero = g % 4;
  let state = setup('selfplay-' + g);
  while (!state.over) {
    const seat = state.turn;
    const v = view(state, seat);
    const card = seat === hero ? chooseCard(v, { ms: 0, samples, minSamples: samples }) : quickCard(v);
    state = apply(state, seat, { type: 'play', card }).state;
  }
  if (state.loser === hero) lost++;
}
const rate = lost / games;
console.log(
  `Search bot lost ${lost} of ${games} games (${(rate * 100).toFixed(1)}%) against three quick bots. ` +
    `An even share would be 25%. ${((Date.now() - started) / 1000).toFixed(0)}s.`,
);
