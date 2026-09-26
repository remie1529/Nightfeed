import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppSettings, LiveTvChannel, LiveTvEpgOption, LiveTvStatus, ShowListItem } from '../lib/types';

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [epgOptions, setEpgOptions] = useState<LiveTvEpgOption[]>([]);
  const [libShows, setLibShows] = useState<ShowListItem[]>([]);
  const [customName, setCustomName] = useState('Nightfeed Mix');
  const [customMode, setCustomMode] = useState<NonNullable<LiveTvChannel['libraryMode']>>('random-mix');
  const [customShow, setCustomShow] = useState<number | ''>('');

  const load = useCallback(async () => {
    const [s, st, ch, epg] = await Promise.all([
      window.torrentAPI.getSettings(),
      window.torrentAPI.getLiveTvStatus?.(),
      window.torrentAPI.getLiveTvChannels?.(),
      window.torrentAPI.getLiveTvEpgOptions?.(),
    ]);
    setSettings(s as AppSettings);
    setStatus((st || null) as LiveTvStatus | null);
    setChannels(Array.isArray(ch) ? (ch as LiveTvChannel[]) : []);
    setEpgOptions(Array.isArray(epg) ? (epg as LiveTvEpgOption[]) : []);
    const shows = await window.torrentAPI.getShows?.();
    setLibShows(Array.isArray(shows) ? (shows as ShowListItem[]) : []);
  }, []);

  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : String(e)));
    const t = setInterval(() => {
      void window.torrentAPI.getLiveTvStatus?.().then((st) => setStatus(st as LiveTvStatus));
    }, 4000);
    return () => clearInterval(t);
  }, [load]);

  const saveSettings = async (partial: Partial<AppSettings>) => {
    const next = (await window.torrentAPI.setSettings(partial)) as AppSettings;
    setSettings(next);
    setStatus((await window.torrentAPI.getLiveTvStatus?.()) as LiveTvStatus);
  };

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const ch = (await window.torrentAPI.refreshLiveTv?.()) as LiveTvChannel[];
      setChannels(Array.isArray(ch) ? ch : []);
      setStatus((await window.torrentAPI.getLiveTvStatus?.()) as LiveTvStatus);
      const epg = await window.torrentAPI.getLiveTvEpgOptions?.();
      setEpgOptions(Array.isArray(epg) ? (epg as LiveTvEpgOption[]) : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const persist = async (next: LiveTvChannel[]) => {
    setChannels(next);
    await window.torrentAPI.setLiveTvChannels?.(next);
    setStatus((await window.torrentAPI.getLiveTvStatus?.()) as LiveTvStatus);
  };

  const groups = useMemo(() => {
    const s = new Set<string>();
    for (const c of channels) if (c.group) s.add(c.group);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [channels]);

  const customChannels = useMemo(() => channels.filter((c) => c.kind === 'library'), [channels]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return channels.filter((c) => {
      if (c.kind === 'library') return false;
      if (group && c.group !== group) return false;
      if (q && !`${c.name} ${c.group} ${c.tvgId}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [channels, query, group]);

  const enabledCount = channels.filter((c) => c.enabled).length;
  const s = settings;

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
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
      {status?.lastError && <div className="error-banner">{status.lastError}</div>}
      {enabledCount > 400 && (
        <div className="error-banner">Plex may struggle with more than ~400 enabled channels ({enabledCount} on).</div>
      )}

      <div className="settings-section">Plex</div>
      <div className="hint" style={{ marginBottom: 12 }}>
        Plex Pass → Settings → Live TV &amp; DVR → Set Up Plex DVR → “Don’t see your HDHomeRun?” → paste the tuner
        URL. Then add the XMLTV guide URL. Plex needs MPEG-TS; Nightfeed converts HLS (.m3u8) automatically. If a
        channel still won’t play, install ffmpeg and set Settings → Live TV → Buffer to ffmpeg.
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
        {status?.active?.length
          ? ` — ${status.active.map((a) => `${a.number} ${a.name}`).join(', ')}`
          : ''}
        {status?.ffmpegFound ? ` · ffmpeg ${status.ffmpegPath}` : ' · ffmpeg not found (memory/off buffer still work)'}
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
                <label>XMLTV guide URL (optional)</label>
                <input
                  value={s.liveTvXmltvUrl || ''}
                  onChange={(e) => setSettings({ ...s, liveTvXmltvUrl: e.target.value })}
                  onBlur={() => void saveSettings({ liveTvXmltvUrl: s.liveTvXmltvUrl })}
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

      <div className="settings-section">Custom channels</div>
      <div className="hint" style={{ marginBottom: 10 }}>
        These play files already in your TV and movie libraries. The guide lists the movie or episode that is on.
        Nightfeed downloads ffmpeg automatically the first time a custom channel plays, and encodes video on the GPU (NVIDIA, Intel, or AMD) when that PC has one. Enable the channel, then refresh the Plex DVR guide.
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
          onClick={() => {
            const id = `lib-${Date.now().toString(36)}`;
            const number = channels.reduce((max, c) => Math.max(max, c.number || 0), 0) + 1;
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
            void persist([ch, ...channels]);
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
                <th>Name</th>
                <th>Plays</th>
                <th style={{ width: 90 }}></th>
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
                          channels.map((x) => (x.id === c.id ? { ...x, enabled: e.target.checked } : x))
                        )
                      }
                    />
                  </td>
                  <td>{c.name}</td>
                  <td style={{ color: 'var(--text-dim)' }}>
                    {LIBRARY_MODES.find((m) => m.id === c.libraryMode)?.label || c.libraryMode}
                    {c.libraryMode === 'show'
                      ? ` — ${libShows.find((s) => s.tmdbId === c.showTmdbId)?.name || 'show'}`
                      : ''}
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={() => void persist(channels.filter((x) => x.id !== c.id))}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="settings-section">
        IPTV channels ({enabledCount} enabled / {channels.length})
      </div>
      <div className="toolbar" style={{ marginBottom: 10 }}>
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
        <button
          type="button"
          onClick={() =>
            void persist(channels.map((c) => (visible.some((v) => v.id === c.id) ? { ...c, enabled: true } : c)))
          }
        >
          Enable visible
        </button>
        <button
          type="button"
          onClick={() =>
            void persist(channels.map((c) => (visible.some((v) => v.id === c.id) ? { ...c, enabled: false } : c)))
          }
        >
          Disable visible
        </button>
        <button
          type="button"
          onClick={() =>
            void persist(
              channels.map((c) => (visible.some((v) => v.id === c.id) ? { ...c, fakeEpg: true } : c))
            )
          }
        >
          Fake EPG on visible
        </button>
        <button
          type="button"
          onClick={() =>
            void persist(
              channels.map((c) => (visible.some((v) => v.id === c.id) ? { ...c, fakeEpg: false } : c))
            )
          }
        >
          Clear fake on visible
        </button>
      </div>
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

      {channels.length === 0 ? (
        <div className="empty-state">
          <h2>No channels yet</h2>
          <p>Set a source above and click Refresh playlist. New channels stay off until you enable them for Plex.</p>
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
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => {
                const iconSrc = c.logoPreview || (/^https?:\/\//i.test(c.logo) ? c.logo : '');
                return (
                <tr key={c.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      onChange={(e) =>
                        void persist(channels.map((x) => (x.id === c.id ? { ...x, enabled: e.target.checked } : x)))
                      }
                    />
                  </td>
                  <td>
                    <input
                      className="mono"
                      style={{ width: 64, padding: '0.25rem 0.35rem' }}
                      value={c.number}
                      onChange={(e) => {
                        const n = Number(e.target.value) || c.number;
                        setChannels(channels.map((x) => (x.id === c.id ? { ...x, number: n } : x)));
                      }}
                      onBlur={() => void persist(channels)}
                    />
                  </td>
                  <td>
                    <div className="row" style={{ gap: 4, alignItems: 'center' }}>
                      {iconSrc ? (
                        <img className="ltv-logo" src={iconSrc} alt="" />
                      ) : (
                        <span className="ltv-logo ltv-logo-empty" />
                      )}
                      <button
                        type="button"
                        style={{ padding: '0.2rem 0.4rem', fontSize: '0.75rem' }}
                        onClick={async () => {
                          const p = await window.torrentAPI.pickFile?.([
                            { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
                          ]);
                          if (!p) return;
                          const next = (await window.torrentAPI.setLiveTvIcon?.(c.id, p)) as LiveTvChannel[];
                          if (Array.isArray(next)) setChannels(next);
                        }}
                      >
                        …
                      </button>
                    </div>
                  </td>
                  <td>
                    <input
                      value={c.name}
                      onChange={(e) =>
                        setChannels(channels.map((x) => (x.id === c.id ? { ...x, name: e.target.value } : x)))
                      }
                      onBlur={() => void persist(channels)}
                    />
                  </td>
                  <td style={{ color: 'var(--text-dim)' }}>{c.group || '—'}</td>
                  <td>
                    <input
                      className="mono"
                      list="nf-epg-ids"
                      placeholder="guide id"
                      value={c.tvgId}
                      onChange={(e) =>
                        setChannels(
                          channels.map((x) =>
                            x.id === c.id ? { ...x, tvgId: e.target.value, epgCustom: true } : x
                          )
                        )
                      }
                      onBlur={() => void persist(channels)}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={!!c.fakeEpg}
                      title="Always use a fake repeating guide for this channel"
                      onChange={(e) =>
                        void persist(
                          channels.map((x) => (x.id === c.id ? { ...x, fakeEpg: e.target.checked } : x))
                        )
                      }
                    />
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
