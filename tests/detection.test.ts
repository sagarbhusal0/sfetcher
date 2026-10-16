import { describe, expect, it } from 'vitest';
import { classifyMedia, dedupeMedia } from '../src/detection/classify.js';

describe('detection', () => {
  it('detects direct mp4 by extension', () => {
    const m = classifyMedia({ url: 'https://cdn.example.com/v/clip.mp4', tabId: 1, source: 'network' });
    expect(m?.kind).toBe('video-direct');
    expect(m?.fileExtension).toBe('mp4');
  });

  it('detects webm and audio urls', () => {
    expect(classifyMedia({ url: 'https://e.com/a.webm', tabId: 1, source: 'dom' })?.kind).toBe('video-direct');
    expect(classifyMedia({ url: 'https://e.com/song.mp3', tabId: 1, source: 'dom' })?.kind).toBe('audio-direct');
  });

  it('classifies by mime type', () => {
    const m = classifyMedia({
      url: 'https://e.com/stream?id=123',
      mimeType: 'video/mp4',
      tabId: 1,
      source: 'network',
    });
    expect(m?.kind).toBe('video-direct');
  });

  it('detects hls and dash manifests', () => {
    expect(classifyMedia({ url: 'https://e.com/live.m3u8', tabId: 1, source: 'network' })?.kind).toBe('hls');
    expect(classifyMedia({ url: 'https://e.com/manifest.mpd', tabId: 1, source: 'network' })?.kind).toBe('dash');
  });

  it('filters false positives (non-media binary)', () => {
    expect(classifyMedia({ url: 'https://e.com/app.wasm', tabId: 1, source: 'network' })).toBeNull();
  });

  it('rejects unsafe schemes and blob urls', () => {
    expect(classifyMedia({ url: 'blob:https://e.com/123', tabId: 1, source: 'dom' })).toBeNull();
    expect(classifyMedia({ url: 'javascript:alert(1)', tabId: 1, source: 'dom' })).toBeNull();
  });

  it('dedupes and merges metadata', () => {
    const a = classifyMedia({ url: 'https://e.com/a.mp4', tabId: 2, source: 'dom' });
    const b = classifyMedia({ url: 'https://e.com/a.mp4', tabId: 2, source: 'network', mimeType: 'video/mp4' });
    expect(a && b && dedupeMedia([a, b])).toHaveLength(1);
  });
});
