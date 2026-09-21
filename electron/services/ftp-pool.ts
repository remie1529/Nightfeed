/**
 * FTP upload via dedicated worker; falls back to in-process uploadFinishedFile.
 */
import { Worker } from 'worker_threads';
import { resolveDistElectronAsset } from './asset-path';
import { uploadFinishedFile } from './ftp';
import { activityLog } from './activity-log';
import type { AppSettings } from '../types';

const WORKER_PATH = resolveDistElectronAsset('ftp-worker.js');

type Pending = { resolve: () => void; reject: (e: Error) => void };
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
    activityLog.info('ftp', 'FTP uploads using dedicated worker');
    logged = true;
  } else if (!logged) {
    activityLog.warn('ftp', 'FTP worker unavailable — uploads falling back to main process');
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
          if (msg.ok) p.resolve();
          else p.reject(new Error(msg.error || 'FTP worker failed'));
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
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !ready) await new Promise((r) => setTimeout(r, 20));
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

export async function uploadViaPool(settings: AppSettings, localPath: string): Promise<void> {
  if (!settings.ftpEnabled) return;
  await ensure();
  if (!useWorker || !worker || !ready) {
    await uploadFinishedFile(settings, localPath);
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker!.postMessage({
        id,
        op: 'upload',
        host: settings.ftpHost,
        port: settings.ftpPort,
        user: settings.ftpUser,
        password: settings.ftpPassword,
        remoteBase: settings.ftpRemoteBasePath,
        localPath,
      });
    });
  } catch {
    useWorker = false;
    note(false);
    await uploadFinishedFile(settings, localPath);
  }
}
