import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWithRetry, hashToken, broadcast, HttpError } from '../supabase/functions/_shared/store.js';
import { handleAct, handleRoom } from '../supabase/functions/_shared/handlers.js';
import { c, stackedGame } from './helpers.js';

// In-memory db with the same get/insert/update(CAS) interface as supabaseDb. Every call yields so
// that concurrent requests interleave like they would against a real database.
function fakeDb() {
  const rows = new Map();
  const tick = () => new Promise((r) => setImmediate(r));
  return {
    rows,
    async get(code) {
      await tick();
      const row = rows.get(code);
      return row ? structuredClone(row) : null;
    },
    async insert(row) {
      await tick();
      if (rows.has(row.code)) return false;
      rows.set(row.code, structuredClone(row));
      return true;
    },
    async update(code, expectedVersion, patch) {
      await tick();
      const row = rows.get(code);
      if (!row || row.version !== expectedVersion) return false;
      rows.set(code, { ...row, ...structuredClone(patch) });
      return true;
    },
  };
}

const quiet = { notify: async () => true };
const live = (hand) => hand.filter((x) => x !== null).length;

async function seed(db, state, tokenByPlayer) {
  const tokens = {};
  for (const [id, t] of Object.entries(tokenByPlayer)) tokens[id] = await hashToken(t);
  db.rows.set('ABCD', { code: 'ABCD', state, tokens, version: state.version });
}

function slapState() {
  return stackedGame({
    players: ['a', 'b'],
    hands: [
      [c('7', 'H'), c('3'), c('4'), c('5')],
      [c('6'), c('7', 'D'), c('8'), c('9')],
    ],
    deck: [c('9', 'H'), c('8', 'H'), c('2', 'S')],
    discard: [c('4', 'D'), c('7', 'S')],
    turn: 0,
  });
}

test('two concurrent slaps on the same pile card leave exactly one ok and one penalty', async () => {
  const db = fakeDb();
  await seed(db, slapState(), { a: 'ta', b: 'tb' });
  const [ra, rb] = await Promise.all([
    handleAct(db, { code: 'ABCD', token: 'ta', action: 'slap', args: { ownerId: 'a', slot: 0 } }, quiet),
    handleAct(db, { code: 'ABCD', token: 'tb', action: 'slap', args: { ownerId: 'b', slot: 1 } }, quiet),
  ]);
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 200);
  assert.equal([ra, rb].filter((r) => r.body.ok === true).length, 1);
  assert.equal([ra, rb].filter((r) => r.body.ok === false).length, 1);
  const { state } = db.rows.get('ABCD');
  assert.equal(state.discardClaimed, true);
  const counts = state.players.map((p) => p.hand.length === 5 ? 'penalty' : live(p.hand));
  assert.deepEqual(counts.slice().sort(), [3, 'penalty'].sort());
  assert.equal(state.version, 2);
});

test('applyWithRetry gives up after 5 conflicts', async () => {
  const db = fakeDb();
  await seed(db, slapState(), { a: 'ta' });
  let calls = 0;
  const realUpdate = db.update;
  db.update = async (code, ver, patch) => {
    // Someone else always saves first.
    await realUpdate(code, ver, { ...patch, version: ver + 1 });
    return realUpdate(code, ver, patch);
  };
  await assert.rejects(
    applyWithRetry(db, 'ABCD', (s) => { calls++; return { ...s, version: s.version + 1 }; }),
    (e) => e instanceof HttpError && e.status === 409,
  );
  assert.equal(calls, 5);
});

test('errors from fn are not retried', async () => {
  const db = fakeDb();
  await seed(db, slapState(), { a: 'ta' });
  let calls = 0;
  await assert.rejects(applyWithRetry(db, 'ABCD', () => { calls++; throw new Error('boom'); }), /boom/);
  assert.equal(calls, 1);
});

test('a bad token is rejected with 403 and changes nothing', async () => {
  const db = fakeDb();
  await seed(db, slapState(), { a: 'ta', b: 'tb' });
  for (const token of ['nope', '', undefined]) {
    const r = await handleAct(db, { code: 'ABCD', token, action: 'discard', args: {} }, quiet);
    assert.equal(r.status, 403);
  }
  const v = await handleRoom(db, { action: 'view', code: 'ABCD', token: 'nope' }, quiet);
  assert.equal(v.status, 403);
  assert.equal(db.rows.get('ABCD').version, 0);
});

test('engine errors become 400 with the message', async () => {
  const db = fakeDb();
  await seed(db, slapState(), { a: 'ta', b: 'tb' });
  const r = await handleAct(db, { code: 'ABCD', token: 'tb', action: 'draw', args: {} }, quiet);
  assert.deepEqual(r, { status: 400, body: { error: 'not your turn' } });
  const bad = await handleAct(db, { code: 'ABCD', token: 'ta', action: 'nope' }, quiet);
  assert.equal(bad.status, 400);
  const missing = await handleAct(db, { code: 'ZZZZ', token: 'ta', action: 'draw' }, quiet);
  assert.equal(missing.status, 404);
});

test('room flow: create, join, view, start, kick', async () => {
  const db = fakeDb();
  const sent = [];
  const deps = { notify: async (code, version) => sent.push([code, version]) };
  const created = await handleRoom(db, { action: 'create', name: 'Ana' }, deps);
  assert.equal(created.status, 200);
  const { code, playerId: host, token: hostTok } = created.body;
  assert.match(code, /^[A-Z]{4}$/);
  assert.notEqual(db.rows.get(code).tokens[host], hostTok);
  assert.equal(db.rows.get(code).tokens[host], await hashToken(hostTok));

  const early = await handleRoom(db, { action: 'start', code, token: hostTok }, deps);
  assert.deepEqual(early, { status: 400, body: { error: 'need at least 2 players' } });

  const j = await handleRoom(db, { action: 'join', code: code.toLowerCase(), name: 'Bo' }, deps);
  assert.equal(j.status, 200);
  const j2 = await handleRoom(db, { action: 'join', code, name: 'Cy' }, deps);

  const kickByGuest = await handleRoom(db, { action: 'kick', code, token: j.body.token, targetId: host }, deps);
  assert.equal(kickByGuest.status, 403);
  const kicked = await handleRoom(db, { action: 'kick', code, token: hostTok, targetId: j2.body.playerId }, deps);
  assert.deepEqual(kicked, { status: 200, body: { ok: true } });
  assert.equal(db.rows.get(code).state.players.length, 2);
  assert.equal(db.rows.get(code).tokens[j2.body.playerId], undefined);

  const started = await handleRoom(db, { action: 'start', code, token: hostTok }, deps);
  assert.deepEqual(started, { status: 200, body: { ok: true } });
  const view = await handleRoom(db, { action: 'view', code, token: j.body.token }, deps);
  assert.equal(view.body.view.phase, 'setup');
  assert.equal(view.body.view.you, j.body.playerId);
  assert.ok(sent.length >= 4);

  const peek = await handleAct(db, { code, token: hostTok, action: 'peekSetup', args: { slots: [0, 1] } }, deps);
  assert.equal(peek.body.seen.length, 2);
  assert.ok(peek.body.view);
});

test('create regenerates the code on collision', async () => {
  const db = fakeDb();
  db.rows.set('AAAA', { code: 'AAAA', state: {}, tokens: {}, version: 0 });
  const seq = [0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5];
  let i = 0;
  const r = await handleRoom(db, { action: 'create', name: 'X' }, { rng: () => seq[i++ % seq.length] });
  assert.equal(r.body.code, 'NNNN');
});

test('draw with no cards left calls gringo for the turn player instead of deadlocking', async () => {
  const db = fakeDb();
  const s = slapState();
  s.deck = [];
  s.discard = [c('4', 'D')];
  await seed(db, s, { a: 'ta', b: 'tb' });
  const r = await handleAct(db, { code: 'ABCD', token: 'ta', action: 'draw', args: {} }, quiet);
  assert.equal(r.status, 200);
  assert.equal(r.body.view.phase, 'final');
  assert.deepEqual(r.body.view.endedBy, { id: 'a', reason: 'gringo' });
});

test('broadcast posts the changed event to the realtime REST endpoint', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true }; };
  const res = await broadcast('ABCD', 7, { url: 'https://x.supabase.co', key: 'k' }, fetchImpl);
  assert.equal(res, true);
  assert.equal(seen.url, 'https://x.supabase.co/realtime/v1/api/broadcast');
  assert.equal(seen.init.headers.apikey, 'k');
  assert.equal(seen.init.headers.authorization, 'Bearer k');
  assert.deepEqual(JSON.parse(seen.init.body).messages[0], {
    topic: 'game:ABCD', event: 'changed', payload: { version: 7 }, private: false,
  });
  assert.equal(await broadcast('ABCD', 7, {}, fetchImpl), false);
  assert.equal(await broadcast('ABCD', 7, { url: 'u', key: 'k' }, async () => { throw new Error('net'); }), false);
});

test('broadcast carries a timeout signal so a hung realtime call cannot stall a request', async () => {
  let init;
  await broadcast('ABCD', 1, { url: 'u', key: 'k' }, async (_u, i) => { init = i; return { ok: true }; });
  assert.ok(init.signal instanceof AbortSignal);
});

test('a player flagged offline gets 400 even with a valid token', async () => {
  const db = fakeDb();
  const s = slapState();
  s.players[1].connected = false;
  await seed(db, s, { a: 'ta', b: 'tb' });
  const r = await handleAct(db, { code: 'ABCD', token: 'tb', action: 'slap', args: { ownerId: 'a', slot: 0 } }, quiet);
  assert.deepEqual(r, { status: 400, body: { error: 'player is not in the game' } });
});

test('responses never contain other players\' hidden cards, token hashes or raw tokens', async () => {
  const db = fakeDb();
  const s = slapState();
  s.deck = [c('K', 'H'), c('8', 'H')];
  await seed(db, s, { a: 'ta', b: 'tb' });
  const drawn = await handleAct(db, { code: 'ABCD', token: 'ta', action: 'draw', args: {} }, quiet);
  const other = await handleRoom(db, { action: 'view', code: 'ABCD', token: 'tb' }, quiet);
  const hashes = Object.values(db.rows.get('ABCD').tokens);
  for (const r of [drawn, other]) {
    const text = JSON.stringify(r.body);
    for (const h of hashes) assert.ok(!text.includes(h));
    assert.ok(!text.includes('tokens'));
  }
  // b must not see a's hand, nor a's drawn card, nor the deck order.
  const text = JSON.stringify(other.body);
  assert.equal(other.body.view.drawn, null);
  assert.ok(!text.includes('"uid"') || other.body.view.players.every((p) => p.hand.every((h) => !h.card)));
  assert.equal(other.body.view.players[0].hand.some((h) => h.card), false);
  assert.equal(other.body.view.players[1].hand.some((h) => h.card), false);
  assert.equal(JSON.stringify(other.body).includes('"deck"'), false);
});

test('power responses carry the reveal as seen; a Queen reveal is not in the view', async () => {
  const db = fakeDb();
  const s = slapState();
  s.discard.push(c('Q', 'S'));
  s.pending = [{ type: 'Q', by: 'a' }];
  s.acted = true;
  await seed(db, s, { a: 'ta', b: 'tb' });
  const q = await handleAct(db, { code: 'ABCD', token: 'ta', action: 'power', args: { type: 'Q', Q: { targetId: 'b', slot: 2 } } }, quiet);
  assert.equal(q.status, 200);
  assert.equal(q.body.seen.uid, s.players[1].hand[2].uid);
  assert.ok(q.body.view.players.every((p) => p.hand.every((e) => e.card === undefined)));
  const again = await handleRoom(db, { action: 'view', code: 'ABCD', token: 'ta' }, quiet);
  assert.ok(again.body.view.players.every((p) => p.hand.every((e) => e.card === undefined)));
});

test('a King reveal is in the response and the view until it is resolved', async () => {
  const db = fakeDb();
  const s = slapState();
  s.discard.push(c('K', 'S'));
  s.pending = [{ type: 'K', by: 'a' }];
  s.acted = true;
  await seed(db, s, { a: 'ta', b: 'tb' });
  const k = await handleAct(db, { code: 'ABCD', token: 'ta', action: 'power', args: { type: 'K', K: { targetId: 'b', slot: 1 } } }, quiet);
  assert.equal(k.status, 200);
  assert.equal(k.body.seen.uid, s.players[1].hand[1].uid);
  assert.equal(k.body.view.players[1].hand[1].card.uid, s.players[1].hand[1].uid);
  const done = await handleAct(db, { code: 'ABCD', token: 'ta', action: 'confirmKing', args: { swapWithSlot: null } }, quiet);
  assert.equal(done.status, 200);
  assert.deepEqual(done.body.view.viewable, []);
  assert.ok(done.body.view.players.every((p) => p.hand.every((e) => e.card === undefined)));
});
