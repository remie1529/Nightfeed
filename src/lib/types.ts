export type Resolution = '720p' | '1080p' | '2160p';

export type EpisodeStatus =
  | 'upcoming'
  | 'aired'
  | 'downloaded'
  | 'downloading'
  | 'missing'
  | 'ignored';

export type EpisodeOverrideStatus = 'upcoming' | 'downloaded' | 'missing' | 'ignored';

export type AddShowPolicy = 'all' | 'future' | 'manual';

export type TorrentSourceId = 'apibay' | 'uindex' | 'jackett';

export interface TorrentSources {
  apibay: boolean;
  uindex: boolean;
  jackett: boolean;
}

export interface AppSettings {
  tmdbApiKey: string;
  libraryRoot: string;
  defaultResolution: Resolution;
  refreshIntervalMinutes: number;
  /** @deprecated Use torrentSources */
  searchProvider?: 'apibay' | 'jackett';
  torrentSources: TorrentSources;
  jackettUrl: string;
  jackettApiKey: string;
  autoDownload: boolean;
  autoDownloadDelayMinutes: number;
  launchOnStartup: boolean;
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramAllowedChatIds: string;
  /** GitHub PAT for private-repo auto-updates — never log this. */
  githubToken: string;
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
  tmdbId: number;
  name: string;
  overview: string;
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

export interface MazeSearchItem {
  id: number;
  name: string;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  firstAirDate: string | null;
  status: string;
}
