/**
 * Offscreen media processor.
 *
 * Runs in an offscreen document (BLOBS reason) because Manifest V3 service
 * workers cannot host long-running ffmpeg.wasm jobs. All work here is local:
 * fetch authorized segments, remux with the bundled single-threaded ffmpeg
 * core, save via the Downloads API. Queue state is written to the same
 * IndexedDB the manager polls, so progress shows up live.
 */
import { fetchBytes, fetchSegmentsOrdered, sanitizeUrlForError, type SegmentRequest } from '../../src/media/segments';
import { coerceKeyBytes, decryptAes128, sequenceIv } from '../../src/media/crypto';
import { loadFFmpeg, packageTracks, remuxToMp4, type RemuxInput } from '../../src/media/ffmpeg';
import {
  MAX_JOB_BYTES,
  planDashJob,
  planHlsMux,
  resolveHlsAudio,
  segName,
} from '../../src/media/pipeline';
import { parseMaster, parseMediaPlaylist, pickVariant, type HlsMediaPlaylist } from '../../src/manifests/hls/parser';
import { listVariants } from '../../src/media/variants';
import { sniffContainer } from '../../src/media/remux';
import { putQueue, allQueue } from '../../src/storage/db';
import {
  createIdbBackend,
  sweepStaleJobs,
  type FragmentBackend,
} from '../../src/storage/fragments';
import { loadPrefs, transition } from '../../src/storage/prefs';
import { parseMessage } from '../../src/messaging/schemas';
import type { QueueItem } from '../../src/shared/types';

const aborters = new Map<string, AbortController>();

/** Write-through fragment bucket (IndexedDB in the real document). */
const fragmentStore: FragmentBackend = createIdbBackend();

/** Best-effort bucket removal on every terminal path. */
function discardBucket(queueId: string): void {
  void fragmentStore.deleteJob(queueId).catch(() => undefined);
}

/**
 * Serialize FFmpeg MEMFS usage: the singleton cannot serve two jobs at
 * once (shared filenames would interleave). Downloads stay parallel;
 * only muxing waits its turn. Cancellation is re-checked after acquiring.
 */
let muxChain: Promise<void> = Promise.resolve();

async function withMuxLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = muxChain;
  let release!: () => void;
  muxChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function setProgress(item: QueueItem, progress: number): Promise<void> {
  await putQueue({ ...item, progress, updatedAt: Date.now() }).catch(() => undefined);
}

async function finish(item: QueueItem, data: Uint8Array, filename: string): Promise<void> {
  // Never resurrect a job that moved on (cancelled, or marked failed by a
  // service-worker restart reconcile) while the mux was running.
  const latest = await allQueue()
    .then((all) => all.find((q) => q.id === item.id))
    .catch(() => undefined);
  if (latest && latest.status !== 'active' && latest.status !== 'pending') {
    discardBucket(item.id);
    return;
  }
  const blob = new Blob([data.buffer as ArrayBuffer], { type: 'video/mp4' });
  const url = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    aborters.delete(item.id);
    discardBucket(item.id);
    await putQueue({
      ...transition(item, 'completed'),
      progress: 1,
      browserDownloadId: downloadId,
    }).catch(() => undefined);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

async function fail(item: QueueItem, e: unknown): Promise<void> {
  aborters.delete(item.id);
  discardBucket(item.id);
  const active = item.status === 'pending' ? { ...transition(item, 'active'), progress: 0 } : item;
  await putQueue(
    transition(active, 'failed', e instanceof Error ? e.message : String(e)),
  ).catch(() => undefined);
}

function fetchHint(e: unknown): string {
  if (e instanceof TypeError) {
    return 'Network fetch failed — the extension likely lacks host access for this site/CDN (grant it, then reload the page). Only content you are authorized to access is processed.';
  }
  return e instanceof Error ? e.message : String(e);
}

/** Decrypt AES-128 segments in place-order; clear segments pass through. */
async function decryptTrack(
  segments: HlsMediaPlaylist['segments'],
  body: Uint8Array[],
  keyCache: Map<string, Uint8Array>,
  signal: AbortSignal,
): Promise<Uint8Array[]> {
  if (!segments.some((s) => s.key)) return body;
  return Promise.all(
    body.map(async (data, i) => {
      const seg = segments[i];
      if (!seg?.key) return data;
      let keyBytes = keyCache.get(seg.key.uri);
      if (!keyBytes) {
        const raw = await fetchBytes(seg.key.uri, { signal, resourceType: 'key' });
        keyBytes = coerceKeyBytes(raw, sanitizeUrlForError(seg.key.uri));
        keyCache.set(seg.key.uri, keyBytes);
      }
      return decryptAes128(data, keyBytes, seg.key.iv ?? sequenceIv(seg.sequence));
    }),
  );
}

async function runHls(
  item: QueueItem,
  manifestUrl: string,
  variantId: string,
  audioId?: string | null,
): Promise<void> {
  const prefs = await loadPrefs();
  const ac = new AbortController();
  aborters.set(item.id, ac);
  try {
    await putQueue(transition(item, 'active'));
    const td = new TextDecoder();
    const topText = td.decode(
      await fetchBytes(manifestUrl, {
        signal: ac.signal,
        maxBytes: prefs.maxManifestBytes,
        resourceType: 'master',
      }),
    );
    let playlistUrl = manifestUrl;
    let audioPlaylistUrl: string | null = null;
    if (topText.includes('#EXT-X-STREAM-INF')) {
      const master = parseMaster(topText, manifestUrl);
      const variant =
        variantId === 'highest'
          ? pickVariant(master, 'highest')
          : (master.variants[Number(variantId)] ?? pickVariant(master, 'highest'));
      if (!variant) throw new Error('No HLS variant available');
      playlistUrl = variant.uri;
      audioPlaylistUrl = resolveHlsAudio(master, variant, audioId ?? null);
    }
    const mediaText = td.decode(
      await fetchBytes(playlistUrl, {
        signal: ac.signal,
        maxBytes: prefs.maxManifestBytes,
        resourceType: 'variant',
      }),
    );
    const media = parseMediaPlaylist(mediaText, playlistUrl, { maxSegments: prefs.maxSegments });
    if (media.isLive) throw new Error('Live HLS streams are not supported in this release');
    if (media.segments.length === 0) throw new Error('HLS playlist contains no segments');

    // Separate audio playlist, when the variant requires one.
    let audio: HlsMediaPlaylist | null = null;
    if (audioPlaylistUrl) {
      const audioText = td.decode(
        await fetchBytes(audioPlaylistUrl, {
          signal: ac.signal,
          maxBytes: prefs.maxManifestBytes,
          resourceType: 'audio',
        }),
      );
      audio = parseMediaPlaylist(audioText, audioPlaylistUrl, { maxSegments: prefs.maxSegments });
      if (audio.isLive) throw new Error('Live HLS streams are not supported in this release');
      if (audio.segments.length === 0) throw new Error('HLS audio playlist contains no segments');
    }

    const fetchTrackParts = (
      segments: HlsMediaPlaylist['segments'],
      track: 'video' | 'audio',
      baseProgress: number,
      span: number,
    ): Promise<{ parts: Uint8Array[]; hasInit: boolean }> =>
      (async () => {
        const initUrl = segments[0]?.initSection ?? null;
        const initRange = segments[0]?.initByteRange ?? undefined;
        const all: SegmentRequest[] = [
          ...(initUrl ? [{ url: initUrl, byteRange: initRange, resourceType: 'init' as const }] : []),
          ...segments.map((s) => ({
            url: s.uri,
            byteRange: s.byteRange ?? undefined,
            resourceType: track,
          })),
        ];
        if (all.length > prefs.maxSegments + 1) throw new Error('Segment count exceeds configured limit');
        const fetched = await fetchSegmentsOrdered(all, {
          concurrency: prefs.concurrency,
          signal: ac.signal,
          onProgress: (done, total) => void setProgress(item, baseProgress + (done / total) * span),
          // Write-through to the disk bucket (init sections excluded:
          // small and re-fetchable, not worth bucket slots).
          onFragment: (idx, data) => {
            const bodyIdx = initUrl ? idx - 1 : idx;
            if (bodyIdx < 0) return;
            return fragmentStore.write(item.id, track, bodyIdx, data);
          },
        });
        return { parts: fetched, hasInit: initUrl != null };
      })();

    // Video and audio fragment sequences stay isolated per track; progress
    // spans are disjoint so work is never double-counted.
    const fetchSpan = audio ? 0.3 : 0.7;
    const keyCache = new Map<string, Uint8Array>();
    const { parts, hasInit } = await fetchTrackParts(media.segments, 'video', 0, fetchSpan);
    let body = hasInit ? parts.slice(1) : parts;
    body = await decryptTrack(media.segments, body, keyCache, ac.signal);
    const first = body[0];
    if (!first) throw new Error('No segment data received');
    const videoContainer = sniffContainer(first);

    let audioBody: Uint8Array[] = [];
    let audioHasInit = false;
    let audioContainer: 'ts' | 'fmp4' | 'unknown' | null = null;
    if (audio) {
      const fetched = await fetchTrackParts(audio.segments, 'audio', fetchSpan, 0.3);
      const rawAudioBody = fetched.hasInit ? fetched.parts.slice(1) : fetched.parts;
      audioBody = await decryptTrack(audio.segments, rawAudioBody, keyCache, ac.signal);
      audioHasInit = fetched.hasInit;
      const audioFirst = audioBody[0];
      if (!audioFirst) throw new Error('No audio segment data received');
      audioContainer = sniffContainer(audioFirst);
      if (audioHasInit && !fetched.parts[0]) throw new Error('No audio initialization data received');
    }

    const muxPlan = planHlsMux(videoContainer, audioContainer);
    const muxBase = audio ? 0.6 : 0.7;
    const muxSpan = audio ? 0.35 : 0.25;
    const out = await withMuxLock(async () => {
      if (ac.signal.aborted) throw new Error('Download cancelled');
      const ff = await loadFFmpeg();
      const vTs = muxPlan.videoStrategy === 'concat-demuxer';
      const vInputs: RemuxInput[] = body.map((data, i) => ({
        name: segName('hls', 'v', i, vTs),
        data,
      }));
      if (!muxPlan.hasSeparateAudio) {
        const initInputs: RemuxInput[] = [];
        if (hasInit && parts[0]) {
          initInputs.push({ name: segName('hls', 'init', 0, false), data: parts[0] });
        }
        return vTs
          ? remuxToMp4(ff, vInputs, 'concat-demuxer', 'out.mp4', (p) =>
              void setProgress(item, muxBase + p * muxSpan),
            )
          : remuxToMp4(
              ff,
              [...initInputs, ...vInputs.map((x, i) => ({ ...x, name: segName('hls', 'v', i, false) }))],
              'concat-protocol',
              'out.mp4',
              (p) => void setProgress(item, muxBase + p * muxSpan),
            );
      }
      const aTs = muxPlan.audioStrategy === 'concat-demuxer';
      const aInputs: RemuxInput[] = audioBody.map((data, i) => ({
        name: segName('hls', 'a', i, aTs),
        data,
      }));
      const vFull = await remuxToMp4(ff, vInputs, muxPlan.videoStrategy, 'v.mp4', (p) =>
        void setProgress(item, muxBase + p * muxSpan * 0.4),
      );
      if (vFull.length === 0) throw new Error('Video remux produced no output');
      const aFull = await remuxToMp4(
        ff,
        aInputs,
        muxPlan.audioStrategy as 'concat-demuxer' | 'concat-protocol',
        'a.m4a',
        (p) => void setProgress(item, muxBase + muxSpan * 0.4 + p * muxSpan * 0.3),
        muxPlan.audioNeedsAdtsFix ? ['-bsf:a', 'aac_adtstoasc'] : undefined,
      );
      if (aFull.length === 0) throw new Error('Audio remux produced no output');
      return packageTracks(
        ff,
        [
          { name: 'v_full.mp4', data: vFull },
          { name: 'a_full.m4a', data: aFull },
        ],
        'out.mp4',
        (p) => void setProgress(item, muxBase + muxSpan * 0.7 + p * muxSpan * 0.3),
      );
    });
    if (out.length === 0) throw new Error('Remux produced no output: unsupported stream combination');
    if (out.length > MAX_JOB_BYTES) throw new Error('Output exceeds 500 MB job limit');
    await finish(item, out, item.filename);
  } catch (e) {
    if ((e as Error)?.message === 'Download cancelled' || ac.signal.aborted) {
      aborters.delete(item.id);
      discardBucket(item.id);
      await putQueue(transition(item.status === 'active' ? item : { ...item, status: 'active' as const }, 'cancelled')).catch(() => undefined);
      return;
    }
    await fail(item, fetchHint(e));
  }
}

async function runDash(item: QueueItem, manifestUrl: string, variantId: string): Promise<void> {
  const prefs = await loadPrefs();
  const ac = new AbortController();
  aborters.set(item.id, ac);
  try {
    await putQueue(transition(item, 'active'));
    const td = new TextDecoder();
    const mpdText = td.decode(
      await fetchBytes(manifestUrl, { signal: ac.signal, maxBytes: prefs.maxManifestBytes }),
    );
    const job = planDashJob(mpdText, manifestUrl, variantId, prefs.maxSegments);
    const tracks: RemuxInput[] = [];
    const fetchTrack = async (
      name: string,
      init: string | null,
      urls: string[],
      extTs: boolean,
      trackType: 'video' | 'audio',
    ): Promise<RemuxInput[]> => {
      const all: SegmentRequest[] = [
        ...(init ? [{ url: init, resourceType: 'init' as const }] : []),
        ...urls.map((url) => ({ url, resourceType: trackType })),
      ];
      const parts = await fetchSegmentsOrdered(all, {
        concurrency: prefs.concurrency,
        signal: ac.signal,
        onProgress: (done, total) => void setProgress(item, (done / total) * 0.35),
        onFragment: (idx, data) => {
          const bodyIdx = init ? idx - 1 : idx;
          if (bodyIdx < 0) return;
          return fragmentStore.write(item.id, trackType, bodyIdx, data);
        },
      });
      const body = init ? parts.slice(1) : parts;
      const out: RemuxInput[] = body.map((data, i) => ({
        name: segName('dash', name, i, extTs),
        data,
      }));
      if (init && parts[0]) out.unshift({ name: segName('dash', `${name}init`, 0, extTs), data: parts[0] });
      return out;
    };
    const vParts = await fetchTrack('v', job.videoInit, job.videoUrls, false, 'video');
    const first = vParts[vParts.length - 1] ?? vParts[0];
    if (!first) throw new Error('No video segment data received');
    const aParts = job.audio ? await fetchTrack('a', job.audioInit, job.audioUrls, false, 'audio') : [];
    // Rebase progress: video 0..0.35, audio 0.35..0.7 (approximate; single bar).
    const packaged = await withMuxLock(async () => {
      if (ac.signal.aborted) throw new Error('Download cancelled');
      const ff = await loadFFmpeg();
      const vFull = await remuxToMp4(ff, vParts, 'concat-protocol', 'v.mp4', (p) =>
        void setProgress(item, 0.7 + p * 0.1),
      );
      return aParts.length > 0
        ? await (async () => {
            const aFull = await remuxToMp4(ff, aParts, 'concat-protocol', 'a.m4a', (p) =>
              void setProgress(item, 0.8 + p * 0.05),
            );
            return packageTracks(
              ff,
              [
                { name: 'v_full.mp4', data: vFull },
                { name: 'a_full.m4a', data: aFull },
              ],
              'out.mp4',
              (p) => void setProgress(item, 0.85 + p * 0.1),
            );
          })()
        : vFull;
    });
    if (packaged.length > MAX_JOB_BYTES) throw new Error('Output exceeds 500 MB job limit');
    await finish(item, packaged, item.filename);
  } catch (e) {
    if ((e as Error)?.message === 'Download cancelled' || ac.signal.aborted) {
      aborters.delete(item.id);
      discardBucket(item.id);
      await putQueue(transition(item.status === 'active' ? item : { ...item, status: 'active' as const }, 'cancelled')).catch(() => undefined);
      return;
    }
    await fail(item, fetchHint(e));
  }
}

async function describeVariants(manifestUrl: string, kind: 'hls' | 'dash') {
  const prefs = await loadPrefs();
  return listVariants(manifestUrl, kind, (url) =>
    fetchBytes(url, { maxBytes: prefs.maxManifestBytes, resourceType: 'master' }).then((b) => new TextDecoder().decode(b)),
  );
}

chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  const msg = parseMessage(raw);
  if (!msg) return false;
  if (msg.type === 'OFFSCREEN_VARIANTS') {
    void (async () => {
      try {
        sendResponse({ ok: true, ...(await describeVariants(msg.payload.manifestUrl, msg.payload.kind)) });
      } catch (e) {
        sendResponse({ ok: false, error: fetchHint(e) });
      }
    })();
    return true;
  }
  if (msg.type === 'OFFSCREEN_EXEC') {
    const { queueId, manifestUrl, kind, variantId } = msg.payload;
    const audioId = msg.payload.audioId ?? null;
    void (async () => {
      const items = await allQueue().catch(() => [] as QueueItem[]);
      const item = items.find((q) => q.id === queueId);
      if (!item) return;
      if (kind === 'hls') await runHls(item, manifestUrl, variantId, audioId);
      else await runDash(item, manifestUrl, variantId);
    })();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'OFFSCREEN_CANCEL') {
    aborters.get(msg.payload.queueId)?.abort(new Error('Download cancelled'));
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// Remove buckets from jobs that died with a previous document load.
// Buckets of pending/active jobs are never touched.
void sweepStaleJobs(
  fragmentStore,
  (jobId) =>
    allQueue()
      .then((all) =>
        all.some((q) => q.id === jobId && (q.status === 'active' || q.status === 'pending')),
      )
      .catch(() => true),
).catch(() => undefined);
