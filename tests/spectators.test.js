import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../supabase/functions/_shared/engine.js';
import { hashToken } from '../supabase/functions/_shared/store.js';
import { handleAct, handleRoom } from '../supabase/functions/_shared/handlers.js';
import { c, fakeDb, seededRng, stackedGame } from './helpers.js';

const quiet = { notify: async () => true };
const rng = seededRng(11);

function lobby(n) {
  let s = engine.createGame('p0', 'p0');
  for (let i = 1; i < n; i++) s = engine.addPlayer(s, `p${i}`, `p${i}`);
  return s;
}

function playing(n = 3) {
  return stackedGame({
    players: Array.from({ length: n }, (_, i) => `p${i}`),
    hands: Array.from({ length: n }, (_, i) => [c('5'), c('6'), c('7'), c(String(2 + i))]),
    deck: [c('9', 'H'), c('8', 'H'), c('2', 'S'), c('3', 'S')],
  });
}

// A finished game for n players: p1 has the lowest total.
function finished(n = 3) {
  const s = playing(n);
  s.hands = undefined;
  s.players.forEach((p, i) => { p.hand = [c(i === 1 ? '2' : '9')]; });
  s.phase = 'final';
  s.finalLeft = [];
  s.rematch = [];
  const done = engine.finishGame(s);
  assert.equal(done.phase, 'done');
  return done;
}

const watchers = (s, ...ids) => ids.reduce((st, id) => engine.joinRoom(st, id, id), s);

test('joinRoom seats you in an open lobby and puts you at the rail otherwise', () => {
  assert.equal(engine.joinRoom(lobby(2), 'x', 'x').players.length, 3);
  const full = engine.joinRoom(lobby(4), 'x', 'x');
  assert.equal(full.players.length, 4);
  assert.deepEqual(full.spectators.map((s) => s.id), ['x']);
  for (const s of [playing(), finished()]) {
    const j = engine.joinRoom(s, 'x', 'x');
    assert.equal(j.players.length, 3);
    assert.deepEqual(j.spectators, [{ id: 'x', name: 'x', wantsIn: false }]);
  }
});

test('the rail has a limit, ids are unique, and states from before spectators still work', () => {
  let s = playing();
  for (let i = 0; i < 8; i++) s = engine.joinRoom(s, `w${i}`, `w${i}`);
  assert.throws(() => engine.joinRoom(s, 'w9', 'w9'), /too many spectators/);
  assert.throws(() => engine.joinRoom(s, 'w0', 'dup'), /already joined/);
  assert.throws(() => engine.joinRoom(s, 'p0', 'dup'), /already joined/);

  const old = playing();
  delete old.spectators;
  assert.deepEqual(engine.viewFor(old, 'p0').spectators, []);
  assert.equal(engine.joinRoom(old, 'x', 'x').spectators.length, 1);
});

test('a spectator sees the table but never a hidden card, and cannot act', () => {
  const s = watchers(engine.startGame(lobby(2), 'p0', rng), 'w');
  const v = engine.viewFor(s, 'w');
  assert.equal(v.spectator, true);
  assert.equal(engine.viewFor(s, 'p0').spectator, false);
  assert.equal(v.drawn, null);
  assert.deepEqual(v.viewable, []);
  for (const p of v.players) for (const e of p.hand) assert.equal(e.card, undefined, 'no face is shown');
  assert.deepEqual(v.spectators, [{ id: 'w', name: 'w', wantsIn: false }]);

  const t = watchers(playing(), 'w');
  const attempts = [
    () => engine.peekSetup(engine.startGame(lobby(2), 'p0', rng), 'w', [0, 1]),
    () => engine.draw(t, 'w'),
    () => engine.callGringo(t, 'w'),
    () => engine.slap(t, 'w', { ownerId: 'p0', slot: 0 }),
    () => engine.voteRematch(watchers(finished(), 'w'), 'w'),
    () => engine.startGame(watchers(lobby(4), 'w'), 'w'),
  ];
  for (const f of attempts) assert.throws(f, /unknown player|not the host|only the host/);
});

test('a spectator sees every face once the game is over, like everyone else', () => {
  const v = engine.viewFor(watchers(finished(), 'w'), 'w');
  assert.ok(v.players.every((p) => p.hand.every((e) => e.empty || e.card)));
});

test('a full lobby seats a spectator the moment a seat opens', () => {
  const s = watchers(lobby(4), 'w1', 'w2');
  assert.throws(() => engine.sit(s, 'w1'), /room full/);
  const open = engine.removePlayer(s, 'p3');
  const seated = engine.sit(open, 'w1');
  assert.deepEqual(seated.players.map((p) => p.id), ['p0', 'p1', 'p2', 'w1']);
  assert.deepEqual(seated.spectators.map((x) => x.id), ['w2']);
  assert.throws(() => engine.sit(seated, 'w2'), /room full/);
  assert.throws(() => engine.sit(seated, 'p0'), /only spectators/);
  assert.equal(engine.sit(open, 'w1', false), open, 'withdrawing in a lobby is a no-op');
});

test('during a game a spectator only queues; nothing changes at the table', () => {
  const s = watchers(playing(), 'w');
  const q = engine.sit(s, 'w');
  assert.equal(q.players.length, 3);
  assert.equal(q.spectators[0].wantsIn, true);
  assert.equal(engine.sit(q, 'w'), q, 'asking twice changes nothing');
  assert.equal(engine.sit(q, 'w', false).spectators[0].wantsIn, false);
  assert.equal(q.phase, s.phase);
});

test('queued spectators fill the open seats of the next game, first come first served', () => {
  let s = watchers(finished(3), 'w1', 'w2', 'w3');
  for (const id of ['w3', 'w1', 'w2']) s = engine.sit(s, id);
  assert.equal(s.phase, 'done', 'a queue alone does not restart anything');
  for (const id of ['p0', 'p1']) s = engine.voteRematch(s, id, rng);
  assert.equal(s.phase, 'done', 'the third player still has to agree');
  s = engine.voteRematch(s, 'p2', rng);
  assert.equal(s.phase, 'setup');
  assert.deepEqual(s.players.map((p) => p.id), ['p0', 'p1', 'p2', 'w3'], 'one seat, so only the first in the queue');
  assert.deepEqual(s.spectators.map((x) => x.id), ['w1', 'w2'], 'the rest keep watching, still in line, in the order they asked');
  assert.ok(s.spectators.every((x) => x.wantsIn));
  for (const p of s.players) assert.equal(p.hand.length, 4);
  assert.equal(s.deck.length, 54 - 16);
  assert.equal(engine.viewFor(s, 'w3').spectator, false);
  assert.equal(engine.viewFor(s, 'w1').spectator, true);
});

test('the new player has to peek like everyone else, and the winner still starts', () => {
  let s = watchers(finished(3), 'w');
  s = engine.sit(s, 'w');
  for (const id of ['p0', 'p1', 'p2']) s = engine.voteRematch(s, id, rng);
  assert.equal(s.phase, 'setup');
  for (const id of ['p0', 'p1', 'p2']) s = engine.peekSetup(s, id, [0, 1]).state;
  assert.equal(s.phase, 'setup', 'the newcomer has not peeked yet');
  s = engine.peekSetup(s, 'w', [2, 3]).state;
  assert.equal(s.phase, 'turns');
  assert.equal(s.players[s.turn].id, 'p1');
});

test('spectators do not hold up a rematch and a withdrawn request is ignored', () => {
  let s = watchers(finished(2), 'a', 'b');
  s = engine.sit(engine.sit(s, 'a'), 'b');
  s = engine.sit(s, 'b', false);
  for (const id of ['p0', 'p1']) s = engine.voteRematch(s, id, rng);
  assert.deepEqual(s.players.map((p) => p.id), ['p0', 'p1', 'a']);
  assert.deepEqual(s.spectators.map((x) => x.id), ['b']);
  assert.equal(s.spectators[0].wantsIn, false);
});

test('a full table of four leaves no room for the queue', () => {
  let s = watchers(finished(4), 'w');
  s = engine.sit(s, 'w');
  for (const id of ['p0', 'p1', 'p2', 'p3']) s = engine.voteRematch(s, id, rng);
  assert.equal(s.players.length, 4);
  assert.deepEqual(s.spectators.map((x) => x.id), ['w']);
});

test('when the others walk away, the spectators who asked can play on without them', () => {
  // One player left to vote, one queued: two people make a game.
  let s = watchers(finished(3), 'w');
  s = engine.sit(s, 'w');
  s = engine.dropAbsent(s, ['p1', 'p2']);
  assert.equal(s.phase, 'done');
  s = engine.voteRematch(s, 'p0', rng);
  assert.equal(s.phase, 'setup');
  assert.deepEqual(s.players.map((p) => p.id), ['p0', 'w']);
  assert.equal(s.hostId, 'p0');

  // Everyone left and two are queued: the first to ask starts nothing alone, the second does.
  let t = watchers(finished(3), 'a', 'b');
  t = engine.dropAbsent(t, ['p0', 'p1', 'p2']);
  t = engine.sit(t, 'a');
  assert.equal(t.phase, 'done');
  t = engine.sit(t, 'b');
  assert.equal(t.phase, 'setup');
  assert.deepEqual(t.players.map((p) => p.id), ['a', 'b']);
  assert.equal(t.hostId, 'a', 'the host seat passes to someone who is still here');
  assert.equal(t.starter, null);

  // A lone remaining player with nobody queued still cannot restart.
  let u = engine.dropAbsent(finished(3), ['p1', 'p2']);
  u = engine.voteRematch(u, 'p0', rng);
  assert.equal(u.phase, 'done');
});

test('a spectator leaving or timing out never touches the game', () => {
  for (const state of [playing(), engine.startGame(lobby(2), 'p0', rng), finished()]) {
    const s = watchers(state, 'w1', 'w2');
    const left = engine.dropAbsent(s, ['w1']);
    assert.equal(left.phase, state.phase);
    assert.equal(left.abandonedBy ?? null, state.abandonedBy ?? null);
    assert.deepEqual(left.spectators.map((x) => x.id), ['w2']);
    assert.deepEqual(left.players, state.players);
    // Mixed with a real leaver, only the player ends the game.
    const both = engine.dropAbsent(s, ['w1', 'p0']);
    assert.deepEqual(both.spectators.map((x) => x.id), ['w2']);
    if (state.phase !== 'done') assert.deepEqual(both.abandonedBy, ['p0']);
  }
  const s = watchers(playing(), 'w');
  const silent = engine.absentPlayers(s, { p0: 100_000, p1: 100_000, p2: 100_000, w: 0 }, 'p0', 100_000);
  assert.deepEqual(silent, ['w']);
  assert.deepEqual(engine.absentPlayers(s, { w: 0, p0: 100_000, p1: 100_000, p2: 100_000 }, 'w', 100_000), [], 'the caller is never silent');
  assert.deepEqual(engine.blockers(s), ['p0'], 'a game never waits on a spectator');
});

test('a spectator leaving while queued frees the queue', () => {
  let s = engine.sit(watchers(finished(2), 'a', 'b'), 'a');
  s = engine.sit(s, 'b');
  s = engine.dropAbsent(s, ['a']);
  for (const id of ['p0', 'p1']) s = engine.voteRematch(s, id, rng);
  assert.deepEqual(s.players.map((p) => p.id), ['p0', 'p1', 'b']);
});

test('a spectator can be removed by the host at any time, and a player still only in the lobby', () => {
  const s = watchers(playing(), 'w');
  const r = engine.removePlayer(s, 'w');
  assert.deepEqual(r.spectators, []);
  assert.equal(r.phase, 'turns');
  assert.equal(r.players.length, 3);
});

// ---- through the real handlers ---------------------------------------------------

async function room(state, ids) {
  const db = fakeDb();
  const tokens = {};
  for (const id of ids ?? state.players.map((p) => p.id)) tokens[id] = await hashToken(`t${id}`);
  db.rows.set('ABCD', { code: 'ABCD', state, tokens, version: state.version });
  return db;
}

let n = 0;
const join = (db, name = 'w') => handleRoom(db, { action: 'join', code: 'ABCD', name }, { ...quiet, uuid: () => `u${++n}` });
const view = (db, token) => handleRoom(db, { action: 'view', code: 'ABCD', token }, quiet);

test('joining a running or full room works and returns a usable spectator token', async () => {
  for (const state of [playing(), lobby(4), finished()]) {
    const db = await room(state);
    const j = await join(db, 'Watcher');
    assert.equal(j.status, 200);
    assert.ok(j.body.token && j.body.playerId);
    const v = await view(db, j.body.token);
    assert.equal(v.status, 200);
    assert.equal(v.body.view.spectator, true);
    assert.equal(v.body.view.you, j.body.playerId);
    assert.deepEqual(db.rows.get('ABCD').state.players, state.players, 'the players are untouched');
  }
});

test('a joiner is seated if the lobby has room, and the name is still validated', async () => {
  const db = await room(lobby(2));
  const j = await join(db, 'Newcomer');
  assert.equal((await view(db, j.body.token)).body.view.spectator, false);
  assert.equal(db.rows.get('ABCD').state.players.length, 3);
  assert.equal((await join(await room(playing()), '   ')).status, 400);
  assert.equal((await handleRoom(await room(playing()), { action: 'join', code: 'ZZZZ', name: 'x' }, quiet)).status, 404);
});

test('too many spectators is a clean 400, not a crash', async () => {
  const db = await room(playing());
  for (let i = 0; i < 8; i++) assert.equal((await join(db, `w${i}`)).status, 200);
  const r = await join(db, 'late');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /too many spectators/);
});

test('simultaneous joins on a full room all land, with no lost updates', async () => {
  const db = await room(lobby(4));
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => join(db, `w${i}`)));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
  const { state, tokens } = db.rows.get('ABCD');
  assert.equal(state.spectators.length, 5);
  assert.equal(new Set(state.spectators.map((x) => x.id)).size, 5);
  assert.equal(Object.keys(tokens).length, 9);
});

test('a spectator cannot play through the act endpoint, and their poll does not disturb the game', async () => {
  const db = await room(playing());
  const j = await join(db);
  const before = db.rows.get('ABCD').version;
  for (const action of ['draw', 'gringo', 'slap', 'keep', 'discard', 'rematch', 'skipPower', 'rps', 'confirmKing']) {
    const r = await handleAct(db, { code: 'ABCD', token: j.body.token, action, args: { slot: 0, ownerId: 'p0' } }, quiet);
    assert.equal(r.status, 400, action);
  }
  assert.equal(db.rows.get('ABCD').version, before);
  const start = await handleRoom(await room(watchersLobby()), { action: 'start', code: 'ABCD', token: 'tw' }, quiet);
  assert.equal(start.status, 403);
});

function watchersLobby() {
  return engine.joinRoom(lobby(4), 'w', 'w');
}

test('sit through the handlers: seats at once in a lobby, queues in a game', async () => {
  const lobbyDb = await room(watchersLobby(), ['p0', 'p1', 'p2', 'p3', 'w']);
  const full = await handleRoom(lobbyDb, { action: 'sit', code: 'ABCD', token: 'tw' }, quiet);
  assert.equal(full.status, 400);
  assert.match(full.body.error, /room full/);
  await handleRoom(lobbyDb, { action: 'leave', code: 'ABCD', token: 'tp3' }, quiet);
  assert.equal((await handleRoom(lobbyDb, { action: 'sit', code: 'ABCD', token: 'tw' }, quiet)).status, 200);
  assert.deepEqual(lobbyDb.rows.get('ABCD').state.players.map((p) => p.id), ['p0', 'p1', 'p2', 'w']);

  const db = await room(engine.joinRoom(finished(2), 'w', 'w'), ['p0', 'p1', 'w']);
  assert.equal((await handleRoom(db, { action: 'sit', code: 'ABCD', token: 'tw', want: true }, quiet)).status, 200);
  assert.equal(db.rows.get('ABCD').state.spectators[0].wantsIn, true);
  await handleAct(db, { code: 'ABCD', token: 'tp0', action: 'rematch' }, quiet);
  await handleAct(db, { code: 'ABCD', token: 'tp1', action: 'rematch' }, quiet);
  const { state } = db.rows.get('ABCD');
  assert.equal(state.phase, 'setup');
  assert.deepEqual(state.players.map((p) => p.id), ['p0', 'p1', 'w']);
  assert.equal(typeof state.lastMoveAt, 'number');
  assert.equal((await handleRoom(db, { action: 'sit', code: 'ABCD', token: 'tp0' }, quiet)).status, 400, 'players cannot sit');
  assert.equal((await handleRoom(db, { action: 'sit', code: 'ABCD', token: 'nope' }, quiet)).status, 403);
});

test('a sit that completes a rematch restarts the idle clock', async () => {
  const done = engine.joinRoom(engine.dropAbsent(finished(3), ['p0', 'p1', 'p2']), 'a', 'a');
  const second = engine.joinRoom(done, 'b', 'b');
  second.lastMoveAt = 1;
  const db = await room(second, ['a', 'b']);
  await handleRoom(db, { action: 'sit', code: 'ABCD', token: 'ta' }, quiet);
  await handleRoom(db, { action: 'sit', code: 'ABCD', token: 'tb' }, { ...quiet, now: () => 5_000_000 });
  const s = db.rows.get('ABCD').state;
  assert.equal(s.phase, 'setup');
  assert.equal(s.lastMoveAt, 5_000_000, 'otherwise the stale clock would forfeit the new players at once');
});

test('the host can remove a spectator mid-game; others cannot; the removed token is dead', async () => {
  const db = await room(engine.joinRoom(playing(), 'w', 'w'), ['p0', 'p1', 'p2', 'w']);
  const other = await handleRoom(db, { action: 'kick', code: 'ABCD', token: 'tp1', targetId: 'w' }, quiet);
  assert.equal(other.status, 403);
  const player = await handleRoom(db, { action: 'kick', code: 'ABCD', token: 'tp0', targetId: 'p1' }, quiet);
  assert.equal(player.status, 403, 'players still cannot be removed mid-game');
  const ok = await handleRoom(db, { action: 'kick', code: 'ABCD', token: 'tp0', targetId: 'w' }, quiet);
  assert.equal(ok.status, 200);
  assert.equal(db.rows.get('ABCD').state.phase, 'turns');
  assert.equal((await view(db, 'tw')).status, 403);
});

test('a silent spectator is swept by the next poll without ending the game', async () => {
  const db = await room(engine.joinRoom(playing(), 'w', 'w'), ['p0', 'p1', 'p2', 'w']);
  let t = 1_000_000;
  const now = () => t;
  const poll = (token) => handleRoom(db, { action: 'view', code: 'ABCD', token }, { ...quiet, now });
  for (const tok of ['tp0', 'tp1', 'tp2', 'tw']) await poll(tok);
  t += engine.PRESENCE.staleMs - 5000;
  for (const tok of ['tp0', 'tp1', 'tp2']) await poll(tok);
  t += 10_000;
  await poll('tp1');
  await poll('tp2');
  const r = await poll('tp0');
  assert.equal(r.status, 200);
  const s = db.rows.get('ABCD').state;
  assert.equal(s.phase, 'turns', 'the game goes on');
  assert.deepEqual(s.spectators, []);
  assert.equal(s.abandonedBy ?? null, null);
  assert.equal(r.body.view.players.every((p) => p.connected), true);
});

test('a spectator closing the tab (bye) or leaving removes them quietly', async () => {
  const db = await room(engine.joinRoom(playing(), 'w', 'w'), ['p0', 'p1', 'p2', 'w']);
  const r = await handleRoom(db, { action: 'leave', code: 'ABCD', token: 'tw' }, quiet);
  assert.equal(r.status, 200);
  const s = db.rows.get('ABCD').state;
  assert.equal(s.phase, 'turns');
  assert.deepEqual(s.spectators, []);
});

test('the room is not purged while a game is played in front of a crowd', async () => {
  const db = await room(playing(), ['p0', 'p1', 'p2']);
  const now = () => Date.parse('2026-01-10T00:00:00Z');
  db.rows.get('ABCD').created_at = new Date(now() - 2 * engine.PRESENCE.lonelyMs).toISOString();
  db.rows.get('ABCD').seen = { p0: now() - 1000, p1: now() - 1000, p2: now() - 1000 };
  const r = await handleRoom(db, { action: 'view', code: 'ABCD', token: 'tp0' }, { ...quiet, now });
  assert.equal(r.status, 200);
});
