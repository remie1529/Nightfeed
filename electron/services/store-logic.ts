import {
  AppSettings,
  DEFAULT_SETTINGS,
  DEFAULT_TORRENT_SOURCES,
  DownloadHistoryItem,
  DownloadItem,
  EpisodeOverrideStatus,
  LiveTvChannel,
  Movie,
  Resolution,
  Show,
  TelegramRequest,
} from '../types';

export interface AppData {
  settings: AppSettings;
  shows: Show[];
  movies: Movie[];
  downloads: DownloadItem[];
  /**
   * Infohashes rejected/abandoned per episode or movie, durable across restarts.
   * Keys: `ep:${showId}:${season}:${episode}` or `movie:${movieId}`.
   */
  triedTorrents: Record<string, string[]>;
  /** Manual episode status overrides keyed by `${showId}:${season}:${episode}` */
  episodeOverrides: Record<string, EpisodeOverrideStatus>;
  /** Known on-disk resolutions keyed by `${showId}:${season}:${episode}` */
  episodeResolutions: Record<string, Resolution>;
  /** Telegram movie/TV requests (pending / approved / denied). */
  telegramRequests: TelegramRequest[];
  downloadHistory: DownloadHistoryItem[];
  lastDailyBriefingDate: string;
  liveTvLineup: LiveTvChannel[];
  /** Custom library channels, stored separately so a playlist refresh cannot drop them. */
  liveTvCustomChannels: LiveTvChannel[];
  liveTvXmltvCache: string;
}

export type BackupSnapshot = AppData & {
  exportedAt: string;
  app: string;
  version: number;
};

const VALID_RESOLUTIONS = new Set<Resolution>(['720p', '1080p', '2160p']);

export function isLibraryChannel(c: LiveTvChannel): boolean {
  return c?.kind === 'library' || String(c?.url || '').startsWith('nightfeed://library/');
}

export function migrateTorrentSources(raw: Partial<AppSettings>): AppSettings['torrentSources'] {
  const base = { ...DEFAULT_TORRENT_SOURCES };
  if (raw.torrentSources && typeof raw.torrentSources === 'object') {
    const src = raw.torrentSources as unknown as Record<string, unknown>;
    const out = { ...base };
    for (const key of Object.keys(base) as Array<keyof typeof base>) {
      if (typeof src[key] === 'boolean') out[key] = src[key] as boolean;
    }
    return out;
  }
  // Legacy single-provider dropdown → multi-source defaults
  if (raw.searchProvider === 'jackett') {
    return { ...base, jackett: true };
  }
  return base;
}

export function normalizeLiveTvLineup(
  rawLineup: unknown,
  rawCustom?: unknown
): { lineup: LiveTvChannel[]; customChannels: LiveTvChannel[] } {
  const baseLineup = Array.isArray(rawLineup)
    ? (rawLineup as LiveTvChannel[]).filter((c) => !!c && typeof c === 'object' && !!c.id)
    : [];
  const savedCustom = Array.isArray(rawCustom)
    ? (rawCustom as LiveTvChannel[]).filter((c) => !!c && typeof c === 'object' && !!c.id && isLibraryChannel(c))
    : [];
  const ids = new Set(baseLineup.map((c) => c.id));
  const extra = savedCustom.filter((c) => !ids.has(c.id));
  const lineup = [...baseLineup, ...extra].map((c) =>
    isLibraryChannel(c) ? { ...c, kind: 'library' as const } : { ...c }
  );
  const customChannels = lineup.filter((c) => isLibraryChannel(c));
  return { lineup, customChannels };
}

export function sanitizeEpisodeResolutions(raw: unknown): Record<string, Resolution> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, Resolution> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && VALID_RESOLUTIONS.has(v as Resolution)) {
      out[k] = v as Resolution;
    }
  }
  return out;
}

export function buildBackupSnapshot(data: AppData): BackupSnapshot {
  const { lineup, customChannels } = normalizeLiveTvLineup(
    data.liveTvLineup,
    data.liveTvCustomChannels
  );
  return {
    settings: data.settings,
    shows: data.shows,
    movies: data.movies,
    downloads: data.downloads,
    triedTorrents: data.triedTorrents,
    episodeOverrides: data.episodeOverrides,
    episodeResolutions: sanitizeEpisodeResolutions(data.episodeResolutions),
    telegramRequests: data.telegramRequests,
    downloadHistory: data.downloadHistory,
    lastDailyBriefingDate: data.lastDailyBriefingDate,
    liveTvLineup: lineup,
    liveTvCustomChannels: customChannels,
    liveTvXmltvCache: '',
    exportedAt: new Date().toISOString(),
    app: 'Nightfeed',
    version: 1,
  };
}

/**
 * Validate and normalize a backup payload without mutating the input object.
 */
export function prepareImportedBackupData(raw: unknown): {
  data: AppData;
  counts: { shows: number; movies: number; liveTvChannels: number };
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid backup: not an object');
  }
  const input = raw as Partial<AppData> & { settings?: AppSettings };
  if (!input.settings || typeof input.settings !== 'object' || Array.isArray(input.settings)) {
    throw new Error('Invalid backup: missing settings');
  }
  if (!Array.isArray(input.shows)) {
    throw new Error('Invalid backup: missing shows array');
  }

  const nextSettings: AppSettings = { ...DEFAULT_SETTINGS, ...input.settings };
  nextSettings.torrentSources = migrateTorrentSources(input.settings as Partial<AppSettings>);
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

  const shows = input.shows.slice();
  const movies = Array.isArray(input.movies) ? input.movies.slice() : [];
  const downloads = Array.isArray(input.downloads) ? input.downloads.slice() : [];
  const triedTorrents =
    input.triedTorrents && typeof input.triedTorrents === 'object' && !Array.isArray(input.triedTorrents)
      ? { ...input.triedTorrents }
      : {};
  const episodeOverrides =
    input.episodeOverrides && typeof input.episodeOverrides === 'object' && !Array.isArray(input.episodeOverrides)
      ? { ...input.episodeOverrides }
      : {};
  const episodeResolutions = sanitizeEpisodeResolutions(input.episodeResolutions);
  const telegramRequests = Array.isArray(input.telegramRequests) ? input.telegramRequests.slice() : [];
  const downloadHistory = Array.isArray(input.downloadHistory) ? input.downloadHistory.slice() : [];
  const lastDailyBriefingDate =
    typeof input.lastDailyBriefingDate === 'string' ? input.lastDailyBriefingDate : '';
  const { lineup, customChannels } = normalizeLiveTvLineup(
    input.liveTvLineup,
    input.liveTvCustomChannels
  );

  return {
    data: {
      settings: nextSettings,
      shows,
      movies,
      downloads,
      triedTorrents,
      episodeOverrides,
      episodeResolutions,
      telegramRequests,
      downloadHistory,
      lastDailyBriefingDate,
      liveTvLineup: lineup,
      liveTvCustomChannels: customChannels,
      liveTvXmltvCache: '',
    },
    counts: {
      shows: shows.length,
      movies: movies.length,
      liveTvChannels: lineup.length,
    },
  };
}

/**
 * Merge refreshed shows from a bulk refresh into the live store shows list
 * without clobbering concurrent additions, removals, user setting edits, or
 * episodes that finished downloading while the refresh was in flight.
 */
export function mergeBulkShows(
  liveShows: Show[],
  pendingUpdates: Map<number, Show>,
  removedIds: Set<number>,
  externallyEditedIds: Set<number>
): Show[] {
  const out = liveShows.slice();
  for (const [tmdbId, refreshed] of pendingUpdates) {
    if (removedIds.has(tmdbId)) continue;
    const idx = out.findIndex((s) => s.tmdbId === tmdbId);
    if (idx < 0) {
      out.push(refreshed);
      continue;
    }
    if (!externallyEditedIds.has(tmdbId)) {
      out[idx] = refreshed;
      continue;
    }
    const live = out[idx];
    // Preserve live user-editable show fields and any episode that became
    // downloaded locally while the background refresh was running.
    const liveDownloaded = new Map<string, { localPath?: string; downloadedResolution?: Resolution }>();
    for (const season of live.seasons || []) {
      for (const ep of season.episodes || []) {
        if (ep.status === 'downloaded' && ep.localPath) {
          liveDownloaded.set(`${season.seasonNumber}:${ep.episodeNumber}`, {
            localPath: ep.localPath,
            downloadedResolution: ep.downloadedResolution,
          });
        }
      }
    }
    const mergedSeasons = (refreshed.seasons || []).map((season) => ({
      ...season,
      episodes: (season.episodes || []).map((ep) => {
        const hit = liveDownloaded.get(`${season.seasonNumber}:${ep.episodeNumber}`);
        if (hit && ep.status !== 'downloaded') {
          return {
            ...ep,
            status: 'downloaded' as const,
            localPath: hit.localPath,
            downloadedResolution: ep.downloadedResolution || hit.downloadedResolution,
          };
        }
        return ep;
      }),
    }));
    out[idx] = {
      ...refreshed,
      preferredResolution: live.preferredResolution,
      minimumResolution: live.minimumResolution,
      minSizeMb720p: live.minSizeMb720p,
      minSizeMb1080p: live.minSizeMb1080p,
      minSizeMb2160p: live.minSizeMb2160p,
      monitored: live.monitored,
      libraryPath: live.libraryPath ?? refreshed.libraryPath,
      seasons: mergedSeasons,
    };
  }
  return out;
}
