/**
 * Segment fetching: HTTP byte ranges, typed errors, bounded retries.
 *
 * Byte-range handling follows the upstream hls-downloader approach
 * (MIT, (c) 2025 Shy Alter): send `Range: bytes=a-b`, accept `206`
 * verbatim after validation, and slice a `200` full-body response down
 * to the requested range. A response that cannot satisfy the range is
 * never silently written — it fails with a RangeMismatchError.
 */

export type ResourceType =
  | 'master'
  | 'variant'
  | 'init'
  | 'video'
  | 'audio'
  | 'key'
  | 'segment';

const RESOURCE_LABELS: Record<ResourceType, string> = {
  master: 'master playlist',
  variant: 'variant playlist',
  init: 'initialization segment',
  video: 'video fragment',
  audio: 'audio fragment',
  key: 'encryption key',
  segment: 'media segment',
};

export function resourceLabel(type: ResourceType): string {
  return RESOURCE_LABELS[type];
}

export interface ByteRange {
  /** First byte offset (inclusive). */
  offset: number;
  /** Number of bytes. */
  length: number;
}

/**
 * Strip query parameters, fragments, and userinfo credentials from a URL
 * for errors, logs, and UI. Signed tokens and credentials must never
 * leave this module.
 */
export function sanitizeUrlForError(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.search = '';
    u.hash = '';
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return '(unparseable url)';
  }
}

/** Human hint distinguishing expiry/auth, missing content, and transient faults. */
export function describeHttpStatus(status: number): string {
  if (status === 401 || status === 403) {
    return 'authorization failed or the signed URL expired (grant access and retry with a fresh page load)';
  }
  if (status === 404 || status === 410) return 'content unavailable at this URL';
  if (status === 429) return 'rate-limited; retry with backoff';
  if (status >= 500) return 'server error; retry may succeed';
  return 'request failed';
}

/** HTTP failure with status, resource kind, and a sanitized URL. */
export class HttpError extends Error {
  readonly status: number;
  readonly resourceType: ResourceType;
  readonly safeUrl: string;

  constructor(status: number, resourceType: ResourceType, rawUrl: string) {
    super(
      `HTTP ${status} for ${RESOURCE_LABELS[resourceType]} ` +
        `(${sanitizeUrlForError(rawUrl)}): ${describeHttpStatus(status)}`,
    );
    this.name = 'HttpError';
    this.status = status;
    this.resourceType = resourceType;
    this.safeUrl = sanitizeUrlForError(rawUrl);
  }

  /** Only transient statuses merit a retry; 403/404 and friends never do. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** A 206/200 response that cannot satisfy the requested byte range. */
export class RangeMismatchError extends Error {
  readonly resourceType: ResourceType;
  readonly safeUrl: string;

  constructor(detail: string, resourceType: ResourceType, rawUrl: string) {
    super(
      `Byte-range mismatch for ${RESOURCE_LABELS[resourceType]} ` +
        `(${sanitizeUrlForError(rawUrl)}): ${detail}`,
    );
    this.name = 'RangeMismatchError';
    this.resourceType = resourceType;
    this.safeUrl = sanitizeUrlForError(rawUrl);
  }
}

export interface FetchProgress {
  loaded: number;
  total: number | null;
}

export interface FetchOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  onProgress?: (p: FetchProgress) => void;
  byteRange?: ByteRange;
  /** Total attempts including the first try (bounded to 1..10). Default 3. */
  attempts?: number;
  /** Base backoff delay in ms; actual delay is base * 2^(retry-1). Default 250. */
  retryBaseDelayMs?: number;
  resourceType?: ResourceType;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Download cancelled');
}

/** Abort-aware sleep used for retry backoff. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error('Download cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseContentRange(header: string | null): { start: number; end: number } | null {
  if (!header) return null;
  const m = /bytes (\d+)-(\d+)(?:\/\d+|\/\*)?/.exec(header);
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]) };
}

async function readBody(
  res: Response,
  opts: { signal?: AbortSignal; maxBytes?: number; onProgress?: (p: FetchProgress) => void },
): Promise<Uint8Array> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (opts.maxBytes && buf.length > opts.maxBytes) throw new Error('Response exceeds size limit');
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  const totalHeader = res.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) : null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      loaded += value.length;
      if (opts.maxBytes && loaded > opts.maxBytes) {
        reader.cancel().catch(() => undefined);
        throw new Error('Response exceeds size limit');
      }
      chunks.push(value);
      opts.onProgress?.({ loaded, total });
    }
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Single fetch attempt: range headers, 206 validation, 200 slice fallback. */
async function fetchOnce(url: string, opts: FetchOptions, resourceType: ResourceType): Promise<Uint8Array> {
  const range = opts.byteRange;
  const headers: Record<string, string> = {};
  if (range) {
    headers['Range'] = `bytes=${range.offset}-${range.offset + range.length - 1}`;
  }
  let res: Response;
  try {
    res = await fetch(url, { signal: opts.signal, credentials: 'omit', headers });
  } catch (e) {
    throwIfAborted(opts.signal);
    throw e;
  }
  if (!res.ok) throw new HttpError(res.status, resourceType, url);

  if (!range) {
    return readBody(res, opts);
  }

  // Ranged request: maxBytes applies to the manifest/segment domain, not to
  // a full-body 200 fallback, so read without the cap and validate the slice.
  const raw = await readBody(res, { signal: opts.signal, onProgress: opts.onProgress });

  if (res.status === 206) {
    const claimed = parseContentRange(res.headers.get('content-range'));
    if (claimed && (claimed.start !== range.offset || claimed.end !== range.offset + range.length - 1)) {
      throw new RangeMismatchError(
        `server returned bytes ${claimed.start}-${claimed.end}, ` +
          `requested ${range.offset}-${range.offset + range.length - 1}`,
        resourceType,
        url,
      );
    }
    if (raw.length !== range.length) {
      throw new RangeMismatchError(
        `206 response holds ${raw.length} bytes, requested ${range.length}`,
        resourceType,
        url,
      );
    }
    return raw;
  }

  // Server ignored the Range header: slice the full body, after bounds check.
  if (raw.length < range.offset + range.length) {
    throw new RangeMismatchError(
      `full response holds ${raw.length} bytes, cannot satisfy offset ${range.offset} + length ${range.length}`,
      resourceType,
      url,
    );
  }
  return raw.slice(range.offset, range.offset + range.length);
}

function isRetryable(e: unknown): boolean {
  if (e instanceof HttpError) return e.retryable;
  if (e instanceof RangeMismatchError) return false;
  if (e instanceof Error && e.message === 'Download cancelled') return false;
  // Network-level failures (TypeError from fetch) are transient.
  return e instanceof TypeError;
}

export async function fetchBytes(url: string, opts: FetchOptions = {}): Promise<Uint8Array> {
  const resourceType = opts.resourceType ?? 'segment';
  const attempts = Math.max(1, Math.min(Math.floor(opts.attempts ?? 3), 10));
  const baseDelay = Math.max(0, opts.retryBaseDelayMs ?? 250);
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    throwIfAborted(opts.signal);
    try {
      return await fetchOnce(url, opts, resourceType);
    } catch (e) {
      lastError = e;
      if (e instanceof Error && e.message === 'Download cancelled') throw e;
      if (opts.signal?.aborted) throw new Error('Download cancelled');
      if (!isRetryable(e) || attempt === attempts) throw e;
      await sleep(baseDelay * 2 ** (attempt - 1), opts.signal);
    }
  }
  throw lastError;
}

export interface SegmentRequest {
  url: string;
  byteRange?: ByteRange;
  resourceType?: ResourceType;
}

export async function fetchSegmentsOrdered(
  urls: Array<string | SegmentRequest>,
  opts: {
    concurrency?: number;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
    attempts?: number;
    retryBaseDelayMs?: number;
    resourceType?: ResourceType;
    /** Write-through hook (e.g. disk bucket); failures propagate and fail the job. */
    onFragment?: (index: number, data: Uint8Array) => void | Promise<void>;
  } = {},
): Promise<Uint8Array[]> {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, 6));
  const items: SegmentRequest[] = urls.map((u) =>
    typeof u === 'string' ? { url: u } : u,
  );
  const results: Uint8Array[] = new Array(items.length);
  let done = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      if (opts.signal?.aborted) throw new Error('Download cancelled');
      const idx = cursor++;
      const item = items[idx] as SegmentRequest;
      const bytes = await fetchBytes(item.url, {
        signal: opts.signal,
        byteRange: item.byteRange,
        resourceType: item.resourceType ?? opts.resourceType ?? 'segment',
        attempts: opts.attempts,
        retryBaseDelayMs: opts.retryBaseDelayMs,
      });
      results[idx] = bytes;
      await opts.onFragment?.(idx, bytes);
      done++;
      opts.onProgress?.(done, items.length);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results as Uint8Array[];
}
