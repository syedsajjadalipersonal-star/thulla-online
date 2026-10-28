import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, setup, view, type ThullaEvent } from '@thulla/engine';
import { rotate, rotateEvents, seatAt, stateFromView } from '../src/online';

test('turns server seats so that your own seat is at the bottom', () => {
  for (let me = 0; me < 4; me++) {
    assert.equal(rotate(me, me), 0);
    for (let p = 0; p < 4; p++) assert.equal(rotate(seatAt(p, me), me), p);
  }
  assert.equal(rotate(-1, 2), -1);
  // Clockwise order is kept: the next seat after you is on your left.
  assert.equal(rotate(3, 2), 1);
});

test('builds a table from one view without inventing anyone else’s cards', () => {
  let state = setup('online-test');
  const events: ThullaEvent[][] = [];
  for (let i = 0; i < 9; i++) {
    const r = apply(state, state.turn, { type: 'play', card: view(state, state.turn).legal[0] });
    state = r.state;
    events.push(r.events);
  }
  for (let me = 0; me < 4; me++) {
    const t = stateFromView(view(state, me), me);
    assert.deepEqual(t.hands[0], state.hands[me]);
    for (let p = 1; p < 4; p++) {
      assert.equal(t.hands[p].length, state.hands[seatAt(p, me)].length);
      assert.ok(t.hands[p].every((c) => c === -1));
    }
    assert.equal(t.turn, rotate(state.turn, me));
    assert.deepEqual(
      t.trick,
      state.trick.map((x) => ({ seat: rotate(x.seat, me), card: x.card })),
    );
    for (const e of rotateEvents(events.flat(), me)) {
      if (e.type === 'played' || e.type === 'lead' || e.type === 'safe') assert.ok(e.seat >= 0 && e.seat < 4);
    }
  }
});
