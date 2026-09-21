/**
 * Kodi-compatible .nfo sidecars for Plex / local agents.
 * Pure fs + XML — safe to call from main or torrent-utility.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import type { Episode, Movie, Show } from '../types';
import { getMovieRoot, getShowRoot } from './paths';

function escapeXml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function yearFromDate(d: string | null | undefined): string | null {
  if (!d) return null;
  const m = String(d).match(/^(\d{4})/);
  return m ? m[1] : null;
}

function findEpisode(show: Show, seasonNumber: number, episodeNumber: number): Episode | undefined {
  for (const season of show.seasons || []) {
    if (season.seasonNumber !== seasonNumber) continue;
    return (season.episodes || []).find((e) => e.episodeNumber === episodeNumber);
  }
  return undefined;
}

function uniqueIdXml(
  entries: Array<{ type: string; value: string | number | null | undefined; default?: boolean }>
): string {
  const lines: string[] = [];
  for (const e of entries) {
    if (e.value == null || e.value === '') continue;
    const v = String(e.value).trim();
    if (!v) continue;
    const def = e.default ? ' default="true"' : '';
    lines.push(`  <uniqueid type="${escapeXml(e.type)}"${def}>${escapeXml(v)}</uniqueid>`);
  }
  return lines.join('\n');
}

/** Show root folder for an on-disk episode file: .../Show/Season XX/file.mkv → .../Show */
export function showRootFromEpisodeFile(videoPath: string): string {
  return path.dirname(path.dirname(videoPath));
}

export function buildTvShowNfoXml(show: Show): string {
  const year = yearFromDate(show.firstAirDate);
  const ids = uniqueIdXml([
    { type: 'imdb', value: show.imdbId, default: !!(show.imdbId && String(show.imdbId).trim()) },
    {
      type: 'tvmaze',
      value: show.tmdbId > 0 ? show.tmdbId : null,
      default: !(show.imdbId && String(show.imdbId).trim()),
    },
  ]);
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<tvshow>',
    `  <title>${escapeXml(show.name || 'Unknown')}</title>`,
  ];
  if (show.overview) parts.push(`  <plot>${escapeXml(show.overview)}</plot>`);
  if (show.firstAirDate) parts.push(`  <premiered>${escapeXml(show.firstAirDate)}</premiered>`);
  if (year) parts.push(`  <year>${escapeXml(year)}</year>`);
  if (show.status) parts.push(`  <status>${escapeXml(show.status)}</status>`);
  if (ids) parts.push(ids);
  if (show.posterPath) parts.push(`  <thumb>${escapeXml(show.posterPath)}</thumb>`);
  if (show.backdropPath) {
    parts.push(`  <fanart><thumb>${escapeXml(show.backdropPath)}</thumb></fanart>`);
  }
  parts.push('</tvshow>', '');
  return parts.join('\n');
}

export function buildEpisodeNfoXml(
  show: Show,
  seasonNumber: number,
  episodeNumber: number,
  episodeTitle?: string,
  episodeOverview?: string
): string {
  const ep = findEpisode(show, seasonNumber, episodeNumber);
  const title = (episodeTitle || ep?.name || `Episode ${episodeNumber}`).trim();
  const plot = (episodeOverview ?? ep?.overview ?? '').trim();
  const airDate = ep?.airDate || null;
  const ids = uniqueIdXml([
    { type: 'imdb', value: show.imdbId, default: !!(show.imdbId && String(show.imdbId).trim()) },
    {
      type: 'tvmaze',
      value: ep?.id || (show.tmdbId > 0 ? show.tmdbId : null),
      default: !(show.imdbId && String(show.imdbId).trim()),
    },
  ]);
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<episodedetails>',
    `  <title>${escapeXml(title)}</title>`,
    `  <showtitle>${escapeXml(show.name || 'Unknown')}</showtitle>`,
    `  <season>${seasonNumber}</season>`,
    `  <episode>${episodeNumber}</episode>`,
  ];
  if (plot) parts.push(`  <plot>${escapeXml(plot)}</plot>`);
  if (airDate) parts.push(`  <aired>${escapeXml(airDate)}</aired>`);
  if (ids) parts.push(ids);
  if (ep?.stillPath) parts.push(`  <thumb>${escapeXml(ep.stillPath)}</thumb>`);
  parts.push('</episodedetails>', '');
  return parts.join('\n');
}

export function buildMovieNfoXml(movie: Movie): string {
  const year =
    movie.releaseYear != null
      ? String(movie.releaseYear)
      : yearFromDate(movie.releaseDate);
  const imdb = (
    movie.imdbId || (movie.tmdbId > 0 ? `tt${movie.tmdbId}` : '')
  ).trim();
  const ids = uniqueIdXml([{ type: 'imdb', value: imdb || null, default: true }]);
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<movie>',
    `  <title>${escapeXml(movie.title || 'Unknown')}</title>`,
  ];
  if (movie.overview) parts.push(`  <plot>${escapeXml(movie.overview)}</plot>`);
  if (movie.releaseDate) parts.push(`  <premiered>${escapeXml(movie.releaseDate)}</premiered>`);
  if (year) parts.push(`  <year>${escapeXml(year)}</year>`);
  if (movie.runtime != null && movie.runtime > 0) {
    parts.push(`  <runtime>${movie.runtime}</runtime>`);
  }
  if (ids) parts.push(ids);
  if (movie.posterPath) parts.push(`  <thumb>${escapeXml(movie.posterPath)}</thumb>`);
  if (movie.backdropPath) {
    parts.push(`  <fanart><thumb>${escapeXml(movie.backdropPath)}</thumb></fanart>`);
  }
  parts.push('</movie>', '');
  return parts.join('\n');
}

async function writeFileUtf8(filePath: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, 'utf8');
}

/**
 * Upsert tvshow.nfo in the show root. Returns path if written, else null.
 */
export async function writeTvShowNfo(show: Show, showRoot: string): Promise<string | null> {
  const root = (showRoot || '').trim();
  if (!root) return null;
  try {
    if (!fs.existsSync(root)) {
      await fsp.mkdir(root, { recursive: true });
    }
  } catch {
    return null;
  }
  const nfoPath = path.join(root, 'tvshow.nfo');
  await writeFileUtf8(nfoPath, buildTvShowNfoXml(show));
  return nfoPath;
}

/**
 * Upsert tvshow.nfo using library roots / show.libraryPath. No-op if no folder yet.
 */
export async function ensureTvShowNfo(
  show: Show,
  libraryRoot: string,
  extraRoots?: string[]
): Promise<string | null> {
  const root = getShowRoot(show, libraryRoot, extraRoots);
  if (!root) return null;
  // Only write when the show folder already exists (or libraryPath points at one),
  // unless libraryPath is set — then create + write.
  const hasLib = !!(show.libraryPath || '').trim();
  if (!hasLib && !fs.existsSync(root)) return null;
  return writeTvShowNfo(show, root);
}

/**
 * Write tvshow.nfo + episode .nfo beside the video after a successful place.
 * Returns paths written (for activity log).
 */
export async function writeEpisodeNfos(opts: {
  show: Show;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle?: string;
  videoPath: string;
}): Promise<string[]> {
  const videoPath = (opts.videoPath || '').trim();
  if (!videoPath) return [];
  const showRoot = showRootFromEpisodeFile(videoPath);
  const written: string[] = [];
  try {
    const showNfo = await writeTvShowNfo(opts.show, showRoot);
    if (showNfo) written.push(showNfo);
  } catch {
    // continue — still try episode nfo
  }
  const base = videoPath.replace(/\.[^.]+$/, '');
  const epNfo = `${base}.nfo`;
  try {
    await writeFileUtf8(
      epNfo,
      buildEpisodeNfoXml(
        opts.show,
        opts.seasonNumber,
        opts.episodeNumber,
        opts.episodeTitle
      )
    );
    written.push(epNfo);
  } catch {
    // ignore
  }
  return written;
}

/**
 * Write movie.nfo (+ basename.nfo) in the movie folder after a successful place.
 */
export async function writeMovieNfos(opts: {
  movie: Movie;
  videoPath: string;
  movieLibraryRoot?: string;
}): Promise<string[]> {
  const videoPath = (opts.videoPath || '').trim();
  if (!videoPath) return [];
  const movieDir =
    opts.movieLibraryRoot != null
      ? getMovieRoot(opts.movie, opts.movieLibraryRoot)
      : path.dirname(videoPath);
  const xml = buildMovieNfoXml(opts.movie);
  const written: string[] = [];
  const movieNfo = path.join(movieDir || path.dirname(videoPath), 'movie.nfo');
  try {
    await writeFileUtf8(movieNfo, xml);
    written.push(movieNfo);
  } catch {
    // ignore
  }
  const baseNfo = `${videoPath.replace(/\.[^.]+$/, '')}.nfo`;
  if (path.resolve(baseNfo) !== path.resolve(movieNfo)) {
    try {
      await writeFileUtf8(baseNfo, xml);
      written.push(baseNfo);
    } catch {
      // ignore
    }
  }
  return written;
}
