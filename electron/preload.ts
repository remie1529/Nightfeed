import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  CalendarEpisode,
  DownloadItem,
  EpisodeOverrideStatus,
  LiveTvChannel,
  LiveTvEpgOption,
  LiveTvStatus,
  MazeSearchItem,
  Movie,
  SearchResult,
  Show,
  ShowListItem,
  TelegramRequest,
  TelegramStatus,
  TmdbMovieSearchItem,
  UpdateStatus,
  VpnStatus,
  WebPortalStatus,
} from './types';

const api = {
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (partial: Partial<AppSettings> | Record<string, unknown>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:set', partial),
  pickLibraryFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder'),

  searchShows: (query: string): Promise<MazeSearchItem[]> =>
    ipcRenderer.invoke('tmdb:search', query),
  addShow: (mazeId: number, policy?: 'all' | 'future' | 'manual'): Promise<Show> =>
    ipcRenderer.invoke('library:add', mazeId, policy),
  removeShow: (mazeId: number): Promise<Show[]> => ipcRenderer.invoke('library:remove', mazeId),
  bulkUpdateShows: (mazeIds: number[], partial: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('library:bulkUpdate', mazeIds, partial),
  bulkRemoveShows: (mazeIds: number[]): Promise<unknown> =>
    ipcRenderer.invoke('library:bulkRemove', mazeIds),
  bulkSetShowMissingStatus: (
    mazeIds: number[],
    status: 'missing' | 'ignored'
  ): Promise<unknown> => ipcRenderer.invoke('library:bulkSetMissingStatus', mazeIds, status),
  getShows: (): Promise<ShowListItem[]> => ipcRenderer.invoke('library:list'),
  getCalendar: (from: string, to: string): Promise<CalendarEpisode[]> =>
    ipcRenderer.invoke('library:calendar', from, to),
  getAddonCatalog: (): Promise<unknown> => ipcRenderer.invoke('addons:catalog'),
  getInstalledAddons: (): Promise<unknown> => ipcRenderer.invoke('addons:installed'),
  getAddonPages: (): Promise<
    Array<{ addonId: string; pageId: string; title: string; html: string; rev?: number }>
  > => ipcRenderer.invoke('addons:pages'),
  installStoreAddon: (id: string): Promise<unknown> =>
    ipcRenderer.invoke('addons:installStore', id),
  installAddonFile: (): Promise<unknown> => ipcRenderer.invoke('addons:installFile'),
  setAddonEnabled: (id: string, enabled: boolean): Promise<unknown> =>
    ipcRenderer.invoke('addons:setEnabled', id, enabled),
  removeAddon: (id: string): Promise<unknown> => ipcRenderer.invoke('addons:remove', id),
  addonPageAction: (addonId: string, action: string, payload: unknown): Promise<unknown> =>
    ipcRenderer.invoke('addons:action', addonId, action, payload),
  getAddonSettings: (): Promise<unknown> => ipcRenderer.invoke('addons:settings'),
  setAddonSetting: (addonId: string, fieldId: string, value: string): Promise<unknown> =>
    ipcRenderer.invoke('addons:setSetting', addonId, fieldId, value),
  runAddonSettingAction: (addonId: string, fieldId: string): Promise<unknown> =>
    ipcRenderer.invoke('addons:settingAction', addonId, fieldId),
  onAddonNavigate: (cb: (nav: { kind?: string; id?: number }) => void) => {
    const listener = (_: unknown, nav: { kind?: string; id?: number }) => cb(nav);
    ipcRenderer.on('addons:navigate', listener);
    return () => {
      ipcRenderer.removeListener('addons:navigate', listener);
    };
  },
  onAddonsChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('addons:changed', listener);
    ipcRenderer.on('addons:pages', listener);
    return () => {
      ipcRenderer.removeListener('addons:changed', listener);
      ipcRenderer.removeListener('addons:pages', listener);
    };
  },
  getShow: (mazeId: number): Promise<Show | null> => ipcRenderer.invoke('library:get', mazeId),
  previewShow: (mazeId: number): Promise<Show> => ipcRenderer.invoke('library:preview', mazeId),
  updateShow: (mazeId: number, partial: Record<string, unknown>): Promise<Show | null> =>
    ipcRenderer.invoke('library:update', mazeId, partial),
  refreshShow: (mazeId: number): Promise<Show> => ipcRenderer.invoke('library:refresh', mazeId),
  refreshAll: () =>
    ipcRenderer.invoke('library:refreshAll') as Promise<{
      ok: boolean;
      started?: boolean;
      alreadyRunning?: boolean;
    }>,
  scanLibraryPreview: (scope: 'tv' | 'movies' | 'both'): Promise<unknown> =>
    ipcRenderer.invoke('library:scanPreview', scope),
  scanLibraryImport: (
    items: Array<{
      id: string;
      kind: 'show' | 'movie';
      folderPath: string;
      matchId: number;
      selected: boolean;
    }>
  ): Promise<unknown> => ipcRenderer.invoke('library:scanImport', items),
  setEpisodeStatus: (
    mazeId: number,
    season: number,
    episode: number,
    status: EpisodeOverrideStatus
  ): Promise<Show | null> =>
    ipcRenderer.invoke('library:setEpisodeStatus', mazeId, season, episode, status),
  setSeasonStatus: (
    mazeId: number,
    season: number,
    status: EpisodeOverrideStatus
  ): Promise<Show | null> =>
    ipcRenderer.invoke('library:setSeasonStatus', mazeId, season, status),

  searchTorrents: (
    mazeId: number,
    season: number,
    episode: number
  ): Promise<{
    results: SearchResult[];
    query: string;
    error?: string;
    dateFiltered?: number;
    blockFiltered?: number;
  }> => ipcRenderer.invoke('search:episode', mazeId, season, episode),
  startDownload: (payload: {
    tmdbId: number;
    season: number;
    episode: number;
    episodeTitle: string;
    magnet: string;
    candidates?: Array<{ magnet: string; infoHash?: string; title?: string }>;
    ignoreMinSize?: boolean;
  }): Promise<unknown> => ipcRenderer.invoke('download:start', payload),
  getDownloads: (): Promise<DownloadItem[]> => ipcRenderer.invoke('download:list'),
  addManualDownload: (payload: { magnet?: string; torrentPath?: string }): Promise<unknown> =>
    ipcRenderer.invoke('download:addManual', payload),
  pauseDownload: (id: string): Promise<unknown> => ipcRenderer.invoke('download:pause', id),
  resumeDownload: (id: string): Promise<unknown> => ipcRenderer.invoke('download:resume', id),
  cancelDownload: (id: string): Promise<unknown> => ipcRenderer.invoke('download:cancel', id),

  // Movies (TMDB)
  searchMovies: (query: string): Promise<TmdbMovieSearchItem[]> =>
    ipcRenderer.invoke('tmdb:searchMovies', query),
  getMovies: (): Promise<Movie[]> => ipcRenderer.invoke('movies:list'),
  getMovie: (tmdbId: number): Promise<Movie | null> => ipcRenderer.invoke('movies:get', tmdbId),
  previewMovie: (tmdbId: number): Promise<Movie> => ipcRenderer.invoke('movies:preview', tmdbId),
  getTrailer: (imdbId: string) =>
    ipcRenderer.invoke('media:trailer', imdbId) as Promise<{ url: string | null }>,
  addMovie: (tmdbId: number): Promise<Movie> => ipcRenderer.invoke('movies:add', tmdbId),
  removeMovie: (tmdbId: number): Promise<Movie[]> => ipcRenderer.invoke('movies:remove', tmdbId),
  bulkUpdateMovies: (tmdbIds: number[], partial: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('movies:bulkUpdate', tmdbIds, partial),
  bulkRemoveMovies: (tmdbIds: number[]): Promise<unknown> =>
    ipcRenderer.invoke('movies:bulkRemove', tmdbIds),
  updateMovie: (tmdbId: number, partial: Record<string, unknown>): Promise<Movie | null> =>
    ipcRenderer.invoke('movies:update', tmdbId, partial),
  refreshMovie: (tmdbId: number): Promise<Movie> => ipcRenderer.invoke('movies:refresh', tmdbId),
  searchMovieTorrents: (
    tmdbId: number
  ): Promise<{
    results: SearchResult[];
    query: string;
    error?: string;
    yearFiltered?: number;
    titleFiltered?: number;
    blockFiltered?: number;
  }> => ipcRenderer.invoke('search:movie', tmdbId),
  startMovieDownload: (payload: {
    tmdbId: number;
    magnet: string;
    candidates?: Array<{ magnet: string; infoHash?: string; title?: string }>;
    ignoreMinSize?: boolean;
  }): Promise<unknown> => ipcRenderer.invoke('download:startMovie', payload),

  getTelegramStatus: (): Promise<TelegramStatus> => ipcRenderer.invoke('telegram:status'),
  sendTelegramTest: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('telegram:test'),
  listRequests: (): Promise<TelegramRequest[]> => ipcRenderer.invoke('requests:list'),
  getPendingRequestCount: (): Promise<number> => ipcRenderer.invoke('requests:pendingCount'),
  resolveRequest: (
    id: string,
    action: 'approved' | 'denied'
  ): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('requests:resolve', id, action),
  getWebPortalStatus: (): Promise<WebPortalStatus> => ipcRenderer.invoke('webPortal:status'),
  getMcpStatus: (): Promise<unknown> => ipcRenderer.invoke('mcp:status'),
  pickFile: (filters?: Array<{ name: string; extensions: string[] }>): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pickFile', filters),
  getLiveTvStatus: (): Promise<LiveTvStatus> => ipcRenderer.invoke('liveTv:status'),
  getLiveTvChannels: (): Promise<LiveTvChannel[]> => ipcRenderer.invoke('liveTv:channels'),
  refreshLiveTv: (): Promise<LiveTvChannel[]> => ipcRenderer.invoke('liveTv:refresh'),
  setLiveTvChannels: (channels: LiveTvChannel[]): Promise<LiveTvChannel[]> =>
    ipcRenderer.invoke('liveTv:setChannels', channels),
  getLiveTvEpgOptions: (): Promise<LiveTvEpgOption[]> => ipcRenderer.invoke('liveTv:epgOptions'),
  setLiveTvIcon: (channelId: string, filePath: string): Promise<LiveTvChannel[]> =>
    ipcRenderer.invoke('liveTv:setIcon', channelId, filePath),
  onSettingsChanged: (cb: (s: AppSettings) => void) => {
    const listener = (_: unknown, s: AppSettings) => cb(s);
    ipcRenderer.on('settings:changed', listener);
    return () => {
      ipcRenderer.removeListener('settings:changed', listener);
    };
  },

  exportBackup: (): Promise<{ ok?: boolean; canceled?: boolean; path?: string }> =>
    ipcRenderer.invoke('backup:export'),
  importBackup: (): Promise<{
    ok?: boolean;
    canceled?: boolean;
    shows?: number;
    movies?: number;
    path?: string;
  }> => ipcRenderer.invoke('backup:import'),

  isAppReady: (): Promise<boolean> => ipcRenderer.invoke('app:isReady'),
  onAppReady: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('app:ready', listener);
    return () => {
      ipcRenderer.removeListener('app:ready', listener);
    };
  },
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  getThreadInfo: (): Promise<unknown> => ipcRenderer.invoke('app:getThreadInfo'),
  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:status'),
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:check'),
  downloadUpdate: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:download'),
  installUpdate: (): Promise<unknown> => ipcRenderer.invoke('update:install'),

  cachedPoster: (url: string): Promise<string | null> => ipcRenderer.invoke('poster:cache', url),

  getVpnStatus: (): Promise<VpnStatus> => ipcRenderer.invoke('vpn:status'),
  importVpnConfig: () => ipcRenderer.invoke('vpn:importConfig'),
  connectVpn: () => ipcRenderer.invoke('vpn:connect'),
  disconnectVpn: () => ipcRenderer.invoke('vpn:disconnect'),
  detectOpenVpn: () => ipcRenderer.invoke('vpn:detect'),

  onDownloadsUpdate: (cb: (items: DownloadItem[]) => void) => {
    const listener = (_: unknown, items: DownloadItem[]) => cb(items);
    ipcRenderer.on('downloads:update', listener);
    return () => {
      ipcRenderer.removeListener('downloads:update', listener);
    };
  },

  onLibraryChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('library:changed', listener);
    return () => {
      ipcRenderer.removeListener('library:changed', listener);
    };
  },

  onRefreshAllProgress: (
    cb: (payload: {
      phase: 'refresh' | 'hunt' | 'movies' | 'done';
      current: number;
      total: number;
      label?: string;
    }) => void
  ) => {
    const listener = (
      _: unknown,
      payload: {
        phase: 'refresh' | 'hunt' | 'movies' | 'done';
        current: number;
        total: number;
        label?: string;
      }
    ) => cb(payload);
    ipcRenderer.on('library:refreshAllProgress', listener);
    return () => {
      ipcRenderer.removeListener('library:refreshAllProgress', listener);
    };
  },

  onRefreshAllDone: (
    cb: (payload: {
      ok: boolean;
      showCount?: number;
      failed?: number;
      huntStarted?: number;
      movieStarted?: number;
      durationMs?: number;
      error?: string;
    }) => void
  ) => {
    const listener = (
      _: unknown,
      payload: {
        ok: boolean;
        showCount?: number;
        failed?: number;
        huntStarted?: number;
        movieStarted?: number;
        durationMs?: number;
        error?: string;
      }
    ) => cb(payload);
    ipcRenderer.on('library:refreshAllDone', listener);
    return () => {
      ipcRenderer.removeListener('library:refreshAllDone', listener);
    };
  },

  onScanProgress: (
    cb: (payload: { current: number; total: number; phase: string; label?: string }) => void
  ) => {
    const listener = (
      _: unknown,
      payload: { current: number; total: number; phase: string; label?: string }
    ) => cb(payload);
    ipcRenderer.on('library:scanProgress', listener);
    return () => {
      ipcRenderer.removeListener('library:scanProgress', listener);
    };
  },

  onMoviesChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('movies:changed', listener);
    return () => {
      ipcRenderer.removeListener('movies:changed', listener);
    };
  },

  onToast: (cb: (payload: { message: string; kind?: string }) => void) => {
    const listener = (_: unknown, payload: { message: string; kind?: string }) => cb(payload);
    ipcRenderer.on('app:toast', listener);
    return () => {
      ipcRenderer.removeListener('app:toast', listener);
    };
  },

  onUpdateStatus: (cb: (status: UpdateStatus) => void) => {
    const listener = (_: unknown, status: UpdateStatus) => cb(status);
    ipcRenderer.on('update:status', listener);
    return () => {
      ipcRenderer.removeListener('update:status', listener);
    };
  },

  onVpnStatus: (cb: (status: VpnStatus) => void) => {
    const listener = (_: unknown, status: VpnStatus) => cb(status);
    ipcRenderer.on('vpn:status', listener);
    return () => {
      ipcRenderer.removeListener('vpn:status', listener);
    };
  },

  getLog: (opts?: { maxBytes?: number }): Promise<unknown> => ipcRenderer.invoke('log:get', opts),
  getLogTail: (opts?: { lines?: number }): Promise<unknown> =>
    ipcRenderer.invoke('log:tail', opts),
  openLogFolder: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('log:openFolder'),
  getLogPath: (): Promise<string> => ipcRenderer.invoke('log:path'),
  onLogChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('log:changed', listener);
    return () => {
      ipcRenderer.removeListener('log:changed', listener);
    };
  },

  onRequestsChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('requests:changed', listener);
    return () => {
      ipcRenderer.removeListener('requests:changed', listener);
    };
  },

  posterUrl: (path: string | null, _size?: string) => {
    if (!path) return null;
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    return path;
  },
};

contextBridge.exposeInMainWorld('torrentAPI', api);

export type TorrentAPI = typeof api;
