import { describe, expect, it } from 'vitest';
import { chooseGrid, quantizeTake, type TakeNote } from '../src/core/quantize';
import { rawToTake } from '../src/core/take';
import { analyzeSignal } from '../src/core/pitch';
import { transcribe } from '../src/core/transcribe';
import { render, SR } from './synth';

function take(starts: number[], dur: number, pitch = 60): TakeNote[] {
  return starts.map((s) => ({ pitch, vel: 80, raw: { startBeat: s, durBeat: dur, pitchFloat: pitch } }));
}

// deterministic jitter in beats
const JITTER = [0.03, -0.05, 0.02, 0.06, -0.04, 0.01, -0.02, 0.05];

describe('quantizeTake', () => {
  it('eighths played late with jitter snap exactly to eighths', () => {
    const starts = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((b, i) => b + 0.12 + JITTER[i]);
    const r = quantizeTake(take(starts, 0.42), 'auto', 1920);
    expect(r.grid).toBe('e');
    expect(r.notes.map((n) => n.startTick)).toEqual([0, 240, 480, 720, 960, 1200, 1440, 1680]);
    expect(r.notes.every((n) => n.durTick === 240)).toBe(true);
  });

  it('sixteenth patterns choose the sixteenth grid', () => {
    const starts = [0, 0.25, 0.5, 1, 1.75, 2, 2.25, 3];
    const r = quantizeTake(take(starts, 0.2), 'auto', 1920);
    expect(r.grid).toBe('s');
    expect(r.notes.map((n) => n.startTick)).toEqual(starts.map((b) => b * 480));
  });

  it('triplets choose the triplet grid', () => {
    const starts = [0, 1 / 3, 2 / 3, 1, 4 / 3, 5 / 3, 2].map((b) => b + 0.02);
    expect(chooseGrid(starts.map((b) => b * 480))).toBe('et');
  });

  it('a note just before the downbeat lands on tick 0', () => {
    const r = quantizeTake(take([-0.1, 1, 2], 0.9), 'e', 1920);
    expect(r.notes[0].startTick).toBe(0);
  });

  it('gaps shorter than a step are closed, longer rests stay', () => {
    // 0.8 beats ends 0.2 before the next onset: closed. 0.6 beats leaves an eighth rest: kept.
    const r = quantizeTake(take([0, 1, 3], 0.8).map((n, i) => (i === 1 ? { ...n, raw: { ...n.raw, durBeat: 0.6 } } : n)), 'e', 1920);
    expect(r.notes.map((n) => [n.startTick, n.durTick])).toEqual([
      [0, 480],
      [480, 240],
      [1440, 480],
    ]);
  });

  it('requantizing from raw is stable', () => {
    const t = take([0.07, 0.55, 1.1, 1.48], 0.4);
    const a = quantizeTake(t, 's', 1920).notes.map((n) => n.startTick);
    quantizeTake(t, 'e', 1920);
    const b = quantizeTake(t, 's', 1920).notes.map((n) => n.startTick);
    expect(b).toEqual(a);
  });
});

describe('full pipeline', () => {
  it('whistled eighths at 120 BPM, 60 ms late, come out on the grid', () => {
    const bpm = 120;
    const spb = 60 / bpm;
    const tBarOne = 0.5;
    const latency = 0.06;
    const midis = [84, 86, 88, 89, 91, 89, 88, 86];
    const tones = midis.map((midi, i) => ({
      midi,
      start: tBarOne + latency + i * spb * 0.5 + JITTER[i] * 0.1,
      dur: spb * 0.5 * 0.85,
    }));
    const sig = render(tones, tBarOne + 3);
    const { notes } = transcribe(analyzeSignal(sig, SR, 'whistle'), 'whistle', -90);
    const tk = rawToTake(notes, { tBarOne, inputOffsetSec: 0, bpm });
    const q = quantizeTake(tk, 'auto', 1920);
    expect(q.notes.map((n) => n.pitch)).toEqual(midis.map((m) => m - 24));
    expect(q.notes.map((n) => n.startTick)).toEqual([0, 240, 480, 720, 960, 1200, 1440, 1680]);
  });
});
