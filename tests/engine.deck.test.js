import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeck, shuffle, cardValue, handTotal } from '../supabase/functions/_shared/engine.js';
import { c } from './helpers.js';

test('buildDeck has 54 cards incl. exactly 2 jokers and unique uids', () => {
  const deck = buildDeck();
  assert.equal(deck.length, 54);
  assert.equal(deck.filter((x) => x.rank === 'JOKER').length, 2);
  assert.equal(new Set(deck.map((x) => x.uid)).size, 54);
  assert.equal(deck.filter((x) => x.rank === 'K' && (x.suit === 'H' || x.suit === 'D')).length, 2);
});

test('cardValue follows the scoring table', () => {
  assert.equal(cardValue(c('A', 'S')), 1);
  assert.equal(cardValue(c('7', 'C')), 7);
  assert.equal(cardValue(c('10', 'D')), 10);
  assert.equal(cardValue(c('J', 'H')), 10);
  assert.equal(cardValue(c('Q', 'S')), 10);
  assert.equal(cardValue(c('K', 'S')), 10);
  assert.equal(cardValue(c('K', 'C')), 10);
  assert.equal(cardValue(c('K', 'H')), -3);
  assert.equal(cardValue(c('K', 'D')), -3);
  assert.equal(cardValue(c('JOKER')), 0);
});

test('handTotal ignores nulls', () => {
  assert.equal(handTotal([c('A'), null, c('K', 'H'), c('5')]), 3);
  assert.equal(handTotal([null, null]), 0);
});

test('shuffle keeps all cards and does not mutate input', () => {
  const deck = buildDeck();
  const before = deck.map((x) => x.uid);
  const out = shuffle(deck);
  assert.deepEqual(deck.map((x) => x.uid), before);
  assert.notEqual(out, deck);
  assert.deepEqual(out.map((x) => x.uid).sort((a, b) => a - b), [...before].sort((a, b) => a - b));
});

test('shuffle is deterministic for a given rng', () => {
  const mk = () => { let n = 7; return () => (n = (n * 16807) % 2147483647) / 2147483647; };
  const a = shuffle(buildDeck(), mk()).map((x) => x.uid);
  const b = shuffle(buildDeck(), mk()).map((x) => x.uid);
  assert.deepEqual(a, b);
});
