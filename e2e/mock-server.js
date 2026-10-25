// Dependency-free local stand-in for the Supabase backend: serves web/ and implements
// /functions/v1/room and /functions/v1/act in memory with the real engine.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomInt } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as engine from '../supabase/functions/_shared/engine.js';

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
const LIMITS = { staleMs: STALE_MS, byeGraceMs: BYE_GRACE_MS, idleMs: Number(process.env.MOCK_IDLE_MS) || engine.PRESENCE.idleMs };

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

function roomEndpoint(body) {
  switch (body.action) {
    case 'create': {
      const name = cleanName(body.name);
      const code = newCode();
      const playerId = randomUUID();
      const token = randomUUID();
      rooms.set(code, { state: engine.createGame(playerId, name), tokens: new Map([[token, playerId]]), seen: {} });
      return { code, playerId, token };
    }
    case 'join': {
      const room = roomOf(body.code);
      const name = cleanName(body.name);
      const playerId = randomUUID();
      const token = randomUUID();
      room.state = wrap(() => engine.addPlayer(room.state, playerId, name));
      room.tokens.set(token, playerId);
      return { playerId, token };
    }
    case 'start': {
      const room = roomOf(body.code);
      const id = auth(room, body.token);
      room.state = wrap(() => engine.stamp(room.state, engine.startGame(room.state, id, RNG), Date.now()));
      return { ok: true };
    }
    case 'kick': {
      const room = roomOf(body.code);
      const id = auth(room, body.token);
      if (id !== room.state.hostId) throw new HttpError(400, 'only the host can kick');
      if (room.state.phase !== 'lobby') throw new HttpError(403, 'players can only be removed in the lobby');
      if (body.targetId === id) throw new HttpError(400, 'cannot kick yourself');
      room.state = wrap(() => engine.removePlayer(room.state, body.targetId));
      for (const [t, pid] of room.tokens) if (pid === body.targetId && room.state.phase === 'lobby') room.tokens.delete(t);
      return { ok: true };
    }
    case 'view': {
      const room = roomOf(body.code);
      const id = auth(room, body.token);
      const t = Date.now();
      room.seen[id] = body.bye === true ? t - (STALE_MS - BYE_GRACE_MS) : t;
      for (const p of room.state.players) if (room.seen[p.id] === undefined) room.seen[p.id] = t;
      const absent = engine.absentPlayers(room.state, room.seen, id, t, LIMITS);
      if (body.bye !== true && absent.length) room.state = wrap(() => engine.stamp(room.state, engine.dropAbsent(room.state, absent), t));
      return { view: engine.viewFor(room.state, id) };
    }
    case 'leave': {
      const room = roomOf(body.code);
      const id = auth(room, body.token);
      room.state = wrap(() => engine.stamp(room.state, engine.dropAbsent(room.state, [id]), Date.now()));
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
  const s = room.state;
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
  room.state = engine.stamp(s, next, Date.now());
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
  room.state = s;
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
      send(res, 200, url.pathname.endsWith('/room') ? roomEndpoint(body) : actEndpoint(body));
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
