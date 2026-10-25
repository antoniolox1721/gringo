import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../supabase/functions/_shared/engine.js';
import { c, stackedGame } from './helpers.js';

const OFFLINE = /player is not in the game/;

function offlineGame(overrides = {}) {
  const s = stackedGame({
    players: ['a', 'b', 'c'],
    hands: [
      [c('2'), c('3'), c('4'), c('5')],
      [c('6'), c('7'), c('8'), c('9')],
      [c('10'), c('A'), c('2'), c('3')],
    ],
    deck: [c('9', 'H'), c('8', 'H'), c('2', 'S')],
    discard: [c('4', 'D')],
    turn: 1,
  });
  s.players[1].connected = false;
  return Object.assign(s, overrides);
}

test('secureRandom stays in [0, 1) and is not constant', () => {
  const xs = Array.from({ length: 2000 }, () => engine.secureRandom());
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.ok(new Set(xs).size > 1990);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(mean > 0.45 && mean < 0.55);
});

test('shuffle and startGame default to the CSPRNG, not Math.random', () => {
  const orig = Math.random;
  Math.random = () => { throw new Error('Math.random used'); };
  try {
    const deck = engine.shuffle(engine.buildDeck());
    assert.equal(new Set(deck.map((x) => x.uid)).size, 54);
    let g = engine.createGame('a', 'A');
    g = engine.addPlayer(g, 'b', 'B');
    const started = engine.startGame(g, 'a');
    assert.equal(started.phase, 'setup');
    const s = offlineGame();
    s.players[1].connected = true;
    s.deck = [];
    s.discard = [c('4', 'D'), c('5'), c('6'), c('4', 'C')];
    assert.equal(engine.draw({ ...s, turn: 0 }, 'a').state.deck.length, 2);
    const wrong = engine.slap({ ...s, turn: 0 }, 'a', { ownerId: 'a', slot: 0 });
    assert.equal(wrong.ok, false);
  } finally {
    Math.random = orig;
  }
});

test('an injected rng still makes shuffle deterministic', () => {
  const rng = () => 0;
  assert.deepEqual(engine.shuffle([1, 2, 3, 4], rng), [2, 3, 4, 1]);
});

test('every action entry point rejects a disconnected player', () => {
  const s = offlineGame({ drawn: c('5') });
  const calls = {
    draw: () => engine.draw(s, 'b'),
    keep: () => engine.keep(s, 'b', 0),
    discardDrawn: () => engine.discardDrawn(s, 'b'),
    usePower: () => engine.usePower({ ...s, pending: [{ type: 'Q', by: 'b' }] }, 'b', { type: 'Q', targetId: 'a', slot: 0 }),
    confirmKing: () => engine.confirmKing({ ...s, pending: [{ type: 'K', by: 'b', target: { ownerId: 'a', slot: 0 }, own: { slot: 0 } }] }, 'b', false),
    kingLook: () => engine.kingLook({ ...s, pending: [{ type: 'K', by: 'b', target: { ownerId: 'a', slot: 0 } }] }, 'b', 0),
    skipPower: () => engine.skipPower({ ...s, pending: [{ type: 'Q', by: 'b' }] }, 'b'),
    slap: () => engine.slap(s, 'b', { ownerId: 'a', slot: 0 }),
    callGringo: () => engine.callGringo({ ...s, drawn: null }, 'b'),
    submitRps: () => engine.submitRps({ ...s, phase: 'rps', rps: { players: ['a', 'b'], picks: {}, round: 0, last: null } }, 'b', 'r'),
    peekSetup: () => engine.peekSetup({ ...s, phase: 'setup' }, 'b', [0, 1]),
  };
  for (const [name, fn] of Object.entries(calls)) assert.throws(fn, OFFLINE, name);
});

test('kicking a player with a pending power does not block the turn', () => {
  let s = stackedGame({
    players: ['a', 'b', 'c'],
    hands: [[c('2'), c('3')], [c('6'), c('7')], [c('10'), c('A')]],
    deck: [c('9', 'H')],
    discard: [c('4', 'D')],
    turn: 0,
  });
  s.players[0].connected = true;
  s = engine.draw(s, 'a').state;
  s = { ...s, drawn: c('Q') };
  s = engine.discardDrawn(s, 'a');
  assert.deepEqual(s.pending.map((p) => p.by), ['a']);
  const next = engine.removePlayer(s, 'a');
  assert.deepEqual(next.pending, []);
  assert.equal(next.players[next.turn].id, 'b');
});

test('kicking a player with a queued slap power drops only their entry', () => {
  const s = offlineGame({ pending: [{ type: 'Q', by: 'b' }, { type: 'J', by: 'c' }] });
  s.players[1].connected = true;
  s.turn = 0;
  const next = engine.removePlayer(s, 'b');
  assert.deepEqual(next.pending, [{ type: 'J', by: 'c' }]);
});

test('kicking a player mid-rps removes them and unblocks the round', () => {
  const s = offlineGame({ phase: 'rps', result: { totals: {}, winners: ['a', 'b', 'c'] } });
  s.players[1].connected = true;
  s.rps = { players: ['a', 'b', 'c'], picks: { a: 'r', c: 's' }, round: 0, last: null };
  const next = engine.removePlayer(s, 'b');
  assert.equal(next.phase, 'done');
  assert.deepEqual(next.result.winners, ['a']);
});

test('kicking a player in the final round removes them from finalLeft', () => {
  const s = offlineGame({ phase: 'final', endedBy: { id: 'a', reason: 'gringo' }, finalLeft: ['b', 'c'], turn: 2 });
  s.players[1].connected = true;
  const next = engine.removePlayer(s, 'b');
  assert.deepEqual(next.finalLeft, ['c']);
});
