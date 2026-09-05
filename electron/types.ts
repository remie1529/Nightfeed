export type Resolution = '720p' | '1080p' | '2160p';

export type EpisodeStatus =
  | 'upcoming'
  | 'aired'
  | 'downloaded'
  | 'downloading'
  | 'missing'
  | 'ignored';

/** Manual statuses persisted across metadata refresh (downloading is always derived). */
export type EpisodeOverrideStatus = 'upcoming' | 'downloaded' | 'missing' | 'ignored';

export type AddShowPolicy = 'all' | 'future' | 'manual';

export interface AppSettings {
  /** Deprecated / unused — metadata is TVMaze (no key). Kept so old stores don't break. */
  tmdbApiKey: string;
  libraryRoot: string;
  defaultResolution: Resolution;
  refreshIntervalMinutes: number;
  searchProvider: 'apibay' | 'jackett';
  jackettUrl: string;
  jackettApiKey: string;
  /** Automatically search + download missing/aired episodes after each refresh. */
  autoDownload: boolean;
  /** Optional pause between auto-started downloads (minutes). 0 = no extra delay. */
  autoDownloadDelayMinutes: number;
  /** Launch app when Windows starts (Electron openAtLogin). */
  launchOnStartup: boolean;
  /** Enable Telegram bot polling in the main process. */
  telegramEnabled: boolean;
  /** Bot token from @BotFather — never log this. */
  telegramBotToken: string;
  /** Comma-separated allowed chat ids (only these can control the bot). */
  telegramAllowedChatIds: string;
}

export interface Episode {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  name: string;
  airDate: string | null;
  overview: string;
  stillPath: string | null;
  status: EpisodeStatus;
  localPath?: string;
}

export interface Season {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  airDate: string | null;
  posterPath: string | null;
  episodes: Episode[];
}

export interface Show {
  id: number;
  /** TVMaze show id (legacy field name tmdbId kept for store compatibility) */
  tmdbId: number;
  name: string;
  overview: string;
  /** Absolute image URL from TVMaze */
  posterPath: string | null;
  backdropPath: string | null;
  firstAirDate: string | null;
  status: string;
  preferredResolution?: Resolution;
  libraryPath?: string;
  seasons: Season[];
  addedAt: string;
  lastRefreshedAt?: string;
}

export interface SearchResult {
  title: string;
  magnet: string;
  size: number;
  seeders: number;
  leechers: number;
  source: string;
  resolution?: Resolution | null;
  infoHash?: string;
}

export interface DownloadItem {
  id: string;
  infoHash: string;
  name: string;
  showId: number;
  showName: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string;
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  numPeers: number;
  status: 'downloading' | 'paused' | 'done' | 'error' | 'queued';
  savePath: string;
  error?: string;
  magnet: string;
}

export interface TelegramStatus {
  enabled: boolean;
  configured: boolean;
  polling: boolean;
  lastUpdateId: number | null;
  lastError: string | null;
  lastOkAt: string | null;
}

export interface UpdateStatus {
  checking: boolean;
  available: boolean;
  downloaded: boolean;
  version: string | null;
  message: string | null;
  error: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  tmdbApiKey: '',
  libraryRoot: '',
  defaultResolution: '1080p',
  refreshIntervalMinutes: 60,
  searchProvider: 'apibay',
  jackettUrl: 'http://127.0.0.1:9117',
  jackettApiKey: '',
  autoDownload: true,
  autoDownloadDelayMinutes: 0,
  launchOnStartup: false,
  telegramEnabled: false,
  telegramBotToken: '',
  telegramAllowedChatIds: '',
};
