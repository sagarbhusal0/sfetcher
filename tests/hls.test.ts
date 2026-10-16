import { describe, expect, it } from 'vitest';
import {
  isMasterPlaylist,
  parseMaster,
  parseMediaPlaylist,
  pickVariant,
} from '../src/manifests/hls/parser.js';

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42e00a,mp4a.40.2",AUDIO="aud"
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"
mid.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.0,
seg1.m4s
#EXT-X-DISCONTINUITY
#EXTINF:6.0,
seg2.m4s
#EXT-X-ENDLIST
`;

describe('hls', () => {
  it('detects master playlists', () => {
    expect(isMasterPlaylist(MASTER)).toBe(true);
    expect(isMasterPlaylist(MEDIA)).toBe(false);
  });

  it('parses variants, audio groups, relative urls', () => {
    const m = parseMaster(MASTER, 'https://cdn.example.com/hls/master.m3u8');
    expect(m.variants).toHaveLength(2);
    expect(m.variants[0]?.uri).toBe('https://cdn.example.com/hls/low.m3u8');
    expect(m.variants[1]?.width).toBe(1280);
    expect(m.renditions[0]?.language).toBe('en');
  });

  it('parses media playlist with init, discontinuity, vod', () => {
    const p = parseMediaPlaylist(MEDIA, 'https://cdn.example.com/hls/mid.m3u8');
    expect(p.segments).toHaveLength(2);
    expect(p.segments[0]?.initSection).toContain('init.mp4');
    expect(p.segments[1]?.discontinuity).toBe(true);
    expect(p.endList).toBe(true);
    expect(p.isLive).toBe(false);
  });

  it('rejects unsafe segment urls', () => {
    expect(() =>
      parseMediaPlaylist('#EXTM3U\n#EXTINF:6,\nfile:///etc/passwd', 'https://e.com/a.m3u8'),
    ).toThrow();
  });

  it('captures AES-128 identity keys instead of rejecting them', () => {
    const p = parseMediaPlaylist(
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.key",IV=0x00000000000000000000000000000001\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST',
      'https://e.com/a.m3u8',
    );
    expect(p.segments[0]?.key?.method).toBe('AES-128');
    expect(p.segments[0]?.key?.uri).toBe('https://e.com/k.key');
    expect(p.segments[0]?.key?.iv).toHaveLength(16);
  });

  it('rejects non-identity and unknown encryption methods explicitly', () => {
    expect(() =>
      parseMediaPlaylist(
        '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k.key"\n#EXTINF:6,\nseg.ts',
        'https://e.com/a.m3u8',
      ),
    ).toThrow(/SAMPLE-AES/);
    expect(() =>
      parseMediaPlaylist(
        '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.key",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:6,\nseg.ts',
        'https://e.com/a.m3u8',
      ),
    ).toThrow(/key format/);
  });

  it('picks highest and capped variants', () => {
    const m = parseMaster(MASTER, 'https://e.com/master.m3u8');
    expect(pickVariant(m, 'highest')?.height).toBe(720);
    expect(pickVariant(m, 480)?.height).toBe(360);
  });

  it('rejects malformed manifests', () => {
    expect(() => parseMaster('not a playlist', 'https://e.com/m.m3u8')).toThrow();
  });
});
