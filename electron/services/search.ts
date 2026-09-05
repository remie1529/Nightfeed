import { BrowserWindow, session } from 'electron';
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
    lower.includes('cf-turnstile') ||
    lower.includes('turnstile') ||
    (lower.includes('attention required') && lower.includes('cloudflare'))
  );
}

function htmlLooksReady(html: string): boolean {
  if (!html || html.length < 80) return false;
  if (html.includes('magnet:?')) return true;
  return !isCloudflareChallenge(200, html);
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

const UINDEX_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const UINDEX_HEADERS: Record<string, string> = {
  'User-Agent': UINDEX_UA,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://uindex.org/',
};

const UINDEX_PARTITION = 'persist:uindex';

/** Persistent Chromium session so CF cookies survive app restarts. */
export function getUindexSession() {
  return session.fromPartition(UINDEX_PARTITION);
}

export async function clearUindexCookies(): Promise<void> {
  const ses = getUindexSession();
  await ses.clearStorageData({
    storages: ['cookies', 'localstorage', 'cachestorage', 'indexdb', 'websql', 'serviceworkers'],
  });
}

let unlockWindow: BrowserWindow | null = null;

/**
 * Visible BrowserWindow on persist:uindex so the user can complete Turnstile.
 * Polls until magnets appear or CF challenge clears (up to timeoutMs).
 */
export function fetchUindexHtmlViaUnlockWindow(
  url: string,
  timeoutMs = 120_000
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;

    // Reuse / replace any prior unlock window
    if (unlockWindow && !unlockWindow.isDestroyed()) {
      try {
        unlockWindow.destroy();
      } catch {
        // ignore
      }
      unlockWindow = null;
    }

    const win = new BrowserWindow({
      show: true,
      width: 1100,
      height: 800,
      minWidth: 640,
      minHeight: 480,
      title: 'UIndex — waiting for Cloudflare…',
      alwaysOnTop: true,
      autoHideMenuBar: true,
      backgroundColor: '#1a1a1a',
      webPreferences: {
        partition: UINDEX_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    unlockWindow = win;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      clearTimeout(hardTimeout);
      try {
        if (!win.isDestroyed()) win.destroy();
      } catch {
        // ignore
      }
      if (unlockWindow === win) unlockWindow = null;
      fn();
    };

    const readHtml = async (): Promise<string> => {
      if (win.isDestroyed()) return '';
      return (await win.webContents.executeJavaScript(
        'document.documentElement.outerHTML'
      )) as string;
    };

    const updateTitle = (html: string) => {
      if (win.isDestroyed()) return;
      if (html.includes('magnet:?')) {
        win.setTitle('UIndex — challenge cleared');
      } else if (isCloudflareChallenge(200, html)) {
        win.setTitle('UIndex — waiting for Cloudflare… (complete check if shown)');
      } else {
        win.setTitle('UIndex — loading results…');
      }
    };

    const pollTimer = setInterval(() => {
      void readHtml()
        .then((html) => {
          if (!html) return;
          updateTitle(html);
          if (html.includes('magnet:?') || htmlLooksReady(html)) {
            // Prefer magnet pages; also accept cleared CF with empty results
            if (html.includes('magnet:?') || !isCloudflareChallenge(200, html)) {
              settle(() => resolve(html));
            }
          }
        })
        .catch(() => undefined);
    }, 500);

    const hardTimeout = setTimeout(() => {
      void readHtml()
        .then((html) => {
          if (!html) {
            settle(() =>
              reject(new Error('UIndex Cloudflare unlock timed out with an empty page.'))
            );
            return;
          }
          if (isCloudflareChallenge(200, html) && !html.includes('magnet:?')) {
            settle(() =>
              reject(
                new Error(
                  'UIndex Cloudflare challenge did not clear within 120s. Use Settings → Unlock UIndex, or enable FlareSolverr (docker run -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest).'
                )
              )
            );
            return;
          }
          settle(() => resolve(html));
        })
        .catch((err) =>
          settle(() => reject(err instanceof Error ? err : new Error(String(err))))
        );
    }, timeoutMs);

    win.on('closed', () => {
      if (unlockWindow === win) unlockWindow = null;
      if (!settled) {
        settled = true;
        clearInterval(pollTimer);
        clearTimeout(hardTimeout);
        reject(new Error('UIndex unlock window was closed before Cloudflare cleared.'));
      }
    });

    // CF Turnstile iframes often abort (ERR_ABORTED / -3); ignore non-main-frame noise.
    win.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
        if (!isMainFrame) return;
        if (errorCode === -3) return;
        settle(() =>
          reject(new Error(`UIndex page failed to load (${errorCode}): ${errorDescription}`))
        );
      }
    );

    void win
      .loadURL(url, {
        userAgent: UINDEX_UA,
        httpReferrer: 'https://uindex.org/',
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (/ERR_ABORTED|-3/i.test(msg)) return;
        settle(() => reject(err instanceof Error ? err : new Error(msg)));
      });
  });
}

/** Open homepage in visible unlock window so user can clear CF without searching. */
export async function openUindexUnlockWindow(): Promise<{ ok: boolean; message: string }> {
  try {
    const html = await fetchUindexHtmlViaUnlockWindow('https://uindex.org/', 120_000);
    if (isCloudflareChallenge(200, html) && !html.includes('magnet:?') && !htmlLooksReady(html)) {
      return { ok: false, message: 'Cloudflare challenge did not clear.' };
    }
    return { ok: true, message: 'UIndex unlocked — cookies saved for future searches.' };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fetchUindexHtmlViaSession(url: string): Promise<{ status: number; html: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await getUindexSession().fetch(url, {
      headers: UINDEX_HEADERS,
      signal: controller.signal,
    });
    const html = await res.text();
    return { status: res.status, html };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * FlareSolverr: POST /v1 request.get, then parse solution.response HTML directly.
 * Do NOT cookie-replay to uindex — CF detects replay.
 */
async function fetchUindexHtmlViaFlareSolverr(
  settings: AppSettings,
  url: string
): Promise<string> {
  const base = (settings.flaresolverrUrl || 'http://127.0.0.1:8191').replace(/\/$/, '');
  const endpoint = `${base}/v1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        cmd: 'request.get',
        url,
        maxTimeout: 60000,
      }),
    });
    if (!res.ok) {
      throw new Error(`FlareSolverr HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      status?: string;
      message?: string;
      solution?: { response?: string; status?: number };
    };
    if (data.status !== 'ok' || !data.solution?.response) {
      throw new Error(data.message || 'FlareSolverr did not return a solution.response');
    }
    return data.solution.response;
  } finally {
    clearTimeout(timer);
  }
}

async function loadUindexHtml(settings: AppSettings, url: string): Promise<string> {
  // 1) session.fetch with persist:uindex (cookies from prior unlock)
  let sessionHitCf = false;
  try {
    const { status, html } = await fetchUindexHtmlViaSession(url);
    if (!isCloudflareChallenge(status, html)) {
      if (status >= 400) throw new Error(`UIndex HTTP ${status}`);
      if (!html || html.length < 200) throw new Error('UIndex returned an empty page.');
      return html;
    }
    sessionHitCf = true;
  } catch (err) {
    if (err instanceof Error && /^UIndex HTTP \d+/.test(err.message)) throw err;
    if (err instanceof Error && err.message.includes('empty page')) throw err;
    sessionHitCf = true;
  }

  // 2) Optional FlareSolverr — parse solution.response directly (no cookie replay)
  if (settings.useFlareSolverr) {
    try {
      const html = await fetchUindexHtmlViaFlareSolverr(settings, url);
      if (html && !(isCloudflareChallenge(200, html) && !html.includes('magnet:?'))) {
        return html;
      }
    } catch (err) {
      // Fall through to visible unlock window
      if (!sessionHitCf) {
        // still try unlock
      }
      void err;
    }
  }

  // 3) Visible unlock BrowserWindow (primary path for Turnstile on Windows)
  return fetchUindexHtmlViaUnlockWindow(url, 120_000);
}

async function searchUindex(settings: AppSettings, query: string): Promise<SearchResult[]> {
  // TV category c=2 — also try uncategorized if that returns empty after a real page load
  const withCat = `https://uindex.org/search.php?search=${encodeURIComponent(query)}&c=2`;
  const noCat = `https://uindex.org/search.php?search=${encodeURIComponent(query)}`;

  const html = await loadUindexHtml(settings, withCat);
  if (isCloudflareChallenge(200, html) && !html.includes('magnet:?')) {
    throw new Error(
      'UIndex is blocked by Cloudflare. Open Settings → Unlock UIndex (Cloudflare), or enable FlareSolverr.'
    );
  }
  let results = parseUindexHtml(html);
  if (results.length === 0) {
    try {
      const htmlAll = await loadUindexHtml(settings, noCat);
      if (!(isCloudflareChallenge(200, htmlAll) && !htmlAll.includes('magnet:?'))) {
        results = parseUindexHtml(htmlAll);
      }
    } catch {
      // Keep empty results from the TV-category attempt
    }
  }
  return results;
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
      searchUindex(settings, query)
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
  // Only surface errors that are still actionable (all paths failed for that source)
  const error = errors.length > 0 ? errors.join(' | ') : undefined;

  return { results: ranked, query, error };
}
