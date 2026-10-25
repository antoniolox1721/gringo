// Gringo rules engine. Pure, dependency-free ES module (runs in Node and Deno).
// Conventions: deck[0] is the top of the deck; the last element of discard is the top of the pile.

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

export function buildDeck() {
  const cards = [];
  let uid = 1;
  for (const suit of SUITS) {
    for (const rank of RANKS) cards.push({ rank, suit, uid: uid++ });
  }
  cards.push({ rank: 'JOKER', suit: null, uid: uid++ });
  cards.push({ rank: 'JOKER', suit: null, uid: uid++ });
  return cards;
}

// Uniform [0, 1) from the platform CSPRNG: 21 + 32 = 53 random bits, so every double is reachable.
export function secureRandom() {
  const w = new Uint32Array(2);
  globalThis.crypto.getRandomValues(w);
  return ((w[0] >>> 11) * 4294967296 + w[1]) / 9007199254740992;
}

export function shuffle(cards, rng = secureRandom) {
  const out = cards.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function cardValue(card) {
  switch (card.rank) {
    case 'A': return 1;
    case 'J':
    case 'Q': return 10;
    case 'K': return card.suit === 'H' || card.suit === 'D' ? -3 : 10;
    case 'JOKER': return 0;
    default: return Number(card.rank);
  }
}

export function handTotal(hand) {
  let total = 0;
  for (const card of hand) if (card) total += cardValue(card);
  return total;
}

// ---------------------------------------------------------------------------
// Internal helpers. `s` is always a private draft clone, never caller state.
// ---------------------------------------------------------------------------

const MAX_PLAYERS = 4;
const HAND_SIZE = 4;

function clone(state) {
  return structuredClone(state);
}

// Runs `fn` on a clone of `state` and returns the clone with version+1.
function produce(state, fn) {
  const s = clone(state);
  fn(s);
  s.version = state.version + 1;
  return s;
}

function playerOf(s, id) {
  const p = s.players.find((x) => x.id === id);
  if (!p) throw new Error('unknown player');
  return p;
}

// Looks up the acting player; kicked/offline players may not act.
function requireActive(s, id) {
  const p = playerOf(s, id);
  if (p.connected === false) throw new Error('player is not in the game');
  return p;
}

function connectedPlayers(s) {
  return s.players.filter((p) => p.connected);
}

// `viewable` only ever holds a King reveal awaiting confirmKing/skipPower. Setup and Queen peeks are
// returned once as `seen` and never persisted, so a refetch cannot show them again.
function clearView(p) {
  p.viewable = [];
}

function clearAllViews(s) {
  for (const p of s.players) clearView(p);
}

// Public per-slot change counter: everyone at a real table sees which slot a card went into.
function touch(p, slot) {
  if (!p.moves) p.moves = p.hand.map(() => 0);
  p.moves[slot] = (p.moves[slot] || 0) + 1;
}

// Drops every "viewable" reference to a slot whose content just changed.
// Penalty cards add slots beyond the original four. Once the last of them is empty it goes away
// again; gaps inside the original four stay, because where a card used to be is part of the game.
// `moves` is kept as is, so a slot that comes back later continues its change counter.
function trimExtraSlots(p) {
  while (p.hand.length > HAND_SIZE && p.hand[p.hand.length - 1] === null) p.hand.pop();
}

function invalidateSlot(s, ownerId, slot) {
  for (const p of s.players) {
    p.viewable = p.viewable.filter((v) => !(v.ownerId === ownerId && v.slot === slot));
  }
}

function checkSetupDone(s) {
  if (s.phase !== 'setup') return;
  const live = connectedPlayers(s);
  if (live.length > 0 && live.every((p) => p.seenSlots.length === 2)) {
    s.phase = 'turns';
    // After a rematch the previous winner starts; otherwise the first player in the room.
    const starter = s.players.findIndex((p) => p.connected && p.id === s.starter);
    s.turn = starter >= 0 ? starter : s.players.findIndex((p) => p.connected);
  }
}

// ---------------------------------------------------------------------------
// Room lifecycle and setup
// ---------------------------------------------------------------------------

function newPlayer(id, name) {
  return { id, name, hand: [], seenSlots: [], viewable: [], gringo: false, connected: true };
}

export function createGame(hostId, hostName) {
  return {
    version: 0,
    phase: 'lobby',
    hostId,
    players: [newPlayer(hostId, hostName)],
    deck: [],
    discard: [],
    discardClaimed: false,
    turn: 0,
    drawn: null,
    acted: false,
    pending: [],
    finalLeft: null,
    endedBy: null,
    abandonedBy: null,
    result: null,
    rps: null,
    rematch: [],
    starter: null,
  };
}

export function addPlayer(state, id, name) {
  if (state.phase !== 'lobby') throw new Error('already started');
  if (state.players.length >= MAX_PLAYERS) throw new Error('room full');
  if (state.players.some((p) => p.id === id)) throw new Error('already joined');
  return produce(state, (s) => {
    s.players.push(newPlayer(id, name));
  });
}

export function startGame(state, byId, rng = secureRandom) {
  if (state.phase !== 'lobby') throw new Error('already started');
  if (byId !== state.hostId) throw new Error('only the host can start');
  if (state.players.length < 2) throw new Error('need at least 2 players');
  return produce(state, (s) => deal(s, rng));
}

function deal(s, rng) {
  const deck = shuffle(buildDeck(), rng);
  for (const p of s.players) {
    p.hand = deck.splice(0, HAND_SIZE);
    p.moves = p.hand.map(() => 0);
    p.seenSlots = [];
    p.viewable = [];
    p.gringo = false;
  }
  s.discard = [];
  s.deck = deck;
  s.discardClaimed = false;
  s.turn = 0;
  s.drawn = null;
  s.acted = false;
  s.pending = [];
  s.finalLeft = null;
  s.endedBy = null;
  s.abandonedBy = null;
  s.result = null;
  s.rps = null;
  s.rematch = [];
  s.phase = 'setup';
}

// Once every player still here has asked for another game, the room restarts: the last winner
// moves first, and anyone who walked away is dropped. Does nothing while a vote is still open.
function maybeRematch(s, rng) {
  if (s.phase !== 'done') return;
  const live = connectedPlayers(s);
  if (live.length < 2 || !live.every((p) => (s.rematch || []).includes(p.id))) return;
  const winner = s.result && s.result.winners.find((id) => live.some((p) => p.id === id));
  s.players = live;
  if (!live.some((p) => p.id === s.hostId)) s.hostId = live[0].id;
  deal(s, rng);
  s.starter = winner || null;
}

export function voteRematch(state, id, rng = secureRandom) {
  requireActive(state, id);
  if (state.phase !== 'done') throw new Error('the game is not over');
  if ((state.rematch || []).includes(id)) return state;
  return produce(state, (s) => {
    s.rematch = [...(s.rematch || []), id];
    maybeRematch(s, rng);
  });
}

export function peekSetup(state, id, slots) {
  requireActive(state, id);
  if (state.phase !== 'setup') throw new Error('not in setup');
  const me = playerOf(state, id);
  if (me.seenSlots.length > 0) throw new Error('already peeked');
  if (!Array.isArray(slots) || slots.length !== 2) throw new Error('peek exactly 2 slots');
  if (slots[0] === slots[1]) throw new Error('slots must be distinct');
  for (const slot of slots) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= HAND_SIZE) throw new Error('invalid slot');
  }
  const seen = slots.map((slot) => structuredClone(me.hand[slot]));
  const next = produce(state, (s) => {
    const p = playerOf(s, id);
    p.seenSlots = slots.slice();
    checkSetupDone(s);
  });
  return { state: next, seen };
}

export function removePlayer(state, id) {
  playerOf(state, id);
  if (state.phase === 'lobby') {
    return produce(state, (s) => {
      s.players = s.players.filter((p) => p.id !== id);
      if (s.hostId === id && s.players.length > 0) s.hostId = s.players[0].id;
    });
  }
  return produce(state, (s) => {
    playerOf(s, id).connected = false;
    handleDisconnect(s, id);
  });
}

// How long a player may go without polling before the others treat them as gone, and how much of
// that a closing tab leaves them (so a page reload survives but a closed tab ends the game fast).
export const PRESENCE = { staleMs: 30000, byeGraceMs: 8000, idleMs: 4 * 60 * 1000, lonelyMs: 5 * 60 * 1000 };

// A room nobody shares is cleared: older than `lonelyMs` and fewer than two players have polled
// within that time. `seen` maps player ids to their last heartbeat (epoch ms).
export function lonelyRoom(seen, createdAtMs, nowMs, lonelyMs = PRESENCE.lonelyMs) {
  if (nowMs - createdAtMs <= lonelyMs) return false;
  return Object.values(seen || {}).filter((t) => nowMs - t <= lonelyMs).length < 2;
}

// Who the game is waiting on right now: the players whose move is missing.
export function blockers(state) {
  if (state.phase === 'setup') return state.players.filter((p) => p.connected && p.seenSlots.length === 0).map((p) => p.id);
  if (state.phase === 'turns' || state.phase === 'final') {
    if (state.pending[0]) return [state.pending[0].by];
    const cur = state.players[state.turn];
    return cur ? [cur.id] : [];
  }
  if (state.phase === 'rps') return state.rps.players.filter((pid) => !state.rps.picks[pid]);
  return [];
}

// Changes only when the awaited player makes progress. Slaps and penalties do not count, so they
// cannot be used to keep an idle player's clock from running out.
export function progressKey(s) {
  const pend = s.pending[0];
  return JSON.stringify([
    s.phase, s.turn, s.drawn !== null, s.pending.length,
    pend ? [pend.type, !!pend.target, !!pend.own] : null,
    s.players.filter((p) => p.seenSlots.length > 0).length,
    s.finalLeft ? s.finalLeft.length : null,
    s.rps ? [s.rps.round, Object.keys(s.rps.picks).length] : null,
  ]);
}

// Records when the game last moved on (kept on the state, outside the rules).
export function stamp(prev, next, now) {
  if (typeof next.lastMoveAt !== 'number' || progressKey(prev) !== progressKey(next)) return { ...next, lastMoveAt: now };
  return next;
}

// Players the others should stop waiting for: silent too long, or holding up the game too long.
export function absentPlayers(state, seen, callerId, now, limits = PRESENCE) {
  const gone = new Set(
    state.players
      .filter((p) => p.connected && p.id !== callerId && now - (seen[p.id] ?? now) > limits.staleMs)
      .map((p) => p.id),
  );
  if (typeof state.lastMoveAt === 'number' && now - state.lastMoveAt > limits.idleMs) {
    for (const id of blockers(state)) gone.add(id);
  }
  return [...gone];
}

// Ends the game for everyone because `ids` walked away: a lobby just loses them, a game in progress
// is scored at once among the players still here. Never leaves a game that cannot finish.
export function dropAbsent(state, ids) {
  const gone = ids.filter((id) => state.players.some((p) => p.id === id && p.connected));
  if (gone.length === 0) return state;
  // A finished game just loses them (their absence may complete the rematch vote).
  if (state.phase === 'done') {
    return produce(state, (s) => {
      for (const id of gone) playerOf(s, id).connected = false;
      maybeRematch(s, secureRandom);
    });
  }
  if (state.phase === 'lobby') return gone.reduce((st, id) => removePlayer(st, id), state);
  return produce(state, (s) => {
    for (const id of gone) playerOf(s, id).connected = false;
    s.abandonedBy = gone;
    finishDraft(s);
    if (s.phase === 'rps') {
      s.phase = 'done';
      s.rps = null;
    }
  });
}

// ---------------------------------------------------------------------------
// Redacted view
// ---------------------------------------------------------------------------

export function viewFor(state, playerId) {
  const done = state.phase === 'done';
  const me = state.players.find((p) => p.id === playerId);
  const sees = (ownerId, slot) =>
    !!me && me.viewable.some((v) => v.ownerId === ownerId && v.slot === slot);
  const turnPlayer = state.players[state.turn];
  const isTurnPlayer = !!turnPlayer && turnPlayer.id === playerId;
  return {
    version: state.version,
    phase: state.phase,
    hostId: state.hostId,
    you: playerId,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      gringo: p.gringo,
      ready: p.seenSlots.length > 0,
      hand: p.hand.map((card, slot) => {
        const entry = { slot, empty: card === null, ver: (p.moves && p.moves[slot]) || 0 };
        if (card && (done || sees(p.id, slot))) entry.card = structuredClone(card);
        return entry;
      }),
    })),
    viewable: me ? me.viewable.map((v) => ({ ...v })) : [],
    deckCount: state.deck.length,
    discardCount: state.discard.length,
    discardTop: state.discard.length ? structuredClone(state.discard[state.discard.length - 1]) : null,
    discardClaimed: state.discardClaimed,
    turn: state.turn,
    turnId: turnPlayer ? turnPlayer.id : null,
    hasDrawn: state.drawn !== null,
    drawn: isTurnPlayer && state.drawn ? structuredClone(state.drawn) : null,
    pending: state.pending.map((x) => ({ type: x.type, by: x.by, revealed: !!x.target, lookedOwn: !!x.own })),
    finalLeft: state.finalLeft ? state.finalLeft.slice() : null,
    endedBy: state.endedBy ? { ...state.endedBy } : null,
    abandonedBy: state.abandonedBy ? state.abandonedBy.slice() : null,
    result: state.result ? structuredClone(state.result) : null,
    rematch: (state.rematch || []).slice(),
    rps: state.rps ? rpsView(state.rps, playerId) : null,
  };
}

function rpsView(rps, playerId) {
  const picks = {};
  for (const [pid, pick] of Object.entries(rps.picks)) picks[pid] = pid === playerId ? pick : 'hidden';
  return { players: rps.players.slice(), picks, round: rps.round, last: rps.last ? { ...rps.last } : null };
}

// ---------------------------------------------------------------------------
// Turn: draw, keep or discard, reshuffle
// ---------------------------------------------------------------------------

const POWER_RANKS = ['J', 'Q', 'K'];

function requireTurn(s, id) {
  if (s.phase !== 'turns' && s.phase !== 'final') throw new Error('game is not in play');
  const current = s.players[s.turn];
  if (!current || current.id !== id) throw new Error('not your turn');
  return current;
}

// When the deck is empty, the pile minus its top card becomes the new deck.
function refill(s, rng) {
  if (s.deck.length === 0 && s.discard.length > 1) {
    const top = s.discard[s.discard.length - 1];
    s.deck = shuffle(s.discard.slice(0, -1), rng);
    s.discard = [top];
  }
}

function takeCard(s, rng) {
  refill(s, rng);
  return s.deck.length > 0 ? s.deck.shift() : null;
}

// Puts a card on the pile and queues its power. Does not advance the turn.
function discardCard(s, card, byId) {
  s.discard.push(card);
  s.discardClaimed = false;
  if (POWER_RANKS.includes(card.rank)) s.pending.push({ type: card.rank, by: byId });
}

// Advances the turn once the current turn's action is done and no power is pending.
function maybeAdvance(s) {
  if (s.acted && s.pending.length === 0) {
    s.acted = false;
    advanceTurn(s);
  }
}

function advanceTurn(s) {
  const n = s.players.length;
  if (s.finalLeft) {
    const current = s.players[s.turn].id;
    s.finalLeft = s.finalLeft.filter((pid) => pid !== current && playerOf(s, pid).connected);
    if (s.finalLeft.length === 0) {
      finishDraft(s);
      return;
    }
    for (let step = 1; step <= n; step++) {
      const idx = (s.turn + step) % n;
      if (s.finalLeft.includes(s.players[idx].id)) {
        s.turn = idx;
        return;
      }
    }
    return;
  }
  for (let step = 1; step <= n; step++) {
    const idx = (s.turn + step) % n;
    if (s.players[idx].connected) {
      s.turn = idx;
      return;
    }
  }
}

export function draw(state, id, rng = secureRandom) {
  requireActive(state, id);
  requireTurn(state, id);
  if (state.pending.length > 0) throw new Error('resolve pending powers first');
  if (state.drawn !== null) throw new Error('already drawn');
  let card = null;
  const next = produce(state, (s) => {
    card = takeCard(s, rng);
    if (!card) throw new Error('no cards');
    s.drawn = card;
    clearView(playerOf(s, id));
  });
  return { state: next, card: structuredClone(card) };
}

export function keep(state, id, slot) {
  requireActive(state, id);
  requireTurn(state, id);
  if (state.drawn === null) throw new Error('draw first');
  const me = playerOf(state, id);
  if (!Number.isInteger(slot) || slot < 0 || slot >= me.hand.length) throw new Error('invalid slot');
  if (me.hand[slot] === null) throw new Error('slot is empty');
  return produce(state, (s) => {
    const p = playerOf(s, id);
    const old = p.hand[slot];
    p.hand[slot] = s.drawn;
    touch(p, slot);
    s.drawn = null;
    clearView(p);
    invalidateSlot(s, id, slot);
    discardCard(s, old, id);
    s.acted = true;
    maybeAdvance(s);
  });
}

export function discardDrawn(state, id) {
  requireActive(state, id);
  requireTurn(state, id);
  if (state.drawn === null) throw new Error('draw first');
  return produce(state, (s) => {
    const card = s.drawn;
    s.drawn = null;
    clearView(playerOf(s, id));
    discardCard(s, card, id);
    s.acted = true;
    maybeAdvance(s);
  });
}

// Public form of the discard hook. `fromTurn` marks a discard made as part of a turn action.
export function onDiscard(state, card, byId, { fromTurn = false } = {}) {
  return produce(state, (s) => {
    discardCard(s, structuredClone(card), byId);
    if (fromTurn) s.acted = true;
    maybeAdvance(s);
  });
}

export function nextTurn(state) {
  return produce(state, (s) => {
    s.acted = false;
    advanceTurn(s);
  });
}

// Applies the consequences of a player going offline. Mutates draft `s`.
function handleDisconnect(s, id) {
  checkSetupDone(s);
  if (s.phase === 'rps') {
    dropFromRps(s, id);
    return;
  }
  if (s.phase !== 'turns' && s.phase !== 'final') return;
  s.pending = s.pending.filter((x) => x.by !== id);
  clearView(playerOf(s, id));
  if (s.players[s.turn].id === id) {
    if (s.drawn) {
      s.discard.push(s.drawn);
      s.discardClaimed = false;
      s.drawn = null;
    }
    s.acted = false;
    advanceTurn(s);
    return;
  }
  if (s.finalLeft) {
    s.finalLeft = s.finalLeft.filter((pid) => pid !== id);
    if (s.finalLeft.length === 0) {
      finishDraft(s);
      return;
    }
  }
  maybeAdvance(s);
}

// ---------------------------------------------------------------------------
// Powers (J / Q / K) and slaps
// ---------------------------------------------------------------------------

function checkSlot(p, slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= p.hand.length) throw new Error('invalid slot');
  if (p.hand[slot] === null) throw new Error('slot is empty');
}

function requirePending(s, id) {
  const pend = s.pending[0];
  if (!pend) throw new Error('no pending power');
  if (pend.by !== id) throw new Error('not your power to use');
  return pend;
}

function finishPower(s) {
  s.pending.shift();
  maybeAdvance(s);
}

function swapCards(s, a, aSlot, b, bSlot) {
  [a.hand[aSlot], b.hand[bSlot]] = [b.hand[bSlot], a.hand[aSlot]];
  touch(a, aSlot);
  touch(b, bSlot);
  invalidateSlot(s, a.id, aSlot);
  invalidateSlot(s, b.id, bSlot);
}

export function usePower(state, id, args) {
  requireActive(state, id);
  const pend = requirePending(state, id);
  if (!args || args.type !== pend.type) throw new Error(`pending ${pend.type} power`);
  if (pend.target) throw new Error('confirm the king first');
  playerOf(state, args.targetId);
  let seen;
  const next = produce(state, (s) => {
    const p = playerOf(s, id);
    const t = playerOf(s, args.targetId);
    clearView(p);
    if (pend.type === 'J') {
      if (t.id === id) throw new Error('choose another player');
      if (t.gringo || p.gringo) throw new Error('cannot swap with a player who called gringo');
      checkSlot(p, args.mine);
      checkSlot(t, args.theirs);
      swapCards(s, p, args.mine, t, args.theirs);
      finishPower(s);
    } else if (pend.type === 'Q') {
      checkSlot(t, args.slot);
      seen = structuredClone(t.hand[args.slot]);
      finishPower(s);
    } else {
      if (t.id === id) throw new Error('choose another player');
      checkSlot(t, args.slot);
      p.viewable.push({ ownerId: t.id, slot: args.slot });
      seen = structuredClone(t.hand[args.slot]);
      s.pending[0].target = { ownerId: t.id, slot: args.slot };
    }
  });
  return seen === undefined ? { state: next } : { state: next, seen };
}

// King, step 2: look at one of your own cards. The reveal lasts until confirmKing or skipPower.
export function kingLook(state, id, slot) {
  requireActive(state, id);
  const pend = requirePending(state, id);
  if (pend.type !== 'K' || !pend.target) throw new Error('look at an opponent card first');
  if (pend.own) throw new Error('you already looked at one of your cards');
  let seen;
  const next = produce(state, (s) => {
    const p = playerOf(s, id);
    checkSlot(p, slot);
    p.viewable.push({ ownerId: id, slot });
    seen = structuredClone(p.hand[slot]);
    s.pending[0].own = { slot };
  });
  return { state: next, seen };
}

// King, step 3: swap the two cards just seen, or leave both where they are.
export function confirmKing(state, id, swap) {
  requireActive(state, id);
  const pend = requirePending(state, id);
  if (pend.type !== 'K' || !pend.target) throw new Error('no king reveal to confirm');
  if (!pend.own) throw new Error('look at one of your own cards first');
  return produce(state, (s) => {
    const p = playerOf(s, id);
    if (swap === true) {
      const t = playerOf(s, pend.target.ownerId);
      if (t.gringo || p.gringo) throw new Error('cannot swap with a player who called gringo');
      checkSlot(p, pend.own.slot);
      checkSlot(t, pend.target.slot);
      swapCards(s, p, pend.own.slot, t, pend.target.slot);
    }
    clearView(p);
    finishPower(s);
  });
}

export function skipPower(state, id) {
  requireActive(state, id);
  requirePending(state, id);
  return produce(state, (s) => {
    clearView(playerOf(s, id));
    finishPower(s);
  });
}

export function slap(state, id, args, rng = secureRandom) {
  requireActive(state, id);
  if (state.phase !== 'turns' && state.phase !== 'final') throw new Error('game is not in play');
  const me = playerOf(state, id);
  const owner = playerOf(state, args.ownerId);
  if (!Number.isInteger(args.slot) || args.slot < 0 || args.slot >= owner.hand.length) throw new Error('invalid slot');
  const card = owner.hand[args.slot];
  const top = state.discard.length ? state.discard[state.discard.length - 1] : null;
  const ok = !!card && !!top && !state.discardClaimed && card.rank === top.rank;
  const other = owner.id !== id;
  const mustGive = ok && other && me.hand.some((x) => x !== null);
  if (mustGive) {
    const g = args.giveSlot;
    if (!Number.isInteger(g) || g < 0 || g >= me.hand.length || me.hand[g] === null) {
      throw new Error('giveSlot required: pick one of your own cards');
    }
  }
  const next = produce(state, (s) => {
    const p = playerOf(s, id);
    const o = playerOf(s, args.ownerId);
    clearView(p);
    if (ok) {
      const taken = o.hand[args.slot];
      o.hand[args.slot] = null;
      touch(o, args.slot);
      invalidateSlot(s, o.id, args.slot);
      if (mustGive) {
        o.hand[args.slot] = p.hand[args.giveSlot];
        p.hand[args.giveSlot] = null;
        touch(p, args.giveSlot);
        invalidateSlot(s, p.id, args.giveSlot);
      }
      trimExtraSlots(o);
      trimExtraSlots(p);
      discardCard(s, taken, id);
      s.discardClaimed = true;
      checkZeroDraft(s, p.id);
      if (other) checkZeroDraft(s, o.id);
    } else {
      const penalty = takeCard(s, rng);
      if (penalty) {
        p.hand.push(penalty);
        touch(p, p.hand.length - 1);
      }
    }
  });
  return { state: next, ok };
}

// ---------------------------------------------------------------------------
// Endings, scoring, rock-paper-scissors
// ---------------------------------------------------------------------------

const BEATS = { r: 's', p: 'r', s: 'p' };

// If `id` has no cards left and nobody has ended the game yet, starts the final round.
function checkZeroDraft(s, id) {
  const p = playerOf(s, id);
  if (s.endedBy || s.phase !== 'turns' || p.hand.some((x) => x !== null)) return;
  s.endedBy = { id, reason: 'empty' };
  s.phase = 'final';
  s.finalLeft = connectedPlayers(s).filter((x) => x.id !== id).map((x) => x.id);
  if (s.finalLeft.length === 0) {
    finishDraft(s);
    return;
  }
  if (s.players[s.turn].id === id && s.drawn === null) {
    s.acted = true;
    maybeAdvance(s);
  }
}

export function checkZero(state, id) {
  playerOf(state, id);
  return produce(state, (s) => checkZeroDraft(s, id));
}

export function callGringo(state, id) {
  requireActive(state, id);
  requireTurn(state, id);
  if (state.phase !== 'turns' || state.endedBy) throw new Error('the final round has started');
  if (state.drawn !== null || state.acted) throw new Error('gringo is only allowed before drawing');
  if (state.pending.length > 0) throw new Error('resolve pending powers first');
  return produce(state, (s) => {
    const p = playerOf(s, id);
    clearView(p);
    p.gringo = true;
    s.endedBy = { id, reason: 'gringo' };
    s.phase = 'final';
    s.finalLeft = connectedPlayers(s).filter((x) => x.id !== id).map((x) => x.id);
    advanceTurn(s);
  });
}

function finishDraft(s) {
  const totals = {};
  for (const p of s.players) totals[p.id] = handTotal(p.hand);
  const live = connectedPlayers(s);
  const eligible = live.length > 0 ? live : s.players;
  const best = Math.min(...eligible.map((p) => totals[p.id]));
  const tiedOnPoints = eligible.filter((p) => totals[p.id] === best);
  // Same points: whoever holds fewer cards wins. Still level: rock, paper, scissors.
  const count = (p) => p.hand.filter((x) => x).length;
  const fewest = Math.min(...tiedOnPoints.map(count));
  const winners = tiedOnPoints.filter((p) => count(p) === fewest).map((p) => p.id);
  s.result = { totals, winners };
  if (tiedOnPoints.length > 1 && winners.length === 1) s.result.decidedBy = 'cards';
  clearAllViews(s);
  s.drawn = null;
  s.pending = [];
  s.acted = false;
  if (winners.length > 1) {
    s.phase = 'rps';
    s.rps = { players: winners.slice(), picks: {}, round: 0, last: null };
  } else {
    s.phase = 'done';
    s.rps = null;
  }
}

export function finishGame(state) {
  return produce(state, finishDraft);
}

// Resolves the current rps round when every remaining player has picked.
function resolveRps(s) {
  const r = s.rps;
  if (r.players.length === 0 || !r.players.every((pid) => r.picks[pid])) return;
  const kinds = [...new Set(r.players.map((pid) => r.picks[pid]))];
  let remaining = r.players.slice();
  if (kinds.length === 2) {
    const win = BEATS[kinds[0]] === kinds[1] ? kinds[0] : kinds[1];
    remaining = remaining.filter((pid) => r.picks[pid] === win);
  }
  r.last = { ...r.picks };
  r.picks = {};
  r.round += 1;
  r.players = remaining;
  if (remaining.length === 1) {
    s.result.winners = remaining.slice();
    s.phase = 'done';
  }
}

function dropFromRps(s, id) {
  const r = s.rps;
  r.players = r.players.filter((pid) => pid !== id);
  delete r.picks[id];
  if (r.players.length === 1) {
    s.result.winners = r.players.slice();
    s.phase = 'done';
  } else if (r.players.length === 0) {
    s.phase = 'done';
  } else {
    resolveRps(s);
  }
}

export function submitRps(state, id, pick) {
  requireActive(state, id);
  if (state.phase !== 'rps') throw new Error('no rps tiebreak in progress');
  if (!Object.hasOwn(BEATS, pick)) throw new Error('pick must be r, p or s');
  if (!state.rps.players.includes(id)) throw new Error('you are not in the tiebreak');
  if (state.rps.picks[id]) throw new Error('already picked this round');
  return produce(state, (s) => {
    s.rps.picks[id] = pick;
    resolveRps(s);
  });
}
