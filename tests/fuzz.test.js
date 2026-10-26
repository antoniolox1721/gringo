import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../supabase/functions/_shared/engine.js';
import { hashToken } from '../supabase/functions/_shared/store.js';
import { handleAct, handleRoom } from '../supabase/functions/_shared/handlers.js';
import { c, fakeDb, seededRng, stackedGame } from './helpers.js';

// What a hostile client can do from the dev console: any action, any JSON, any token.
const quiet = { notify: async () => true };
const rand = seededRng(42);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

const JUNK = [
  null, undefined, true, false, 0, -1, 1, 2, 3, 4, 9, 1e9, -0, 0.5, NaN, Infinity, 'x', '', '0', '__proto__', 'constructor',
  'p0', 'p1', 'p2', 'J', 'Q', 'K', 'r', {}, [], [0, 1], [0, 0], [1, 1], ['a'], { slot: 0 }, { __proto__: { slot: 0 } },
  { targetId: 'p1', slot: 0 }, 'A'.repeat(500),
  // plausible values, so setup and tiebreak actually get past validation now and then
  [0, 1], [2, 3], [1, 3], 'p', 's', 'r', 0, 1, 2, 3, 'p1', 'p2',
];
const ACTS = ['peekSetup', 'draw', 'keep', 'discard', 'power', 'kingLook', 'confirmKing', 'skipPower', 'slap', 'gringo', 'rps', '__proto__', 'toString', 7, null];
const ROOM_ACTS = ['create', 'join', 'view', 'start', 'kick', 'leave', 'sit', '__proto__', null];

const deckOf = (hands) => hands.map((h) => h);
function game(kind) {
  const base = () => stackedGame({
    players: ['p0', 'p1', 'p2'],
    hands: deckOf([[c('5'), c('6'), c('7'), c('2')], [c('9', 'H'), c('10', 'H'), c('2', 'C'), c('3', 'C')], [c('A'), c('4'), c('8'), c('3')]]),
    deck: [c('9', 'D'), c('8', 'H'), c('2', 'S'), c('3', 'S'), c('J', 'D'), c('K', 'H')],
    discard: [c('4', 'D')],
  });
  const g = base();
  if (kind === 'setup') return engine.startGame(engine.addPlayer(engine.addPlayer(engine.createGame('p0', 'p0'), 'p1', 'p1'), 'p2', 'p2'), 'p0', rand);
  if (kind === 'drawn') return engine.draw(g, 'p0', rand).state;
  if (kind === 'queen') return { ...g, pending: [{ type: 'Q', by: 'p0' }], acted: true };
  if (kind === 'king') return { ...g, pending: [{ type: 'K', by: 'p0' }], acted: true };
  if (kind === 'king2') {
    const k = engine.usePower({ ...g, pending: [{ type: 'K', by: 'p0' }], acted: true }, 'p0', { type: 'K', targetId: 'p1', slot: 0 });
    return k.state;
  }
  if (kind === 'jack') return { ...g, pending: [{ type: 'J', by: 'p0' }], acted: true };
  if (kind === 'final') return engine.callGringo(g, 'p0');
  if (kind === 'rps') {
    const t = stackedGame({ players: ['p0', 'p1', 'p2'], hands: [[c('2')], [c('2')], [c('9')]] });
    t.phase = 'final';
    t.finalLeft = [];
    return engine.finishGame(t);
  }
  return g;
}
const RULE_SETS = [
  {}, { jackAnyPlayers: true }, { gringoBlocksSwaps: false }, { slapOthers: false }, { slapOthers: true, slapGive: false }, { multiSlap: true },
  { missPenalty: 3 }, { jackAnyPlayers: true, gringoBlocksSwaps: false, slapGive: false, multiSlap: true, missPenalty: 2 },
];
// Every state gets a spectator ('w') and random house rules, so both are fuzzed in every phase.
const withExtras = (state) => ({
  ...state,
  rules: engine.cleanRules(pick(RULE_SETS)),
  spectators: [{ id: 'w', name: 'w', wantsIn: rand() < 0.5 }],
});
const KINDS = ['setup', 'turns', 'drawn', 'queen', 'king', 'king2', 'jack', 'final', 'rps'];

const cardCount = (s) =>
  s.deck.length + s.discard.length + (s.drawn ? 1 : 0) + s.players.reduce((n, p) => n + p.hand.filter((x) => x !== null).length, 0);

async function seed(state) {
  const db = fakeDb();
  const tokens = {};
  for (const p of [...state.players, ...(state.spectators || [])]) tokens[p.id] = await hashToken(`t${p.id}`);
  db.rows.set('ABCD', { code: 'ABCD', state, tokens, version: state.version });
  return db;
}

// Well-formed arguments for the actions that junk rarely guesses, so every phase gets exercised.
const GOOD = {
  peekSetup: { slots: [0, 1] }, rps: { pick: 'r' }, keep: { slot: 0 }, slap: { ownerId: 'p1', slot: 0, giveSlot: 0 },
  kingLook: { slot: 0 }, confirmKing: { swap: true }, power: { type: 'K', K: { targetId: 'p1', slot: 0 } },
};
const OK = new Set([200, 400, 403, 404, 409]);

function assertNoLeak(state, view, who) {
  const me = state.players.find((p) => p.id === who);
  const allowed = new Set((me ? me.viewable : []).map((v) => `${v.ownerId}:${v.slot}`));
  for (const p of view.players) {
    for (const e of p.hand) {
      if (e.card && view.phase !== 'done' && view.phase !== 'rps') {
        assert.ok(allowed.has(`${p.id}:${e.slot}`), `${who} sees ${p.id} slot ${e.slot} without being allowed`);
      }
    }
  }
  const text = JSON.stringify(view);
  assert.ok(!text.includes('"tokens"') && !text.includes('"deck":['), 'view leaks tokens or the deck');
}

test('junk from a hostile client never crashes, never changes the card count, never leaks a hidden card', async () => {
  for (const kind of KINDS) {
    for (let round = 0; round < 120; round++) {
      let state = withExtras(game(kind));
      const db = await seed(state);
      const before = cardCount(state);
      for (let i = 0; i < 6; i++) {
        const who = pick(['p0', 'p1', 'p2', 'w']);
        const args = {};
        for (const k of ['firstId', 'slot', 'slots', 'type', 'targetId', 'mine', 'theirs', 'ownerId', 'giveSlot', 'swap', 'pick', 'J', 'Q', 'K', 'swapWithSlot']) {
          if (rand() < 0.6) args[k] = pick(JUNK);
        }
        const action = pick(ACTS);
        const body = {
          code: 'ABCD', token: pick([`t${who}`, `t${who}`, `t${who}`, 'nope', '', null, 5]), action,
          args: rand() < 0.4 && GOOD[action] ? GOOD[action] : pick([args, args, null, [], 'x', 5]),
        };
        const r = await handleAct(db, body, quiet);
        assert.ok(OK.has(r.status), `${kind}: ${JSON.stringify(body)} -> ${r.status}`);
        state = db.rows.get('ABCD').state;
        assert.equal(cardCount(state), before, `${kind}: cards created or destroyed by ${JSON.stringify(body)}`);
        if (r.body.view) assertNoLeak(state, r.body.view, who);
        for (const id of ['p0', 'p1', 'p2', 'w']) {
          const v = await handleRoom(db, { action: 'view', code: 'ABCD', token: `t${id}` }, quiet);
          assert.equal(v.status, 200);
          assertNoLeak(state, v.body.view, id);
        }
      }
    }
  }
});

test('junk room requests never crash and never let a stranger touch a game', async () => {
  for (let i = 0; i < 400; i++) {
    const state = game(pick(KINDS));
    const db = await seed(state);
    const body = {
      action: pick(ROOM_ACTS), code: pick(['ABCD', 'abcd', 'ABC', 'ABCDE', '', null, 5, '__pr', 'ZZZZ']),
      token: pick(['tp0', 'nope', '', null, 5, {}]), name: pick(JUNK), targetId: pick(JUNK), bye: pick(JUNK),
    };
    const r = await handleRoom(db, body, quiet);
    assert.ok(OK.has(r.status), `${JSON.stringify(body)} -> ${r.status}`);
    // A join needs no token: into a running game it only adds a spectator, never touching the players.
    if (body.token !== 'tp0') {
      const row = db.rows.get('ABCD');
      if (row && body.action === 'join' && r.status === 200) {
        assert.deepEqual(row.state.players, state.players, `a stranger changed the players with ${JSON.stringify(body)}`);
      } else if (row) assert.equal(row.version, state.version, `a stranger changed the game with ${JSON.stringify(body)}`);
    }
  }
});
