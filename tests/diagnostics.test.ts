import { describe, expect, it } from 'vitest';
import { classifyWithReason } from '../src/detection/classify.js';
import { dedupeMedia } from '../src/detection/classify.js';
import { DiagBuffer, makeDiag, sanitizeRef } from '../src/detection/diagnose.js';
import { diagEventSchema, parseMessage } from '../src/messaging/schemas.js';

describe('diagnostic sanitizer (privacy)', () => {
  it('strips query strings, hashes, and credentials', () => {
    const s = sanitizeRef('https://user:pass@cdn.example.com/v/seg.m3u8?token=SECRET&id=1#frag');
    expect(s.host).toBe('cdn.example.com');
    expect(s.ext).toBe('m3u8');
    const built = makeDiag(3, 'network-observed', 'https://cdn.example.com/v/seg.m3u8?token=SECRET', 'x');
    expect(JSON.stringify(built)).not.toContain('SECRET');
    expect(JSON.stringify(built)).not.toContain('user');
  });

  it('keeps only the origin host for blob urls (drops uuid)', () => {
    const s = sanitizeRef('blob:https://player.example.com/550e8400-e29b-41d4-a716-446655440000');
    expect(s.host).toBe('player.example.com');
    expect(s.ext).toBeNull();
    const built = makeDiag(-1, 'blob-source-skipped', null, 'frame=sub');
    expect(JSON.stringify(built)).not.toContain('550e8400');
  });

  it('rejects oversized detail and non-url input safely', () => {
    expect(sanitizeRef('not a url')).toEqual({ host: null, ext: null });
    const built = makeDiag(1, 'scan-summary', null, 'x'.repeat(500));
    expect(built.detail.length).toBeLessThanOrEqual(200);
  });
});

describe('classifier rejection reasons', () => {
  it('names unsafe schemes', () => {
    const r = classifyWithReason({ url: 'file:///etc/passwd', tabId: 1, source: 'network' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unsafe-scheme-rejected');
  });

  it('names blob urls (iframe MSE players)', () => {
    const r = classifyWithReason({ url: 'blob:https://embed.example/uuid', tabId: 1, source: 'dom' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('blob-url');
  });

  it('names non-media filtering (embed pages, scripts)', () => {
    const r = classifyWithReason({ url: 'https://embed.example/player.html', tabId: 1, source: 'network' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('non-media-filtered');
  });

  it('still accepts real manifest urls', () => {
    const r = classifyWithReason({ url: 'https://cdn.example.com/hls/index.m3u8', tabId: 1, source: 'network' });
    expect(r.ok).toBe(true);
  });
});

describe('iframe-frame reporting (Anikoto case)', () => {
  it('same resource found in top frame and embed frame dedupes to one item', () => {
    // Background stamps sender.tab.id on every frame's report, so both
    // frames produce the same stable id and merge.
    const a = classifyWithReason({ url: 'https://cdn.example.com/hls/index.m3u8', tabId: 7, source: 'dom' });
    const b = classifyWithReason({ url: 'https://cdn.example.com/hls/index.m3u8', tabId: 7, source: 'dom' });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(dedupeMedia([a.media, b.media])).toHaveLength(1);
    }
  });

  it('diag events accept unknown-tab (-1) senders from subframes', () => {
    const e = diagEventSchema.safeParse({
      t: Date.now(),
      tabId: -1,
      reason: 'scan-summary',
      host: null,
      detail: 'videos=1 blobOnly=1 embeds=1 items=0 subframe',
    });
    expect(e.success).toBe(true);
  });
});

describe('diagnostic messages', () => {
  it('parses throttled DIAG_EVENT batches', () => {
    const msg = parseMessage({
      type: 'DIAG_EVENT',
      payload: { events: [{ t: 1, tabId: -1, reason: 'iframe-embed-noted', host: 'embed.example', detail: 'embed-player' }] },
    });
    expect(msg?.type).toBe('DIAG_EVENT');
  });

  it('parses GET_DIAGNOSTICS', () => {
    expect(parseMessage({ type: 'GET_DIAGNOSTICS', payload: { tabId: 4, host: 'anikoto.example' } })?.type).toBe(
      'GET_DIAGNOSTICS',
    );
  });

  it('rejects diag events carrying long free text', () => {
    expect(
      diagEventSchema.safeParse({ t: 1, tabId: 1, reason: 'scan-summary', host: null, detail: 'x'.repeat(500) }).success,
    ).toBe(false);
  });
});

describe('diag buffer', () => {
  it('caps memory and aggregates by reason/host', () => {
    const buf = new DiagBuffer(5);
    for (let i = 0; i < 9; i++) {
      buf.push(makeDiag(7, 'scan-summary', null, `n=${i}`));
    }
    expect(buf.size).toBe(5);
    buf.push(makeDiag(7, 'iframe-embed-noted', 'https://cdn-a.example/', 'embed-player'));
    buf.push(makeDiag(7, 'iframe-embed-noted', 'https://cdn-b.example/', 'embed-player'));
    expect(buf.countByReason(7)['iframe-embed-noted']).toBe(2);
    expect(buf.hostsByReason('iframe-embed-noted', 7)).toEqual(['cdn-a.example', 'cdn-b.example']);
  });
});
