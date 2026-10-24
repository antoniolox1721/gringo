import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, addPlayer, removePlayer, startGame, peekSetup, viewFor,
} from '../supabase/functions/_shared/engine.js';
import { seededRng } from './helpers.js';

function lobby(n = 2) {
  let s = createGame('p1', 'Ann');
  for (let i = 2; i <= n; i++) s = addPlayer(s, `p${i}`, `Player ${i}`);
  return s;
}

test('createGame starts in the lobby with the host', () => {
  const s = createGame('p1', 'Ann');
  assert.equal(s.phase, 'lobby');
  assert.equal(s.players.length, 1);
  assert.equal(s.hostId, 'p1');
});

test('third player joins, fifth rejected', () => {
  let s = lobby(2);
  s = addPlayer(s, 'p3', 'C');
  assert.equal(s.players.length, 3);
  s = addPlayer(s, 'p4', 'D');
  assert.throws(() => addPlayer(s, 'p5', 'E'), /room full/);
});

test('joining after start is rejected', () => {
  const s = startGame(lobby(2), 'p1', seededRng());
  assert.throws(() => addPlayer(s, 'p3', 'C'), /already started/);
});

test('non-host cannot start', () => {
  assert.throws(() => startGame(lobby(2), 'p2'), /host/);
});

test('start with 1 player throws', () => {
  assert.throws(() => startGame(createGame('p1', 'A'), 'p1'), /2 players/);
});

test('deal gives 4 cards each and leaves the discard pile empty', () => {
  const s = startGame(lobby(3), 'p1', seededRng());
  assert.equal(s.phase, 'setup');
  for (const p of s.players) assert.equal(p.hand.length, 4);
  assert.equal(s.discard.length, 0);
  assert.equal(s.deck.length, 54 - 12);
  const uids = [...s.deck, ...s.discard, ...s.players.flatMap((p) => p.hand)].map((x) => x.uid);
  assert.equal(new Set(uids).size, 54);
});

test('pure functions do not mutate input and bump version', () => {
  const s0 = lobby(2);
  const snapshot = JSON.stringify(s0);
  const s1 = startGame(s0, 'p1', seededRng());
  assert.equal(JSON.stringify(s0), snapshot);
  assert.equal(s1.version, s0.version + 1);
});

test('peekSetup returns the two cards and rejects a second peek', () => {
  const s = startGame(lobby(2), 'p1', seededRng());
  const { state, seen } = peekSetup(s, 'p1', [0, 3]);
  assert.deepEqual(seen.map((x) => x.uid), [s.players[0].hand[0].uid, s.players[0].hand[3].uid]);
  assert.throws(() => peekSetup(state, 'p1', [1, 2]), /already peeked/);
});

test('peekSetup validates slots', () => {
  const s = startGame(lobby(2), 'p1', seededRng());
  assert.throws(() => peekSetup(s, 'p1', [0]), /2/);
  assert.throws(() => peekSetup(s, 'p1', [1, 1]), /distinct/);
  assert.throws(() => peekSetup(s, 'p1', [0, 4]), /slot/);
});

test('phase becomes turns after all peeked', () => {
  let s = startGame(lobby(3), 'p1', seededRng());
  s = peekSetup(s, 'p1', [0, 1]).state;
  s = peekSetup(s, 'p2', [0, 1]).state;
  assert.equal(s.phase, 'setup');
  s = peekSetup(s, 'p3', [2, 3]).state;
  assert.equal(s.phase, 'turns');
  assert.equal(s.turn, 0);
});

test('a disconnected player does not block the end of setup', () => {
  let s = startGame(lobby(3), 'p1', seededRng());
  s = peekSetup(s, 'p1', [0, 1]).state;
  s = peekSetup(s, 'p2', [0, 1]).state;
  s = removePlayer(s, 'p3');
  assert.equal(s.phase, 'turns');
});

test('removePlayer in lobby removes the player', () => {
  const s = removePlayer(lobby(3), 'p2');
  assert.deepEqual(s.players.map((p) => p.id), ['p1', 'p3']);
});

test('viewFor never contains another player\'s card objects', () => {
  let s = startGame(lobby(3), 'p1', seededRng());
  s = peekSetup(s, 'p1', [0, 1]).state;
  const view = viewFor(s, 'p1');
  const text = JSON.stringify(view);
  for (const other of s.players.slice(1)) {
    for (const card of other.hand) assert.ok(!text.includes(`"uid":${card.uid},`) && !text.includes(`"uid":${card.uid}}`), 'leaked opponent card');
  }
  const mine = view.players[0].hand;
  assert.ok(mine[0].card && mine[1].card);
  assert.equal(mine[2].card, undefined);
  assert.equal(mine[2].empty, false);
});

test('viewFor hides deck contents', () => {
  const s = startGame(lobby(2), 'p1', seededRng());
  const text = JSON.stringify(viewFor(s, 'p1'));
  for (const card of s.deck) assert.ok(!text.includes(`"uid":${card.uid},`) && !text.includes(`"uid":${card.uid}}`));
  assert.equal(viewFor(s, 'p1').deckCount, s.deck.length);
  assert.equal(viewFor(s, 'p1').deck, undefined);
});

test('game starts with an empty discard pile', () => {
  const s = startGame(lobby(2), 'p1', seededRng());
  assert.deepEqual(s.discard, []);
  assert.equal(s.discardClaimed, false);
  const v = viewFor(s, 'p1');
  assert.equal(v.discardTop, null);
  assert.equal(v.discardCount, 0);
});
