/**
 * Development-only diagnostics for the media-detection pipeline.
 *
 * Privacy rules (hard requirements, covered by tests):
 * - Never log full URLs: query strings and fragments may carry tokens.
 *   Only protocol + hostname + truncated pathname + file extension are kept.
 * - Never log headers, cookies, credentials, or request/response bodies.
 * - Blob UUIDs are dropped; only the page hostname is recorded.
 */
import { extensionFromUrl, safeHostname } from '../shared/utils.js';

export type DiagReason =
  | 'scan-summary'
  | 'blob-source-skipped'
  | 'unsafe-scheme-rejected'
  | 'non-media-filtered'
  | 'iframe-embed-noted'
  | 'network-observed'
  | 'network-classified'
  | 'no-host-access'
  | 'message-dropped-invalid';

export interface DiagEvent {
  t: number;
  tabId: number;
  reason: DiagReason;
  /** Hostname only, never a full URL. */
  host: string | null;
  /** Short, non-sensitive detail (counts, extensions, MIME base). */
  detail: string;
}

export interface SanitizedRef {
  host: string | null;
  ext: string | null;
}

/**
 * Strip a URL down to what is safe for a debug log: hostname + extension.
 * Query, hash, credentials, and blob UUIDs are always discarded.
 */
export function sanitizeRef(rawUrl: string): SanitizedRef {
  if (rawUrl.startsWith('blob:')) {
    // blob:<origin>/<uuid> — the UUID is opaque; keep only the origin host.
    try {
      const inner = rawUrl.slice('blob:'.length);
      return { host: safeHostname(inner), ext: null };
    } catch {
      return { host: null, ext: null };
    }
  }
  return { host: safeHostname(rawUrl), ext: extensionFromUrl(rawUrl) };
}

export function makeDiag(tabId: number, reason: DiagReason, rawUrl: string | null, detail: string): DiagEvent {
  const ref = rawUrl ? sanitizeRef(rawUrl) : { host: null, ext: null as string | null };
  const suffix = rawUrl && ref.ext ? ` ext=${ref.ext}` : '';
  return { t: Date.now(), tabId, reason, host: ref.host, detail: `${detail}${suffix}`.slice(0, 200) };
}

/** Fixed-capacity ring buffer for recent diagnostic events (service-worker memory). */
export class DiagBuffer {
  private events: DiagEvent[] = [];
  constructor(private cap = 200) {}

  push(e: DiagEvent): void {
    this.events.push(e);
    if (this.events.length > this.cap) this.events.splice(0, this.events.length - this.cap);
  }

  recent(n = 50): DiagEvent[] {
    return this.events.slice(-n).reverse();
  }

  countByReason(tabId?: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.events) {
      if (tabId != null && e.tabId !== tabId) continue;
      out[e.reason] = (out[e.reason] ?? 0) + 1;
    }
    return out;
  }

  hostsByReason(reason: DiagReason, tabId?: number, max = 8): string[] {
    const seen: string[] = [];
    for (const e of this.events) {
      if (e.reason !== reason) continue;
      if (tabId != null && e.tabId !== tabId) continue;
      if (e.host && !seen.includes(e.host)) seen.push(e.host);
      if (seen.length >= max) break;
    }
    return seen;
  }

  get size(): number {
    return this.events.length;
  }
}
