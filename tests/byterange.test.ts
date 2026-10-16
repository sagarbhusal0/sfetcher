import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseByteRangeValue, parseMediaPlaylist } from '../src/manifests/hls/parser.js';
import {
  fetchBytes,
  fetchSegmentsOrdered,
  HttpError,
  RangeMismatchError,
  sanitizeUrlForError,
} from '../src/media/segments.js';

const BASE = 'https://cdn.example.com/hls/';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => handler(String(input), init)),
  );
}

function bytes(n: number, start = 0): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (start + i) % 256);
}

function rangeHeader(init?: RequestInit): string | null {
  const h = init?.headers as Record<string, string> | undefined;
  return h?.['Range'] ?? null;
}

/** Build a Response from exact bytes (avoids BodyInit typing friction). */
function resp(data: Uint8Array, status: number, headers?: Record<string, string>): Response {
  return new Response(data.buffer as ArrayBuffer, { status, headers });
}

describe('EXT-X-BYTERANGE parsing', () => {
  it('parses explicit length@offset values', () => {
    expect(parseByteRangeValue('720@0')).toEqual({ length: 720, offset: 0 });
    expect(parseByteRangeValue('153600@8192')).toEqual({ length: 153600, offset: 8192 });
  });

  it('parses omitted offsets as null (resolved by the playlist parser)', () => {
    expect(parseByteRangeValue('720')).toEqual({ length: 720, offset: null });
  });

  it('rejects malformed values', () => {
    for (const bad of ['abc', '', '0', '0@10', '-5@10', '10@-1', '1.5@2', '@100', '10@']) {
      expect(() => parseByteRangeValue(bad), bad).toThrow(/BYTERANGE/);
    }
  });

  it('resolves explicit offsets per segment', () => {
    const p = parseMediaPlaylist(
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n' +
        '#EXT-X-BYTERANGE:100@0\n#EXTINF:6,\nmedia.bin\n' +
        '#EXT-X-BYTERANGE:200@500\n#EXTINF:6,\nmedia.bin\n#EXT-X-ENDLIST',
      BASE,
    );
    expect(p.segments.map((s) => s.byteRange)).toEqual([
      { offset: 0, length: 100 },
      { offset: 500, length: 200 },
    ]);
  });

  it('derives omitted offsets from the previous range of the same URI', () => {
    const p = parseMediaPlaylist(
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n' +
        '#EXT-X-BYTERANGE:100@0\n#EXTINF:6,\nmedia.bin\n' +
        '#EXT-X-BYTERANGE:200\n#EXTINF:6,\nmedia.bin\n' +
        '#EXT-X-BYTERANGE:50\n#EXTINF:6,\nmedia.bin\n#EXT-X-ENDLIST',
      BASE,
    );
    expect(p.segments.map((s) => s.byteRange)).toEqual([
      { offset: 0, length: 100 },
      { offset: 100, length: 200 },
      { offset: 300, length: 50 },
    ]);
  });

  it('starts omitted offsets at 0 for a never-referenced URI', () => {
    const p = parseMediaPlaylist(
      '#EXTM3U\n#EXTINF:6,\n#EXT-X-BYTERANGE:64\nseg.bin\n#EXT-X-ENDLIST',
      BASE,
    );
    expect(p.segments[0]?.byteRange).toEqual({ offset: 0, length: 64 });
  });

  it('tracks offsets independently per URI', () => {
    const p = parseMediaPlaylist(
      '#EXTM3U\n#EXT-X-BYTERANGE:100@1000\n#EXTINF:6,\na.bin\n' +
        '#EXT-X-BYTERANGE:100\n#EXTINF:6,\nb.bin\n' +
        '#EXT-X-BYTERANGE:100\n#EXTINF:6,\na.bin\n#EXT-X-ENDLIST',
      BASE,
    );
    expect(p.segments.map((s) => s.byteRange)).toEqual([
      { offset: 1000, length: 100 },
      { offset: 0, length: 100 },
      { offset: 1100, length: 100 },
    ]);
  });

  it('leaves segments without BYTERANGE untouched', () => {
    const p = parseMediaPlaylist('#EXTM3U\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST', BASE);
    expect(p.segments[0]?.byteRange).toBeNull();
  });

  it('ignores a dangling trailing BYTERANGE instead of failing the parse', () => {
    const p = parseMediaPlaylist(
      '#EXTM3U\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST\n#EXT-X-BYTERANGE:10@0',
      BASE,
    );
    expect(p.segments).toHaveLength(1);
  });

  it('parses EXT-X-MAP BYTERANGE onto following segments', () => {
    const p = parseMediaPlaylist(
      '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n' +
        '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"\n' +
        '#EXTINF:6,\nseg1.m4s\n#EXTINF:6,\nseg2.m4s\n#EXT-X-ENDLIST',
      BASE,
    );
    expect(p.segments[0]?.initSection).toContain('init.mp4');
    expect(p.segments[0]?.initByteRange).toEqual({ offset: 0, length: 720 });
    expect(p.segments[1]?.initByteRange).toEqual({ offset: 0, length: 720 });
  });

  it('resets initByteRange when a later MAP has no BYTERANGE', () => {
    const p = parseMediaPlaylist(
      '#EXTM3U\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"\n' +
        '#EXTINF:6,\nseg1.m4s\n#EXT-X-MAP:URI="init2.mp4"\n#EXTINF:6,\nseg2.m4s\n#EXT-X-ENDLIST',
      BASE,
    );
    expect(p.segments[0]?.initByteRange).toEqual({ offset: 0, length: 720 });
    expect(p.segments[1]?.initByteRange).toBeNull();
  });
});

describe('HTTP range fetching', () => {
  it('sends the Range header and accepts an exact 206', async () => {
    mockFetch((url, init) => {
      expect(rangeHeader(init)).toBe('bytes=10-19');
      return resp(bytes(10, 10), 206);
    });
    const out = await fetchBytes(`${BASE}media.bin`, {
      byteRange: { offset: 10, length: 10 },
      attempts: 1,
    });
    expect([...out]).toEqual([...bytes(10, 10)]);
  });

  it('validates the Content-Range of a 206', async () => {
    mockFetch(
      () => resp(bytes(10), 206, { 'Content-Range': 'bytes 50-59/1000' }),
    );
    await expect(
      fetchBytes(`${BASE}media.bin`, { byteRange: { offset: 10, length: 10 }, attempts: 1 }),
    ).rejects.toThrow(RangeMismatchError);
  });

  it('rejects a short 206 instead of writing a truncated fragment', async () => {
    mockFetch(() => resp(bytes(4), 206));
    await expect(
      fetchBytes(`${BASE}media.bin`, { byteRange: { offset: 0, length: 10 }, attempts: 1 }),
    ).rejects.toThrow(/holds 4 bytes/);
  });

  it('slices a 200 full-body fallback to the requested range', async () => {
    const full = bytes(100);
    mockFetch((url, init) => {
      expect(rangeHeader(init)).toBe('bytes=20-39');
      return resp(full, 200);
    });
    const out = await fetchBytes(`${BASE}media.bin`, {
      byteRange: { offset: 20, length: 20 },
      attempts: 1,
    });
    expect([...out]).toEqual([...full.slice(20, 40)]);
  });

  it('fails a 200 fallback that cannot satisfy the range', async () => {
    mockFetch(() => resp(bytes(10), 200));
    await expect(
      fetchBytes(`${BASE}media.bin`, { byteRange: { offset: 5, length: 10 }, attempts: 1 }),
    ).rejects.toThrow(RangeMismatchError);
  });

  it('fetches plain bodies unchanged (no range)', async () => {
    const full = bytes(32);
    mockFetch((url, init) => {
      expect(rangeHeader(init)).toBeNull();
      return resp(full, 200);
    });
    const out = await fetchBytes(`${BASE}seg.ts`, { attempts: 1 });
    expect([...out]).toEqual([...full]);
  });
});

describe('typed errors, retry, cancellation', () => {
  it('reports HTTP failures with resource type and sanitized URL', async () => {
    const fetchFn = vi.fn(async () => new Response('denied', { status: 403 }));
    vi.stubGlobal('fetch', fetchFn);
    const err = await fetchBytes(`${BASE}v.m3u8?token=secret&x=1`, {
      resourceType: 'variant',
      attempts: 3,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect((err as HttpError).resourceType).toBe('variant');
    expect((err as Error).message).toContain('variant playlist');
    expect((err as Error).message).not.toContain('secret');
    expect((err as Error).message).toContain('https://cdn.example.com/hls/v.m3u8');
    // Permanent failure: no retry.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('never retries 404', async () => {
    const fetchFn = vi.fn(async () => new Response('nope', { status: 404 }));
    vi.stubGlobal('fetch', fetchFn);
    await expect(fetchBytes(`${BASE}seg.ts`, { resourceType: 'video' })).rejects.toThrow(HttpError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries transient 500s with bounded attempts and then succeeds', async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return calls < 3 ? new Response('err', { status: 500 }) : resp(bytes(8), 200);
    });
    const out = await fetchBytes(`${BASE}seg.ts`, {
      resourceType: 'video',
      attempts: 5,
      retryBaseDelayMs: 0,
    });
    expect(calls).toBe(3);
    expect(out).toHaveLength(8);
  });

  it('gives up after the configured attempt budget', async () => {
    const fetchFn = vi.fn(async () => new Response('err', { status: 503 }));
    vi.stubGlobal('fetch', fetchFn);
    await expect(
      fetchBytes(`${BASE}seg.ts`, { attempts: 3, retryBaseDelayMs: 0 }),
    ).rejects.toThrow(HttpError);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('retries network-level TypeErrors', async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      return resp(bytes(4), 200);
    });
    const out = await fetchBytes(`${BASE}seg.ts`, { attempts: 3, retryBaseDelayMs: 0 });
    expect(calls).toBe(2);
    expect(out).toHaveLength(4);
  });

  it('does not retry range mismatches', async () => {
    const fetchFn = vi.fn(async () => resp(bytes(2), 206));
    vi.stubGlobal('fetch', fetchFn);
    await expect(
      fetchBytes(`${BASE}seg.ts`, {
        byteRange: { offset: 0, length: 9 },
        attempts: 4,
        retryBaseDelayMs: 0,
      }),
    ).rejects.toThrow(RangeMismatchError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('respects an already-aborted signal without fetching', async () => {
    const fetchFn = vi.fn(async () => resp(bytes(4), 200));
    vi.stubGlobal('fetch', fetchFn);
    const ac = new AbortController();
    ac.abort();
    await expect(fetchBytes(`${BASE}seg.ts`, { signal: ac.signal })).rejects.toThrow(
      'Download cancelled',
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('aborts backoff sleep when cancelled mid-retry', async () => {
    mockFetch(() => new Response('err', { status: 500 }));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    await expect(
      fetchBytes(`${BASE}seg.ts`, { signal: ac.signal, attempts: 5, retryBaseDelayMs: 5000 }),
    ).rejects.toThrow('Download cancelled');
  });
});

describe('sanitizeUrlForError', () => {
  it('drops query and fragment but keeps host and path', () => {
    expect(sanitizeUrlForError('https://cdn.example.com/hls/v.m3u8?token=abc#x')).toBe(
      'https://cdn.example.com/hls/v.m3u8',
    );
  });

  it('handles unparseable input without throwing', () => {
    expect(sanitizeUrlForError('not a url')).toBe('(unparseable url)');
  });
});

describe('fetchSegmentsOrdered with ranges', () => {  it('fetches mixed plain and ranged items, preserving order', async () => {
    const full = bytes(100);
    const seen: Array<string | null> = [];
    mockFetch((url, init) => {
      seen.push(rangeHeader(init));
      const h = rangeHeader(init);
      if (!h) return resp(bytes(4, 1), 200);
      const m = /bytes=(\d+)-(\d+)/.exec(h) as RegExpExecArray;
      const start = Number(m[1]);
      const end = Number(m[2]);
      return resp(full.slice(start, end + 1), 206);
    });
    const parts = await fetchSegmentsOrdered(
      [
        { url: `${BASE}a.bin`, byteRange: { offset: 0, length: 10 }, resourceType: 'video' },
        `${BASE}plain.ts`,
        { url: `${BASE}a.bin`, byteRange: { offset: 50, length: 5 }, resourceType: 'video' },
      ],
      { concurrency: 2, attempts: 1 },
    );
    expect(parts).toHaveLength(3);
    expect([...parts[0] as Uint8Array]).toEqual([...full.slice(0, 10)]);
    expect(parts[1]).toHaveLength(4);
    expect([...parts[2] as Uint8Array]).toEqual([...full.slice(50, 55)]);
    expect(seen).toContain('bytes=0-9');
    expect(seen).toContain(null);
    expect(seen).toContain('bytes=50-54');
  });
});

describe('request context (cookies and referrer)', () => {
  it('sends same-origin credentials and the tab referrer', async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        seen.push(init ?? {});
        return new Response(new Uint8Array([1, 2]).buffer as ArrayBuffer, { status: 200 });
      }),
    );
    try {
      await fetchBytes(`${BASE}seg.ts`, {
        attempts: 1,
        referrer: 'https://watch.example.com/title',
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(seen[0]?.credentials).toBe('include');
    expect(seen[0]?.referrer).toBe('https://watch.example.com/title');
  });

  it('omits the referrer field when none is provided', async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        seen.push(init ?? {});
        return new Response(new Uint8Array([1]).buffer as ArrayBuffer, { status: 200 });
      }),
    );
    try {
      await fetchBytes(`${BASE}seg.ts`, { attempts: 1 });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(seen[0]?.credentials).toBe('include');
    expect(seen[0]?.referrer).toBeUndefined();
  });

  it('passes the referrer through ordered segment fetches', async () => {
    const seen: Array<RequestInit | undefined> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        seen.push(init);
        return new Response(new Uint8Array([7]).buffer as ArrayBuffer, { status: 200 });
      }),
    );
    try {
      await fetchSegmentsOrdered([`${BASE}a.ts`, `${BASE}b.ts`], {
        attempts: 1,
        referrer: 'https://watch.example.com/title',
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(seen).toHaveLength(2);
    for (const init of seen) expect(init?.referrer).toBe('https://watch.example.com/title');
  });
});
