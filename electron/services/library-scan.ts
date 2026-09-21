/**
 * Manual mass-import from existing library folders.
 * Never auto-runs — only invoked via explicit user IPC.
 * Read-only scan: does not delete/move/rename files.
 */
import fs from 'fs';
import path from 'path';
import { Movie, Show } from '../types';
import { searchShows as searchShowsDirect, type MazeSearchItem } from './tvmaze-search';
import { searchMovies as searchMoviesDirect, type MovieSearchItem } from './imdb';
import { sanitizeName, uniqueRoots } from './paths';

/** Injectable so a worker can use direct search; main may pass metadata-pool. */
export type FolderScanSearchers = {
  searchShows: (query: string) => Promise<MazeSearchItem[]>;
  searchMovies: (query: string) => Promise<MovieSearchItem[]>;
};

const defaultSearchers: FolderScanSearchers = {
  searchShows: searchShowsDirect,
  searchMovies: searchMoviesDirect,
};

const VIDEO_EXTS = new Set([
  '.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv', '.ts', '.flv', '.webm',
]);

const SEASON_FOLDER_RE = /^(season\s*0*\d+|s0*\d+)$/i;

export type LibraryScanScope = 'tv' | 'movies' | 'both';

export type ScanMatchStatus = 'will_add' | 'already_in_library' | 'no_match' | 'ambiguous';

export interface FolderScanCandidate {
  id: string;
  kind: 'show' | 'movie';
  folderName: string;
  folderPath: string;
  /** Parsed title (movies may strip year) */
  parsedTitle: string;
  parsedYear: number | null;
  status: ScanMatchStatus;
  /** Human-readable status / confidence note */
  note: string;
  /** Matched metadata id (TVMaze or IMDb numeric) when status is will_add / ambiguous / already */
  matchId: number | null;
  matchName: string | null;
  matchYear: number | null;
  matchPoster: string | null;
  /** Extra candidates when ambiguous */
  alternatives?: Array<{ id: number; name: string; year: number | null }>;
  /** Loose video file at movie root (not a subfolder) */
  isLooseFile?: boolean;
  /** Pre-selected for import (will_add / ambiguous best match) */
  selected: boolean;
}

export interface FolderScanPreview {
  scope: LibraryScanScope;
  tvRoot: string;
  movieRoot: string;
  candidates: FolderScanCandidate[];
  errors: string[];
}

export interface FolderScanImportItem {
  id: string;
  kind: 'show' | 'movie';
  folderPath: string;
  matchId: number;
  selected: boolean;
}

export interface FolderScanImportResult {
  added: number;
  skipped: number;
  failed: number;
  errors: string[];
  addedTitles: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse "Title (2020)" or "Title.2020" / "Title 2020" heuristics */
export function parseMovieFolderName(name: string): { title: string; year: number | null } {
  const bare = name.replace(/\.[^.]+$/, ''); // strip ext if present
  const paren = bare.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  if (paren) {
    return { title: paren[1].trim(), year: parseInt(paren[2], 10) };
  }
  const trailing = bare.match(/^(.*?)[.\s_-]+(\d{4})$/);
  if (trailing) {
    const y = parseInt(trailing[2], 10);
    if (y >= 1900 && y <= 2100) {
      return { title: trailing[1].replace(/[._]+/g, ' ').trim(), year: y };
    }
  }
  return { title: bare.replace(/[._]+/g, ' ').trim(), year: null };
}

function pathEquals(a: string, b: string): boolean {
  const na = path.normalize(a.trim()).replace(/[/\\]+$/, '').toLowerCase();
  const nb = path.normalize(b.trim()).replace(/[/\\]+$/, '').toLowerCase();
  return na === nb;
}

function showAlreadyTracked(shows: Show[], folderPath: string, folderName: string): Show | undefined {
  const byPath = shows.find((s) => s.libraryPath && pathEquals(s.libraryPath, folderPath));
  if (byPath) return byPath;
  const norm = normalizeTitle(folderName);
  return shows.find((s) => normalizeTitle(s.name) === norm || normalizeTitle(sanitizeName(s.name)) === norm);
}

function movieAlreadyTracked(
  movies: Movie[],
  folderPath: string,
  title: string,
  year: number | null
): Movie | undefined {
  const byPath = movies.find((m) => m.libraryPath && pathEquals(m.libraryPath, folderPath));
  if (byPath) return byPath;
  const byLocal = movies.find((m) => m.localPath && pathEquals(m.localPath, folderPath));
  if (byLocal) return byLocal;
  const norm = normalizeTitle(title);
  return movies.find((m) => {
    if (normalizeTitle(m.title) !== norm) return false;
    if (year && m.releaseYear && m.releaseYear !== year) return false;
    return true;
  });
}

function scoreShowMatch(folderName: string, item: MazeSearchItem): number {
  const a = normalizeTitle(folderName);
  const b = normalizeTitle(item.name);
  if (a === b) return 100;
  if (b.startsWith(a) || a.startsWith(b)) return 80;
  if (b.includes(a) || a.includes(b)) return 60;
  return 0;
}

function scoreMovieMatch(
  title: string,
  year: number | null,
  item: MovieSearchItem
): number {
  const a = normalizeTitle(title);
  const b = normalizeTitle(item.title);
  let score = 0;
  if (a === b) score = 100;
  else if (b.startsWith(a) || a.startsWith(b)) score = 80;
  else if (b.includes(a) || a.includes(b)) score = 60;
  else return 0;
  if (year && item.releaseYear) {
    if (item.releaseYear === year) score += 20;
    else if (Math.abs(item.releaseYear - year) === 1) score += 5;
    else score -= 30;
  }
  return score;
}

function pickShowMatch(
  folderName: string,
  results: MazeSearchItem[]
): {
  status: ScanMatchStatus;
  match: MazeSearchItem | null;
  note: string;
  alternatives: Array<{ id: number; name: string; year: number | null }>;
} {
  if (!results.length) {
    return { status: 'no_match', match: null, note: 'No TVMaze results', alternatives: [] };
  }
  const scored = results
    .map((r) => ({ r, score: scoreShowMatch(folderName, r) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return {
      status: 'no_match',
      match: null,
      note: `No confident match (top result: ${results[0].name})`,
      alternatives: results.slice(0, 5).map((r) => ({
        id: r.id,
        name: r.name,
        year: r.firstAirDate ? parseInt(r.firstAirDate.slice(0, 4), 10) : null,
      })),
    };
  }

  const best = scored[0];
  const second = scored[1];
  const alts = scored.slice(0, 5).map(({ r }) => ({
    id: r.id,
    name: r.name,
    year: r.firstAirDate ? parseInt(r.firstAirDate.slice(0, 4), 10) : null,
  }));

  if (best.score >= 100) {
    return {
      status: 'will_add',
      match: best.r,
      note: 'Exact name match',
      alternatives: alts,
    };
  }
  if (best.score >= 80 && (!second || best.score - second.score >= 20)) {
    return {
      status: 'will_add',
      match: best.r,
      note: `Best match (confidence ${best.score})`,
      alternatives: alts,
    };
  }
  if (best.score >= 60) {
    return {
      status: 'ambiguous',
      match: best.r,
      note: second
        ? `Ambiguous — best “${best.r.name}” vs “${second.r.name}”; confirm before import`
        : `Ambiguous — best “${best.r.name}”; confirm before import`,
      alternatives: alts,
    };
  }
  return {
    status: 'no_match',
    match: null,
    note: `Low confidence (best: ${best.r.name})`,
    alternatives: alts,
  };
}

function pickMovieMatch(
  title: string,
  year: number | null,
  results: MovieSearchItem[]
): {
  status: ScanMatchStatus;
  match: MovieSearchItem | null;
  note: string;
  alternatives: Array<{ id: number; name: string; year: number | null }>;
} {
  if (!results.length) {
    return { status: 'no_match', match: null, note: 'No IMDb results', alternatives: [] };
  }
  const scored = results
    .map((r) => ({ r, score: scoreMovieMatch(title, year, r) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return {
      status: 'no_match',
      match: null,
      note: `No confident match (top: ${results[0].title})`,
      alternatives: results.slice(0, 5).map((r) => ({
        id: r.id,
        name: r.title,
        year: r.releaseYear,
      })),
    };
  }

  const best = scored[0];
  const second = scored[1];
  const alts = scored.slice(0, 5).map(({ r }) => ({
    id: r.id,
    name: r.title,
    year: r.releaseYear,
  }));

  if (best.score >= 110 || (best.score >= 100 && year && best.r.releaseYear === year)) {
    return {
      status: 'will_add',
      match: best.r,
      note: year ? 'Title + year match' : 'Exact title match',
      alternatives: alts,
    };
  }
  if (best.score >= 90 && (!second || best.score - second.score >= 15)) {
    return {
      status: 'will_add',
      match: best.r,
      note: `Best match (confidence ${best.score})`,
      alternatives: alts,
    };
  }
  if (best.score >= 60) {
    return {
      status: 'ambiguous',
      match: best.r,
      note: second
        ? `Ambiguous — best “${best.r.title}” vs “${second.r.title}”; confirm before import`
        : `Ambiguous — best “${best.r.title}”; confirm before import`,
      alternatives: alts,
    };
  }
  return {
    status: 'no_match',
    match: null,
    note: `Low confidence (best: ${best.r.title})`,
    alternatives: alts,
  };
}

function listDirSafe(root: string): string[] {
  try {
    if (!root || !fs.existsSync(root)) return [];
    return fs.readdirSync(root);
  } catch {
    return [];
  }
}

function isDir(full: string): boolean {
  try {
    return fs.statSync(full).isDirectory();
  } catch {
    return false;
  }
}

function isVideoFile(full: string): boolean {
  try {
    const st = fs.statSync(full);
    if (!st.isFile()) return false;
    return VIDEO_EXTS.has(path.extname(full).toLowerCase());
  } catch {
    return false;
  }
}

export function detectTvFolders(libraryRoot: string): Array<{ name: string; path: string }> {
  const root = (libraryRoot || '').trim();
  if (!root) return [];
  const out: Array<{ name: string; path: string }> = [];
  for (const entry of listDirSafe(root)) {
    if (entry.startsWith('.')) continue;
    if (SEASON_FOLDER_RE.test(entry)) continue;
    const full = path.join(root, entry);
    if (!isDir(full)) continue;
    out.push({ name: entry, path: full });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function detectMovieEntries(
  movieLibraryRoot: string
): Array<{ name: string; path: string; isLooseFile: boolean }> {
  const root = (movieLibraryRoot || '').trim();
  if (!root) return [];
  const out: Array<{ name: string; path: string; isLooseFile: boolean }> = [];
  for (const entry of listDirSafe(root)) {
    if (entry.startsWith('.')) continue;
    const full = path.join(root, entry);
    if (isDir(full)) {
      out.push({ name: entry, path: full, isLooseFile: false });
      continue;
    }
    if (isVideoFile(full)) {
      out.push({ name: entry, path: full, isLooseFile: true });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function buildScanPreview(
  scope: LibraryScanScope,
  libraryRoot: string | string[],
  movieLibraryRoot: string | string[],
  shows: Show[],
  movies: Movie[],
  onProgress?: (msg: string) => void,
  searchers: FolderScanSearchers = defaultSearchers
): Promise<FolderScanPreview> {
  const searchShowsMeta = searchers.searchShows;
  const searchMoviesMeta = searchers.searchMovies;
  const errors: string[] = [];
  const candidates: FolderScanCandidate[] = [];
  const tvRoots = uniqueRoots(libraryRoot);
  const movieRoots = uniqueRoots(movieLibraryRoot);
  const tvRoot = tvRoots[0] || '';
  const movieRoot = movieRoots[0] || '';

  if ((scope === 'tv' || scope === 'both') && !tvRoots.length) {
    errors.push('TV library root is not set');
  }
  if ((scope === 'movies' || scope === 'both') && !movieRoots.length) {
    errors.push('Movie library root is not set');
  }
  for (const r of tvRoots) {
    if ((scope === 'tv' || scope === 'both') && r && !fs.existsSync(r)) {
      errors.push(`TV library root not found: ${r}`);
    }
  }
  for (const r of movieRoots) {
    if ((scope === 'movies' || scope === 'both') && r && !fs.existsSync(r)) {
      errors.push(`Movie library root not found: ${r}`);
    }
  }

  if (scope === 'tv' || scope === 'both') {
    const folders = tvRoots.flatMap((r) => detectTvFolders(r));
    onProgress?.(`Scanning ${folders.length} TV folders…`);
    for (let i = 0; i < folders.length; i++) {
      const folder = folders[i];
      onProgress?.(`Matching TV ${i + 1}/${folders.length}: ${folder.name}`);
      const existing = showAlreadyTracked(shows, folder.path, folder.name);
      if (existing) {
        candidates.push({
          id: `show:${folder.path}`,
          kind: 'show',
          folderName: folder.name,
          folderPath: folder.path,
          parsedTitle: folder.name,
          parsedYear: null,
          status: 'already_in_library',
          note: `Already tracked as “${existing.name}”`,
          matchId: existing.tmdbId,
          matchName: existing.name,
          matchYear: existing.firstAirDate
            ? parseInt(existing.firstAirDate.slice(0, 4), 10)
            : null,
          matchPoster: existing.posterPath,
          selected: false,
        });
        continue;
      }
      try {
        const results = await searchShowsMeta(folder.name);
        const picked = pickShowMatch(folder.name, results);
        const match = picked.match;
        candidates.push({
          id: `show:${folder.path}`,
          kind: 'show',
          folderName: folder.name,
          folderPath: folder.path,
          parsedTitle: folder.name,
          parsedYear: null,
          status: picked.status,
          note: picked.note,
          matchId: match?.id ?? null,
          matchName: match?.name ?? null,
          matchYear: match?.firstAirDate
            ? parseInt(match.firstAirDate.slice(0, 4), 10)
            : null,
          matchPoster: match?.posterUrl ?? null,
          alternatives: picked.alternatives,
          selected: picked.status === 'will_add' || picked.status === 'ambiguous',
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`TV “${folder.name}”: ${msg}`);
        candidates.push({
          id: `show:${folder.path}`,
          kind: 'show',
          folderName: folder.name,
          folderPath: folder.path,
          parsedTitle: folder.name,
          parsedYear: null,
          status: 'no_match',
          note: `Search failed: ${msg}`,
          matchId: null,
          matchName: null,
          matchYear: null,
          matchPoster: null,
          selected: false,
        });
      }
      await sleep(120);
    }
  }

  if (scope === 'movies' || scope === 'both') {
    const entries = movieRoots.flatMap((r) => detectMovieEntries(r));
    onProgress?.(`Scanning ${entries.length} movie entries…`);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const parsed = parseMovieFolderName(entry.name);
      onProgress?.(`Matching movie ${i + 1}/${entries.length}: ${parsed.title}`);
      const trackPath = entry.isLooseFile ? entry.path : entry.path;
      const existing = movieAlreadyTracked(movies, trackPath, parsed.title, parsed.year);
      // Also treat loose file's parent+name for already check via basename
      const existing2 =
        existing ||
        (entry.isLooseFile
          ? movieAlreadyTracked(movies, movieRoot, parsed.title, parsed.year)
          : undefined);
      if (existing2) {
        candidates.push({
          id: `movie:${entry.path}`,
          kind: 'movie',
          folderName: entry.name,
          folderPath: entry.isLooseFile ? movieRoot : entry.path,
          parsedTitle: parsed.title,
          parsedYear: parsed.year,
          status: 'already_in_library',
          note: `Already tracked as “${existing2.title}”`,
          matchId: existing2.tmdbId,
          matchName: existing2.title,
          matchYear: existing2.releaseYear,
          matchPoster: existing2.posterPath,
          isLooseFile: entry.isLooseFile,
          selected: false,
        });
        continue;
      }
      try {
        const q = parsed.year ? `${parsed.title} ${parsed.year}` : parsed.title;
        const results = await searchMoviesMeta(q);
        const picked = pickMovieMatch(parsed.title, parsed.year, results);
        const match = picked.match;
        candidates.push({
          id: `movie:${entry.path}`,
          kind: 'movie',
          folderName: entry.name,
          folderPath: entry.isLooseFile ? movieRoot : entry.path,
          parsedTitle: parsed.title,
          parsedYear: parsed.year,
          status: picked.status,
          note: picked.note,
          matchId: match?.id ?? null,
          matchName: match?.title ?? null,
          matchYear: match?.releaseYear ?? null,
          matchPoster: match?.posterUrl ?? null,
          alternatives: picked.alternatives,
          isLooseFile: entry.isLooseFile,
          selected: picked.status === 'will_add' || picked.status === 'ambiguous',
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Movie “${entry.name}”: ${msg}`);
        candidates.push({
          id: `movie:${entry.path}`,
          kind: 'movie',
          folderName: entry.name,
          folderPath: entry.isLooseFile ? movieRoot : entry.path,
          parsedTitle: parsed.title,
          parsedYear: parsed.year,
          status: 'no_match',
          note: `Search failed: ${msg}`,
          matchId: null,
          matchName: null,
          matchYear: null,
          matchPoster: null,
          isLooseFile: entry.isLooseFile,
          selected: false,
        });
      }
      await sleep(150);
    }
  }

  return {
    scope,
    tvRoot,
    movieRoot,
    candidates,
    errors,
  };
}
