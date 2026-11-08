/**
 * Turn a magnet or .torrent the user added on the Downloads tab into a library episode or movie.
 * The normal finisher then moves the video into that title's folder.
 */
import fs from 'fs';
import { Movie, Show } from '../types';
import { showMatchScore, titleMatchesMovie, titleMatchesShow } from './search';

// parse-torrent stays external (same package WebTorrent already ships).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const parseTorrent = require('parse-torrent') as {
  (id: string | Buffer): { name?: string; infoHash?: string };
  toMagnetURI: (parsed: { name?: string; infoHash?: string }) => string;
};

export function magnetDisplayName(magnet: string): string {
  const match = String(magnet || '').match(/[?&]dn=([^&]+)/i);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1].replace(/\+/g, ' ')).trim();
  } catch {
    return match[1].trim();
  }
}

export function readTorrentFile(filePath: string): { name: string; magnet: string } {
  const buf = fs.readFileSync(filePath);
  const parsed = parseTorrent(buf);
  if (!parsed?.infoHash) throw new Error('That torrent file could not be read');
  const name = String(parsed.name || '').trim();
  if (!name) throw new Error('That torrent file has no name');
  return { name, magnet: parseTorrent.toMagnetURI(parsed) };
}

export function parseEpisodeTag(title: string): { season: number; episode: number } | null {
  const text = String(title || '').replace(/[._]/g, ' ');
  const seasonEpisode = text.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
  const cross = text.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  const match = seasonEpisode || cross;
  if (!match) return null;
  const season = parseInt(match[1], 10);
  const episode = parseInt(match[2], 10);
  if (!season || !episode) return null;
  return { season, episode };
}

export function episodeTitleFromShow(show: Show, season: number, episode: number): string {
  for (const seasonObj of show.seasons || []) {
    if (seasonObj.seasonNumber !== season) continue;
    const found = (seasonObj.episodes || []).find((item) => item.episodeNumber === episode);
    if (found?.name) return found.name;
  }
  return 'Episode';
}

export type ManualTorrentMatch =
  | { kind: 'episode'; show: Show; season: number; episode: number; episodeTitle: string }
  | { kind: 'movie'; movie: Movie }
  | { kind: 'lookup-show'; title: string; season: number; episode: number }
  | { kind: 'lookup-movie'; title: string; year: number | null };

const RELEASE_CUT = /\b(?:19|20)\d{2}\b|\b(?:720|1080|2160)p\b|\b(?:bluray|blu-ray|web[- ]?dl|webrip|hdtv|dvdrip|brrip|hdrip)\b/i;

function cleanTorrentText(name: string): string {
  return String(name || '')
    .replace(/[._]+/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "The Odyssey (2026) [1080p] [BluRay]" -> title The Odyssey, year 2026. */
export function movieGuessFromTorrentName(name: string): { title: string; year: number | null } {
  let text = cleanTorrentText(name);
  let year: number | null = null;
  const paren = text.match(/\((19|20)\d{2}\)/);
  if (paren) {
    year = Number(paren[0].slice(1, 5));
    text = text.replace(paren[0], ' ').replace(/\s+/g, ' ').trim();
  }
  const cut = text.search(RELEASE_CUT);
  if (cut > 0) {
    if (year == null) {
      const found = text.slice(cut).match(/\b((?:19|20)\d{2})\b/);
      if (found) year = Number(found[1]);
    }
    text = text.slice(0, cut).trim();
  }
  text = text.replace(/[\s\-–_:]+$/g, '').trim();
  return { title: text, year };
}

export function showGuessFromTorrentName(name: string): string {
  let text = cleanTorrentText(name);
  text = text.replace(/\bS\d{1,2}E\d{1,3}\b/ig, ' ');
  text = text.replace(/\b\d{1,2}x\d{1,3}\b/ig, ' ');
  const cut = text.search(RELEASE_CUT);
  if (cut > 0) text = text.slice(0, cut);
  return text.replace(/[\s\-–_:()]+$/g, '').replace(/\s+/g, ' ').trim();
}

function sameName(a: string, b: string): boolean {
  const norm = (value: string) => value.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  return norm(a) === norm(b);
}

export function pickMovieHit<T extends { title: string; releaseYear: number | null }>(
  results: T[],
  title: string,
  year: number | null
): T | null {
  const same = results.filter((item) => sameName(item.title, title));
  if (year) {
    const dated = same.filter((item) => item.releaseYear === year);
    return dated[0] || null;
  }
  return same[0] || null;
}

export function pickShowHit<T extends { name: string }>(results: T[], title: string): T | null {
  return results.find((item) => sameName(item.name, title)) || null;
}

export function matchManualTorrent(
  name: string,
  shows: Show[],
  movies: Movie[]
): ManualTorrentMatch {
  const title = String(name || '').trim();
  if (!title) throw new Error('This magnet has no title. Use a torrent file, or a magnet that includes the name.');

  const tag = parseEpisodeTag(title);
  if (tag) {
    let best: { show: Show; score: number } | null = null;
    for (const show of shows) {
      if (!titleMatchesShow(title, show.name)) continue;
      const score = showMatchScore(title, show.name);
      const hasEpisode = (show.seasons || []).some(
        (season) => season.seasonNumber === tag.season
          && (season.episodes || []).some((episode) => episode.episodeNumber === tag.episode)
      );
      const ranked = score + (hasEpisode ? 5 : 0);
      if (!best || ranked > best.score) best = { show, score: ranked };
    }
    if (!best) {
      const guessed = showGuessFromTorrentName(title);
      if (!guessed) {
        throw new Error('This magnet has no title. Use a torrent file, or a magnet that includes the name.');
      }
      return { kind: 'lookup-show', title: guessed, season: tag.season, episode: tag.episode };
    }
    return {
      kind: 'episode',
      show: best.show,
      season: tag.season,
      episode: tag.episode,
      episodeTitle: episodeTitleFromShow(best.show, tag.season, tag.episode),
    };
  }

  const hits = movies.filter((movie) => titleMatchesMovie(title, movie.title, {
    titles: [movie.title],
    imdbId: movie.imdbId,
    releaseDates: movie.releaseDate ? [movie.releaseDate.slice(0, 10)] : [],
  }));
  if (!hits.length) {
    const guessed = movieGuessFromTorrentName(title);
    if (!guessed.title) {
      throw new Error('This magnet has no title. Use a torrent file, or a magnet that includes the name.');
    }
    return { kind: 'lookup-movie', title: guessed.title, year: guessed.year };
  }
  const yearInTitle = title.match(/\b(19|20)\d{2}\b/);
  const year = yearInTitle ? Number(yearInTitle[0]) : 0;
  const picked = (year
    ? hits.find((movie) => movie.releaseYear === year) || hits[0]
    : hits[0]);
  return { kind: 'movie', movie: picked };
}
