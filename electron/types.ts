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

export interface FtpSettings {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  /** Never log this value. */
  password: string;
  /** Remote base directory for finished TV/movie files. */
  remoteBasePath: string;
}

/** Ranked magnet candidates for auto-retry after bad payloads (e.g. .exe). */
export interface TorrentCandidate {
  magnet: string;
  infoHash?: string;
  title?: string;
}

export interface AppSettings {
  /** @deprecated Movies use IMDb scrape (no key). Kept for older settings files. */
  tmdbApiKey?: string;
  libraryRoot: string;
  /** Separate root for movies — never mix with TV libraryRoot. */
  movieLibraryRoot: string;
  defaultResolution: Resolution;
  /** Global preferred resolution for movies (per-movie override on Movie). */
  defaultMovieResolution: Resolution;
  refreshIntervalMinutes: number;
  /**
   * @deprecated Use torrentSources. Kept so older electron-store data still loads.
   */
  searchProvider?: 'apibay' | 'jackett';
  /** Which free/optional torrent indexes to query (all enabled are searched & merged). */
  torrentSources: TorrentSources;
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
  /**
   * @deprecated Prefer telegramAdminChatIds. Kept for migration from older installs.
   */
  telegramAllowedChatIds: string;
  /** Comma-separated admin chat ids (approvals + full bot commands). */
  telegramAdminChatIds: string;
  /** Comma-separated request-only chat ids (can submit movie/TV requests). */
  telegramRequestChatIds: string;
  /** GitHub PAT for private-repo auto-updates — never log this. */
  githubToken: string;
  /** Max WebTorrent peer connections (default 150). */
  maxConnections: number;
  /** Download speed cap in KiB/s; 0 = unlimited. */
  maxDownloadSpeedKBps: number;
  /** Upload speed cap in KiB/s; 0 = unlimited. */
  maxUploadSpeedKBps: number;
  /** Optional FTP upload of finished library files. */
  ftpEnabled: boolean;
  ftpHost: string;
  ftpPort: number;
  ftpUser: string;
  /** Never log this value. */
  ftpPassword: string;
  /** Remote base path (TV and/or movies share one base). */
  ftpRemoteBasePath: string;
  /** Enable OpenVPN controls (torrent traffic only when connected). */
  vpnEnabled: boolean;
  /** Copied .ovpn path under userData/vpn (never ship secrets in repo). */
  vpnConfigPath: string;
  /** Original .ovpn filename for Settings display. */
  vpnConfigName: string;
  /** Optional OpenVPN auth username. */
  vpnUsername: string;
  /** Optional OpenVPN auth password — never log. */
  vpnPassword: string;
  /** Refuse to start torrent downloads until VPN is connected. */
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
  /** TVMaze show id (legacy field name tmdbId kept for store compatibility) */
  tmdbId: number;
  name: string;
  overview: string;
  /** Absolute image URL from TVMaze */
  posterPath: string | null;
  backdropPath: string | null;
  firstAirDate: string | null;
  status: string;
  /** IMDb id from TVMaze externals, e.g. "tt0903747" — used by EZTV */
  imdbId?: string | null;
  preferredResolution?: Resolution;
  libraryPath?: string;
  seasons: Season[];
  addedAt: string;
  lastRefreshedAt?: string;
}

export interface Movie {
  id: number;
  /** Numeric IMDb title id (tt digits); legacy field name tmdbId kept for store compatibility */
  tmdbId: number;
  title: string;
  overview: string;
  /** IMDb id like tt0133093 */
  imdbId?: string | null;
  /** Absolute poster image URL (IMDb / Amazon CDN) */
  posterPath: string | null;
  backdropPath: string | null;
  releaseDate: string | null;
  releaseYear: number | null;
  /** Runtime in minutes if available */
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
  /** 'movie' for movie downloads; omitted/episode for TV (backwards compatible). */
  kind?: 'episode' | 'movie';
  movieId?: number;
  /** Ranked search candidates for .exe auto-retry. */
  candidates?: TorrentCandidate[];
  /** Infohashes already attempted for this episode/movie. */
  triedInfoHashes?: string[];
  /** Telegram requester to notify when this download finishes. */
  notifyChatId?: number;
  /** Pending/approved Telegram request id that started this download. */
  telegramRequestId?: string;
}

export type TelegramRequestStatus = 'pending' | 'approved' | 'denied';

export type TelegramRequestMediaType = 'show' | 'movie';

export interface TelegramRequest {
  id: string;
  mediaType: TelegramRequestMediaType;
  /** TVMaze show id or IMDb numeric title id (same as Show/Movie.tmdbId). */
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

export const DEFAULT_SETTINGS: AppSettings = {
  tmdbApiKey: '',
  libraryRoot: '',
  movieLibraryRoot: '',
  defaultResolution: '1080p',
  defaultMovieResolution: '1080p',
  refreshIntervalMinutes: 60,
  torrentSources: { ...DEFAULT_TORRENT_SOURCES },
  searchProvider: 'apibay',
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
};
