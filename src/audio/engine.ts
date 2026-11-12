// Audio clock, metronome, synth playback and mic capture (plan sections 3 and 8).

import { PPQ, type InputMode } from '../core/config';
import type { Song } from '../core/model';
import { sectionTicks } from '../core/model';
import { noiseFloorDb, StreamingAnalyzer, type Frame } from '../core/pitch';
import { midiToHz } from '../core/util';

export interface RecordResult {
  frames: Frame[];
  t0: number; // context time of the first count-in click
  tBarOne: number;
  stoppedAt: number; // context time when the recording ended
  noiseFloorDb: number;
  inputOffsetSec: number;
  bpm: number;
  sampleRate: number;
  outputLatency: number | null;
  baseLatency: number | null;
}

/** Mic audio of the last take. Only kept when debug capture is on. */
export interface TakeAudio {
  sampleRate: number;
  firstSample: number; // context sample index of samples[0]
  samples: Float32Array;
}

export interface RecordSession {
  stop(): void;
  done: Promise<RecordResult>;
  t0: number;
  tBarOne: number;
  tEnd: number; // in free-length mode this is the safety cap
}

export class Engine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private workletReady: Promise<void> | null = null;
  /** When true, the next recording keeps its mic audio in memory (see plan section 12). */
  debug = false;
  private takeChunks: { start: number; data: Float32Array }[] = [];

  /** Forget any kept audio. Called on a new recording, on New, and when the page is hidden. */
  clearTakeAudio(): void {
    this.takeChunks = [];
  }

  get hasTakeAudio(): boolean {
    return this.takeChunks.length > 0;
  }

  /** The kept audio as one contiguous buffer; dropouts are filled with silence. */
  takeAudio(): TakeAudio | null {
    const chunks = this.takeChunks;
    if (!chunks.length || !this.ctx) return null;
    const first = chunks[0].start;
    const last = chunks[chunks.length - 1];
    const samples = new Float32Array(last.start + last.data.length - first);
    for (const c of chunks) samples.set(c.data, c.start - first);
    return { sampleRate: this.ctx.sampleRate, firstSample: first, samples };
  }

  /** Must be called from a user gesture the first time (iOS). */
  async ensure(): Promise<AudioContext> {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    return this.ctx;
  }

  get now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /** Delay between a scheduled sound and the moment the listener hears it. */
  get outputLatency(): number {
    const c = this.ctx as (AudioContext & { outputLatency?: number }) | null;
    return (c?.outputLatency ?? 0) + (c?.baseLatency ?? 0);
  }

  /** Round-trip estimate: hear the click, react, the mic hears you later. */
  estimateInputOffset(): number {
    return this.outputLatency + 0.015;
  }

  click(t: number, accent: boolean, dest: AudioNode = this.master): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = accent ? 1760 : 1320;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(accent ? 0.25 : 0.14, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + 0.05);
  }

  voice(t: number, pitch: number, durSec: number, vel: number, dest: AudioNode = this.master): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.value = midiToHz(pitch);
    f.type = 'lowpass';
    f.frequency.value = Math.min(8000, midiToHz(pitch) * 6);
    const peak = (vel / 127) * 0.3;
    const end = t + Math.max(0.05, durSec);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
    g.gain.exponentialRampToValueAtTime(peak * 0.6, t + 0.15);
    g.gain.setValueAtTime(peak * 0.6, Math.max(t + 0.15, end - 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, end + 0.08);
    o.connect(f).connect(g).connect(dest);
    o.start(t);
    o.stop(end + 0.1);
  }

  async preview(pitch: number): Promise<void> {
    await this.ensure();
    this.voice(this.now + 0.01, pitch, 0.25, 90);
  }

  /**
   * Loop the first section. Reads the song on every tick so edits made during
   * playback are heard on the next pass.
   */
  play(getSong: () => Song, opts: { metronome: boolean }): { stop(): void; positionTick(): number } {
    const ctx = this.ctx!;
    const bus = ctx.createGain();
    bus.connect(this.master);
    const t0 = ctx.currentTime + 0.08;
    let scheduledTick = 0;

    // Tempo changes restart playback (see main.ts), so tps is constant here.
    const tick = () => {
      const song = getSong();
      const section = song.sections[0];
      const loop = sectionTicks(song, section);
      const tps = (song.tempoBpm / 60) * PPQ;
      const windowEnd = (ctx.currentTime + 0.15 - t0) * tps;
      if (windowEnd <= scheduledTick) return;
      const from = scheduledTick;
      const to = windowEnd;
      const kFrom = Math.floor(from / loop);
      const kTo = Math.floor(to / loop);
      for (let k = kFrom; k <= kTo; k++) {
        const base = k * loop;
        for (const track of section.tracks) {
          if (track.muted) continue;
          for (const n of track.notes) {
            const abs = base + n.startTick;
            if (abs >= from && abs < to) this.voice(t0 + abs / tps, n.pitch, n.durTick / tps, n.vel, bus);
          }
        }
        if (opts.metronome) {
          const beatTicks = PPQ * (4 / song.timeSig[1]);
          for (let b = 0; b < loop; b += beatTicks) {
            const abs = base + b;
            if (abs >= from && abs < to) this.click(t0 + abs / tps, b % (beatTicks * song.timeSig[0]) === 0, bus);
          }
        }
      }
      scheduledTick = to;
    };
    tick();
    const timer = window.setInterval(tick, 25);

    return {
      stop: () => {
        window.clearInterval(timer);
        bus.gain.setTargetAtTime(0, ctx.currentTime, 0.01);
        window.setTimeout(() => bus.disconnect(), 300);
      },
      positionTick: () => {
        const song = getSong();
        const loop = sectionTicks(song, song.sections[0]);
        const tps = (song.tempoBpm / 60) * PPQ;
        const t = (ctx.currentTime - this.outputLatency - t0) * tps;
        return ((t % loop) + loop) % loop;
      },
    };
  }

  async record(opts: {
    song: Song;
    mode: InputMode;
    onFrame: (f: Frame) => void;
    /** Record until stopped instead of for the section length (capped at maxBars). */
    free?: boolean;
    maxBars?: number;
  }): Promise<RecordSession> {
    const ctx = await this.ensure();
    this.clearTakeAudio();
    if (!this.workletReady) {
      this.workletReady = ctx.audioWorklet.addModule(import.meta.env.BASE_URL + 'capture-worklet.js');
    }
    await this.workletReady;

    // iOS: the audio session must allow capture *before* the mic is opened,
    // otherwise getUserMedia fails ("AudioSession category is not compatible
    // with audio capture"). Afterwards it goes back to 'auto', never 'playback',
    // so the next recording can open the mic again.
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) session.type = 'play-and-record';

    // Voice processing treats whistles as noise: switch all of it off.
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
    } catch (err) {
      if (session) session.type = 'auto';
      throw err;
    }

    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'siffle-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const sink = ctx.createGain();
    sink.gain.value = 0; // keeps the node pulled by the graph without making sound
    src.connect(node).connect(sink).connect(ctx.destination);

    const frames: Frame[] = [];
    const analyzer = new StreamingAnalyzer(ctx.sampleRate, opts.mode, (f) => {
      frames.push(f);
      opts.onFrame(f);
    });
    const keep = this.debug;
    node.port.onmessage = (e: MessageEvent<{ start: number; data: Float32Array }>) => {
      analyzer.push(e.data.data, e.data.start);
      if (keep) this.takeChunks.push({ start: e.data.start, data: e.data.data });
    };

    const song = opts.song;
    const section = song.sections[0];
    const beat = 60 / song.tempoBpm;
    const beatsPerBar = song.timeSig[0];
    const t0 = ctx.currentTime + 0.25;
    const tBarOne = t0 + beatsPerBar * beat;
    const bars = opts.free ? (opts.maxBars ?? 64) : sectionTicks(song, section) / PPQ / beatsPerBar;
    const tEnd = tBarOne + bars * beatsPerBar * beat;
    const inputOffsetSec = this.estimateInputOffset();

    // Clicks are scheduled just ahead of time, so an open-ended take does not
    // queue hundreds of them and stopping silences them at once.
    const bus = ctx.createGain();
    bus.connect(this.master);
    let nextClick = 0;
    const scheduleClicks = () => {
      for (let t = t0 + nextClick * beat; t < Math.min(tEnd - 1e-6, ctx.currentTime + 0.3); t = t0 + ++nextClick * beat) {
        this.click(t, nextClick % beatsPerBar === 0, bus);
      }
    };
    scheduleClicks();

    let resolve!: (r: RecordResult) => void;
    const done = new Promise<RecordResult>((r) => (resolve = r));
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearInterval(watch);
      bus.gain.setTargetAtTime(0, ctx.currentTime, 0.005);
      window.setTimeout(() => bus.disconnect(), 200);
      node.port.onmessage = null;
      src.disconnect();
      node.disconnect();
      sink.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      if (session) session.type = 'auto';
      const c = ctx as AudioContext & { outputLatency?: number };
      resolve({
        frames,
        stoppedAt: ctx.currentTime,
        t0,
        tBarOne,
        noiseFloorDb: noiseFloorDb(frames, t0, tBarOne),
        inputOffsetSec,
        bpm: song.tempoBpm,
        sampleRate: ctx.sampleRate,
        outputLatency: c.outputLatency ?? null,
        baseLatency: c.baseLatency ?? null,
      });
    };
    // a short tail lets the last note's release be analysed
    const watch = window.setInterval(() => {
      scheduleClicks();
      if (ctx.currentTime >= tEnd + inputOffsetSec + 0.2) finish();
    }, 50);

    return { stop: finish, done, t0, tBarOne, tEnd };
  }
}
