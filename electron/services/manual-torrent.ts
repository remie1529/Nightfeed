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

function episodeTitle(show: Show, season: number, episode: number): string {
  for (const seasonObj of show.seasons || []) {
    if (seasonObj.seasonNumber !== season) continue;
    const found = (seasonObj.episodes || []).find((item) => item.episodeNumber === episode);
    if (found?.name) return found.name;
  }
  return 'Episode';
}

export function matchManualTorrent(
  name: string,
  shows: Show[],
  movies: Movie[]
):
  | { kind: 'episode'; show: Show; season: number; episode: number; episodeTitle: string }
  | { kind: 'movie'; movie: Movie } {
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
      throw new Error(
        `This looks like S${String(tag.season).padStart(2, '0')}E${String(tag.episode).padStart(2, '0')} but no show in the library matches “${title}”. Add the show, then try again.`
      );
    }
    return {
      kind: 'episode',
      show: best.show,
      season: tag.season,
      episode: tag.episode,
      episodeTitle: episodeTitle(best.show, tag.season, tag.episode),
    };
  }

  const hits = movies.filter((movie) => titleMatchesMovie(title, movie.title, {
    titles: [movie.title],
    imdbId: movie.imdbId,
    releaseDates: movie.releaseDate ? [movie.releaseDate.slice(0, 10)] : [],
  }));
  if (!hits.length) {
    throw new Error(`No movie in the library matches “${title}”. Add the movie, then try again.`);
  }
  const yearInTitle = title.match(/\b(19|20)\d{2}\b/);
  const year = yearInTitle ? Number(yearInTitle[0]) : 0;
  const picked = (year
    ? hits.find((movie) => movie.releaseYear === year) || hits[0]
    : hits[0]);
  return { kind: 'movie', movie: picked };
}
