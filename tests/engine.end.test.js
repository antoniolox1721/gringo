import test from 'node:test';
import assert from 'node:assert/strict';
import {
  callGringo, checkZero, finishGame, submitRps, draw, discardDrawn, slap, removePlayer,
  usePower, skipPower, viewFor,
} from '../supabase/functions/_shared/engine.js';
import { c, stackedGame } from './helpers.js';

function game(extra = {}) {
  return stackedGame({
    players: ['a', 'b', 'c'],
    hands: [
      [c('2'), c('3'), c('4'), c('5')],
      [c('6'), c('7'), c('8'), c('9')],
      [c('10'), c('A'), c('2', 'H'), c('3', 'H')],
    ],
    deck: [c('9', 'H'), c('8', 'H'), c('5', 'H'), c('6', 'H'), c('9', 'S')],
    discard: [c('4', 'D')],
    ...extra,
  });
}

const playTurn = (s, id) => discardDrawn(draw(s, id).state, id);

test('gringo gives each other player exactly one more turn and the caller none', () => {
  let s = callGringo(game(), 'a');
  assert.equal(s.players[0].gringo, true);
  assert.deepEqual(s.endedBy, { id: 'a', reason: 'gringo' });
  assert.equal(s.phase, 'final');
  assert.deepEqual(s.finalLeft, ['b', 'c']);
  assert.equal(s.turn, 1);
  assert.throws(() => draw(s, 'a'), /not your turn/);
  s = playTurn(s, 'b');
  assert.equal(s.phase, 'final');
  assert.equal(s.turn, 2);
  s = playTurn(s, 'c');
  assert.equal(s.phase, 'done');
  assert.deepEqual(s.result.winners, ['a']);
  assert.deepEqual(s.result.totals, { a: 14, b: 30, c: 16 });
});

test('with four players the caller is skipped when the round wraps', () => {
  const g = stackedGame({
    players: ['a', 'b', 'c', 'd'],
    hands: [[c('9'), c('9')], [c('2'), c('2')], [c('3'), c('3')], [c('4'), c('4')]],
    deck: [c('5'), c('5'), c('5'), c('5')],
    turn: 1,
  });
  let s = callGringo(g, 'b');
  assert.equal(s.turn, 2);
  s = playTurn(s, 'c');
  s = playTurn(s, 'd');
  assert.equal(s.turn, 0);
  s = playTurn(s, 'a');
  assert.equal(s.phase, 'done');
});

test('gringo only on own turn before drawing', () => {
  const g = game();
  assert.throws(() => callGringo(g, 'b'), /not your turn/);
  assert.throws(() => callGringo(draw(g, 'a').state, 'a'), /before drawing/);
  const withPending = { ...g, pending: [{ type: 'J', by: 'a' }] };
  assert.throws(() => callGringo(withPending, 'a'), /pending/);
  const s = callGringo(g, 'a');
  assert.throws(() => callGringo(s, 'b'), /final round|started/);
});

test('reaching 0 cards by slap starts the final round', () => {
  const g = game({ discard: [c('4', 'D'), c('7', 'S')] });
  g.players[0].hand = [null, c('7', 'H'), null, null];
  const { state, ok } = slap(g, 'a', { ownerId: 'a', slot: 1 });
  assert.equal(ok, true);
  assert.deepEqual(state.endedBy, { id: 'a', reason: 'empty' });
  assert.equal(state.phase, 'final');
  assert.deepEqual(state.finalLeft, ['b', 'c']);
  assert.equal(state.turn, 1);
});

test('empty-hand trigger mid-turn of another player lets that turn count, then skips the empty player', () => {
  const g = game({ turn: 2, discard: [c('4', 'D'), c('7', 'S')] });
  g.players[0].hand = [c('7', 'H'), null, null, null];
  let s = slap(g, 'a', { ownerId: 'a', slot: 0 }).state;
  assert.deepEqual(s.finalLeft, ['b', 'c']);
  assert.equal(s.turn, 2);
  s = playTurn(s, 'c');
  assert.equal(s.turn, 1);
  assert.equal(s.phase, 'final');
  s = playTurn(s, 'b');
  assert.equal(s.phase, 'done');
  assert.deepEqual(s.result.winners, ['a']);
  assert.equal(s.result.totals.a, 0);
});

test('slapping an opponent that empties the slapper also ends the round', () => {
  const g = game({ discard: [c('4', 'D'), c('7', 'S')] });
  g.players[0].hand = [null, null, null, c('3')];
  g.players[1].hand[1] = c('7', 'D');
  const { state } = slap(g, 'a', { ownerId: 'b', slot: 1, giveSlot: 3 });
  assert.deepEqual(state.endedBy, { id: 'a', reason: 'empty' });
});

test('hitting 0 on your own turn passes the turn on immediately', () => {
  const g = game({ turn: 0, discard: [c('4', 'D'), c('7', 'S')] });
  g.players[0].hand = [c('7', 'H'), null, null, null];
  const s = slap(g, 'a', { ownerId: 'a', slot: 0 }).state;
  assert.equal(s.turn, 1);
});

test('hitting 0 with a slapped power waits for the power before passing the turn', () => {
  const g = game({ turn: 0, discard: [c('4', 'D'), c('J', 'S')] });
  g.players[0].hand = [c('J', 'H'), null, null, null];
  let s = slap(g, 'a', { ownerId: 'a', slot: 0 }).state;
  assert.equal(s.turn, 0);
  assert.throws(() => usePower(s, 'a', { type: 'J', mine: 0, targetId: 'b', theirs: 0 }), /empty/);
  s = skipPower(s, 'a');
  assert.equal(s.turn, 1);
});

test('checkZero ignores players who still hold cards and finished games', () => {
  const g = game();
  assert.equal(checkZero(g, 'a').endedBy, null);
  g.players[0].hand = [null, null, null, null];
  const s = checkZero(g, 'a');
  assert.deepEqual(s.endedBy, { id: 'a', reason: 'empty' });
  assert.deepEqual(checkZero(s, 'b').endedBy, { id: 'a', reason: 'empty' });
});

test('0-card player is still compared (red king hand beats 0)', () => {
  const g = game();
  g.phase = 'final';
  g.players[0].hand = [null, null, null, null];
  g.players[1].hand = [c('K', 'H'), null, null, null];
  const s = finishGame(g);
  assert.deepEqual(s.result.totals, { a: 0, b: -3, c: 16 });
  assert.deepEqual(s.result.winners, ['b']);
  assert.equal(s.phase, 'done');
});

test('lowest total wins', () => {
  const g = game();
  g.phase = 'final';
  const s = finishGame(g);
  assert.deepEqual(s.result.winners, ['a']);
});

test('tie goes to rps with only tied players', () => {
  const g = game();
  g.phase = 'final';
  g.players[0].hand = [c('2'), null, null, null];
  g.players[1].hand = [c('2', 'H'), null, null, null];
  const s = finishGame(g);
  assert.equal(s.phase, 'rps');
  assert.deepEqual(s.rps.players, ['a', 'b']);
  assert.deepEqual(s.result.winners, ['a', 'b']);
});

test('same points: the player with fewer cards wins without rps', () => {
  const g = game();
  g.phase = 'final';
  g.players[0].hand = [c('2'), c('3'), null, null];
  g.players[1].hand = [c('5', 'H'), null, null, null];
  g.players[2].hand = [c('10'), null, null, null];
  const s = finishGame(g);
  assert.equal(s.phase, 'done');
  assert.deepEqual(s.result.winners, ['b']);
  assert.equal(s.result.decidedBy, 'cards');
});

test('same points and same card count among the fewest still goes to rps', () => {
  const g = game();
  g.phase = 'final';
  g.players[0].hand = [c('2'), c('3'), null, null];
  g.players[2].hand = [c('2', 'D'), c('3', 'D'), null, null];
  g.players[1].hand = [c('4', 'H'), c('A', 'H'), null, null];
  const s = finishGame(g);
  assert.equal(s.phase, 'rps');
  assert.deepEqual(s.rps.players, ['a', 'b', 'c']);
});

function tied(n = 2) {
  const g = game();
  g.phase = 'final';
  const ids = ['a', 'b', 'c'].slice(0, n);
  g.players = g.players.map((p, i) => ({ ...p, hand: i < n ? [c('2'), null, null, null] : [c('10'), null, null, null] }));
  return { s: finishGame(g), ids };
}

test('rps rock beats scissors ends game', () => {
  let { s } = tied(2);
  s = submitRps(s, 'a', 'r');
  assert.equal(s.phase, 'rps');
  s = submitRps(s, 'b', 's');
  assert.equal(s.phase, 'done');
  assert.deepEqual(s.result.winners, ['a']);
});

test('rps paper beats rock and scissors beats paper', () => {
  let { s } = tied(2);
  s = submitRps(submitRps(s, 'a', 'r'), 'b', 'p');
  assert.deepEqual(s.result.winners, ['b']);
  ({ s } = tied(2));
  s = submitRps(submitRps(s, 'a', 'p'), 'b', 's');
  assert.deepEqual(s.result.winners, ['b']);
});

test('rps same pick repeats', () => {
  let { s } = tied(2);
  s = submitRps(submitRps(s, 'a', 'p'), 'b', 'p');
  assert.equal(s.phase, 'rps');
  assert.deepEqual(s.rps.picks, {});
  assert.equal(s.rps.round, 1);
  assert.deepEqual(s.rps.last, { a: 'p', b: 'p' });
  s = submitRps(submitRps(s, 'a', 'r'), 'b', 's');
  assert.equal(s.phase, 'done');
});

test('three-way different picks repeats', () => {
  let { s } = tied(3);
  s = submitRps(submitRps(submitRps(s, 'a', 'r'), 'b', 'p'), 'c', 's');
  assert.equal(s.phase, 'rps');
  assert.deepEqual(s.rps.players, ['a', 'b', 'c']);
  assert.equal(s.rps.round, 1);
});

test('three-way 2-of-3 win eliminates the loser and continues', () => {
  let { s } = tied(3);
  s = submitRps(submitRps(submitRps(s, 'a', 'r'), 'b', 'r'), 'c', 's');
  assert.equal(s.phase, 'rps');
  assert.deepEqual(s.rps.players, ['a', 'b']);
  s = submitRps(submitRps(s, 'a', 'p'), 'b', 'r');
  assert.equal(s.phase, 'done');
  assert.deepEqual(s.result.winners, ['a']);
});

test('rps rejects bad picks, outsiders and double picks, and hides picks in views', () => {
  let { s } = tied(2);
  assert.throws(() => submitRps(s, 'a', 'x'), /pick/);
  assert.throws(() => submitRps(s, 'c', 'r'), /not in the tiebreak/);
  s = submitRps(s, 'a', 'r');
  assert.throws(() => submitRps(s, 'a', 'p'), /already picked/);
  assert.equal(viewFor(s, 'a').rps.picks.a, 'r');
  assert.equal(viewFor(s, 'b').rps.picks.a, 'hidden');
  assert.throws(() => submitRps(game(), 'a', 'r'), /tiebreak/);
});

test('a tied player leaving during rps does not block it', () => {
  let { s } = tied(3);
  s = submitRps(submitRps(s, 'a', 'r'), 'b', 'p');
  s = removePlayer(s, 'c');
  assert.equal(s.phase, 'done');
  assert.deepEqual(s.result.winners, ['b']);
});

test('hands are revealed in view only when done', () => {
  const g = game();
  g.phase = 'final';
  const uid = g.players[1].hand[0].uid;
  assert.equal(viewFor(g, 'a').players[1].hand[0].card, undefined);
  const done = finishGame(g);
  assert.equal(done.phase, 'done');
  assert.equal(viewFor(done, 'a').players[1].hand[0].card.uid, uid);
  assert.equal(viewFor(done, 'a').result.winners.length, 1);
  const { s: inRps } = tied(2);
  assert.equal(viewFor(inRps, 'c').players[0].hand[0].card, undefined);
});

test('a disconnected player\'s turn is skipped in the final round and does not block ending', () => {
  let s = callGringo(game(), 'a');
  s = removePlayer(s, 'c');
  assert.deepEqual(s.finalLeft, ['b']);
  s = playTurn(s, 'b');
  assert.equal(s.phase, 'done');
  assert.ok(!s.result.winners.includes('c'));
});

test('disconnecting while it is your final turn ends the game when nobody is left', () => {
  let s = callGringo(game(), 'a');
  s = playTurn(s, 'b');
  assert.equal(s.turn, 2);
  s = removePlayer(s, 'c');
  assert.equal(s.phase, 'done');
});

test('gringo with every other player offline finishes immediately', () => {
  let g = game();
  g = removePlayer(removePlayer(g, 'b'), 'c');
  const s = callGringo(g, 'a');
  assert.equal(s.phase, 'done');
  assert.deepEqual(s.result.winners, ['a']);
});

test('no actions after the game is done', () => {
  const s = finishGame({ ...game(), phase: 'final' });
  assert.throws(() => draw(s, 'a'), /not in play/);
  assert.throws(() => slap(s, 'a', { ownerId: 'a', slot: 0 }), /not in play/);
});

test('the gringo caller can still be slapped on', () => {
  let g = game({ discard: [c('4', 'D'), c('2', 'S')] });
  g = callGringo(g, 'a');
  const { state, ok } = slap(g, 'b', { ownerId: 'a', slot: 0, giveSlot: 0 });
  assert.equal(ok, true);
  assert.equal(state.players[0].hand[0].uid, g.players[1].hand[0].uid);
});
