/**
 * Dedicated library refresh / folder-scan worker (worker_threads).
 * TVMaze fetch + local episode indexing run off Electron main so the UI stays responsive.
 * Does not host WebTorrent — downloads stay in torrent-utility.
 */
import { parentPort, workerData } from 'worker_threads';
import type { EpisodeOverrideStatus, Resolution, Show, Movie } from '../types';
import { fetchShowDetail, type EpisodeMetaMaps } from '../services/tvmaze';
import {
  buildScanPreview,
  type FolderScanPreview,
  type LibraryScanScope,
} from '../services/library-scan';
import { searchShows } from '../services/tvmaze-search';
import { searchMovies } from '../services/imdb';

export type LibraryWorkerRefreshRequest = {
  id: number;
  op: 'refreshAll';
  shows: Show[];
  libraryRoot: string;
  extraRoots: string[];
  downloadingKeys: string[];
  overrides: Record<string, EpisodeOverrideStatus>;
  resolutions: Record<string, Resolution>;
};

export type LibraryWorkerFetchShowsRequest = {
  id: number;
  op: 'fetchShows';
  items: Array<{ mazeId: number; existing?: Show; folderPath?: string }>;
  libraryRoot: string;
  extraRoots: string[];
  downloadingKeys: string[];
  overrides: Record<string, EpisodeOverrideStatus>;
  resolutions: Record<string, Resolution>;
};

export type LibraryWorkerScanPreviewRequest = {
  id: number;
  op: 'scanPreview';
  scope: LibraryScanScope;
  tvRoots: string[];
  movieRoots: string[];
  shows: Show[];
  movies: Movie[];
};

export type LibraryWorkerRequest =
  | LibraryWorkerRefreshRequest
  | LibraryWorkerFetchShowsRequest
  | LibraryWorkerScanPreviewRequest;

if (!parentPort) {
  throw new Error('library-worker must be run as a worker_threads Worker');
}

function metaFrom(msg: {
  overrides: Record<string, EpisodeOverrideStatus>;
  resolutions: Record<string, Resolution>;
}): EpisodeMetaMaps {
  return {
    overrides: msg.overrides || {},
    resolutions: msg.resolutions || {},
  };
}

async function runRefreshAll(msg: LibraryWorkerRefreshRequest): Promise<{
  failed: number;
  count: number;
}> {
  const downloading = new Set(msg.downloadingKeys || []);
  const meta = metaFrom(msg);
  let failed = 0;
  const total = msg.shows.length;
  // Stream each finished show to main — never return one mega-array (structured-clone freeze).
  const BATCH = 3;
  let batch: Show[] = [];
  const flushBatch = () => {
    if (!batch.length) return;
    parentPort!.postMessage({
      type: 'shows',
      id: msg.id,
      shows: batch,
    });
    batch = [];
  };
  for (let i = 0; i < msg.shows.length; i++) {
    const show = msg.shows[i];
    parentPort!.postMessage({
      type: 'progress',
      id: msg.id,
      phase: 'refresh',
      current: i + 1,
      total,
      label: show.name,
    });
    let detailed: Show = show;
    try {
      detailed = await fetchShowDetail(
        show.tmdbId,
        msg.libraryRoot,
        show,
        downloading,
        msg.extraRoots,
        meta
      );
    } catch (err) {
      failed += 1;
      parentPort!.postMessage({
        type: 'warn',
        id: msg.id,
        message: `Refresh failed: ${show.name}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    batch.push(detailed);
    if (batch.length >= BATCH) flushBatch();
  }
  flushBatch();
  return { failed, count: total };
}

async function runFetchShows(msg: LibraryWorkerFetchShowsRequest): Promise<{
  shows: Show[];
  failed: number;
  errors: string[];
}> {
  const downloading = new Set(msg.downloadingKeys || []);
  const meta = metaFrom(msg);
  const shows: Show[] = [];
  const errors: string[] = [];
  let failed = 0;
  const total = msg.items.length;
  for (let i = 0; i < msg.items.length; i++) {
    const item = msg.items[i];
    parentPort!.postMessage({
      type: 'progress',
      id: msg.id,
      phase: 'import',
      current: i + 1,
      total,
      label: item.existing?.name || `TV #${item.mazeId}`,
    });
    try {
      const existing = item.existing
        ? { ...item.existing, libraryPath: item.folderPath || item.existing.libraryPath }
        : item.folderPath
          ? ({
              id: item.mazeId,
              tmdbId: item.mazeId,
              name: '',
              overview: '',
              posterPath: null,
              backdropPath: null,
              firstAirDate: null,
              status: '',
              libraryPath: item.folderPath,
              seasons: [],
              addedAt: new Date().toISOString(),
            } as Show)
          : undefined;
      const detailed = await fetchShowDetail(
        item.mazeId,
        msg.libraryRoot,
        existing,
        downloading,
        msg.extraRoots,
        meta
      );
      shows.push({
        ...detailed,
        libraryPath: item.folderPath || detailed.libraryPath,
      });
    } catch (err) {
      failed += 1;
      errors.push(
        `show ${item.mazeId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return { shows, failed, errors };
}

async function runScanPreview(
  msg: LibraryWorkerScanPreviewRequest
): Promise<FolderScanPreview> {
  return buildScanPreview(
    msg.scope || 'both',
    msg.tvRoots || [],
    msg.movieRoots || [],
    msg.shows || [],
    msg.movies || [],
    (label) => {
      parentPort!.postMessage({
        type: 'progress',
        id: msg.id,
        phase: 'scan',
        current: 0,
        total: 0,
        label,
      });
    },
    { searchShows, searchMovies }
  );
}

parentPort.on('message', (msg: LibraryWorkerRequest) => {
  void (async () => {
    try {
      if (msg.op === 'refreshAll') {
        const result = await runRefreshAll(msg);
        parentPort!.postMessage({ id: msg.id, ok: true, result });
        return;
      }
      if (msg.op === 'fetchShows') {
        const result = await runFetchShows(msg);
        parentPort!.postMessage({ id: msg.id, ok: true, result });
        return;
      }
      if (msg.op === 'scanPreview') {
        const result = await runScanPreview(msg);
        parentPort!.postMessage({ id: msg.id, ok: true, result });
        return;
      }
      parentPort!.postMessage({
        id: (msg as { id: number }).id,
        ok: false,
        error: 'Unknown library op',
      });
    } catch (err) {
      parentPort!.postMessage({
        id: (msg as { id: number }).id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
});

parentPort.postMessage({ type: 'ready', workerId: workerData?.workerId ?? 0 });
