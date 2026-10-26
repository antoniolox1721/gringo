// Request limits per client address. The same rules run on Supabase (counters in Postgres, see
// migration 0007), in the local mock server and in tests (in-memory counters below).

export const RATE = {
  windowMs: 60_000,
  all: 600, // any request; a 4-player room polls about 50 times a minute
  create: 10, // new rooms
  join: 30, // joins (also what a flood of spectators looks like)
  misses: 20, // requests for a room or token that does not exist, which is what guessing codes looks like
};

// Fixed windows, same arithmetic as the SQL functions.
export function memoryCounters() {
  const hits = new Map();
  const bump = (key, now, windowMs, inc) => {
    const h = hits.get(key);
    if (!h || h.start + windowMs <= now) {
      hits.set(key, { start: now, n: inc });
      return inc;
    }
    h.n += inc;
    return h.n;
  };
  return {
    hits,
    gate(ip, kind, now, windowMs) {
      const all = bump(`all:${ip}`, now, windowMs, 1);
      const k = kind ? bump(`${kind}:${ip}`, now, windowMs, 1) : 0;
      const miss = bump(`miss:${ip}`, now, windowMs, 0);
      return { all, kind: k, miss };
    },
    miss(ip, now, windowMs) {
      bump(`miss:${ip}`, now, windowMs, 1);
    },
  };
}

// null when the request may go on, otherwise the 429 to send back.
export async function checkRate(db, ip, kind, now, limits = RATE) {
  if (!ip || !db || !db.gate) return null;
  try {
    const g = await db.gate(ip, kind, now, limits.windowMs);
    if (g.all > limits.all || (kind && g.kind > limits[kind]) || g.miss >= limits.misses) {
      return { status: 429, body: { error: 'too many requests, slow down' } };
    }
  } catch {
    // A broken limiter must never take the game down.
  }
  return null;
}

// Counts a request that named a room or token that is not there.
export async function noteMiss(db, ip, now, status, limits = RATE) {
  if (!ip || !db || !db.miss || (status !== 404 && status !== 403)) return;
  try {
    await db.miss(ip, now, limits.windowMs);
  } catch {
    // see above
  }
}
