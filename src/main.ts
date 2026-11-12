import './style.css';
import { Engine, type RecordSession } from './audio/engine';
import { MODES, PPQ, type InputMode } from './core/config';
import { songToMidi } from './core/midi';
import { encodeWav, noteRefs, slug, type TakeFile, type TakeNoteRef } from './core/takefile';
import { createSong, isSong, sectionTicks, type Grid, type Note, type Song, type Track } from './core/model';
import { GRID_LABELS, GRID_TICKS, quantizeTake, type ConcreteGrid } from './core/quantize';
import { rawToTake } from './core/take';
import { isVoiced, transcribe } from './core/transcribe';
import { clamp, hzToMidi, median, newId, noteName } from './core/util';
import { PianoRoll } from './ui/pianoroll';

// Reveal the app before the canvas measures itself (see the boot note in index.html).
document.documentElement.classList.add('ready');

const STORE_KEY = 'siffle:song';
const PREFS_KEY = 'siffle:prefs';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const app = document.querySelector<HTMLElement>('.app')!;
const statusEl = $<HTMLParagraphElement>('status');

// --- state ---------------------------------------------------------------

let song: Song = load() ?? createSong();
let mode: InputMode = (loadPrefs().mode as InputMode) in MODES ? (loadPrefs().mode as InputMode) : 'whistle';
let lastGrid: ConcreteGrid | null = null;
const undoStack: string[] = [];
const engine = new Engine();
let playback: ReturnType<Engine['play']> | null = null;
let session: RecordSession | null = null;
let playRaf = 0;
let starting = false; // a recording is being set up (mic permission, worklet)
let startedAt = 0; // performance.now() when the current recording began

// Debug capture (plan section 12): ?debug=1 keeps the mic audio of the last take
// in memory so it can be saved as a test fixture. Off by default, never persisted.
const debug = new URLSearchParams(location.search).get('debug') === '1';
engine.debug = debug;
type LastTake = Omit<TakeFile, 'name' | 'savedAt' | 'headphones' | 'expected' | 'firstSample'>;
let lastTake: LastTake | null = null;

const section = () => song.sections[0];
const melody = (): Track => section().tracks[0];
const lengthTicks = () => sectionTicks(song, section());

function load(): Song | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const s = raw ? JSON.parse(raw) : null;
    return isSong(s) ? s : null;
  } catch {
    return null;
  }
}

function loadPrefs(): { mode?: string; metro?: boolean } {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function save(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(song));
    localStorage.setItem(PREFS_KEY, JSON.stringify({ mode, metro: metro.checked }));
  } catch {
    /* storage full or blocked: keep working in memory */
  }
}

/** Every user action goes through here: one action = one undo step. */
function commit(change: () => void): void {
  undoStack.push(JSON.stringify(song));
  if (undoStack.length > 50) undoStack.shift();
  change();
  afterChange();
}

function afterChange(): void {
  save();
  syncControls();
  roll.draw();
}

function undo(): void {
  const prev = undoStack.pop();
  if (!prev) return;
  song = JSON.parse(prev);
  roll.select(null);
  if (playback) restartPlayback();
  afterChange();
  say('Undone.');
}

function say(text: string, live = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('live', live);
}

// --- piano roll ----------------------------------------------------------

const roll = new PianoRoll($<HTMLCanvasElement>('roll'), {
  getNotes: () => melody().notes,
  getLengthTicks: lengthTicks,
  getBeatsPerBar: () => song.timeSig[0],
  onAdd: (tick, pitch) => {
    commit(() => {
      const notes = melody().notes;
      const next = notes.filter((n) => n.startTick > tick).sort((a, b) => a.startTick - b.startTick)[0];
      const dur = Math.min(roll.newNoteTicks, (next?.startTick ?? lengthTicks()) - tick, lengthTicks() - tick);
      // adding inside an existing note splits it
      for (const n of notes) if (n.startTick < tick && n.startTick + n.durTick > tick) n.durTick = tick - n.startTick;
      const note: Note = { id: newId(), pitch, startTick: tick, durTick: Math.max(roll.snap, dur), vel: 90 };
      notes.push(note);
      sortNotes();
    });
    preview(pitch);
  },
  onMove: (id, tick, pitch) =>
    commit(() => {
      const n = find(id);
      if (!n) return;
      n.startTick = tick;
      n.pitch = pitch;
      n.durTick = Math.min(n.durTick, lengthTicks() - tick);
      delete n.raw;
      sortNotes();
    }),
  onResize: (id, dur) =>
    commit(() => {
      const n = find(id);
      if (!n) return;
      n.durTick = dur;
      delete n.raw;
    }),
  onSelect: (id) => {
    $<HTMLButtonElement>('delete').disabled = !id;
    if (id) {
      const n = find(id);
      if (n) say(`${noteName(n.pitch)}, ${describeLength(n.durTick)}. Drag to move, drag the right edge to resize.`);
    }
  },
  onPreview: (p) => preview(p),
});

function find(id: string): Note | undefined {
  return melody().notes.find((n) => n.id === id);
}

function sortNotes(): void {
  melody().notes.sort((a, b) => a.startTick - b.startTick);
}

function preview(pitch: number): void {
  if (!session) void engine.preview(pitch);
}

function describeLength(ticks: number): string {
  const names: Record<number, string> = {
    [PPQ * 4]: 'whole note',
    [PPQ * 3]: 'dotted half',
    [PPQ * 2]: 'half note',
    [PPQ * 1.5]: 'dotted quarter',
    [PPQ]: 'quarter note',
    [PPQ * 0.75]: 'dotted eighth',
    [PPQ / 2]: 'eighth note',
    [PPQ / 3]: 'triplet eighth',
    [PPQ / 4]: 'sixteenth note',
  };
  return names[ticks] ?? `${+(ticks / PPQ).toFixed(2)} beats`;
}

// --- controls ------------------------------------------------------------

const titleEl = $<HTMLInputElement>('title');
const barsEl = $<HTMLSelectElement>('bars');
const gridEl = $<HTMLSelectElement>('grid');
const metro = $<HTMLInputElement>('metro');
metro.checked = !!loadPrefs().metro;

function syncControls(): void {
  titleEl.value = song.title;
  $('bpm').textContent = String(song.tempoBpm);
  barsEl.value = String(section().bars);
  gridEl.value = melody().grid;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
    b.setAttribute('aria-checked', String(b.dataset.mode === mode));
  }
  $<HTMLButtonElement>('undo').disabled = undoStack.length === 0;
  const sel = roll.selectedId ? find(roll.selectedId) : undefined;
  if (roll.selectedId && !sel) roll.select(null);
  $<HTMLButtonElement>('delete').disabled = !sel;
  // Editing snaps to sixteenths, or to triplets when the take is in triplets.
  const g = melody().grid;
  const concrete: ConcreteGrid = g === 'auto' ? (lastGrid ?? 's') : g;
  roll.snap = concrete === 'et' ? GRID_TICKS.et : GRID_TICKS.s;
  roll.newNoteTicks = concrete === 'et' ? GRID_TICKS.et : GRID_TICKS.e;
}

titleEl.addEventListener('change', () => commit(() => (song.title = titleEl.value.trim() || 'Untitled')));
titleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') titleEl.blur();
});

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
  b.addEventListener('click', () => {
    mode = b.dataset.mode as InputMode;
    save();
    syncControls();
  });
}

function setTempo(bpm: number): void {
  commit(() => (song.tempoBpm = clamp(Math.round(bpm), 40, 220)));
  if (playback) restartPlayback();
}

// hold to repeat
function repeatButton(el: HTMLElement, action: () => void): void {
  let timer = 0;
  let delay = 0;
  const stop = () => window.clearTimeout(timer);
  el.addEventListener('pointerdown', () => {
    action();
    delay = 400;
    const loop = () => {
      action();
      delay = Math.max(60, delay * 0.8);
      timer = window.setTimeout(loop, delay);
    };
    timer = window.setTimeout(loop, delay);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) el.addEventListener(ev, stop);
}
repeatButton($('slower'), () => setTempo(song.tempoBpm - 1));
repeatButton($('faster'), () => setTempo(song.tempoBpm + 1));

barsEl.addEventListener('change', () => {
  commit(() => {
    section().bars = Number(barsEl.value);
    const len = lengthTicks();
    for (const t of section().tracks) {
      t.notes = t.notes.filter((n) => n.startTick < len);
      for (const n of t.notes) n.durTick = Math.min(n.durTick, len - n.startTick);
    }
  });
});

gridEl.addEventListener('change', () => {
  const grid = gridEl.value as Grid;
  commit(() => {
    melody().grid = grid;
    requantize();
  });
  const g = melody().grid === 'auto' ? lastGrid : (grid as ConcreteGrid);
  say(g ? `Rhythm snapped to ${GRID_LABELS[g]} notes.` : 'Grid set.');
});

/** Re-snap the recorded notes (those not edited by hand) from their raw timing. */
function requantize(): void {
  const track = melody();
  const recorded = track.notes.filter((n) => n.raw);
  if (!recorded.length) return;
  const manual = track.notes.filter((n) => !n.raw);
  const q = quantizeTake(
    recorded.map((n) => ({ raw: n.raw!, pitch: n.pitch, vel: n.vel })),
    track.grid,
    lengthTicks(),
  );
  lastGrid = q.grid;
  track.notes = [...manual, ...q.notes];
  sortNotes();
}

function transposeAll(semis: number): void {
  const notes = melody().notes;
  if (!notes.length) return;
  const targets = notes;
  if (targets.some((n) => n.pitch + semis < 24 || n.pitch + semis > 108)) {
    say('That would go off the keyboard.');
    return;
  }
  commit(() => {
    for (const n of targets) {
      n.pitch += semis;
      if (n.raw) n.raw = { ...n.raw, pitchFloat: n.raw.pitchFloat + semis };
    }
  });
  roll.centerOn(notes.map((n) => n.pitch));
  say(semis > 0 ? 'Up an octave.' : 'Down an octave.');
}
$('octUp').addEventListener('click', () => transposeAll(12));
$('octDown').addEventListener('click', () => transposeAll(-12));

$('undo').addEventListener('click', undo);

$('delete').addEventListener('click', deleteSelected);
function deleteSelected(): void {
  const id = roll.selectedId;
  if (!id) return;
  commit(() => (melody().notes = melody().notes.filter((n) => n.id !== id)));
  roll.select(null);
  say('Note deleted.');
}

$('new').addEventListener('click', () => {
  if (melody().notes.length && !confirm('Start a new song? The current one is replaced (Undo brings it back).')) return;
  stopAll();
  forgetTake();
  commit(() => {
    const fresh = createSong();
    fresh.tempoBpm = song.tempoBpm;
    song = fresh;
  });
  say('New song. Tap the red button, wait for four clicks, then whistle.');
});

$('zoomIn').addEventListener('click', () => roll.zoom(1.25));
$('zoomOut').addEventListener('click', () => roll.zoom(0.8));
metro.addEventListener('change', () => {
  save();
  if (playback) restartPlayback();
});

// --- playback ------------------------------------------------------------

$('play').addEventListener('click', async () => {
  if (session) return;
  if (playback) {
    stopPlayback();
    return;
  }
  await engine.ensure();
  startPlayback();
});

function startPlayback(): void {
  playback = engine.play(() => song, { metronome: metro.checked });
  app.classList.add('playing');
  $('play').querySelector('span')!.textContent = 'Stop';
  const frame = () => {
    if (!playback) return;
    roll.playhead = playback.positionTick();
    roll.follow(roll.playhead);
    roll.draw();
    playRaf = requestAnimationFrame(frame);
  };
  playRaf = requestAnimationFrame(frame);
}

function stopPlayback(): void {
  playback?.stop();
  playback = null;
  cancelAnimationFrame(playRaf);
  roll.playhead = null;
  app.classList.remove('playing');
  $('play').querySelector('span')!.textContent = 'Play';
  roll.draw();
}

function restartPlayback(): void {
  stopPlayback();
  startPlayback();
}

function stopAll(): void {
  if (playback) stopPlayback();
  session?.stop();
}

// --- recording -----------------------------------------------------------

$('record').addEventListener('click', async () => {
  if (starting) return; // ignore taps while the mic is opening
  if (session) {
    // a quick double tap should not stop the take it just started
    if (performance.now() - startedAt > 600) session.stop();
    return;
  }
  if (playback) stopPlayback();
  starting = true;
  try {
    await record();
  } finally {
    starting = false;
  }
});

async function record(): Promise<void> {
  forgetTake();
  roll.select(null);
  roll.trace = [];
  const beat = 60 / song.tempoBpm;
  const beatsPerBar = song.timeSig[0];
  let floorGuess = -70;
  const countInLevels: number[] = [];
  let lastLabel = '';

  try {
    await engine.ensure();
    session = await engine.record({
      song,
      mode,
      onFrame: (f) => {
        if (!session) return;
        const offset = engine.estimateInputOffset();
        const tick = ((f.t - offset - session.tBarOne) / beat) * PPQ;
        if (tick < 0) {
          // count-in: learn the room's noise level and count down
          countInLevels.push(f.rmsDb);
          if (countInLevels.length % 10 === 0) floorGuess = Math.min(-40, median(countInLevels));
          const left = Math.ceil(-tick / PPQ);
          const label = left > 0 && left <= beatsPerBar ? `Get ready… ${left}` : 'Get ready…';
          if (label !== lastLabel) say((lastLabel = label), true);
          return;
        }
        roll.playhead = tick;
        roll.follow(tick);
        if (isVoiced(f, mode, floorGuess)) {
          const p = hzToMidi(f.f0) + MODES[mode].octaveShift;
          roll.trace.push({ tick, pitch: p });
          if (roll.trace.length % 8 === 1) roll.followPitch(p);
          const label = `Listening: ${noteName(p)}`;
          if (label !== lastLabel) say((lastLabel = label), true);
        } else if (lastLabel !== 'Listening…') {
          say((lastLabel = 'Listening…'), true);
        }
        roll.draw();
      },
    });
  } catch (err) {
    session = null;
    const name = (err as DOMException)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      say('Microphone blocked. Allow it for this site in the browser settings, then tap record again.');
    } else if (name === 'NotFoundError') {
      say('No microphone found.');
    } else {
      say('Could not start recording: ' + ((err as Error)?.message ?? String(err)));
    }
    return;
  }

  starting = false; // the session exists now: a later tap stops it
  startedAt = performance.now();
  app.classList.add('recording');
  roll.recording = true;
  roll.scrollX = 0;
  roll.draw();

  const result = await session.done;
  session = null;
  app.classList.remove('recording');
  roll.recording = false;
  roll.playhead = null;
  roll.trace = [];

  const { notes, tuningOffset } = transcribe(result.frames, mode, result.noiseFloorDb);
  const take = rawToTake(notes, result);
  const recordedGrid = melody().grid;
  const rememberTake = (detected: TakeNoteRef[]) => {
    if (!debug || !engine.hasTakeAudio) return;
    lastTake = {
      schemaVersion: 1,
      userAgent: navigator.userAgent,
      mode,
      bpm: result.bpm,
      timeSig: [...song.timeSig] as [number, number],
      bars: section().bars,
      grid: recordedGrid,
      sampleRate: result.sampleRate,
      t0: result.t0,
      tBarOne: result.tBarOne,
      inputOffsetSec: result.inputOffsetSec,
      outputLatency: result.outputLatency,
      baseLatency: result.baseLatency,
      detected,
    };
    syncDebug();
  };
  if (!take.length) {
    rememberTake([]);
    roll.draw();
    say(mode === 'whistle' ? 'No notes heard. Whistle a little louder or closer to the phone.' : 'No notes heard. Hum a little louder or closer to the phone.');
    return;
  }
  commit(() => {
    const q = quantizeTake(take, melody().grid, lengthTicks());
    lastGrid = q.grid;
    melody().notes = q.notes;
  });
  rememberTake(noteRefs(melody().notes));
  const n = melody().notes.length;
  roll.centerOn(melody().notes.map((x) => x.pitch));
  const cents = Math.round(tuningOffset * 100);
  const tuning = Math.abs(cents) < 8 ? 'in tune' : `${Math.abs(cents)} cents ${cents > 0 ? 'sharp' : 'flat'}`;
  const gridName = lastGrid ? GRID_LABELS[lastGrid] : '';
  say(`${n} note${n === 1 ? '' : 's'} on a ${gridName} grid, ${tuning}. Tap Play to hear it.`);
}

// --- export --------------------------------------------------------------

$('export').addEventListener('click', async () => {
  if (!section().tracks.some((t) => t.notes.length)) {
    say('Nothing to export yet. Record or add some notes first.');
    return;
  }
  const bytes = songToMidi(song);
  const name = (song.title.trim() || 'siffle').replace(/[^\p{L}\p{N} _-]/gu, '').trim() + '.mid';
  const file = new File([bytes as Uint8Array<ArrayBuffer>], name, { type: 'audio/midi' });
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: song.title });
      say('MIDI exported.');
      return;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  say(`Saved ${name}.`);
});

// --- debug capture -------------------------------------------------------

let sharing = false; // the share sheet can hide the page; keep the audio meanwhile
const debugBar = $<HTMLDivElement>('debugBar');
const saveTakeBtn = $<HTMLButtonElement>('saveTake');
const takeDialog = $<HTMLDialogElement>('takeDialog');
const takeName = $<HTMLInputElement>('takeName');
const takePhones = $<HTMLInputElement>('takePhones');
debugBar.hidden = !debug;
// Read-only probe for automated checks: how many mic samples are held in memory.
(window as Window & { siffleKeptSamples?: () => number }).siffleKeptSamples = () => engine.takeAudio()?.samples.length ?? 0;

function forgetTake(): void {
  engine.clearTakeAudio();
  lastTake = null;
  syncDebug();
}

function syncDebug(): void {
  saveTakeBtn.disabled = !(lastTake && engine.hasTakeAudio);
}

saveTakeBtn.addEventListener('click', () => {
  if (!lastTake) return;
  if (!takeName.value) takeName.value = `${slug(song.title === 'Untitled' ? 'take' : song.title)}-${lastTake.mode}-${lastTake.bpm}`;
  takeDialog.showModal();
  takeName.select();
});

// Handled on submit (still inside the tap) so iOS allows the share sheet.
takeDialog.querySelector('form')!.addEventListener('submit', async (e) => {
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== 'save' || !lastTake) return;
  const audio = engine.takeAudio();
  if (!audio) {
    say('The take audio is gone (the page was hidden or a new recording started). Record again.');
    return;
  }
  const name = slug(takeName.value);
  const file: TakeFile = {
    ...lastTake,
    name,
    savedAt: new Date().toISOString(),
    headphones: takePhones.checked,
    firstSample: audio.firstSample,
    expected: noteRefs(melody().notes),
  };
  const wav = new File([encodeWav(audio.samples, audio.sampleRate)], `${name}.wav`, { type: 'audio/wav' });
  const json = new File([JSON.stringify(file, null, 2)], `${name}.json`, { type: 'application/json' });
  await deliver([wav, json]);
  say(`Saved ${name}.wav and ${name}.json. Put both in takes/${name}/ in the fixtures repo (as take.wav and take.json).`);
});

/** Share sheet on phones, downloads elsewhere. */
async function deliver(files: File[]): Promise<void> {
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare?.({ files })) {
    sharing = true;
    try {
      await navigator.share({ files });
      return;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return;
    } finally {
      sharing = false;
    }
  }
  files.forEach((f, i) =>
    window.setTimeout(() => {
      const url = URL.createObjectURL(f);
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, i * 300),
  );
}

// --- keyboard (desktop) --------------------------------------------------

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).matches('input, select')) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && roll.selectedId) {
    e.preventDefault();
    deleteSelected();
  } else if (e.key === ' ') {
    e.preventDefault();
    $('play').click();
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
    e.preventDefault();
    undo();
  } else if (roll.selectedId && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    const n = find(roll.selectedId);
    if (!n) return;
    const p = clamp(n.pitch + (e.key === 'ArrowUp' ? 1 : -1), 24, 108);
    commit(() => {
      n.pitch = p;
      delete n.raw;
    });
    preview(p);
  } else if (e.key === 'Escape') {
    roll.select(null);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && !sharing) forgetTake();
  if (document.hidden) stopAll();
});

// --- start ---------------------------------------------------------------

syncControls();
if (melody().notes.length) {
  roll.centerOn(melody().notes.map((n) => n.pitch));
  say('Welcome back. Your last song is loaded.');
}
