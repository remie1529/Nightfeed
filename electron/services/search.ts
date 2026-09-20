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
  /** Override for MIN_AUTO_SEEDERS when set. */
  minSeeders?: number;
}

export function effectiveMinSeeders(rules?: QualityRules | null, fallback = MIN_AUTO_SEEDERS): number {
  const n = rules?.minSeeders;
  if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return Math.min(500, Math.floor(n));
  return fallback;
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

export function rankResults(
  results: SearchResult[],
  preferred: Resolution,
  showName?: string,
  minSeeders: number = MIN_AUTO_SEEDERS
): SearchResult[] {
  const minS = typeof minSeeders === 'number' && minSeeders >= 0 ? minSeeders : MIN_AUTO_SEEDERS;
  const score = (r: SearchResult): number => {
    const seeds = r.seeders || 0;
    let s = 0;
    if (showName) s += showMatchScore(r.title || '', showName) * 50_000;
    if (r.resolution === preferred) s += 5_000_000;
    else if (r.resolution) s += 150_000;
    if (seeds <= 0) s -= 4_000_000;
    else if (seeds < minS) s -= 2_000_000;
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
  const minS = effectiveMinSeeders(rules);
  const minimum = rules?.minimum || preferred;
  const pool = (results || []).filter((r) => {
    if (!r?.magnet) return false;
    if ((r.seeders || 0) < minS) return false;
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

/** Plain-English why auto-pick found nothing (for activity log). */
export function summarizeAutoRejects(
  results: SearchResult[],
  preferred: Resolution,
  kind: 'episode' | 'movie',
  rules?: QualityRules,
  opts?: { upgrade?: boolean; triedSkipped?: number }
): string {
  const list = results || [];
  const minS = effectiveMinSeeders(rules);
  const minimum = rules?.minimum || preferred;
  const upgrade = !!opts?.upgrade;
  let noMagnet = 0;
  let belowSeeders = 0;
  let junk = 0;
  let wrongRes = 0;
  let sizeFail = 0;
  let ok = 0;
  for (const r of list) {
    if (!r?.magnet) {
      noMagnet += 1;
      continue;
    }
    if ((r.seeders || 0) < minS) {
      belowSeeders += 1;
      continue;
    }
    if (isJunkRelease(r.title || '')) {
      junk += 1;
      continue;
    }
    if (upgrade) {
      if (!r.resolution || resolutionRank(r.resolution) < resolutionRank(preferred)) {
        wrongRes += 1;
        continue;
      }
      if (!sizeOkForAuto(r.size || 0, kind, r.resolution, rules)) {
        sizeFail += 1;
        continue;
      }
    } else {
      if (r.resolution && !meetsMinResolution(r.resolution, minimum)) {
        wrongRes += 1;
        continue;
      }
      if (!r.resolution && resolutionRank(preferred) > resolutionRank(minimum)) {
        if (!sizeOkForAuto(r.size || 0, kind, minimum, rules)) {
          sizeFail += 1;
          continue;
        }
      } else if (!sizeOkForAuto(r.size || 0, kind, r.resolution, rules)) {
        sizeFail += 1;
        continue;
      }
    }
    ok += 1;
  }
  const parts: string[] = [];
  const tried = opts?.triedSkipped || 0;
  if (!list.length && !tried) return 'no search results';
  if (!list.length && tried) return `no results left after skipping ${tried} tried hash${tried === 1 ? '' : 'es'}`;
  if (tried) parts.push(`${tried} already tried`);
  if (belowSeeders) parts.push(`${belowSeeders} below min seeders (${minS})`);
  if (wrongRes) {
    parts.push(
      upgrade
        ? `${wrongRes} below preferred ${preferred}`
        : `${wrongRes} below minimum ${minimum}`
    );
  }
  if (junk) parts.push(`${junk} junk/cam`);
  if (sizeFail) parts.push(`${sizeFail} size fail`);
  if (noMagnet) parts.push(`${noMagnet} without magnet`);
  if (ok) parts.push(`${ok} passed filters but none started`);
  if (!parts.length) return `${list.length} result(s), none usable`;
  return `${list.length} result(s): ${parts.join(', ')}`;
}

/** Prefer-or-better only — used when upgrading a below-preferred library copy. */
export function pickUpgradeDownload(
  results: SearchResult[],
  preferred: Resolution,
  kind: 'episode' | 'movie' = 'episode',
  rules?: QualityRules
): SearchResult | null {
  const minS = effectiveMinSeeders(rules);
  const pool = (results || []).filter((r) => {
    if (!r?.magnet) return false;
    if ((r.seeders || 0) < minS) return false;
    if (isJunkRelease(r.title || '')) return false;
    if (!r.resolution || resolutionRank(r.resolution) < resolutionRank(preferred)) return false;
    if (!sizeOkForAuto(r.size || 0, kind, r.resolution, rules)) return false;
    return true;
  });
  if (!pool.length) return null;
  pool.sort((a, b) => {
    const ar = resolutionRank(a.resolution);
    const br = resolutionRank(b.resolution);
    if (br !== ar) return br - ar;
    return (b.seeders || 0) - (a.seeders || 0);
  });
  return pool[0];
}

export function filterUpgradeResults(
  results: SearchResult[],
  preferred: Resolution,
  kind: 'episode' | 'movie',
  rules?: QualityRules
): SearchResult[] {
  const minS = effectiveMinSeeders(rules);
  return (results || []).filter((r) => {
    if (!r?.magnet) return false;
    if ((r.seeders || 0) < minS) return false;
    if (!r.resolution || resolutionRank(r.resolution) < resolutionRank(preferred)) return false;
    if (!sizeOkForAuto(r.size || 0, kind, r.resolution, rules)) return false;
    return true;
  });
}

export function filterQualityResults(
  results: SearchResult[],
  preferred: Resolution,
  kind: 'episode' | 'movie',
  rules?: QualityRules
): SearchResult[] {
  const minS = effectiveMinSeeders(rules);
  const minimum = rules?.minimum || preferred;
  return (results || []).filter((r) => {
    if (!r?.magnet) return false;
    if ((r.seeders || 0) < minS) return false;
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

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1');
}

function stripTags(s: string): string {
  return decodeHtmlEntities(stripCdata(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
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
  // Normalize separators so "S01.E07" / "1x07" still match as whole episode tags.
  const t = (title || '').toLowerCase().replace(/[._]/g, ' ');
  const epTags: Array<{ s: number; e: number }> = [];
  for (const m of t.matchAll(/\bs(\d{1,2})e(\d{1,3})\b/g)) {
    epTags.push({ s: parseInt(m[1], 10), e: parseInt(m[2], 10) });
  }
  for (const m of t.matchAll(/\b(\d{1,2})x(\d{1,3})\b/g)) {
    epTags.push({ s: parseInt(m[1], 10), e: parseInt(m[2], 10) });
  }
  if (epTags.length === 0) return false;
  // Reject titles that name any other episode (even if the target tag also appears).
  for (const tag of epTags) {
    if (tag.s !== season || tag.e !== episode) return false;
  }
  return true;
}

/** Common words that should not drive anthology / franchise show matching. */
const SHOW_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'or',
  'to',
  'in',
  'on',
  'at',
  'for',
  'with',
  'from',
  'story',
  'stories',
  'season',
  'series',
  'show',
  'tv',
  'part',
  'vol',
  'volume',
  'episode',
]);

function normalizeShowText(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function significantShowTokens(showName: string): string[] {
  return normalizeShowText(showName)
    .split(' ')
    .filter((t) => t.length > 0 && !SHOW_STOPWORDS.has(t));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * After SxxExx match, require the torrent title to match the show name — not just one
 * shared franchise word (e.g. reject "Monster The Ed Gein Story" when searching
 * "Monster: The Lizzie Borden Story").
 */
export function titleMatchesShow(title: string, showName: string): boolean {
  const name = (showName || '').trim();
  if (!name) return true;

  const titleNorm = normalizeShowText(title);
  if (!titleNorm) return false;

  const tokens = significantShowTokens(name);
  if (tokens.length === 0) {
    const fallback = normalizeShowText(name).split(' ').filter(Boolean);
    return fallback.length > 0 && fallback.every((t) => titleNorm.includes(t));
  }

  // Full distinctive phrase (stopwords stripped) as substring → accept.
  const compact = tokens.join(' ');
  if (compact && titleNorm.includes(compact)) return true;

  // Also accept original normalized show without the/story-style stopwords if contiguous.
  const stripped = normalizeShowText(name)
    .split(' ')
    .filter((t) => t && !SHOW_STOPWORDS.has(t))
    .join(' ');
  if (stripped && titleNorm.includes(stripped)) return true;

  // Short / sparse show names: do not over-filter (Lost, 24, Qi, …).
  if (tokens.length === 1) {
    const t = tokens[0];
    if (t.length <= 3) {
      return new RegExp(`(?:^|\\s)${escapeRegExp(t)}(?:\\s|$)`).test(titleNorm);
    }
    return titleNorm.includes(t);
  }

  const longTokens = tokens.filter((t) => t.length > 3);
  if (longTokens.length >= 2) {
    // Require all long distinctive tokens (lizzie + borden + monster, etc.).
    return longTokens.every((t) => titleNorm.includes(t));
  }

  // Few long tokens: require every significant token (e.g. "Ed Gein" → ed + gein).
  return tokens.every((t) => titleNorm.includes(t));
}

/** Higher = closer show-name match; used to soft-rank exact-ish titles first. */
export function showMatchScore(title: string, showName: string): number {
  const name = (showName || '').trim();
  if (!name) return 0;
  const titleNorm = normalizeShowText(title);
  const tokens = significantShowTokens(name);
  if (!tokens.length || !titleNorm) return 0;

  const compact = tokens.join(' ');
  if (titleNorm.includes(compact)) return 100;

  const hits = tokens.filter((t) => titleNorm.includes(t)).length;
  const ratio = hits / tokens.length;
  // Bonus when the longest distinctive tokens all hit.
  const byLen = [...tokens].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const top = byLen.slice(0, Math.min(3, byLen.length));
  const topHits = top.filter((t) => titleNorm.includes(t)).length;
  return Math.round(ratio * 70 + (topHits / top.length) * 25);
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

/** YTS / YIFY movie API — movies only (JSON, no key). */
async function searchYts(query: string): Promise<SearchResult[]> {
  const url =
    `https://movies-api.accel.li/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}` +
    `&limit=50&sort_by=seeds&order_by=desc`;
  let res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 20000);
  if (!res.ok) {
    // fallback mirror
    res = await fetchWithTimeout(
      `https://yts.gg/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=50&sort_by=seeds&order_by=desc`,
      { headers: { Accept: 'application/json' } },
      20000
    );
  }
  if (!res.ok) throw new Error(`YTS HTTP ${res.status}`);
  const data = (await res.json()) as {
    data?: {
      movies?: Array<{
        title_long?: string;
        title?: string;
        year?: number;
        torrents?: Array<{
          hash?: string;
          quality?: string;
          type?: string;
          size_bytes?: number;
          seeds?: number;
          peers?: number;
        }>;
      }>;
    };
  };
  const results: SearchResult[] = [];
  for (const movie of data.data?.movies || []) {
    const base = movie.title_long || movie.title || query;
    for (const t of movie.torrents || []) {
      const hash = (t.hash || '').toLowerCase();
      if (!hash) continue;
      const quality = t.quality || '';
      const kind = t.type || '';
      const title = `${base} ${quality}${kind ? ` ${kind}` : ''}`.trim();
      results.push({
        title,
        magnet: buildMagnet(hash, title),
        size: t.size_bytes || 0,
        seeders: t.seeds || 0,
        leechers: t.peers || 0,
        source: 'yts',
        resolution: detectResolution(title) || detectResolution(quality),
        infoHash: hash,
      });
    }
  }
  return results;
}

/** TheRarBG / TorrentGalaxy-family public JSON search — no API key. */
async function searchTheRarBg(query: string): Promise<SearchResult[]> {
  const hosts = ['therarbg.com', 'torrentgalaxy.info', 'therarbg.to'];
  let data: {
    results?: Array<{
      n?: string;
      s?: number;
      se?: number;
      le?: number;
      h?: string;
    }>;
  } | null = null;
  let lastErr = '';
  for (const host of hosts) {
    try {
      const url = `https://${host}/get-posts/keywords:${encodeURIComponent(query)}/?format=json`;
      const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 15000);
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      data = (await res.json()) as typeof data;
      break;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  if (!data) throw new Error(`TheRarBG ${lastErr || 'unreachable'}`);
  const results: SearchResult[] = [];
  for (const item of data.results || []) {
    const title = item.n || '';
    const hash = (item.h || '').toLowerCase();
    if (!title || !hash) continue;
    results.push({
      title,
      magnet: buildMagnet(hash, title),
      size: item.s || 0,
      seeders: item.se || 0,
      leechers: item.le || 0,
      source: 'therarbg',
      resolution: detectResolution(title),
      infoHash: hash,
    });
  }
  return results;
}

/** TorrentDownloads.pro public search RSS — info_hash in feed. */
async function searchTorrentDownloads(query: string): Promise<SearchResult[]> {
  const url = `https://www.torrentdownloads.pro/rss.xml?type=search&search=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(
    url,
    { headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' } },
    20000
  );
  if (!res.ok) throw new Error(`TorrentDownloads HTTP ${res.status}`);
  const xml = await res.text();
  const results: SearchResult[] = [];
  for (const item of parseRssItems(xml)) {
    const title = rssTag(item, 'title');
    if (!title) continue;
    const hash = (rssTag(item, 'info_hash') || '').toLowerCase();
    if (!hash || !/^[a-f0-9]{40}$/.test(hash)) continue;
    const sizeRaw = rssTag(item, 'size');
    const size = /^\d+$/.test(sizeRaw) ? parseInt(sizeRaw, 10) : parseSizeToBytes(sizeRaw);
    const seeders = parseInt(rssTag(item, 'seeders') || '0', 10) || 0;
    const leechers = parseInt(rssTag(item, 'leechers') || '0', 10) || 0;
    results.push({
      title,
      magnet: buildMagnet(hash, title),
      size: size || 0,
      seeders,
      leechers,
      source: 'torrentdownloads',
      resolution: detectResolution(title),
      infoHash: hash,
    });
  }
  return results;
}

/** Tokyo Toshokan anime RSS — magnets in description. */
async function searchTokyoTosho(query: string): Promise<SearchResult[]> {
  const url = `https://www.tokyotosho.info/rss.php?terms=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(
    url,
    { headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' } },
    20000
  );
  if (!res.ok) throw new Error(`TokyoTosho HTTP ${res.status}`);
  const xml = await res.text();
  const results: SearchResult[] = [];
  for (const item of parseRssItems(xml)) {
    const title = rssTag(item, 'title');
    if (!title) continue;
    const desc = item.match(/<description\b[^>]*>([\s\S]*?)<\/description>/i)?.[1] || '';
    const decoded = decodeHtmlEntities(desc.replace(/<!\[CDATA\[|\]\]>/g, ''));
    let magnet = '';
    const magnetHref = decoded.match(/href=["'](magnet:\?[^"']+)["']/i);
    if (magnetHref) magnet = decodeHtmlEntities(magnetHref[1]);
    const hash = extractInfoHash(magnet).toLowerCase();
    if (!hash) continue;
    if (!magnet.startsWith('magnet:')) magnet = buildMagnet(hash, title);
    const sizeMatch = decoded.match(/Size:\s*([\d.]+\s*[KMGT]?i?B)/i);
    const size = sizeMatch ? parseSizeToBytes(sizeMatch[1]) : 0;
    results.push({
      title,
      magnet,
      size,
      seeders: 0,
      leechers: 0,
      source: 'tokyotosho',
      resolution: detectResolution(title),
      infoHash: hash,
    });
  }
  return results;
}


/** SolidTorrents / BitSearch public JSON API — no key. */
async function searchSolidTorrents(query: string): Promise<SearchResult[]> {
  const hosts = [
    `https://solidtorrents.to/api/v1/search?q=${encodeURIComponent(query)}&category=all&sort=seeders`,
    `https://bitsearch.eu/api/v1/search?q=${encodeURIComponent(query)}&sort=seeders&limit=50`,
    `https://bitsearch.to/api/v1/search?q=${encodeURIComponent(query)}&sort=seeders&limit=50`,
  ];
  let data: {
    results?: Array<{
      title?: string;
      infohash?: string;
      size?: number;
      seeders?: number;
      leechers?: number;
    }>;
  } | null = null;
  let lastErr = '';
  for (const url of hosts) {
    try {
      const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 15000);
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      data = (await res.json()) as typeof data;
      if (data?.results?.length) break;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  if (!data) throw new Error(`SolidTorrents ${lastErr || 'unreachable'}`);
  const results: SearchResult[] = [];
  for (const item of data.results || []) {
    const title = item.title || '';
    const hash = (item.infohash || '').toLowerCase();
    if (!title || !hash) continue;
    results.push({
      title,
      magnet: buildMagnet(hash, title),
      size: item.size || 0,
      seeders: item.seeders || 0,
      leechers: item.leechers || 0,
      source: 'solidtorrents',
      resolution: detectResolution(title),
      infoHash: hash,
    });
  }
  return results;
}

/** TorrentDownload.info public search RSS — hash + seeds in description. */
async function searchTorrentDownload(query: string): Promise<SearchResult[]> {
  const url = `https://www.torrentdownload.info/feed?q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(
    url,
    { headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' } },
    20000
  );
  if (!res.ok) throw new Error(`TorrentDownload HTTP ${res.status}`);
  const xml = await res.text();
  const results: SearchResult[] = [];
  for (const item of parseRssItems(xml)) {
    const title = rssTag(item, 'title');
    if (!title) continue;
    const desc = rssTag(item, 'description');
    const link = rssTag(item, 'link') || rssTag(item, 'guid');
    const hashMatch =
      desc.match(/Hash:\s*([a-fA-F0-9]{40})/i) ||
      link.match(/\/([a-fA-F0-9]{40})\b/);
    const hash = (hashMatch?.[1] || '').toLowerCase();
    if (!hash) continue;
    const sizeMatch = desc.match(/Size:\s*([\d.]+\s*[KMGT]?i?B)/i);
    const seedMatch = desc.match(/Seeds?:\s*([\d,]+)/i);
    const peerMatch = desc.match(/Peers?:\s*([\d,]+)/i);
    results.push({
      title,
      magnet: buildMagnet(hash, title),
      size: sizeMatch ? parseSizeToBytes(sizeMatch[1]) : 0,
      seeders: seedMatch ? parseInt(seedMatch[1].replace(/,/g, ''), 10) || 0 : 0,
      leechers: peerMatch ? parseInt(peerMatch[1].replace(/,/g, ''), 10) || 0 : 0,
      source: 'torrentdownload',
      resolution: detectResolution(title),
      infoHash: hash,
    });
  }
  return results;
}

/** Pirate Bay HTML mirrors — magnets in search results (fallback when apibay is enough but more coverage). */
async function searchTpbMirror(query: string): Promise<SearchResult[]> {
  const paths = [
    `https://pirateproxy.live/search/${encodeURIComponent(query)}/1/99/0`,
    `https://thepiratebay10.info/search/${encodeURIComponent(query)}/1/99/0`,
  ];
  let html = '';
  let lastErr = '';
  for (const url of paths) {
    try {
      const res = await fetchWithTimeout(
        url,
        { headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0' } },
        15000
      );
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      html = await res.text();
      if (/magnet:\?/i.test(html)) break;
      html = '';
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  if (!html) throw new Error(`TPB mirror ${lastErr || 'unreachable'}`);
  const results: SearchResult[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const row = m[1];
    const magnetHref = row.match(/href=["'](magnet:\?[^"']+)["']/i);
    if (!magnetHref) continue;
    const magnet = decodeHtmlEntities(magnetHref[1]);
    const hash = extractInfoHash(magnet).toLowerCase();
    if (!hash) continue;
    const titleMatch =
      row.match(/title=["']Details for ([^"']+)["']/i) ||
      row.match(/<a[^>]+>([^<]{3,})<\/a>/i);
    const title = titleMatch ? decodeHtmlEntities(titleMatch[1]).trim() : '';
    if (!title) continue;
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) =>
      stripTags(x[1].replace(/&nbsp;/gi, ' '))
    );
    // Typical: cat, title, date, ?, size, seeds, leeches, uploader
    let size = 0;
    let seeders = 0;
    let leechers = 0;
    for (const td of tds) {
      if (!size && /[\d.]+\s*[KMGT]i?B/i.test(td)) size = parseSizeToBytes(td);
    }
    const nums = tds.filter((td) => /^\d+$/.test(td));
    if (nums.length >= 2) {
      seeders = parseInt(nums[0], 10) || 0;
      leechers = parseInt(nums[1], 10) || 0;
    }
    results.push({
      title,
      magnet: magnet.startsWith('magnet:') ? magnet : buildMagnet(hash, title),
      size,
      seeders,
      leechers,
      source: 'tpbmirror',
      resolution: detectResolution(title),
      infoHash: hash,
    });
  }
  return results;
}

/** Bangumi.moe anime JSON search — no key. */
async function searchBangumi(query: string): Promise<SearchResult[]> {
  const res = await fetchWithTimeout(
    'https://bangumi.moe/api/v2/torrent/search',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, limit: 50 }),
    },
    20000
  );
  if (!res.ok) throw new Error(`Bangumi HTTP ${res.status}`);
  const data = (await res.json()) as {
    torrents?: Array<{
      title?: string;
      magnet?: string;
      infoHash?: string;
      size?: string | number;
      seeders?: number;
      leechers?: number;
    }>;
  };
  const results: SearchResult[] = [];
  for (const item of data.torrents || []) {
    const title = item.title || '';
    const hash = (item.infoHash || extractInfoHash(item.magnet || '')).toLowerCase();
    if (!title || !hash) continue;
    const magnet =
      item.magnet && item.magnet.startsWith('magnet:')
        ? item.magnet
        : buildMagnet(hash, title);
    const size =
      typeof item.size === 'number'
        ? item.size
        : parseSizeToBytes(String(item.size || ''));
    results.push({
      title,
      magnet,
      size,
      seeders: item.seeders || 0,
      leechers: item.leechers || 0,
      source: 'bangumi',
      resolution: detectResolution(title),
      infoHash: hash,
    });
  }
  return results;
}

/** Mikan Project anime RSS — infohash in enclosure URL. */
async function searchMikan(query: string): Promise<SearchResult[]> {
  const url = `https://mikanani.me/RSS/Search?searchstr=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(
    url,
    { headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' } },
    20000
  );
  if (!res.ok) throw new Error(`Mikan HTTP ${res.status}`);
  const xml = await res.text();
  const results: SearchResult[] = [];
  for (const item of parseRssItems(xml)) {
    const title = rssTag(item, 'title');
    if (!title) continue;
    const enclosure = rssAttr(item, 'enclosure', 'url');
    const lengthAttr = rssAttr(item, 'enclosure', 'length');
    const hashMatch = enclosure.match(/\/([a-fA-F0-9]{40})(?:\.torrent)?(?:\?|$)/i);
    const hash = (hashMatch?.[1] || extractInfoHash(enclosure)).toLowerCase();
    if (!hash) continue;
    const size =
      (lengthAttr && /^\d+$/.test(lengthAttr) ? parseInt(lengthAttr, 10) : 0) ||
      parseSizeToBytes(rssTag(item, 'description'));
    results.push({
      title,
      magnet: buildMagnet(hash, title),
      size: size || 0,
      seeders: 0,
      leechers: 0,
      source: 'mikan',
      resolution: detectResolution(title),
      infoHash: hash,
    });
  }
  return results;
}

/** DMHY (share.dmhy.org) anime RSS — magnet enclosures (often base32 infohash). */
async function searchDmhy(query: string): Promise<SearchResult[]> {
  const url = `https://share.dmhy.org/topics/rss/rss.xml?keyword=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(
    url,
    { headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' } },
    20000
  );
  if (!res.ok) throw new Error(`DMHY HTTP ${res.status}`);
  const xml = await res.text();
  const results: SearchResult[] = [];
  for (const item of parseRssItems(xml)) {
    const title = rssTag(item, 'title');
    if (!title) continue;
    let magnet = rssAttr(item, 'enclosure', 'url');
    if (!magnet.startsWith('magnet:')) {
      const m = item.match(/magnet:\?[^"'<\s]+/i);
      if (m) magnet = decodeHtmlEntities(m[0]);
    } else {
      magnet = decodeHtmlEntities(magnet);
    }
    const hash = extractInfoHash(magnet).toLowerCase();
    if (!hash) continue;
    if (!magnet.startsWith('magnet:')) magnet = buildMagnet(hash, title);
    results.push({
      title,
      magnet,
      size: 0,
      seeders: 0,
      leechers: 0,
      source: 'dmhy',
      resolution: detectResolution(title),
      infoHash: hash,
    });
  }
  return results;
}

/** ACGNX anime RSS — magnet enclosures. */
async function searchAcgnx(query: string): Promise<SearchResult[]> {
  const hosts = [
    `https://www.acgnx.se/rss.xml?keyword=${encodeURIComponent(query)}`,
    `https://share.acgnx.se/rss.xml?keyword=${encodeURIComponent(query)}`,
  ];
  let xml = '';
  let lastErr = '';
  for (const url of hosts) {
    try {
      const res = await fetchWithTimeout(
        url,
        { headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' } },
        15000
      );
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      xml = await res.text();
      if (parseRssItems(xml).length) break;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  if (!xml) throw new Error(`ACGNX ${lastErr || 'unreachable'}`);
  const results: SearchResult[] = [];
  for (const item of parseRssItems(xml)) {
    const title = rssTag(item, 'title');
    if (!title) continue;
    let magnet = rssAttr(item, 'enclosure', 'url');
    if (magnet.startsWith('magnet:')) magnet = decodeHtmlEntities(magnet);
    else {
      const m = item.match(/magnet:\?[^"'<\s]+/i);
      magnet = m ? decodeHtmlEntities(m[0]) : '';
    }
    const hash = extractInfoHash(magnet).toLowerCase();
    if (!hash) continue;
    if (!magnet.startsWith('magnet:')) magnet = buildMagnet(hash, title);
    const desc = rssTag(item, 'description');
    const sizeMatch = desc.match(/([\d.]+\s*[KMGT]?i?B)/i);
    results.push({
      title,
      magnet,
      size: sizeMatch ? parseSizeToBytes(sizeMatch[1]) : 0,
      seeders: 0,
      leechers: 0,
      source: 'acgnx',
      resolution: detectResolution(title),
      infoHash: hash,
    });
  }
  return results;
}

/** SubsPlease anime JSON search — magnets per resolution. */
async function searchSubsPlease(query: string): Promise<SearchResult[]> {
  const url = `https://subsplease.org/api/?f=search&tz=UTC&s=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 20000);
  if (!res.ok) throw new Error(`SubsPlease HTTP ${res.status}`);
  const data = (await res.json()) as Record<
    string,
    {
      show?: string;
      episode?: string;
      downloads?: Array<{ res?: string; magnet?: string }>;
    }
  >;
  if (!data || typeof data !== 'object') return [];
  const results: SearchResult[] = [];
  for (const [key, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== 'object') continue;
    for (const dl of entry.downloads || []) {
      const magnet = dl.magnet || '';
      if (!magnet.startsWith('magnet:')) continue;
      const hash = extractInfoHash(magnet).toLowerCase();
      if (!hash) continue;
      const resLabel = dl.res ? `${dl.res}p` : '';
      const title = `[SubsPlease] ${key}${resLabel ? ` (${resLabel})` : ''}`;
      const xl = magnet.match(/[?&]xl=(\d+)/i);
      results.push({
        title,
        magnet,
        size: xl ? parseInt(xl[1], 10) || 0 : 0,
        seeders: 0,
        leechers: 0,
        source: 'subsplease',
        resolution: detectResolution(title) || detectResolution(resLabel),
        infoHash: hash,
      });
    }
  }
  return results;
}

/** Sukebei (Nyaa NSFW) RSS — same schema as Nyaa. */
async function searchSukebei(query: string): Promise<SearchResult[]> {
  const url = `https://sukebei.nyaa.si/?page=rss&q=${encodeURIComponent(query)}&c=0_0&f=0`;
  const res = await fetchWithTimeout(
    url,
    { headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' } },
    20000
  );
  if (!res.ok) throw new Error(`Sukebei HTTP ${res.status}`);
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
      source: 'sukebei',
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
    'yts',
    'therarbg',
    'torrentdownloads',
    'solidtorrents',
    'torrentdownload',
    'tpbmirror',
    'limetorrents',
    'animetosho',
    'nyaa',
    'tokyotosho',
    'bangumi',
    'mikan',
    'dmhy',
    'acgnx',
    'subsplease',
    'sukebei',
    'jackett',
  ];
  const out = order.filter((id) => !!src[id]);
  // Safety: never search nothing — fall back to on-by-default sources
  if (out.length === 0) {
    return order.filter((id) => DEFAULT_TORRENT_SOURCES[id]);
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
  const sources = enabledTorrentSources(settings).filter((id) => id !== 'yts');
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
  if (sources.includes('therarbg')) {
    runners.push(run('TheRarBG', () => searchTheRarBg(query)));
  }
  if (sources.includes('torrentdownloads')) {
    runners.push(run('TorrentDownloads', () => searchTorrentDownloads(query)));
  }
  if (sources.includes('animetosho')) {
    runners.push(run('AnimeTosho', () => searchAnimeTosho(query)));
  }
  if (sources.includes('nyaa')) runners.push(run('Nyaa', () => searchNyaa(query)));
  if (sources.includes('tokyotosho')) {
    runners.push(run('TokyoTosho', () => searchTokyoTosho(query)));
  }
  if (sources.includes('limetorrents')) {
    runners.push(run('LimeTorrents', () => searchLimeTorrents(query)));
  }
  if (sources.includes('solidtorrents')) {
    runners.push(run('SolidTorrents', () => searchSolidTorrents(query)));
  }
  if (sources.includes('torrentdownload')) {
    runners.push(run('TorrentDownload', () => searchTorrentDownload(query)));
  }
  if (sources.includes('tpbmirror')) {
    runners.push(run('TPB Mirror', () => searchTpbMirror(query)));
  }
  if (sources.includes('bangumi')) {
    runners.push(run('Bangumi', () => searchBangumi(query)));
  }
  if (sources.includes('mikan')) {
    runners.push(run('Mikan', () => searchMikan(query)));
  }
  if (sources.includes('dmhy')) {
    runners.push(run('DMHY', () => searchDmhy(query)));
  }
  if (sources.includes('acgnx')) {
    runners.push(run('ACGNX', () => searchAcgnx(query)));
  }
  if (sources.includes('subsplease')) {
    runners.push(run('SubsPlease', () => searchSubsPlease(query)));
  }
  if (sources.includes('sukebei')) {
    runners.push(run('Sukebei', () => searchSukebei(query)));
  }
  if (sources.includes('jackett')) {
    runners.push(run('Jackett', () => searchJackett(settings, query)));
  }

  await Promise.all(runners);

  const merged = mergeByInfoHash(groups);
  const episodeOnly = merged.filter(
    (r) =>
      titleMatchesEpisode(r.title || '', season, episode) &&
      titleMatchesShow(r.title || '', showName) &&
      !isMultiEpisodePack(r.title || '')
  );
  // Never fall back to unfiltered merge — wrong episodes must not appear in Find / auto-download.
  const ranked = rankResults(episodeOnly, preferred, showName, settings.minSeeders ?? MIN_AUTO_SEEDERS);
  const parts: string[] = [];
  if (errors.length > 0) parts.push(errors.join(' | '));
  if (!episodeOnly.length) {
    parts.push(`No torrents matching ${episodeTag(season, episode)}`);
  }
  const error = parts.length > 0 ? parts.join(' | ') : undefined;

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
  if (sources.includes('yts')) {
    runners.push(run('YTS', () => searchYts(query)));
  }
  if (sources.includes('therarbg')) {
    runners.push(run('TheRarBG', () => searchTheRarBg(query)));
  }
  if (sources.includes('torrentdownloads')) {
    runners.push(run('TorrentDownloads', () => searchTorrentDownloads(query)));
  }
  if (sources.includes('animetosho')) {
    runners.push(run('AnimeTosho', () => searchAnimeTosho(query)));
  }
  if (sources.includes('nyaa')) runners.push(run('Nyaa', () => searchNyaa(query)));
  if (sources.includes('tokyotosho')) {
    runners.push(run('TokyoTosho', () => searchTokyoTosho(query)));
  }
  if (sources.includes('limetorrents')) {
    runners.push(run('LimeTorrents', () => searchLimeTorrents(query)));
  }
  if (sources.includes('solidtorrents')) {
    runners.push(run('SolidTorrents', () => searchSolidTorrents(query)));
  }
  if (sources.includes('torrentdownload')) {
    runners.push(run('TorrentDownload', () => searchTorrentDownload(query)));
  }
  if (sources.includes('tpbmirror')) {
    runners.push(run('TPB Mirror', () => searchTpbMirror(query)));
  }
  if (sources.includes('bangumi')) {
    runners.push(run('Bangumi', () => searchBangumi(query)));
  }
  if (sources.includes('mikan')) {
    runners.push(run('Mikan', () => searchMikan(query)));
  }
  if (sources.includes('dmhy')) {
    runners.push(run('DMHY', () => searchDmhy(query)));
  }
  if (sources.includes('acgnx')) {
    runners.push(run('ACGNX', () => searchAcgnx(query)));
  }
  if (sources.includes('subsplease')) {
    runners.push(run('SubsPlease', () => searchSubsPlease(query)));
  }
  if (sources.includes('sukebei')) {
    runners.push(run('Sukebei', () => searchSukebei(query)));
  }
  // Jackett movies category 2000
  if (sources.includes('jackett')) {
    runners.push(run('Jackett', () => searchJackett(settings, query, 2000)));
  }

  await Promise.all(runners);

  const merged = mergeByInfoHash(groups);
  const cleaned = merged.filter((r) => !/\b(trailer|teaser)\b/i.test(r.title || ''));
  const ranked = rankResults(cleaned.length ? cleaned : merged, preferred, undefined, settings.minSeeders ?? MIN_AUTO_SEEDERS);
  const error = errors.length > 0 ? errors.join(' | ') : undefined;

  return { results: ranked, query, error };
}
