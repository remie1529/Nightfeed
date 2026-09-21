/**
 * Pure Live TV playlist/XMLTV fetch+parse (no Electron).
 * Used by livetv-worker and as in-process fallback.
 */
import http from 'http';
import https from 'https';
import fs from 'fs';
import crypto from 'crypto';
import type { AppSettings, LiveTvChannel } from '../types';

const ADULT_RE = /xxx|adult|porn|erotic|18\+|nsfw|playboy/i;
const DEFAULT_UA = 'VLC/3.0.20 LibVLC/3.0.20';

export type LiveTvRefreshInput = {
  settings: AppSettings;
  existing: LiveTvChannel[];
};

export type LiveTvRefreshOutput = {
  channels: LiveTvChannel[];
  xmltv?: string;
};

function channelId(url: string): string {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
}

function isAdult(ch: { group?: string; name?: string }): boolean {
  return ADULT_RE.test(`${ch.group || ''} ${ch.name || ''}`);
}

function fetchText(url: string, ua: string, timeoutMs = 25000): Promise<string> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      reject(new Error('Bad URL'));
      return;
    }
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

function xtreamBase(host: string, port: number): string {
  let h = (host || '').trim().replace(/\/+$/, '');
  if (!h) return '';
  if (!/^https?:\/\//i.test(h)) h = `http://${h}`;
  try {
    const u = new URL(h);
    if (port && !host.includes('://') && !String(host).split('/')[0].includes(':')) {
      u.port = String(port);
    }
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
      logo: old.logoCustom && old.logo ? old.logo : c.logo,
      tvgId: old.epgCustom && old.tvgId ? old.tvgId : c.tvgId,
      logoCustom: !!old.logoCustom,
      epgCustom: !!old.epgCustom,
      fakeEpg: !!old.fakeEpg,
    };
  });
}

async function fetchXtream(s: AppSettings, ua: string): Promise<LiveTvChannel[]> {
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

export async function refreshLiveTvCore(input: LiveTvRefreshInput): Promise<LiveTvRefreshOutput> {
  const s = input.settings;
  const ua = s.liveTvUserAgent || DEFAULT_UA;
  let incoming: LiveTvChannel[] = [];

  if (s.liveTvSourceType === 'direct' && (s.liveTvDirectUrl || '').trim()) {
    const url = s.liveTvDirectUrl.trim();
    incoming = [
      {
        id: channelId(url),
        name: (s.liveTvDirectName || '').trim() || 'Live',
        number: 1,
        group: '',
        logo: '',
        tvgId: '',
        url,
        enabled: false,
      },
    ];
  } else if (s.liveTvSourceType === 'm3u' && (s.liveTvM3uUrl || '').trim()) {
    const src = s.liveTvM3uUrl.trim();
    const text = /^https?:\/\//i.test(src) ? await fetchText(src, ua) : fs.readFileSync(src, 'utf8');
    incoming = parseM3u(text);
  } else if (
    s.liveTvSourceType === 'xtream' &&
    (s.liveTvXtreamHost || '').trim() &&
    s.liveTvXtreamUsername
  ) {
    incoming = await fetchXtream(s, ua);
  }

  if (s.liveTvHideAdult) incoming = incoming.filter((c) => !isAdult(c));
  const channels = mergeLineup(incoming, input.existing || []);

  let xmltv: string | undefined;
  let xmlUrl = (s.liveTvXmltvUrl || '').trim();
  if (!xmlUrl && s.liveTvSourceType === 'xtream' && (s.liveTvXtreamHost || '').trim()) {
    const base = xtreamBase(s.liveTvXtreamHost, s.liveTvXtreamPort || 80);
    xmlUrl = `${base}/xmltv.php?username=${encodeURIComponent(s.liveTvXtreamUsername)}&password=${encodeURIComponent(s.liveTvXtreamPassword)}`;
  }
  if (xmlUrl) {
    try {
      const xml = await fetchText(xmlUrl, ua, 60000);
      xmltv = xml.length > 8_000_000 ? '' : xml;
    } catch {
      xmltv = undefined;
    }
  }

  return { channels, xmltv };
}
