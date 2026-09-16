import Store from 'electron-store';
import { app } from 'electron';
import path from 'path';
import {
  AppSettings,
  DEFAULT_SETTINGS,
  DownloadItem,
  EpisodeOverrideStatus,
  LiveTvChannel,
  Movie,
  DownloadHistoryItem,
  Show,
  TelegramRequest,
} from '../types';

export interface AppData {
  settings: AppSettings;
  shows: Show[];
  movies: Movie[];
  downloads: DownloadItem[];
  /** Manual episode status overrides keyed by `${showId}:${season}:${episode}` */
  episodeOverrides: Record<string, EpisodeOverrideStatus>;
  /** Telegram movie/TV requests (pending / approved / denied). */
  telegramRequests: TelegramRequest[];
  downloadHistory: DownloadHistoryItem[];
  lastDailyBriefingDate: string;
  liveTvLineup: LiveTvChannel[];
  liveTvXmltvCache: string;
}

const defaults: AppData = {
  settings: {
    ...DEFAULT_SETTINGS,
    libraryRoot: path.join(app.getPath('documents'), 'TV Shows'),
    movieLibraryRoot: path.join(app.getPath('documents'), 'Movies'),
  },
  shows: [],
  movies: [],
  downloads: [],
  episodeOverrides: {},
  telegramRequests: [],
  downloadHistory: [],
  lastDailyBriefingDate: '',
  liveTvLineup: [],
  liveTvXmltvCache: '',
};

export const store = new Store<AppData>({
  name: 'torrent-data',
  defaults,
});

export function episodeKey(showId: number, season: number, episode: number): string {
  return `${showId}:${season}:${episode}`;
}

function migrateTorrentSources(raw: Partial<AppSettings>): AppSettings['torrentSources'] {
  const base = { ...DEFAULT_SETTINGS.torrentSources };
  if (raw.torrentSources && typeof raw.torrentSources === 'object') {
    const src = raw.torrentSources as Record<string, unknown>;
    return {
      apibay: src.apibay !== false,
      knaben: src.knaben !== false,
      yourbittorrent: src.yourbittorrent !== false,
      torrentscsv: src.torrentscsv !== false,
      eztv: src.eztv !== false,
      animetosho: src.animetosho !== false,
      nyaa: src.nyaa !== false,
      limetorrents: src.limetorrents !== false,
      jackett: !!src.jackett,
    };
  }
  // Legacy single-provider dropdown → multi-source defaults
  if (raw.searchProvider === 'jackett') {
    return { ...base, jackett: true };
  }
  return base;
}

export function getSettings(): AppSettings {
  const raw = store.get('settings') || {};
  const merged: AppSettings = { ...DEFAULT_SETTINGS, ...raw };
  merged.torrentSources = migrateTorrentSources(raw as Partial<AppSettings>);
  if (!merged.movieLibraryRoot) {
    merged.movieLibraryRoot =
      (raw as Partial<AppSettings>).movieLibraryRoot ||
      path.join(app.getPath('documents'), 'Movies');
  }
  const tvRoots = Array.isArray(merged.libraryRoots) ? merged.libraryRoots.filter((r) => !!(r || '').trim()) : [];
  if (!tvRoots.length && merged.libraryRoot) tvRoots.push(merged.libraryRoot);
  merged.libraryRoots = tvRoots;
  merged.libraryRoot = tvRoots[0] || merged.libraryRoot || '';
  const movieRoots = Array.isArray(merged.movieLibraryRoots)
    ? merged.movieLibraryRoots.filter((r) => !!(r || '').trim())
    : [];
  if (!movieRoots.length && merged.movieLibraryRoot) movieRoots.push(merged.movieLibraryRoot);
  merged.movieLibraryRoots = movieRoots;
  merged.movieLibraryRoot = movieRoots[0] || merged.movieLibraryRoot || '';
  if (typeof merged.telegramDailyBriefing !== 'boolean') merged.telegramDailyBriefing = false;
  if (
    typeof merged.telegramDailyBriefingHour !== 'number' ||
    merged.telegramDailyBriefingHour < 0 ||
    merged.telegramDailyBriefingHour > 23
  ) {
    merged.telegramDailyBriefingHour = 9;
  }
  if (!merged.defaultMovieResolution) {
    merged.defaultMovieResolution = merged.defaultResolution || '1080p';
  }
  if (merged.minimumResolution !== '720p' && merged.minimumResolution !== '1080p' && merged.minimumResolution !== '2160p') {
    merged.minimumResolution = '720p';
  }
  if (
    merged.minimumMovieResolution !== '720p' &&
    merged.minimumMovieResolution !== '1080p' &&
    merged.minimumMovieResolution !== '2160p'
  ) {
    merged.minimumMovieResolution = '720p';
  }
  if (typeof merged.minSizeMb720p !== 'number' || merged.minSizeMb720p < 0) merged.minSizeMb720p = 200;
  if (typeof merged.minSizeMb1080p !== 'number' || merged.minSizeMb1080p < 0) merged.minSizeMb1080p = 500;
  if (typeof merged.minSizeMb2160p !== 'number' || merged.minSizeMb2160p < 0) merged.minSizeMb2160p = 2000;
  if (merged.processFolder == null) merged.processFolder = '';
  if (typeof merged.ftpEnabled !== 'boolean') merged.ftpEnabled = false;
  if (merged.ftpHost == null) merged.ftpHost = '';
  if (!merged.ftpPort || merged.ftpPort < 1) merged.ftpPort = 21;
  if (merged.ftpUser == null) merged.ftpUser = '';
  if (merged.ftpPassword == null) merged.ftpPassword = '';
  if (merged.ftpRemoteBasePath == null) merged.ftpRemoteBasePath = '';
  if (!merged.maxConnections || merged.maxConnections < 1) merged.maxConnections = 55;
  if (merged.maxConnections > 80) merged.maxConnections = 80;
  if (typeof merged.vpnEnabled !== 'boolean') merged.vpnEnabled = false;
  if (merged.vpnConfigPath == null) merged.vpnConfigPath = '';
  if (merged.vpnConfigName == null) merged.vpnConfigName = '';
  if (merged.vpnUsername == null) merged.vpnUsername = '';
  if (merged.vpnPassword == null) merged.vpnPassword = '';
  if (typeof merged.vpnRequireForTorrents !== 'boolean') merged.vpnRequireForTorrents = false;
  if (merged.telegramAdminChatIds == null) merged.telegramAdminChatIds = '';
  if (merged.telegramRequestChatIds == null) merged.telegramRequestChatIds = '';
  // Migrate legacy single allow-list into Admin when new fields are empty.
  if (
    !(merged.telegramAdminChatIds || '').trim() &&
    !(merged.telegramRequestChatIds || '').trim() &&
    (merged.telegramAllowedChatIds || '').trim()
  ) {
    merged.telegramAdminChatIds = merged.telegramAllowedChatIds;
  }
  if (typeof merged.webPortalEnabled !== 'boolean') merged.webPortalEnabled = false;
  if (!merged.webPortalPort || merged.webPortalPort < 1) merged.webPortalPort = 8787;
  if (merged.webPortalBind !== 'lan') merged.webPortalBind = 'localhost';
  if (merged.webPortalAdminPasswordHash == null) merged.webPortalAdminPasswordHash = '';
  if (merged.webPortalSessionSecret == null) merged.webPortalSessionSecret = '';
  if (typeof merged.liveTvEnabled !== 'boolean') merged.liveTvEnabled = false;
  if (!merged.liveTvPort || merged.liveTvPort < 1) merged.liveTvPort = 34400;
  if (merged.liveTvBind !== 'localhost') merged.liveTvBind = 'lan';
  if (!merged.liveTvTuners || merged.liveTvTuners < 1) merged.liveTvTuners = 3;
  merged.liveTvTuners = Math.max(1, Math.min(16, Math.floor(merged.liveTvTuners)));
  if (merged.liveTvBufferMode !== 'off' && merged.liveTvBufferMode !== 'ffmpeg') merged.liveTvBufferMode = 'memory';
  if (!merged.liveTvBufferKb || merged.liveTvBufferKb < 64) merged.liveTvBufferKb = 1024;
  if (!merged.liveTvBufferTimeoutMs || merged.liveTvBufferTimeoutMs < 500) merged.liveTvBufferTimeoutMs = 8000;
  if (merged.liveTvUserAgent == null) merged.liveTvUserAgent = DEFAULT_SETTINGS.liveTvUserAgent;
  if (merged.liveTvFfmpegPath == null) merged.liveTvFfmpegPath = '';
  if (typeof merged.liveTvHideAdult !== 'boolean') merged.liveTvHideAdult = true;
  if (!merged.liveTvSourceType) merged.liveTvSourceType = 'none';
  if (merged.liveTvDirectUrl == null) merged.liveTvDirectUrl = '';
  if (merged.liveTvDirectName == null) merged.liveTvDirectName = '';
  if (merged.liveTvM3uUrl == null) merged.liveTvM3uUrl = '';
  if (merged.liveTvXmltvUrl == null) merged.liveTvXmltvUrl = '';
  if (merged.liveTvXtreamHost == null) merged.liveTvXtreamHost = '';
  if (merged.liveTvXtreamUsername == null) merged.liveTvXtreamUsername = '';
  if (merged.liveTvXtreamPassword == null) merged.liveTvXtreamPassword = '';
  if (!merged.liveTvXtreamPort || merged.liveTvXtreamPort < 1) merged.liveTvXtreamPort = 80;
  if (typeof merged.liveTvXtreamHls !== 'boolean') merged.liveTvXtreamHls = false;
  return merged;
}

export function setSettings(partial: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...partial };
  // Keep deprecated allow-list mirrored to admin ids for older backups / tooling.
  if (
    partial.telegramAdminChatIds !== undefined ||
    (partial.telegramAllowedChatIds !== undefined && !(next.telegramAdminChatIds || '').trim())
  ) {
    if (partial.telegramAdminChatIds !== undefined) {
      next.telegramAllowedChatIds = next.telegramAdminChatIds || '';
    } else if (partial.telegramAllowedChatIds !== undefined && !(next.telegramAdminChatIds || '').trim()) {
      next.telegramAdminChatIds = next.telegramAllowedChatIds || '';
    }
  }
  if (Array.isArray(next.libraryRoots) && next.libraryRoots.length) {
    next.libraryRoots = next.libraryRoots.map((r) => String(r || '').trim()).filter(Boolean);
    next.libraryRoot = next.libraryRoots[0] || '';
  } else if (next.libraryRoot) {
    next.libraryRoots = [next.libraryRoot];
  } else {
    next.libraryRoots = [];
  }
  if (Array.isArray(next.movieLibraryRoots) && next.movieLibraryRoots.length) {
    next.movieLibraryRoots = next.movieLibraryRoots.map((r) => String(r || '').trim()).filter(Boolean);
    next.movieLibraryRoot = next.movieLibraryRoots[0] || '';
  } else if (next.movieLibraryRoot) {
    next.movieLibraryRoots = [next.movieLibraryRoot];
  } else {
    next.movieLibraryRoots = [];
  }
  store.set('settings', next);
  return next;
}

export function getShows(): Show[] {
  return store.get('shows') || [];
}

export function saveShows(shows: Show[]): void {
  store.set('shows', shows);
}

export function upsertShow(show: Show): Show[] {
  const shows = getShows();
  const idx = shows.findIndex((s) => s.tmdbId === show.tmdbId);
  if (idx >= 0) shows[idx] = show;
  else shows.push(show);
  saveShows(shows);
  return shows;
}

export function removeShow(tmdbId: number): Show[] {
  const shows = getShows().filter((s) => s.tmdbId !== tmdbId);
  saveShows(shows);
  clearShowOverrides(tmdbId);
  return shows;
}

export function getMovies(): Movie[] {
  return store.get('movies') || [];
}

export function saveMovies(movies: Movie[]): void {
  store.set('movies', movies);
}

export function upsertMovie(movie: Movie): Movie[] {
  const movies = getMovies();
  const idx = movies.findIndex((m) => m.tmdbId === movie.tmdbId);
  if (idx >= 0) movies[idx] = movie;
  else movies.push(movie);
  saveMovies(movies);
  return movies;
}

export function removeMovie(tmdbId: number): Movie[] {
  const movies = getMovies().filter((m) => m.tmdbId !== tmdbId);
  saveMovies(movies);
  return movies;
}

export function getDownloads(): DownloadItem[] {
  return store.get('downloads') || [];
}

export function saveDownloads(items: DownloadItem[]): void {
  store.set('downloads', items);
}

export function getEpisodeOverrides(): Record<string, EpisodeOverrideStatus> {
  return store.get('episodeOverrides') || {};
}

export function getEpisodeOverride(
  showId: number,
  season: number,
  episode: number
): EpisodeOverrideStatus | undefined {
  return getEpisodeOverrides()[episodeKey(showId, season, episode)];
}

export function setEpisodeOverride(
  showId: number,
  season: number,
  episode: number,
  status: EpisodeOverrideStatus | null
): Record<string, EpisodeOverrideStatus> {
  const all = { ...getEpisodeOverrides() };
  const key = episodeKey(showId, season, episode);
  if (status == null) delete all[key];
  else all[key] = status;
  store.set('episodeOverrides', all);
  return all;
}

export function setEpisodeOverridesBulk(
  entries: Record<string, EpisodeOverrideStatus>
): Record<string, EpisodeOverrideStatus> {
  const all = { ...getEpisodeOverrides(), ...entries };
  store.set('episodeOverrides', all);
  return all;
}

export function clearShowOverrides(showId: number): void {
  const all = getEpisodeOverrides();
  const prefix = `${showId}:`;
  const next: Record<string, EpisodeOverrideStatus> = {};
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(prefix)) next[k] = v;
  }
  store.set('episodeOverrides', next);
}


export function getTelegramRequests(): TelegramRequest[] {
  return store.get('telegramRequests') || [];
}

export function saveTelegramRequests(requests: TelegramRequest[]): void {
  store.set('telegramRequests', requests);
}

export function upsertTelegramRequest(req: TelegramRequest): TelegramRequest[] {
  const all = getTelegramRequests();
  const idx = all.findIndex((r) => r.id === req.id);
  if (idx >= 0) all[idx] = req;
  else all.push(req);
  // Cap history to avoid unbounded growth (keep newest 200).
  const trimmed = all.length > 200 ? all.slice(all.length - 200) : all;
  saveTelegramRequests(trimmed);
  return trimmed;
}

export function getTelegramRequest(id: string): TelegramRequest | undefined {
  return getTelegramRequests().find((r) => r.id === id);
}

export function getDownloadHistory(): DownloadHistoryItem[] {
  return store.get('downloadHistory') || [];
}

export function appendDownloadHistory(item: DownloadHistoryItem): void {
  const cutoff = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const next = [...getDownloadHistory(), item].filter((h) => {
    const t = Date.parse(h.at);
    return Number.isFinite(t) && t >= cutoff;
  });
  store.set('downloadHistory', next.slice(-400));
}

export function getLastDailyBriefingDate(): string {
  return store.get('lastDailyBriefingDate') || '';
}

export function setLastDailyBriefingDate(day: string): void {
  store.set('lastDailyBriefingDate', day);
}

export function getLiveTvLineup(): LiveTvChannel[] {
  const raw = store.get('liveTvLineup');
  return Array.isArray(raw) ? raw : [];
}

export function setLiveTvLineup(channels: LiveTvChannel[]): void {
  store.set('liveTvLineup', channels);
}

export function getLiveTvXmltvCache(): string {
  return store.get('liveTvXmltvCache') || '';
}

export function setLiveTvXmltvCache(xml: string): void {
  store.set('liveTvXmltvCache', xml || '');
}

/** Full app data snapshot for backup (includes secrets from settings). */
export function exportBackupData(): AppData & { exportedAt: string; app: string; version: number } {
  return {
    settings: getSettings(),
    shows: getShows(),
    movies: getMovies(),
    downloads: getDownloads(),
    episodeOverrides: getEpisodeOverrides(),
    telegramRequests: getTelegramRequests(),
    downloadHistory: getDownloadHistory(),
    lastDailyBriefingDate: getLastDailyBriefingDate(),
    liveTvLineup: getLiveTvLineup(),
    liveTvXmltvCache: '',
    exportedAt: new Date().toISOString(),
    app: 'Nightfeed',
    version: 1,
  };
}

/**
 * Replace all persisted data with a backup payload.
 * Expects the shape written by exportBackupData (or a raw AppData object).
 */
export function importBackupData(raw: unknown): { shows: number; movies: number } {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid backup: not an object');
  }
  const data = raw as Partial<AppData> & { settings?: AppSettings };
  if (!data.settings || typeof data.settings !== 'object') {
    throw new Error('Invalid backup: missing settings');
  }
  if (!Array.isArray(data.shows)) {
    throw new Error('Invalid backup: missing shows array');
  }
  if (!Array.isArray(data.movies)) {
    // Older backups may omit movies
    data.movies = [];
  }
  if (!Array.isArray(data.downloads)) {
    data.downloads = [];
  }
  if (!data.episodeOverrides || typeof data.episodeOverrides !== 'object') {
    data.episodeOverrides = {};
  }
  if (!Array.isArray((data as AppData).telegramRequests)) {
    (data as AppData).telegramRequests = [];
  }

  const nextSettings: AppSettings = { ...DEFAULT_SETTINGS, ...data.settings };
  nextSettings.torrentSources = migrateTorrentSources(data.settings as Partial<AppSettings>);
  if (nextSettings.telegramAdminChatIds == null) nextSettings.telegramAdminChatIds = '';
  if (nextSettings.telegramRequestChatIds == null) nextSettings.telegramRequestChatIds = '';
  if (typeof nextSettings.webPortalEnabled !== 'boolean') nextSettings.webPortalEnabled = false;
  if (!nextSettings.webPortalPort || nextSettings.webPortalPort < 1) nextSettings.webPortalPort = 8787;
  if (nextSettings.webPortalBind !== 'lan') nextSettings.webPortalBind = 'localhost';
  if (nextSettings.webPortalAdminPasswordHash == null) nextSettings.webPortalAdminPasswordHash = '';
  if (nextSettings.webPortalSessionSecret == null) nextSettings.webPortalSessionSecret = '';
  if (
    !(nextSettings.telegramAdminChatIds || '').trim() &&
    !(nextSettings.telegramRequestChatIds || '').trim() &&
    (nextSettings.telegramAllowedChatIds || '').trim()
  ) {
    nextSettings.telegramAdminChatIds = nextSettings.telegramAllowedChatIds;
  }

  store.set('settings', nextSettings);
  store.set('shows', data.shows);
  store.set('movies', data.movies);
  store.set('downloads', data.downloads);
  store.set('episodeOverrides', data.episodeOverrides);
  store.set('telegramRequests', (data as AppData).telegramRequests || []);
  store.set('downloadHistory', Array.isArray((data as AppData).downloadHistory) ? (data as AppData).downloadHistory : []);
  store.set(
    'lastDailyBriefingDate',
    typeof (data as AppData).lastDailyBriefingDate === 'string' ? (data as AppData).lastDailyBriefingDate : ''
  );

  return { shows: data.shows.length, movies: (data.movies || []).length };
}
