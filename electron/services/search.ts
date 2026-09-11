import { AppSettings, Resolution, SearchResult, TorrentSourceId, DEFAULT_TORRENT_SOURCES } from '../types';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function buildQuery(showName: string, season: number, episode: number): string {
  return `${showName} S${pad2(season)}E${pad2(episode)}`;
}

/** Auto-download / retry skip torrents at or below this — 0–5 seeders almost never complete. */
export const MIN_AUTO_SEEDERS = 8;

export function resolutionRank(res: Resolution | null | undefined): number {
  if (res === '2160p') return 3;
  if (res === '1080p') return 2;
  if (res === '720p') return 1;
  return 0;
}

export function meetsMinResolution(actual: Resolution | null | undefined, minimum: Resolution): boolean {
  return resolutionRank(actual) >= resolutionRank(minimum);
}

export interface QualityRules {
  preferred: Resolution;
  minimum: Resolution;
  minSizeMb: { '720p': number; '1080p': number; '2160p': number };
}

export function detectResolution(title: string): Resolution | null {
  const t = (title || '').toLowerCase().replace(/[._]/g, ' ');
  if (/\b(2160p|3840\s*[x×]\s*2160|uhd|4k)\b/.test(t)) return '2160p';
  if (/\b(1080p|1080i|1920\s*[x×]\s*1080|full\s*hd|\bfhd\b)\b/.test(t)) return '1080p';
  if (/\b(720p|1280\s*[x×]\s*720)\b/.test(t)) return '720p';
  return null;
}

export function isJunkRelease(title: string): boolean {
  const t = (title || '').toLowerCase().replace(/[._]/g, ' ');
  return /\b(camrip|hdcam|\bcam\b|telesync|\bts\b|\btc\b|dvdscr|screener|\bscr\b|workprint|\bwp\b|r5|trailer|teaser|\bsample\b)\b/.test(
    t
  );
}

function isMultiEpisodePack(title: string): boolean {
  const t = (title || '').replace(/[._]/g, ' ');
  if (/s\d{2}e\d{2}\s*[-–to]+\s*(s\d{2}e)?\d{2}/i.test(t)) return true;
  if (/\be\d{2}\s*[-–]\s*e\d{2}\b/i.test(t)) return true;
  if (/\bcomplete\s+(season|series)\b/i.test(t)) return true;
  if (/\bseason\s+\d+\b/i.test(t) && !/s\d{2}e\d{2}/i.test(t)) return true;
  return false;
}

function sizeOkForAuto(
  size: number,
  kind: 'episode' | 'movie',
  res: Resolution | null,
  rules?: QualityRules
): boolean {
  if (!size) return true;
  const cap = kind === 'episode' ? 8 * 1024 * 1024 * 1024 : 50 * 1024 * 1024 * 1024;
  if (size > cap) return false;
  const key = res || rules?.minimum || rules?.preferred;
  const minMb = key && rules?.minSizeMb ? rules.minSizeMb[key] : 0;
  if (minMb > 0 && size < minMb * 1024 * 1024) return false;
  if (kind === 'episode' && size < 80 * 1024 * 1024) return false;
  if (kind === 'movie' && size < 400 * 1024 * 1024) return false;
  return true;
}

export function rankResults(results: SearchResult[], preferred: Resolution): SearchResult[] {
  const score = (r: SearchResult): number => {
    const seeds = r.seeders || 0;
    let s = 0;
    if (r.resolution === preferred) s += 5_000_000;
    else if (r.resolution) s += 150_000;
    if (seeds <= 0) s -= 4_000_000;
    else if (seeds < MIN_AUTO_SEEDERS) s -= 2_000_000;
    else s += Math.min(seeds, 8000) * 25;
    if (isJunkRelease(r.title || '')) s -= 8_000_000;
    s += Math.min(r.leechers || 0, 80);
    return s;
  };
  return [...results].sort((a, b) => score(b) - score(a) || (b.seeders || 0) - (a.seeders || 0));
}

/** Best torrent: preferred first, never below minimum, enough seeders, not junk. */
export function pickAutoDownload(
  results: SearchResult[],
  preferred: Resolution,
  kind: 'episode' | 'movie' = 'episode',
  rules?: QualityRules
): SearchResult | null {
  const minimum = rules?.minimum || preferred;
  const pool = (results || []).filter((r) => {
    if (!r?.magnet) return false;
    if ((r.seeders || 0) < MIN_AUTO_SEEDERS) return false;
    if (isJunkRelease(r.title || '')) return false;
    if (r.resolution && !meetsMinResolution(r.resolution, minimum)) return false;
    if (!r.resolution && resolutionRank(preferred) > resolutionRank(minimum)) {
      // Unknown label: only keep if size meets the minimum rung
      if (!sizeOkForAuto(r.size || 0, kind, minimum, rules)) return false;
    } else if (!sizeOkForAuto(r.size || 0, kind, r.resolution, rules)) {
      return false;
    }
    return true;
  });
  if (!pool.length) return null;
  pool.sort((a, b) => {
    const ap = a.resolution === preferred ? 1 : 0;
    const bp = b.resolution === preferred ? 1 : 0;
    if (bp !== ap) return bp - ap;
    const ar = resolutionRank(a.resolution);
    const br = resolutionRank(b.resolution);
    if (br !== ar) return br - ar;
    return (b.seeders || 0) - (a.seeders || 0);
  });
  return pool[0];
}

export function filterQualityResults(
  results: SearchResult[],
  preferred: Resolution,
  kind: 'episode' | 'movie',
  rules?: QualityRules
): SearchResult[] {
  const minimum = rules?.minimum || preferred;
  return (results || []).filter((r) => {
    if (!r?.magnet) return false;
    if ((r.seeders || 0) < MIN_AUTO_SEEDERS) return false;
    if (r.resolution && !meetsMinResolution(r.resolution, minimum)) return false;
    if (!sizeOkForAuto(r.size || 0, kind, r.resolution || minimum, rules)) return false;
    return true;
  });
}

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker1.bt.moack.co.kr:80/announce',
  'udp://tracker.theoks.net:6969/announce',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.files.fm:7073/announce',
];

function buildMagnet(hash: string, name: string): string {
  let magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}`;
  for (const tr of TRACKERS) {
    magnet += `&tr=${encodeURIComponent(tr)}`;
  }
  return magnet;
}

export function extractInfoHash(magnetOrHash: string): string {
  const raw = (magnetOrHash || '').trim();
  if (/^[a-fA-F0-9]{40}$/.test(raw)) return raw.toLowerCase();
  if (/^[a-zA-Z2-7]{32}$/.test(raw)) return raw.toLowerCase();
  const m = raw.match(/btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  return m ? m[1].toLowerCase() : '';
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(s: string): string {
  return decodeHtmlEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseSizeToBytes(text: string): number {
  const m = text.replace(/,/g, '').match(/([\d.]+)\s*(TiB|GiB|MiB|KiB|TB|GB|MB|KB|B)\b/i);
  if (!m) {
    const n = parseInt(text.replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
  }
  const value = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const mult: Record<string, number> = {
    B: 1,
    KB: 1000,
    KIB: 1024,
    MB: 1000 ** 2,
    MIB: 1024 ** 2,
    GB: 1000 ** 3,
    GIB: 1024 ** 3,
    TB: 1000 ** 4,
    TIB: 1024 ** 4,
  };
  return Math.round(value * (mult[unit] || 1));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function episodeTag(season: number, episode: number): string {
  return `S${pad2(season)}E${pad2(episode)}`;
}

function titleMatchesEpisode(title: string, season: number, episode: number): boolean {
  const t = title.toLowerCase();
  const tag = episodeTag(season, episode).toLowerCase();
  if (t.includes(tag)) return true;
  // also accept 1x01 style
  const alt = `${season}x${pad2(episode)}`.toLowerCase();
  if (t.includes(alt)) return true;
  return false;
}

/** Normalize IMDb id to digits-only for EZTV (strips leading "tt"). */
export function imdbNumericId(imdbId: string | null | undefined): string | null {
  if (!imdbId) return null;
  const m = String(imdbId).trim().match(/^(?:tt)?(\d+)$/i);
  return m ? m[1] : null;
}

interface ApibayItem {
  id: string;
  name: string;
  info_hash: string;
  leechers: string;
  seeders: string;
  size: string;
}

function mapApibayItems(data: ApibayItem[], query: string): SearchResult[] {
  if (!Array.isArray(data) || data.length === 0) return [];
  if (data.length === 1 && (data[0].name === 'No results returned' || data[0].id === '0')) {
    return [];
  }
  return data.map((item) => {
    const hash = (item.info_hash || '').toLowerCase();
    return {
      title: item.name,
      magnet: buildMagnet(hash, item.name || query),
      size: parseInt(item.size, 10) || 0,
      seeders: parseInt(item.seeders, 10) || 0,
      leechers: parseInt(item.leechers, 10) || 0,
      source: 'apibay',
      resolution: detectResolution(item.name || ''),
      infoHash: hash,
    };
  });
}

async function searchApibay(query: string, cat = 205): Promise<SearchResult[]> {
  const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=${cat}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Apibay HTTP ${res.status}`);
  const data = (await res.json()) as ApibayItem[];
  let results = mapApibayItems(data, query);
  if (results.length === 0) {
    const fallback = await fetchWithTimeout(`https://apibay.org/q.php?q=${encodeURIComponent(query)}`);
    if (fallback.ok) {
      results = mapApibayItems((await fallback.json()) as ApibayItem[], query);
    }
  }
  return results;
}

async function searchKnaben(query: string): Promise<SearchResult[]> {
  const res = await fetchWithTimeout(
    'https://api.knaben.org/v1',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, size: 50, search_type: '100%' }),
    },
    20000
  );
  if (!res.ok) throw new Error(`Knaben HTTP ${res.status}`);
  const data = (await res.json()) as {
    hits?: Array<{
      title?: string;
      hash?: string;
      magnetUrl?: string | null;
      bytes?: number;
      seeders?: number;
      peers?: number;
    }>;
  };
  const results: SearchResult[] = [];
  for (const hit of data.hits || []) {
    const title = hit.title || '';
    const hash = (hit.hash || extractInfoHash(hit.magnetUrl || '')).toLowerCase();
    if (!title || !hash) continue;
    const magnet =
      hit.magnetUrl && hit.magnetUrl.startsWith('magnet:')
        ? hit.magnetUrl
        : buildMagnet(hash, title);
    results.push({
      title,
      magnet,
      size: hit.bytes || 0,
      seeders: hit.seeders || 0,
      leechers: Math.max(0, (hit.peers || 0) - (hit.seeders || 0)),
      source: 'knaben',
      resolution: detectResolution(title),
      infoHash: hash,
    });
  }
  return results;
}

async function searchYourBittorrent(query: string, category = 'television'): Promise<SearchResult[]> {
  const url =
    `https://yourbittorrent.com/api/search.json?q=${encodeURIComponent(query)}` +
    `&category=${encodeURIComponent(category)}&limit=50&sort=seeds`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`YourBittorrent HTTP ${res.status}`);
  const data = (await res.json()) as {
    results?: Array<{
      name?: string;
      infohash?: string;
      magnet?: string;
      size_bytes?: number;
      seeds?: number;
      peers?: number;
    }>;
  };
  const results: SearchResult[] = [];
  for (const item of data.results || []) {
    const title = item.name || '';
    const hash = (item.infohash || extractInfoHash(item.magnet || '')).toLowerCase();
    if (!title || !hash) continue;
    const magnet =
      item.magnet && item.magnet.startsWith('magnet:')
        ? item.magnet
        : buildMagnet(hash, title);
    results.push({
      title,
      magnet,
      size: item.size_bytes || 0,
      seeders: item.seeds || 0,
      leechers: Math.max(0, (item.peers || 0) - (item.seeds || 0)),
      source: 'yourbittorrent',
      resolution: detectResolution(title),
      infoHash: hash,
    });
  }
  return results;
}

async function searchTorrentsCsv(query: string): Promise<SearchResult[]> {
  const url = `https://torrents-csv.com/service/search?q=${encodeURIComponent(query)}&size=50`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`TorrentsCSV HTTP ${res.status}`);
  const data = (await res.json()) as {
    torrents?: Array<{
      infohash?: string;
      name?: string;
      size_bytes?: number;
      seeders?: number;
      leechers?: number;
    }>;
  };
  const results: SearchResult[] = [];
  for (const item of data.torrents || []) {
    const title = item.name || '';
    const hash = (item.infohash || '').toLowerCase();
    if (!title || !hash) continue;
    results.push({
      title,
      magnet: buildMagnet(hash, title),
      size: item.size_bytes || 0,
      seeders: item.seeders || 0,
      leechers: item.leechers || 0,
      source: 'torrentscsv',
      resolution: detectResolution(title),
      infoHash: hash,
    });
  }
  return results;
}

async function searchEztv(
  imdbId: string | null | undefined,
  season: number,
  episode: number
): Promise<SearchResult[]> {
  const numeric = imdbNumericId(imdbId);
  if (!numeric) return []; // skip quietly when no IMDb id

  const url = `https://eztvx.to/api/get-torrents?imdb_id=${encodeURIComponent(numeric)}&limit=100`;
  const res = await fetchWithTimeout(url, {}, 20000);
  if (!res.ok) throw new Error(`EZTV HTTP ${res.status}`);
  const data = (await res.json()) as {
    torrents?: Array<{
      title?: string;
      filename?: string;
      hash?: string;
      magnet_url?: string;
      size_bytes?: string | number;
      seeds?: number;
      peers?: number;
      season?: string | number;
      episode?: string | number;
    }>;
  };
  const results: SearchResult[] = [];
  for (const item of data.torrents || []) {
    const title = item.title || item.filename || '';
    if (!title) continue;
    const seasonNum = parseInt(String(item.season ?? ''), 10);
    const episodeNum = parseInt(String(item.episode ?? ''), 10);
    const matches =
      (Number.isFinite(seasonNum) &&
        Number.isFinite(episodeNum) &&
        seasonNum === season &&
        episodeNum === episode) ||
      titleMatchesEpisode(title, season, episode);
    if (!matches) continue;
    const hash = (item.hash || extractInfoHash(item.magnet_url || '')).toLowerCase();
    if (!hash) continue;
    const magnet =
      item.magnet_url && item.magnet_url.startsWith('magnet:')
        ? item.magnet_url
        : buildMagnet(hash, title);
    results.push({
      title,
      magnet,
      size: parseInt(String(item.size_bytes || '0'), 10) || 0,
      seeders: item.seeds || 0,
      leechers: Math.max(0, (item.peers || 0) - (item.seeds || 0)),
      source: 'eztv',
      resolution: detectResolution(title),
      infoHash: hash,
    });
  }
  return results;
}

async function searchAnimeTosho(query: string): Promise<SearchResult[]> {
  const url = `https://feed.animetosho.org/json?q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url, {}, 20000);
  if (!res.ok) throw new Error(`AnimeTosho HTTP ${res.status}`);
  const data = (await res.json()) as Array<{
    title?: string;
    magnet_uri?: string;
    info_hash?: string;
    total_size?: number;
    seeders?: number;
    leechers?: number;
  }>;
  if (!Array.isArray(data)) return [];
  const results: SearchResult[] = [];
  for (const item of data) {
    const title = item.title || '';
    const hash = (item.info_hash || extractInfoHash(item.magnet_uri || '')).toLowerCase();
    if (!title || !hash) continue;
    const magnet =
      item.magnet_uri && item.magnet_uri.startsWith('magnet:')
        ? item.magnet_uri
        : buildMagnet(hash, title);
    results.push({
      title,
      magnet,
      size: item.total_size || 0,
      seeders: item.seeders || 0,
      leechers: item.leechers || 0,
      source: 'animetosho',
      resolution: detectResolution(title),
      infoHash: hash,
    });
  }
  return results;
}

function parseRssItems(xml: string): string[] {
  const items: string[] = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) items.push(m[1]);
  return items;
}

function rssTag(item: string, localName: string): string {
  // Match both plain and namespaced tags: <title>, <nyaa:infoHash>, etc.
  const re = new RegExp(
    `<(?:[a-zA-Z0-9_]+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_]+:)?${localName}>`,
    'i'
  );
  const m = item.match(re);
  return m ? stripTags(m[1]) : '';
}

function rssAttr(item: string, tag: string, attr: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}=["']([^"']+)["'][^>]*/?>`, 'i');
  const m = item.match(re);
  return m ? decodeHtmlEntities(m[1]) : '';
}

async function searchNyaa(query: string): Promise<SearchResult[]> {
  const url = `https://nyaa.si/?page=rss&q=${encodeURIComponent(query)}&c=0_0&f=0`;
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' } }, 20000);
  if (!res.ok) throw new Error(`Nyaa HTTP ${res.status}`);
  const xml = await res.text();
  const results: SearchResult[] = [];
  for (const item of parseRssItems(xml)) {
    const title = rssTag(item, 'title');
    if (!title) continue;
    let magnet = '';
    const magnetHref = item.match(/href=["'](magnet:\?[^"']+)["']/i);
    if (magnetHref) magnet = decodeHtmlEntities(magnetHref[1]);
    const infoHash =
      rssTag(item, 'infoHash') ||
      extractInfoHash(magnet) ||
      extractInfoHash(rssAttr(item, 'enclosure', 'url'));
    const hash = infoHash.toLowerCase();
    if (!hash) continue;
    if (!magnet.startsWith('magnet:')) magnet = buildMagnet(hash, title);
    const sizeText = rssTag(item, 'size');
    const seeders = parseInt(rssTag(item, 'seeders') || '0', 10) || 0;
    const leechers = parseInt(rssTag(item, 'leechers') || '0', 10) || 0;
    results.push({
      title,
      magnet,
      size: parseSizeToBytes(sizeText),
      seeders,
      leechers,
      source: 'nyaa',
      resolution: detectResolution(title),
      infoHash: hash,
    });
  }
  return results;
}

/** LimeTorrents RSS — infohash embedded in itorrents enclosure URL. */
async function searchLimeTorrents(query: string): Promise<SearchResult[]> {
  const url = `https://www.limetorrents.fun/searchrss/${encodeURIComponent(query)}/`;
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' } }, 20000);
  if (!res.ok) throw new Error(`LimeTorrents HTTP ${res.status}`);
  const xml = await res.text();
  const results: SearchResult[] = [];
  for (const item of parseRssItems(xml)) {
    const title = rssTag(item, 'title');
    if (!title) continue;
    const enclosure = rssAttr(item, 'enclosure', 'url');
    const hashMatch = enclosure.match(/\/torrent\/([a-fA-F0-9]{40})\.torrent/i);
    const hash = (hashMatch?.[1] || extractInfoHash(enclosure)).toLowerCase();
    if (!hash) continue;
    const sizeRaw = rssTag(item, 'size');
    const size = /^\d+$/.test(sizeRaw) ? parseInt(sizeRaw, 10) : parseSizeToBytes(sizeRaw);
    const desc = rssTag(item, 'description');
    const seedMatch = desc.match(/Seeds?:\s*([\d,]+)/i);
    const leechMatch = desc.match(/Leechers?\s*([\d,]+)/i);
    const seeders = seedMatch ? parseInt(seedMatch[1].replace(/,/g, ''), 10) || 0 : 0;
    const leechers = leechMatch ? parseInt(leechMatch[1].replace(/,/g, ''), 10) || 0 : 0;
    results.push({
      title,
      magnet: buildMagnet(hash, title),
      size: size || 0,
      seeders,
      leechers,
      source: 'limetorrents',
      resolution: detectResolution(title),
      infoHash: hash,
    });
  }
  return results;
}

async function searchJackett(settings: AppSettings, query: string, category = 5000): Promise<SearchResult[]> {
  if (!settings.jackettUrl || !settings.jackettApiKey) {
    throw new Error('Jackett URL and API key are required when Jackett is enabled.');
  }
  const base = settings.jackettUrl.replace(/\/$/, '');
  const url =
    `${base}/api/v2.0/indexers/all/results?apikey=${encodeURIComponent(settings.jackettApiKey)}` +
    `&Query=${encodeURIComponent(query)}&Category[]=${category}`;
  const res = await fetchWithTimeout(url, {}, 30000);
  if (!res.ok) throw new Error(`Jackett HTTP ${res.status}`);
  const data = (await res.json()) as {
    Results?: Array<{
      Title: string;
      MagnetUri?: string;
      Link?: string;
      Size: number;
      Seeders: number;
      Peers: number;
      Tracker?: string;
      InfoHash?: string;
    }>;
  };
  const results: SearchResult[] = [];
  for (const item of data.Results || []) {
    const magnet = item.MagnetUri || '';
    if (!magnet.startsWith('magnet:')) continue;
    const infoHash = (item.InfoHash || extractInfoHash(magnet)).toLowerCase();
    results.push({
      title: item.Title,
      magnet,
      size: item.Size || 0,
      seeders: item.Seeders || 0,
      leechers: Math.max(0, (item.Peers || 0) - (item.Seeders || 0)),
      source: item.Tracker || 'jackett',
      resolution: detectResolution(item.Title || ''),
      infoHash,
    });
  }
  return results;
}

function normalizeResult(r: SearchResult): SearchResult {
  const infoHash = (r.infoHash || extractInfoHash(r.magnet)).toLowerCase();
  return { ...r, infoHash: infoHash || r.infoHash };
}

/** Merge results from multiple sources; keep the highest-seeder copy per infohash. */
export function mergeByInfoHash(groups: SearchResult[][]): SearchResult[] {
  const map = new Map<string, SearchResult>();
  const noHash: SearchResult[] = [];
  for (const group of groups) {
    for (const raw of group) {
      const r = normalizeResult(raw);
      const key = r.infoHash || '';
      if (!key) {
        noHash.push(r);
        continue;
      }
      const prev = map.get(key);
      if (!prev || (r.seeders || 0) > (prev.seeders || 0)) {
        map.set(key, r);
      }
    }
  }
  return [...map.values(), ...noHash];
}

export function enabledTorrentSources(settings: AppSettings): TorrentSourceId[] {
  const src = { ...DEFAULT_TORRENT_SOURCES, ...(settings.torrentSources || {}) };
  const order: TorrentSourceId[] = [
    'apibay',
    'knaben',
    'yourbittorrent',
    'torrentscsv',
    'eztv',
    'animetosho',
    'nyaa',
    'limetorrents',
    'jackett',
  ];
  const out = order.filter((id) => !!src[id]);
  // Safety: never search nothing
  if (out.length === 0) {
    return order.filter((id) => id !== 'jackett');
  }
  return out;
}

export interface SearchEpisodeOpts {
  imdbId?: string | null;
  mazeId?: number;
}

export async function searchEpisodeTorrents(
  settings: AppSettings,
  showName: string,
  season: number,
  episode: number,
  preferred: Resolution,
  opts: SearchEpisodeOpts = {}
): Promise<{ results: SearchResult[]; query: string; error?: string }> {
  const query = buildQuery(showName, season, episode);
  const sources = enabledTorrentSources(settings);
  const errors: string[] = [];
  const groups: SearchResult[][] = [];

  const run = (label: string, fn: () => Promise<SearchResult[]>) =>
    fn()
      .then((r) => {
        groups.push(r);
      })
      .catch((err) => {
        errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      });

  const runners: Array<Promise<void>> = [];

  if (sources.includes('apibay')) runners.push(run('Apibay', () => searchApibay(query)));
  if (sources.includes('knaben')) runners.push(run('Knaben', () => searchKnaben(query)));
  if (sources.includes('yourbittorrent')) {
    runners.push(run('YourBittorrent', () => searchYourBittorrent(query)));
  }
  if (sources.includes('torrentscsv')) {
    runners.push(run('TorrentsCSV', () => searchTorrentsCsv(query)));
  }
  if (sources.includes('eztv')) {
    runners.push(run('EZTV', () => searchEztv(opts.imdbId, season, episode)));
  }
  if (sources.includes('animetosho')) {
    runners.push(run('AnimeTosho', () => searchAnimeTosho(query)));
  }
  if (sources.includes('nyaa')) runners.push(run('Nyaa', () => searchNyaa(query)));
  if (sources.includes('limetorrents')) {
    runners.push(run('LimeTorrents', () => searchLimeTorrents(query)));
  }
  if (sources.includes('jackett')) {
    runners.push(run('Jackett', () => searchJackett(settings, query)));
  }

  await Promise.all(runners);

  const merged = mergeByInfoHash(groups);
  const episodeOnly = merged.filter(
    (r) => titleMatchesEpisode(r.title || '', season, episode) && !isMultiEpisodePack(r.title || '')
  );
  const ranked = rankResults(episodeOnly.length ? episodeOnly : merged, preferred);
  const error = errors.length > 0 ? errors.join(' | ') : undefined;

  return { results: ranked, query, error };
}

export function buildMovieQuery(title: string, year?: number | null): string {
  const t = (title || '').trim();
  if (year) return `${t} ${year}`;
  return t;
}

/** Movie torrent search — skips EZTV (TV-only); prefers movie categories where supported. */
export async function searchMovieTorrents(
  settings: AppSettings,
  title: string,
  year: number | null | undefined,
  preferred: Resolution
): Promise<{ results: SearchResult[]; query: string; error?: string }> {
  const query = buildMovieQuery(title, year);
  const sources = enabledTorrentSources(settings).filter((id) => id !== 'eztv');
  const errors: string[] = [];
  const groups: SearchResult[][] = [];

  const run = (label: string, fn: () => Promise<SearchResult[]>) =>
    fn()
      .then((r) => {
        groups.push(r);
      })
      .catch((err) => {
        errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      });

  const runners: Array<Promise<void>> = [];

  // Apibay cat 201 = Movies
  if (sources.includes('apibay')) runners.push(run('Apibay', () => searchApibay(query, 201)));
  if (sources.includes('knaben')) runners.push(run('Knaben', () => searchKnaben(query)));
  if (sources.includes('yourbittorrent')) {
    runners.push(run('YourBittorrent', () => searchYourBittorrent(query, 'movies')));
  }
  if (sources.includes('torrentscsv')) {
    runners.push(run('TorrentsCSV', () => searchTorrentsCsv(query)));
  }
  if (sources.includes('animetosho')) {
    runners.push(run('AnimeTosho', () => searchAnimeTosho(query)));
  }
  if (sources.includes('nyaa')) runners.push(run('Nyaa', () => searchNyaa(query)));
  if (sources.includes('limetorrents')) {
    runners.push(run('LimeTorrents', () => searchLimeTorrents(query)));
  }
  // Jackett movies category 2000
  if (sources.includes('jackett')) {
    runners.push(run('Jackett', () => searchJackett(settings, query, 2000)));
  }

  await Promise.all(runners);

  const merged = mergeByInfoHash(groups);
  const cleaned = merged.filter((r) => !/\b(trailer|teaser)\b/i.test(r.title || ''));
  const ranked = rankResults(cleaned.length ? cleaned : merged, preferred);
  const error = errors.length > 0 ? errors.join(' | ') : undefined;

  return { results: ranked, query, error };
}
