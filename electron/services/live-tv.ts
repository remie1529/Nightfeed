/**
 * IPTV → Plex Live TV: HDHomeRun-style tuner + XMLTV guide.
 * Does not bind sockets to the torrent VPN interface.
 */
import http from 'http';
import https from 'https';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { app, nativeImage } from 'electron';
import type { AppSettings, LiveTvChannel, LiveTvEpgOption, LiveTvStatus } from '../types';
import { getLiveTvLineup, getLiveTvXmltvCache, getSettings, setLiveTvLineup, setLiveTvXmltvCache } from './store';
import { currentLibrarySlot, libraryScheduleNow } from './library-channel';
import { refreshLiveTvViaPool } from './livetv-pool';

const insecureHttps = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const keepAliveHttp = new http.Agent({ keepAlive: true });

const ADULT_RE = /xxx|adult|porn|erotic|18\+|nsfw|playboy/i;
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

function channelId(url: string): string {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
}

function isAdult(ch: { group?: string; name?: string }): boolean {
  return ADULT_RE.test(`${ch.group || ''} ${ch.name || ''}`);
}

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

function fetchText(url: string, ua: string, timeoutMs = 25000): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'User-Agent': ua, Accept: '*/*' },
        timeout: timeoutMs,
      },
      (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          fetchText(next, ua, timeoutMs).then(resolve, reject);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 80_000_000) {
            req.destroy();
            reject(new Error('Response too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (code >= 400) reject(new Error(`HTTP ${code}`));
          else resolve(Buffer.concat(chunks).toString('utf8'));
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.end();
  });
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

function parseM3u(text: string): LiveTvChannel[] {
  const lines = text.split(/\r?\n/);
  const out: LiveTvChannel[] = [];
  let meta: { name: string; group: string; logo: string; tvgId: string } | null = null;
  const vlc: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTVLCOPT:')) {
      const opt = line.slice('#EXTVLCOPT:'.length).trim();
      const ua = opt.match(/^http-user-agent=(.+)/i);
      if (ua) vlc.push(`User-Agent=${ua[1].trim()}`);
      const ref = opt.match(/^http-referr?er=(.+)/i);
      if (ref) vlc.push(`Referer=${ref[1].trim()}`);
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      const comma = line.indexOf(',');
      const attrs = comma >= 0 ? line.slice(0, comma) : line;
      const name = comma >= 0 ? line.slice(comma + 1).trim() : 'Channel';
      const attr = (key: string) => {
        const m = attrs.match(new RegExp(`${key}="([^"]*)"`, 'i'));
        return m?.[1] || '';
      };
      meta = {
        name: name || attr('tvg-name') || 'Channel',
        group: attr('group-title'),
        logo: attr('tvg-logo'),
        tvgId: attr('tvg-id'),
      };
      continue;
    }
    if (line.startsWith('#')) continue;
    const rawUrl = line.replace(/^['"]|['"]$/g, '');
    if (!/^https?:\/\//i.test(rawUrl.split('|')[0])) continue;
    const extra = vlc.length && !rawUrl.includes('|') ? `|${vlc.join('|')}` : '';
    vlc.length = 0;
    const streamUrl = rawUrl + extra;
    const info = meta || { name: 'Channel', group: '', logo: '', tvgId: '' };
    out.push({
      id: channelId(streamUrl.split('|')[0]),
      name: info.name,
      number: out.length + 1,
      group: info.group,
      logo: info.logo,
      tvgId: info.tvgId,
      url: streamUrl,
      enabled: false,
    });
    meta = null;
  }
  return out;
}

function openUpstream(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      reject(new Error('Bad stream URL'));
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
          const next = new URL(res.headers.location, url).toString();
          openUpstream(next, headers, timeoutMs).then(resolve, reject);
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

function xtreamBase(host: string, port: number): string {
  let h = (host || '').trim().replace(/\/+$/, '');
  if (!h) return '';
  if (!/^https?:\/\//i.test(h)) h = `http://${h}`;
  try {
    const u = new URL(h);
    if (port && !host.includes('://') && !host.split('/')[0].includes(':')) u.port = String(port);
    return u.origin;
  } catch {
    return h;
  }
}

function mergeLineup(incoming: LiveTvChannel[], existing: LiveTvChannel[]): LiveTvChannel[] {
  const prev = new Map(existing.map((c) => [c.id, c]));
  const iptv = incoming
    .filter((c) => c.kind !== 'library')
    .map((c, i) => {
      const old = prev.get(c.id);
      if (!old) return { ...c, number: c.number || i + 1, enabled: false };
      return {
        ...c,
        enabled: old.enabled,
        number: old.number || c.number || i + 1,
        name: old.name && old.name !== c.name ? old.name : c.name,
        logo: old.logoCustom && old.logo ? old.logo : c.logo,
        tvgId: old.epgCustom && old.tvgId ? old.tvgId : c.tvgId,
        logoCustom: !!old.logoCustom,
        epgCustom: !!old.epgCustom,
        fakeEpg: !!old.fakeEpg,
      };
    });
  const custom = existing.filter((c) => c.kind === 'library');
  return [...custom, ...iptv];
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

export function findChannelIconFile(channelId: string): string | null {
  try {
    const dir = iconDir();
    if (!fs.existsSync(dir)) return null;
    const hit = fs.readdirSync(dir).find((f) => f === channelId || f.startsWith(`${channelId}.`));
    if (hit) return path.join(dir, hit);
  } catch {
    // ignore
  }
  return null;
}

function clearIconFiles(channelId: string): void {
  try {
    const dir = iconDir();
    if (!fs.existsSync(dir)) return;
    for (const old of fs.readdirSync(dir).filter((f) => f === channelId || f.startsWith(`${channelId}.`))) {
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
  fs.mkdirSync(iconDir(), { recursive: true });
  clearIconFiles(channelId);
  let png = buf;
  try {
    const img = nativeImage.createFromBuffer(buf);
    if (!img.isEmpty()) png = img.toPNG();
  } catch {
    // keep original bytes
  }
  const dest = path.join(iconDir(), `${channelId}.png`);
  fs.writeFileSync(dest, png);
  return dest;
}

export function saveChannelIconFile(channelId: string, fromPath: string): string {
  if (!fromPath || !fs.existsSync(fromPath)) throw new Error('Icon file not found');
  fs.mkdirSync(iconDir(), { recursive: true });
  clearIconFiles(channelId);
  const dest = path.join(iconDir(), `${channelId}.png`);
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

  sync(settings: AppSettings): void {
    this.ffmpegPath = detectFfmpeg(settings.liveTvFfmpegPath);
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
    const s = getSettings();
    try {
      const { channels, xmltv, usedWorker } = await refreshLiveTvViaPool({
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
    }
  }

  private async fetchXtream(s: AppSettings, ua: string): Promise<LiveTvChannel[]> {
    const base = xtreamBase(s.liveTvXtreamHost, s.liveTvXtreamPort || 80);
    const user = encodeURIComponent(s.liveTvXtreamUsername);
    const pass = encodeURIComponent(s.liveTvXtreamPassword);
    const api = `${base}/player_api.php?username=${user}&password=${pass}&action=get_live_streams`;
    const catsUrl = `${base}/player_api.php?username=${user}&password=${pass}&action=get_live_categories`;
    let cats: Record<string, string> = {};
    try {
      const raw = JSON.parse(await fetchText(catsUrl, ua));
      if (Array.isArray(raw)) {
        for (const c of raw) cats[String(c.category_id)] = String(c.category_name || '');
      }
    } catch {
      cats = {};
    }
    const streams = JSON.parse(await fetchText(api, ua));
    if (!Array.isArray(streams)) throw new Error('Xtream live list was not an array');
    const ext = s.liveTvXtreamHls ? 'm3u8' : 'ts';
    return streams.map((st: Record<string, unknown>, i: number) => {
      const id = String(st.stream_id || '');
      const url = `${base}/live/${s.liveTvXtreamUsername}/${s.liveTvXtreamPassword}/${id}.${ext}`;
      return {
        id: channelId(url),
        name: String(st.name || `Stream ${id}`),
        number: i + 1,
        group: cats[String(st.category_id || '')] || '',
        logo: String(st.stream_icon || ''),
        tvgId: String(st.epg_channel_id || ''),
        url,
        enabled: false,
      };
    });
  }

  private async refreshXmltv(s: AppSettings, ua: string): Promise<void> {
    let url = (s.liveTvXmltvUrl || '').trim();
    if (!url && s.liveTvSourceType === 'xtream' && s.liveTvXtreamHost.trim()) {
      const base = xtreamBase(s.liveTvXtreamHost, s.liveTvXtreamPort || 80);
      url = `${base}/xmltv.php?username=${encodeURIComponent(s.liveTvXtreamUsername)}&password=${encodeURIComponent(s.liveTvXtreamPassword)}`;
    }
    if (!url) {
      this.xmltvMem = getLiveTvXmltvCache();
      this.reindexXmltv();
      return;
    }
    try {
      const xml = await fetchText(url, ua, 60000);
      this.xmltvMem = xml;
      setLiveTvXmltvCache(xml.length > 8_000_000 ? '' : xml);
      this.reindexXmltv();
    } catch (err) {
      this.xmltvMem = getLiveTvXmltvCache();
      this.reindexXmltv();
      if (!this.xmltvMem) throw err;
    }
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
    const settings = getSettings();
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const p = url.pathname.toLowerCase();
    res.setHeader('Access-Control-Allow-Origin', '*');
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
      let id = decodeURIComponent(p.slice('/icon/'.length).split('/')[0] || '');
      id = id.replace(/\.(png|jpg|jpeg|gif|webp|svg)$/i, '');
      const lineup = id ? getLiveTvLineup().find((c) => c.id === id) : null;
      const file = findChannelIconFile(id);
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
      res.writeHead(200, {
        'Content-Type': mimeForIcon(disk),
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      });
      fs.createReadStream(disk).pipe(res);
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
  ): ChildProcessWithoutNullStreams {
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
      const t2 = (await readStreamLimited(second, 4_000_000)).toString('utf8');
      parsed = parseHlsPlaylist(t2, mediaUrl);
    }
    if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
    const seen = new Set<string>();
    let loops = 0;
    while (!aborted() && loops < 20000) {
      loops += 1;
      const fresh = loops === 1 ? parsed : parseHlsPlaylist(
        (await readStreamLimited(await openUpstream(mediaUrl, headers, timeout), 4_000_000)).toString('utf8'),
        mediaUrl
      );
      const newSegs = fresh.segments.filter((s) => !seen.has(s.url));
      if (!newSegs.length && fresh.ended) break;
      for (const seg of newSegs) {
        if (aborted()) return;
        seen.add(seg.url);
        const segRes = await openUpstream(seg.url, headers, timeout);
        if ((segRes.statusCode || 0) >= 400) continue;
        segRes.socket?.setTimeout(0);
        await new Promise<void>((resolve, reject) => {
          segRes.on('data', (c: Buffer) => {
            if (aborted()) {
              segRes.destroy();
              resolve();
              return;
            }
            try {
              res.write(c);
            } catch (e) {
              reject(e);
            }
          });
          segRes.on('end', () => resolve());
          segRes.on('error', reject);
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
    setChild: (proc: ChildProcessWithoutNullStreams | null) => void
  ): Promise<void> {
    const ff = this.ffmpegPath;
    if (!ff) {
      this.failStream(res, cleanup, ch.name, new Error('ffmpeg is required for library channels'));
      return;
    }
    if (!res.headersSent) {
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
    }
    const days = Math.max(1, settings.liveTvFakeEpgDays || 2);
    const playFile = (file: string, offsetSec: number) =>
      new Promise<void>((resolve) => {
        if (!isAlive()) {
          resolve();
          return;
        }
        const proc = spawn(
          ff,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-ss',
            String(Math.max(0, Math.floor(offsetSec))),
            '-i',
            file,
            '-c',
            'copy',
            '-f',
            'mpegts',
            'pipe:1',
          ],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
        );
        setChild(proc);
        proc.stdout.pipe(res, { end: false });
        const done = () => resolve();
        proc.on('exit', done);
        proc.on('error', done);
        req.once('close', () => {
          try {
            proc.kill();
          } catch {
            // ignore
          }
        });
      });
    let guard = 0;
    while (isAlive() && guard < 400) {
      guard += 1;
      const slot = currentLibrarySlot(ch, days);
      if (!slot) {
        this.lastStreamError = `${ch.name}: no downloaded movies or episodes for this channel`;
        break;
      }
      const offset = Math.max(0, (Date.now() - slot.start) / 1000);
      await playFile(slot.path, offset);
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
    let child: ChildProcessWithoutNullStreams | null = null;
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
        up.socket?.setTimeout(0);
        const code = up.statusCode || 200;
        if (code >= 400) throw new Error(`Provider HTTP ${code}`);
        const ctype = String(up.headers['content-type'] || '');
        if (/mpegurl|m3u8/i.test(ctype)) {
          up.resume();
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
        const dest =
          mode === 'memory'
            ? new PassThrough({ highWaterMark: Math.max(64, settings.liveTvBufferKb || 1024) * 1024 })
            : res;
        if (mode === 'memory') dest.pipe(res);
        up.pipe(dest);
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
