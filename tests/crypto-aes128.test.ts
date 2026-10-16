import { describe, expect, it } from 'vitest';
import { coerceKeyBytes, decryptAes128, sequenceIv } from '../src/media/crypto.js';
import { parseIvHex } from '../src/manifests/hls/parser.js';

const KEY = Uint8Array.from({ length: 16 }, (_, i) => i);
const IV = Uint8Array.from({ length: 16 }, (_, i) => 0xf0 + i);

async function encrypt(plain: Uint8Array): Promise<Uint8Array> {
  // Fresh copies are ArrayBuffer-backed, satisfying BufferSource typing.
  const key = await crypto.subtle.importKey('raw', new Uint8Array(KEY), 'AES-CBC', false, [
    'encrypt',
  ]);
  const out = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: new Uint8Array(IV) },
    key,
    new Uint8Array(plain),
  );
  return new Uint8Array(out);
}

describe('sequenceIv', () => {
  it('encodes the media sequence as a 128-bit big-endian integer', () => {
    expect([...sequenceIv(0)]).toEqual(new Array(16).fill(0));
    expect([...sequenceIv(1)].slice(15)).toEqual([1]);
    expect([...sequenceIv(0x010203)].slice(13)).toEqual([1, 2, 3]);
  });

  it('rejects invalid sequence numbers', () => {
    expect(() => sequenceIv(-1)).toThrow();
    expect(() => sequenceIv(1.5)).toThrow();
  });
});

describe('parseIvHex', () => {
  it('parses full and short hex with optional 0x', () => {
    expect(parseIvHex('0x00000000000000000000000000000001')[15]).toBe(1);
    expect(parseIvHex('ff')[15]).toBe(0xff);
    expect(parseIvHex('ff')).toHaveLength(16);
  });

  it('rejects malformed IVs', () => {
    for (const bad of ['', '0x', 'zz', '0x' + 'aa'.repeat(17)]) {
      expect(() => parseIvHex(bad), bad).toThrow(/IV/);
    }
  });
});

describe('decryptAes128', () => {
  it('round-trips segments encrypted with the same key and IV', async () => {
    const plain = Uint8Array.from({ length: 64 }, (_, i) => (i * 7) % 256);
    const cipher = await encrypt(plain);
    expect(cipher).not.toEqual(plain);
    await expect(decryptAes128(cipher, KEY, IV)).resolves.toEqual(plain);
  });

  it('validates key and IV lengths', async () => {
    await expect(decryptAes128(new Uint8Array(16), new Uint8Array(8), IV)).rejects.toThrow(
      /key length/,
    );
    await expect(decryptAes128(new Uint8Array(16), KEY, new Uint8Array(8))).rejects.toThrow(
      /IV length/,
    );
  });

  it('validates fetched key files', () => {
    expect(() => coerceKeyBytes(new Uint8Array(15), 'https://e.com/k')).toThrow(/16/);
    expect(coerceKeyBytes(new Uint8Array(16), 'x')).toHaveLength(16);
  });
});
