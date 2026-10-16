# Third-Party Notices

Sfetcher itself is MIT-licensed (see `LICENSE`).

## Adapted logic: hls-downloader

The HLS backend adapts architectural ideas and small algorithms from
[hls-downloader](https://github.com/puemos/hls-downloader) by Shy Alter,
also MIT-licensed:

> MIT License — Copyright (c) 2025 Shy Alter

Adapted (not copied verbatim; reimplemented for Sfetcher's WXT architecture):

- `src/media/segments.ts` — HTTP `Range: bytes=a-b` request format,
  `200 OK` slice-fallback with bounds validation, `HttpError`-style
  no-retry-on-status error model, gentle exponential backoff shape
  (upstream: `src/background/src/services/fetch-loader.ts`).
- `src/media/crypto.ts` — AES-128-CBC identity-key decryption via Web Crypto
  with playlist-or-sequence-derived IVs
  (upstream: `src/background/src/services/crypto-decryptor.ts`).
- `src/shared/utils.ts` (`propagateQueryParams`) — fill-missing query merge
  for related playlist/fragment URLs, tightened with a same-origin boundary
  the upstream version does not have
  (upstream: `src/core/src/utils/url.ts` `appendQueryParams`).
- `src/media/pipeline.ts` (`planHlsMux`) and the dual-track mux flow —
  `-c copy` video+audio packaging, ADTS reframing (`-bsf:a aac_adtstoasc`)
  for TS audio, MKV-not-needed refusal posture
  (upstream: `src/background/src/services/ffmpeg-muxer.ts` `buildMuxArgs`).
- `src/storage/fragments.ts` — per-job, per-track fragment bucketing with
  usage accounting and stale-job sweeping
  (upstream: `src/background/src/services/disk-backed-fs.ts`,
  `opfs-storage.ts`).
- Offscreen lifecycle (lazy creation, tolerate-already-exists, progress
  relay) follows the upstream offscreen pattern
  (upstream: `src/background/src/services/disk-backed-fs.ts`,
  `src/background/src/offscreen.ts`).

Not taken: UI components, Redux/epic store, blocklists, store
configuration, Firefox/MV2 build setup, or any project infrastructure.
Sfetcher is not affiliated with hls-downloader or with Video DownloadHelper.

## Bundled runtime dependencies (npm)

| Package | License | Notes |
|---|---|---|
| `@ffmpeg/core`, `@ffmpeg/ffmpeg`, `@ffmpeg/util` | MIT | Single-threaded WASM core vendored in `public/ffmpeg/`; loaded from `chrome-extension://` only. FFmpeg itself is LGPL/GPL-licensed free software; the prebuilt core is used unmodified for local remuxing. See https://ffmpeg.org/legal.html |
| `idb` | ISC | IndexedDB helpers (queue/media stores, fragment buckets) |
| `mp4box` | BSD-3-Clause | Post-mux container validation only |
| `mux.js` | Apache-2.0 | Installed but currently unused at runtime (reserved) |
| `react`, `react-dom` | MIT | Popup/Manager UI |
| `lucide-react` | ISC | Icons |
| `zod` | MIT | Cross-context message validation |
| `wxt`, `@wxt-dev/module-react`, `tailwindcss`, `@tailwindcss/vite`, `vitest`, `jsdom`, `typescript`, `eslint`, `prettier` | MIT | Build/test tooling (not shipped) |
| `@types/*` | MIT | Type packages (not shipped) |

Run `npm audit` for current vulnerability status (0 vulnerabilities at release).
