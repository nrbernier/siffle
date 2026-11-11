// Canvas piano roll with touch editing (plan section 9).
// Tap empty space: add a note (or deselect). Tap a note: select it.
// Drag a note: move. Drag its right edge: resize. Drag empty space: pan.

import { PPQ } from '../core/config';
import type { Note } from '../core/model';
import { clamp, isBlackKey, noteName } from '../core/util';

export interface RollCallbacks {
  getNotes(): Note[];
  getLengthTicks(): number;
  getBeatsPerBar(): number;
  onAdd(tick: number, pitch: number): void;
  onMove(id: string, tick: number, pitch: number): void;
  onResize(id: string, durTick: number): void;
  onSelect(id: string | null): void;
  onPreview(pitch: number): void;
}

interface TracePoint {
  tick: number;
  pitch: number;
}

type Drag =
  | { kind: 'none' }
  | { kind: 'pending'; x: number; y: number; hit: Note | null; edge: boolean; sx: number; sy: number }
  | { kind: 'pan'; x: number; y: number; sx: number; sy: number }
  | { kind: 'move'; note: Note; dTick: number; dPitch: number; x: number; y: number; lastPitch: number }
  | { kind: 'resize'; note: Note; dur: number; x: number };

const MIN_PITCH = 24;
const MAX_PITCH = 108;

export class PianoRoll {
  pxPerBeat = 64;
  rowH = 24;
  gutter = 44;
  scrollX = 0;
  scrollY = 0;
  snap = PPQ / 4;
  newNoteTicks = PPQ / 2;
  selectedId: string | null = null;
  playhead: number | null = null;
  trace: TracePoint[] = [];
  recording = false;

  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private drag: Drag = { kind: 'none' };
  private colors: Record<string, string> = {};
  private raf = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private cb: RollCallbacks,
  ) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.readColors());
    this.readColors();
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', () => {
      this.drag = { kind: 'none' };
      this.draw();
    });
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.resize();
    this.scrollY = (MAX_PITCH - 72) * this.rowH;
  }

  private readColors(): void {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['bg', 'row-black', 'grid', 'grid-strong', 'ink', 'ink-soft', 'note', 'note-edge', 'accent', 'gutter']) {
      this.colors[k] = cs.getPropertyValue('--' + k).trim();
    }
    this.draw();
  }

  private resize(): void {
    const parent = this.canvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    this.w = parent.clientWidth;
    this.h = parent.clientHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.clampScroll();
    this.draw();
  }

  // --- geometry -----------------------------------------------------------

  private x(tick: number): number {
    return this.gutter + (tick / PPQ) * this.pxPerBeat - this.scrollX;
  }
  private y(pitch: number): number {
    return (MAX_PITCH - pitch) * this.rowH - this.scrollY;
  }
  private tickAt(x: number): number {
    return ((x - this.gutter + this.scrollX) / this.pxPerBeat) * PPQ;
  }
  private pitchAt(y: number): number {
    return MAX_PITCH - Math.floor((y + this.scrollY) / this.rowH);
  }

  private clampScroll(): void {
    const contentW = (this.cb.getLengthTicks() / PPQ) * this.pxPerBeat + 40;
    const contentH = (MAX_PITCH - MIN_PITCH + 1) * this.rowH;
    this.scrollX = clamp(this.scrollX, 0, Math.max(0, contentW - (this.w - this.gutter)));
    this.scrollY = clamp(this.scrollY, 0, Math.max(0, contentH - this.h));
  }

  zoom(factor: number): void {
    const centerTick = this.tickAt(this.gutter + (this.w - this.gutter) / 2);
    this.pxPerBeat = clamp(this.pxPerBeat * factor, 24, 240);
    this.scrollX = (centerTick / PPQ) * this.pxPerBeat - (this.w - this.gutter) / 2;
    this.clampScroll();
    this.draw();
  }

  /** Scroll so the given pitches are in view. */
  centerOn(pitches: number[]): void {
    if (!pitches.length) return;
    const mid = (Math.min(...pitches) + Math.max(...pitches)) / 2;
    this.scrollY = (MAX_PITCH - mid) * this.rowH - this.h / 2;
    this.scrollX = 0;
    this.clampScroll();
    this.draw();
  }

  /** Keep a moving playhead on screen. */
  follow(tick: number): void {
    const x = this.x(tick);
    if (x > this.w - 30 || x < this.gutter) {
      this.scrollX = (tick / PPQ) * this.pxPerBeat - 20;
      this.clampScroll();
    }
  }

  followPitch(pitch: number): void {
    const y = this.y(pitch);
    if (y < this.rowH * 2 || y > this.h - this.rowH * 3) {
      this.scrollY = (MAX_PITCH - pitch) * this.rowH - this.h / 2;
      this.clampScroll();
    }
  }

  private hit(px: number, py: number): { note: Note | null; edge: boolean } {
    const notes = this.cb.getNotes();
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      const x0 = this.x(n.startTick);
      const x1 = this.x(n.startTick + n.durTick);
      const y0 = this.y(n.pitch);
      if (py >= y0 && py < y0 + this.rowH && px >= x0 && px <= x1 + 6) {
        const edgeZone = Math.min(14, (x1 - x0) * 0.4);
        return { note: n, edge: px >= x1 - edgeZone };
      }
    }
    return { note: null, edge: false };
  }

  // --- input --------------------------------------------------------------

  private pos(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private down(e: PointerEvent): void {
    if (this.recording) return;
    this.canvas.setPointerCapture(e.pointerId);
    const { x, y } = this.pos(e);
    const h = this.hit(x, y);
    this.drag = { kind: 'pending', x, y, hit: h.note, edge: h.edge, sx: this.scrollX, sy: this.scrollY };
  }

  private move(e: PointerEvent): void {
    const { x, y } = this.pos(e);
    const d = this.drag;
    if (d.kind === 'pending') {
      if (Math.hypot(x - d.x, y - d.y) < 7) return;
      if (d.hit && d.hit.id === this.selectedId) {
        this.drag = d.edge
          ? { kind: 'resize', note: d.hit, dur: d.hit.durTick, x: d.x }
          : { kind: 'move', note: d.hit, dTick: 0, dPitch: 0, x: d.x, y: d.y, lastPitch: d.hit.pitch };
      } else if (d.hit && d.edge) {
        this.select(d.hit.id);
        this.drag = { kind: 'resize', note: d.hit, dur: d.hit.durTick, x: d.x };
      } else if (d.hit) {
        this.select(d.hit.id);
        this.drag = { kind: 'move', note: d.hit, dTick: 0, dPitch: 0, x: d.x, y: d.y, lastPitch: d.hit.pitch };
      } else {
        this.drag = { kind: 'pan', x: d.x, y: d.y, sx: d.sx, sy: d.sy };
      }
    }
    const g = this.drag;
    if (g.kind === 'pan') {
      this.scrollX = g.sx - (x - g.x);
      this.scrollY = g.sy - (y - g.y);
      this.clampScroll();
    } else if (g.kind === 'move') {
      const len = this.cb.getLengthTicks();
      g.dTick = Math.round((((x - g.x) / this.pxPerBeat) * PPQ) / this.snap) * this.snap;
      g.dTick = clamp(g.dTick, -g.note.startTick, len - g.note.startTick - this.snap);
      g.dPitch = -Math.round((y - g.y) / this.rowH);
      const p = clamp(g.note.pitch + g.dPitch, MIN_PITCH, MAX_PITCH);
      if (p !== g.lastPitch) {
        g.lastPitch = p;
        this.cb.onPreview(p);
      }
    } else if (g.kind === 'resize') {
      const len = this.cb.getLengthTicks();
      const raw = g.note.durTick + (((x - g.x) / this.pxPerBeat) * PPQ);
      g.dur = clamp(Math.round(raw / this.snap) * this.snap, this.snap, len - g.note.startTick);
    } else {
      // hover cursor on desktop
      const h = this.hit(x, y);
      this.canvas.style.cursor = h.note ? (h.edge ? 'ew-resize' : 'grab') : 'default';
      return;
    }
    this.draw();
  }

  private up(e: PointerEvent): void {
    const d = this.drag;
    this.drag = { kind: 'none' };
    if (d.kind === 'pending') {
      if (d.hit) {
        this.select(d.hit.id === this.selectedId ? null : d.hit.id);
        if (d.hit.id === this.selectedId) this.cb.onPreview(d.hit.pitch);
      } else if (this.selectedId) {
        this.select(null);
      } else {
        const { x, y } = this.pos(e);
        if (x < this.gutter) return;
        const tick = Math.floor(this.tickAt(x) / this.snap) * this.snap;
        const pitch = this.pitchAt(y);
        if (tick >= 0 && tick < this.cb.getLengthTicks() && pitch >= MIN_PITCH && pitch <= MAX_PITCH) {
          this.cb.onAdd(tick, pitch);
        }
      }
    } else if (d.kind === 'move' && (d.dTick !== 0 || d.dPitch !== 0)) {
      this.cb.onMove(d.note.id, d.note.startTick + d.dTick, clamp(d.note.pitch + d.dPitch, MIN_PITCH, MAX_PITCH));
    } else if (d.kind === 'resize' && d.dur !== d.note.durTick) {
      this.cb.onResize(d.note.id, d.dur);
    }
    this.draw();
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    if (e.ctrlKey) {
      this.zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
      return;
    }
    if (e.shiftKey) this.scrollX += e.deltaY;
    else {
      this.scrollX += e.deltaX;
      this.scrollY += e.deltaY;
    }
    this.clampScroll();
    this.draw();
  }

  select(id: string | null): void {
    this.selectedId = id;
    this.cb.onSelect(id);
    this.draw();
  }

  // --- drawing ------------------------------------------------------------

  draw(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.paint();
    });
  }

  private paint(): void {
    const { ctx, w, h, colors: c } = this;
    const len = this.cb.getLengthTicks();
    const bpb = this.cb.getBeatsPerBar();
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, w, h);

    const top = Math.min(MAX_PITCH, this.pitchAt(0));
    const bottom = Math.max(MIN_PITCH, this.pitchAt(h));
    const endX = this.x(len);

    // rows
    for (let p = top; p >= bottom; p--) {
      const y = this.y(p);
      if (isBlackKey(p)) {
        ctx.fillStyle = c['row-black'];
        ctx.fillRect(this.gutter, y, Math.min(w, endX) - this.gutter, this.rowH);
      }
      if (p % 12 === 0) {
        ctx.fillStyle = c['grid-strong'];
        ctx.fillRect(this.gutter, y + this.rowH - 1, Math.min(w, endX) - this.gutter, 1);
      }
    }

    // vertical lines: sixteenths, beats, bars
    const step = PPQ / 4;
    const firstTick = Math.max(0, Math.floor(this.tickAt(this.gutter) / step) * step);
    for (let t = firstTick; t <= len; t += step) {
      const x = Math.round(this.x(t)) + 0.5;
      if (x > w) break;
      if (x < this.gutter) continue;
      const isBar = t % (PPQ * bpb) === 0;
      const isBeat = t % PPQ === 0;
      if (!isBeat && this.pxPerBeat < 40) continue;
      ctx.strokeStyle = isBar ? c['grid-strong'] : c.grid;
      ctx.globalAlpha = isBar || isBeat ? 1 : 0.45;
      ctx.lineWidth = isBar ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // beyond the end of the section
    if (endX < w) {
      ctx.fillStyle = c['row-black'];
      ctx.globalAlpha = 0.6;
      ctx.fillRect(endX, 0, w - endX, h);
      ctx.globalAlpha = 1;
    }

    // notes
    const r = Math.min(6, this.rowH / 3);
    for (const n of this.cb.getNotes()) {
      let start = n.startTick;
      let pitch = n.pitch;
      let dur = n.durTick;
      const d = this.drag;
      if (d.kind === 'move' && d.note.id === n.id) {
        start += d.dTick;
        pitch = clamp(pitch + d.dPitch, MIN_PITCH, MAX_PITCH);
      }
      if (d.kind === 'resize' && d.note.id === n.id) dur = d.dur;
      const x0 = this.x(start) + 1;
      const x1 = this.x(start + dur) - 1;
      if (x1 < this.gutter || x0 > w) continue;
      const y0 = this.y(pitch) + 2;
      const selected = n.id === this.selectedId;
      ctx.fillStyle = c.note;
      ctx.globalAlpha = this.recording ? 0.35 : 1;
      roundRect(ctx, x0, y0, Math.max(4, x1 - x0), this.rowH - 4, r);
      ctx.fill();
      if (selected) {
        ctx.strokeStyle = c.accent;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        // resize grip
        ctx.fillStyle = c.bg;
        ctx.fillRect(x1 - 6, y0 + 5, 2, this.rowH - 14);
      }
      ctx.globalAlpha = 1;
    }

    // live pitch contour while recording
    if (this.trace.length > 1) {
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      let prev: TracePoint | null = null;
      for (const pt of this.trace) {
        const x = this.x(pt.tick);
        const y = (MAX_PITCH - pt.pitch + 0.5) * this.rowH - this.scrollY;
        if (prev && pt.tick - prev.tick < PPQ / 8 && Math.abs(pt.pitch - prev.pitch) < 3) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        prev = pt;
      }
      ctx.stroke();
    }

    // playhead
    if (this.playhead !== null) {
      const x = this.x(this.playhead);
      if (x >= this.gutter && x <= w) {
        ctx.fillStyle = this.recording ? c.accent : c.ink;
        ctx.fillRect(Math.round(x) - 1, 0, 2, h);
      }
    }

    // gutter with note names on every C, and E/G when rows are tall enough
    ctx.fillStyle = c.gutter;
    ctx.fillRect(0, 0, this.gutter, h);
    ctx.fillStyle = c['grid-strong'];
    ctx.fillRect(this.gutter - 1, 0, 1, h);
    ctx.font = '600 11px ' + getComputedStyle(document.body).fontFamily;
    ctx.textBaseline = 'middle';
    for (let p = top; p >= bottom; p--) {
      const isC = p % 12 === 0;
      if (!isC && this.rowH < 22) continue;
      if (!isC && p % 12 !== 7) continue;
      ctx.fillStyle = isC ? c.ink : c['ink-soft'];
      ctx.fillText(noteName(p), 6, this.y(p) + this.rowH / 2);
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
