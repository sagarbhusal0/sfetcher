import { useEffect, useState } from 'react';
import { RotateCcw, Trash2, XCircle, Settings2, Bug } from 'lucide-react';
import type { QueueItem, UserPrefs } from '../../src/shared/types';
import { DEFAULT_PREFS } from '../../src/shared/types';
import { loadPrefs, savePrefs } from '../../src/storage/prefs';
import { allQueue, clearQueueHistory } from '../../src/storage/db';

interface DiagRow {
  t: number;
  tabId: number;
  reason: string;
  host: string | null;
  detail: string;
}

export default function Manager() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [prefs, setPrefs] = useState<UserPrefs>(DEFAULT_PREFS);
  const [error, setError] = useState<string | null>(null);
  const [diagRows, setDiagRows] = useState<DiagRow[]>([]);
  const [diagCounts, setDiagCounts] = useState<Record<string, number>>({});

  const refresh = async () => {
    try {
      setQueue(await allQueue());
      const p = await loadPrefs();
      setPrefs(p);
      if (p.debugLogging) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
        const d = await chrome.runtime
          .sendMessage({
            type: 'GET_DIAGNOSTICS',
            payload: { tabId: tab?.id ?? 0, host: tab?.url ? new URL(tab.url).hostname : '' },
          })
          .catch(() => null);
        if (d?.ok) {
          setDiagRows(d.recent as DiagRow[]);
          setDiagCounts(d.counts as Record<string, number>);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, []);

  const act = async (type: 'CANCEL_DOWNLOAD' | 'RETRY_DOWNLOAD', queueId: string) => {
    await chrome.runtime.sendMessage({ type, payload: { queueId } }).catch(() => undefined);
    await refresh();
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center gap-3">
        <h1 className="font-semibold">Sfetcher — Download Manager</h1>
        <span className="text-xs text-zinc-500">local-first · no accounts · no telemetry</span>
      </header>
      <main className="max-w-4xl mx-auto p-6 space-y-6">
        {error && <p className="text-sm text-red-300">{error}</p>}

        <section>
          <h2 className="text-sm font-medium text-zinc-300 mb-2">Queue ({queue.length})</h2>
          {queue.length === 0 && (
            <p className="text-sm text-zinc-500">Queue is empty. Start a download from the popup.</p>
          )}
          <ul className="space-y-2">
            {queue.map((q) => (
              <li key={q.id} className="border border-zinc-800 rounded p-3 bg-zinc-900/50">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-mono text-xs text-zinc-400">{q.status}</span>
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-200">
                    {q.job ? `stream:${q.job.kind}` : q.kind}
                  </span>
                  <span className="truncate flex-1" title={q.url}>{q.filename}</span>
                  <span className="text-xs text-zinc-500">{Math.round(q.progress * 100)}%</span>
                  {q.status === 'active' || q.status === 'pending' ? (
                    <button
                      onClick={() => void act('CANCEL_DOWNLOAD', q.id)}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 border border-zinc-700 rounded"
                    >
                      <XCircle size={12} /> Cancel
                    </button>
                  ) : null}
                  {q.status === 'failed' || q.status === 'cancelled' ? (
                    <button
                      onClick={() => void act('RETRY_DOWNLOAD', q.id)}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 border border-zinc-700 rounded"
                    >
                      <RotateCcw size={12} /> Retry
                    </button>
                  ) : null}
                </div>
                {q.error && <p className="text-xs text-red-300 mt-1">{q.error}</p>}
                <div className="h-1 bg-zinc-800 rounded mt-2">
                  <div className="h-1 bg-zinc-200 rounded" style={{ width: `${q.progress * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
          {queue.length > 0 && (
            <button
              onClick={() => void clearQueueHistory().then(refresh)}
              className="mt-2 inline-flex items-center gap-1 text-xs text-zinc-400"
            >
              <Trash2 size={12} /> Clear finished
            </button>
          )}
        </section>

        <section className="border border-zinc-800 rounded p-4">
          <h2 className="text-sm font-medium mb-3 inline-flex items-center gap-2">
            <Settings2 size={14} /> Settings
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <label className="space-y-1">
              <span className="text-xs text-zinc-400">Theme</span>
              <select
                value={prefs.theme}
                onChange={(e) => {
                  const next = { ...prefs, theme: e.target.value as UserPrefs['theme'] };
                  setPrefs(next);
                  void savePrefs(next);
                }}
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5"
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-zinc-400">Download subfolder</span>
              <input
                value={prefs.downloadSubfolder}
                onChange={(e) => {
                  const next = { ...prefs, downloadSubfolder: e.target.value };
                  setPrefs(next);
                }}
                onBlur={() => void savePrefs(prefs)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-zinc-400">Concurrency (1–6)</span>
              <input
                type="number"
                min={1}
                max={6}
                value={prefs.concurrency}
                onChange={(e) => {
                  const next = {
                    ...prefs,
                    concurrency: Math.max(1, Math.min(6, Number(e.target.value) || 3)),
                  };
                  setPrefs(next);
                  void savePrefs(next);
                }}
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5"
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm mt-3">
            <input
              type="checkbox"
              checked={prefs.debugLogging}
              onChange={(e) => {
                const next = { ...prefs, debugLogging: e.target.checked };
                setPrefs(next);
                void savePrefs(next);
              }}
            />
            <span className="inline-flex items-center gap-1 text-xs text-zinc-400">
              <Bug size={12} /> Development diagnostics (local console + event log; no URLs with
              query strings, cookies, or credentials are ever recorded)
            </span>
          </label>
        </section>

        {prefs.debugLogging && (
          <section className="border border-zinc-800 rounded p-4">
            <h2 className="text-sm font-medium mb-2">Detection diagnostics</h2>
            {Object.keys(diagCounts).length === 0 && (
              <p className="text-xs text-zinc-500">
                No diagnostic events yet. Open a media page, then return here.
              </p>
            )}
            {Object.keys(diagCounts).length > 0 && (
              <p className="text-xs text-zinc-400 mb-2">
                {Object.entries(diagCounts)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(' · ')}
              </p>
            )}
            <ul className="space-y-1 max-h-64 overflow-y-auto font-mono text-[11px]">
              {diagRows.map((r, i) => (
                <li key={`${r.t}-${i}`} className="text-zinc-400">
                  <span className="text-zinc-600">{new Date(r.t).toLocaleTimeString()}</span>{' '}
                  <span className="text-zinc-200">{r.reason}</span> tab={r.tabId} host=
                  {r.host ?? '-'} {r.detail}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="text-xs text-zinc-500 space-y-1">
          <h2 className="text-sm text-zinc-300 font-medium">Privacy & supported formats</h2>
          <p>All media metadata and settings stay on this device. No accounts, ads, analytics, or remote backend.</p>
          <p>Supported in v1: direct MP4/WebM/MOV/audio downloads; HLS VOD and DASH VOD (static) parsing with TS/fMP4 remux. Live streams, DRM/encrypted streams, and transcoding are explicitly unsupported and reported as such.</p>
        </section>
      </main>
    </div>
  );
}
