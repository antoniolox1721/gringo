import { call, subscribe, pollMs } from './api.js';

const KEYS = { code: 'gringo.code', playerId: 'gringo.playerId', token: 'gringo.token' };
const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

let session = loadSession();
let view = null;
let unsub = null;
let pollTimer = null;
let fetching = false;
let busy = false;
let lastKey = '';
let homeError = '';
let toastTimer = null;
let local = freshLocal();

function freshLocal() {
  return { armed: false, giving: null, peekSel: [], jMine: null, kingSwap: false, kickArm: null };
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

function cardLabel(card) {
  if (card.rank === 'JOKER') return 'Joker';
  return `${card.rank}${SUIT[card.suit] || ''}`;
}
function cardHtml(card, extra = '') {
  const red = card.suit === 'H' || card.suit === 'D';
  return `<span class="card face${red ? ' red' : ''} ${extra}">${esc(cardLabel(card))}</span>`;
}

function toast(msg, kind = '') {
  $toast.textContent = msg;
  $toast.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.className = ''; }, 3500);
}

const me = () => view && view.players.find((p) => p.id === view.you);
const nameOf = (id) => {
  const p = view && view.players.find((x) => x.id === id);
  return p ? p.name : 'someone';
};
const inPlay = () => view && (view.phase === 'turns' || view.phase === 'final');

// ---- networking ------------------------------------------------------------
async function refresh() {
  if (!session || fetching) return;
  fetching = true;
  try {
    const { view: v } = await call('room', { action: 'view', code: session.code, token: session.token });
    applyView(v);
  } catch (e) {
    if (e.status === 403 || (e.status === 400 && /room/i.test(e.message))) {
      leave(e.status === 403 ? 'You are no longer in that room.' : e.message);
    }
  } finally { fetching = false; }
}

function applyView(v) {
  if (!v) return;
  if (view && v.version < view.version) return; // stale response
  view = v;
  render();
}

async function act(action, args = {}) {
  if (busy || !session) return null;
  busy = true;
  try {
    const resp = await call('act', { code: session.code, token: session.token, action, args });
    local = { ...freshLocal(), kickArm: null };
    if (resp.view) applyView(resp.view);
    return resp;
  } catch (e) {
    toast(e.message, 'err');
    local.giving = null;
    refresh();
    return null;
  } finally { busy = false; render(); }
}

function startSession(s) {
  session = s;
  saveSession(s);
  view = null;
  local = freshLocal();
  lastKey = '';
  if (unsub) unsub();
  unsub = subscribe(s.code, refresh);
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, pollMs);
  refresh();
}

function leave(msg = '') {
  if (unsub) unsub();
  unsub = null;
  clearInterval(pollTimer);
  clearSession();
  session = null;
  view = null;
  homeError = msg;
  lastKey = '';
  render();
}

// ---- rendering -------------------------------------------------------------
function render() {
  const key = JSON.stringify([session && session.code, view, local, busy, homeError]);
  if (key === lastKey) return;
  lastKey = key;
  if (!session) { renderHome(); return; }
  if (!view) { $app.innerHTML = '<p class="muted">Connecting...</p>'; return; }
  const body = {
    lobby: renderLobby, setup: renderSetup, turns: renderBoard, final: renderBoard, rps: renderRps, done: renderDone,
  }[view.phase] || renderBoard;
  $app.innerHTML = header() + body();
}

function header() {
  return `<header class="top"><h1>Gringo</h1><span class="code" title="Room code">Room <b>${esc(session.code)}</b></span></header>`;
}

function renderHome() {
  // Do not clobber what the user is typing.
  if ($app.querySelector('#home')) {
    const err = $app.querySelector('#home-err');
    if (err) err.textContent = homeError;
    return;
  }
  $app.innerHTML = `
    <header class="top"><h1>Gringo</h1></header>
    <section id="home" class="panel">
      <label>Your name<input id="name" maxlength="16" autocomplete="off" placeholder="Name"></label>
      <button class="primary" data-act="create">Create room</button>
      <div class="or">or join a room</div>
      <label>Room code<input id="code" maxlength="4" autocapitalize="characters" autocomplete="off" placeholder="ABCD"></label>
      <button data-act="join">Join room</button>
      <p id="home-err" class="err">${esc(homeError)}</p>
    </section>`;
}

function renderLobby() {
  const isHost = view.hostId === view.you;
  const rows = view.players.map((p) => `
    <li><span>${esc(p.name)}${p.id === view.you ? ' <em>(you)</em>' : ''}${p.id === view.hostId ? ' <span class="badge">host</span>' : ''}</span>
    ${isHost && p.id !== view.you ? `<button class="small" data-act="kick" data-id="${esc(p.id)}">${local.kickArm === p.id ? 'Sure?' : 'Kick'}</button>` : ''}</li>`).join('');
  const canStart = isHost && view.players.length >= 2;
  return `<section class="panel">
    <p>Share this code with friends:</p>
    <div class="bigcode" id="roomcode">${esc(session.code)}</div>
    <h2>Players (${view.players.length}/4)</h2>
    <ul class="plist">${rows}</ul>
    ${isHost
      ? `<button class="primary" data-act="start" ${canStart ? '' : 'disabled'}>Start game</button>${canStart ? '' : '<p class="muted">Need at least 2 players.</p>'}`
      : '<p class="muted">Waiting for the host to start...</p>'}
    <button class="link" data-act="leave">Leave room</button>
  </section>`;
}

function handHtml(p, mode) {
  const mine = p.id === view.you;
  const slots = p.hand.map((s) => {
    const tap = mode && !s.empty && mode.can(mine, p, s);
    const sel = (mode && mode.selected && mode.selected(mine, s.slot)) ? ' sel' : '';
    const attrs = `data-owner="${esc(p.id)}" data-slot="${s.slot}"`;
    let inner;
    if (s.empty) inner = '<span class="card gap" aria-label="empty slot"></span>';
    else if (s.card) inner = cardHtml(s.card, 'peek');
    else inner = '<span class="card back" aria-label="hidden card"></span>';
    return `<button class="slot${tap ? ' tap' : ''}${sel}" ${attrs} ${tap ? '' : 'tabindex="-1"'} ${s.empty ? 'aria-label="empty slot"' : ''}>${inner}<i>${s.slot + 1}</i></button>`;
  }).join('');
  return `<div class="hand">${slots}</div>`;
}

function renderSetup() {
  const m = me();
  const peeked = m && m.hand.some((s) => s.card);
  if (peeked) {
    return `<section class="panel"><h2>Memorise your cards</h2>
      ${handHtml(m, null)}
      <p class="muted">Waiting for the other players to peek...</p></section>`;
  }
  const mode = {
    can: (mine) => mine,
    selected: (mine, slot) => mine && local.peekSel.includes(slot),
  };
  return `<section class="panel"><h2>Peek at 2 of your 4 cards</h2>
    ${handHtml(m, mode)}
    <p class="muted">Tap two cards, then confirm. You only get to look once.</p>
    <button class="primary" data-act="peek" ${local.peekSel.length === 2 ? '' : 'disabled'}>Peek (${local.peekSel.length}/2)</button>
  </section>`;
}

// What does tapping a slot mean right now?
function currentMode() {
  const pend = view.pending[0];
  const myTurn = view.turnId === view.you;
  if (local.giving) return { id: 'give', hint: 'Pick which of YOUR cards to give them.', can: (mine) => mine };
  if (local.armed) return { id: 'slap', hint: 'SLAP: tap a card that matches the top of the pile (yours or an opponent\'s).', can: () => true };
  if (pend && pend.by === view.you) {
    if (pend.type === 'J') {
      if (local.jMine === null) return { id: 'J1', hint: 'Jack: tap one of YOUR cards to swap away.', can: (mine) => mine };
      return { id: 'J2', hint: 'Jack: now tap the opponent card to swap with (blind).', can: (mine) => !mine, selected: (mine, slot) => mine && slot === local.jMine };
    }
    if (pend.type === 'Q') return { id: 'Q', hint: 'Queen: tap any card to look at it.', can: () => true };
    if (!pend.revealed) return { id: 'K1', hint: 'King: tap an opponent card to look at it.', can: (mine) => !mine };
    if (local.kingSwap) return { id: 'K2', hint: 'King: tap YOUR card to swap into that spot.', can: (mine) => mine };
    return { id: 'K3', hint: 'King: you looked at the card. Swap it or leave it.', can: () => false };
  }
  if (pend) return { id: 'wait', hint: `${esc(nameOf(pend.by))} is using a ${pend.type} power...`, can: () => false };
  if (myTurn && view.hasDrawn) return { id: 'keep', hint: 'Tap one of your cards to swap the drawn card into, or discard it.', can: (mine) => mine };
  if (myTurn) return { id: 'idle', hint: 'Your turn: draw a card, or call Gringo.', can: () => false };
  return { id: 'other', hint: `${esc(nameOf(view.turnId))}'s turn.`, can: () => false };
}

function renderBoard() {
  const mode = currentMode();
  const m = me();
  const others = view.players.filter((p) => p.id !== view.you);
  const myTurn = view.turnId === view.you;
  const pend = view.pending[0];
  const isHost = view.hostId === view.you;

  let banner = '';
  if (view.phase === 'final' && view.endedBy) {
    const who = nameOf(view.endedBy.id);
    const why = view.endedBy.reason === 'gringo' ? `${esc(who)} called Gringo` : `${esc(who)} has no cards left`;
    const left = (view.finalLeft || []).map(nameOf).map(esc).join(', ');
    banner = `<div class="banner" id="final-banner">Final round: ${why}. Still to play: ${left || 'nobody'}.</div>`;
  }

  const seat = (p) => {
    const tags = [
      p.id === view.turnId ? '<span class="badge turn">turn</span>' : '',
      p.gringo ? '<span class="badge warn">gringo</span>' : '',
      p.connected ? '' : '<span class="badge off">offline</span>',
    ].join('');
    const kick = isHost && p.id !== view.you
      ? `<button class="small" data-act="kick" data-id="${esc(p.id)}">${local.kickArm === p.id ? 'Sure?' : 'Kick'}</button>` : '';
    return `<section class="seat${p.id === view.turnId ? ' active' : ''}" data-player="${esc(p.id)}">
      <div class="seathead"><b>${esc(p.name)}${p.id === view.you ? ' (you)' : ''}</b> ${tags}${kick}</div>
      ${handHtml(p, mode)}</section>`;
  };

  const top = view.discardTop
    ? cardHtml(view.discardTop, view.discardClaimed ? 'claimed' : '')
    : '<span class="card gap"></span>';
  const table = `<section class="table">
    <div class="pile"><span class="card back"></span><small>Deck ${view.deckCount}</small></div>
    <div class="pile" id="discard">${top}<small>Discard ${view.discardCount}</small>
      ${view.discardTop ? (view.discardClaimed ? '<small class="claimed-hint" id="claimed">claimed - slaps now are penalised</small>' : '<small class="open-hint">open to slap</small>') : ''}</div>
    ${myTurn && view.drawn ? `<div class="pile" id="drawn">${cardHtml(view.drawn, 'drawn')}<small>You drew</small></div>` : ''}
  </section>`;

  const btns = [];
  if (myTurn && !pend && !local.armed) {
    if (!view.hasDrawn) {
      btns.push('<button class="primary" data-act="draw">Draw</button>');
      if (view.phase === 'turns') btns.push('<button class="warn" data-act="gringo">Gringo</button>');
    } else {
      btns.push('<button class="primary" data-act="discard">Discard</button>');
    }
  }
  if (pend && pend.by === view.you) {
    if (pend.type === 'K' && pend.revealed && !local.kingSwap) {
      btns.push('<button class="primary" data-act="kingswap">Swap...</button><button data-act="kingkeep">Leave as is</button>');
    }
    btns.push('<button data-act="skippower">Skip power</button>');
  }
  const slapBtn = `<button class="slapbtn${local.armed || local.giving ? ' on' : ''}" data-act="slap">${local.armed || local.giving ? 'Cancel slap' : 'Slap!'}</button>`;

  return `${banner}
    ${table}
    <p class="hint" id="hint">${mode.hint}</p>
    <div class="actions">${btns.join('')}${slapBtn}</div>
    ${others.map(seat).join('')}
    ${m ? seat(m) : ''}`;
}

function renderRps() {
  const r = view.rps;
  const inIt = r.players.includes(view.you);
  const last = r.last
    ? `<p class="muted">Last round: ${Object.entries(r.last).map(([id, k]) => `${esc(nameOf(id))} ${esc(rpsName(k))}`).join(', ')}</p>` : '';
  const picked = r.picks[view.you];
  let ctl;
  if (!inIt) ctl = `<p class="muted">Tied players are playing rock-paper-scissors: ${r.players.map(nameOf).map(esc).join(', ')}.</p>`;
  else if (picked && picked !== 'hidden') ctl = `<p>You picked <b>${esc(rpsName(picked))}</b>. Waiting for the others...</p>`;
  else ctl = `<div class="actions rps">
      <button data-act="rps" data-pick="r">Rock</button>
      <button data-act="rps" data-pick="p">Paper</button>
      <button data-act="rps" data-pick="s">Scissors</button></div>`;
  return `<section class="panel" id="rps"><h2>Tie-break: rock paper scissors</h2>
    <p>Tied: ${r.players.map(nameOf).map(esc).join(', ')} (round ${r.round + 1})</p>${last}${ctl}</section>
    ${resultHands()}`;
}
const rpsName = (k) => ({ r: 'rock', p: 'paper', s: 'scissors' }[k] || k);

function resultHands() {
  const totals = (view.result && view.result.totals) || {};
  const winners = (view.result && view.result.winners) || [];
  return view.players.map((p) => `
    <section class="seat${winners.includes(p.id) && view.phase === 'done' ? ' winner' : ''}">
      <div class="seathead"><b>${esc(p.name)}${p.id === view.you ? ' (you)' : ''}</b>
      <span class="total">${totals[p.id] === undefined ? '' : `Total ${totals[p.id]}`}</span>
      ${winners.includes(p.id) && view.phase === 'done' ? '<span class="badge turn">winner</span>' : ''}</div>
      ${handHtml(p, null)}</section>`).join('');
}

function renderDone() {
  const winners = (view.result && view.result.winners) || [];
  const names = winners.map(nameOf).map(esc).join(' & ') || 'nobody';
  const youWon = winners.includes(view.you);
  return `<section class="panel result" id="result">
    <h2>${youWon ? 'You win!' : `${names} wins`}</h2>
    <p class="muted">Lowest total wins.</p></section>
    ${resultHands()}
    <button class="link" data-act="leave">Back to start</button>`;
}

// ---- events ----------------------------------------------------------------
document.addEventListener('click', async (ev) => {
  const slotEl = ev.target.closest('.slot');
  if (slotEl && view && !busy) {
    onSlot(slotEl.dataset.owner, Number(slotEl.dataset.slot));
    return;
  }
  const el = ev.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const a = el.dataset.act;
  switch (a) {
    case 'create': return doCreate();
    case 'join': return doJoin();
    case 'leave': return leave();
    case 'start': return roomCall('start', {});
    case 'kick': {
      if (local.kickArm !== el.dataset.id) { local.kickArm = el.dataset.id; render(); return; }
      local.kickArm = null;
      return roomCall('kick', { targetId: el.dataset.id });
    }
    case 'peek': return act('peekSetup', { slots: local.peekSel.slice().sort() });
    case 'draw': return act('draw');
    case 'discard': return act('discard');
    case 'gringo': return act('gringo');
    case 'skippower': return act('skipPower');
    case 'kingkeep': return act('confirmKing', { swapWithSlot: null });
    case 'kingswap': local.kingSwap = true; render(); return;
    case 'rps': return act('rps', { pick: el.dataset.pick });
    case 'slap':
      if (local.armed || local.giving) local = { ...local, armed: false, giving: null };
      else local = { ...local, armed: true };
      render();
      return;
    default:
  }
});

async function roomCall(action, extra) {
  if (busy || !session) return;
  busy = true;
  try {
    const r = await call('room', { action, code: session.code, token: session.token, ...extra });
    if (r.view) applyView(r.view); else await refresh();
  } catch (e) { toast(e.message, 'err'); }
  finally { busy = false; lastKey = ''; render(); refresh(); }
}

async function doCreate() {
  const name = document.getElementById('name').value.trim();
  if (!name) { homeError = 'Enter your name first.'; lastKey = ''; render(); return; }
  try {
    const r = await call('room', { action: 'create', name });
    homeError = '';
    startSession({ code: r.code, playerId: r.playerId, token: r.token });
  } catch (e) { homeError = e.message; lastKey = ''; render(); }
}

async function doJoin() {
  const name = document.getElementById('name').value.trim();
  const code = document.getElementById('code').value.trim().toUpperCase();
  if (!name || !code) { homeError = 'Enter your name and the room code.'; lastKey = ''; render(); return; }
  try {
    const r = await call('room', { action: 'join', code, name });
    homeError = '';
    startSession({ code, playerId: r.playerId, token: r.token });
  } catch (e) { homeError = e.message; lastKey = ''; render(); }
}

function onSlot(ownerId, slot) {
  const mine = ownerId === view.you;
  if (view.phase === 'setup') {
    if (!mine) return;
    const i = local.peekSel.indexOf(slot);
    if (i >= 0) local.peekSel.splice(i, 1);
    else if (local.peekSel.length < 2) local.peekSel.push(slot);
    else local.peekSel = [local.peekSel[1], slot];
    render();
    return;
  }
  if (!inPlay()) return;
  const mode = currentMode();
  const owner = view.players.find((p) => p.id === ownerId);
  const entry = owner && owner.hand[slot];
  if (!entry || entry.empty || !mode.can(mine, owner, entry)) return;
  switch (mode.id) {
    case 'give': {
      const g = local.giving;
      return slapAct({ ownerId: g.ownerId, slot: g.slot, giveSlot: slot });
    }
    case 'slap': {
      if (mine) return slapAct({ ownerId, slot });
      const hasOwn = me().hand.some((s) => !s.empty);
      if (!hasOwn) return slapAct({ ownerId, slot });
      local.giving = { ownerId, slot };
      local.armed = false;
      render();
      return;
    }
    case 'J1': local.jMine = slot; render(); return;
    case 'J2': return act('power', { type: 'J', J: { mine: local.jMine, targetId: ownerId, theirs: slot } });
    case 'Q': return act('power', { type: 'Q', Q: { targetId: ownerId, slot } });
    case 'K1': return act('power', { type: 'K', K: { targetId: ownerId, slot } });
    case 'K2': return act('confirmKing', { swapWithSlot: slot });
    case 'keep': return act('keep', { slot });
    default:
  }
}

async function slapAct(args) {
  const resp = await act('slap', args);
  if (resp) toast(resp.ok ? 'Slap! Card played.' : 'Missed - you take a penalty card.', resp.ok ? 'ok' : 'err');
}

// ---- boot ------------------------------------------------------------------
render();
if (session) {
  const s = session;
  session = null;
  startSession(s);
}
window.addEventListener('online', refresh);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
