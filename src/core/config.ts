// All tuning constants live here. Every value is a starting point, tuned
// against the synthetic fixtures in tests/ (see the plan, section 1).

export const PPQ = 480; // ticks per quarter note

export const ANALYSIS = {
  hopSec: 0.01, // one feature frame every 10 ms
  yinWindow: 1024, // samples integrated by YIN (the full buffer is window + max lag)
  yinThreshold: 0.15, // first dip of the normalized difference below this wins
  minRmsDb: -120,
};

export interface ModeConfig {
  label: string;
  minF: number;
  maxF: number;
  clarity: number; // minimum YIN clarity for a voiced frame
  octaveShift: number; // semitones added to every detected pitch
  splitSemis: number; // pitch distance from the note median that starts a new note
  splitFrames: number; // consecutive stable frames needed to confirm a pitch change
}

export const MODES = {
  whistle: {
    label: 'Whistle',
    minF: 400,
    maxF: 5000,
    clarity: 0.9,
    octaveShift: -24,
    splitSemis: 0.7,
    splitFrames: 4,
  },
  voice: {
    label: 'Hum / voice',
    minF: 70,
    maxF: 1000,
    clarity: 0.8,
    octaveShift: 0,
    splitSemis: 0.8,
    splitFrames: 6,
  },
} satisfies Record<string, ModeConfig>;

export type InputMode = keyof typeof MODES;

export const SEGMENT = {
  aboveFloorDb: 12, // a voiced frame must be this far above the noise floor
  startFrames: 3, // voiced frames needed to open a note
  endFrames: 5, // unvoiced frames that close a note
  dipDb: 6, // level drop that counts as a re-articulation
  minNoteFrames: 6, // shorter notes are merged into a neighbour or dropped
  mergeGapSec: 0.04,
  octaveWindow: 8, // half-width (frames) of the local median used to undo octave slips
};
