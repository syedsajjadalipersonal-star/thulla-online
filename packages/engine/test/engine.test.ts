import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  ACE_OF_SPADES,
  apply,
  checkAction,
  isIllegalMoveError,
  legalCards,
  makeCard,
  pending,
  replay,
  setup,
  SUIT_CLUBS,
  SUIT_DIAMONDS,
  SUIT_HEARTS,
  SUIT_SPADES,
  view,
} from '@thulla/engine';
import { assertCardsAccountedFor, makeState, playRandomGame } from './helpers';

const S = (r: number) => makeCard(SUIT_SPADES, r);
const H = (r: number) => makeCard(SUIT_HEARTS, r);
const D = (r: number) => makeCard(SUIT_DIAMONDS, r);
const C = (r: number) => makeCard(SUIT_CLUBS, r);

describe('dealing', () => {
  it('deals 13 distinct cards to each seat', () => {
    const s = setup('deal-test');
    assert.deepEqual(
      s.hands.map((h) => h.length),
      [13, 13, 13, 13],
    );
    assertCardsAccountedFor(s);
  });

  it('deals the same hands from the same seed, and different hands from another seed', () => {
    assert.deepEqual(setup('same-seed').hands, setup('same-seed').hands);
    assert.notDeepEqual(setup('seed-a').hands, setup('seed-b').hands);
  });

  it('starts with the holder of the ace of spades, who may only play it', () => {
    for (let i = 0; i < 50; i++) {
      const s = setup('opener-' + i);
      assert.ok(s.hands[s.turn].indexOf(ACE_OF_SPADES) >= 0);
      assert.deepEqual(legalCards(s, s.turn), [ACE_OF_SPADES]);
      assert.deepEqual(pending(s), { seat: s.turn, kind: 'play' });
    }
  });
});

describe('whole games', () => {
  it('plays 300 random games to the end with every card always accounted for', () => {
    for (let i = 0; i < 300; i++) {
      const g = playRandomGame('random-' + i, assertCardsAccountedFor);
      const last = g.states[g.states.length - 1];
      assert.equal(last.over, true);
      assert.equal(pending(last), null);
      const holding = last.hands.filter((h) => h.length > 0).length;
      assert.ok(holding <= 1, 'at most one player is left holding cards');
      if (last.loser >= 0) assert.ok(last.hands[last.loser].length > 0);
      assert.equal(last.finished.length + (last.loser >= 0 ? 1 : 0), 4);
    }
  });

  it('replays a recorded game to exactly the same states and events', () => {
    for (let i = 0; i < 25; i++) {
      const g = playRandomGame('replay-' + i);
      const results = replay(g.seed, g.moves);
      assert.equal(results.length, g.moves.length);
      results.forEach((r, k) => {
        assert.deepEqual(r.state, g.states[k + 1]);
        assert.deepEqual(r.events, g.events[k]);
      });
    }
  });

  it('never changes the state it is given', () => {
    const g = playRandomGame('immutability');
    for (let k = 0; k < g.moves.length; k++) {
      const before = JSON.stringify(g.states[k]);
      apply(g.states[k], g.moves[k].seat, { type: 'play', card: g.moves[k].card });
      assert.equal(JSON.stringify(g.states[k]), before);
    }
  });

  it('keeps every state as plain JSON, so Nakama can store and send it', () => {
    const g = playRandomGame('json');
    for (const s of g.states) assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  });
});

describe('rules', () => {
  it('rejects moves out of turn, cards not held, and failing to follow suit', () => {
    const s = makeState([[S(5), H(9)], [S(7), H(3)], [S(9)], [S(11), D(4)]], 0);
    const lead = apply(s, 0, { type: 'play', card: S(5) }).state;
    assert.match(checkAction(lead, 2, { type: 'play', card: S(9) }) || '', /not your turn/);
    assert.match(checkAction(lead, 1, { type: 'play', card: S(9) }) || '', /not in your hand/);
    assert.match(checkAction(lead, 1, { type: 'play', card: H(3) }) || '', /follow suit with spades/);
    assert.equal(checkAction(lead, 1, { type: 'play', card: S(7) }), null);
    assert.throws(
      () => apply(lead, 1, { type: 'play', card: H(3) }),
      (e: unknown) => isIllegalMoveError(e),
    );
  });

  it('requires the ace of spades as the very first card', () => {
    const s = setup('first-card');
    const other = s.hands[s.turn].find((c) => c !== ACE_OF_SPADES)!;
    assert.match(checkAction(s, s.turn, { type: 'play', card: other }) || '', /ace of spades/);
  });

  it('sends a fully followed trick to the pile, and the highest card leads next', () => {
    const s = makeState([[S(5), H(9)], [S(13), H(3)], [S(9), C(2)], [S(11), D(4)]], 0);
    let st = s;
    for (const [seat, card] of [[0, S(5)], [1, S(13)], [2, S(9)], [3, S(11)]] as const) {
      st = apply(st, seat, { type: 'play', card }).state;
    }
    assert.deepEqual(st.pile, [S(5), S(13), S(9), S(11)]);
    assert.equal(st.turn, 1, 'the king of spades leads next');
    assert.deepEqual(st.trick, []);
  });

  it('on the first trick, an off-suit card is a discard: no pickup, and the trick goes to the pile', () => {
    const s = makeState([[ACE_OF_SPADES, H(9)], [H(3), H(4)], [S(9), C(2)], [S(11), D(4)]], 0, { firstTrick: true });
    let r = apply(s, 0, { type: 'play', card: ACE_OF_SPADES });
    r = apply(r.state, 1, { type: 'play', card: H(3) });
    assert.equal(r.state.trick.length, 2, 'the trick continues after a first-round discard');
    assert.equal(r.state.voids[1][SUIT_SPADES], true, 'seat 1 is known to have no spades');
    r = apply(r.state, 2, { type: 'play', card: S(9) });
    r = apply(r.state, 3, { type: 'play', card: S(11) });
    assert.deepEqual(r.state.pile, [ACE_OF_SPADES, H(3), S(9), S(11)]);
    assert.equal(r.state.turn, 0);
    assert.equal(r.state.firstTrick, false);
    assert.ok(r.events.some((e) => e.type === 'trickToPile'));
  });

  it('after the first trick, an off-suit card is a thulla: the trick stops and the highest card picks it all up', () => {
    const s = makeState([[S(5), H(9)], [S(13), H(3)], [H(10), C(2)], [S(11), D(4)]], 0);
    let r = apply(s, 0, { type: 'play', card: S(5) });
    r = apply(r.state, 1, { type: 'play', card: S(13) });
    r = apply(r.state, 2, { type: 'play', card: H(10) });
    const st = r.state;
    assert.deepEqual(st.hands[1], [S(5), S(13), H(3), H(10)].sort((a, b) => a - b));
    assert.deepEqual(st.known[1], [S(5), S(13), H(10)].sort((a, b) => a - b), 'picked-up cards are public');
    assert.deepEqual(st.hands[3], [S(11), D(4)], 'seat 3 never played');
    assert.equal(st.voids[2][SUIT_SPADES], true);
    assert.equal(st.turn, 1, 'the player who picked up leads');
    assert.deepEqual(st.pile, []);
    const pickup = r.events.find((e) => e.type === 'pickup');
    assert.deepEqual(pickup && { seat: pickup.seat, cutter: pickup.cutter }, { seat: 1, cutter: 2 });
  });

  it('marks a player safe when their hand empties, and ends the game with one player left', () => {
    const s = makeState([[S(5)], [S(13), H(3)], [], []], 0, { finished: [2, 3] });
    let r = apply(s, 0, { type: 'play', card: S(5) });
    r = apply(r.state, 1, { type: 'play', card: S(13) });
    assert.equal(r.state.over, true);
    assert.equal(r.state.loser, 1);
    assert.deepEqual(r.state.finished, [2, 3, 0]);
    assert.ok(r.events.some((e) => e.type === 'safe' && e.seat === 0 && e.place === 3));
    assert.ok(r.events.some((e) => e.type === 'gameOver' && e.loser === 1));
  });

  it('passes the lead on when the winner of a pile trick has no cards left', () => {
    const s = makeState([[S(5), H(2)], [S(13)], [S(9), C(2)], [S(11), D(4)]], 0);
    let st = s;
    for (const [seat, card] of [[0, S(5)], [1, S(13)], [2, S(9)], [3, S(11)]] as const) {
      st = apply(st, seat, { type: 'play', card }).state;
    }
    assert.deepEqual(st.finished, [1]);
    assert.equal(st.turn, 2, 'seat 1 is out, so the next seat with cards leads');
    assert.deepEqual(st.parts, [2, 3, 0]);
  });
});

describe('what each seat may see', () => {
  it('never shows a seat any card from another hand unless it was picked up in public', () => {
    for (let i = 0; i < 60; i++) {
      const g = playRandomGame('view-' + i);
      for (const st of g.states) {
        for (let seat = 0; seat < 4; seat++) {
          const v = view(st, seat);
          assert.deepEqual(v.hand, st.hands[seat]);
          const visible = new Set<number>([...v.hand, ...v.pile, ...v.trick.map((t) => t.card), ...v.legal]);
          v.known.forEach((k) => k.forEach((c) => visible.add(c)));
          for (let other = 0; other < 4; other++) {
            if (other === seat) continue;
            for (const c of st.hands[other]) {
              if (st.known[other].indexOf(c) >= 0) continue;
              assert.ok(!visible.has(c), `seat ${seat} can see hidden card ${c} of seat ${other}`);
            }
          }
          assert.deepEqual(
            v.handSizes,
            st.hands.map((h) => h.length),
          );
          assert.deepEqual(v.legal, legalCards(st, seat));
        }
      }
    }
  });
});
