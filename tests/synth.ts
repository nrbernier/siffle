// Synthetic test signals: whistled or hummed notes with optional detuning,
// vibrato, glides and noise. Deterministic (seeded noise).

import { midiToHz } from '../src/core/util';

export const SR = 44100;

export interface ToneSpec {
  midi: number; // pitch actually produced (whistle register for whistle mode)
  start: number; // seconds
  dur: number; // seconds
  toMidi?: number; // linear glide target
  vibratoCents?: number;
  vibratoHz?: number;
  amp?: number;
  harmonics?: number[]; // relative amplitudes of partials 2, 3, ...
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function render(tones: ToneSpec[], totalSec: number, opts: { noiseDb?: number; detuneCents?: number } = {}): Float32Array {
  const out = new Float32Array(Math.ceil(totalSec * SR));
  const detune = (opts.detuneCents ?? 0) / 100;
  for (const t of tones) {
    const n0 = Math.floor(t.start * SR);
    const len = Math.floor(t.dur * SR);
    const amp = t.amp ?? 0.3;
    const fade = Math.floor(0.008 * SR);
    let phase = 0;
    for (let k = 0; k < len && n0 + k < out.length; k++) {
      const x = k / len;
      let m = t.midi + (t.toMidi !== undefined ? (t.toMidi - t.midi) * x : 0) + detune;
      if (t.vibratoCents) m += (t.vibratoCents / 100) * Math.sin(2 * Math.PI * (t.vibratoHz ?? 6) * (k / SR));
      phase += (2 * Math.PI * midiToHz(m)) / SR;
      let env = 1;
      if (k < fade) env = k / fade;
      if (len - k < fade) env = (len - k) / fade;
      let s = Math.sin(phase);
      t.harmonics?.forEach((h, i) => (s += h * Math.sin((i + 2) * phase)));
      out[n0 + k] += amp * env * s;
    }
  }
  if (opts.noiseDb !== undefined) {
    const r = rng(42);
    const a = Math.pow(10, opts.noiseDb / 20) * Math.sqrt(3);
    for (let i = 0; i < out.length; i++) out[i] += a * (2 * r() - 1);
  }
  return out;
}

/** A sequence of notes, back to back or separated by gaps. */
export function sequence(midis: number[], noteSec: number, opts: { gapSec?: number; startSec?: number } = {}): ToneSpec[] {
  const gap = opts.gapSec ?? 0;
  const start = opts.startSec ?? 0.2;
  return midis.map((midi, i) => ({ midi, start: start + i * noteSec, dur: noteSec - gap }));
}
