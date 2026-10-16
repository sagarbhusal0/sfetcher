# Changelog

## 0.3.0 — HLS completion release candidate

- Manifest: `offscreen` permission + `wasm-unsafe-eval` CSP for bundled FFmpeg.
- Offscreen lifecycle hardened (`hasDocument`/`getContexts` feature detection,
  staged init errors, mux serialization, restart reconcile, finish guards).
- HLS: byte ranges (explicit/implicit), init sections, audio renditions with
  language selection, in-band audio, same-origin signed-URL propagation,
  AES-128 identity-key decryption, dual-track stream-copy mux with ADTS fix.
- Reliable fetching: typed `HttpError`/`RangeMismatchError` with sanitized
  URLs, bounded retry (429/5xx + network only; never 403/404), abort-aware
  backoff, per-resource attribution (master/variant/init/video/audio/key).
- Disk-backed IndexedDB fragment buckets with write-through, quota guard,
  startup sweep, and terminal-state cleanup.
- Post-mux MP4 validation (mp4box) before success is reported.
- DASH: signed-URL propagation + explicit ContentProtection refusal.
- Docs: README rewrite, THIRD_PARTY_NOTICES, troubleshooting, privacy.

Browser acceptance (Chrome/Brave, real streams) is the remaining gate;
see the manual test procedure in the release notes. Classified as a
release candidate until that gate passes.

## 0.2.1 and earlier

- 0.2.x: WXT/React/Tailwind MV3 shell, DOM+network detection with
  dedupe/diagnostics, popup + manager, direct downloads, basic HLS/DASH
  VOD remux via bundled single-threaded ffmpeg.wasm.
