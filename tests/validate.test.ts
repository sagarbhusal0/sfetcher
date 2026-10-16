import { describe, expect, it } from 'vitest';
import { validateMp4Container } from '../src/media/validate.js';
import {
  __emitFFmpegLogForTests,
  createLogTape,
} from '../src/media/ffmpeg.js';

/** Minimal big-endian box writer for fixtures. */
function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}

function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n);
  return b;
}

function str(s: string): Uint8Array {
  return Uint8Array.from(s.split('').map((c) => c.charCodeAt(0)));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(...payload);
  return concat(u32(8 + body.length), str(type), body);
}

function full(type: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array {
  return box(type, concat(new Uint8Array([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), ...payload));
}

function videoTrack(): Uint8Array {
  const avcC = box('avcC', new Uint8Array([1, 66, 0, 30, 0xff, 0xe0]));
  const avc1 = box(
    'avc1',
    concat(
      new Uint8Array(6),
      u16(1),
      new Uint8Array(16),
      u16(64),
      u16(64),
      u32(0x00480000),
      u32(0x00480000),
      u32(0),
      u16(1),
      new Uint8Array(32),
      u16(0x18),
      u16(0xffff),
      avcC,
    ),
  );
  const stbl = box(
    'stbl',
    full('stsd', 0, 0, u32(1), avc1),
    full('stts', 0, 0, u32(0)),
    full('stsc', 0, 0, u32(0)),
    full('stsz', 0, 0, u32(0), u32(0)),
    full('stco', 0, 0, u32(0)),
  );
  const minf = box(
    'minf',
    full('vmhd', 0, 1, u16(0), new Uint8Array(6)),
    box('dinf', full('dref', 0, 0, u32(1), box('url ', new Uint8Array([0, 0, 0, 1])))),
    stbl,
  );
  const mdia = box(
    'mdia',
    full('mdhd', 0, 0, u32(0), u32(0), u32(90000), u32(9000), u16(0x55c4), u16(0)),
    full('hdlr', 0, 0, u32(0), str('vide'), new Uint8Array(12), str('Video\0')),
    minf,
  );
  return box(
    'trak',
    full(
      'tkhd',
      0,
      3,
      u32(0),
      u32(0),
      u32(1),
      u32(0),
      u32(6000),
      new Uint8Array(8),
      u16(0),
      u16(0),
      u16(0x0100),
      u16(0),
      concat(u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)),
      u32(64 << 16),
      u32(64 << 16),
    ),
    mdia,
  );
}

function minimalMp4(): Uint8Array {
  const ftyp = box('ftyp', concat(str('isom'), u32(0), str('isom')));
  const mvhd = full(
    'mvhd',
    0,
    0,
    u32(0),
    u32(0),
    u32(1000),
    u32(6000),
    u32(0x00010000),
    u16(0x0100),
    new Uint8Array(10),
    concat(u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)),
    new Uint8Array(24),
    u32(2),
  );
  return concat(ftyp, box('moov', mvhd, videoTrack(), box('udta')));
}

describe('validateMp4Container', () => {
  it('accepts a minimal valid MP4 with a video track', () => {
    const v = validateMp4Container(minimalMp4(), false);
    expect(v.trackCount).toBe(1);
    expect(v.hasVideo).toBe(true);
    expect(v.hasAudio).toBe(false);
    expect(v.codecs[0]).toContain('avc1');
  });

  it('rejects when the expected audio track is missing', () => {
    expect(() => validateMp4Container(minimalMp4(), true)).toThrow(/audio track is missing/);
  });

  it('rejects empty and garbage output', () => {
    expect(() => validateMp4Container(new Uint8Array(0), false)).toThrow(/empty output/);
    expect(() => validateMp4Container(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), false)).toThrow(
      /not a valid MP4|validation/,
    );
  });

  it('rejects a truncated moov', () => {
    const fullFile = minimalMp4();
    expect(() => validateMp4Container(fullFile.slice(0, 60), false)).toThrow(/valid MP4|validation/);
  });
});

describe('ffmpeg log tape', () => {
  it('keeps the last N lines across multicast listeners', () => {
    const a = createLogTape(3);
    const b = createLogTape(10);
    for (const m of ['l1', 'l2', 'l3', 'l4']) __emitFFmpegLogForTests(m);
    expect(a.tail()).toBe('l2\nl3\nl4');
    expect(b.tail()).toBe('l1\nl2\nl3\nl4');
    a.dispose();
    b.dispose();
  });

  it('stops collecting after dispose', () => {
    const tape = createLogTape();
    __emitFFmpegLogForTests('before');
    tape.dispose();
    __emitFFmpegLogForTests('after');
    expect(tape.tail()).toBe('before');
  });
});
