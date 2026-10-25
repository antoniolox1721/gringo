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

test('a leaver forfeits even with the lowest score', () => {
  const g = stackedGame({
    players: ['p0', 'p1', 'p2'],
    hands: [[c('9'), c('9')], [c('A'), c('2')], [c('5'), c('6')]],
  });
  const best = engine.dropAbsent(g, ['p1']);
  assert.equal(best.result.totals.p1, 3, 'p1 had the lowest total');
  assert.deepEqual(best.result.winners, ['p2']);
  const tied = stackedGame({
    players: ['p0', 'p1', 'p2'],
    hands: [[c('5'), c('6')], [c('A')], [c('4'), c('7')]],
  });
  assert.deepEqual(engine.dropAbsent(tied, ['p1']).result.winners.sort(), ['p0', 'p2']);
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

test('dropAbsent leaves a finished game finished and ignores players already gone', () => {
  const done = engine.dropAbsent(stacked(), ['p0']);
  const later = engine.dropAbsent(done, ['p1']);
  assert.equal(later.phase, 'done');
  assert.deepEqual(later.abandonedBy, ['p0']);
  assert.equal(engine.dropAbsent(later, ['p1']), later);
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

test('leave needs a valid token and leaves a finished game finished', async () => {
  const db = await room(stacked(2));
  assert.equal((await handleRoom(db, { action: 'leave', code: 'ABCD', token: 'nope' }, quiet)).status, 403);
  await handleRoom(db, { action: 'leave', code: 'ABCD', token: 'tp0' }, quiet);
  assert.equal((await handleRoom(db, { action: 'leave', code: 'ABCD', token: 'tp1' }, quiet)).status, 200);
  assert.equal(db.rows.get('ABCD').state.phase, 'done');
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

test('a player who never polled still goes stale, and concurrent polls keep each other\'s heartbeats', async () => {
  const db = await room(stacked(3));
  const now = clock();
  await Promise.all([poll(db, 'p0', now), poll(db, 'p1', now)]);
  const seen = db.rows.get('ABCD').seen;
  assert.deepEqual(Object.keys(seen).sort(), ['p0', 'p1', 'p2']);
  now.advance(staleMs - 5000);
  await Promise.all([poll(db, 'p0', now), poll(db, 'p1', now)]);
  now.advance(6000);
  const r = await poll(db, 'p0', now);
  assert.equal(r.body.view.phase, 'done');
  assert.deepEqual(r.body.view.abandonedBy, ['p2'], 'only the player who never polled is gone');
});

// ---- idle players and abuse limits ---------------------------------------------
const { idleMs } = engine.PRESENCE;

// Time passes with everybody's tab open and polling (nobody is stale), but nobody plays.
async function idleFor(db, ids, now, ms) {
  for (let left = ms; left > 0; left -= 10000) {
    now.advance(Math.min(10000, left));
    for (const id of ids) await poll(db, id, now);
  }
}

function started(state, now) {
  return { ...state, lastMoveAt: now() };
}

test('blockers names exactly who the game is waiting for', () => {
  const s = engine.startGame(lobby(3), 'p0', rng);
  assert.deepEqual(engine.blockers(s).sort(), ['p0', 'p1', 'p2']);
  assert.deepEqual(engine.blockers(engine.peekSetup(s, 'p1', [0, 1]).state).sort(), ['p0', 'p2']);
  assert.deepEqual(engine.blockers(stacked()), ['p0']);
  assert.deepEqual(engine.blockers({ ...stacked(), pending: [{ type: 'Q', by: 'p2' }] }), ['p2']);
  const rps = phases().rps;
  assert.equal(rps.phase, 'rps');
  assert.deepEqual(engine.blockers(rps).sort(), rps.rps.players.slice().sort());
  assert.deepEqual(engine.blockers(engine.dropAbsent(stacked(), ['p0'])), []);
  assert.deepEqual(engine.blockers(lobby()), []);
});

test('a player who keeps the tab open but never moves forfeits after the idle window', async () => {
  const now = clock();
  const db = await room(started(stacked(3), now));
  for (const id of ['p0', 'p1', 'p2']) await poll(db, id, now);
  // Everybody keeps polling; nobody plays. p0 holds the turn.
  for (let i = 0; i < idleMs / 5000 - 2; i++) {
    now.advance(5000);
    for (const id of ['p0', 'p1', 'p2']) await poll(db, id, now);
  }
  assert.equal((await poll(db, 'p1', now)).body.view.phase, 'turns', 'still within the window');
  now.advance(15000);
  const r = await poll(db, 'p1', now);
  assert.equal(r.body.view.phase, 'done');
  assert.deepEqual(r.body.view.abandonedBy, ['p0']);
  assert.ok(!r.body.view.result.winners.includes('p0'));
});

test('slaps and penalties do not reset the idle clock; real progress does', async () => {
  const now = clock();
  const db = await room(started(stacked(2), now));
  await poll(db, 'p0', now);
  await poll(db, 'p1', now);
  await idleFor(db, ['p0', 'p1'], now, idleMs - 20000);
  const { handleAct } = await import('../supabase/functions/_shared/handlers.js');
  const slap = await handleAct(db, { code: 'ABCD', token: 'tp1', action: 'slap', args: { ownerId: 'p1', slot: 0 } }, { ...quiet, now });
  assert.equal(slap.status, 200, JSON.stringify(slap.body));
  const before = db.rows.get('ABCD').state.lastMoveAt;
  assert.equal(before, 1_000_000, 'a slap left the clock alone');
  await idleFor(db, ['p0'], now, 25000);
  const r = await poll(db, 'p1', now);
  assert.equal(r.body.view.phase, 'done', 'idle p0 still forfeits after a slap by p1');

  const db2 = await room(started(stacked(2), now));
  await idleFor(db2, ['p0', 'p1'], now, idleMs - 20000);
  await handleAct(db2, { code: 'ABCD', token: 'tp0', action: 'draw', args: {} }, { ...quiet, now });
  assert.equal(db2.rows.get('ABCD').state.lastMoveAt, now(), 'a draw restarts the clock');
  await idleFor(db2, ['p0', 'p1'], now, 25000);
  assert.equal((await poll(db2, 'p1', now)).body.view.phase, 'turns');
});

test('idle setup forfeits only the players who never peeked', async () => {
  const now = clock();
  let s = engine.startGame(lobby(3), 'p0', rng);
  s = engine.peekSetup(s, 'p1', [0, 1]).state;
  const db = await room(started(s, now));
  now.advance(idleMs + 1000);
  for (const id of ['p0', 'p1', 'p2']) await poll(db, id, now);
  const st = db.rows.get('ABCD').state;
  assert.equal(st.phase, 'done');
  assert.deepEqual(st.abandonedBy.sort(), ['p0', 'p2']);
  assert.deepEqual(st.result.winners, ['p1']);
});

test('a state without lastMoveAt is never idle-swept', async () => {
  const db = await room(stacked(2));
  const now = clock();
  for (let i = 0; i < 36; i++) {
    await poll(db, 'p0', now);
    await poll(db, 'p1', now);
    now.advance(20000);
  }
  assert.equal((await poll(db, 'p0', now)).body.view.phase, 'turns');
});

test('the host cannot remove players once the game has started', async () => {
  const db = await room(stacked(3));
  const r = await handleRoom(db, { action: 'kick', code: 'ABCD', token: 'tp0', targetId: 'p1' }, quiet);
  assert.equal(r.status, 403);
  assert.equal(db.rows.get('ABCD').state.players[1].connected, true);
  const db2 = await room(lobby(3));
  assert.equal((await handleRoom(db2, { action: 'kick', code: 'ABCD', token: 'tp0', targetId: 'p1' }, quiet)).status, 200);
});

test('polls closer than two seconds apart skip the database write', async () => {
  const db = await room(stacked(2));
  let writes = 0;
  const touch = db.touch;
  db.touch = async (...a) => { writes += 1; return touch(...a); };
  const now = clock();
  await poll(db, 'p0', now);
  const first = writes;
  now.advance(500);
  await poll(db, 'p0', now);
  await poll(db, 'p0', now);
  assert.equal(writes, first, 'rapid polls wrote nothing');
  now.advance(2000);
  await poll(db, 'p0', now);
  assert.equal(writes, first + 1);
});

test('a kick that races a start is judged on the state it changes', async () => {
  const db = await room(lobby(3));
  const get = db.get;
  let started = false;
  // The game starts right after the kick's first read, before its write.
  db.get = async (code) => {
    const row = await get(code);
    if (!started) {
      started = true;
      const st = engine.startGame(row.state, 'p0', rng);
      db.rows.set(code, { ...db.rows.get(code), state: st, version: st.version });
    }
    return row;
  };
  const r = await handleRoom(db, { action: 'kick', code: 'ABCD', token: 'tp0', targetId: 'p1' }, quiet);
  assert.equal(r.status, 403);
  assert.equal(db.rows.get('ABCD').state.players[1].connected, true);
});

test('a rematch started by someone leaving gets a fresh idle clock', async () => {
  const s = stacked(3);
  s.rematch = [];
  s.lastMoveAt = 1;
  let done = engine.finishGame(s);
  done = engine.voteRematch(done, 'p0');
  done = engine.voteRematch(done, 'p1');
  const db = await room(done);
  const now = clock();
  const r = await handleRoom(db, { action: 'leave', code: 'ABCD', token: 'tp2' }, { ...quiet, now });
  assert.equal(r.status, 200);
  const st = db.rows.get('ABCD').state;
  assert.equal(st.phase, 'setup');
  assert.equal(st.lastMoveAt, now());
});

// ---- lonely rooms ----------------------------------------------------------------
const { lonelyMs } = engine.PRESENCE;
const aged = (db, createdAt) => { const r = db.rows.get('ABCD'); db.rows.set('ABCD', { ...r, created_at: new Date(createdAt).toISOString() }); };

test('lonelyRoom: needs to be old and to have fewer than two players present', () => {
  const t = 10 * lonelyMs;
  assert.equal(engine.lonelyRoom({}, t - 1000, t), false, 'a new room is left alone');
  assert.equal(engine.lonelyRoom({}, 0, t), true, 'nobody ever came');
  assert.equal(engine.lonelyRoom({ a: t - 1000 }, 0, t), true, 'only one player is here');
  assert.equal(engine.lonelyRoom({ a: t - 1000, b: t - lonelyMs - 1 }, 0, t), true, 'the other left a while ago');
  assert.equal(engine.lonelyRoom({ a: t - 1000, b: t - lonelyMs + 1000 }, 0, t), false, 'two players are in it');
});

test('a lone player polling an old room loses it; two players keep it', async () => {
  const now = clock();
  const alone = await room(lobby(2));
  aged(alone, now() - lonelyMs - 1000);
  alone.rows.get('ABCD').seen = { p1: now() - lonelyMs - 5000 };
  const first = await poll(alone, 'p0', now);
  assert.equal(first.status, 404);
  assert.equal(alone.rows.has('ABCD'), false);

  const together = await room(lobby(2));
  aged(together, now() - lonelyMs - 1000);
  together.rows.get('ABCD').seen = { p0: now() - 1000, p1: now() - 2000 };
  assert.equal((await poll(together, 'p0', now)).status, 200);
  assert.equal((await poll(together, 'p1', now)).status, 200);
  now.advance(lonelyMs - 10_000);
  assert.equal((await poll(together, 'p0', now)).status, 200);
  assert.equal((await poll(together, 'p1', now)).status, 200);
  assert.equal(together.rows.has('ABCD'), true);
});

test('creating a room clears empty and one-player rooms older than five minutes', async () => {
  const db = fakeDb();
  const now = clock(Date.parse('2026-01-10T00:00:00Z'));
  const old = new Date(now() - lonelyMs - 1000).toISOString();
  const recent = new Date(now() - 60_000).toISOString();
  db.rows.set('EMTY', { code: 'EMTY', state: {}, tokens: {}, version: 0, seen: {}, created_at: old, updated_at: recent });
  db.rows.set('ONEP', { code: 'ONEP', state: {}, tokens: {}, version: 0, seen: { a: now() - 1000 }, created_at: old, updated_at: recent });
  db.rows.set('TWOP', { code: 'TWOP', state: {}, tokens: {}, version: 0, seen: { a: now() - 1000, b: now() - 2000 }, created_at: old, updated_at: recent });
  db.rows.set('NEWW', { code: 'NEWW', state: {}, tokens: {}, version: 0, seen: {}, created_at: recent, updated_at: recent });
  assert.equal((await handleRoom(db, { action: 'create', name: 'x' }, { ...quiet, now })).status, 200);
  assert.deepEqual([...db.rows.keys()].filter((k) => k !== 'EMTY' && db.rows.has(k)).sort().filter((k) => ['ONEP', 'TWOP', 'NEWW'].includes(k)), ['NEWW', 'TWOP']);
  assert.equal(db.rows.has('EMTY'), false);
  assert.equal(db.rows.has('ONEP'), false);
});

test('someone who joined an old lonely room is present before their first poll', async () => {
  const now = clock();
  const db = await room(lobby(1), ['p0']);
  aged(db, now() - lonelyMs - 1000);
  db.rows.get('ABCD').seen = { p0: now() - 1000 };
  const j = await handleRoom(db, { action: 'join', code: 'ABCD', name: 'late' }, { ...quiet, now, uuid: () => 'p9' });
  assert.equal(j.status, 200);
  assert.equal((await poll(db, 'p0', now)).status, 200, 'the host keeps the room');
  assert.equal(db.rows.has('ABCD'), true);
});

test('the delete re-checks presence: a second player who arrived since the read keeps the room', async () => {
  const now = clock();
  const db = await room(lobby(2));
  aged(db, now() - lonelyMs - 1000);
  db.rows.get('ABCD').seen = { p0: now() - 1000 };
  const real = db.get.bind(db);
  let first = true;
  db.get = async (code) => { // the room looks lonely on the handler's read, then p1 shows up
    const row = await real(code);
    if (first) { first = false; db.rows.set('ABCD', { ...db.rows.get('ABCD'), seen: { p0: now() - 1000, p1: now() - 500 } }); }
    return row;
  };
  assert.equal((await poll(db, 'p0', now)).status, 200);
  assert.equal(db.rows.has('ABCD'), true);
});
