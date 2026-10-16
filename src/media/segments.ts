export interface FetchProgress {
  loaded: number;
  total: number | null;
}

export async function fetchBytes(
  url: string,
  opts: {
    signal?: AbortSignal;
    maxBytes?: number;
    onProgress?: (p: FetchProgress) => void;
  } = {},
): Promise<Uint8Array> {
  const res = await fetch(url, { signal: opts.signal, credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
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

export async function fetchSegmentsOrdered(
  urls: string[],
  opts: {
    concurrency?: number;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<Uint8Array[]> {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, 6));
  const results: Uint8Array[] = new Array(urls.length);
  let done = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < urls.length) {
      if (opts.signal?.aborted) throw new Error('Download cancelled');
      const idx = cursor++;
      const bytes = await fetchBytes(urls[idx] as string, { signal: opts.signal });
      results[idx] = bytes;
      done++;
      opts.onProgress?.(done, urls.length);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, () => worker());
  await Promise.all(workers);
  return results as Uint8Array[];
}
