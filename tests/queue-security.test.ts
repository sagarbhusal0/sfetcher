import { describe, expect, it } from 'vitest';
import { canTransition, createQueueItem, transition } from '../src/storage/prefs.js';
import { sanitizeFilename, joinDownloadPath, isAllowedUrl } from '../src/shared/utils.js';
import { parseMessage } from '../src/messaging/schemas.js';
import { planRemux, sniffContainer } from '../src/media/remux.js';

describe('queue', () => {
  it('orders valid transitions and rejects invalid ones', () => {
    expect(canTransition('pending', 'active')).toBe(true);
    expect(canTransition('completed', 'active')).toBe(false);
    const item = createQueueItem({ mediaId: 'm1', url: 'https://e.com/a.mp4', filename: 'a.mp4', kind: 'video-direct' });
    expect(item.status).toBe('pending');
    const active = transition(item, 'active');
    expect(active.status).toBe('active');
    expect(() => transition(active, 'pending')).toThrow();
  });

  it('sanitizes filenames and blocks traversal', () => {
    expect(sanitizeFilename('../../etc/passwd')).not.toContain('/');
    expect(sanitizeFilename('a<b>c?.mp4')).toBe('a_b_c_.mp4');
    expect(joinDownloadPath('Sfetcher', '../../x.mp4')).toBe('Sfetcher/x.mp4');
  });
});

describe('security', () => {
  it('accepts content-script detections with unknown tab (-1)', () => {
    const msg = parseMessage({
      type: 'MEDIA_DETECTED',
      payload: {
        items: [
          {
            id: 'm1',
            tabId: -1,
            url: 'https://e.com/a.mp4',
            kind: 'video-direct',
            source: 'dom',
            fileExtension: 'mp4',
            mimeType: null,
            container: 'mp4',
            codecs: null,
            width: null,
            height: null,
            durationSec: null,
            hostname: 'e.com',
            estimatedSizeBytes: null,
            detectedAt: Date.now(),
            title: null,
          },
        ],
      },
    });
    expect(msg?.type).toBe('MEDIA_DETECTED');
  });

  it('rejects unsafe urls and invalid messages', () => {
    expect(isAllowedUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedUrl('https://e.com/v.mp4')).toBe(true);
    expect(parseMessage({ type: 'NOPE' })).toBeNull();
    expect(
      parseMessage({ type: 'START_DIRECT_DOWNLOAD', payload: { mediaId: '', url: 'x', filename: '' } }),
    ).toBeNull();
  });

  it('plans remux honestly and sniffs containers', () => {
    expect(planRemux({ container: 'unknown', segmentCount: 5, initPresent: false }).kind).toBe('unsupported');
    expect(planRemux({ container: 'fmp4', segmentCount: 3, initPresent: false }).kind).toBe('unsupported');
    expect(planRemux({ container: 'ts', segmentCount: 3, initPresent: false }).kind).toBe('ts-to-mp4');
    const ts = new Uint8Array(188);
    ts[0] = 0x47;
    expect(sniffContainer(ts)).toBe('ts');
  });
});
