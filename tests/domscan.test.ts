/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { scanResourceTiming, scanRoot } from '../src/detection/domScan.js';
import { dedupeMedia } from '../src/detection/classify.js';
import { filterMedia } from '../src/detection/filter.js';
import { isSegmentUrl } from '../src/shared/utils.js';
import { parseMessage } from '../src/messaging/schemas.js';

const TOP = { inFrame: false, pageHostname: 'anikoto.example', title: 'Episode 1' };
const SUB = { inFrame: true, pageHostname: 'embed.example', title: 'Player' };

function doc(html: string): Document {
  const d = document.implementation.createHTMLDocument('t');
  d.body.innerHTML = html;
  return d;
}

describe('initial scan', () => {
  it('detects video src, source children, and manifest links', () => {
    const d = doc(`
      <video src="https://cdn.example.com/v/ep1.mp4"></video>
      <video><source src="https://cdn.example.com/v/ep1.webm"></video>
      <a href="https://cdn.example.com/hls/index.m3u8">watch</a>
    `);
    const out = scanRoot(d, TOP);
    const urls = out.items.map((i) => i.url);
    expect(urls).toContain('https://cdn.example.com/v/ep1.mp4');
    expect(urls).toContain('https://cdn.example.com/v/ep1.webm');
    expect(urls).toContain('https://cdn.example.com/hls/index.m3u8');
    expect(out.stats.videos).toBe(2);
  });

  it('ignores non-media anchors and scripts', () => {
    const d = doc(`<a href="https://e.example/page">x</a><a href="https://e.example/app.js">y</a>`);
    expect(scanRoot(d, TOP).items).toHaveLength(0);
  });
});

describe('dynamic pages', () => {
  it('detects dynamically inserted video elements on rescan', () => {
    const d = doc(`<div id="player"></div>`);
    expect(scanRoot(d, TOP).items).toHaveLength(0);
    const v = d.createElement('video');
    v.setAttribute('src', 'https://cdn.example.com/v/late.mp4');
    d.getElementById('player')?.appendChild(v);
    const out = scanRoot(d, TOP);
    expect(out.items.map((i) => i.url)).toContain('https://cdn.example.com/v/late.mp4');
  });

  it('picks up changed source urls (signature changes, both eau)', () => {
    const d = doc(`<video src="https://cdn.example.com/v/a.mp4"></video>`);
    const first = scanRoot(d, TOP);
    d.querySelector('video')?.setAttribute('src', 'https://cdn.example.com/v/b.mp4');
    const second = scanRoot(d, TOP);
    expect(second.signature).not.toBe(first.signature);
    const merged = dedupeMedia(
      [...first.items, ...second.items].map((i) => ({ ...i, tabId: 9 })),
    );
    expect(merged.map((i) => i.url).sort()).toEqual([
      'https://cdn.example.com/v/a.mp4',
      'https://cdn.example.com/v/b.mp4',
    ]);
  });
});

describe('blob-backed playback (Anikoto case)', () => {
  it('reports no item but records blob evidence + stats', () => {
    const d = doc(`<video src="blob:https://embed.example/uuid-123"></video>`);
    const out = scanRoot(d, SUB);
    expect(out.items).toHaveLength(0);
    expect(out.stats.blobOnly).toBe(1);
    expect(out.stats.videos).toBe(1);
    expect(out.diags.some((e) => e.reason === 'blob-source-skipped')).toBe(true);
  });

  it('does not offer blob urls as downloads', () => {
    const d = doc(`<video src="blob:https://embed.example/u"></video><a href="blob:https://x/y">b</a>`);
    const out = scanRoot(d, SUB);
    expect(out.items.every((i) => !i.url.startsWith('blob:'))).toBe(true);
  });
});

describe('iframes and cross-frame duplicates', () => {
  it('notes cross-origin embed hosts, excludes same-host frames', () => {
    const d = doc(`
      <iframe src="https://embed.example/player?id=1"></iframe>
      <iframe src="https://anikoto.example/embed-self"></iframe>
    `);
    const out = scanRoot(d, TOP);
    expect(out.iframeHosts).toEqual(['embed.example']);
    expect(out.diags.some((e) => e.reason === 'iframe-embed-noted')).toBe(true);
    // Full embed URL (with query token) never lands in diagnostics.
    expect(JSON.stringify(out.diags)).not.toContain('id=1');
  });

  it('subframes do not rescan embeds (no loops, no dup notes)', () => {
    const d = doc(`<iframe src="https://other.example/x"></iframe>`);
    const out = scanRoot(d, SUB);
    expect(out.iframeHosts).toHaveLength(0);
  });

  it('same resource found in top frame and embed frame dedupes to one', () => {
    const top = scanRoot(doc(`<video src="https://cdn.example.com/hls/index.m3u8"></video>`), TOP);
    const sub = scanRoot(doc(`<video src="https://cdn.example.com/hls/index.m3u8"></video>`), SUB);
    const merged = dedupeMedia(
      [...top.items, ...sub.items].map((i) => ({ ...i, tabId: 7 })),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.kind).toBe('hls');
  });
});

describe('resource-timing signal (no extra permissions)', () => {
  it('detects manifests fetched by in-frame players', () => {
    const { items } = scanResourceTiming(
      [
        { name: 'https://cdn.example.com/app.js' },
        { name: 'https://stream.example.com/hls/playlist.m3u8?token=abc' },
      ],
      'Episode 1',
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('hls');
  });

  it('reports segment traffic as hosts, never as items', () => {
    const { items, segHosts } = scanResourceTiming(
      [
        { name: 'https://stream.example.com/hls/seg1.ts' },
        { name: 'https://stream.example.com/hls/seg2.m4s' },
      ],
      't',
    );
    expect(items).toHaveLength(0);
    expect(segHosts).toEqual(['stream.example.com']);
  });

  it('ignores extension-less and blob entries', () => {
    const { items, segHosts } = scanResourceTiming(
      [{ name: 'https://api.example.com/ping' }, { name: 'blob:https://x/u' }],
      't',
    );
    expect(items).toHaveLength(0);
    expect(segHosts).toHaveLength(0);
  });
});

describe('segment pattern helper', () => {
  it('matches common segment extensions incl. tokenized urls', () => {
    expect(isSegmentUrl('https://c.example/s/0.ts')).toBe(true);
    expect(isSegmentUrl('https://c.example/s/0.m4s?token=x')).toBe(true);
    expect(isSegmentUrl('https://c.example/v.mp4')).toBe(false);
    expect(isSegmentUrl('https://c.example/hls/index.m3u8')).toBe(false);
  });
});

describe('messaging and permission failures', () => {
  it('drops malformed messages', () => {
    expect(parseMessage(null)).toBeNull();
    expect(parseMessage({ type: 'MEDIA_DETECTED' })).toBeNull();
    expect(parseMessage({ type: 'GET_TAB_MEDIA', payload: { tabId: -1 } })).toBeNull();
  });

  it('caps diag batches (no log flooding)', () => {
    const events = Array.from({ length: 21 }, (_, i) => ({
      t: i,
      tabId: -1,
      reason: 'scan-summary' as const,
      host: null,
      detail: 'x',
    }));
    expect(parseMessage({ type: 'DIAG_EVENT', payload: { events } })).toBeNull();
  });
});

describe('popup state sync', () => {
  it('merges stored + live detections and filters honestly', () => {
    const stored = scanRoot(doc(`<video src="https://cdn.example.com/v/a.mp4"></video>`), TOP).items.map(
      (i) => ({ ...i, tabId: 5 }),
    );
    const live = scanRoot(doc(`<video src="https://cdn.example.com/hls/index.m3u8"></video>`), TOP).items.map(
      (i) => ({ ...i, tabId: 5 }),
    );
    // Mirrors background GET_TAB_MEDIA merge: stored + cached, deduped.
    const merged = dedupeMedia([...stored, ...live]);
    expect(merged).toHaveLength(2);
    expect(filterMedia(merged, '', 'all')).toHaveLength(2);
    expect(filterMedia(merged, 'm3u8', 'all')).toHaveLength(1);
    expect(filterMedia(merged, '', 'hls').map((i) => i.kind)).toEqual(['hls']);
    expect(filterMedia(merged, 'ANIKOTO', 'all')).toHaveLength(0);
  });
});
