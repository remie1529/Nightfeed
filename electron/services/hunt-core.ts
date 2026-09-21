/**
 * Shared auto-hunt orchestration (shows + movie upgrades).
 * Runs inside hunt-worker OR in-process as fallback. Does not start WebTorrent.
 */
import path from 'path';
import type {
  AppSettings,
  Episode,
  EpisodeOverrideStatus,
  Movie,
  Resolution,
  SearchResult,
  Show,
  TorrentCandidate,
} from '../types';
import { DEFAULT_TORRENT_SOURCES } from '../types';
import {
  detectResolution,
  extractInfoHash,
  filterQualityResults,
  filterUpgradeResults,
  pickAutoDownload,
  pickUpgradeDownload,
  resolutionRank,
  searchEpisodeTorrents,
  searchMovieTorrents,
  type QualityRules,
} from './search';

function triedEpisodeKey(showId: number, season: number, episode: number): string {
  return `ep:${showId}:${season}:${episode}`;
}

function triedMovieKey(movieId: number): string {
  return `movie:${movieId}`;
}

export type HuntProgress = {
  phase: 'hunt' | 'movies';
  current: number;
  total: number;
  label?: string;
};

export type HuntLogLine = {
  level: 'info' | 'warn';
  category: string;
  message: string;
  meta?: Record<string, unknown>;
};

export type HuntDownloadIntent = {
  kind: 'episode' | 'movie';
  magnet: string;
  infoHash?: string;
  title: string;
  resolution?: Resolution | null;
  seeders?: number;
  source?: string;
  upgrade: boolean;
  preferred: Resolution;
  quality: QualityRules;
  candidates: TorrentCandidate[];
  triedInfoHashes: string[];
  showId?: number;
  showName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string;
  movieId?: number;
  movieTitle?: string;
  releaseYear?: number | null;
  choiceDescription: string;
  resultCount: number;
  triedSkipped: number;
  sourcesHit: string;
  searchError?: string;
};

export type HuntShowsInput = {
  shows: Show[];
  settings: AppSettings;
  force?: boolean;
  overrides: Record<string, EpisodeOverrideStatus>;
  triedTorrents: Record<string, string[]>;
  /** Keys matching engine hasEpisodeActivity (showId:season:episode). */
  activeEpisodeKeys: string[];
  onProgress?: (p: HuntProgress) => void;
};

export type HuntMoviesInput = {
  movies: Movie[];
  settings: AppSettings;
  allowUpgrade?: boolean;
  force?: boolean;
  triedTorrents: Record<string, string[]>;
  activeMovieIds: number[];
  onProgress?: (p: HuntProgress) => void;
};

export type HuntResult = {
  intents: HuntDownloadIntent[];
  logs: HuntLogLine[];
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function isMonitored(item: { monitored?: boolean } | null | undefined): boolean {
  return item?.monitored !== false;
}

function shortInfoHash(hashOrMagnet?: string | null): string {
  const raw = (hashOrMagnet || '').trim();
  if (!raw) return '';
  const fromMagnet = extractInfoHash(raw);
  const h = (fromMagnet || raw).toLowerCase().replace(/[^a-f0-9]/g, '');
  return h ? h.slice(0, 8) : '';
}

function enabledTorrentSourceIds(settings: AppSettings): string[] {
  const src = { ...DEFAULT_TORRENT_SOURCES, ...(settings.torrentSources || {}) };
  return (Object.keys(src) as Array<keyof typeof src>).filter((k) => !!(src as any)[k]).map(String);
}

function sourcesInResults(results: Array<{ source?: string }> | undefined): string {
  const set = new Set<string>();
  for (const r of results || []) {
    if (r?.source) set.add(String(r.source));
  }
  return set.size ? Array.from(set).sort().join(',') : '(none)';
}

export function buildQualityRules(
  settings: AppSettings,
  kind: 'episode' | 'movie',
  preferredOverride?: Resolution | null,
  show?: Show | null
): QualityRules {
  const preferred =
    (preferredOverride ||
      (kind === 'movie'
        ? settings.defaultMovieResolution || settings.defaultResolution
        : settings.defaultResolution)) as Resolution;
  const minimum =
    (kind === 'episode' && show?.minimumResolution
      ? show.minimumResolution
      : kind === 'movie'
        ? settings.minimumMovieResolution || settings.minimumResolution
        : settings.minimumResolution) || '720p';
  const tv720 = show?.minSizeMb720p != null ? show.minSizeMb720p : settings.minSizeMbTv720p;
  const tv1080 = show?.minSizeMb1080p != null ? show.minSizeMb1080p : settings.minSizeMbTv1080p;
  const tv2160 = show?.minSizeMb2160p != null ? show.minSizeMb2160p : settings.minSizeMbTv2160p;
  return {
    preferred,
    minimum: minimum as Resolution,
    minSizeMb: {
      '720p': (kind === 'movie' ? settings.minSizeMbMovie720p : tv720) || 0,
      '1080p': (kind === 'movie' ? settings.minSizeMbMovie1080p : tv1080) || 0,
      '2160p': (kind === 'movie' ? settings.minSizeMbMovie2160p : tv2160) || 0,
    },
    minSeeders: typeof settings.minSeeders === 'number' ? settings.minSeeders : 8,
  };
}

function currentLibraryResolution(
  localPath: string | undefined,
  stored?: Resolution | null
): Resolution | null {
  if (stored) return stored;
  if (!localPath) return null;
  return detectResolution(path.basename(localPath));
}

function needsPreferredUpgrade(
  current: Resolution | null | undefined,
  preferred: Resolution
): boolean {
  if (!current) return false;
  return resolutionRank(current) < resolutionRank(preferred);
}

function filterResultsSkippingTried<T extends { magnet?: string; infoHash?: string }>(
  results: T[],
  tried: Iterable<string>
): T[] {
  const set = new Set(Array.from(tried).map((h) => h.toLowerCase()).filter(Boolean));
  if (!set.size) return results;
  return (results || []).filter((r) => {
    const h = (r.infoHash || extractInfoHash(r.magnet || '') || '').toLowerCase();
    return !h || !set.has(h);
  });
}

function toCandidates(
  results: Array<{ magnet: string; infoHash?: string; title?: string }>
): TorrentCandidate[] {
  return (results || [])
    .filter((r) => r?.magnet)
    .map((r) => ({
      magnet: r.magnet,
      infoHash: (r.infoHash || extractInfoHash(r.magnet) || '').toLowerCase() || undefined,
      title: r.title,
    }));
}

function toHealthyPreferredCandidates(
  results: SearchResult[],
  preferred: Resolution,
  kind: 'episode' | 'movie',
  rules: QualityRules,
  upgradeOnly = false
): TorrentCandidate[] {
  const filtered = upgradeOnly
    ? filterUpgradeResults(results, preferred, kind, rules)
    : filterQualityResults(results, preferred, kind, rules);
  return toCandidates(filtered);
}

function describeTorrentChoice(
  best: {
    title?: string;
    magnet?: string;
    infoHash?: string;
    resolution?: Resolution | null;
    seeders?: number;
    source?: string;
  },
  opts: {
    preferred: Resolution;
    upgrade?: boolean;
    triedSkipped: number;
    healthyCount: number;
    mode: 'auto' | 'upgrade';
  }
): string {
  const title = String(best.title || 'torrent').slice(0, 120);
  const hash = shortInfoHash(best.infoHash || best.magnet);
  const bits: string[] = [`"${title}"`];
  if (hash) bits.push(`hash ${hash}`);
  if (best.resolution) bits.push(String(best.resolution));
  else {
    const guessed = detectResolution(title);
    if (guessed) bits.push(guessed);
  }
  if (typeof best.seeders === 'number') bits.push(`${best.seeders} seeders`);
  if (best.source) bits.push(`via ${best.source}`);
  const why: string[] = [];
  if (opts.mode === 'upgrade' || opts.upgrade) why.push('upgrade hunt');
  else why.push('auto hunt');
  const res = best.resolution || detectResolution(title);
  if (res === opts.preferred) why.push(`preferred ${opts.preferred}`);
  else if (res) why.push(`${res} (preferred ${opts.preferred})`);
  else why.push(`preferred ${opts.preferred}`);
  if (typeof best.seeders === 'number') why.push(`${best.seeders} seeders`);
  if (opts.triedSkipped > 0) {
    why.push(`skipped ${opts.triedSkipped} tried hash${opts.triedSkipped === 1 ? '' : 'es'}`);
  }
  if (opts.healthyCount > 0) {
    why.push(`highest rank of ${opts.healthyCount} healthy`);
  }
  return `${bits.join(', ')} — ${why.join(', ')}`;
}

function triedListFor(
  map: Record<string, string[]>,
  key: string
): string[] {
  const list = map[key];
  if (!Array.isArray(list)) return [];
  return list.map((h) => String(h || '').toLowerCase()).filter(Boolean);
}

function overrideKey(showId: number, season: number, episode: number): string {
  return `${showId}:${season}:${episode}`;
}

export async function huntShowsCore(input: HuntShowsInput): Promise<HuntResult> {
  const settings = input.settings;
  const force = !!input.force;
  const logs: HuntLogLine[] = [];
  const intents: HuntDownloadIntent[] = [];
  const active = new Set(input.activeEpisodeKeys || []);
  const overrides = input.overrides || {};
  const triedMap = input.triedTorrents || {};
  const sourceIds = enabledTorrentSourceIds(settings);

  logs.push({
    level: 'info',
    category: 'hunt',
    message: `Auto hunt start: ${input.shows.length} show(s)${force ? ' (forced)' : ''}`,
    meta: { sources: sourceIds.join(',') || '(none)' },
  });

  let pausedShows = 0;
  let totalNoCandidates = 0;
  let totalFailed = 0;

  for (let si = 0; si < input.shows.length; si++) {
    const show = input.shows[si];
    input.onProgress?.({
      phase: 'hunt',
      current: si + 1,
      total: input.shows.length,
      label: show.name,
    });

    if (!isMonitored(show) && !force) {
      pausedShows += 1;
      continue;
    }

    const preferred = (show.preferredResolution || settings.defaultResolution) as Resolution;
    const rules = buildQualityRules(settings, 'episode', preferred, show);
    type EpJob = { ep: Episode; upgrade: boolean };
    const jobs: EpJob[] = [];
    let ignored = 0;
    let alreadyDl = 0;
    let haveOk = 0;

    for (const season of show.seasons || []) {
      for (const ep of season.episodes || []) {
        const ok = overrideKey(show.tmdbId, ep.seasonNumber, ep.episodeNumber);
        if (ep.status === 'ignored' || overrides[ok] === 'ignored') {
          ignored += 1;
          continue;
        }
        if (active.has(ok)) {
          alreadyDl += 1;
          continue;
        }
        if (ep.status === 'missing' || ep.status === 'aired') {
          jobs.push({ ep, upgrade: false });
          continue;
        }
        if (ep.status === 'downloaded') {
          const current = currentLibraryResolution(ep.localPath, ep.downloadedResolution);
          if (needsPreferredUpgrade(current, preferred)) {
            jobs.push({ ep, upgrade: true });
          } else {
            haveOk += 1;
          }
        }
      }
    }

    logs.push({
      level: 'info',
      category: 'hunt',
      message: `Scan show: ${show.name} — ${jobs.length} to check (${jobs.filter((j) => j.upgrade).length} upgrade), skipped ${ignored} ignored / ${alreadyDl} already downloading / ${haveOk} have preferred`,
      meta: { preferred, mazeId: show.tmdbId },
    });

    for (const { ep, upgrade } of jobs) {
      const epLabel = `${show.name} S${pad2(ep.seasonNumber)}E${pad2(ep.episodeNumber)}`;
      const ok = overrideKey(show.tmdbId, ep.seasonNumber, ep.episodeNumber);
      if (active.has(ok)) continue;

      try {
        const { results, error: searchErr } = await searchEpisodeTorrents(
          settings,
          show.name,
          ep.seasonNumber,
          ep.episodeNumber,
          preferred,
          { imdbId: show.imdbId, mazeId: show.tmdbId }
        );
        const triedKey = triedEpisodeKey(show.tmdbId, ep.seasonNumber, ep.episodeNumber);
        const triedList = triedListFor(triedMap, triedKey);
        const pool = filterResultsSkippingTried(results, triedList);
        const triedSkipped = (results?.length || 0) - pool.length;
        const best = upgrade
          ? pickUpgradeDownload(pool, preferred, 'episode', rules)
          : pickAutoDownload(pool, preferred, 'episode', rules);

        if (!best?.magnet) {
          totalNoCandidates += 1;
          continue;
        }

        const candidates = toHealthyPreferredCandidates(pool, preferred, 'episode', rules, upgrade);
        const choiceDescription = describeTorrentChoice(best, {
          preferred,
          upgrade,
          triedSkipped,
          healthyCount: candidates.length,
          mode: upgrade ? 'upgrade' : 'auto',
        });

        intents.push({
          kind: 'episode',
          magnet: best.magnet,
          infoHash: best.infoHash || extractInfoHash(best.magnet) || undefined,
          title: best.title || epLabel,
          resolution: best.resolution,
          seeders: best.seeders,
          source: best.source,
          upgrade,
          preferred,
          quality: rules,
          candidates,
          triedInfoHashes: triedList,
          showId: show.tmdbId,
          showName: show.name,
          seasonNumber: ep.seasonNumber,
          episodeNumber: ep.episodeNumber,
          episodeTitle: ep.name,
          choiceDescription,
          resultCount: results?.length || 0,
          triedSkipped,
          sourcesHit: sourcesInResults(results),
          searchError: searchErr || undefined,
        });
        // Avoid re-picking same ep if later logic re-scans within same pass.
        active.add(ok);
      } catch (err) {
        totalFailed += 1;
        logs.push({
          level: 'warn',
          category: 'hunt',
          message: `Episode check failed: ${epLabel}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  if (pausedShows) {
    logs.push({
      level: 'info',
      category: 'hunt',
      message: `Skipped ${pausedShows} paused show(s)`,
    });
  }

  logs.push({
    level: 'info',
    category: 'hunt',
    message: `Auto hunt plan: ${intents.length} download intent(s)${
      totalNoCandidates || totalFailed
        ? ` (${totalNoCandidates} no candidates, ${totalFailed} failed)`
        : ''
    }`,
  });

  return { intents, logs };
}

type MovieSkipCounts = {
  paused: number;
  downloading: number;
  have: number;
  status: number;
  noCandidates: number;
};

function summarizeMovieSkips(skips: MovieSkipCounts): string {
  const parts: string[] = [];
  if (skips.have) parts.push(`${skips.have} already-have`);
  if (skips.paused) parts.push(`${skips.paused} paused`);
  if (skips.downloading) parts.push(`${skips.downloading} already downloading`);
  if (skips.status) parts.push(`${skips.status} other status`);
  if (skips.noCandidates) parts.push(`${skips.noCandidates} no candidates`);
  return parts.length ? parts.join(', ') : 'none';
}

export async function huntMoviesCore(input: HuntMoviesInput): Promise<HuntResult> {
  const settings = input.settings;
  const force = !!input.force;
  const allowUpgrade = !!input.allowUpgrade;
  const logs: HuntLogLine[] = [];
  const intents: HuntDownloadIntent[] = [];
  const active = new Set(input.activeMovieIds || []);
  const triedMap = input.triedTorrents || {};
  const sourceIds = enabledTorrentSourceIds(settings);
  const skips: MovieSkipCounts = {
    paused: 0,
    downloading: 0,
    have: 0,
    status: 0,
    noCandidates: 0,
  };

  logs.push({
    level: 'info',
    category: 'hunt',
    message: `Movie upgrade hunt start: ${input.movies.length} movie(s)`,
    meta: { sources: sourceIds.join(',') || '(none)' },
  });

  for (let i = 0; i < input.movies.length; i++) {
    const movie = input.movies[i];
    input.onProgress?.({
      phase: 'movies',
      current: i + 1,
      total: input.movies.length,
      label: movie.title,
    });

    if (!isMonitored(movie) && !force) {
      skips.paused += 1;
      continue;
    }
    if (active.has(movie.tmdbId)) {
      skips.downloading += 1;
      continue;
    }

    const preferred = (movie.preferredResolution ||
      settings.defaultMovieResolution ||
      settings.defaultResolution) as Resolution;
    const rules = buildQualityRules(settings, 'movie', preferred, null);
    const upgrade =
      allowUpgrade &&
      movie.status === 'downloaded' &&
      needsPreferredUpgrade(
        currentLibraryResolution(movie.localPath, movie.downloadedResolution),
        preferred
      );

    if (movie.status === 'downloaded' && !upgrade) {
      skips.have += 1;
      continue;
    }
    if (movie.status !== 'missing' && movie.status !== 'downloaded' && !force) {
      skips.status += 1;
      continue;
    }

    try {
      const res = await searchMovieTorrents(
        settings,
        movie.title,
        movie.releaseYear,
        preferred
      );
      const triedKey = triedMovieKey(movie.tmdbId);
      const triedList = triedListFor(triedMap, triedKey);
      const pool = filterResultsSkippingTried(res.results, triedList);
      const triedSkipped = (res.results?.length || 0) - pool.length;
      const best = upgrade
        ? pickUpgradeDownload(pool, preferred, 'movie', rules)
        : pickAutoDownload(pool, preferred, 'movie', rules);

      if (!best?.magnet) {
        skips.noCandidates += 1;
        continue;
      }

      const candidates = toHealthyPreferredCandidates(pool, preferred, 'movie', rules, upgrade);
      const choiceDescription = describeTorrentChoice(best, {
        preferred,
        upgrade,
        triedSkipped,
        healthyCount: candidates.length,
        mode: upgrade ? 'upgrade' : 'auto',
      });

      intents.push({
        kind: 'movie',
        magnet: best.magnet,
        infoHash: best.infoHash || extractInfoHash(best.magnet) || undefined,
        title: best.title || movie.title,
        resolution: best.resolution,
        seeders: best.seeders,
        source: best.source,
        upgrade,
        preferred,
        quality: rules,
        candidates,
        triedInfoHashes: triedList,
        movieId: movie.tmdbId,
        movieTitle: movie.title,
        releaseYear: movie.releaseYear,
        choiceDescription,
        resultCount: res.results?.length || 0,
        triedSkipped,
        sourcesHit: sourcesInResults(res.results),
        searchError: res.error || undefined,
      });
      active.add(movie.tmdbId);
    } catch (err) {
      logs.push({
        level: 'warn',
        category: 'hunt',
        message: `Movie upgrade check failed: ${movie.title}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  logs.push({
    level: 'info',
    category: 'hunt',
    message: `Movie upgrade hunt plan: ${intents.length} intent(s); skipped ${summarizeMovieSkips(skips)}`,
  });

  return { intents, logs };
}
