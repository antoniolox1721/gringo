// Deck convention: deck[0] is the top (next card drawn). Discard convention: last element is the top.
let nextUid = 1000;

export function c(rank, suit) {
  const s = rank === 'JOKER' ? null : (suit ?? 'S');
  return { rank, suit: s, uid: nextUid++ };
}

export function stackedGame({ players, hands, deck = [], discard, turn = 0 }) {
  return {
    version: 0,
    phase: 'turns',
    hostId: players[0],
    players: players.map((id, i) => ({
      id,
      name: id,
      hand: hands[i].slice(),
      seenSlots: [],
      viewable: [],
      gringo: false,
      connected: true,
    })),
    deck: deck.slice(),
    discard: (discard ?? [c('4', 'C')]).slice(),
    discardClaimed: false,
    turn,
    drawn: null,
    acted: false,
    pending: [],
    finalLeft: null,
    endedBy: null,
    result: null,
    rps: null,
  };
}

export function seededRng(seed = 1) {
  let n = seed;
  return () => (n = (n * 16807) % 2147483647) / 2147483647;
}

// In-memory db with the same get/insert/update(CAS) interface as supabaseDb. Every call yields so
// that concurrent requests interleave like they would against a real database.
export function fakeDb() {
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
    // Same merge as the touch_seen SQL function: defaults first, then what is stored, then the caller.
    async touch(code, missing, caller) {
      await tick();
      const row = rows.get(code);
      if (row) rows.set(code, { ...row, seen: { ...missing, ...(row.seen || {}), ...caller } });
    },
    async purge(olderThanIso) {
      await tick();
      for (const [code, row] of rows) if (row.updated_at && row.updated_at < olderThanIso) rows.delete(code);
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
