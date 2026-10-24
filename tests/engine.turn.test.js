import test from 'node:test';
import assert from 'node:assert/strict';
import {
  draw, keep, discardDrawn, nextTurn, removePlayer,
} from '../supabase/functions/_shared/engine.js';
import { c, stackedGame, seededRng } from './helpers.js';

function game(extra = {}) {
  return stackedGame({
    players: ['a', 'b', 'c'],
    hands: [
      [c('2'), c('3'), c('4'), c('5')],
      [c('6'), c('7'), c('8'), c('9')],
      [c('10'), c('A'), c('2', 'H'), c('3', 'H')],
    ],
    deck: [c('9', 'H'), c('8', 'H'), c('7', 'H')],
    discard: [c('4', 'D')],
    ...extra,
  });
}

test('draw then discard moves card to pile and advances turn', () => {
  const g = game();
  const top = g.deck[0];
  const { state: s1, card } = draw(g, 'a');
  assert.equal(card.uid, top.uid);
  assert.equal(s1.drawn.uid, top.uid);
  assert.equal(s1.deck.length, 2);
  const s2 = discardDrawn(s1, 'a');
  assert.equal(s2.discard.at(-1).uid, top.uid);
  assert.equal(s2.drawn, null);
  assert.equal(s2.turn, 1);
  assert.equal(s2.discardClaimed, false);
});

test('keep swaps and discards old card', () => {
  const g = game();
  const old = g.players[0].hand[2];
  const drawnCard = g.deck[0];
  const s = keep(draw(g, 'a').state, 'a', 2);
  assert.equal(s.players[0].hand[2].uid, drawnCard.uid);
  assert.equal(s.discard.at(-1).uid, old.uid);
  assert.equal(s.turn, 1);
});

test('keep into an emptied slot (null) is rejected', () => {
  const g = game();
  g.players[0].hand[1] = null;
  const { state } = draw(g, 'a');
  assert.throws(() => keep(state, 'a', 1), /empty/);
  assert.throws(() => keep(state, 'a', 9), /slot/);
});

test('keep and discard require a drawn card', () => {
  const g = game();
  assert.throws(() => keep(g, 'a', 0), /draw first/);
  assert.throws(() => discardDrawn(g, 'a'), /draw first/);
});

test('cannot draw twice', () => {
  const { state } = draw(game(), 'a');
  assert.throws(() => draw(state, 'a'), /already drawn/);
});

test('non-turn player cannot draw', () => {
  assert.throws(() => draw(game(), 'b'), /not your turn/);
});

test('draw does not mutate the input state', () => {
  const g = game();
  const snap = JSON.stringify(g);
  const { state } = draw(g, 'a');
  assert.equal(JSON.stringify(g), snap);
  assert.equal(state.version, g.version + 1);
});

test('draw with empty deck reshuffles pile but keeps top discard', () => {
  const pile = [c('2', 'D'), c('3', 'D'), c('5', 'D'), c('6', 'D')];
  const g = game({ deck: [], discard: pile });
  const { state, card } = draw(g, 'a', seededRng(3));
  assert.equal(state.discard.length, 1);
  assert.equal(state.discard[0].uid, pile[3].uid);
  assert.equal(state.deck.length, 2);
  const ids = [card, ...state.deck].map((x) => x.uid).sort();
  assert.deepEqual(ids, [pile[0].uid, pile[1].uid, pile[2].uid].sort());
});

test('draw with a single deck card then empty deck reshuffles on the next draw', () => {
  const g = game({ deck: [c('9', 'H')], discard: [c('2', 'D'), c('3', 'D'), c('5', 'D')] });
  let s = draw(g, 'a').state;
  s = discardDrawn(s, 'a');
  assert.equal(s.deck.length, 0);
  const r = draw(s, 'b', seededRng(2));
  assert.equal(r.state.discard.length, 1);
  assert.equal(r.state.discard[0].uid, s.discard.at(-1).uid);
  assert.equal(r.state.deck.length, 2);
});

test('draw with deck and pile exhausted throws', () => {
  const g = game({ deck: [], discard: [c('2', 'D')] });
  assert.throws(() => draw(g, 'a'), /no cards/);
});

test('discarding a J queues a pending J and does not advance turn', () => {
  const g = game({ deck: [c('J', 'S'), c('2', 'S')] });
  const s = discardDrawn(draw(g, 'a').state, 'a');
  assert.deepEqual(s.pending, [{ type: 'J', by: 'a' }]);
  assert.equal(s.turn, 0);
});

test('keeping a card that swaps out a Q queues a pending Q', () => {
  const g = game();
  g.players[0].hand[0] = c('Q', 'H');
  const s = keep(draw(g, 'a').state, 'a', 0);
  assert.deepEqual(s.pending, [{ type: 'Q', by: 'a' }]);
  assert.equal(s.turn, 0);
});

test('cannot draw while powers are pending', () => {
  const g = game({ deck: [c('K', 'S'), c('2', 'S'), c('3', 'S')] });
  const s = discardDrawn(draw(g, 'a').state, 'a');
  assert.throws(() => draw(s, 'a'), /pending/);
});

test('discarding a 5 advances turn', () => {
  const g = game({ deck: [c('5', 'S'), c('2', 'S')] });
  const s = discardDrawn(draw(g, 'a').state, 'a');
  assert.deepEqual(s.pending, []);
  assert.equal(s.turn, 1);
});

test('turn order wraps around', () => {
  let s = game({ turn: 2 });
  s = discardDrawn(draw(s, 'c').state, 'c');
  assert.equal(s.turn, 0);
});

test('disconnected players are skipped', () => {
  let g = game();
  g = removePlayer(g, 'b');
  const s = discardDrawn(draw(g, 'a').state, 'a');
  assert.equal(s.turn, 2);
});

test('nextTurn skips disconnected players', () => {
  let g = game();
  g = removePlayer(g, 'b');
  assert.equal(nextTurn(g).turn, 2);
});

test('removing the player whose turn it is auto-skips and drops their held card', () => {
  const { state } = draw(game(), 'a');
  const s = removePlayer(state, 'a');
  assert.equal(s.turn, 1);
  assert.equal(s.drawn, null);
  assert.equal(s.discard.length, 2);
  assert.deepEqual(s.pending, []);
});

test('draw with deck empty and pile of two takes the buried card and keeps the top', () => {
  const buried = c('2', 'D');
  const top = c('3', 'D');
  const g = game({ deck: [], discard: [buried, top] });
  const { state, card } = draw(g, 'a');
  assert.equal(card.uid, buried.uid);
  assert.deepEqual(state.discard.map((x) => x.uid), [top.uid]);
  assert.equal(state.deck.length, 0);
});

test('draw with empty deck and empty pile throws no cards', () => {
  const g = game({ deck: [], discard: [] });
  assert.throws(() => draw(g, 'a'), /no cards/);
});

test('draw with empty deck and single-card pile throws no cards and keeps the card', () => {
  const g = game({ deck: [], discard: [c('2', 'D')] });
  assert.throws(() => draw(g, 'a'), /no cards/);
  assert.equal(g.discard.length, 1);
});
