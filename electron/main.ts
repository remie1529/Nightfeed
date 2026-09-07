import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { autoUpdater } from 'electron-updater';
import {
  episodeKey,
  exportBackupData,
  getMovies,
  getSettings,
  getShows,
  getTelegramRequest,
  getTelegramRequests,
  importBackupData,
  removeMovie,
  removeShow,
  saveDownloads,
  setEpisodeOverride,
  setEpisodeOverridesBulk,
  setSettings,
  upsertMovie,
  upsertShow,
  upsertTelegramRequest,
} from './services/store';
import {
  applyLocalStatuses,
  fetchShowDetail,
  ignoreAiredEpisodes,
} from './services/tvmaze';
import { extractInfoHash } from './services/search';
import { searchEpisodeTorrents, searchMovieTorrents, destroySearchPool, getSearchPoolInfo } from './services/search-pool';
import { searchShowsMeta, searchMoviesMeta, destroyMetadataPool, getMetadataPoolInfo } from './services/metadata-pool';
import {
  applyMovieLocalStatus,
  fetchMovieDetail,
} from './services/imdb';
import { downloadEngine, ensureTorrentEngine, getTorrentEngineInfo } from './services/engine-bridge';
import { approveDenyKeyboard, telegramBot } from './services/telegram';
import { uploadFinishedFile } from './services/ftp';
import { vpnManager } from './services/vpn';
import {
  buildScanPreview,
  type FolderScanImportItem,
  type FolderScanImportResult,
  type LibraryScanScope,
} from './services/library-scan';
import {
  AddShowPolicy,
  AppSettings,
  DownloadItem,
  Episode,
  EpisodeOverrideStatus,
  Movie,
  Resolution,
  Show,
  ShowListItem,
  TelegramRequest,
  TorrentCandidate,
  UpdateStatus,
  VpnStatus,
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

function resolveAppIcon(): string | undefined {
  const candidates = [
    path.join(__dirname, '../build/icon.png'),
    path.join(process.resourcesPath || '', 'icon.png'),
    path.join(__dirname, '../build/icon.ico'),
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      // ignore
    }
  }
  return undefined;
}

function createWindow() {
  const iconPath = resolveAppIcon();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#121212',
    title: 'Nightfeed',
    autoHideMenuBar: true,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  if (iconPath) {
    try {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) mainWindow.setIcon(img);
    } catch {
      // ignore
    }
  }
  try {
    mainWindow.setMenuBarVisibility(false);
  } catch {
    // ignore
  }

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

/** Strip heavy fields from progress IPC so the renderer stays light. */
function slimDownloadsForUi(items: DownloadItem[]): DownloadItem[] {
  return items.map((item) => {
    if (!item.candidates?.length && !item.triedInfoHashes?.length) return item;
    const { candidates: _c, triedInfoHashes: _t, ...rest } = item;
    return rest;
  });
}

/** Persist downloads without candidates (retry uses in-memory / reject-exe events). */
function slimDownloadsForStore(items: DownloadItem[]): DownloadItem[] {
  return items.map((item) => {
    if (!item.candidates?.length) return item;
    const { candidates: _c, ...rest } = item;
    return rest;
  });
}

let persistDownloadsTimer: NodeJS.Timeout | null = null;
let pendingPersistItems: DownloadItem[] | null = null;

function persistDownloadsDebounced(items: DownloadItem[], force = false): void {
  pendingPersistItems = items;
  const flush = () => {
    persistDownloadsTimer = null;
    const snapshot = pendingPersistItems;
    pendingPersistItems = null;
    if (!snapshot) return;
    // Never block the IPC/progress turn with sync electron-store I/O.
    setImmediate(() => {
      try {
        saveDownloads(slimDownloadsForStore(snapshot));
      } catch (err) {
        console.error('[downloads] persist failed', err);
      }
    });
  };
  if (force) {
    if (persistDownloadsTimer) {
      clearTimeout(persistDownloadsTimer);
      persistDownloadsTimer = null;
    }
    flush();
    return;
  }
  if (!persistDownloadsTimer) {
    persistDownloadsTimer = setTimeout(flush, 5000);
  }
}

function pushDownloads(opts?: { persist?: 'debounce' | 'now' | 'skip' }) {
  const items = downloadEngine.list();
  const mode = opts?.persist ?? 'debounce';
  if (mode === 'now') persistDownloadsDebounced(items, true);
  else if (mode === 'debounce') persistDownloadsDebounced(items, false);
  mainWindow?.webContents.send('downloads:update', slimDownloadsForUi(items));
}

function notify(message: string, kind: 'info' | 'ok' | 'warn' | 'error' = 'info') {
  mainWindow?.webContents.send('app:toast', { message, kind });
}

function pushVpnStatus(extra?: Partial<AppSettings>): void {
  const settings = { ...getSettings(), ...(extra || {}) };
  const status: VpnStatus = vpnManager.getStatus(settings);
  mainWindow?.webContents.send('vpn:status', status);
}

function applyTorrentBindFromVpn(): void {
  const addr = vpnManager.getBindAddress();
  downloadEngine.applySettings({
    bindAddress: addr,
  });
}

/** When VPN is required for torrents, block starts until connected. */
function assertVpnAllowsTorrents(): void {
  const s = getSettings();
  if (!s.vpnEnabled || !s.vpnRequireForTorrents) return;
  if (!vpnManager.isConnected()) {
    throw new Error('VPN required for torrents — connect OpenVPN in Settings first.');
  }
}

function pushUpdateStatus() {
  mainWindow?.webContents.send('update:status', { ...updateState });
}

function downloadingKeys(): Set<string> {
  return downloadEngine.getDownloadingKeys();
}

function downloadingMovieIds(): Set<number> {
  return downloadEngine.getDownloadingMovieIds();
}

function withMovieLocalStatus(movie: Movie): Movie {
  return applyMovieLocalStatus(movie, getSettings().movieLibraryRoot, downloadingMovieIds());
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

function toCandidates(results: Array<{ magnet: string; infoHash?: string; title?: string }>): TorrentCandidate[] {
  return (results || [])
    .filter((r) => r?.magnet)
    .map((r) => ({
      magnet: r.magnet,
      infoHash: (r.infoHash || extractInfoHash(r.magnet) || '').toLowerCase() || undefined,
      title: r.title,
    }));
}

function pickNextCandidate(
  candidates: TorrentCandidate[] | undefined,
  tried: Set<string>,
  currentMagnet?: string
): TorrentCandidate | null {
  for (const c of candidates || []) {
    if (!c?.magnet) continue;
    const h = (c.infoHash || extractInfoHash(c.magnet) || '').toLowerCase();
    if (h && tried.has(h)) continue;
    if (!h && currentMagnet && c.magnet === currentMagnet) continue;
    if (h) return c;
    if (c.magnet !== currentMagnet) return c;
  }
  return null;
}

async function tryNextAfterExeReject(item: DownloadItem): Promise<void> {
  const settings = getSettings();
  const tried = new Set((item.triedInfoHashes || []).map((h) => h.toLowerCase()));
  if (item.infoHash) tried.add(item.infoHash.toLowerCase());
  const curHash = extractInfoHash(item.magnet || '');
  if (curHash) tried.add(curHash.toLowerCase());

  let candidates = item.candidates ? [...item.candidates] : [];
  let next = pickNextCandidate(candidates, tried, item.magnet);

  // Re-search and skip already-tried infohashes when no stored next candidate
  if (!next) {
    try {
      if (item.kind === 'movie' && item.movieId != null) {
        const movie = getMovies().find((m) => m.tmdbId === item.movieId);
        if (movie) {
          const preferred = (movie.preferredResolution ||
            settings.defaultMovieResolution ||
            settings.defaultResolution) as Resolution;
          const res = await searchMovieTorrents(
            settings,
            movie.title,
            movie.releaseYear,
            preferred
          );
          candidates = toCandidates(res.results);
          next = pickNextCandidate(candidates, tried, item.magnet);
        }
      } else if (item.showId != null && item.seasonNumber != null && item.episodeNumber != null) {
        const show = getShows().find((s) => s.tmdbId === item.showId);
        if (show) {
          const preferred = (show.preferredResolution || settings.defaultResolution) as Resolution;
          const res = await searchEpisodeTorrents(
            settings,
            show.name,
            item.seasonNumber,
            item.episodeNumber,
            preferred,
            { imdbId: show.imdbId, mazeId: show.tmdbId }
          );
          candidates = toCandidates(res.results);
          next = pickNextCandidate(candidates, tried, item.magnet);
        }
      }
    } catch {
      // search failure — fall through to "no alternative"
    }
  }

  notify(`Skipped .exe, trying another torrent for ${item.name}`, 'warn');

  if (!next?.magnet) {
    notify(`No alternative torrents after skipping .exe for ${item.name}`, 'error');
    pushDownloads({ persist: 'now' });
    return;
  }

  const triedList = Array.from(tried);
  try {
    if (item.kind === 'movie' && item.movieId != null) {
      const movie = getMovies().find((m) => m.tmdbId === item.movieId);
      if (!movie) throw new Error('Movie not found');
      await downloadEngine.startMovie({
        magnet: next.magnet,
        movie,
        movieLibraryRoot: settings.movieLibraryRoot,
        candidates,
        triedInfoHashes: triedList,
      });
      upsertMovie(withMovieLocalStatus(movie));
      mainWindow?.webContents.send('movies:changed');
    } else {
      const show = getShows().find((s) => s.tmdbId === item.showId);
      if (!show) throw new Error('Show not found');
      await downloadEngine.start({
        magnet: next.magnet,
        show,
        libraryRoot: settings.libraryRoot,
        seasonNumber: item.seasonNumber,
        episodeNumber: item.episodeNumber,
        episodeTitle: item.episodeTitle,
        candidates,
        triedInfoHashes: triedList,
      });
      emitLibraryChanged();
    }
    pushDownloads({ persist: 'now' });
  } catch (err) {
    notify(
      `Failed to start next torrent: ${err instanceof Error ? err.message : String(err)}`,
      'error'
    );
  }
}

async function maybeFtpUpload(localPath: string | undefined, label: string): Promise<void> {
  const settings = getSettings();
  if (!settings.ftpEnabled || !localPath) return;
  try {
    await uploadFinishedFile(settings, localPath);
    notify(`FTP uploaded: ${label}`, 'ok');
  } catch (err) {
    // Local success stands; never undo. Never include password in message.
    notify(`FTP upload failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
  }
}

function withLocalStatuses(show: Show): Show {
  return applyLocalStatuses(show, getSettings().libraryRoot, downloadingKeys());
}

let libraryChangedTimer: NodeJS.Timeout | null = null;
/** Coalesce rapid library:changed during mass import / bulk ops. */
function emitLibraryChanged(immediate = false) {
  if (immediate) {
    if (libraryChangedTimer) {
      clearTimeout(libraryChangedTimer);
      libraryChangedTimer = null;
    }
    mainWindow?.webContents.send('library:changed');
    return;
  }
  if (libraryChangedTimer) clearTimeout(libraryChangedTimer);
  libraryChangedTimer = setTimeout(() => {
    libraryChangedTimer = null;
    mainWindow?.webContents.send('library:changed');
  }, 200);
}

/** Grid payload: counts from stored statuses — no disk scan, no season trees over IPC. */
function toShowListItem(show: Show, downloading: Set<string>): ShowListItem {
  let missingCount = 0;
  let episodeCount = 0;
  let downloadedCount = 0;
  for (const season of show.seasons || []) {
    for (const ep of season.episodes || []) {
      episodeCount += 1;
      const key = episodeKey(show.tmdbId, ep.seasonNumber, ep.episodeNumber);
      if (downloading.has(key)) continue;
      if (ep.status === 'missing' || ep.status === 'aired') missingCount += 1;
      if (ep.status === 'downloaded') downloadedCount += 1;
    }
  }
  return {
    id: show.id,
    tmdbId: show.tmdbId,
    name: show.name,
    posterPath: show.posterPath,
    status: show.status,
    firstAirDate: show.firstAirDate,
    missingCount,
    episodeCount,
    downloadedCount,
  };
}

function listShowSummaries(): ShowListItem[] {
  const downloading = downloadingKeys();
  return getShows().map((s) => toShowListItem(s, downloading));
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

type AutoDownloadNotify = { notifyChatId?: number; telegramRequestId?: string };

async function autoDownloadForShows(
  shows: Show[],
  notifyCtx?: AutoDownloadNotify
): Promise<number> {
  const settings = getSettings();
  // Telegram-approved requests may force a download pass even when autoDownload is off.
  const force = !!(notifyCtx?.notifyChatId || notifyCtx?.telegramRequestId);
  if (!settings.autoDownload && !force) return 0;
  if (settings.vpnEnabled && settings.vpnRequireForTorrents && !vpnManager.isConnected()) {
    return 0;
  }
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
          const { results } = await searchEpisodeTorrents(
            settings,
            show.name,
            ep.seasonNumber,
            ep.episodeNumber,
            preferred,
            { imdbId: show.imdbId, mazeId: show.tmdbId }
          );
          if (!results.length) {
            continue;
          }
          const best = results[0];
          if (!best?.magnet) continue;
          const candidates = toCandidates(results);
          await downloadEngine.start({
            magnet: best.magnet,
            show,
            libraryRoot: settings.libraryRoot,
            seasonNumber: ep.seasonNumber,
            episodeNumber: ep.episodeNumber,
            episodeTitle: ep.name,
            candidates,
            triedInfoHashes: [],
            notifyChatId: notifyCtx?.notifyChatId,
            telegramRequestId: notifyCtx?.telegramRequestId,
          });
          started += 1;
          pushDownloads({ persist: 'now' });
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

async function addMovieById(tmdbId: number): Promise<Movie> {
  const settings = getSettings();
  if (!(settings.movieLibraryRoot || '').trim()) {
    throw new Error('Set a movie library folder in Settings before adding movies');
  }
  const existing = getMovies().find((m) => m.tmdbId === tmdbId);
  const movie = await fetchMovieDetail(
    tmdbId,
    settings.movieLibraryRoot,
    existing,
    downloadingMovieIds()
  );
  upsertMovie(movie);
  mainWindow?.webContents.send('movies:changed');
  return withMovieLocalStatus(movie);
}

async function autoDownloadMovie(
  movie: Movie,
  notifyCtx?: AutoDownloadNotify
): Promise<boolean> {
  const settings = getSettings();
  if (settings.vpnEnabled && settings.vpnRequireForTorrents && !vpnManager.isConnected()) {
    return false;
  }
  if (downloadEngine.hasMovieActivity(movie.tmdbId)) return false;
  const preferred = (movie.preferredResolution ||
    settings.defaultMovieResolution ||
    settings.defaultResolution) as Resolution;
  const res = await searchMovieTorrents(
    settings,
    movie.title,
    movie.releaseYear,
    preferred
  );
  if (!res.results.length || !res.results[0]?.magnet) return false;
  const candidates = toCandidates(res.results);
  await downloadEngine.startMovie({
    magnet: res.results[0].magnet,
    movie,
    movieLibraryRoot: settings.movieLibraryRoot,
    candidates,
    triedInfoHashes: [],
    notifyChatId: notifyCtx?.notifyChatId,
    telegramRequestId: notifyCtx?.telegramRequestId,
  });
  upsertMovie(withMovieLocalStatus(movie));
  pushDownloads({ persist: 'now' });
  mainWindow?.webContents.send('movies:changed');
  return true;
}

function newTelegramRequestId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function formatRequestLine(r: TelegramRequest): string {
  const type = r.mediaType === 'movie' ? 'Movie' : 'TV';
  const year = r.year ? ` (${r.year})` : '';
  return `[${r.id}] ${type}: ${r.title}${year} — ${r.status}`;
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
  emitLibraryChanged();
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


async function importShowFromScan(mazeId: number, folderPath: string): Promise<Show> {
  const settings = getSettings();
  const existing = getShows().find((s) => s.tmdbId === mazeId);
  if (existing) {
    // Ensure libraryPath points at scanned folder if missing
    if (folderPath && !(existing.libraryPath || '').trim()) {
      const updated = { ...existing, libraryPath: folderPath };
      upsertShow(updated);
      const refreshed = await refreshOne(updated);
      return refreshed;
    }
    return withLocalStatuses(existing);
  }
  const shell = {
    id: mazeId,
    tmdbId: mazeId,
    name: '',
    overview: '',
    posterPath: null,
    backdropPath: null,
    firstAirDate: null,
    status: '',
    libraryPath: folderPath,
    seasons: [],
    addedAt: new Date().toISOString(),
  } as Show;
  let show = await fetchShowDetail(mazeId, settings.libraryRoot, shell, downloadingKeys());
  show = { ...show, libraryPath: folderPath || show.libraryPath };
  show = withLocalStatuses(show);
  upsertShow(show);
  return show;
}

async function importMovieFromScan(movieId: number, folderPath: string): Promise<Movie> {
  const settings = getSettings();
  const existing = getMovies().find((m) => m.tmdbId === movieId);
  if (existing) {
    if (folderPath && !(existing.libraryPath || '').trim()) {
      const updated = applyMovieLocalStatus(
        { ...existing, libraryPath: folderPath },
        settings.movieLibraryRoot,
        downloadingMovieIds()
      );
      upsertMovie(updated);
      mainWindow?.webContents.send('movies:changed');
      return withMovieLocalStatus(updated);
    }
    return withMovieLocalStatus(existing);
  }
  const shell = {
    id: movieId,
    tmdbId: movieId,
    title: '',
    overview: '',
    posterPath: null,
    backdropPath: null,
    releaseDate: null,
    releaseYear: null,
    runtime: null,
    status: 'missing' as const,
    libraryPath: folderPath,
    addedAt: new Date().toISOString(),
  } as Movie;
  let movie = await fetchMovieDetail(
    movieId,
    settings.movieLibraryRoot,
    shell,
    downloadingMovieIds()
  );
  movie = { ...movie, libraryPath: folderPath || movie.libraryPath };
  movie = applyMovieLocalStatus(movie, settings.movieLibraryRoot, downloadingMovieIds());
  upsertMovie(movie);
  mainWindow?.webContents.send('movies:changed');
  return withMovieLocalStatus(movie);
}

async function runFolderScanImport(items: FolderScanImportItem[]): Promise<FolderScanImportResult> {
  const result: FolderScanImportResult = {
    added: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    addedTitles: [],
  };
  const selected = (items || []).filter((i) => i.selected && i.matchId);
  const total = selected.length;
  for (let i = 0; i < selected.length; i++) {
    const item = selected[i];
    mainWindow?.webContents.send('library:scanProgress', {
      current: i + 1,
      total,
      phase: 'importing',
      label: item.kind === 'show' ? `TV #${item.matchId}` : `Movie #${item.matchId}`,
    });
    try {
      if (item.kind === 'show') {
        const before = getShows().some((s) => s.tmdbId === item.matchId);
        if (before) {
          result.skipped += 1;
          continue;
        }
        const show = await importShowFromScan(item.matchId, item.folderPath);
        result.added += 1;
        result.addedTitles.push(show.name);
      } else {
        const before = getMovies().some((m) => m.tmdbId === item.matchId);
        if (before) {
          result.skipped += 1;
          continue;
        }
        const movie = await importMovieFromScan(item.matchId, item.folderPath);
        result.added += 1;
        result.addedTitles.push(movie.title);
      }
    } catch (e) {
      result.failed += 1;
      result.errors.push(
        `${item.kind} ${item.matchId}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    // Yield between items so UI stays responsive on large imports.
    await new Promise<void>((r) => setImmediate(r));
  }
  mainWindow?.webContents.send('library:scanProgress', {
    current: total,
    total,
    phase: 'done',
    label: 'Import finished',
  });
  emitLibraryChanged(true);
  if (result.added || result.failed) {
    mainWindow?.webContents.send('movies:changed');
  }
  return result;
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

  emitLibraryChanged();
  return withLocalStatuses(show);
}


const UPDATE_FEED = {
  provider: 'github' as const,
  owner: 'remie1529',
  repo: 'Nightfeed',
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
  telegramBot.setSettingsGetter(() => getSettings());
  telegramBot.setHandlers({
    async help(chatId, _args, reply) {
      await reply(
        chatId,
        [
          'Nightfeed bot (admin)',
          '/status — library + active downloads',
          '/shows — tracked shows',
          '/movies — tracked movies',
          '/check — refresh metadata (+ auto-download if enabled)',
          '/downloads — download progress',
          '/add <query> — search TVMaze and add best match',
          '/request show|movie <name> — submit a request (or approve your own via admin)',
          '/approve <id> — approve a pending request',
          '/deny <id> — deny a pending request',
          '/requests — list recent pending requests',
          '/help — this list',
        ].join('\n')
      );
    },
    async helpRequests(chatId, _args, reply) {
      await reply(
        chatId,
        [
          'Nightfeed bot (requests)',
          '/request show <name> — request a TV show',
          '/request movie <name> — request a movie',
          '/request <name> — prompt for show vs movie',
          '/status — your recent requests',
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
      const pending = getTelegramRequests().filter((r) => r.status === 'pending').length;
      await reply(
        chatId,
        [
          `Shows: ${shows.length}`,
          `Movies: ${getMovies().length}`,
          `Missing/aired episodes: ${missing}`,
          `Active downloads: ${active.length}`,
          `Pending Telegram requests: ${pending}`,
          `Auto-download: ${settings.autoDownload ? 'on' : 'off'}`,
          `Refresh every: ${settings.refreshIntervalMinutes} min`,
          `TV library: ${settings.libraryRoot || '(not set)'}`,
          `Movie library: ${settings.movieLibraryRoot || '(not set)'}`,
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
    async movies(chatId, _args, reply) {
      const movies = getMovies().map((m) => withMovieLocalStatus(m));
      if (!movies.length) {
        await reply(chatId, 'No tracked movies.');
        return;
      }
      const lines = movies.map((m, i) => {
        const year = m.releaseYear ? ` (${m.releaseYear})` : '';
        return `${i + 1}. ${m.title}${year} — ${m.status}`;
      });
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
        const label =
          d.kind === 'movie'
            ? `${d.showName} (movie)`
            : `${d.showName} S${pad2(d.seasonNumber)}E${pad2(d.episodeNumber)}`;
        return `${label} — ${d.status} ${pct}% ${formatSpeed(d.downloadSpeed)}`;
      });
      await reply(chatId, lines.join('\n'));
    },
    async add(chatId, args, reply) {
      if (!args.trim()) {
        await reply(chatId, 'Usage: /add <show name>');
        return;
      }
      const results = await searchShowsMeta(args.trim());
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
    async request(chatId, args, reply, meta) {
      const raw = (args || '').trim();
      if (!raw) {
        await reply(
          chatId,
          'Usage:\n/request show <name>\n/request movie <name>\n/request <name>'
        );
        return;
      }
      let mediaType: 'show' | 'movie' | null = null;
      let query = raw;
      const typed = raw.match(/^(show|tv|series|movie|film)\s+(.+)$/i);
      if (typed) {
        const kind = typed[1].toLowerCase();
        mediaType = kind === 'movie' || kind === 'film' ? 'movie' : 'show';
        query = typed[2].trim();
      }
      if (!query) {
        await reply(chatId, 'Please include a title after the type.');
        return;
      }
      if (!mediaType) {
        await reply(
          chatId,
          `Is “${query}” a show or a movie?\nUse:\n/request show ${query}\nor\n/request movie ${query}`
        );
        return;
      }

      if (mediaType === 'show') {
        const results = await searchShowsMeta(query);
        if (!results.length) {
          await reply(chatId, `No TV shows found for “${query}”.`);
          return;
        }
        const best = results[0];
        const existing = getShows().find((s) => s.tmdbId === best.id);
        if (existing) {
          await reply(chatId, `Already in library: ${existing.name}`);
          return;
        }
        const pendingDup = getTelegramRequests().find(
          (r) =>
            r.status === 'pending' &&
            r.mediaType === 'show' &&
            r.mediaId === best.id &&
            r.requesterChatId === chatId
        );
        if (pendingDup) {
          await reply(chatId, `You already have a pending request: ${pendingDup.title} (${pendingDup.id})`);
          return;
        }
        const year = best.firstAirDate ? Number(best.firstAirDate.slice(0, 4)) || null : null;
        const req: TelegramRequest = {
          id: newTelegramRequestId(),
          mediaType: 'show',
          mediaId: best.id,
          title: best.name,
          year,
          overview: best.overview,
          requesterChatId: chatId,
          requesterName: meta?.fromName,
          status: 'pending',
          createdAt: new Date().toISOString(),
        };
        upsertTelegramRequest(req);
        await reply(chatId, 'Request submitted, waiting for admin approval');
        const adminText = [
          'New Telegram request',
          `Type: TV show`,
          `Title: ${req.title}${year ? ` (${year})` : ''}`,
          `Requester: ${req.requesterName || '—'} (${req.requesterChatId})`,
          `Id: ${req.id}`,
          '',
          `Or: /approve ${req.id}  /deny ${req.id}`,
        ].join('\n');
        await telegramBot.notifyAdminChats(getSettings(), adminText, approveDenyKeyboard(req.id));
        return;
      }

      // movie
      const results = await searchMoviesMeta(query);
      if (!results.length) {
        await reply(chatId, `No movies found for “${query}”.`);
        return;
      }
      const best = results[0];
      const existing = getMovies().find((m) => m.tmdbId === best.id);
      if (existing) {
        await reply(chatId, `Already in library: ${existing.title}`);
        return;
      }
      const pendingDup = getTelegramRequests().find(
        (r) =>
          r.status === 'pending' &&
          r.mediaType === 'movie' &&
          r.mediaId === best.id &&
          r.requesterChatId === chatId
      );
      if (pendingDup) {
        await reply(chatId, `You already have a pending request: ${pendingDup.title} (${pendingDup.id})`);
        return;
      }
      const req: TelegramRequest = {
        id: newTelegramRequestId(),
        mediaType: 'movie',
        mediaId: best.id,
        title: best.title,
        year: best.releaseYear,
        overview: best.overview,
        requesterChatId: chatId,
        requesterName: meta?.fromName,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      upsertTelegramRequest(req);
      await reply(chatId, 'Request submitted, waiting for admin approval');
      const adminText = [
        'New Telegram request',
        `Type: Movie`,
        `Title: ${req.title}${req.year ? ` (${req.year})` : ''}`,
        `Requester: ${req.requesterName || '—'} (${req.requesterChatId})`,
        `Id: ${req.id}`,
        '',
        `Or: /approve ${req.id}  /deny ${req.id}`,
      ].join('\n');
      await telegramBot.notifyAdminChats(getSettings(), adminText, approveDenyKeyboard(req.id));
    },
    async myrequests(chatId, args, reply) {
      const settings = getSettings();
      const adminRaw =
        (settings.telegramAdminChatIds || '').trim() ||
        (settings.telegramAllowedChatIds || '').trim();
      const isAdmin = adminRaw
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .includes(String(chatId));
      if (isAdmin && !(args || '').trim()) {
        const pending = getTelegramRequests()
          .filter((r) => r.status === 'pending')
          .slice(-20)
          .reverse();
        if (!pending.length) {
          await reply(chatId, 'No pending requests.');
          return;
        }
        await reply(chatId, pending.map(formatRequestLine).join('\n'));
        return;
      }
      const mine = getTelegramRequests()
        .filter((r) => r.requesterChatId === chatId)
        .slice(-15)
        .reverse();
      if (!mine.length) {
        await reply(chatId, 'You have no requests yet. Try /request show <name>');
        return;
      }
      await reply(chatId, mine.map(formatRequestLine).join('\n'));
    },
    async approve(chatId, args, reply) {
      const id = (args || '').trim().split(/\s+/)[0];
      if (!id) {
        await reply(chatId, 'Usage: /approve <id>');
        return;
      }
      const result = await resolveTelegramRequest(id, 'approved', chatId);
      await reply(chatId, result.message);
    },
    async deny(chatId, args, reply) {
      const id = (args || '').trim().split(/\s+/)[0];
      if (!id) {
        await reply(chatId, 'Usage: /deny <id>');
        return;
      }
      const result = await resolveTelegramRequest(id, 'denied', chatId);
      await reply(chatId, result.message);
    },
    async callback(chatId, data, reply) {
      const m = /^(approve|deny):(.+)$/.exec((data || '').trim());
      if (!m) {
        await reply(chatId, 'Unknown button action.');
        return;
      }
      const action = m[1] === 'approve' ? 'approved' : 'denied';
      const result = await resolveTelegramRequest(m[2], action, chatId);
      await reply(chatId, result.message);
    },
  });
  telegramBot.sync(getSettings());
}

async function resolveTelegramRequest(
  id: string,
  action: 'approved' | 'denied',
  adminChatId: number
): Promise<{ ok: boolean; message: string }> {
  const req = getTelegramRequest(id);
  if (!req) return { ok: false, message: `Unknown request id: ${id}` };
  if (req.status !== 'pending') {
    return { ok: false, message: `Request ${id} is already ${req.status}.` };
  }
  const settings = getSettings();

  if (action === 'denied') {
    const updated: TelegramRequest = {
      ...req,
      status: 'denied',
      resolvedAt: new Date().toISOString(),
      resolvedByChatId: adminChatId,
    };
    upsertTelegramRequest(updated);
    try {
      await telegramBot.notifyChat(
        settings,
        req.requesterChatId,
        `Denied: ${req.title}`
      );
    } catch {
      // ignore notify failure
    }
    return { ok: true, message: `Denied ${req.title} (${req.id}).` };
  }

  // approve
  const notifyCtx = {
    notifyChatId: req.requesterChatId,
    telegramRequestId: req.id,
  };
  try {
    if (req.mediaType === 'show') {
      const show = await addShowWithPolicy(req.mediaId, 'manual');
      // Kick off search+download with Telegram notify tags on each item.
      void autoDownloadForShows([show], notifyCtx);
      const updated: TelegramRequest = {
        ...req,
        status: 'approved',
        resolvedAt: new Date().toISOString(),
        resolvedByChatId: adminChatId,
        title: show.name || req.title,
      };
      upsertTelegramRequest(updated);
      try {
        await telegramBot.notifyChat(settings, req.requesterChatId, `Approved: ${show.name}`);
      } catch {
        // ignore
      }
      return { ok: true, message: `Approved TV: ${show.name} — searching/downloading…` };
    }

    const movie = await addMovieById(req.mediaId);
    let started = false;
    try {
      started = await autoDownloadMovie(movie, notifyCtx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(`Telegram approve download failed: ${msg}`, 'warn');
    }
    const updated: TelegramRequest = {
      ...req,
      status: 'approved',
      resolvedAt: new Date().toISOString(),
      resolvedByChatId: adminChatId,
      title: movie.title || req.title,
    };
    upsertTelegramRequest(updated);
    try {
      await telegramBot.notifyChat(settings, req.requesterChatId, `Approved: ${movie.title}`);
    } catch {
      // ignore
    }
    return {
      ok: true,
      message: started
        ? `Approved movie: ${movie.title} — download started.`
        : `Approved movie: ${movie.title} — added to library (no torrent found yet).`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Approve failed: ${message}` };
  }
}

function registerIpc() {
  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:set', (_e, partial: Partial<AppSettings>) => {
    const next = setSettings(partial);
    scheduleRefresh();
    applyLoginItem(!!next.launchOnStartup);
    telegramBot.sync(next);
    downloadEngine.applySettings({
      maxConnections: next.maxConnections,
      maxDownloadSpeedKBps: next.maxDownloadSpeedKBps,
      maxUploadSpeedKBps: next.maxUploadSpeedKBps,
      bindAddress: vpnManager.getBindAddress(),
    });
    // Re-apply private GitHub feed if token present (never log token)
    configureUpdaterFeed();
    if (!next.vpnEnabled) {
      void vpnManager.disconnect();
    }
    pushVpnStatus(next);
    return next;
  });

  ipcMain.handle('dialog:pickFolder', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('tmdb:search', async (_e, query: string) => {
    // Off main: metadata worker. Yield first so we never share a turn with progress flush.
    await new Promise<void>((r) => setImmediate(r));
    return searchShowsMeta(query || '');
  });

  ipcMain.handle('library:list', async () => {
    // Lightweight grid: no per-episode disk scans / no season trees.
    // Yield once so we never block a progress flush turn on huge libraries.
    await new Promise<void>((r) => setImmediate(r));
    return listShowSummaries();
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

  // Manual folder mass-import (never auto-runs)
  ipcMain.handle('library:scanPreview', async (_e, scope: LibraryScanScope) => {
    const settings = getSettings();
    return buildScanPreview(
      scope || 'both',
      settings.libraryRoot,
      settings.movieLibraryRoot,
      getShows(),
      getMovies()
    );
  });

  ipcMain.handle('library:scanImport', async (_e, items: FolderScanImportItem[]) => {
    return runFolderScanImport(items || []);
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
    emitLibraryChanged();
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
      emitLibraryChanged();
      return updated;
    }
  );

  ipcMain.handle(
    'library:setSeasonStatus',
    (_e, tmdbId: number, season: number, status: EpisodeOverrideStatus) => {
      const show = getShows().find((s) => s.tmdbId === tmdbId);
      if (!show) throw new Error('Show not found');
      const allowed: EpisodeOverrideStatus[] = ['missing', 'downloaded', 'ignored', 'upcoming'];
      if (!allowed.includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      const seasonObj = show.seasons.find((s) => s.seasonNumber === season);
      if (!seasonObj) throw new Error(`Season ${season} not found`);
      const entries: Record<string, EpisodeOverrideStatus> = {};
      for (const ep of seasonObj.episodes || []) {
        entries[episodeKey(tmdbId, ep.seasonNumber, ep.episodeNumber)] = status;
      }
      if (Object.keys(entries).length) {
        setEpisodeOverridesBulk(entries);
      }
      const updated = withLocalStatuses(show);
      upsertShow(updated);
      emitLibraryChanged();
      notify(
        `Season ${season}: set ${Object.keys(entries).length} episode(s) to ${status}`,
        'ok'
      );
      return updated;
    }
  );

  ipcMain.handle('search:episode', async (_e, tmdbId: number, season: number, episode: number) => {
    const settings = getSettings();
    const show = getShows().find((s) => s.tmdbId === tmdbId);
    if (!show) throw new Error('Show not found');
    const preferred = (show.preferredResolution || settings.defaultResolution) as Resolution;
    const res = await searchEpisodeTorrents(settings, show.name, season, episode, preferred, {
      imdbId: show.imdbId,
      mazeId: show.tmdbId,
    });
    // Partial source errors are returned in res.error but must not wipe other results
    if (res.error && !res.results.length) {
      notify(res.error, 'warn');
    }
    return res;
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
        candidates?: TorrentCandidate[];
      }
    ) => {
      assertVpnAllowsTorrents();
      const settings = getSettings();
      const show = getShows().find((s) => s.tmdbId === payload.tmdbId);
      if (!show) throw new Error('Show not found');
      const candidates = payload.candidates?.length
        ? toCandidates(payload.candidates)
        : toCandidates([{ magnet: payload.magnet }]);
      const item = await downloadEngine.start({
        magnet: payload.magnet,
        show,
        libraryRoot: settings.libraryRoot,
        seasonNumber: payload.season,
        episodeNumber: payload.episode,
        episodeTitle: payload.episodeTitle,
        candidates,
        triedInfoHashes: [],
      });
      pushDownloads({ persist: 'now' });
      return item;
    }
  );

  ipcMain.handle('download:list', () => downloadEngine.list());
  ipcMain.handle('download:pause', (_e, id: string) => {
    downloadEngine.pause(id);
    pushDownloads({ persist: 'now' });
  });
  ipcMain.handle('download:resume', (_e, id: string) => {
    downloadEngine.resume(id);
    pushDownloads({ persist: 'now' });
  });
  ipcMain.handle('download:cancel', (_e, id: string) => {
    downloadEngine.cancel(id);
    pushDownloads({ persist: 'now' });
  });



  ipcMain.handle('tmdb:searchMovies', async (_e, query: string) => {
    await new Promise<void>((r) => setImmediate(r));
    return searchMoviesMeta(query || '');
  });

  ipcMain.handle('movies:list', () => {
    return getMovies().map((m) => withMovieLocalStatus(m));
  });

  ipcMain.handle('movies:get', (_e, tmdbId: number) => {
    const movie = getMovies().find((m) => m.tmdbId === tmdbId);
    if (!movie) return null;
    return withMovieLocalStatus(movie);
  });

  ipcMain.handle('movies:add', async (_e, tmdbId: number) => {
    const settings = getSettings();
    if (!(settings.movieLibraryRoot || '').trim()) {
      throw new Error('Set a movie library folder in Settings before adding movies');
    }
    const existing = getMovies().find((m) => m.tmdbId === tmdbId);
    const movie = await fetchMovieDetail(
      tmdbId,
      settings.movieLibraryRoot,
      existing,
      downloadingMovieIds()
    );
    upsertMovie(movie);
    mainWindow?.webContents.send('movies:changed');
    return withMovieLocalStatus(movie);
  });

  ipcMain.handle('movies:remove', (_e, tmdbId: number) => {
    removeMovie(tmdbId);
    mainWindow?.webContents.send('movies:changed');
    return getMovies().map((m) => withMovieLocalStatus(m));
  });

  ipcMain.handle('movies:update', (_e, tmdbId: number, partial: Partial<Movie>) => {
    const movies = getMovies();
    const idx = movies.findIndex((m) => m.tmdbId === tmdbId);
    if (idx < 0) throw new Error('Movie not found');
    movies[idx] = { ...movies[idx], ...partial, tmdbId };
    upsertMovie(movies[idx]);
    mainWindow?.webContents.send('movies:changed');
    return withMovieLocalStatus(movies[idx]);
  });

  ipcMain.handle('movies:refresh', async (_e, tmdbId: number) => {
    const settings = getSettings();
    const existing = getMovies().find((m) => m.tmdbId === tmdbId);
    if (!existing) throw new Error('Movie not found');
    const movie = await fetchMovieDetail(
      tmdbId,
      settings.movieLibraryRoot,
      existing,
      downloadingMovieIds()
    );
    upsertMovie(movie);
    mainWindow?.webContents.send('movies:changed');
    return movie;
  });

  ipcMain.handle('search:movie', async (_e, tmdbId: number) => {
    const settings = getSettings();
    const movie = getMovies().find((m) => m.tmdbId === tmdbId);
    if (!movie) throw new Error('Movie not found');
    const preferred = (movie.preferredResolution ||
      settings.defaultMovieResolution ||
      settings.defaultResolution) as Resolution;
    const res = await searchMovieTorrents(
      settings,
      movie.title,
      movie.releaseYear,
      preferred
    );
    if (res.error && !res.results.length) {
      notify(res.error, 'warn');
    }
    return res;
  });

  ipcMain.handle(
    'download:startMovie',
    async (
      _e,
      payload: {
        tmdbId: number;
        magnet: string;
        candidates?: TorrentCandidate[];
      }
    ) => {
      assertVpnAllowsTorrents();
      const settings = getSettings();
      const movie = getMovies().find((m) => m.tmdbId === payload.tmdbId);
      if (!movie) throw new Error('Movie not found');
      if (!(settings.movieLibraryRoot || '').trim()) {
        throw new Error('Set a movie library folder in Settings');
      }
      const candidates = payload.candidates?.length
        ? toCandidates(payload.candidates)
        : toCandidates([{ magnet: payload.magnet }]);
      const item = await downloadEngine.startMovie({
        magnet: payload.magnet,
        movie,
        movieLibraryRoot: settings.movieLibraryRoot,
        candidates,
        triedInfoHashes: [],
      });
      // Mark downloading in store for UI
      upsertMovie(withMovieLocalStatus(movie));
      pushDownloads({ persist: 'now' });
      mainWindow?.webContents.send('movies:changed');
      return item;
    }
  );

  ipcMain.handle('backup:export', async () => {
    const data = exportBackupData();
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export Nightfeed backup',
      defaultPath: `nightfeed-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON backup', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    const fs = await import('fs/promises');
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, path: filePath };
  });

  ipcMain.handle('backup:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Import Nightfeed backup',
      filters: [{ name: 'JSON backup', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths?.[0]) return { ok: false, canceled: true };
    const fs = await import('fs/promises');
    const rawText = await fs.readFile(filePaths[0], 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new Error('Backup file is not valid JSON');
    }
    const counts = importBackupData(parsed);
    const settings = getSettings();
    downloadEngine.applySettings({
      maxConnections: settings.maxConnections,
      maxDownloadSpeedKBps: settings.maxDownloadSpeedKBps,
      maxUploadSpeedKBps: settings.maxUploadSpeedKBps,
      bindAddress: vpnManager.getBindAddress(),
    });
    applyLoginItem(!!settings.launchOnStartup);
    telegramBot.sync(settings);
    scheduleRefresh();
    emitLibraryChanged();
    mainWindow?.webContents.send('movies:changed');
    pushDownloads({ persist: 'skip' });
    return { ok: true, ...counts, path: filePaths[0] };
  });

    ipcMain.handle('telegram:status', () => telegramBot.getStatus(getSettings()));
  ipcMain.handle('telegram:test', async () => telegramBot.sendTest(getSettings()));

  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('app:getThreadInfo', () => {
    const search = getSearchPoolInfo();
    const torrent = getTorrentEngineInfo();
    const meta = getMetadataPoolInfo();
    return {
      searchWorkers: search.size,
      searchUsingWorkers: search.usingWorkers,
      metadataWorker: meta.usingWorker,
      cpus: search.cpus,
      torrentMode: torrent.mode,
      torrentDetail: torrent.detail,
    };
  });
  ipcMain.handle('update:status', () => ({ ...updateState }));
  ipcMain.handle('update:check', async () => checkForUpdates(true));
  ipcMain.handle('update:install', () => {
    if (updateState.downloaded) {
      autoUpdater.quitAndInstall();
    }
  });

  ipcMain.handle('vpn:status', async () => {
    await vpnManager.refreshDetect();
    return vpnManager.getStatus(getSettings());
  });

  ipcMain.handle('vpn:detect', async () => {
    await vpnManager.refreshDetect();
    pushVpnStatus();
    return vpnManager.getStatus(getSettings());
  });

  ipcMain.handle('vpn:importConfig', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import OpenVPN configuration',
      properties: ['openFile'],
      filters: [
        { name: 'OpenVPN config', extensions: ['ovpn', 'conf'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    const imported = await vpnManager.importConfig(res.filePaths[0]);
    const next = setSettings({
      vpnConfigPath: imported.configPath,
      vpnConfigName: imported.configName,
      vpnEnabled: true,
    });
    pushVpnStatus(next);
    return { ok: true, ...imported, settings: next };
  });

  ipcMain.handle('vpn:connect', async () => {
    const s = getSettings();
    if (!s.vpnConfigPath) {
      throw new Error('Import an .ovpn file first');
    }
    // password never logged
    await vpnManager.connect({
      configPath: s.vpnConfigPath,
      username: s.vpnUsername || '',
      password: s.vpnPassword || '',
    });
    applyTorrentBindFromVpn();
    pushVpnStatus();
    return vpnManager.getStatus(getSettings());
  });

  ipcMain.handle('vpn:disconnect', async () => {
    await vpnManager.disconnect();
    applyTorrentBindFromVpn();
    pushVpnStatus();
    return vpnManager.getStatus(getSettings());
  });
}

app.whenReady().then(async () => {
  try {
    Menu.setApplicationMenu(null);
  } catch {
    // ignore
  }
  registerIpc();
  wireTelegram();
  setupAutoUpdater();
  await vpnManager.refreshDetect();
  vpnManager.on('status', () => {
    applyTorrentBindFromVpn();
    pushVpnStatus();
  });
  vpnManager.on('bind', () => {
    applyTorrentBindFromVpn();
    pushVpnStatus();
  });
  await ensureTorrentEngine();
  if (getTorrentEngineInfo().mode === 'in-process') {
    notify(
      'WebTorrent utilityProcess failed — downloads run on the UI process. Library search still uses a worker.',
      'warn'
    );
  }
  downloadEngine.on('update', () => pushDownloads({ persist: 'debounce' }));
  downloadEngine.on('reject-exe', (item: DownloadItem) => {
    void tryNextAfterExeReject(item);
  });
  downloadEngine.on('done', (item: DownloadItem) => {
    if (item?.kind === 'movie' && item.movieId != null) {
      const movie = getMovies().find((m) => m.tmdbId === item.movieId);
      if (movie) {
        movie.status = 'downloaded';
        movie.localPath = item.savePath || movie.localPath;
        upsertMovie(withMovieLocalStatus(movie));
      }
      mainWindow?.webContents.send('movies:changed');
    } else if (item?.showId != null && item.seasonNumber != null && item.episodeNumber != null) {
      setEpisodeOverride(item.showId, item.seasonNumber, item.episodeNumber, 'downloaded');
      const show = getShows().find((s) => s.tmdbId === item.showId);
      if (show) {
        upsertShow(withLocalStatuses(show));
      }
      emitLibraryChanged();
    }
    if (item?.name) {
      notify(`Finished: ${item.name}`, 'ok');
    }
    if (item?.notifyChatId) {
      const title =
        item.kind === 'movie'
          ? item.showName || item.name
          : `${item.showName} S${pad2(item.seasonNumber)}E${pad2(item.episodeNumber)}${
              item.episodeTitle ? ` — ${item.episodeTitle}` : ''
            }`;
      void telegramBot
        .notifyChat(getSettings(), item.notifyChatId, `Download finished: ${title}`)
        .catch(() => undefined);
    }
    pushDownloads({ persist: 'now' });
    void maybeFtpUpload(item?.savePath, item?.name || path.basename(item?.savePath || 'file'));
  });
  createWindow();
  const settings = getSettings();
  downloadEngine.applySettings({
    maxConnections: settings.maxConnections,
    maxDownloadSpeedKBps: settings.maxDownloadSpeedKBps,
    maxUploadSpeedKBps: settings.maxUploadSpeedKBps,
    bindAddress: vpnManager.getBindAddress(),
  });
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
    void vpnManager.disconnect();
    downloadEngine.destroy();
    void destroySearchPool();
    void destroyMetadataPool();
    app.quit();
  }
});
