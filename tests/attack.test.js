import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../supabase/functions/_shared/engine.js';
import { RATE, RATE_UNKNOWN, UNKNOWN_IP, memoryCounters } from '../supabase/functions/_shared/ratelimit.js';
import { handleAct, handleRoom } from '../supabase/functions/_shared/handlers.js';
import { fakeDb } from './helpers.js';

// A hostile client's playbook, run against the real handlers.
const quiet = { notify: async () => true };

let seq = 0;
const uuid = () => `id-${++seq}-${Math.random().toString(16).slice(2)}`;
const room = (db, body, deps = {}) => handleRoom(db, body, { ...quiet, uuid, ...deps });
const act = (db, body, deps = {}) => handleAct(db, body, { ...quiet, ...deps });

async function newRoom(db, players = 3, extra = {}, rules = undefined) {
  const made = await room(db, { action: 'create', name: 'p0', rules }, extra);
  assert.equal(made.status, 200);
  const code = made.body.code;
  const who = [{ id: made.body.playerId, token: made.body.token }];
  for (let i = 1; i < players; i++) {
    const j = await room(db, { action: 'join', code, name: `p${i}` }, extra);
    who.push({ id: j.body.playerId, token: j.body.token });
  }
  return { code, who };
}

// ---- reading hidden cards ---------------------------------------------------------

const pickOf = (xs) => xs[Math.floor(Math.random() * xs.length)];

// Every card the observer is not entitled to see right now: the deck, the other hands, and their own
// hand unless a reveal is pending, plus the card someone else is holding.
function hiddenUids(state, observerId) {
  const me = state.players.find((p) => p.id === observerId);
  const seeing = new Set((me ? me.viewable : []).map((v) => `${v.ownerId}:${v.slot}`));
  const out = new Set(state.deck.map((c) => c.uid));
  for (const p of state.players) {
    p.hand.forEach((c, slot) => { if (c && !seeing.has(`${p.id}:${slot}`)) out.add(c.uid); });
  }
  const turn = state.players[state.turn];
  if (state.drawn && !(turn && turn.id === observerId)) out.add(state.drawn.uid);
  return out;
}

function pathOf(obj, uid, path = '') {
  if (obj && typeof obj === 'object') {
    if (obj.uid === uid) return path;
    for (const [k, v] of Object.entries(obj)) {
      const p = pathOf(v, uid, `${path}.${k}`);
      if (p) return p;
    }
  }
  return null;
}

const uidsIn = (text) => new Set([...text.matchAll(/"uid":(\d+)/g)].map((m) => Number(m[1])));

function botMove(state, who) {
  const mine = state.players.find((p) => p.id === who.id);
  const others = state.players.filter((p) => p.id !== who.id);
  const slotOf = (p) => pickOf(p.hand.map((c, i) => (c ? i : -1)).filter((i) => i >= 0).concat([0]));
  if (Math.random() < 0.12) {
    const owner = pickOf(state.players);
    return { action: 'slap', args: { ownerId: owner.id, slot: slotOf(owner), giveSlot: slotOf(mine) } };
  }
  if (state.phase === 'setup') return { action: 'peekSetup', args: { slots: [0, 1] } };
  if (state.phase === 'rps') return { action: 'rps', args: { pick: pickOf(['r', 'p', 's']) } };
  const pend = state.pending[0];
  if (pend && pend.by === who.id) {
    if (pend.type === 'J') {
      const t = pickOf(others);
      return { action: 'power', args: { type: 'J', J: { targetId: t.id, mine: slotOf(mine), theirs: slotOf(t) } } };
    }
    if (pend.type === 'Q') {
      const t = pickOf(state.players);
      return { action: 'power', args: { type: 'Q', Q: { targetId: t.id, slot: slotOf(t) } } };
    }
    if (!pend.target) {
      const t = pickOf(others);
      return { action: 'power', args: { type: 'K', K: { targetId: t.id, slot: slotOf(t) } } };
    }
    if (!pend.own) return { action: 'kingLook', args: { slot: slotOf(mine) } };
    return { action: 'confirmKing', args: { swap: Math.random() < 0.5 } };
  }
  if (state.players[state.turn].id !== who.id) return { action: 'slap', args: { ownerId: mine.id, slot: slotOf(mine) } };
  if (state.drawn) return Math.random() < 0.5 ? { action: 'keep', args: { slot: slotOf(mine) } } : { action: 'discard', args: {} };
  return Math.random() < 0.15 ? { action: 'gringo', args: {} } : { action: 'draw', args: {} };
}

test('real attempt: playing full games, no response ever carries a card the player may not see', async () => {
  let checked = 0;
  for (let game = 0; game < 14; game++) {
    const db = fakeDb();
    // Half the games let hands be slapped across the table and Jacks swap anyone, so those paths are attacked too.
    const { code, who } = await newRoom(db, 3 + (game % 2), {}, { slapOthers: game % 2 === 0, jackAnyPlayers: game % 3 === 0 });
    // A spectator is the best-placed spy: they only listen.
    const spy = await room(db, { action: 'join', code, name: 'spy' });
    // (the lobby had a seat, so with 3 players they sit; with 4 they watch)
    const observers = [...who, { id: spy.body.playerId, token: spy.body.token }];
    await room(db, { action: 'start', code, token: who[0].token });
    for (let step = 0; step < 900; step++) {
      const state = db.rows.get(code).state;
      if (state.phase === 'done') break;
      const actor = pickOf(who);
      const move = botMove(state, actor);
      const res = await act(db, { code, token: actor.token, ...move });
      const after = db.rows.get(code).state;
      if (after.phase === 'done' || after.phase === 'rps') continue;
      for (const o of observers) {
        // The first poll after the ending window scores the game (the clock is real), so what counts as
        // hidden is judged on the state the answer was actually built from.
        const view = (await room(db, { action: 'view', code, token: o.token })).body;
        const now = db.rows.get(code).state;
        if (now.phase === 'done' || now.phase === 'rps') break;
        const hidden = hiddenUids(now, o.id);
        const texts = [JSON.stringify(view)];
        if (o.id === actor.id && res.status === 200) {
          const legit = new Set([...uidsIn(JSON.stringify(res.body.seen ?? null))]);
          // a King/Queen/peek answer is the one place a hidden card may be named, and only to the asker
          const body = { ...res.body };
          delete body.seen;
          texts.push(JSON.stringify(body));
          for (const u of legit) hidden.delete(u);
        }
        for (const text of texts) {
          for (const u of uidsIn(text)) {
            assert.ok(!hidden.has(u), `game ${game} step ${step}: ${o.id} was sent hidden card ${u} (${move.action}) at ${pathOf(JSON.parse(text), u)}; phase ${after.phase}; location: ${JSON.stringify(after.deck.some((c) => c.uid === u) ? 'deck' : after.players.map((p) => p.hand.map((c) => c && c.uid)))}`);
          }
        }
        checked += 1;
      }
    }
  }
  assert.ok(checked > 500, 'the games actually ran');
});

// ---- being someone else ------------------------------------------------------------

test('real attempt: forged tokens never act, view or leave as another player', async () => {
  const db = fakeDb();
  const { code, who } = await newRoom(db, 3);
  await room(db, { action: 'start', code, token: who[0].token });
  const stored = db.rows.get(code).tokens;
  const before = JSON.stringify(db.rows.get(code).state);
  const forged = [
    who[1].id, who[0].id, stored[who[0].id], stored[who[1].id], who[0].token.toUpperCase(), ` ${who[0].token}`, `${who[0].token} `,
    who[0].token.slice(0, -1), `${who[0].token}x`, who[0].token + who[0].token, '', null, 0, 1, true, {}, [who[0].token], { toString: () => who[0].token },
    '__proto__', 'constructor', 'A'.repeat(5000),
  ];
  for (const token of forged) {
    for (const body of [
      { action: 'view', code }, { action: 'leave', code }, { action: 'sit', code }, { action: 'kick', code, targetId: who[1].id },
    ]) {
      const r = await room(db, { ...body, token });
      assert.equal(r.status, 403, `${JSON.stringify(token)} ${body.action} -> ${r.status}`);
    }
    for (const action of ['draw', 'peekSetup', 'gringo', 'slap', 'rematch']) {
      const r = await act(db, { code, token, action, args: { slots: [0, 1], ownerId: who[1].id, slot: 0 } });
      assert.equal(r.status, 403, `${JSON.stringify(token)} ${action} -> ${r.status}`);
    }
  }
  assert.equal(JSON.stringify(db.rows.get(code).state), before, 'not one forged request changed the room');
});

test('real attempt: someone else cannot use a player id as a token, and a spectator cannot start or kick', async () => {
  const db = fakeDb();
  const { code, who } = await newRoom(db, 4);
  const spy = await room(db, { action: 'join', code, name: 'spy' });
  assert.ok([400, 403].includes((await room(db, { action: 'start', code, token: spy.body.token })).status), 'a spectator cannot start');
  assert.equal((await room(db, { action: 'kick', code, token: spy.body.token, targetId: who[1].id })).status, 403);
  assert.equal((await room(db, { action: 'kick', code, token: who[1].token, targetId: who[2].id })).status, 403, 'only the host kicks');
  assert.equal(db.rows.get(code).state.players.length, 4);
});

// ---- guessing room codes and flooding ----------------------------------------------

test('real attempt: guessing room codes is cut off after a few tries, per address', async () => {
  const db = fakeDb();
  const { code } = await newRoom(db, 2, { ip: '10.0.0.1' });
  const t0 = 5_000_000;
  const attacker = '203.0.113.7';
  let missed = 0;
  let blocked = 0;
  for (let i = 0; i < 300; i++) {
    const guess = String.fromCharCode(65 + (i % 26), 65 + (Math.floor(i / 26) % 26), 75, 75);
    const r = await room(db, { action: 'join', code: guess === code ? 'ZZZZ' : guess, name: 'x' }, { ip: attacker, now: () => t0 + i * 10 });
    if (r.status === 404) missed += 1;
    if (r.status === 429) blocked += 1;
  }
  assert.ok(missed <= RATE.misses, `only ${RATE.misses} wrong guesses get an answer, saw ${missed}`);
  assert.ok(blocked >= 300 - RATE.misses - 1);
  // Even the right code gets nothing from the blocked address; it does not even reveal that it exists.
  const right = await room(db, { action: 'join', code, name: 'x' }, { ip: attacker, now: () => t0 + 5000 });
  assert.equal(right.status, 429);
  // Everyone else is unaffected, and the block lifts after the window.
  assert.equal((await room(db, { action: 'join', code, name: 'friend' }, { ip: '198.51.100.2', now: () => t0 + 5000 })).status, 200);
  assert.equal((await room(db, { action: 'join', code, name: 'later' }, { ip: attacker, now: () => t0 + RATE.windowMs + 6000 })).status, 200);
});

test('real attempt: a burst of simultaneous guesses cannot all slip past the limit', async () => {
  const db = fakeDb();
  const ip = '203.0.113.99';
  const burst = await Promise.all(Array.from({ length: 400 }, (_, i) =>
    room(db, { action: 'join', code: `Q${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + (Math.floor(i / 26) % 26))}Z`, name: 'x' }, { ip, now: () => 7_000_000 })));
  const answered = burst.filter((r) => r.status === 404).length;
  assert.ok(answered <= RATE.misses, `only ${RATE.misses} guesses may be answered at once, ${answered} were`);
  assert.equal(burst.filter((r) => r.status === 429).length, 400 - answered);
});

test('requests that succeed give their reservation back, so normal play never nears the miss limit', async () => {
  const db = fakeDb();
  const { code, who } = await newRoom(db, 2, { ip: '10.9.9.9', now: () => 7_999_000 });
  const ip = '10.9.9.9';
  const results = [];
  for (let i = 0; i < 200; i++) results.push((await room(db, { action: 'view', code, token: who[i % 2].token }, { ip, now: () => 8_000_000 })).status);
  assert.ok(results.every((s) => s === 200));
  // A handful of honest mistakes on top of that are still fine.
  for (let i = 0; i < 5; i++) assert.equal((await room(db, { action: 'join', code: 'ZZZZ', name: 'x' }, { ip, now: () => 8_000_000 })).status, 404);
  assert.equal((await room(db, { action: 'view', code, token: who[0].token }, { ip, now: () => 8_000_000 })).status, 200);
  // Simultaneous honest requests (four players polling at the same moment) are not mistaken for guessing.
  const together = await Promise.all(Array.from({ length: 12 }, (_, i) => room(db, { action: 'view', code, token: who[i % 2].token }, { ip, now: () => 8_000_001 })));
  assert.ok(together.every((r) => r.status === 200));
});

test('real attempt: wrong tokens count as guesses too', async () => {
  const db = fakeDb();
  const { code, who } = await newRoom(db, 2, { ip: '10.0.0.1' });
  const ip = '203.0.113.9';
  const statuses = [];
  for (let i = 0; i < 40; i++) statuses.push((await act(db, { code, token: `guess${i}`, action: 'draw' }, { ip })).status);
  assert.equal(statuses.filter((s) => s === 403).length, RATE.misses);
  assert.ok(statuses.slice(RATE.misses).every((s) => s === 429));
  assert.equal((await act(db, { code, token: who[0].token, action: 'draw' }, { ip: '10.0.0.1' })).status, 400, 'a real player on another address still reaches the game (not started yet)');
});

test('real attempt: room creation and join floods are capped and never touch the rooms', async () => {
  const db = fakeDb();
  const ip = '192.0.2.5';
  const made = [];
  for (let i = 0; i < RATE.create + 5; i++) made.push((await room(db, { action: 'create', name: 'x' }, { ip })).status);
  assert.equal(made.filter((s) => s === 200).length, RATE.create);
  assert.ok(made.slice(RATE.create).every((s) => s === 429));
  assert.equal(db.rows.size, RATE.create, 'no extra rooms were made');

  const { code } = await newRoom(fakeDb(), 2);
  const db2 = fakeDb();
  const host = await newRoom(db2, 4, { ip: '10.1.1.1' });
  const results = [];
  for (let i = 0; i < RATE.join + 10; i++) results.push((await room(db2, { action: 'join', code: host.code, name: `s${i}` }, { ip })).status);
  assert.equal(results.filter((s) => s === 200).length, 8, 'at most 8 spectators exist at once');
  assert.ok(results.includes(429), 'and the flood is cut off');
  assert.ok(db2.rows.get(host.code).state.spectators.length <= 8);
  assert.ok(code);
});

test('real attempt: hammering one address is cut off, but a polling table of four is nowhere near the limit', async () => {
  const db = fakeDb();
  const { code, who } = await newRoom(db, 4, { ip: '10.2.2.2', now: () => 8_999_000 });
  const t0 = 9_000_000;
  const ip = '10.2.2.2';
  // Four players polling every 2 seconds for a minute.
  let throttled = 0;
  for (let s = 0; s < 30; s++) {
    for (const p of who) {
      if ((await room(db, { action: 'view', code, token: p.token }, { ip, now: () => t0 + s * 2000 })).status === 429) throttled += 1;
    }
  }
  assert.equal(throttled, 0);
  let cut = 0;
  for (let i = 0; i < RATE.all + 50; i++) {
    if ((await room(db, { action: 'view', code, token: who[0].token }, { ip: '10.3.3.3', now: () => t0 })).status === 429) cut += 1;
  }
  assert.ok(cut >= 49, `the flood is cut off (${cut} refused)`);
});

test('the limiter never gets in the way when it cannot do its job', async () => {
  const db = fakeDb();
  db.gate = async () => { throw new Error('database down'); };
  db.miss = async () => { throw new Error('database down'); };
  const made = await room(db, { action: 'create', name: 'x' }, { ip: '1.2.3.4' });
  assert.equal(made.status, 200);
  assert.equal((await room(db, { action: 'join', code: 'ZZZZ', name: 'x' }, { ip: '1.2.3.4' })).status, 404);
  // No address passed in (unit tests, internal callers): no limits at all.
  const bare = fakeDb();
  for (let i = 0; i < RATE.create + 3; i++) assert.equal((await room(bare, { action: 'create', name: 'x' })).status, 200);
});

test('requests with no trusted address share one looser bucket instead of going unlimited', async () => {
  const db = fakeDb();
  const statuses = [];
  for (let i = 0; i < RATE_UNKNOWN.create + 5; i++) statuses.push((await room(db, { action: 'create', name: 'x' }, { ip: UNKNOWN_IP, now: () => 3_000_000 })).status);
  assert.equal(statuses.filter((s) => s === 200).length, RATE_UNKNOWN.create, 'ten times the normal allowance');
  assert.ok(RATE_UNKNOWN.create > RATE.create);
  assert.ok(statuses.slice(RATE_UNKNOWN.create).every((s) => s === 429));
});

test('a release only counts inside the window the reservation was made in', () => {
  const c = memoryCounters();
  const W = 60_000;
  c.gate('1.1.1.1', '', 1000, W); // reserved in window A
  c.gate('1.1.1.1', '', 2000, W);
  c.release('1.1.1.1', 2000, W); // same window: counts back
  assert.equal(c.gate('1.1.1.1', '', 3000, W).miss, 2);
  // The window rolls over, someone reserves in the new one, then an old request releases.
  const first = c.gate('1.1.1.1', '', 70_000, W);
  assert.equal(first.miss, 1);
  c.release('1.1.1.1', 59_000, W); // reservation belonged to the old window: ignored
  assert.equal(c.gate('1.1.1.1', '', 71_000, W).miss, 2);
});

// ---- the lasting game log -----------------------------------------------------------

test('every game start is logged once, rematches included, with only a time and a player count', async () => {
  const db = fakeDb();
  const { code, who } = await newRoom(db, 3);
  assert.equal(db.starts.length, 0, 'a lobby is not a game');
  await room(db, { action: 'start', code, token: who[0].token });
  assert.equal(db.starts.length, 1);
  assert.equal(db.starts[0].players, 3);
  assert.deepEqual(Object.keys(db.starts[0]).sort(), ['at', 'players']);
  const s = db.rows.get(code).state;
  // End it by a forfeit, then everyone left votes for another game.
  await room(db, { action: 'leave', code, token: who[2].token });
  assert.equal(db.rows.get(code).state.phase, 'setup', 'two are left, so the game goes on');
  await room(db, { action: 'leave', code, token: who[1].token });
  assert.equal(db.rows.get(code).state.phase, 'done');
  assert.equal(db.starts.length, 1, 'a game ending is not a start');
  // Only p0 is left; a game needs two, so a spectator who asks for a seat makes it.
  const watcher = await room(db, { action: 'join', code, name: 'w' });
  await room(db, { action: 'sit', code, token: watcher.body.token });
  await act(db, { code, token: who[0].token, action: 'rematch' });
  assert.equal(db.rows.get(code).state.phase, 'setup');
  assert.equal(db.starts.length, 2);
  assert.equal(db.starts[1].players, 2);
  assert.ok(s);
});

test('a failing log never breaks starting a game', async () => {
  const db = fakeDb();
  db.logStart = async () => { throw new Error('log table missing'); };
  const { code, who } = await newRoom(db, 2);
  assert.equal((await room(db, { action: 'start', code, token: who[0].token })).status, 200);
  assert.equal(db.rows.get(code).state.phase, 'setup');
});
