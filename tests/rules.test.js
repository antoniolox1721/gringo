import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../supabase/functions/_shared/engine.js';
import { hashToken } from '../supabase/functions/_shared/store.js';
import { handleAct, handleRoom } from '../supabase/functions/_shared/handlers.js';
import { c, fakeDb, seededRng, stackedGame } from './helpers.js';

const quiet = { notify: async () => true };
const rng = seededRng(5);

function game(rules, over = {}) {
  const s = stackedGame({
    players: ['a', 'b', 'c'],
    hands: [[c('5'), c('6'), c('7'), c('8')], [c('9'), c('10'), c('2'), c('3')], [c('4'), c('4', 'H'), c('A'), c('2', 'D')]],
    deck: [c('9', 'H'), c('8', 'H'), c('2', 'S'), c('3', 'S'), c('4', 'S'), c('5', 'H')],
    discard: [c('J', 'S')],
    ...over,
  });
  s.rules = engine.cleanRules(rules);
  return s;
}
const withJack = (s, by = 'a') => ({ ...s, pending: [{ type: 'J', by }] });

test('cleanRules keeps defaults for anything missing or malformed', () => {
  assert.deepEqual(engine.cleanRules(undefined), engine.DEFAULT_RULES);
  assert.deepEqual(engine.cleanRules(null), engine.DEFAULT_RULES);
  assert.deepEqual(engine.cleanRules('x'), engine.DEFAULT_RULES);
  assert.deepEqual(engine.cleanRules({ jackAnyPlayers: 'yes', missPenalty: 9, slapGive: 0, bogus: true, __proto__: { multiSlap: true } }), engine.DEFAULT_RULES);
  assert.deepEqual(engine.cleanRules({ missPenalty: 2.5 }), engine.DEFAULT_RULES);
  const custom = engine.cleanRules({ jackAnyPlayers: true, missPenalty: 3, gringoBlocksSwaps: false });
  assert.equal(custom.jackAnyPlayers, true);
  assert.equal(custom.missPenalty, 3);
  assert.equal(custom.gringoBlocksSwaps, false);
  assert.equal(custom.slapOthers, false, 'slapping other hands is a house rule');
  assert.equal(custom.slapGive, true);
  assert.equal(engine.cleanRules({ slapOthers: true }).slapOthers, true);
});

test('rooms and their views carry the rules; old states fall back to the defaults', () => {
  const made = engine.createGame('a', 'A', { multiSlap: true });
  assert.equal(engine.viewFor(made, 'a').rules.multiSlap, true);
  const old = engine.createGame('a', 'A');
  delete old.rules;
  assert.deepEqual(engine.viewFor(old, 'a').rules, engine.DEFAULT_RULES);
  const rematch = (() => {
    let s = engine.createGame('a', 'A', { multiSlap: true });
    s = engine.addPlayer(s, 'b', 'B');
    return engine.startGame(s, 'a', rng);
  })();
  assert.equal(rematch.rules.multiSlap, true, 'dealing keeps the rules');
});

test('standard rules: the Jack only swaps your own card with another player', () => {
  const s = withJack(game({}));
  assert.throws(() => engine.usePower(s, 'a', { type: 'J', targetId: 'b', firstId: 'c', mine: 0, theirs: 0 }), /first card must be yours/);
  const { state } = engine.usePower(s, 'a', { type: 'J', targetId: 'b', mine: 0, theirs: 1 });
  assert.equal(state.players[0].hand[0].rank, '10');
  assert.equal(state.players[1].hand[1].rank, '5');
  assert.throws(() => engine.usePower(s, 'a', { type: 'J', targetId: 'a', mine: 0, theirs: 1 }), /another player/);
});

test('jackAnyPlayers: swap two other players, or yourself and another', () => {
  const s = withJack(game({ jackAnyPlayers: true }));
  const { state } = engine.usePower(s, 'a', { type: 'J', firstId: 'b', targetId: 'c', mine: 0, theirs: 2 });
  assert.equal(state.players[1].hand[0].rank, 'A');
  assert.equal(state.players[2].hand[2].rank, '9');
  assert.deepEqual(state.players[0].hand.map((x) => x.rank), ['5', '6', '7', '8'], 'the Jack player is untouched');
  assert.equal(state.pending.length, 0);
  const own = engine.usePower(s, 'a', { type: 'J', firstId: 'a', targetId: 'c', mine: 1, theirs: 1 }).state;
  assert.equal(own.players[0].hand[1].suit, 'H');
  for (const bad of [
    { firstId: 'b', targetId: 'b', mine: 0, theirs: 1 },
    { firstId: 'nobody', targetId: 'b', mine: 0, theirs: 1 },
    { firstId: 'b', targetId: 'c', mine: 7, theirs: 0 },
    { firstId: 'b', targetId: 'c', mine: 0, theirs: -1 },
    { firstId: {}, targetId: 'c', mine: 0, theirs: 0 },
  ]) assert.throws(() => engine.usePower(s, 'a', { type: 'J', ...bad }), Error, JSON.stringify(bad));
  assert.throws(() => engine.usePower(withJack(game({})), 'b', { type: 'J', targetId: 'c', mine: 0, theirs: 0 }), /not your power/);
});

test('Gringo protects the caller by default and not when the rule is off', () => {
  const locked = (rules) => {
    const s = withJack(game(rules));
    s.players[1].gringo = true;
    s.endedBy = { id: 'b', reason: 'gringo' };
    return s;
  };
  assert.throws(() => engine.usePower(locked({}), 'a', { type: 'J', targetId: 'b', mine: 0, theirs: 0 }), /called gringo/);
  assert.throws(() => engine.usePower(locked({ jackAnyPlayers: true }), 'a', { type: 'J', firstId: 'b', targetId: 'c', mine: 0, theirs: 0 }), /called gringo/);
  assert.throws(() => engine.usePower(locked({ jackAnyPlayers: true }), 'a', { type: 'J', firstId: 'c', targetId: 'b', mine: 0, theirs: 0 }), /called gringo/);
  const { state } = engine.usePower(locked({ gringoBlocksSwaps: false }), 'a', { type: 'J', targetId: 'b', mine: 0, theirs: 0 });
  assert.equal(state.players[1].hand[0].rank, '5');
  // King too.
  const king = (rules) => {
    let s = { ...locked(rules), pending: [{ type: 'K', by: 'a' }] };
    s = engine.usePower(s, 'a', { type: 'K', targetId: 'b', slot: 0 }).state;
    return engine.kingLook(s, 'a', 0).state;
  };
  assert.throws(() => engine.confirmKing(king({}), 'a', true), /called gringo/);
  const swapped = engine.confirmKing(king({ gringoBlocksSwaps: false }), 'a', true);
  assert.equal(swapped.players[1].hand[0].rank, '5');
  assert.equal(swapped.players[0].hand[0].rank, '9');
});

const topSeven = (rules) => game(rules, { discard: [c('7', 'D')] });

test('slapOthers on: another hand can be slapped, taking the card and giving one back', () => {
  const s = topSeven({ slapOthers: true });
  s.players[1].hand[0] = c('7', 'C');
  const { state, ok } = engine.slap(s, 'a', { ownerId: 'b', slot: 0, giveSlot: 3 }, rng);
  assert.equal(ok, true);
  assert.equal(state.players[1].hand[0].rank, '8');
  assert.equal(state.players[0].hand[3], null);
  assert.throws(() => engine.slap(s, 'a', { ownerId: 'b', slot: 0 }, rng), /giveSlot required/);
});

test('by default only your own cards can be slapped, and trying another hand is refused without a penalty', () => {
  const s = topSeven({});
  s.players[1].hand[0] = c('7', 'C');
  assert.throws(() => engine.slap(s, 'a', { ownerId: 'b', slot: 0, giveSlot: 0 }, rng), /only your own/);
  assert.throws(() => engine.slap(s, 'a', { ownerId: 'b', slot: 1 }, rng), /only your own/, 'a wrong guess is refused too, not punished');
  const own = engine.slap(s, 'a', { ownerId: 'a', slot: 2 }, rng);
  assert.equal(own.ok, true);
  assert.equal(own.state.players[0].hand[2], null);
});

test('slapGive off: the card is taken and nothing is handed back', () => {
  const s = topSeven({ slapOthers: true, slapGive: false });
  s.players[1].hand[0] = c('7', 'C');
  const { state, ok } = engine.slap(s, 'a', { ownerId: 'b', slot: 0 }, rng);
  assert.equal(ok, true);
  assert.equal(state.players[1].hand[0], null);
  assert.deepEqual(state.players[0].hand.map((x) => x && x.rank), ['5', '6', '7', '8']);
  assert.equal(state.discard.at(-1).rank, '7');
  // A giveSlot sent anyway is ignored, never trusted.
  const sneaky = engine.slap(s, 'a', { ownerId: 'b', slot: 0, giveSlot: 99 }, rng);
  assert.equal(sneaky.ok, true);
});

test('a slapped-out hand still ends the game with free slaps', () => {
  const s = topSeven({ slapOthers: true, slapGive: false });
  s.players[1].hand = [c('7', 'C'), null, null, null];
  const { state } = engine.slap(s, 'a', { ownerId: 'b', slot: 0 }, rng);
  assert.equal(state.phase, 'final');
  assert.deepEqual(state.endedBy, { id: 'b', reason: 'empty' });
});

test('multiSlap: a second matching slap works after the first; standard locks the pile', () => {
  const mk = (rules) => {
    const s = topSeven(rules);
    s.players[0].hand[0] = c('7', 'S');
    s.players[1].hand[0] = c('7', 'C');
    return s;
  };
  const locked = engine.slap(mk({}), 'a', { ownerId: 'a', slot: 0 }, rng).state;
  assert.equal(locked.discardClaimed, true);
  const miss = engine.slap(locked, 'b', { ownerId: 'b', slot: 0 }, rng);
  assert.equal(miss.ok, false);
  assert.equal(miss.state.players[1].hand.length, 5, 'standard: a second slap is a miss');

  const open = engine.slap(mk({ multiSlap: true }), 'a', { ownerId: 'a', slot: 0 }, rng).state;
  assert.equal(open.discardClaimed, false);
  const again = engine.slap(open, 'b', { ownerId: 'b', slot: 0 }, rng);
  assert.equal(again.ok, true);
  assert.equal(again.state.discard.length, 3);
  assert.equal(engine.slap(again.state, 'c', { ownerId: 'c', slot: 3 }, rng).ok, false, 'a different rank still misses');
});

test('missPenalty sets how many cards a wrong slap costs, and stops when the deck is empty', () => {
  for (const n of [1, 2, 3]) {
    const s = topSeven({ missPenalty: n });
    const { state, ok } = engine.slap(s, 'a', { ownerId: 'a', slot: 0 }, rng);
    assert.equal(ok, false);
    assert.equal(state.players[0].hand.length, 4 + n);
    assert.equal(state.deck.length, 6 - n);
  }
  const dry = topSeven({ missPenalty: 3 });
  dry.deck = [c('9', 'H')];
  dry.discard = [c('7', 'D')];
  const { state } = engine.slap(dry, 'a', { ownerId: 'a', slot: 0 }, rng);
  assert.equal(state.players[0].hand.length, 5, 'only the one card there was');
  const total = (st) => st.deck.length + st.discard.length + st.players.reduce((k, p) => k + p.hand.filter(Boolean).length, 0);
  assert.equal(total(state), total(dry));
});

test('rules arrive through the room endpoint, validated, and the view shows them', async () => {
  const db = fakeDb();
  const make = async (rules) => {
    const r = await handleRoom(db, { action: 'create', name: 'Ann', rules }, { ...quiet, uuid: (() => { let i = 0; return () => `id${++i}${Math.random()}`; })() });
    assert.equal(r.status, 200);
    return db.rows.get(r.body.code).state.rules;
  };
  assert.deepEqual(await make(undefined), engine.DEFAULT_RULES);
  assert.deepEqual(await make({ jackAnyPlayers: true, missPenalty: 2, evil: 1 }), { ...engine.DEFAULT_RULES, jackAnyPlayers: true, missPenalty: 2 });
  assert.deepEqual(await make({ missPenalty: 'lots', slapGive: [] }), engine.DEFAULT_RULES);
});

test('through the endpoints a new room refuses slaps on other hands, and a room that asked for them allows it', async () => {
  const run = async (rules) => {
    const s = engine.createGame('a', 'a', rules);
    let st = engine.addPlayer(s, 'b', 'b');
    st = engine.startGame(st, 'a', rng);
    st.phase = 'turns';
    st.players[1].hand[0] = c('7', 'C');
    st.discard = [c('7', 'D')];
    const db = fakeDb();
    const tokens = { a: await hashToken('ta'), b: await hashToken('tb') };
    db.rows.set('ABCD', { code: 'ABCD', state: st, tokens, version: st.version });
    return handleAct(db, { code: 'ABCD', token: 'ta', action: 'slap', args: { ownerId: 'b', slot: 0, giveSlot: 0 } }, quiet);
  };
  const standard = await run(undefined);
  assert.equal(standard.status, 400);
  assert.match(standard.body.error, /only your own cards/);
  const house = await run({ slapOthers: true });
  assert.equal(house.status, 200);
  assert.equal(house.body.ok, true);
});

test('the Jack through the act endpoint honours firstId and the rule', async () => {
  const run = async (rules, jack) => {
    const s = withJack(game(rules));
    const db = fakeDb();
    const tokens = {};
    for (const id of ['a', 'b', 'c']) tokens[id] = await hashToken(`t${id}`);
    db.rows.set('ABCD', { code: 'ABCD', state: s, tokens, version: s.version });
    const r = await handleAct(db, { code: 'ABCD', token: 'ta', action: 'power', args: { type: 'J', J: jack } }, quiet);
    return { r, db };
  };
  const any = await run({ jackAnyPlayers: true }, { firstId: 'b', targetId: 'c', mine: 0, theirs: 0 });
  assert.equal(any.r.status, 200);
  assert.equal(any.db.rows.get('ABCD').state.players[1].hand[0].rank, '4');
  const std = await run({}, { firstId: 'b', targetId: 'c', mine: 0, theirs: 0 });
  assert.equal(std.r.status, 400);
});
