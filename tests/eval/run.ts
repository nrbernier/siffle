// npm run eval — score every recorded take in the private fixtures repo.
// Usage: npm run eval [-- <name filter>] [-- --notes]
// Location: $SIFFLE_FIXTURES, default ../siffle-fixtures/takes

import { basename } from 'node:path';
import { noteName } from '../../src/core/util';
import { FIXTURES_DIR, fixturesAvailable, listTakes, loadTake } from './fixtures';
import { scoreTake, type Score } from './score';

const args = process.argv.slice(2);
const showNotes = args.includes('--notes');
const filter = args.find((a) => !a.startsWith('--'));

if (!fixturesAvailable()) {
  console.log(`No fixtures at ${FIXTURES_DIR} (set SIFFLE_FIXTURES or clone nrbernier/siffle-fixtures next to this repo). Nothing to score.`);
  process.exit(0);
}

const dirs = listTakes().filter((d) => !filter || basename(d).includes(filter));
if (!dirs.length) {
  console.log(`No takes in ${FIXTURES_DIR}${filter ? ` matching "${filter}"` : ''}.`);
  process.exit(0);
}

const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(5);
const rows: Score[] = [];
const head = ['take', 'notes', 'recall', 'prec', 'pitch', 'oct', 'len', 'shift', 'grid', 'lat est', 'lat meas'];
const table: string[][] = [];

for (const dir of dirs) {
  const name = basename(dir);
  try {
    const t = loadTake(dir);
    const s = scoreTake(t.file, t.samples, t.sampleRate);
    rows.push(s);
    table.push([
      name,
      `${s.detected}/${s.expected}`,
      pct(s.recall),
      pct(s.precision),
      pct(s.pitch),
      String(s.octaveErrors),
      pct(s.length),
      s.slotShift === 0 ? '0' : (s.slotShift > 0 ? '+' : '') + s.slotShift,
      s.grid,
      `${s.estLatencyMs} ms`,
      s.measuredLatencyMs === null ? (t.file.headphones ? 'phones' : '?') : `${s.measuredLatencyMs} ms`,
    ]);
    if (showNotes) {
      const fmt = (n: { startTick: number; durTick: number; pitch: number }) => `${noteName(n.pitch)}@${n.startTick}+${n.durTick}`;
      console.log(`\n${name}\n  expected: ${t.file.expected.map(fmt).join(' ')}\n  detected: ${s.notes.map(fmt).join(' ')}`);
    }
  } catch (e) {
    table.push([name, `error: ${(e as Error).message}`]);
  }
}

if (rows.length) {
  const sum = (k: 'matched' | 'expected' | 'detected') => rows.reduce((a, r) => a + r[k], 0);
  const matched = sum('matched');
  const weighted = (k: 'pitch' | 'length') => rows.reduce((a, r) => a + r[k] * r.matched, 0) / (matched || 1);
  table.push([
    'TOTAL',
    `${sum('detected')}/${sum('expected')}`,
    pct(matched / (sum('expected') || 1)),
    pct(matched / (sum('detected') || 1)),
    pct(weighted('pitch')),
    String(rows.reduce((a, r) => a + r.octaveErrors, 0)),
    pct(weighted('length')),
    `${rows.filter((r) => r.slotShift !== 0).length} off`,
    '',
    '',
    '',
  ]);
}

const widths = head.map((h, i) => Math.max(h.length, ...table.map((r) => (r[i] ?? '').length)));
const line = (r: string[]) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
console.log('\n' + line(head));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
table.forEach((r, i) => {
  if (i === table.length - 1 && r[0] === 'TOTAL') console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  console.log(r.length === 2 ? `${r[0]}  ${r[1]}` : line(r));
});
console.log(`\n${FIXTURES_DIR}`);
