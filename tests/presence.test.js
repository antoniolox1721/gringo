import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../supabase/functions/_shared/engine.js';
import { hashToken } from '../supabase/functions/_shared/store.js';
import { handleRoom } from '../supabase/functions/_shared/handlers.js';
import { c, fakeDb, seededRng, stackedGame } from './helpers.js';

const { staleMs, byeGraceMs } = engine.PRESENCE;
const quiet = { notify: async () => true };
const rng = seededRng(7);

function lobby(n = 3) {
  let s = engine.createGame('p0', 'p0');
  for (let i = 1; i < n; i++) s = engine.addPlayer(s, `p${i}`, `p${i}`);
  return s;
}

function stacked(n = 3) {
  return stackedGame({
    players: Array.from({ length: n }, (_, i) => `p${i}`),
    hands: Array.from({ length: n }, (_, i) => [c('5'), c('6'), c('7'), c(String(2 + i))]),
    deck: [c('9', 'H'), c('8', 'H'), c('2', 'S'), c('3', 'S')],
  });
}

// Every phase a game can be in, for 3 players.
function phases() {
  const mid = stacked();
  const drawn = engine.draw(mid, 'p0', rng).state;
  const queen = { ...mid, pending: [{ type: 'Q', by: 'p1' }] };
  const final = engine.callGringo(mid, 'p0');
  const tied = stackedGame({
    players: ['p0', 'p1', 'p2'],
    hands: [[c('2')], [c('2')], [c('9')]],
  });
  tied.phase = 'final';
  tied.finalLeft = [];
  const rps = engine.finishGame(tied);
  return {
    setup: engine.startGame(lobby(), 'p0', rng),
    turns: mid,
    'turns, card drawn': drawn,
    'turns, power pending': queen,
    final,
    rps,
  };
}

test('dropAbsent ends every phase of a game at once, however the others are placed', () => {
  for (const [name, state] of Object.entries(phases())) {
    for (const gone of [['p0'], ['p1'], ['p2'], ['p0', 'p1'], ['p1', 'p2']]) {
      const next = engine.dropAbsent(state, gone);
      assert.equal(next.phase, 'done', `${name}, ${gone} left`);
      assert.deepEqual(next.abandonedBy, gone, `${name}, ${gone} left`);
      assert.equal(next.rps, null);
      assert.ok(next.result, `${name} has a result`);
      assert.ok(next.version > state.version);
      const winners = next.result.winners;
      assert.ok(winners.length > 0 && winners.every((w) => !gone.includes(w)), `${name}: a leaver cannot win`);
    }
  }
});

test('the last player standing wins when everyone else leaves', () => {
  const next = engine.dropAbsent(stacked(), ['p0', 'p2']);
  assert.deepEqual(next.result.winners, ['p1']);
  assert.equal(engine.viewFor(next, 'p1').abandonedBy.length, 2);
});

test('a lobby only loses the absent player; the host passes on', () => {
  const next = engine.dropAbsent(lobby(), ['p0']);
  assert.equal(next.phase, 'lobby');
  assert.deepEqual(next.players.map((p) => p.id), ['p1', 'p2']);
  assert.equal(next.hostId, 'p1');
  assert.equal(next.abandonedBy, null);
});

test('dropAbsent ignores finished games and players already gone', () => {
  const done = engine.dropAbsent(stacked(), ['p0']);
  assert.equal(engine.dropAbsent(done, ['p1']), done);
  assert.equal(engine.dropAbsent(stacked(), []).phase, 'turns');
});

// ---- handlers --------------------------------------------------------------
async function room(state, ids = state.players.map((p) => p.id)) {
  const db = fakeDb();
  const tokens = {};
  for (const id of ids) tokens[id] = await hashToken(`t${id}`);
  db.rows.set('ABCD', { code: 'ABCD', state, tokens, version: state.version });
  return db;
}

function clock(t0 = 1_000_000) {
  let t = t0;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

const poll = (db, who, now, extra = {}) =>
  handleRoom(db, { action: 'view', code: 'ABCD', token: `t${who}`, ...extra }, { ...quiet, now });

test('a poll is a heartbeat and does not bump the game version', async () => {
  const db = await room(stacked(2));
  const now = clock();
  const r = await poll(db, 'p0', now);
  assert.equal(r.status, 200);
  assert.equal(db.rows.get('ABCD').seen.p0, now());
  assert.equal(db.rows.get('ABCD').version, 0);
});

test('a player who stops polling ends the game for the others after the stale window', async () => {
  const db = await room(stacked(3));
  const now = clock();
  for (const id of ['p0', 'p1', 'p2']) await poll(db, id, now);
  now.advance(staleMs - 1000);
  await poll(db, 'p0', now);
  const r1 = await poll(db, 'p1', now);
  assert.equal(r1.body.view.phase, 'turns', 'still within the window');
  now.advance(2000);
  await poll(db, 'p0', now);
  const r = await poll(db, 'p1', now);
  assert.equal(r.body.view.phase, 'done');
  assert.deepEqual(r.body.view.abandonedBy, ['p2']);
  assert.ok(!r.body.view.result.winners.includes('p2'));
  assert.equal(db.rows.get('ABCD').state.phase, 'done');
});

test('a late-joining row without heartbeats is not swept on the first poll', async () => {
  const db = await room(stacked(2));
  const r = await poll(db, 'p0', clock());
  assert.equal(r.body.view.phase, 'turns');
});

test('closing the tab (bye) ends the game after the short grace, a reload does not', async () => {
  const db = await room(stacked(2));
  const now = clock();
  await poll(db, 'p0', now);
  await poll(db, 'p1', now);
  await poll(db, 'p1', now, { bye: true });
  now.advance(byeGraceMs - 1000);
  assert.equal((await poll(db, 'p0', now)).body.view.phase, 'turns');
  await poll(db, 'p1', now); // the reloaded page is back
  now.advance(byeGraceMs + 1000);
  assert.equal((await poll(db, 'p0', now)).body.view.phase, 'turns', 'p1 came back');
  await poll(db, 'p1', now, { bye: true });
  now.advance(byeGraceMs + 1000);
  const r = await poll(db, 'p0', now);
  assert.equal(r.body.view.phase, 'done');
  assert.deepEqual(r.body.view.abandonedBy, ['p1']);
});

test('a bye never ends the game by itself', async () => {
  const db = await room(stacked(2));
  const now = clock();
  await poll(db, 'p0', now);
  now.advance(staleMs * 2);
  const r = await poll(db, 'p1', now, { bye: true });
  assert.equal(r.body.view.phase, 'turns');
});

test('the lobby drops a ghost player instead of ending anything', async () => {
  const db = await room(lobby(3));
  const now = clock();
  for (const id of ['p0', 'p1', 'p2']) await poll(db, id, now);
  now.advance(staleMs + 1000);
  await poll(db, 'p0', now);
  const r = await poll(db, 'p1', now);
  assert.equal(r.body.view.phase, 'lobby');
  assert.deepEqual(r.body.view.players.map((p) => p.id), ['p0']);
});

test('leave ends a running game at once and removes a lobby player', async () => {
  const db = await room(stacked(3));
  const r = await handleRoom(db, { action: 'leave', code: 'ABCD', token: 'tp1' }, quiet);
  assert.equal(r.status, 200);
  const { state } = db.rows.get('ABCD');
  assert.equal(state.phase, 'done');
  assert.deepEqual(state.abandonedBy, ['p1']);

  const db2 = await room(lobby(3));
  await handleRoom(db2, { action: 'leave', code: 'ABCD', token: 'tp0' }, quiet);
  const s2 = db2.rows.get('ABCD').state;
  assert.deepEqual(s2.players.map((p) => p.id), ['p1', 'p2']);
  assert.equal(s2.hostId, 'p1');
});

test('leave needs a valid token and is harmless on a finished game', async () => {
  const db = await room(stacked(2));
  assert.equal((await handleRoom(db, { action: 'leave', code: 'ABCD', token: 'nope' }, quiet)).status, 403);
  await handleRoom(db, { action: 'leave', code: 'ABCD', token: 'tp0' }, quiet);
  const v = db.rows.get('ABCD').state.version;
  assert.equal((await handleRoom(db, { action: 'leave', code: 'ABCD', token: 'tp1' }, quiet)).status, 200);
  assert.equal(db.rows.get('ABCD').state.version, v);
});

test('creating a room purges rooms untouched for a day', async () => {
  const db = fakeDb();
  const now = clock(Date.parse('2026-01-10T00:00:00Z'));
  db.rows.set('OLDD', { code: 'OLDD', state: {}, tokens: {}, version: 0, updated_at: '2026-01-08T00:00:00Z' });
  db.rows.set('NEWW', { code: 'NEWW', state: {}, tokens: {}, version: 0, updated_at: '2026-01-09T20:00:00Z' });
  const r = await handleRoom(db, { action: 'create', name: 'x' }, { ...quiet, now });
  assert.equal(r.status, 200);
  assert.equal(db.rows.has('OLDD'), false);
  assert.equal(db.rows.has('NEWW'), true);
});
