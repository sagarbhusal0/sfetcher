import { openDB, type IDBPDatabase } from 'idb';
import type { DetectedMedia, QueueItem } from '../shared/types.js';

const DB_NAME = 'sfetcher';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains('media')) {
          d.createObjectStore('media', { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains('queue')) {
          const q = d.createObjectStore('queue', { keyPath: 'id' });
          q.createIndex('by-status', 'status');
        }
      },
    });
  }
  return dbPromise;
}

export async function putMedia(items: DetectedMedia[]): Promise<void> {
  if (items.length === 0) return;
  const d = await db();
  const tx = d.transaction('media', 'readwrite');
  await Promise.all(items.map((i) => tx.store.put(i)));
  await tx.done;
}

export async function mediaForTab(tabId: number): Promise<DetectedMedia[]> {
  const d = await db();
  const all = await d.getAll('media');
  return (all as DetectedMedia[]).filter((m) => m.tabId === tabId);
}

export async function clearMedia(tabId?: number): Promise<void> {
  const d = await db();
  if (tabId == null) {
    await d.clear('media');
    return;
  }
  const tx = d.transaction('media', 'readwrite');
  const all = (await tx.store.getAll()) as DetectedMedia[];
  await Promise.all(all.filter((m) => m.tabId === tabId).map((m) => tx.store.delete(m.id)));
  await tx.done;
}

export async function putQueue(item: QueueItem): Promise<void> {
  const d = await db();
  await d.put('queue', item);
}

export async function allQueue(): Promise<QueueItem[]> {
  const d = await db();
  return (await d.getAll('queue')) as QueueItem[];
}

export async function clearQueueHistory(): Promise<void> {
  const d = await db();
  const tx = d.transaction('queue', 'readwrite');
  const all = (await tx.store.getAll()) as QueueItem[];
  await Promise.all(
    all
      .filter((q) => q.status === 'completed' || q.status === 'failed' || q.status === 'cancelled')
      .map((q) => tx.store.delete(q.id)),
  );
  await tx.done;
}
