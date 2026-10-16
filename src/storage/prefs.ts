import { DEFAULT_PREFS, type QueueItem, type QueueStatus, type UserPrefs } from '../shared/types.js';

const PREFS_KEY = 'sfetcher:prefs:v1';

function prefsArea(): chrome.storage.StorageArea {
  return chrome.storage.local;
}

export async function loadPrefs(): Promise<UserPrefs> {
  try {
    const raw = await prefsArea().get(PREFS_KEY);
    const stored = raw[PREFS_KEY] as Partial<UserPrefs> | undefined;
    return { ...DEFAULT_PREFS, ...stored };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export async function savePrefs(prefs: UserPrefs): Promise<void> {
  await prefsArea().set({ [PREFS_KEY]: prefs });
}

const VALID_TRANSITIONS: Record<QueueStatus, QueueStatus[]> = {
  pending: ['active', 'cancelled'],
  active: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: ['pending', 'cancelled'],
  cancelled: ['pending'],
};

export function canTransition(from: QueueStatus, to: QueueStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function createQueueItem(input: {
  mediaId: string;
  url: string;
  filename: string;
  kind: QueueItem['kind'];
  selectedVariant?: string | null;
  job?: QueueItem['job'];
}): QueueItem {
  const now = Date.now();
  return {
    id: `q_${now.toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    mediaId: input.mediaId,
    url: input.url,
    filename: input.filename,
    kind: input.kind,
    status: 'pending',
    progress: 0,
    error: null,
    createdAt: now,
    updatedAt: now,
    browserDownloadId: null,
    selectedVariant: input.selectedVariant ?? null,
    job: input.job ?? null,
  };
}

export function transition(item: QueueItem, to: QueueStatus, error: string | null = null): QueueItem {
  if (!canTransition(item.status, to)) {
    throw new Error(`Invalid queue transition ${item.status} -> ${to}`);
  }
  return { ...item, status: to, error, updatedAt: Date.now() };
}
