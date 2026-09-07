export type Resolution = '720p' | '1080p' | '2160p';

export type EpisodeStatus =
  | 'upcoming'
  | 'aired'
  | 'downloaded'
  | 'downloading'
  | 'missing'
  | 'ignored';

export type EpisodeOverrideStatus = 'upcoming' | 'downloaded' | 'missing' | 'ignored';

export type MovieStatus = 'missing' | 'downloaded' | 'downloading';

export type AddShowPolicy = 'all' | 'future' | 'manual';

export type TorrentSourceId =
  | 'apibay'
  | 'knaben'
  | 'yourbittorrent'
  | 'torrentscsv'
  | 'eztv'
  | 'animetosho'
  | 'nyaa'
  | 'limetorrents'
  | 'jackett';

export interface TorrentSources {
  apibay: boolean;
  knaben: boolean;
  yourbittorrent: boolean;
  torrentscsv: boolean;
  eztv: boolean;
  animetosho: boolean;
  nyaa: boolean;
  limetorrents: boolean;
  jackett: boolean;
}

export interface TorrentCandidate {
  magnet: string;
  infoHash?: string;
  title?: string;
}

export interface AppSettings {
  /** @deprecated Movies use IMDb scrape (no key). Kept for older settings files. */
  tmdbApiKey?: string;
  libraryRoot: string;
  movieLibraryRoot: string;
  defaultResolution: Resolution;
  defaultMovieResolution: Resolution;
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
  /** @deprecated Prefer telegramAdminChatIds */
  telegramAllowedChatIds: string;
  telegramAdminChatIds: string;
  telegramRequestChatIds: string;
  /** GitHub PAT for private-repo auto-updates — never log this. */
  githubToken: string;
  /** Max WebTorrent peer connections (default 150). */
  maxConnections: number;
  /** Download speed cap in KiB/s; 0 = unlimited. */
  maxDownloadSpeedKBps: number;
  /** Upload speed cap in KiB/s; 0 = unlimited. */
  maxUploadSpeedKBps: number;
  ftpEnabled: boolean;
  ftpHost: string;
  ftpPort: number;
  ftpUser: string;
  /** Never log this value. */
  ftpPassword: string;
  ftpRemoteBasePath: string;
  vpnEnabled: boolean;
  vpnConfigPath: string;
  vpnConfigName: string;
  vpnUsername: string;
  vpnPassword: string;
  vpnRequireForTorrents: boolean;
}

export type VpnConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface VpnStatus {
  enabled: boolean;
  state: VpnConnectionState;
  message: string;
  openvpnFound: boolean;
  openvpnPath: string | null;
  configPath: string | null;
  configName: string | null;
  bindAddress: string | null;
  requireForTorrents: boolean;
  usernameSet: boolean;
  routeNopull: boolean;
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
  imdbId?: string | null;
  preferredResolution?: Resolution;
  libraryPath?: string;
  seasons: Season[];
  addedAt: string;
  lastRefreshedAt?: string;
}

/** Lightweight library grid row — no season trees. */
export interface ShowListItem {
  id: number;
  tmdbId: number;
  name: string;
  posterPath: string | null;
  status: string;
  firstAirDate: string | null;
  missingCount: number;
  episodeCount: number;
  downloadedCount: number;
}

export interface Movie {
  id: number;
  /** Numeric IMDb title id (tt digits); legacy field name tmdbId kept for store compatibility */
  tmdbId: number;
  title: string;
  overview: string;
  /** IMDb id like tt0133093 */
  imdbId?: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  releaseDate: string | null;
  releaseYear: number | null;
  runtime: number | null;
  status: MovieStatus;
  preferredResolution?: Resolution;
  libraryPath?: string;
  localPath?: string;
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
  kind?: 'episode' | 'movie';
  movieId?: number;
  candidates?: TorrentCandidate[];
  triedInfoHashes?: string[];
  notifyChatId?: number;
  telegramRequestId?: string;
}

export type TelegramRequestStatus = 'pending' | 'approved' | 'denied';
export type TelegramRequestMediaType = 'show' | 'movie';

export interface TelegramRequest {
  id: string;
  mediaType: TelegramRequestMediaType;
  mediaId: number;
  title: string;
  year?: number | null;
  overview?: string;
  requesterChatId: number;
  requesterName?: string;
  status: TelegramRequestStatus;
  createdAt: string;
  resolvedAt?: string;
  resolvedByChatId?: number;
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

export interface TmdbMovieSearchItem {
  id: number;
  title: string;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  releaseDate: string | null;
  releaseYear: number | null;
}

export const DEFAULT_TORRENT_SOURCES: TorrentSources = {
  apibay: true,
  knaben: true,
  yourbittorrent: true,
  torrentscsv: true,
  eztv: true,
  animetosho: true,
  nyaa: true,
  limetorrents: true,
  jackett: false,
};
