// ============================================================
// sound.js — page-turn sound
// ============================================================
// Plays the real recording at audio/page-flip.mp3. If that file is
// ever missing it falls back to a layered Web Audio synthesis so page
// turns still have a paper sound.

let audio = null;
let lastAt = 0;

function loadAudio() {
  if (audio) return audio;
  try {
    audio = new Audio('audio/page-flip.mp3');
    audio.load();
  } catch (err) {
    audio = null;
  }
  return audio;
}

/** Play the page-turn sound. `direction` kept for API compat / fallback. */
export function playPageTurn(direction = 1) {
  const now = performance.now();
  if (now - lastAt < 80) return;
  lastAt = now;

  const el = loadAudio();
  if (el) {
    try { el.currentTime = 0; } catch (err) { /* not ready yet */ }
    const done = el.play().then(() => true).catch(() => false);
    return done;
  }
  return fallbackSynth(direction);
}

/* ============================================================
   Fallback synthesis — used only when the mp3 is unavailable.
   ============================================================ */
let ctx = null;

function ensureCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function noiseBuffer(ac, seconds) {
  const len = Math.max(1, Math.floor(ac.sampleRate * seconds));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    last = 0.97 * last + 0.03 * white;
    d[i] = white * 0.7 + last * 0.9;
  }
  return buf;
}

function fallbackSynth(direction = 1) {
  const ac = ensureCtx();
  if (!ac) return null;

  const t0 = ac.currentTime;
  const dur = 0.42;
  const dir = direction > 0 ? 1 : -1;

  const noise = ac.createBufferSource();
  noise.buffer = noiseBuffer(ac, dur);
  noise.loop = true;

  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.8;
  lp.frequency.setValueAtTime(dir > 0 ? 2600 : 2900, t0);
  lp.frequency.exponentialRampToValueAtTime(320, t0 + dur);

  const swish = ac.createGain();
  swish.gain.setValueAtTime(0.0001, t0);
  swish.gain.exponentialRampToValueAtTime(0.3, t0 + 0.05);
  swish.gain.setValueAtTime(0.3, t0 + dur * 0.62);
  swish.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  noise.connect(lp);
  lp.connect(swish);
  swish.connect(ac.destination);
  noise.start(t0);
  noise.stop(t0 + dur + 0.05);

  const crack = ac.createBufferSource();
  crack.buffer = noiseBuffer(ac, 0.16);
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 2.2;
  bp.frequency.setValueAtTime(3800, t0);
  bp.frequency.exponentialRampToValueAtTime(2400, t0 + 0.16);

  const crunch = ac.createGain();
  const cStart = dir > 0 ? 0.06 : 0.24;
  crunch.gain.setValueAtTime(0.0001, t0 + cStart);
  crunch.gain.exponentialRampToValueAtTime(0.05, t0 + cStart + 0.015);
  crunch.gain.exponentialRampToValueAtTime(0.0001, t0 + cStart + 0.16);

  crack.connect(bp);
  bp.connect(crunch);
  crunch.connect(ac.destination);
  crack.start(t0 + cStart);
  crack.stop(t0 + cStart + 0.18);

  const thump = ac.createOscillator();
  thump.type = 'sine';
  const landAt = dir > 0 ? dur * 0.86 : 0.03;
  thump.frequency.setValueAtTime(190, t0 + landAt);
  thump.frequency.exponentialRampToValueAtTime(70, t0 + landAt + 0.14);

  const land = ac.createGain();
  land.gain.setValueAtTime(0.0001, t0 + landAt);
  land.gain.exponentialRampToValueAtTime(0.22, t0 + landAt + 0.012);
  land.gain.exponentialRampToValueAtTime(0.0001, t0 + landAt + 0.15);

  const landLow = ac.createBiquadFilter();
  landLow.type = 'lowpass';
  landLow.frequency.value = 500;

  thump.connect(landLow);
  landLow.connect(land);
  land.connect(ac.destination);
  thump.start(t0 + landAt);
  thump.stop(t0 + landAt + 0.18);
}