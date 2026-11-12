// A synthetic take in the exact format the app saves, for testing the harness
// and the click-rejection path without real audio.

import { PPQ } from '../../src/core/config';
import type { TakeFile, TakeNoteRef } from '../../src/core/takefile';
import { render, SR, type ToneSpec } from '../synth';

export interface SyntheticOptions {
  bpm?: number;
  latencySec?: number; // true round trip: click heard and whistle recorded this late
  clickAmp?: number; // speaker click as heard by the mic; 0 = headphones
  estLatencySec?: number; // what the "app" assumed
  noiseDb?: number;
}

/** Whistled notes (whistle register, MIDI) placed on beats after bar one. */
export function syntheticTake(
  melody: { beat: number; beats: number; midi: number }[],
  o: SyntheticOptions = {},
): { file: TakeFile; samples: Float32Array; sampleRate: number } {
  const bpm = o.bpm ?? 100;
  const beat = 60 / bpm;
  const latency = o.latencySec ?? 0.08;
  const firstSample = 48_000; // pretend the context had run for ~1 s before recording
  const t0 = firstSample / SR + 0.3;
  const tBarOne = t0 + 4 * beat;
  const bars = 2;
  const totalSec = 0.3 + (4 + bars * 4) * beat + 0.6;

  const tones: ToneSpec[] = melody.map((m) => ({
    midi: m.midi,
    start: tBarOne - firstSample / SR + latency + m.beat * beat,
    dur: m.beats * beat * 0.8,
  }));
  const samples = render(tones, totalSec, { noiseDb: o.noiseDb ?? -60 });

  // count-in and bar clicks, as the engine plays them (square wave, 40 ms decay)
  const amp = o.clickAmp ?? 0.08;
  if (amp > 0) {
    for (let k = 0; t0 + k * beat < tBarOne + bars * 4 * beat - 1e-6; k++) {
      const at = Math.round((t0 + k * beat + latency) * SR) - firstSample;
      const f = k % 4 === 0 ? 1760 : 1320;
      for (let i = 0; i < 0.045 * SR && at + i < samples.length; i++) {
        const env = Math.min(1, i / (0.002 * SR)) * Math.exp(-i / (0.006 * SR));
        samples[at + i] += amp * env * (Math.sin((2 * Math.PI * f * i) / SR) >= 0 ? 1 : -1);
      }
    }
  }

  const expected: TakeNoteRef[] = melody.map((m) => ({
    startTick: Math.round(m.beat * PPQ),
    durTick: Math.round(m.beats * PPQ),
    pitch: m.midi - 24,
  }));

  const file: TakeFile = {
    schemaVersion: 1,
    name: 'synthetic',
    savedAt: '2026-01-01T00:00:00.000Z',
    userAgent: 'test',
    mode: 'whistle',
    bpm,
    timeSig: [4, 4],
    bars,
    grid: 'auto',
    sampleRate: SR,
    firstSample,
    t0,
    tBarOne,
    inputOffsetSec: o.estLatencySec ?? latency,
    outputLatency: null,
    baseLatency: null,
    headphones: amp === 0,
    detected: [],
    expected,
  };
  return { file, samples, sampleRate: SR };
}

/** Frère Jacques, first two bars twice over: quarters, in the whistle register. */
export const FRERE_JACQUES = [84, 86, 88, 84, 84, 86, 88, 84].map((midi, i) => ({ beat: i, beats: 1, midi }));
