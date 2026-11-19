import fs from 'fs';
import path from 'path';
import { Movie, Show } from '../types';

const SEASON_PATTERNS = [
  /^season\s*0*(\d+)$/i,
  /^s0*(\d+)$/i,
];

const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeName(name: string): string {
  let clean = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .trim();
  if (!clean || clean === '.' || clean === '..') return 'Untitled';
  if (WINDOWS_RESERVED_RE.test(clean)) clean = `${clean}_`;
  return clean;
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function uniqueRoots(...groups: Array<string | string[] | undefined | null>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    const list = Array.isArray(g) ? g : g ? [g] : [];
    for (const raw of list) {
      const t = String(raw || '').trim();
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

function dirExists(p: string): boolean {
  try {
    return !!p && fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findSeasonDirExisting(showRoot: string, seasonNumber: number): string | null {
  if (!dirExists(showRoot)) return null;
  try {
    for (const entry of fs.readdirSync(showRoot)) {
      const full = path.join(showRoot, entry);
      try {
        if (!fs.statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const re of SEASON_PATTERNS) {
        const m = entry.match(re);
        if (m && parseInt(m[1], 10) === seasonNumber) return full;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function allShowLocations(show: Show, roots: string[]): string[] {
  const out: string[] = [];
  const add = (p?: string) => {
    const t = (p || '').trim();
    if (!dirExists(t)) return;
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  add(show.libraryPath);
  const name = sanitizeName(show.name);
  for (const r of roots) add(path.join(r, name));
  return out;
}

/** Existing show folder, or top library root / ShowName for brand-new shows. */
export function getShowRoot(show: Show, libraryRoot: string, extraRoots?: string[]): string {
  const roots = uniqueRoots(libraryRoot, extraRoots);
  const existing = allShowLocations(show, roots)[0];
  if (existing) return existing;
  const primary = roots[0] || libraryRoot || '';
  return path.join(primary, sanitizeName(show.name));
}

/**
 * Where to put / find a season: reuse an existing Season XX folder anywhere,
 * otherwise use the top library root (even if the show already lives elsewhere).
 */
export function showRootForSeason(show: Show, roots: string[], seasonNumber: number): string {
  const ordered = uniqueRoots(roots);
  const candidates: string[] = [];
  if ((show.libraryPath || '').trim()) candidates.push(show.libraryPath!.trim());
  const name = sanitizeName(show.name);
  for (const r of ordered) candidates.push(path.join(r, name));
  for (const showRoot of candidates) {
    if (findSeasonDirExisting(showRoot, seasonNumber)) return showRoot;
  }
  const primary = ordered[0] || '';
  return path.join(primary, name);
}

/** Find existing season folder or create Season XX */
export function resolveSeasonDir(showRoot: string, seasonNumber: number): string {
  if (!fs.existsSync(showRoot)) {
    fs.mkdirSync(showRoot, { recursive: true });
  }

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(showRoot);
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    const full = path.join(showRoot, entry);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const re of SEASON_PATTERNS) {
      const m = entry.match(re);
      if (m && parseInt(m[1], 10) === seasonNumber) {
        return full;
      }
    }
  }

  const created = path.join(showRoot, `Season ${pad2(seasonNumber)}`);
  fs.mkdirSync(created, { recursive: true });
  return created;
}

export function buildEpisodeFilename(
  showName: string,
  seasonNumber: number,
  episodeNumber: number,
  episodeTitle: string,
  ext: string
): string {
  const cleanExt = ext.startsWith('.') ? ext : `.${ext}`;
  const title = sanitizeName(episodeTitle || 'Episode');
  return `${sanitizeName(showName)} - S${pad2(seasonNumber)}E${pad2(episodeNumber)} - ${title}${cleanExt}`;
}

export function buildEpisodePath(
  show: Show,
  libraryRoot: string,
  seasonNumber: number,
  episodeNumber: number,
  episodeTitle: string,
  ext: string,
  extraRoots?: string[]
): { seasonDir: string; filePath: string; fileName: string } {
  const roots = uniqueRoots(libraryRoot, extraRoots);
  const showRoot = showRootForSeason(show, roots, seasonNumber);
  const seasonDir = resolveSeasonDir(showRoot, seasonNumber);
  const fileName = buildEpisodeFilename(
    show.name,
    seasonNumber,
    episodeNumber,
    episodeTitle,
    ext
  );
  return {
    seasonDir,
    fileName,
    filePath: path.join(seasonDir, fileName),
  };
}

const VIDEO_EXTS = new Set([
  '.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv', '.ts', '.flv', '.webm',
]);

export function findLocalEpisode(
  show: Show,
  libraryRoot: string,
  seasonNumber: number,
  episodeNumber: number
): string | undefined {
  const showRoot = getShowRoot(show, libraryRoot);
  if (!fs.existsSync(showRoot)) return undefined;

  let seasonDir: string | undefined;
  try {
    for (const entry of fs.readdirSync(showRoot)) {
      const full = path.join(showRoot, entry);
      if (!fs.statSync(full).isDirectory()) continue;
      for (const re of SEASON_PATTERNS) {
        const m = entry.match(re);
        if (m && parseInt(m[1], 10) === seasonNumber) {
          seasonDir = full;
          break;
        }
      }
      if (seasonDir) break;
    }
  } catch {
    return undefined;
  }
  if (!seasonDir) return undefined;

  const epMatchRe = new RegExp(`S0*${seasonNumber}E0*${episodeNumber}(?!\\d)`, 'i');
  try {
    for (const file of fs.readdirSync(seasonDir)) {
      const ext = path.extname(file).toLowerCase();
      if (!VIDEO_EXTS.has(ext)) continue;
      if (epMatchRe.test(file)) {
        return path.join(seasonDir, file);
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function normalizePathKey(p: string): string {
  return path.normalize((p || '').trim()).replace(/[/\\]+$/, '').toLowerCase();
}

function isVideoFileExisting(p: string | undefined): boolean {
  const t = (p || '').trim();
  if (!t) return false;
  try {
    return fs.existsSync(t) && fs.statSync(t).isFile() && VIDEO_EXTS.has(path.extname(t).toLowerCase());
  } catch {
    return false;
  }
}

function normalizeLooseMovieBase(s: string): string {
  return s
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getMovieFolderName(movie: Movie): string {
  const title = sanitizeName(movie.title || 'Movie');
  if (movie.releaseYear) return `${title} (${movie.releaseYear})`;
  return title;
}

export function getMovieRoot(movie: Movie, movieLibraryRoot: string, extraRoots?: string[]): string {
  const roots = uniqueRoots(movieLibraryRoot, extraRoots);
  const rootKeys = new Set(roots.map(normalizePathKey));
  const custom = (movie.libraryPath || '').trim();
  if (custom && dirExists(custom) && !rootKeys.has(normalizePathKey(custom))) {
    return custom;
  }
  const folder = getMovieFolderName(movie);
  for (const r of roots) {
    const candidate = path.join(r, folder);
    if (dirExists(candidate)) return candidate;
  }
  const primary = roots[0] || movieLibraryRoot || '';
  return path.join(primary, folder);
}

/** Resolve / create `{movieLibraryRoot}/{Title} ({Year})/` */
export function resolveMovieDir(movie: Movie, movieLibraryRoot: string): string {
  const root = getMovieRoot(movie, movieLibraryRoot);
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
  return root;
}

export function buildMovieFilename(movie: Movie, ext: string): string {
  const cleanExt = ext.startsWith('.') ? ext : `.${ext}`;
  return `${getMovieFolderName(movie)}${cleanExt}`;
}

export function buildMoviePath(
  movie: Movie,
  movieLibraryRoot: string,
  ext: string
): { movieDir: string; filePath: string; fileName: string } {
  const movieDir = resolveMovieDir(movie, movieLibraryRoot);
  const fileName = buildMovieFilename(movie, ext);
  return {
    movieDir,
    fileName,
    filePath: path.join(movieDir, fileName),
  };
}

export function findLocalMovie(
  movie: Movie,
  movieLibraryRoot: string,
  extraRoots?: string[]
): string | undefined {
  // 1. Direct file path (e.g., loose movie imported from a shared movie root)
  if (isVideoFileExisting(movie.localPath)) {
    return movie.localPath!.trim();
  }
  if (isVideoFileExisting(movie.libraryPath)) {
    return movie.libraryPath!.trim();
  }

  const roots = uniqueRoots(movieLibraryRoot, extraRoots);
  const rootKeys = new Set(roots.map(normalizePathKey));
  const movieRoot = getMovieRoot(movie, movieLibraryRoot, extraRoots);
  const folderName = getMovieFolderName(movie).toLowerCase();

  // 2. Dedicated movie subfolder (safe to fall back to first video inside it)
  if (movieRoot && dirExists(movieRoot) && !rootKeys.has(normalizePathKey(movieRoot))) {
    try {
      const videos: string[] = [];
      for (const file of fs.readdirSync(movieRoot)) {
        const ext = path.extname(file).toLowerCase();
        if (!VIDEO_EXTS.has(ext)) continue;
        videos.push(path.join(movieRoot, file));
      }
      if (videos.length) {
        const exact = videos.find((v) => {
          const base = path.basename(v, path.extname(v)).toLowerCase();
          return base === folderName;
        });
        return exact || videos[0];
      }
    } catch {
      // fall through to loose-file check
    }
  }

  // 3. Loose video file directly inside a movie root (must match title/year, never pick arbitrary videos[0])
  const searchDirs = uniqueRoots(
    roots,
    movie.libraryPath && dirExists(movie.libraryPath.trim()) ? movie.libraryPath.trim() : undefined
  );
  const wantTitle = normalizeLooseMovieBase(movie.title || '');
  const wantWithYear = movie.releaseYear ? normalizeLooseMovieBase(`${movie.title || ''} ${movie.releaseYear}`) : '';
  for (const dir of searchDirs) {
    if (!dirExists(dir)) continue;
    try {
      for (const file of fs.readdirSync(dir)) {
        const ext = path.extname(file).toLowerCase();
        if (!VIDEO_EXTS.has(ext)) continue;
        const full = path.join(dir, file);
        try {
          if (!fs.statSync(full).isFile()) continue;
        } catch {
          continue;
        }
        const base = path.basename(file, ext);
        if (base.toLowerCase() === folderName) return full;
        const norm = normalizeLooseMovieBase(base);
        if (wantWithYear && norm === wantWithYear) return full;
        if (wantTitle && norm === wantTitle) return full;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * One-pass disk index for a show: readdir show root + each season folder once,
 * then map `${season}:${episode}` → file path. Used by applyLocalStatuses
 * instead of per-episode scans.
 */
function indexOneShowRoot(showRoot: string): Map<string, string> {
  const found = new Map<string, string>();
  if (!dirExists(showRoot)) return found;
  const seasonDirs: Array<{ seasonNumber: number; dir: string }> = [];
  try {
    for (const entry of fs.readdirSync(showRoot)) {
      const full = path.join(showRoot, entry);
      try {
        if (!fs.statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const re of SEASON_PATTERNS) {
        const m = entry.match(re);
        if (m) {
          seasonDirs.push({ seasonNumber: parseInt(m[1], 10), dir: full });
          break;
        }
      }
    }
  } catch {
    return found;
  }
  const epRe = /S(\d{1,2})E(\d{1,3})/i;
  for (const { seasonNumber, dir } of seasonDirs) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (!VIDEO_EXTS.has(ext)) continue;
      const m = file.match(epRe);
      if (!m) continue;
      const sn = parseInt(m[1], 10);
      const en = parseInt(m[2], 10);
      if (sn !== seasonNumber) continue;
      const key = `${sn}:${en}`;
      if (!found.has(key)) found.set(key, path.join(dir, file));
    }
  }
  return found;
}

export function indexLocalEpisodes(
  show: Show,
  libraryRoot: string,
  extraRoots?: string[]
): Map<string, string> {
  const found = new Map<string, string>();
  const roots = uniqueRoots(libraryRoot, extraRoots);
  for (const showRoot of allShowLocations(show, roots)) {
    for (const [k, v] of indexOneShowRoot(showRoot)) {
      if (!found.has(k)) found.set(k, v);
    }
  }
  return found;
}
