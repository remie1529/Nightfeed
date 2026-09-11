import { useEffect, useState } from 'react';
import type { AppSettings, Resolution, TelegramStatus, TorrentSources, UpdateStatus, VpnStatus, WebPortalStatus } from '../lib/types';
import FolderScanImport from '../components/FolderScanImport';
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

function LibraryRootsEditor({
  roots,
  onChange,
}: {
  roots: string[];
  onChange: (next: string[]) => void;
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const addFolder = async () => {
    const folder = await window.torrentAPI.pickLibraryFolder();
    if (!folder) return;
    if (roots.some((r) => r.toLowerCase() === folder.toLowerCase())) return;
    onChange([...roots, folder]);
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= roots.length) return;
    const next = [...roots];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  };

  return (
    <div>
      {roots.map((root, i) => (
        <div
          key={`${root}:${i}`}
          className="root-row"
          draggable
          onDragStart={() => setDragIdx(i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            if (dragIdx == null || dragIdx === i) return;
            move(dragIdx, i);
            setDragIdx(null);
          }}
        >
          <span className="root-handle" title="Drag to reorder">⋮⋮</span>
          {i === 0 ? <span className="root-badge">Default</span> : null}
          <input
            value={root}
            onChange={(e) => {
              const next = [...roots];
              next[i] = e.target.value;
              onChange(next);
            }}
          />
          <button type="button" onClick={() => onChange(roots.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" onClick={() => void addFolder()} style={{ marginTop: 8 }}>
        Add folder…
      </button>
    </div>
  );
}

const empty: AppSettings = {
  tmdbApiKey: '',
  libraryRoot: '',
  libraryRoots: [],
  movieLibraryRoot: '',
  movieLibraryRoots: [],
  defaultResolution: '1080p',
  defaultMovieResolution: '1080p',
  minimumResolution: '720p',
  minimumMovieResolution: '720p',
  minSizeMb720p: 200,
  minSizeMb1080p: 500,
  minSizeMb2160p: 2000,
  processFolder: '',
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
  telegramAdminChatIds: '',
  telegramRequestChatIds: '',
  telegramDailyBriefing: false,
  telegramDailyBriefingHour: 9,
  githubToken: '',
  maxConnections: 200,
  maxDownloadSpeedKBps: 0,
  maxUploadSpeedKBps: 0,
  ftpEnabled: false,
  ftpHost: '',
  ftpPort: 21,
  ftpUser: '',
  ftpPassword: '',
  ftpRemoteBasePath: '',
  vpnEnabled: false,
  vpnConfigPath: '',
  vpnConfigName: '',
  vpnUsername: '',
  vpnPassword: '',
  vpnRequireForTorrents: false,
  webPortalEnabled: false,
  webPortalPort: 8787,
  webPortalBind: 'localhost',
  webPortalAdminPasswordHash: '',
  webPortalSessionSecret: '',
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
  const [threadInfo, setThreadInfo] = useState<{
    searchWorkers?: number;
    searchUsingWorkers?: boolean;
    metadataWorker?: boolean;
    cpus?: number;
    torrentMode?: string;
    torrentDetail?: string;
  } | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [vpnStatus, setVpnStatus] = useState<VpnStatus | null>(null);
  const [vpnBusy, setVpnBusy] = useState(false);
  const [webPortalPassword, setWebPortalPassword] = useState('');
  const [portalStatus, setPortalStatus] = useState<WebPortalStatus | null>(null);

  const refreshTg = async () => {
    try {
      const s = (await window.torrentAPI.getTelegramStatus()) as TelegramStatus;
      setTgStatus(s);
    } catch {
      // ignore
    }
  };

  const refreshPortal = async () => {
    try {
      const s = (await window.torrentAPI.getWebPortalStatus?.()) as WebPortalStatus | undefined;
      if (s) setPortalStatus(s);
    } catch {
      // ignore
    }
  };

  const refreshVpn = async () => {
    try {
      const s = (await window.torrentAPI.getVpnStatus?.()) as VpnStatus;
      if (s) setVpnStatus(s);
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
      if (!(loaded.telegramAdminChatIds || '').trim() && (loaded.telegramAllowedChatIds || '').trim()) {
        loaded.telegramAdminChatIds = loaded.telegramAllowedChatIds;
      }
      if (!loaded.libraryRoots?.length && loaded.libraryRoot) loaded.libraryRoots = [loaded.libraryRoot];
      if (!loaded.movieLibraryRoots?.length && loaded.movieLibraryRoot) {
        loaded.movieLibraryRoots = [loaded.movieLibraryRoot];
      }
      setLocal(loaded);
    });
    window.torrentAPI.getAppVersion?.().then((v) => setAppVersion(String(v || '—'))).catch(() => undefined);
    window.torrentAPI.getThreadInfo?.().then((info) => setThreadInfo(info as typeof threadInfo)).catch(() => undefined);
    window.torrentAPI.getUpdateStatus?.().then((s) => setUpdateStatus(s as UpdateStatus)).catch(() => undefined);
    refreshTg();
    void refreshVpn();
    void refreshPortal();
    const id = setInterval(() => {
      void refreshTg();
      void refreshVpn();
      void refreshPortal();
    }, 4000);
    const off = window.torrentAPI.onUpdateStatus?.((s) => setUpdateStatus(s as UpdateStatus));
    const offVpn = window.torrentAPI.onVpnStatus?.((s) => setVpnStatus(s as VpnStatus));
    return () => {
      clearInterval(id);
      off?.();
      offVpn?.();
    };
  }, []);

  const save = async () => {
    setError(null);
    setTgTestMsg(null);
    try {
      const payload: Record<string, unknown> = { ...settings };
      if (webPortalPassword.trim()) {
        payload.webPortalAdminPassword = webPortalPassword.trim();
      }
      // Never send session secret edits from UI; main owns it.
      delete payload.webPortalSessionSecret;
      const next = (await window.torrentAPI.setSettings(payload)) as AppSettings;
      setLocal({ ...empty, ...next });
      setWebPortalPassword('');
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      await refreshTg();
      await refreshPortal();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const exportBackup = async () => {
    setBackupBusy(true);
    setBackupMsg(null);
    setError(null);
    try {
      const res = (await window.torrentAPI.exportBackup()) as {
        ok?: boolean;
        canceled?: boolean;
        path?: string;
      };
      if (res?.canceled) {
        setBackupMsg(null);
        return;
      }
      if (res?.ok) setBackupMsg(`Backup exported to ${res.path}`);
      else setBackupMsg('Export failed');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBackupBusy(false);
    }
  };

  const importBackup = async () => {
    const ok = window.confirm(
      'Replace ALL Nightfeed data with this backup?\n\n' +
        'This overwrites settings, TV shows, movies, episode overrides, and download queue state.\n' +
        'The backup file may contain secrets (GitHub token, Telegram token, FTP password).\n\n' +
        'This cannot be undone unless you export a backup first.'
    );
    if (!ok) return;
    setBackupBusy(true);
    setBackupMsg(null);
    setError(null);
    try {
      const res = (await window.torrentAPI.importBackup()) as {
        ok?: boolean;
        canceled?: boolean;
        shows?: number;
        movies?: number;
        path?: string;
      };
      if (res?.canceled) return;
      if (res?.ok) {
        setBackupMsg(
          `Backup imported (${res.shows ?? 0} shows, ${res.movies ?? 0} movies). Reloading settings…`
        );
        const s = (await window.torrentAPI.getSettings()) as AppSettings;
        setLocal({ ...empty, ...s, torrentSources: { ...defaultSources, ...(s.torrentSources || {}) } });
        await refreshTg();
      } else {
        setBackupMsg('Import failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBackupBusy(false);
    }
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
        progress: null,
        version: null,
        message: e instanceof Error ? e.message : String(e),
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setUpdateBusy(false);
    }
  };

  const importVpn = async () => {
    setVpnBusy(true);
    setError(null);
    try {
      const res = (await window.torrentAPI.importVpnConfig?.()) as {
        ok?: boolean;
        canceled?: boolean;
        configName?: string;
        settings?: AppSettings;
      };
      if (res?.canceled) return;
      if (res?.settings) {
        setLocal({
          ...empty,
          ...res.settings,
          torrentSources: { ...defaultSources, ...(res.settings.torrentSources || {}) },
        });
      }
      await refreshVpn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setVpnBusy(false);
    }
  };

  const connectVpn = async () => {
    setVpnBusy(true);
    setError(null);
    try {
      // Persist username/password/toggles before connect (password never logged)
      await window.torrentAPI.setSettings(settings);
      const s = (await window.torrentAPI.connectVpn?.()) as VpnStatus;
      if (s) setVpnStatus(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await refreshVpn();
    } finally {
      setVpnBusy(false);
    }
  };

  const disconnectVpn = async () => {
    setVpnBusy(true);
    try {
      const s = (await window.torrentAPI.disconnectVpn?.()) as VpnStatus;
      if (s) setVpnStatus(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setVpnBusy(false);
    }
  };

  const tgLabel = (() => {
    if (!settings.telegramEnabled) return 'Disabled';
    if (tgStatus?.polling) return 'Connected (polling)';
    if (tgStatus?.lastError) return `Error: ${tgStatus.lastError}`;
    const admin = (settings.telegramAdminChatIds || settings.telegramAllowedChatIds || '').trim();
    const reqs = (settings.telegramRequestChatIds || '').trim();
    if (!settings.telegramBotToken || (!admin && !reqs)) {
      return 'Enabled — token / chat ids incomplete';
    }
    return 'Enabled — starting…';
  })();

  const enabledCount = SOURCE_OPTIONS.filter((o) => !!settings.torrentSources?.[o.id]).length;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>TV & movie libraries, downloads, VPN, auto-download, startup, Telegram, web portal, updates</p>
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
          <label>TV library roots</label>
          <LibraryRootsEditor
            roots={settings.libraryRoots?.length ? settings.libraryRoots : settings.libraryRoot ? [settings.libraryRoot] : []}
            onChange={(libraryRoots) =>
              setLocal({ ...settings, libraryRoots, libraryRoot: libraryRoots[0] || '' })
            }
          />
          <div className="hint">
            Drag to reorder. The <strong>top</strong> folder is used for new shows. If a season folder already
            exists in any listed library, that location is reused.
            Episodes save as {'{Show}/Season XX/{Show} - SxxExx - Title.ext'}.
          </div>
        </div>

        <div className="field">
          <label>Movie library roots</label>
          <LibraryRootsEditor
            roots={
              settings.movieLibraryRoots?.length
                ? settings.movieLibraryRoots
                : settings.movieLibraryRoot
                  ? [settings.movieLibraryRoot]
                  : []
            }
            onChange={(movieLibraryRoots) =>
              setLocal({ ...settings, movieLibraryRoots, movieLibraryRoot: movieLibraryRoots[0] || '' })
            }
          />
          <div className="hint">
            Drag to reorder. The <strong>top</strong> folder is used for new movies. If {'{Title} ({Year})'} already
            exists in any listed library, that folder is reused.
          </div>
        </div>

        <div className="field">
          <label>Mass import from folders</label>
          <div className="row" style={{ gap: '0.6rem', flexWrap: 'wrap' }}>
            <FolderScanImport defaultScope="both" />
          </div>
          <div className="hint">
            Manual only — never runs on startup. Scans TV/movie library roots, previews matches (TVMaze / IMDb),
            then imports on confirm. Existing files are marked downloaded when paths match; nothing is moved or deleted.
          </div>
        </div>

        <div className="field">
          <label>Process folder (optional)</label>
          <div className="row">
            <input
              value={settings.processFolder || ''}
              onChange={(e) => setLocal({ ...settings, processFolder: e.target.value })}
              placeholder="Download here first, then verify and move"
            />
            <button
              type="button"
              onClick={async () => {
                const folder = await window.torrentAPI.pickLibraryFolder();
                if (folder) setLocal({ ...settings, processFolder: folder });
              }}
            >
              Browse
            </button>
          </div>
          <div className="hint">
            If set, Nightfeed downloads into this folder, checks the real video resolution and minimum
            size, renames the file, then moves it into the library. Leave empty to download straight into
            the library (checks still run). Needs <code>ffprobe</code> on PATH for a true resolution read;
            otherwise the filename is used.
          </div>
        </div>

        <div className="field">
          <label>Preferred TV resolution</label>
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

        <div className="field">
          <label>Minimum TV resolution</label>
          <select
            value={settings.minimumResolution || '720p'}
            onChange={(e) =>
              setLocal({ ...settings, minimumResolution: e.target.value as Resolution })
            }
          >
            <option value="720p">720p</option>
            <option value="1080p">1080p</option>
            <option value="2160p">2160p</option>
          </select>
          <div className="hint">Never auto-pick or keep a TV file below this. Preferred is tried first.</div>
        </div>

        <div className="field">
          <label>Preferred movie resolution</label>
          <select
            value={settings.defaultMovieResolution || settings.defaultResolution || '1080p'}
            onChange={(e) =>
              setLocal({ ...settings, defaultMovieResolution: e.target.value as Resolution })
            }
          >
            <option value="720p">720p</option>
            <option value="1080p">1080p</option>
            <option value="2160p">2160p</option>
          </select>
        </div>

        <div className="field">
          <label>Minimum movie resolution</label>
          <select
            value={settings.minimumMovieResolution || '720p'}
            onChange={(e) =>
              setLocal({ ...settings, minimumMovieResolution: e.target.value as Resolution })
            }
          >
            <option value="720p">720p</option>
            <option value="1080p">1080p</option>
            <option value="2160p">2160p</option>
          </select>
        </div>

        <div className="field">
          <label>Minimum file size (MB)</label>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            {(['720p', '1080p', '2160p'] as const).map((key) => {
              const field =
                key === '720p' ? 'minSizeMb720p' : key === '1080p' ? 'minSizeMb1080p' : 'minSizeMb2160p';
              return (
                <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="hint" style={{ margin: 0 }}>{key}</span>
                  <input
                    type="number"
                    min={0}
                    style={{ width: 90 }}
                    value={settings[field] ?? 0}
                    onChange={(e) =>
                      setLocal({ ...settings, [field]: Math.max(0, parseInt(e.target.value || '0', 10)) })
                    }
                  />
                </label>
              );
            })}
          </div>
          <div className="hint">0 = no extra size floor. Applied to search picks and after download.</div>
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
            After each refresh (timer or manual), search the preferred resolution and start in-app downloads.
            Skips ignored episodes, ones already queued, and torrents with fewer than 8 seeders or the wrong
            resolution. Default: on.
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

        <div className="settings-section">Downloads (WebTorrent)</div>

        <div className="field">
          <label>Max peer connections</label>
          <input
            type="number"
            min={10}
            max={500}
            value={settings.maxConnections ?? 200}
            onChange={(e) =>
              setLocal({
                ...settings,
                maxConnections: Math.max(10, parseInt(e.target.value || '200', 10) || 200),
              })
            }
          />
          <div className="hint">
            Higher values can improve throughput when many peers are available. Default 200.
            WebTorrent peer I/O uses many connections; piece hashing and peer churn run in an
            Electron <code>utilityProcess</code> when available (separate from the UI process).
            Torrent search merge/dedupe/ranking runs on a <code>worker_threads</code> pool
            (up to 4 workers / CPU cores). Progress IPC is throttled (~1s); download store writes are debounced so Library search stays responsive.
          </div>
        </div>

        <div className="field">
          <label>Max download speed (KiB/s)</label>
          <input
            type="number"
            min={0}
            value={settings.maxDownloadSpeedKBps ?? 0}
            onChange={(e) =>
              setLocal({
                ...settings,
                maxDownloadSpeedKBps: Math.max(0, parseInt(e.target.value || '0', 10) || 0),
              })
            }
          />
          <div className="hint">0 = unlimited. Applied via WebTorrent client.throttleDownload (bytes/s).</div>
        </div>

        <div className="field">
          <label>Max upload speed (KiB/s)</label>
          <input
            type="number"
            min={0}
            value={settings.maxUploadSpeedKBps ?? 0}
            onChange={(e) =>
              setLocal({
                ...settings,
                maxUploadSpeedKBps: Math.max(0, parseInt(e.target.value || '0', 10) || 0),
              })
            }
          />
          <div className="hint">0 = unlimited. Applied via WebTorrent client.throttleUpload (bytes/s).</div>
        </div>

        <div className="settings-section">FTP upload (optional)</div>

        <div className="field">
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={!!settings.ftpEnabled}
              onChange={(e) => setLocal({ ...settings, ftpEnabled: e.target.checked })}
            />
            <span>Upload finished files to FTP</span>
          </label>
          <div className="hint">
            After a valid video is renamed into the library, upload a copy to your FTP server.
            Local success is kept even if FTP fails. Password is stored locally and never logged.
          </div>
        </div>

        {settings.ftpEnabled && (
          <>
            <div className="field">
              <label>FTP host</label>
              <input
                value={settings.ftpHost || ''}
                onChange={(e) => setLocal({ ...settings, ftpHost: e.target.value })}
                placeholder="ftp.example.com"
              />
            </div>
            <div className="field">
              <label>FTP port</label>
              <input
                type="number"
                min={1}
                max={65535}
                value={settings.ftpPort ?? 21}
                onChange={(e) =>
                  setLocal({
                    ...settings,
                    ftpPort: Math.max(1, parseInt(e.target.value || '21', 10) || 21),
                  })
                }
              />
            </div>
            <div className="field">
              <label>FTP username</label>
              <input
                value={settings.ftpUser || ''}
                onChange={(e) => setLocal({ ...settings, ftpUser: e.target.value })}
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label>FTP password</label>
              <input
                type="password"
                autoComplete="off"
                value={settings.ftpPassword || ''}
                onChange={(e) => setLocal({ ...settings, ftpPassword: e.target.value })}
              />
              <div className="hint">Never logged. Stored in local electron-store only.</div>
            </div>
            <div className="field">
              <label>Remote base path</label>
              <input
                value={settings.ftpRemoteBasePath || ''}
                onChange={(e) => setLocal({ ...settings, ftpRemoteBasePath: e.target.value })}
                placeholder="/media/TV or /media/Movies"
              />
              <div className="hint">
                One base directory for finished files (TV and/or movies). File is uploaded as{' '}
                {'{base}/{filename}'}.
              </div>
            </div>
          </>
        )}

        <div className="settings-section">VPN (OpenVPN)</div>

        <div className="field">
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={!!settings.vpnEnabled}
              onChange={(e) => setLocal({ ...settings, vpnEnabled: e.target.checked })}
            />
            <span>Enable OpenVPN</span>
          </label>
          <div className="hint">
            <strong>Split tunnel:</strong> only torrent sockets bind to the VPN. Plex, port-forwarding, the
            browser, and whatismyipaddress.com should keep your normal ISP IP. <code>redirect-gateway</code> is
            ignored so the VPN does not become the PC default route. The first Connect after this update may
            show a one-time Administrator prompt so Windows will send those torrent sockets out the VPN
            (otherwise they cannot reach seeders). Nightfeed runs its own <code>openvpn.exe</code> (the OpenVPN
            GUI will not show this session). Install{' '}
            <a href="https://openvpn.net/community-downloads/" target="_blank" rel="noreferrer">OpenVPN Community</a>{' '}
            on this PC. Auto-connects on app start when an .ovpn is imported. After updating Nightfeed,
            Disconnect then Connect once so the new flags apply.
          </div>
        </div>

        {settings.vpnEnabled && (
          <>
            <div className="field">
              <label>.ovpn configuration</label>
              <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                <input
                  value={settings.vpnConfigName || settings.vpnConfigPath || ''}
                  readOnly
                  placeholder="No config imported"
                />
                <button type="button" onClick={() => void importVpn()} disabled={vpnBusy}>
                  {vpnBusy ? 'Working…' : 'Import .ovpn…'}
                </button>
              </div>
              <div className="hint">
                The .ovpn is copied into app userData together with relative <code>ca</code>/<code>cert</code>/
                <code>key</code> files from the same folder. Original path is not required after import.
              </div>
            </div>

            <div className="field">
              <label>VPN username (optional)</label>
              <input
                value={settings.vpnUsername || ''}
                onChange={(e) => setLocal({ ...settings, vpnUsername: e.target.value })}
                autoComplete="off"
              />
            </div>

            <div className="field">
              <label>VPN password (optional)</label>
              <input
                type="password"
                autoComplete="off"
                value={settings.vpnPassword || ''}
                onChange={(e) => setLocal({ ...settings, vpnPassword: e.target.value })}
              />
              <div className="hint">Never logged. Written to a restricted auth-user-pass file only while connecting.</div>
            </div>

            <div className="field">
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={!!settings.vpnRequireForTorrents}
                  onChange={(e) => setLocal({ ...settings, vpnRequireForTorrents: e.target.checked })}
                />
                <span>Require VPN for torrent downloads</span>
              </label>
              <div className="hint">
                Kill switch: torrents cannot start or resume until OpenVPN is connected. If the VPN drops,
                active downloads pause immediately, admins get a Telegram alert, and a persistent notice
                stays in the bottom-right until the VPN is back.
              </div>
            </div>

            <div className="field">
              <label>VPN status</label>
              <div className="status-line">
                {vpnStatus
                  ? `${vpnStatus.state}${vpnStatus.message ? ` — ${vpnStatus.message}` : ''}`
                  : '—'}
              </div>
              {vpnStatus && (
                <div className="hint" style={{ marginTop: 6 }}>
                  OpenVPN: {vpnStatus.openvpnFound ? (vpnStatus.openvpnPath || 'found') : 'not found — install Community edition on this PC'}
                  {vpnStatus.bindAddress ? ` · torrent bind ${vpnStatus.bindAddress}` : ''}
                  {vpnStatus.routeNopull ? ' · split-tunnel' : ''}
                  {vpnStatus.launchMethod ? ` · ${vpnStatus.launchMethod}` : ''}
                </div>
              )}
              {vpnStatus?.lastError && (vpnStatus.state === 'error' || vpnStatus.state === 'disconnected') && (
                <div className="hint" style={{ marginTop: 6, color: 'var(--danger)' }}>
                  {vpnStatus.lastError}
                </div>
              )}
              {!vpnStatus?.bindAddress && vpnStatus?.state === 'connected' && (
                <div className="hint" style={{ color: 'var(--danger)' }}>
                  Connected but TUN/TAP IP not detected yet — torrent bind pending. Peer TCP binds when the
                  interface IP appears; until then traffic may use the default interface.
                </div>
              )}
              <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void connectVpn()}
                  disabled={vpnBusy || !settings.vpnConfigPath}
                >
                  {vpnBusy ? 'Working…' : 'Connect'}
                </button>
                <button type="button" onClick={() => void disconnectVpn()} disabled={vpnBusy}>
                  Disconnect
                </button>
                <button
                  type="button"
                  onClick={() => void window.torrentAPI.detectOpenVpn?.().then((s) => setVpnStatus(s as VpnStatus))}
                  disabled={vpnBusy}
                >
                  Re-detect OpenVPN
                </button>
              </div>
              <div className="hint" style={{ marginTop: 8 }}>
                Limitation: WebTorrent peer TCP connections use <code>localAddress</code> bind to the VPN IP.
                DHT/uTP are disabled while bound. Tracker announces and metadata (TVMaze/IMDb) stay on the normal
                network. Changing VPN bind mid-download may require restarting that download.
              </div>
            </div>
          </>
        )}

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
            Uses Electron openAtLogin. You may also need to allow “Nightfeed” under Windows Settings → Apps → Startup.
          </div>
        </div>

        <div className="settings-section">Metadata & search</div>

        <div className="field">
          <label>TV metadata</label>
          <input value="TVMaze (api.tvmaze.com) — free, no API key" disabled />
          <div className="hint">Show search and episode air dates come from TVMaze. IMDb ids are stored for EZTV. No signup required.</div>
        </div>

        <div className="field">
          <label>Movie metadata</label>
          <input value="IMDb.com (scraped) — free, no API key" disabled />
          <div className="hint">Movie search and title details (poster, year, runtime, plot, IMDb id) are scraped from IMDb. No signup or API key. TV stays on TVMaze.</div>
        </div>

        <div className="field">
          <label>Torrent sources ({enabledCount} enabled)</label>
          <div className="hint" style={{ marginBottom: 10 }}>
            Enable any combination. Searches query <strong>all enabled</strong> sources in parallel, merge/dedupe by
            infohash, and rank by <strong>preferred resolution first</strong>, then seeders. Auto-download will not
            start a torrent with under 8 seeders or a different resolution. Partial failures keep other sources’ hits.
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
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={!!settings.telegramDailyBriefing}
              onChange={(e) => setLocal({ ...settings, telegramDailyBriefing: e.target.checked })}
            />
            <span>Daily download briefing</span>
          </label>
          <div className="row" style={{ marginTop: 8, gap: 8, alignItems: 'center' }}>
            <span className="hint" style={{ margin: 0 }}>Send at</span>
            <input
              type="number"
              min={0}
              max={23}
              style={{ width: 72 }}
              value={settings.telegramDailyBriefingHour ?? 9}
              onChange={(e) =>
                setLocal({
                  ...settings,
                  telegramDailyBriefingHour: Math.min(23, Math.max(0, parseInt(e.target.value || '9', 10))),
                })
              }
            />
            <span className="hint" style={{ margin: 0 }}>:00 local time, to admin chats</span>
          </div>
          <div className="hint">
            Lists what finished in the last 24 hours. If nothing completed, no message is sent.
          </div>
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
          <label>Admin chat ID(s)</label>
          <input
            value={settings.telegramAdminChatIds || settings.telegramAllowedChatIds || ''}
            onChange={(e) =>
              setLocal({
                ...settings,
                telegramAdminChatIds: e.target.value,
                telegramAllowedChatIds: e.target.value,
              })
            }
            placeholder="e.g. 123456789"
          />
          <div className="hint">
            Comma-separated. Admins get approval notifications and full bot commands
            (/status /shows /movies /check /downloads /add /approve /deny /help).
            Paste the exact ID the bot replies with. Click <strong>Save</strong> after editing.
          </div>
        </div>

        <div className="field">
          <label>Requests chat ID(s)</label>
          <input
            value={settings.telegramRequestChatIds || ''}
            onChange={(e) => setLocal({ ...settings, telegramRequestChatIds: e.target.value })}
            placeholder="e.g. 987654321"
          />
          <div className="hint">
            Comma-separated. These users can only submit movie/TV requests
            (/request-show /request-movie &lt;name&gt;). Paste the exact ID from the bot reply.
            You must click <strong>Save</strong> or the lists will not load.
          </div>
        </div>

        <div className="field">
          <label>Bot status</label>
          <div className="status-line">{tgLabel}</div>
          <div className="hint">
            Loaded IDs — Admin: {tgStatus?.adminChatIdCount ?? 0}, Requests:{' '}
            {tgStatus?.requestChatIdCount ?? 0}
            {' '}(after Save). If counts stay 0, the lists did not stick.
          </div>
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
            Message the bot (DM or group) to see Your chat ID: … then paste that exact ID under
            Admin or Requests and click <strong>Save</strong>. Private chat IDs are usually positive;
            group/supergroup IDs are negative (start with -).
          </div>
        </div>

        <div className="settings-section">Web portal</div>

        <div className="field">
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={!!settings.webPortalEnabled}
              onChange={(e) => setLocal({ ...settings, webPortalEnabled: e.target.checked })}
            />
            <span>Enable local web portal</span>
          </label>
          <div className="hint">
            Runs a small HTTP server from the app (no login on Request page). Save to start/stop.
          </div>
        </div>

        <div className="field">
          <label>Port</label>
          <input
            type="number"
            min={1}
            max={65535}
            value={settings.webPortalPort ?? 8787}
            onChange={(e) =>
              setLocal({ ...settings, webPortalPort: Number(e.target.value) || 8787 })
            }
          />
        </div>

        <div className="field">
          <label>Bind address</label>
          <select
            value={settings.webPortalBind === 'lan' ? 'lan' : 'localhost'}
            onChange={(e) =>
              setLocal({
                ...settings,
                webPortalBind: e.target.value === 'lan' ? 'lan' : 'localhost',
              })
            }
          >
            <option value="localhost">Localhost only (127.0.0.1)</option>
            <option value="lan">LAN (0.0.0.0)</option>
          </select>
          <div className="hint">
            Localhost is safer. LAN lets other devices on your network open the Request page.
          </div>
        </div>

        <div className="field">
          <label>Admin password</label>
          <input
            type="password"
            autoComplete="new-password"
            value={webPortalPassword}
            onChange={(e) => setWebPortalPassword(e.target.value)}
            placeholder={
              settings.webPortalAdminPasswordHash || portalStatus?.passwordSet
                ? '•••••••• (leave blank to keep)'
                : 'Set a password'
            }
          />
          <div className="hint">
            Stored as a hash only — plaintext is never logged. Required for /admin.
          </div>
        </div>

        <div className="field">
          <label>Portal URL</label>
          <div className="status-line">
            {portalStatus?.listening
              ? (portalStatus.urls || []).join(' · ') || `http://127.0.0.1:${settings.webPortalPort || 8787}/`
              : settings.webPortalEnabled
                ? portalStatus?.lastError
                  ? `Not listening — ${portalStatus.lastError}`
                  : 'Enabled — Save / wait for listen…'
                : 'Disabled'}
          </div>
          <div className="hint">
            Public request page: <code>/</code> or <code>/request</code>. Admin: <code>/admin</code> (password).
            {settings.webPortalBind === 'lan' ? ' On LAN, use this PC’s IP in the URL.' : ''}
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
          {updateStatus?.available && !updateStatus?.downloaded && (
            <button
              type="button"
              onClick={() => void window.torrentAPI.downloadUpdate?.()}
              disabled={updateBusy}
            >
              {typeof updateStatus.progress === 'number'
                ? `Downloading ${updateStatus.progress}%`
                : 'Download update'}
            </button>
          )}
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
          Packaged builds check GitHub Releases for remie1529/Nightfeed on startup and every 6 hours.
          A banner appears when an update is ready. The repo is private, so a GitHub token is required.
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
          , or a fine-grained token with Contents: Read on remie1529/Nightfeed.
          Stored locally in electron-store. Never logged. Save, then Check for updates.
        </div>
      </div>

      <div className="settings-section">Backup</div>

      <div className="field" style={{ maxWidth: 760 }}>
        <label>Export / import library &amp; settings</label>
        <div className="toolbar" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => void exportBackup()} disabled={backupBusy}>
            {backupBusy ? 'Working…' : 'Export backup…'}
          </button>
          <button type="button" className="secondary" onClick={() => void importBackup()} disabled={backupBusy}>
            Import backup…
          </button>
        </div>
        <div className="hint">
          Exports a JSON file with settings, TV shows, movies, episode overrides, and download queue.
          The file includes secrets (GitHub PAT, Telegram bot token, FTP password) so you can restore
          everything — store it privately. Import replaces current data after confirmation.
        </div>
        {backupMsg && <div className="hint" style={{ color: 'var(--ok, #6c6)' }}>{backupMsg}</div>}
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
        <div style={{ fontWeight: 650, marginBottom: 6 }}>About Nightfeed</div>
        <div style={{ color: 'var(--text-dim)', fontSize: '0.9rem' }}>
          Desktop TV & movie manager with embedded downloads. TV via free TVMaze; movies via IMDb.com scrape (no API key).
          Torrent search and library zoekfunctie (TVMaze / IMDb) run on <code>worker_threads</code>.
          WebTorrent prefers an Electron <code>utilityProcess</code>. Progress IPC is throttled; download
          persistence is debounced so search stays responsive during active downloads.
          {' '}
          {threadInfo && (
            <div style={{ marginTop: 8 }}>
              Runtime: torrent search workers{' '}
              {threadInfo.searchUsingWorkers
                ? `on (${threadInfo.searchWorkers}/${threadInfo.cpus} CPUs)`
                : 'fallback in-process'}
              ; metadata search {threadInfo.metadataWorker ? 'worker on' : 'in-process'}; torrent engine{' '}
              {threadInfo.torrentMode || '—'}.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
