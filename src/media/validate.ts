/**
 * Post-mux container validation with mp4box.js (already a dependency).
 *
 * FFmpeg's exit code only proves the muxer ran; this confirms the output
 * is actually a parseable MP4 with the expected streams before the job is
 * reported complete. Never concat-and-rename: no moov/tracks, no success.
 */

import { createFile, type MP4BoxBuffer } from 'mp4box';

interface TrackSummary {
  type?: string;
  codec?: string;
}

interface MoovSummary {
  duration?: number;
  timescale?: number;
  tracks?: TrackSummary[];
}

export interface ValidatedMedia {
  trackCount: number;
  hasVideo: boolean;
  hasAudio: boolean;
  durationSec: number | null;
  codecs: string[];
}

/**
 * Parse `data` as MP4 and assert it carries usable tracks.
 * Throws an actionable error when the container is invalid or when an
 * expected audio track is missing.
 */
export function validateMp4Container(data: Uint8Array, expectAudio: boolean): ValidatedMedia {
  if (data.length < 8) throw new Error('Output failed container validation: empty output');
  let info: MoovSummary;
  try {
    const file = createFile();
    // mp4box requires an ArrayBuffer view carrying a fileStart offset.
    const copy = new Uint8Array(data);
    const ab = Object.assign(copy.buffer, { fileStart: 0 }) as MP4BoxBuffer;
    file.appendBuffer(ab);
    file.flush();
    info = file.getInfo() as unknown as MoovSummary;
  } catch (e) {
    throw new Error(
      `Output failed container validation: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const tracks = info.tracks ?? [];
  if (tracks.length === 0) {
    throw new Error('Output is not a valid MP4: no tracks found (moov missing or corrupt)');
  }
  const hasVideo = tracks.some((t) => t.type === 'video');
  const hasAudio = tracks.some((t) => t.type === 'audio');
  if (!hasVideo) throw new Error('Output validation failed: no video track found');
  if (expectAudio && !hasAudio) {
    throw new Error('Output validation failed: expected audio track is missing');
  }
  const durationSec =
    typeof info.duration === 'number' && typeof info.timescale === 'number' && info.timescale > 0
      ? info.duration / info.timescale
      : null;
  return {
    trackCount: tracks.length,
    hasVideo,
    hasAudio,
    durationSec,
    codecs: tracks.map((t) => t.codec ?? 'unknown'),
  };
}
