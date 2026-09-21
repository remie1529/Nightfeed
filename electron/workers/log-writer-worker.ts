/**
 * Dedicated activity-log file I/O worker (worker_threads).
 * Main only enqueues formatted lines; this process appends/prunes/reads.
 */
import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';
import path from 'path';

const RETENTION_DAYS = 7;
const FILE_PREFIX = 'nightfeed-';
const FILE_SUFFIX = '.log';

type InitMsg = { id: number; op: 'init'; dir: string };
type AppendMsg = { id: number; op: 'append'; lines: string[]; day: string };
type ReadMsg = { id: number; op: 'read'; maxBytes?: number };
type PruneMsg = { id: number; op: 'prune' };
type Msg = InitMsg | AppendMsg | ReadMsg | PruneMsg;

let dir = '';
let currentDay = '';
let stream: fs.WriteStream | null = null;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseDayFromName(name: string): Date | null {
  const m = name.match(/^nightfeed-(\d{4})-(\d{2})-(\d{2})\.log$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function openDay(day: string): void {
  if (stream && currentDay === day && !stream.destroyed) return;
  try {
    stream?.end();
  } catch {
    // ignore
  }
  currentDay = day;
  const file = path.join(dir, `${FILE_PREFIX}${day}${FILE_SUFFIX}`);
  stream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
  stream.on('error', () => undefined);
}

function pruneOld(): void {
  if (!dir) return;
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      const day = parseDayFromName(name);
      if (!day) continue;
      if (day.getTime() < cutoff) {
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
}

function listFiles(): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => parseDayFromName(n))
      .sort()
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

function readAll(maxBytes = 2.5 * 1024 * 1024): {
  text: string;
  path: string;
  truncated: boolean;
  size: number;
} {
  pruneOld();
  const files = listFiles();
  let total = 0;
  for (const f of files) {
    try {
      total += fs.statSync(f).size;
    } catch {
      // ignore
    }
  }
  let truncated = false;
  let remaining = maxBytes;
  const chunks: string[] = [];
  for (let i = files.length - 1; i >= 0 && remaining > 0; i--) {
    const f = files[i];
    try {
      const buf = fs.readFileSync(f);
      if (buf.length <= remaining) {
        chunks.unshift(buf.toString('utf8'));
        remaining -= buf.length;
      } else {
        truncated = true;
        const slice = buf.subarray(buf.length - remaining);
        let text = slice.toString('utf8');
        const nl = text.indexOf('\n');
        if (nl >= 0 && nl < text.length - 1) text = text.slice(nl + 1);
        chunks.unshift(text);
        remaining = 0;
      }
    } catch {
      // ignore
    }
  }
  openDay(dayKey());
  return {
    text: chunks.join(''),
    path: path.join(dir, `${FILE_PREFIX}${currentDay}${FILE_SUFFIX}`),
    truncated: truncated || total > maxBytes,
    size: total,
  };
}

if (!parentPort) {
  throw new Error('log-writer-worker must run as worker_threads Worker');
}

parentPort.on('message', (msg: Msg) => {
  try {
    if (msg.op === 'init') {
      dir = msg.dir;
      fs.mkdirSync(dir, { recursive: true });
      openDay(dayKey());
      pruneOld();
      parentPort!.postMessage({ id: msg.id, ok: true });
      return;
    }
    if (msg.op === 'append') {
      if (!dir) throw new Error('log writer not initialized');
      openDay(msg.day || dayKey());
      const payload = (msg.lines || []).join('');
      if (payload) {
        if (stream && !stream.destroyed) stream.write(payload);
        else fs.appendFileSync(path.join(dir, `${FILE_PREFIX}${currentDay}${FILE_SUFFIX}`), payload, 'utf8');
      }
      parentPort!.postMessage({ id: msg.id, ok: true });
      return;
    }
    if (msg.op === 'read') {
      const result = readAll(msg.maxBytes);
      parentPort!.postMessage({ id: msg.id, ok: true, result });
      return;
    }
    if (msg.op === 'prune') {
      pruneOld();
      openDay(dayKey());
      parentPort!.postMessage({ id: msg.id, ok: true });
      return;
    }
    parentPort!.postMessage({ id: (msg as any).id, ok: false, error: 'Unknown log op' });
  } catch (err) {
    parentPort!.postMessage({
      id: (msg as any).id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

parentPort.postMessage({ type: 'ready', workerId: workerData?.workerId ?? 0 });
