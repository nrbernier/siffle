// Frames → notes (plan section 4). Pure: no DOM, no audio.

import { MODES, SEGMENT, type InputMode } from './config';
import type { Frame } from './pitch';
import { clamp, hzToMidi, median } from './util';

export interface RawNote {
  startSec: number;
  durSec: number;
  pitchFloat: number; // after tuning correction and octave shift
  pitch: number; // rounded MIDI number
  vel: number;
}

export interface TranscribeResult {
  notes: RawNote[];
  tuningOffset: number; // semitones the singer was sharp (+) or flat (-)
}

export function isVoiced(f: Frame, mode: InputMode, noiseFloorDb: number): boolean {
  const cfg = MODES[mode];
  return (
    f.f0 > 0 &&
    f.clarity >= cfg.clarity &&
    f.f0 >= cfg.minF &&
    f.f0 <= cfg.maxF &&
    f.rmsDb >= noiseFloorDb + SEGMENT.aboveFloorDb
  );
}

export function transcribe(frames: Frame[], mode: InputMode, noiseFloorDb: number): TranscribeResult {
  const cfg = MODES[mode];
  const n = frames.length;
  if (n === 0) return { notes: [], tuningOffset: 0 };
  const hop = n > 1 ? frames[1].t - frames[0].t : 0.01;

  const voiced = frames.map((f) => isVoiced(f, mode, noiseFloorDb));
  const raw = frames.map((f, i) => (voiced[i] ? hzToMidi(f.f0) : NaN));

  // 1. median smoothing over 5 frames
  const m = raw.map((_v, i) => {
    if (!voiced[i]) return NaN;
    const w: number[] = [];
    for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < n && voiced[j]) w.push(raw[j]);
    return median(w);
  });

  // 2. undo short octave slips against a wider local median
  const fixed = m.map((v, i) => {
    if (!voiced[i]) return NaN;
    const w: number[] = [];
    for (let j = i - SEGMENT.octaveWindow; j <= i + SEGMENT.octaveWindow; j++) {
      if (j >= 0 && j < n && voiced[j]) w.push(m[j]);
    }
    const diff = v - median(w);
    for (const oct of [24, 12]) {
      if (Math.abs(Math.abs(diff) - oct) < 0.7) return v - Math.sign(diff) * oct;
    }
    return v;
  });

  // 3. tuning offset: circular mean of the fractional semitone, weighted by clarity
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    if (!voiced[i]) continue;
    const w = frames[i].clarity;
    sx += w * Math.cos(2 * Math.PI * fixed[i]);
    sy += w * Math.sin(2 * Math.PI * fixed[i]);
  }
  const tuningOffset = sx === 0 && sy === 0 ? 0 : Math.atan2(sy, sx) / (2 * Math.PI);
  const p = fixed.map((v) => v - tuningOffset);

  // 4. segmentation state machine
  const groups: number[][] = [];
  let cur: number[] | null = null;
  let pendingStart = -1;
  let gap: number[] = [];
  let gapDipped = false;
  let gapUnvoiced = 0;
  let dev: number[] = [];

  const level = (g: number[]) => median(g.slice(-20).map((j) => frames[j].rmsDb));
  const pitchMedian = (g: number[]) => median(g.map((j) => p[j]).filter((v) => !Number.isNaN(v)));
  const close = () => {
    if (cur && cur.length) groups.push(cur);
    cur = null;
    gap = [];
    gapDipped = false;
    gapUnvoiced = 0;
    dev = [];
    pendingStart = -1;
  };

  for (let i = 0; i < n; i++) {
    if (!cur) {
      if (voiced[i]) {
        if (pendingStart < 0) pendingStart = i;
        if (i - pendingStart + 1 >= SEGMENT.startFrames) {
          cur = [];
          for (let j = pendingStart; j <= i; j++) cur.push(j);
          pendingStart = -1;
        }
      } else {
        pendingStart = -1;
      }
      continue;
    }

    const lvl = level(cur);
    const quiet = frames[i].rmsDb < lvl - SEGMENT.dipDb;
    if (!voiced[i] || quiet) {
      dev = []; // a deviation running into a gap is a release, not a new note
      gap.push(i);
      if (quiet) gapDipped = true;
      if (!voiced[i]) gapUnvoiced++;
      if (gapUnvoiced >= SEGMENT.endFrames) {
        close();
      } else if (gap.length > 12) {
        // long, quiet but voiced: a decrescendo, keep the note going
        cur.push(...gap.filter((j) => voiced[j]));
        gap = [];
        gapDipped = false;
        gapUnvoiced = 0;
      }
      continue;
    }

    if (gap.length > 0) {
      const rearticulated = gap.length >= 2 && gapDipped;
      if (rearticulated) {
        groups.push(cur);
        cur = [i];
      } else {
        cur.push(...gap.filter((j) => voiced[j]));
      }
      gap = [];
      gapDipped = false;
      gapUnvoiced = 0;
      if (rearticulated) continue;
    }

    const med = pitchMedian(cur);
    if (Math.abs(p[i] - med) > cfg.splitSemis) {
      dev.push(i);
      if (dev.length >= cfg.splitFrames) {
        // Only split once the new pitch is stable: during a glide the frames keep
        // moving, so the glide itself is dropped and we get two notes, not three.
        const tail = dev.slice(-cfg.splitFrames);
        const tm = median(tail.map((j) => p[j]));
        const stable = tail.every((j) => Math.abs(p[j] - tm) <= cfg.splitSemis * 0.7);
        if (stable || dev.length > 50) {
          groups.push(cur);
          cur = stable ? tail : dev;
          dev = [];
        }
      }
    } else {
      if (dev.length) cur.push(...dev); // a brief excursion (vibrato peak) belongs to the note
      dev = [];
      cur.push(i);
    }
  }
  if (cur) groups.push(cur);

  // 5. groups → notes
  type Tmp = RawNote & { frames: number };
  let notes: Tmp[] = groups
    .filter((g) => g.length > 0)
    .map((g) => {
      g.sort((a, b) => a - b);
      const first = g[0];
      const last = g[g.length - 1];
      const pitched = g.filter((j) => !Number.isNaN(p[j]));
      const lo = Math.floor(pitched.length * 0.2);
      const hi = Math.max(lo + 1, Math.ceil(pitched.length * 0.8));
      const pf = median(pitched.slice(lo, hi).map((j) => p[j])) + cfg.octaveShift;
      const lvl = median(g.map((j) => frames[j].rmsDb));
      const loud = (lvl - (noiseFloorDb + SEGMENT.aboveFloorDb)) / 30;
      return {
        startSec: frames[first].t,
        durSec: frames[last].t - frames[first].t + hop,
        pitchFloat: pf,
        pitch: clamp(Math.round(pf), 0, 127),
        vel: Math.round(clamp(40 + loud * 70, 40, 110)),
        frames: g.length,
      };
    });

  // 6. very short notes: merge into a close neighbour of similar pitch, else drop
  const keep: Tmp[] = [];
  for (let k = 0; k < notes.length; k++) {
    const nt = notes[k];
    if (nt.frames >= SEGMENT.minNoteFrames) {
      keep.push(nt);
      continue;
    }
    const prev = keep[keep.length - 1];
    const next = notes[k + 1];
    if (prev && nt.startSec - (prev.startSec + prev.durSec) <= SEGMENT.mergeGapSec && Math.abs(prev.pitchFloat - nt.pitchFloat) <= 1) {
      prev.durSec = nt.startSec + nt.durSec - prev.startSec;
    } else if (next && next.startSec - (nt.startSec + nt.durSec) <= SEGMENT.mergeGapSec && Math.abs(next.pitchFloat - nt.pitchFloat) <= 1) {
      next.durSec = next.startSec + next.durSec - nt.startSec;
      next.startSec = nt.startSec;
    }
  }
  notes = keep;

  return {
    notes: notes.map(({ frames: _f, ...rest }) => rest),
    tuningOffset,
  };
}
