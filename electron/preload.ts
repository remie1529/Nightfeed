import { contextBridge, ipcRenderer } from 'electron';

const api = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial: Record<string, unknown>) => ipcRenderer.invoke('settings:set', partial),
  pickLibraryFolder: () => ipcRenderer.invoke('dialog:pickFolder'),

  searchShows: (query: string) => ipcRenderer.invoke('tmdb:search', query),
  addShow: (mazeId: number, policy?: 'all' | 'future' | 'manual') =>
    ipcRenderer.invoke('library:add', mazeId, policy),
  removeShow: (mazeId: number) => ipcRenderer.invoke('library:remove', mazeId),
  getShows: () => ipcRenderer.invoke('library:list'),
  getShow: (mazeId: number) => ipcRenderer.invoke('library:get', mazeId),
  updateShow: (mazeId: number, partial: Record<string, unknown>) =>
    ipcRenderer.invoke('library:update', mazeId, partial),
  refreshShow: (mazeId: number) => ipcRenderer.invoke('library:refresh', mazeId),
  refreshAll: () => ipcRenderer.invoke('library:refreshAll'),
  scanLibraryPreview: (scope: 'tv' | 'movies' | 'both') =>
    ipcRenderer.invoke('library:scanPreview', scope),
  scanLibraryImport: (items: Array<{
    id: string;
    kind: 'show' | 'movie';
    folderPath: string;
    matchId: number;
    selected: boolean;
  }>) => ipcRenderer.invoke('library:scanImport', items),
  setEpisodeStatus: (
    mazeId: number,
    season: number,
    episode: number,
    status: 'missing' | 'downloaded' | 'ignored' | 'upcoming'
  ) => ipcRenderer.invoke('library:setEpisodeStatus', mazeId, season, episode, status),

  searchTorrents: (mazeId: number, season: number, episode: number) =>
    ipcRenderer.invoke('search:episode', mazeId, season, episode),
  startDownload: (payload: {
    tmdbId: number;
    season: number;
    episode: number;
    episodeTitle: string;
    magnet: string;
    candidates?: Array<{ magnet: string; infoHash?: string; title?: string }>;
  }) => ipcRenderer.invoke('download:start', payload),
  getDownloads: () => ipcRenderer.invoke('download:list'),
  pauseDownload: (id: string) => ipcRenderer.invoke('download:pause', id),
  resumeDownload: (id: string) => ipcRenderer.invoke('download:resume', id),
  cancelDownload: (id: string) => ipcRenderer.invoke('download:cancel', id),

  // Movies (TMDB)
  searchMovies: (query: string) => ipcRenderer.invoke('tmdb:searchMovies', query),
  getMovies: () => ipcRenderer.invoke('movies:list'),
  getMovie: (tmdbId: number) => ipcRenderer.invoke('movies:get', tmdbId),
  addMovie: (tmdbId: number) => ipcRenderer.invoke('movies:add', tmdbId),
  removeMovie: (tmdbId: number) => ipcRenderer.invoke('movies:remove', tmdbId),
  updateMovie: (tmdbId: number, partial: Record<string, unknown>) =>
    ipcRenderer.invoke('movies:update', tmdbId, partial),
  refreshMovie: (tmdbId: number) => ipcRenderer.invoke('movies:refresh', tmdbId),
  searchMovieTorrents: (tmdbId: number) => ipcRenderer.invoke('search:movie', tmdbId),
  startMovieDownload: (payload: {
    tmdbId: number;
    magnet: string;
    candidates?: Array<{ magnet: string; infoHash?: string; title?: string }>;
  }) => ipcRenderer.invoke('download:startMovie', payload),

  getTelegramStatus: () => ipcRenderer.invoke('telegram:status'),
  sendTelegramTest: () => ipcRenderer.invoke('telegram:test'),

  exportBackup: () => ipcRenderer.invoke('backup:export'),
  importBackup: () => ipcRenderer.invoke('backup:import'),

  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  getThreadInfo: () => ipcRenderer.invoke('app:getThreadInfo'),
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),

  getVpnStatus: () => ipcRenderer.invoke('vpn:status'),
  importVpnConfig: () => ipcRenderer.invoke('vpn:importConfig'),
  connectVpn: () => ipcRenderer.invoke('vpn:connect'),
  disconnectVpn: () => ipcRenderer.invoke('vpn:disconnect'),
  detectOpenVpn: () => ipcRenderer.invoke('vpn:detect'),

  onDownloadsUpdate: (cb: (items: unknown[]) => void) => {
    const listener = (_: unknown, items: unknown[]) => cb(items);
    ipcRenderer.on('downloads:update', listener);
    return () => ipcRenderer.removeListener('downloads:update', listener);
  },

  onLibraryChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('library:changed', listener);
    return () => ipcRenderer.removeListener('library:changed', listener);
  },

  onMoviesChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('movies:changed', listener);
    return () => ipcRenderer.removeListener('movies:changed', listener);
  },

  onToast: (cb: (payload: { message: string; kind?: string }) => void) => {
    const listener = (_: unknown, payload: { message: string; kind?: string }) => cb(payload);
    ipcRenderer.on('app:toast', listener);
    return () => ipcRenderer.removeListener('app:toast', listener);
  },

  onUpdateStatus: (cb: (status: unknown) => void) => {
    const listener = (_: unknown, status: unknown) => cb(status);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },

  onVpnStatus: (cb: (status: unknown) => void) => {
    const listener = (_: unknown, status: unknown) => cb(status);
    ipcRenderer.on('vpn:status', listener);
    return () => ipcRenderer.removeListener('vpn:status', listener);
  },

  posterUrl: (path: string | null, _size?: string) => {
    if (!path) return null;
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    return path;
  },
};

contextBridge.exposeInMainWorld('torrentAPI', api);

export type TorrentAPI = typeof api;
