export type MediaKind =
  | 'video-direct'
  | 'audio-direct'
  | 'hls'
  | 'dash'
  | 'unknown';

export type DetectionSource = 'dom' | 'network' | 'manifest-hint';

export interface DetectedMedia {
  id: string;
  tabId: number;
  url: string;
  kind: MediaKind;
  source: DetectionSource;
  /** All distinct discovery paths that reported this resource (merged on dedupe). */
  sources?: DetectionSource[];
  fileExtension: string | null;
  mimeType: string | null;
  container: string | null;
  codecs: string | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  hostname: string | null;
  estimatedSizeBytes: number | null;
  detectedAt: number;
  title: string | null;
}

export type QueueStatus =
  | 'pending'
  | 'active'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface StreamJobSpec {
  manifestUrl: string;
  kind: 'hls' | 'dash';
  variantId: string;
  /** Selected separate audio rendition (`groupId::name`); null = in-band/default. */
  audioId: string | null;
  /** Initiating tab page URL, sent as fetch referrer for hotlink protection. */
  referrer: string | null;
}

export interface QueueItem {
  id: string;
  mediaId: string;
  url: string;
  filename: string;
  kind: MediaKind;
  status: QueueStatus;
  progress: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  browserDownloadId: number | null;
  selectedVariant: string | null;
  /** Present for multi-segment HLS/DASH jobs processed in the offscreen document. */
  job?: StreamJobSpec | null;
}

export interface UserPrefs {
  theme: 'dark' | 'light';
  downloadSubfolder: string;
  concurrency: number;
  maxManifestBytes: number;
  maxSegments: number;
  debugLogging: boolean;
}

export const DEFAULT_PREFS: UserPrefs = {
  theme: 'dark',
  downloadSubfolder: 'Sfetcher',
  concurrency: 3,
  maxManifestBytes: 2_000_000,
  maxSegments: 2000,
  debugLogging: false,
};
