// The song model (plan section 2). Time is in ticks (PPQ per quarter note).

import { PPQ } from './config';
import { newId } from './util';

export type Grid = 'auto' | 'e' | 's' | 'et';

export interface RawTiming {
  startBeat: number; // beats after bar one, latency-corrected, before quantization
  durBeat: number;
  pitchFloat: number;
}

export interface Note {
  id: string;
  pitch: number; // MIDI
  startTick: number;
  durTick: number;
  vel: number;
  raw?: RawTiming; // present until the note is edited by hand
}

export interface Track {
  id: string;
  kind: 'melody' | 'bass' | 'chords' | 'perc';
  name: string;
  instrument: string;
  muted: boolean;
  generated: boolean;
  grid: Grid;
  notes: Note[];
}

export interface Section {
  id: string;
  name: string;
  bars: number;
  tracks: Track[];
}

export interface Song {
  schemaVersion: 1;
  id: string;
  title: string;
  tempoBpm: number;
  timeSig: [number, number];
  key: { tonicPc: number; mode: string; chosenByUser: boolean };
  sections: Section[];
  arrangement: string[];
}

export function createSong(): Song {
  const section: Section = {
    id: newId(),
    name: 'A',
    bars: 4,
    tracks: [
      {
        id: newId(),
        kind: 'melody',
        name: 'Melody',
        instrument: 'triangle',
        muted: false,
        generated: false,
        grid: 'auto',
        notes: [],
      },
    ],
  };
  return {
    schemaVersion: 1,
    id: newId(),
    title: 'Untitled',
    tempoBpm: 100,
    timeSig: [4, 4],
    key: { tonicPc: 0, mode: 'major', chosenByUser: false },
    sections: [section],
    arrangement: [section.id],
  };
}

export function sectionTicks(song: Song, section: Section): number {
  const [num, den] = song.timeSig;
  return section.bars * num * PPQ * (4 / den);
}

export function cloneSong(song: Song): Song {
  return structuredClone(song);
}

/** Loose validation for anything loaded from storage or a file. */
export function isSong(x: unknown): x is Song {
  const s = x as Song;
  return !!s && s.schemaVersion === 1 && Array.isArray(s.sections) && s.sections.length > 0;
}
