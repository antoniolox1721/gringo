// Dependency-free local stand-in for the Supabase backend: serves web/ and implements
// /functions/v1/room and /functions/v1/act in memory with the real engine.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomInt } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as engine from '../supabase/functions/_shared/engine.js';
import { RATE, checkRate, memoryCounters, settleRate } from '../supabase/functions/_shared/ratelimit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(here, '..', 'web');
const PORT = Number(process.env.PORT) || 8787;

// MOCK_SEED makes shuffles reproducible (tiny mulberry32); unset keeps the engine's CSPRNG.
function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const RNG = process.env.MOCK_SEED !== undefined && process.env.MOCK_SEED !== '' ? seededRng(Number(process.env.MOCK_SEED)) : undefined;
const TEST_MODE = process.env.MOCK_TEST === '1';
// Presence: MOCK_STALE_MS shortens the window after which a silent player counts as gone.
const STALE_MS = Number(process.env.MOCK_STALE_MS) || engine.PRESENCE.staleMs;
const BYE_GRACE_MS = Math.min(engine.PRESENCE.byeGraceMs, STALE_MS / 3);
const LIMITS = { staleMs: STALE_MS, byeGraceMs: BYE_GRACE_MS, idleMs: Number(process.env.MOCK_IDLE_MS) || engine.PRESENCE.idleMs, lonelyMs: Number(process.env.MOCK_LONELY_MS) || engine.PRESENCE.lonelyMs, endingMs: Number(process.env.MOCK_ENDING_MS) || engine.PRESENCE.endingMs };

// The same per-address limits as the Edge Functions (MOCK_RATE_* raise them for tests that poll a lot).
const LIMIT = { ...RATE, all: Number(process.env.MOCK_RATE_ALL) || RATE.all, create: Number(process.env.MOCK_RATE_CREATE) || RATE.create, join: Number(process.env.MOCK_RATE_JOIN) || RATE.join, misses: Number(process.env.MOCK_RATE_MISSES) || RATE.misses };
const counters = memoryCounters();
const limiterDb = { gate: (...a) => counters.gate(...a), release: (...a) => counters.release(...a) };
const starts = []; // games started (time, players), like the play_log table

// Records a game start: lobby or finished game -> setup.
function logStart(before, after) {
  if (before.phase !== 'setup' && after.phase === 'setup') starts.push({ at: Date.now(), players: after.players.length });
}

const rooms = new Map(); // code -> { state, tokens: Map(token -> playerId) }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += String.fromCharCode(65 + randomInt(26));
    if (!rooms.has(c)) return c;
  }
}

function roomOf(code) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) throw new HttpError(400, 'unknown room');
  return room;
}

function auth(room, token) {
  const id = room.tokens.get(token);
  if (!id) throw new HttpError(403, 'bad token');
  return id;
}

function cleanName(name) {
  const n = String(name ?? '').trim().slice(0, 16);
  if (!n) throw new HttpError(400, 'name required');
  return n;
}

function wrap(fn) {
  try { return fn(); } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, e.message);
  }
}

function dropTokens(room, before) {
  const gone = new Set(engine.vanishedSpectators(before, room.state));
  for (const [tok, pid] of room.tokens) if (gone.has(pid)) room.tokens.delete(tok);
}

function roomEndpoint(body) {
  switch (body.action) {
    case 'create': {
      const name = cleanName(body.name);
      const code = newCode();
      const playerId = randomUUID();
      const token = randomUUID();
      for (const [c, r] of rooms) if (engine.lonelyRoom(r.seen, r.createdAt, Date.now(), LIMITS.lonelyMs)) rooms.delete(c);
      rooms.set(code, { state: engine.createGame(playerId, name, body.rules), tokens: new Map([[token, playerId]]), seen: {}, createdAt: Date.now() });
      return { code, playerId, token };
    }
    case 'join': {
      const room = roomOf(body.code);
      const name = cleanName(body.name);
      const playerId = randomUUID();
      const token = randomUUID();
      room.state = wrap(() => engine.joinRoom(room.state, playerId, name));
      room.tokens.set(token, playerId);
      room.seen[playerId] = Date.now();
      return { playerId, token };
    }
    case 'start': {
      const room = roomOf(body.code);
      const id = auth(room, body.token);
      const before = room.state;
      room.state = wrap(() => engine.stamp(before, engine.startGame(before, id, RNG), Date.now()));
      logStart(before, room.state);
      return { ok: true };
    }
    case 'kick': {
      const room = roomOf(body.code);
      const id = auth(room, body.token);
      if (id !== room.state.hostId) throw new HttpError(400, 'only the host can kick');
      const watcher = (room.state.spectators || []).some((x) => x.id === body.targetId);
      if (room.state.phase !== 'lobby' && !watcher) throw new HttpError(403, 'players can only be removed in the lobby');
      if (body.targetId === id) throw new HttpError(400, 'cannot kick yourself');
      room.state = wrap(() => engine.removePlayer(room.state, body.targetId));
      for (const [t, pid] of room.tokens) if (pid === body.targetId && (room.state.phase === 'lobby' || watcher)) room.tokens.delete(t);
      return { ok: true };
    }
    case 'view': {
      const room = roomOf(body.code);
      const id = auth(room, body.token);
      const t = Date.now();
      room.seen[id] = body.bye === true ? t - (STALE_MS - BYE_GRACE_MS) : t;
      const lonely = engine.lonelyRoom(room.seen, room.createdAt, t, LIMITS.lonelyMs);
      for (const p of [...room.state.players, ...(room.state.spectators || [])]) if (room.seen[p.id] === undefined) room.seen[p.id] = t;
      if (body.bye !== true && lonely) {
        rooms.delete(String(body.code).toUpperCase());
        throw new HttpError(404, 'room not found');
      }
      if (engine.endingOver(room.state, t, LIMITS)) room.state = engine.stamp(room.state, engine.settle(room.state, t, LIMITS), t);
      const absent = engine.absentPlayers(room.state, room.seen, id, t, LIMITS);
      if (body.bye !== true && absent.length) {
        const before = room.state;
        room.state = wrap(() => engine.stamp(before, engine.dropAbsent(before, absent), t));
        dropTokens(room, before);
        logStart(before, room.state);
      }
      return { view: engine.viewFor(room.state, id) };
    }
    case 'sit': {
      const room = roomOf(body.code);
      const id = auth(room, body.token);
      const before = room.state;
      room.state = wrap(() => engine.stamp(before, engine.sit(before, id, body.want !== false), Date.now()));
      logStart(before, room.state);
      return { ok: true };
    }
    case 'leave': {
      const room = roomOf(body.code);
      const id = auth(room, body.token);
      const before = room.state;
      room.state = wrap(() => engine.stamp(before, engine.dropAbsent(before, [id]), Date.now()));
      dropTokens(room, before);
      logStart(before, room.state);
      return { ok: true };
    }
    default:
      throw new HttpError(400, 'unknown action');
  }
}

function actEndpoint(body) {
  const room = roomOf(body.code);
  const id = auth(room, body.token);
  const a = body.args || {};
  const s0 = room.state;
  const s = engine.settle(s0, Date.now(), LIMITS);
  let next;
  let extra = {};
  wrap(() => {
    switch (body.action) {
      case 'peekSetup': { const r = engine.peekSetup(s, id, a.slots); next = r.state; extra = { seen: r.seen }; break; }
      case 'draw': next = engine.draw(s, id, RNG).state; break;
      case 'keep': next = engine.keep(s, id, a.slot); break;
      case 'discard': next = engine.discardDrawn(s, id); break;
      case 'power': {
        const type = a.type;
        if (!['J', 'Q', 'K'].includes(type)) throw new Error('invalid power type');
        const r = engine.usePower(s, id, { type, ...(a[type] || {}) });
        next = r.state;
        if (r.seen !== undefined) extra = { seen: r.seen };
        break;
      }
      case 'kingLook': { const r = engine.kingLook(s, id, a.slot); next = r.state; extra = { seen: r.seen }; break; }
      case 'confirmKing': next = engine.confirmKing(s, id, a.swap === true); break;
      case 'skipPower': next = engine.skipPower(s, id); break;
      case 'slap': { const r = engine.slap(s, id, a, RNG); next = r.state; extra = { ok: r.ok }; break; }
      case 'gringo': next = engine.callGringo(s, id); break;
      case 'rps': next = engine.submitRps(s, id, a.pick); break;
      case 'rematch': next = engine.voteRematch(s, id, RNG); break;
      default: throw new Error('unknown action');
    }
  });
  room.state = engine.stamp(s0, next, Date.now());
  logStart(s0, room.state);
  return { view: engine.viewFor(room.state, id), ...extra };
}

// Test-only (MOCK_TEST=1): overwrite hands/discard/deck with named cards, e.g. '9S', '10H', 'JOKER'.
function stackEndpoint(body) {
  const room = roomOf(body.code);
  let uid = 1000;
  const card = (name) => {
    const str = String(name);
    if (str === 'JOKER') return { rank: 'JOKER', suit: null, uid: uid++ };
    return { rank: str.slice(0, -1), suit: str.slice(-1), uid: uid++ };
  };
  const s = structuredClone(room.state);
  if (body.hands) for (const [i, cards] of Object.entries(body.hands)) s.players[Number(i)].hand = cards.map(card);
  if (body.discard) s.discard = body.discard.map(card);
  if (body.deck) s.deck = body.deck.map(card);
  s.version += 1;
  // finish: end the game normally (scores the hands), so the reveal can be looked at with any hands.
  room.state = body.finish ? engine.finishGame(s) : s;
  return { ok: true };
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e6) throw new HttpError(400, 'body too large');
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'invalid JSON'); }
}

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS });
  res.end(JSON.stringify(obj));
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    if (url.pathname === '/functions/v1/room' || url.pathname === '/functions/v1/act') {
      if (req.method !== 'POST') throw new HttpError(400, 'POST only');
      const body = await readJson(req);
      const isRoom = url.pathname.endsWith('/room');
      // Tests can pretend to be another address (MOCK_TEST only).
      const ip = (TEST_MODE && req.headers['x-test-ip']) || req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const kind = isRoom && (body.action === 'create' || body.action === 'join') ? body.action : '';
      const blocked = await checkRate(limiterDb, ip, kind, now, LIMIT);
      if (blocked) { send(res, blocked.status, blocked.body); return; }
      try {
        send(res, 200, isRoom ? roomEndpoint(body) : actEndpoint(body));
        await settleRate(limiterDb, ip, now, 200, LIMIT);
      } catch (e) {
        await settleRate(limiterDb, ip, now, e.status === 403 || e.message === 'unknown room' ? 403 : e.status || 500, LIMIT);
        throw e;
      }
      return;
    }
    if (TEST_MODE && url.pathname === '/__test/starts' && req.method === 'GET') {
      send(res, 200, { starts });
      return;
    }
    if (TEST_MODE && url.pathname === '/__test/stack' && req.method === 'POST') {
      send(res, 200, stackEndpoint(await readJson(req)));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(400, 'bad method');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(WEB, '.' + rel);
    if (file !== WEB && !file.startsWith(WEB + path.sep)) throw new HttpError(403, 'forbidden');
    let data;
    try { data = await readFile(file); } catch { res.writeHead(404, CORS); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', ...CORS });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`mock server on http://localhost:${PORT}`));
