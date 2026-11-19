/**
 * Activity-log file I/O via dedicated worker. Main enqueues lines; falls back to sync fs.
 */
import fs from 'fs';
import path from 'path';
import { resolveDistElectronAsset } from './asset-path';
import { SingleWorkerClient, isWorkerTransportError } from './single-worker-client';

let dir = '';
let modeLogger: ((using: boolean) => void) | null = null;

const client = new SingleWorkerClient({
  name: 'log-writer-pool',
  workerPath: resolveDistElectronAsset('log-writer-worker.js'),
  readyTimeoutMs: 5000,
  onModeChange: (using) => {
    modeLogger?.(using);
  },
});

export function setLogWriterModeLogger(fn: (usingWorker: boolean) => void): void {
  modeLogger = fn;
}

export async function initLogWriter(logDir: string): Promise<{ usedWorker: boolean }> {
  dir = logDir;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  try {
    await client.run({ op: 'init', dir });
    return { usedWorker: true };
  } catch {
    return { usedWorker: false };
  }
}

export async function appendLogLines(day: string, lines: string[]): Promise<void> {
  if (!lines.length) return;
  if (client.isUsingWorker()) {
    try {
      await client.run({ op: 'append', day, lines });
      return;
    } catch (err) {
      if (!isWorkerTransportError(err)) {
        // Still try sync fallback so log lines are not lost on worker write error
      }
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
  if (client.isUsingWorker()) {
    try {
      return await client.run<{
        text: string;
        path: string;
        truncated: boolean;
        size: number;
      }>({ op: 'read', maxBytes });
    } catch {
      return null;
    }
  }
  return null;
}

export async function pruneLogWriter(): Promise<void> {
  if (client.isUsingWorker()) {
    try {
      await client.run({ op: 'prune' });
    } catch {
      // ignore
    }
  }
}

export function getLogWriterInfo(): { usingWorker: boolean } {
  return { usingWorker: client.isUsingWorker() };
}

export function destroyLogWriter(): Promise<void> {
  return client.destroy();
}
