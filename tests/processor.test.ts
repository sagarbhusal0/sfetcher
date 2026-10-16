import { describe, expect, it, vi } from 'vitest';
import { ensureOffscreen, ProcessorInitError } from '../src/media/offscreen.js';
import { listVariants } from '../src/media/variants.js';
import { classifyWithReason, dedupeMedia } from '../src/detection/classify.js';
import { normalizeMediaUrl } from '../src/shared/utils.js';
import type { DetectedMedia } from '../src/shared/types.js';

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720
high.m3u8
`;

describe('processor initialization', () => {
  it('fails with stage offscreen-api-missing when the namespace is absent', async () => {
    // Reproduces the reported popup error:
    // "Cannot read properties of undefined (reading 'hasDocument')".
    const err = await ensureOffscreen({}).catch((e) => e);
    expect(err).toBeInstanceOf(ProcessorInitError);
    expect((err as ProcessorInitError).stage).toBe('offscreen-api-missing');
    expect((err as Error).message).toContain('offscreen-api-missing');
  });

  it('fails with stage offscreen-api-missing when hasDocument is not a function', async () => {
    const err = await ensureOffscreen({ offscreen: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ProcessorInitError);
    expect((err as ProcessorInitError).stage).toBe('offscreen-api-missing');
  });

  it('fails with stage offscreen-hasDocument and preserves the cause stack', async () => {
    const cause = new Error('boom');
    const err = await ensureOffscreen({
      offscreen: {
        hasDocument: () => Promise.reject(cause),
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ProcessorInitError);
    expect((err as ProcessorInitError).stage).toBe('offscreen-hasDocument');
    expect((err as ProcessorInitError).causeStack).toContain('boom');
  });

  it('fails with stage offscreen-createDocument when creation throws', async () => {
    const err = await ensureOffscreen({
      offscreen: {
        hasDocument: () => Promise.resolve(false),
        createDocument: () => Promise.reject(new Error('single offscreen only')),
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ProcessorInitError);
    expect((err as ProcessorInitError).stage).toBe('offscreen-createDocument');
  });

  it('succeeds without creating when a document already exists', async () => {
    const createDocument = vi.fn(() => Promise.resolve());
    await ensureOffscreen({
      offscreen: { hasDocument: () => Promise.resolve(true), createDocument },
    });
    expect(createDocument).not.toHaveBeenCalled();
  });

  it('creates the document with the local URL and BLOBS reason', async () => {
    const createDocument = vi.fn((_opts: unknown): Promise<void> => Promise.resolve());
    await ensureOffscreen(
      {
        offscreen: { hasDocument: () => Promise.resolve(false), createDocument },
        runtime: { getURL: (p: string) => `chrome-extension://id/${p}` },
      },
      'offscreen.html',
    );
    expect(createDocument).toHaveBeenCalledOnce();
    const arg = createDocument.mock.calls[0]?.[0] as unknown as { url: string; reasons: string[] };
    expect(arg.url).toBe('chrome-extension://id/offscreen.html');
    expect(arg.reasons).toEqual(['BLOBS']);
  });

  it('falls back to runtime.getContexts when hasDocument is absent', async () => {
    const createDocument = vi.fn((_opts: unknown): Promise<void> => Promise.resolve());
    const getContexts = vi.fn((): Promise<Array<{ contextType?: string }>> => Promise.resolve([]));
    await ensureOffscreen(
      {
        offscreen: { createDocument },
        runtime: { getContexts },
      },
      'offscreen.html',
    );
    expect(getContexts).toHaveBeenCalledOnce();
    expect(createDocument).toHaveBeenCalledOnce();
  });

  it('skips creation when getContexts already shows an offscreen document', async () => {
    const createDocument = vi.fn((_opts: unknown): Promise<void> => Promise.resolve());
    await ensureOffscreen({
      offscreen: { createDocument },
      runtime: {
        getContexts: () => Promise.resolve([{ contextType: 'OFFSCREEN_DOCUMENT' }]),
      },
    });
    expect(createDocument).not.toHaveBeenCalled();
  });
});

describe('quality discovery without the processor', () => {
  it('lists HLS variants from a master fixture (no offscreen involved)', async () => {
    const listing = await listVariants('https://cdn.example.com/hls/master.m3u8', 'hls', async () => MASTER);
    expect(listing.live).toBe(false);
    expect(listing.variants.map((v) => v.id)).toEqual(['0', '1']);
    expect(listing.variants[1]?.label).toContain('720p');
  });

  it('reports live playlists instead of variants', async () => {
    const listing = await listVariants(
      'https://e.com/live.m3u8',
      'hls',
      async () => '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.ts\n',
    );
    expect(listing.live).toBe(true);
    expect(listing.note).toMatch(/Live/);
  });

  it('propagates fetch failures for the caller to explain (host access)', async () => {
    await expect(
      listVariants('https://cdn.example.com/hls/master.m3u8', 'hls', async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe('manifest URL normalization', () => {
  it('lowercases scheme/host and drops fragments', () => {
    expect(normalizeMediaUrl('HTTPS://CDN.Example.COM/hls/index.m3u8#frag')).toBe(
      'https://cdn.example.com/hls/index.m3u8',
    );
  });

  it('keeps path case and query (different tokens stay distinct)', () => {
    expect(normalizeMediaUrl('https://cdn.example.com/HLS/A.m3u8?token=1')).toBe(
      'https://cdn.example.com/HLS/A.m3u8?token=1',
    );
  });
});

describe('duplicate manifest detection', () => {
  function via(url: string, source: 'dom' | 'network', mime: string | null, tabId = 11): DetectedMedia {
    const res = classifyWithReason({ url, mimeType: mime, resourceType: 'x', tabId, source });
    if (!res.ok) throw new Error(`should classify: ${url}`);
    return res.media;
  }

  it('merges the same manifest found via DOM, timing, and network', () => {
    const items = [
      via('https://cdn.example.com/hls/index.m3u8', 'dom', null),
      via('https://cdn.example.com/hls/index.m3u8', 'dom', null),
      via('HTTPS://cdn.example.com/hls/index.m3u8', 'network', 'application/vnd.apple.mpegurl'),
    ];
    const merged = dedupeMedia(items);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.sources?.sort()).toEqual(['dom', 'network']);
    // Richest metadata wins: MIME observed on the network path is retained.
    expect(merged[0]?.mimeType).toBe('application/vnd.apple.mpegurl');
  });

  it('does not merge genuinely different variant playlists', () => {
    const merged = dedupeMedia([
      via('https://cdn.example.com/hls/low.m3u8', 'dom', null),
      via('https://cdn.example.com/hls/high.m3u8', 'dom', null),
      via('https://cdn.example.com/hls/low.m3u8?token=OTHER', 'network', null),
    ]);
    expect(merged).toHaveLength(3);
  });

  it('fragment-only differences merge (same resource)', () => {
    const merged = dedupeMedia([
      via('https://cdn.example.com/v/clip.mp4#t=1', 'dom', null),
      via('https://cdn.example.com/v/clip.mp4', 'network', 'video/mp4'),
    ]);
    expect(merged).toHaveLength(1);
  });
});
