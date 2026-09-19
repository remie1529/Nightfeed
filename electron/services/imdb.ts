/**
 * Movie metadata via IMDb.com (no API key).
 * Search: IMDb suggestion CDN. Detail: IMDb web GraphQL (same endpoint the site uses),
 * with HTML title-page scrape as a secondary path when available.
 */
import fs from 'fs';
import path from 'path';
import { detectResolution } from './search';
import { Movie, MovieStatus } from '../types';
import { findLocalMovie, getMovieFolderName } from './paths';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Nightfeed/1.5.5';

const SUGGEST_BASE = 'https://v3.sg.media-imdb.com/suggestion';
const GRAPHQL = 'https://api.graphql.imdb.com/';

export interface MovieSearchItem {
  id: number;
  title: string;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  releaseDate: string | null;
  releaseYear: number | null;
}

/** tt0133093 -> 133093 */
export function imdbIdToNumber(imdbId: string): number {
  const m = String(imdbId).trim().match(/^(?:tt)?(\d+)$/i);
  if (!m) throw new Error(`Invalid IMDb id: ${imdbId}`);
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid IMDb id: ${imdbId}`);
  return n;
}

/** 133093 -> tt0133093 */
export function numberToImdbId(id: number): string {
  if (!Number.isFinite(id) || id <= 0) throw new Error(`Invalid movie id: ${id}`);
  return `tt${String(Math.floor(id)).padStart(7, '0')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url: string, init: RequestInit = {}, timeoutMs = 20000): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'en-US,en;q=0.9',
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

function suggestPrefix(query: string): string {
  const c = (query.trim()[0] || 'a').toLowerCase();
  if (/[a-z0-9]/.test(c)) return c;
  return 'x';
}

type SuggestHit = {
  id?: string;
  l?: string;
  s?: string;
  y?: number;
  qid?: string;
  q?: string;
  i?: { imageUrl?: string } | string;
};

function posterFromSuggest(hit: SuggestHit): string | null {
  if (!hit.i) return null;
  if (typeof hit.i === 'string') return hit.i;
  return hit.i.imageUrl || null;
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
  downloadingIds: Set<number>,
  extraRoots?: string[]
): Movie {
  const localPath = findLocalMovie(movie, movieLibraryRoot, extraRoots);
  const downloading = downloadingIds.has(movie.tmdbId);
  let downloadedResolution = movie.downloadedResolution;
  if (localPath) {
    downloadedResolution =
      downloadedResolution || detectResolution(path.basename(localPath)) || undefined;
  } else {
    downloadedResolution = undefined;
  }
  return {
    ...movie,
    localPath,
    status: resolveMovieStatus(localPath, downloading, movie.status),
    downloadedResolution,
  };
}

export async function searchMovies(query: string): Promise<MovieSearchItem[]> {
  const q = query.trim();
  if (!q) return [];

  const prefix = suggestPrefix(q);
  const url = `${SUGGEST_BASE}/${encodeURIComponent(prefix)}/${encodeURIComponent(q)}.json`;
  let data: { d?: SuggestHit[] };
  try {
    const res = await fetchText(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`IMDb search HTTP ${res.status}`);
    }
    data = JSON.parse(res.text) as { d?: SuggestHit[] };
  } catch (err) {
    throw new Error(
      `IMDb search failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const out: MovieSearchItem[] = [];
  const seen = new Set<number>();
  for (const hit of data.d || []) {
    if (!hit.id || !/^tt\d+$/i.test(hit.id)) continue;
    // Strict: feature films / movies primarily
    const qid = (hit.qid || '').toLowerCase();
    const qtype = (hit.q || '').toLowerCase();
    const okType =
      qid === 'movie' ||
      qtype === 'feature' ||
      qtype === 'tv movie' ||
      qtype === 'video' ||
      (!qid && !qtype && !!hit.y);
    if (!okType) continue;
    // Skip obvious TV series
    if (qid === 'tvseries' || qid === 'tvminiseries' || qtype === 'tv series') continue;

    let id: number;
    try {
      id = imdbIdToNumber(hit.id);
    } catch {
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);

    const poster = posterFromSuggest(hit);
    const year = typeof hit.y === 'number' ? hit.y : null;
    out.push({
      id,
      title: hit.l || hit.id,
      overview: hit.s ? `Cast: ${hit.s}` : '',
      posterUrl: poster,
      backdropUrl: poster,
      releaseDate: year ? `${year}-01-01` : null,
      releaseYear: year,
    });
    if (out.length >= 20) break;
  }

  // Gentle pacing if caller searches rapidly
  await sleep(50);
  return out;
}

const DETAIL_QUERY = `query TitleMainPage($id: ID!) {
  title(id: $id) {
    id
    titleText { text }
    originalTitleText { text }
    releaseYear { year }
    releaseDate { year month day }
    runtime { seconds }
    plot { plotText { plainText } }
    primaryImage { url }
    genres { genres { text } }
  }
}`;

async function fetchDetailGraphql(imdbId: string): Promise<{
  title: string;
  overview: string;
  posterPath: string | null;
  releaseYear: number | null;
  releaseDate: string | null;
  runtime: number | null;
} | null> {
  const body = JSON.stringify({
    operationName: 'TitleMainPage',
    variables: { id: imdbId },
    query: DETAIL_QUERY,
  });
  const res = await fetchText(
    GRAPHQL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Origin: 'https://www.imdb.com',
        Referer: `https://www.imdb.com/title/${imdbId}/`,
        'x-imdb-client-name': 'imdb-web-app',
      },
      body,
    },
    25000
  );
  if (!res.ok) {
    throw new Error(`IMDb GraphQL HTTP ${res.status}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    throw new Error('IMDb GraphQL returned invalid JSON');
  }
  const title = parsed?.data?.title;
  if (!title) return null;

  const year = title.releaseYear?.year ?? title.releaseDate?.year ?? null;
  let releaseDate: string | null = null;
  if (title.releaseDate?.year) {
    const m = String(title.releaseDate.month || 1).padStart(2, '0');
    const d = String(title.releaseDate.day || 1).padStart(2, '0');
    releaseDate = `${title.releaseDate.year}-${m}-${d}`;
  } else if (year) {
    releaseDate = `${year}-01-01`;
  }

  const seconds = title.runtime?.seconds;
  const runtime =
    typeof seconds === 'number' && seconds > 0 ? Math.round(seconds / 60) : null;

  return {
    title: title.titleText?.text || title.originalTitleText?.text || imdbId,
    overview: title.plot?.plotText?.plainText || '',
    posterPath: title.primaryImage?.url || null,
    releaseYear: typeof year === 'number' ? year : null,
    releaseDate,
    runtime,
  };
}

/** Best-effort HTML scrape (often WAF-blocked from datacenters; works for some networks). */
async function fetchDetailHtml(imdbId: string): Promise<{
  title: string;
  overview: string;
  posterPath: string | null;
  releaseYear: number | null;
  releaseDate: string | null;
  runtime: number | null;
} | null> {
  const res = await fetchText(
    `https://www.imdb.com/title/${imdbId}/`,
    {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Upgrade-Insecure-Requests': '1',
      },
    },
    25000
  );
  if (!res.ok || res.status === 202 || res.text.length < 2000) return null;

  const ldMatch = res.text.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/i
  );
  if (ldMatch) {
    try {
      const ld = JSON.parse(ldMatch[1]);
      const year = ld.datePublished
        ? parseInt(String(ld.datePublished).slice(0, 4), 10)
        : null;
      let runtime: number | null = null;
      if (typeof ld.duration === 'string') {
        const m = ld.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?/i);
        if (m) runtime = (parseInt(m[1] || '0', 10) || 0) * 60 + (parseInt(m[2] || '0', 10) || 0);
      }
      return {
        title: ld.name || imdbId,
        overview: ld.description || '',
        posterPath: ld.image || null,
        releaseYear: Number.isFinite(year as number) ? (year as number) : null,
        releaseDate: ld.datePublished || null,
        runtime: runtime && runtime > 0 ? runtime : null,
      };
    } catch {
      // fall through
    }
  }
  return null;
}

async function fetchDetailSuggest(imdbId: string): Promise<{
  title: string;
  overview: string;
  posterPath: string | null;
  releaseYear: number | null;
  releaseDate: string | null;
  runtime: number | null;
} | null> {
  const prefix = imdbId.slice(2, 3) || 't';
  // suggestion by id string often returns the title
  const url = `${SUGGEST_BASE}/t/${encodeURIComponent(imdbId)}.json`;
  const res = await fetchText(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  try {
    const data = JSON.parse(res.text) as { d?: SuggestHit[] };
    const hit = (data.d || []).find((h) => (h.id || '').toLowerCase() === imdbId.toLowerCase());
    if (!hit) return null;
    const year = typeof hit.y === 'number' ? hit.y : null;
    return {
      title: hit.l || imdbId,
      overview: hit.s ? `Cast: ${hit.s}` : '',
      posterPath: posterFromSuggest(hit),
      releaseYear: year,
      releaseDate: year ? `${year}-01-01` : null,
      runtime: null,
    };
  } catch {
    return null;
  }
}

export async function fetchMovieDetail(
  movieId: number,
  movieLibraryRoot: string,
  existing?: Movie | null,
  downloadingIds: Set<number> = new Set(),
  extraRoots?: string[]
): Promise<Movie> {
  const imdbId = numberToImdbId(movieId);
  let detail: {
    title: string;
    overview: string;
    posterPath: string | null;
    releaseYear: number | null;
    releaseDate: string | null;
    runtime: number | null;
  } | null = null;
  const errors: string[] = [];

  try {
    detail = await fetchDetailGraphql(imdbId);
  } catch (err) {
    errors.push(`GraphQL: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!detail) {
    try {
      detail = await fetchDetailHtml(imdbId);
    } catch (err) {
      errors.push(`HTML: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!detail) {
    try {
      detail = await fetchDetailSuggest(imdbId);
    } catch (err) {
      errors.push(`Suggest: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!detail) {
    throw new Error(
      `IMDb metadata failed for ${imdbId}. ${errors.join(' | ') || 'No data returned.'}`
    );
  }

  const movie: Movie = {
    id: movieId,
    tmdbId: movieId,
    title: detail.title || existing?.title || imdbId,
    overview: detail.overview || existing?.overview || '',
    posterPath: detail.posterPath || existing?.posterPath || null,
    backdropPath: detail.posterPath || existing?.backdropPath || null,
    releaseDate: detail.releaseDate || existing?.releaseDate || null,
    releaseYear: detail.releaseYear ?? existing?.releaseYear ?? null,
    runtime: detail.runtime ?? existing?.runtime ?? null,
    status: existing?.status || 'missing',
    preferredResolution: existing?.preferredResolution,
    libraryPath: existing?.libraryPath,
    localPath: existing?.localPath,
    downloadedResolution: existing?.downloadedResolution,
    addedAt: existing?.addedAt || new Date().toISOString(),
    lastRefreshedAt: new Date().toISOString(),
    imdbId,
  } as Movie;

  void getMovieFolderName(movie);
  await sleep(80);
  return applyMovieLocalStatus(movie, movieLibraryRoot, downloadingIds, extraRoots);
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

