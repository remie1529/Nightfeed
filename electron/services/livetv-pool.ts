/**
 * Live TV refresh via dedicated worker; falls back to in-process refreshLiveTvCore.
 */
import { Worker } from 'worker_threads';
import { resolveDistElectronAsset } from './asset-path';
import { activityLog } from './activity-log';
import {
  refreshLiveTvCore,
  type LiveTvRefreshInput,
  type LiveTvRefreshOutput,
} from './livetv-refresh-core';

const WORKER_PATH = resolveDistElectronAsset('livetv-worker.js');

type Pending = {
  resolve: (v: LiveTvRefreshOutput) => void;
  reject: (e: Error) => void;
};

let worker: Worker | null = null;
let ready = false;
let useWorker = true;
let nextId = 1;
const pending = new Map<number, Pending>();
let initPromise: Promise<void> | null = null;
let logged = false;

function note(using: boolean) {
  if (logged && using) return;
  if (using) {
    activityLog.info('livetv', 'Live TV refresh using dedicated worker');
    logged = true;
  } else if (!logged) {
    activityLog.warn('livetv', 'Live TV worker unavailable — refresh falling back to main process');
    logged = true;
  }
}

async function ensure(): Promise<void> {
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
        if (typeof msg?.id === 'number') {
          const p = pending.get(msg.id);
          if (!p) return;
          pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.result as LiveTvRefreshOutput);
          else p.reject(new Error(msg.error || 'Live TV worker failed'));
        }
      });
      w.on('error', () => {
        useWorker = false;
        note(false);
      });
      w.on('exit', (code) => {
        ready = false;
        worker = null;
        initPromise = null;
        if (code !== 0) {
          useWorker = false;
          note(false);
        }
      });
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !ready) await new Promise((r) => setTimeout(r, 25));
      if (!ready) {
        try {
          await w.terminate();
        } catch {
          // ignore
        }
        worker = null;
        useWorker = false;
        note(false);
      } else note(true);
    } catch {
      useWorker = false;
      worker = null;
      note(false);
    }
  })();
  return initPromise;
}

export async function refreshLiveTvViaPool(
  input: LiveTvRefreshInput
): Promise<LiveTvRefreshOutput & { usedWorker: boolean }> {
  await ensure();
  if (!useWorker || !worker || !ready) {
    note(false);
    const result = await refreshLiveTvCore(input);
    return { ...result, usedWorker: false };
  }
  try {
    const result = await new Promise<LiveTvRefreshOutput>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker!.postMessage({
        id,
        op: 'refresh',
        settings: input.settings,
        existing: input.existing,
      });
    });
    return { ...result, usedWorker: true };
  } catch (err) {
    console.error('[livetv-pool] worker failed, falling back', err);
    useWorker = false;
    note(false);
    const result = await refreshLiveTvCore(input);
    return { ...result, usedWorker: false };
  }
}
