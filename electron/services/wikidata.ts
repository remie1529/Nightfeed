import fs from 'fs';
import path from 'path';
import { Movie, MovieStatus } from '../types';
import { findLocalMovie, getMovieFolderName } from './paths';

const WD_API = 'https://www.wikidata.org/w/api.php';
const COMMONS = 'https://commons.wikimedia.org/wiki/Special:FilePath';

export interface MovieSearchItem {
  id: number;
  title: string;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  releaseDate: string | null;
  releaseYear: number | null;
}

function qidToNumber(qid: string): number {
  const n = parseInt(String(qid).replace(/^Q/i, ''), 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid Wikidata id: ${qid}`);
  return n;
}

function numberToQid(id: number): string {
  return `Q${id}`;
}

function commonsFileUrl(filename: string, width = 500): string {
  const clean = filename.replace(/^File:/i, '').trim();
  return `${COMMONS}/${encodeURIComponent(clean)}?width=${width}`;
}

function yearFromWikidataTime(time: string | undefined | null): number | null {
  if (!time) return null;
  // +2010-07-16T00:00:00Z
  const m = time.match(/([+-]?\d{1,6})-/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  return Number.isFinite(y) ? y : null;
}

function dateFromWikidataTime(time: string | undefined | null): string | null {
  if (!time) return null;
  const m = time.match(/([+-]?)(\d{1,6})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const year = m[2].padStart(4, '0');
  return `${year}-${m[3]}-${m[4]}`;
}

async function wdApi<T>(params: Record<string, string>): Promise<T> {
  const url = new URL(WD_API);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');
  const res = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'TorrentTVManager/1.5.1 (desktop; movie metadata via Wikidata)',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Wikidata HTTP ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

type Claim = {
  mainsnak?: {
    datavalue?: {
      value?: any;
      type?: string;
    };
    datatype?: string;
  };
};

function claimValues(claims: Record<string, Claim[]> | undefined, prop: string): any[] {
  const arr = claims?.[prop] || [];
  return arr
    .map((c) => c?.mainsnak?.datavalue?.value)
    .filter((v) => v !== undefined && v !== null);
}

function isFilmEntity(claims: Record<string, Claim[]> | undefined): boolean {
  const instances = claimValues(claims, 'P31').map((v) => (typeof v === 'object' ? v.id : v));
  // film, feature film, animated film, short film, television film
  const filmIds = new Set(['Q11424', 'Q24869', 'Q202866', 'Q24862', 'Q506240']);
  return instances.some((id) => filmIds.has(String(id)));
}

export function resolveMovieStatus(
  localPath: string | undefined,
  downloading: boolean,
  stored?: MovieStatus
): MovieStatus {
  if (downloading) return 'downloading';
  if (localPath) return 'downloaded';
  if (stored === 'downloaded') return 'downloaded';
  return 'missing';
}

export function applyMovieLocalStatus(
  movie: Movie,
  movieLibraryRoot: string,
  downloadingIds: Set<number>
): Movie {
  const localPath = findLocalMovie(movie, movieLibraryRoot);
  const downloading = downloadingIds.has(movie.tmdbId);
  return {
    ...movie,
    localPath,
    status: resolveMovieStatus(localPath, downloading, movie.status),
  };
}

export async function searchMovies(query: string): Promise<MovieSearchItem[]> {
  const q = query.trim();
  if (!q) return [];

  const data = await wdApi<{
    search?: Array<{ id: string; label?: string; description?: string }>;
  }>({
    action: 'wbsearchentities',
    search: q,
    language: 'en',
    uselang: 'en',
    type: 'item',
    limit: '20',
  });

  const hits = data.search || [];
  if (!hits.length) return [];

  const ids = hits.map((h) => h.id).join('|');
  const entities = await wdApi<{
    entities?: Record<
      string,
      {
        id: string;
        labels?: { en?: { value?: string } };
        descriptions?: { en?: { value?: string } };
        claims?: Record<string, Claim[]>;
      }
    >;
  }>({
    action: 'wbgetentities',
    ids,
    props: 'labels|descriptions|claims',
    languages: 'en',
  });

  const out: MovieSearchItem[] = [];
  for (const hit of hits) {
    const ent = entities.entities?.[hit.id];
    if (!ent) continue;
    // Prefer films; if none of the batch are films, still include top label matches later
    const film = isFilmEntity(ent.claims);
    const title = ent.labels?.en?.value || hit.label || hit.id;
    const overview = ent.descriptions?.en?.value || hit.description || '';
    const times = claimValues(ent.claims, 'P577');
    const timeStr = typeof times[0] === 'object' ? times[0]?.time : null;
    const releaseYear = yearFromWikidataTime(timeStr);
    const releaseDate = dateFromWikidataTime(timeStr);
    const images = claimValues(ent.claims, 'P18');
    const imageName = typeof images[0] === 'string' ? images[0] : null;
    const posterUrl = imageName ? commonsFileUrl(imageName, 500) : null;
    out.push({
      id: qidToNumber(hit.id),
      title,
      overview,
      posterUrl,
      backdropUrl: imageName ? commonsFileUrl(imageName, 1280) : null,
      releaseDate,
      releaseYear,
      // stash film flag via overview prefix? better filter below
      ...(film ? {} : { overview: overview || '' }),
    } as MovieSearchItem & { _film?: boolean });
    (out[out.length - 1] as any)._film = film;
  }

  const films = out.filter((m) => (m as any)._film);
  const ranked = (films.length ? films : out).map((m) => {
    const { _film, ...rest } = m as any;
    return rest as MovieSearchItem;
  });
  return ranked.slice(0, 20);
}

export async function fetchMovieDetail(
  movieId: number,
  movieLibraryRoot: string,
  existing?: Movie | null,
  downloadingIds: Set<number> = new Set()
): Promise<Movie> {
  const qid = numberToQid(movieId);
  const entities = await wdApi<{
    entities?: Record<
      string,
      {
        id: string;
        labels?: { en?: { value?: string } };
        descriptions?: { en?: { value?: string } };
        claims?: Record<string, Claim[]>;
      }
    >;
  }>({
    action: 'wbgetentities',
    ids: qid,
    props: 'labels|descriptions|claims',
    languages: 'en',
  });
  const ent = entities.entities?.[qid];
  if (!ent || (ent as any).missing) {
    throw new Error(`Movie not found on Wikidata (${qid})`);
  }

  const title = ent.labels?.en?.value || existing?.title || qid;
  const overview = ent.descriptions?.en?.value || existing?.overview || '';
  const times = claimValues(ent.claims, 'P577');
  const timeStr = typeof times[0] === 'object' ? times[0]?.time : null;
  const releaseDate = dateFromWikidataTime(timeStr) || existing?.releaseDate || null;
  const releaseYear = yearFromWikidataTime(timeStr) ?? existing?.releaseYear ?? null;
  const images = claimValues(ent.claims, 'P18');
  const imageName = typeof images[0] === 'string' ? images[0] : null;
  const posterPath = imageName ? commonsFileUrl(imageName, 500) : existing?.posterPath || null;
  const backdropPath = imageName ? commonsFileUrl(imageName, 1280) : existing?.backdropPath || null;

  // runtime P2047 (in minutes often with unit)
  let runtime: number | null = existing?.runtime ?? null;
  const runVals = claimValues(ent.claims, 'P2047');
  if (runVals[0] && typeof runVals[0] === 'object' && runVals[0].amount) {
    const mins = parseFloat(String(runVals[0].amount).replace(/^\+/, ''));
    if (Number.isFinite(mins) && mins > 0) runtime = Math.round(mins);
  }

  const imdbVals = claimValues(ent.claims, 'P345');
  const imdbId = typeof imdbVals[0] === 'string' ? imdbVals[0] : null;

  const movie: Movie = {
    id: movieId,
    tmdbId: movieId,
    title,
    overview,
    posterPath,
    backdropPath,
    releaseDate,
    releaseYear,
    runtime,
    status: existing?.status || 'missing',
    preferredResolution: existing?.preferredResolution,
    libraryPath: existing?.libraryPath,
    localPath: existing?.localPath,
    addedAt: existing?.addedAt || new Date().toISOString(),
    lastRefreshedAt: new Date().toISOString(),
    ...(imdbId ? { imdbId } : {}),
  } as Movie;

  void getMovieFolderName(movie);
  return applyMovieLocalStatus(movie, movieLibraryRoot, downloadingIds);
}

export function refreshMovieLocal(
  movie: Movie,
  movieLibraryRoot: string,
  downloadingIds: Set<number>
): Movie {
  return applyMovieLocalStatus(movie, movieLibraryRoot, downloadingIds);
}

export function ensureMovieFolder(movie: Movie, movieLibraryRoot: string): string {
  const root = movie.libraryPath?.trim()
    ? movie.libraryPath.trim()
    : path.join(movieLibraryRoot, getMovieFolderName(movie));
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
  return root;
}
