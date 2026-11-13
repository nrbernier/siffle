// Beats → ticks (plan section 5). Pure.

import { PPQ, SEGMENT } from './config';

const SEGMENT_MIN_PICKUP = SEGMENT.minPickupBeats * PPQ;
import type { Grid, Note, RawTiming } from './model';
import { median, newId } from './util';

export interface TakeNote {
  raw: RawTiming;
  pitch: number;
  vel: number;
}

export type ConcreteGrid = Exclude<Grid, 'auto'>;

export const GRID_TICKS: Record<ConcreteGrid, number> = {
  e: PPQ / 2,
  s: PPQ / 4,
  et: PPQ / 3,
};

export const GRID_LABELS: Record<Grid, string> = {
  auto: 'Auto',
  e: '1/8',
  s: '1/16',
  et: '1/8 triplet',
};

function posInBeat(tick: number): number {
  return (((tick % PPQ) + PPQ) % PPQ) / PPQ;
}

function distToGrid(tick: number, g: number): number {
  return Math.abs(tick - Math.round(tick / g) * g);
}

/** Median signed distance to the grid, ignored if it is half a step or more. */
function gridBias(startTicks: number[], g: number): number {
  if (startTicks.length === 0) return 0;
  const b = median(startTicks.map((t) => t - Math.round(t / g) * g));
  return Math.abs(b) >= g / 2 ? 0 : b;
}

/**
 * Pick the coarsest grid that explains the onsets. Each candidate is judged
 * after removing its own bias, so a player who is consistently late on
 * eighths is not mistaken for triplets.
 */
export function chooseGrid(startTicks: number[]): ConcreteGrid {
  if (startTicks.length === 0) return 'e';
  const fit = (g: ConcreteGrid, tol: number) => {
    const b = gridBias(startTicks, GRID_TICKS[g]);
    const shifted = startTicks.map((t) => t - b);
    return { share: shifted.filter((t) => distToGrid(t, GRID_TICKS[g]) <= tol).length / shifted.length, shifted };
  };
  const e = fit('e', 50);
  if (e.share >= 0.85) return 'e';
  const et = fit('et', 30);
  const tripletOnsets = et.shifted.filter((t) => {
    const p = posInBeat(t);
    return Math.abs(p - 1 / 3) < 0.06 || Math.abs(p - 2 / 3) < 0.06;
  }).length;
  const s = fit('s', 30);
  if (et.share >= 0.85 && tripletOnsets >= 2 && et.share > s.share) return 'et';
  // Sixteenths only when several onsets really sit on an off-beat sixteenth.
  // Real players scatter by a tenth of a beat or more around eighths; that
  // scatter alone must not switch the grid (it puts whole takes a sixteenth off).
  const offSixteenths = e.shifted.filter((t) => {
    const r = Math.abs(t - Math.round(t / GRID_TICKS.e) * GRID_TICKS.e);
    return Math.abs(r - GRID_TICKS.s) < GRID_TICKS.s * 0.35;
  }).length;
  return offSixteenths >= 2 && offSixteenths >= startTicks.length * 0.1 ? 's' : 'e';
}

export interface QuantizeResult {
  notes: Note[];
  grid: ConcreteGrid;
  biasTicks: number;
}

export function quantizeTake(take: TakeNote[], grid: Grid, lengthTicks: number): QuantizeResult {
  const items = take
    .map((n) => ({ n, start: n.raw.startBeat * PPQ, end: (n.raw.startBeat + n.raw.durBeat) * PPQ }))
    .sort((a, b) => a.start - b.start);

  const used: ConcreteGrid = grid === 'auto' ? chooseGrid(items.map((i) => i.start)) : grid;
  const g = GRID_TICKS[used];

  // 1. remove the player's consistent early/late bias
  const bias = gridBias(
    items.map((i) => i.start),
    g,
  );
  for (const i of items) {
    i.start -= bias;
    i.end -= bias;
  }

  // 2. snap onsets. A note just before the downbeat belongs to tick 0. A pickup
  // up to one beat before bar one wraps to the end of the section: the section
  // loops, so that is where an upbeat sits.
  type Slot = { n: TakeNote; slot: number; start: number; end: number };
  const slots: Slot[] = [];
  for (const i of items) {
    let slot = Math.round(i.start / g) * g + 0; // + 0 turns -0 into 0
    if (slot < 0 && i.start > -g / 2) slot = 0;
    // a pickup must be a real note, not a stray sound during the count-in
    if (slot < 0 && slot >= -PPQ && i.end - i.start >= SEGMENT_MIN_PICKUP) {
      slot += lengthTicks;
      i.start += lengthTicks;
      i.end += lengthTicks;
    }
    if (slot < 0 || slot >= lengthTicks) continue;
    slots.push({ ...i, slot });
  }
  slots.sort((a, b) => a.slot - b.slot || a.start - b.start);

  // 3. collisions: two notes on one slot
  const placed: Slot[] = [];
  for (const s of slots) {
    const prev = placed[placed.length - 1];
    if (prev && prev.slot >= s.slot) {
      const frac = (s.start - prev.slot) / g;
      if (frac > 0.6 - 1e-9 && prev.slot + g < lengthTicks) {
        s.slot = prev.slot + g;
        placed.push(s);
      } else if (s.end - s.start > prev.end - prev.start) {
        placed[placed.length - 1] = s;
      }
      continue;
    }
    placed.push(s);
  }

  // 4. durations: snap the end, at least one step, no overlap. A raw gap to the
  // next onset shorter than one step is not a rest: the note runs on to it.
  const notes: Note[] = placed.map((s, k) => {
    const next = placed[k + 1];
    const limit = next ? next.slot : lengthTicks;
    let end = Math.round(s.end / g) * g;
    if (next && next.start - s.end < g) end = limit;
    if (end - s.slot < g) end = s.slot + g;
    end = Math.min(end, limit);
    return {
      id: newId(),
      pitch: s.n.pitch,
      startTick: s.slot,
      durTick: Math.max(1, end - s.slot),
      vel: s.n.vel,
      raw: s.n.raw,
    };
  });

  return { notes, grid: used, biasTicks: bias };
}
