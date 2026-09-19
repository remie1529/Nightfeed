import fs from 'fs';
import path from 'path';
import { Movie, MovieStatus } from '../types';
import { findLocalMovie, getMovieFolderName } from './paths';

const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';

function posterUrl(posterPath: string | null | undefined, size = 'w500'): string | null {
  if (!posterPath) return null;
  if (posterPath.startsWith('http')) return posterPath;
  return `${IMG}/${size}${posterPath}`;
}

function backdropUrl(backdropPath: string | null | undefined): string | null {
  if (!backdropPath) return null;
  if (backdropPath.startsWith('http')) return backdropPath;
  return `${IMG}/w1280${backdropPath}`;
}

async function tmdbFetch<T>(apiKey: string, endpoint: string): Promise<T> {
  const sep = endpoint.includes('?') ? '&' : '?';
  const url = `${BASE}${endpoint}${sep}api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401) {
      throw new Error('Invalid TMDB API key. Get a free key at https://www.themoviedb.org/settings/api');
    }
    throw new Error(`TMDB ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export interface TmdbSearchItem {
  id: number;
  title: string;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  releaseDate: string | null;
  releaseYear: number | null;
}

interface TmdbMovieResult {
  id: number;
  title?: string;
  original_title?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string | null;
  runtime?: number | null;
}

function yearFromDate(date: string | null | undefined): number | null {
  if (!date || date.length < 4) return null;
  const y = parseInt(date.slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}

export async function searchMovies(apiKey: string, query: string): Promise<TmdbSearchItem[]> {
  const key = (apiKey || '').trim();
  if (!key) {
    throw new Error('Add a free TMDB API key in Settings to search movies');
  }
  const q = query.trim();
  if (!q) return [];
  const data = await tmdbFetch<{ results?: TmdbMovieResult[] }>(
    key,
    `/search/movie?query=${encodeURIComponent(q)}&include_adult=false`
  );
  return (data.results || []).slice(0, 20).map((r) => ({
    id: r.id,
    title: r.title || r.original_title || 'Untitled',
    overview: r.overview || '',
    posterUrl: posterUrl(r.poster_path),
    backdropUrl: backdropUrl(r.backdrop_path),
    releaseDate: r.release_date || null,
    releaseYear: yearFromDate(r.release_date),
  }));
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

export async function fetchMovieDetail(
  apiKey: string,
  tmdbId: number,
  movieLibraryRoot: string,
  existing?: Movie | null,
  downloadingIds: Set<number> = new Set()
): Promise<Movie> {
  const key = (apiKey || '').trim();
  if (!key) {
    throw new Error('Add a free TMDB API key in Settings to search movies');
  }
  const r = await tmdbFetch<TmdbMovieResult>(key, `/movie/${tmdbId}`);
  const title = r.title || r.original_title || existing?.title || 'Untitled';
  const releaseDate = r.release_date || existing?.releaseDate || null;
  const releaseYear = yearFromDate(releaseDate);
  const movie: Movie = {
    id: r.id,
    tmdbId: r.id,
    title,
    overview: r.overview || existing?.overview || '',
    posterPath: posterUrl(r.poster_path) || existing?.posterPath || null,
    backdropPath: backdropUrl(r.backdrop_path) || existing?.backdropPath || null,
    releaseDate,
    releaseYear,
    runtime: typeof r.runtime === 'number' && r.runtime > 0 ? r.runtime : existing?.runtime ?? null,
    status: existing?.status || 'missing',
    preferredResolution: existing?.preferredResolution,
    libraryPath: existing?.libraryPath,
    localPath: existing?.localPath,
    monitored: existing?.monitored,
    addedAt: existing?.addedAt || new Date().toISOString(),
    lastRefreshedAt: new Date().toISOString(),
  };
  // Ensure folder name is available for path helpers
  void getMovieFolderName(movie);
  return applyMovieLocalStatus(movie, movieLibraryRoot, downloadingIds);
}

/** Re-scan disk for a stored movie without hitting TMDB. */
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
