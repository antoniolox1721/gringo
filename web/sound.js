// Optional, very short WebAudio blips (off by default) and tiny haptics where the device supports them.
const KEY = 'gringo.sound';
let on = false;
try { on = localStorage.getItem(KEY) === '1'; } catch { /* storage unavailable */ }
let ctx = null;

const TONES = {
  draw: [[540, 0.045, 'triangle']],
  land: [[170, 0.05, 'sine']],
  slap: [[920, 0.035, 'square'], [460, 0.06, 'triangle']],
  miss: [[240, 0.08, 'sawtooth'], [180, 0.1, 'sine']],
  turn: [[660, 0.06, 'sine'], [990, 0.08, 'sine']],
  flip: [[1250, 0.025, 'triangle']],
  call: [[523, 0.07, 'triangle'], [659, 0.07, 'triangle'], [784, 0.1, 'triangle']],
};

export const soundOn = () => on;

export function toggleSound() {
  on = !on;
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* ignore */ }
  if (on) blip('turn');
  return on;
}

export function blip(kind) {
  if (!on || !TONES[kind]) return;
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    let t = ctx.currentTime + 0.005;
    for (const [freq, len, type] of TONES[kind]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.09, t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + len + 0.02);
      t += len * 0.8;
    }
  } catch { /* audio unavailable */ }
}

export function buzz(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* ignore */ }
}
