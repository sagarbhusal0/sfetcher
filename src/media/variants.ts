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
  /** AUDIO group referenced by this variant; null = audio is in-band. */
  audioGroupId: string | null;
}

export interface AudioRenditionInfo {
  /** Stable selection id: `${groupId}::${name}` (never parsed from labels). */
  id: string;
  groupId: string;
  name: string;
  language: string | null;
  isDefault: boolean;
  autoselect: boolean;
  channels: string | null;
  /** Null URI means in-band audio — no separate playlist to download. */
  hasPlaylist: boolean;
}

export interface VariantListing {
  variants: VariantInfo[];
  audioRenditions: AudioRenditionInfo[];
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
            audioGroupId: null,
          },
        ],
        audioRenditions: [],
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
        audioGroupId: v.audioGroup,
      })),
      audioRenditions: master.renditions
        .filter((r) => r.type === 'AUDIO')
        .map((r) => ({
          id: `${r.groupId}::${r.name}`,
          groupId: r.groupId,
          name: r.name,
          language: r.language,
          isDefault: r.default,
          autoselect: r.autoselect,
          channels: r.channels,
          hasPlaylist: r.uri != null,
        })),
      live: false,
      note: null,
    };
  }
  const manifest = parseMpd(text, manifestUrl);
  if (manifest.isLive) {
    return { variants: [], audioRenditions: [], live: true, note: 'Live/dynamic MPD: not supported' };
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
      audioGroupId: null,
    })),
    audioRenditions: [],
    live: false,
    note: videos.length === 0 ? 'No video representations found' : null,
  };
}
