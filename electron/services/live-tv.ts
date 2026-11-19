/**
 * IPTV → Plex Live TV: HDHomeRun-style tuner + XMLTV guide.
 * Does not bind sockets to the torrent VPN interface.
 */
import http from 'http';
import https from 'https';
import { spawn, execFile, execFileSync, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { app, nativeImage } from 'electron';
import type { AppSettings, LiveTvChannel, LiveTvEpgOption, LiveTvStatus } from '../types';
import { getLiveTvLineup, getLiveTvXmltvCache, getSettings, setLiveTvLineup, setLiveTvXmltvCache } from './store';
import { currentLibrarySlot, libraryScheduleNow } from './library-channel';
import { activityLog } from './activity-log';
import { refreshLiveTvViaPool } from './livetv-pool';
import { isAdult, parseM3u } from './livetv-refresh-core';
import { extractZipSafely } from './safe-unzip';

const insecureHttps = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const keepAliveHttp = new http.Agent({ keepAlive: true });

const FFMPEG_CANDIDATES = [
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe'),
];

type TunerSlot = {
  number: number;
  name: string;
  req: http.IncomingMessage;
  cleanup: () => void;
};

export function pickLanIpv4(): string | null {
  const preferred: string[] = [];
  const other: string[] = [];
  try {
    for (const [name, entries] of Object.entries(os.networkInterfaces())) {
      const n = name.toLowerCase();
      if (/tap|tun|openvpn|wintun|dco|tailscale|vethernet|loopback/.test(n)) continue;
      for (const e of entries || []) {
        if (!e || e.internal) continue;
        if (e.family !== 'IPv4' && (e.family as unknown) !== 4) continue;
        if (e.address.startsWith('192.168.')) preferred.push(e.address);
        else if (e.address.startsWith('10.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(e.address)) other.push(e.address);
      }
    }
  } catch {
    // ignore
  }
  return preferred[0] || other[0] || null;
}

function detectFfmpeg(explicit?: string): string | null {
  const bundled = path.join(app.getPath('userData'), 'ffmpeg', 'ffmpeg.exe');
  if (fs.existsSync(bundled)) return bundled;
  if (explicit && fs.existsSync(explicit)) return explicit;
  for (const p of FFMPEG_CANDIDATES) {
    if (p && fs.existsSync(p)) return p;
  }
  try {
    const out = execFileSync('where', ['ffmpeg'], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    const first = String(out).split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && fs.existsSync(first)) return first;
  } catch {
    // ignore
  }
  return null;
}

const FFMPEG_ZIP = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
let ffmpegInstall: Promise<string | null> | null = null;

function downloadToFile(url: string, dest: string, hops = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (hops > 6) {
      reject(new Error('Too many redirects while downloading ffmpeg'));
      return;
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      reject(new Error('Invalid ffmpeg download URL'));
      return;
    }
    if (parsedUrl.protocol !== 'https:') {
      reject(new Error('ffmpeg download must use HTTPS'));
      return;
    }
    const req = https.get(url, { headers: { 'User-Agent': 'Nightfeed' }, timeout: 60000 }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        let nextUrl: URL;
        try {
          nextUrl = new URL(res.headers.location, url);
        } catch {
          reject(new Error('Invalid redirect URL while downloading ffmpeg'));
          return;
        }
        if (nextUrl.protocol !== 'https:') {
          reject(new Error('Refused insecure HTTP redirect while downloading ffmpeg'));
          return;
        }
        downloadToFile(nextUrl.toString(), dest, hops + 1).then(resolve, reject);
        return;
      }
      if (code !== 200) {
        res.resume();
        reject(new Error(`ffmpeg download failed (HTTP ${code})`));
        return;
      }
      const file = fs.createWriteStream(dest);
      res.on('error', (err) => {
        file.destroy();
        reject(err);
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout downloading ffmpeg'));
    });
    req.on('error', reject);
  });
}

/** Download a Windows ffmpeg build into %AppData%\\Nightfeed\\ffmpeg if none is installed. */
async function ensureBundledProbe(dir: string): Promise<void> {
  const dest = path.join(dir, 'ffprobe.exe');
  if (fs.existsSync(dest)) return;
  const zip = path.join(dir, 'ffmpeg-essentials.zip');
  if (!fs.existsSync(zip)) return;
  const extract = path.join(dir, 'extract');
  try {
    await extractZipSafely(zip, extract, 180_000);
    const probe = findFile(extract, 'ffprobe.exe');
    if (probe) fs.copyFileSync(probe, dest);
  } catch {
    // probe stays missing; playback still works
  } finally {
    try {
      fs.rmSync(extract, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export function ensureFfmpeg(explicit?: string): Promise<string | null> {
  const found = detectFfmpeg(explicit);
  if (found) {
    const dir = path.join(app.getPath('userData'), 'ffmpeg');
    if (found === path.join(dir, 'ffmpeg.exe')) void ensureBundledProbe(dir);
    return Promise.resolve(found);
  }
  if (process.platform !== 'win32') return Promise.resolve(null);
  if (ffmpegInstall) return ffmpegInstall;
  ffmpegInstall = (async () => {
    const dir = path.join(app.getPath('userData'), 'ffmpeg');
    const zip = path.join(dir, 'ffmpeg-essentials.zip');
    const extract = path.join(dir, 'extract');
    fs.mkdirSync(dir, { recursive: true });
    try {
      await downloadToFile(FFMPEG_ZIP, zip);
      await extractZipSafely(zip, extract, 180_000);
      const exe = findFile(extract, 'ffmpeg.exe');
      if (!exe) throw new Error('ffmpeg.exe was not in the download');
      const dest = path.join(dir, 'ffmpeg.exe');
      fs.copyFileSync(exe, dest);
      const probe = findFile(extract, 'ffprobe.exe');
      if (probe) fs.copyFileSync(probe, path.join(dir, 'ffprobe.exe'));
      return fs.existsSync(dest) ? dest : null;
    } finally {
      try {
        fs.rmSync(extract, { recursive: true, force: true });
        fs.rmSync(zip, { force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  })().catch((err) => {
    console.error('[live-tv] ffmpeg install failed', err);
    return null;
  }).finally(() => {
    ffmpegInstall = null;
  });
  return ffmpegInstall;
}

type HwName = 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264';
let cachedHwName: { ff: string; name: HwName } | null = null;
let hwLogged = false;

function detectHwName(ff: string): HwName {
  if (cachedHwName && cachedHwName.ff === ff) return cachedHwName.name;
  let text = '';
  try {
    text = execFileSync(ff, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 8000 });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    text = `${e.stdout || ''}\n${e.stderr || ''}`;
  }
  let name: HwName = 'libx264';
  if (/\bh264_nvenc\b/.test(text)) name = 'h264_nvenc';
  else if (/\bh264_qsv\b/.test(text)) name = 'h264_qsv';
  else if (/\bh264_amf\b/.test(text)) name = 'h264_amf';
  cachedHwName = { ff, name };
  if (!hwLogged) {
    hwLogged = true;
    activityLog.info('livetv', `Library channel video encoder: ${name}`);
  }
  return name;
}

function probeCodecsAsync(ff: string, file: string): Promise<{ video: string; audio: string }> {
  const probe = path.join(path.dirname(ff), 'ffprobe.exe');
  if (!fs.existsSync(probe)) return Promise.resolve({ video: '', audio: '' });
  return new Promise((resolve) => {
    execFile(
      probe,
      ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0', file],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
      (err, out) => {
        if (err) {
          resolve({ video: '', audio: '' });
          return;
        }
        let video = '';
        let audio = '';
        for (const line of String(out || '').split(/\r?\n/)) {
          const [type, name] = line.split(',');
          if (type === 'video' && !video) video = (name || '').trim();
          if (type === 'audio' && !audio) audio = (name || '').trim();
        }
        resolve({ video, audio });
      }
    );
  });
}

const MPEGTS_AUDIO = new Set(['aac', 'ac3', 'eac3', 'mp2', 'mp3']);

/** H.264 files can be remuxed. Anything else is decoded and encoded on the GPU. */
function libraryFfmpegArgs(
  ff: string,
  file: string,
  offsetSec: number,
  mode: 'copy' | 'hw' | 'cpu',
  limitSec?: number
): string[] {
  const ss = String(Math.max(0, Math.floor(offsetSec)));
  const limit = limitSec && limitSec > 0 ? ['-t', String(Math.max(1, Math.floor(limitSec)))] : [];
  if (mode === 'copy') {
    return ['-hide_banner', '-loglevel', 'error', '-re', '-ss', ss, '-i', file, ...limit, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-f', 'mpegts', 'pipe:1'];
  }
  const hw = detectHwName(ff);
  const args = ['-hide_banner', '-loglevel', 'error', '-re'];
  if (mode === 'hw') {
    if (hw === 'h264_nvenc') args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-extra_hw_frames', '8');
    else if (hw === 'h264_qsv') args.push('-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv');
    else if (hw === 'h264_amf') args.push('-hwaccel', 'd3d11va');
  }
  args.push('-ss', ss, '-i', file, ...limit, '-map', '0:v:0', '-map', '0:a:0?');
  if (mode === 'cpu' || hw === 'libx264') {
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23', '-threads', '2');
  } else if (hw === 'h264_nvenc') {
    args.push('-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'll', '-rc', 'vbr', '-cq', '28', '-b:v', '0');
  } else if (hw === 'h264_qsv') {
    args.push('-c:v', 'h264_qsv', '-preset', 'veryfast', '-look_ahead', '0', '-global_quality', '26');
  } else {
    args.push('-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '24', '-qp_p', '24');
  }
  args.push('-c:a', 'aac', '-ac', '2', '-b:a', '128k', '-f', 'mpegts', 'pipe:1');
  return args;
}

function findFile(dir: string, name: string): string | null {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (ent.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return null;
}

function parseStreamTarget(raw: string): { url: string; headers: Record<string, string> } {
  const parts = String(raw || '').split('|');
  const url = (parts[0] || '').trim();
  const headers: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    let k = p.slice(0, i).trim();
    const v = p.slice(i + 1).trim();
    if (/^(http-)?user-agent$/i.test(k)) k = 'User-Agent';
    else if (/^(http-)?referr?er$/i.test(k)) k = 'Referer';
    else if (/^origin$/i.test(k)) k = 'Origin';
    if (k && v) headers[k] = v;
  }
  return { url, headers };
}

const MAX_UPSTREAM_REDIRECTS = 6;

function openUpstream(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  redirects = 0
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_UPSTREAM_REDIRECTS) {
      reject(new Error('Too many redirects'));
      return;
    }
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      reject(new Error('Bad stream URL'));
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new Error('Unsupported stream protocol'));
      return;
    }
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        family: 4,
        agent: isHttps ? insecureHttps : keepAliveHttp,
        timeout: Math.max(3000, timeoutMs),
        headers: {
          Accept: '*/*',
          Connection: 'keep-alive',
          ...headers,
        },
      },
      (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          let next: string;
          try {
            next = new URL(res.headers.location, url).toString();
          } catch {
            reject(new Error('Bad redirect URL'));
            return;
          }
          openUpstream(next, headers, timeoutMs, redirects + 1).then(resolve, reject);
          return;
        }
        resolve(res);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout connecting to provider'));
    });
    req.end();
  });
}

async function readStreamLimited(stream: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  return new Promise((resolve, reject) => {
    stream.on('data', (c: Buffer) => {
      n += c.length;
      if (n > limit) {
        stream.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function parseHlsPlaylist(text: string, baseUrl: string): {
  variants: { bw: number; url: string }[];
  segments: { url: string; dur: number }[];
  target: number;
  ended: boolean;
  fmp4: boolean;
} {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants: { bw: number; url: string }[] = [];
  const segments: { url: string; dur: number }[] = [];
  let pendingBw = 0;
  let pendingDur = 6;
  let target = 6;
  let ended = false;
  let fmp4 = false;
  let master = false;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      target = Math.max(1, Number(line.split(':')[1]) || 6);
      continue;
    }
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      master = true;
      const m = line.match(/BANDWIDTH=(\d+)/i);
      pendingBw = m ? Number(m[1]) : 0;
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      pendingDur = Number(line.slice(8).split(',')[0]) || target;
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) fmp4 = true;
    if (line === '#EXT-X-ENDLIST') ended = true;
    if (line.startsWith('#')) continue;
    const abs = new URL(line, baseUrl).toString();
    if (master) {
      variants.push({ bw: pendingBw, url: abs });
      pendingBw = 0;
    } else {
      segments.push({ url: abs, dur: pendingDur });
    }
  }
  return { variants, segments, target, ended, fmp4 };
}

function xmlEsc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xmltvTs(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const ah = Math.floor(Math.abs(off) / 60);
  const am = Math.abs(off) % 60;
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())} ${sign}${p(ah)}${p(am)}`;
}

function iconDir(): string {
  return path.join(app.getPath('userData'), 'live-tv-icons');
}

function safeChannelId(id: string): string | null {
  const s = String(id || '').trim();
  if (!s || !/^[a-z0-9_-]{1,80}$/i.test(s)) return null;
  return s;
}

export function findChannelIconFile(channelId: string): string | null {
  const safeId = safeChannelId(channelId);
  if (!safeId) return null;
  try {
    const dir = iconDir();
    if (!fs.existsSync(dir)) return null;
    const hit = fs.readdirSync(dir).find((f) => f === safeId || f.startsWith(`${safeId}.`));
    if (hit) return path.join(dir, hit);
  } catch {
    // ignore
  }
  return null;
}

function clearIconFiles(channelId: string): void {
  const safeId = safeChannelId(channelId);
  if (!safeId) return;
  try {
    const dir = iconDir();
    if (!fs.existsSync(dir)) return;
    for (const old of fs.readdirSync(dir).filter((f) => f === safeId || f.startsWith(`${safeId}.`))) {
      try {
        fs.unlinkSync(path.join(dir, old));
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

function writeIconBuffer(channelId: string, buf: Buffer): string {
  const safeId = safeChannelId(channelId);
  if (!safeId) throw new Error('Invalid channel id');
  fs.mkdirSync(iconDir(), { recursive: true });
  clearIconFiles(safeId);
  let png = buf;
  try {
    const img = nativeImage.createFromBuffer(buf);
    if (!img.isEmpty()) png = img.toPNG();
  } catch {
    // keep original bytes
  }
  const dest = path.join(iconDir(), `${safeId}.png`);
  fs.writeFileSync(dest, png);
  return dest;
}

export function saveChannelIconFile(channelId: string, fromPath: string): string {
  const safeId = safeChannelId(channelId);
  if (!safeId) throw new Error('Invalid channel id');
  if (!fromPath || !fs.existsSync(fromPath)) throw new Error('Icon file not found');
  fs.mkdirSync(iconDir(), { recursive: true });
  clearIconFiles(safeId);
  const dest = path.join(iconDir(), `${safeId}.png`);
  try {
    const img = nativeImage.createFromPath(fromPath);
    if (!img.isEmpty()) {
      fs.writeFileSync(dest, img.toPNG());
      return dest;
    }
  } catch {
    // fall through
  }
  fs.copyFileSync(fromPath, dest);
  return dest;
}

export function logoPreviewDataUrl(ch: LiveTvChannel): string {
  const file =
    findChannelIconFile(ch.id) ||
    (ch.logo && !/^https?:\/\//i.test(ch.logo) && fs.existsSync(ch.logo) ? ch.logo : null);
  if (file) {
    try {
      const buf = fs.readFileSync(file);
      if (buf.length > 16 && buf.length < 2_000_000) {
        return `data:${mimeForIcon(file)};base64,${buf.toString('base64')}`;
      }
    } catch {
      // ignore
    }
  }
  if (/^https?:\/\//i.test(ch.logo || '')) return ch.logo;
  return '';
}

export function withLogoPreview(ch: LiveTvChannel): LiveTvChannel & { logoPreview?: string } {
  const logoPreview = logoPreviewDataUrl(ch);
  return logoPreview ? { ...ch, logoPreview } : ch;
}

function mimeForIcon(file: string): string {
  const e = path.extname(file).toLowerCase();
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.gif') return 'image/gif';
  if (e === '.webp') return 'image/webp';
  if (e === '.svg') return 'image/svg+xml';
  return 'image/png';
}

function parseXmltvChannels(xml: string): LiveTvEpgOption[] {
  const out: LiveTvEpgOption[] = [];
  const seen = new Set<string>();
  const re = /<channel\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const id = m[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = (m[2].match(/<display-name[^>]*>([^<]+)<\/display-name>/i) || [])[1] || id;
    out.push({ id, name: name.trim() });
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return out;
}

function indexXmltvProgrammes(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /<programme\b[^>]*\bchannel="([^"]+)"[^>]*>[\s\S]*?<\/programme>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const id = m[1];
    map.set(id, (map.get(id) || '') + m[0] + '\n');
  }
  return map;
}

function fakeProgrammesXml(channelId: string, title: string, minutes: number, days: number): string {
  const slot = Math.max(15, Math.min(240, Math.floor(minutes) || 60));
  const span = Math.max(1, Math.min(7, Math.floor(days) || 2));
  const start = new Date();
  start.setSeconds(0, 0);
  start.setMinutes(Math.floor(start.getMinutes() / slot) * slot);
  const endMs = start.getTime() + span * 24 * 60 * 60 * 1000;
  const chunks: string[] = [];
  const cid = xmlEsc(channelId);
  const ttl = xmlEsc(title || 'Live');
  for (let t = start.getTime(); t < endMs; t += slot * 60 * 1000) {
    const a = new Date(t);
    const b = new Date(t + slot * 60 * 1000);
    chunks.push(
      `<programme start="${xmltvTs(a)}" stop="${xmltvTs(b)}" channel="${cid}"><title>${ttl}</title><desc>Live</desc></programme>`
    );
  }
  return chunks.join('\n');
}

class LiveTvServer {
  private server: http.Server | null = null;
  private slots = new Map<string, TunerSlot>();
  private lastError: string | null = null;
  private lastStreamError: string | null = null;
  private lastRefresh: string | null = null;
  private xmltvMem = '';
  private xmltvIds: LiveTvEpgOption[] = [];
  private xmltvByChannel = new Map<string, string>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private ffmpegPath: string | null = null;
  private refreshing = false;
  private refreshInFlight: Promise<LiveTvChannel[]> | null = null;

  /** A tuner is streaming, or the channel list is being refreshed. */
  isInUse(): boolean {
    return this.slots.size > 0 || this.refreshing;
  }

  sync(settings: AppSettings): void {
    this.ffmpegPath = detectFfmpeg(settings.liveTvFfmpegPath);
    if (settings.liveTvEnabled && !this.ffmpegPath) {
      void ensureFfmpeg(settings.liveTvFfmpegPath).then((p) => {
        if (p) this.ffmpegPath = p;
      });
    }
    if (!settings.liveTvEnabled) {
      this.stop();
      return;
    }
    const port = Math.max(1, Math.min(65535, settings.liveTvPort || 34400));
    const host = settings.liveTvBind === 'localhost' ? '127.0.0.1' : '0.0.0.0';
    if (this.server) {
      const addr = this.server.address();
      const curPort = typeof addr === 'object' && addr ? addr.port : 0;
      const curHost = typeof addr === 'object' && addr ? addr.address : '';
      if (curPort === port && (curHost === host || (host === '0.0.0.0' && curHost === '::'))) return;
      this.stop();
    }
    try {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.on('error', (err) => {
        this.lastError = err.message;
        this.server = null;
      });
      this.server.listen(port, host, () => {
        this.lastError = null;
      });
      this.xmltvMem = getLiveTvXmltvCache();
      this.reindexXmltv();
      this.scheduleRefresh();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.server = null;
    }
  }

  stop(): void {
    for (const slot of this.slots.values()) {
      try {
        slot.cleanup();
      } catch {
        // ignore
      }
    }
    this.slots.clear();
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.server) {
      try {
        this.server.close();
      } catch {
        // ignore
      }
      this.server = null;
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      void this.refreshSources().catch(() => undefined);
    }, 12 * 60 * 60 * 1000);
  }

  getStatus(settings: AppSettings): LiveTvStatus {
    const lan = pickLanIpv4() || '127.0.0.1';
    const host = settings.liveTvBind === 'localhost' ? '127.0.0.1' : lan;
    const port = settings.liveTvPort || 34400;
    const lineup = getLiveTvLineup();
    const enabled = lineup.filter((c) => c.enabled);
    return {
      enabled: !!settings.liveTvEnabled,
      listening: !!this.server,
      port,
      bind: settings.liveTvBind === 'localhost' ? 'localhost' : 'lan',
      ffmpegFound: !!this.ffmpegPath,
      ffmpegPath: this.ffmpegPath,
      tuners: settings.liveTvTuners || 3,
      tunersInUse: this.slots.size,
      channelCount: lineup.length,
      enabledCount: enabled.length,
      lastError: this.lastStreamError || this.lastError,
      lastRefresh: this.lastRefresh,
      tunerUrl: `http://${host}:${port}`,
      xmltvUrl: `http://${host}:${port}/xmltv.xml`,
      active: [...this.slots.values()].map((s) => ({ number: s.number, name: s.name })),
    };
  }

  enabledChannels(): LiveTvChannel[] {
    const list = getLiveTvLineup()
      .filter((c) => c.enabled && c.url)
      .sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));
    const used = new Set<number>();
    return list.map((c, i) => {
      let n = c.number || i + 1;
      while (used.has(n)) n += 1;
      used.add(n);
      return n === c.number ? c : { ...c, number: n };
    });
  }

  async refreshSources(): Promise<LiveTvChannel[]> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const run = (async () => {
      const s = getSettings();
      this.refreshing = true;
      try {
        const { channels, xmltv } = await refreshLiveTvViaPool({
          settings: s,
          existing: getLiveTvLineup(),
        });
        setLiveTvLineup(channels);
        this.lastRefresh = new Date().toISOString();
        this.lastError = null;
        if (typeof xmltv === 'string') {
          this.xmltvMem = xmltv;
          setLiveTvXmltvCache(xmltv.length > 8_000_000 ? '' : xmltv);
        } else if (!xmltv) {
          this.xmltvMem = getLiveTvXmltvCache();
        }
        this.reindexXmltv();
        void this.cacheEnabledLogos().catch(() => undefined);
        return channels;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        this.refreshing = false;
        this.refreshInFlight = null;
      }
    })();
    this.refreshInFlight = run;
    return run;
  }

  private reindexXmltv(): void {
    const xml = this.xmltvMem || '';
    this.xmltvIds = xml ? parseXmltvChannels(xml) : [];
    this.xmltvByChannel = xml ? indexXmltvProgrammes(xml) : new Map();
  }

  epgOptions(): LiveTvEpgOption[] {
    if (!this.xmltvIds.length && (this.xmltvMem || getLiveTvXmltvCache())) {
      this.xmltvMem = this.xmltvMem || getLiveTvXmltvCache();
      this.reindexXmltv();
    }
    return this.xmltvIds;
  }

  applyChannelIcon(channelId: string, filePath: string): LiveTvChannel[] {
    const dest = saveChannelIconFile(channelId, filePath);
    const next = getLiveTvLineup().map((c) =>
      c.id === channelId ? { ...c, logo: dest, logoCustom: true } : c
    );
    setLiveTvLineup(next);
    return next.map(withLogoPreview);
  }

  private iconUrl(ch: LiveTvChannel, base: string): string {
    if (findChannelIconFile(ch.id) || (ch.logo && !/^https?:\/\//i.test(ch.logo))) {
      return `${base}/icon/${encodeURIComponent(ch.id)}.png`;
    }
    if (/^https?:\/\//i.test(ch.logo || '')) return ch.logo;
    return '';
  }

  private async cacheEnabledLogos(): Promise<void> {
    const ua = getSettings().liveTvUserAgent || DEFAULT_UA;
    for (const ch of this.enabledChannels()) {
      if (ch.logoCustom) continue;
      if (findChannelIconFile(ch.id)) continue;
      if (!/^https?:\/\//i.test(ch.logo || '')) continue;
      try {
        const up = await openUpstream(ch.logo, { 'User-Agent': ua }, 12000);
        if ((up.statusCode || 0) >= 400) {
          up.resume();
          continue;
        }
        const buf = await readStreamLimited(up, 1_500_000);
        if (buf.length > 32) writeIconBuffer(ch.id, buf);
      } catch {
        // keep remote URL
      }
    }
  }

  composeXmltv(base: string): string {
    const s = getSettings();
    const minutes = s.liveTvFakeEpgMinutes || 60;
    const days = s.liveTvFakeEpgDays || 2;
    const fakeMissing = s.liveTvFakeEpgMissing !== false;
    const enabled = this.enabledChannels();
    const chXml: string[] = [];
    const prXml: string[] = [];
    for (const ch of enabled) {
      const cid = (ch.tvgId || `nf-${ch.id}`).trim();
      const icon = this.iconUrl(ch, base);
      chXml.push(
        `<channel id="${xmlEsc(cid)}"><display-name>${xmlEsc(ch.name)}</display-name>${
          icon ? `<icon src="${xmlEsc(icon)}" />` : ''
        }</channel>`
      );
      if (ch.kind === 'library') {
        const slots = libraryScheduleNow(ch, days);
        if (!slots.length) {
          prXml.push(fakeProgrammesXml(cid, `${ch.name} — nothing downloaded yet`, minutes, days));
        } else {
          prXml.push(
            slots
              .map(
                (slot) =>
                  `<programme start="${xmltvTs(new Date(slot.start))}" stop="${xmltvTs(new Date(slot.end))}" channel="${xmlEsc(cid)}"><title>${xmlEsc(slot.title)}</title><desc>${xmlEsc(slot.desc)}</desc></programme>`
              )
              .join('\n')
          );
        }
      } else {
      const mapped = ch.tvgId ? this.xmltvByChannel.get(ch.tvgId) : '';
      const useFake = !!ch.fakeEpg || (fakeMissing && !mapped);
      if (useFake) prXml.push(fakeProgrammesXml(cid, ch.name, minutes, days));
      else if (mapped) prXml.push(mapped);
      }
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="Nightfeed">\n${chXml.join(
      '\n'
    )}\n${prXml.join('\n')}\n</tv>\n`;
  }

  private baseUrl(req: http.IncomingMessage, settings: AppSettings): string {
    const hostHdr = String(req.headers.host || '');
    if (hostHdr) return `http://${hostHdr}`;
    const lan = pickLanIpv4() || '127.0.0.1';
    const host = settings.liveTvBind === 'localhost' ? '127.0.0.1' : lan;
    return `http://${host}:${settings.liveTvPort || 34400}`;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      this.handleInner(req, res);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal error');
      } else if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          // ignore
        }
      }
    }
  }

  private handleInner(req: http.IncomingMessage, res: http.ServerResponse): void {
    const settings = getSettings();
    let url: URL;
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad URL');
      return;
    }
    const p = url.pathname.toLowerCase();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (p === '/discover.json') {
      const base = this.baseUrl(req, settings);
      this.json(res, {
        FriendlyName: 'Nightfeed',
        ModelNumber: 'HDHR4-2US',
        FirmwareName: 'hdhomerun4_atsc',
        FirmwareVersion: '20190621',
        DeviceID: crypto.createHash('md5').update(`${os.hostname()}-nightfeed`).digest('hex').slice(0, 8).toUpperCase(),
        DeviceAuth: 'Nightfeed',
        BaseURL: base,
        LineupURL: `${base}/lineup.json`,
        TunerCount: settings.liveTvTuners || 3,
      });
      return;
    }
    if (p === '/lineup_status.json') {
      this.json(res, { ScanInProgress: 0, ScanPossible: 1, Source: 'Cable', SourceList: ['Cable'] });
      return;
    }
    if (p === '/lineup.json') {
      const base = this.baseUrl(req, settings);
      const rows = this.enabledChannels().map((c) => {
        const logo = this.iconUrl(c, base);
        return {
          GuideNumber: String(c.number),
          GuideName: c.name,
          HD: 1,
          URL: `${base}/auto/v${c.number}`,
          ...(logo ? { Logo: logo } : {}),
        };
      });
      this.json(res, rows);
      return;
    }
    if (p === '/lineup.post') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (p === '/xmltv.xml' || p === '/xmltv') {
      if (!this.xmltvIds.length && (this.xmltvMem || getLiveTvXmltvCache())) {
        this.xmltvMem = this.xmltvMem || getLiveTvXmltvCache();
        this.reindexXmltv();
      }
      const xml = this.composeXmltv(this.baseUrl(req, settings));
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(xml);
      return;
    }
    if (p.startsWith('/icon/')) {
      let rawId: string;
      try {
        rawId = decodeURIComponent(p.slice('/icon/'.length).split('/')[0] || '');
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad icon id');
        return;
      }
      const id = safeChannelId(rawId.replace(/\.(png|jpg|jpeg|gif|webp|svg)$/i, ''));
      const lineup = id ? getLiveTvLineup().find((c) => c.id === id) : null;
      const file = id ? findChannelIconFile(id) : null;
      const disk =
        file ||
        (lineup && lineup.logo && !/^https?:\/\//i.test(lineup.logo) && fs.existsSync(lineup.logo)
          ? lineup.logo
          : null);
      if (!disk) {
        res.writeHead(404);
        res.end();
        return;
      }
      const stream = fs.createReadStream(disk);
      stream.on('error', () => {
        if (!res.headersSent) res.writeHead(404);
        if (!res.writableEnded) res.end();
      });
      res.writeHead(200, {
        'Content-Type': mimeForIcon(disk),
        'Cache-Control': 'public, max-age=3600',
      });
      stream.pipe(res);
      return;
    }
    const auto = p.match(/^\/auto\/v(\d+)/);
    if (auto) {
      if (req.method === 'HEAD' || req.method === 'OPTIONS') {
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      this.streamChannel(Number(auto[1]), req, res, settings);
      return;
    }
    if (p === '/' || p === '/index.html') {
      const st = this.getStatus(settings);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Nightfeed Live TV</title><body style="font-family:sans-serif;background:#121212;color:#e8e6e3;padding:2rem"><h1 style="color:#d4a017">Nightfeed Live TV</h1><p>HDHomeRun tuner for Plex.</p><p>Tuner: <code>${st.tunerUrl}</code><br>Guide: <code>${st.xmltvUrl}</code></p><p>${st.enabledCount} channels enabled · ${st.tunersInUse}/${st.tuners} tuners in use</p></body>`
      );
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  }

  private json(res: http.ServerResponse, body: unknown): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private failStream(res: http.ServerResponse, cleanup: () => void, chName: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.lastStreamError = `${chName}: ${msg}`;
    try {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(msg);
    } catch {
      // ignore
    }
    cleanup();
  }

  private spawnFfmpeg(
    url: string,
    headers: Record<string, string>,
    res: http.ServerResponse,
    cleanup: () => void,
    ff: string,
    chName: string
  ): ChildProcess {
    const ua = headers['User-Agent'] || DEFAULT_UA;
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-fflags',
      '+genpts+discardcorrupt',
      '-user_agent',
      ua,
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '5',
    ];
    if (headers.Referer) args.push('-headers', `Referer: ${headers.Referer}\r\n`);
    args.push('-i', url, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-f', 'mpegts', 'pipe:1');
    const child = spawn(ff, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let errBuf = '';
    child.stderr?.on('data', (d: Buffer) => {
      errBuf = (errBuf + d.toString('utf8')).slice(-2000);
    });
    if (!res.headersSent) {
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
    }
    child.stdout.pipe(res);
    child.on('error', (err) => this.failStream(res, cleanup, chName, err));
    child.on('exit', (code) => {
      if (code && code !== 0) this.lastStreamError = `${chName}: ffmpeg ${errBuf.trim() || `exit ${code}`}`;
      cleanup();
    });
    return child;
  }

  private async pipeHls(
    playlistUrl: string,
    headers: Record<string, string>,
    res: http.ServerResponse,
    req: http.IncomingMessage,
    cleanup: () => void,
    settings: AppSettings,
    chName: string
  ): Promise<void> {
    const aborted = () => req.destroyed || res.destroyed;
    const timeout = settings.liveTvBufferTimeoutMs || 8000;
    let mediaUrl = playlistUrl;
    const first = await openUpstream(mediaUrl, headers, timeout);
    if ((first.statusCode || 0) >= 400) {
      first.destroy();
      throw new Error(`Provider HTTP ${first.statusCode}`);
    }
    const body = await readStreamLimited(first, 4_000_000);
    const text = body.toString('utf8');
    if (!text.includes('#EXTM3U')) {
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
      res.write(body);
      return;
    }
    let parsed = parseHlsPlaylist(text, mediaUrl);
    if (parsed.fmp4) throw new Error('fMP4 HLS needs ffmpeg (Settings → Buffer = ffmpeg)');
    if (parsed.variants.length) {
      parsed.variants.sort((a, b) => b.bw - a.bw);
      mediaUrl = parsed.variants[0].url;
      const second = await openUpstream(mediaUrl, headers, timeout);
      if ((second.statusCode || 0) >= 400) {
        second.destroy();
        throw new Error(`Provider HTTP ${second.statusCode}`);
      }
      const t2 = (await readStreamLimited(second, 4_000_000)).toString('utf8');
      parsed = parseHlsPlaylist(t2, mediaUrl);
    }
    if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
    const seen = new Set<string>();
    const MAX_SEEN = 500;
    let loops = 0;
    while (!aborted() && loops < 20000) {
      loops += 1;
      let fresh = parsed;
      if (loops > 1) {
        const plRes = await openUpstream(mediaUrl, headers, timeout);
        if ((plRes.statusCode || 0) >= 400) {
          plRes.destroy();
          throw new Error(`Provider HTTP ${plRes.statusCode}`);
        }
        fresh = parseHlsPlaylist(
          (await readStreamLimited(plRes, 4_000_000)).toString('utf8'),
          mediaUrl
        );
      }
      const newSegs = fresh.segments.filter((s) => !seen.has(s.url));
      if (!newSegs.length && fresh.ended) break;
      for (const seg of newSegs) {
        if (aborted()) return;
        seen.add(seg.url);
        if (seen.size > MAX_SEEN) {
          const oldest = seen.values().next().value;
          if (oldest !== undefined) seen.delete(oldest);
        }
        const segRes = await openUpstream(seg.url, headers, timeout);
        if ((segRes.statusCode || 0) >= 400) {
          segRes.destroy();
          continue;
        }
        segRes.socket?.setTimeout(0);
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => segRes.resume();
          const onClose = () => {
            segRes.destroy();
            finish();
          };
          let settled = false;
          const finish = (err?: unknown) => {
            if (settled) return;
            settled = true;
            res.removeListener('drain', onDrain);
            req.removeListener('close', onClose);
            if (err) reject(err);
            else resolve();
          };
          req.once('close', onClose);
          segRes.on('data', (c: Buffer) => {
            if (aborted()) {
              segRes.destroy();
              finish();
              return;
            }
            try {
              if (!res.write(c)) {
                segRes.pause();
                res.once('drain', onDrain);
              }
            } catch (e) {
              segRes.destroy();
              finish(e);
            }
          });
          segRes.on('end', () => finish());
          segRes.on('error', (e) => finish(e));
        });
      }
      if (fresh.ended) break;
      await new Promise((r) => setTimeout(r, Math.min(4000, Math.max(400, (fresh.target * 1000) / 2))));
    }
    cleanup();
  }

  private async pipeLibraryChannel(
    ch: LiveTvChannel,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    cleanup: () => void,
    settings: AppSettings,
    isAlive: () => boolean,
    setChild: (proc: ChildProcess | null) => void
  ): Promise<void> {
    this.lastStreamError = this.ffmpegPath ? null : `${ch.name}: installing ffmpeg…`;
    const ff = this.ffmpegPath || (await ensureFfmpeg(settings.liveTvFfmpegPath));
    if (ff) this.ffmpegPath = ff;
    this.lastStreamError = null;
    if (!isAlive()) {
      cleanup();
      return;
    }
    if (!ff) {
      this.failStream(res, cleanup, ch.name, new Error('Could not install ffmpeg'));
      return;
    }
    if (!res.headersSent) {
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
    }
    const days = Math.max(1, settings.liveTvFakeEpgDays || 2);
    let stop = false;
    const playFile = async (file: string, offsetSec: number, limitSec: number): Promise<void> => {
      if (!isAlive()) return;
      const codecs = await probeCodecsAsync(ff, file);
      if (!isAlive()) return;
      const copyOk = codecs.video === 'h264' && (!codecs.audio || MPEGTS_AUDIO.has(codecs.audio));
      const modes: Array<'copy' | 'hw' | 'cpu'> = copyOk ? ['copy'] : ['hw', 'cpu'];
      const limited = Math.max(1, Math.floor(limitSec));
      const run = (mode: 'copy' | 'hw' | 'cpu') =>
        new Promise<{ code: number | null; bytes: number; err: string }>((done) => {
          if (!isAlive()) {
            done({ code: 0, bytes: 0, err: '' });
            return;
          }
          const proc = spawn(ff, libraryFfmpegArgs(ff, file, offsetSec, mode, limited), {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          setChild(proc);
          if (!isAlive()) {
            try {
              proc.kill();
            } catch {
              // ignore
            }
            done({ code: 0, bytes: 0, err: '' });
            return;
          }
          let bytes = 0;
          let errBuf = '';
          let settled = false;
          const onDrain = () => proc.stdout.resume();
          const onClose = () => {
            try {
              proc.kill();
            } catch {
              // ignore
            }
          };
          const finish = (code: number | null) => {
            if (settled) return;
            settled = true;
            res.removeListener('drain', onDrain);
            req.removeListener('close', onClose);
            setChild(null);
            done({ code, bytes, err: errBuf });
          };
          req.once('close', onClose);
          proc.stderr?.on('data', (d: Buffer) => {
            errBuf = (errBuf + d.toString('utf8')).slice(-500);
          });
          proc.stdout.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (!isAlive() || res.writableEnded) {
              try {
                proc.kill();
              } catch {
                // ignore
              }
              return;
            }
            if (!res.write(chunk)) {
              proc.stdout.pause();
              res.once('drain', onDrain);
            }
          });
          proc.on('exit', (code) => finish(code));
          proc.on('error', () => finish(1));
        });
      for (let i = 0; i < modes.length; i++) {
        if (!isAlive()) break;
        const mode = modes[i];
        const result = await run(mode);
        if (!result.code || result.bytes >= 8000 || !isAlive()) break;
        if (i === modes.length - 1) {
          stop = true;
          this.lastStreamError = `${ch.name}: playback failed ${result.err || 'ffmpeg'}`.trim();
        } else {
          activityLog.warn('livetv', `GPU playback failed for ${path.basename(file)}, retrying`, {
            error: result.err,
          });
        }
      }
    };
    const sleepAbortable = (ms: number) =>
      new Promise<void>((resolve) => {
        if (!isAlive() || ms <= 0) {
          resolve();
          return;
        }
        const onClose = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          req.removeListener('close', onClose);
          resolve();
        }, ms);
        req.once('close', onClose);
      });
    let guard = 0;
    while (isAlive() && !stop && guard < 400) {
      guard += 1;
      const slot = currentLibrarySlot(ch, days);
      if (!slot) {
        this.lastStreamError = `${ch.name}: no downloaded movies or episodes for this channel`;
        break;
      }
      const offset = Math.max(0, (Date.now() - slot.start) / 1000);
      const remain = Math.max(1, (slot.end - Date.now()) / 1000);
      await playFile(slot.path, offset, remain);
      const waitMs = slot.end - Date.now();
      if (waitMs > 400 && isAlive()) {
        await sleepAbortable(waitMs);
      }
    }
    cleanup();
  }

  private streamChannel(
    number: number,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    settings: AppSettings
  ): void {
    const ch = this.enabledChannels().find((c) => c.number === number);
    if (!ch) {
      res.writeHead(404);
      res.end('Unknown channel');
      return;
    }
    const max = Math.max(1, settings.liveTvTuners || 3);
    if (this.slots.size >= max) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('All tuners in use');
      return;
    }
    const slotId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ua = settings.liveTvUserAgent || DEFAULT_UA;
    const parsed = parseStreamTarget(ch.url);
    const headers: Record<string, string> = { 'User-Agent': ua, ...parsed.headers };
    if (!headers['User-Agent']) headers['User-Agent'] = ua;
    let child: ChildProcess | null = null;
    let upstream: http.IncomingMessage | null = null;
    let bufferStream: PassThrough | null = null;
    let alive = true;
    const cleanup = () => {
      if (!alive) return;
      alive = false;
      this.slots.delete(slotId);
      try {
        child?.kill();
      } catch {
        // ignore
      }
      child = null;
      try {
        upstream?.destroy();
      } catch {
        // ignore
      }
      upstream = null;
      try {
        bufferStream?.destroy();
      } catch {
        // ignore
      }
      bufferStream = null;
    };
    this.slots.set(slotId, { number, name: ch.name, req, cleanup });
    req.on('close', cleanup);
    res.on('close', cleanup);

    const mode = settings.liveTvBufferMode;
    const ff = this.ffmpegPath;
    if (ch.kind === 'library') {
      void this.pipeLibraryChannel(ch, req, res, cleanup, settings, () => alive, (proc) => {
        child = proc;
      });
      return;
    }
    const url = parsed.url;
    const hls = /\.m3u8(\?|$)/i.test(url);

    const run = async () => {
      try {
        if ((mode === 'ffmpeg' || (hls && ff)) && ff) {
          child = this.spawnFfmpeg(url, headers, res, cleanup, ff, ch.name);
          return;
        }
        if (hls) {
          await this.pipeHls(url, headers, res, req, cleanup, settings, ch.name);
          return;
        }
        const up = await openUpstream(url, headers, settings.liveTvBufferTimeoutMs || 8000);
        if (!alive) {
          up.destroy();
          return;
        }
        upstream = up;
        up.socket?.setTimeout(0);
        const code = up.statusCode || 200;
        if (code >= 400) {
          up.destroy();
          throw new Error(`Provider HTTP ${code}`);
        }
        const ctype = String(up.headers['content-type'] || '');
        if (/mpegurl|m3u8/i.test(ctype)) {
          up.destroy();
          upstream = null;
          if (ff) {
            child = this.spawnFfmpeg(url, headers, res, cleanup, ff, ch.name);
            return;
          }
          await this.pipeHls(url, headers, res, req, cleanup, settings, ch.name);
          return;
        }
        if (!res.headersSent) {
          res.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Cache-Control': 'no-store',
          });
        }
        if (mode === 'memory') {
          bufferStream = new PassThrough({
            highWaterMark: Math.max(64, settings.liveTvBufferKb || 1024) * 1024,
          });
          bufferStream.pipe(res);
          up.pipe(bufferStream);
        } else {
          up.pipe(res);
        }
        up.on('end', cleanup);
        up.on('error', (err) => this.failStream(res, cleanup, ch.name, err));
      } catch (err) {
        this.failStream(res, cleanup, ch.name, err);
      }
    };
    void run();
  }
}

const DEFAULT_UA = 'VLC/3.0.20 LibVLC/3.0.20';

export const liveTv = new LiveTvServer();
export { parseM3u, isAdult };
