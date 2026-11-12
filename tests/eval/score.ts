// Scores one recorded take against its answer key (plan section 12, step 3).
// Runs exactly the app's pipeline: analyse → transcribe → rawToTake → quantize.

import { PPQ } from '../../src/core/config';
import { analyzeSignal, noiseFloorDb } from '../../src/core/pitch';
import { GRID_TICKS, quantizeTake, type ConcreteGrid } from '../../src/core/quantize';
import { rawToTake } from '../../src/core/take';
import type { TakeFile, TakeNoteRef } from '../../src/core/takefile';
import { transcribe } from '../../src/core/transcribe';

export interface Score {
  name: string;
  expected: number;
  detected: number;
  matched: number;
  recall: number; // matched / expected
  precision: number; // matched / detected
  pitch: number; // share of matched notes with the right pitch
  octaveErrors: number; // matched notes off by exactly 12 or 24 semitones
  length: number; // share of matched notes with the right duration
  slotShift: number; // grid steps late (+) or early (-) that best explains the take; 0 = correct
  grid: ConcreteGrid;
  estLatencyMs: number; // what the app assumed
  measuredLatencyMs: number | null; // from count-in clicks heard in the WAV (speaker takes only)
  notes: TakeNoteRef[]; // what the current algorithm produces
}

export function lengthTicks(f: TakeFile): number {
  return f.bars * f.timeSig[0] * PPQ * (4 / f.timeSig[1]);
}

/** Run the app's pipeline on a take. */
export function detect(f: TakeFile, samples: Float32Array, sampleRate: number) {
  if (sampleRate !== f.sampleRate) throw new Error(`${f.name}: WAV is ${sampleRate} Hz, JSON says ${f.sampleRate} Hz`);
  const frames = analyzeSignal(samples, sampleRate, f.mode, f.firstSample);
  const floor = noiseFloorDb(frames, f.t0, f.tBarOne);
  const { notes } = transcribe(frames, f.mode, floor);
  const take = rawToTake(notes, { tBarOne: f.tBarOne, inputOffsetSec: f.inputOffsetSec, bpm: f.bpm });
  const q = quantizeTake(take, f.grid, lengthTicks(f));
  return { notes: q.notes.map(({ startTick, durTick, pitch }) => ({ startTick, durTick, pitch })), grid: q.grid };
}

/** One-to-one match on start tick, after shifting detected notes by `shift` ticks (wrapping around the loop). */
function match(expected: TakeNoteRef[], detected: TakeNoteRef[], shift: number, len: number) {
  const used = new Set<number>();
  const pairs: [TakeNoteRef, TakeNoteRef][] = [];
  for (const e of expected) {
    let best = -1;
    detected.forEach((d, i) => {
      if (used.has(i)) return;
      const start = (((d.startTick - shift) % len) + len) % len;
      if (start !== e.startTick) return;
      if (best < 0 || (d.pitch === e.pitch && detected[best].pitch !== e.pitch)) best = i;
    });
    if (best >= 0) {
      used.add(best);
      pairs.push([e, detected[best]]);
    }
  }
  return pairs;
}

/**
 * Round-trip delay heard in the recording: for each count-in click, the time
 * from its scheduled start to the moment it appears in the mic signal.
 * Only meaningful on speaker takes (with headphones the mic does not hear it).
 */
export function measureLatency(f: TakeFile, samples: Float32Array, sampleRate: number): number | null {
  const beat = 60 / f.bpm;
  const block = Math.round(sampleRate / 1000); // 1 ms energy blocks
  const delays: number[] = [];
  for (let k = 0; k < f.timeSig[0]; k++) {
    const tc = f.t0 + k * beat;
    const from = Math.round(tc * sampleRate) - f.firstSample;
    const to = from + Math.round(0.4 * sampleRate);
    if (from < 0 || to > samples.length) continue;
    const energy: number[] = [];
    for (let s = from; s + block <= to; s += block) {
      let e = 0;
      for (let j = s; j < s + block; j++) e += samples[j] * samples[j];
      energy.push(e / block);
    }
    const sorted = [...energy].sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.2)];
    const peak = sorted[sorted.length - 1];
    if (peak < 1e-7 || peak < floor * 20) continue; // click not heard
    const onset = energy.findIndex((e) => e > floor + 0.2 * (peak - floor));
    if (onset < 3) continue; // already loud when the click started (e.g. whistling during the count-in)
    delays.push(onset / 1000);
  }
  if (delays.length < 2) return null;
  delays.sort((a, b) => a - b);
  return delays[delays.length >> 1];
}

export function scoreTake(f: TakeFile, samples: Float32Array, sampleRate: number): Score {
  const { notes, grid } = detect(f, samples, sampleRate);
  const len = lengthTicks(f);
  const g = GRID_TICKS[grid];
  const atZero = match(f.expected, notes, 0, len);

  // Count pitch-correct matches: with an even rhythm and loop wrapping, starts
  // alone line up for a shift in either direction.
  const goodMatches = (shift: number) => match(f.expected, notes, shift, len).filter(([e, d]) => e.pitch === d.pitch).length;
  let slotShift = 0;
  let bestCount = goodMatches(0);
  for (const s of [-1, 1, -2, 2]) {
    const n = goodMatches(s * g);
    if (n > bestCount) {
      bestCount = n;
      slotShift = s;
    }
  }

  const share = (n: number, d: number) => (d ? n / d : 1);
  const diff = atZero.map(([e, d]) => Math.abs(d.pitch - e.pitch));
  return {
    name: f.name,
    expected: f.expected.length,
    detected: notes.length,
    matched: atZero.length,
    recall: share(atZero.length, f.expected.length),
    precision: share(atZero.length, notes.length),
    pitch: share(diff.filter((x) => x === 0).length, atZero.length),
    octaveErrors: diff.filter((x) => x === 12 || x === 24).length,
    length: share(atZero.filter(([e, d]) => e.durTick === d.durTick).length, atZero.length),
    slotShift,
    grid,
    estLatencyMs: Math.round(f.inputOffsetSec * 1000),
    measuredLatencyMs: f.headphones ? null : ((m) => (m === null ? null : Math.round(m * 1000)))(measureLatency(f, samples, sampleRate)),
    notes,
  };
}
