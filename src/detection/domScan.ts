/**
 * Pure page/frame media discovery.
 *
 * Separated from the content-script entrypoint so the exact same logic runs
 * under automated DOM fixtures (jsdom) and in real frames. No chrome APIs,
 * no network access — classification only. Callers deliver items/diags.
 */
import { classifyWithReason } from './classify.js';
import { makeDiag, type DiagEvent } from './diagnose.js';
import { extensionFromUrl, stableId } from '../shared/utils.js';
import type { DetectedMedia } from '../shared/types.js';

export interface ScanContext {
  /** True when running inside a subframe (player iframes included). */
  inFrame: boolean;
  pageHostname: string;
  title: string;
}

export interface ScanStats {
  videos: number;
  blobOnly: number;
  embeds: number;
  items: number;
}

export interface ScanOutcome {
  items: DetectedMedia[];
  diags: DiagEvent[];
  stats: ScanStats;
  iframeHosts: string[];
  signature: string;
}

const LINK_MEDIA_RE =
  /\.(mp4|webm|mov|mkv|m4v|mp3|m4a|ogg|oga|wav|flac|opus|m3u8|mpd)(\?|#|$)/i;

function elText(el: Element, fallback: string): string {
  return el.textContent?.trim().slice(0, 120) || fallback;
}

export function scanRoot(root: ParentNode, ctx: ScanContext): ScanOutcome {
  const items: DetectedMedia[] = [];
  const diags: DiagEvent[] = [];
  let videos = 0;
  let blobOnly = 0;

  const mediaEls =
    root instanceof Document || root instanceof Element
      ? root.querySelectorAll('video, audio')
      : [];
  mediaEls.forEach((el) => {
    const media = el as HTMLMediaElement;
    videos++;
    const candidates: string[] = [];
    if (media.currentSrc) candidates.push(media.currentSrc);
    if (media.src) candidates.push(media.src);
    // <source> children (quality variants) and <track> elements (subtitles/
    // captions — evaluated honestly; non-media kinds are filtered out).
    media.querySelectorAll('source, track').forEach((s) => {
      const src = (s as HTMLElement).getAttribute('src');
      if (src) candidates.push(src);
    });
    let sawBlob = false;
    for (const url of candidates) {
      if (!url) continue;
      if (url.startsWith('blob:') || url.startsWith('data:')) {
        sawBlob = true;
        continue;
      }
      const res = classifyWithReason({
        url,
        mimeType: null,
        resourceType: 'media',
        tabId: -1,
        source: 'dom',
        width: (media as HTMLVideoElement).videoWidth ?? null,
        height: (media as HTMLVideoElement).videoHeight ?? null,
        durationSec: Number.isFinite(media.duration) ? media.duration : null,
        title: ctx.title,
      });
      if (res.ok) items.push(res.media);
    }
    if (sawBlob && candidates.every((u) => !u || u.startsWith('blob:') || u.startsWith('data:'))) {
      // Player element exists but its only source is opaque (MSE/HLS).
      // Evidence of playback — not a downloadable resource.
      blobOnly++;
      diags.push(makeDiag(-1, 'blob-source-skipped', null, `frame=${ctx.inFrame ? 'sub' : 'top'}`));
    }
    const hintAttrs = [
      media.getAttribute('data-hls-url'),
      media.getAttribute('data-dash-url'),
    ];
    for (const hint of hintAttrs) {
      if (!hint || hint.startsWith('blob:')) continue;
      const res = classifyWithReason({
        url: hint,
        mimeType: null,
        resourceType: 'xmlhttprequest',
        tabId: -1,
        source: 'manifest-hint',
        title: ctx.title,
      });
      if (res.ok) items.push(res.media);
    }
  });

  // Embedded players: hostnames only (embed URLs may carry tokens).
  const iframeHosts: string[] = [];
  if (!ctx.inFrame) {
    const seen = new Set<string>();
    const frames =
      root instanceof Document || root instanceof Element
        ? root.querySelectorAll('iframe[src]')
        : [];
    frames.forEach((f) => {
      try {
        const host = new URL((f as HTMLIFrameElement).src).hostname;
        if (host && host !== ctx.pageHostname && !seen.has(host)) {
          seen.add(host);
          iframeHosts.push(host);
        }
      } catch {
        // ignore unparseable embed src
      }
    });
    for (const host of iframeHosts.slice(0, 5)) {
      diags.push(makeDiag(-1, 'iframe-embed-noted', `https://${host}/`, 'embed-player'));
    }
  }

  const links =
    root instanceof Document || root instanceof Element ? root.querySelectorAll('a[href]') : [];
  links.forEach((a) => {
    const href = (a as HTMLAnchorElement).href;
    if (!href || href.startsWith('blob:') || href.startsWith('data:')) return;
    if (!LINK_MEDIA_RE.test(href)) return;
    const res = classifyWithReason({
      url: href,
      mimeType: null,
      resourceType: 'link',
      tabId: -1,
      source: 'dom',
      title: elText(a, ctx.title),
    });
    if (res.ok) items.push(res.media);
  });

  const stats: ScanStats = { videos, blobOnly, embeds: iframeHosts.length, items: items.length };
  // Hash item identities into the signature so a source-URL *change* (same
  // counts, different resources) triggers a diagnostics refresh.
  const uhash = stableId(items.map((i) => i.id).sort().join('|'));
  const signature = `v=${videos} b=${blobOnly} f=${iframeHosts.length} i=${items.length} u=${uhash} frame=${ctx.inFrame ? 'sub' : 'top'}`;
  diags.unshift(
    makeDiag(
      -1,
      'scan-summary',
      null,
      `videos=${videos} blobOnly=${blobOnly} embeds=${iframeHosts.length} items=${items.length} ${ctx.inFrame ? 'subframe' : 'top'}`,
    ),
  );
  return { items, diags, stats, iframeHosts, signature };
}

export interface ResourceEntry {
  /** Resolved request URL as reported by the timing API. */
  name: string;
}

export interface TimingOutcome {
  /** Manifests / direct media worth reporting as items. */
  items: DetectedMedia[];
  /** Segment hosts seen (diagnostic association only, never items). */
  segHosts: string[];
}

/**
 * Classify subresource URLs observed via PerformanceResourceTiming inside a
 * frame. This needs no extra permissions and sees the XHR/fetch requests an
 * in-frame HLS/DASH player makes — including manifests behind blob: video
 * elements. Only manifest/media extensions become items; proof of segment
 * traffic is returned as hostnames for diagnostics.
 */
export function scanResourceTiming(
  entries: ResourceEntry[],
  title: string,
  cap = 150,
): TimingOutcome {
  const items: DetectedMedia[] = [];
  const segHosts: string[] = [];
  const seenSeg = new Set<string>();
  for (const entry of entries.slice(-cap)) {
    const url = entry.name;
    if (!url || url.startsWith('blob:') || url.startsWith('data:')) continue;
    const ext = extensionFromUrl(url);
    if (ext === 'm3u8' || ext === 'mpd') {
      const res = classifyWithReason({
        url,
        mimeType: null,
        resourceType: 'resource-timing',
        tabId: -1,
        source: 'dom',
        title,
      });
      if (res.ok) items.push(res.media);
      continue;
    }
    if (ext && ['ts', 'm4s', 'cmfv', 'cmfa'].includes(ext)) {
      try {
        const host = new URL(url).hostname;
        if (host && !seenSeg.has(host)) {
          seenSeg.add(host);
          segHosts.push(host);
        }
      } catch {
        // ignore
      }
    }
  }
  return { items, segHosts };
}
