/**
 * Offscreen-document lifecycle for the media processor.
 *
 * The `chrome.offscreen` namespace is absent on some Chromium builds
 * (observed: headless Chrome 155 reports `typeof chrome.offscreen ===
 * 'undefined'`), and `hasDocument` is missing on others. Every stage is
 * feature-detected so a missing API produces a named, actionable error
 * instead of `Cannot read properties of undefined`. When `hasDocument` is
 * absent we fall back to `runtime.getContexts` before creating.
 */

export type InitStage =
  | 'offscreen-api-missing'
  | 'offscreen-hasDocument'
  | 'offscreen-createDocument';

export class ProcessorInitError extends Error {
  readonly stage: InitStage;
  readonly causeStack: string | null;

  constructor(stage: InitStage, message: string, cause?: unknown) {
    super(message);
    this.name = 'ProcessorInitError';
    this.stage = stage;
    this.causeStack =
      cause instanceof Error ? (cause.stack ?? String(cause)) : cause != null ? String(cause) : null;
  }
}

interface OffscreenNamespace {
  offscreen?: {
    hasDocument?: () => Promise<boolean>;
    createDocument?: (opts: {
      url: string;
      reasons: string[];
      justification: string;
    }) => Promise<void>;
  };
  runtime?: {
    getURL?: (path: string) => string;
    getContexts?: (filter: { contextTypes: string[] }) => Promise<Array<{ contextType?: string }>>;
  };
}

/**
 * Ensure the media-processor offscreen document exists. Resolves when ready;
 * throws ProcessorInitError naming the exact failing stage. The chrome
 * namespace is injectable so this is unit-testable without a browser.
 */
export async function ensureOffscreen(
  chromeNs: OffscreenNamespace = globalThis.chrome as OffscreenNamespace,
  docUrl = 'offscreen.html',
): Promise<void> {
  const offscreen = chromeNs?.offscreen;
  if (!offscreen) {
    throw new ProcessorInitError(
      'offscreen-api-missing',
      'Media processor unavailable: this browser does not expose the chrome.offscreen API ' +
        '(stage offscreen-api-missing). Quality lists and direct downloads keep working; ' +
        'stream remuxing needs a Chromium build with offscreen-document support (Chrome 109+).',
    );
  }
  // hasDocument is optional and absent on some Chromium builds — when it is
  // present use it; otherwise fall back to runtime.getContexts. A missing
  // hasDocument alone is never treated as a missing API.
  if (typeof offscreen.hasDocument === 'function') {
    let has: boolean;
    try {
      has = await offscreen.hasDocument();
    } catch (cause) {
      throw new ProcessorInitError(
        'offscreen-hasDocument',
        `Media processor unavailable at stage offscreen-hasDocument: ${messageOf(cause)}`,
        cause,
      );
    }
    if (has) return;
  } else if (typeof chromeNs?.runtime?.getContexts === 'function') {
    // hasDocument missing: check for an existing offscreen document via
    // getContexts so we don't create duplicates. A failure here is not
    // fatal — fall through and attempt creation.
    try {
      const contexts = await chromeNs.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (contexts.length > 0) return;
    } catch {
      // ignore; attempt creation below
    }
  }
  if (typeof offscreen.createDocument !== 'function') {
    throw new ProcessorInitError(
      'offscreen-api-missing',
      'Media processor unavailable: chrome.offscreen.createDocument is missing (stage offscreen-api-missing).',
    );
  }
  const url = chromeNs?.runtime?.getURL?.(docUrl) ?? docUrl;
  try {
    await offscreen.createDocument({
      url,
      reasons: ['BLOBS'],
      justification: 'Local remuxing of user-authorized HLS/DASH segments into playable files.',
    });
  } catch (cause) {
    throw new ProcessorInitError(
      'offscreen-createDocument',
      `Media processor unavailable at stage offscreen-createDocument: ${messageOf(cause)}`,
      cause,
    );
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
