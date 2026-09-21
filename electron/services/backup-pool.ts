/**
 * Backup JSON serialize/parse + file I/O on a dedicated worker.
 */
import { Worker } from 'worker_threads';
import fs from 'fs';
import { resolveDistElectronAsset } from './asset-path';
import { activityLog } from './activity-log';

const WORKER_PATH = resolveDistElectronAsset('backup-worker.js');

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
let worker: Worker | null = null;
let ready = false;
let useWorker = true;
let nextId = 1;
const pending = new Map<number, Pending>();
let initPromise: Promise<void> | null = null;
let logged = false;

function note(using: boolean) {
  if (logged && using) return;
  if (using) { activityLog.info('backup', 'Backup export/import using dedicated worker'); logged = true; }
  else if (!logged) { activityLog.warn('backup', 'Backup worker unavailable — falling back to main process'); logged = true; }
}

async function ensure(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const w = new Worker(WORKER_PATH, { workerData: { workerId: 0 } });
      worker = w;
      w.on('message', (msg: any) => {
        if (msg?.type === 'ready') { ready = true; return; }
        if (typeof msg?.id === 'number') {
          const p = pending.get(msg.id);
          if (!p) return;
          pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.result ?? msg.bytes);
          else p.reject(new Error(msg.error || 'Backup worker failed'));
        }
      });
      w.on('error', () => { useWorker = false; note(false); });
      w.on('exit', (code) => { ready = false; worker = null; initPromise = null; if (code !== 0) { useWorker = false; note(false); } });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !ready) await new Promise((r) => setTimeout(r, 20));
      if (!ready) { try { await w.terminate(); } catch {} worker = null; useWorker = false; note(false); }
      else note(true);
    } catch { useWorker = false; worker = null; note(false); }
  })();
  return initPromise;
}

function run(payload: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!worker || !ready) { reject(new Error('Backup worker not ready')); return; }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...payload, id });
  });
}

export async function writeBackupJsonViaPool(filePath: string, data: unknown): Promise<void> {
  await ensure();
  if (!useWorker || !worker || !ready) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return;
  }
  try {
    await run({ op: 'writeJson', filePath, data });
  } catch {
    useWorker = false; note(false);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }
}

export async function readBackupJsonViaPool(filePath: string): Promise<unknown> {
  await ensure();
  if (!useWorker || !worker || !ready) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  try {
    return await run({ op: 'readJson', filePath });
  } catch {
    useWorker = false; note(false);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
}
