# Sfetcher — Media Downloader

Free, local-first Chromium Manifest V3 extension that detects downloadable
media on the current page and downloads it. No accounts, ads, analytics,
telemetry, or backend. Primary target: Brave on Linux (loads in any
Chromium MV3 browser; developed and verified with Chrome).

Inspired by Video DownloadHelper. Not affiliated with it.

## Supported

- **Direct files**: MP4/WebM/MOV/audio via Downloads API (progress,
  cancel/retry, SW-restart reconcile). Unaffected by FFmpeg.
- **HLS VOD**: master/media playlists, multiple resolutions and bitrates,
  separate audio renditions with language selection, in-band audio,
  `EXT-X-MAP` init sections, explicit and implicit `EXT-X-BYTERANGE`,
  relative/absolute/signed URLs (same-origin token propagation),
  AES-128 identity-key decryption. Live playlists are refused with a message.
- **DASH (static VOD)**: representation selection, video+audio packaging.
  Dynamic/live MPDs, multi-period subtleties beyond the first period, and
  `ContentProtection`/DRM tracks are refused with explicit errors.
- **Output**: stream-copy remux to MP4 (no transcoding), MP4 container
  validated with mp4box before success is reported. Separate audio/video
  packaged with timestamps preserved; TS audio reframed (`aac_adtstoasc`).

## Explicitly unsupported (refused with a message, never corrupt files)

Live recording, DRM (Widevine/FairPlay/SAMPLE-AES/key-service KEYFORMATs),
transcoding/re-encoding, subtitles download, resumable downloads.

## Requirements

- Node.js 22+, npm 11+
- Brave (Linux) or Chrome for running the extension

## Setup

```bash
npm install
npm run dev        # WXT dev mode
npm run test       # vitest unit suite
npm run typecheck  # tsc --noEmit
npm run lint       # eslint (see note below)
npm run build      # -> .output/chrome-mv3
npm run zip        # versioned release archive
```

Lint note: `npm run lint` currently reports pre-existing errors confined to
`test-pages/ff/*.js` (browser/worker globals in fixture files); all shipped
source is clean.

## Load unpacked

1. `npm run build`
2. Open `brave://extensions` (or `chrome://extensions`), enable Developer mode
3. Load unpacked → `<repo>/.output/chrome-mv3`
4. Grant host access for the site under test, reload the page, play the video
5. Popup → Qualities → pick resolution/audio → Download MP4; Manager shows queue

## Permissions (why each)

- `storage` — preferences + queue/media metadata (IndexedDB).
- `downloads` — saving direct files and finished remuxes.
- `activeTab`, `scripting` — tab media registry wiring.
- `webRequest` — non-blocking manifest/MIME observation (no request blocking).
- `offscreen` — media-processor document (MV3 workers can't host ffmpeg).
- `optional_host_permissions: <all_urls>` — granted by you per site; without
  it the extension can't observe that site's streams. Nothing is exfiltrated.

Extension-page CSP includes `script-src 'self' 'wasm-unsafe-eval'` solely to
allow the locally bundled FFmpeg WASM. No remote code is ever executed.

## Privacy

All processing is local: detection, fragment download, decryption of
provider-supplied AES-128 keys, remuxing, and storage stay in the browser
profile. Diagnostics record hosts and short details only — never full signed
URLs, tokens, cookies, or headers. No network request leaves the machine
except the media fetches you explicitly start.

## Troubleshooting

- **Nothing detected**: grant host access, reload, play the video, reopen the
  popup. Blob/MSE-only players report a limitation instead of failing silently.
- **HTTP 401/403**: authorization failed or the signed URL expired — reload the
  page (fresh tokens) and retry. Not retried automatically, by design.
- **HTTP 404/410**: content unavailable at that URL.
- **HTTP 429/5xx**: retried with backoff (bounded); persistent failure means
  the server keeps failing.
- **Unsupported encryption/DRM**: the exact method is named; not bypassed.
- **FFmpeg init failure**: staged error names the phase (`offscreen-*`);
  fixed by the `offscreen` permission + WASM CSP (both in the manifest).
- **Quota errors**: free disk space or clear finished jobs, then retry.

## Known limitations

- Large VODs stream fragments to an IndexedDB bucket, but the remux working
  set still lives in RAM (ffmpeg.wasm exec model); the 500 MB output /
  2000-segment / 2 MB-manifest caps stay.
- Variant playlists observed via resource timing can appear as extra rows;
  each is genuinely downloadable (use its Qualities view).
- DASH beyond static single-period VOD is experimental.
- No Firefox build; Chromium-only.

## Test URLs (only media you are authorized to download)

- `test-pages/direct.html`, `hls.html`, `dash.html`, `blob.html`, `iframe.html`
  (local fixtures + documented public test assets).

## License

MIT — see `LICENSE`. Third-party and upstream adaptations: see
`THIRD_PARTY_NOTICES.md`. Release history: see `CHANGELOG.md`.
