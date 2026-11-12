import { describe, expect, it } from 'vitest';
import { decodeWav, encodeWav } from '../src/core/takefile';
import { scoreTake } from './eval/score';
import { FRERE_JACQUES, syntheticTake } from './eval/synthetic';

/** Save and reload through the WAV format, as a real take would be. */
function roundTrip(t: ReturnType<typeof syntheticTake>) {
  const { samples, sampleRate } = decodeWav(encodeWav(t.samples, t.sampleRate));
  return scoreTake(JSON.parse(JSON.stringify(t.file)), samples, sampleRate);
}

describe('wav', () => {
  it('encodes and decodes 16-bit mono within quantization error', () => {
    const x = new Float32Array([0, 0.5, -0.5, 1, -1, 0.123]);
    const { samples, sampleRate } = decodeWav(encodeWav(x, 44100));
    expect(sampleRate).toBe(44100);
    samples.forEach((v, i) => expect(v).toBeCloseTo(x[i], 3));
  });
});

describe('eval harness', () => {
  it('a perfect synthetic speaker take scores 100% with no shift', () => {
    const s = roundTrip(syntheticTake(FRERE_JACQUES));
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(1);
    expect(s.pitch).toBe(1);
    expect(s.length).toBe(1);
    expect(s.octaveErrors).toBe(0);
    expect(s.slotShift).toBe(0);
  });

  it('measures the round-trip latency from the count-in clicks', () => {
    const s = roundTrip(syntheticTake(FRERE_JACQUES, { latencySec: 0.12 }));
    expect(s.measuredLatencyMs).not.toBeNull();
    expect(Math.abs(s.measuredLatencyMs! - 120)).toBeLessThanOrEqual(5);
  });

  it('a headphone take has no latency measurement', () => {
    const s = roundTrip(syntheticTake(FRERE_JACQUES, { clickAmp: 0 }));
    expect(s.measuredLatencyMs).toBeNull();
    expect(s.recall).toBe(1);
  });

  it('an underestimated latency shows up as a slot shift', () => {
    // the app assumed 20 ms, the truth is 170 ms: about one sixteenth late at 100 bpm
    const s = roundTrip(syntheticTake(FRERE_JACQUES, { latencySec: 0.17, estLatencySec: 0.02, clickAmp: 0 }));
    expect(s.recall).toBeLessThan(1);
    expect(s.slotShift).toBe(1);
  });
});
