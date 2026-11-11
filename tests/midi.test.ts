import { describe, expect, it } from 'vitest';
import { songToMidi } from '../src/core/midi';
import { createSong } from '../src/core/model';

function readU32(b: Uint8Array, o: number) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

describe('songToMidi', () => {
  it('writes a valid type-1 file with tempo and note events', () => {
    const song = createSong();
    song.tempoBpm = 120;
    song.sections[0].tracks[0].notes = [
      { id: 'a', pitch: 60, startTick: 0, durTick: 480, vel: 90 },
      { id: 'b', pitch: 62, startTick: 480, durTick: 480, vel: 90 },
    ];
    const b = songToMidi(song);
    expect(String.fromCharCode(...b.slice(0, 4))).toBe('MThd');
    expect(readU32(b, 4)).toBe(6);
    expect((b[8] << 8) | b[9]).toBe(1); // format 1
    expect((b[10] << 8) | b[11]).toBe(2); // tempo track + melody
    expect((b[12] << 8) | b[13]).toBe(480);

    // walk chunks
    let o = 14;
    const chunks: Uint8Array[] = [];
    while (o < b.length) {
      expect(String.fromCharCode(...b.slice(o, o + 4))).toBe('MTrk');
      const len = readU32(b, o + 4);
      chunks.push(b.slice(o + 8, o + 8 + len));
      o += 8 + len;
    }
    expect(o).toBe(b.length);
    // 500000 µs per quarter = 0x07A120
    expect([...chunks[0]].join(',')).toContain([0xff, 0x51, 0x03, 0x07, 0xa1, 0x20].join(','));
    const noteOns = [...chunks[1]].filter((x, i, a) => x === 0x90 && a[i + 2] === 90).length;
    expect(noteOns).toBe(2);
  });
});
