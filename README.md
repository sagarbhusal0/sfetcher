# Sfetcher — Media Downloader (v0.2.0, full)

Free, local-first browser extension (Chromium Manifest V3) that detects downloadable
media on the current page and downloads it. No accounts, ads, analytics, telemetry,
or backend. Target: Brave on Linux (also loads in any Chromium).

## Features

- Detects MP4/WebM/MOV/audio, HLS `.m3u8`, DASH `.mpd`, HTML5 elements, network MIME hints, dynamic DOM.
- Direct downloads via Downloads API: progress, cancel/retry, filename edit, sanitize/dedupe, subfolder pref, SW-restart reconcile.
- HLS VOD end-to-end: variant + quality selection in the popup, ordered segment
  download with concurrency/cancel/retry, local remux to MP4 via the bundled
  single-threaded ffmpeg.wasm (stream copy, no transcoding), progress in the Manager.
- DASH VOD (static) end-to-end: representation selection, video+audio track
  download, local packaging to MP4. Dynamic/live MPDs are refused with a message.
- ffmpeg core (`ffmpeg-core.js` + `ffmpeg-core.wasm`) is vendored in `public/ffmpeg/`
  and loaded from `chrome-extension://` URLs only — no executable, codec, or JS
  runtime is ever fetched from a remote server at execution time.
- Processing runs in an offscreen document (MV3 service workers can't host
  long ffmpeg jobs); the popup/manager never freeze.
- Live streams, DRM/encrypted streams, and transcoding are explicitly unsupported
  and reported as such instead of producing corrupt files.
- Popup (compact) + Manager (queue/history/settings/privacy/formats). Dark-first.
- Permissions: `storage`, `downloads`, `activeTab`, `scripting`, `webRequest` + optional `<all_urls>`.

## Requirements

- Node.js 22+ (tested 24.15.0), npm 11+
- Brave (Linux) or any Chromium with MV3

## Setup

```bash
npm install
npm run dev      # WXT dev mode
npm run test     # vitest
npm run typecheck
npm run lint
npm run build    # -> .output/chrome-mv3
npm run zip      # packaged archive
```

## Load in Brave (Linux)

1. `npm run build`
2. Open `brave://extensions`, enable Developer mode
3. Load unpacked → `<repo>/.output/chrome-mv3`
4. Grant host access for the site under test
5. Popup → play media → Download; Manager via popup link (`manager.html`)

## Test URLs (use only media you are authorized to download)

- Direct: `test-pages/direct.html` (drop any authorized `sample.mp4` next to it, serve with `node serve.cjs` or any static server)
- HLS VOD: `test-pages/hls.html` (public Mux test stream; video plays via blob MSE — detection must still list the `.m3u8` manifests)
- DASH VOD: `test-pages/dash.html` (public Big Buck Bunny DASH asset)
- Blob-only: `test-pages/blob.html` (honest "player active, no downloadable URL" state)
- Iframe embed: `test-pages/iframe.html` (player in subframe, found via all-frames scan)
- Embedded third-party players (Anikoto-style): the popup's **Grant site access** button enables network observation; reload the page after granting.

## Logs / troubleshooting

- Popup/manager console + `brave://extensions` → service worker DevTools
- Missing detections: grant host access; blob-only players report a limitation instead of failing silently
- Blocked request: check optional host permission + site CSP
- Unsupported format: manager/privacy section lists v1 scope; live/DRM/transcode are refused with a message

## Limitations (honest)

- No live recording, no DRM/encrypted handling, no transcoding (remux/copy only;
  ffmpeg.wasm is bundled for remuxing, not re-encoding).
- Stream-segment fetching runs under the page's origin from the offscreen document,
  so the extension needs host access for the site/CDN (grant it, then reload).
  Direct downloads use the Downloads API and are unaffected.
- Job cap: 500 MB output, 2000 segments, 2 MB manifests — larger jobs are refused
  with a message rather than crashing the worker.
- No Firefox build; Chromium-only.
- Large VODs are held in memory during remux; very large jobs may hit worker memory.
