// Finds recorded takes in the private fixtures repo. Audio never lives in this repo.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWav, type TakeFile } from '../../src/core/takefile';

export const FIXTURES_DIR = resolve(process.env.SIFFLE_FIXTURES ?? join(dirname(fileURLToPath(import.meta.url)), '../../../siffle-fixtures/takes'));

export interface LoadedTake {
  dir: string;
  file: TakeFile;
  samples: Float32Array;
  sampleRate: number;
}

export function fixturesAvailable(): boolean {
  return existsSync(FIXTURES_DIR);
}

/** Every folder under takes/ that holds take.json and take.wav. */
export function listTakes(): string[] {
  if (!fixturesAvailable()) return [];
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(FIXTURES_DIR, d.name))
    .filter((d) => existsSync(join(d, 'take.json')) && existsSync(join(d, 'take.wav')))
    .sort();
}

export function loadTake(dir: string): LoadedTake {
  const file = JSON.parse(readFileSync(join(dir, 'take.json'), 'utf8')) as TakeFile;
  if (file.schemaVersion !== 1) throw new Error(`${dir}: unknown schemaVersion ${file.schemaVersion}`);
  const { samples, sampleRate } = decodeWav(new Uint8Array(readFileSync(join(dir, 'take.wav'))));
  return { dir, file, samples, sampleRate };
}

/** Optional per-take minimum recall, in takes/../thresholds.json: { "<take folder>": 0.9 }. */
export function loadThresholds(): Record<string, number> {
  const p = join(FIXTURES_DIR, '..', 'thresholds.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}
