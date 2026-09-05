import { useEffect, useState } from 'react';
import type { AppSettings, Resolution, TelegramStatus, TorrentSources, UpdateStatus } from '../lib/types';
import { DEFAULT_TORRENT_SOURCES } from '../lib/types';

const defaultSources: TorrentSources = { ...DEFAULT_TORRENT_SOURCES };

const SOURCE_OPTIONS: Array<{ id: keyof TorrentSources; label: string; hint: string }> = [
  { id: 'apibay', label: 'Apibay', hint: 'Pirate Bay JSON API' },
  { id: 'knaben', label: 'Knaben', hint: 'Meta-search JSON API' },
  { id: 'yourbittorrent', label: 'YourBittorrent', hint: 'Public search JSON' },
  { id: 'torrentscsv', label: 'Torrents.csv', hint: 'Open dump search API' },
  { id: 'eztv', label: 'EZTV', hint: 'TV via IMDb id' },
  { id: 'animetosho', label: 'AnimeTosho', hint: 'Anime JSON feed' },
  { id: 'nyaa', label: 'Nyaa', hint: 'Anime/raw RSS' },
  { id: 'limetorrents', label: 'LimeTorrents', hint: 'Public RSS + magnets' },
  { id: 'jackett', label: 'Jackett', hint: 'Self-hosted (optional)' },
];

const empty: AppSettings = {
  tmdbApiKey: '',
  libraryRoot: '',
  defaultResolution: '1080p',
  refreshIntervalMinutes: 60,
  torrentSources: { ...defaultSources },
  jackettUrl: 'http://127.0.0.1:9117',
  jackettApiKey: '',
  autoDownload: true,
  autoDownloadDelayMinutes: 0,
  launchOnStartup: false,
  telegramEnabled: false,
  telegramBotToken: '',
  telegramAllowedChatIds: '',
  githubToken: '',
};

export default function SettingsView() {
  const [settings, setLocal] = useState<AppSettings>(empty);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tgStatus, setTgStatus] = useState<TelegramStatus | null>(null);
  const [tgTestMsg, setTgTestMsg] = useState<string | null>(null);
  const [tgTesting, setTgTesting] = useState(false);
  const [appVersion, setAppVersion] = useState('—');
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);

  const refreshTg = async () => {
    try {
      const s = (await window.torrentAPI.getTelegramStatus()) as TelegramStatus;
      setTgStatus(s);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    window.torrentAPI.getSettings().then((s) => {
      const loaded = { ...empty, ...(s as AppSettings) };
      loaded.torrentSources = {
        ...defaultSources,
        ...(loaded.torrentSources || {}),
      };
      setLocal(loaded);
    });
    window.torrentAPI.getAppVersion?.().then((v) => setAppVersion(String(v || '—'))).catch(() => undefined);
    window.torrentAPI.getUpdateStatus?.().then((s) => setUpdateStatus(s as UpdateStatus)).catch(() => undefined);
    refreshTg();
    const id = setInterval(() => void refreshTg(), 4000);
    const off = window.torrentAPI.onUpdateStatus?.((s) => setUpdateStatus(s as UpdateStatus));
    return () => {
      clearInterval(id);
      off?.();
    };
  }, []);

  const save = async () => {
    setError(null);
    setTgTestMsg(null);
    try {
      const next = (await window.torrentAPI.setSettings(settings)) as AppSettings;
      setLocal({ ...empty, ...next });
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      await refreshTg();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const pickRoot = async () => {
    const folder = await window.torrentAPI.pickLibraryFolder();
    if (folder) setLocal({ ...settings, libraryRoot: folder });
  };

  const setSource = (id: keyof TorrentSources, checked: boolean) => {
    setLocal({
      ...settings,
      torrentSources: {
        ...defaultSources,
        ...settings.torrentSources,
        [id]: checked,
      },
    });
  };

  const sendTest = async () => {
    setTgTesting(true);
    setTgTestMsg(null);
    try {
      await window.torrentAPI.setSettings(settings);
      const res = (await window.torrentAPI.sendTelegramTest()) as { ok: boolean; error?: string };
      setTgTestMsg(res.ok ? 'Test message sent.' : res.error || 'Test failed');
      await refreshTg();
    } catch (e) {
      setTgTestMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setTgTesting(false);
    }
  };

  const checkUpdates = async () => {
    setUpdateBusy(true);
    try {
      const s = (await window.torrentAPI.checkForUpdates()) as UpdateStatus;
      setUpdateStatus(s);
    } catch (e) {
      setUpdateStatus({
        checking: false,
        available: false,
        downloaded: false,
        version: null,
        message: e instanceof Error ? e.message : String(e),
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setUpdateBusy(false);
    }
  };

  const tgLabel = (() => {
    if (!settings.telegramEnabled) return 'Disabled';
    if (tgStatus?.polling) return 'Connected (polling)';
    if (tgStatus?.lastError) return `Error: ${tgStatus.lastError}`;
    if (!settings.telegramBotToken || !settings.telegramAllowedChatIds.trim()) {
      return 'Enabled — token / chat id incomplete';
    }
    return 'Enabled — starting…';
  })();

  const enabledCount = SOURCE_OPTIONS.filter((o) => !!settings.torrentSources?.[o.id]).length;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Library, auto-download, startup, Telegram, updates</p>
        </div>
        <div className="toolbar">
          {saved && <span style={{ color: 'var(--ok)' }}>Saved</span>}
          <button className="primary" onClick={save}>Save</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="form-grid form-grid-wide">
        <div className="settings-section">Library & quality</div>

        <div className="field">
          <label>Default library root</label>
          <div className="row">
            <input
              value={settings.libraryRoot}
              onChange={(e) => setLocal({ ...settings, libraryRoot: e.target.value })}
            />
            <button onClick={pickRoot}>Browse</button>
          </div>
          <div className="hint">
            Episodes save as {'{Show}/Season XX/{Show} - SxxExx - Title.ext'}. Existing Season 01 / S01 folders are reused.
          </div>
        </div>

        <div className="field">
          <label>Default resolution</label>
          <select
            value={settings.defaultResolution}
            onChange={(e) =>
              setLocal({ ...settings, defaultResolution: e.target.value as Resolution })
            }
          >
            <option value="720p">720p</option>
            <option value="1080p">1080p</option>
            <option value="2160p">2160p</option>
          </select>
        </div>

        <div className="settings-section">Episode checks & auto-download</div>

        <div className="field">
          <label>Episode check interval (minutes)</label>
          <input
            type="number"
            min={0}
            value={settings.refreshIntervalMinutes}
            onChange={(e) =>
              setLocal({
                ...settings,
                refreshIntervalMinutes: Math.max(0, parseInt(e.target.value || '0', 10)),
              })
            }
          />
          <div className="hint">Set 0 to disable automatic refresh. Manual “Check new episodes” always works.</div>
        </div>

        <div className="field">
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={!!settings.autoDownload}
              onChange={(e) => setLocal({ ...settings, autoDownload: e.target.checked })}
            />
            <span>Auto-download new / missing episodes</span>
          </label>
          <div className="hint">
            After each refresh (timer or manual), search preferred resolution and start in-app downloads.
            Skips ignored episodes and ones already downloading, queued, or done. Default: on.
          </div>
        </div>

        <div className="field">
          <label>Auto-download delay between episodes (minutes)</label>
          <input
            type="number"
            min={0}
            value={settings.autoDownloadDelayMinutes}
            onChange={(e) =>
              setLocal({
                ...settings,
                autoDownloadDelayMinutes: Math.max(0, parseInt(e.target.value || '0', 10)),
              })
            }
          />
          <div className="hint">Optional pause between starting each auto-download. 0 = minimal delay only.</div>
        </div>

        <div className="settings-section">Startup</div>

        <div className="field">
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={!!settings.launchOnStartup}
              onChange={(e) => setLocal({ ...settings, launchOnStartup: e.target.checked })}
            />
            <span>Launch on Windows startup</span>
          </label>
          <div className="hint">
            Uses Electron openAtLogin. You may also need to allow “Torrent” under Windows Settings → Apps → Startup.
          </div>
        </div>

        <div className="settings-section">Metadata & search</div>

        <div className="field">
          <label>Metadata</label>
          <input value="TVMaze (api.tvmaze.com) — free, no API key" disabled />
          <div className="hint">Show search and episode air dates come from TVMaze. IMDb ids are stored for EZTV. No signup required.</div>
        </div>

        <div className="field">
          <label>Torrent sources ({enabledCount} enabled)</label>
          <div className="hint" style={{ marginBottom: 10 }}>
            Enable any combination. Searches query <strong>all enabled</strong> sources in parallel, merge/dedupe by infohash, and rank by resolution + seeders. Partial failures keep other sources’ hits.
          </div>
          <div className="source-grid">
            {SOURCE_OPTIONS.map((opt) => (
              <label key={opt.id} className="source-card toggle-row">
                <input
                  type="checkbox"
                  checked={!!settings.torrentSources?.[opt.id]}
                  onChange={(e) => setSource(opt.id, e.target.checked)}
                />
                <span className="source-card-text">
                  <span className="source-card-title">{opt.label}</span>
                  <span className="source-card-hint">{opt.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="hint" style={{ marginTop: 10 }}>
            Defaults: all free public APIs on; Jackett off (needs your own server).
          </div>
        </div>

        {settings.torrentSources?.jackett && (
          <>
            <div className="field">
              <label>Jackett URL</label>
              <input
                value={settings.jackettUrl}
                onChange={(e) => setLocal({ ...settings, jackettUrl: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Jackett API key</label>
              <input
                type="password"
                value={settings.jackettApiKey}
                onChange={(e) => setLocal({ ...settings, jackettApiKey: e.target.value })}
              />
            </div>
          </>
        )}

        <div className="settings-section">Telegram</div>

        <div className="field">
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={!!settings.telegramEnabled}
              onChange={(e) => setLocal({ ...settings, telegramEnabled: e.target.checked })}
            />
            <span>Enable Telegram bot</span>
          </label>
          <div className="hint">Polls api.telegram.org from the main process (no paid API). Save to start/stop.</div>
        </div>

        <div className="field">
          <label>Bot token (from @BotFather)</label>
          <input
            type="password"
            autoComplete="off"
            value={settings.telegramBotToken}
            onChange={(e) => setLocal({ ...settings, telegramBotToken: e.target.value })}
            placeholder="123456:ABC-DEF..."
          />
          <div className="hint">Stored locally in electron-store. Never logged.</div>
        </div>

        <div className="field">
          <label>Allowed chat id(s)</label>
          <input
            value={settings.telegramAllowedChatIds}
            onChange={(e) => setLocal({ ...settings, telegramAllowedChatIds: e.target.value })}
            placeholder="e.g. 123456789"
          />
          <div className="hint">Comma-separated. Only these chats can run commands.</div>
        </div>

        <div className="field">
          <label>Bot status</label>
          <div className="status-line">{tgLabel}</div>
          {tgStatus?.lastOkAt && (
            <div className="hint">Last OK: {new Date(tgStatus.lastOkAt).toLocaleString()}</div>
          )}
          {tgStatus?.lastError && (
            <div className="hint" style={{ color: 'var(--danger)' }}>Last error: {tgStatus.lastError}</div>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={sendTest} disabled={tgTesting || !settings.telegramBotToken}>
              {tgTesting ? 'Sending…' : 'Send test message'}
            </button>
            {tgTestMsg && (
              <span style={{ color: tgTestMsg.includes('sent') ? 'var(--ok)' : 'var(--danger)' }}>
                {tgTestMsg}
              </span>
            )}
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            Commands: /status /shows /check /downloads /add &lt;query&gt; /help
          </div>
        </div>
      </div>

      <div className="settings-section" style={{ maxWidth: 760 }}>Updates</div>
      <div className="field" style={{ maxWidth: 760 }}>
        <label>App version</label>
        <div className="status-line">v{appVersion}</div>
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={checkUpdates} disabled={updateBusy}>
            {updateBusy || updateStatus?.checking ? 'Checking…' : 'Check for updates'}
          </button>
          {updateStatus?.downloaded && (
            <button className="primary" onClick={() => window.torrentAPI.installUpdate?.()}>
              Restart &amp; install
            </button>
          )}
        </div>
        {updateStatus?.message && (
          <div className="hint" style={{ color: updateStatus.error ? 'var(--danger)' : 'var(--text-dim)' }}>
            {updateStatus.message}
          </div>
        )}
        <div className="hint">
          Packaged builds check GitHub Releases for remie1529/TV-Show-Manager on startup.
          The repo is private, so a GitHub token is required for update checks to succeed.
        </div>
      </div>

      <div className="field" style={{ maxWidth: 760 }}>
        <label>GitHub personal access token</label>
        <input
          type="password"
          autoComplete="off"
          value={settings.githubToken || ''}
          onChange={(e) => setLocal({ ...settings, githubToken: e.target.value })}
          placeholder="ghp_… or github_pat_…"
        />
        <div className="hint">
          Needed because the update repo is private. Create a classic PAT with the{' '}
          <code>repo</code> scope at{' '}
          <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer">
            github.com/settings/tokens
          </a>
          , or a fine-grained token with Contents: Read on remie1529/TV-Show-Manager.
          Stored locally in electron-store. Never logged. Save, then Check for updates.
        </div>
      </div>

      <div
        style={{
          marginTop: '2rem',
          padding: '1rem 1.1rem',
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--bg-elevated)',
          maxWidth: 760,
        }}
      >
        <div style={{ fontWeight: 650, marginBottom: 6 }}>About Torrent</div>
        <div style={{ color: 'var(--text-dim)', fontSize: '0.9rem' }}>
          Desktop TV show manager with embedded downloads. Metadata via free TVMaze API.
          Prefer legal sources and content you have rights to download.
        </div>
      </div>
    </div>
  );
}
