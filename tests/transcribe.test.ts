import { describe, expect, it } from 'vitest';
import { analyzeSignal, yin } from '../src/core/pitch';
import { transcribe } from '../src/core/transcribe';
import { midiToHz } from '../src/core/util';
import { render, sequence, SR } from './synth';

const FLOOR = -90; // synthetic silence; in the app this comes from the count-in

function run(sig: Float32Array, mode: 'whistle' | 'voice' = 'whistle') {
  return transcribe(analyzeSignal(sig, SR, mode), mode, FLOOR);
}

// C major scale in the whistle register (C6..C7); app shows it two octaves lower
const SCALE = [84, 86, 88, 89, 91, 93, 95, 96];

describe('yin', () => {
  it('finds a whistle-range sine', () => {
    const buf = render([{ midi: 90, start: 0, dur: 0.1 }], 0.1);
    const { f0, clarity } = yin(buf, SR, 400, 5000);
    const cents = 1200 * Math.log2(f0 / midiToHz(90));
    expect(Math.abs(cents)).toBeLessThan(5);
    expect(clarity).toBeGreaterThan(0.95);
  });

  it('finds a hummed note with harmonics', () => {
    const buf = render([{ midi: 50, start: 0, dur: 0.1, harmonics: [0.5, 0.3, 0.2] }], 0.1);
    const { f0 } = yin(buf, SR, 70, 1000);
    expect(f0).toBeCloseTo(midiToHz(50), 0);
  });
});

describe('transcribe', () => {
  it('legato scale gives one note per step, two octaves down', () => {
    const { notes } = run(render(sequence(SCALE, 0.25), 2.6));
    expect(notes.map((n) => n.pitch)).toEqual(SCALE.map((m) => m - 24));
    notes.forEach((n, i) => expect(n.startSec).toBeCloseTo(0.2 + i * 0.25, 1));
  });

  it('detuned 30 cents sharp: same pitches, offset reported', () => {
    const { notes, tuningOffset } = run(render(sequence(SCALE, 0.25), 2.6, { detuneCents: 30 }));
    expect(notes.map((n) => n.pitch)).toEqual(SCALE.map((m) => m - 24));
    expect(tuningOffset).toBeCloseTo(0.3, 1);
  });

  it('repeated note with 40 ms gaps stays separate', () => {
    const { notes } = run(render(sequence([88, 88, 88, 88], 0.25, { gapSec: 0.04 }), 1.4));
    expect(notes.map((n) => n.pitch)).toEqual([64, 64, 64, 64]);
  });

  it('vibrato of ±40 cents is one note', () => {
    const { notes } = run(render([{ midi: 88, start: 0.2, dur: 1, vibratoCents: 40, vibratoHz: 6 }], 1.4));
    expect(notes).toHaveLength(1);
    expect(notes[0].pitch).toBe(64);
  });

  it('slow glide between two notes gives two notes', () => {
    const tones = [
      { midi: 84, start: 0.2, dur: 0.35 },
      { midi: 84, toMidi: 88, start: 0.55, dur: 0.15 },
      { midi: 88, start: 0.7, dur: 0.35 },
    ];
    const { notes } = run(render(tones, 1.3));
    expect(notes.map((n) => n.pitch)).toEqual([60, 64]);
  });

  it('noise alone gives no notes', () => {
    const { notes } = run(render([], 1, { noiseDb: -30 }));
    expect(notes).toHaveLength(0);
  });

  it('a short click gives no note', () => {
    const { notes } = run(render([{ midi: 96, start: 0.3, dur: 0.015, amp: 0.8 }], 0.8));
    expect(notes).toHaveLength(0);
  });

  it('melody survives background noise', () => {
    const { notes } = run(render(sequence(SCALE, 0.25), 2.6, { noiseDb: -45 }));
    expect(notes.map((n) => n.pitch)).toEqual(SCALE.map((m) => m - 24));
  });

  // Real iPhone takes (no automatic gain) put whistles only a few dB above room
  // noise, and the pitch tracker's clarity dips in and out within a note.
  it('a quiet scale only 8 dB above the noise floor is still found', () => {
    const amp = Math.pow(10, (-54 + 8) / 20) * Math.SQRT2; // sine RMS 8 dB over the noise
    const tones = sequence(SCALE, 0.3, { gapSec: 0.06 }).map((t) => ({ ...t, amp }));
    const sig = render(tones, 2.9, { noiseDb: -54 });
    const { notes } = transcribe(analyzeSignal(sig, SR, 'whistle'), 'whistle', -54);
    expect(notes.map((n) => n.pitch)).toEqual(SCALE.map((m) => m - 24));
  });

  it('a note whose clarity drops out for 50 ms stays one note', () => {
    // As in real takes: the whistle goes breathy for a moment, the level barely changes.
    const sig = render([{ midi: 88, start: 0.2, dur: 0.8, amp: 0.05 }], 1.2, { noiseDb: -50 });
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    for (let i = Math.round(0.55 * SR); i < Math.round(0.6 * SR); i++) sig[i] = 0.06 * rnd();
    const { notes } = run(sig);
    expect(notes.map((n) => n.pitch)).toEqual([64]);
  });

  it('a real silence between two equal notes still separates them', () => {
    const { notes } = run(render(sequence([88, 88], 0.35, { gapSec: 0.05 }), 1.0, { noiseDb: -50 }));
    expect(notes).toHaveLength(2);
  });

  it('a short scoop into a long note is part of that note', () => {
    const tones = [
      { midi: 86.5, toMidi: 88, start: 0.2, dur: 0.1 },
      { midi: 88, start: 0.3, dur: 0.6 },
    ];
    const { notes } = run(render(tones, 1.2));
    expect(notes.map((n) => n.pitch)).toEqual([64]);
    expect(notes[0].startSec).toBeCloseTo(0.2, 1);
  });

  it('fast equal sixteenths are not mistaken for scoops', () => {
    const { notes } = run(render(sequence([84, 86, 88, 89, 91, 89, 88, 86], 0.125), 1.4));
    expect(notes.map((n) => n.pitch)).toEqual([60, 62, 64, 65, 67, 65, 64, 62]);
  });

  it('voice mode: hummed notes with harmonics', () => {
    const tones = sequence([48, 50, 52, 53], 0.3, { gapSec: 0.05 }).map((t) => ({ ...t, harmonics: [0.5, 0.3, 0.2] }));
    const { notes } = run(render(tones, 1.6), 'voice');
    expect(notes.map((n) => n.pitch)).toEqual([48, 50, 52, 53]);
  });
});
