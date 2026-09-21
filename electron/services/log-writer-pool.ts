/**
 * Activity-log file I/O via dedicated worker. Main enqueues lines; falls back to sync fs.
 */
import { Worker } from 'worker_threads';
import fs from 'fs';
import path from 'path';
import { resolveDistElectronAsset } from './asset-path';

const WORKER_PATH = resolveDistElectronAsset('log-writer-worker.js');

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
let ready = false;
let useWorker = true;
let nextId = 1;
const pending = new Map<number, Pending>();
let initPromise: Promise<void> | null = null;
let dir = '';
let loggedMode = false;
let fallbackLogged = false;
let modeLogger: ((using: boolean) => void) | null = null;

export function setLogWriterModeLogger(fn: (usingWorker: boolean) => void): void {
  modeLogger = fn;
}

function noteMode(usingWorker: boolean): void {
  if (loggedMode && !(usingWorker === false && !fallbackLogged)) return;
  modeLogger?.(usingWorker);
  if (usingWorker) loggedMode = true;
  else if (!fallbackLogged) {
    fallbackLogged = true;
    loggedMode = true;
  }
}

function settle(id: number, ok: boolean, result?: unknown, error?: string) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (ok) p.resolve(result);
  else p.reject(new Error(error || 'Log writer failed'));
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
        if (typeof msg?.id === 'number') settle(msg.id, !!msg.ok, msg.result, msg.error);
      });
      w.on('error', (err) => {
        console.error('[log-writer-pool] error', err);
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
          useWorker = false;
          noteMode(false);
        }
        initPromise = null;
      });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (ready) break;
        await new Promise((r) => setTimeout(r, 20));
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
      console.error('[log-writer-pool] init failed', err);
      useWorker = false;
      worker = null;
      noteMode(false);
    }
  })();
  return initPromise;
}

function run(payload: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!worker || !ready) {
      reject(new Error('Log writer not ready'));
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...payload, id });
  });
}

export async function initLogWriter(logDir: string): Promise<{ usedWorker: boolean }> {
  dir = logDir;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  await ensureWorker();
  if (!useWorker || !worker || !ready) {
    noteMode(false);
    return { usedWorker: false };
  }
  try {
    await run({ op: 'init', dir });
    return { usedWorker: true };
  } catch {
    useWorker = false;
    noteMode(false);
    return { usedWorker: false };
  }
}

export async function appendLogLines(day: string, lines: string[]): Promise<void> {
  if (!lines.length) return;
  if (useWorker && worker && ready) {
    try {
      await run({ op: 'append', day, lines });
      return;
    } catch {
      useWorker = false;
      noteMode(false);
    }
  }
  // sync fallback
  try {
    if (!dir) return;
    const file = path.join(dir, `nightfeed-${day}.log`);
    fs.appendFileSync(file, lines.join(''), 'utf8');
  } catch {
    // ignore
  }
}

export async function readLogAll(maxBytes?: number): Promise<{
  text: string;
  path: string;
  truncated: boolean;
  size: number;
} | null> {
  if (useWorker && worker && ready) {
    try {
      return (await run({ op: 'read', maxBytes })) as any;
    } catch {
      useWorker = false;
      noteMode(false);
    }
  }
  return null;
}

export async function pruneLogWriter(): Promise<void> {
  if (useWorker && worker && ready) {
    try {
      await run({ op: 'prune' });
    } catch {
      // ignore
    }
  }
}

export function getLogWriterInfo(): { usingWorker: boolean } {
  return { usingWorker: useWorker && !!worker && ready };
}

export async function destroyLogWriter(): Promise<void> {
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
}
