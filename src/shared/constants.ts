export const DIRECT_VIDEO_EXTS = new Set([
  'mp4',
  'webm',
  'mov',
  'mkv',
  'avi',
  'm4v',
  'ogv',
]);

export const DIRECT_AUDIO_EXTS = new Set([
  'mp3',
  'aac',
  'm4a',
  'ogg',
  'oga',
  'wav',
  'flac',
  'opus',
]);

export const MANIFEST_EXTS = new Set(['m3u8', 'mpd']);

/** Media segment extensions: observed for diagnostics/association only —
//  never surfaced as downloadable items on their own. */
export const SEGMENT_EXTS = new Set(['ts', 'm4s', 'cmfv', 'cmfa']);

export const VIDEO_MIME_PREFIX = 'video/';
export const AUDIO_MIME_PREFIX = 'audio/';

export const KNOWN_VIDEO_MIMES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
  'video/ogg',
]);

export const KNOWN_AUDIO_MIMES = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/flac',
  'audio/opus',
  'audio/webm',
]);

export const HLS_MIMES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/x-mpegurl',
]);

export const DASH_MIMES = new Set(['application/dash+xml']);

export const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:']);

export const MAX_FILENAME_LENGTH = 180;
