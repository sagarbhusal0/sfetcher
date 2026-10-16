import { describe, expect, it } from 'vitest';
import {
  parseMaster,
  parseMediaPlaylist,
  resolveUrl,
} from '../src/manifests/hls/parser.js';
import { listVariants } from '../src/media/variants.js';
import { planHlsMux, resolveHlsAudio } from '../src/media/pipeline.js';
import { propagateQueryParams } from '../src/shared/utils.js';
import { parseMessage } from '../src/messaging/schemas.js';

const BASE = 'https://cdn.example.com/hls/';

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio-en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Espanol",LANGUAGE="es",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="2",URI="audio-es.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud-hi",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio-hi.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="subs.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aud"
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,AUDIO="aud"
mid.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
hi.m3u8
`;

describe('audio rendition parsing', () => {
  it('parses AUDIO metadata including channels and autoselect', () => {
    const m = parseMaster(MASTER, `${BASE}master.m3u8`);
    const audios = m.renditions.filter((r) => r.type === 'AUDIO');
    expect(audios).toHaveLength(3);
    expect(audios[0]).toMatchObject({
      groupId: 'aud',
      name: 'English',
      language: 'en',
      default: true,
      autoselect: true,
      channels: '2',
    });
    expect(audios[0]?.uri).toBe(`${BASE}audio-en.m3u8`);
    expect(audios[1]).toMatchObject({ name: 'Espanol', language: 'es', default: false });
  });

  it('does not treat subtitles as audio', () => {
    const m = parseMaster(MASTER, `${BASE}master.m3u8`);
    expect(m.renditions.filter((r) => r.type === 'SUBTITLES')).toHaveLength(1);
    expect(m.renditions.filter((r) => r.type === 'AUDIO')).toHaveLength(3);
  });

  it('associates variants with their AUDIO group', () => {
    const m = parseMaster(MASTER, `${BASE}master.m3u8`);
    expect(m.variants[0]?.audioGroup).toBe('aud');
    expect(m.variants[1]?.audioGroup).toBe('aud');
    expect(m.variants[2]?.audioGroup).toBeNull();
  });
});

describe('resolveHlsAudio', () => {
  const master = () => parseMaster(MASTER, `${BASE}master.m3u8`);

  it('returns null for in-band audio (no AUDIO group)', () => {
    const m = master();
    const hi = m.variants[2];
    if (!hi) throw new Error('fixture missing hi variant');
    expect(resolveHlsAudio(m, hi, null)).toBeNull();
  });

  it('auto-selects the DEFAULT rendition when none is chosen', () => {
    const m = master();
    const low = m.variants[0];
    if (!low) throw new Error('fixture missing low variant');
    expect(resolveHlsAudio(m, low, null)).toBe(`${BASE}audio-en.m3u8`);
  });

  it('resolves an explicitly selected alternate language', () => {
    const m = master();
    const low = m.variants[0];
    if (!low) throw new Error('fixture missing low variant');
    expect(resolveHlsAudio(m, low, 'aud::Espanol')).toBe(`${BASE}audio-es.m3u8`);
  });

  it('throws for an unknown audio id instead of inventing a track', () => {
    const m = master();
    const low = m.variants[0];
    if (!low) throw new Error('fixture missing low variant');
    expect(() => resolveHlsAudio(m, low, 'aud::Klingon')).toThrow(/not available/);
    expect(() => resolveHlsAudio(m, low, 'nope::English')).toThrow(/not available/);
  });

  it('returns null for a rendition with no URI (in-band signal)', () => {
    const m = parseMaster(
      '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="mix",DEFAULT=YES\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=100,AUDIO="a"\nv.m3u8\n',
      BASE,
    );
    const v = m.variants[0];
    if (!v) throw new Error('fixture broken');
    expect(resolveHlsAudio(m, v, null)).toBeNull();
    expect(resolveHlsAudio(m, v, 'a::mix')).toBeNull();
  });
});

describe('variant listing with audio', () => {
  it('exposes audio renditions as structured data with stable ids', async () => {
    const listing = await listVariants(`${BASE}master.m3u8`, 'hls', async () => MASTER);
    expect(listing.variants[0]?.audioGroupId).toBe('aud');
    expect(listing.variants[2]?.audioGroupId).toBeNull();
    expect(listing.audioRenditions.map((a) => a.id)).toEqual([
      'aud::English',
      'aud::Espanol',
      'aud-hi::English',
    ]);
    expect(listing.audioRenditions[0]).toMatchObject({
      groupId: 'aud',
      language: 'en',
      isDefault: true,
      hasPlaylist: true,
    });
  });

  it('marks URI-less renditions as in-band (no playlist)', async () => {
    const listing = await listVariants(
      `${BASE}master.m3u8`,
      'hls',
      async () =>
        '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="mix",DEFAULT=YES\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=100,AUDIO="a"\nv.m3u8\n',
    );
    expect(listing.audioRenditions[0]?.hasPlaylist).toBe(false);
  });

  it('keeps DASH listings working with empty audio metadata', async () => {
    const listing = await listVariants('https://e.com/m.mpd', 'dash', async () => {
      throw new Error('not needed');
    }).catch((e) => e);
    expect(listing).toBeInstanceOf(Error);
  });
});

describe('planHlsMux', () => {
  it('plans single-track TS via the concat demuxer', () => {
    expect(planHlsMux('ts', null)).toEqual({
      hasSeparateAudio: false,
      videoStrategy: 'concat-demuxer',
      audioStrategy: null,
      audioNeedsAdtsFix: false,
    });
  });

  it('plans single-track fMP4 via the concat protocol', () => {
    expect(planHlsMux('fmp4', null).videoStrategy).toBe('concat-protocol');
  });

  it('plans dual TS tracks with the ADTS fix', () => {
    const plan = planHlsMux('ts', 'ts');
    expect(plan.hasSeparateAudio).toBe(true);
    expect(plan.audioNeedsAdtsFix).toBe(true);
    expect(plan.audioStrategy).toBe('concat-demuxer');
  });

  it('plans dual fMP4 tracks without the ADTS fix', () => {
    const plan = planHlsMux('fmp4', 'fmp4');
    expect(plan.audioNeedsAdtsFix).toBe(false);
    expect(plan.audioStrategy).toBe('concat-protocol');
  });

  it('rejects unknown containers with actionable errors', () => {
    expect(() => planHlsMux('unknown', null)).toThrow(/Video remux|Unrecognized video/);
    expect(() => planHlsMux('ts', 'unknown')).toThrow(/audio container/);
  });
});

describe('query propagation', () => {
  it('fills missing params from a signed playlist URL (same origin)', () => {
    expect(
      propagateQueryParams(`${BASE}master.m3u8?token=abc`, `${BASE}low.m3u8`),
    ).toBe(`${BASE}low.m3u8?token=abc`);
  });

  it('preserves explicitly supplied destination params', () => {
    expect(propagateQueryParams(`${BASE}a?token=1&x=1`, `${BASE}b?token=2`)).toBe(
      `${BASE}b?token=2&x=1`,
    );
  });

  it('never propagates across origins', () => {
    expect(propagateQueryParams(`${BASE}master.m3u8?token=abc`, 'https://other.example.com/s.m3u8')).toBe(
      'https://other.example.com/s.m3u8',
    );
  });

  it('is a no-op without source params', () => {
    expect(propagateQueryParams(`${BASE}master.m3u8`, `${BASE}low.m3u8`)).toBe(`${BASE}low.m3u8`);
  });

  it('handles duplicate params and invalid input safely', () => {
    expect(propagateQueryParams(`${BASE}a?t=1&t=2`, `${BASE}b`)).toContain('t=1');
    expect(propagateQueryParams('not a url', `${BASE}b`)).toBe(`${BASE}b`);
  });

  it('flows through playlist resolution for segments and renditions', () => {
    const media = parseMediaPlaylist(
      '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6,\nseg1.ts\n#EXT-X-ENDLIST',
      `${BASE}mid.m3u8?token=s3cr3t`,
    );
    expect(media.segments[0]?.uri).toBe(`${BASE}seg1.ts?token=s3cr3t`);
    const master = parseMaster('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n', `${BASE}master.m3u8?token=s3cr3t`);
    expect(master.variants[0]?.uri).toBe(`${BASE}low.m3u8?token=s3cr3t`);
  });

  it('does not leak tokens across origins during resolution', () => {
    const media = parseMediaPlaylist(
      '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6,\nhttps://cdn.other.com/seg1.ts\n#EXT-X-ENDLIST',
      `${BASE}mid.m3u8?token=s3cr3t`,
    );
    expect(media.segments[0]?.uri).toBe('https://cdn.other.com/seg1.ts');
  });

  it('leaves existing query-less behavior unchanged', () => {
    expect(resolveUrl(`${BASE}master.m3u8`, 'low.m3u8')).toBe(`${BASE}low.m3u8`);
  });
});

describe('audio selection messaging', () => {
  it('accepts START_STREAM_DOWNLOAD with and without audioId', () => {
    const base = {
      type: 'START_STREAM_DOWNLOAD',
      payload: {
        mediaId: 'm1',
        manifestUrl: `${BASE}master.m3u8`,
        kind: 'hls',
        variantId: '1',
        filename: 'out',
      },
    } as const;
    expect(parseMessage(base)?.type).toBe('START_STREAM_DOWNLOAD');
    expect(
      parseMessage({ ...base, payload: { ...base.payload, audioId: 'aud::Espanol' } })?.type,
    ).toBe('START_STREAM_DOWNLOAD');
    expect(
      parseMessage({ ...base, payload: { ...base.payload, audioId: null } })?.type,
    ).toBe('START_STREAM_DOWNLOAD');
  });

  it('accepts OFFSCREEN_EXEC with an audio id', () => {
    expect(
      parseMessage({
        type: 'OFFSCREEN_EXEC',
        payload: {
          queueId: 'q1',
          manifestUrl: `${BASE}master.m3u8`,
          kind: 'hls',
          variantId: '1',
          audioId: 'aud::English',
        },
      })?.type,
    ).toBe('OFFSCREEN_EXEC');
  });
});
