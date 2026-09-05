import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'path';
import { autoUpdater } from 'electron-updater';
import {
  getSettings,
  getShows,
  removeShow,
  saveDownloads,
  setEpisodeOverride,
  setEpisodeOverridesBulk,
  setSettings,
  upsertShow,
} from './services/store';
import {
  applyLocalStatuses,
  fetchShowDetail,
  ignoreAiredEpisodes,
  searchShows,
} from './services/tvmaze';
import { searchEpisodeTorrents } from './services/search';
import { downloadEngine } from './services/engine';
import { telegramBot } from './services/telegram';
import {
  AddShowPolicy,
  AppSettings,
  Episode,
  EpisodeOverrideStatus,
  Resolution,
  Show,
  UpdateStatus,
} from './types';

let mainWindow: BrowserWindow | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let autoDownloadRunning = false;

const updateState: UpdateStatus = {
  checking: false,
  available: false,
  downloaded: false,
  version: null,
  message: null,
  error: null,
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#121212',
    title: 'Torrent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function pushDownloads() {
  const items = downloadEngine.list();
  saveDownloads(items);
  mainWindow?.webContents.send('downloads:update', items);
}

function notify(message: string, kind: 'info' | 'ok' | 'warn' | 'error' = 'info') {
  mainWindow?.webContents.send('app:toast', { message, kind });
}

function pushUpdateStatus() {
  mainWindow?.webContents.send('update:status', { ...updateState });
}

function downloadingKeys(): Set<string> {
  return downloadEngine.getDownloadingKeys();
}

function applyLoginItem(enabled: boolean) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled });
  } catch {
    // unsupported platforms / environments
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function withLocalStatuses(show: Show): Show {
  return applyLocalStatuses(show, getSettings().libraryRoot, downloadingKeys());
}

async function refreshOne(show: Show): Promise<Show> {
  const settings = getSettings();
  const detailed = await fetchShowDetail(
    show.tmdbId,
    settings.libraryRoot,
    show,
    downloadingKeys()
  );
  upsertShow(detailed);
  return detailed;
}

async function autoDownloadForShows(shows: Show[]): Promise<number> {
  const settings = getSettings();
  if (!settings.autoDownload) return 0;
  if (autoDownloadRunning) return 0;
  autoDownloadRunning = true;
  let started = 0;
  try {
    const delayMs = Math.max(0, (settings.autoDownloadDelayMinutes || 0) * 60 * 1000);
    for (const show of shows) {
      const preferred = (show.preferredResolution || settings.defaultResolution) as Resolution;
      const candidates: Episode[] = [];
      for (const season of show.seasons || []) {
        for (const ep of season.episodes || []) {
          // Never auto-download ignored episodes
          if (ep.status === 'ignored') continue;
          if (ep.status !== 'missing' && ep.status !== 'aired') continue;
          if (downloadEngine.hasEpisodeActivity(show.tmdbId, ep.seasonNumber, ep.episodeNumber)) {
            continue;
          }
          candidates.push(ep);
        }
      }
      for (const ep of candidates) {
        if (downloadEngine.hasEpisodeActivity(show.tmdbId, ep.seasonNumber, ep.episodeNumber)) {
          continue;
        }
        try {
          const { results, error } = await searchEpisodeTorrents(
            settings,
            show.name,
            ep.seasonNumber,
            ep.episodeNumber,
            preferred
          );
          if (error || !results.length) {
            continue;
          }
          const best = results[0];
          if (!best?.magnet) continue;
          await downloadEngine.start({
            magnet: best.magnet,
            show,
            libraryRoot: settings.libraryRoot,
            seasonNumber: ep.seasonNumber,
            episodeNumber: ep.episodeNumber,
            episodeTitle: ep.name,
          });
          started += 1;
          pushDownloads();
          notify(
            `Auto-download: ${show.name} S${pad2(ep.seasonNumber)}E${pad2(ep.episodeNumber)}`,
            'ok'
          );
          if (delayMs > 0) await sleep(delayMs);
          else await sleep(800);
        } catch {
          // skip failed episode; continue others
        }
      }
    }
  } finally {
    autoDownloadRunning = false;
  }
  if (started > 0) {
    notify(`Started ${started} auto-download${started === 1 ? '' : 's'}`, 'ok');
  }
  return started;
}

async function refreshAllShows(): Promise<Show[]> {
  const updated: Show[] = [];
  for (const show of getShows()) {
    try {
      updated.push(await refreshOne(show));
    } catch {
      updated.push(show);
    }
  }
  mainWindow?.webContents.send('library:changed');
  await autoDownloadForShows(updated);
  return updated;
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const minutes = getSettings().refreshIntervalMinutes;
  if (!minutes || minutes <= 0) return;
  refreshTimer = setInterval(() => {
    void refreshAllShows().catch(() => undefined);
  }, minutes * 60 * 1000);
}

function formatSpeed(bps: number): string {
  if (!bps || bps < 1024) return `${Math.round(bps || 0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

async function addShowWithPolicy(mazeId: number, policy: AddShowPolicy = 'manual'): Promise<Show> {
  const settings = getSettings();
  const existing = getShows().find((s) => s.tmdbId === mazeId);
  let show = await fetchShowDetail(mazeId, settings.libraryRoot, existing, downloadingKeys());
  upsertShow(show);

  if (policy === 'future') {
    const entries = ignoreAiredEpisodes(show);
    if (Object.keys(entries).length) {
      setEpisodeOverridesBulk(entries);
      show = withLocalStatuses(show);
      upsertShow(show);
    }
  }

  if (policy === 'all') {
    // Past aired stay missing/wanted — queue auto-download for this show
    void autoDownloadForShows([show]);
  }

  mainWindow?.webContents.send('library:changed');
  return withLocalStatuses(show);
}


const UPDATE_FEED = {
  provider: 'github' as const,
  owner: 'remie1529',
  repo: 'TV-Show-Manager',
};

/** Configure electron-updater for private GitHub when a PAT is set. Never log the token. */
function configureUpdaterFeed(): void {
  const token = (getSettings().githubToken || '').trim();
  if (!token) return;
  autoUpdater.setFeedURL({
    ...UPDATE_FEED,
    private: true,
    token,
  });
}

function formatUpdateError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const hasToken = !!(getSettings().githubToken || '').trim();
  if (
    !hasToken &&
    /\b(404|401)\b|Not Found|Unauthorized|Unable to find latest version|HttpError/i.test(msg)
  ) {
    return 'Private repo — add a GitHub token in Settings';
  }
  return msg;
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    updateState.checking = true;
    updateState.error = null;
    updateState.message = 'Checking for updates…';
    pushUpdateStatus();
  });

  autoUpdater.on('update-available', (info) => {
    updateState.checking = false;
    updateState.available = true;
    updateState.version = info.version || null;
    updateState.message = `Update ${info.version} available — downloading…`;
    pushUpdateStatus();
    notify(`Update ${info.version} available — downloading…`, 'info');
  });

  autoUpdater.on('update-not-available', (info) => {
    updateState.checking = false;
    updateState.available = false;
    updateState.version = info.version || app.getVersion();
    updateState.message = `Up to date (v${info.version || app.getVersion()})`;
    pushUpdateStatus();
  });

  autoUpdater.on('error', (err) => {
    updateState.checking = false;
    updateState.error = formatUpdateError(err);
    updateState.message = updateState.error;
    pushUpdateStatus();
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateState.checking = false;
    updateState.downloaded = true;
    updateState.version = info.version || null;
    updateState.message = `Update ${info.version} ready — restart to install`;
    pushUpdateStatus();
    notify(`Update ${info.version} ready — restart to install`, 'ok');
  });
}

async function checkForUpdates(manual: boolean): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    updateState.checking = false;
    updateState.message = 'Updates only apply to packaged builds';
    updateState.error = null;
    if (manual) pushUpdateStatus();
    return { ...updateState };
  }
  try {
    configureUpdaterFeed();
    updateState.checking = true;
    updateState.error = null;
    pushUpdateStatus();
    await autoUpdater.checkForUpdates();
  } catch (e) {
    updateState.checking = false;
    updateState.error = formatUpdateError(e);
    updateState.message = updateState.error;
    pushUpdateStatus();
  }
  return { ...updateState };
}

function wireTelegram() {
  telegramBot.setHandlers({
    async help(chatId, _args, reply) {
      await reply(
        chatId,
        [
          'Torrent TV Manager bot',
          '/status — library + active downloads',
          '/shows — tracked shows',
          '/check — refresh metadata (+ auto-download if enabled)',
          '/downloads — download progress',
          '/add <query> — search TVMaze and add best match',
          '/help — this list',
        ].join('\n')
      );
    },
    async status(chatId, _args, reply) {
      const shows = getShows();
      const settings = getSettings();
      const dl = downloadEngine.list();
      const active = dl.filter((d) =>
        d.status === 'downloading' || d.status === 'queued' || d.status === 'paused'
      );
      let missing = 0;
      for (const s of shows) {
        for (const season of s.seasons || []) {
          for (const ep of season.episodes || []) {
            if (ep.status === 'missing' || ep.status === 'aired') missing += 1;
          }
        }
      }
      await reply(
        chatId,
        [
          `Shows: ${shows.length}`,
          `Missing/aired episodes: ${missing}`,
          `Active downloads: ${active.length}`,
          `Auto-download: ${settings.autoDownload ? 'on' : 'off'}`,
          `Refresh every: ${settings.refreshIntervalMinutes} min`,
          `Library: ${settings.libraryRoot || '(not set)'}`,
        ].join('\n')
      );
    },
    async shows(chatId, _args, reply) {
      const shows = getShows();
      if (!shows.length) {
        await reply(chatId, 'No tracked shows.');
        return;
      }
      const lines = shows.map((s, i) => `${i + 1}. ${s.name} (${s.status || '—'})`);
      await reply(chatId, lines.join('\n'));
    },
    async check(chatId, _args, reply) {
      await reply(chatId, 'Refreshing library…');
      const updated = await refreshAllShows();
      await reply(chatId, `Refresh done (${updated.length} shows).`);
    },
    async downloads(chatId, _args, reply) {
      const items = downloadEngine.list();
      if (!items.length) {
        await reply(chatId, 'No downloads in queue.');
        return;
      }
      const lines = items.slice(0, 25).map((d) => {
        const pct = Math.round((d.progress || 0) * 100);
        return `${d.showName} S${pad2(d.seasonNumber)}E${pad2(d.episodeNumber)} — ${d.status} ${pct}% ${formatSpeed(d.downloadSpeed)}`;
      });
      await reply(chatId, lines.join('\n'));
    },
    async add(chatId, args, reply) {
      if (!args.trim()) {
        await reply(chatId, 'Usage: /add <show name>');
        return;
      }
      const results = await searchShows(args.trim());
      if (!results.length) {
        await reply(chatId, `No TVMaze results for “${args.trim()}”.`);
        return;
      }
      const best = results[0];
      const show = await addShowWithPolicy(best.id, 'manual');
      if (results.length === 1 || args.trim().toLowerCase() === best.name.toLowerCase()) {
        await reply(chatId, `Added: ${show.name}`);
        return;
      }
      const choices = results
        .slice(0, 8)
        .map((r, i) => `${i + 1}. ${r.name}${r.firstAirDate ? ` (${r.firstAirDate.slice(0, 4)})` : ''} — id ${r.id}`)
        .join('\n');
      await reply(
        chatId,
        `Added best match: ${show.name}\n\nOther matches:\n${choices}\n\nTip: /add with a more specific name if needed.`
      );
    },
  });
  telegramBot.sync(getSettings());
}

function registerIpc() {
  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:set', (_e, partial: Partial<AppSettings>) => {
    const next = setSettings(partial);
    scheduleRefresh();
    applyLoginItem(!!next.launchOnStartup);
    telegramBot.sync(next);
    // Re-apply private GitHub feed if token present (never log token)
    configureUpdaterFeed();
    return next;
  });

  ipcMain.handle('dialog:pickFolder', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('tmdb:search', async (_e, query: string) => searchShows(query));

  ipcMain.handle('library:list', () => {
    const settings = getSettings();
    return getShows().map((s) => applyLocalStatuses(s, settings.libraryRoot, downloadingKeys()));
  });

  ipcMain.handle('library:get', (_e, tmdbId: number) => {
    const settings = getSettings();
    const show = getShows().find((s) => s.tmdbId === tmdbId);
    if (!show) return null;
    return applyLocalStatuses(show, settings.libraryRoot, downloadingKeys());
  });

  ipcMain.handle('library:add', async (_e, mazeId: number, policy?: AddShowPolicy) => {
    return addShowWithPolicy(mazeId, policy || 'manual');
  });

  ipcMain.handle('library:remove', (_e, tmdbId: number) => removeShow(tmdbId));

  ipcMain.handle('library:update', (_e, tmdbId: number, partial: Partial<Show>) => {
    const shows = getShows();
    const idx = shows.findIndex((s) => s.tmdbId === tmdbId);
    if (idx < 0) throw new Error('Show not found');
    shows[idx] = { ...shows[idx], ...partial, tmdbId };
    upsertShow(shows[idx]);
    return shows[idx];
  });

  ipcMain.handle('library:refresh', async (_e, tmdbId: number) => {
    const show = getShows().find((s) => s.tmdbId === tmdbId);
    if (!show) throw new Error('Show not found');
    const updated = await refreshOne(show);
    await autoDownloadForShows([updated]);
    mainWindow?.webContents.send('library:changed');
    return updated;
  });

  ipcMain.handle('library:refreshAll', async () => refreshAllShows());

  ipcMain.handle(
    'library:setEpisodeStatus',
    (
      _e,
      tmdbId: number,
      season: number,
      episode: number,
      status: EpisodeOverrideStatus
    ) => {
      const show = getShows().find((s) => s.tmdbId === tmdbId);
      if (!show) throw new Error('Show not found');
      const allowed: EpisodeOverrideStatus[] = ['missing', 'downloaded', 'ignored', 'upcoming'];
      if (!allowed.includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      setEpisodeOverride(tmdbId, season, episode, status);
      const updated = withLocalStatuses(show);
      upsertShow(updated);
      mainWindow?.webContents.send('library:changed');
      return updated;
    }
  );

  ipcMain.handle('search:episode', async (_e, tmdbId: number, season: number, episode: number) => {
    const settings = getSettings();
    const show = getShows().find((s) => s.tmdbId === tmdbId);
    if (!show) throw new Error('Show not found');
    const preferred = (show.preferredResolution || settings.defaultResolution) as Resolution;
    return searchEpisodeTorrents(settings, show.name, season, episode, preferred);
  });

  ipcMain.handle(
    'download:start',
    async (
      _e,
      payload: {
        tmdbId: number;
        season: number;
        episode: number;
        episodeTitle: string;
        magnet: string;
      }
    ) => {
      const settings = getSettings();
      const show = getShows().find((s) => s.tmdbId === payload.tmdbId);
      if (!show) throw new Error('Show not found');
      const item = await downloadEngine.start({
        magnet: payload.magnet,
        show,
        libraryRoot: settings.libraryRoot,
        seasonNumber: payload.season,
        episodeNumber: payload.episode,
        episodeTitle: payload.episodeTitle,
      });
      pushDownloads();
      return item;
    }
  );

  ipcMain.handle('download:list', () => downloadEngine.list());
  ipcMain.handle('download:pause', (_e, id: string) => {
    downloadEngine.pause(id);
    pushDownloads();
  });
  ipcMain.handle('download:resume', (_e, id: string) => {
    downloadEngine.resume(id);
    pushDownloads();
  });
  ipcMain.handle('download:cancel', (_e, id: string) => {
    downloadEngine.cancel(id);
    pushDownloads();
  });

  ipcMain.handle('telegram:status', () => telegramBot.getStatus(getSettings()));
  ipcMain.handle('telegram:test', async () => telegramBot.sendTest(getSettings()));

  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('update:status', () => ({ ...updateState }));
  ipcMain.handle('update:check', async () => checkForUpdates(true));
  ipcMain.handle('update:install', () => {
    if (updateState.downloaded) {
      autoUpdater.quitAndInstall();
    }
  });
}

app.whenReady().then(() => {
  registerIpc();
  wireTelegram();
  setupAutoUpdater();
  downloadEngine.on('update', () => pushDownloads());
  downloadEngine.on('done', (item) => {
    pushDownloads();
    if (item?.name) {
      notify(`Finished: ${item.name}`, 'ok');
    }
    mainWindow?.webContents.send('library:changed');
  });
  createWindow();
  const settings = getSettings();
  applyLoginItem(!!settings.launchOnStartup);
  scheduleRefresh();

  // Non-blocking update check on startup (packaged builds only)
  setTimeout(() => {
    void checkForUpdates(false);
  }, 4000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    telegramBot.stop();
    downloadEngine.destroy();
    app.quit();
  }
});
