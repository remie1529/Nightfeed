/**
 * Pure XMLTV, HLS, and stream-header helpers for Live TV (no Electron imports).
 */
import type { LiveTvEpgOption } from '../types';

export function xmlEsc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function xmlUnesc(s: string): string {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = Number(n);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    })
    .replace(/&amp;/g, '&');
}

export function xmltvTs(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const ah = Math.floor(Math.abs(off) / 60);
  const am = Math.abs(off) % 60;
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())} ${sign}${p(ah)}${p(am)}`;
}

export function parseXmltvChannels(xml: string): LiveTvEpgOption[] {
  const out: LiveTvEpgOption[] = [];
  const seen = new Set<string>();
  const re = /<channel\b[^>]*\bid=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/channel>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const rawId = m[1] ?? m[2] ?? '';
    const id = xmlUnesc(rawId).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const body = m[3] || '';
    const nameMatch = body.match(/<display-name[^>]*>([^<]+)<\/display-name>/i);
    const name = nameMatch ? xmlUnesc(nameMatch[1]).trim() : id;
    out.push({ id, name: name || id });
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return out;
}

/** O(N) XMLTV programme indexer keyed by unescaped channel id. */
export function indexXmltvProgrammes(xml: string): Map<string, string> {
  const buckets = new Map<string, string[]>();
  const re = /<programme\b[^>]*\bchannel=(?:"([^"]+)"|'([^']+)')[^>]*>[\s\S]*?<\/programme>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const rawId = m[1] ?? m[2] ?? '';
    const id = xmlUnesc(rawId).trim();
    if (!id) continue;
    let list = buckets.get(id);
    if (!list) {
      list = [];
      buckets.set(id, list);
    }
    list.push(m[0]);
  }
  const map = new Map<string, string>();
  for (const [id, list] of buckets.entries()) {
    map.set(id, list.join('\n') + '\n');
  }
  return map;
}

/** Rewrite channel="..." attributes on cached <programme> blocks when aliasing an EPG feed. */
export function rewriteProgrammeChannel(programmesXml: string, targetChannelId: string): string {
  const escaped = xmlEsc(targetChannelId);
  return programmesXml.replace(
    /(<programme\b[^>]*\bchannel=)(?:"[^"]*"|'[^']*')/gi,
    `$1"${escaped}"`
  );
}

export function fakeProgrammesXml(channelId: string, title: string, minutes: number, days: number): string {
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

export function parseStreamTarget(raw: string): { url: string; headers: Record<string, string> } {
  const parts = String(raw || '').split('|');
  const url = (parts[0] || '').trim();
  const headers: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    let k = p.slice(0, i).trim().replace(/[\r\n:]/g, '');
    const v = p.slice(i + 1).trim().replace(/[\r\n]/g, '');
    if (/^(http-)?user-agent$/i.test(k)) k = 'User-Agent';
    else if (/^(http-)?referr?er$/i.test(k)) k = 'Referer';
    else if (/^(http-)?origin$/i.test(k)) k = 'Origin';
    if (k && v) headers[k] = v;
  }
  return { url, headers };
}

/** Build ffmpeg `-headers` value for all non-User-Agent headers, stripping CR/LF injection. */
export function buildFfmpegHeadersArg(headers: Record<string, string>): string {
  const lines: string[] = [];
  for (const [rawKey, rawVal] of Object.entries(headers || {})) {
    const k = String(rawKey || '').trim().replace(/[\r\n:]/g, '');
    const v = String(rawVal || '').trim().replace(/[\r\n]/g, '');
    if (!k || !v || /^user-agent$/i.test(k)) continue;
    lines.push(`${k}: ${v}\r\n`);
  }
  return lines.join('');
}

export interface ParsedHlsPlaylist {
  variants: { bw: number; url: string }[];
  segments: { url: string; dur: number }[];
  target: number;
  ended: boolean;
  fmp4: boolean;
  encrypted: boolean;
}

export function parseHlsPlaylist(text: string, baseUrl: string): ParsedHlsPlaylist {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants: { bw: number; url: string }[] = [];
  const segments: { url: string; dur: number }[] = [];
  let pendingBw = 0;
  let pendingDur = 6;
  let target = 6;
  let ended = false;
  let fmp4 = false;
  let encrypted = false;
  let expectVariantUrl = false;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      target = Math.max(1, Number(line.split(':')[1]) || 6);
      continue;
    }
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      expectVariantUrl = true;
      const m = line.match(/BANDWIDTH=(\d+)/i);
      pendingBw = m ? Number(m[1]) : 0;
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      expectVariantUrl = false;
      pendingDur = Number(line.slice(8).split(',')[0]) || target;
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) fmp4 = true;
    if (line.startsWith('#EXT-X-KEY:') && !/METHOD=NONE/i.test(line)) encrypted = true;
    if (line === '#EXT-X-ENDLIST') ended = true;
    if (line.startsWith('#')) continue;
    let abs: string;
    try {
      abs = new URL(line, baseUrl).toString();
    } catch {
      continue;
    }
    if (expectVariantUrl) {
      variants.push({ bw: pendingBw, url: abs });
      pendingBw = 0;
      expectVariantUrl = false;
    } else {
      segments.push({ url: abs, dur: pendingDur });
    }
  }
  return { variants, segments, target, ended, fmp4, encrypted };
}
