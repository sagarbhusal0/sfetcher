/**
 * Offscreen media processor.
 *
 * Runs in an offscreen document (BLOBS reason) because Manifest V3 service
 * workers cannot host long-running ffmpeg.wasm jobs. All work here is local:
 * fetch authorized segments, remux with the bundled single-threaded ffmpeg
 * core, save via the Downloads API. Queue state is written to the same
 * IndexedDB the manager polls, so progress shows up live.
 */
import { fetchBytes, fetchSegmentsOrdered } from '../../src/media/segments';
import { loadFFmpeg, packageTracks, remuxToMp4, type RemuxInput } from '../../src/media/ffmpeg';
import {
  MAX_JOB_BYTES,
  planDashJob,
  segName,
} from '../../src/media/pipeline';
import { parseMaster, parseMediaPlaylist, pickVariant } from '../../src/manifests/hls/parser';
import { listVariants } from '../../src/media/variants';
import { sniffContainer } from '../../src/media/remux';
import { putQueue, allQueue } from '../../src/storage/db';
import { loadPrefs, transition } from '../../src/storage/prefs';
import { parseMessage } from '../../src/messaging/schemas';
import type { QueueItem } from '../../src/shared/types';

const aborters = new Map<string, AbortController>();

async function setProgress(item: QueueItem, progress: number): Promise<void> {
  await putQueue({ ...item, progress, updatedAt: Date.now() }).catch(() => undefined);
}

async function finish(item: QueueItem, data: Uint8Array, filename: string): Promise<void> {
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

async function runHls(item: QueueItem, manifestUrl: string, variantId: string): Promise<void> {
  const prefs = await loadPrefs();
  const ac = new AbortController();
  aborters.set(item.id, ac);
  try {
    await putQueue(transition(item, 'active'));
    const td = new TextDecoder();
    const topText = td.decode(
      await fetchBytes(manifestUrl, { signal: ac.signal, maxBytes: prefs.maxManifestBytes }),
    );
    let playlistUrl = manifestUrl;
    if (topText.includes('#EXT-X-STREAM-INF')) {
      const master = parseMaster(topText, manifestUrl);
      const variant =
        variantId === 'highest'
          ? pickVariant(master, 'highest')
          : (master.variants[Number(variantId)] ?? pickVariant(master, 'highest'));
      if (!variant) throw new Error('No HLS variant available');
      playlistUrl = variant.uri;
    }
    const mediaText = td.decode(
      await fetchBytes(playlistUrl, { signal: ac.signal, maxBytes: prefs.maxManifestBytes }),
    );
    const media = parseMediaPlaylist(mediaText, playlistUrl, { maxSegments: prefs.maxSegments });
    if (media.isLive) throw new Error('Live HLS streams are not supported in this release');
    if (media.segments.length === 0) throw new Error('HLS playlist contains no segments');

    const urls = media.segments.map((s) => s.uri);
    const initUrl = media.segments[0]?.initSection ?? null;
    const all = initUrl ? [initUrl, ...urls] : urls;
    if (all.length > prefs.maxSegments + 1) throw new Error('Segment count exceeds configured limit');

    const parts = await fetchSegmentsOrdered(all, {
      concurrency: prefs.concurrency,
      signal: ac.signal,
      onProgress: (done, total) => void setProgress(item, (done / total) * 0.7),
    });
    const body = initUrl ? parts.slice(1) : parts;
    const first = body[0];
    if (!first) throw new Error('No segment data received');
    const container = sniffContainer(first);
    if (container === 'unknown') {
      throw new Error('Unrecognized segment container: transcode required (not bundled; see README)');
    }
    const ts = container === 'ts';
    const inputs: RemuxInput[] = body.map((data, i) => ({
      name: segName('hls', 'v', i, ts),
      data,
    }));
    const initInputs: RemuxInput[] = [];
    if (initUrl && parts[0]) {
      initInputs.push({ name: segName('hls', 'init', 0, false), data: parts[0] });
    }
    const ff = await loadFFmpeg();
    const out = ts
      ? await remuxToMp4(ff, inputs, 'concat-demuxer', 'out.mp4', (p) =>
          void setProgress(item, 0.7 + p * 0.25),
        )
      : await remuxToMp4(
          ff,
          [...initInputs, ...inputs.map((x, i) => ({ ...x, name: segName('hls', 'v', i, false) }))],
          'concat-protocol',
          'out.mp4',
          (p) => void setProgress(item, 0.7 + p * 0.25),
        );
    if (out.length > MAX_JOB_BYTES) throw new Error('Output exceeds 500 MB job limit');
    await finish(item, out, item.filename);
  } catch (e) {
    if ((e as Error)?.message === 'Download cancelled' || ac.signal.aborted) {
      aborters.delete(item.id);
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
    ): Promise<RemuxInput[]> => {
      const all = init ? [init, ...urls] : urls;
      const parts = await fetchSegmentsOrdered(all, {
        concurrency: prefs.concurrency,
        signal: ac.signal,
        onProgress: (done, total) => void setProgress(item, (done / total) * 0.35),
      });
      const body = init ? parts.slice(1) : parts;
      const out: RemuxInput[] = body.map((data, i) => ({
        name: segName('dash', name, i, extTs),
        data,
      }));
      if (init && parts[0]) out.unshift({ name: segName('dash', `${name}init`, 0, extTs), data: parts[0] });
      return out;
    };
    const vParts = await fetchTrack('v', job.videoInit, job.videoUrls, false);
    const first = vParts[vParts.length - 1] ?? vParts[0];
    if (!first) throw new Error('No video segment data received');
    const aParts = job.audio ? await fetchTrack('a', job.audioInit, job.audioUrls, false) : [];
    // Rebase progress: video 0..0.35, audio 0.35..0.7 (approximate; single bar).
    const ff = await loadFFmpeg();
    const vFull = await remuxToMp4(ff, vParts, 'concat-protocol', 'v.mp4', (p) =>
      void setProgress(item, 0.7 + p * 0.1),
    );
    const packaged = aParts.length > 0
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
    if (packaged.length > MAX_JOB_BYTES) throw new Error('Output exceeds 500 MB job limit');
    await finish(item, packaged, item.filename);
  } catch (e) {
    if ((e as Error)?.message === 'Download cancelled' || ac.signal.aborted) {
      aborters.delete(item.id);
      await putQueue(transition(item.status === 'active' ? item : { ...item, status: 'active' as const }, 'cancelled')).catch(() => undefined);
      return;
    }
    await fail(item, fetchHint(e));
  }
}

async function describeVariants(manifestUrl: string, kind: 'hls' | 'dash') {
  const prefs = await loadPrefs();
  return listVariants(manifestUrl, kind, (url) =>
    fetchBytes(url, { maxBytes: prefs.maxManifestBytes }).then((b) => new TextDecoder().decode(b)),
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
    void (async () => {
      const items = await allQueue().catch(() => [] as QueueItem[]);
      const item = items.find((q) => q.id === queueId);
      if (!item) return;
      if (kind === 'hls') await runHls(item, manifestUrl, variantId);
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
