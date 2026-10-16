// Lightweight remux decisions without pulling ffmpeg.wasm into v1.
// MPEG-TS segments are transmuxed with mux.js; fMP4/DASH init+media segments
// are packaged with mp4box.js. Anything else is reported as unsupported
// rather than silently producing a corrupt file.

export type RemuxPlan =
  | { kind: 'ts-to-mp4'; segmentCount: number }
  | { kind: 'fmp4-package'; initPresent: boolean; segmentCount: number }
  | { kind: 'unsupported'; reason: string };

export function planRemux(input: {
  container: 'ts' | 'fmp4' | 'unknown';
  segmentCount: number;
  initPresent: boolean;
}): RemuxPlan {
  if (input.segmentCount === 0) return { kind: 'unsupported', reason: 'No segments to process' };
  if (input.container === 'ts') return { kind: 'ts-to-mp4', segmentCount: input.segmentCount };
  if (input.container === 'fmp4' && input.initPresent) {
    return { kind: 'fmp4-package', initPresent: true, segmentCount: input.segmentCount };
  }
  if (input.container === 'fmp4') {
    return { kind: 'unsupported', reason: 'fMP4 stream missing initialization segment' };
  }
  return {
    kind: 'unsupported',
    reason: 'Unknown container: transcode required (deferred; ffmpeg.wasm not bundled in v1)',
  };
}

export function sniffContainer(bytes: Uint8Array): 'ts' | 'fmp4' | 'unknown' {
  if (bytes.length >= 188 && bytes[0] === 0x47) return 'ts';
  if (bytes.length >= 8) {
    const box = String.fromCharCode(bytes[4] ?? 0, bytes[5] ?? 0, bytes[6] ?? 0, bytes[7] ?? 0);
    if (box === 'ftyp' || box === 'moof' || box === 'moov' || box === 'styp') return 'fmp4';
  }
  return 'unknown';
}
