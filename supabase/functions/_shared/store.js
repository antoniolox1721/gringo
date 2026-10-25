// Storage helpers shared by the Edge Functions and the node tests.
// `db` is any object with get(code), insert(row), update(code, expectedVersion, patch), touch(code, missing, caller)
// and purge(olderThanIso);
// supabaseDb(client) adapts a supabase-js client to that interface.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function hashToken(token, cryptoImpl = globalThis.crypto) {
  const bytes = new TextEncoder().encode(String(token));
  const digest = await cryptoImpl.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function loadGame(db, code) {
  const row = await db.get(code);
  if (!row) throw new HttpError(404, 'room not found');
  return { state: row.state, tokens: row.tokens, version: row.version, seen: row.seen || {} };
}

// Compare-and-set on the version column. `tokens` is only written when given.
export async function saveIfVersion(db, code, expectedVersion, nextState, tokens) {
  const patch = { state: nextState, version: nextState.version, updated_at: new Date().toISOString() };
  if (tokens !== undefined) patch.tokens = tokens;
  return db.update(code, expectedVersion, patch);
}

// fn(state, tokens) returns a State, or { state, extra?, tokens? }. Errors thrown by fn propagate
// untouched; only version conflicts are retried.
export async function applyWithRetry(db, code, fn, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const { state, tokens, version } = await loadGame(db, code);
    const out = await fn(state, tokens);
    const next = out && out.state ? out.state : out;
    const nextTokens = out && out.state ? out.tokens : undefined;
    if (await saveIfVersion(db, code, version, next, nextTokens)) {
      return { state: next, extra: out && out.state ? out.extra : undefined, version: next.version };
    }
  }
  throw new HttpError(409, 'too many concurrent updates, try again');
}

export async function playerIdForToken(tokens, token) {
  if (typeof token !== 'string' || token === '') throw new HttpError(403, 'invalid token');
  const hash = await hashToken(token);
  const id = Object.keys(tokens).find((pid) => tokens[pid] === hash);
  if (!id) throw new HttpError(403, 'invalid token');
  return id;
}

// Best effort: a missed broadcast is recovered by the client's refetch on reconnect.
export async function broadcast(code, version, env = defaultEnv(), fetchImpl = globalThis.fetch) {
  if (!env.url || !env.key) return false;
  try {
    const res = await fetchImpl(`${env.url}/realtime/v1/api/broadcast`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
      headers: { 'content-type': 'application/json', apikey: env.key, authorization: `Bearer ${env.key}` },
      body: JSON.stringify({
        messages: [{ topic: `game:${code}`, event: 'changed', payload: { version }, private: false }],
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function defaultEnv() {
  const d = globalThis.Deno;
  if (!d) return {};
  return { url: d.env.get('SUPABASE_URL'), key: d.env.get('SUPABASE_SERVICE_ROLE_KEY') };
}

export function supabaseDb(client) {
  return {
    async get(code) {
      const { data, error } = await client
        .from('games')
        .select('state,tokens,version,seen')
        .eq('code', code)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    },
    async insert(row) {
      const { error } = await client.from('games').insert(row);
      if (!error) return true;
      if (error.code === '23505') return false;
      throw new Error(error.message);
    },
    // Presence only: no version bump, so heartbeats never wake the other clients. One atomic SQL
    // statement merges the caller's entry, so concurrent polls cannot overwrite each other.
    async touch(code, missing, caller) {
      const { error } = await client.rpc('touch_seen', { p_code: code, p_missing: missing, p_caller: caller });
      if (error) throw new Error(error.message);
    },
    async purge(olderThanIso) {
      const { error } = await client.from('games').delete().lt('updated_at', olderThanIso);
      if (error) throw new Error(error.message);
    },
    async update(code, expectedVersion, patch) {
      const { data, error } = await client
        .from('games')
        .update(patch)
        .eq('code', code)
        .eq('version', expectedVersion)
        .select('code');
      if (error) throw new Error(error.message);
      return data.length > 0;
    },
  };
}
