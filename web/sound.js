// Synthesised sound effects (off by default) and tiny haptics where the device supports them.
// Everything is built from oscillators and filtered noise, so there are no audio files to load.
const KEY = 'gringo.sound';
let on = false;
try { on = localStorage.getItem(KEY) === '1'; } catch { /* storage unavailable */ }
let ctx = null;
let bus = null;

export const soundOn = () => on;

export function toggleSound() {
  on = !on;
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* ignore */ }
  if (on) blip('turn');
  return on;
}

const noiseCache = new WeakMap();
function noiseBuffer(c) {
  let buf = noiseCache.get(c);
  if (!buf) {
    buf = c.createBuffer(1, Math.floor(c.sampleRate * 1.2), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(c, buf);
  }
  return buf;
}

// A short decaying-noise room, so chimes and impacts get a tail instead of stopping dead.
function reverbBuffer(c) {
  const len = Math.floor(c.sampleRate * 0.9);
  const buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2.6;
  }
  return buf;
}

// out = { dry, wet }: where voices connect. The wet send goes through the reverb.
function makeBus(c) {
  const master = c.createGain();
  master.gain.value = 1.7;
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 5;
  comp.attack.value = 0.003;
  comp.release.value = 0.15;
  const verb = c.createConvolver();
  verb.buffer = reverbBuffer(c);
  const wetGain = c.createGain();
  wetGain.gain.value = 0.55;
  const dry = c.createGain();
  const wet = c.createGain();
  dry.connect(comp);
  wet.connect(verb).connect(wetGain).connect(comp);
  // A soft clipper last, so overlapping sounds can never exceed full scale.
  const limiter = c.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / (curve.length - 1)) * 2 - 1) * 1.4) / Math.tanh(1.4);
  limiter.curve = curve;
  comp.connect(master).connect(limiter).connect(c.destination);
  return { dry, wet };
}

// One oscillator with a pitch glide and an attack/decay envelope.
function tone(c, out, t, { f, to = f, dur, type = 'sine', gain = 0.25, attack = 0.004, send = 0, lp = 0, detune = 0 }) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.detune.value = detune;
  osc.frequency.setValueAtTime(f, t);
  if (to !== f) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let node = osc;
  if (lp) {
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = lp;
    osc.connect(filter);
    node = filter;
  }
  node.connect(g);
  g.connect(out.dry);
  if (send) {
    const s = c.createGain();
    s.gain.value = send;
    g.connect(s).connect(out.wet);
  }
  osc.start(t);
  osc.stop(t + dur + 0.03);
}

// Filtered noise with a cutoff sweep: slides, thuds, cracks and whooshes.
function noise(c, out, t, { dur, gain = 0.3, type = 'bandpass', f, to = f, q = 0.9, attack = 0.003, send = 0 }) {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c);
  const filter = c.createBiquadFilter();
  filter.type = type;
  filter.Q.value = q;
  filter.frequency.setValueAtTime(f, t);
  if (to !== f) filter.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(g);
  g.connect(out.dry);
  if (send) {
    const s = c.createGain();
    s.gain.value = send;
    g.connect(s).connect(out.wet);
  }
  src.start(t, Math.random() * 0.4);
  src.stop(t + dur + 0.03);
}

const midi = (n) => 440 * 2 ** ((n - 69) / 12);

// Each sound returns its length in seconds. `t` is the start time on the context's clock.
const SOUNDS = {
  // A card sliding off the deck.
  draw(c, o, t) {
    noise(c, o, t, { dur: 0.12, gain: 0.32, type: 'highpass', f: 1500, to: 6500, q: 0.5, attack: 0.02 });
    tone(c, o, t + 0.09, { f: 520, to: 380, dur: 0.05, type: 'triangle', gain: 0.1 });
    return 0.2;
  },
  // A card turning over.
  flip(c, o, t) {
    noise(c, o, t, { dur: 0.07, gain: 0.34, f: 3800, to: 7000, q: 1.2, attack: 0.008 });
    tone(c, o, t + 0.045, { f: 1500, to: 900, dur: 0.035, type: 'triangle', gain: 0.16 });
    return 0.12;
  },
  // A card settling on the felt.
  land(c, o, t) {
    noise(c, o, t, { dur: 0.06, gain: 0.3, type: 'lowpass', f: 1400, to: 300, q: 0.7 });
    tone(c, o, t, { f: 150, to: 62, dur: 0.1, gain: 0.34 });
    return 0.14;
  },
  // A deck being riffled: a run of quick card ticks that thickens, then a tap to square it up.
  shuffle(c, o, t) {
    for (let i = 0; i < 14; i++) {
      const at = t + i * 0.042 + (i % 2) * 0.008;
      noise(c, o, at, { dur: 0.04, gain: 0.2 + i * 0.01, f: 3200 + i * 140, to: 6500, q: 1.1, attack: 0.004 });
    }
    noise(c, o, t + 0.64, { dur: 0.07, gain: 0.3, type: 'lowpass', f: 1600, to: 300, q: 0.7 });
    tone(c, o, t + 0.64, { f: 140, to: 62, dur: 0.1, gain: 0.3 });
    return 0.8;
  },
  // A hand smacking the pile.
  slap(c, o, t) {
    noise(c, o, t, { dur: 0.09, gain: 0.55, f: 2600, to: 1200, q: 0.8, attack: 0.001, send: 0.15 });
    noise(c, o, t, { dur: 0.05, gain: 0.35, type: 'highpass', f: 5000, q: 0.5, attack: 0.001 });
    tone(c, o, t, { f: 320, to: 70, dur: 0.14, gain: 0.5, attack: 0.002 });
    return 0.2;
  },
  // A wrong slap: a dull, falling thunk.
  miss(c, o, t) {
    tone(c, o, t, { f: 235, to: 150, dur: 0.2, type: 'sawtooth', gain: 0.2, lp: 700 });
    tone(c, o, t + 0.11, { f: 170, to: 95, dur: 0.28, type: 'sawtooth', gain: 0.22, lp: 520 });
    noise(c, o, t, { dur: 0.08, gain: 0.18, type: 'lowpass', f: 900, to: 250 });
    return 0.42;
  },
  // Your turn: two soft bell notes.
  turn(c, o, t) {
    for (const [i, n] of [76, 83].entries()) {
      const at = t + i * 0.1;
      tone(c, o, at, { f: midi(n), dur: 0.5, gain: 0.2, attack: 0.006, send: 0.5 });
      tone(c, o, at, { f: midi(n) * 2.01, dur: 0.28, gain: 0.07, attack: 0.004, send: 0.4 });
    }
    return 0.65;
  },
  // Gringo called: a drum hit and a rising brassy chord.
  call(c, o, t) {
    noise(c, o, t, { dur: 0.16, gain: 0.4, f: 1800, to: 500, q: 0.6, attack: 0.002, send: 0.3 });
    tone(c, o, t, { f: 130, to: 55, dur: 0.22, gain: 0.5, attack: 0.002 });
    [60, 64, 67, 72].forEach((n, i) => {
      const at = t + 0.12 + i * 0.09;
      const dur = i === 3 ? 0.7 : 0.3;
      tone(c, o, at, { f: midi(n), dur, type: 'sawtooth', gain: 0.1, attack: 0.012, lp: 2200, detune: -6, send: 0.35 });
      tone(c, o, at, { f: midi(n), dur, type: 'sawtooth', gain: 0.1, attack: 0.012, lp: 2200, detune: 6, send: 0.35 });
    });
    return 1.1;
  },
  // A power card hitting the table: sub boom, crack, whoosh, metallic ring and a rising shimmer.
  power(c, o, t) {
    tone(c, o, t, { f: 95, to: 32, dur: 0.55, gain: 0.7, attack: 0.002 });
    noise(c, o, t, { dur: 0.1, gain: 0.5, type: 'highpass', f: 2500, q: 0.5, attack: 0.001 });
    noise(c, o, t, { dur: 0.5, gain: 0.34, type: 'lowpass', f: 5200, to: 160, q: 0.8, attack: 0.004, send: 0.3 });
    tone(c, o, t + 0.01, { f: 740, dur: 0.7, gain: 0.1, attack: 0.002, send: 0.6 });
    tone(c, o, t + 0.01, { f: 740 * 1.504, dur: 0.6, gain: 0.07, attack: 0.002, send: 0.6 });
    tone(c, o, t + 0.01, { f: 740 * 2.76, dur: 0.4, gain: 0.04, attack: 0.002, send: 0.6 });
    tone(c, o, t + 0.12, { f: 600, to: 2400, dur: 0.4, type: 'triangle', gain: 0.07, attack: 0.1, send: 0.5 });
    return 0.85;
  },
  // You won: a bright major arpeggio with sparkle.
  win(c, o, t) {
    [72, 76, 79, 84, 88].forEach((n, i) => {
      const at = t + i * 0.085;
      tone(c, o, at, { f: midi(n), dur: i === 4 ? 0.9 : 0.3, type: 'triangle', gain: 0.12, attack: 0.006, send: 0.5 });
      tone(c, o, at, { f: midi(n) * 2, dur: 0.22, gain: 0.05, send: 0.6 });
    });
    noise(c, o, t + 0.34, { dur: 0.5, gain: 0.07, type: 'highpass', f: 6000, to: 9000, attack: 0.05, send: 0.5 });
    return 1.3;
  },
  // Someone else won: a soft falling pair.
  lose(c, o, t) {
    [67, 62].forEach((n, i) => {
      tone(c, o, t + i * 0.16, { f: midi(n), dur: 0.5, type: 'triangle', gain: 0.15, attack: 0.01, lp: 1800, send: 0.4 });
    });
    return 0.8;
  },
};

// Builds the named sound on any audio context (the live one, or an offline one for tests).
export function synth(kind, c, out, t) {
  const make = SOUNDS[kind];
  return make ? make(c, out, t) : 0;
}

export function renderBus(c) {
  return makeBus(c);
}

export const SOUND_KINDS = Object.keys(SOUNDS);

export function blip(kind) {
  if (!on || !SOUNDS[kind]) return;
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    bus = bus || makeBus(ctx);
    synth(kind, ctx, bus, ctx.currentTime + 0.005);
  } catch { /* audio unavailable */ }
}

export function buzz(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* ignore */ }
}
