import fs from 'fs';
import path from 'path';
import { Movie, Show } from '../types';

const SEASON_PATTERNS = [
  /^season\s*0*(\d+)$/i,
  /^s0*(\d+)$/i,
];

export function sanitizeName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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

  const marker = `S${pad2(seasonNumber)}E${pad2(episodeNumber)}`;
  const markerAlt = `S${seasonNumber}E${episodeNumber}`;
  try {
    for (const file of fs.readdirSync(seasonDir)) {
      const ext = path.extname(file).toLowerCase();
      if (!VIDEO_EXTS.has(ext)) continue;
      const upper = file.toUpperCase();
      if (upper.includes(marker.toUpperCase()) || upper.includes(markerAlt.toUpperCase())) {
        return path.join(seasonDir, file);
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function getMovieFolderName(movie: Movie): string {
  const title = sanitizeName(movie.title || 'Movie');
  if (movie.releaseYear) return `${title} (${movie.releaseYear})`;
  return title;
}

export function getMovieRoot(movie: Movie, movieLibraryRoot: string, extraRoots?: string[]): string {
  if (movie.libraryPath && dirExists(movie.libraryPath.trim())) {
    return movie.libraryPath.trim();
  }
  const folder = getMovieFolderName(movie);
  const roots = uniqueRoots(movieLibraryRoot, extraRoots);
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
  const movieRoot = getMovieRoot(movie, movieLibraryRoot, extraRoots);
  if (!fs.existsSync(movieRoot)) return undefined;

  const folderName = getMovieFolderName(movie).toLowerCase();
  try {
    const videos: string[] = [];
    for (const file of fs.readdirSync(movieRoot)) {
      const ext = path.extname(file).toLowerCase();
      if (!VIDEO_EXTS.has(ext)) continue;
      videos.push(path.join(movieRoot, file));
    }
    if (!videos.length) return undefined;
    const exact = videos.find((v) => {
      const base = path.basename(v, path.extname(v)).toLowerCase();
      return base === folderName;
    });
    return exact || videos[0];
  } catch {
    return undefined;
  }
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
