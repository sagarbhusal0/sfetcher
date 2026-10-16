import { describe, expect, it } from 'vitest';
import { buildSegmentUrls, parseMpd, substituteTemplate } from '../src/manifests/dash/parser.js';

const MPD = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT60S" xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet mimeType="video/mp4" codecs="avc1.4d401f">
      <SegmentTemplate media="seg-$Number%03d$.m4s" initialization="init.mp4" timescale="1" startNumber="1" duration="6"/>
      <Representation id="v1" bandwidth="1000000" width="640" height="360"/>
      <Representation id="v2" bandwidth="2400000" width="1280" height="720"/>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" lang="en">
      <BaseURL>audio/</BaseURL>
      <Representation id="a1" bandwidth="128000">
        <BaseURL>init.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

describe('dash', () => {
  it('parses static mpd with adaptation sets', () => {
    const m = parseMpd(MPD, 'https://cdn.example.com/dash/manifest.mpd');
    expect(m.type).toBe('static');
    expect(m.isLive).toBe(false);
    expect(m.adaptationSets).toHaveLength(2);
    expect(m.adaptationSets[0]?.representations).toHaveLength(2);
  });

  it('substitutes templates incl. zero-pad and escaped dollars', () => {
    expect(
      substituteTemplate('seg-$Number%03d$.m4s', { Number: 7 }),
    ).toBe('seg-007.m4s');
    expect(substituteTemplate('cost $$5 $Bandwidth$', { Bandwidth: 9 })).toBe('cost $5 9');
  });

  it('builds segment urls with base resolution', () => {
    const m = parseMpd(MPD, 'https://cdn.example.com/dash/manifest.mpd');
    const rep = m.adaptationSets[0]?.representations[0];
    if (!rep) throw new Error('missing rep');
    const built = buildSegmentUrls(rep, { count: 2 });
    expect(built.media[0]).toContain('seg-001.m4s');
    expect(built.init).toContain('init.mp4');
  });

  it('resolves nested base urls', () => {
    const m = parseMpd(MPD, 'https://cdn.example.com/dash/manifest.mpd');
    const audio = m.adaptationSets[1]?.representations[0];
    expect(audio?.baseUrl).toContain('audio/');
  });

  it('flags dynamic as live', () => {
    const live = parseMpd(
      MPD.replace('type="static"', 'type="dynamic"'),
      'https://e.com/m.mpd',
    );
    expect(live.isLive).toBe(true);
  });

  it('rejects malformed xml', () => {
    expect(() => parseMpd('<MPD><unclosed>', 'https://e.com/m.mpd')).toThrow();
  });
});
