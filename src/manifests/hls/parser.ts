export interface HlsVariant {
  uri: string;
  bandwidth: number | null;
  resolution: string | null;
  width: number | null;
  height: number | null;
  codecs: string | null;
  audioGroup: string | null;
  subtitlesGroup: string | null;
}

export interface HlsRendition {
  groupId: string;
  type: 'AUDIO' | 'SUBTITLES';
  name: string;
  language: string | null;
  uri: string | null;
  default: boolean;
  autoselect: boolean;
  channels: string | null;
}

export interface HlsByteRange {
  /** First byte offset (inclusive). */
  offset: number;
  /** Number of bytes. */
  length: number;
}

export interface HlsSegment {
  uri: string;
  duration: number;
  sequence: number;
  discontinuity: boolean;
  initSection: string | null;
  /** Byte range of the initialization segment, when EXT-X-MAP carries BYTERANGE. */
  initByteRange: HlsByteRange | null;
  /** Byte range of this media segment, when EXT-X-BYTERANGE precedes it. */
  byteRange: HlsByteRange | null;
}

export interface HlsMediaPlaylist {
  segments: HlsSegment[];
  targetDuration: number;
  endList: boolean;
  playlistType: string | null;
  isLive: boolean;
}

export interface HlsMaster {
  variants: HlsVariant[];
  renditions: HlsRendition[];
}

export const HLS_LIMITS = { maxLines: 20000, maxSegments: 2000, maxBytes: 2_000_000 };

function parseAttributes(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const rest = line.slice(line.indexOf(':') + 1);
  let cur = '';
  let inQuotes = false;
  const parts: string[] = [];
  for (const ch of rest) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ',' && !inQuotes) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim();
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    attrs[k] = v;
  }
  return attrs;
}

function parseResolution(s: string | undefined): { w: number | null; h: number | null } {
  if (!s) return { w: null, h: null };
  const m = /^(\d+)x(\d+)$/.exec(s);
  if (!m) return { w: null, h: null };
  return { w: Number(m[1]), h: Number(m[2]) };
}

/**
 * Parse an EXT-X-BYTERANGE value (`n[@o]`) into a structured range.
 * A missing offset is resolved by the caller against the previous
 * applicable range, per RFC 8216 section 4.3.2.2.
 */
export function parseByteRangeValue(value: string): { length: number; offset: number | null } {
  const m = /^(\d+)@(\d+)$/.exec(value.trim()) ?? /^(\d+)$/.exec(value.trim());
  if (!m) throw new Error(`Invalid EXT-X-BYTERANGE value: ${value}`);
  const length = Number(m[1]);
  const offset = m[2] !== undefined ? Number(m[2]) : null;
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new Error(`Invalid EXT-X-BYTERANGE length: ${value}`);
  }
  if (offset !== null && (!Number.isSafeInteger(offset) || offset < 0)) {
    throw new Error(`Invalid EXT-X-BYTERANGE offset: ${value}`);
  }
  return { length, offset };
}

import { propagateQueryParams } from '../../shared/utils.js';

export function resolveUrl(base: string, ref: string, inheritQueryFrom?: string): string {
  try {
    const u = new URL(ref, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`Unsafe URL scheme in playlist: ${u.protocol}`);
    }
    const resolved = u.toString();
    return inheritQueryFrom ? propagateQueryParams(inheritQueryFrom, resolved) : resolved;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Unsafe URL scheme')) throw e;
    throw new Error(`Unresolvable playlist URL: ${ref}`);
  }
}

export function isMasterPlaylist(text: string): boolean {
  return text.includes('#EXT-X-STREAM-INF');
}

export function parseMaster(text: string, baseUrl: string): HlsMaster {
  if (text.length > HLS_LIMITS.maxBytes) throw new Error('HLS manifest exceeds size limit');
  const lines = text.split(/\r?\n/);
  if (lines.length > HLS_LIMITS.maxLines) throw new Error('HLS manifest exceeds line limit');
  if (!lines[0]?.startsWith('#EXTM3U')) throw new Error('Not an HLS playlist (missing #EXTM3U)');

  const variants: HlsVariant[] = [];
  const renditions: HlsRendition[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? '';
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttributes(line);
      const uriLine = (lines[i + 1] ?? '').trim();
      if (!uriLine || uriLine.startsWith('#')) throw new Error('Master playlist variant missing URI');
      const { w, h } = parseResolution(attrs['RESOLUTION']);
      variants.push({
        uri: resolveUrl(baseUrl, uriLine, baseUrl),
        bandwidth: attrs['BANDWIDTH'] ? Number(attrs['BANDWIDTH']) : null,
        resolution: attrs['RESOLUTION'] ?? null,
        width: w,
        height: h,
        codecs: attrs['CODECS'] ?? null,
        audioGroup: attrs['AUDIO'] ?? null,
        subtitlesGroup: attrs['SUBTITLES'] ?? null,
      });
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(line);
      const t = attrs['TYPE'];
      if (t === 'AUDIO' || t === 'SUBTITLES') {
        renditions.push({
          groupId: attrs['GROUP-ID'] ?? '',
          type: t,
          name: attrs['NAME'] ?? '',
          language: attrs['LANGUAGE'] ?? null,
          uri: attrs['URI'] ? resolveUrl(baseUrl, attrs['URI'], baseUrl) : null,
          default: (attrs['DEFAULT'] ?? 'NO') === 'YES',
          autoselect: (attrs['AUTOSELECT'] ?? 'NO') === 'YES',
          channels: attrs['CHANNELS'] ?? null,
        });
      }
    }
  }
  return { variants, renditions };
}

export function parseMediaPlaylist(
  text: string,
  baseUrl: string,
  opts: { maxSegments?: number } = {},
): HlsMediaPlaylist {
  if (text.length > HLS_LIMITS.maxBytes) throw new Error('HLS manifest exceeds size limit');
  const lines = text.split(/\r?\n/);
  if (lines.length > HLS_LIMITS.maxLines) throw new Error('HLS manifest exceeds line limit');
  if (!lines[0]?.startsWith('#EXTM3U')) throw new Error('Not an HLS playlist (missing #EXTM3U)');

  const maxSegments = opts.maxSegments ?? HLS_LIMITS.maxSegments;
  const segments: HlsSegment[] = [];
  let targetDuration = 0;
  let endList = false;
  let playlistType: string | null = null;
  let mediaSequence = 0;
  let pendingDuration = 0;
  let pendingInit: string | null = null;
  let pendingInitRange: HlsByteRange | null = null;
  let pendingRange: { length: number; offset: number | null } | null = null;
  /** Next implicit offset per resolved URI (RFC 8216 4.3.2.2). */
  const nextOffsetByUri = new Map<string, number>();
  let discontinuityNext = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.split(':')[1]);
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.split(':')[1]) || 0;
    } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      playlistType = line.split(':')[1]?.trim() ?? null;
    } else if (line === '#EXT-X-ENDLIST') {
      endList = true;
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuityNext = true;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line);
      pendingInit = attrs['URI'] ? resolveUrl(baseUrl, attrs['URI'], baseUrl) : null;
      // EXT-X-MAP may carry its own BYTERANGE for the init section.
      if (attrs['BYTERANGE'] !== undefined) {
        const { length, offset } = parseByteRangeValue(attrs['BYTERANGE']);
        const mapUri = pendingInit ?? baseUrl;
        const resolved = offset ?? nextOffsetByUri.get(mapUri) ?? 0;
        pendingInitRange = { offset: resolved, length };
        nextOffsetByUri.set(mapUri, resolved + length);
      } else {
        pendingInitRange = null;
      }
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByteRangeValue(line.slice('#EXT-X-BYTERANGE:'.length));
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = Number(line.slice(8).split(',')[0]) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line);
      if ((attrs['METHOD'] ?? 'NONE') !== 'NONE') {
        throw new Error('Encrypted HLS stream (EXT-X-KEY) is not supported');
      }
    } else if (!line.startsWith('#')) {
      if (segments.length >= maxSegments) throw new Error('HLS segment count exceeds limit');
      const uri = resolveUrl(baseUrl, line, baseUrl);
      let byteRange: HlsByteRange | null = null;
      if (pendingRange) {
        const offset = pendingRange.offset ?? nextOffsetByUri.get(uri) ?? 0;
        byteRange = { offset, length: pendingRange.length };
        nextOffsetByUri.set(uri, offset + pendingRange.length);
        pendingRange = null;
      }
      segments.push({
        uri,
        duration: pendingDuration,
        sequence: mediaSequence + segments.length,
        discontinuity: discontinuityNext,
        initSection: pendingInit,
        initByteRange: pendingInitRange,
        byteRange,
      });
      pendingDuration = 0;
      discontinuityNext = false;
    }
  }

  const isLive = !endList && playlistType !== 'VOD';
  return { segments, targetDuration, endList, playlistType, isLive };
}

export function pickVariant(master: HlsMaster, mode: 'highest' | number): HlsVariant | null {
  if (master.variants.length === 0) return null;
  if (typeof mode === 'number') {
    const byHeight = [...master.variants].sort((a, b) => (a.height ?? 0) - (b.height ?? 0));
    let best: HlsVariant | null = null;
    for (const v of byHeight) {
      if ((v.height ?? 0) <= mode) best = v;
    }
    return best ?? byHeight[0] ?? null;
  }
  return [...master.variants].sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0] ?? null;
}
