import { describe, expect, it } from 'vitest';
import { parseMaster, parseMediaPlaylist } from '../src/manifests/hls/parser.js';
import { parseMpd, buildSegmentUrls } from '../src/manifests/dash/parser.js';
import { planRemux, sniffContainer } from '../src/media/remux.js';

// End-to-end pipeline shape on synthetic fixtures: manifest -> select ->
// resolve segments -> plan remux. No network, no public sites.
describe('vod pipelines', () => {
  it('hls vod: master -> variant -> media playlist -> remux plan', () => {
    const master = parseMaster(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000,RESOLUTION=1280x720\nhigh.m3u8\n',
      'https://e.com/hls/master.m3u8',
    );
    expect(master.variants).toHaveLength(2);
    const media = parseMediaPlaylist(
      '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6,\nseg1.ts\n#EXTINF:6,\nseg2.ts\n#EXT-X-ENDLIST\n',
      master.variants[0]?.uri ?? 'https://e.com/hls/low.m3u8',
    );
    expect(media.isLive).toBe(false);
    expect(media.segments).toHaveLength(2);
    const plan = planRemux({ container: 'ts', segmentCount: media.segments.length, initPresent: false });
    expect(plan.kind).toBe('ts-to-mp4');
    expect(sniffContainer(new Uint8Array(188).fill(0).map((_, i) => (i === 0 ? 0x47 : 0)))).toBe('ts');
  });

  it('dash vod: mpd -> representation -> segments -> remux plan', () => {
    const mpd = parseMpd(
      '<?xml version="1.0"?><MPD type="static" xmlns="urn:mpeg:dash:schema:mpd:2011"><Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate media="s-$Number$.m4s" initialization="i.mp4" startNumber="1"/><Representation id="v1" bandwidth="500"/></AdaptationSet></Period></MPD>',
      'https://e.com/dash/m.mpd',
    );
    const rep = mpd.adaptationSets[0]?.representations[0];
    if (!rep) throw new Error('missing rep');
    const built = buildSegmentUrls(rep, { count: 2 });
    expect(built.media).toHaveLength(2);
    expect(built.init).toContain('i.mp4');
    const plan = planRemux({ container: 'fmp4', segmentCount: built.media.length, initPresent: built.init != null });
    expect(plan.kind).toBe('fmp4-package');
  });
});
