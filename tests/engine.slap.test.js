import test from 'node:test';
import assert from 'node:assert/strict';
import {
  slap, usePower, draw, discardDrawn, viewFor,
} from '../supabase/functions/_shared/engine.js';
import { c, stackedGame } from './helpers.js';

// Top of the pile is a 7 of spades.
function slapGame(extra = {}) {
  return stackedGame({
    players: ['a', 'b', 'c'],
    hands: [
      [c('7', 'H'), c('3'), c('4'), c('5')],
      [c('6'), c('7', 'D'), c('8'), c('9')],
      [c('7', 'C'), c('A'), c('2', 'H'), c('3', 'H')],
    ],
    deck: [c('9', 'H'), c('8', 'H'), c('2', 'S'), c('K', 'S')],
    discard: [c('4', 'D'), c('7', 'S')],
    turn: 2,
    ...extra,
  });
}

test('matching own card removes it', () => {
  const g = slapGame();
  const card = g.players[0].hand[0];
  const { state, ok } = slap(g, 'a', { ownerId: 'a', slot: 0 });
  assert.equal(ok, true);
  assert.equal(state.players[0].hand[0], null);
  assert.equal(state.players[0].hand.length, 4);
  assert.equal(state.discard.at(-1).uid, card.uid);
  assert.equal(state.discardClaimed, true);
  assert.equal(state.turn, 2);
});

test('second slap on the same pile card is penalised', () => {
  const g = slapGame();
  const first = slap(g, 'a', { ownerId: 'a', slot: 0 });
  const penaltyCard = first.state.deck[0];
  const second = slap(first.state, 'c', { ownerId: 'c', slot: 0 });
  assert.equal(second.ok, false);
  assert.equal(second.state.players[2].hand.length, 5);
  assert.equal(second.state.players[2].hand[4].uid, penaltyCard.uid);
  assert.equal(second.state.players[2].hand[0].rank, '7');
  assert.equal(second.state.discard.length, first.state.discard.length);
});

test('slap of rank mismatch gives penalty card', () => {
  const g = slapGame();
  const { state, ok } = slap(g, 'a', { ownerId: 'a', slot: 1 });
  assert.equal(ok, false);
  assert.equal(state.players[0].hand.length, 5);
  assert.equal(state.players[0].hand[1].rank, '3');
  assert.equal(state.deck.length, g.deck.length - 1);
  assert.equal(state.discardClaimed, false);
});

test('slapping an opponent\'s matching card moves it, slapper gives a card into the vacated slot', () => {
  const g = slapGame();
  const theirs = g.players[1].hand[1];
  const given = g.players[0].hand[2];
  const { state, ok } = slap(g, 'a', { ownerId: 'b', slot: 1, giveSlot: 2 });
  assert.equal(ok, true);
  assert.equal(state.discard.at(-1).uid, theirs.uid);
  assert.equal(state.players[1].hand[1].uid, given.uid);
  assert.equal(state.players[0].hand[2], null);
  assert.equal(state.discardClaimed, true);
});

test('slapping an opponent needs a giveSlot', () => {
  const g = slapGame();
  assert.throws(() => slap(g, 'a', { ownerId: 'b', slot: 1 }), /giveSlot/);
  assert.throws(() => slap(g, 'a', { ownerId: 'b', slot: 1, giveSlot: 9 }), /giveSlot/);
});

test('wrong slap on an opponent costs only the slapper', () => {
  const g = slapGame();
  const { state, ok } = slap(g, 'a', { ownerId: 'b', slot: 0, giveSlot: 1 });
  assert.equal(ok, false);
  assert.equal(state.players[0].hand.length, 5);
  assert.deepEqual(state.players[1].hand, g.players[1].hand);
  assert.deepEqual(state.players[0].hand.slice(0, 4), g.players[0].hand);
});

test('late slap on an opponent costs only the slapper', () => {
  const g = slapGame();
  const first = slap(g, 'a', { ownerId: 'a', slot: 0 }).state;
  const { state, ok } = slap(first, 'c', { ownerId: 'b', slot: 1, giveSlot: 0 });
  assert.equal(ok, false);
  assert.deepEqual(state.players[1].hand, first.players[1].hand);
  assert.equal(state.players[2].hand.length, 5);
});

test('slapped J/Q/K queues a pending power for the slapper', () => {
  const g = slapGame();
  g.discard = [c('4', 'D'), c('K', 'S')];
  g.players[0].hand[0] = c('K', 'C');
  const { state, ok } = slap(g, 'a', { ownerId: 'a', slot: 0 });
  assert.equal(ok, true);
  assert.deepEqual(state.pending, [{ type: 'K', by: 'a' }]);
  assert.equal(state.turn, 2);
  assert.throws(() => draw(state, 'c'), /pending/);
  const resolved = usePower(state, 'a', { type: 'K', targetId: 'b', slot: 0 }).state;
  assert.equal(resolved.turn, 2);
});

test('slap powers queue behind a turn power, in slap order', () => {
  const g = slapGame({ turn: 0 });
  g.discard = [c('4', 'D'), c('J', 'S')];
  g.pending = [{ type: 'J', by: 'a' }];
  g.acted = true;
  g.players[1].hand[1] = c('J', 'H');
  const s = slap(g, 'b', { ownerId: 'b', slot: 1 }).state;
  assert.deepEqual(s.pending, [{ type: 'J', by: 'a' }, { type: 'J', by: 'b' }]);
  const s2 = usePower(s, 'a', { type: 'J', mine: 0, targetId: 'c', theirs: 0 }).state;
  assert.equal(s2.turn, 0);
  const s3 = usePower(s2, 'b', { type: 'J', mine: 0, targetId: 'c', theirs: 1 }).state;
  assert.equal(s3.turn, 1);
});

test('a slapped card inherits claimed so a third player is penalised', () => {
  const g = slapGame();
  const s1 = slap(g, 'a', { ownerId: 'a', slot: 0 }).state;
  assert.equal(s1.discard.at(-1).rank, '7');
  const s2 = slap(s1, 'b', { ownerId: 'b', slot: 1 });
  assert.equal(s2.ok, false);
  const s3 = slap(s2.state, 'c', { ownerId: 'c', slot: 0 });
  assert.equal(s3.ok, false);
  assert.equal(s3.state.players[1].hand.length, 5);
  assert.equal(s3.state.players[2].hand.length, 5);
});

test('suits are ignored when matching', () => {
  assert.equal(slap(slapGame(), 'c', { ownerId: 'c', slot: 0 }).ok, true);
});

test('joker matches joker', () => {
  const g = slapGame();
  g.discard = [c('4', 'D'), c('JOKER')];
  g.players[0].hand[3] = c('JOKER');
  assert.equal(slap(g, 'a', { ownerId: 'a', slot: 3 }).ok, true);
  assert.equal(slap(g, 'a', { ownerId: 'a', slot: 0 }).ok, false);
});

test('slap with an empty deck draws the penalty from the reshuffled pile', () => {
  const g = slapGame({ deck: [], discard: [c('2', 'D'), c('3', 'D'), c('7', 'S')] });
  const { state, ok } = slap(g, 'a', { ownerId: 'a', slot: 1 });
  assert.equal(ok, false);
  assert.equal(state.players[0].hand.length, 5);
  assert.equal(state.discard.length, 1);
  assert.equal(state.deck.length, 1);
});

test('slap with deck and pile exhausted is a penalty-free no-op, not a crash', () => {
  const g = slapGame({ deck: [], discard: [c('7', 'S')] });
  const { state, ok } = slap(g, 'a', { ownerId: 'a', slot: 1 });
  assert.equal(ok, false);
  assert.equal(state.players[0].hand.length, 4);
});

test('slapping an emptied slot or an all-null hand is a wrong slap, not a crash', () => {
  const g = slapGame();
  g.players[1].hand = [null, null, null, null];
  const { state, ok } = slap(g, 'a', { ownerId: 'b', slot: 2, giveSlot: 1 });
  assert.equal(ok, false);
  assert.equal(state.players[0].hand.length, 5);
  assert.throws(() => slap(g, 'a', { ownerId: 'b', slot: 17, giveSlot: 1 }), /slot/);
  assert.throws(() => slap(g, 'a', { ownerId: 'nobody', slot: 0 }), /unknown player/);
});

test('slap is only allowed while the game is in play', () => {
  const g = slapGame();
  g.phase = 'setup';
  assert.throws(() => slap(g, 'a', { ownerId: 'a', slot: 0 }), /not in play/);
});

test('slap does not mutate input and bumps version', () => {
  const g = slapGame();
  const snap = JSON.stringify(g);
  const { state } = slap(g, 'a', { ownerId: 'a', slot: 0 });
  assert.equal(JSON.stringify(g), snap);
  assert.equal(state.version, g.version + 1);
});

test('slap-race: two slaps on the same pile card, exactly one succeeds', () => {
  const g = slapGame();
  const r1 = slap(g, 'a', { ownerId: 'a', slot: 0 });
  const r2 = slap(r1.state, 'c', { ownerId: 'c', slot: 0 });
  assert.deepEqual([r1.ok, r2.ok], [true, false]);
  assert.equal(r2.state.players[0].hand.filter(Boolean).length, 3);
  assert.equal(r2.state.players[2].hand.length, 5);
});

test('revealed slots are invalidated when a slap moves a card', () => {
  const g = slapGame();
  g.players[2].viewable = [{ ownerId: 'b', slot: 1 }];
  const { state } = slap(g, 'a', { ownerId: 'b', slot: 1, giveSlot: 2 });
  assert.deepEqual(state.players[2].viewable, []);
  assert.equal(viewFor(state, 'c').players[1].hand[1].card, undefined);
});

test('slap on empty pile gives penalty and does not crash', () => {
  const g = slapGame({ discard: [] });
  const { state, ok } = slap(g, 'a', { ownerId: 'a', slot: 0 });
  assert.equal(ok, false);
  assert.equal(state.players[0].hand.length, 5);
  assert.equal(state.discard.length, 0);
  assert.equal(viewFor(state, 'a').discardTop, null);
});

test('first discard becomes the top and can be matched', () => {
  const g = slapGame({ discard: [], turn: 0 });
  const s1 = discardDrawn(draw(g, 'a').state, 'a');
  assert.equal(s1.discard.length, 1);
  const rank = s1.discard[0].rank;
  const s2 = structuredClone(s1);
  s2.players[2].hand[0] = c(rank, 'C');
  const r = slap(s2, 'c', { ownerId: 'c', slot: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.state.discard.length, 2);
});

// Player 'a' holds an extra fifth card (a penalty) that is a 7.
function extraSlotGame() {
  const g = slapGame();
  g.players[0].hand = [c('9'), c('3'), c('4'), c('5'), c('7', 'H')];
  g.players[0].moves = [0, 0, 0, 0, 1];
  return g;
}

test('a penalty slot disappears again when its card is slapped away', () => {
  const { state, ok } = slap(extraSlotGame(), 'a', { ownerId: 'a', slot: 4 });
  assert.equal(ok, true);
  assert.equal(state.players[0].hand.length, 4);
  assert.ok(state.players[0].hand.every((x) => x !== null));
});

test('giving the penalty card away on a slap also removes its slot', () => {
  const g = extraSlotGame();
  const { state, ok } = slap(g, 'a', { ownerId: 'b', slot: 1, giveSlot: 4 });
  assert.equal(ok, true);
  assert.equal(state.players[0].hand.length, 4);
  assert.equal(state.players[1].hand[1].uid, g.players[0].hand[4].uid);
});

test('only the empty tail goes: gaps in the original four stay, and a hole before a live extra stays', () => {
  const g = extraSlotGame();
  const first = slap(g, 'a', { ownerId: 'a', slot: 4 });
  assert.equal(first.state.players[0].hand.length, 4);
  const gap = slap({ ...slapGame() }, 'a', { ownerId: 'a', slot: 0 });
  assert.equal(gap.state.players[0].hand.length, 4);
  assert.equal(gap.state.players[0].hand[0], null);
  const two = extraSlotGame();
  two.players[0].hand = [c('9'), c('3'), c('4'), c('7', 'H'), c('6')];
  const mid = slap(two, 'a', { ownerId: 'a', slot: 3 });
  assert.equal(mid.state.players[0].hand.length, 5);
  assert.equal(mid.state.players[0].hand[3], null);
});

test('a slot that comes back after being trimmed keeps counting its changes', () => {
  const g = extraSlotGame();
  const trimmed = slap(g, 'a', { ownerId: 'a', slot: 4 }).state;
  const before = viewFor(trimmed, 'a').players[0].hand.length;
  assert.equal(before, 4);
  trimmed.discardClaimed = true;
  const again = slap(trimmed, 'a', { ownerId: 'a', slot: 0 });
  assert.equal(again.ok, false);
  assert.equal(again.state.players[0].hand.length, 5);
  assert.equal(trimmed.players[0].moves[4], 2, 'removal counted as a change');
  assert.equal(viewFor(again.state, 'a').players[0].hand[4].ver, 3, 'the new card continues the counter, so a stale reveal cannot match it');
});
