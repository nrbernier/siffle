// Scores one recorded take against its answer key (plan section 12, step 3).
// Runs exactly the app's pipeline: analyse → transcribe → rawToTake → quantize.

import { PPQ } from '../../src/core/config';
import { clickLatency, countInClicks, EnergyBlocks } from '../../src/core/latency';
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
export function detect(f: TakeFile, samples: Float32Array, sampleRate: number, inputOffsetSec = f.inputOffsetSec) {
  if (sampleRate !== f.sampleRate) throw new Error(`${f.name}: WAV is ${sampleRate} Hz, JSON says ${f.sampleRate} Hz`);
  const frames = analyzeSignal(samples, sampleRate, f.mode, f.firstSample);
  const floor = noiseFloorDb(frames, f.t0, f.tBarOne);
  const { notes } = transcribe(frames, f.mode, floor);
  const take = rawToTake(notes, { tBarOne: f.tBarOne, inputOffsetSec, bpm: f.bpm });
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
 * Round-trip delay heard in the recording, measured exactly as the live app
 * does (src/core/latency.ts). Null when the clicks are not clearly heard.
 */
export function measureLatency(f: TakeFile, samples: Float32Array, sampleRate: number): number | null {
  const clicks = countInClicks(f.t0, f.bpm, f.timeSig[0]);
  const blocks = new EnergyBlocks(f.t0 - 0.2, clicks[clicks.length - 1] + 0.6, sampleRate);
  blocks.push(samples, f.firstSample);
  return clickLatency(blocks.means(), blocks.startTime, clicks);
}

export function scoreTake(f: TakeFile, samples: Float32Array, sampleRate: number): Score {
  // Same choice as the live app: the latency heard in the count-in when the
  // clicks are clear, otherwise the offset the app had at the time.
  const measured = measureLatency(f, samples, sampleRate);
  const { notes, grid } = detect(f, samples, sampleRate, measured ?? f.inputOffsetSec);
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
    measuredLatencyMs: measured === null ? null : Math.round(measured * 1000),
    notes,
  };
}
