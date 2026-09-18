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
  | 'yts'
  | 'therarbg'
  | 'torrentdownloads'
  | 'solidtorrents'
  | 'torrentdownload'
  | 'tpbmirror'
  | 'limetorrents'
  | 'animetosho'
  | 'nyaa'
  | 'tokyotosho'
  | 'bangumi'
  | 'mikan'
  | 'dmhy'
  | 'acgnx'
  | 'subsplease'
  | 'sukebei'
  | 'jackett';

export interface TorrentSources {
  apibay: boolean;
  knaben: boolean;
  yourbittorrent: boolean;
  torrentscsv: boolean;
  eztv: boolean;
  yts: boolean;
  therarbg: boolean;
  torrentdownloads: boolean;
  solidtorrents: boolean;
  torrentdownload: boolean;
  tpbmirror: boolean;
  limetorrents: boolean;
  animetosho: boolean;
  nyaa: boolean;
  tokyotosho: boolean;
  bangumi: boolean;
  mikan: boolean;
  dmhy: boolean;
  acgnx: boolean;
  subsplease: boolean;
  sukebei: boolean;
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
  libraryRoots: string[];
  movieLibraryRoot: string;
  movieLibraryRoots: string[];
  defaultResolution: Resolution;
  defaultMovieResolution: Resolution;
  minimumResolution: Resolution;
  minimumMovieResolution: Resolution;
  minSizeMbTv720p: number;
  minSizeMbTv1080p: number;
  minSizeMbTv2160p: number;
  minSizeMbMovie720p: number;
  minSizeMbMovie1080p: number;
  minSizeMbMovie2160p: number;
  /** @deprecated Migrated to minSizeMbTv* / minSizeMbMovie* */
  minSizeMb720p?: number;
  /** @deprecated */
  minSizeMb1080p?: number;
  /** @deprecated */
  minSizeMb2160p?: number;
  processFolder: string;
  refreshIntervalMinutes: number;
  /** @deprecated Use torrentSources */
  searchProvider?: 'apibay' | 'jackett';
  torrentSources: TorrentSources;
  jackettUrl: string;
  jackettApiKey: string;
  autoDownload: boolean;
  autoDownloadDelayMinutes: number;
  launchOnStartup: boolean;
  restartOnCrash: boolean;
  telegramEnabled: boolean;
  telegramBotToken: string;
  /** @deprecated Prefer telegramAdminChatIds */
  telegramAllowedChatIds: string;
  telegramAdminChatIds: string;
  telegramRequestChatIds: string;
  telegramDailyBriefing: boolean;
  telegramDailyBriefingHour: number;
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
  webPortalEnabled: boolean;
  webPortalPort: number;
  webPortalBind: 'localhost' | 'lan';
  /** Present when a password has been set (hash never shown in UI). */
  webPortalAdminPasswordHash?: string;
  webPortalSessionSecret?: string;
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
  logoCustom?: boolean;
  epgCustom?: boolean;
  fakeEpg?: boolean;
  /** UI-only data URL; not persisted. */
  logoPreview?: string;
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

export type TelegramRequestStatus = 'pending' | 'approved' | 'denied' | 'downloaded';
export type TelegramRequestMediaType = 'show' | 'movie';

export interface TelegramRequest {
  id: string;
  mediaType: TelegramRequestMediaType;
  mediaId: number;
  title: string;
  year?: number | null;
  overview?: string;
  /** Absolute poster image URL (TVMaze / IMDb). */
  posterUrl?: string | null;
  requesterChatId: number;
  requesterName?: string;
  /** Anonymous web portal client id (localStorage). */
  requesterClientId?: string;
  status: TelegramRequestStatus;
  createdAt: string;
  resolvedAt?: string;
  resolvedByChatId?: number;
  source?: 'telegram' | 'web';
}

export interface WebPortalStatus {
  enabled: boolean;
  listening: boolean;
  port: number;
  bind: string;
  urls: string[];
  lastError: string | null;
  passwordSet: boolean;
}

export interface TelegramStatus {
  enabled: boolean;
  configured: boolean;
  polling: boolean;
  lastUpdateId: number | null;
  lastError: string | null;
  lastOkAt: string | null;
  adminChatIdCount: number;
  requestChatIdCount: number;
}

export interface UpdateStatus {
  checking: boolean;
  available: boolean;
  downloaded: boolean;
  version: string | null;
  message: string | null;
  error: string | null;
  progress: number | null;
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
  yts: true,
  therarbg: true,
  torrentdownloads: true,
  solidtorrents: true,
  torrentdownload: true,
  tpbmirror: true,
  limetorrents: true,
  animetosho: false,
  nyaa: true,
  tokyotosho: true,
  bangumi: false,
  mikan: false,
  dmhy: false,
  acgnx: false,
  subsplease: false,
  sukebei: false,
  jackett: false,
};
