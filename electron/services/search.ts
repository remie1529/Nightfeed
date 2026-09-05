import { AppSettings, Resolution, SearchResult } from '../types';

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

async function searchApibay(query: string): Promise<SearchResult[]> {
  const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=205`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Search HTTP ${res.status}`);
    const data = (await res.json()) as ApibayItem[];
    if (!Array.isArray(data) || data.length === 0) return [];
    // apibay returns a placeholder row when empty
    if (data.length === 1 && (data[0].name === 'No results returned' || data[0].id === '0')) {
      return [];
    }
    return data.map((item) => {
      const hash = (item.info_hash || '').toLowerCase();
      const magnet =
        `magnet:?xt=urn:btih:${hash}` +
        `&dn=${encodeURIComponent(item.name || query)}` +
        `&tr=${encodeURIComponent('udp://tracker.opentrackr.org:1337/announce')}` +
        `&tr=${encodeURIComponent('udp://open.stealth.si:80/announce')}` +
        `&tr=${encodeURIComponent('udp://tracker.openbittorrent.com:6969/announce')}`;
      return {
        title: item.name,
        magnet,
        size: parseInt(item.size, 10) || 0,
        seeders: parseInt(item.seeders, 10) || 0,
        leechers: parseInt(item.leechers, 10) || 0,
        source: 'apibay',
        resolution: detectResolution(item.name || ''),
        infoHash: hash,
      };
    });
  } finally {
    clearTimeout(timer);
  }
}

async function searchJackett(settings: AppSettings, query: string): Promise<SearchResult[]> {
  if (!settings.jackettUrl || !settings.jackettApiKey) {
    throw new Error('Jackett URL and API key are required when using the Jackett provider.');
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
    }>;
  };
  const results: SearchResult[] = [];
  for (const item of data.Results || []) {
    const magnet = item.MagnetUri || '';
    if (!magnet.startsWith('magnet:')) continue;
    results.push({
      title: item.Title,
      magnet,
      size: item.Size || 0,
      seeders: item.Seeders || 0,
      leechers: Math.max(0, (item.Peers || 0) - (item.Seeders || 0)),
      source: item.Tracker || 'jackett',
      resolution: detectResolution(item.Title || ''),
    });
  }
  return results;
}

export async function searchEpisodeTorrents(
  settings: AppSettings,
  showName: string,
  season: number,
  episode: number,
  preferred: Resolution
): Promise<{ results: SearchResult[]; query: string; error?: string }> {
  const query = buildQuery(showName, season, episode);
  try {
    let raw: SearchResult[] = [];
    if (settings.searchProvider === 'jackett') {
      raw = await searchJackett(settings, query);
    } else {
      raw = await searchApibay(query);
      // fallback without category if empty
      if (raw.length === 0) {
        const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}`;
        const res = await fetch(url);
        if (res.ok) {
          const data = (await res.json()) as ApibayItem[];
          if (Array.isArray(data) && !(data.length === 1 && data[0].id === '0')) {
            raw = data.map((item) => {
              const hash = (item.info_hash || '').toLowerCase();
              return {
                title: item.name,
                magnet:
                  `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(item.name || query)}` +
                  `&tr=${encodeURIComponent('udp://tracker.opentrackr.org:1337/announce')}`,
                size: parseInt(item.size, 10) || 0,
                seeders: parseInt(item.seeders, 10) || 0,
                leechers: parseInt(item.leechers, 10) || 0,
                source: 'apibay',
                resolution: detectResolution(item.name || ''),
                infoHash: hash,
              };
            });
          }
        }
      }
    }
    return { results: rankResults(raw, preferred), query };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { results: [], query, error: message };
  }
}
