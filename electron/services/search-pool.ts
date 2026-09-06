/**
 * Worker-thread pool for torrent search (fetch + merge/dedupe + resolution ranking).
 * Pool size = min(4, os.cpus().length). Falls back to in-process search if workers fail.
 */
import { Worker } from 'worker_threads';
import os from 'os';
import { resolveDistElectronAsset } from './asset-path';
import {
  searchEpisodeTorrents as searchEpisodeDirect,
  searchMovieTorrents as searchMovieDirect,
  mergeByInfoHash,
  rankResults,
  extractInfoHash,
} from './search';
import type { AppSettings, Resolution, SearchResult } from '../types';
import type { SearchEpisodeOpts } from './search';

const POOL_SIZE = Math.max(1, Math.min(4, os.cpus()?.length || 1));
const WORKER_PATH = resolveDistElectronAsset('search-worker.js');

type Pending = {
  resolve: (v: { results: SearchResult[]; query: string; error?: string }) => void;
  reject: (e: Error) => void;
};

type PooledWorker = {
  worker: Worker;
  busy: boolean;
  ready: boolean;
};

let pool: PooledWorker[] = [];
let nextId = 1;
const pending = new Map<number, Pending>();
let initPromise: Promise<void> | null = null;
let useWorkers = true;

function settle(id: number, ok: boolean, result?: { results: SearchResult[]; query: string; error?: string }, error?: string) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (ok && result) p.resolve(result);
  else p.reject(new Error(error || 'Search worker failed'));
}

function attachWorker(pw: PooledWorker): void {
  pw.worker.on('message', (msg: any) => {
    if (msg?.type === 'ready') {
      pw.ready = true;
      return;
    }
    pw.busy = false;
    if (typeof msg?.id === 'number') {
      settle(msg.id, !!msg.ok, msg.result, msg.error);
    }
    pump();
  });
  pw.worker.on('error', (err) => {
    pw.busy = false;
    // Reject all? leave pending; mark pool degraded
    console.error('[search-pool] worker error', err);
  });
  pw.worker.on('exit', (code) => {
    pw.busy = false;
    pw.ready = false;
    if (code !== 0) {
      console.error('[search-pool] worker exited', code);
    }
  });
}

async function ensurePool(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const created: PooledWorker[] = [];
      for (let i = 0; i < POOL_SIZE; i++) {
        const worker = new Worker(WORKER_PATH, { workerData: { workerId: i } });
        const pw: PooledWorker = { worker, busy: false, ready: false };
        attachWorker(pw);
        created.push(pw);
      }
      // Wait briefly for ready handshakes
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (created.every((w) => w.ready)) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      if (!created.some((w) => w.ready)) {
        for (const w of created) {
          try {
            await w.worker.terminate();
          } catch {
            // ignore
          }
        }
        useWorkers = false;
        pool = [];
        return;
      }
      pool = created;
      useWorkers = true;
    } catch (err) {
      console.error('[search-pool] init failed, using in-process search', err);
      useWorkers = false;
      pool = [];
    }
  })();
  return initPromise;
}

const waitQueue: Array<() => void> = [];

function pump(): void {
  while (waitQueue.length) {
    const idle = pool.find((w) => w.ready && !w.busy);
    if (!idle) return;
    const job = waitQueue.shift();
    if (job) job();
  }
}

function runOnPool(message: Record<string, unknown>): Promise<{ results: SearchResult[]; query: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });

    const trySend = () => {
      const idle = pool.find((w) => w.ready && !w.busy);
      if (!idle) {
        waitQueue.push(trySend);
        return;
      }
      idle.busy = true;
      idle.worker.postMessage({ ...message, id });
    };

    trySend();
  });
}

export async function searchEpisodeTorrents(
  settings: AppSettings,
  showName: string,
  season: number,
  episode: number,
  preferred: Resolution,
  opts: SearchEpisodeOpts = {}
): Promise<{ results: SearchResult[]; query: string; error?: string }> {
  await ensurePool();
  if (!useWorkers || pool.length === 0) {
    return searchEpisodeDirect(settings, showName, season, episode, preferred, opts);
  }
  try {
    return await runOnPool({
      op: 'episode',
      settings,
      showName,
      season,
      episode,
      preferred,
      opts,
    });
  } catch {
    return searchEpisodeDirect(settings, showName, season, episode, preferred, opts);
  }
}

export async function searchMovieTorrents(
  settings: AppSettings,
  title: string,
  year: number | null | undefined,
  preferred: Resolution
): Promise<{ results: SearchResult[]; query: string; error?: string }> {
  await ensurePool();
  if (!useWorkers || pool.length === 0) {
    return searchMovieDirect(settings, title, year, preferred);
  }
  try {
    return await runOnPool({
      op: 'movie',
      settings,
      title,
      year,
      preferred,
    });
  } catch {
    return searchMovieDirect(settings, title, year, preferred);
  }
}

/** CPU-only merge + rank on a worker (used when groups are already fetched). */
export async function rankMergedResults(
  groups: SearchResult[][],
  preferred: Resolution
): Promise<SearchResult[]> {
  await ensurePool();
  if (!useWorkers || pool.length === 0) {
    return rankResults(mergeByInfoHash(groups), preferred);
  }
  try {
    const res = await runOnPool({ op: 'rank', groups, preferred });
    return res.results;
  } catch {
    return rankResults(mergeByInfoHash(groups), preferred);
  }
}

export function getSearchPoolInfo(): { size: number; usingWorkers: boolean; cpus: number } {
  return {
    size: pool.length || (useWorkers ? POOL_SIZE : 0),
    usingWorkers: useWorkers && pool.length > 0,
    cpus: os.cpus()?.length || 1,
  };
}

export async function destroySearchPool(): Promise<void> {
  const workers = [...pool];
  pool = [];
  for (const pw of workers) {
    try {
      await pw.worker.terminate();
    } catch {
      // ignore
    }
  }
  for (const [id, p] of pending) {
    pending.delete(id);
    p.reject(new Error('Search pool destroyed'));
  }
}

export { extractInfoHash };
