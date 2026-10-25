import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../supabase/functions/_shared/engine.js';
import { c, seededRng, stackedGame } from './helpers.js';

function finished() {
  const s = stackedGame({
    players: ['a', 'b', 'c'],
    hands: [[c('9')], [c('2')], [c('7')]],
  });
  s.phase = 'final';
  s.finalLeft = [];
  s.rematch = [];
  s.hostId = 'a';
  const done = engine.finishGame(s);
  assert.deepEqual(done.result.winners, ['b']);
  return done;
}

const rng = seededRng(3);

test('a rematch waits until every player has voted', () => {
  let s = engine.voteRematch(finished(), 'a', rng);
  assert.equal(s.phase, 'done');
  s = engine.voteRematch(s, 'c', rng);
  assert.equal(s.phase, 'done');
  assert.deepEqual(engine.viewFor(s, 'a').rematch, ['a', 'c']);
  assert.equal(engine.voteRematch(s, 'a', rng), s, 'a repeat vote changes nothing');
});

test('the full vote deals a fresh game and the last winner starts', () => {
  let s = finished();
  for (const id of ['a', 'b', 'c']) s = engine.voteRematch(s, id, rng);
  assert.equal(s.phase, 'setup');
  assert.equal(s.players.length, 3);
  for (const p of s.players) {
    assert.equal(p.hand.length, 4);
    assert.deepEqual(p.seenSlots, []);
    assert.equal(p.gringo, false);
  }
  assert.equal(s.result, null);
  assert.deepEqual(s.rematch, []);
  assert.equal(s.endedBy, null);
  assert.equal(s.deck.length, 54 - 12);
  for (const id of ['a', 'b', 'c']) s = engine.peekSetup(s, id, [0, 1]).state;
  assert.equal(s.phase, 'turns');
  assert.equal(s.players[s.turn].id, 'b');
});

test('a player who walked away is dropped and the rest can still rematch', () => {
  let s = engine.voteRematch(finished(), 'a', rng);
  s = engine.voteRematch(s, 'b', rng);
  s = engine.dropAbsent(s, ['c']);
  assert.equal(s.phase, 'setup');
  assert.deepEqual(s.players.map((p) => p.id), ['a', 'b']);
});

test('if the winner left, the first remaining player starts; one player left cannot rematch', () => {
  let s = engine.voteRematch(finished(), 'a', rng);
  s = engine.voteRematch(s, 'c', rng);
  s = engine.dropAbsent(s, ['b']);
  assert.equal(s.phase, 'setup');
  for (const id of ['a', 'c']) s = engine.peekSetup(s, id, [0, 1]).state;
  assert.equal(s.players[s.turn].id, 'a');

  let t = engine.voteRematch(finished(), 'a', rng);
  t = engine.dropAbsent(t, ['b', 'c']);
  assert.equal(t.phase, 'done');
});

test('voting is refused mid-game and for players who are not in the room', () => {
  const mid = stackedGame({ players: ['a', 'b'], hands: [[c('2')], [c('3')]] });
  assert.throws(() => engine.voteRematch(mid, 'a', rng), /not over/);
  assert.throws(() => engine.voteRematch(finished(), 'zed', rng), /unknown player/);
});
