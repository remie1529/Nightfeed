/**
 * Dedicated auto-hunt worker pool (single worker_threads Worker).
 * Falls back to in-process hunt-core if the worker fails to start.
 */
import { Worker } from 'worker_threads';
import { resolveDistElectronAsset } from './asset-path';
import {
  huntMoviesCore,
  huntShowsCore,
  type HuntDownloadIntent,
  type HuntLogLine,
  type HuntMoviesInput,
  type HuntProgress,
  type HuntShowsInput,
} from './hunt-core';
import { activityLog } from './activity-log';

const WORKER_PATH = resolveDistElectronAsset('hunt-worker.js');

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (p: HuntProgress) => void;
  onLog?: (line: HuntLogLine) => void;
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
    activityLog.info('hunt', 'Auto hunt using dedicated worker');
    loggedMode = true;
  } else if (!fallbackLogged) {
    activityLog.warn(
      'hunt',
      'Hunt worker unavailable — auto hunt falling back to main process'
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
  else p.reject(new Error(error || 'Hunt worker failed'));
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
          const pend = pending.get(msg.id);
          pend?.onProgress?.({
            phase: msg.phase || 'hunt',
            current: msg.current || 0,
            total: msg.total || 0,
            label: msg.label,
          });
          return;
        }
        if (msg?.type === 'log') {
          const pend = pending.get(msg.id);
          if (msg.line) pend?.onLog?.(msg.line as HuntLogLine);
          return;
        }
        if (msg?.type === 'logBatch') {
          const pend = pending.get(msg.id);
          if (Array.isArray(msg.lines)) {
            for (const line of msg.lines) pend?.onLog?.(line as HuntLogLine);
          }
          return;
        }
        if (typeof msg?.id === 'number') {
          settle(msg.id, !!msg.ok, msg.result, msg.error);
        }
      });
      w.on('error', (err) => {
        console.error('[hunt-pool] worker error', err);
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
          console.error('[hunt-pool] worker exited', code);
          useWorker = false;
          noteMode(false);
        }
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
      console.error('[hunt-pool] init failed, using in-process hunt', err);
      useWorker = false;
      worker = null;
      noteMode(false);
    }
  })();
  return initPromise;
}

function runOnWorker(
  payload: Record<string, unknown>,
  onProgress?: (p: HuntProgress) => void,
  onLog?: (line: HuntLogLine) => void
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!worker || !ready) {
      reject(new Error('Hunt worker not ready'));
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve, reject, onProgress, onLog });
    worker.postMessage({ ...payload, id });
  });
}

export type HuntPoolResult = {
  intents: HuntDownloadIntent[];
  logs: HuntLogLine[];
  usedWorker: boolean;
};

export async function huntShowsViaPool(
  input: HuntShowsInput
): Promise<HuntPoolResult> {
  await ensureWorker();
  if (!useWorker || !worker || !ready) {
    noteMode(false);
    const result = await huntShowsCore(input);
    return { ...result, usedWorker: false };
  }
  try {
    let streamed = false;
    const result = (await runOnWorker(
      {
        op: 'huntShows',
        shows: input.shows,
        settings: input.settings,
        force: input.force,
        overrides: input.overrides,
        triedTorrents: input.triedTorrents,
        activeEpisodeKeys: input.activeEpisodeKeys,
      },
      input.onProgress,
      (line) => {
        streamed = true;
        input.onLog?.(line);
      }
    )) as { intents: HuntDownloadIntent[]; logs: HuntLogLine[] };
    return {
      intents: result.intents || [],
      // Avoid double-apply when lines were streamed live
      logs: streamed ? [] : result.logs || [],
      usedWorker: true,
    };
  } catch (err) {
    console.error('[hunt-pool] huntShows worker failed, falling back', err);
    useWorker = false;
    noteMode(false);
    const result = await huntShowsCore(input);
    return { ...result, usedWorker: false };
  }
}

export async function huntMoviesViaPool(
  input: HuntMoviesInput
): Promise<HuntPoolResult> {
  await ensureWorker();
  if (!useWorker || !worker || !ready) {
    noteMode(false);
    const result = await huntMoviesCore(input);
    return { ...result, usedWorker: false };
  }
  try {
    let streamed = false;
    const result = (await runOnWorker(
      {
        op: 'huntMovies',
        movies: input.movies,
        settings: input.settings,
        allowUpgrade: input.allowUpgrade,
        force: input.force,
        triedTorrents: input.triedTorrents,
        activeMovieIds: input.activeMovieIds,
      },
      input.onProgress,
      (line) => {
        streamed = true;
        input.onLog?.(line);
      }
    )) as { intents: HuntDownloadIntent[]; logs: HuntLogLine[] };
    return {
      intents: result.intents || [],
      logs: streamed ? [] : result.logs || [],
      usedWorker: true,
    };
  } catch (err) {
    console.error('[hunt-pool] huntMovies worker failed, falling back', err);
    useWorker = false;
    noteMode(false);
    const result = await huntMoviesCore(input);
    return { ...result, usedWorker: false };
  }
}

export function getHuntPoolInfo(): { usingWorker: boolean } {
  return { usingWorker: useWorker && !!worker && ready };
}

export async function destroyHuntPool(): Promise<void> {
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
    p.reject(new Error('Hunt pool destroyed'));
  }
}
