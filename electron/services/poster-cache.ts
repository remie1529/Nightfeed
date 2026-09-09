import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { app, net } from 'electron';

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

export async function ensurePosterCached(url: string): Promise<string> {
  const raw = (url || '').trim();
  if (!raw) return raw;
  if (!/^https?:\/\//i.test(raw)) return raw;
  await fsp.mkdir(posterCacheDir(), { recursive: true });
  const dest = cachedPosterFile(raw);
  try {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 40) {
      return nfimgForFile(dest);
    }
  } catch {
    // download
  }
  try {
    const res = await net.fetch(raw, { bypassCustomProtocolHandlers: true });
    if (!res.ok) return raw;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 40) return raw;
    await fsp.writeFile(dest, buf);
    return nfimgForFile(dest);
  } catch {
    return raw;
  }
}
