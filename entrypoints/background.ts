import { defineBackground } from 'wxt/utils/define-background';
import { classifyWithReason, dedupeMedia } from '../src/detection/classify';
import { DiagBuffer, makeDiag, type DiagEvent } from '../src/detection/diagnose';
import { ensureOffscreen, ProcessorInitError } from '../src/media/offscreen';
import { listVariants } from '../src/media/variants';
import { fetchBytes } from '../src/media/segments';
import { parseMessage } from '../src/messaging/schemas';
import { allQueue, clearMedia, mediaForTab, putMedia, putQueue } from '../src/storage/db';
import { createQueueItem, loadPrefs, transition } from '../src/storage/prefs';
import { joinDownloadPath, sanitizeFilename, isSegmentUrl } from '../src/shared/utils';
import type { DetectedMedia } from '../src/shared/types';

const tabMedia = new Map<number, DetectedMedia[]>();
/** Hosts where a real HLS/DASH manifest was identified, per tab. */
const tabManifestHosts = new Map<number, Set<string>>();
/** Latest per-tab scan stats reported by content scripts (players active). */
const tabStats = new Map<
  number,
  { videos: number; blobOnly: number; embeds: number; items: number; t: number }
>();
const diag = new DiagBuffer(200);
let debugLogging = false;
void loadPrefs()
  .then((p) => {
    debugLogging = p.debugLogging;
  })
  .catch(() => undefined);

function dlog(event: DiagEvent): void {
  diag.push(event);
  if (debugLogging) {
    // Diagnostic console output only: host + short detail, never full URLs,
    // headers, cookies, or bodies.
    console.debug(
      `[sfetcher:diag] tab=${event.tabId} ${event.reason} host=${event.host ?? '-'} ${event.detail}`,
    );
  }
}

/** Hosts already flagged as permission-blind this session (avoid log spam). */
const blindHosts = new Set<string>();

/** Report a processor-init failure: user-facing stage + full stack in diagnostics. */
function reportInitFailure(tabId: number, e: unknown, operation: string): string {
  const stage = e instanceof ProcessorInitError ? e.stage : 'unknown';
  const message = e instanceof Error ? e.message : String(e);
  dlog(makeDiag(tabId, 'message-dropped-invalid', null, `${operation} init-failed stage=${stage}`));
  if (e instanceof ProcessorInitError && e.causeStack) {
    dlog({
      t: Date.now(),
      tabId,
      reason: 'message-dropped-invalid',
      host: null,
      detail: `cause-stack ${e.causeStack.slice(0, 200)}`,
    });
  }
  return message;
}

async function hasHostAccess(host: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({
      origins: [`https://${host}/*`, `http://${host}/*`],
    });
  } catch {
    return false;
  }
}

/** Recently logged classification ids (request+response stages both fire). */
const loggedIds = new Set<string>();
function dlogOnce(id: string, event: DiagEvent): void {
  if (loggedIds.has(id)) return;
  loggedIds.add(id);
  if (loggedIds.size > 500) {
    const first = loggedIds.values().next().value;
    if (first !== undefined) loggedIds.delete(first);
  }
  dlog(event);
}

function observeNetwork(
  tabId: number,
  frameId: number,
  url: string,
  type: string,
  mime: string | null,
  stage: 'request' | 'response',
): void {
  const res = classifyWithReason({ url, mimeType: mime, resourceType: type, tabId, source: 'network' });
  if (res.ok) {
    remember([res.media]);
    dlogOnce(
      res.media.id,
      makeDiag(tabId, 'network-classified', url, `kind=${res.media.kind} frame=${frameId} via=${stage}`),
    );
    return;
  }
  // Segment traffic is never an item, but associated with a known manifest
  // host it corroborates stream playback on this tab (VDH-style grouping
  // signal, diagnostics only).
  if (isSegmentUrl(url)) {
    try {
      const host = new URL(url).hostname;
      const known = tabManifestHosts.get(tabId)?.has(host) === true;
      dlog(
        makeDiag(
          tabId,
          'network-observed',
          url,
          `${known ? 'segment manifest-known' : 'segment manifest-unknown'} frame=${frameId}`,
        ),
      );
    } catch {
      // ignore unparseable URLs
    }
    return;
  }
  // Record notable near-misses only (media-ish traffic), never full URLs.
  const looksInteresting =
    type === 'media' ||
    type === 'xmlhttprequest' ||
    /\.m3u8|\.mpd(\?|#|$)/i.test(url);
  if (looksInteresting) {
    const reason = res.reason === 'blob-url' ? 'blob-source-skipped' : 'non-media-filtered';
    dlog(makeDiag(tabId, reason, url, `type=${type} frame=${frameId} via=${stage}`));
  }
  // Permission blindness check (throttled per host): without host access
  // Chrome never delivers these events at all, so a quiet network observer
  // on a media-heavy page is itself a signal worth recording once.
  try {
    const host = new URL(url).hostname;
    if (!blindHosts.has(host)) {
      blindHosts.add(host);
      void hasHostAccess(host).then((ok) => {
        if (!ok) dlog(makeDiag(tabId, 'no-host-access', url, 'webRequest blind'));
      });
    }
  } catch {
    // ignore unparseable URLs
  }
}

function remember(items: DetectedMedia[]): void {
  for (const item of items) {
    const list = tabMedia.get(item.tabId) ?? [];
    list.push(item);
    tabMedia.set(item.tabId, dedupeMedia(list).slice(-300));
    if ((item.kind === 'hls' || item.kind === 'dash') && item.hostname) {
      let hosts = tabManifestHosts.get(item.tabId);
      if (!hosts) {
        hosts = new Set();
        tabManifestHosts.set(item.tabId, hosts);
      }
      hosts.add(item.hostname);
    }
  }
  void putMedia(items).catch(() => undefined);
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const msg = parseMessage(raw);
    if (!msg) return false;

    if (msg.type === 'MEDIA_DETECTED') {
      const fromTab = sender.tab?.id ?? -1;
      const items = msg.payload.items
        .map((i) => ({ ...i, tabId: fromTab }))
        .filter((i) => i.tabId >= 0);
      remember(items);
      dlog({
        t: Date.now(),
        tabId: fromTab,
        reason: 'network-classified',
        host: sender.tab?.url ? new URL(sender.tab.url).hostname : null,
        detail: `frame=${sender.frameId ?? 0} items=${items.length} source=dom`,
      });
      sendResponse({ ok: true, count: items.length });
      return false;
    }

    if (msg.type === 'DIAG_EVENT') {
      const fromTab = sender.tab?.id ?? -1;
      for (const e of msg.payload.events) {
        const tabId = e.tabId >= 0 ? e.tabId : fromTab;
        dlog({ ...e, tabId });
        if (e.stats && tabId >= 0) {
          tabStats.set(tabId, { ...e.stats, t: Date.now() });
        }
      }
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'GET_DIAGNOSTICS') {
      const { tabId, host } = msg.payload;
      void (async () => {
        const access = await hasHostAccess(host);
        sendResponse({
          ok: true,
          debug: debugLogging,
          hostAccess: access,
          itemsFound: (tabMedia.get(tabId) ?? []).length,
          counts: diag.countByReason(tabId),
          iframeHosts: diag.hostsByReason('iframe-embed-noted', tabId),
          blobHosts: diag.hostsByReason('blob-source-skipped', tabId),
          manifestHosts: [...(tabManifestHosts.get(tabId) ?? [])],
          latestStats: tabStats.get(tabId) ?? null,
          recent: diag.recent(30).filter((e) => e.tabId === tabId || e.tabId === -1),
        });
      })();
      return true;
    }

    if (msg.type === 'GET_TAB_MEDIA') {
      const cached = tabMedia.get(msg.payload.tabId) ?? [];
      void mediaForTab(msg.payload.tabId)
        .then((stored) => sendResponse({ ok: true, items: dedupeMedia([...stored, ...cached]) }))
        .catch(() => sendResponse({ ok: true, items: cached }));
      return true;
    }

    if (msg.type === 'START_DIRECT_DOWNLOAD') {
      void (async () => {
        try {
          const prefs = await loadPrefs();
          const filename = sanitizeFilename(msg.payload.filename);
          const path = joinDownloadPath(prefs.downloadSubfolder, filename);
          const browserId = await chrome.downloads.download({
            url: msg.payload.url,
            filename: path,
            conflictAction: 'uniquify',
            saveAs: false,
          });
          const item = createQueueItem({
            mediaId: msg.payload.mediaId,
            url: msg.payload.url,
            filename: path,
            kind: 'video-direct',
          });
          await putQueue({ ...item, status: 'active', browserDownloadId: browserId });
          sendResponse({ ok: true, queueId: item.id, browserDownloadId: browserId });
        } catch (e) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      })();
      return true;
    }

    if (msg.type === 'CANCEL_DOWNLOAD' || msg.type === 'RETRY_DOWNLOAD') {
      void (async () => {
        const all = await allQueue();
        const item = all.find((q) => q.id === msg.payload.queueId);
        if (!item) {
          sendResponse({ ok: false, error: 'Queue item not found' });
          return;
        }
        try {
          if (msg.type === 'CANCEL_DOWNLOAD') {
            // Stop an in-flight ffmpeg/segment job as well as any native download.
            if (item.job) {
              await ensureOffscreen().catch(() => undefined);
              await chrome.runtime
                .sendMessage({ type: 'OFFSCREEN_CANCEL', payload: { queueId: item.id } })
                .catch(() => undefined);
            }
            if (item.browserDownloadId != null) {
              await chrome.downloads.cancel(item.browserDownloadId).catch(() => undefined);
            }
            await putQueue(transition(item, 'cancelled'));
          } else if (item.job) {
            // Retry a stream job by re-executing the stored spec.
            try {
              await ensureOffscreen();
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e);
              reportInitFailure(-1, e, 'stream-retry');
              sendResponse({ ok: false, error: message });
              return;
            }
            await putQueue(transition(item, 'pending'));
            await chrome.runtime.sendMessage({
              type: 'OFFSCREEN_EXEC',
              payload: {
                queueId: item.id,
                manifestUrl: item.job.manifestUrl,
                kind: item.job.kind,
                variantId: item.job.variantId,
                audioId: item.job.audioId ?? null,
              },
            });
          } else {
            await putQueue(transition(item, 'pending'));
          }
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      })();
      return true;
    }

    if (msg.type === 'LIST_VARIANTS') {
      void (async () => {
        try {
          // Quality discovery runs in the service worker: manifest fetch +
          // parse only. The offscreen document (and ffmpeg) is NOT required
          // and is initialized lazily on actual download.
          const prefs = await loadPrefs();
          const listing = await listVariants(msg.payload.manifestUrl, msg.payload.kind, (url) =>
            fetchBytes(url, { maxBytes: prefs.maxManifestBytes, resourceType: 'master' }).then((b) =>
              new TextDecoder().decode(b),
            ),
          );
          sendResponse({ ok: true, ...listing });
        } catch (e) {
          const hint =
            e instanceof TypeError
              ? 'Manifest fetch failed — the extension likely lacks host access (grant it, then reload the page). Only content you are authorized to access is processed.'
              : e instanceof Error
                ? e.message
                : String(e);
          sendResponse({ ok: false, error: hint });
        }
      })();
      return true;
    }

    if (msg.type === 'START_STREAM_DOWNLOAD') {
      void (async () => {
        try {
          const prefs = await loadPrefs();
          const filename = sanitizeFilename(msg.payload.filename).replace(/\.[^.]+$/, '') + '.mp4';
          const path = joinDownloadPath(prefs.downloadSubfolder, filename);
          const job = {
            manifestUrl: msg.payload.manifestUrl,
            kind: msg.payload.kind,
            variantId: msg.payload.variantId,
            audioId: msg.payload.audioId ?? null,
          } as const;
          const item = createQueueItem({
            mediaId: msg.payload.mediaId,
            url: msg.payload.manifestUrl,
            filename: path,
            kind: msg.payload.kind,
            selectedVariant: msg.payload.variantId,
            job: { ...job },
          });
          await putQueue(item);
          // Lazily initialize the media processor only now that a remux is
          // actually required — never for discovery.
          try {
            await ensureOffscreen();
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            reportInitFailure(-1, e, 'stream-start');
            await putQueue(transition(transition(item, 'active'), 'failed', message)).catch(
              () => undefined,
            );
            sendResponse({ ok: false, error: message });
            return;
          }
          await chrome.runtime.sendMessage({
            type: 'OFFSCREEN_EXEC',
            payload: {
              queueId: item.id,
              manifestUrl: job.manifestUrl,
              kind: job.kind,
              variantId: job.variantId,
              audioId: job.audioId,
            },
          });
          sendResponse({ ok: true, queueId: item.id });
        } catch (e) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      })();
      return true;
    }

    return false;
  });

  chrome.webRequest.onResponseStarted.addListener(
    (details) => {
      if (details.tabId < 0) return;
      const mime =
        details.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-type')?.value ??
        null;
      observeNetwork(details.tabId, details.frameId, details.url, details.type, mime, 'response');
    },
    { urls: ['http://*/*', 'https://*/*'] },
    ['responseHeaders'],
  );

  // Frame-aware URL capture without headers: fires for every request type in
  // every frame (main + embed iframes) the extension may observe, including
  // requests whose response headers are unavailable. Non-blocking, MV3-safe.
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0) return;
      observeNetwork(details.tabId, details.frameId, details.url, details.type, null, 'request');
    },
    { urls: ['http://*/*', 'https://*/*'] },
  );

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['sfetcher:prefs:v1']) {
      const next = changes['sfetcher:prefs:v1'].newValue as { debugLogging?: boolean } | undefined;
      debugLogging = next?.debugLogging === true;
    }
  });

  chrome.downloads.onChanged.addListener((delta) => {
    if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
      void (async () => {
        const all = await allQueue().catch(() => []);
        const item = all.find((q) => q.browserDownloadId === delta.id);
        if (!item || item.status !== 'active') return;
        try {
          if (delta.state?.current === 'complete') {
            await putQueue({ ...transition(item, 'completed'), progress: 1 });
          } else {
            await putQueue(
              transition(item, 'failed', delta.error?.current ?? 'Download interrupted'),
            );
          }
        } catch {
          // ignore reconcile errors
        }
      })();
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    tabMedia.delete(tabId);
    tabManifestHosts.delete(tabId);
    tabStats.delete(tabId);
    void clearMedia(tabId).catch(() => undefined);
  });

  // Reconcile persisted active downloads after SW restart.
  void (async () => {
    const all = await allQueue().catch(() => []);
    for (const item of all.filter((q) => q.status === 'active' && q.browserDownloadId != null)) {
      try {
        const [native] = await chrome.downloads.search({ id: item.browserDownloadId as number });
        if (!native) {
          await putQueue(transition(item, 'failed', 'Browser download missing after restart'));
        } else if (native.state === 'complete') {
          await putQueue({ ...transition(item, 'completed'), progress: 1 });
        } else if (native.state === 'interrupted') {
          await putQueue(transition(item, 'failed', native.error ?? 'Interrupted'));
        }
      } catch {
        // keep as active; next event will reconcile
      }
    }
  })();
});
