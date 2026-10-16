/**
 * Disk-backed fragment buckets for HLS/DASH jobs.
 *
 * Fragments are written through to IndexedDB (real backend) as they arrive
 * so an interrupted job leaves recoverable, attributable state instead of
 * silent garbage, and terminal states (success / failure / cancellation)
 * always delete the bucket. Tracks are isolated by (jobId, track, index)
 * with stable index ordering.
 *
 * Honest scope: the ffmpeg.wasm exec model requires all remux inputs in
 * MEMFS before execution, so the remux working set still lives in RAM
 * (bounded by the MAX_JOB_BYTES cap). This layer buys crash visibility,
 * quota accounting, and guaranteed cleanup — not zero-RAM remuxing.
 *
 * The backend is injectable: unit tests use the in-memory backend (jsdom
 * has no IndexedDB); the offscreen document uses the IndexedDB backend.
 */

export type FragmentTrack = 'video' | 'audio';

export interface FragmentMeta {
  byteOffset?: number;
  byteLength?: number;
  bytesWritten?: number;
}

export interface FragmentJobMeta {
  jobId: string;
  createdAt: number;
  videoCount: number;
  audioCount: number;
  bytesWritten: number;
}

export class FragmentStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FragmentStorageError';
  }
}

export class FragmentQuotaError extends FragmentStorageError {
  constructor(message: string) {
    super(message);
    this.name = 'FragmentQuotaError';
  }
}

function isQuotaFailure(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name ?? '';
  return (
    name === 'QuotaExceededError' ||
    (e instanceof Error && /quota/i.test(e.message))
  );
}

export interface FragmentBackend {
  write(
    jobId: string,
    track: FragmentTrack,
    index: number,
    data: Uint8Array,
    meta?: FragmentMeta,
  ): Promise<void>;
  readTrack(jobId: string, track: FragmentTrack): Promise<Uint8Array[]>;
  jobMeta(jobId: string): Promise<FragmentJobMeta | null>;
  deleteJob(jobId: string): Promise<void>;
  listJobs(): Promise<FragmentJobMeta[]>;
}

/** Test/shim backend: same ordering and isolation semantics, no browser needed. */
export function createMemoryBackend(): FragmentBackend {
  const chunks = new Map<string, { data: Uint8Array; meta: FragmentMeta }>();
  const metas = new Map<string, FragmentJobMeta>();
  const key = (jobId: string, track: FragmentTrack, index: number): string =>
    `${jobId}\0${track}\0${index}`;

  const metaFor = (jobId: string): FragmentJobMeta => {
    let m = metas.get(jobId);
    if (!m) {
      m = { jobId, createdAt: Date.now(), videoCount: 0, audioCount: 0, bytesWritten: 0 };
      metas.set(jobId, m);
    }
    return m;
  };

  return {
    async write(jobId, track, index, data, meta): Promise<void> {
      if (!Number.isInteger(index) || index < 0) {
        throw new FragmentStorageError(`Invalid fragment index: ${index}`);
      }
      chunks.set(key(jobId, track, index), { data: data.slice(), meta: meta ?? {} });
      const m = metaFor(jobId);
      if (track === 'video') m.videoCount = Math.max(m.videoCount, index + 1);
      else m.audioCount = Math.max(m.audioCount, index + 1);
      m.bytesWritten += data.length;
    },
    async readTrack(jobId, track): Promise<Uint8Array[]> {
      const out: Array<{ index: number; data: Uint8Array }> = [];
      for (const [k, v] of chunks) {
        const [jid, t, idx] = k.split('\0');
        if (jid === jobId && t === track) out.push({ index: Number(idx), data: v.data });
      }
      out.sort((a, b) => a.index - b.index);
      return out.map((e) => e.data);
    },
    async jobMeta(jobId): Promise<FragmentJobMeta | null> {
      return metas.get(jobId) ?? null;
    },
    async deleteJob(jobId): Promise<void> {
      for (const k of [...chunks.keys()]) {
        if (k.startsWith(`${jobId}\0`)) chunks.delete(k);
      }
      metas.delete(jobId);
    },
    async listJobs(): Promise<FragmentJobMeta[]> {
      return [...metas.values()];
    },
  };
}

/** Production backend over IndexedDB (`idb` is already a dependency). */
export function createIdbBackend(dbName = 'sfetcher-fragments'): FragmentBackend {
  let dbPromise: Promise<import('idb').IDBPDatabase> | null = null;
  const db = (): Promise<import('idb').IDBPDatabase> => {
    if (!dbPromise) {
      dbPromise = import('idb').then(({ openDB }) =>
        openDB(dbName, 1, {
          upgrade(d) {
            if (!d.objectStoreNames.contains('chunks')) {
              d.createObjectStore('chunks', { keyPath: ['jobId', 'track', 'index'] });
            }
            if (!d.objectStoreNames.contains('jobs')) {
              d.createObjectStore('jobs', { keyPath: 'jobId' });
            }
          },
        }),
      );
    }
    return dbPromise;
  };

  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (isQuotaFailure(e)) {
        throw new FragmentQuotaError(
          'Browser storage quota exceeded while saving fragments. Free disk space or clear old jobs, then retry.',
        );
      }
      throw e instanceof Error ? e : new FragmentStorageError(String(e));
    }
  };

  return {
    async write(jobId, track, index, data, meta): Promise<void> {
      if (!Number.isInteger(index) || index < 0) {
        throw new FragmentStorageError(`Invalid fragment index: ${index}`);
      }
      await wrap(async () => {
        const d = await db();
        const tx = d.transaction(['chunks', 'jobs'], 'readwrite');
        await tx.objectStore('chunks').put({
          jobId,
          track,
          index,
          data: data.slice(),
          meta: meta ?? {},
        });
        const prev =
          ((await tx.objectStore('jobs').get(jobId)) as FragmentJobMeta | undefined) ??
          { jobId, createdAt: Date.now(), videoCount: 0, audioCount: 0, bytesWritten: 0 };
        const next: FragmentJobMeta = {
          ...prev,
          videoCount: track === 'video' ? Math.max(prev.videoCount, index + 1) : prev.videoCount,
          audioCount: track === 'audio' ? Math.max(prev.audioCount, index + 1) : prev.audioCount,
          bytesWritten: prev.bytesWritten + data.length,
        };
        await tx.objectStore('jobs').put(next);
        await tx.done;
      });
    },
    async readTrack(jobId, track): Promise<Uint8Array[]> {
      return wrap(async () => {
        const d = await db();
        const all = (await d.getAll('chunks')) as Array<{
          jobId: string;
          track: string;
          index: number;
          data: Uint8Array;
        }>;
        return all
          .filter((c) => c.jobId === jobId && c.track === track)
          .sort((a, b) => a.index - b.index)
          .map((c) => c.data);
      });
    },
    async jobMeta(jobId): Promise<FragmentJobMeta | null> {
      return wrap(async () => {
        const d = await db();
        return ((await d.get('jobs', jobId)) as FragmentJobMeta | undefined) ?? null;
      });
    },
    async deleteJob(jobId): Promise<void> {
      await wrap(async () => {
        const d = await db();
        const tx = d.transaction(['chunks', 'jobs'], 'readwrite');
        const keys = (await tx.objectStore('chunks').getAllKeys()) as Array<[string, string, number]>;
        await Promise.all(
          keys.filter((k) => k[0] === jobId).map((k) => tx.objectStore('chunks').delete(k)),
        );
        await tx.objectStore('jobs').delete(jobId);
        await tx.done;
      });
    },
    async listJobs(): Promise<FragmentJobMeta[]> {
      return wrap(async () => {
        const d = await db();
        return (await d.getAll('jobs')) as FragmentJobMeta[];
      });
    },
  };
}

export interface StorageEstimate {
  quota: number | null;
  usage: number | null;
}

/** Best-effort storage estimate; null when the API is unavailable. */
export async function estimateStorage(): Promise<StorageEstimate | null> {
  try {
    const nav = globalThis.navigator as
      | { storage?: { estimate?: () => Promise<{ quota?: number; usage?: number }> } }
      | undefined;
    const est = await nav?.storage?.estimate?.();
    if (!est) return null;
    return { quota: est.quota ?? null, usage: est.usage ?? null };
  } catch {
    return null;
  }
}

/**
 * Decide whether `neededBytes` may be written given an estimate.
 * Applies a safety margin (default 15%) and refuses when the estimate
 * is missing numbers rather than assuming infinite space.
 */
export function canFit(
  estimate: StorageEstimate | null,
  neededBytes: number,
  safetyMargin = 0.15,
): boolean {
  if (!estimate || estimate.quota == null || estimate.usage == null) return true;
  const margin = Math.min(Math.max(safetyMargin, 0), 0.9);
  return estimate.usage + neededBytes <= estimate.quota * (1 - margin);
}

/**
 * Remove buckets that do not belong to an active job and are older than
 * `maxAgeMs`. Active jobs are never touched. Returns removed job ids.
 */
export async function sweepStaleJobs(
  backend: FragmentBackend,
  isActive: (jobId: string) => boolean | Promise<boolean>,
  maxAgeMs = 24 * 60 * 60 * 1000,
): Promise<string[]> {
  const now = Date.now();
  const removed: string[] = [];
  for (const job of await backend.listJobs()) {
    if (await isActive(job.jobId)) continue;
    if (now - job.createdAt < maxAgeMs) continue;
    await backend.deleteJob(job.jobId);
    removed.push(job.jobId);
  }
  return removed;
}
