// Card flights and small effects. Transform and opacity only, Web Animations API, one motion language:
// ease-in-out travel on an arc with a slight tilt, a landing that overshoots a hair and settles.
const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
export const reduced = () => mq.matches;

const TRAVEL = 'cubic-bezier(.45, 0, .25, 1)';

let layer = null;
function flightLayer() {
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'flight-layer';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);
  }
  return layer;
}

const live = new Set();

// Ends every running flight at once (its card lands where it was going). Used when a newer view
// arrives so animations never pile up behind the state.
export function finishAll() {
  for (const f of Array.from(live)) f.end(true);
}

// from/to: { x, y, w, rot } with x/y the centre in viewport px and w the upright card width.
// face/back: card markup. flip 'up' turns back -> face mid-air, 'down' face -> back.
export function fly({ from, to, face, back, flip = null, delay = 0, arc = 1, onLand }) {
  const dx = from.x - to.x;
  const dy = from.y - to.y;
  const dist = Math.hypot(dx, dy) || 1;
  const s0 = from.w / to.w;
  const dur = Math.round(Math.min(460, Math.max(280, 240 + dist * 0.32)));
  // Bend the path toward the top of the screen so every flight reads as a toss, not a slide;
  // arc -1 bends the other way, so two cards trading places pass each other.
  let nx = -dy / dist;
  let ny = dx / dist;
  if (ny > 0) { nx = -nx; ny = -ny; }
  const lift = Math.min(70, dist * 0.2) * arc;
  const mx = dx / 2 + nx * lift;
  const my = dy / 2 + ny * lift;
  const tilt = dx > 0 ? -9 : 9;
  const r0 = from.rot || 0;
  const r1 = to.rot || 0;
  const peak = Math.max(s0, 1) * 1.1;

  const el = document.createElement('div');
  el.className = 'flyer';
  el.style.setProperty('--cw', `${to.w}px`);
  el.style.left = `${to.x - to.w / 2}px`;
  el.style.top = `${to.y - (to.w * 1.4) / 2}px`;
  const showBack = flip === 'up' || (!flip && !face);
  el.innerHTML = flip
    ? `<i class="fly-shadow"></i><div class="flip">${face}${back.replace('class="card back', 'class="card back flip-back')}</div>`
    : `<i class="fly-shadow"></i>${showBack ? back : face}`;
  flightLayer().appendChild(el);

  const anims = [];
  const opts = { duration: dur, delay, fill: 'both' };
  anims.push(el.animate([
    { transform: `translate(${dx}px, ${dy}px) rotate(${r0}deg) scale(${s0})`, easing: TRAVEL },
    { offset: 0.48, transform: `translate(${mx}px, ${my}px) rotate(${(r0 + r1) / 2 + tilt}deg) scale(${peak})`, easing: 'cubic-bezier(.4, 0, .6, 1)' },
    { offset: 0.84, transform: `translate(0, 0) rotate(${r1}deg) scale(1.045)`, easing: 'ease-out' },
    { offset: 0.93, transform: `translate(0, 0) rotate(${r1}deg) scale(.985)` },
    { transform: `translate(0, 0) rotate(${r1}deg) scale(1)` },
  ], opts));
  anims.push(el.firstChild.animate([
    { opacity: 0.35 }, { offset: 0.48, opacity: 1 }, { offset: 0.84, opacity: 0.2 }, { opacity: 0 },
  ], opts));
  if (flip) {
    const a = flip === 'up' ? 180 : 0;
    const b = flip === 'up' ? 0 : 180;
    anims.push(el.querySelector('.flip').animate([
      { transform: `perspective(700px) rotateY(${a}deg)` },
      { offset: 0.2, transform: `perspective(700px) rotateY(${a}deg)` },
      { offset: 0.75, transform: `perspective(700px) rotateY(${b}deg)` },
      { transform: `perspective(700px) rotateY(${b}deg)` },
    ], opts));
  }

  const f = {
    done: false,
    end(silent) {
      if (f.done) return;
      f.done = true;
      live.delete(f);
      for (const a of anims) a.cancel();
      el.remove();
      if (onLand) onLand(silent);
    },
  };
  live.add(f);
  anims[0].finished.then(() => f.end(false), () => {});
  return f;
}

// Half-turn used for flips in place: the old face turns away, the caller swaps content, the new face turns in.
// Returns the animation (or null); the caller cancels it once the new face is in place.
export function turnAway(el, ms = 130) {
  if (!el || reduced()) return null;
  return el.animate([
    { transform: 'perspective(700px) rotateY(0deg)' },
    { transform: 'perspective(700px) rotateY(90deg)' },
  ], { duration: ms, easing: 'cubic-bezier(.55, 0, 1, .45)', fill: 'forwards' });
}

export function turnIn(el, ms = 240) {
  if (!el || reduced()) return;
  el.animate([
    { transform: 'perspective(700px) rotateY(-90deg)' },
    { offset: 0.75, transform: 'perspective(700px) rotateY(8deg)' },
    { transform: 'perspective(700px) rotateY(0deg)' },
  ], { duration: ms, easing: 'ease-out' });
}

export function impact(el) {
  if (!el || reduced()) return;
  el.animate([
    { transform: 'scale(1)' }, { offset: 0.3, transform: 'scale(1.12) rotate(-2deg)' },
    { offset: 0.65, transform: 'scale(.96)' }, { transform: 'scale(1)' },
  ], { duration: 360, easing: 'ease-out' });
}

export function shake(el) {
  if (!el || reduced()) return;
  el.animate([
    { transform: 'translateX(0)' }, { transform: 'translateX(-7px)' }, { transform: 'translateX(6px)' },
    { transform: 'translateX(-4px)' }, { transform: 'translateX(2px)' }, { transform: 'translateX(0)' },
  ], { duration: 380, easing: 'ease-out' });
}

export function pulse(el) {
  if (!el || reduced()) return;
  el.animate([
    { transform: 'scale(.92)', opacity: 0 }, { offset: 0.35, transform: 'scale(1.06)', opacity: 1 },
    { transform: 'scale(1)', opacity: 1 },
  ], { duration: 420, easing: 'ease-out' });
}

// FLIP: records boxes before a DOM update, then slides moved elements from their old place.
export function measure(root, sel) {
  const out = new Map();
  for (const el of root.querySelectorAll(sel)) out.set(el.dataset.flip, el.getBoundingClientRect());
  return out;
}

export function flipFrom(root, sel, before) {
  if (reduced()) return;
  for (const el of root.querySelectorAll(sel)) {
    const a = before.get(el.dataset.flip);
    if (!a) continue;
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.animate([
      { transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' },
    ], { duration: 320, easing: TRAVEL });
  }
}
