import test from 'node:test';
import assert from 'node:assert/strict';
import {
  usePower, confirmKing, skipPower, draw, viewFor,
} from '../supabase/functions/_shared/engine.js';
import { c, stackedGame } from './helpers.js';

// Player 'a' has just discarded a power card; the power is pending and the turn has been acted.
function powerGame(type, extra = {}) {
  const g = stackedGame({
    players: ['a', 'b', 'c'],
    hands: [
      [c('2'), c('3'), c('4'), c('5')],
      [c('6'), c('7'), c('8'), c('9')],
      [c('10'), c('A'), c('2', 'H'), c('3', 'H')],
    ],
    deck: [c('9', 'H'), c('8', 'H'), c('7', 'H')],
    discard: [c('4', 'D'), c(type, 'S')],
  });
  g.pending = [{ type, by: 'a' }];
  g.acted = true;
  return Object.assign(g, extra);
}

test('J swaps two slots blindly', () => {
  const g = powerGame('J');
  const mine = g.players[0].hand[0];
  const theirs = g.players[1].hand[1];
  const { state } = usePower(g, 'a', { type: 'J', mine: 0, targetId: 'b', theirs: 1 });
  assert.equal(state.players[0].hand[0].uid, theirs.uid);
  assert.equal(state.players[1].hand[1].uid, mine.uid);
  assert.deepEqual(state.pending, []);
  assert.equal(state.turn, 1);
});

test('J on a gringo-called player is rejected', () => {
  const g = powerGame('J');
  g.players[1].gringo = true;
  assert.throws(() => usePower(g, 'a', { type: 'J', mine: 0, targetId: 'b', theirs: 1 }), /gringo/);
});

test('J rejects null slots and self-targeting', () => {
  const g = powerGame('J');
  g.players[1].hand[1] = null;
  assert.throws(() => usePower(g, 'a', { type: 'J', mine: 0, targetId: 'b', theirs: 1 }), /empty/);
  assert.throws(() => usePower(g, 'a', { type: 'J', mine: 0, targetId: 'a', theirs: 1 }), /another player/);
});

test('Q reveals only to the user, nobody else\'s view changes', () => {
  const g = powerGame('Q');
  const target = g.players[1].hand[2];
  const before = JSON.stringify(viewFor(g, 'c'));
  const { state, seen } = usePower(g, 'a', { type: 'Q', targetId: 'b', slot: 2 });
  assert.equal(seen.uid, target.uid);
  assert.equal(viewFor(state, 'a').players[1].hand[2].card.uid, target.uid);
  assert.equal(viewFor(state, 'b').players[1].hand[2].card, undefined);
  const after = JSON.parse(JSON.stringify(viewFor(state, 'c')));
  const was = JSON.parse(before);
  assert.deepEqual({ ...after, version: 0, turn: 0, turnId: 'a' }, { ...was, version: 0, pending: [] });
  assert.ok(!JSON.stringify(viewFor(state, 'c')).includes(`"uid":${target.uid},`));
  assert.equal(state.turn, 1);
});

test('Q can look at one of your own cards', () => {
  const g = powerGame('Q');
  const { seen } = usePower(g, 'a', { type: 'Q', targetId: 'a', slot: 3 });
  assert.equal(seen.uid, g.players[0].hand[3].uid);
});

test('a reveal is cleared on the revealed-to player\'s next action', () => {
  const g = powerGame('Q');
  let { state } = usePower(g, 'a', { type: 'Q', targetId: 'b', slot: 2 });
  assert.equal(state.players[0].viewable.length, 1);
  state = { ...state, turn: 0 };
  state = draw(state, 'a').state;
  assert.deepEqual(state.players[0].viewable, []);
});

test('K reveal then decline leaves hands unchanged', () => {
  const g = powerGame('K');
  const r = usePower(g, 'a', { type: 'K', targetId: 'b', slot: 0 });
  assert.equal(r.seen.uid, g.players[1].hand[0].uid);
  assert.equal(r.state.pending.length, 1);
  assert.equal(r.state.turn, 0);
  const s = confirmKing(r.state, 'a', null);
  assert.deepEqual(s.players.map((p) => p.hand), g.players.map((p) => p.hand));
  assert.deepEqual(s.pending, []);
  assert.equal(s.turn, 1);
});

test('K reveal then swap exchanges', () => {
  const g = powerGame('K');
  const r = usePower(g, 'a', { type: 'K', targetId: 'b', slot: 0 });
  const s = confirmKing(r.state, 'a', 3);
  assert.equal(s.players[0].hand[3].uid, g.players[1].hand[0].uid);
  assert.equal(s.players[1].hand[0].uid, g.players[0].hand[3].uid);
  assert.equal(s.turn, 1);
});

test('K cannot swap with a gringo caller but may still look and decline', () => {
  const g = powerGame('K');
  g.players[1].gringo = true;
  const r = usePower(g, 'a', { type: 'K', targetId: 'b', slot: 0 });
  assert.throws(() => confirmKing(r.state, 'a', 3), /gringo/);
  assert.equal(confirmKing(r.state, 'a', null).turn, 1);
});

test('confirmKing needs a K reveal first', () => {
  assert.throws(() => confirmKing(powerGame('K'), 'a', null), /reveal/);
});

test('K must look at another player', () => {
  assert.throws(() => usePower(powerGame('K'), 'a', { type: 'K', targetId: 'a', slot: 0 }), /another player/);
});

test('power against a player with an all-null hand can be skipped', () => {
  const g = powerGame('J');
  g.players[1].hand = [null, null, null, null];
  assert.throws(() => usePower(g, 'a', { type: 'J', mine: 0, targetId: 'b', theirs: 0 }), /empty/);
  const q = powerGame('Q');
  q.players[1].hand = [null, null];
  assert.throws(() => usePower(q, 'a', { type: 'Q', targetId: 'b', slot: 0 }), /empty/);
  const s = skipPower(g, 'a');
  assert.deepEqual(s.pending, []);
  assert.equal(s.turn, 1);
});

test('turn advances only after pending is empty', () => {
  const g = powerGame('J');
  g.pending.push({ type: 'Q', by: 'b' });
  const s1 = usePower(g, 'a', { type: 'J', mine: 0, targetId: 'c', theirs: 0 }).state;
  assert.equal(s1.pending.length, 1);
  assert.equal(s1.turn, 0);
  const s2 = usePower(s1, 'b', { type: 'Q', targetId: 'c', slot: 1 }).state;
  assert.equal(s2.pending.length, 0);
  assert.equal(s2.turn, 1);
});

test('only the first pending owner may resolve, and with the right power type', () => {
  const g = powerGame('J');
  g.pending.push({ type: 'Q', by: 'b' });
  assert.throws(() => usePower(g, 'b', { type: 'Q', targetId: 'c', slot: 0 }), /not your power/);
  assert.throws(() => usePower(g, 'a', { type: 'Q', targetId: 'c', slot: 0 }), /pending J/);
  assert.throws(() => skipPower(g, 'b'), /not your power/);
});

test('usePower with nothing pending throws', () => {
  const g = powerGame('J');
  g.pending = [];
  assert.throws(() => usePower(g, 'a', { type: 'J', mine: 0, targetId: 'b', theirs: 0 }), /no pending/);
});

test('a power resolved by a slapper does not advance the turn', () => {
  const g = powerGame('J');
  g.acted = false;
  g.pending = [{ type: 'J', by: 'c' }];
  const s = usePower(g, 'c', { type: 'J', mine: 0, targetId: 'b', theirs: 0 }).state;
  assert.equal(s.turn, 0);
  assert.equal(s.acted, false);
});

test('a swap invalidates stale reveals of the swapped slots', () => {
  const g = powerGame('J');
  g.players[2].viewable = [{ ownerId: 'b', slot: 1 }];
  const s = usePower(g, 'a', { type: 'J', mine: 0, targetId: 'b', theirs: 1 }).state;
  assert.deepEqual(s.players[2].viewable, []);
});
