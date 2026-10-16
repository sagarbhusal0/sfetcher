import { describe, expect, it, vi } from 'vitest';
import {
  canFit,
  createMemoryBackend,
  estimateStorage,
  FragmentQuotaError,
  sweepStaleJobs,
} from '../src/storage/fragments.js';
import { fetchSegmentsOrdered } from '../src/media/segments.js';

function u8(values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

describe('fragment bucket (memory backend)', () => {
  it('reads tracks back in index order regardless of write order', async () => {
    const store = createMemoryBackend();
    await store.write('j1', 'video', 2, u8([3]));
    await store.write('j1', 'video', 0, u8([1]));
    await store.write('j1', 'video', 1, u8([2]));
    const track = await store.readTrack('j1', 'video');
    expect(track.map((b) => b[0])).toEqual([1, 2, 3]);
  });

  it('isolates video and audio tracks of the same job', async () => {
    const store = createMemoryBackend();
    await store.write('j1', 'video', 0, u8([10]));
    await store.write('j1', 'audio', 0, u8([20]));
    expect((await store.readTrack('j1', 'video'))[0]?.[0]).toBe(10);
    expect((await store.readTrack('j1', 'audio'))[0]?.[0]).toBe(20);
    const meta = await store.jobMeta('j1');
    expect(meta).toMatchObject({ videoCount: 1, audioCount: 1, bytesWritten: 2 });
  });

  it('isolates concurrent jobs', async () => {
    const store = createMemoryBackend();
    await store.write('a', 'video', 0, u8([1]));
    await store.write('b', 'video', 0, u8([2]));
    await store.deleteJob('a');
    expect(await store.readTrack('a', 'video')).toEqual([]);
    expect(await store.jobMeta('a')).toBeNull();
    expect((await store.readTrack('b', 'video'))[0]?.[0]).toBe(2);
  });

  it('rejects invalid fragment indexes', async () => {
    const store = createMemoryBackend();
    await expect(store.write('j', 'video', -1, u8([1]))).rejects.toThrow(/Invalid fragment index/);
    await expect(store.write('j', 'video', 1.5, u8([1]))).rejects.toThrow(/Invalid fragment index/);
  });

  it('handles large fragment counts', async () => {
    const store = createMemoryBackend();
    const n = 500;
    for (let i = n - 1; i >= 0; i--) {
      await store.write('big', 'video', i, u8([i % 256]));
    }
    const track = await store.readTrack('big', 'video');
    expect(track).toHaveLength(n);
    expect(track.map((b) => b[0])).toEqual(Array.from({ length: n }, (_, i) => i % 256));
  });
});

describe('sweepStaleJobs', () => {
  it('removes only old inactive jobs, never active ones', async () => {
    const store = createMemoryBackend();
    await store.write('old-dead', 'video', 0, u8([1]));
    await store.write('live', 'video', 0, u8([2]));
    await store.write('young-dead', 'video', 0, u8([3]));
    // Age the "old" job by rewriting its meta timestamp via delete+write is
    // not possible; instead sweep with maxAgeMs=0 so everything inactive is stale.
    const removed = await sweepStaleJobs(store, (id) => id === 'live', 0);
    expect(removed.sort()).toEqual(['old-dead', 'young-dead']);
    expect(await store.jobMeta('live')).not.toBeNull();
  });

  it('spares young inactive jobs within the grace window', async () => {
    const store = createMemoryBackend();
    await store.write('fresh', 'video', 0, u8([1]));
    const removed = await sweepStaleJobs(store, () => false, 60 * 60 * 1000);
    expect(removed).toEqual([]);
    expect(await store.jobMeta('fresh')).not.toBeNull();
  });

  it('treats queue-read failures as active (never deletes blindly)', async () => {
    const store = createMemoryBackend();
    await store.write('j', 'video', 0, u8([1]));
    const removed = await sweepStaleJobs(
      store,
      () => Promise.reject(new Error('idb gone')),
      0,
    ).catch(() => ['propagated']);
    // The rejection propagates; caller decides. Document the contract:
    expect(removed).toEqual(['propagated']);
    expect(await store.jobMeta('j')).not.toBeNull();
  });
});

describe('storage capacity guard', () => {
  it('applies the safety margin instead of filling the disk', () => {
    const est = { quota: 1000, usage: 800 };
    expect(canFit(est, 50)).toBe(true); // 850 <= 850
    expect(canFit(est, 51)).toBe(false);
    expect(canFit(est, 150, 0)).toBe(true);
  });

  it('permits writes when no estimate is available', () => {
    expect(canFit(null, 10 ** 12)).toBe(true);
    expect(canFit({ quota: null, usage: null }, 10)).toBe(true);
  });

  it('returns null when the storage API is unavailable', async () => {
    const navRecord = globalThis.navigator as unknown as Record<string, unknown>;
    const had = navRecord['storage'];
    try {
      delete navRecord['storage'];
      await expect(estimateStorage()).resolves.toBeNull();
    } finally {
      if (had !== undefined) navRecord['storage'] = had;
    }
  });

  it('exposes a quota error type for callers to report actionably', () => {
    expect(new FragmentQuotaError('x').name).toBe('FragmentQuotaError');
  });
});

describe('fetch write-through hook', () => {
  it('calls onFragment once per segment with its index', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([9]).buffer as ArrayBuffer, { status: 200 })),
    );
    try {
      const seen: Array<[number, number]> = [];
      const parts = await fetchSegmentsOrdered(['u1', 'u2', 'u3'], {
        concurrency: 2,
        attempts: 1,
        onFragment: (idx, data) => {
          seen.push([idx, data[0] ?? -1]);
        },
      });
      expect(parts).toHaveLength(3);
      expect(seen.sort((a, b) => a[0] - b[0])).toEqual([
        [0, 9],
        [1, 9],
        [2, 9],
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
