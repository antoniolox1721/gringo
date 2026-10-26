// Request limits per client address. The same rules run on Supabase (counters in Postgres, see
// migration 0007), in the local mock server and in tests (in-memory counters below).

export const RATE = {
  windowMs: 60_000,
  all: 600, // any request; a 4-player room polls about 50 times a minute
  create: 10, // new rooms
  join: 30, // joins (also what a flood of spectators looks like)
  misses: 20, // requests for a room or token that does not exist, which is what guessing codes looks like
};

// Requests with no trusted client address share one bucket with limits ten times higher: still a cap
// on floods, but loose enough that a missing header cannot take the game down for everyone.
export const UNKNOWN_IP = 'unknown';
export const RATE_UNKNOWN = {
  ...RATE,
  all: RATE.all * 10,
  create: RATE.create * 10,
  join: RATE.join * 10,
  misses: RATE.misses * 10,
};
export const limitsFor = (ip, base = RATE) => (ip === UNKNOWN_IP ? RATE_UNKNOWN : base);

// Every request reserves one "miss" before it runs and gives it back if it succeeded, so requests
// that arrive at the same moment cannot all pass a check that only counted afterwards.

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
      const miss = bump(`miss:${ip}`, now, windowMs, 1);
      return { all, kind: k, miss };
    },
    release(ip, now, windowMs) {
      // Only inside the window the reservation was made in.
      const h = hits.get(`miss:${ip}`);
      if (h && h.start <= now && h.start + windowMs > now) h.n = Math.max(0, h.n - 1);
    },
  };
}

// null when the request may go on, otherwise the 429 to send back.
export async function checkRate(db, ip, kind, now, limits = RATE) {
  if (!ip || !db || !db.gate) return null;
  try {
    const g = await db.gate(ip, kind, now, limits.windowMs);
    if (g.all > limits.all || (kind && g.kind > limits[kind]) || g.miss > limits.misses) {
      return { status: 429, body: { error: 'too many requests, slow down' } };
    }
  } catch {
    // A broken limiter must never take the game down.
  }
  return null;
}

// After the request ran: unless it named a room or token that is not there (404, 403), the reserved miss goes back.
export async function settleRate(db, ip, now, status, limits = RATE) {
  if (!ip || !db || !db.release || status === 404 || status === 403 || status === 429) return;
  try {
    await db.release(ip, now, limits.windowMs);
  } catch {
    // see above
  }
}
