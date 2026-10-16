import { ALLOWED_URL_SCHEMES, MAX_FILENAME_LENGTH, SEGMENT_EXTS } from './constants.js';

export function safeHostname(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname || null;
  } catch {
    return null;
  }
}

export function isAllowedUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return ALLOWED_URL_SCHEMES.has(u.protocol);
  } catch {
    return false;
  }
}

export function extensionFromUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    const last = u.pathname.split('/').pop() ?? '';
    const dot = last.lastIndexOf('.');
    if (dot < 0) return null;
    const ext = last.slice(dot + 1).toLowerCase().split(/[?#;]/)[0] ?? '';
    if (!ext || !/^[a-z0-9]{2,5}$/.test(ext)) return null;
    return ext;
  } catch {
    return null;
  }
}

export function sanitizeFilename(input: string, fallback = 'download'): string {
  let name = input.split(/[\\/]/).pop() ?? input;
  name = name.replace(/[\0-\x1F\x7F<>:"|?*]/g, '_').trim();
  name = name.replace(/^\.+/, '').replace(/\.+$/, '');
  if (!name) name = fallback;
  if (name.length > MAX_FILENAME_LENGTH) {
    const dot = name.lastIndexOf('.');
    if (dot > 0) {
      const ext = name.slice(dot);
      name = name.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
    } else {
      name = name.slice(0, MAX_FILENAME_LENGTH);
    }
  }
  return name;
}

export function joinDownloadPath(subfolder: string, filename: string): string {
  const cleanFolder = sanitizeFilename(subfolder.trim() || 'Sfetcher', 'Sfetcher').replace(
    /\.[^.]+$/,
    '',
  );
  return `${cleanFolder}/${sanitizeFilename(filename)}`;
}

export function isSegmentUrl(rawUrl: string): boolean {
  const ext = extensionFromUrl(rawUrl);
  return ext != null && SEGMENT_EXTS.has(ext);
}

/**
 * Normalize a media URL for duplicate detection: lowercase scheme/host,
 * drop the fragment. Path case and query are preserved — a different token
 * or path is a genuinely different resource and must NOT merge.
 */
export function normalizeMediaUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    u.hash = '';
    return u.toString();
  } catch {
    return rawUrl;
  }
}

export function stableId(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `m${(h >>> 0).toString(16)}${input.length.toString(16)}`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(1)} ${units[u]}`;
}
