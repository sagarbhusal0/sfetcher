/**
 * HLS AES-128 segment decryption (identity keys only).
 *
 * Only `EXT-X-KEY:METHOD=AES-128` with no (or `identity`) KEYFORMAT is
 * supported: the key is an ordinary 16-byte file fetched over HTTP and
 * each segment is AES-128-CBC decrypted. SAMPLE-AES, key-service
 * KEYFORMATs, Widevine/FairPlay, and every other scheme remain explicit
 * errors — this module never attempts DRM circumvention.
 *
 * Decryption follows the upstream hls-downloader approach (MIT,
 * (c) 2025 Shy Alter): Web Crypto AES-CBC with the playlist IV or the
 * RFC 8216 sequence-derived IV.
 */

/** RFC 8216 4.4.2.4: absent IV means the media sequence as a 128-bit big-endian integer. */
export function sequenceIv(sequenceNumber: number): Uint8Array {
  if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 0) {
    throw new Error(`Invalid media sequence for IV derivation: ${sequenceNumber}`);
  }
  const iv = new Uint8Array(16);
  let n = sequenceNumber;
  for (let i = 15; i >= 0 && n > 0; i--) {
    iv[i] = n % 256;
    n = Math.floor(n / 256);
  }
  return iv;
}

function subtle(): SubtleCrypto {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  const s = cryptoObj?.subtle;
  if (!s) throw new Error('Web Crypto is unavailable in this context; cannot decrypt AES-128 segments');
  return s;
}

/** Decrypt one AES-128-CBC segment. Key must be exactly 16 bytes. */
export async function decryptAes128(
  data: Uint8Array,
  keyBytes: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array> {
  if (keyBytes.length !== 16) {
    throw new Error(`Invalid AES-128 key length: ${keyBytes.length} bytes (expected 16)`);
  }
  if (iv.length !== 16) {
    throw new Error(`Invalid AES-128 IV length: ${iv.length} bytes (expected 16)`);
  }
  const key = await subtle().importKey('raw', keyBytes.slice().buffer as ArrayBuffer, 'AES-CBC', false, [
    'decrypt',
  ]);
  const plain = await subtle().decrypt({ name: 'AES-CBC', iv: iv.slice() }, key, data.slice());
  return new Uint8Array(plain);
}

/** Validate a fetched key file before use (exactly 16 bytes). */
export function coerceKeyBytes(data: Uint8Array, keyUrlForError: string): Uint8Array {
  if (data.length !== 16) {
    throw new Error(
      `Invalid AES-128 key at ${keyUrlForError}: ${data.length} bytes (expected exactly 16)`,
    );
  }
  return data;
}
