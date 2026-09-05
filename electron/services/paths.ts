import fs from 'fs';
import path from 'path';
import { Show } from '../types';

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

export function getShowRoot(show: Show, libraryRoot: string): string {
  if (show.libraryPath && show.libraryPath.trim()) {
    return show.libraryPath.trim();
  }
  return path.join(libraryRoot, sanitizeName(show.name));
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
  ext: string
): { seasonDir: string; filePath: string; fileName: string } {
  const showRoot = getShowRoot(show, libraryRoot);
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
