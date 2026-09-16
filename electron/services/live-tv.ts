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
import type { AppSettings, LiveTvChannel, LiveTvStatus } from '../types';
import { getLiveTvLineup, getLiveTvXmltvCache, getSettings, setLiveTvLineup, setLiveTvXmltvCache } from './store';

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

function parseM3u(text: string): LiveTvChannel[] {
  const lines = text.split(/\r?\n/);
  const out: LiveTvChannel[] = [];
  let meta: { name: string; group: string; logo: string; tvgId: string } | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
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
    if (!/^https?:\/\//i.test(line)) continue;
    const info = meta || { name: 'Channel', group: '', logo: '', tvgId: '' };
    out.push({
      id: channelId(line),
      name: info.name,
      number: out.length + 1,
      group: info.group,
      logo: info.logo,
      tvgId: info.tvgId,
      url: line,
      enabled: false,
    });
    meta = null;
  }
  return out;
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
  return incoming.map((c, i) => {
    const old = prev.get(c.id);
    if (!old) return { ...c, number: c.number || i + 1, enabled: false };
    return {
      ...c,
      enabled: old.enabled,
      number: old.number || c.number || i + 1,
      name: old.name && old.name !== c.name ? old.name : c.name,
    };
  });
}

class LiveTvServer {
  private server: http.Server | null = null;
  private slots = new Map<string, TunerSlot>();
  private lastError: string | null = null;
  private lastRefresh: string | null = null;
  private xmltvMem = '';
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
      lastError: this.lastError,
      lastRefresh: this.lastRefresh,
      tunerUrl: `http://${host}:${port}`,
      xmltvUrl: `http://${host}:${port}/xmltv.xml`,
      active: [...this.slots.values()].map((s) => ({ number: s.number, name: s.name })),
    };
  }

  enabledChannels(): LiveTvChannel[] {
    return getLiveTvLineup()
      .filter((c) => c.enabled && c.url)
      .sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));
  }

  async refreshSources(): Promise<LiveTvChannel[]> {
    const s = getSettings();
    const ua = s.liveTvUserAgent || DEFAULT_UA;
    let incoming: LiveTvChannel[] = [];
    try {
      if (s.liveTvSourceType === 'direct' && s.liveTvDirectUrl.trim()) {
        const url = s.liveTvDirectUrl.trim();
        incoming = [
          {
            id: channelId(url),
            name: s.liveTvDirectName.trim() || 'Live',
            number: 1,
            group: '',
            logo: '',
            tvgId: '',
            url,
            enabled: false,
          },
        ];
      } else if (s.liveTvSourceType === 'm3u' && s.liveTvM3uUrl.trim()) {
        const src = s.liveTvM3uUrl.trim();
        const text = /^https?:\/\//i.test(src) ? await fetchText(src, ua) : fs.readFileSync(src, 'utf8');
        incoming = parseM3u(text);
      } else if (s.liveTvSourceType === 'xtream' && s.liveTvXtreamHost.trim() && s.liveTvXtreamUsername) {
        incoming = await this.fetchXtream(s, ua);
      }
      if (s.liveTvHideAdult) incoming = incoming.filter((c) => !isAdult(c));
      const merged = mergeLineup(incoming, getLiveTvLineup());
      setLiveTvLineup(merged);
      this.lastRefresh = new Date().toISOString();
      this.lastError = null;
      await this.refreshXmltv(s, ua);
      return merged;
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
      return;
    }
    try {
      const xml = await fetchText(url, ua, 60000);
      this.xmltvMem = xml;
      setLiveTvXmltvCache(xml.length > 8_000_000 ? '' : xml);
    } catch (err) {
      this.xmltvMem = getLiveTvXmltvCache();
      if (!this.xmltvMem) throw err;
    }
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
      const rows = this.enabledChannels().map((c) => ({
        GuideNumber: String(c.number),
        GuideName: c.name,
        URL: `${base}/auto/v${c.number}`,
      }));
      this.json(res, rows);
      return;
    }
    if (p === '/lineup.post') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (p === '/xmltv.xml' || p === '/xmltv') {
      const xml = this.xmltvMem || getLiveTvXmltvCache() || '<?xml version="1.0"?><tv></tv>';
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(xml);
      return;
    }
    const auto = p.match(/^\/auto\/v(\d+)/);
    if (auto) {
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
    const max = settings.liveTvTuners || 3;
    if (this.slots.size >= max) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('All tuners in use');
      return;
    }
    const slotId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ua = settings.liveTvUserAgent || DEFAULT_UA;
    let child: ChildProcessWithoutNullStreams | null = null;
    let upstream: http.ClientRequest | null = null;
    const cleanup = () => {
      this.slots.delete(slotId);
      try {
        child?.kill();
      } catch {
        // ignore
      }
      try {
        upstream?.destroy();
      } catch {
        // ignore
      }
    };
    this.slots.set(slotId, { number, name: ch.name, req, cleanup });
    req.on('close', cleanup);
    res.on('close', cleanup);

    const mode = settings.liveTvBufferMode;
    const ff = this.ffmpegPath;
    if (mode === 'ffmpeg' && ff) {
      child = spawn(
        ff,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-user_agent',
          ua,
          '-reconnect',
          '1',
          '-reconnect_streamed',
          '1',
          '-i',
          ch.url,
          '-c',
          'copy',
          '-f',
          'mpegts',
          'pipe:1',
        ],
        { windowsHide: true }
      );
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
      child.stdout.pipe(res);
      child.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
        cleanup();
      });
      child.on('exit', () => cleanup());
      return;
    }

    try {
      const u = new URL(ch.url);
      const lib = u.protocol === 'https:' ? https : http;
      upstream = lib.request(
        {
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          method: 'GET',
          headers: { 'User-Agent': ua, Accept: '*/*' },
          timeout: settings.liveTvBufferTimeoutMs || 8000,
        },
        (up) => {
          const code = up.statusCode || 200;
          if (code >= 300 && code < 400 && up.headers.location) {
            up.resume();
            ch.url = new URL(up.headers.location, ch.url).toString();
            this.slots.delete(slotId);
            this.streamChannel(number, req, res, settings);
            return;
          }
          if (code >= 400) {
            if (!res.headersSent) res.writeHead(code);
            res.end();
            cleanup();
            return;
          }
          res.writeHead(200, {
            'Content-Type': up.headers['content-type'] || 'video/mp2t',
            'Cache-Control': 'no-store',
          });
          const dest =
            mode === 'memory'
              ? new PassThrough({ highWaterMark: Math.max(64, settings.liveTvBufferKb || 1024) * 1024 })
              : res;
          if (mode === 'memory') dest.pipe(res);
          up.pipe(dest);
        }
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
        cleanup();
      });
      upstream.on('timeout', () => {
        upstream?.destroy();
        cleanup();
      });
      upstream.end();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) res.writeHead(502);
      res.end();
      cleanup();
    }
  }
}

const DEFAULT_UA = 'VLC/3.0.20 LibVLC/3.0.20';

export const liveTv = new LiveTvServer();
export { parseM3u, isAdult };
