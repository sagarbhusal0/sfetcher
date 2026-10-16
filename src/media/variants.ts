/**
 * Stream variant discovery shared by the service worker and the offscreen
 * document. Runs anywhere `fetch` exists — deliberately NOT dependent on the
 * offscreen document or ffmpeg, so quality lists keep working when the media
 * processor cannot initialize.
 */
import { parseMaster, parseMediaPlaylist } from '../manifests/hls/parser.js';
import { parseMpd } from '../manifests/dash/parser.js';

export interface VariantInfo {
  id: string;
  label: string;
  width: number | null;
  height: number | null;
  bandwidth: number | null;
  codecs: string | null;
  estSizeBytes: number | null;
}

export interface VariantListing {
  variants: VariantInfo[];
  live: boolean;
  note: string | null;
}

function fmtBw(bandwidth: number | null): string {
  return bandwidth ? ` · ${(bandwidth / 1_000_000).toFixed(1)} Mbps` : '';
}

export async function listVariants(
  manifestUrl: string,
  kind: 'hls' | 'dash',
  fetchText: (url: string) => Promise<string>,
): Promise<VariantListing> {
  const text = await fetchText(manifestUrl);
  if (kind === 'hls') {
    if (!text.includes('#EXT-X-STREAM-INF')) {
      const media = parseMediaPlaylist(text, manifestUrl);
      return {
        variants: [
          {
            id: 'highest',
            label: 'default',
            width: null,
            height: null,
            bandwidth: null,
            codecs: null,
            estSizeBytes: null,
          },
        ],
        live: media.isLive,
        note: media.isLive ? 'Live playlist: recording is not supported' : null,
      };
    }
    const master = parseMaster(text, manifestUrl);
    return {
      variants: master.variants.map((v, i) => ({
        id: String(i),
        label: `${v.height ? `${v.height}p` : 'variant'}${fmtBw(v.bandwidth)}`,
        width: v.width,
        height: v.height,
        bandwidth: v.bandwidth,
        codecs: v.codecs,
        estSizeBytes: null,
      })),
      live: false,
      note: null,
    };
  }
  const manifest = parseMpd(text, manifestUrl);
  if (manifest.isLive) {
    return { variants: [], live: true, note: 'Live/dynamic MPD: not supported' };
  }
  const videos = manifest.adaptationSets
    .filter((a) => (a.mimeType ?? '').startsWith('video'))
    .flatMap((a) => a.representations);
  return {
    variants: videos.map((r) => ({
      id: r.id || `${r.width}x${r.height}`,
      label: `${r.height ? `${r.height}p` : 'variant'}${fmtBw(r.bandwidth)}`,
      width: r.width,
      height: r.height,
      bandwidth: r.bandwidth,
      codecs: r.codecs,
      estSizeBytes: null,
    })),
    live: false,
    note: videos.length === 0 ? 'No video representations found' : null,
  };
}
