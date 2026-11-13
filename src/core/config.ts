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
  clarity: number; // YIN clarity that makes a frame voiced on its own
  weakClarity: number; // lower clarity accepted when the pitch agrees with its neighbours
  octaveShift: number; // semitones added to every detected pitch
  splitSemis: number; // pitch distance from the note median that starts a new note
  splitFrames: number; // consecutive stable frames needed to confirm a pitch change
}

export const MODES = {
  whistle: {
    label: 'Whistle',
    minF: 500,
    maxF: 5000,
    clarity: 0.6,
    weakClarity: 0,
    octaveShift: -24,
    splitSemis: 0.7,
    splitFrames: 4,
  },
  voice: {
    label: 'Hum / voice',
    minF: 70,
    maxF: 1000,
    clarity: 0.6,
    weakClarity: 0,
    octaveShift: 0,
    splitSemis: 0.8,
    splitFrames: 6,
  },
} satisfies Record<string, ModeConfig>;

export type InputMode = keyof typeof MODES;

export const SEGMENT = {
  // Voicing (plan section 4, retuned on real iPhone takes): phone recordings
  // without automatic gain are so quiet that loudness barely separates a note
  // from room noise. Pitch does: through a real note it stays steady even
  // when clarity dips, while noise jumps around.
  aboveFloorDb: 3, // a clearly periodic frame must be at least this far above the noise floor
  weakAboveFloorDb: -3, // a pitch-stable frame may sit this close to (or just under) the floor
  stableRadius: 3, // neighbours on each side checked for pitch agreement
  stableNeighbors: 3, // how many of them must agree
  stableSemis: 0.5, // agreement tolerance
  startFrames: 3, // voiced frames needed to open a note
  endFrames: 5, // unvoiced frames that close a note
  // Re-articulation: a deliberate new attack on the same pitch drops deep,
  // to the room noise (16-28 dB in real takes). A held whistle wobbles by up
  // to ~10 dB without meaning a new note. A dip counts if it is dipDeepDb
  // deep or reaches the noise floor, and never if it is under dipDb.
  dipDb: 6,
  dipDeepDb: 14,
  dipFloorMarginDb: 3,
  minNoteFrames: 9, // notes shorter than this (90 ms) are merged into a neighbour or dropped
  minPickupBeats: 0.25, // a note before bar one shorter than this is a stray sound, not a pickup
  mergeGapSec: 0.04,
  bridgeFrames: 8, // fragments closer than this (and without a real dip in level) may be rejoined
  sameNoteSemis: 0.5, // fragments this close in pitch are the same note
  scoopSec: 0.14, // a short slide into a note, at most 40% of that note's length, is part of it
  octaveWindow: 8, // half-width (frames) of the local median used to undo octave slips
};
