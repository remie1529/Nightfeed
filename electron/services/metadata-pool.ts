/**
 * Dedicated worker for TVMaze / IMDb library search so main-thread download
 * persistence and progress IPC never starve the zoekfunctie.
 */
import { Worker } from 'worker_threads';
import { resolveDistElectronAsset } from './asset-path';
import { searchShows as searchShowsDirect, type MazeSearchItem } from './tvmaze-search';
import { searchMovies as searchMoviesDirect, type MovieSearchItem } from './imdb';

const WORKER_PATH = resolveDistElectronAsset('metadata-worker.js');

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

let worker: Worker | null = null;
let ready = false;
let useWorker = true;
let nextId = 1;
const pending = new Map<number, Pending>();
let initPromise: Promise<void> | null = null;
const waitQueue: Array<() => void> = [];
let busy = false;

function settle(id: number, ok: boolean, results?: unknown, error?: string) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (ok) p.resolve(results);
  else p.reject(new Error(error || 'Metadata worker failed'));
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
        busy = false;
        if (typeof msg?.id === 'number') {
          settle(msg.id, !!msg.ok, msg.results, msg.error);
        }
        pump();
      });
      w.on('error', (err) => {
        console.error('[metadata-pool] worker error', err);
        busy = false;
        useWorker = false;
      });
      w.on('exit', (code) => {
        ready = false;
        worker = null;
        busy = false;
        if (code !== 0) {
          console.error('[metadata-pool] worker exited', code);
          useWorker = false;
        }
      });
      const deadline = Date.now() + 5000;
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
      }
    } catch (err) {
      console.error('[metadata-pool] init failed, using in-process metadata search', err);
      useWorker = false;
      worker = null;
    }
  })();
  return initPromise;
}

function pump(): void {
  while (waitQueue.length) {
    if (busy || !ready || !worker) return;
    const job = waitQueue.shift();
    if (job) job();
  }
}

function runOnWorker(op: 'shows' | 'movies', query: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const trySend = () => {
      if (!worker || !ready) {
        waitQueue.push(trySend);
        return;
      }
      if (busy) {
        waitQueue.push(trySend);
        return;
      }
      busy = true;
      worker.postMessage({ id, op, query });
    };
    trySend();
  });
}

export async function searchShowsMeta(query: string): Promise<MazeSearchItem[]> {
  await ensureWorker();
  if (!useWorker || !worker || !ready) {
    return searchShowsDirect(query);
  }
  try {
    return (await runOnWorker('shows', query)) as MazeSearchItem[];
  } catch {
    return searchShowsDirect(query);
  }
}

export async function searchMoviesMeta(query: string): Promise<MovieSearchItem[]> {
  await ensureWorker();
  if (!useWorker || !worker || !ready) {
    return searchMoviesDirect(query);
  }
  try {
    return (await runOnWorker('movies', query)) as MovieSearchItem[];
  } catch {
    return searchMoviesDirect(query);
  }
}

export function getMetadataPoolInfo(): { usingWorker: boolean } {
  return { usingWorker: useWorker && !!worker && ready };
}

export async function destroyMetadataPool(): Promise<void> {
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
    p.reject(new Error('Metadata pool destroyed'));
  }
}
