import { useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, Search, ExternalLink, Film, Music, Radio } from 'lucide-react';
import type { DetectedMedia } from '../../src/shared/types';
import { formatBytes } from '../../src/shared/utils';
import { filterMedia, type MediaFilter } from '../../src/detection/filter';

type Filter = MediaFilter;

interface VariantInfo {
  id: string;
  label: string;
  bandwidth: number | null;
  audioGroupId: string | null;
}

interface AudioRenditionInfo {
  id: string;
  groupId: string;
  name: string;
  language: string | null;
  isDefault: boolean;
  hasPlaylist: boolean;
}

function MediaRow({
  item,
  pageUrl,
  busy,
  onDownloadDirect,
  onStreamStarted,
  onError,
  markBusy,
  clearBusy,
}: {
  item: DetectedMedia;
  pageUrl: string | null;
  busy: boolean;
  onDownloadDirect: () => void;
  onStreamStarted: (msg: string) => void;
  onError: (msg: string) => void;
  markBusy: (id: string) => void;
  clearBusy: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [variants, setVariants] = useState<VariantInfo[] | null>(null);
  const [audios, setAudios] = useState<AudioRenditionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string>('highest');
  const [selectedAudio, setSelectedAudio] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const isStream = item.kind === 'hls' || item.kind === 'dash';

  // Audio renditions belonging to the selected variant's group that need a
  // separate playlist. In-band audio (no group / no URI) needs no selection.
  // 'highest' resolves backend-side to the top-bandwidth variant; mirror that
  // here so the audio choice matches what will actually download.
  const relevantAudios = useMemo(() => {
    if (!variants || variants.length === 0) return [];
    const effective =
      selected === 'highest'
        ? [...variants]
            .filter((v) => v.id !== 'highest')
            .sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0]
        : variants.find((v) => v.id === selected);
    const group = effective?.audioGroupId ?? null;
    if (!group) return [];
    return audios.filter((a) => a.groupId === group && a.hasPlaylist);
  }, [variants, audios, selected]);

  useEffect(() => {
    if (relevantAudios.length === 0) {
      setSelectedAudio(null);
      return;
    }
    setSelectedAudio((prev) => {
      if (prev && relevantAudios.some((a) => a.id === prev)) return prev;
      return (relevantAudios.find((a) => a.isDefault) ?? relevantAudios[0])?.id ?? null;
    });
  }, [relevantAudios]);

  const loadVariants = async () => {
    if (variants || loading) {
      setExpanded((v) => !v);
      return;
    }
    setLoading(true);
    setExpanded(true);
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'LIST_VARIANTS',
        payload: { manifestUrl: item.url, kind: item.kind, referrer: pageUrl },
      });
      if (!res?.ok) throw new Error(res?.error ?? 'Could not read stream variants');
      if (res.live) {
        setNote(res.note ?? 'Live stream: recording is not supported in this release.');
        setVariants([]);
      } else {
        setVariants([{ id: 'highest', label: 'Highest available', bandwidth: null, audioGroupId: null }, ...(res.variants as VariantInfo[])]);
        setAudios((res.audioRenditions ?? []) as AudioRenditionInfo[]);
        if (res.note) setNote(res.note);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      setExpanded(false);
    } finally {
      setLoading(false);
    }
  };

  const startStream = async () => {
    markBusy(item.id);
    try {
      const fallback = (item.title || item.url.split('/').pop()?.split('?')[0] || 'stream').slice(0, 120);
      const res = await chrome.runtime.sendMessage({
        type: 'START_STREAM_DOWNLOAD',
        payload: {
          mediaId: item.id,
          manifestUrl: item.url,
          kind: item.kind,
          variantId: selected,
          audioId: selectedAudio,
          referrer: pageUrl,
          filename: fallback,
        },
      });
      if (!res?.ok) throw new Error(res?.error ?? 'Stream download failed to start');
      onStreamStarted('Stream download started — track progress in the Manager.');
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      clearBusy();
    }
  };

  return (
    <li className="border border-zinc-800 rounded p-2 bg-zinc-900/60">
      <div className="flex items-center gap-2">
        <span className="text-zinc-400">
          {item.kind === 'audio-direct' ? <Music size={16} /> : item.kind === 'hls' || item.kind === 'dash' ? <Radio size={16} /> : <Film size={16} />}
        </span>
        <span className="text-[11px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-200">
          {item.kind}
        </span>
        {item.width && item.height && (
          <span className="text-[11px] text-zinc-400">
            {item.width}×{item.height}
          </span>
        )}
        <span className="ml-auto text-[11px] text-zinc-500">{item.hostname}</span>
      </div>
      <p className="truncate text-xs text-zinc-300 mt-1" title={item.url}>
        {item.title || item.url}
      </p>
      <div className="flex items-center gap-2 mt-2">
        <span className="text-[11px] text-zinc-500">
          {item.container ?? item.fileExtension ?? 'unknown'} · {formatBytes(item.estimatedSizeBytes)}
        </span>
        {!isStream && (
          <button
            onClick={onDownloadDirect}
            disabled={busy}
            className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded bg-zinc-100 text-zinc-900 text-xs disabled:opacity-50"
          >
            <ArrowDownToLine size={13} /> Download
          </button>
        )}
        {isStream && (
          <button
            onClick={() => void loadVariants()}
            className="ml-auto px-2 py-1 rounded border border-zinc-700 text-xs"
          >
            {expanded ? 'Hide qualities' : 'Qualities'}
          </button>
        )}
      </div>
      {isStream && expanded && (
        <div className="mt-2 space-y-1 border-t border-zinc-800 pt-2">
          {loading && <p className="text-[11px] text-zinc-500">Reading stream variants…</p>}
          {note && <p className="text-[11px] text-amber-300/90">{note}</p>}
          {variants && variants.length > 0 && (
            <>
              <div className="space-y-1 max-h-28 overflow-y-auto">
                {variants.map((v) => (
                  <label key={v.id} className="flex items-center gap-2 text-xs text-zinc-300">
                    <input
                      type="radio"
                      name={`q-${item.id}`}
                      checked={selected === v.id}
                      onChange={() => setSelected(v.id)}
                    />
                    {v.label}
                  </label>
                ))}
              </div>
              {relevantAudios.length > 0 && (
                <div className="space-y-1 border-t border-zinc-800 pt-2">
                  <p className="text-[11px] text-zinc-500">Audio track</p>
                  {relevantAudios.map((a) => (
                    <label key={a.id} className="flex items-center gap-2 text-xs text-zinc-300">
                      <input
                        type="radio"
                        name={`a-${item.id}`}
                        checked={selectedAudio === a.id}
                        onChange={() => setSelectedAudio(a.id)}
                      />
                      {a.language ? `${a.language} — ` : ''}{a.name}
                    </label>
                  ))}
                </div>
              )}
              <button
                onClick={() => void startStream()}
                disabled={busy}
                className="inline-flex items-center gap-1 px-2 py-1 rounded bg-zinc-100 text-zinc-900 text-xs disabled:opacity-50"
              >
                <ArrowDownToLine size={13} /> Download MP4
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

interface DiagSummary {
  hostAccess: boolean;
  itemsFound: number;
  counts: Record<string, number>;
  iframeHosts: string[];
  blobHosts: string[];
  manifestHosts: string[];
  latestStats: { videos: number; blobOnly: number; embeds: number; items: number; t: number } | null;
}

export default function App() {
  const [items, setItems] = useState<DetectedMedia[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [diag, setDiag] = useState<DiagSummary | null>(null);
  const [pageUrl, setPageUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchMedia = async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (cancelled) return;
        if (!tab?.id) {
          setNotice('No active tab.');
          return;
        }
        // Only http(s) page URLs are forwarded as fetch referrers; the
        // message schema rejects anything else.
        setPageUrl(tab.url && /^https?:\/\//i.test(tab.url) ? tab.url : null);
        const res = await chrome.runtime.sendMessage({
          type: 'GET_TAB_MEDIA',
          payload: { tabId: tab.id },
        });
        if (!cancelled) setItems((res?.items ?? []) as DetectedMedia[]);
        // Honest pipeline status: what did the scanners actually see?
        try {
          const host = tab.url ? new URL(tab.url).hostname : '';
          const d = await chrome.runtime.sendMessage({
            type: 'GET_DIAGNOSTICS',
            payload: { tabId: tab.id, host },
          });
          if (!cancelled && d?.ok) setDiag(d as DiagSummary);
        } catch {
          // diagnostics are best-effort; media list is the source of truth
        }
      } catch (e) {
        if (!cancelled) setNotice(e instanceof Error ? e.message : String(e));
      }
    };
    void fetchMedia();
    // Detections arrive asynchronously after page scan — re-poll while open.
    const t = setInterval(() => void fetchMedia(), 1500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const visible = useMemo(() => filterMedia(items, query, filter), [items, query, filter]);

  const download = async (m: DetectedMedia) => {
    setBusyId(m.id);
    setNotice(null);
    try {
      if (m.kind === 'hls' || m.kind === 'dash') {
        setNotice(
          'Adaptive streams need quality selection in the Manager. Live streams are marked unsupported in v1.',
        );
        return;
      }
      const fallback = m.url.split('/').pop()?.split('?')[0] || 'download';
      const res = await chrome.runtime.sendMessage({
        type: 'START_DIRECT_DOWNLOAD',
        payload: { mediaId: m.id, url: m.url, filename: fallback },
      });
      if (!res?.ok) throw new Error(res?.error ?? 'Download failed to start');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="w-[380px] max-h-[560px] overflow-y-auto bg-zinc-950 text-zinc-100 text-sm">
      <header className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <div className="font-semibold">Sfetcher — Media Downloader</div>
        <div className="text-xs text-zinc-400">
          {items.length} found
        </div>
      </header>
      <div className="p-3 space-y-2">
        <label className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5">
          <Search size={14} className="text-zinc-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search media…"
            className="bg-transparent outline-none flex-1 placeholder:text-zinc-600"
          />
        </label>
        <div className="flex gap-1 flex-wrap" role="tablist" aria-label="Format filter">
          {(['all', 'video-direct', 'audio-direct', 'hls', 'dash'] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2 py-1 rounded text-xs border ${
                filter === f
                  ? 'bg-zinc-100 text-zinc-900 border-zinc-100'
                  : 'border-zinc-800 text-zinc-300'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        {notice && <p className="text-xs text-amber-300 bg-amber-950/40 border border-amber-900 rounded p-2">{notice}</p>}
        {visible.length === 0 && (
          <div className="text-xs text-zinc-500 py-6 text-center space-y-2">
            <p>No downloadable resource identified on this tab yet.</p>
            {diag?.latestStats && diag.latestStats.videos > 0 && (
              <p>
                {diag.latestStats.videos} player element{diag.latestStats.videos === 1 ? '' : 's'}{' '}
                active on this page — no downloadable URL identified from{' '}
                {diag.latestStats.blobOnly > 0 ? 'opaque (blob) streams' : 'them'} yet.
              </p>
            )}
            {diag && diag.iframeHosts.length > 0 && (
              <p>
                Video plays inside embedded player(s): {diag.iframeHosts.join(', ')}. The stream
                itself isn't exposed as a downloadable URL.
              </p>
            )}
            {diag && diag.manifestHosts.length > 0 && (
              <p className="text-zinc-400">
                Stream manifest seen on: {diag.manifestHosts.join(', ')} — open Qualities on the
                item above when it appears.
              </p>
            )}
            {diag && (diag.counts['blob-source-skipped'] ?? 0) > 0 && (
              <p>
                Player uses opaque blob streams (segmented playback) — no direct manifest observed.
              </p>
            )}
            {diag && !diag.hostAccess && (
              <div className="space-y-2 rounded border border-amber-900 bg-amber-950/40 p-2">
                <p className="text-amber-300/90">
                  The extension can't observe this site's network requests yet — that is where
                  embedded players load their streams. Grant access, reload the page, and play
                  the video.
                </p>
                <button
                  onClick={() =>
                    void (async () => {
                      try {
                        const granted = await chrome.permissions.request({
                          origins: ['<all_urls>'],
                        });
                        setNotice(
                          granted
                            ? 'Access granted — reload the page, play the video, then reopen this popup.'
                            : 'Access not granted — only directly embedded files can be detected.',
                        );
                      } catch (e) {
                        setNotice(e instanceof Error ? e.message : String(e));
                      }
                    })()
                  }
                  className="px-2 py-1 rounded bg-amber-200 text-zinc-900 font-medium"
                >
                  Grant site access
                </button>
              </div>
            )}
            <p className="text-zinc-600">
              Play the video, wait a few seconds, then use Refresh. Blob-only players (e.g.
              YouTube-style embeds) can't be read by extensions.
            </p>
            <button
              onClick={() => void chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
                if (!tab?.id) return;
                const res = await chrome.runtime.sendMessage({
                  type: 'GET_TAB_MEDIA',
                  payload: { tabId: tab.id },
                });
                setItems((res?.items ?? []) as DetectedMedia[]);
              })}
              className="px-2 py-1 rounded border border-zinc-700 text-zinc-300"
            >
              Refresh now
            </button>
          </div>
        )}
        <ul className="space-y-2">
          {visible.map((m) => (
            <MediaRow
              key={m.id}
              item={m}
              pageUrl={pageUrl}
              busy={busyId === m.id}
              onDownloadDirect={() => void download(m)}
              onStreamStarted={(msg) => setNotice(msg)}
              onError={(msg) => setNotice(msg)}
              markBusy={(id) => setBusyId(id)}
              clearBusy={() => setBusyId(null)}
            />
          ))}
        </ul>
        <button
          className="w-full inline-flex items-center justify-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 py-2"
          onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('/manager.html') })}
        >
          Open download manager <ExternalLink size={12} />
        </button>
      </div>
    </div>
  );
}
