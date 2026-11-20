import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppSettings,
  LiveTvChannel,
  LiveTvEpgOption,
  LiveTvStatus,
  LiveTvTestResult,
  ShowListItem,
} from '../lib/types';

const PAGE_SIZE = 100;

const LIBRARY_MODES: Array<{ id: NonNullable<LiveTvChannel['libraryMode']>; label: string }> = [
  { id: 'random-movies', label: 'Random movies' },
  { id: 'random-episodes', label: 'Random episodes' },
  { id: 'random-mix', label: 'Random movies and episodes' },
  { id: 'latest-movies', label: 'Latest movies' },
  { id: 'latest-episodes', label: 'Latest episodes' },
  { id: 'latest-mix', label: 'Latest movies and episodes' },
  { id: 'show', label: 'One show, in order' },
];

export default function LiveTvView() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [status, setStatus] = useState<LiveTvStatus | null>(null);
  const [channels, setChannels] = useState<LiveTvChannel[]>([]);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('');
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [epgOptions, setEpgOptions] = useState<LiveTvEpgOption[]>([]);
  const [libShows, setLibShows] = useState<ShowListItem[]>([]);
  const [customName, setCustomName] = useState('Nightfeed Mix');
  const [customMode, setCustomMode] = useState<NonNullable<LiveTvChannel['libraryMode']>>('random-mix');
  const [customShow, setCustomShow] = useState<number | ''>('');
  const [page, setPage] = useState(0);
  const [numDrafts, setNumDrafts] = useState<Record<string, string>>({});
  const [testResults, setTestResults] = useState<Record<string, LiveTvTestResult | 'testing'>>({});
  const channelsRef = useRef<LiveTvChannel[]>(channels);
  channelsRef.current = channels;
  const persistChainRef = useRef<Promise<void>>(Promise.resolve());
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    const [s, st, ch, epg] = await Promise.all([
      window.torrentAPI.getSettings(),
      window.torrentAPI.getLiveTvStatus?.(),
      window.torrentAPI.getLiveTvChannels?.(),
      window.torrentAPI.getLiveTvEpgOptions?.(),
    ]);
    if (!mountedRef.current) return;
    setSettings(s as AppSettings);
    setStatus((st || null) as LiveTvStatus | null);
    setChannels(Array.isArray(ch) ? (ch as LiveTvChannel[]) : []);
    setEpgOptions(Array.isArray(epg) ? (epg as LiveTvEpgOption[]) : []);
    const shows = await window.torrentAPI.getShows?.();
    if (!mountedRef.current) return;
    setLibShows(Array.isArray(shows) ? (shows as ShowListItem[]) : []);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    void load().catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });
    const t = setInterval(() => {
      void window.torrentAPI
        .getLiveTvStatus?.()
        .then((st) => {
          if (!cancelled && st) setStatus(st as LiveTvStatus);
        })
        .catch(() => undefined);
    }, 4000);
    return () => {
      mountedRef.current = false;
      cancelled = true;
      clearInterval(t);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, [load]);

  const saveSettings = async (partial: Partial<AppSettings>) => {
    setError(null);
    try {
      const next = (await window.torrentAPI.setSettings(partial)) as AppSettings;
      if (!mountedRef.current) return;
      setSettings(next);
      setStatus((await window.torrentAPI.getLiveTvStatus?.()) as LiveTvStatus);
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
    }
  };

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      // Flush any edited source fields before refreshing so clicking Refresh right after typing works.
      if (settings) {
        const saved = (await window.torrentAPI.setSettings({
          liveTvSourceType: settings.liveTvSourceType,
          liveTvM3uUrl: settings.liveTvM3uUrl,
          liveTvXmltvUrl: settings.liveTvXmltvUrl,
          liveTvXtreamHost: settings.liveTvXtreamHost,
          liveTvXtreamPort: settings.liveTvXtreamPort,
          liveTvXtreamUsername: settings.liveTvXtreamUsername,
          liveTvXtreamPassword: settings.liveTvXtreamPassword,
          liveTvXtreamHls: settings.liveTvXtreamHls,
          liveTvDirectUrl: settings.liveTvDirectUrl,
          liveTvDirectName: settings.liveTvDirectName,
        })) as AppSettings;
        if (mountedRef.current) setSettings(saved);
      }
      const ch = (await window.torrentAPI.refreshLiveTv?.()) as LiveTvChannel[];
      if (!mountedRef.current) return;
      setChannels(Array.isArray(ch) ? ch : []);
      setNumDrafts({});
      setTestResults({});
      setStatus((await window.torrentAPI.getLiveTvStatus?.()) as LiveTvStatus);
      const epg = await window.torrentAPI.getLiveTvEpgOptions?.();
      if (mountedRef.current) setEpgOptions(Array.isArray(epg) ? (epg as LiveTvEpgOption[]) : []);
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const persist = (next: LiveTvChannel[]) => {
    channelsRef.current = next;
    setChannels(next);
    persistChainRef.current = persistChainRef.current
      .then(async () => {
        await window.torrentAPI.setLiveTvChannels?.(next);
        const st = (await window.torrentAPI.getLiveTvStatus?.()) as LiveTvStatus;
        if (mountedRef.current && st) setStatus(st);
      })
      .catch((e) => {
        if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
      });
    return persistChainRef.current;
  };

  const pickChannelIcon = async (channelId: string) => {
    try {
      const p = await window.torrentAPI.pickFile?.([
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
      ]);
      if (!p) return;
      const next = (await window.torrentAPI.setLiveTvIcon?.(channelId, p)) as LiveTvChannel[];
      if (mountedRef.current && Array.isArray(next)) {
        channelsRef.current = next;
        setChannels(next);
      }
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
    }
  };

  const runChannelTest = async (channelId: string) => {
    setTestResults((prev) => ({ ...prev, [channelId]: 'testing' }));
    try {
      const res = await window.torrentAPI.testLiveTvChannel?.(channelId);
      if (!mountedRef.current) return;
      if (res) {
        setTestResults((prev) => ({ ...prev, [channelId]: res }));
      }
    } catch (e) {
      if (!mountedRef.current) return;
      setTestResults((prev) => ({
        ...prev,
        [channelId]: {
          ok: false,
          latencyMs: 0,
          detail: e instanceof Error ? e.message : String(e),
        },
      }));
    }
  };

  const dismissStreamError = async () => {
    try {
      const st = await window.torrentAPI.clearLiveTvError?.();
      if (mountedRef.current && st) setStatus(st);
    } catch {
      // ignore
    }
  };

  const groups = useMemo(() => {
    const s = new Set<string>();
    for (const c of channels) if (c.kind !== 'library' && c.group) s.add(c.group);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [channels]);

  const customChannels = useMemo(() => channels.filter((c) => c.kind === 'library'), [channels]);
  const iptvChannels = useMemo(() => channels.filter((c) => c.kind !== 'library'), [channels]);
  const iptvEnabledCount = useMemo(() => iptvChannels.filter((c) => c.enabled).length, [iptvChannels]);
  const enabledCount = useMemo(() => channels.filter((c) => c.enabled).length, [channels]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return iptvChannels.filter((c) => {
      if (enabledOnly && !c.enabled) return false;
      if (group && c.group !== group) return false;
      if (q && !`${c.name} ${c.group} ${c.tvgId}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [iptvChannels, query, group, enabledOnly]);

  useEffect(() => {
    setPage(0);
  }, [query, group, enabledOnly]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = useMemo(
    () => visible.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE),
    [visible, safePage]
  );

  const applyToVisible = (patch: Partial<LiveTvChannel>) => {
    const visibleIds = new Set(visible.map((v) => v.id));
    void persist(channelsRef.current.map((c) => (visibleIds.has(c.id) ? { ...c, ...patch } : c)));
  };

  const s = settings;

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null;
        setCopied(null);
      }, 1500);
    } catch {
      setCopied(null);
    }
  };

  const renderNumberInput = (c: LiveTvChannel) => {
    const numValue = numDrafts[c.id] !== undefined ? numDrafts[c.id] : String(c.number);
    return (
      <input
        className="mono"
        style={{ width: 64, padding: '0.25rem 0.35rem' }}
        value={numValue}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^0-9]/g, '');
          setNumDrafts((prev) => ({ ...prev, [c.id]: raw }));
        }}
        onBlur={() => {
          const raw = numDrafts[c.id];
          setNumDrafts((prev) => {
            if (!(c.id in prev)) return prev;
            const copy = { ...prev };
            delete copy[c.id];
            return copy;
          });
          if (raw === undefined) return;
          const parsed = parseInt(raw, 10);
          const nextNum = Number.isFinite(parsed) && parsed >= 1 ? parsed : c.number;
          if (nextNum === c.number) return;
          void persist(channelsRef.current.map((x) => (x.id === c.id ? { ...x, number: nextNum } : x)));
        }}
      />
    );
  };

  const renderIconCell = (c: LiveTvChannel) => {
    const iconSrc = c.logoPreview || (/^https?:\/\//i.test(c.logo) ? c.logo : '');
    return (
      <div className="row" style={{ gap: 4, alignItems: 'center' }}>
        {iconSrc ? <img className="ltv-logo" src={iconSrc} alt="" /> : <span className="ltv-logo ltv-logo-empty" />}
        <button
          type="button"
          style={{ padding: '0.2rem 0.4rem', fontSize: '0.75rem' }}
          title="Choose local icon image"
          onClick={() => void pickChannelIcon(c.id)}
        >
          …
        </button>
      </div>
    );
  };

  const renderTestStatus = (channelId: string) => {
    const res = testResults[channelId];
    if (!res) return null;
    if (res === 'testing') {
      return (
        <div className="hint" style={{ margin: '2px 0 0', fontSize: '0.75rem' }}>
          Testing…
        </div>
      );
    }
    return (
      <div
        className="hint"
        style={{
          margin: '2px 0 0',
          fontSize: '0.75rem',
          color: res.ok ? 'var(--ok, #6fcf97)' : 'var(--danger)',
        }}
      >
        {res.detail}
      </div>
    );
  };

  return (
    <div className="page page-wide">
      <div className="page-header">
        <div>
          <h1>Live TV</h1>
          <p>
            {status?.listening ? `Tuner on ${status.tunerUrl}` : 'Tuner not listening — enable in Settings and Save'}
            {status?.lastRefresh ? ` · refreshed ${new Date(status.lastRefresh).toLocaleString()}` : ''}
          </p>
        </div>
        <div className="toolbar">
          <button type="button" className="primary" onClick={() => void refresh()} disabled={busy || !s?.liveTvEnabled}>
            {busy ? 'Refreshing…' : 'Refresh playlist'}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {status?.lastError && (
        <div
          className="error-banner"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
        >
          <span>{status.lastError}</span>
          <button type="button" onClick={() => void dismissStreamError()} style={{ flexShrink: 0 }}>
            Dismiss
          </button>
        </div>
      )}
      {enabledCount > 400 && (
        <div className="error-banner">Plex may struggle with more than ~400 enabled channels ({enabledCount} on).</div>
      )}

      <div className="settings-section">Plex</div>
      <div className="hint" style={{ marginBottom: 12 }}>
        Plex Pass → Settings → Live TV &amp; DVR → Set Up Plex DVR → “Don’t see your HDHomeRun?” → paste the tuner
        URL. Then add the XMLTV guide URL. Plex needs MPEG-TS; Nightfeed converts HLS (.m3u8) automatically and shares
        active channel streams across multiple viewers.
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <code className="status-line">{status?.tunerUrl || '—'}</code>
        <button type="button" onClick={() => status?.tunerUrl && void copy(status.tunerUrl, 'tuner')}>
          {copied === 'tuner' ? 'Copied' : 'Copy tuner'}
        </button>
        <code className="status-line">{status?.xmltvUrl || '—'}</code>
        <button type="button" onClick={() => status?.xmltvUrl && void copy(status.xmltvUrl, 'xmltv')}>
          {copied === 'xmltv' ? 'Copied' : 'Copy guide'}
        </button>
      </div>
      <div className="hint" style={{ marginBottom: 16 }}>
        Tuners in use: {status?.tunersInUse ?? 0}/{status?.tuners ?? 0}
        {status?.active?.length ? ` — ${status.active.map((a) => `${a.number} ${a.name}`).join(', ')}` : ''}
        {status?.ffmpegFound
          ? ` · ffmpeg ready${status.hwEncoder ? ` (${status.hwEncoder})` : ''}`
          : ' · ffmpeg not found (auto-installs for custom channels)'}
        {typeof status?.epgChannelCount === 'number' && status.epgChannelCount > 0
          ? ` · EPG: ${status.epgChannelCount} channels`
          : ''}
      </div>

      <div className="settings-section">Source</div>
      {s && (
        <>
          <div className="field">
            <label>Type</label>
            <select
              value={s.liveTvSourceType || 'none'}
              onChange={(e) =>
                void saveSettings({
                  liveTvSourceType: e.target.value as AppSettings['liveTvSourceType'],
                })
              }
            >
              <option value="none">—</option>
              <option value="m3u">M3U / M3U8 file or URL</option>
              <option value="xtream">Xtream Codes</option>
              <option value="direct">Direct stream URL</option>
            </select>
          </div>
          {s.liveTvSourceType === 'm3u' && (
            <>
              <div className="field">
                <label>M3U URL or file</label>
                <div className="row" style={{ gap: 8 }}>
                  <input
                    value={s.liveTvM3uUrl || ''}
                    onChange={(e) => setSettings({ ...s, liveTvM3uUrl: e.target.value })}
                    onBlur={() => void saveSettings({ liveTvM3uUrl: s.liveTvM3uUrl })}
                    placeholder="https://…/playlist.m3u or local path"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const p = await window.torrentAPI.pickFile?.([
                        { name: 'M3U', extensions: ['m3u', 'm3u8', 'txt'] },
                      ]);
                      if (p) {
                        setSettings({ ...s, liveTvM3uUrl: p });
                        await saveSettings({ liveTvM3uUrl: p });
                      }
                    }}
                  >
                    Browse…
                  </button>
                </div>
              </div>
              <div className="field">
                <label>XMLTV guide URL (optional, supports .xml and .xml.gz)</label>
                <input
                  value={s.liveTvXmltvUrl || ''}
                  onChange={(e) => setSettings({ ...s, liveTvXmltvUrl: e.target.value })}
                  onBlur={() => void saveSettings({ liveTvXmltvUrl: s.liveTvXmltvUrl })}
                  placeholder="https://…/epg.xml.gz"
                />
              </div>
            </>
          )}
          {s.liveTvSourceType === 'xtream' && (
            <>
              <div className="field">
                <label>Host</label>
                <input
                  value={s.liveTvXtreamHost || ''}
                  placeholder="http://host:port or host"
                  onChange={(e) => setSettings({ ...s, liveTvXtreamHost: e.target.value })}
                  onBlur={() => void saveSettings({ liveTvXtreamHost: s.liveTvXtreamHost })}
                />
              </div>
              <div className="field">
                <label>Port (when not included in Host)</label>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={s.liveTvXtreamPort ?? 80}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    setSettings({ ...s, liveTvXtreamPort: Number.isFinite(n) ? n : 80 });
                  }}
                  onBlur={() =>
                    void saveSettings({
                      liveTvXtreamPort: Math.max(1, Math.min(65535, s.liveTvXtreamPort || 80)),
                    })
                  }
                />
              </div>
              <div className="field">
                <label>Username</label>
                <input
                  value={s.liveTvXtreamUsername || ''}
                  onChange={(e) => setSettings({ ...s, liveTvXtreamUsername: e.target.value })}
                  onBlur={() => void saveSettings({ liveTvXtreamUsername: s.liveTvXtreamUsername })}
                />
              </div>
              <div className="field">
                <label>Password</label>
                <input
                  type="password"
                  autoComplete="off"
                  value={s.liveTvXtreamPassword || ''}
                  onChange={(e) => setSettings({ ...s, liveTvXtreamPassword: e.target.value })}
                  onBlur={() => void saveSettings({ liveTvXtreamPassword: s.liveTvXtreamPassword })}
                />
                <div className="hint">Never logged.</div>
              </div>
              <div className="field">
                <label>XMLTV guide URL override (optional, leave blank to use Xtream EPG)</label>
                <input
                  value={s.liveTvXmltvUrl || ''}
                  onChange={(e) => setSettings({ ...s, liveTvXmltvUrl: e.target.value })}
                  onBlur={() => void saveSettings({ liveTvXmltvUrl: s.liveTvXmltvUrl })}
                  placeholder="Optional custom .xml / .xml.gz URL"
                />
              </div>
              <div className="field">
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={!!s.liveTvXtreamHls}
                    onChange={(e) => void saveSettings({ liveTvXtreamHls: e.target.checked })}
                  />
                  <span>Use HLS (.m3u8) instead of MPEG-TS</span>
                </label>
              </div>
            </>
          )}
          {s.liveTvSourceType === 'direct' && (
            <>
              <div className="field">
                <label>Stream URL</label>
                <input
                  value={s.liveTvDirectUrl || ''}
                  onChange={(e) => setSettings({ ...s, liveTvDirectUrl: e.target.value })}
                  onBlur={() => void saveSettings({ liveTvDirectUrl: s.liveTvDirectUrl })}
                />
              </div>
              <div className="field">
                <label>Name</label>
                <input
                  value={s.liveTvDirectName || ''}
                  onChange={(e) => setSettings({ ...s, liveTvDirectName: e.target.value })}
                  onBlur={() => void saveSettings({ liveTvDirectName: s.liveTvDirectName })}
                />
              </div>
            </>
          )}
        </>
      )}

      <div className="settings-section">Custom channels ({customChannels.length})</div>
      <div className="hint" style={{ marginBottom: 10 }}>
        These play files already in your TV and movie libraries using real probed durations and continuous schedules.
        H.264 files copy video directly; HEVC/other codecs use your verified GPU encoder ({status?.hwEncoder || 'auto'})
        when available.
      </div>
      <div className="toolbar" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        <input
          style={{ maxWidth: 220 }}
          placeholder="Channel name"
          value={customName}
          onChange={(e) => setCustomName(e.target.value)}
        />
        <select
          value={customMode}
          onChange={(e) => setCustomMode(e.target.value as NonNullable<LiveTvChannel['libraryMode']>)}
          style={{ maxWidth: 280 }}
        >
          {LIBRARY_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        {customMode === 'show' && (
          <select
            value={customShow === '' ? '' : String(customShow)}
            onChange={(e) => setCustomShow(e.target.value ? Number(e.target.value) : '')}
            style={{ maxWidth: 260 }}
          >
            <option value="">Choose a show…</option>
            {libShows.map((sh) => (
              <option key={sh.tmdbId} value={sh.tmdbId}>
                {sh.name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="primary"
          disabled={customMode === 'show' && customShow === ''}
          onClick={() => {
            if (customMode === 'show' && customShow === '') return;
            const id = `lib-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            const number = channelsRef.current.reduce((max, c) => Math.max(max, c.number || 0), 0) + 1;
            const ch: LiveTvChannel = {
              id,
              name: customName.trim() || 'Nightfeed',
              number,
              group: 'Nightfeed',
              logo: '',
              tvgId: `nf-${id}`,
              url: `nightfeed://library/${id}`,
              enabled: true,
              kind: 'library',
              libraryMode: customMode,
              showTmdbId: customMode === 'show' && customShow !== '' ? Number(customShow) : null,
              epgCustom: true,
            };
            void persist([ch, ...channelsRef.current]);
          }}
        >
          Add channel
        </button>
      </div>
      {customChannels.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 16 }}>
          <table className="dense">
            <thead>
              <tr>
                <th style={{ width: 52 }}>On</th>
                <th style={{ width: 70 }}>#</th>
                <th style={{ width: 52 }}>Icon</th>
                <th>Name</th>
                <th>Plays</th>
                <th>Now playing</th>
                <th style={{ width: 150 }}></th>
              </tr>
            </thead>
            <tbody>
              {customChannels.map((c) => (
                <tr key={c.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      onChange={(e) =>
                        void persist(
                          channelsRef.current.map((x) => (x.id === c.id ? { ...x, enabled: e.target.checked } : x))
                        )
                      }
                    />
                  </td>
                  <td>{renderNumberInput(c)}</td>
                  <td>{renderIconCell(c)}</td>
                  <td>
                    <input
                      value={c.name}
                      onChange={(e) => {
                        const v = e.target.value;
                        const next = channelsRef.current.map((x) => (x.id === c.id ? { ...x, name: v } : x));
                        channelsRef.current = next;
                        setChannels(next);
                      }}
                      onBlur={() => void persist(channelsRef.current)}
                    />
                  </td>
                  <td style={{ color: 'var(--text-dim)' }}>
                    {LIBRARY_MODES.find((m) => m.id === c.libraryMode)?.label || c.libraryMode}
                    {c.libraryMode === 'show'
                      ? ` — ${libShows.find((sh) => sh.tmdbId === c.showTmdbId)?.name || 'show'}`
                      : ''}
                  </td>
                  <td style={{ color: 'var(--text-dim)', maxWidth: 260 }}>
                    <div>{status?.libraryNowPlaying?.[c.id] || '—'}</div>
                    {renderTestStatus(c.id)}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      <button
                        type="button"
                        disabled={testResults[c.id] === 'testing'}
                        onClick={() => void runChannelTest(c.id)}
                      >
                        Test
                      </button>
                      <button
                        type="button"
                        onClick={() => void persist(channelsRef.current.filter((x) => x.id !== c.id))}
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="settings-section">
        IPTV channels ({iptvEnabledCount} enabled / {iptvChannels.length})
      </div>
      <div className="toolbar" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        <input
          style={{ maxWidth: 220 }}
          placeholder="Search channels…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={group} onChange={(e) => setGroup(e.target.value)} style={{ maxWidth: 220 }}>
          <option value="">All groups</option>
          {groups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <label className="toggle-row" style={{ margin: '0 4px' }}>
          <input
            type="checkbox"
            checked={enabledOnly}
            onChange={(e) => setEnabledOnly(e.target.checked)}
          />
          <span>Enabled only</span>
        </label>
        <button type="button" onClick={() => applyToVisible({ enabled: true })}>
          Enable visible
        </button>
        <button type="button" onClick={() => applyToVisible({ enabled: false })}>
          Disable visible
        </button>
        <button type="button" onClick={() => applyToVisible({ fakeEpg: true })}>
          Fake EPG on visible
        </button>
        <button type="button" onClick={() => applyToVisible({ fakeEpg: false })}>
          Clear fake on visible
        </button>
      </div>
      {visible.length > PAGE_SIZE && (
        <div className="toolbar" style={{ marginBottom: 10 }}>
          <span className="hint" style={{ margin: 0 }}>
            Showing {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, visible.length)} of{' '}
            {visible.length} matching channels
          </span>
          <button type="button" disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            ← Prev
          </button>
          <span className="mono" style={{ fontSize: '0.82rem' }}>
            Page {safePage + 1} / {pageCount}
          </span>
          <button
            type="button"
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          >
            Next →
          </button>
        </div>
      )}
      <div className="hint" style={{ marginBottom: 10 }}>
        Icon: URL or Browse a local image (Plex reads it from the XMLTV guide). EPG id: pick a guide channel or type
        one. Fake: repeating Live blocks when you don’t have a real mapping.
      </div>
      <datalist id="nf-epg-ids">
        {epgOptions.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name !== o.id ? `${o.name}` : o.id}
          </option>
        ))}
      </datalist>

      {iptvChannels.length === 0 ? (
        <div className="empty-state">
          <h2>No IPTV channels yet</h2>
          <p>Set a source above and click Refresh playlist. New channels stay off until you enable them for Plex.</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="empty-state">
          <h2>No matching channels</h2>
          <p>Try clearing your search, group, or “Enabled only” filter.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="dense">
            <thead>
              <tr>
                <th style={{ width: 52 }}>On</th>
                <th style={{ width: 70 }}>#</th>
                <th style={{ width: 52 }}>Icon</th>
                <th>Name</th>
                <th>Group</th>
                <th>EPG id</th>
                <th style={{ width: 70 }}>Fake</th>
                <th style={{ width: 90 }}>Test</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((c) => (
                <tr key={c.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      onChange={(e) =>
                        void persist(
                          channelsRef.current.map((x) => (x.id === c.id ? { ...x, enabled: e.target.checked } : x))
                        )
                      }
                    />
                  </td>
                  <td>{renderNumberInput(c)}</td>
                  <td>{renderIconCell(c)}</td>
                  <td>
                    <input
                      value={c.name}
                      onChange={(e) => {
                        const v = e.target.value;
                        const next = channelsRef.current.map((x) => (x.id === c.id ? { ...x, name: v } : x));
                        channelsRef.current = next;
                        setChannels(next);
                      }}
                      onBlur={() => void persist(channelsRef.current)}
                    />
                    {renderTestStatus(c.id)}
                  </td>
                  <td style={{ color: 'var(--text-dim)' }}>{c.group || '—'}</td>
                  <td>
                    <input
                      className="mono"
                      list="nf-epg-ids"
                      placeholder="guide id"
                      value={c.tvgId}
                      onChange={(e) => {
                        const v = e.target.value;
                        const next = channelsRef.current.map((x) =>
                          x.id === c.id ? { ...x, tvgId: v, epgCustom: true } : x
                        );
                        channelsRef.current = next;
                        setChannels(next);
                      }}
                      onBlur={(e) => {
                        const value = e.target.value;
                        if (value === (c.tvgId || '') && !c.epgCustom) return;
                        void persist(
                          channelsRef.current.map((x) =>
                            x.id === c.id ? { ...x, tvgId: value, epgCustom: true } : x
                          )
                        );
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={!!c.fakeEpg}
                      title="Always use a fake repeating guide for this channel"
                      onChange={(e) =>
                        void persist(
                          channelsRef.current.map((x) => (x.id === c.id ? { ...x, fakeEpg: e.target.checked } : x))
                        )
                      }
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      disabled={testResults[c.id] === 'testing'}
                      onClick={() => void runChannelTest(c.id)}
                    >
                      {testResults[c.id] === 'testing' ? '…' : 'Test'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
