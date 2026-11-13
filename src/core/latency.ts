// Round-trip latency from the count-in clicks (plan section 8). Pure.
//
// On a phone speaker the mic hears the metronome. The delay from a click's
// scheduled time to its arrival in the recording is exactly the offset needed
// to line the take up with the beat: output delay (click to ear) plus input
// delay (voice to timestamp). The browser's own figures are far off on iOS
// (it reported ~20 ms where the clicks arrive ~180 ms late).

export const BLOCK_SEC = 0.001;

export const LATENCY = {
  searchSec: 0.45, // look for each click this long after it was scheduled
  baselineSec: 0.12, // quiet stretch before the click used as the reference level
  riseDb: 10, // arrival = first block this far above the reference
  peakDb: 14, // a click only counts if it peaks at least this far above the reference
  minClicks: 3, // of the count-in clicks, this many must be found
  maxSpreadSec: 0.03, // and agree this closely (whistling during the count-in fails this)
};

/** Collects 1 ms energy blocks over a time window from streamed samples. Keeps numbers, not audio. */
export class EnergyBlocks {
  readonly energy: Float32Array;
  private readonly count: Uint16Array;

  constructor(
    readonly startTime: number,
    endTime: number,
    private readonly sampleRate: number,
  ) {
    const n = Math.max(0, Math.ceil((endTime - startTime) / BLOCK_SEC));
    this.energy = new Float32Array(n);
    this.count = new Uint16Array(n);
  }

  /** `startSample` is the context sample index of chunk[0]. */
  push(chunk: Float32Array, startSample: number): void {
    const n = this.energy.length;
    const t = startSample / this.sampleRate;
    if (t > this.startTime + n * BLOCK_SEC || t + chunk.length / this.sampleRate < this.startTime) return;
    for (let i = 0; i < chunk.length; i++) {
      const b = Math.floor(((startSample + i) / this.sampleRate - this.startTime) / BLOCK_SEC);
      if (b < 0) continue;
      if (b >= n) break;
      this.energy[b] += chunk[i] * chunk[i];
      this.count[b]++;
    }
  }

  /** Mean energy per block (0 where nothing arrived). */
  means(): Float32Array {
    return this.energy.map((e, i) => (this.count[i] ? e / this.count[i] : 0));
  }
}

function db(e: number): number {
  return 10 * Math.log10(e + 1e-15);
}

/**
 * Median arrival delay of the clicks, or null when they are not clearly heard
 * (headphones, a noisy room, whistling during the count-in).
 */
export function clickLatency(energy: Float32Array, startTime: number, clickTimes: number[]): number | null {
  const at = (t: number) => Math.round((t - startTime) / BLOCK_SEC);
  const found: number[] = [];
  for (const tc of clickTimes) {
    const b0 = at(tc - LATENCY.baselineSec);
    const c0 = at(tc);
    const c1 = at(tc + LATENCY.searchSec);
    if (b0 < 0 || c1 > energy.length) continue;
    const before = [...energy.subarray(b0, c0)].sort((a, b) => a - b);
    const ref = before[Math.floor(before.length / 2)];
    if (!(ref > 0)) continue;
    const win = energy.subarray(c0, c1);
    let peak = 0;
    for (const e of win) peak = Math.max(peak, e);
    if (db(peak) - db(ref) < LATENCY.peakDb) continue;
    // first block of two in a row above the rise threshold
    let onset = -1;
    for (let i = 0; i + 1 < win.length; i++) {
      if (db(win[i]) - db(ref) >= LATENCY.riseDb && db(win[i + 1]) - db(ref) >= LATENCY.riseDb) {
        onset = i;
        break;
      }
    }
    if (onset >= 0) found.push(onset * BLOCK_SEC);
  }
  if (found.length < LATENCY.minClicks) return null;
  found.sort((a, b) => a - b);
  // drop one outlier at either end if there are enough clicks
  const core = found.length >= 4 ? found.slice(1, -1) : found;
  if (core[core.length - 1] - core[0] > LATENCY.maxSpreadSec) return null;
  return core[core.length >> 1];
}

/** Count-in click times for a take. */
export function countInClicks(t0: number, bpm: number, beatsPerBar: number): number[] {
  return Array.from({ length: beatsPerBar }, (_, k) => t0 + (k * 60) / bpm);
}
