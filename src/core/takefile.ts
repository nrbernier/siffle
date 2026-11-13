// Test-take bundle (plan section 12): a WAV of the mic plus this JSON.
// Pure: used by the app to save takes and by the eval harness to score them.

import type { Grid } from './model';

export interface TakeNoteRef {
  startTick: number;
  durTick: number;
  pitch: number;
}

export interface TakeFile {
  schemaVersion: 1;
  name: string;
  savedAt: string;
  userAgent: string;
  mode: 'whistle' | 'voice';
  bpm: number;
  timeSig: [number, number];
  bars: number;
  grid: Grid; // the track setting when recorded, usually 'auto'
  sampleRate: number;
  firstSample: number; // context sample index of WAV sample 0
  t0: number; // context seconds of the first count-in click
  tBarOne: number; // context seconds of the first downbeat
  inputOffsetSec: number; // the latency offset the app used for this take
  measuredLatencySec?: number | null; // heard in the count-in (absent in takes saved before calibration)
  outputLatency: number | null;
  baseLatency: number | null;
  headphones: boolean;
  detected: TakeNoteRef[]; // what the app produced, before edits
  expected: TakeNoteRef[]; // the answer key, after the user's corrections
}

export function noteRefs(notes: { startTick: number; durTick: number; pitch: number }[]): TakeNoteRef[] {
  return notes
    .map(({ startTick, durTick, pitch }) => ({ startTick, durTick, pitch }))
    .sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
}

/** Safe file and folder name: lowercase letters, digits and dashes. */
export function slug(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'take'
  );
}

/** 16-bit mono PCM WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, Math.round(x < 0 ? x * 0x8000 : x * 0x7fff), true);
  }
  return new Uint8Array(buf);
}

/** Reads PCM 16-bit WAV (mono, or stereo mixed down). Skips unknown chunks. */
export function decodeWav(bytes: Uint8Array): { sampleRate: number; samples: Float32Array } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let o = 12;
  let fmt: { channels: number; sampleRate: number; bits: number; format: number } | null = null;
  while (o + 8 <= bytes.length) {
    const id = tag(o);
    const len = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      fmt = {
        format: v.getUint16(body, true),
        channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        bits: v.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before fmt chunk');
      if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('Only 16-bit PCM WAV is supported');
      const frames = Math.floor(Math.min(len, bytes.length - body) / (2 * fmt.channels));
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) sum += v.getInt16(body + (i * fmt.channels + c) * 2, true);
        samples[i] = sum / fmt.channels / 0x8000;
      }
      return { sampleRate: fmt.sampleRate, samples };
    }
    o = body + len + (len % 2);
  }
  throw new Error('WAV has no data chunk');
}
