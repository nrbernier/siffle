// Pitch and level features. Runs on raw samples and keeps only numbers:
// the streaming analyzer holds one analysis window and nothing else.

import { ANALYSIS, MODES, type InputMode } from './config';

export interface Frame {
  t: number; // seconds, centre of the analysis window, on the AudioContext clock
  f0: number; // Hz, 0 when no pitch was found
  clarity: number; // 0..1, 1 = perfectly periodic
  rmsDb: number;
}

/** YIN with cumulative mean normalisation and parabolic interpolation. */
export function yin(
  buf: Float32Array,
  sampleRate: number,
  minF: number,
  maxF: number,
  W = ANALYSIS.yinWindow,
): { f0: number; clarity: number } {
  const maxLag = Math.min(Math.floor(sampleRate / minF), buf.length - W - 2);
  const minLag = Math.max(2, Math.floor(sampleRate / maxF));
  if (maxLag <= minLag) return { f0: 0, clarity: 0 };

  let energy = 0;
  for (let j = 0; j < W; j++) energy += buf[j] * buf[j];
  if (energy < 1e-10) return { f0: 0, clarity: 0 };

  const d = new Float32Array(maxLag + 2);
  for (let tau = 1; tau <= maxLag + 1; tau++) {
    let sum = 0;
    for (let j = 0; j < W; j++) {
      const diff = buf[j] - buf[j + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  // cumulative mean normalised difference
  const c = new Float32Array(maxLag + 2);
  c[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxLag + 1; tau++) {
    running += d[tau];
    c[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }

  let tau = -1;
  for (let t = minLag; t <= maxLag; t++) {
    if (c[t] < ANALYSIS.yinThreshold) {
      while (t + 1 <= maxLag && c[t + 1] < c[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    let best = minLag;
    for (let t = minLag + 1; t <= maxLag; t++) if (c[t] < c[best]) best = t;
    tau = best;
  }

  // parabolic interpolation around the minimum
  let refined = tau;
  const a = c[tau - 1];
  const b = c[tau];
  const e = c[tau + 1];
  const denom = a - 2 * b + e;
  if (denom > 0) refined = tau + (0.5 * (a - e)) / denom;

  const clarity = Math.max(0, Math.min(1, 1 - b));
  return { f0: sampleRate / refined, clarity };
}

export function rmsDb(buf: Float32Array, start: number, len: number): number {
  let s = 0;
  for (let i = start; i < start + len; i++) s += buf[i] * buf[i];
  const rms = Math.sqrt(s / len);
  return rms > 0 ? Math.max(ANALYSIS.minRmsDb, 20 * Math.log10(rms)) : ANALYSIS.minRmsDb;
}

/**
 * Turns a stream of sample chunks into one Frame per hop.
 * Samples older than one analysis window are overwritten, never stored.
 */
export class StreamingAnalyzer {
  private readonly buf: Float32Array;
  private readonly hop: number;
  private readonly W = ANALYSIS.yinWindow;
  private filled = 0;
  private sinceHop = 0;
  private abs = -1; // absolute index of the next expected sample
  private readonly minF: number;
  private readonly maxF: number;

  constructor(
    private readonly sampleRate: number,
    mode: InputMode,
    private readonly onFrame: (f: Frame) => void,
  ) {
    const cfg = MODES[mode];
    this.minF = cfg.minF;
    this.maxF = cfg.maxF;
    this.hop = Math.round(sampleRate * ANALYSIS.hopSec);
    const len = this.W + Math.ceil(sampleRate / cfg.minF) + 4;
    this.buf = new Float32Array(Math.max(2048, len));
  }

  /** `startSample` is the absolute index of chunk[0] on the context clock. */
  push(chunk: Float32Array, startSample: number): void {
    if (startSample !== this.abs) {
      // first chunk, or a dropout: restart the window
      this.filled = 0;
      this.sinceHop = 0;
      this.abs = startSample;
    }
    let off = 0;
    while (off < chunk.length) {
      const take = Math.min(chunk.length - off, this.hop - this.sinceHop);
      this.append(chunk.subarray(off, off + take));
      off += take;
      this.abs += take;
      this.sinceHop += take;
      if (this.sinceHop >= this.hop) {
        this.sinceHop = 0;
        if (this.filled >= this.buf.length) this.emit();
      }
    }
  }

  private append(s: Float32Array): void {
    const L = this.buf.length;
    if (this.filled + s.length <= L) {
      this.buf.set(s, this.filled);
      this.filled += s.length;
    } else {
      const shift = this.filled + s.length - L;
      this.buf.copyWithin(0, shift, this.filled);
      this.buf.set(s, L - s.length);
      this.filled = L;
    }
  }

  private emit(): void {
    const L = this.buf.length;
    const { f0, clarity } = yin(this.buf, this.sampleRate, this.minF, this.maxF, this.W);
    const level = rmsDb(this.buf, L - this.W, this.W);
    const t = (this.abs - L / 2) / this.sampleRate;
    this.onFrame({ t, f0, clarity, rmsDb: level });
  }
}

/** Offline helper (tests, debugging): analyse a whole signal. */
export function analyzeSignal(
  samples: Float32Array,
  sampleRate: number,
  mode: InputMode,
  chunk = 1024,
): Frame[] {
  const frames: Frame[] = [];
  const a = new StreamingAnalyzer(sampleRate, mode, (f) => frames.push(f));
  for (let i = 0; i < samples.length; i += chunk) {
    a.push(samples.subarray(i, Math.min(samples.length, i + chunk)), i);
  }
  return frames;
}
