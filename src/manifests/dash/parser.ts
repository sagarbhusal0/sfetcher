export interface DashRepresentation {
  id: string;
  bandwidth: number | null;
  width: number | null;
  height: number | null;
  codecs: string | null;
  mimeType: string | null;
  baseUrl: string | null;
  segmentTemplate: {
    media: string | null;
    initialization: string | null;
    timescale: number;
    startNumber: number;
    duration: number | null;
  } | null;
  segmentList: { media: string[]; initialization: string | null } | null;
  timeline: { d: number; r: number; t: number | null }[] | null;
}

export interface DashAdaptationSet {
  id: string | null;
  mimeType: string | null;
  codecs: string | null;
  lang: string | null;
  representations: DashRepresentation[];
}

export interface DashManifest {
  type: 'static' | 'dynamic';
  isLive: boolean;
  durationSec: number | null;
  baseUrl: string | null;
  adaptationSets: DashAdaptationSet[];
}

function childElements(el: Element, tag: string): Element[] {
  return Array.from(el.children).filter((c) => c.tagName === tag || c.tagName.endsWith(`:${tag}`));
}

function childText(el: Element, tag: string): string | null {
  const kids = childElements(el, tag);
  return kids[0]?.textContent?.trim() || null;
}

function resolveDashUrl(base: string, ref: string): string {
  const u = new URL(ref, base);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Unsafe URL scheme in MPD: ${u.protocol}`);
  }
  return u.toString();
}

export function substituteTemplate(
  template: string,
  vars: { RepresentationID?: string; Bandwidth?: number; Number?: number; Time?: number },
): string {
  // Handles $RepresentationID$, $Bandwidth$, $Number$, $Time$ and $$ escape.
  return template.replace(/\$\$|\$([A-Za-z]+)(%0\d+d)?\$/g, (m, name: string, fmt: string) => {
    if (m === '$$') return '$';
    let val: string | number | undefined;
    if (name === 'RepresentationID') val = vars.RepresentationID;
    else if (name === 'Bandwidth') val = vars.Bandwidth;
    else if (name === 'Number') val = vars.Number;
    else if (name === 'Time') val = vars.Time;
    if (val == null) return m;
    if (fmt) {
      const width = Number(fmt.slice(1, -1));
      return String(val).padStart(width, '0');
    }
    return String(val);
  });
}

function parseDurationIso8601(s: string | null): number | null {
  if (!s) return null;
  const m = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(s);
  if (!m) return null;
  return (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) || null;
}

export function parseMpd(xmlText: string, manifestUrl: string): DashManifest {
  if (xmlText.length > 2_000_000) throw new Error('MPD exceeds size limit');
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  } catch {
    throw new Error('Malformed MPD XML');
  }
  const parserError = doc.getElementsByTagName('parsererror')[0];
  if (parserError) throw new Error('Malformed MPD XML');
  const mpd = doc.documentElement;
  if (!mpd || mpd.tagName !== 'MPD') throw new Error('Not a DASH MPD document');

  const type = (mpd.getAttribute('type') ?? 'static') as 'static' | 'dynamic';
  const durationSec = parseDurationIso8601(mpd.getAttribute('mediaPresentationDuration'));
  const mpdBase = childText(mpd, 'BaseURL');
  const baseUrl = mpdBase ? resolveDashUrl(manifestUrl, mpdBase) : manifestUrl;

  const periods = childElements(mpd, 'Period');
  const period = periods[0] ?? mpd;
  const adaptationSets: DashAdaptationSet[] = [];

  for (const aset of childElements(period, 'AdaptationSet')) {
    const asetMime = aset.getAttribute('mimeType');
    const asetCodecs = aset.getAttribute('codecs');
    const asetLang = aset.getAttribute('lang');
    const asetBase = childText(aset, 'BaseURL');
    const asetBaseUrl = asetBase ? resolveDashUrl(baseUrl, asetBase) : baseUrl;

    const reps: DashRepresentation[] = [];
    for (const rep of childElements(aset, 'Representation')) {
      const id = rep.getAttribute('id') ?? '';
      const repBase = childText(rep, 'BaseURL');
      const repBaseUrl = repBase ? resolveDashUrl(asetBaseUrl, repBase) : null;

      const stEl = childElements(rep, 'SegmentTemplate')[0] ?? childElements(aset, 'SegmentTemplate')[0];
      let segmentTemplate: DashRepresentation['segmentTemplate'] = null;
      if (stEl) {
        const tlEl = childElements(stEl, 'SegmentTimeline')[0];
        let timeline: DashRepresentation['timeline'] = null;
        if (tlEl) {
          timeline = childElements(tlEl, 'S').map((s) => ({
            d: Number(s.getAttribute('d') ?? 0),
            r: Number(s.getAttribute('r') ?? 0),
            t: s.getAttribute('t') != null ? Number(s.getAttribute('t')) : null,
          }));
        }
        segmentTemplate = {
          media: stEl.getAttribute('media'),
          initialization: stEl.getAttribute('initialization'),
          timescale: Number(stEl.getAttribute('timescale') ?? 1) || 1,
          startNumber: Number(stEl.getAttribute('startNumber') ?? 1) || 1,
          duration: stEl.getAttribute('duration') ? Number(stEl.getAttribute('duration')) : null,
        };
        void timeline;
        // Attach timeline via closure field below
        (segmentTemplate as unknown as { timeline: unknown }).timeline = timeline;
      }

      const slEl = childElements(rep, 'SegmentList')[0];
      let segmentList: DashRepresentation['segmentList'] = null;
      if (slEl) {
        const initEl = childElements(slEl, 'Initialization')[0];
        segmentList = {
          media: childElements(slEl, 'SegmentURL').map((s) => s.getAttribute('media') ?? ''),
          initialization: initEl?.getAttribute('sourceURL') ?? null,
        };
      }

      reps.push({
        id,
        bandwidth: rep.getAttribute('bandwidth') ? Number(rep.getAttribute('bandwidth')) : null,
        width: rep.getAttribute('width') ? Number(rep.getAttribute('width')) : null,
        height: rep.getAttribute('height') ? Number(rep.getAttribute('height')) : null,
        codecs: rep.getAttribute('codecs') ?? asetCodecs,
        mimeType: rep.getAttribute('mimeType') ?? asetMime,
        baseUrl: repBaseUrl ?? asetBaseUrl,
        segmentTemplate,
        segmentList,
        timeline:
          (segmentTemplate as unknown as { timeline?: DashRepresentation['timeline'] })?.timeline ??
          null,
      });
    }
    adaptationSets.push({
      id: aset.getAttribute('id'),
      mimeType: asetMime,
      codecs: asetCodecs,
      lang: asetLang,
      representations: reps,
    });
  }

  return { type, isLive: type === 'dynamic', durationSec, baseUrl, adaptationSets };
}

export function buildSegmentUrls(
  rep: DashRepresentation,
  opts: { count?: number; startNumber?: number } = {},
): { init: string | null; media: string[] } {
  const base = rep.baseUrl ?? '';
  const join = (ref: string) => resolveDashUrl(base, ref);
  if (rep.segmentList) {
    return {
      init: rep.segmentList.initialization ? join(rep.segmentList.initialization) : null,
      media: rep.segmentList.media.filter(Boolean).map(join),
    };
  }
  if (rep.segmentTemplate?.media) {
    const tpl = rep.segmentTemplate;
    if (!tpl.media) return { init: null, media: [] };
    const mediaTpl: string = tpl.media;
    const count = opts.count ?? 10;
    const start = opts.startNumber ?? tpl.startNumber;
    const media: string[] = [];
    if (rep.timeline && rep.timeline.length > 0) {
      let time = rep.timeline[0]?.t ?? 0;
      for (const s of rep.timeline) {
        const repeat = s.r < 0 ? 0 : s.r;
        for (let k = 0; k <= repeat; k++) {
          media.push(
            join(
              substituteTemplate(mediaTpl, {
                RepresentationID: rep.id,
                Bandwidth: rep.bandwidth ?? undefined,
                Number: start + media.length,
                Time: time,
              }),
            ),
          );
          time += s.d;
          if (media.length >= (opts.count ?? 2000)) break;
        }
      }
    } else if (tpl.duration) {
      for (let i = 0; i < count; i++) {
        media.push(
          join(
            substituteTemplate(mediaTpl, {
              RepresentationID: rep.id,
              Bandwidth: rep.bandwidth ?? undefined,
              Number: start + i,
              Time: (start + i) * tpl.duration,
            }),
          ),
        );
      }
    } else {
      for (let i = 0; i < count; i++) {
        media.push(
          join(
            substituteTemplate(mediaTpl, {
              RepresentationID: rep.id,
              Bandwidth: rep.bandwidth ?? undefined,
              Number: start + i,
            }),
          ),
        );
      }
    }
    return {
      init: tpl.initialization
        ? join(
            substituteTemplate(tpl.initialization, {
              RepresentationID: rep.id,
              Bandwidth: rep.bandwidth ?? undefined,
            }),
          )
        : null,
      media,
    };
  }
  return { init: null, media: [] };
}
