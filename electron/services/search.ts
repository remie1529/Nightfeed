import { AppSettings, Resolution, SearchResult, TorrentSourceId } from '../types';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function buildQuery(showName: string, season: number, episode: number): string {
  return `${showName} S${pad2(season)}E${pad2(episode)}`;
}

export function detectResolution(title: string): Resolution | null {
  const t = title.toLowerCase();
  if (/\b(2160p|4k|uhd)\b/.test(t)) return '2160p';
  if (/\b1080p\b/.test(t)) return '1080p';
  if (/\b720p\b/.test(t)) return '720p';
  return null;
}

export function rankResults(results: SearchResult[], preferred: Resolution): SearchResult[] {
  const order: Resolution[] = preferred === '2160p'
    ? ['2160p', '1080p', '720p']
    : preferred === '720p'
      ? ['720p', '1080p', '2160p']
      : ['1080p', '720p', '2160p'];

  const score = (r: SearchResult): number => {
    const resIdx = r.resolution ? order.indexOf(r.resolution) : order.length;
    const resScore = (order.length - resIdx) * 1_000_000;
    return resScore + (r.seeders || 0) * 10 + Math.min(r.leechers || 0, 50);
  };

  return [...results].sort((a, b) => score(b) - score(a));
}

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
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

function parseIntLoose(text: string): number {
  const digits = text.replace(/[^\d]/g, '');
  if (!digits) return 0;
  return parseInt(digits, 10) || 0;
}

function isCloudflareChallenge(status: number, html: string): boolean {
  if (status === 403 || status === 503) return true;
  const lower = html.toLowerCase();
  return (
    lower.includes('just a moment') ||
    lower.includes('cf-browser-verification') ||
    lower.includes('challenge-platform') ||
    (lower.includes('attention required') && lower.includes('cloudflare'))
  );
}

interface ApibayItem {
  id: string;
  name: string;
  info_hash: string;
  leechers: string;
  seeders: string;
  size: string;
  username?: string;
  status?: string;
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

async function searchApibay(query: string): Promise<SearchResult[]> {
  const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=205`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Apibay HTTP ${res.status}`);
    const data = (await res.json()) as ApibayItem[];
    let results = mapApibayItems(data, query);
    if (results.length === 0) {
      const fallback = await fetch(`https://apibay.org/q.php?q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      });
      if (fallback.ok) {
        results = mapApibayItems((await fallback.json()) as ApibayItem[], query);
      }
    }
    return results;
  } finally {
    clearTimeout(timer);
  }
}

/** Parse UIndex HTML result tables (sr-table / maintable / generic magnet rows). */
export function parseUindexHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const row = rowMatch[1];
    const magnetMatch = row.match(/href=["'](magnet:\?[^"']+)["']/i);
    if (!magnetMatch) continue;
    const magnet = decodeHtmlEntities(magnetMatch[1]);
    const infoHash = extractInfoHash(magnet);
    if (!infoHash || seen.has(infoHash)) continue;

    let title = '';
    const details = row.match(/href=["'][^"']*details\.php[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    if (details) title = stripTags(details[1]);
    if (!title) {
      const dn = magnet.match(/[?&]dn=([^&]+)/i);
      if (dn) {
        try {
          title = decodeURIComponent(dn[1].replace(/\+/g, ' '));
        } catch {
          title = dn[1];
        }
      }
    }
    if (!title) continue;

    const sizeCell =
      row.match(/class=["'][^"']*(?:hp-td-size|td-size|size)[^"']*["'][^>]*>([\s\S]*?)<\/td>/i) ||
      row.match(/<td[^>]*style=["'][^"']*white-space:\s*nowrap[^"']*["'][^>]*>([\s\S]*?)<\/td>/i);
    let sizeText = sizeCell ? stripTags(sizeCell[1]) : '';
    if (!sizeText) {
      const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]));
      sizeText = cells.find((c) => /[\d.]+\s*(TiB|GiB|MiB|KiB|TB|GB|MB|KB)\b/i.test(c)) || '';
    }

    const seedPill =
      row.match(/class=["'][^"']*(?:hp-seed-pill|seed)[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) ||
      row.match(/<span[^>]*class=["']g["'][^>]*>([\s\S]*?)<\/span>/i);
    const leechPill =
      row.match(/class=["'][^"']*(?:hp-leech-pill|leech)[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) ||
      row.match(/<span[^>]*class=["']b["'][^>]*>([\s\S]*?)<\/span>/i);

    let seeders = seedPill ? parseIntLoose(stripTags(seedPill[1])) : 0;
    let leechers = leechPill ? parseIntLoose(stripTags(leechPill[1])) : 0;
    if (!seedPill || !leechPill) {
      const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]));
      // Typical: #, Name, Size, S, L
      if (cells.length >= 5) {
        if (!seedPill) seeders = parseIntLoose(cells[3]);
        if (!leechPill) leechers = parseIntLoose(cells[4]);
      }
    }

    seen.add(infoHash);
    results.push({
      title,
      magnet,
      size: parseSizeToBytes(sizeText),
      seeders,
      leechers,
      source: 'uindex',
      resolution: detectResolution(title),
      infoHash,
    });
  }
  return results;
}

async function searchUindex(query: string): Promise<SearchResult[]> {
  // TV category c=2 — stable search endpoint used by FlexGet / qBittorrent plugins
  const url = `https://uindex.org/search.php?search=${encodeURIComponent(query)}&c=2`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://uindex.org/',
      },
    });
    const html = await res.text();
    if (isCloudflareChallenge(res.status, html)) {
      throw new Error(
        'UIndex is temporarily blocked by Cloudflare bot protection. Try again later, or keep Apibay enabled.'
      );
    }
    if (!res.ok) throw new Error(`UIndex HTTP ${res.status}`);
    if (!html || html.length < 200) {
      throw new Error('UIndex returned an empty page.');
    }
    return parseUindexHtml(html);
  } finally {
    clearTimeout(timer);
  }
}

async function searchJackett(settings: AppSettings, query: string): Promise<SearchResult[]> {
  if (!settings.jackettUrl || !settings.jackettApiKey) {
    throw new Error('Jackett URL and API key are required when Jackett is enabled.');
  }
  const base = settings.jackettUrl.replace(/\/$/, '');
  const url =
    `${base}/api/v2.0/indexers/all/results?apikey=${encodeURIComponent(settings.jackettApiKey)}` +
    `&Query=${encodeURIComponent(query)}&Category[]=5000`;
  const res = await fetch(url);
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
  const src = settings.torrentSources;
  const out: TorrentSourceId[] = [];
  if (src?.apibay) out.push('apibay');
  if (src?.uindex) out.push('uindex');
  if (src?.jackett) out.push('jackett');
  // Safety: never search nothing
  if (out.length === 0) out.push('apibay', 'uindex');
  return out;
}

export async function searchEpisodeTorrents(
  settings: AppSettings,
  showName: string,
  season: number,
  episode: number,
  preferred: Resolution
): Promise<{ results: SearchResult[]; query: string; error?: string }> {
  const query = buildQuery(showName, season, episode);
  const sources = enabledTorrentSources(settings);
  const errors: string[] = [];
  const groups: SearchResult[][] = [];

  const runners: Array<Promise<void>> = [];

  if (sources.includes('apibay')) {
    runners.push(
      searchApibay(query)
        .then((r) => {
          groups.push(r);
        })
        .catch((err) => {
          errors.push(`Apibay: ${err instanceof Error ? err.message : String(err)}`);
        })
    );
  }
  if (sources.includes('uindex')) {
    runners.push(
      searchUindex(query)
        .then((r) => {
          groups.push(r);
        })
        .catch((err) => {
          errors.push(`UIndex: ${err instanceof Error ? err.message : String(err)}`);
        })
    );
  }
  if (sources.includes('jackett')) {
    runners.push(
      searchJackett(settings, query)
        .then((r) => {
          groups.push(r);
        })
        .catch((err) => {
          errors.push(`Jackett: ${err instanceof Error ? err.message : String(err)}`);
        })
    );
  }

  await Promise.all(runners);

  const merged = mergeByInfoHash(groups);
  const ranked = rankResults(merged, preferred);
  const error =
    ranked.length === 0 && errors.length > 0
      ? errors.join(' | ')
      : undefined;

  return { results: ranked, query, error };
}
