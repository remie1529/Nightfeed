import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { app, nativeImage, net } from 'electron';

const MAX_CONCURRENT_DOWNLOADS = 8;
const FETCH_TIMEOUT_MS = 12_000;
const RESIZE_THRESHOLD_BYTES = 350_000;
const MAX_CACHED_WIDTH = 640;
const TARGET_RESIZE_WIDTH = 420;

const inFlight = new Map<string, Promise<string>>();
let activeDownloads = 0;
const waitQueue: Array<() => void> = [];
let dirReady: Promise<void> | null = null;

function acquireDownloadSlot(): Promise<void> {
  if (activeDownloads < MAX_CONCURRENT_DOWNLOADS) {
    activeDownloads += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waitQueue.push(() => {
      activeDownloads += 1;
      resolve();
    });
  });
}

function releaseDownloadSlot(): void {
  activeDownloads = Math.max(0, activeDownloads - 1);
  const next = waitQueue.shift();
  if (next) next();
}

export function posterCacheDir(): string {
  return path.join(app.getPath('userData'), 'poster-cache');
}

function extFromUrl(url: string): string {
  const m = url.split('?')[0].match(/\.(jpg|jpeg|png|webp|gif)$/i);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
}

function keyFor(url: string): string {
  const hash = crypto.createHash('sha1').update(url).digest('hex');
  return `${hash}.${extFromUrl(url)}`;
}

export function cachedPosterFile(url: string): string {
  return path.join(posterCacheDir(), keyFor(url));
}

export function nfimgForFile(filename: string): string {
  return `nfimg://cache/${encodeURIComponent(path.basename(filename))}`;
}

export function resolveNfimgFile(requestUrl: string): string | null {
  try {
    const u = new URL(requestUrl);
    const name = decodeURIComponent((u.pathname || u.hostname || '').replace(/^\//, ''));
    if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) return null;
    return path.join(posterCacheDir(), name);
  } catch {
    return null;
  }
}

function ensureCacheDir(): Promise<void> {
  if (!dirReady) {
    dirReady = fsp.mkdir(posterCacheDir(), { recursive: true }).then(() => undefined);
  }
  return dirReady;
}

function downscaleOversizedPoster(buf: Buffer): Buffer {
  if (buf.length <= RESIZE_THRESHOLD_BYTES) return buf;
  try {
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return buf;
    const { width } = img.getSize();
    if (!width || width <= MAX_CACHED_WIDTH) return buf;
    const resized = img.resize({ width: TARGET_RESIZE_WIDTH, quality: 'best' });
    const jpg = resized.toJPEG(85);
    return jpg.length > 40 && jpg.length < buf.length ? jpg : buf;
  } catch {
    return buf;
  }
}

export async function ensurePosterCached(url: string): Promise<string> {
  const raw = (url || '').trim();
  if (!raw || !/^https?:\/\//i.test(raw)) return raw;

  await ensureCacheDir();
  const dest = cachedPosterFile(raw);
  try {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 40) {
      return nfimgForFile(dest);
    }
  } catch {
    // download below
  }

  const existing = inFlight.get(raw);
  if (existing) return existing;

  const task = (async (): Promise<string> => {
    await acquireDownloadSlot();
    try {
      // Re-check disk in case an earlier queued task wrote it.
      try {
        if (fs.existsSync(dest) && fs.statSync(dest).size > 40) {
          return nfimgForFile(dest);
        }
      } catch {
        // continue
      }
      const res = await net.fetch(raw, {
        bypassCustomProtocolHandlers: true,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return raw;
      const rawBuf = Buffer.from(await res.arrayBuffer());
      if (rawBuf.length < 40) return raw;
      const finalBuf = downscaleOversizedPoster(rawBuf);
      await fsp.writeFile(dest, finalBuf);
      return nfimgForFile(dest);
    } catch {
      return raw;
    } finally {
      releaseDownloadSlot();
    }
  })().finally(() => {
    if (inFlight.get(raw) === task) inFlight.delete(raw);
  });

  inFlight.set(raw, task);
  return task;
}
