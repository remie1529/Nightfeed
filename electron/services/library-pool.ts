/**
 * Dedicated library refresh / folder-scan worker pool (single worker_threads Worker).
 * Falls back to in-process TVMaze + disk scan if the worker fails to start.
 */
import { Worker } from 'worker_threads';
import { resolveDistElectronAsset } from './asset-path';
import { fetchShowDetail, type EpisodeMetaMaps } from './tvmaze';
import {
  buildScanPreview,
  type FolderScanPreview,
  type LibraryScanScope,
} from './library-scan';
import { searchShowsMeta, searchMoviesMeta } from './metadata-pool';
import type { EpisodeOverrideStatus, Movie, Resolution, Show } from '../types';
import { activityLog } from './activity-log';

const WORKER_PATH = resolveDistElectronAsset('library-worker.js');

export type LibraryRefreshProgress = {
  phase: 'refresh' | 'import' | 'scan';
  current: number;
  total: number;
  label?: string;
};

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (p: LibraryRefreshProgress) => void;
  onWarn?: (message: string) => void;
  onShows?: (shows: Show[]) => void | Promise<void>;
  showChain?: Promise<void>;
};

let worker: Worker | null = null;
let ready = false;
let useWorker = true;
let nextId = 1;
const pending = new Map<number, Pending>();
let initPromise: Promise<void> | null = null;
let loggedMode = false;
let fallbackLogged = false;

function noteMode(usingWorker: boolean): void {
  if (loggedMode && !(usingWorker === false && !fallbackLogged)) return;
  if (usingWorker) {
    activityLog.info('library', 'Library refresh/scan using dedicated worker');
    loggedMode = true;
  } else if (!fallbackLogged) {
    activityLog.warn(
      'library',
      'Library worker unavailable — refresh/scan falling back to main process'
    );
    fallbackLogged = true;
    loggedMode = true;
  }
}

function settle(id: number, ok: boolean, result?: unknown, error?: string) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (ok) p.resolve(result);
  else p.reject(new Error(error || 'Library worker failed'));
}

async function ensureWorker(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const w = new Worker(WORKER_PATH, { workerData: { workerId: 0 } });
      worker = w;
      w.on('message', (msg: any) => {
        if (msg?.type === 'ready') {
          ready = true;
          return;
        }
        if (msg?.type === 'progress') {
          const p = pending.get(msg.id);
          p?.onProgress?.({
            phase: msg.phase || 'refresh',
            current: msg.current || 0,
            total: msg.total || 0,
            label: msg.label,
          });
          return;
        }
        if (msg?.type === 'warn') {
          const p = pending.get(msg.id);
          if (msg.message) p?.onWarn?.(String(msg.message));
          return;
        }
        if (msg?.type === 'shows') {
          const p = pending.get(msg.id);
          if (p?.onShows && Array.isArray(msg.shows)) {
            const batch = msg.shows as Show[];
            p.showChain = (p.showChain || Promise.resolve())
              .then(() => p.onShows!(batch))
              .catch((err) => {
                console.error('[library-pool] onShows handler failed', err);
              });
          }
          return;
        }
        if (typeof msg?.id === 'number') {
          const p = pending.get(msg.id);
          const finish = () => settle(msg.id, !!msg.ok, msg.result, msg.error);
          if (p?.showChain) {
            p.showChain.then(finish).catch(finish);
          } else {
            finish();
          }
        }
      });
      w.on('error', (err) => {
        console.error('[library-pool] worker error', err);
        useWorker = false;
        noteMode(false);
        for (const [id, p] of pending) {
          pending.delete(id);
          p.reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      w.on('exit', (code) => {
        ready = false;
        worker = null;
        if (code !== 0) {
          console.error('[library-pool] worker exited', code);
          useWorker = false;
          noteMode(false);
        }
        // Allow re-init on next job
        initPromise = null;
      });
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (ready) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      if (!ready) {
        try {
          await w.terminate();
        } catch {
          // ignore
        }
        worker = null;
        useWorker = false;
        noteMode(false);
      } else {
        noteMode(true);
      }
    } catch (err) {
      console.error('[library-pool] init failed, using in-process library refresh', err);
      useWorker = false;
      worker = null;
      noteMode(false);
    }
  })();
  return initPromise;
}

function runOnWorker(
  payload: Record<string, unknown>,
  onProgress?: (p: LibraryRefreshProgress) => void,
  onWarn?: (message: string) => void,
  onShows?: (shows: Show[]) => void | Promise<void>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!worker || !ready) {
      reject(new Error('Library worker not ready'));
      return;
    }
    const id = nextId++;
    pending.set(id, {
      resolve,
      reject,
      onProgress,
      onWarn,
      onShows,
      showChain: Promise.resolve(),
    });
    worker.postMessage({ ...payload, id });
  });
}

export type RefreshAllInput = {
  shows: Show[];
  libraryRoot: string;
  extraRoots: string[];
  downloadingKeys: string[];
  overrides: Record<string, EpisodeOverrideStatus>;
  resolutions: Record<string, Resolution>;
  onProgress?: (p: LibraryRefreshProgress) => void;
  onWarn?: (message: string) => void;
  /** Called with small batches of refreshed shows as the worker finishes them. */
  onShows?: (shows: Show[]) => void | Promise<void>;
};

export type RefreshAllResult = { shows: Show[]; failed: number; usedWorker: boolean; streamed?: boolean };

async function refreshAllInProcess(input: RefreshAllInput): Promise<RefreshAllResult> {
  const downloading = new Set(input.downloadingKeys || []);
  const meta: EpisodeMetaMaps = {
    overrides: input.overrides || {},
    resolutions: input.resolutions || {},
  };
  const updated: Show[] = [];
  let failed = 0;
  const total = input.shows.length;
  const stream = !!input.onShows;
  for (let i = 0; i < input.shows.length; i++) {
    const show = input.shows[i];
    input.onProgress?.({
      phase: 'refresh',
      current: i + 1,
      total,
      label: show.name,
    });
    let detailed: Show = show;
    try {
      detailed = await fetchShowDetail(
        show.tmdbId,
        input.libraryRoot,
        show,
        downloading,
        input.extraRoots,
        meta
      );
    } catch (err) {
      failed += 1;
      input.onWarn?.(
        `Refresh failed: ${show.name}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (stream) {
      await input.onShows!([detailed]);
    } else {
      updated.push(detailed);
    }
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  return { shows: updated, failed, usedWorker: false, streamed: stream };
}

export async function refreshAllViaPool(input: RefreshAllInput): Promise<RefreshAllResult> {
  await ensureWorker();
  if (!useWorker || !worker || !ready) {
    noteMode(false);
    return refreshAllInProcess(input);
  }
  try {
    // Slim outbound clone: worker only needs shell fields (seasons rebuilt from TVMaze).
    const slimShows = input.shows.map((s) => ({
      ...s,
      seasons: [] as Show['seasons'],
      overview: '',
    }));
    const stream = !!input.onShows;
    const result = (await runOnWorker(
      {
        op: 'refreshAll',
        shows: slimShows,
        libraryRoot: input.libraryRoot,
        extraRoots: input.extraRoots,
        downloadingKeys: input.downloadingKeys,
        overrides: input.overrides,
        resolutions: input.resolutions,
      },
      input.onProgress,
      input.onWarn,
      input.onShows
    )) as { shows?: Show[]; failed: number; count?: number };
    return {
      shows: stream ? [] : result.shows || [],
      failed: result.failed || 0,
      usedWorker: true,
      streamed: stream,
    };
  } catch (err) {
    console.error('[library-pool] refreshAll worker failed, falling back', err);
    useWorker = false;
    noteMode(false);
    return refreshAllInProcess(input);
  }
}

export type FetchShowsInput = {
  items: Array<{ mazeId: number; existing?: Show; folderPath?: string }>;
  libraryRoot: string;
  extraRoots: string[];
  downloadingKeys: string[];
  overrides: Record<string, EpisodeOverrideStatus>;
  resolutions: Record<string, Resolution>;
  onProgress?: (p: LibraryRefreshProgress) => void;
};

export type FetchShowsResult = {
  shows: Show[];
  failed: number;
  errors: string[];
  usedWorker: boolean;
};

export async function fetchShowsViaPool(input: FetchShowsInput): Promise<FetchShowsResult> {
  await ensureWorker();
  if (!useWorker || !worker || !ready) {
    noteMode(false);
    const downloading = new Set(input.downloadingKeys || []);
    const meta: EpisodeMetaMaps = {
      overrides: input.overrides || {},
      resolutions: input.resolutions || {},
    };
    const shows: Show[] = [];
    const errors: string[] = [];
    let failed = 0;
    for (let i = 0; i < input.items.length; i++) {
      const item = input.items[i];
      input.onProgress?.({
        phase: 'import',
        current: i + 1,
        total: input.items.length,
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
          input.libraryRoot,
          existing,
          downloading,
          input.extraRoots,
          meta
        );
        shows.push({ ...detailed, libraryPath: item.folderPath || detailed.libraryPath });
      } catch (err) {
        failed += 1;
        errors.push(
          `show ${item.mazeId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    return { shows, failed, errors, usedWorker: false };
  }
  try {
    const result = (await runOnWorker(
      {
        op: 'fetchShows',
        items: input.items,
        libraryRoot: input.libraryRoot,
        extraRoots: input.extraRoots,
        downloadingKeys: input.downloadingKeys,
        overrides: input.overrides,
        resolutions: input.resolutions,
      },
      input.onProgress
    )) as { shows: Show[]; failed: number; errors: string[] };
    return {
      shows: result.shows || [],
      failed: result.failed || 0,
      errors: result.errors || [],
      usedWorker: true,
    };
  } catch (err) {
    console.error('[library-pool] fetchShows worker failed, falling back', err);
    useWorker = false;
    noteMode(false);
    // Re-enter: useWorker is false so the in-process branch runs.
    return fetchShowsViaPool({ ...input });
  }
}

export type ScanPreviewInput = {
  scope: LibraryScanScope;
  tvRoots: string[];
  movieRoots: string[];
  shows: Show[];
  movies: Movie[];
  onProgress?: (p: LibraryRefreshProgress) => void;
};

export async function scanPreviewViaPool(
  input: ScanPreviewInput
): Promise<{ preview: FolderScanPreview; usedWorker: boolean }> {
  await ensureWorker();
  if (!useWorker || !worker || !ready) {
    noteMode(false);
    const preview = await buildScanPreview(
      input.scope,
      input.tvRoots,
      input.movieRoots,
      input.shows,
      input.movies,
      (label) => input.onProgress?.({ phase: 'scan', current: 0, total: 0, label }),
      { searchShows: searchShowsMeta, searchMovies: searchMoviesMeta }
    );
    return { preview, usedWorker: false };
  }
  try {
    const preview = (await runOnWorker(
      {
        op: 'scanPreview',
        scope: input.scope,
        tvRoots: input.tvRoots,
        movieRoots: input.movieRoots,
        shows: input.shows,
        movies: input.movies,
      },
      input.onProgress
    )) as FolderScanPreview;
    return { preview, usedWorker: true };
  } catch (err) {
    console.error('[library-pool] scanPreview worker failed, falling back', err);
    useWorker = false;
    noteMode(false);
    return scanPreviewViaPool(input);
  }
}

export function getLibraryPoolInfo(): { usingWorker: boolean } {
  return { usingWorker: useWorker && !!worker && ready };
}

export async function destroyLibraryPool(): Promise<void> {
  const w = worker;
  worker = null;
  ready = false;
  if (w) {
    try {
      await w.terminate();
    } catch {
      // ignore
    }
  }
  for (const [id, p] of pending) {
    pending.delete(id);
    p.reject(new Error('Library pool destroyed'));
  }
}
