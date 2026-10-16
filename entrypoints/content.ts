import { defineContentScript } from 'wxt/utils/define-content-script';
import { scanResourceTiming, scanRoot } from '../src/detection/domScan';
import { makeDiag } from '../src/detection/diagnose';
import { stableId } from '../src/shared/utils';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  // Episode pages (Anikoto et al.) play video inside cross-origin embed
  // iframes — the top frame has no <video> at all. Run in every frame so the
  // frame that actually hosts the player is scanned.
  allFrames: true,
  matchAboutBlank: true,
  runAt: 'document_idle',
  main() {
    const inFrame = window.self !== window.top;
    let queued = false;
    let lastSignature = '';
    let lastDiagSent = 0;
    let lastItemsSig = '';
    let lastItemsSent = 0;

    const report = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        try {
          const { items, diags, stats, signature } = scanRoot(document, {
            inFrame,
            pageHostname: location.hostname,
            title: document.title,
          });
          // Subresource requests the frame already made (HLS.js/DASH.js
          // manifest + segment fetches). Needs no extra permissions and sees
          // through blob: video elements to the real manifest URL.
          let segHosts: string[] = [];
          try {
            const timing = scanResourceTiming(
              performance
                .getEntriesByType('resource')
                .map((e) => ({ name: (e as PerformanceEntry).name })),
              document.title,
            );
            items.push(...timing.items);
            segHosts = timing.segHosts;
          } catch {
            // Performance API unavailable — DOM scan still stands.
          }
          if (items.length > 0) {
            // Player manifest/segment fetches land in the timing buffer with
            // no accompanying DOM mutation — resend when the set changes or
            // as a 15s heartbeat so late-loading streams are still caught.
            const itemsSig = stableId(items.map((i) => i.id).sort().join('|'));
            const nowItems = Date.now();
            if (itemsSig !== lastItemsSig || nowItems - lastItemsSent > 15_000) {
              lastItemsSig = itemsSig;
              lastItemsSent = nowItems;
              chrome.runtime
                .sendMessage({ type: 'MEDIA_DETECTED', payload: { items } })
                .catch(() => undefined);
            }
          }
          // Diagnostics are throttled: resend only when the page's media
          // signature changes, or at most every 10s as a heartbeat.
          const now = Date.now();
          const fullSignature = `${signature}|seg=${segHosts.length}`;
          if (fullSignature !== lastSignature || now - lastDiagSent > 10_000) {
            lastSignature = fullSignature;
            lastDiagSent = now;
            const extra =
              segHosts.length > 0
                ? [makeDiag(-1, 'network-observed', `https://${segHosts[0]}/`, 'segment-traffic')]
                : [];
            // Attach machine-readable scan stats so the popup can report
            // "N players active" honestly without parsing log strings.
            const summary = diags[0]
              ? { ...diags[0], stats }
              : makeDiag(-1, 'scan-summary', null, 'empty');
            chrome.runtime
              .sendMessage({ type: 'DIAG_EVENT', payload: { events: [summary, ...diags.slice(1), ...extra].slice(0, 20) } })
              .catch(() => undefined);
          }
        } catch {
          // never break the host page
        }
      });
    };

    // Startup marker: proves injection per frame (top vs sub) in diagnostics.
    try {
      chrome.runtime
        .sendMessage({
          type: 'DIAG_EVENT',
          payload: {
            events: [makeDiag(-1, 'scan-summary', null, `content-startup frame=${inFrame ? 'sub' : 'top'}`)],
          },
        })
        .catch(() => undefined);
    } catch {
      // ignore
    }

    report();
    const obs = new MutationObserver(report);
    const root = document.documentElement ?? document;
    obs.observe(root, { childList: true, subtree: true, attributes: true });
    // Resource-timing entries (player manifest/segment fetches) arrive with
    // no DOM mutation — poll on a slow cadence so they are still discovered.
    const poll = setInterval(report, 5000);
    window.addEventListener('beforeunload', () => clearInterval(poll));
  },
});
