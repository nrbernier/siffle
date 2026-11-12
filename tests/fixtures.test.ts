// Scores the real recorded takes when the private fixtures repo is present.
// Skipped otherwise, so CI on the public repo never needs audio.

import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixturesAvailable, listTakes, loadTake, loadThresholds } from './eval/fixtures';
import { scoreTake } from './eval/score';

const takes = listTakes();
const thresholds = loadThresholds();

describe.skipIf(!fixturesAvailable() || takes.length === 0)('recorded takes', () => {
  for (const dir of takes) {
    const name = basename(dir);
    it(name, () => {
      const t = loadTake(dir);
      const s = scoreTake(t.file, t.samples, t.sampleRate);
      // Report-only until a baseline exists; then thresholds.json sets the floor per take.
      if (name in thresholds) expect(s.recall).toBeGreaterThanOrEqual(thresholds[name]);
      expect(s.expected).toBeGreaterThan(0); // every take needs an answer key
    });
  }
});
