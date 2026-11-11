// Standard MIDI File writer, type 1 (plan section 10). Pure.

import { PPQ } from './config';
import type { Song } from './model';
import { sectionTicks } from './model';

const GM_PROGRAM: Record<string, number> = {
  triangle: 73, // flute
  piano: 0,
  bass: 33,
};

function vlq(n: number): number[] {
  let v = Math.max(0, Math.round(n));
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

function chunk(type: string, data: number[]): number[] {
  const len = data.length;
  return [
    ...[...type].map((c) => c.charCodeAt(0)),
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
    ...data,
  ];
}

type Ev = { tick: number; order: number; bytes: number[] };

function encodeTrack(events: Ev[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const out: number[] = [];
  let last = 0;
  for (const e of events) {
    out.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  out.push(0, 0xff, 0x2f, 0x00);
  return out;
}

function text(type: number, s: string): number[] {
  const bytes = [...new TextEncoder().encode(s)];
  return [0xff, type, ...vlq(bytes.length), ...bytes];
}

export function songToMidi(song: Song): Uint8Array {
  const order = song.arrangement
    .map((id) => song.sections.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => !!s);

  // track 0: tempo, time signature, section markers
  const mpq = Math.round(60_000_000 / song.tempoBpm);
  const [num, den] = song.timeSig;
  const meta: Ev[] = [
    { tick: 0, order: 0, bytes: text(0x03, song.title) },
    { tick: 0, order: 1, bytes: [0xff, 0x51, 0x03, (mpq >> 16) & 0xff, (mpq >> 8) & 0xff, mpq & 0xff] },
    { tick: 0, order: 2, bytes: [0xff, 0x58, 0x04, num, Math.log2(den), 24, 8] },
  ];
  let offset = 0;
  for (const s of order) {
    meta.push({ tick: offset, order: 3, bytes: text(0x06, s.name) });
    offset += sectionTicks(song, s);
  }
  const tracks = [encodeTrack(meta)];

  // one MIDI track per app track, matched by position within each section
  const trackCount = Math.max(...order.map((s) => s.tracks.length), 0);
  for (let ti = 0; ti < trackCount; ti++) {
    const first = order.find((s) => s.tracks[ti])!.tracks[ti];
    const channel = first.kind === 'perc' ? 9 : Math.min(ti, 8);
    const evs: Ev[] = [
      { tick: 0, order: 0, bytes: text(0x03, first.name) },
      { tick: 0, order: 1, bytes: [0xc0 | channel, GM_PROGRAM[first.instrument] ?? 0] },
    ];
    let base = 0;
    for (const s of order) {
      const tr = s.tracks[ti];
      if (tr && !tr.muted) {
        for (const n of tr.notes) {
          const on = base + n.startTick;
          evs.push({ tick: on, order: 3, bytes: [0x90 | channel, n.pitch, n.vel] });
          evs.push({ tick: on + n.durTick, order: 2, bytes: [0x80 | channel, n.pitch, 0] });
        }
      }
      base += sectionTicks(song, s);
    }
    tracks.push(encodeTrack(evs));
  }

  const header = chunk('MThd', [0, 1, (tracks.length >> 8) & 0xff, tracks.length & 0xff, (PPQ >> 8) & 0xff, PPQ & 0xff]);
  const bytes = [...header, ...tracks.flatMap((t) => chunk('MTrk', t))];
  return new Uint8Array(bytes);
}
