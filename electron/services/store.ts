import Store from 'electron-store';
import { app } from 'electron';
import path from 'path';
import {
  AppSettings,
  DEFAULT_SETTINGS,
  DownloadItem,
  EpisodeOverrideStatus,
  Show,
} from '../types';

export interface AppData {
  settings: AppSettings;
  shows: Show[];
  downloads: DownloadItem[];
  /** Manual episode status overrides keyed by `${showId}:${season}:${episode}` */
  episodeOverrides: Record<string, EpisodeOverrideStatus>;
}

const defaults: AppData = {
  settings: {
    ...DEFAULT_SETTINGS,
    libraryRoot: path.join(app.getPath('documents'), 'TV Shows'),
  },
  shows: [],
  downloads: [],
  episodeOverrides: {},
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
  return merged;
}

export function setSettings(partial: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...partial };
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
