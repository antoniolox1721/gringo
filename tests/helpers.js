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
