// Glue between transcription (seconds) and quantization (beats). Pure.

import type { RawNote } from './transcribe';
import type { TakeNote } from './quantize';

export interface TakeTiming {
  tBarOne: number; // context time of the first downbeat after the count-in
  inputOffsetSec: number; // round-trip latency estimate
  bpm: number;
}

export function rawToTake(notes: RawNote[], timing: TakeTiming): TakeNote[] {
  const spb = 60 / timing.bpm;
  return notes.map((n) => ({
    pitch: n.pitch,
    vel: n.vel,
    raw: {
      startBeat: (n.startSec - timing.inputOffsetSec - timing.tBarOne) / spb,
      durBeat: n.durSec / spb,
      pitchFloat: n.pitchFloat,
    },
  }));
}
