// Tiny synthesized sound effects (Web Audio). Everything is generated in code: no audio files,
// no licensing questions. Muted until the player interacts (browser autoplay rules) and
// switchable in Settings.
type Cue = 'move' | 'pass' | 'tackle' | 'shot' | 'goal' | 'surge' | 'turn' | 'whistle' | 'error';

let ctx: AudioContext | null = null;
let enabled = true;

export function setSoundEnabled(v: boolean): void {
  enabled = v;
}

function audio(): AudioContext | null {
  if (!enabled) return null;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx ??= new AC();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(a: AudioContext, freq: number, start: number, dur: number, type: OscillatorType, gain: number, slideTo?: number): void {
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, start);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, start + dur);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(a.destination);
  o.start(start);
  o.stop(start + dur + 0.02);
}

function noise(a: AudioContext, start: number, dur: number, gain: number, from: number, to: number, q = 0.8): void {
  const len = Math.max(1, Math.floor(a.sampleRate * dur));
  const buf = a.createBuffer(1, len, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = q;
  f.frequency.setValueAtTime(from, start);
  f.frequency.exponentialRampToValueAtTime(to, start + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + Math.min(0.25, dur / 3));
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  src.connect(f).connect(g).connect(a.destination);
  src.start(start);
  src.stop(start + dur + 0.05);
}

export function play(cue: Cue): void {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + 0.01;
  switch (cue) {
    case 'move':
      tone(a, 420, t, 0.07, 'triangle', 0.08, 300);
      break;
    case 'pass':
      noise(a, t, 0.28, 0.12, 900, 2600, 1.2);
      tone(a, 520, t, 0.08, 'triangle', 0.06);
      break;
    case 'tackle':
      tone(a, 140, t, 0.18, 'sine', 0.25, 60);
      noise(a, t, 0.15, 0.12, 500, 200);
      break;
    case 'shot':
      tone(a, 180, t, 0.12, 'sine', 0.3, 90);
      noise(a, t, 0.35, 0.14, 1200, 3800, 1.5);
      break;
    case 'goal':
      noise(a, t, 2.2, 0.22, 500, 1400, 0.4);
      [523, 659, 784, 1047].forEach((f, i) => tone(a, f, t + 0.05 + i * 0.09, 0.35, 'triangle', 0.08));
      break;
    case 'surge':
      tone(a, 220, t, 0.4, 'sawtooth', 0.06, 880);
      tone(a, 330, t + 0.05, 0.35, 'triangle', 0.05, 990);
      break;
    case 'turn':
      tone(a, 660, t, 0.12, 'sine', 0.06);
      tone(a, 880, t + 0.08, 0.14, 'sine', 0.05);
      break;
    case 'whistle':
      tone(a, 2100, t, 0.25, 'sine', 0.07, 2300);
      tone(a, 2100, t + 0.3, 0.45, 'sine', 0.07, 2250);
      break;
    case 'error':
      tone(a, 200, t, 0.12, 'square', 0.04, 170);
      break;
  }
}
