import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppSettings, LiveTvChannel, LiveTvStatus } from '../lib/types';

export default function LiveTvView() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [status, setStatus] = useState<LiveTvStatus | null>(null);
  const [channels, setChannels] = useState<LiveTvChannel[]>([]);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, st, ch] = await Promise.all([
      window.torrentAPI.getSettings(),
      window.torrentAPI.getLiveTvStatus?.(),
      window.torrentAPI.getLiveTvChannels?.(),
    ]);
    setSettings(s as AppSettings);
    setStatus((st || null) as LiveTvStatus | null);
    setChannels(Array.isArray(ch) ? (ch as LiveTvChannel[]) : []);
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

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return channels.filter((c) => {
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
        URL. Then add the XMLTV guide URL.
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

      <div className="settings-section">
        Channels ({enabledCount} enabled / {channels.length})
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
      </div>

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
                <th>Name</th>
                <th>Group</th>
                <th>EPG id</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => (
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
                    <input
                      value={c.name}
                      onChange={(e) =>
                        setChannels(channels.map((x) => (x.id === c.id ? { ...x, name: e.target.value } : x)))
                      }
                      onBlur={() => void persist(channels)}
                    />
                  </td>
                  <td style={{ color: 'var(--text-dim)' }}>{c.group || '—'}</td>
                  <td className="mono" style={{ color: 'var(--text-faint)', fontSize: '0.75rem' }}>
                    {c.tvgId || '—'}
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
