# Sfetcher — IMPLEMENTATION_PLAN.md

## Goal
Free, local-first Video DownloadHelper alternative (Brave/Linux priority, Chromium MV3):
detect direct media + HLS VOD + DASH VOD, download/remux locally, no backend/accounts/telemetry.

## Architecture
- `entrypoints/background.ts`: MV3 SW — tab media registry, non-blocking webRequest MIME observer, Zod-validated message router, Downloads-API orchestration, queue FSM, SW-restart reconcile.
- `entrypoints/content.ts`: DOM scan (video/audio/source, manifest hints, media-link anchors) + MutationObserver; reports to background. No page-script injection, no blob exfiltration.
- `entrypoints/popup/`: compact React finder (search/filter/sort, badges, direct download, manager link).
- `entrypoints/manager/`: full-page queue/history/settings/privacy/formats docs.
- `src/detection/`: ext+MIME+element fusion, false-positive filter, dedupe/merge.
- `src/manifests/hls/`: hand-rolled master/media parser (variants, groups, init, seq, discontinuity, EOL, VOD/live, URL resolve + scheme allowlist, encryption refusal).
- `src/manifests/dash/`: DOMParser MPD (static/dynamic, sets/reps, BaseURL chain, SegmentTemplate/Timeline/List, $…$ incl. $$ escape).
- `src/media/`: ordered segment fetch (bounded concurrency, cancel/retry/progress) + `planRemux`/`sniffContainer` (TS via mux.js, fMP4 via mp4box.js; unknown → explicit unsupported, never concat-and-rename).
- `src/downloads/` + `src/storage/`: queue FSM (pending→active→completed/failed/cancelled, invalid transitions throw), chrome.storage prefs + IndexedDB media/queue.
- `src/messaging/`: Zod schemas for every cross-context message.

## Order
1. Init (this plan, deps pinned: wxt 0.21.4, react 19.3.0, tailwind 4.3.3, zod 4.6.5, vitest 5.0.3, idb 8.0.4, mux.js 6.3.0, mp4box 2.4.1).
2. Foundation → build + unpacked load test.
3. HLS → unit + VOD pipeline integration test (synthetic fixture).
4. DASH → same.
5. Manager + hardening (minimal perms, caps, privacy page).
6. Validate: typecheck/lint/test/build/zip.

## Risks
- MV3 observability gaps → fusion + honest UI fallback.
- SW suspend → incremental persist + reconcile on startup.
- ffmpeg.wasm weight → deferred; v1 = remux/copy only, transcode reported unsupported.
- Live/DRM → detect + refuse with message (no circumvention).
- Tailwind v4/WXT drift → pinned versions, minimal config.

## Validation
`npm run typecheck|lint|test|build|zip`; manual Brave checklist (direct URL, HLS VOD, DASH VOD); gaps documented in README + final report.
