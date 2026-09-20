import { Episode, EpisodeOverrideStatus, EpisodeStatus, Resolution, Season, Show } from '../types';
import { indexLocalEpisodes } from './paths';
import { episodeKey, getEpisodeOverrides, getEpisodeResolutions } from './store';
import { detectResolution } from './search';
import path from 'path';

export { searchShows, type MazeSearchItem } from './tvmaze-search';

const BASE = 'https://api.tvmaze.com';

function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Resolve episode status.
 * Priority: manual ignored > downloading (derived) > file on disk > other overrides > air-date.
 * Ignored always wins — even when a file is already on disk or a download is active —
 * so auto-hunt / upgrade / try-next never touch that episode after the user marks it Ignored.
 */
export function resolveEpisodeStatus(
  airDate: string | null,
  localPath: string | undefined,
  downloading: boolean,
  override?: EpisodeOverrideStatus | null
): EpisodeStatus {
  if (override === 'ignored') return 'ignored';
  if (downloading) return 'downloading';
  if (localPath) return 'downloaded';
  if (override === 'downloaded') return 'downloaded';
  if (override === 'missing') return 'missing';
  if (override === 'upcoming') return 'upcoming';
  if (!airDate) return 'upcoming';
  if (airDate > todayISO()) return 'upcoming';
  return 'missing';
}

async function mazeFetch<T>(endpoint: string): Promise<T> {
  const url = `${BASE}${endpoint}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`TVMaze ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

interface MazeShow {
  id: number;
  name: string;
  summary: string | null;
  status: string;
  premiered: string | null;
  image: { medium: string | null; original: string | null } | null;
  externals?: { tvrage?: number | null; thetvdb?: number | null; imdb?: string | null } | null;
}

interface MazeEpisode {
  id: number;
  name: string;
  season: number;
  number: number | null;
  airdate: string | null;
  summary: string | null;
  image: { medium: string | null; original: string | null } | null;
}

interface MazeSeason {
  id: number;
  number: number;
  name: string | null;
  episodeOrder: number | null;
  premiereDate: string | null;
  image: { medium: string | null; original: string | null } | null;
}


function resolveDownloadedResolution(
  localPath: string | undefined,
  stored: Resolution | undefined
): Resolution | undefined {
  if (stored) return stored;
  if (!localPath) return undefined;
  return detectResolution(path.basename(localPath)) || undefined;
}

function emptyShowShell(
  mazeId: number,
  name: string,
  existing?: Show
): Show {
  return {
    id: existing?.id || mazeId,
    tmdbId: mazeId, // field kept for compatibility; stores TVMaze id
    name,
    overview: '',
    posterPath: null,
    backdropPath: null,
    firstAirDate: null,
    status: '',
    imdbId: existing?.imdbId ?? null,
    libraryPath: existing?.libraryPath,
    seasons: [],
    addedAt: existing?.addedAt || new Date().toISOString(),
    preferredResolution: existing?.preferredResolution,
    minimumResolution: existing?.minimumResolution,
    minSizeMb720p: existing?.minSizeMb720p,
    minSizeMb1080p: existing?.minSizeMb1080p,
    minSizeMb2160p: existing?.minSizeMb2160p,
    monitored: existing?.monitored,
  };
}

export async function fetchShowDetail(
  mazeId: number,
  libraryRoot: string,
  existing?: Show,
  downloadingKeys: Set<string> = new Set(),
  extraRoots?: string[]
): Promise<Show> {
  const [detail, seasonsMeta, episodes] = await Promise.all([
    mazeFetch<MazeShow>(`/shows/${mazeId}`),
    mazeFetch<MazeSeason[]>(`/shows/${mazeId}/seasons`).catch(() => [] as MazeSeason[]),
    mazeFetch<MazeEpisode[]>(`/shows/${mazeId}/episodes`).catch(() => [] as MazeEpisode[]),
  ]);

  const shell = emptyShowShell(mazeId, detail.name, existing);
  shell.overview = stripHtml(detail.summary);
  shell.posterPath = detail.image?.medium || detail.image?.original || null;
  shell.backdropPath = detail.image?.original || detail.image?.medium || null;
  shell.firstAirDate = detail.premiered;
  shell.status = detail.status || '';
  shell.imdbId = detail.externals?.imdb || existing?.imdbId || null;

  const overrides = getEpisodeOverrides();

  const bySeason = new Map<number, MazeEpisode[]>();
  for (const ep of episodes) {
    if (ep.season === 0) continue; // skip specials
    if (ep.number == null) continue;
    const list = bySeason.get(ep.season) || [];
    list.push(ep);
    bySeason.set(ep.season, list);
  }

  const seasonNumbers = new Set<number>([
    ...bySeason.keys(),
    ...seasonsMeta.filter((s) => s.number > 0).map((s) => s.number),
  ]);

  const localIndex = indexLocalEpisodes(shell, libraryRoot, extraRoots);
  const resolutions = getEpisodeResolutions();

  const seasons: Season[] = [...seasonNumbers]
    .sort((a, b) => a - b)
    .map((seasonNumber) => {
      const meta = seasonsMeta.find((s) => s.number === seasonNumber);
      const eps = (bySeason.get(seasonNumber) || []).sort(
        (a, b) => (a.number || 0) - (b.number || 0)
      );
      const mapped: Episode[] = eps.map((ep) => {
        const key = episodeKey(mazeId, ep.season, ep.number as number);
        const localPath = localIndex.get(`${ep.season}:${ep.number as number}`);
        const status = resolveEpisodeStatus(
          ep.airdate,
          localPath,
          downloadingKeys.has(key),
          overrides[key]
        );
        return {
          id: ep.id,
          seasonNumber: ep.season,
          episodeNumber: ep.number as number,
          name: ep.name || `Episode ${ep.number}`,
          airDate: ep.airdate,
          overview: stripHtml(ep.summary),
          stillPath: ep.image?.medium || ep.image?.original || null,
          status,
          localPath,
          downloadedResolution: resolveDownloadedResolution(localPath, resolutions[key]),
        };
      });
      return {
        seasonNumber,
        name: meta?.name || `Season ${seasonNumber}`,
        episodeCount: mapped.length || meta?.episodeOrder || 0,
        airDate: meta?.premiereDate || mapped[0]?.airDate || null,
        posterPath: meta?.image?.medium || meta?.image?.original || null,
        episodes: mapped,
      };
    });

  return {
    ...shell,
    seasons,
    lastRefreshedAt: new Date().toISOString(),
  };
}

export function applyLocalStatuses(
  show: Show,
  libraryRoot: string,
  downloadingKeys: Set<string>,
  extraRoots?: string[]
): Show {
  const overrides = getEpisodeOverrides();
  const resolutions = getEpisodeResolutions();
  // One-pass FS index for the whole show (not per-episode readdir).
  const localIndex = indexLocalEpisodes(show, libraryRoot, extraRoots);
  const seasons = show.seasons.map((season) => ({
    ...season,
    episodes: season.episodes.map((ep) => {
      const key = episodeKey(show.tmdbId, ep.seasonNumber, ep.episodeNumber);
      const localPath = localIndex.get(`${ep.seasonNumber}:${ep.episodeNumber}`);
      const status = resolveEpisodeStatus(
        ep.airDate,
        localPath,
        downloadingKeys.has(key),
        overrides[key]
      );
      return {
        ...ep,
        localPath,
        status,
        downloadedResolution: resolveDownloadedResolution(localPath, resolutions[key]),
      };
    }),
  }));
  return { ...show, seasons };
}

/** Mark already-aired episodes (no local file) as ignored — used by "Only future episodes". */
export function ignoreAiredEpisodes(show: Show): Record<string, EpisodeOverrideStatus> {
  const today = todayISO();
  const entries: Record<string, EpisodeOverrideStatus> = {};
  for (const season of show.seasons || []) {
    for (const ep of season.episodes || []) {
      if (ep.localPath) continue;
      if (ep.status === 'downloaded' || ep.status === 'downloading') continue;
      // Only past air dates (before today, local). Matched local files stay downloaded; future/unaired unchanged.
      if (ep.airDate && ep.airDate < today) {
        entries[episodeKey(show.tmdbId, ep.seasonNumber, ep.episodeNumber)] = 'ignored';
      }
    }
  }
  return entries;
}

/** Poster paths from TVMaze are already absolute URLs */
export function imageUrl(path: string | null): string | null {
  return path || null;
}
