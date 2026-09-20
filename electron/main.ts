import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, protocol, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
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
  appendDownloadHistory,
  getDownloadHistory,
  getLastDailyBriefingDate,
  getDownloads,
  saveDownloads,
  addTriedTorrents,
  getTriedTorrents,
  triedEpisodeKey,
  triedMovieKey,
  getEpisodeOverride,
  setEpisodeOverride,
  setEpisodeResolution,
  setLastDailyBriefingDate,
  setEpisodeOverridesBulk,
  setSettings,
  upsertMovie,
  upsertShow,
  upsertTelegramRequest,
  getLiveTvLineup,
  setLiveTvLineup,
} from './services/store';
import {
  applyLocalStatuses,
  fetchShowDetail,
  ignoreAiredEpisodes,
} from './services/tvmaze';
import {
  extractInfoHash,
  filterQualityResults,
  filterUpgradeResults,
  MIN_AUTO_SEEDERS,
  detectResolution,
  pickAutoDownload,
  pickUpgradeDownload,
  resolutionRank,
  summarizeAutoRejects,
  type QualityRules,
} from './services/search';
import { searchEpisodeTorrents, searchMovieTorrents, destroySearchPool, getSearchPoolInfo } from './services/search-pool';
import { searchShowsMeta, searchMoviesMeta, destroyMetadataPool, getMetadataPoolInfo } from './services/metadata-pool';
import {
  applyMovieLocalStatus,
  fetchMovieDetail,
} from './services/imdb';
import { downloadEngine, ensureTorrentEngine, getTorrentEngineInfo, getLastUtilityFailure } from './services/engine-bridge';
import { isIgnorableTorrentSocketError } from './services/engine';
import {
  approveDenyKeyboard,
  escapeHtml,
  normalizeChatIdToken,
  parseChatIds,
  telegramBot,
} from './services/telegram';
import {
  hashWebPortalPassword,
  portalPublicUrls,
  webPortal,
} from './services/web-portal';
import { uploadFinishedFile } from './services/ftp';
import { vpnManager } from './services/vpn';
import { liveTv, withLogoPreview } from './services/live-tv';
import {
  applyCrashRestartTask,
  clearSessionLock,
  isCrashWatchdogArg,
  runCrashWatchdog,
  writeSessionLock,
} from './services/crash-watchdog';
import { uniqueRoots, showRootForSeason, getMovieRoot } from './services/paths';
import { activityLog, summarizeSettingsKeys } from './services/activity-log';
import { ensurePosterCached, resolveNfimgFile } from './services/poster-cache';
import { randomBytes } from 'crypto';
import os from 'os';
import {
  buildScanPreview,
  type FolderScanImportItem,
  type FolderScanImportResult,
  type LibraryScanScope,
} from './services/library-scan';
import {
  AddShowPolicy,
  AppSettings,
  CalendarEpisode,
  DEFAULT_TORRENT_SOURCES,
  DownloadItem,
  Episode,
  EpisodeOverrideStatus,
  Movie,
  Resolution,
  SearchResult,
  Show,
  ShowListItem,
  LiveTvChannel,
  TelegramRequest,
  TorrentCandidate,
  UpdateStatus,
  VpnStatus,
} from './types';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'nfimg',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true },
  },
]);

if (!isCrashWatchdogArg()) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
  }
}

process.on('uncaughtException', (err) => {
  if (isIgnorableTorrentSocketError(err)) {
    console.error('[nightfeed] ignored torrent socket exhaustion:', err.message);
    return;
  }
  console.error('[nightfeed] uncaughtException', err);
  try {
    activityLog.error('app', `uncaughtException: ${err?.message || String(err)}`);
  } catch {
    // ignore
  }
});
process.on('unhandledRejection', (reason) => {
  if (isIgnorableTorrentSocketError(reason)) {
    console.error('[nightfeed] ignored torrent socket rejection:', reason);
    return;
  }
  console.error('[nightfeed] unhandledRejection', reason);
  try {
    const msg = reason instanceof Error ? reason.message : String(reason);
    activityLog.error('app', `unhandledRejection: ${msg}`);
  } catch {
    // ignore
  }
});

let mainWindow: BrowserWindow | null = null;
let uiBackendReady = false;

function signalUiReady(): void {
  uiBackendReady = true;
  mainWindow?.webContents.send('app:ready');
}
let refreshTimer: NodeJS.Timeout | null = null;
let autoDownloadRunning = false;

const updateState: UpdateStatus = {
  checking: false,
  available: false,
  downloaded: false,
  progress: null,
  version: null,
  message: null,
  error: null,
};

function resolveAppIcon(): string | undefined {
  const candidates = [
    path.join(process.resourcesPath || '', 'icon.ico'),
    path.join(process.resourcesPath || '', 'icon.png'),
    path.join(__dirname, '../build/icon.ico'),
    path.join(__dirname, '../build/icon.png'),
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
    show: false,
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

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });
  mainWindow.webContents.on('did-finish-load', () => {
    if (uiBackendReady) mainWindow?.webContents.send('app:ready');
  });
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
  }, 4000);

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
    persistDownloadsTimer = setTimeout(flush, 15000);
  }
}

let lastDownloadsUiKey = '';

function pushDownloads(opts?: { persist?: 'debounce' | 'now' | 'skip' }) {
  const items = downloadEngine.list();
  const mode = opts?.persist ?? 'debounce';
  if (mode === 'now') persistDownloadsDebounced(items, true);
  else if (mode === 'debounce') persistDownloadsDebounced(items, false);
  const slim = slimDownloadsForUi(items);
  const key = slim
    .map(
      (i) =>
        `${i.id}:${i.status}:${Math.round((i.progress || 0) * 100)}:${Math.round(i.downloadSpeed || 0)}:${i.numSeeders || 0}:${i.numPeers || 0}:${i.error || ''}`
    )
    .join('|');
  if (key === lastDownloadsUiKey && mode === 'debounce') return;
  lastDownloadsUiKey = key;
  mainWindow?.webContents.send('downloads:update', slim);
}

function notify(message: string, kind: 'info' | 'ok' | 'warn' | 'error' = 'info') {
  mainWindow?.webContents.send('app:toast', { message, kind });
  const level = kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : 'info';
  activityLog[level]('toast', message);
}

let lastLoggedVpnState: string | null = null;

function pushVpnStatus(extra?: Partial<AppSettings>): void {
  const settings = { ...getSettings(), ...(extra || {}) };
  const status: VpnStatus = vpnManager.getStatus(settings);
  mainWindow?.webContents.send('vpn:status', status);
  const stateKey = `${status.state || ''}|${status.killSwitch ? 1 : 0}|${status.bindAddress || ''}`;
  if (stateKey !== lastLoggedVpnState) {
    lastLoggedVpnState = stateKey;
    activityLog.info('vpn', `Status: ${status.state || 'unknown'}`, {
      killSwitch: !!status.killSwitch,
      bind: status.bindAddress || '',
      message: status.message || '',
    });
  }
}

function torrentVpnHold(): boolean {
  const s = getSettings();
  return !!(s.vpnEnabled && s.vpnRequireForTorrents && !vpnManager.isConnected());
}

/** Dedup key so handshake status spam does not re-apply / kick. */
let lastTorrentBindKey = '';

function applyTorrentBindFromVpn(): void {
  const bindAddress = vpnManager.getBindAddress();
  const bindIfIndex = vpnManager.getBindIfIndex();
  const vpnHold = torrentVpnHold();
  const processFolder = getSettings().processFolder || '';
  const key = `${bindAddress ?? ''}|${bindIfIndex ?? ''}|${vpnHold ? 1 : 0}|${processFolder}`;
  // Status-only updates while connecting (same bind/hold) are a no-op.
  if (key === lastTorrentBindKey) return;
  lastTorrentBindKey = key;
  downloadEngine.applySettings({
    bindAddress,
    bindIfIndex,
    vpnHold,
    processFolder,
  });
  // Mid-handshake: do not kick the torrent queue — wait until connected/disconnected.
  if (vpnManager.isConnecting()) return;
  downloadEngine.kickQueue();
}

/** When VPN is required for torrents, block starts until connected. */
function assertVpnAllowsTorrents(): void {
  const s = getSettings();
  if (!s.vpnEnabled || !s.vpnRequireForTorrents) return;
  if (!vpnManager.isConnected()) {
    throw new Error('VPN kill switch: OpenVPN is not connected. Torrents are blocked.');
  }
}

let lastVpnKillAlertAt = 0;
let vpnReconnectAttempt = false;

function alertVpnKillSwitch(detail: string): void {
  const now = Date.now();
  if (now - lastVpnKillAlertAt < 60_000) return;
  lastVpnKillAlertAt = now;
  const msg = `Nightfeed VPN kill switch: ${detail} Torrents are paused until OpenVPN is connected.`;
  notify(msg, 'error');
  void telegramBot.notifyAdminChats(getSettings(), msg).catch(() => undefined);
}

function localDayStamp(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function maybeSendDailyBriefing(): Promise<void> {
  const s = getSettings();
  if (!s.telegramEnabled || !s.telegramDailyBriefing) return;
  const hour = Math.min(23, Math.max(0, s.telegramDailyBriefingHour ?? 9));
  const now = new Date();
  if (now.getHours() < hour) return;
  const today = localDayStamp(now);
  if (getLastDailyBriefingDate() === today) return;
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const items = getDownloadHistory().filter((h) => {
    const t = Date.parse(h.at);
    return Number.isFinite(t) && t >= since;
  });
  setLastDailyBriefingDate(today);
  if (!items.length) return;
  const lines = [
    `<b>Nightfeed daily briefing</b>`,
    `${items.length} download${items.length === 1 ? '' : 's'} in the last 24 hours:`,
    ...items.slice(0, 40).map((h) => `• ${escapeHtml(h.title)}`),
  ];
  if (items.length > 40) lines.push(`…and ${items.length - 40} more`);
  const photo = items.find((h) => h.posterUrl)?.posterUrl || null;
  await telegramBot.notifyAdminChats(s, lines.join('\n'), undefined, photo);
}

function startVpnFromSettings(): Promise<void> {
  const s = getSettings();
  if (!s.vpnEnabled || !s.vpnConfigPath) return Promise.resolve();
  return vpnManager
    .connect({
      configPath: s.vpnConfigPath,
      username: s.vpnUsername || '',
      password: s.vpnPassword || '',
    })
    .then(() => undefined)
    .catch(() => undefined);
}

async function autoConnectVpnOnLaunch(): Promise<void> {
  const s = getSettings();
  applyTorrentBindFromVpn();
  if (!s.vpnEnabled || !s.vpnConfigPath) return;
  notify('Connecting OpenVPN…', 'info');
  await startVpnFromSettings();
  applyTorrentBindFromVpn();
  pushVpnStatus();
  if (s.vpnRequireForTorrents) {
    setTimeout(() => {
      if (!vpnManager.isConnected() && getSettings().vpnRequireForTorrents) {
        applyTorrentBindFromVpn();
        pushVpnStatus();
        alertVpnKillSwitch('OpenVPN did not connect after startup.');
      }
    }, 60000);
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

function slimShowForDownload(show: Show): Show {
  return {
    tmdbId: show.tmdbId,
    name: show.name,
    libraryPath: show.libraryPath || '',
  } as Show;
}

function slimMovieForDownload(movie: Movie): Movie {
  return {
    tmdbId: movie.tmdbId,
    title: movie.title,
    libraryPath: movie.libraryPath || '',
    releaseYear: movie.releaseYear,
  } as Movie;
}

function showForDownload(show: Show, seasonNumber: number): Show {
  const roots = tvRoots();
  return {
    ...slimShowForDownload(show),
    libraryPath: showRootForSeason(show, roots, seasonNumber),
  };
}

function qualityRules(
  kind: 'episode' | 'movie',
  preferredOverride?: Resolution | null,
  show?: Show | null
): QualityRules {
  const s = getSettings();
  const preferred =
    (preferredOverride ||
      (kind === 'movie' ? s.defaultMovieResolution || s.defaultResolution : s.defaultResolution)) as Resolution;
  const minimum =
    (kind === 'episode' && show?.minimumResolution
      ? show.minimumResolution
      : kind === 'movie'
        ? s.minimumMovieResolution || s.minimumResolution
        : s.minimumResolution) || '720p';
  const tv720 = show?.minSizeMb720p != null ? show.minSizeMb720p : s.minSizeMbTv720p;
  const tv1080 = show?.minSizeMb1080p != null ? show.minSizeMb1080p : s.minSizeMbTv1080p;
  const tv2160 = show?.minSizeMb2160p != null ? show.minSizeMb2160p : s.minSizeMbTv2160p;
  return {
    preferred,
    minimum: minimum as Resolution,
    minSizeMb: {
      '720p': (kind === 'movie' ? s.minSizeMbMovie720p : tv720) || 0,
      '1080p': (kind === 'movie' ? s.minSizeMbMovie1080p : tv1080) || 0,
      '2160p': (kind === 'movie' ? s.minSizeMbMovie2160p : tv2160) || 0,
    },
    minSeeders: typeof s.minSeeders === 'number' ? s.minSeeders : 8,
  };
}

function currentLibraryResolution(
  localPath: string | undefined,
  stored?: Resolution | null
): Resolution | null {
  if (stored) return stored;
  if (!localPath) return null;
  return detectResolution(path.basename(localPath));
}

function needsPreferredUpgrade(
  current: Resolution | null | undefined,
  preferred: Resolution
): boolean {
  if (!current) return false;
  return resolutionRank(current) < resolutionRank(preferred);
}

function movieForDownload(movie: Movie): Movie {
  const roots = movieRoots();
  return {
    ...slimMovieForDownload(movie),
    libraryPath: getMovieRoot(movie, roots[0] || '', roots),
  };
}

function tvRoots(s = getSettings()): string[] {
  return uniqueRoots(s.libraryRoots, s.libraryRoot);
}

function movieRoots(s = getSettings()): string[] {
  return uniqueRoots(s.movieLibraryRoots, s.movieLibraryRoot);
}

function withMovieLocalStatus(movie: Movie): Movie {
  const s = getSettings();
  return applyMovieLocalStatus(movie, s.movieLibraryRoot, downloadingMovieIds(), movieRoots(s));
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

/** Unset / undefined means monitored (back-compat for existing library). */
function isMonitored(item: { monitored?: boolean } | null | undefined): boolean {
  return item?.monitored !== false;
}


function shortInfoHash(hashOrMagnet?: string | null): string {
  const raw = (hashOrMagnet || '').trim();
  if (!raw) return '';
  const fromMagnet = extractInfoHash(raw);
  const h = (fromMagnet || raw).toLowerCase().replace(/[^a-f0-9]/g, '');
  return h ? h.slice(0, 8) : '';
}

function enabledTorrentSourceIds(settings: AppSettings): string[] {
  const src = { ...DEFAULT_TORRENT_SOURCES, ...(settings.torrentSources || {}) };
  return (Object.keys(src) as Array<keyof typeof src>).filter((k) => !!(src as any)[k]).map(String);
}

function sourcesInResults(results: Array<{ source?: string }> | undefined): string {
  const set = new Set<string>();
  for (const r of results || []) {
    if (r?.source) set.add(String(r.source));
  }
  return set.size ? Array.from(set).sort().join(',') : '(none)';
}

function describeTorrentChoice(
  best: {
    title?: string;
    magnet?: string;
    infoHash?: string;
    resolution?: Resolution | null;
    seeders?: number;
    source?: string;
  },
  opts: {
    preferred: Resolution;
    upgrade?: boolean;
    triedSkipped: number;
    healthyCount: number;
    mode: 'auto' | 'upgrade' | 'try-next' | 'manual';
  }
): string {
  const title = String(best.title || 'torrent').slice(0, 120);
  const hash = shortInfoHash(best.infoHash || best.magnet);
  const bits: string[] = [`"${title}"`];
  if (hash) bits.push(`hash ${hash}`);
  if (best.resolution) bits.push(String(best.resolution));
  else {
    const guessed = detectResolution(title);
    if (guessed) bits.push(guessed);
  }
  if (typeof best.seeders === 'number') bits.push(`${best.seeders} seeders`);
  if (best.source) bits.push(`via ${best.source}`);
  const why: string[] = [];
  if (opts.mode === 'try-next') why.push('next after abandon/reject');
  else if (opts.mode === 'upgrade' || opts.upgrade) why.push('upgrade hunt');
  else if (opts.mode === 'manual') why.push('manual start');
  else why.push('auto hunt');
  const res = best.resolution || detectResolution(title);
  if (res === opts.preferred) why.push(`preferred ${opts.preferred}`);
  else if (res) why.push(`${res} (preferred ${opts.preferred})`);
  else why.push(`preferred ${opts.preferred}`);
  if (typeof best.seeders === 'number') why.push(`${best.seeders} seeders`);
  if (opts.triedSkipped > 0) {
    why.push(`skipped ${opts.triedSkipped} tried hash${opts.triedSkipped === 1 ? '' : 'es'}`);
  }
  if (opts.healthyCount > 0) {
    why.push(`highest rank of ${opts.healthyCount} healthy`);
  }
  return `${bits.join(', ')} — ${why.join(', ')}`;
}

function cancelReasonFromError(error?: string | null): string {
  const e = (error || '').trim();
  if (!e) return 'rejected';
  if (/no progress for 1 hour/i.test(e)) return '1h no progress (stuck)';
  if (/below minimum|too small|resolution/i.test(e)) return `quality reject (${e})`;
  if (/\.exe|non-video|payload/i.test(e)) return `exe/payload reject (${e})`;
  return e;
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

function toHealthyPreferredCandidates(
  results: Array<{
    magnet: string;
    infoHash?: string;
    title?: string;
    seeders?: number;
    resolution?: Resolution | null;
    size?: number;
  }>,
  preferred: Resolution,
  kind: 'episode' | 'movie',
  show?: Show | null,
  upgradeOnly = false
): TorrentCandidate[] {
  const rules = qualityRules(kind, preferred, show);
  const filtered = upgradeOnly
    ? filterUpgradeResults(results as any, preferred, kind, rules)
    : filterQualityResults(results as any, preferred, kind, rules);
  return toCandidates(filtered);
}

function durableTriedKey(item: {
  kind?: string;
  movieId?: number;
  showId?: number;
  seasonNumber?: number;
  episodeNumber?: number;
}): string | null {
  if (item.kind === 'movie' && item.movieId != null) return triedMovieKey(item.movieId);
  if (item.showId != null && item.seasonNumber != null && item.episodeNumber != null) {
    return triedEpisodeKey(item.showId, item.seasonNumber, item.episodeNumber);
  }
  return null;
}

/** Persist rejected/cancelled/stuck infohashes for this episode/movie. */
function rememberTriedFromItem(item: DownloadItem): string[] {
  const key = durableTriedKey(item);
  if (!key) return item.triedInfoHashes || [];
  const hashes: string[] = [];
  if (item.infoHash) hashes.push(item.infoHash);
  const fromMagnet = extractInfoHash(item.magnet || '');
  if (fromMagnet) hashes.push(fromMagnet);
  for (const h of item.triedInfoHashes || []) hashes.push(h);
  return addTriedTorrents(key, hashes);
}

/** Cancel active/queued/paused downloads for an episode (e.g. user set Ignored). Remembers tried hashes. */
function cancelActiveDownloadsForEpisode(
  showId: number,
  season: number,
  episode: number,
  reason: string
): number {
  let n = 0;
  for (const item of downloadEngine.list()) {
    if (
      item.showId === showId &&
      item.seasonNumber === season &&
      item.episodeNumber === episode &&
      (item.status === 'downloading' || item.status === 'queued' || item.status === 'paused')
    ) {
      rememberTriedFromItem(item);
      downloadEngine.cancel(item.id);
      activityLog.info('download', `Cancel: ${item.name || `${showId} S${pad2(season)}E${pad2(episode)}`}`, {
        reason,
        infoHash: shortInfoHash(item.infoHash || item.magnet) || item.infoHash || '',
      });
      n += 1;
    }
  }
  if (n) pushDownloads({ persist: 'now' });
  return n;
}

function loadTriedForEpisode(showId: number, season: number, episode: number): string[] {
  return getTriedTorrents(triedEpisodeKey(showId, season, episode));
}

function loadTriedForMovie(movieId: number): string[] {
  return getTriedTorrents(triedMovieKey(movieId));
}

function filterResultsSkippingTried<T extends { magnet?: string; infoHash?: string }>(
  results: T[],
  tried: Iterable<string>
): T[] {
  const set = new Set(Array.from(tried).map((h) => h.toLowerCase()).filter(Boolean));
  if (!set.size) return results;
  return (results || []).filter((r) => {
    const h = (r.infoHash || extractInfoHash(r.magnet || '') || '').toLowerCase();
    return !h || !set.has(h);
  });
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
  // User Ignored must stop try-next even if a reject raced in after the override.
  if (
    item.showId != null &&
    item.seasonNumber != null &&
    item.episodeNumber != null &&
    getEpisodeOverride(item.showId, item.seasonNumber, item.episodeNumber) === 'ignored'
  ) {
    rememberTriedFromItem(item);
    activityLog.info('download', `Skip try-next: episode ignored — ${item.name}`, {
      reason: 'ignored',
      infoHash: shortInfoHash(item.infoHash || item.magnet) || item.infoHash || '',
    });
    pushDownloads({ persist: 'now' });
    return;
  }
  // Durable + in-memory tried set so the same magnet is never re-picked.
  const durable = rememberTriedFromItem(item);
  const tried = new Set(durable.map((h) => h.toLowerCase()));
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
          candidates = toHealthyPreferredCandidates(
            filterResultsSkippingTried(res.results, tried),
            preferred,
            'movie'
          );
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
          candidates = toHealthyPreferredCandidates(
            filterResultsSkippingTried(res.results, tried),
            preferred,
            'episode'
          );
          next = pickNextCandidate(candidates, tried, item.magnet);
        }
      }
    } catch {
      // search failure — fall through to "no alternative"
    }
  }

  const abandonReason = cancelReasonFromError(item.error);
  activityLog.warn('download', `Abandon: ${item.name}`, {
    reason: abandonReason,
    infoHash: shortInfoHash(item.infoHash || item.magnet) || item.infoHash || '',
    error: item.error || '',
  });
  notify(`Skipped: ${item.error || 'bad torrent'} — trying another for ${item.name}`, 'warn');

  if (!next?.magnet) {
    activityLog.warn('download', `No alternative after abandon: ${item.name}`, {
      reason: abandonReason,
      tried: tried.size,
    });
    notify(`No alternative torrents after skipping ${item.name}`, 'error');
    pushDownloads({ persist: 'now' });
    return;
  }

  const triedList = Array.from(tried);
  const preferredForNext = (
    item.kind === 'movie'
      ? (getMovies().find((m) => m.tmdbId === item.movieId)?.preferredResolution ||
          settings.defaultMovieResolution ||
          settings.defaultResolution)
      : (getShows().find((s) => s.tmdbId === item.showId)?.preferredResolution ||
          settings.defaultResolution)
  ) as Resolution;
  const nextRes = detectResolution(next.title || '');
  activityLog.info(
    'download',
    `Chose next: ${describeTorrentChoice(
      { title: next.title, magnet: next.magnet, infoHash: next.infoHash, resolution: nextRes },
      {
        preferred: preferredForNext,
        triedSkipped: triedList.length,
        healthyCount: candidates.length,
        mode: 'try-next',
      }
    )}`,
    { replacing: item.name, reason: abandonReason }
  );
  try {
    if (item.kind === 'movie' && item.movieId != null) {
      const movie = getMovies().find((m) => m.tmdbId === item.movieId);
      if (!movie) throw new Error('Movie not found');
      await downloadEngine.startMovie({
        magnet: next.magnet,
        movie: movieForDownload(movie),
        movieLibraryRoot: movieRoots(settings)[0] || settings.movieLibraryRoot,
        candidates,
        triedInfoHashes: triedList,
        quality: qualityRules(
          'movie',
          movie.preferredResolution || settings.defaultMovieResolution || settings.defaultResolution
        ),
      });
      upsertMovie(withMovieLocalStatus(movie));
      mainWindow?.webContents.send('movies:changed');
    } else {
      const show = getShows().find((s) => s.tmdbId === item.showId);
      if (!show) throw new Error('Show not found');
      await downloadEngine.start({
        magnet: next.magnet,
        show: showForDownload(show, item.seasonNumber),
        libraryRoot: tvRoots(settings)[0] || settings.libraryRoot,
        seasonNumber: item.seasonNumber,
        episodeNumber: item.episodeNumber,
        episodeTitle: item.episodeTitle,
        candidates,
        triedInfoHashes: triedList,
        quality: qualityRules('episode', show.preferredResolution || settings.defaultResolution, show),
      });
      emitLibraryChanged();
    }
    pushDownloads({ persist: 'now' });
  } catch (err) {
    activityLog.error(
      'download',
      `Failed to start next torrent for ${item.name}: ${err instanceof Error ? err.message : String(err)}`
    );
    notify(
      `Failed to start next torrent: ${err instanceof Error ? err.message : String(err)}`,
      'error'
    );
  }
}

async function maybeFtpUpload(localPath: string | undefined, label: string): Promise<void> {
  const settings = getSettings();
  if (!settings.ftpEnabled || !localPath) return;
  activityLog.info('ftp', `Upload start: ${label}`);
  try {
    await uploadFinishedFile(settings, localPath);
    activityLog.info('ftp', `Upload ok: ${label}`);
    notify(`FTP uploaded: ${label}`, 'ok');
  } catch (err) {
    // Local success stands; never undo. Never include password in message.
    activityLog.warn(
      'ftp',
      `Upload failed: ${label}: ${err instanceof Error ? err.message : String(err)}`
    );
    notify(`FTP upload failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
  }
}

function withLocalStatuses(show: Show): Show {
  const s = getSettings();
  return applyLocalStatuses(show, s.libraryRoot, downloadingKeys(), tvRoots(s));
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
    monitored: show.monitored,
  };
}

function listShowSummaries(): ShowListItem[] {
  const downloading = downloadingKeys();
  return getShows().map((s) => toShowListItem(s, downloading));
}

function listCalendarEpisodes(from: string, to: string): CalendarEpisode[] {
  const start = String(from || '').slice(0, 10);
  const end = String(to || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return [];
  const downloading = downloadingKeys();
  const items: CalendarEpisode[] = [];
  for (const show of getShows()) {
    for (const season of show.seasons || []) {
      for (const ep of season.episodes || []) {
        if (!ep.airDate) continue;
        const day = ep.airDate.slice(0, 10);
        if (day < start || day > end) continue;
        const key = episodeKey(show.tmdbId, ep.seasonNumber, ep.episodeNumber);
        items.push({
          tmdbId: show.tmdbId,
          showName: show.name,
          posterPath: show.posterPath,
          seasonNumber: ep.seasonNumber,
          episodeNumber: ep.episodeNumber,
          name: ep.name,
          airDate: day,
          status: downloading.has(key) ? 'downloading' : ep.status,
        });
      }
    }
  }
  items.sort((a, b) => {
    const d = a.airDate.localeCompare(b.airDate);
    if (d) return d;
    const s = a.showName.localeCompare(b.showName);
    if (s) return s;
    if (a.seasonNumber !== b.seasonNumber) return a.seasonNumber - b.seasonNumber;
    return a.episodeNumber - b.episodeNumber;
  });
  return items;
}

async function refreshOne(show: Show): Promise<Show> {
  const settings = getSettings();
  const detailed = await fetchShowDetail(
    show.tmdbId,
    settings.libraryRoot,
    show,
    downloadingKeys(),
    tvRoots(settings)
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
  if (!settings.autoDownload && !force) {
    activityLog.info('hunt', 'Auto hunt skipped: auto-download is off');
    return 0;
  }
  if (settings.vpnEnabled && settings.vpnRequireForTorrents && !vpnManager.isConnected()) {
    activityLog.info('hunt', 'Auto hunt held: VPN required but not connected', {
      vpnHold: true,
    });
    return 0;
  }
  if (autoDownloadRunning) {
    activityLog.info('hunt', 'Auto hunt skipped: already running');
    return 0;
  }
  autoDownloadRunning = true;
  let started = 0;
  const sourceIds = enabledTorrentSourceIds(settings);
  activityLog.info(
    'hunt',
    `Auto hunt start: ${shows.length} show(s)${force ? ' (forced)' : ''}`,
    { sources: sourceIds.join(',') || '(none)' }
  );
  try {
    const delayMs = Math.max(0, (settings.autoDownloadDelayMinutes || 0) * 60 * 1000);
    for (const show of shows) {
      // Per-show pause: skip hunting unless this is an explicit Telegram/web approval force.
      if (!isMonitored(show) && !force) {
        activityLog.info('hunt', `Skipped show: ${show.name} (monitoring paused)`);
        continue;
      }
      const preferred = (show.preferredResolution || settings.defaultResolution) as Resolution;
      const rules = qualityRules('episode', preferred, show);
      type EpJob = { ep: Episode; upgrade: boolean };
      const jobs: EpJob[] = [];
      let ignored = 0;
      let alreadyDl = 0;
      let haveOk = 0;
      for (const season of show.seasons || []) {
        for (const ep of season.episodes || []) {
          if (
            ep.status === 'ignored' ||
            getEpisodeOverride(show.tmdbId, ep.seasonNumber, ep.episodeNumber) === 'ignored'
          ) {
            ignored += 1;
            continue;
          }
          if (downloadEngine.hasEpisodeActivity(show.tmdbId, ep.seasonNumber, ep.episodeNumber)) {
            alreadyDl += 1;
            continue;
          }
          if (ep.status === 'missing' || ep.status === 'aired') {
            jobs.push({ ep, upgrade: false });
            continue;
          }
          // Keep hunting preferred when library copy is below preferred (e.g. grabbed at minimum).
          if (ep.status === 'downloaded') {
            const current = currentLibraryResolution(ep.localPath, ep.downloadedResolution);
            if (needsPreferredUpgrade(current, preferred)) {
              jobs.push({ ep, upgrade: true });
            } else {
              haveOk += 1;
            }
          }
        }
      }
      activityLog.info(
        'hunt',
        `Scan show: ${show.name} — ${jobs.length} to check (${jobs.filter((j) => j.upgrade).length} upgrade), skipped ${ignored} ignored / ${alreadyDl} already downloading / ${haveOk} have preferred`,
        { preferred, mazeId: show.tmdbId }
      );
      for (const { ep, upgrade } of jobs) {
        const epLabel = `${show.name} S${pad2(ep.seasonNumber)}E${pad2(ep.episodeNumber)}`;
        if (downloadEngine.hasEpisodeActivity(show.tmdbId, ep.seasonNumber, ep.episodeNumber)) {
          activityLog.info('hunt', `Skipped ${epLabel}: already downloading`);
          continue;
        }
        try {
          activityLog.info(
            'hunt',
            `Checking episode: ${epLabel} (${upgrade ? 'upgrade' : 'missing'})`,
            { preferred, sources: sourceIds.join(',') || '(none)' }
          );
          const { results, error: searchErr } = await searchEpisodeTorrents(
            settings,
            show.name,
            ep.seasonNumber,
            ep.episodeNumber,
            preferred,
            { imdbId: show.imdbId, mazeId: show.tmdbId }
          );
          const triedList = loadTriedForEpisode(show.tmdbId, ep.seasonNumber, ep.episodeNumber);
          const pool = filterResultsSkippingTried(results, triedList);
          const triedSkipped = (results?.length || 0) - pool.length;
          activityLog.info(
            'search',
            `Auto episode search: ${epLabel} — ${results?.length || 0} result(s)`,
            {
              sourcesHit: sourcesInResults(results),
              triedSkipped,
              error: searchErr || '',
            }
          );
          const best = upgrade
            ? pickUpgradeDownload(pool, preferred, 'episode', rules)
            : pickAutoDownload(pool, preferred, 'episode', rules);
          if (!best?.magnet) {
            activityLog.info(
              'hunt',
              `Skipped ${epLabel}: no candidates — ${summarizeAutoRejects(pool, preferred, 'episode', rules, {
                upgrade,
                triedSkipped,
              })}`
            );
            continue;
          }
          const candidates = toHealthyPreferredCandidates(
            pool,
            preferred,
            'episode',
            show,
            upgrade
          );
          activityLog.info(
            'download',
            `Chose torrent: ${describeTorrentChoice(best, {
              preferred,
              upgrade,
              triedSkipped,
              healthyCount: candidates.length,
              mode: upgrade ? 'upgrade' : 'auto',
            })}`,
            { episode: epLabel }
          );
          await downloadEngine.start({
            magnet: best.magnet,
            show: showForDownload(show, ep.seasonNumber),
            libraryRoot: tvRoots(settings)[0] || settings.libraryRoot,
            seasonNumber: ep.seasonNumber,
            episodeNumber: ep.episodeNumber,
            episodeTitle: ep.name,
            candidates,
            triedInfoHashes: triedList,
            notifyChatId: notifyCtx?.notifyChatId,
            telegramRequestId: notifyCtx?.telegramRequestId,
            quality: rules,
          });
          started += 1;
          pushDownloads({ persist: 'now' });
          notify(
            `${upgrade ? 'Upgrade' : 'Auto-download'}: ${show.name} S${pad2(ep.seasonNumber)}E${pad2(ep.episodeNumber)}`,
            'ok'
          );
          if (delayMs > 0) await sleep(delayMs);
          else await sleep(800);
        } catch (err) {
          activityLog.warn(
            'hunt',
            `Episode check failed: ${epLabel}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
  } finally {
    autoDownloadRunning = false;
  }
  activityLog.info('hunt', `Auto hunt done: started ${started} download(s)`);
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
    downloadingMovieIds(),
    movieRoots(settings)
  );
  upsertMovie(movie);
  mainWindow?.webContents.send('movies:changed');
  return withMovieLocalStatus(movie);
}

async function autoDownloadMovie(
  movie: Movie,
  notifyCtx?: AutoDownloadNotify,
  opts?: { allowUpgrade?: boolean }
): Promise<boolean> {
  const settings = getSettings();
  const force = !!(notifyCtx?.notifyChatId || notifyCtx?.telegramRequestId);
  if (!isMonitored(movie) && !force) {
    activityLog.info('hunt', `Skipped movie: ${movie.title} (monitoring paused)`);
    return false;
  }
  if (settings.vpnEnabled && settings.vpnRequireForTorrents && !vpnManager.isConnected()) {
    activityLog.info('hunt', `Auto movie hunt held: ${movie.title} (VPN required but not connected)`, {
      vpnHold: true,
    });
    return false;
  }
  if (downloadEngine.hasMovieActivity(movie.tmdbId)) {
    activityLog.info('hunt', `Skipped movie: ${movie.title} (already downloading)`);
    return false;
  }
  const preferred = (movie.preferredResolution ||
    settings.defaultMovieResolution ||
    settings.defaultResolution) as Resolution;
  const live = withMovieLocalStatus(movie);
  const upgrade =
    !!opts?.allowUpgrade &&
    live.status === 'downloaded' &&
    needsPreferredUpgrade(
      currentLibraryResolution(live.localPath, live.downloadedResolution),
      preferred
    );
  // Missing/forced downloads always; upgrades only when allowUpgrade.
  if (live.status === 'downloaded' && !upgrade) {
    activityLog.info('hunt', `Skipped movie: ${movie.title} (already have / no upgrade needed)`);
    return false;
  }
  if (live.status !== 'missing' && live.status !== 'downloaded' && !notifyCtx) {
    activityLog.info('hunt', `Skipped movie: ${movie.title} (status ${live.status})`);
    return false;
  }
  const sourceIds = enabledTorrentSourceIds(settings);
  activityLog.info(
    'hunt',
    `Checking movie: ${movie.title}${movie.releaseYear ? ` (${movie.releaseYear})` : ''} (${upgrade ? 'upgrade' : 'missing'})`,
    { preferred, sources: sourceIds.join(',') || '(none)' }
  );
  const res = await searchMovieTorrents(
    settings,
    movie.title,
    movie.releaseYear,
    preferred
  );
  const rules = qualityRules('movie', preferred);
  const triedList = loadTriedForMovie(movie.tmdbId);
  const pool = filterResultsSkippingTried(res.results, triedList);
  const triedSkipped = (res.results?.length || 0) - pool.length;
  activityLog.info(
    'search',
    `Auto movie search: ${movie.title} — ${res.results?.length || 0} result(s)`,
    {
      sourcesHit: sourcesInResults(res.results),
      triedSkipped,
      error: res.error || '',
    }
  );
  const best = upgrade
    ? pickUpgradeDownload(pool, preferred, 'movie', rules)
    : pickAutoDownload(pool, preferred, 'movie', rules);
  if (!best?.magnet) {
    activityLog.info(
      'hunt',
      `Skipped movie ${movie.title}: no candidates — ${summarizeAutoRejects(pool, preferred, 'movie', rules, {
        upgrade,
        triedSkipped,
      })}`
    );
    return false;
  }
  const candidates = toHealthyPreferredCandidates(pool, preferred, 'movie', null, upgrade);
  activityLog.info(
    'download',
    `Chose torrent: ${describeTorrentChoice(best, {
      preferred,
      upgrade,
      triedSkipped,
      healthyCount: candidates.length,
      mode: upgrade ? 'upgrade' : 'auto',
    })}`,
    { movie: movie.title }
  );
  await downloadEngine.startMovie({
    magnet: best.magnet,
    movie: movieForDownload(movie),
    movieLibraryRoot: movieRoots(settings)[0] || settings.movieLibraryRoot,
    candidates,
    triedInfoHashes: triedList,
    notifyChatId: notifyCtx?.notifyChatId,
    telegramRequestId: notifyCtx?.telegramRequestId,
    quality: rules,
  });
  upsertMovie(withMovieLocalStatus(movie));
  pushDownloads({ persist: 'now' });
  mainWindow?.webContents.send('movies:changed');
  if (upgrade) {
    notify(`Upgrade: ${movie.title}`, 'ok');
  }
  return true;
}

async function autoUpgradeMovies(): Promise<number> {
  const settings = getSettings();
  if (!settings.autoDownload) return 0;
  if (settings.vpnEnabled && settings.vpnRequireForTorrents && !vpnManager.isConnected()) {
    activityLog.info('hunt', 'Movie upgrade hunt held: VPN required but not connected', {
      vpnHold: true,
    });
    return 0;
  }
  const movies = getMovies();
  activityLog.info('hunt', `Movie upgrade hunt start: ${movies.length} movie(s)`);
  let started = 0;
  for (const movie of movies) {
    try {
      const ok = await autoDownloadMovie(movie, undefined, { allowUpgrade: true });
      if (ok) {
        started += 1;
        await sleep(800);
      }
    } catch (err) {
      activityLog.warn(
        'hunt',
        `Movie upgrade check failed: ${movie.title}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  activityLog.info('hunt', `Movie upgrade hunt done: started ${started}`);
  return started;
}

function newTelegramRequestId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function formatRequestLine(r: TelegramRequest): string {
  const type = r.mediaType === 'movie' ? 'Movie' : 'TV';
  const year = r.year ? ` (${r.year})` : '';
  return `[${r.id}] ${type}: ${r.title}${year} — ${r.status}`;
}

function emitRequestsChanged() {
  mainWindow?.webContents.send('requests:changed');
}

/** Resolve poster for a request from library or TVMaze/IMDb; persist if found. */
async function resolveRequestPoster(req: TelegramRequest): Promise<string | null> {
  if ((req.posterUrl || '').trim()) return req.posterUrl || null;
  try {
    if (req.mediaType === 'show') {
      const inLib = getShows().find((s) => s.tmdbId === req.mediaId);
      if (inLib?.posterPath) return inLib.posterPath;
      const res = await fetch(`https://api.tvmaze.com/shows/${req.mediaId}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return null;
      const detail = (await res.json()) as {
        image?: { medium?: string | null; original?: string | null } | null;
      };
      return detail.image?.medium || detail.image?.original || null;
    }
    const inLib = getMovies().find((m) => m.tmdbId === req.mediaId);
    if (inLib?.posterPath) return inLib.posterPath;
    const settings = getSettings();
    const detail = await fetchMovieDetail(
      req.mediaId,
      settings.movieLibraryRoot || '',
      null,
      new Set(),
      movieRoots(settings)
    );
    return detail.posterPath || null;
  } catch {
    return null;
  }
}

async function enrichTelegramRequests(requests: TelegramRequest[]): Promise<TelegramRequest[]> {
  const out: TelegramRequest[] = [];
  let changed = false;
  for (const req of requests) {
    if ((req.posterUrl || '').trim()) {
      out.push(req);
      continue;
    }
    const posterUrl = await resolveRequestPoster(req);
    if (posterUrl) {
      const updated = { ...req, posterUrl };
      upsertTelegramRequest(updated);
      out.push(updated);
      changed = true;
    } else {
      out.push(req);
    }
  }
  if (changed) emitRequestsChanged();
  return out;
}

function pickLanIpv4(): string | null {
  try {
    const nets = os.networkInterfaces();
    for (const entries of Object.values(nets)) {
      for (const e of entries || []) {
        if (e && !e.internal && (e.family === 'IPv4' || e.family === 4)) return e.address;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function ensureWebPortalSecrets(settings: AppSettings): AppSettings {
  let next = settings;
  if (!(next.webPortalSessionSecret || '').trim()) {
    next = setSettings({ webPortalSessionSecret: randomBytes(24).toString('hex') });
  }
  return next;
}

function applySettingsSideEffects(next: AppSettings): void {
  scheduleRefresh();
  applyLoginItem(!!next.launchOnStartup);
  const crashTask = applyCrashRestartTask(!!next.restartOnCrash);
  if (next.restartOnCrash && !crashTask.ok) {
    notify(`Could not register crash-restart task: ${crashTask.message}`, 'warn');
  }
  telegramBot.sync(next);
  const portalSettings = ensureWebPortalSecrets(next);
  webPortal.sync(portalSettings);
  activityLog.info('portal', 'Web portal settings applied', {
    enabled: !!portalSettings.webPortalEnabled,
  });
  liveTv.sync(next);
  downloadEngine.applySettings({
    maxConnections: next.maxConnections,
    maxDownloadSpeedKBps: next.maxDownloadSpeedKBps,
    maxUploadSpeedKBps: next.maxUploadSpeedKBps,
    bindAddress: vpnManager.getBindAddress(),
    bindIfIndex: vpnManager.getBindIfIndex(),
    vpnHold: !!(next.vpnEnabled && next.vpnRequireForTorrents && !vpnManager.isConnected()),
    processFolder: next.processFolder || '',
  });
  configureUpdaterFeed();
  if (!next.vpnEnabled) {
    void vpnManager.disconnect();
  }
  pushVpnStatus(next);
}


async function refreshAllShows(): Promise<Show[]> {
  activityLog.info('library', 'Scheduled/manual refresh all + auto hunt');
  const updated: Show[] = [];
  for (const show of getShows()) {
    try {
      updated.push(await refreshOne(show));
    } catch (err) {
      activityLog.warn(
        'library',
        `Refresh failed: ${show.name}: ${err instanceof Error ? err.message : String(err)}`
      );
      updated.push(show);
    }
    await new Promise<void>((r) => setImmediate(r));
  }
  emitLibraryChanged();
  await autoDownloadForShows(updated);
  await autoUpgradeMovies();
  activityLog.info('library', `Refresh all finished (${updated.length} show(s))`);
  return updated;
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const minutes = getSettings().refreshIntervalMinutes;
  if (!minutes || minutes <= 0) {
    activityLog.info('library', 'Scheduled refresh disabled');
    return;
  }
  activityLog.info('library', `Scheduled refresh every ${minutes} min`);
  refreshTimer = setInterval(() => {
    void refreshAllShows().catch(() => undefined);
  }, minutes * 60 * 1000);
}

function formatSpeed(bps: number): string {
  if (!bps || bps < 1024) return `${Math.round(bps || 0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}



/** Resume incomplete torrents persisted from the previous session / after an update. */
async function restorePersistedDownloads(): Promise<void> {
  const pending = (getDownloads() || []).filter(
    (d) =>
      d?.magnet &&
      d.savePath &&
      (d.status === 'downloading' || d.status === 'queued' || d.status === 'paused')
  );
  if (!pending.length) {
    activityLog.info('download', 'Restore: no persisted downloads');
    return;
  }
  activityLog.info('download', `Restore: ${pending.length} persisted download(s)`);
  const settings = getSettings();
  let restored = 0;
  for (const item of pending) {
    try {
      if (item.kind === 'movie' && item.movieId != null) {
        const movie = getMovies().find((m) => m.tmdbId === item.movieId);
        if (!movie) continue;
        const triedMovie = Array.from(
          new Set([...(item.triedInfoHashes || []), ...loadTriedForMovie(item.movieId!)])
        );
        await downloadEngine.restore(item, {
          magnet: item.magnet,
          movie: movieForDownload(movie),
          movieLibraryRoot: movieRoots(settings)[0] || settings.movieLibraryRoot,
          candidates: item.candidates,
          triedInfoHashes: triedMovie,
          notifyChatId: item.notifyChatId,
          telegramRequestId: item.telegramRequestId,
          quality: qualityRules('movie', movie.preferredResolution),
        });
        restored += 1;
      } else if (item.showId != null && item.seasonNumber != null && item.episodeNumber != null) {
        const show = getShows().find((s) => s.tmdbId === item.showId);
        if (!show) continue;
        const triedEp = Array.from(
          new Set([
            ...(item.triedInfoHashes || []),
            ...loadTriedForEpisode(item.showId, item.seasonNumber, item.episodeNumber),
          ])
        );
        await downloadEngine.restore(item, {
          magnet: item.magnet,
          show: showForDownload(show, item.seasonNumber),
          libraryRoot: tvRoots(settings)[0] || settings.libraryRoot,
          seasonNumber: item.seasonNumber,
          episodeNumber: item.episodeNumber,
          episodeTitle: item.episodeTitle || '',
          candidates: item.candidates,
          triedInfoHashes: triedEp,
          notifyChatId: item.notifyChatId,
          telegramRequestId: item.telegramRequestId,
          quality: qualityRules('episode', show.preferredResolution, show),
        });
        restored += 1;
      }
    } catch (err) {
      console.error('[downloads] restore failed', item.id, err);
    }
  }
  if (restored) {
    pushDownloads({ persist: 'now' });
    notify(`Resumed ${restored} download${restored === 1 ? '' : 's'} from last session`, 'info');
  }
  activityLog.info('download', `Restore done: ${restored} resumed`);
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
  let show = await fetchShowDetail(mazeId, settings.libraryRoot, shell, downloadingKeys(), tvRoots(settings));
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
    downloadingMovieIds(),
    movieRoots(settings)
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
        let show = await importShowFromScan(item.matchId, item.folderPath);
        // Bulk folder import only: mark past aired (no local file) as ignored so we don't snatch the back catalog.
        const ignoreEntries = ignoreAiredEpisodes(show);
        if (Object.keys(ignoreEntries).length) {
          setEpisodeOverridesBulk(ignoreEntries);
          show = withLocalStatuses(show);
          upsertShow(show);
        }
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
  let show = await fetchShowDetail(mazeId, settings.libraryRoot, existing, downloadingKeys(), tvRoots(settings));
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

/** Configure electron-updater for public remie1529/Nightfeed Releases (no token). */
function configureUpdaterFeed(): void {
  try {
    delete process.env.GH_TOKEN;
  } catch {
    // ignore
  }
  autoUpdater.setFeedURL({ ...UPDATE_FEED });
  autoUpdater.requestHeaders = undefined as any;
}

function formatUpdateError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/\b401\b|Unauthorized/i.test(msg)) {
    return 'Update check returned 401. Releases are public — try again later or check GitHub status.';
  }
  return msg;
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  // Prefer full installer download; differential .blockmap can hang on some feeds.
  (autoUpdater as any).disableDifferentialDownload = true;
  autoUpdater.logger = {
    info: (m: unknown) => console.log('[updater]', m),
    warn: (m: unknown) => console.warn('[updater]', m),
    error: (m: unknown) => console.error('[updater]', m),
    debug: (m: unknown) => console.log('[updater]', m),
  } as any;

  autoUpdater.on('checking-for-update', () => {
    updateState.checking = true;
    updateState.error = null;
    updateState.message = 'Checking for updates…';
    activityLog.info('updater', 'Checking for updates');
    pushUpdateStatus();
  });

  autoUpdater.on('update-available', (info) => {
    updateState.checking = false;
    updateState.available = true;
    updateState.downloaded = false;
    updateState.progress = 0;
    updateState.version = info.version || null;
    updateState.message = `Update ${info.version} available — downloading…`;
    activityLog.info('updater', `Update available: v${info.version}`);
    pushUpdateStatus();
    notify(`Update ${info.version} found — downloading installer…`, 'info');
    void downloadAppUpdate();
  });

  autoUpdater.on('update-not-available', (info) => {
    updateState.checking = false;
    updateState.available = false;
    updateState.progress = null;
    updateState.version = info.version || app.getVersion();
    updateState.message = `Up to date (v${info.version || app.getVersion()})`;
    activityLog.info('updater', `Up to date (v${info.version || app.getVersion()})`);
    pushUpdateStatus();
  });

  autoUpdater.on('download-progress', (prog) => {
    const pct = Math.max(0, Math.min(100, Math.round(prog.percent || 0)));
    updateState.available = true;
    updateState.progress = pct;
    updateState.message = `Downloading update ${updateState.version || ''}… ${pct}%`;
    pushUpdateStatus();
  });

  autoUpdater.on('error', (err) => {
    updateState.checking = false;
    updateState.progress = null;
    updateState.error = formatUpdateError(err);
    updateState.message = updateState.error;
    activityLog.error('updater', `Update error: ${updateState.error}`);
    pushUpdateStatus();
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateState.checking = false;
    updateState.available = true;
    updateState.downloaded = true;
    updateState.progress = 100;
    updateState.version = info.version || updateState.version;
    updateState.error = null;
    updateState.message = `Update ${updateState.version} ready — restart to install`;
    activityLog.info('updater', `Update downloaded: v${updateState.version}`);
    pushUpdateStatus();
    notify(`Update ${updateState.version} ready — restart to install`, 'ok');
  });
}

async function downloadAppUpdate(): Promise<UpdateStatus> {
  configureUpdaterFeed();
  if (updateState.downloaded) return { ...updateState };
  updateState.available = true;
  updateState.error = null;
  updateState.progress = updateState.progress ?? 0;
  updateState.message = `Downloading update ${updateState.version || ''}…`;
  pushUpdateStatus();
  try {
    await autoUpdater.downloadUpdate();
  } catch (e) {
    updateState.error = formatUpdateError(e);
    updateState.message = updateState.error;
    updateState.progress = null;
    pushUpdateStatus();
  }
  return { ...updateState };
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
          '/status — library + downloads + VPN',
          '/shows — tracked shows',
          '/movies — tracked movies',
          '/missing — missing/aired episodes',
          '/check — refresh metadata (+ auto-download)',
          '/downloads — download progress',
          '/pause — pause all downloads',
          '/resume — resume queued downloads',
          '/vpn — OpenVPN status',
          '/search <query> — search TV + movies (with posters)',
          '/add <show> — add a TV show',
          '/add-movie <title> — add a movie',
          '/request-show <name> — submit a TV request',
          '/request-movie <name> — submit a movie request',
          '/approve <id>  /deny <id>  /requests',
          '/help — this list',
        ].join('\n')
      );
    },
    async helpRequests(chatId, _args, reply) {
      await reply(
        chatId,
        [
          'Nightfeed bot (requests)',
          '/request-show <name> — request a TV show',
          '/request-movie <name> — request a movie',
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
      const vpn = vpnManager.getStatus(settings);
      await reply(
        chatId,
        [
          `Shows: ${shows.length}`,
          `Movies: ${getMovies().length}`,
          `Missing/aired episodes: ${missing}`,
          `Active downloads: ${active.length}`,
          `Pending requests: ${pending}`,
          `Auto-download: ${settings.autoDownload ? 'on' : 'off'}`,
          `VPN: ${vpn.state}${vpn.killSwitch ? ' · kill switch ON' : ''}`,
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
      const movies = getMovies();
      if (!movies.length) {
        await reply(chatId, 'No tracked movies.');
        return;
      }
      const lines = movies.slice(0, 40).map((m, i) => {
        const year = m.releaseYear ? ` (${m.releaseYear})` : '';
        return `${i + 1}. ${m.title}${year} — ${m.status}`;
      });
      if (movies.length > 40) lines.push(`…and ${movies.length - 40} more`);
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
      const caption = `<b>Added show</b>\n${escapeHtml(show.name)}`;
      const settings = getSettings();
      if (show.posterPath) {
        await telegramBot.notifyChat(settings, chatId, caption, show.posterPath);
      } else {
        await reply(chatId, `Added: ${show.name}`);
      }
      if (results.length > 1) {
        const others = results.slice(1, 5);
        await reply(chatId, `Other matches — tap to add:`, {
          reply_markup: {
            inline_keyboard: others.map((r) => [
              {
                text: `${r.name}${r.firstAirDate ? ` (${r.firstAirDate.slice(0, 4)})` : ''}`,
                callback_data: `addshow:${r.id}`,
              },
            ]),
          },
        });
      }
    },
    async addMovie(chatId, args, reply) {
      if (!args.trim()) {
        await reply(chatId, 'Usage: /add-movie <title>');
        return;
      }
      const results = await searchMoviesMeta(args.trim());
      if (!results.length) {
        await reply(chatId, `No movies found for “${args.trim()}”.`);
        return;
      }
      const best = results[0];
      const movie = await addMovieById(best.id);
      const year = movie.releaseYear ? ` (${movie.releaseYear})` : '';
      const caption = `<b>Added movie</b>\n${escapeHtml(movie.title)}${year}`;
      const settings = getSettings();
      if (movie.posterPath) {
        await telegramBot.notifyChat(settings, chatId, caption, movie.posterPath);
      } else {
        await reply(chatId, `Added: ${movie.title}${year}`);
      }
      if (results.length > 1) {
        const others = results.slice(1, 5);
        await reply(chatId, `Other matches — tap to add:`, {
          reply_markup: {
            inline_keyboard: others.map((r) => [
              {
                text: `${r.title}${r.releaseYear ? ` (${r.releaseYear})` : ''}`,
                callback_data: `addmovie:${r.id}`,
              },
            ]),
          },
        });
      }
    },
    async search(chatId, args, reply) {
      if (!args.trim()) {
        await reply(chatId, 'Usage: /search <title>');
        return;
      }
      const q = args.trim();
      const [shows, movies] = await Promise.all([searchShowsMeta(q), searchMoviesMeta(q)]);
      if (!shows.length && !movies.length) {
        await reply(chatId, `Nothing found for “${q}”.`);
        return;
      }
      const top = shows[0] || movies[0];
      const topPoster = top && 'posterUrl' in top ? top.posterUrl : null;
      const caption = [
        `<b>Search</b> ${escapeHtml(q)}`,
        shows[0] ? `TV: ${escapeHtml(shows[0].name)}` : '',
        movies[0] ? `Movie: ${escapeHtml(movies[0].title)}${movies[0].releaseYear ? ` (${movies[0].releaseYear})` : ''}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      const settings = getSettings();
      if (topPoster) await telegramBot.notifyChat(settings, chatId, caption, topPoster);
      else await reply(chatId, caption.replace(/<[^>]+>/g, ''));
      const rows: Array<Array<{ text: string; callback_data: string }>> = [];
      for (const s of shows.slice(0, 3)) {
        rows.push([{ text: `TV · ${s.name}`, callback_data: `addshow:${s.id}` }]);
      }
      for (const m of movies.slice(0, 3)) {
        rows.push([
          {
            text: `Movie · ${m.title}${m.releaseYear ? ` (${m.releaseYear})` : ''}`,
            callback_data: `addmovie:${m.id}`,
          },
        ]);
      }
      if (rows.length) {
        await reply(chatId, 'Tap to add to the library:', {
          reply_markup: { inline_keyboard: rows },
        });
      }
    },
    async vpn(chatId, _args, reply) {
      const s = getSettings();
      const st = vpnManager.getStatus(s);
      await reply(
        chatId,
        [
          `VPN: ${s.vpnEnabled ? 'enabled' : 'off'}`,
          `State: ${st.state}${st.message ? ` — ${st.message}` : ''}`,
          `Require for torrents: ${s.vpnRequireForTorrents ? 'on' : 'off'}`,
          `Kill switch: ${st.killSwitch ? 'ON — torrents paused' : 'off'}`,
          st.bindAddress ? `Torrent bind: ${st.bindAddress}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      );
    },
    async pause(chatId, _args, reply) {
      const items = downloadEngine.list().filter((d) => d.status === 'downloading' || d.status === 'queued');
      for (const d of items) downloadEngine.pause(d.id);
      pushDownloads({ persist: 'now' });
      await reply(chatId, items.length ? `Paused ${items.length} download(s).` : 'Nothing to pause.');
    },
    async resume(chatId, _args, reply) {
      try {
        assertVpnAllowsTorrents();
      } catch (e) {
        await reply(chatId, e instanceof Error ? e.message : String(e));
        return;
      }
      const items = downloadEngine.list().filter((d) => d.status === 'paused');
      for (const d of items) downloadEngine.resume(d.id);
      pushDownloads({ persist: 'now' });
      await reply(chatId, items.length ? `Resumed ${items.length} download(s).` : 'Nothing paused.');
    },
    async missing(chatId, _args, reply) {
      const lines: string[] = [];
      for (const s of getShows()) {
        for (const season of s.seasons || []) {
          for (const ep of season.episodes || []) {
            if (ep.status !== 'missing' && ep.status !== 'aired') continue;
            lines.push(`${s.name} S${pad2(ep.seasonNumber)}E${pad2(ep.episodeNumber)} — ${ep.name}`);
            if (lines.length >= 25) break;
          }
          if (lines.length >= 25) break;
        }
        if (lines.length >= 25) break;
      }
      await reply(chatId, lines.length ? lines.join('\n') : 'No missing/aired episodes.');
    },
    async request(chatId, args, reply, meta) {
      const raw = (args || '').trim();
      if (!raw) {
        await reply(
          chatId,
          'Usage:\n/request-show <name>\n/request-movie <name>'
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
          `Is “${query}” a show or a movie?\nUse:\n/request-show ${query}\nor\n/request-movie ${query}`
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
        const year = best.firstAirDate ? Number(best.firstAirDate.slice(0, 4)) || null : null;
        const result = await submitPendingMediaRequest({
          mediaType: 'show',
          mediaId: best.id,
          title: best.name,
          year,
          overview: best.overview,
          posterUrl: best.posterUrl || null,
          requesterChatId: chatId,
          requesterName: meta?.fromName,
          source: 'telegram',
        });
        await reply(chatId, result.message);
        return;
      }

      const results = await searchMoviesMeta(query);
      if (!results.length) {
        await reply(chatId, `No movies found for “${query}”.`);
        return;
      }
      const best = results[0];
      const result = await submitPendingMediaRequest({
        mediaType: 'movie',
        mediaId: best.id,
        title: best.title,
        year: best.releaseYear,
        overview: best.overview,
        posterUrl: best.posterUrl || null,
        requesterChatId: chatId,
        requesterName: meta?.fromName,
        source: 'telegram',
      });
      await reply(chatId, result.message);
    },
    async myrequests(chatId, args, reply) {
      const settings = getSettings();
      const adminIds = parseChatIds(
        (settings.telegramAdminChatIds || '').trim() ||
          (settings.telegramAllowedChatIds || '').trim()
      );
      const chatToken = normalizeChatIdToken(String(chatId));
      const isAdmin = !!(chatToken && adminIds.has(chatToken));
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
        await reply(chatId, 'You have no requests yet. Try /request-show <name>');
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
      const raw = (data || '').trim();
      const addShow = /^addshow:(\d+)$/.exec(raw);
      if (addShow) {
        const show = await addShowWithPolicy(Number(addShow[1]), 'manual');
        const cap = `<b>Added show</b>\n${escapeHtml(show.name)}`;
        if (show.posterPath) await telegramBot.notifyChat(getSettings(), chatId, cap, show.posterPath);
        else await reply(chatId, `Added: ${show.name}`);
        return;
      }
      const addMovie = /^addmovie:(\d+)$/.exec(raw);
      if (addMovie) {
        const movie = await addMovieById(Number(addMovie[1]));
        const year = movie.releaseYear ? ` (${movie.releaseYear})` : '';
        const cap = `<b>Added movie</b>\n${escapeHtml(movie.title)}${year}`;
        if (movie.posterPath) await telegramBot.notifyChat(getSettings(), chatId, cap, movie.posterPath);
        else await reply(chatId, `Added: ${movie.title}${year}`);
        return;
      }
      const m = /^(approve|deny):(.+)$/.exec(raw);
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
  wireWebPortal();
}

function wireWebPortal() {
  webPortal.setDeps({
    getSettings,
    searchShows: async (query) => {
      const results = await searchShowsMeta(query);
      return results.map((r) => ({
        id: r.id,
        name: r.name,
        overview: r.overview,
        firstAirDate: r.firstAirDate,
        posterUrl: r.posterUrl || null,
      }));
    },
    searchMovies: async (query) => {
      const results = await searchMoviesMeta(query);
      return results.map((r) => ({
        id: r.id,
        title: r.title,
        overview: r.overview,
        releaseYear: r.releaseYear,
        posterUrl: r.posterUrl || null,
      }));
    },
    isInLibrary: (mediaType, mediaId) => {
      if (mediaType === 'show') return getShows().some((s) => s.tmdbId === mediaId);
      return getMovies().some((m) => m.tmdbId === mediaId);
    },
    submitRequest: async (input) =>
      submitPendingMediaRequest({
        ...input,
        requesterChatId: 0,
        source: 'web',
      }),
    listRequests: () => getTelegramRequests(),
    enrichRequests: (requests) => enrichTelegramRequests(requests),
    resolveRequest: async (id, action) => resolveTelegramRequest(id, action, 0),
  });
  webPortal.sync(ensureWebPortalSecrets(getSettings()));
  liveTv.sync(getSettings());
}


async function submitPendingMediaRequest(input: {
  mediaType: 'show' | 'movie';
  mediaId: number;
  title: string;
  year?: number | null;
  overview?: string;
  posterUrl?: string | null;
  requesterChatId: number;
  requesterName?: string;
  requesterClientId?: string;
  source: 'telegram' | 'web';
}): Promise<{ ok: boolean; message: string; request?: TelegramRequest; alreadyAvailable?: boolean }> {
  const existingShow =
    input.mediaType === 'show'
      ? getShows().find((s) => s.tmdbId === input.mediaId)
      : undefined;
  const existingMovie =
    input.mediaType === 'movie'
      ? getMovies().find((m) => m.tmdbId === input.mediaId)
      : undefined;
  if (existingShow) {
    return {
      ok: false,
      alreadyAvailable: true,
      message: `Already available in the library: ${existingShow.name}`,
    };
  }
  if (existingMovie) {
    return {
      ok: false,
      alreadyAvailable: true,
      message: `Already available in the library: ${existingMovie.title}`,
    };
  }

  const pendingDup = getTelegramRequests().find((r) => {
    if (r.status !== 'pending' || r.mediaType !== input.mediaType || r.mediaId !== input.mediaId) {
      return false;
    }
    if (input.source === 'web') {
      if (!input.requesterClientId) return false;
      return r.requesterClientId === input.requesterClientId;
    }
    return r.requesterChatId === input.requesterChatId;
  });
  if (pendingDup) {
    return {
      ok: false,
      message: `You already have a pending request: ${pendingDup.title} (${pendingDup.id})`,
    };
  }

  const req: TelegramRequest = {
    id: newTelegramRequestId(),
    mediaType: input.mediaType,
    mediaId: input.mediaId,
    title: input.title,
    year: input.year ?? null,
    overview: input.overview,
    posterUrl: input.posterUrl || null,
    requesterChatId: input.requesterChatId,
    requesterName: input.source === 'web' ? undefined : input.requesterName,
    requesterClientId: input.source === 'web' ? input.requesterClientId : undefined,
    status: 'pending',
    createdAt: new Date().toISOString(),
    source: input.source,
  };
  upsertTelegramRequest(req);
  emitRequestsChanged();
  activityLog.info('telegram', `New request: ${req.title}`, {
    id: req.id,
    mediaType: req.mediaType,
    source: req.source || '',
  });

  const typeLabel = input.mediaType === 'movie' ? 'Movie' : 'TV show';
  const who =
    input.source === 'web'
      ? `Web${input.requesterClientId ? ` · ${input.requesterClientId.slice(0, 8)}` : ''}`
      : `${input.requesterName || '—'} (${input.requesterChatId})`;
  const adminText = [
    `<b>New ${input.source === 'web' ? 'web' : 'Telegram'} request</b>`,
    `${typeLabel}: <b>${escapeHtml(req.title)}</b>${req.year ? ` (${req.year})` : ''}`,
    req.overview ? escapeHtml(req.overview.slice(0, 280)) : '',
    `From: ${escapeHtml(who)}`,
    `Id: <code>${escapeHtml(req.id)}</code>`,
    `/approve ${req.id}   /deny ${req.id}`,
  ]
    .filter(Boolean)
    .join('\n');
  await telegramBot.notifyAdminChats(
    getSettings(),
    adminText,
    approveDenyKeyboard(req.id),
    req.posterUrl
  );

  return {
    ok: true,
    message: 'Request submitted, waiting for admin approval',
    request: req,
  };
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
    activityLog.info('telegram', `Denied request: ${req.title}`, {
      id: req.id,
      mediaType: req.mediaType,
    });
    const updated: TelegramRequest = {
      ...req,
      status: 'denied',
      resolvedAt: new Date().toISOString(),
      resolvedByChatId: adminChatId,
    };
    upsertTelegramRequest(updated);
    emitRequestsChanged();
    try {
      await telegramBot.notifyChat(
        settings,
        req.requesterChatId,
        `<b>Denied</b>\n${escapeHtml(req.title)}`,
        req.posterUrl
      );
    } catch {
      // ignore notify failure
    }
    return { ok: true, message: `Denied ${req.title} (${req.id}).` };
  }

  // approve — only Telegram-notify when requester has a real chat id (web uses 0)
  const notifyCtx =
    req.requesterChatId && req.requesterChatId !== 0
      ? {
          notifyChatId: req.requesterChatId,
          telegramRequestId: req.id,
        }
      : {
          telegramRequestId: req.id,
        };
  try {
    activityLog.info('telegram', `Approved request: ${req.title}`, {
      id: req.id,
      mediaType: req.mediaType,
    });
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
        posterUrl: req.posterUrl || show.posterPath || null,
      };
      upsertTelegramRequest(updated);
      emitRequestsChanged();
      try {
        await telegramBot.notifyChat(
          settings,
          req.requesterChatId,
          `<b>Approved</b>\n${escapeHtml(show.name)}\nSearching / downloading…`,
          req.posterUrl || show.posterPath
        );
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
      posterUrl: req.posterUrl || movie.posterPath || null,
    };
    upsertTelegramRequest(updated);
    emitRequestsChanged();
    try {
      await telegramBot.notifyChat(
        settings,
        req.requesterChatId,
        `<b>Approved</b>\n${escapeHtml(movie.title)}${movie.releaseYear ? ` (${movie.releaseYear})` : ''}\n${started ? 'Download started.' : 'Added to library.'}`,
        req.posterUrl || movie.posterPath
      );
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
  ipcMain.handle('settings:set', (_e, partial: Partial<AppSettings> & { webPortalAdminPassword?: string }) => {
    const incoming = { ...(partial || {}) } as Partial<AppSettings> & {
      webPortalAdminPassword?: string;
    };
    const plainPassword =
      typeof incoming.webPortalAdminPassword === 'string'
        ? incoming.webPortalAdminPassword
        : undefined;
    delete incoming.webPortalAdminPassword;

    if (plainPassword && plainPassword.length > 0) {
      incoming.webPortalAdminPasswordHash = hashWebPortalPassword(plainPassword);
    }
    if (incoming.webPortalAdminPasswordHash === '') {
      delete incoming.webPortalAdminPasswordHash;
    }

    if (incoming.webPortalEnabled && !(getSettings().webPortalSessionSecret || '').trim()) {
      incoming.webPortalSessionSecret = randomBytes(24).toString('hex');
    }
    if (incoming.webPortalPort != null) {
      const n = Number(incoming.webPortalPort);
      incoming.webPortalPort = Number.isFinite(n) ? Math.max(1, Math.min(65535, Math.floor(n))) : 8787;
    }
    if (incoming.webPortalBind != null && incoming.webPortalBind !== 'lan') {
      incoming.webPortalBind = 'localhost';
    }
    if (incoming.liveTvPort != null) {
      const n = Number(incoming.liveTvPort);
      incoming.liveTvPort = Number.isFinite(n) ? Math.max(1, Math.min(65535, Math.floor(n))) : 34400;
    }
    if (incoming.liveTvBind != null && incoming.liveTvBind !== 'localhost') {
      incoming.liveTvBind = 'lan';
    }
    if (incoming.liveTvTuners != null) {
      const n = Number(incoming.liveTvTuners);
      incoming.liveTvTuners = Number.isFinite(n) ? Math.max(1, Math.min(16, Math.floor(n))) : 3;
    }
    if (incoming.liveTvBufferMode != null && incoming.liveTvBufferMode !== 'off' && incoming.liveTvBufferMode !== 'ffmpeg') {
      incoming.liveTvBufferMode = 'memory';
    }
    if (incoming.liveTvFakeEpgMinutes != null) {
      const n = Number(incoming.liveTvFakeEpgMinutes);
      incoming.liveTvFakeEpgMinutes = [30, 60, 120].includes(n) ? n : 60;
    }
    if (incoming.liveTvFakeEpgDays != null) {
      const n = Number(incoming.liveTvFakeEpgDays);
      incoming.liveTvFakeEpgDays = Number.isFinite(n) ? Math.max(1, Math.min(7, Math.floor(n))) : 2;
    }

    const next = setSettings(incoming);
    activityLog.info('settings', 'Settings saved', {
      keys: summarizeSettingsKeys(incoming as Record<string, unknown>),
    });
    applySettingsSideEffects(next);
    mainWindow?.webContents.send('settings:changed', next);
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

  ipcMain.handle('library:get', async (_e, tmdbId: number) => {
    await new Promise<void>((r) => setImmediate(r));
    const settings = getSettings();
    const show = getShows().find((s) => s.tmdbId === tmdbId);
    if (!show) return null;
    return applyLocalStatuses(show, settings.libraryRoot, downloadingKeys(), tvRoots(settings));
  });

  ipcMain.handle('library:add', async (_e, mazeId: number, policy?: AddShowPolicy) => {
    const show = await addShowWithPolicy(mazeId, policy || 'manual');
    activityLog.info('library', `Added show: ${show?.name || mazeId}`, {
      mazeId,
      policy: policy || 'manual',
    });
    return show;
  });

  // Manual folder mass-import (never auto-runs)
  ipcMain.handle('library:scanPreview', async (_e, scope: LibraryScanScope) => {
    const settings = getSettings();
    activityLog.info('library', `Folder scan preview (${scope || 'both'})`);
    const preview = await buildScanPreview(
      scope || 'both',
      tvRoots(settings),
      movieRoots(settings),
      getShows(),
      getMovies()
    );
    activityLog.info(
      'library',
      `Folder scan preview done: ${preview?.candidates?.length || 0} candidate(s)`
    );
    return preview;
  });

  ipcMain.handle('library:scanImport', async (_e, items: FolderScanImportItem[]) => {
    const selected = (items || []).filter((i) => i.selected && i.matchId);
    activityLog.info('library', `Folder scan import start: ${selected.length} selected`);
    const result = await runFolderScanImport(items || []);
    activityLog.info(
      'library',
      `Folder scan import done: added ${result.added}, skipped ${result.skipped}, failed ${result.failed}`
    );
    return result;
  });



  ipcMain.handle('library:remove', (_e, tmdbId: number) => {
    const show = getShows().find((s) => s.tmdbId === tmdbId);
    removeShow(tmdbId);
    activityLog.info('library', `Removed show: ${show?.name || tmdbId}`, { mazeId: tmdbId });
  });

  ipcMain.handle('library:bulkUpdate', (_e, tmdbIds: number[], partial: Partial<Show>) => {
    const ids = Array.isArray(tmdbIds) ? tmdbIds.map(Number).filter((n) => Number.isFinite(n)) : [];
    const shows = getShows();
    let n = 0;
    for (const id of ids) {
      const idx = shows.findIndex((s) => s.tmdbId === id);
      if (idx < 0) continue;
      const merged: Show = { ...shows[idx], ...partial, tmdbId: id };
      for (const key of [
        'preferredResolution',
        'minimumResolution',
        'minSizeMb720p',
        'minSizeMb1080p',
        'minSizeMb2160p',
        'libraryPath',
      ] as const) {
        if (key in partial && (partial as any)[key] == null) {
          delete (merged as any)[key];
        }
      }
      shows[idx] = merged;
      upsertShow(shows[idx]);
      n += 1;
    }
    if (n) emitLibraryChanged();
    if (n && 'monitored' in partial) {
      activityLog.info(
        'monitor',
        `${partial.monitored === false ? 'Paused' : 'Resumed'} monitoring for ${n} show(s)`
      );
    } else if (n) {
      activityLog.info('library', `Bulk updated ${n} show(s)`, {
        keys: Object.keys(partial || {}).join(','),
      });
    }
    return { updated: n };
  });

  ipcMain.handle('library:bulkRemove', (_e, tmdbIds: number[]) => {
    const ids = new Set(
      (Array.isArray(tmdbIds) ? tmdbIds : []).map(Number).filter((n) => Number.isFinite(n))
    );
    let n = 0;
    for (const id of ids) {
      const before = getShows().length;
      removeShow(id);
      if (getShows().length < before) n += 1;
    }
    if (n) {
      activityLog.info('library', `Bulk removed ${n} show(s)`);
      emitLibraryChanged();
    }
    return { removed: n };
  });

  /** Mark missing/aired episodes as ignored (or missing) across many shows — whole-show status bulk. */
  ipcMain.handle(
    'library:bulkSetMissingStatus',
    (_e, tmdbIds: number[], status: EpisodeOverrideStatus) => {
      const allowed: EpisodeOverrideStatus[] = ['missing', 'ignored'];
      if (!allowed.includes(status)) throw new Error(`Invalid bulk status: ${status}`);
      const ids = new Set(
        (Array.isArray(tmdbIds) ? tmdbIds : []).map(Number).filter((n) => Number.isFinite(n))
      );
      const entries: Record<string, EpisodeOverrideStatus> = {};
      for (const show of getShows()) {
        if (!ids.has(show.tmdbId)) continue;
        for (const season of show.seasons || []) {
          for (const ep of season.episodes || []) {
            if (status === 'ignored') {
              if (ep.status === 'missing' || ep.status === 'aired') {
                entries[episodeKey(show.tmdbId, ep.seasonNumber, ep.episodeNumber)] = 'ignored';
              }
            } else if (status === 'missing') {
              if (ep.status === 'ignored') {
                entries[episodeKey(show.tmdbId, ep.seasonNumber, ep.episodeNumber)] = 'missing';
              }
            }
          }
        }
      }
      if (Object.keys(entries).length) {
        setEpisodeOverridesBulk(entries);
        for (const show of getShows()) {
          if (!ids.has(show.tmdbId)) continue;
          upsertShow(withLocalStatuses(show));
        }
        emitLibraryChanged();
      }
      return { updated: Object.keys(entries).length };
    }
  );

  ipcMain.handle('library:update', (_e, tmdbId: number, partial: Partial<Show>) => {
    const shows = getShows();
    const idx = shows.findIndex((s) => s.tmdbId === tmdbId);
    if (idx < 0) throw new Error('Show not found');
    const merged: Show = { ...shows[idx], ...partial, tmdbId };
    // Explicit undefined from UI = clear per-show override (use global).
    for (const key of [
      'preferredResolution',
      'minimumResolution',
      'minSizeMb720p',
      'minSizeMb1080p',
      'minSizeMb2160p',
      'libraryPath',
    ] as const) {
      if (key in partial && (partial as any)[key] == null) {
        delete (merged as any)[key];
      }
    }
    shows[idx] = merged;
    upsertShow(shows[idx]);
    if ('monitored' in partial) {
      activityLog.info(
        'monitor',
        `${partial.monitored === false ? 'Paused' : 'Resumed'} monitoring: ${merged.name}`,
        { mazeId: tmdbId }
      );
    } else {
      activityLog.info('library', `Updated show: ${merged.name}`, {
        keys: Object.keys(partial || {}).join(','),
      });
    }
    return shows[idx];
  });

  ipcMain.handle('library:refresh', async (_e, tmdbId: number) => {
    const show = getShows().find((s) => s.tmdbId === tmdbId);
    if (!show) throw new Error('Show not found');
    activityLog.info('library', `Refresh show: ${show.name}`, { mazeId: tmdbId });
    const updated = await refreshOne(show);
    await autoDownloadForShows([updated]);
    emitLibraryChanged();
    return updated;
  });

  ipcMain.handle('library:refreshAll', async () => {
    activityLog.info('library', 'Refresh all shows');
    return refreshAllShows();
  });

  ipcMain.handle('library:calendar', (_e, from: string, to: string) => listCalendarEpisodes(from, to));

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
      const epLabel = `${show.name} S${pad2(season)}E${pad2(episode)}`;
      let hadDownloaded = false;
      for (const s of show.seasons || []) {
        for (const ep of s.episodes || []) {
          if (ep.seasonNumber === season && ep.episodeNumber === episode) {
            if (ep.localPath || ep.status === 'downloaded') hadDownloaded = true;
          }
        }
      }
      setEpisodeOverride(tmdbId, season, episode, status);
      activityLog.info('library', `Episode status: ${epLabel} → ${status}`);
      if (status === 'ignored') {
        if (hadDownloaded) {
          activityLog.info(
            'library',
            `Ignored overrides downloaded: ${epLabel} (file on disk kept; auto paths skipped)`
          );
        }
        const cancelled = cancelActiveDownloadsForEpisode(
          tmdbId,
          season,
          episode,
          'ignored by user'
        );
        if (cancelled) {
          activityLog.info(
            'library',
            `Cancelled ${cancelled} active download(s) for ignored episode: ${epLabel}`
          );
        }
      }
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
      let overriddenDownloaded = 0;
      let cancelled = 0;
      for (const ep of seasonObj.episodes || []) {
        entries[episodeKey(tmdbId, ep.seasonNumber, ep.episodeNumber)] = status;
        if (status === 'ignored' && (ep.localPath || ep.status === 'downloaded')) {
          overriddenDownloaded += 1;
        }
      }
      if (Object.keys(entries).length) {
        setEpisodeOverridesBulk(entries);
      }
      if (status === 'ignored') {
        for (const ep of seasonObj.episodes || []) {
          cancelled += cancelActiveDownloadsForEpisode(
            tmdbId,
            ep.seasonNumber,
            ep.episodeNumber,
            'ignored by user (season bulk)'
          );
        }
        if (overriddenDownloaded) {
          activityLog.info(
            'library',
            `Ignored overrides downloaded: ${show.name} S${pad2(season)} (${overriddenDownloaded} ep(s) with file on disk; auto paths skipped)`
          );
        }
        if (cancelled) {
          activityLog.info(
            'library',
            `Cancelled ${cancelled} active download(s) for ignored season: ${show.name} S${pad2(season)}`
          );
        }
      }
      const updated = withLocalStatuses(show);
      upsertShow(updated);
      emitLibraryChanged();
      activityLog.info(
        'library',
        `Season status: ${show.name} S${pad2(season)} → ${status} (${Object.keys(entries).length} eps)`
      );
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
    const sources = enabledTorrentSourceIds(settings);
    activityLog.info('search', `Episode search start: ${show.name} S${pad2(season)}E${pad2(episode)}`, {
      preferred,
      sources: sources.join(',') || '(none)',
    });
    const res = await searchEpisodeTorrents(settings, show.name, season, episode, preferred, {
      imdbId: show.imdbId,
      mazeId: show.tmdbId,
    });
    activityLog.info(
      'search',
      `Episode search done: ${show.name} S${pad2(season)}E${pad2(episode)} — ${res.results?.length || 0} result(s)`,
      { sourcesHit: sourcesInResults(res.results), error: res.error || '' }
    );
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
      const triedList = loadTriedForEpisode(payload.tmdbId, payload.season, payload.episode);
      const candidates = payload.candidates?.length
        ? toCandidates(payload.candidates)
        : toCandidates([{ magnet: payload.magnet }]);
      const preferred = (show.preferredResolution || settings.defaultResolution) as Resolution;
      const item = await downloadEngine.start({
        magnet: payload.magnet,
        show: showForDownload(show, payload.season),
        libraryRoot: tvRoots(settings)[0] || settings.libraryRoot,
        seasonNumber: payload.season,
        episodeNumber: payload.episode,
        episodeTitle: payload.episodeTitle,
        candidates,
        triedInfoHashes: triedList,
        quality: qualityRules('episode', preferred, show),
      });
      const startHash = item?.infoHash || extractInfoHash(payload.magnet) || '';
      const startTitle = item?.name || payload.episodeTitle || show.name;
      activityLog.info(
        'download',
        `Start (manual): ${describeTorrentChoice(
          {
            title: startTitle,
            magnet: payload.magnet,
            infoHash: startHash,
            resolution: detectResolution(startTitle),
          },
          {
            preferred,
            triedSkipped: triedList.length,
            healthyCount: candidates.length,
            mode: 'manual',
          }
        )}`,
        { S: payload.season, E: payload.episode, infoHash: shortInfoHash(startHash) || startHash }
      );
      pushDownloads({ persist: 'now' });
      return item;
    }
  );

  ipcMain.handle('download:list', () => downloadEngine.list());
  ipcMain.handle('download:pause', (_e, id: string) => {
    const item = downloadEngine.list().find((d) => d.id === id);
    downloadEngine.pause(id);
    activityLog.info('download', `Pause: ${item?.name || id}`, {
      reason: 'user pause',
      infoHash: shortInfoHash(item?.infoHash || item?.magnet) || item?.infoHash || '',
    });
    pushDownloads({ persist: 'now' });
  });
  ipcMain.handle('download:resume', (_e, id: string) => {
    assertVpnAllowsTorrents();
    const item = downloadEngine.list().find((d) => d.id === id);
    downloadEngine.resume(id);
    activityLog.info('download', `Resume: ${item?.name || id}`, {
      reason: 'user resume',
      infoHash: shortInfoHash(item?.infoHash || item?.magnet) || item?.infoHash || '',
    });
    pushDownloads({ persist: 'now' });
  });
  ipcMain.handle('download:cancel', (_e, id: string) => {
    const item = downloadEngine.list().find((d) => d.id === id);
    if (item) rememberTriedFromItem(item);
    downloadEngine.cancel(id);
    activityLog.info('download', `Cancel: ${item?.name || id}`, {
      reason: 'user cancel',
      infoHash: shortInfoHash(item?.infoHash || item?.magnet) || item?.infoHash || '',
    });
    pushDownloads({ persist: 'now' });
  });



  ipcMain.handle('tmdb:searchMovies', async (_e, query: string) => {
    await new Promise<void>((r) => setImmediate(r));
    return searchMoviesMeta(query || '');
  });

  ipcMain.handle('movies:list', async () => {
    await new Promise<void>((r) => setImmediate(r));
    const downloading = downloadingMovieIds();
    // Grid uses stored status — no per-folder disk scan (that happens on movie detail / refresh).
    return getMovies().map((m) => ({
      ...m,
      status: downloading.has(m.tmdbId) ? 'downloading' : m.status,
    }));
  });

  ipcMain.handle('movies:get', async (_e, tmdbId: number) => {
    await new Promise<void>((r) => setImmediate(r));
    const movie = getMovies().find((m) => m.tmdbId === tmdbId);
    if (!movie) return null;
    return withMovieLocalStatus(movie);
  });

  ipcMain.handle('movies:add', async (_e, tmdbId: number) => {
    const settings = getSettings();
    if (!movieRoots(settings).length) {
      throw new Error('Set a movie library folder in Settings before adding movies');
    }
    const existing = getMovies().find((m) => m.tmdbId === tmdbId);
    const movie = await fetchMovieDetail(
      tmdbId,
      settings.movieLibraryRoot,
      existing,
      downloadingMovieIds(),
      movieRoots(settings)
    );
    upsertMovie(movie);
    activityLog.info('library', `Added movie: ${movie.title}`, { tmdbId });
    mainWindow?.webContents.send('movies:changed');
    return withMovieLocalStatus(movie);
  });

  ipcMain.handle('movies:remove', (_e, tmdbId: number) => {
    const movie = getMovies().find((m) => m.tmdbId === tmdbId);
    removeMovie(tmdbId);
    activityLog.info('library', `Removed movie: ${movie?.title || tmdbId}`, { tmdbId });
    mainWindow?.webContents.send('movies:changed');
    return getMovies().map((m) => withMovieLocalStatus(m));
  });

  ipcMain.handle('movies:bulkUpdate', (_e, tmdbIds: number[], partial: Partial<Movie>) => {
    const ids = Array.isArray(tmdbIds) ? tmdbIds.map(Number).filter((n) => Number.isFinite(n)) : [];
    const movies = getMovies();
    let n = 0;
    for (const id of ids) {
      const idx = movies.findIndex((m) => m.tmdbId === id);
      if (idx < 0) continue;
      movies[idx] = { ...movies[idx], ...partial, tmdbId: id };
      upsertMovie(movies[idx]);
      n += 1;
    }
    if (n) mainWindow?.webContents.send('movies:changed');
    if (n && 'monitored' in partial) {
      activityLog.info(
        'monitor',
        `${partial.monitored === false ? 'Paused' : 'Resumed'} monitoring for ${n} movie(s)`
      );
    } else if (n) {
      activityLog.info('library', `Bulk updated ${n} movie(s)`, {
        keys: Object.keys(partial || {}).join(','),
      });
    }
    return { updated: n };
  });

  ipcMain.handle('movies:bulkRemove', (_e, tmdbIds: number[]) => {
    const ids = new Set(
      (Array.isArray(tmdbIds) ? tmdbIds : []).map(Number).filter((n) => Number.isFinite(n))
    );
    let n = 0;
    for (const id of ids) {
      const before = getMovies().length;
      removeMovie(id);
      if (getMovies().length < before) n += 1;
    }
    if (n) {
      activityLog.info('library', `Bulk removed ${n} movie(s)`);
      mainWindow?.webContents.send('movies:changed');
    }
    return { removed: n };
  });

  ipcMain.handle('movies:update', (_e, tmdbId: number, partial: Partial<Movie>) => {
    const movies = getMovies();
    const idx = movies.findIndex((m) => m.tmdbId === tmdbId);
    if (idx < 0) throw new Error('Movie not found');
    movies[idx] = { ...movies[idx], ...partial, tmdbId };
    upsertMovie(movies[idx]);
    if ('monitored' in partial) {
      activityLog.info(
        'monitor',
        `${partial.monitored === false ? 'Paused' : 'Resumed'} monitoring: ${movies[idx].title}`,
        { tmdbId }
      );
    } else {
      activityLog.info('library', `Updated movie: ${movies[idx].title}`, {
        keys: Object.keys(partial || {}).join(','),
      });
    }
    mainWindow?.webContents.send('movies:changed');
    return withMovieLocalStatus(movies[idx]);
  });

  ipcMain.handle('movies:refresh', async (_e, tmdbId: number) => {
    const settings = getSettings();
    const existing = getMovies().find((m) => m.tmdbId === tmdbId);
    if (!existing) throw new Error('Movie not found');
    activityLog.info('library', `Refresh movie: ${existing.title}`, { tmdbId });
    const movie = await fetchMovieDetail(
      tmdbId,
      settings.movieLibraryRoot,
      existing,
      downloadingMovieIds(),
      movieRoots(settings)
    );
    upsertMovie(movie);
    mainWindow?.webContents.send('movies:changed');
    if (settings.autoDownload) {
      void autoDownloadMovie(movie, undefined, { allowUpgrade: true }).catch(() => undefined);
    }
    return movie;
  });

  ipcMain.handle('search:movie', async (_e, tmdbId: number) => {
    const settings = getSettings();
    const movie = getMovies().find((m) => m.tmdbId === tmdbId);
    if (!movie) throw new Error('Movie not found');
    const preferred = (movie.preferredResolution ||
      settings.defaultMovieResolution ||
      settings.defaultResolution) as Resolution;
    const sources = enabledTorrentSourceIds(settings);
    activityLog.info('search', `Movie search start: ${movie.title}`, {
      preferred,
      sources: sources.join(',') || '(none)',
    });
    const res = await searchMovieTorrents(
      settings,
      movie.title,
      movie.releaseYear,
      preferred
    );
    activityLog.info(
      'search',
      `Movie search done: ${movie.title} — ${res.results?.length || 0} result(s)`,
      { sourcesHit: sourcesInResults(res.results), error: res.error || '' }
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
      const mRoots = movieRoots(settings);
      if (!mRoots.length) {
        throw new Error('Set a movie library folder in Settings');
      }
      const triedList = loadTriedForMovie(payload.tmdbId);
      const candidates = payload.candidates?.length
        ? toCandidates(payload.candidates)
        : toCandidates([{ magnet: payload.magnet }]);
      const preferred = (movie.preferredResolution ||
        settings.defaultMovieResolution ||
        settings.defaultResolution) as Resolution;
      const item = await downloadEngine.startMovie({
        magnet: payload.magnet,
        movie: movieForDownload(movie),
        movieLibraryRoot: mRoots[0],
        candidates,
        triedInfoHashes: triedList,
        quality: qualityRules('movie', preferred),
      });
      const startHash = item?.infoHash || extractInfoHash(payload.magnet) || '';
      const startTitle = item?.name || movie.title;
      activityLog.info(
        'download',
        `Start movie (manual): ${describeTorrentChoice(
          {
            title: startTitle,
            magnet: payload.magnet,
            infoHash: startHash,
            resolution: detectResolution(startTitle),
          },
          {
            preferred,
            triedSkipped: triedList.length,
            healthyCount: candidates.length,
            mode: 'manual',
          }
        )}`,
        { infoHash: shortInfoHash(startHash) || startHash }
      );
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
    activityLog.info('backup', 'Exported backup', { path: filePath });
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
    bindIfIndex: vpnManager.getBindIfIndex(),
      vpnHold: torrentVpnHold(),
      processFolder: settings.processFolder || '',
    });
    applyLoginItem(!!settings.launchOnStartup);
    telegramBot.sync(settings);
    scheduleRefresh();
    emitLibraryChanged();
    mainWindow?.webContents.send('movies:changed');
    pushDownloads({ persist: 'skip' });
    activityLog.info('backup', 'Imported backup', {
      path: filePaths[0],
      ...Object.fromEntries(
        Object.entries(counts || {}).map(([k, v]) => [k, v])
      ),
    });
    return { ok: true, ...counts, path: filePaths[0] };
  });

    ipcMain.handle('telegram:status', () => telegramBot.getStatus(getSettings()));
  ipcMain.handle('telegram:test', async () => {
    activityLog.info('telegram', 'Sending test message');
    const r = await telegramBot.sendTest(getSettings());
    if (r?.ok) activityLog.info('telegram', 'Test message sent');
    else activityLog.warn('telegram', `Test message failed: ${r?.error || 'unknown'}`);
    return r;
  });
  ipcMain.handle('requests:list', async () => {
    const all = getTelegramRequests();
    return enrichTelegramRequests(all);
  });
  ipcMain.handle('requests:pendingCount', () => {
    return getTelegramRequests().filter((r) => r.status === 'pending').length;
  });
  ipcMain.handle(
    'requests:resolve',
    async (_e, id: string, action: 'approved' | 'denied') => {
      if (action !== 'approved' && action !== 'denied') {
        return { ok: false, message: 'Invalid action' };
      }
      const result = await resolveTelegramRequest(String(id || ''), action, 0);
      return result;
    }
  );
  ipcMain.handle('liveTv:status', () => liveTv.getStatus(getSettings()));
  ipcMain.handle('liveTv:channels', () => getLiveTvLineup().map(withLogoPreview));
  ipcMain.handle('liveTv:refresh', async () => {
    activityLog.info('livetv', 'Refreshing Live TV sources');
    const r = await liveTv.refreshSources();
    activityLog.info('livetv', 'Live TV sources refreshed');
    return r;
  });
  ipcMain.handle('liveTv:setChannels', (_e, channels: LiveTvChannel[]) => {
    if (!Array.isArray(channels)) return getLiveTvLineup();
    activityLog.info('livetv', `Saving Live TV lineup (${channels.length} channel(s))`);
    setLiveTvLineup(
      channels.map((c, i) => ({
        id: String(c.id || ''),
        name: String(c.name || `Channel ${i + 1}`),
        number: Math.max(1, Math.floor(Number(c.number) || i + 1)),
        group: String(c.group || ''),
        logo: String(c.logo || ''),
        tvgId: String(c.tvgId || ''),
        url: String(c.url || ''),
        enabled: !!c.enabled,
        logoCustom: !!c.logoCustom,
        epgCustom: !!c.epgCustom,
        fakeEpg: !!c.fakeEpg,
      }))
    );
    return getLiveTvLineup();
  });
  ipcMain.handle('liveTv:epgOptions', () => liveTv.epgOptions());
  ipcMain.handle('liveTv:setIcon', (_e, channelId: string, filePath: string) => {
    return liveTv.applyChannelIcon(String(channelId || ''), String(filePath || ''));
  });
  ipcMain.handle('dialog:pickFile', async (_e, filters?: Array<{ name: string; extensions: string[] }>) => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: filters?.length ? filters : [{ name: 'M3U', extensions: ['m3u', 'm3u8', 'txt'] }],
    });
    return r.canceled ? null : r.filePaths[0] || null;
  });

  ipcMain.handle('webPortal:status', () => {
    const s = getSettings();
    const st = webPortal.getStatus(s);
    st.urls = st.listening ? portalPublicUrls(s, pickLanIpv4()) : [];
    return st;
  });

  ipcMain.handle('app:isReady', () => uiBackendReady);
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
  ipcMain.handle('update:download', async () => downloadAppUpdate());
  ipcMain.handle('update:install', async () => {
    if (!updateState.downloaded) return;
    activityLog.info('updater', `Installing update v${updateState.version || '?'}`);
    try {
      downloadEngine.destroy();
    } catch {
      // ignore
    }
    try {
      await vpnManager.disconnect();
    } catch {
      // ignore
    }
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.handle('log:get', (_e, opts?: { maxBytes?: number }) => {
    const maxBytes = opts?.maxBytes;
    return activityLog.readAll(typeof maxBytes === 'number' ? maxBytes : undefined);
  });
  ipcMain.handle('log:tail', (_e, opts?: { lines?: number }) => {
    const lines = opts?.lines;
    return activityLog.tail(typeof lines === 'number' ? lines : 800);
  });
  ipcMain.handle('log:openFolder', async () => activityLog.openFolder());
  ipcMain.handle('log:path', () => ({
    dir: activityLog.getDir(),
    file: activityLog.getCurrentPath(),
  }));

  ipcMain.handle('poster:cache', async (_e, url: string) => {
    try {
      return await ensurePosterCached(String(url || ''));
    } catch {
      return url;
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
    activityLog.info('vpn', `Imported OpenVPN config: ${imported.configName || 'config'}`, {
      // path only — never credentials
      path: imported.configPath || '',
    });
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
    activityLog.info('vpn', 'Connect requested');
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
    activityLog.info('vpn', 'Disconnect requested');
    await vpnManager.disconnect();
    applyTorrentBindFromVpn();
    pushVpnStatus();
    return vpnManager.getStatus(getSettings());
  });
}

app.whenReady().then(async () => {
  if (isCrashWatchdogArg()) {
    runCrashWatchdog();
    app.exit(0);
    return;
  }
  try {
    protocol.handle('nfimg', async (request) => {
      const file = resolveNfimgFile(request.url);
      if (!file || !fs.existsSync(file)) {
        return new Response('Not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(file).toString());
    });
  } catch (err) {
    console.error('[poster-cache] protocol', err);
  }
  try {
    Menu.setApplicationMenu(null);
  } catch {
    // ignore
  }
  activityLog.init();
  activityLog.info('app', `Nightfeed starting v${app.getVersion()}`);
  activityLog.on('changed', () => {
    mainWindow?.webContents.send('log:changed');
  });
  registerIpc();
  createWindow();
  writeSessionLock();
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
  vpnManager.on('drop', (detail: string) => {
    applyTorrentBindFromVpn();
    pushVpnStatus();
    const s = getSettings();
    if (s.vpnRequireForTorrents) {
      alertVpnKillSwitch(typeof detail === 'string' && detail ? detail : 'OpenVPN connection dropped.');
    }
    if (s.vpnEnabled && s.vpnConfigPath && !vpnReconnectAttempt) {
      vpnReconnectAttempt = true;
      void startVpnFromSettings().finally(() => {
        vpnReconnectAttempt = false;
        applyTorrentBindFromVpn();
        pushVpnStatus();
      });
    }
  });
  await ensureTorrentEngine();
  // Wire progress listeners BEFORE restore so the first promotions are not dropped.
  const progressMilestones = new Map<string, number>();
  downloadEngine.on('update', () => {
    try {
      for (const d of downloadEngine.list()) {
        if (d.status !== 'downloading') continue;
        const pct = Math.floor((d.progress || 0) * 100);
        const prev = progressMilestones.get(d.id) || 0;
        let next = prev;
        for (const mark of [25, 50, 75]) {
          if (pct >= mark && prev < mark) next = mark;
        }
        if (next > prev) {
          progressMilestones.set(d.id, next);
          activityLog.info('download', `Progress ${next}%: ${d.name}`, {
            infoHash: shortInfoHash(d.infoHash || d.magnet) || d.infoHash || '',
          });
        }
      }
      for (const id of [...progressMilestones.keys()]) {
        if (!downloadEngine.list().some((d) => d.id === id && d.status === 'downloading')) {
          progressMilestones.delete(id);
        }
      }
    } catch {
      // ignore
    }
    pushDownloads({ persist: 'debounce' });
  });
  // Apply bind/VPN/processFolder before re-queuing persisted downloads.
  {
    const settings = getSettings();
    await downloadEngine.applySettingsAsync({
      maxConnections: settings.maxConnections,
      maxDownloadSpeedKBps: settings.maxDownloadSpeedKBps,
      maxUploadSpeedKBps: settings.maxUploadSpeedKBps,
      bindAddress: vpnManager.getBindAddress(),
      bindIfIndex: vpnManager.getBindIfIndex(),
      vpnHold: torrentVpnHold(),
      processFolder: settings.processFolder || '',
    });
  }
  await restorePersistedDownloads();
  downloadEngine.kickQueue();
  if (getTorrentEngineInfo().mode === 'in-process') {
    const fail = getLastUtilityFailure();
    const why = fail
      ? `path=${fail.pathTried}; exists=${fail.pathExists ? 'yes' : 'no'}` +
        (fail.forkError ? `; fork=${fail.forkError}` : '') +
        (fail.timedOut ? '; timedOut' : '') +
        (fail.exitCode != null ? `; exit=${fail.exitCode}` : '') +
        (fail.stderr ? `; stderr=${String(fail.stderr).slice(0, 240)}` : '') +
        (fail.note ? `; ${fail.note}` : '')
      : getTorrentEngineInfo().detail;
    activityLog.warn('download', `Download worker unavailable; using UI process until restart. ${why}`);
    notify(
      'Download worker unavailable — using UI process until restart. See log for details.',
      'warn'
    );
  } else {
    activityLog.info('download', 'Download engine: utilityProcess (one worker + floater on failure)');
  }

  downloadEngine.on('fallback-in-process', (reason: string) => {
    const fail = getLastUtilityFailure();
    const extra = fail
      ? `path=${fail.pathTried}; exit=${fail.exitCode ?? ''}; ${fail.stderr ? String(fail.stderr).slice(0, 160) : fail.note || ''}`
      : reason || '';
    activityLog.warn('download', `Switched to UI process mid-session: ${reason || 'unknown'}${extra ? ` | ${extra}` : ''}`);
    notify(
      'Download worker unavailable — using UI process until restart. See log for details.',
      'warn'
    );
  });
  downloadEngine.on('reject-exe', (item: DownloadItem) => {
    activityLog.warn('download', `Cancel/abandon: ${item?.name || 'download'}`, {
      reason: cancelReasonFromError(item?.error),
      infoHash: shortInfoHash(item?.infoHash || item?.magnet) || item?.infoHash || '',
      error: item?.error || '',
    });
    void tryNextAfterExeReject(item);
  });
  downloadEngine.on('engine-error', (msg: string) => {
    activityLog.error('download', `Engine error: ${msg || 'unknown'}`);
  });
  downloadEngine.on('done', (item: DownloadItem & { downloadedResolution?: Resolution }) => {
    if (item?.kind === 'movie' && item.movieId != null) {
      const movie = getMovies().find((m) => m.tmdbId === item.movieId);
      if (movie) {
        movie.status = 'downloaded';
        movie.localPath = item.savePath || movie.localPath;
        if (item.downloadedResolution) movie.downloadedResolution = item.downloadedResolution;
        else if (item.savePath) {
          movie.downloadedResolution =
            detectResolution(path.basename(item.savePath)) || movie.downloadedResolution;
        }
        upsertMovie(withMovieLocalStatus(movie));
      }
      mainWindow?.webContents.send('movies:changed');
    } else if (item?.showId != null && item.seasonNumber != null && item.episodeNumber != null) {
      const alreadyIgnored =
        getEpisodeOverride(item.showId, item.seasonNumber, item.episodeNumber) === 'ignored';
      if (alreadyIgnored) {
        activityLog.info(
          'download',
          `Complete but kept Ignored: ${item.showName || item.name} S${pad2(item.seasonNumber)}E${pad2(item.episodeNumber)}`,
          {
            infoHash: shortInfoHash(item.infoHash || item.magnet) || item.infoHash || '',
            reason: 'ignored override',
          }
        );
      } else {
        setEpisodeOverride(item.showId, item.seasonNumber, item.episodeNumber, 'downloaded');
      }
      const res =
        item.downloadedResolution ||
        (item.savePath ? detectResolution(path.basename(item.savePath)) : null);
      if (res) setEpisodeResolution(item.showId, item.seasonNumber, item.episodeNumber, res);
      const show = getShows().find((s) => s.tmdbId === item.showId);
      if (show) {
        upsertShow(withLocalStatuses(show));
      }
      emitLibraryChanged();
    }
    if (item?.name) {
      activityLog.info('download', `Complete: ${item.name}`, {
        infoHash: shortInfoHash(item.infoHash || item.magnet) || item.infoHash || '',
        kind: item.kind || '',
      });
      notify(`Finished: ${item.name}`, 'ok');
    }
    {
      const poster =
        item?.kind === 'movie'
          ? getMovies().find((m) => m.tmdbId === item.movieId)?.posterPath
          : getShows().find((s) => s.tmdbId === item?.showId)?.posterPath;
      const title =
        item?.kind === 'movie'
          ? item.showName || item.name
          : item
            ? `${item.showName} S${pad2(item.seasonNumber)}E${pad2(item.episodeNumber)}${
                item.episodeTitle ? ` — ${item.episodeTitle}` : ''
              }`
            : '';
      if (title) {
        appendDownloadHistory({
          at: new Date().toISOString(),
          title,
          kind: item.kind === 'movie' ? 'movie' : 'episode',
          posterUrl: poster || null,
        });
      }
    }
    if (item?.telegramRequestId) {
      const linked = getTelegramRequest(item.telegramRequestId);
      if (linked && (linked.status === 'approved' || linked.status === 'pending')) {
        upsertTelegramRequest({
          ...linked,
          status: 'downloaded',
          resolvedAt: linked.resolvedAt || new Date().toISOString(),
        });
        emitRequestsChanged();
      }
    }
    if (item?.notifyChatId) {
      const title =
        item.kind === 'movie'
          ? item.showName || item.name
          : `${item.showName} S${pad2(item.seasonNumber)}E${pad2(item.episodeNumber)}${
              item.episodeTitle ? ` — ${item.episodeTitle}` : ''
            }`;
      const poster =
        item.kind === 'movie'
          ? getMovies().find((m) => m.tmdbId === item.movieId)?.posterPath
          : getShows().find((s) => s.tmdbId === item.showId)?.posterPath;
      void telegramBot
        .notifyChat(
          getSettings(),
          item.notifyChatId,
          `<b>Download finished</b>\n${escapeHtml(title)}`,
          poster
        )
        .catch(() => undefined);
    }
    pushDownloads({ persist: 'now' });
    void maybeFtpUpload(item?.savePath, item?.name || path.basename(item?.savePath || 'file'));
  });
  const settings = getSettings();
  await downloadEngine.applySettingsAsync({
    maxConnections: settings.maxConnections,
    maxDownloadSpeedKBps: settings.maxDownloadSpeedKBps,
    maxUploadSpeedKBps: settings.maxUploadSpeedKBps,
    bindAddress: vpnManager.getBindAddress(),
    bindIfIndex: vpnManager.getBindIfIndex(),
    vpnHold: torrentVpnHold(),
    processFolder: settings.processFolder || '',
  });
  downloadEngine.kickQueue();
  applyLoginItem(!!settings.launchOnStartup);
  applyCrashRestartTask(!!settings.restartOnCrash);
  scheduleRefresh();
  void autoConnectVpnOnLaunch();
  signalUiReady();
  activityLog.info('app', 'UI ready');

  // Non-blocking update check on startup, then every 6 hours
  setTimeout(() => {
    void checkForUpdates(false);
  }, 4000);
  setInterval(() => {
    void checkForUpdates(false);
  }, 6 * 60 * 60 * 1000);
  setTimeout(() => {
    void maybeSendDailyBriefing();
  }, 20000);
  setInterval(() => {
    void maybeSendDailyBriefing();
  }, 15 * 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  activityLog.info('app', 'Nightfeed quitting');
  activityLog.destroy();
  clearSessionLock();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    clearSessionLock();
    telegramBot.stop();
    webPortal.stop();
    liveTv.stop();
    void vpnManager.disconnect();
    downloadEngine.destroy();
    void destroySearchPool();
    void destroyMetadataPool();
    app.quit();
  }
});
