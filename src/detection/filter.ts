import type { DetectedMedia } from '../shared/types.js';

export type MediaFilter = 'all' | 'video-direct' | 'audio-direct' | 'hls' | 'dash' | 'unknown';

/** Pure popup list filtering (search + format). Kept out of the UI layer for tests. */
export function filterMedia(
  items: DetectedMedia[],
  query: string,
  filter: MediaFilter,
): DetectedMedia[] {
  const q = query.trim().toLowerCase();
  return items.filter((i) => {
    if (filter !== 'all' && i.kind !== filter) return false;
    if (!q) return true;
    return (
      i.url.toLowerCase().includes(q) ||
      (i.hostname ?? '').toLowerCase().includes(q) ||
      (i.title ?? '').toLowerCase().includes(q)
    );
  });
}
