import { call, subscribe, pollMs } from './api.js';
import { morph } from './morph.js';
import * as motion from './motion.js';
import { blip, buzz, soundOn, toggleSound } from './sound.js';

const KEYS = { code: 'gringo.code', playerId: 'gringo.playerId', token: 'gringo.token' };
const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_NAME = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };
const RANK_NAME = { A: 'Ace', J: 'Jack', Q: 'Queen', K: 'King' };
const REVEAL_MS = 3000;

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');
const $callout = document.getElementById('callout');

let session = loadSession();
let view = null;
let unsub = null;
let pollTimer = null;
let fetching = false;
let busy = false;
let homeError = '';
let toastTimer = null;
let local = freshLocal();
let failures = 0;
let lastHtml = '';

// Short-lived client state layered over the server view.
const reveals = new Map(); // fx key -> { card, kind: 'peek' | 'K', until, ver }
const ghosts = new Set(); // fx keys hidden while a flying card is on its way there
let pileHold = null; // what the pile showed before a card started flying onto it

function freshLocal() {
  return { armed: false, giving: null, peekSel: [], jMine: null, jOwner: null, kickArm: null, leaveArm: false, confirmGringo: false };
}

// ---- storage (always guarded) ---------------------------------------------
function loadSession() {
  try {
    const code = localStorage.getItem(KEYS.code);
    const playerId = localStorage.getItem(KEYS.playerId);
    const token = localStorage.getItem(KEYS.token);
    return code && playerId && token ? { code, playerId, token } : null;
  } catch { return null; }
}
function saveSession(s) {
  try {
    localStorage.setItem(KEYS.code, s.code);
    localStorage.setItem(KEYS.playerId, s.playerId);
    localStorage.setItem(KEYS.token, s.token);
  } catch { /* storage unavailable: session lives in memory only */ }
}
function clearSession() {
  try { for (const k of Object.values(KEYS)) localStorage.removeItem(k); } catch { /* ignore */ }
}

// ---- helpers ---------------------------------------------------------------
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cardId = (c) => (c ? String(c.uid ?? `${c.rank}${c.suit}`) : '');

function cardLabel(card) {
  if (card.rank === 'JOKER') return 'Joker';
  return `${card.rank}${SUIT[card.suit] || ''}`;
}
function cardSpoken(card) {
  if (card.rank === 'JOKER') return 'Joker, worth 0';
  const low = card.rank === 'K' && (card.suit === 'H' || card.suit === 'D');
  return `${RANK_NAME[card.rank] || card.rank} of ${SUIT_NAME[card.suit]}${low ? ', worth minus 3' : ''}`;
}
// Rank and suit in the corner, a big pip in the middle. Red kings carry a -3 tag, the joker a 0.
function cardHtml(card, { cls = '', fx = '', stamp = false } = {}) {
  const joker = card.rank === 'JOKER';
  const red = card.suit === 'H' || card.suit === 'D';
  const low = card.rank === 'K' && red;
  const glyph = joker ? '★' : SUIT[card.suit];
  const tag = low ? '<u class="val">−3</u>' : joker ? '<u class="val">0</u>' : '';
  return `<span class="card face${red ? ' red' : ''}${low ? ' king-low' : ''}${cls ? ` ${cls}` : ''}"${fx ? ` data-fx="${esc(fx)}"` : ''} role="img" aria-label="${esc(cardSpoken(card))}">` +
    `<b class="r">${joker ? 'Jk' : esc(card.rank)}</b>${joker ? '' : `<i class="s">${glyph}</i>`}<i class="pip${joker ? ' joker' : ''}">${glyph}</i>${tag}` +
    `${stamp ? '<span class="stamp" id="claimed">Claimed</span>' : ''}</span>`;
}
const backHtml = (cls = '', fx = '') => `<span class="card back${cls ? ` ${cls}` : ''}"${fx ? ` data-fx="${esc(fx)}"` : ''}></span>`;

const me = () => view && view.players.find((p) => p.id === view.you);
// Whose seat anchors the table. Spectators see it from the first seat's side, with nobody marked as them.
const anchor = () => me() || (view && view.spectator ? view.players[0] : null);
const nameOf = (id) => {
  const p = view && view.players.find((x) => x.id === id);
  return p ? p.name : 'someone';
};
const whoName = (id) => (view && id === view.you ? 'You' : nameOf(id));
const possessive = (id) => (view && id === view.you ? 'your' : `${nameOf(id)}'s`);
const seatIndex = (id) => Math.max(0, view.players.findIndex((p) => p.id === id));
const inPlay = () => view && (view.phase === 'turns' || view.phase === 'final');
const atTable = () => view && ['setup', 'turns', 'final', 'ending'].includes(view.phase);
// Slaps are allowed all through the last round and for a moment after the last turn.
const playing = () => view && ['turns', 'final', 'ending'].includes(view.phase);
const isOver = () => view && (view.phase === 'done' || view.phase === 'rps');
const ENDING_MS = 3500; // keep in step with PRESENCE.endingMs on the server
const live = (p) => p.hand.filter((s) => !s.empty).length;

function toast(msg, kind = '') {
  $toast.textContent = msg;
  $toast.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.className = kind; }, kind === 'err' ? 4500 : 3200);
}

// Engine and network errors, rewritten as what happened and what to do next.
const FRIENDLY = [
  [/not your turn/i, 'It is not your turn yet.'],
  [/draw first/i, 'Draw a card first.'],
  [/already drawn/i, 'You already drew. Tap one of your cards to swap, or discard.'],
  [/resolve pending/i, 'Use or skip the power first.'],
  [/gringo is only allowed/i, 'Gringo has to be called before you draw.'],
  [/final round has started/i, 'The final round has already started.'],
  [/giveSlot required/i, 'Pick one of your cards to give.'],
  [/who called gringo/i, 'Cards of a player who called Gringo are locked.'],
  [/slot is empty/i, 'That spot is empty. Pick a card.'],
  [/choose another player/i, "Pick another player's card."],
  [/cannot reach the server/i, 'Cannot reach the server. Check your connection and try again.'],
  [/room not found|unknown room/i, 'No room has that code. Check it and try again.'],
  [/room full/i, 'That room is full. Games take up to 4 players.'],
  [/already started/i, 'That game has already started. Ask for a new room code.'],
  [/name required/i, 'Enter your name first.'],
  [/need at least 2/i, 'You need at least 2 players to start.'],
  [/no cards/i, 'There are no cards left to draw.'],
  [/too many spectators/i, 'Too many people are already watching that room.'],
];
function friendly(e) {
  const msg = (e && e.message) || 'Something went wrong.';
  for (const [re, text] of FRIENDLY) if (re.test(msg)) return text;
  const s = msg.charAt(0).toUpperCase() + msg.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

// ---- networking ------------------------------------------------------------
async function refresh() {
  if (!session || fetching) return;
  fetching = true;
  try {
    const { view: v } = await call('room', { action: 'view', code: session.code, token: session.token });
    if (failures) { failures = 0; lastHtml = ''; }
    applyView(v);
    checkBuild().then(reloadIfStale);
  } catch (e) {
    if (e.status === 403) leave('The host removed you from that room, or it has ended.');
    else if (e.status === 404 || (e.status === 400 && /room/i.test(e.message))) leave('That room no longer exists.');
    else { failures += 1; render(); }
  } finally { fetching = false; }
}

// A new deploy changes version.json. Reloading is safe (the session is kept), so open pages pick the
// new client up by themselves, as soon as nothing is half-done on this screen.
const BUILD = (window.GRINGO_CONFIG || {}).BUILD;
let lastBuildCheck = 0;
async function checkBuild() {
  if (!BUILD || Date.now() - lastBuildCheck < 20000) return;
  lastBuildCheck = Date.now();
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    const { build } = await res.json();
    // Once per target build: if a cached file still reports the old id after a reload, do not loop.
    if (build && build !== BUILD && sessionStorage.getItem('gringo.reloadedFor') !== build) pendingReload = build;
  } catch { /* offline or no version file: keep playing */ }
}
let pendingReload = null;
function reloadIfStale() {
  if (!pendingReload || busy) return;
  const idle = !local.armed && !local.giving && local.peekSel.length === 0 && local.jMine === null;
  if (!idle) return;
  try { sessionStorage.setItem('gringo.reloadedFor', pendingReload); } catch { /* private mode */ }
  location.reload();
}

// During the slap window every client asks again once it is over, so the game is scored on time
// even when nobody else polls (the server settles it on the first poll that finds it over).
let endTimer = null;
let endTries = 0;
function watchEnding(v) {
  if (v.phase !== 'ending') { clearTimeout(endTimer); endTimer = null; endTries = 0; return; }
  if (endTimer) return;
  endTimer = setTimeout(() => { endTimer = null; refresh(); }, endTries++ === 0 ? ENDING_MS + 250 : 700);
}

function applyView(v) {
  if (!v) return;
  if (view && v.version < view.version) return; // stale response
  // Neither seated nor watching: the host removed them, or they timed out as a spectator.
  if (!v.spectator && !v.players.some((p) => p.id === v.you)) { leave('You are no longer in that room.'); return; }
  watchEnding(v);
  const prev = view;
  if (prev && v.version === prev.version) { view = v; render(); return; }
  view = v;
  if (!prev) { render(); return; }

  dropStaleReveals(prev, v);
  const plan = motion.reduced() ? [] : planFlights(prev, v);
  motion.finishAll();
  const from = plan.map((f) => (f.fromAfter ? null : rectOf(f.from)));
  const flipBefore = motion.measure($app, '[data-flip]');
  for (const f of plan) ghosts.add(f.to);
  if (plan.some((f) => f.to === 'pile') && prev.discardTop) {
    pileHold = { card: prev.discardTop, claimed: prev.discardClaimed };
  } else if (plan.some((f) => f.to === 'pile')) {
    pileHold = { card: null, claimed: false };
  }
  if (v.phase === 'done' || v.phase === 'rps') local = { ...local, armed: false, giving: null, confirmGringo: false };
  // A new top card changes what matches: drop an armed slap rather than risk a penalty on a stale target.
  if ((local.armed || local.giving) && cardId(v.discardTop) !== cardId(prev.discardTop)) local = { ...local, armed: false, giving: null };
  render();
  motion.flipFrom($app, '[data-flip]', flipBefore);
  launch(plan, from);
  announce(prev, v);
  reshuffleFx(prev, v);
}

// When the deck runs out the pile (all but its top card) is shuffled into a new deck. The views
// show it as the deck growing while the pile shrinks, which never happens in any other turn.
function reshuffleFx(p, v) {
  const inPlay = (ph) => ph === 'turns' || ph === 'final';
  if (!inPlay(p.phase) || !inPlay(v.phase) || v.deckCount <= p.deckCount || v.discardCount >= p.discardCount) return;
  toast('The deck ran out. The pile is shuffled back in.');
  blip('shuffle');
  if (motion.reduced()) return;
  const from = rectOf('pile');
  const to = rectOf('deck');
  if (!from || !to) return;
  const n = Math.min(9, p.discardCount - 1);
  for (let i = 0; i < n; i++) {
    motion.fly({ from, to, face: null, back: BACK, delay: i * 55, arc: i % 2 ? 1.6 : -1.6 });
  }
  setTimeout(() => motion.riffle($app.querySelector('.pile.deck')), 250 + n * 55);
}

// ---- motion: derive what happened by diffing two views ----------------------
function rectOf(key) {
  const el = $app.querySelector(`[data-fx="${CSS.escape(key)}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width) return null;
  const host = el.closest('[data-rot]');
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: el.offsetWidth, rot: host ? Number(host.dataset.rot) : 0 };
}

const BACK = backHtml();

function planFlights(p, v) {
  const out = [];
  if (p.phase === 'lobby' && v.phase === 'setup') {
    const n = v.players.length;
    v.players.forEach((pl, i) => pl.hand.forEach((e, slot) => {
      out.push({ from: 'deck', fromAfter: true, to: `slot:${pl.id}:${slot}`, delay: (slot * n + i) * 55, sound: 'flip' });
    }));
    return out;
  }
  if (!['turns', 'final', 'ending'].includes(v.phase) || !['turns', 'final', 'ending', 'setup'].includes(p.phase)) return out;

  const changed = [];
  const emptied = [];
  const added = [];
  for (const np of v.players) {
    const op = p.players.find((x) => x.id === np.id);
    if (!op) continue;
    np.hand.forEach((e, slot) => {
      const o = op.hand[slot];
      if (!o) added.push({ pid: np.id, slot });
      else if (e.empty && !o.empty) emptied.push({ pid: np.id, slot });
      else if (!e.empty && e.ver !== o.ver) changed.push({ pid: np.id, slot });
    });
    // An extra slot that emptied and was removed in the same step still counts as emptied.
    op.hand.forEach((o, slot) => { if (slot >= np.hand.length && !o.empty) emptied.push({ pid: np.id, slot }); });
  }
  const topMoved = !!v.discardTop && cardId(v.discardTop) !== cardId(p.discardTop);
  const top = v.discardTop;
  const heldBy = p.hasDrawn ? p.turnId : null;
  const resolved = heldBy && !(v.hasDrawn && v.turnId === heldBy);
  const heldFace = heldBy === v.you && p.drawn ? cardHtml(p.drawn) : null;

  if (resolved) {
    const k = changed.findIndex((c) => c.pid === heldBy);
    if (k >= 0) {
      const { slot } = changed.splice(k, 1)[0];
      const to = `slot:${heldBy}:${slot}`;
      out.push({ from: `held:${heldBy}`, to, face: heldFace, flip: heldFace ? 'down' : null, sound: 'land' });
      if (top) out.push({ from: to, to: 'pile', face: cardHtml(top), flip: 'up', delay: 70 });
    } else if (topMoved) {
      out.push({ from: `held:${heldBy}`, to: 'pile', face: cardHtml(top), flip: heldFace ? null : 'up', sound: 'land' });
    }
  } else if (topMoved && emptied.length) {
    // A slap: the matched card goes to the pile; on an opponent's card the slapper's card fills the gap.
    if (changed.length === 1 && emptied.length === 1 && changed[0].pid !== emptied[0].pid) {
      const owner = changed.shift();
      const giver = emptied.shift();
      const ownerKey = `slot:${owner.pid}:${owner.slot}`;
      out.push({ from: ownerKey, to: 'pile', face: cardHtml(top), flip: 'up', impact: true });
      out.push({ from: `slot:${giver.pid}:${giver.slot}`, to: ownerKey, delay: 160, sound: 'land' });
    } else {
      const e = emptied.shift();
      out.push({ from: `slot:${e.pid}:${e.slot}`, to: 'pile', face: cardHtml(top), flip: 'up', impact: true });
    }
  } else if (topMoved && p.turnId) {
    // The draw happened between two fetches: replay it as deck -> (their slot ->) pile.
    const k = changed.findIndex((c) => c.pid === p.turnId);
    if (k >= 0) {
      const to = `slot:${p.turnId}:${changed.splice(k, 1)[0].slot}`;
      out.push({ from: 'deck', to, sound: 'land' }, { from: to, to: 'pile', face: cardHtml(top), flip: 'up', delay: 90 });
    } else {
      out.push({ from: 'deck', to: 'pile', face: cardHtml(top), flip: 'up', sound: 'land' });
    }
  }
  if (v.hasDrawn && !(p.hasDrawn && p.turnId === v.turnId)) {
    const mine = v.turnId === v.you && v.drawn;
    out.push({ from: 'deck', to: `held:${v.turnId}`, face: mine ? cardHtml(v.drawn) : null, flip: mine ? 'up' : null, sound: 'draw' });
  }
  for (const a of added) out.push({ from: 'deck', to: `slot:${a.pid}:${a.slot}`, penalty: a.pid, sound: 'miss' });
  if (!topMoved && !resolved && changed.length === 2 && changed[0].pid !== changed[1].pid) {
    const [a, b] = changed;
    const ka = `slot:${a.pid}:${a.slot}`;
    const kb = `slot:${b.pid}:${b.slot}`;
    out.push({ from: ka, to: kb, sound: 'land' }, { from: kb, to: ka, delay: 40, arc: -1 });
  }
  // A discarded J/Q/K that just started its power gets the impact treatment when it lands.
  const np = v.pending[0];
  const pp = p.pending[0];
  if (np && top && np.type === top.rank && !(pp && pp.type === np.type && pp.by === np.by)) {
    const onPile = out.filter((f) => f.to === 'pile' && !f.impact).pop();
    if (onPile) onPile.power = np.type;
  }
  return out;
}

function launch(plan, fromRects) {
  let skipped = false;
  plan.forEach((f, i) => {
    const from = f.fromAfter ? rectOf(f.from) : fromRects[i];
    const to = rectOf(f.to);
    if (!from || !to) { land(f, true); skipped = true; return; }
    motion.fly({
      from, to, face: f.face || null, back: BACK, flip: f.flip || null, delay: f.delay || 0, arc: f.arc || 1,
      onLand: (silent) => land(f, silent),
    });
  });
  if (skipped) render();
}

function land(f, silent) {
  ghosts.delete(f.to);
  if (f.to === 'pile' && ![...ghosts].includes('pile')) pileHold = null;
  if (silent) return;
  render();
  if (f.sound) blip(f.sound);
  if (f.impact) {
    blip('slap');
    motion.impact($app.querySelector('#discard .card'));
  }
  if (f.power) powerBurst(f.power);
  if (f.penalty) motion.shake($app.querySelector(`.seat[data-player="${CSS.escape(f.penalty)}"] .hand`));
}

// Impact frame for a power card hitting the pile: flash, shockwave rings, rays and a stamped name.
const POWER_FX = { J: ['Jack', 'Blind swap'], Q: ['Queen', 'Look at any card'], K: ['King', 'Look at two, then swap'] };
function powerBurst(rank) {
  const card = $app.querySelector('#discard .card');
  if (!card) return;
  blip('power');
  buzz([25, 35, 25]);
  motion.impact(card);
  motion.shake($app.querySelector('.table'));
  if (motion.reduced()) return;
  const r = card.getBoundingClientRect();
  const [name, sub] = POWER_FX[rank];
  const fx = document.createElement('div');
  fx.className = `power-fx p-${rank}`;
  fx.setAttribute('aria-hidden', 'true');
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  fx.style.cssText = `left:${cx}px;top:${cy}px;--w:${r.width}px;--cx:${cx}px;--cy:${cy}px`;
  fx.innerHTML = `<i class="flash"></i><i class="ring"></i><i class="ring r2"></i><i class="rays"></i><b>${name}</b><small>${sub}</small>`;
  document.body.appendChild(fx);
  setTimeout(() => fx.remove(), 1500);
}

// Toasts, callouts, rings and haptics for the change from p to v.
const POWER_TEXT = { J: 'a Jack: blind swap', Q: 'a Queen: look at any card', K: 'a King: look at two cards, then swap or not' };
function announce(p, v) {
  const parts = [];
  if (isOver() && !['done', 'rps'].includes(p.phase) && reveal) {
    // Cards tick over one by one; the verdict sound waits for the last total.
    for (let i = 0; i < reveal.count; i++) setTimeout(() => blip('flip'), reveal.base + i * reveal.step + 120);
    if (v.phase === 'done') setTimeout(() => blip(v.result && v.result.winners.includes(v.you) ? 'win' : 'lose'), reveal.endAt);
  } else if (v.phase === 'done' && p.phase === 'rps' && reveal) {
    setTimeout(() => blip(v.result && v.result.winners.includes(v.you) ? 'win' : 'lose'), 300);
  }
  if (atTable() || v.phase === 'done' || v.phase === 'rps') {
    for (const np of v.players) {
      const op = p.players.find((x) => x.id === np.id);
      if (!op) continue;
      if (np.gringo && !op.gringo) callout(`${whoName(np.id)} called Gringo`, 'Final round. Everyone else plays one more turn.');
      if (np.hand.length > op.hand.length && playing()) {
        if (np.id === v.you) buzz([30, 40, 30]);
        else parts.push(`${np.name} missed a slap and takes a penalty card.`);
      }
      if (op.connected && !np.connected) parts.push(`${np.name} left the game.`);
    }
    if (v.endedBy && !p.endedBy && v.endedBy.reason === 'empty') {
      callout(`${whoName(v.endedBy.id)} ${v.endedBy.id === v.you ? 'have' : 'has'} no cards left`, 'Final round. Everyone else plays one more turn.');
    }
  }
  if (playing()) {
    const topMoved = v.discardTop && cardId(v.discardTop) !== cardId(p.discardTop);
    if (topMoved && v.discardClaimed && !p.discardClaimed) {
      const slapper = v.players.find((np) => {
        const op = p.players.find((x) => x.id === np.id);
        return op && live(np) < live(op);
      });
      if (!slapper || slapper.id !== v.you) parts.push(`${slapper ? slapper.name : 'Someone'} slapped ${cardLabel(v.discardTop)}.`);
    }
    const np = v.pending[0];
    if (np && np.by !== v.you && !(p.pending[0] && p.pending[0].type === np.type && p.pending[0].by === np.by)) {
      parts.push(`${nameOf(np.by)} played ${POWER_TEXT[np.type] || 'a power'}.`);
    }
    if (v.turnId !== p.turnId || (p.phase === 'setup' && v.phase === 'turns')) {
      const ring = $app.querySelector(`.seat[data-player="${CSS.escape(v.turnId || '')}"] .ring`);
      motion.pulse(ring);
      if (v.turnId === v.you && v.phase !== 'ending') { buzz(15); blip('turn'); }
    }
  }
  if (parts.length && !busy) toast(parts.slice(0, 2).join(' '));
}

let calloutTimer = null;
function callout(title, sub) {
  $callout.innerHTML = `<div class="callout-card"><b>${esc(title)}</b><span>${esc(sub)}</span></div>`;
  $callout.className = 'show';
  blip('call');
  buzz([20, 30, 20]);
  clearTimeout(calloutTimer);
  calloutTimer = setTimeout(() => { $callout.className = ''; }, 2200);
}

// ---- reveals (setup peek, Queen, King) --------------------------------------
// They come from the action response only. Peeks show for REVEAL_MS with a countdown ring, then turn face down.
function showReveals(items, kind) {
  const keys = items.map((x) => x.key);
  flipSwap(keys, () => {
    const until = Date.now() + REVEAL_MS;
    for (const it of items) reveals.set(it.key, { card: it.card, kind, until, ver: it.ver });
  });
  if (kind === 'peek') setTimeout(() => hideReveals(keys), REVEAL_MS);
}

function hideReveals(keys) {
  const still = keys.filter((k) => reveals.has(k));
  if (!still.length) return;
  flipSwap(still, () => { for (const k of still) reveals.delete(k); });
}

// Turns the cards at `keys` away, applies `mutate`, re-renders, and turns the new faces in.
function flipSwap(keys, mutate) {
  const els = keys.map((k) => $app.querySelector(`[data-fx="${CSS.escape(k)}"]`)).filter(Boolean);
  const away = els.map((el) => motion.turnAway(el)).filter(Boolean);
  Promise.all(away.map((a) => a.finished.catch(() => {}))).then(() => {
    mutate();
    render();
    for (const a of away) a.cancel();
    blip('flip');
    for (const k of keys) motion.turnIn($app.querySelector(`[data-fx="${CSS.escape(k)}"]`));
  });
}

function slotVer(v, key) {
  const [, pid, slot] = key.split(':');
  const p = v.players.find((x) => x.id === pid);
  const e = p && p.hand[Number(slot)];
  return e ? `${e.ver}:${e.empty}` : 'gone';
}

function dropStaleReveals(p, v) {
  if (!['setup', 'turns', 'final'].includes(v.phase)) { reveals.clear(); return; }
  const kingOpen = v.pending[0] && v.pending[0].type === 'K' && v.pending[0].by === v.you && v.pending[0].revealed;
  const toHide = [];
  for (const [key, r] of reveals) {
    if (slotVer(v, key) !== r.ver) reveals.delete(key);
    else if (r.kind === 'K' && !kingOpen) toHide.push(key);
  }
  if (toHide.length) setTimeout(() => hideReveals(toHide), 0);
}

// ---- actions ---------------------------------------------------------------
async function act(action, args = {}) {
  if (busy || !session) return null;
  busy = true;
  try {
    const resp = await call('act', { code: session.code, token: session.token, action, args });
    local = freshLocal();
    busy = false;
    if (resp.view) applyView(resp.view);
    return resp;
  } catch (e) {
    busy = false;
    toast(friendly(e), 'err');
    blip('miss');
    local.giving = null;
    refresh();
    return null;
  } finally { busy = false; render(); }
}

async function peek() {
  const slots = local.peekSel.slice().sort((a, b) => a - b);
  const resp = await act('peekSetup', { slots });
  if (!resp || !Array.isArray(resp.seen)) return;
  const m = me();
  showReveals(slots.map((slot, i) => {
    const key = `slot:${view.you}:${slot}`;
    return { key, card: resp.seen[i], ver: slotVer(view, key) };
  }).filter((x) => x.card && m), 'peek');
}

async function power(type, targetId, slot, extra = {}) {
  const resp = await act('power', { type, [type]: { targetId, slot, ...extra } });
  if (!resp || !resp.seen || type === 'J') return;
  const key = `slot:${targetId}:${slot}`;
  showReveals([{ key, card: resp.seen, ver: slotVer(view, key) }], type === 'K' ? 'K' : 'peek');
}

// King step 2: the player's own card shows face up beside the opponent's until they decide.
async function kingLook(slot) {
  const resp = await act('kingLook', { slot });
  if (!resp || !resp.seen) return;
  const key = `slot:${view.you}:${slot}`;
  showReveals([{ key, card: resp.seen, ver: slotVer(view, key) }], 'K');
}

function startSession(s) {
  session = s;
  saveSession(s);
  view = null;
  local = freshLocal();
  reveals.clear();
  ghosts.clear();
  pileHold = null;
  failures = 0;
  if (unsub) unsub();
  unsub = subscribe(s.code, refresh);
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, pollMs);
  render();
  refresh();
}

// The player's own choice to go: tell the server first (it ends a running game for the others).
function leaveRoom() {
  if (session) call('room', { action: 'leave', code: session.code, token: session.token }, { keepalive: true }).catch(() => {});
  leave();
}

function leave(msg = '') {
  if (unsub) unsub();
  unsub = null;
  clearInterval(pollTimer);
  clearSession();
  motion.finishAll();
  session = null;
  view = null;
  failures = 0;
  reveals.clear();
  ghosts.clear();
  pileHold = null;
  homeError = msg;
  render();
}

// ---- rendering -------------------------------------------------------------
function render() {
  const html = screenHtml();
  if (html !== lastHtml) {
    lastHtml = html;
    morph($app, html);
  }
  $app.dataset.phase = !session ? 'home' : view ? view.phase : 'connecting';
  const myTurn = inPlay() && view.turnId === view.you;
  document.title = !session ? 'Gringo · memory card game'
    : myTurn ? '● Your turn · Gringo'
      : view && view.phase === 'lobby' ? `Room ${session.code} · Gringo` : 'Gringo';
}

function screenHtml() {
  if (!session) return homeHtml();
  if (!view) return connectingHtml();
  const m = me();
  if (m && !m.connected && view.phase !== 'done' && view.phase !== 'rps') return removedHtml();
  switch (view.phase) {
    case 'lobby': return lobbyHtml();
    default: return gameHtml();
  }
}

const SOUND_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/>' +
  '<path class="waves" d="M16 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
  '<path class="mute" d="M16.5 9.5l5 5m0-5l-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

function barHtml(brand = true, plaque = '') {
  const net = failures >= 2
    ? '<span class="net" role="status" aria-label="Connection lost. Reconnecting…" title="Connection lost. Reconnecting…">Reconnecting…</span>' : '';
  const room = plaque || !session ? plaque : `<span class="room" title="Room code">Room <b>${esc(session.code)}</b></span>`;
  const on = soundOn();
  const me = session && view && view.players.find((p) => p.id === view.you);
  const exit = me && me.connected && ['setup', 'turns', 'final', 'ending', 'rps'].includes(view.phase)
    ? `<button class="leave${local.leaveArm ? ' armed' : ''}" data-act="exit">${local.leaveArm ? 'End game?' : 'Leave'}</button>`
    : session && view && view.spectator && view.phase !== 'lobby' ? '<button class="leave" data-act="leave">Leave</button>' : '';
  return `<header class="bar" data-key="bar">${brand ? '<span class="brand">Gringo</span>' : ''}${room}${net}${exit}
    <button class="icon sound${on ? ' on' : ''}" data-act="sound" aria-pressed="${on}" aria-label="Sound effects" title="Sound ${on ? 'on' : 'off'}">${SOUND_ICON}</button></header>`;
}

// House rules offered when creating a room. `invert` shows a rule that is on by default as a switch
// that turns the unusual behaviour on, so every checkbox reads "this room does something different".
const RULE_UI = [
  { key: 'gringoBlocksSwaps', invert: true, label: 'Swaps still work after Gringo', hint: 'Jack and King can swap cards with the player who called it.' },
  { key: 'jackAnyPlayers', label: 'Jack swaps any two players', hint: 'Blind swap between any two players, not only with you.' },
  { key: 'slapOthers', invert: true, label: 'Slap only your own cards', hint: 'Slapping a card from another hand is not allowed.' },
  { key: 'slapGive', invert: true, label: 'Free slaps', hint: 'Slapping another hand takes the card without giving one back.' },
  { key: 'multiSlap', label: 'Slap again and again', hint: 'The pile can be slapped again right after a slap.' },
];
const RULE_DEFAULTS = { gringoBlocksSwaps: true, jackAnyPlayers: false, slapOthers: true, slapGive: true, multiSlap: false, missPenalty: 1 };
let homeRules = { ...RULE_DEFAULTS };
let homeRulesOpen = false;

function customRulesHtml() {
  const rows = RULE_UI.map((r) => `<label class="rule"><input type="checkbox" data-rule="${r.key}"${(r.invert ? !homeRules[r.key] : homeRules[r.key]) ? ' checked' : ''}>
    <span><b>${r.label}</b><small>${r.hint}</small></span></label>`).join('');
  const pen = [1, 2, 3].map((n) => `<option value="${n}"${homeRules.missPenalty === n ? ' selected' : ''}>${n} card${n > 1 ? 's' : ''}</option>`).join('');
  return `<details class="custom" data-key="custom"${homeRulesOpen ? ' open' : ''}><summary>Custom rules</summary>${rows}
    <label class="rule select"><span><b>Wrong slap costs</b><small>Cards taken for a slap that misses.</small></span><select data-rule="missPenalty">${pen}</select></label></details>`;
}

// Rules that differ from the standard game, as short sentences (shown in the lobby).
function ruleNotes(rules) {
  const out = [];
  if (!rules.gringoBlocksSwaps) out.push('Swaps still work after Gringo');
  if (rules.jackAnyPlayers) out.push('Jack swaps any two players');
  if (!rules.slapOthers) out.push('Only your own cards can be slapped');
  else if (!rules.slapGive) out.push('Free slaps: no card given back');
  if (rules.multiSlap) out.push('The pile can be slapped again after a slap');
  if (rules.missPenalty !== 1) out.push(`A wrong slap costs ${rules.missPenalty} cards`);
  return out;
}

function homeHtml() {
  const fan = [{ rank: 'K', suit: 'H' }, { rank: '7', suit: 'S' }, { rank: 'A', suit: 'D' }, { rank: 'Q', suit: 'C' }];
  return `<div class="screen home" data-key="home">${barHtml(false)}
    <div class="hero" aria-hidden="true">${fan.map((c, i) => `<div class="fan-card" style="--i:${i}">${cardHtml(c)}</div>`).join('')}</div>
    <h1 class="title">Gringo</h1>
    <p class="lede">A memory card game for 2 to 4 players. Remember your cards, slap matches, lowest hand wins.</p>
    <form id="home" class="tray" novalidate>
      <label for="name">Your name</label>
      <input id="name" maxlength="16" autocomplete="nickname" placeholder="Name" enterkeyhint="go">
      ${customRulesHtml()}
      <button class="primary" type="submit" data-act="create">Create room</button>
      <div class="or"><span>or join a room</span></div>
      <label for="code">Room code</label>
      <div class="join-row">
        <input id="code" maxlength="4" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="ABCD" inputmode="text">
        <button type="button" data-act="join">Join room</button>
      </div>
      <p id="home-err" class="err" role="alert">${esc(homeError)}</p>
    </form>
    <details class="rules"><summary>How to play</summary><ol>
      <li>Everyone gets 4 face-down cards and peeks at 2 of them, once.</li>
      <li>On your turn draw a card, then swap it into one of your spots or discard it.</li>
      <li>Anyone may slap a card that matches the top of the pile. Wrong slaps cost a card.</li>
      <li>Discarding a Jack swaps two cards blind, a Queen lets you look at one, a King lets you look at one opponent card and one of yours, then swap those two or not.</li>
      <li>Call Gringo before drawing when you think you are lowest. Everyone else plays one more turn.</li>
      <li>Aces are 1, faces 10, red kings −3, jokers 0. Lowest total wins.</li>
    </ol></details>
  </div>`;
}

function connectingHtml() {
  return `<div class="screen connecting" data-key="connecting">${barHtml()}
    <div class="shuffle" aria-hidden="true">${BACK}${BACK}${BACK}</div>
    <p class="muted" role="status">Connecting to room ${esc(session.code)}…</p>
    <button class="link" data-act="leave">Cancel</button></div>`;
}

function removedHtml() {
  return `<div class="screen connecting" data-key="removed">${barHtml()}
    <section class="placard"><h2>You are out of this game</h2>
    <p class="muted">The host removed you, or you left. The others carry on without you.</p>
    <button class="primary" data-act="leave">Back to start</button></section></div>`;
}

function lobbyHtml() {
  const isHost = view.hostId === view.you;
  const rows = view.players.map((p) => `
    <li data-key="p:${esc(p.id)}" style="--seat: var(--seat-${seatIndex(p.id)})"><span class="dot"></span>
      <span class="pname">${esc(p.name)}</span>${p.id === view.you ? '<em>you</em>' : ''}${p.id === view.hostId ? '<span class="badge">host</span>' : ''}
      ${isHost && p.id !== view.you ? kickHtml(p) : ''}</li>`).join('');
  const empty = Array.from({ length: 4 - view.players.length }, (_, i) => `<div class="open-seat" data-key="open:${i}"><span class="dot"></span><span class="pname">Open seat</span></div>`).join('');
  const canStart = isHost && view.players.length >= 2;
  const open = view.players.length < 4;
  const rail = view.spectators.length
    ? `<h2>Watching <span class="muted">${view.spectators.length}</span></h2>
      <ul class="plist rail">${view.spectators.map((x) => `<li data-key="w:${esc(x.id)}"><span class="dot"></span><span class="pname">${esc(x.name)}</span>${x.id === view.you ? '<em>you</em>' : ''}${isHost ? kickHtml(x) : ''}</li>`).join('')}</ul>` : '';
  const foot = view.spectator
    ? `${open ? '<button class="primary" data-act="sit">Take a seat</button>' : '<p class="muted note">The room is full, so you are watching. A seat opens up if someone leaves.</p>'}`
    : isHost
      ? `<button class="primary" data-act="start" ${canStart ? '' : 'disabled'}>Start game</button>
           <p class="muted note">${canStart ? 'Everyone in? Start when ready.' : 'Start unlocks when a second player joins.'}</p>`
      : `<p class="muted note waiting"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>Waiting for ${esc(nameOf(view.hostId))} to start the game.</p>`;
  return `<div class="screen lobby" data-key="lobby">${barHtml()}
    <section class="placard">
      <p class="eyebrow">Share this code with your friends</p>
      <div class="codecard"><span class="bigcode" id="roomcode">${esc(session.code)}</span>
        <button class="small" data-act="copy" aria-label="Copy room code">Copy</button></div>
      ${ruleNotes(view.rules).length ? `<ul class="house" aria-label="House rules">${ruleNotes(view.rules).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      <h2>Players <span class="muted">${view.players.length} of 4</span></h2>
      <ul class="plist">${rows}</ul>${empty ? `<div class="plist open">${empty}</div>` : ''}
      ${rail}${foot}
      <button class="link" data-act="leave">Leave room</button>
    </section></div>`;
}

function kickHtml(p, compact = false) {
  const armed = local.kickArm === p.id;
  const label = armed ? 'Remove?' : compact ? '<span aria-hidden="true">×</span>' : 'Kick';
  return `<button class="kick${compact ? ' mini' : ''}${armed ? ' armed' : ''}" data-act="kick" data-id="${esc(p.id)}" aria-label="${armed ? `Confirm: remove ${esc(p.name)}` : `Remove ${esc(p.name)}`}" title="Remove ${esc(p.name)}">${label}</button>`;
}

// What tapping a slot means right now. `mine` marks states where this player must act.
function currentMode() {
  if (view.spectator) {
    const hint = view.phase === 'setup' ? 'Players are peeking at their first cards.'
      : view.phase === 'turns' || view.phase === 'final' ? `${esc(nameOf(view.turnId))}'s turn.` : '';
    return { id: 'watch', hint: `<b>You are watching.</b> ${hint}`.trim(), can: () => false };
  }
  const pend = view.pending[0];
  const myTurn = view.turnId === view.you;
  const top = view.discardTop ? cardLabel(view.discardTop) : '';
  if (view.phase === 'setup') {
    const m = me();
    if (m && m.ready) {
      const waiting = view.players.filter((p) => p.connected && !p.ready).map((p) => esc(p.name));
      return { id: 'wait', hint: `Remember them. Waiting for ${waiting.join(', ') || 'the others'} to peek.`, can: () => false };
    }
    return {
      id: 'peek', mine: true, hint: '<b>Peek at 2 of your 4 cards.</b> Tap two, then press Peek.',
      can: (mine) => mine, selected: (mine, slot) => mine && local.peekSel.includes(slot),
    };
  }
  if (local.giving) return { id: 'give', mine: true, slap: true, hint: '<b>Slap:</b> Pick which of YOUR cards to give them.', can: (mine) => mine };
  if (local.armed) {
    const hint = !view.discardTop ? '<b>Slap:</b> the pile is empty, so any slap misses.'
      : view.discardClaimed ? `<b>Slap:</b> ${esc(top)} is already claimed. A slap now costs a penalty card.`
        : `<b>Slap:</b> tap ${view.rules.slapOthers ? 'any' : 'one of your own'} card${view.rules.slapOthers ? '' : 's'} that match${view.rules.slapOthers ? 'es' : ''} ${esc(top)}. A miss costs ${view.rules.missPenalty === 1 ? 'a penalty card' : `${view.rules.missPenalty} penalty cards`}.`;
    return { id: 'slap', mine: true, slap: true, can: view.rules.slapOthers ? () => true : (mine) => mine, hint };
  }
  if (view.phase === 'ending') return { id: 'ending', hint: '<b>Round over.</b> Slap a match now, before the cards are counted.', can: () => false };
  if (pend && pend.by === view.you) {
    if (pend.type === 'J') {
      const R = view.rules;
      const ok = (p) => !(R.gringoBlocksSwaps && p.gringo);
      if (local.jMine === null) {
        return R.jackAnyPlayers
          ? { id: 'J1', mine: true, hint: '<b>Jack:</b> tap any card to swap away.', can: (mine, p) => ok(p) }
          : { id: 'J1', mine: true, hint: '<b>Jack:</b> tap one of YOUR cards to swap away.', can: (mine) => mine };
      }
      return {
        id: 'J2', mine: true,
        hint: R.jackAnyPlayers ? '<b>Jack:</b> now tap a card of a different player. The swap is blind.' : '<b>Jack:</b> now tap an opponent card. The swap is blind.',
        can: (mine, p) => p.id !== local.jOwner && ok(p),
        selected: (mine, slot, p) => p.id === local.jOwner && slot === local.jMine,
      };
    }
    if (pend.type === 'Q') return { id: 'Q', mine: true, hint: '<b>Queen:</b> tap any card to look at it.', can: () => true };
    if (!pend.revealed) return { id: 'K1', mine: true, hint: '<b>King:</b> tap an opponent card to look at it.', can: (mine) => !mine };
    if (!pend.lookedOwn) return { id: 'K2', mine: true, hint: '<b>King:</b> now tap one of YOUR cards to look at it.', can: (mine) => mine };
    return { id: 'K3', mine: true, hint: '<b>King:</b> swap the two cards you saw, or leave them where they are.', can: () => false };
  }
  if (pend) return { id: 'wait', hint: `${esc(nameOf(pend.by))} is using a ${esc(RANK_NAME[pend.type] || pend.type)}.`, can: () => false };
  if (myTurn && view.hasDrawn) return { id: 'keep', mine: true, hint: '<b>Your turn:</b> tap one of your cards to swap, or discard.', can: (mine) => mine };
  if (myTurn) return { id: 'idle', mine: true, hint: view.phase === 'final' ? '<b>Your turn:</b> your last one. Draw a card.' : '<b>Your turn:</b> draw a card, or call Gringo.', can: () => false };
  return { id: 'other', hint: `<b>${esc(nameOf(view.turnId))}'s turn.</b> You can slap a match any time.`, can: () => false };
}

// The end-of-game reveal: when each card turns over and when each total shows up. It is worked out
// once per finished hand layout and kept, so later polls and the move from tiebreak to result do not
// replay it. `settled` flips once the last card is over; the winner and the result panel wait for it.
let reveal = null;
function revealPlan() {
  if (!isOver()) { reveal = null; return null; }
  const sig = view.players.map((p) => `${p.id}:${p.hand.map((e) => (e.empty ? '_' : '#')).join('')}`).join('|');
  if (reveal && reveal.sig === sig) return reveal;
  const keys = [];
  for (const p of view.players) for (const e of p.hand) if (!e.empty) keys.push(`${p.id}:${e.slot}`);
  const still = motion.reduced();
  const step = still ? 0 : Math.max(110, Math.min(300, Math.floor(4200 / Math.max(keys.length, 1))));
  const base = still ? 0 : 500;
  const idx = new Map(keys.map((k, i) => [k, i]));
  const lastOf = {};
  for (const p of view.players) lastOf[p.id] = Math.max(-1, ...p.hand.filter((e) => !e.empty).map((e) => idx.get(`${p.id}:${e.slot}`)));
  const plan = {
    sig, idx, step, base, count: keys.length, settled: still,
    totalAt: (id) => base + (lastOf[id] + 1) * step + 150,
    endAt: still ? 0 : base + keys.length * step + 450,
  };
  reveal = plan;
  if (!plan.settled) setTimeout(() => { if (reveal === plan) { plan.settled = true; render(); } }, plan.endAt);
  return plan;
}

const RING = '<svg class="countdown" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15"/><circle class="arc" cx="18" cy="18" r="15"/></svg>';

function slotHtml(p, e, mode) {
  const mine = p.id === view.you;
  const key = `slot:${p.id}:${e.slot}`;
  const tap = mode && !e.empty && mode.can(mine, p, e);
  const sel = mode && mode.selected && mode.selected(mine, e.slot, p);
  const rv = reveals.get(key);
  const pend = view.pending[0];
  const kingHeld = !rv && e.card && inPlay() && pend && pend.type === 'K' && pend.by === view.you && pend.revealed;
  const ghost = ghosts.has(key) ? 'ghost' : '';
  let inner;
  let name;
  if (reveal && e.card) {
    // End of the game: the card turns over in place, one after another.
    inner = `<span class="flipper" style="--d:${reveal.base + reveal.idx.get(`${p.id}:${e.slot}`) * reveal.step}ms">${backHtml('rb', key)}${cardHtml(e.card, { cls: 'rf' })}</span>`;
    name = cardSpoken(e.card);
  } else if (e.empty) { inner = `<span class="card gap${ghost ? ` ${ghost}` : ''}" data-fx="${esc(key)}"></span>`; name = 'empty spot'; }
  else if (rv || kingHeld) {
    const card = rv ? rv.card : e.card;
    inner = cardHtml(card, { cls: `peek ${ghost}`.trim(), fx: key }) + (rv && rv.kind === 'peek' ? RING : '');
    name = cardSpoken(card);
  } else { inner = backHtml(ghost, key); name = 'face-down card'; }
  const label = `${mine ? 'Your' : `${p.name}'s`} card ${e.slot + 1}: ${name}`;
  return `<button class="slot${tap ? ' tap' : ''}${sel ? ' sel' : ''}${rv ? ' revealing' : kingHeld ? ' peeked' : ''}" data-key="${esc(key)}" data-owner="${esc(p.id)}" data-slot="${e.slot}"` +
    `${tap ? '' : ' tabindex="-1" aria-disabled="true"'} aria-label="${esc(label)}">${inner}</button>`;
}

function seatHtml(p, pos, mode) {
  const isMe = p.id === view.you;
  const rot = pos === 'left' ? 90 : pos === 'right' ? -90 : 0;
  const active = (inPlay() && p.id === view.turnId) || (view.phase === 'setup' && p.connected && !p.ready);
  const n = live(p);
  const winners = (view.result && view.result.winners) || [];
  const won = !!reveal && winners.includes(p.id) && view.phase === 'done';
  const forfeit = !!reveal && (view.abandonedBy || []).includes(p.id);
  const badges = [
    view.phase === 'setup' ? (p.ready ? '<span class="badge ok">ready</span>' : '<span class="badge">peeking</span>') : '',
    p.gringo ? '<span class="badge call">gringo</span>' : '',
    won && reveal.settled ? '<span class="badge win">winner</span>' : '',
    forfeit ? '<span class="badge off">forfeit</span>' : p.connected ? '' : '<span class="badge off">offline</span>',
  ].join('');
  const totals = view.result && view.result.totals;
  const total = reveal && totals && totals[p.id] !== undefined
    ? `<span class="total" style="--d:${reveal.totalAt(p.id)}ms">Total ${totals[p.id]}</span>` : '';
  const holding = inPlay() && view.hasDrawn && view.turnId === p.id && !isMe;
  const held = holding
    ? `<div class="held-mini" data-key="held">${backHtml(ghosts.has(`held:${p.id}`) ? 'ghost' : '', `held:${p.id}`)}<small>drew</small></div>` : '';
  return `<section class="seat pos-${pos}${isMe ? ' me' : ''}${active ? ' active' : ''}${p.connected || reveal ? '' : ' offline'}${won && reveal.settled ? ' winner' : ''}" data-key="seat:${esc(p.id)}" data-player="${esc(p.id)}" data-rot="${rot}" style="--seat: var(--seat-${seatIndex(p.id)}); --n: ${p.hand.length}">
    <i class="ring" aria-hidden="true"></i>
    <div class="chip"><span class="dot" aria-hidden="true"></span><b class="name">${esc(p.name)}</b>${isMe ? '<span class="you">you</span>' : ''}
      <span class="count" aria-label="${n} cards">${n}</span>${badges}${total}</div>
    <div class="hand">${p.hand.map((e) => slotHtml(p, e, mode)).join('')}</div>${held}
  </section>`;
}

function gameHtml() {
  const over = isOver();
  const plan = revealPlan();
  const mode = over ? { id: 'over', hint: '', can: () => false } : currentMode();
  const m = me();
  const seatOf = anchor();
  const myIdx = view.players.findIndex((p) => seatOf && p.id === seatOf.id);
  const order = myIdx < 0 ? view.players.slice() : [...view.players.slice(myIdx + 1), ...view.players.slice(0, myIdx)];
  const POS = { 1: ['top'], 2: ['left', 'right'], 3: ['left', 'top', 'right'] }[order.length] || ['top', 'left', 'right'];
  const seats = order.map((p, i) => seatHtml(p, POS[i] || 'top', mode)).join('');
  const myTurn = inPlay() && view.turnId === view.you;
  const pend = view.pending[0];

  let banner = '';
  if (view.phase === 'final' && view.endedBy) {
    const mine = view.endedBy.id === view.you;
    const who = esc(whoName(view.endedBy.id));
    const why = view.endedBy.reason === 'gringo' ? `${who} called Gringo` : `${who} ${mine ? 'have' : 'has'} no cards left`;
    const left = (view.finalLeft || []).map(whoName).map(esc).join(', ');
    const text = `${why}. ${left ? `Last turns: ${left}.` : 'No turns left.'}`;
    banner = `<div class="final" id="final-banner" data-key="final" role="status" title="${text}"><b>Final round</b><span>${text}</span></div>`;
  }

  if (view.phase === 'ending') {
    banner = `<div class="final ending" id="ending-banner" data-key="final" role="status" style="--ending:${ENDING_MS}ms"><b>Round over</b><span>Last chance to slap a match.</span><i class="fuse" aria-hidden="true"></i></div>`;
  }

  const shown = pileHold || { card: view.discardTop, claimed: view.discardClaimed };
  const pileCard = shown.card
    ? cardHtml(shown.card, { fx: 'pile', stamp: shown.claimed, cls: shown.claimed ? 'claimed' : '' })
    : '<span class="card gap" data-fx="pile"><span class="gap-label">Empty</span></span>';
  const under = view.discardCount > 1 ? '<span class="under" aria-hidden="true"></span>' : '';
  const deckDepth = Math.min(4, Math.ceil(view.deckCount / 12));
  const drawn = myTurn && view.drawn
    ? `<div class="pile held" id="drawn" data-key="drawn" data-flip="drawn">${cardHtml(view.drawn, { fx: `held:${view.you}`, cls: ghosts.has(`held:${view.you}`) ? 'ghost' : '' })}<small>Your card</small></div>`
    : '<div class="pile held hold" data-key="drawn" aria-hidden="true"><span class="card gap"></span><small>Your card</small></div>';
  const center = `<div class="center" data-key="center"><div class="piles">
    <div class="pile deck depth-${deckDepth}" data-key="deck" data-flip="deck">${view.deckCount ? BACK.replace('class="card back"', 'class="card back" data-fx="deck"') : '<span class="card gap" data-fx="deck"></span>'}<small>Deck <b>${view.deckCount}</b></small></div>
    <div class="pile discard${view.discardCount ? '' : ' empty'}" id="discard" data-key="discard" data-flip="pile">${under}${pileCard}<small>Pile <b>${view.discardCount}</b></small></div>
    ${drawn}</div></div>`;

  const btns = [];
  const b = (act, label, cls = '') => `<button class="${cls}" data-act="${act}" data-key="b:${act}">${label}</button>`;
  if (over) {
    // The table itself is the result; the buttons come back once the last total is in.
  } else if (view.phase === 'setup') {
    if (m && !m.ready) btns.push(`<button class="primary wide" data-act="peek" data-key="b:peek" ${local.peekSel.length === 2 ? '' : 'disabled'}>Peek <span class="tally">${local.peekSel.length}/2</span></button>`);
  } else {
    if (myTurn && !pend && !local.armed && !local.giving) {
      if (!view.hasDrawn) {
        btns.push(b('draw', 'Draw', 'primary'));
        if (view.phase === 'turns') btns.push(b('gringo', 'Gringo', 'call'));
      } else {
        btns.push(b('discard', 'Discard', 'primary'));
      }
    }
    if (pend && pend.by === view.you && !local.armed && !local.giving) {
      if (pend.type === 'K' && pend.lookedOwn) {
        btns.push(b('kingswap', 'Swap them', 'primary'));
        btns.push(b('kingkeep', 'Leave them'));
      } else btns.push(b('skippower', 'Skip power'));
    }
    const slapOn = local.armed || local.giving;
    btns.push(`<button class="slapbtn${slapOn ? ' on' : ''}" data-act="slap" data-key="b:slap" aria-pressed="${slapOn ? 'true' : 'false'}">${slapOn ? 'Cancel slap' : 'Slap'}</button>`);
  }

  const confirm = !over && local.confirmGringo && myTurn && !view.hasDrawn && view.phase === 'turns'
    ? `<div class="confirm-back" data-key="confirm"><div class="confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-text">
      <h2 id="confirm-title">Call Gringo?</h2>
      <p id="confirm-text">Are you sure you want to call Gringo? Everyone else gets one last turn, then all cards are counted.</p>
      <div class="confirm-btns"><button data-act="gringo-no" data-key="c:no">Not yet</button><button class="call" data-act="gringo-yes" data-key="c:yes">Call Gringo</button></div>
    </div></div>` : '';

  const status = `<p class="hint${mode.slap ? ' slap' : mode.mine ? ' mine' : ''}" id="hint" data-key="hint" aria-live="polite"><span>${mode.hint}${watchersHtml()}</span></p>`;
  const tail = over ? endPanelHtml(plan) : `${status}
    ${seatOf ? seatHtml(seatOf, 'bottom', mode) : ''}
    <div class="actions" data-key="actions">${btns.join('')}</div>`;
  return `<div class="screen game n${view.players.length}${local.armed || local.giving ? ' slapping' : ''}${over ? ` over${plan.settled ? ' settled' : ''}` : ''}" data-key="game" style="--me: var(--seat-${seatIndex(view.you)})">${barHtml(true, banner)}
    <div class="table" data-key="table">${seats}${center}</div>
    ${tail}${confirm}</div>`;
}

function watchersHtml() {
  const names = view.spectators.map((x) => esc(x.name));
  return names.length ? `<small class="watchers">Watching: ${names.join(', ')}</small>` : '';
}

// What sits under the table once the game is over: the verdict, and the next step.
function endPanelHtml() {
  const m = me();
  const mine = anchor() ? seatHtml(anchor(), 'bottom', { can: () => false }) : '';
  let inner;
  if (view.phase === 'rps') {
    const r = view.rps;
    const inIt = r.players.includes(view.you);
    const last = r.last
      ? `<p class="muted">Last round: ${Object.entries(r.last).map(([id, k]) => `${esc(nameOf(id))} ${esc(rpsName(k))}`).join(', ')}. Tied again.</p>` : '';
    const picked = r.picks[view.you];
    let ctl;
    if (!inIt) ctl = `<p class="muted">The tied players are playing rock, paper, scissors: ${r.players.map(nameOf).map(esc).join(', ')}.</p>`;
    else if (picked && picked !== 'hidden') ctl = `<p>You picked <b>${esc(rpsName(picked))}</b>. Waiting for the others.</p>`;
    else {
      ctl = `<div class="rps">
        <button data-act="rps" data-pick="r"><span aria-hidden="true">✊</span>Rock</button>
        <button data-act="rps" data-pick="p"><span aria-hidden="true">✋</span>Paper</button>
        <button data-act="rps" data-pick="s"><span aria-hidden="true">✌️</span>Scissors</button></div>`;
    }
    inner = `<p class="eyebrow">Same points, same number of cards</p><h2>Rock, paper, scissors</h2>
      <p>Round ${r.round + 1} between ${r.players.map(nameOf).map(esc).join(' and ')}.</p>${last}${ctl}`;
    return `${mine}<section class="placard endpanel" id="rps" data-key="endpanel">${inner}</section>`;
  }
  const winners = (view.result && view.result.winners) || [];
  const names = winners.map(nameOf).map(esc).join(' & ') || 'Nobody';
  const youWon = winners.includes(view.you);
  const burst = youWon
    ? `<div class="burst" aria-hidden="true">${['♠', '♥', '♦', '♣', '♥', '♠', '♦', '♣', '♥', '♦', '♠', '♣'].map((g, k) => `<i class="${g === '♥' || g === '♦' ? 'red' : ''}" style="--k:${k}">${g}</i>`).join('')}</div>` : '';
  const why = leftNote() || (view.result && view.result.decidedBy === 'cards' ? 'Tied on points, so the player with fewer cards wins.'
    : tieBroken() ? 'Same points and same number of cards, settled by rock, paper, scissors.' : 'Lowest total wins. Red kings count −3, jokers 0.');
  return `${mine}<section class="placard result endpanel${youWon ? ' won' : ''}" id="result" data-key="endpanel">${burst}
    <p class="eyebrow">Game over</p>
    <h2>${youWon ? 'You win!' : `${names} ${winners.length > 1 ? 'win' : 'wins'}`}</h2>
    <p class="muted">${why}</p>
    ${againHtml()}</section>`;
}

const rpsName = (k) => ({ r: 'rock', p: 'paper', s: 'scissors' }[k] || k);

function tieBroken() {
  const r = view.result;
  if (!r || r.winners.length !== 1) return false;
  const best = r.totals[r.winners[0]];
  return view.players.some((p) => p.connected && p.id !== r.winners[0] && r.totals[p.id] === best);
}

function leftNote() {
  const gone = (view.abandonedBy || []).map(nameOf).map(esc);
  if (gone.length === 0) return '';
  return `${gone.join(' & ')} left and forfeited, so the game ended.`;
}

function againHtml() {
  const voted = view.rematch || [];
  const live = view.players.filter((p) => p.connected);
  const queued = view.spectators.filter((x) => x.wantsIn);
  const free = Math.max(0, 4 - live.length);
  if (view.spectator) {
    const mineQ = queued.findIndex((x) => x.id === view.you);
    const queuedNote = mineQ < 0 ? (free ? '<p class="muted again-note">Ask for a seat and you play in the next game.</p>' : '<p class="muted again-note">The table is full, but you can line up in case someone leaves.</p>')
      : mineQ < free ? '<p class="muted again-note">You have a seat in the next game.</p>' : '<p class="muted again-note">You are in line. A seat opens up if someone does not play again.</p>';
    return `${mineQ < 0 ? '<button class="primary again" data-act="sit">Join the next game</button>'
      : '<button class="primary again" data-act="unsit">Leave the line</button>'}${queuedNote}
    <button class="link again" data-act="leave">Back to start</button>`;
  }
  const waiting = live.filter((p) => !voted.includes(p.id)).map((p) => esc(p.name));
  const mine = voted.includes(view.you);
  const joining = queued.slice(0, free).map((x) => esc(x.name));
  if (live.length + joining.length < 2) return '<button class="primary again" data-act="leave">Back to start</button>';
  const label = mine ? `Waiting for ${waiting.join(' & ')}` : `Play again${voted.length ? ` (${voted.length}/${live.length} ready)` : ''}`;
  const note = mine ? '' : '<p class="muted again-note">Everyone has to agree. The winner starts.</p>';
  const joinNote = joining.length ? `<p class="muted again-note">${joining.join(' & ')} ${joining.length > 1 ? 'are' : 'is'} joining the next game.</p>` : '';
  return `<button class="primary again" data-act="again"${mine ? ' disabled' : ''}>${label}</button>${note}${joinNote}
    <button class="link again" data-act="leave">Back to start</button>`;
}

// ---- events ----------------------------------------------------------------
document.addEventListener('click', (ev) => {
  const slotEl = ev.target.closest('button.slot');
  if (slotEl && view && !busy) {
    onSlot(slotEl.dataset.owner, Number(slotEl.dataset.slot));
    return;
  }
  const el = ev.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const a = el.dataset.act;
  if (a === 'create' || a === 'join') ev.preventDefault();
  if (a !== 'exit') local.leaveArm = false;
  switch (a) {
    case 'create': doCreate(); return;
    case 'join': doJoin(); return;
    case 'leave': leaveRoom(); return;
    case 'exit':
      if (!local.leaveArm) { local.leaveArm = true; render(); return; }
      leaveRoom();
      return;
    case 'sound': toggleSound(); lastHtml = ''; render(); return;
    case 'copy': copyCode(); return;
    case 'start': roomCall('start', {}); return;
    case 'kick':
      if (local.kickArm !== el.dataset.id) { local.kickArm = el.dataset.id; render(); return; }
      local.kickArm = null;
      roomCall('kick', { targetId: el.dataset.id });
      return;
    case 'peek': peek(); return;
    case 'draw': act('draw'); return;
    case 'discard': act('discard'); return;
    case 'gringo':
      local = { ...local, confirmGringo: true };
      render();
      document.querySelector('.confirm [data-act=gringo-no]')?.focus();
      return;
    case 'gringo-no': local = { ...local, confirmGringo: false }; render(); return;
    case 'gringo-yes': act('gringo'); return;
    case 'skippower': act('skipPower'); return;
    case 'kingkeep': act('confirmKing', { swap: false }); return;
    case 'kingswap': act('confirmKing', { swap: true }); return;
    case 'rps': act('rps', { pick: el.dataset.pick }); return;
    case 'again': act('rematch'); return;
    case 'sit': roomCall('sit', { want: true }); return;
    case 'unsit': roomCall('sit', { want: false }); return;
    case 'slap':
      if (local.armed || local.giving) local = { ...local, armed: false, giving: null };
      else { local = { ...local, armed: true }; buzz(8); }
      render();
      return;
    default:
  }
});

document.addEventListener('submit', (ev) => {
  ev.preventDefault();
  doCreate();
});

document.addEventListener('change', (ev) => {
  const key = ev.target.dataset && ev.target.dataset.rule;
  if (!key) return;
  const rule = RULE_UI.find((r) => r.key === key);
  homeRules = { ...homeRules, [key]: rule ? ev.target.checked !== !!rule.invert : Number(ev.target.value) };
});
document.addEventListener('toggle', (ev) => {
  if (ev.target.matches && ev.target.matches('details.custom')) homeRulesOpen = ev.target.open;
}, true);

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && (local.armed || local.giving || local.jMine !== null || local.confirmGringo)) {
    local = { ...local, armed: false, giving: null, jMine: null, jOwner: null, confirmGringo: false };
    render();
  }
  if (ev.key === 'Enter' && ev.target.id === 'code') { ev.preventDefault(); doJoin(); }
});

async function copyCode() {
  try {
    await navigator.clipboard.writeText(session.code);
    toast(`Copied room code ${session.code}.`, 'ok');
  } catch { toast(`Room code: ${session.code}`); }
}

async function roomCall(action, extra) {
  if (busy || !session) return;
  busy = true;
  render();
  try {
    await call('room', { action, code: session.code, token: session.token, ...extra });
  } catch (e) { toast(friendly(e), 'err'); }
  finally { busy = false; render(); refresh(); }
}

function homeFail(msg, field) {
  homeError = msg;
  render();
  const el = document.getElementById(field);
  if (el) el.focus();
}

async function doCreate() {
  if (busy) return;
  const name = document.getElementById('name').value.trim();
  if (!name) { homeFail('Enter your name first.', 'name'); return; }
  busy = true;
  try {
    const r = await call('room', { action: 'create', name, rules: homeRules });
    homeError = '';
    startSession({ code: r.code, playerId: r.playerId, token: r.token });
  } catch (e) { homeFail(friendly(e)); } finally { busy = false; }
}

async function doJoin() {
  if (busy) return;
  const name = document.getElementById('name').value.trim();
  const code = document.getElementById('code').value.trim().toUpperCase();
  if (!name) { homeFail('Enter your name first.', 'name'); return; }
  if (!/^[A-Z]{4}$/.test(code)) { homeFail('Room codes are 4 letters, like ABCD.', 'code'); return; }
  busy = true;
  try {
    const r = await call('room', { action: 'join', code, name });
    homeError = '';
    startSession({ code, playerId: r.playerId, token: r.token });
  } catch (e) { homeFail(friendly(e), /room/i.test(e.message) ? 'code' : undefined); } finally { busy = false; }
}

function onSlot(ownerId, slot) {
  const mine = ownerId === view.you;
  const owner = view.players.find((p) => p.id === ownerId);
  const entry = owner && owner.hand[slot];
  if (view.phase === 'setup') {
    const m = me();
    if (!mine || !m || m.ready) return;
    const i = local.peekSel.indexOf(slot);
    if (i >= 0) local.peekSel.splice(i, 1);
    else if (local.peekSel.length < 2) local.peekSel.push(slot);
    else local.peekSel = [local.peekSel[1], slot];
    render();
    return;
  }
  if (!playing()) return;
  const mode = currentMode();
  if (!entry || entry.empty || !mode.can(mine, owner, entry)) return;
  switch (mode.id) {
    case 'give': slapAct({ ownerId: local.giving.ownerId, slot: local.giving.slot, giveSlot: slot }); return;
    case 'slap': {
      if (mine || !view.rules.slapGive || !me().hand.some((s) => !s.empty)) { slapAct({ ownerId, slot }); return; }
      local.giving = { ownerId, slot };
      local.armed = false;
      render();
      return;
    }
    case 'J1': local.jMine = slot; local.jOwner = ownerId; render(); return;
    case 'J2': act('power', { type: 'J', J: { firstId: local.jOwner, mine: local.jMine, targetId: ownerId, theirs: slot } }); return;
    case 'Q': power('Q', ownerId, slot); return;
    case 'K1': power('K', ownerId, slot); return;
    case 'K2': kingLook(slot); return;
    case 'keep': act('keep', { slot }); return;
    default:
  }
}

async function slapAct(args) {
  const resp = await act('slap', args);
  if (!resp) return;
  if (resp.ok) { toast('Slap! Card played.', 'ok'); buzz(25); } else { toast(view.rules.missPenalty === 1 ? 'Missed. You take a penalty card.' : `Missed. You take ${view.rules.missPenalty} penalty cards.`, 'err'); }
}

// ---- boot ------------------------------------------------------------------
render();
checkBuild().then(reloadIfStale);
if (session) startSession(session);
window.addEventListener('online', refresh);
// A closing tab says bye. The server keeps a short grace, so a reload does not end the game.
window.addEventListener('pagehide', () => {
  if (session) call('room', { action: 'view', code: session.code, token: session.token, bye: true }, { keepalive: true }).catch(() => {});
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
