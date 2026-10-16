import {
  AUDIO_MIME_PREFIX,
  DASH_MIMES,
  DIRECT_AUDIO_EXTS,
  DIRECT_VIDEO_EXTS,
  HLS_MIMES,
  KNOWN_AUDIO_MIMES,
  KNOWN_VIDEO_MIMES,
  VIDEO_MIME_PREFIX,
} from '../shared/constants.js';
import { extensionFromUrl, isAllowedUrl } from '../shared/utils.js';
import type { DetectedMedia, DetectionSource, MediaKind } from '../shared/types.js';
import { stableId, safeHostname, normalizeMediaUrl } from '../shared/utils.js';

export interface ClassifyInput {
  url: string;
  mimeType?: string | null;
  resourceType?: string | null;
  tabId: number;
  source: DetectionSource;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
  title?: string | null;
}

function baseKind(url: string, mime: string | null): { kind: MediaKind; container: string | null } {
  const ext = extensionFromUrl(url);
  const m = (mime ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

  if (m && HLS_MIMES.has(m)) return { kind: 'hls', container: 'hls' };
  if (m && DASH_MIMES.has(m)) return { kind: 'dash', container: 'mpd' };
  if (ext === 'm3u8') return { kind: 'hls', container: 'hls' };
  if (ext === 'mpd') return { kind: 'dash', container: 'mpd' };

  if (m.startsWith(VIDEO_MIME_PREFIX) || (m && KNOWN_VIDEO_MIMES.has(m))) {
    return { kind: 'video-direct', container: ext };
  }
  if (m.startsWith(AUDIO_MIME_PREFIX) || (m && KNOWN_AUDIO_MIMES.has(m))) {
    return { kind: 'audio-direct', container: ext };
  }

  if (ext && DIRECT_VIDEO_EXTS.has(ext)) return { kind: 'video-direct', container: ext };
  if (ext && DIRECT_AUDIO_EXTS.has(ext)) return { kind: 'audio-direct', container: ext };

  return { kind: 'unknown', container: ext };
}

export type SkipReason = 'unsafe-scheme-rejected' | 'blob-url' | 'non-media-filtered';

export type ClassifyResult =
  | { ok: true; media: DetectedMedia }
  | { ok: false; reason: SkipReason };

export function classifyWithReason(input: ClassifyInput): ClassifyResult {
  const { url, tabId, source } = input;
  if (url.startsWith('blob:')) return { ok: false, reason: 'blob-url' };
  if (!isAllowedUrl(url)) return { ok: false, reason: 'unsafe-scheme-rejected' };

  const mime = input.mimeType?.split(';')[0]?.trim() || null;
  const { kind, container } = baseKind(url, mime);
  // Reduce false positives: unknown kinds are dropped unless they came from a
  // media element with dimensions/duration.
  if (kind === 'unknown') {
    const looksLikeMediaElement =
      (input.width ?? 0) > 0 || (input.height ?? 0) > 0 || (input.durationSec ?? 0) > 0;
    if (!looksLikeMediaElement) return { ok: false, reason: 'non-media-filtered' };
  }

  const ext = extensionFromUrl(url);
  return {
    ok: true,
    media: {
      // Identity is the normalized URL: same manifest found via DOM,
      // resource-timing, and webRequest merges; genuinely different variant
      // playlists (different paths) keep distinct ids.
      id: stableId(`${tabId}|${normalizeMediaUrl(url)}`),
      tabId,
      url,
      kind,
      source,
      sources: [source],
      fileExtension: ext,
      mimeType: mime,
      container,
      codecs: null,
      width: input.width ?? null,
      height: input.height ?? null,
      durationSec: input.durationSec ?? null,
      hostname: safeHostname(url),
      estimatedSizeBytes: null,
      detectedAt: Date.now(),
      title: input.title ?? null,
    },
  };
}

export function classifyMedia(input: ClassifyInput): DetectedMedia | null {
  const res = classifyWithReason(input);
  return res.ok ? res.media : null;
}

export function dedupeMedia(items: DetectedMedia[]): DetectedMedia[] {
  const byId = new Map<string, DetectedMedia>();
  for (const item of items) {
    const prev = byId.get(item.id);
    if (!prev) {
      byId.set(item.id, item);
      continue;
    }
    // Merge: keep richer metadata and union the discovery sources.
    const sources = [...(prev.sources ?? [prev.source]), ...(item.sources ?? [item.source])];
    byId.set(item.id, {
      ...prev,
      sources: [...new Set(sources)].slice(0, 3) as DetectedMedia['sources'],
      mimeType: prev.mimeType ?? item.mimeType,
      width: prev.width ?? item.width,
      height: prev.height ?? item.height,
      durationSec: prev.durationSec ?? item.durationSec,
      title: prev.title ?? item.title,
      detectedAt: Math.min(prev.detectedAt, item.detectedAt),
    });
  }
  return [...byId.values()];
}
