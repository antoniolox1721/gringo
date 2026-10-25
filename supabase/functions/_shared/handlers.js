import * as engine from './engine.js';
import { HttpError, applyWithRetry, broadcast, hashToken, loadGame, playerIdForToken } from './store.js';

const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function randomCode(rng = engine.secureRandom) {
  let code = '';
  for (let i = 0; i < 4; i++) code += LETTERS[Math.floor(rng() * 26)];
  return code;
}

function cleanName(name) {
  const n = typeof name === 'string' ? name.trim().slice(0, 20) : '';
  if (!n) throw new HttpError(400, 'name required');
  return n;
}

function cleanCode(code) {
  if (typeof code !== 'string' || !/^[A-Za-z]{4}$/.test(code)) throw new HttpError(404, 'room not found');
  return code.toUpperCase();
}

// Errors thrown by the engine inside fn are rule violations: 400. HttpErrors keep their status.
async function guarded(work) {
  try {
    return await work();
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
    if (e instanceof Error && e.isEngine) return { status: 400, body: { error: e.message } };
    throw e;
  }
}

async function runEngine(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Error && !(e instanceof HttpError)) e.isEngine = true;
    throw e;
  }
}

const ok = (body) => ({ status: 200, body });

export async function handleRoom(db, body, deps = {}) {
  const { notify = broadcast, uuid = () => crypto.randomUUID(), rng = engine.secureRandom, now = Date.now, limits = engine.PRESENCE } = deps;
  return guarded(async () => {
    const action = body && body.action;
    if (action === 'create') {
      const name = cleanName(body.name);
      const playerId = uuid();
      const token = uuid();
      const tokens = { [playerId]: await hashToken(token) };
      const state = engine.createGame(playerId, name);
      // Housekeeping: rooms nobody has touched for a day are dead. Best effort.
      if (db.purge) await db.purge(new Date(now() - ROOM_TTL_MS).toISOString()).catch(() => {});
      for (let i = 0; i < 20; i++) {
        const code = randomCode(rng);
        if (await db.insert({ code, state, tokens, version: state.version })) {
          return ok({ code, playerId, token });
        }
      }
      throw new HttpError(503, 'could not allocate a room code');
    }

    const code = cleanCode(body && body.code);

    if (action === 'join') {
      const name = cleanName(body.name);
      const playerId = uuid();
      const token = uuid();
      const tokenHash = await hashToken(token);
      const res = await applyWithRetry(db, code, (state, tokens) =>
        runEngine(() => ({
          state: engine.addPlayer(state, playerId, name),
          tokens: { ...tokens, [playerId]: tokenHash },
        })),
      );
      await notify(code, res.version);
      return ok({ playerId, token });
    }

    if (action === 'view') {
      const { state, tokens, seen } = await loadGame(db, code);
      const id = await playerIdForToken(tokens, body.token);
      const t = now();
      // Every poll is a heartbeat. A closing tab says bye and keeps only a short grace period.
      const bye = body.bye === true;
      const mine = bye ? t - (limits.staleMs - limits.byeGraceMs) : t;
      const missing = {};
      for (const p of state.players) if (seen[p.id] === undefined) missing[p.id] = t;
      // Polls closer than 2 s apart skip the write, so a spammed loop cannot hammer the database.
      const fresh = seen[id] !== undefined && t - seen[id] < 2000;
      if (db.touch && (bye || !fresh || Object.keys(missing).length > 0)) await db.touch(code, missing, { [id]: mine });
      const next = { ...missing, ...seen, [id]: mine };
      if (bye || engine.absentPlayers(state, next, id, t, limits).length === 0) {
        return ok({ view: engine.viewFor(state, id) });
      }
      const res = await applyWithRetry(db, code, (st) =>
        runEngine(() => engine.dropAbsent(st, engine.absentPlayers(st, next, id, t, limits))),
      );
      await notify(code, res.version);
      return ok({ view: engine.viewFor(res.state, id) });
    }

    if (action === 'leave') {
      const res = await applyWithRetry(db, code, async (state, tokens) => {
        const id = await playerIdForToken(tokens, body.token);
        return runEngine(() => engine.dropAbsent(state, [id]));
      });
      await notify(code, res.version);
      return ok({ ok: true });
    }

    if (action === 'start' || action === 'kick') {
      const res = await applyWithRetry(db, code, async (state, tokens) => {
        const id = await playerIdForToken(tokens, body.token);
        return runEngine(() => {
          if (action === 'start') return engine.stamp(state, engine.startGame(state, id), now());
          if (id !== state.hostId) throw new HttpError(403, 'only the host can kick');
          // Checked on the same state that is updated, so a start cannot slip in between.
          if (state.phase !== 'lobby') throw new HttpError(403, 'players can only be removed in the lobby');
          const targetId = body.targetId;
          const next = engine.removePlayer(state, targetId);
          const { [targetId]: _gone, ...rest } = tokens;
          return { state: next, tokens: rest };
        });
      });
      await notify(code, res.version);
      return ok({ ok: true });
    }

    throw new HttpError(400, 'unknown action');
  });
}

export async function handleAct(db, body, deps = {}) {
  const { notify = broadcast, now = Date.now } = deps;
  return guarded(async () => {
    const code = cleanCode(body && body.code);
    const { action } = body;
    const args = body.args && typeof body.args === 'object' ? body.args : {};
    let playerId;
    const res = await applyWithRetry(db, code, async (state, tokens) => {
      playerId = await playerIdForToken(tokens, body.token);
      return runEngine(() => {
        const out = applyAction(state, playerId, action, args);
        return { ...out, state: engine.stamp(state, out.state, now()) };
      });
    });
    await notify(code, res.version);
    return ok({ view: engine.viewFor(res.state, playerId), ...res.extra });
  });
}

function applyAction(state, id, action, args) {
  switch (action) {
    case 'peekSetup': {
      const { state: next, seen } = engine.peekSetup(state, id, args.slots);
      return { state: next, extra: { seen } };
    }
    case 'draw': {
      try {
        return { state: engine.draw(state, id).state };
      } catch (e) {
        if (e.message !== 'no cards') throw e;
        // Deck and discard are both empty: end the game for this turn player instead of deadlocking.
        return { state: state.phase === 'final' ? engine.finishGame(state) : engine.callGringo(state, id) };
      }
    }
    case 'keep':
      return { state: engine.keep(state, id, args.slot) };
    case 'discard':
      return { state: engine.discardDrawn(state, id) };
    case 'power': {
      // The web client nests the target under the power letter: { type: 'Q', Q: { targetId, slot } }.
      const nested = args[args.type] && typeof args[args.type] === 'object' ? args[args.type] : {};
      const { state: next, seen } = engine.usePower(state, id, { ...args, ...nested, type: args.type });
      return seen === undefined ? { state: next } : { state: next, extra: { seen } };
    }
    case 'kingLook': {
      const { state: next, seen } = engine.kingLook(state, id, args.slot);
      return { state: next, extra: { seen } };
    }
    case 'confirmKing':
      return { state: engine.confirmKing(state, id, args.swap === true) };
    case 'skipPower':
      return { state: engine.skipPower(state, id) };
    case 'slap': {
      const { state: next, ok: slapOk } = engine.slap(state, id, args);
      return { state: next, extra: { ok: slapOk } };
    }
    case 'gringo':
      return { state: engine.callGringo(state, id) };
    case 'rps':
      return { state: engine.submitRps(state, id, args.pick) };
    case 'rematch':
      return { state: engine.voteRematch(state, id) };
    default:
      throw new HttpError(400, 'unknown action');
  }
}
