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
  /** Ordered TV library roots; first is used for new shows. */
  libraryRoots: string[];
  /** Separate root for movies — never mix with TV libraryRoot. */
  movieLibraryRoot: string;
  /** Ordered movie library roots; first is used for new movies. */
  movieLibraryRoots: string[];
  defaultResolution: Resolution;
  /** Global preferred resolution for movies (per-movie override on Movie). */
  defaultMovieResolution: Resolution;
  /** Never auto-accept TV below this. */
  minimumResolution: Resolution;
  /** Never auto-accept movies below this. */
  minimumMovieResolution: Resolution;
  /** Minimum finished file size in MB per resolution (0 = no extra floor). */
  minSizeMb720p: number;
  minSizeMb1080p: number;
  minSizeMb2160p: number;
  /** Optional staging folder: download, verify, rename, then move into the library. */
  processFolder: string;
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
  /** Daily Telegram digest of downloads in the last 24 hours (admins). */
  telegramDailyBriefing: boolean;
  /** Local hour (0–23) to send the briefing. */
  telegramDailyBriefingHour: number;
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
  /** Enable local HTTP request/admin portal in the main process. */
  webPortalEnabled: boolean;
  /** HTTP listen port (default 8787). */
  webPortalPort: number;
  /** localhost = 127.0.0.1, lan = 0.0.0.0 */
  webPortalBind: 'localhost' | 'lan';
  /** scrypt hash of admin password — never store or log plaintext. */
  webPortalAdminPasswordHash: string;
  /** HMAC secret for admin session cookies. */
  webPortalSessionSecret: string;
  liveTvEnabled: boolean;
  liveTvPort: number;
  liveTvBind: 'localhost' | 'lan';
  liveTvTuners: number;
  liveTvBufferMode: 'off' | 'memory' | 'ffmpeg';
  liveTvBufferKb: number;
  liveTvBufferTimeoutMs: number;
  liveTvUserAgent: string;
  liveTvFfmpegPath: string;
  liveTvHideAdult: boolean;
  liveTvSourceType: 'none' | 'direct' | 'm3u' | 'xtream';
  liveTvDirectUrl: string;
  liveTvDirectName: string;
  liveTvM3uUrl: string;
  liveTvXmltvUrl: string;
  liveTvXtreamHost: string;
  liveTvXtreamUsername: string;
  liveTvXtreamPassword: string;
  liveTvXtreamPort: number;
  liveTvXtreamHls: boolean;
  /** Generate a repeating fake guide when a channel has no XMLTV programmes. */
  liveTvFakeEpgMissing: boolean;
  liveTvFakeEpgMinutes: number;
  liveTvFakeEpgDays: number;
}

export interface LiveTvChannel {
  id: string;
  name: string;
  number: number;
  group: string;
  logo: string;
  tvgId: string;
  url: string;
  enabled: boolean;
  /** Keep this logo on playlist refresh. */
  logoCustom?: boolean;
  /** Keep this tvgId on playlist refresh. */
  epgCustom?: boolean;
  /** Always emit a fake repeating guide for this channel. */
  fakeEpg?: boolean;
}

export interface LiveTvEpgOption {
  id: string;
  name: string;
}

export interface LiveTvStatus {
  enabled: boolean;
  listening: boolean;
  port: number;
  bind: 'localhost' | 'lan';
  ffmpegFound: boolean;
  ffmpegPath: string | null;
  tuners: number;
  tunersInUse: number;
  channelCount: number;
  enabledCount: number;
  lastError: string | null;
  lastRefresh: string | null;
  tunerUrl: string;
  xmltvUrl: string;
  active: Array<{ number: number; name: string }>;
}

export type VpnConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';
export type VpnLaunchMethod = 'direct' | 'interactive-service' | 'elevated' | null;

export interface VpnStatus {
  enabled: boolean;
  state: VpnConnectionState;
  message: string;
  openvpnFound: boolean;
  openvpnPath: string | null;
  configPath: string | null;
  configName: string | null;
  bindAddress: string | null;
  bindIfIndex: number | null;
  requireForTorrents: boolean;
  usernameSet: boolean;
  routeNopull: boolean;
  lastError: string | null;
  launchMethod: VpnLaunchMethod;
  /** True when torrents are blocked because VPN is required and not connected. */
  killSwitch: boolean;
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

export interface CalendarEpisode {
  tmdbId: number;
  showName: string;
  posterPath: string | null;
  seasonNumber: number;
  episodeNumber: number;
  name: string;
  airDate: string;
  status: EpisodeStatus;
}

/** Lightweight library grid row — no season trees / no disk scan. */
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

export interface DownloadHistoryItem {
  at: string;
  title: string;
  kind: 'episode' | 'movie';
  posterUrl?: string | null;
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
  /** Absolute poster image URL (TVMaze / IMDb). */
  posterUrl?: string | null;
  /** Telegram chat id; 0 for web-only requesters (no Telegram notify). */
  requesterChatId: number;
  requesterName?: string;
  status: TelegramRequestStatus;
  createdAt: string;
  resolvedAt?: string;
  resolvedByChatId?: number;
  /** Origin of the request (telegram bot vs local web portal). */
  source?: 'telegram' | 'web';
}

export interface TelegramStatus {
  enabled: boolean;
  configured: boolean;
  polling: boolean;
  lastUpdateId: number | null;
  lastError: string | null;
  lastOkAt: string | null;
  /** Parsed Admin chat IDs currently loaded from settings. */
  adminChatIdCount: number;
  /** Parsed Requests chat IDs currently loaded from settings. */
  requestChatIdCount: number;
}

export interface UpdateStatus {
  checking: boolean;
  available: boolean;
  downloaded: boolean;
  version: string | null;
  message: string | null;
  error: string | null;
  /** 0–100 while the installer is downloading. */
  progress: number | null;
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
  telegramDailyBriefing: false,
  telegramDailyBriefingHour: 9,
  githubToken: '',
  maxConnections: 55,
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
  liveTvEnabled: false,
  liveTvPort: 34400,
  liveTvBind: 'lan',
  liveTvTuners: 3,
  liveTvBufferMode: 'memory',
  liveTvBufferKb: 1024,
  liveTvBufferTimeoutMs: 8000,
  liveTvUserAgent: 'VLC/3.0.20 LibVLC/3.0.20',
  liveTvFfmpegPath: '',
  liveTvHideAdult: true,
  liveTvSourceType: 'none',
  liveTvDirectUrl: '',
  liveTvDirectName: '',
  liveTvM3uUrl: '',
  liveTvXmltvUrl: '',
  liveTvXtreamHost: '',
  liveTvXtreamUsername: '',
  liveTvXtreamPassword: '',
  liveTvXtreamPort: 80,
  liveTvXtreamHls: false,
  liveTvFakeEpgMissing: true,
  liveTvFakeEpgMinutes: 60,
  liveTvFakeEpgDays: 2,
};
