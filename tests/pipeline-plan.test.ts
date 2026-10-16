import { describe, expect, it } from 'vitest';
import {
  MAX_JOB_BYTES,
  estimateDashCount,
  estimateSize,
  labelFor,
  planDashJob,
  planHlsJob,
  segName,
} from '../src/media/pipeline.js';
import { parseMpd } from '../src/manifests/dash/parser.js';

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720
high.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:6.0,
s1.ts
#EXTINF:6.0,
s2.ts
#EXT-X-ENDLIST
`;

const MPD = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT12S" xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <SegmentTemplate media="v-$Number$.m4s" initialization="v-init.mp4" startNumber="0" duration="6" timescale="1"/>
      <Representation id="v1" bandwidth="1000000" width="640" height="360"/>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4">
      <SegmentTemplate media="a-$Number$.m4s" initialization="a-init.mp4" startNumber="0" duration="6" timescale="1"/>
      <Representation id="a1" bandwidth="128000"/>
    </AdaptationSet>
  </Period>
</MPD>`;

describe('hls job planning', () => {
  it('resolves master + variant + segments without network', () => {
    const plan = planHlsJob(MASTER, 'https://cdn.example.com/hls/master.m3u8', () => MEDIA, '1', 2000);
    expect(plan.playlistUrl).toBe('https://cdn.example.com/hls/high.m3u8');
    expect(plan.segmentUrls).toHaveLength(2);
    expect(plan.segmentUrls[0]).toBe('https://cdn.example.com/hls/s1.ts');
    expect(plan.durationSec).toBe(12);
    expect(plan.live).toBe(false);
  });

  it('supports highest selection', () => {
    const plan = planHlsJob(MASTER, 'https://e.com/m.m3u8', () => MEDIA, 'highest', 2000);
    expect(plan.variant.height).toBe(720);
  });

  it('rejects live playlists', () => {
    const live = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\ns1.ts\n';
    expect(() => planHlsJob(MASTER, 'https://e.com/m.m3u8', () => live, '0', 2000)).toThrow(/Live/);
  });
});

describe('dash job planning', () => {
  it('resolves video + audio tracks and segment urls', () => {
    const plan = planDashJob(MPD, 'https://cdn.example.com/d/m.mpd', 'highest', 2000);
    expect(plan.video.height).toBe(360);
    expect(plan.audio?.id).toBe('a1');
    expect(plan.videoUrls).toHaveLength(2);
    expect(plan.videoInit).toContain('v-init.mp4');
    expect(plan.audioUrls).toHaveLength(2);
  });

  it('rejects dynamic/live manifests', () => {
    expect(() =>
      planDashJob(MPD.replace('type="static"', 'type="dynamic"'), 'https://e.com/m.mpd', 'highest', 2000),
    ).toThrow(/Live/);
  });

  it('estimates segment counts from duration', () => {
    const manifest = parseMpd(MPD, 'https://e.com/m.mpd');
    const rep = manifest.adaptationSets[0]?.representations[0];
    if (!rep) throw new Error('missing rep');
    expect(estimateDashCount(manifest, rep, 2000)).toBe(2);
  });
});

describe('pipeline helpers', () => {
  it('labels variants honestly (no invented resolutions)', () => {
    expect(labelFor(null, 720, 2400000)).toBe('720p · 2.4 Mbps');
    expect(labelFor(null, null, null)).toBe('default');
  });

  it('estimates sizes and caps jobs', () => {
    expect(estimateSize(8000000, 60)).toBe(60_000_000);
    expect(estimateSize(null, 60)).toBeNull();
    expect(MAX_JOB_BYTES).toBe(500_000_000);
  });

  it('generates memfs-safe segment names (never from remote input)', () => {
    expect(segName('hls', 'v', 3, true)).toBe('hls_v_00003.ts');
    expect(segName('dash', 'vinit', 0, false)).toBe('dash_vinit_00000.m4s');
    expect(segName('hls', '../../evil', 0, true)).not.toContain('/');
  });
});
