/**
 * IPTV → Plex Live TV: HDHomeRun-style tuner + XMLTV guide + custom library channels.
 * Does not bind sockets to the torrent VPN interface.
 */
import http from 'http';
import https from 'https';
import { spawn, execFile, execFileSync, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { app, nativeImage } from 'electron';
import type {
  AppSettings,
  LiveTvChannel,
  LiveTvEpgOption,
  LiveTvStatus,
  LiveTvTestResult,
} from '../types';
import {
  getLiveTvLineup,
  getLiveTvXmltvCache,
  getSettings,
  setLiveTvLineup,
  setLiveTvXmltvCache,
} from './store';
import {
  currentLibrarySlot,
  initDurationCache,
  libraryScheduleNow,
  nextLibrarySlot,
  setCachedDurationSec,
  unprobedLibraryFiles,
} from './library-channel';
import { activityLog } from './activity-log';
import { refreshLiveTvViaPool } from './livetv-pool';
import { isAdult, parseM3u } from './livetv-refresh-core';
import {
  buildFfmpegHeadersArg,
  fakeProgrammesXml,
  indexXmltvProgrammes,
  parseHlsPlaylist,
  parseStreamTarget,
  parseXmltvChannels,
  rewriteProgrammeChannel,
  xmlEsc,
  xmltvTs,
} from './livetv-xmltv';
import { extractZipSafely } from './safe-unzip';

const DEFAULT_UA = 'VLC/3.0.20 LibVLC/3.0.20';
const insecureHttps = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const keepAliveHttp = new http.Agent({ keepAlive: true });

const FFMPEG_CANDIDATES = [
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe'),
];

const SHARED_GRACE_MS = 2000;
const MAX_SLOW_CLIENT_BUFFER = 4 * 1024 * 1024;
const BACKPRESSURE_WATERMARK = 512 * 1024;

type TunerSlot = {
  number: number;
  name: string;
  req: http.IncomingMessage;
  cleanup: () => void;
};

type SharedClient = {
  slotId: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  headersSent: boolean;
  closed: boolean;
  onDrain: () => void;
  close: () => void;
};

type SharedChannelStream = {
  key: string;
  channelName: string;
  clients: Set<SharedClient>;
  firstByteSeen: boolean;
  destroyed: boolean;
  graceTimer: NodeJS.Timeout | null;
  stopProducer: () => void;
  onDrainNotify: (() => void) | null;
  writeChunk: (chunk: Buffer) => boolean;
  failAll: (err: unknown) => void;
  endAll: () => void;
  destroyNow: () => void;
};

export function pickLanIpv4(): string | null {
  const preferred: string[] = [];
  const other: string[] = [];
  try {
    for (const [name, entries] of Object.entries(os.networkInterfaces())) {
      const n = name.toLowerCase();
      if (
        /tap|tun|openvpn|wintun|dco|tailscale|vethernet|loopback|vmware|virtualbox|vbox|docker|wsl|hyper-v|zerotier|hamachi|wireguard|mullvad|nordlynx/.test(
          n
        )
      ) {
        continue;
      }
      for (const e of entries || []) {
        if (!e || e.internal) continue;
        if (e.family !== 'IPv4' && (e.family as unknown) !== 4) continue;
        if (e.address.startsWith('192.168.56.')) continue; // VirtualBox host-only default
        if (e.address.startsWith('192.168.')) preferred.push(e.address);
        else if (e.address.startsWith('10.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(e.address)) {
          other.push(e.address);
        }
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
    const first = String(out)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
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
  })()
    .catch((err) => {
      console.error('[live-tv] ffmpeg install failed', err);
      return null;
    })
    .finally(() => {
      ffmpegInstall = null;
    });
  return ffmpegInstall;
}

type HwName = 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264';
let cachedHwName: { ff: string; name: HwName } | null = null;
let hwProbeInFlight: { ff: string; promise: Promise<HwName> } | null = null;

function testEncoderAvailable(ff: string, encoder: Exclude<HwName, 'libx264'>): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      ff,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=128x128:d=0.1',
        '-frames:v',
        '1',
        '-pix_fmt',
        'nv12',
        '-c:v',
        encoder,
        '-f',
        'null',
        '-',
      ],
      { encoding: 'utf8', timeout: 6000, windowsHide: true },
      (err) => resolve(!err)
    );
  });
}

function listCompiledEncoders(ff: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      ff,
      ['-hide_banner', '-encoders'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) resolve(`${stdout || ''}\n${stderr || ''}`);
        else resolve(String(stdout || ''));
      }
    );
  });
}

/**
 * Probe which H.264 hardware encoder ACTUALLY works on this PC's GPU
 * (not just what ffmpeg was compiled with) so Intel QuickSync / AMD AMF / NVENC
 * are picked accurately instead of always failing on NVENC.
 */
async function detectHwNameAsync(ff: string): Promise<HwName> {
  if (cachedHwName && cachedHwName.ff === ff) return cachedHwName.name;
  if (hwProbeInFlight && hwProbeInFlight.ff === ff) return hwProbeInFlight.promise;
  const run = (async (): Promise<HwName> => {
    const text = await listCompiledEncoders(ff);
    const candidates: Array<Exclude<HwName, 'libx264'>> = ['h264_nvenc', 'h264_qsv', 'h264_amf'];
    let picked: HwName = 'libx264';
    for (const enc of candidates) {
      if (!new RegExp(`\\b${enc}\\b`).test(text)) continue;
      if (await testEncoderAvailable(ff, enc)) {
        picked = enc;
        break;
      }
    }
    cachedHwName = { ff, name: picked };
    activityLog.info('livetv', `Library channel video encoder (verified): ${picked}`);
    return picked;
  })().finally(() => {
    if (hwProbeInFlight?.ff === ff) hwProbeInFlight = null;
  });
  hwProbeInFlight = { ff, promise: run };
  return run;
}

function resolveFfprobe(ff: string): string | null {
  const sibling = path.join(path.dirname(ff), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  if (fs.existsSync(sibling)) return sibling;
  return null;
}

function probeMediaAsync(
  ff: string,
  file: string
): Promise<{ video: string; audio: string; durationSec: number | null }> {
  const probe = resolveFfprobe(ff);
  if (!probe) return Promise.resolve({ video: '', audio: '', durationSec: null });
  return new Promise((resolve) => {
    execFile(
      probe,
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,codec_name:format=duration',
        '-of',
        'json',
        file,
      ],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
      (err, out) => {
        if (err || !out) {
          resolve({ video: '', audio: '', durationSec: null });
          return;
        }
        try {
          const parsed = JSON.parse(String(out)) as {
            streams?: Array<{ codec_type?: string; codec_name?: string }>;
            format?: { duration?: string | number };
          };
          let video = '';
          let audio = '';
          for (const st of parsed.streams || []) {
            if (st.codec_type === 'video' && !video) video = String(st.codec_name || '').trim().toLowerCase();
            if (st.codec_type === 'audio' && !audio) audio = String(st.codec_name || '').trim().toLowerCase();
          }
          const rawDur = Number(parsed.format?.duration);
          const durationSec = Number.isFinite(rawDur) && rawDur >= 60 ? Math.round(rawDur) : null;
          if (durationSec !== null) setCachedDurationSec(file, durationSec);
          resolve({ video, audio, durationSec });
        } catch {
          resolve({ video: '', audio: '', durationSec: null });
        }
      }
    );
  });
}

const MPEGTS_AUDIO = new Set(['aac', 'ac3', 'eac3', 'mp2', 'mp3']);
type LibraryFfmpegMode = 'copy' | 'vcopy-aac' | 'hw' | 'hw-swdec' | 'cpu';

/**
 * Build ffmpeg args for library channels:
 * - copy: H.264 + MPEG-TS audio (pure remux)
 * - vcopy-aac: H.264 + DTS/TrueHD/Opus/FLAC (video copy + AAC audio)
 * - hw: full GPU decode + encode
 * - hw-swdec: software decode + GPU encode (handles 10-bit HEVC/AV1 on QSV/NVENC/AMF)
 * - cpu: libx264 ultrafast fallback
 */
function libraryFfmpegArgs(
  hw: HwName,
  file: string,
  offsetSec: number,
  mode: LibraryFfmpegMode,
  limitSec?: number,
  outputTsOffsetSec = 0
): string[] {
  const ss = String(Math.max(0, Math.floor(offsetSec)));
  const limit = limitSec && limitSec > 0 ? ['-t', String(Math.max(1, Math.floor(limitSec)))] : [];
  const tsOffset =
    outputTsOffsetSec > 0 ? ['-output_ts_offset', outputTsOffsetSec.toFixed(3)] : [];

  if (mode === 'copy') {
    return [
      '-hide_banner',
      '-loglevel',
      'error',
      '-re',
      '-ss',
      ss,
      '-i',
      file,
      ...limit,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c',
      'copy',
      ...tsOffset,
      '-mpegts_flags',
      '+resend_headers',
      '-f',
      'mpegts',
      'pipe:1',
    ];
  }
  if (mode === 'vcopy-aac') {
    return [
      '-hide_banner',
      '-loglevel',
      'error',
      '-re',
      '-ss',
      ss,
      '-i',
      file,
      ...limit,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-ac',
      '2',
      '-ar',
      '48000',
      '-b:a',
      '128k',
      ...tsOffset,
      '-mpegts_flags',
      '+resend_headers',
      '-f',
      'mpegts',
      'pipe:1',
    ];
  }

  const args = ['-hide_banner', '-loglevel', 'error', '-re'];
  if (mode === 'hw') {
    if (hw === 'h264_nvenc') {
      args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-extra_hw_frames', '8');
    } else if (hw === 'h264_qsv') {
      args.push('-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv');
    } else if (hw === 'h264_amf') {
      args.push('-hwaccel', 'd3d11va');
    }
  }
  args.push('-ss', ss, '-i', file, ...limit, '-map', '0:v:0', '-map', '0:a:0?');
  if (mode === 'hw-swdec') {
    args.push('-pix_fmt', 'nv12');
  }
  if (mode === 'cpu' || hw === 'libx264') {
    args.push(
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-tune',
      'zerolatency',
      '-crf',
      '23',
      '-threads',
      '2'
    );
  } else if (hw === 'h264_nvenc') {
    args.push('-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'll', '-rc', 'vbr', '-cq', '28', '-b:v', '0');
  } else if (hw === 'h264_qsv') {
    args.push('-c:v', 'h264_qsv', '-preset', 'veryfast', '-look_ahead', '0', '-global_quality', '26');
  } else {
    args.push('-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '24', '-qp_p', '24');
  }
  args.push(
    '-c:a',
    'aac',
    '-ac',
    '2',
    '-ar',
    '48000',
    '-b:a',
    '128k',
    ...tsOffset,
    '-mpegts_flags',
    '+resend_headers',
    '-f',
    'mpegts',
    'pipe:1'
  );
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

function alignMpegTsChunk(chunk: Buffer): Buffer {
  if (chunk.length < 188) return chunk;
  for (let i = 0; i < Math.min(chunk.length, 376); i++) {
    if (chunk[i] === 0x47 && (i + 188 >= chunk.length || chunk[i + 188] === 0x47)) {
      return i === 0 ? chunk : chunk.subarray(i);
    }
  }
  return chunk;
}

function iconDir(): string {
  return path.join(app.getPath('userData'), 'live-tv-icons');
}

function xmltvDiskPath(): string {
  return path.join(app.getPath('userData'), 'live-tv-xmltv.xml.gz');
}

function durationCacheDiskPath(): string {
  return path.join(app.getPath('userData'), 'live-tv-durations.json');
}

function safeChannelId(id: string): string | null {
  const s = String(id || '').trim();
  if (!s || !/^[a-z0-9_-]{1,80}$/i.test(s)) return null;
  return s;
}

function buildIconFileIndex(): Map<string, string> {
  const index = new Map<string, string>();
  try {
    const dir = iconDir();
    if (!fs.existsSync(dir)) return index;
    for (const file of fs.readdirSync(dir)) {
      const dot = file.indexOf('.');
      const base = dot > 0 ? file.slice(0, dot) : file;
      if (base && !index.has(base)) {
        index.set(base, path.join(dir, file));
      }
    }
  } catch {
    // ignore
  }
  return index;
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

function mimeForIcon(file: string): string {
  const e = path.extname(file).toLowerCase();
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.gif') return 'image/gif';
  if (e === '.webp') return 'image/webp';
  if (e === '.svg') return 'image/svg+xml';
  return 'image/png';
}

function logoPreviewDataUrlWithIndex(ch: LiveTvChannel, iconIndex?: Map<string, string>): string {
  const safeId = safeChannelId(ch.id);
  const indexedFile = safeId
    ? iconIndex
      ? iconIndex.get(safeId) || null
      : findChannelIconFile(safeId)
    : null;
  const file =
    indexedFile ||
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

export function logoPreviewDataUrl(ch: LiveTvChannel): string {
  return logoPreviewDataUrlWithIndex(ch);
}

export function withLogoPreview(ch: LiveTvChannel): LiveTvChannel & { logoPreview?: string } {
  const logoPreview = logoPreviewDataUrlWithIndex(ch);
  return logoPreview ? { ...ch, logoPreview } : ch;
}

/** Fast O(1)-readdir batch logo preview builder for full channel lineups. */
export function withLogoPreviews(channels: LiveTvChannel[]): Array<LiveTvChannel & { logoPreview?: string }> {
  const iconIndex = buildIconFileIndex();
  return channels.map((ch) => {
    const logoPreview = logoPreviewDataUrlWithIndex(ch, iconIndex);
    return logoPreview ? { ...ch, logoPreview } : ch;
  });
}

class LiveTvServer {
  private server: http.Server | null = null;
  private listening = false;
  private slots = new Map<string, TunerSlot>();
  private sharedStreams = new Map<string, SharedChannelStream>();
  private lastError: string | null = null;
  private lastStreamError: string | null = null;
  private lastRefresh: string | null = null;
  private xmltvMem = '';
  private xmltvIds: LiveTvEpgOption[] = [];
  private xmltvByChannel = new Map<string, string>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private startupRefreshTimer: NodeJS.Timeout | null = null;
  private ffmpegPath: string | null = null;
  private hwEncoder: HwName | null = null;
  private refreshing = false;
  private refreshInFlight: Promise<LiveTvChannel[]> | null = null;
  private durationCacheReady = false;
  private probingDurations = false;

  /** A tuner is streaming, or the channel list is being refreshed. */
  isInUse(): boolean {
    return this.slots.size > 0 || this.refreshing;
  }

  private ensureDurationCacheLoaded(): void {
    if (this.durationCacheReady) return;
    this.durationCacheReady = true;
    initDurationCache(durationCacheDiskPath());
  }

  private loadXmltvFromDisk(): { loaded: boolean; stale: boolean } {
    const gzPath = xmltvDiskPath();
    try {
      if (fs.existsSync(gzPath)) {
        const st = fs.statSync(gzPath);
        const xml = zlib.gunzipSync(fs.readFileSync(gzPath)).toString('utf8');
        if (xml) {
          this.xmltvMem = xml;
          if (!this.lastRefresh) this.lastRefresh = new Date(st.mtimeMs).toISOString();
          this.reindexXmltv();
          const stale = Date.now() - st.mtimeMs > 12 * 60 * 60 * 1000;
          return { loaded: true, stale };
        }
      }
    } catch {
      // fall through to legacy cache
    }
    const legacy = getLiveTvXmltvCache();
    if (legacy) {
      this.xmltvMem = legacy;
      this.reindexXmltv();
      return { loaded: true, stale: true };
    }
    return { loaded: false, stale: true };
  }

  private saveXmltvToDisk(xml: string): void {
    try {
      const gzPath = xmltvDiskPath();
      fs.mkdirSync(path.dirname(gzPath), { recursive: true });
      const compressed = zlib.gzipSync(Buffer.from(xml, 'utf8'));
      void fs.promises.writeFile(gzPath, compressed).catch(() => undefined);
      // Clear legacy config.json cache so config.json stays small.
      if (getLiveTvXmltvCache()) setLiveTvXmltvCache('');
    } catch {
      // ignore disk write errors
    }
  }

  private hasConfiguredIptvSource(s: AppSettings): boolean {
    if (s.liveTvSourceType === 'm3u') return !!(s.liveTvM3uUrl || '').trim();
    if (s.liveTvSourceType === 'xtream') return !!((s.liveTvXtreamHost || '').trim() && s.liveTvXtreamUsername);
    if (s.liveTvSourceType === 'direct') return !!(s.liveTvDirectUrl || '').trim();
    return false;
  }

  private triggerHwDetection(ff: string): void {
    void detectHwNameAsync(ff)
      .then((enc) => {
        this.hwEncoder = enc;
      })
      .catch(() => undefined);
  }

  probeLibraryDurationsInBackground(): void {
    if (this.probingDurations || !this.ffmpegPath) return;
    const ff = this.ffmpegPath;
    if (!resolveFfprobe(ff)) return;
    this.ensureDurationCacheLoaded();
    const files = unprobedLibraryFiles(getLiveTvLineup());
    if (!files.length) return;
    this.probingDurations = true;
    void (async () => {
      try {
        for (const file of files.slice(0, 200)) {
          if (!this.server) break;
          await probeMediaAsync(ff, file);
          await new Promise((r) => setTimeout(r, 50));
        }
      } finally {
        this.probingDurations = false;
      }
    })();
  }

  sync(settings: AppSettings): void {
    this.ensureDurationCacheLoaded();
    this.ffmpegPath = detectFfmpeg(settings.liveTvFfmpegPath);
    if (this.ffmpegPath) {
      this.triggerHwDetection(this.ffmpegPath);
    } else if (settings.liveTvEnabled) {
      void ensureFfmpeg(settings.liveTvFfmpegPath).then((p) => {
        if (p) {
          this.ffmpegPath = p;
          this.triggerHwDetection(p);
          this.probeLibraryDurationsInBackground();
        }
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
      if (curPort === port && (curHost === host || (host === '0.0.0.0' && curHost === '::'))) {
        this.probeLibraryDurationsInBackground();
        return;
      }
      this.stop();
    }
    try {
      const srv = http.createServer((req, res) => this.handle(req, res));
      this.server = srv;
      this.listening = false;
      srv.on('error', (err) => {
        this.lastError = err.message;
        if (this.server === srv) {
          this.server = null;
          this.listening = false;
        }
      });
      srv.listen(port, host, () => {
        if (this.server === srv) {
          this.listening = true;
          this.lastError = null;
        }
      });
      const { stale } = this.loadXmltvFromDisk();
      this.scheduleRefresh();
      this.probeLibraryDurationsInBackground();
      if (stale && this.hasConfiguredIptvSource(settings)) {
        if (this.startupRefreshTimer) clearTimeout(this.startupRefreshTimer);
        this.startupRefreshTimer = setTimeout(() => {
          this.startupRefreshTimer = null;
          if (this.server) void this.refreshSources().catch(() => undefined);
        }, 10_000);
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.server = null;
      this.listening = false;
    }
  }

  stop(): void {
    if (this.startupRefreshTimer) {
      clearTimeout(this.startupRefreshTimer);
      this.startupRefreshTimer = null;
    }
    for (const shared of this.sharedStreams.values()) {
      try {
        shared.destroyNow();
      } catch {
        // ignore
      }
    }
    this.sharedStreams.clear();
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
      const srv = this.server;
      this.server = null;
      this.listening = false;
      try {
        (srv as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      } catch {
        // ignore
      }
      try {
        srv.close();
      } catch {
        // ignore
      }
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      void this.refreshSources().catch(() => undefined);
    }, 12 * 60 * 60 * 1000);
  }

  clearError(settings: AppSettings): LiveTvStatus {
    this.lastError = null;
    this.lastStreamError = null;
    return this.getStatus(settings);
  }

  getStatus(settings: AppSettings): LiveTvStatus {
    this.ensureDurationCacheLoaded();
    const lan = pickLanIpv4() || '127.0.0.1';
    const host = settings.liveTvBind === 'localhost' ? '127.0.0.1' : lan;
    const port = settings.liveTvPort || 34400;
    const lineup = getLiveTvLineup();
    const enabled = lineup.filter((c) => c.enabled);
    const days = Math.max(1, settings.liveTvFakeEpgDays || 2);
    const libraryNowPlaying: Record<string, string> = {};
    for (const ch of lineup) {
      if (ch.kind !== 'library') continue;
      const slot = currentLibrarySlot(ch, days);
      if (slot) libraryNowPlaying[ch.id] = slot.title;
    }
    return {
      enabled: !!settings.liveTvEnabled,
      listening: this.listening && !!this.server,
      port,
      bind: settings.liveTvBind === 'localhost' ? 'localhost' : 'lan',
      ffmpegFound: !!this.ffmpegPath,
      ffmpegPath: this.ffmpegPath,
      hwEncoder: this.hwEncoder,
      epgChannelCount: this.xmltvIds.length,
      libraryNowPlaying,
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
        if (typeof xmltv === 'string' && xmltv.length > 0) {
          this.xmltvMem = xmltv;
          this.saveXmltvToDisk(xmltv);
        } else if (!this.xmltvMem) {
          this.loadXmltvFromDisk();
        }
        this.reindexXmltv();
        void this.cacheEnabledLogos().catch(() => undefined);
        this.probeLibraryDurationsInBackground();
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
    if (!this.xmltvIds.length && !this.xmltvMem) {
      this.loadXmltvFromDisk();
    }
    return this.xmltvIds;
  }

  applyChannelIcon(channelId: string, filePath: string): LiveTvChannel[] {
    const dest = saveChannelIconFile(channelId, filePath);
    const next = getLiveTvLineup().map((c) =>
      c.id === channelId ? { ...c, logo: dest, logoCustom: true } : c
    );
    setLiveTvLineup(next);
    return withLogoPreviews(next);
  }

  async testChannel(channelId: string): Promise<LiveTvTestResult> {
    const started = Date.now();
    const ch = getLiveTvLineup().find((c) => c.id === channelId);
    if (!ch) {
      return { ok: false, latencyMs: 0, detail: 'Channel not found' };
    }
    const settings = getSettings();
    if (ch.kind === 'library') {
      this.ensureDurationCacheLoaded();
      const days = Math.max(1, settings.liveTvFakeEpgDays || 2);
      const slot = currentLibrarySlot(ch, days);
      if (!slot) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          detail: 'No downloaded movies or episodes match this channel',
        };
      }
      if (!fs.existsSync(slot.path)) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          detail: `File missing: ${path.basename(slot.path)}`,
        };
      }
      const ff = this.ffmpegPath || detectFfmpeg(settings.liveTvFfmpegPath);
      let modeInfo = ff ? 'ready' : 'ffmpeg will auto-install on play';
      if (ff) {
        const hw = await detectHwNameAsync(ff);
        this.hwEncoder = hw;
        const codecs = await probeMediaAsync(ff, slot.path);
        if (codecs.video === 'h264' && (!codecs.audio || MPEGTS_AUDIO.has(codecs.audio))) {
          modeInfo = 'direct copy';
        } else if (codecs.video === 'h264') {
          modeInfo = `video copy + AAC (${codecs.audio || 'audio'})`;
        } else if (codecs.video) {
          modeInfo = `${codecs.video} → ${hw}`;
        } else {
          modeInfo = hw;
        }
      }
      return {
        ok: true,
        latencyMs: Date.now() - started,
        detail: `${slot.title} (${modeInfo})`,
      };
    }

    const ua = settings.liveTvUserAgent || DEFAULT_UA;
    const parsed = parseStreamTarget(ch.url);
    const headers: Record<string, string> = { 'User-Agent': ua, ...parsed.headers };
    if (!headers['User-Agent']) headers['User-Agent'] = ua;
    try {
      const up = await openUpstream(parsed.url, headers, Math.min(8000, settings.liveTvBufferTimeoutMs || 8000));
      const status = up.statusCode || 0;
      const contentType = String(up.headers['content-type'] || '');
      up.destroy();
      const latencyMs = Date.now() - started;
      const ok = status >= 200 && status < 400;
      return {
        ok,
        status,
        latencyMs,
        contentType,
        detail: ok
          ? `HTTP ${status}${contentType ? ` · ${contentType.split(';')[0]}` : ''} (${latencyMs}ms)`
          : `Provider HTTP ${status} (${latencyMs}ms)`,
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private iconUrl(ch: LiveTvChannel, base: string, iconIndex?: Map<string, string>): string {
    const safeId = safeChannelId(ch.id);
    const hasDisk =
      (safeId && (iconIndex ? iconIndex.has(safeId) : !!findChannelIconFile(safeId))) ||
      (ch.logo && !/^https?:\/\//i.test(ch.logo));
    if (hasDisk) {
      return `${base}/icon/${encodeURIComponent(ch.id)}.png`;
    }
    if (/^https?:\/\//i.test(ch.logo || '')) return ch.logo;
    return '';
  }

  private async cacheEnabledLogos(): Promise<void> {
    const ua = getSettings().liveTvUserAgent || DEFAULT_UA;
    const iconIndex = buildIconFileIndex();
    for (const ch of this.enabledChannels()) {
      if (ch.logoCustom) continue;
      const safeId = safeChannelId(ch.id);
      if (safeId && iconIndex.has(safeId)) continue;
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
    this.ensureDurationCacheLoaded();
    const s = getSettings();
    const minutes = s.liveTvFakeEpgMinutes || 60;
    const days = s.liveTvFakeEpgDays || 2;
    const fakeMissing = s.liveTvFakeEpgMissing !== false;
    const enabled = this.enabledChannels();
    const iconIndex = buildIconFileIndex();
    const chXml: string[] = [];
    const prXml: string[] = [];
    const usedIds = new Set<string>();

    for (const ch of enabled) {
      const preferredId = (ch.tvgId || `nf-${ch.id}`).trim();
      const cid = !preferredId || usedIds.has(preferredId) ? `nf-${ch.id}` : preferredId;
      usedIds.add(cid);
      const icon = this.iconUrl(ch, base, iconIndex);
      chXml.push(
        `<channel id="${xmlEsc(cid)}"><display-name>${xmlEsc(ch.name)}</display-name><lcn>${ch.number}</lcn>${
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
        const lookupId = (ch.tvgId || '').trim();
        const mapped = lookupId ? this.xmltvByChannel.get(lookupId) : '';
        const useFake = !!ch.fakeEpg || (fakeMissing && !mapped);
        if (useFake) {
          prXml.push(fakeProgrammesXml(cid, ch.name, minutes, days));
        } else if (mapped) {
          prXml.push(cid === lookupId ? mapped : rewriteProgrammeChannel(mapped, cid));
        }
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
      const iconIndex = buildIconFileIndex();
      const rows = this.enabledChannels().map((c) => {
        const logo = this.iconUrl(c, base, iconIndex);
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
      if (!this.xmltvIds.length && !this.xmltvMem) {
        this.loadXmltvFromDisk();
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
    const auto = p.match(/^\/auto\/v(\d+)(?:\.\d+)?$/);
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

  private createSharedStream(key: string, channelName: string): SharedChannelStream {
    const shared: SharedChannelStream = {
      key,
      channelName,
      clients: new Set<SharedClient>(),
      firstByteSeen: false,
      destroyed: false,
      graceTimer: null,
      stopProducer: () => undefined,
      onDrainNotify: null,
      writeChunk: (chunk: Buffer): boolean => {
        if (shared.destroyed || !chunk.length) return false;
        const isFirst = !shared.firstByteSeen;
        if (isFirst) {
          shared.firstByteSeen = true;
          this.lastStreamError = null;
        }
        let allBackedUp = shared.clients.size > 0;
        for (const client of [...shared.clients]) {
          if (client.closed || client.res.destroyed || client.res.writableEnded) {
            client.close();
            continue;
          }
          if (client.res.writableLength > MAX_SLOW_CLIENT_BUFFER) {
            try {
              client.res.destroy();
            } catch {
              // ignore
            }
            client.close();
            continue;
          }
          let payload = chunk;
          if (!client.headersSent) {
            client.headersSent = true;
            try {
              if (!client.res.headersSent) {
                client.res.writeHead(200, {
                  'Content-Type': 'video/mp2t',
                  'Cache-Control': 'no-store',
                });
              }
            } catch {
              client.close();
              continue;
            }
            if (!isFirst) {
              payload = alignMpegTsChunk(chunk);
            }
          }
          try {
            const ok = client.res.write(payload);
            if (ok && client.res.writableLength < BACKPRESSURE_WATERMARK) {
              allBackedUp = false;
            } else if (!ok) {
              client.res.once('drain', client.onDrain);
            }
          } catch {
            client.close();
          }
        }
        return !allBackedUp;
      },
      failAll: (err: unknown) => {
        if (shared.destroyed) return;
        const msg = err instanceof Error ? err.message : String(err);
        this.lastStreamError = `${channelName}: ${msg}`;
        for (const client of [...shared.clients]) {
          try {
            if (!client.headersSent && !client.res.headersSent) {
              client.res.writeHead(502, { 'Content-Type': 'text/plain' });
              client.res.end(msg);
            } else if (!client.res.writableEnded) {
              client.res.end();
            }
          } catch {
            // ignore
          }
          client.close();
        }
        shared.destroyNow();
      },
      endAll: () => {
        if (shared.destroyed) return;
        for (const client of [...shared.clients]) {
          try {
            if (!client.res.writableEnded) client.res.end();
          } catch {
            // ignore
          }
          client.close();
        }
        shared.destroyNow();
      },
      destroyNow: () => {
        if (shared.destroyed) return;
        shared.destroyed = true;
        if (shared.graceTimer) {
          clearTimeout(shared.graceTimer);
          shared.graceTimer = null;
        }
        if (this.sharedStreams.get(key) === shared) {
          this.sharedStreams.delete(key);
        }
        try {
          shared.stopProducer();
        } catch {
          // ignore
        }
        for (const client of [...shared.clients]) {
          client.close();
        }
        shared.clients.clear();
      },
    };
    this.sharedStreams.set(key, shared);
    return shared;
  }

  private attachClient(
    shared: SharedChannelStream,
    number: number,
    name: string,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    if (shared.graceTimer) {
      clearTimeout(shared.graceTimer);
      shared.graceTimer = null;
    }
    const slotId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const client: SharedClient = {
      slotId,
      req,
      res,
      headersSent: false,
      closed: false,
      onDrain: () => {
        shared.onDrainNotify?.();
      },
      close: () => {
        if (client.closed) return;
        client.closed = true;
        this.slots.delete(slotId);
        shared.clients.delete(client);
        req.removeListener('close', client.close);
        res.removeListener('close', client.close);
        res.removeListener('drain', client.onDrain);
        if (shared.clients.size === 0 && !shared.destroyed) {
          if (!shared.firstByteSeen) {
            shared.destroyNow();
          } else {
            if (shared.graceTimer) clearTimeout(shared.graceTimer);
            shared.graceTimer = setTimeout(() => {
              shared.graceTimer = null;
              if (shared.clients.size === 0 && !shared.destroyed) {
                shared.destroyNow();
              }
            }, SHARED_GRACE_MS);
          }
        }
      },
    };
    shared.clients.add(client);
    this.slots.set(slotId, {
      number,
      name,
      req,
      cleanup: () => {
        try {
          if (!res.writableEnded) res.end();
        } catch {
          // ignore
        }
        client.close();
      },
    });
    req.once('close', client.close);
    res.once('close', client.close);
  }

  private spawnFfmpegIntoShared(
    url: string,
    headers: Record<string, string>,
    shared: SharedChannelStream,
    ff: string,
    timeoutMs: number
  ): void {
    const ua = headers['User-Agent'] || DEFAULT_UA;
    const extraHeaders = buildFfmpegHeadersArg(headers);
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
    if (extraHeaders) args.push('-headers', extraHeaders);
    args.push(
      '-i',
      url,
      '-map',
      '0:v?',
      '-map',
      '0:a?',
      '-c',
      'copy',
      '-mpegts_flags',
      '+resend_headers',
      '-f',
      'mpegts',
      'pipe:1'
    );
    const child = spawn(ff, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let errBuf = '';
    let gotBytes = false;
    const startupTimer = setTimeout(() => {
      if (!gotBytes && !shared.destroyed) {
        try {
          child.kill();
        } catch {
          // ignore
        }
        shared.failAll(new Error(errBuf.trim() || 'Timeout waiting for stream data'));
      }
    }, Math.max(15_000, timeoutMs * 2));

    shared.stopProducer = () => {
      clearTimeout(startupTimer);
      try {
        child.kill();
      } catch {
        // ignore
      }
    };
    shared.onDrainNotify = () => {
      try {
        child.stdout.resume();
      } catch {
        // ignore
      }
    };

    child.stderr?.on('data', (d: Buffer) => {
      errBuf = (errBuf + d.toString('utf8')).slice(-2000);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (shared.destroyed) return;
      if (!gotBytes) {
        gotBytes = true;
        clearTimeout(startupTimer);
      }
      if (!shared.writeChunk(chunk)) {
        child.stdout.pause();
      }
    });
    child.on('error', (err) => {
      clearTimeout(startupTimer);
      shared.failAll(err);
    });
    child.on('exit', (code) => {
      clearTimeout(startupTimer);
      if (shared.destroyed) return;
      if (!gotBytes || (code && code !== 0)) {
        shared.failAll(new Error(`ffmpeg ${errBuf.trim() || `exit ${code}`}`));
      } else {
        shared.endAll();
      }
    });
  }

  private async pipeHlsIntoShared(
    playlistUrl: string,
    headers: Record<string, string>,
    shared: SharedChannelStream,
    settings: AppSettings,
    ff: string | null
  ): Promise<void> {
    const timeout = settings.liveTvBufferTimeoutMs || 8000;
    let activeUpstream: http.IncomingMessage | null = null;
    let sleepCancel: (() => void) | null = null;
    const prevStop = shared.stopProducer;
    shared.stopProducer = () => {
      prevStop();
      sleepCancel?.();
      try {
        activeUpstream?.destroy();
      } catch {
        // ignore
      }
      activeUpstream = null;
    };

    const sleepAbortable = (ms: number) =>
      new Promise<void>((resolve) => {
        if (shared.destroyed || ms <= 0) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          sleepCancel = null;
          resolve();
        }, ms);
        sleepCancel = () => {
          clearTimeout(timer);
          sleepCancel = null;
          resolve();
        };
      });

    let mediaUrl = playlistUrl;
    const first = await openUpstream(mediaUrl, headers, timeout);
    activeUpstream = first;
    if ((first.statusCode || 0) >= 400) {
      first.destroy();
      throw new Error(`Provider HTTP ${first.statusCode}`);
    }
    const body = await readStreamLimited(first, 4_000_000);
    activeUpstream = null;
    if (shared.destroyed) return;

    const text = body.toString('utf8');
    if (!text.includes('#EXTM3U')) {
      shared.writeChunk(body);
      shared.endAll();
      return;
    }

    let parsed = parseHlsPlaylist(text, mediaUrl);
    if (parsed.variants.length) {
      parsed.variants.sort((a, b) => b.bw - a.bw);
      mediaUrl = parsed.variants[0].url;
      const second = await openUpstream(mediaUrl, headers, timeout);
      activeUpstream = second;
      if ((second.statusCode || 0) >= 400) {
        second.destroy();
        throw new Error(`Provider HTTP ${second.statusCode}`);
      }
      const t2 = (await readStreamLimited(second, 4_000_000)).toString('utf8');
      activeUpstream = null;
      if (shared.destroyed) return;
      parsed = parseHlsPlaylist(t2, mediaUrl);
    }

    if (parsed.fmp4 || parsed.encrypted) {
      if (ff) {
        this.spawnFfmpegIntoShared(mediaUrl, headers, shared, ff, timeout);
        return;
      }
      throw new Error(
        parsed.encrypted
          ? 'Encrypted HLS stream needs ffmpeg (Settings → Buffer = ffmpeg)'
          : 'fMP4 HLS needs ffmpeg (Settings → Buffer = ffmpeg)'
      );
    }

    const seen = new Set<string>();
    const MAX_SEEN = 500;
    let firstFetch = true;

    while (!shared.destroyed) {
      let fresh = parsed;
      if (!firstFetch) {
        const plRes = await openUpstream(mediaUrl, headers, timeout);
        activeUpstream = plRes;
        if ((plRes.statusCode || 0) >= 400) {
          plRes.destroy();
          throw new Error(`Provider HTTP ${plRes.statusCode}`);
        }
        const plText = (await readStreamLimited(plRes, 4_000_000)).toString('utf8');
        activeUpstream = null;
        if (shared.destroyed) return;
        fresh = parseHlsPlaylist(plText, mediaUrl);
      }

      // Start live HLS streams near the live edge (last 3 segments) so playback isn't 60s behind.
      let candidates = fresh.segments;
      if (firstFetch && !fresh.ended && candidates.length > 3) {
        for (const skipped of candidates.slice(0, candidates.length - 3)) {
          seen.add(skipped.url);
        }
        candidates = candidates.slice(-3);
      }
      firstFetch = false;

      const newSegs = candidates.filter((s) => !seen.has(s.url));
      if (!newSegs.length && fresh.ended) break;

      for (const seg of newSegs) {
        if (shared.destroyed) return;
        seen.add(seg.url);
        if (seen.size > MAX_SEEN) {
          const oldest = seen.values().next().value;
          if (oldest !== undefined) seen.delete(oldest);
        }
        const segRes = await openUpstream(seg.url, headers, timeout);
        activeUpstream = segRes;
        if ((segRes.statusCode || 0) >= 400) {
          segRes.destroy();
          activeUpstream = null;
          continue;
        }
        segRes.socket?.setTimeout(0);
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (err?: unknown) => {
            if (settled) return;
            settled = true;
            if (activeUpstream === segRes) activeUpstream = null;
            if (shared.onDrainNotify === onDrain) shared.onDrainNotify = null;
            if (err) reject(err);
            else resolve();
          };
          const onDrain = () => {
            try {
              segRes.resume();
            } catch {
              // ignore
            }
          };
          shared.onDrainNotify = onDrain;
          segRes.on('data', (c: Buffer) => {
            if (shared.destroyed) {
              segRes.destroy();
              finish();
              return;
            }
            if (!shared.writeChunk(c)) {
              segRes.pause();
            }
          });
          segRes.on('end', () => finish());
          segRes.on('error', (e) => finish(e));
          segRes.on('close', () => finish());
        });
      }
      if (fresh.ended) break;
      await sleepAbortable(Math.min(4000, Math.max(400, (fresh.target * 1000) / 2)));
    }
    shared.endAll();
  }

  private async pipeLibraryChannelIntoShared(
    ch: LiveTvChannel,
    shared: SharedChannelStream,
    settings: AppSettings
  ): Promise<void> {
    this.ensureDurationCacheLoaded();
    let activeProc: ChildProcess | null = null;
    let sleepCancel: (() => void) | null = null;
    shared.stopProducer = () => {
      sleepCancel?.();
      try {
        activeProc?.kill();
      } catch {
        // ignore
      }
      activeProc = null;
    };

    const ff = this.ffmpegPath || (await ensureFfmpeg(settings.liveTvFfmpegPath));
    if (ff) this.ffmpegPath = ff;
    if (shared.destroyed) return;
    if (!ff) {
      shared.failAll(new Error('Could not install ffmpeg'));
      return;
    }

    const hw = await detectHwNameAsync(ff);
    this.hwEncoder = hw;
    if (shared.destroyed) return;

    const days = Math.max(1, settings.liveTvFakeEpgDays || 2);
    let stop = false;
    let streamElapsedSec = 0;

    const playFile = async (file: string, offsetSec: number, limitSec: number): Promise<number> => {
      if (shared.destroyed) return 0;
      const codecs = await probeMediaAsync(ff, file);
      if (shared.destroyed) return 0;

      const copyOk = codecs.video === 'h264' && (!codecs.audio || MPEGTS_AUDIO.has(codecs.audio));
      let modes: LibraryFfmpegMode[];
      if (copyOk) {
        modes = ['copy'];
      } else if (codecs.video === 'h264') {
        modes = ['vcopy-aac', 'cpu'];
      } else if (hw !== 'libx264') {
        modes = ['hw', 'hw-swdec', 'cpu'];
      } else {
        modes = ['cpu'];
      }

      const limited = Math.max(1, Math.floor(limitSec));
      const run = (mode: LibraryFfmpegMode) =>
        new Promise<{ code: number | null; bytes: number; err: string; elapsedSec: number }>((done) => {
          if (shared.destroyed) {
            done({ code: 0, bytes: 0, err: '', elapsedSec: 0 });
            return;
          }
          const startedAt = Date.now();
          const proc = spawn(
            ff,
            libraryFfmpegArgs(ff ? hw : 'libx264', file, offsetSec, mode, limited, streamElapsedSec),
            {
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            }
          );
          activeProc = proc;
          if (shared.destroyed) {
            try {
              proc.kill();
            } catch {
              // ignore
            }
            done({ code: 0, bytes: 0, err: '', elapsedSec: 0 });
            return;
          }
          let bytes = 0;
          let errBuf = '';
          let settled = false;
          const onDrain = () => {
            try {
              proc.stdout.resume();
            } catch {
              // ignore
            }
          };
          shared.onDrainNotify = onDrain;
          const finish = (code: number | null) => {
            if (settled) return;
            settled = true;
            if (activeProc === proc) activeProc = null;
            if (shared.onDrainNotify === onDrain) shared.onDrainNotify = null;
            done({
              code,
              bytes,
              err: errBuf,
              elapsedSec: Math.max(0, (Date.now() - startedAt) / 1000),
            });
          };
          proc.stderr?.on('data', (d: Buffer) => {
            errBuf = (errBuf + d.toString('utf8')).slice(-500);
          });
          proc.stdout.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (shared.destroyed) {
              try {
                proc.kill();
              } catch {
                // ignore
              }
              return;
            }
            if (!shared.writeChunk(chunk)) {
              proc.stdout.pause();
            }
          });
          proc.on('exit', (code) => finish(code));
          proc.on('error', () => finish(1));
        });

      for (let i = 0; i < modes.length; i++) {
        if (shared.destroyed) break;
        const mode = modes[i];
        const result = await run(mode);
        if (!result.code || result.bytes >= 8000 || shared.destroyed) {
          return result.elapsedSec;
        }
        if (i === modes.length - 1) {
          stop = true;
          shared.failAll(new Error(`playback failed ${result.err || 'ffmpeg'}`.trim()));
        } else {
          activityLog.warn('livetv', `Library playback (${mode}) failed for ${path.basename(file)}, retrying`, {
            error: result.err,
          });
        }
      }
      return 0;
    };

    const sleepAbortable = (ms: number) =>
      new Promise<void>((resolve) => {
        if (shared.destroyed || ms <= 0) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          sleepCancel = null;
          resolve();
        }, ms);
        sleepCancel = () => {
          clearTimeout(timer);
          sleepCancel = null;
          resolve();
        };
      });

    let curSlot = currentLibrarySlot(ch, days);
    let guard = 0;
    while (!shared.destroyed && !stop && guard < 1000) {
      guard += 1;
      if (!curSlot) {
        shared.failAll(new Error('No downloaded movies or episodes for this channel'));
        return;
      }
      const now = Date.now();
      const offset = now >= curSlot.start && now < curSlot.end ? (now - curSlot.start) / 1000 : 0;
      const remain = Math.max(1, (curSlot.end - Math.max(now, curSlot.start)) / 1000);
      const playedSec = await playFile(curSlot.path, offset, remain);
      if (shared.destroyed || stop) break;
      streamElapsedSec += Math.max(1, playedSec);

      const waitMs = curSlot.end - Date.now();
      if (waitMs > 150 && waitMs <= 2000) {
        await sleepAbortable(waitMs);
        curSlot = currentLibrarySlot(ch, days);
      } else if (waitMs > 2000) {
        // File finished earlier than scheduled slot; advance directly to next item instead of stalling Plex with silence.
        curSlot = nextLibrarySlot(ch, days, curSlot.end) || currentLibrarySlot(ch, days);
      } else {
        curSlot = currentLibrarySlot(ch, days);
      }
    }
    shared.endAll();
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

    // Fan-out: if this channel already has an active upstream (or is in its 2s grace period),
    // attach this client to the existing stream without opening a second provider connection or ffmpeg process.
    const existingShared = this.sharedStreams.get(ch.id);
    if (existingShared && !existingShared.destroyed) {
      this.attachClient(existingShared, number, ch.name, req, res);
      return;
    }

    const max = Math.max(1, settings.liveTvTuners || 3);
    if (this.slots.size >= max) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('All tuners in use');
      return;
    }

    const shared = this.createSharedStream(ch.id, ch.name);
    this.attachClient(shared, number, ch.name, req, res);

    if (ch.kind === 'library') {
      void this.pipeLibraryChannelIntoShared(ch, shared, settings).catch((err) => {
        shared.failAll(err);
      });
      return;
    }

    const ua = settings.liveTvUserAgent || DEFAULT_UA;
    const parsed = parseStreamTarget(ch.url);
    const headers: Record<string, string> = { 'User-Agent': ua, ...parsed.headers };
    if (!headers['User-Agent']) headers['User-Agent'] = ua;
    const mode = settings.liveTvBufferMode;
    const ff = this.ffmpegPath;
    const url = parsed.url;
    const timeoutMs = settings.liveTvBufferTimeoutMs || 8000;
    const hls = /\.m3u8(\?|$)/i.test(url);

    const run = async () => {
      try {
        if ((mode === 'ffmpeg' || (hls && ff)) && ff) {
          this.spawnFfmpegIntoShared(url, headers, shared, ff, timeoutMs);
          return;
        }
        if (hls) {
          await this.pipeHlsIntoShared(url, headers, shared, settings, ff);
          return;
        }
        const up = await openUpstream(url, headers, timeoutMs);
        if (shared.destroyed) {
          up.destroy();
          return;
        }
        shared.stopProducer = () => {
          try {
            up.destroy();
          } catch {
            // ignore
          }
        };
        up.socket?.setTimeout(0);
        const code = up.statusCode || 200;
        if (code >= 400) {
          up.destroy();
          throw new Error(`Provider HTTP ${code}`);
        }
        const ctype = String(up.headers['content-type'] || '');
        if (/mpegurl|m3u8/i.test(ctype)) {
          up.destroy();
          if (ff) {
            this.spawnFfmpegIntoShared(url, headers, shared, ff, timeoutMs);
            return;
          }
          await this.pipeHlsIntoShared(url, headers, shared, settings, ff);
          return;
        }
        shared.onDrainNotify = () => {
          try {
            up.resume();
          } catch {
            // ignore
          }
        };
        up.on('data', (chunk: Buffer) => {
          if (shared.destroyed) {
            up.destroy();
            return;
          }
          if (!shared.writeChunk(chunk)) {
            up.pause();
          }
        });
        up.on('end', () => shared.endAll());
        up.on('error', (err) => shared.failAll(err));
      } catch (err) {
        shared.failAll(err);
      }
    };
    void run();
  }
}

export const liveTv = new LiveTvServer();
export { parseM3u, isAdult };
