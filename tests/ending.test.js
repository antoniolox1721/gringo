import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../supabase/functions/_shared/engine.js';
import { hashToken } from '../supabase/functions/_shared/store.js';
import { handleAct, handleRoom } from '../supabase/functions/_shared/handlers.js';
import { c, fakeDb, stackedGame } from './helpers.js';

const { endingMs } = engine.PRESENCE;
const quiet = { notify: async () => true };

// b to move in the last round of a two player game; 4D on the pile.
function lastTurn() {
  const g = stackedGame({
    players: ['a', 'b'],
    hands: [[c('4', 'H'), c('9'), c('9'), c('9')], [c('3'), c('2'), c('2'), c('2')]],
    deck: [c('8', 'S'), c('8', 'H')],
    discard: [c('7', 'D')],
    turn: 1,
  });
  g.phase = 'final';
  g.finalLeft = ['b'];
  g.endedBy = { id: 'a', reason: 'gringo' };
  g.lastMoveAt = 1000;
  return g;
}

const endTurn = (s) => engine.discardDrawn(engine.draw(s, 'b').state, 'b');

test('the last turn opens a slap window and scores nothing yet', () => {
  const s = endTurn(lastTurn());
  assert.equal(s.phase, 'ending');
  assert.equal(s.result, null);
  assert.equal(engine.viewFor(s, 'a').players[1].hand[0].card, undefined, 'cards stay face down');
  assert.equal(engine.endingOver(s, 1000 + endingMs - 1), false);
  assert.equal(engine.endingOver(s, 1000 + endingMs), true);
  assert.equal(engine.settle(s, 1000 + endingMs - 1), s, 'settling early changes nothing');
});

test('a slap during the window counts in the final totals', () => {
  let s = endTurn(lastTurn());
  // b discarded an 8; give b a matching 8 to slap with.
  s = { ...s, players: s.players.map((p) => (p.id === 'b' ? { ...p, hand: [c('8', 'C'), ...p.hand.slice(1)] } : p)) };
  const before = engine.handTotal(s.players[1].hand);
  const slapped = engine.slap(s, 'b', { ownerId: 'b', slot: 0 }).state;
  assert.equal(slapped.phase, 'ending');
  assert.deepEqual(slapped.pending, []);
  const done = engine.settle(slapped, Infinity);
  assert.equal(done.result.totals.b, before - 8);
});

test('a slap after the window is refused and the game is scored by then', async () => {
  const s = endTurn(lastTurn());
  const db = fakeDb();
  db.rows.set('ABCD', { code: 'ABCD', state: s, tokens: { a: await hashToken('ta'), b: await hashToken('tb') }, version: s.version });
  const late = { now: () => 1000 + endingMs + 1 };
  const r = await handleAct(db, { code: 'ABCD', token: 'ta', action: 'slap', args: { ownerId: 'b', slot: 0 } }, { ...quiet, ...late });
  assert.equal(r.status, 400);
  const v = await handleRoom(db, { action: 'view', code: 'ABCD', token: 'ta' }, { ...quiet, ...late });
  assert.equal(v.body.view.phase, 'done');
  assert.ok(v.body.view.result.winners.length >= 1);
  assert.equal(db.rows.get('ABCD').state.phase, 'done');
});

test('a poll inside the window leaves it open; a leaver ends it at once', async () => {
  const s = endTurn(lastTurn());
  const db = fakeDb();
  db.rows.set('ABCD', { code: 'ABCD', state: s, tokens: { a: await hashToken('ta'), b: await hashToken('tb') }, version: s.version, seen: {} });
  const early = await handleRoom(db, { action: 'view', code: 'ABCD', token: 'ta' }, { ...quiet, now: () => 1500 });
  assert.equal(early.body.view.phase, 'ending');
  const left = engine.dropAbsent(s, ['b']);
  assert.equal(left.phase, 'done');
  assert.deepEqual(left.abandonedBy, ['b']);
});
