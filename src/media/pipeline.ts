import {
  parseMaster,
  parseMediaPlaylist,
  pickVariant,
  type HlsMaster,
  type HlsVariant,
} from '../manifests/hls/parser.js';
import {
  buildSegmentUrls,
  parseMpd,
  type DashManifest,
  type DashRepresentation,
} from '../manifests/dash/parser.js';

export const MAX_JOB_BYTES = 500_000_000;

export interface VariantOption {
  id: string;
  label: string;
  width: number | null;
  height: number | null;
  bandwidth: number | null;
  codecs: string | null;
  estSizeBytes: number | null;
}

export function labelFor(
  width: number | null,
  height: number | null,
  bandwidth: number | null,
): string {
  const res = height ? `${height}p` : width ? `${width}w` : null;
  const bw = bandwidth ? `${(bandwidth / 1_000_000).toFixed(1)} Mbps` : null;
  return [res, bw].filter(Boolean).join(' · ') || 'default';
}

export function estimateSize(bandwidth: number | null, durationSec: number | null): number | null {
  if (!bandwidth || !durationSec || durationSec <= 0) return null;
  return Math.round((bandwidth / 8) * durationSec);
}

export interface HlsJobPlan {
  kind: 'hls';
  playlistUrl: string;
  variant: HlsVariant;
  segmentUrls: string[];
  initUrl: string | null;
  durationSec: number;
  live: boolean;
}

/** Resolve a master playlist to a concrete VOD job plan (pure, testable). */
export function planHlsJob(
  masterText: string,
  manifestUrl: string,
  mediaTextFor: (playlistUrl: string) => string,
  variantId: string,
  maxSegments: number,
): HlsJobPlan {
  const master = parseMaster(masterText, manifestUrl);
  if (master.variants.length === 0) throw new Error('HLS master has no variants');
  const variant =
    variantId === 'highest'
      ? pickVariant(master, 'highest')
      : (master.variants[Number(variantId)] ?? pickVariant(master, 'highest'));
  if (!variant) throw new Error('No HLS variant available');
  const mediaText = mediaTextFor(variant.uri);
  const media = parseMediaPlaylist(mediaText, variant.uri, { maxSegments });
  if (media.isLive) throw new Error('Live HLS streams are not supported in this release');
  const durationSec = media.segments.reduce((a, s) => a + s.duration, 0);
  return {
    kind: 'hls',
    playlistUrl: variant.uri,
    variant,
    segmentUrls: media.segments.map((s) => s.uri),
    initUrl: media.segments[0]?.initSection ?? null,
    durationSec,
    live: false,
  };
}

export interface DashJobPlan {
  kind: 'dash';
  manifest: DashManifest;
  video: DashRepresentation;
  audio: DashRepresentation | null;
  videoUrls: string[];
  videoInit: string | null;
  audioUrls: string[];
  audioInit: string | null;
  durationSec: number | null;
}

function pickVideoRep(manifest: DashManifest, variantId: string): DashRepresentation {
  const videoSets = manifest.adaptationSets.filter((a) =>
    (a.mimeType ?? '').startsWith('video'),
  );
  const reps = videoSets.flatMap((a) => a.representations);
  if (reps.length === 0) throw new Error('DASH manifest has no video representations');
  if (variantId === 'highest') {
    return [...reps].sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0] as DashRepresentation;
  }
  const byId = reps.find((r) => r.id === variantId);
  if (byId) return byId;
  const byIdx = reps[Number(variantId)];
  if (byIdx) return byIdx;
  throw new Error('Requested DASH representation not found');
}

function pickAudioRep(manifest: DashManifest): DashRepresentation | null {
  const audioSets = manifest.adaptationSets.filter((a) =>
    (a.mimeType ?? '').startsWith('audio'),
  );
  const reps = audioSets.flatMap((a) => a.representations);
  if (reps.length === 0) return null;
  return [...reps].sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0] as DashRepresentation;
}

export function estimateDashCount(
  manifest: DashManifest,
  rep: DashRepresentation,
  maxSegments: number,
): number {
  if (rep.segmentList) return Math.min(rep.segmentList.media.length, maxSegments);
  const tpl = rep.segmentTemplate;
  if (rep.timeline && rep.timeline.length > 0) {
    let n = 0;
    for (const s of rep.timeline) n += 1 + (s.r < 0 ? 0 : s.r);
    return Math.min(n, maxSegments);
  }
  if (tpl?.duration && manifest.durationSec) {
    const n = Math.ceil((manifest.durationSec * tpl.timescale) / tpl.duration);
    return Math.min(Math.max(n, 1), maxSegments);
  }
  return Math.min(200, maxSegments);
}

/** Resolve a static MPD to a concrete VOD job plan (pure, testable). */
export function planDashJob(
  mpdText: string,
  manifestUrl: string,
  variantId: string,
  maxSegments: number,
): DashJobPlan {
  const manifest = parseMpd(mpdText, manifestUrl);
  if (manifest.isLive) throw new Error('Live/dynamic DASH streams are not supported in this release');
  const video = pickVideoRep(manifest, variantId);
  const audio = pickAudioRep(manifest);
  if (video.contentProtection) {
    throw new Error('DASH content protection (DRM) on the video track is not supported');
  }
  if (audio?.contentProtection) {
    throw new Error('DASH content protection (DRM) on the audio track is not supported');
  }
  const vBuilt = buildSegmentUrls(video, { count: estimateDashCount(manifest, video, maxSegments) });
  const aBuilt = audio
    ? buildSegmentUrls(audio, { count: estimateDashCount(manifest, audio, maxSegments) })
    : { init: null, media: [] as string[] };
  if (vBuilt.media.length === 0) throw new Error('DASH representation produced no segments');
  return {
    kind: 'dash',
    manifest,
    video,
    audio,
    videoUrls: vBuilt.media,
    videoInit: vBuilt.init,
    audioUrls: aBuilt.media,
    audioInit: aBuilt.init,
    durationSec: manifest.durationSec,
  };
}

/** MEMFS-safe generated names — never derived from remote input. */
export function segName(kind: 'hls' | 'dash', track: string, i: number, ts: boolean): string {
  const safeTrack = track.replace(/[^a-z0-9]/gi, '').slice(0, 12) || 't';
  return `${kind}_${safeTrack}_${String(Math.max(0, Math.floor(i))).padStart(5, '0')}.${ts ? 'ts' : 'm4s'}`;
}

/**
 * Resolve the separate audio playlist for a selected HLS variant.
 * Returns the audio media-playlist URL, or null when audio is in-band
 * (no AUDIO group, or the selected rendition has no URI).
 * Throws when an explicitly selected audio id is not in the master.
 */
export function resolveHlsAudio(
  master: HlsMaster,
  variant: HlsVariant,
  audioId: string | null | undefined,
): string | null {
  const audios = master.renditions.filter((r) => r.type === 'AUDIO');
  if (audioId) {
    const sep = audioId.indexOf('::');
    const groupId = sep >= 0 ? audioId.slice(0, sep) : audioId;
    const name = sep >= 0 ? audioId.slice(sep + 2) : '';
    const found = audios.find((r) => r.groupId === groupId && r.name === name);
    if (!found) throw new Error('Selected audio track is not available in this playlist');
    return found.uri;
  }
  if (!variant.audioGroup) return null;
  const group = audios.filter((r) => r.groupId === variant.audioGroup && r.uri != null);
  if (group.length === 0) return null;
  return (group.find((r) => r.default) ?? group[0])?.uri ?? null;
}

export type SniffedContainer = 'ts' | 'fmp4' | 'unknown';

export interface HlsMuxPlan {
  /** True when a separate audio playlist must be downloaded and packaged. */
  hasSeparateAudio: boolean;
  videoStrategy: 'concat-demuxer' | 'concat-protocol';
  audioStrategy: 'concat-demuxer' | 'concat-protocol' | null;
  /** TS audio needs ADTS→ASC reframing when moved into MP4. */
  audioNeedsAdtsFix: boolean;
}

/**
 * Choose remux strategies from sniffed input containers (pure, testable).
 * Throws an actionable error for unknown/unsupported combinations —
 * callers must never concat-and-rename on this path.
 */
export function planHlsMux(
  videoContainer: SniffedContainer,
  audioContainer: SniffedContainer | null,
): HlsMuxPlan {
  if (videoContainer === 'unknown') {
    throw new Error('Unrecognized video container: transcode required (not bundled; see README)');
  }
  if (audioContainer === 'unknown') {
    throw new Error('Unrecognized audio container: transcode required (not bundled; see README)');
  }
  if (audioContainer === null) {
    return {
      hasSeparateAudio: false,
      videoStrategy: videoContainer === 'ts' ? 'concat-demuxer' : 'concat-protocol',
      audioStrategy: null,
      audioNeedsAdtsFix: false,
    };
  }
  return {
    hasSeparateAudio: true,
    videoStrategy: videoContainer === 'ts' ? 'concat-demuxer' : 'concat-protocol',
    audioStrategy: audioContainer === 'ts' ? 'concat-demuxer' : 'concat-protocol',
    audioNeedsAdtsFix: audioContainer === 'ts',
  };
}
