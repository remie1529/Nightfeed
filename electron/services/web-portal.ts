import http from 'http';
import { URL } from 'url';
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'crypto';
import type { AppSettings, TelegramRequest } from '../types';

export type WebPortalSearchShow = {
  id: number;
  name: string;
  overview?: string;
  firstAirDate?: string | null;
  posterUrl?: string | null;
};

export type WebPortalSearchMovie = {
  id: number;
  title: string;
  overview?: string;
  releaseYear?: number | null;
  posterUrl?: string | null;
};

export type WebPortalSubmitInput = {
  mediaType: 'show' | 'movie';
  mediaId: number;
  title: string;
  year?: number | null;
  overview?: string;
  posterUrl?: string | null;
  requesterName?: string;
};

export type WebPortalDeps = {
  getSettings: () => AppSettings;
  searchShows: (query: string) => Promise<WebPortalSearchShow[]>;
  searchMovies: (query: string) => Promise<WebPortalSearchMovie[]>;
  isInLibrary: (mediaType: 'show' | 'movie', mediaId: number) => boolean;
  submitRequest: (
    input: WebPortalSubmitInput
  ) => Promise<{ ok: boolean; message: string; request?: TelegramRequest }>;
  listRequests: () => TelegramRequest[];
  /** Backfill missing posterUrl from TVMaze/IMDb when possible. */
  enrichRequests?: (requests: TelegramRequest[]) => Promise<TelegramRequest[]>;
  resolveRequest: (
    id: string,
    action: 'approved' | 'denied'
  ) => Promise<{ ok: boolean; message: string }>;
};

const COOKIE_NAME = 'nf_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Hash admin password with scrypt. Never log the plaintext. */
export function hashWebPortalPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyWebPortalPassword(password: string, stored: string): boolean {
  if (!stored || !password) return false;
  const parts = stored.split(':');
  if (parts[0] !== 'scrypt' || parts.length !== 3) return false;
  const salt = parts[1];
  const expected = Buffer.from(parts[2], 'hex');
  let test: Buffer;
  try {
    test = scryptSync(password, salt, 64);
  } catch {
    return false;
  }
  if (test.length !== expected.length) return false;
  return timingSafeEqual(test, expected);
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function shellCss(): string {
  return `
:root {
  --bg: #121212;
  --bg-elevated: #1a1a1a;
  --bg-hover: #222222;
  --bg-input: #0e0e0e;
  --border: #2a2a2a;
  --border-strong: #3a3a3a;
  --text: #e8e6e3;
  --text-dim: #9a9690;
  --accent: #d4a017;
  --accent-dim: #a67c0f;
  --accent-soft: rgba(212,160,23,0.12);
  --danger: #c45c5c;
  --ok: #6a9a6a;
  --font: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
  --radius: 8px;
}
* { box-sizing: border-box; }
html { scrollbar-width: thin; scrollbar-color: #3a3a3a #121212; }
body {
  margin: 0; min-height: 100vh;
  background: radial-gradient(1200px 500px at 10% -10%, #1c180e 0%, #121212 55%);
  color: var(--text);
  font-family: var(--font); font-size: 15px; line-height: 1.5;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.wrap { max-width: 880px; margin: 0 auto; padding: 1.75rem 1.2rem 3.5rem; }
.wrap.wide { max-width: 1080px; }
.topbar { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 1.5rem; }
.brand { display: flex; align-items: baseline; gap: 0.65rem; }
.brand h1 { margin: 0; font-size: 1.45rem; letter-spacing: 0.02em; color: var(--accent); }
.brand span { color: var(--text-dim); font-size: 0.88rem; }
.nav { display: flex; gap: 0.4rem; }
.nav a {
  color: var(--text-dim); padding: 0.35rem 0.7rem; border-radius: 999px;
  text-decoration: none; border: 1px solid transparent;
}
.nav a:hover { color: var(--text); background: var(--bg-hover); text-decoration: none; }
.nav a.active { color: var(--accent); background: var(--accent-soft); border-color: var(--accent-dim); }
.hero { margin-bottom: 1.1rem; }
.hero h2 { margin: 0 0 0.35rem; font-size: 1.35rem; }
.hero p { margin: 0; color: var(--text-dim); }
.card {
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: 12px; padding: 1.15rem 1.2rem; margin-bottom: 1rem;
  box-shadow: 0 10px 40px rgba(0,0,0,0.25);
}
.field { margin-bottom: 0.95rem; }
.field label { display: block; margin-bottom: 0.4rem; color: var(--text-dim); font-size: 0.82rem; font-weight: 500; }
input, select, button { font: inherit; color: inherit; }
input, select {
  width: 100%; background: var(--bg-input); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 0.65rem 0.8rem; outline: none;
}
input:focus, select:focus { border-color: var(--accent-dim); }
.row { display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: center; }
.pills { display: flex; gap: 0.45rem; }
.pill {
  border: 1px solid var(--border-strong); background: transparent; color: var(--text-dim);
  border-radius: 999px; padding: 0.4rem 0.9rem; cursor: pointer;
}
.pill.on { background: var(--accent); border-color: var(--accent); color: #1a1408; font-weight: 600; }
button {
  cursor: pointer; border: 1px solid var(--border-strong);
  background: var(--bg-elevated); border-radius: var(--radius);
  padding: 0.55rem 0.95rem;
}
button:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--accent-dim); }
button:disabled { opacity: 0.45; cursor: not-allowed; }
button.primary {
  background: var(--accent); border-color: var(--accent);
  color: #1a1408; font-weight: 600;
}
button.primary:hover:not(:disabled) { background: #e0b328; border-color: #e0b328; }
button.danger { border-color: var(--danger); color: #f0c0c0; }
button.ok { border-color: var(--ok); color: #c8e0c8; }
.hint { color: var(--text-dim); font-size: 0.85rem; margin-top: 0.35rem; }
.msg { margin-top: 0.75rem; padding: 0.7rem 0.85rem; border-radius: var(--radius); border: 1px solid var(--border); }
.msg.ok { border-color: var(--ok); color: #c8e0c8; background: #1a241a; }
.msg.err { border-color: var(--danger); color: #f0c0c0; background: #241a1a; }
.msg.info { border-color: var(--accent-dim); background: var(--accent-soft); }
.results { display: flex; flex-direction: column; gap: 0.65rem; }
.result {
  display: flex; gap: 0.9rem; align-items: stretch;
  padding: 0.75rem; border: 1px solid var(--border); border-radius: 10px;
  background: #161616;
}
.poster {
  width: 72px; height: 108px; object-fit: cover; border-radius: 6px;
  background: #0a0a0a; flex-shrink: 0;
}
.result-body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.result-title { font-weight: 650; font-size: 1.02rem; }
.result-meta { color: var(--text-dim); font-size: 0.88rem; margin-top: 0.25rem; flex: 1; }
.badge {
  display: inline-block; font-size: 0.72rem; padding: 0.18rem 0.5rem;
  border-radius: 999px; border: 1px solid var(--border); color: var(--text-dim);
  text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600;
}
.badge.pending { border-color: var(--accent-dim); color: var(--accent); background: var(--accent-soft); }
.badge.approved { border-color: var(--ok); color: #c8e0c8; background: #1a241a; }
.badge.denied { border-color: var(--danger); color: #f0c0c0; background: #241a1a; }
.stats { display: flex; gap: 0.7rem; flex-wrap: wrap; margin-bottom: 1rem; }
.stat {
  flex: 1; min-width: 120px; background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: 10px; padding: 0.75rem 0.9rem;
}
.stat b { display: block; font-size: 1.35rem; color: var(--accent); }
.table { width: 100%; border-collapse: collapse; }
.table th, .table td {
  text-align: left; padding: 0.7rem 0.45rem; border-bottom: 1px solid var(--border);
  vertical-align: top;
}
.table th { color: var(--text-dim); font-weight: 500; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.05em; }
.req-cell { display: flex; gap: 0.85rem; align-items: flex-start; }
.req-poster {
  width: 56px; height: 84px; object-fit: cover; border-radius: 6px;
  background: #0a0a0a; flex-shrink: 0;
}
.req-poster.ph { display: grid; place-items: center; color: var(--text-dim); font-size: 0.65rem; }
.status-card { display: flex; gap: 0.9rem; align-items: center; }
@media (max-width: 640px) {
  .poster { width: 56px; height: 84px; }
  .req-poster { width: 44px; height: 66px; }
}
`;
}

function layout(title: string, body: string, active: 'request' | 'admin', wide = false): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · Nightfeed</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
  <style>${shellCss()}</style>
</head>
<body>
  <div class="wrap${wide ? ' wide' : ''}">
    <div class="topbar">
      <div class="brand"><h1>Nightfeed</h1><span>${escapeHtml(title)}</span></div>
      <div class="nav">
        <a href="/request"${active === 'request' ? ' class="active"' : ''}>Request</a>
        <a href="/admin"${active === 'admin' ? ' class="active"' : ''}>Admin</a>
      </div>
    </div>
    ${body}
  </div>
</body>
</html>`;
}

function requestPageHtml(): string {
  const body = `
<div class="hero">
  <h2>Request a title</h2>
  <p>Search TV or movies and send a request. No account needed.</p>
</div>
<div class="card">
  <div class="field">
    <label>Type</label>
    <div class="pills">
      <button type="button" class="pill on" id="typeShow">TV show</button>
      <button type="button" class="pill" id="typeMovie">Movie</button>
    </div>
    <input type="hidden" id="mediaType" value="show" />
  </div>
  <div class="field">
    <label>Search</label>
    <div class="row">
      <input id="query" placeholder="Title…" style="flex:1" autofocus />
      <button type="button" class="primary" id="searchBtn">Search</button>
    </div>
    <div class="hint">TV via TVMaze · Movies via IMDb</div>
  </div>
  <div id="msg"></div>
</div>
<div id="statusBox" class="card" style="display:none"></div>
<div id="results" class="results" style="display:none"></div>
<script>
(function () {
  const $ = (id) => document.getElementById(id);
  const msg = (text, kind) => {
    const el = $('msg');
    el.innerHTML = text ? '<div class="msg ' + (kind || 'info') + '">' + text + '</div>' : '';
  };
  const trackId = localStorage.getItem('nf_last_request_id');
  if (trackId) pollStatus(trackId);

  async function pollStatus(id) {
    try {
      const res = await fetch('/api/request/' + encodeURIComponent(id));
      const data = await res.json();
      if (!data || !data.ok || !data.request) return;
      const r = data.request;
      const box = $('statusBox');
      box.style.display = 'block';
      const poster = r.posterUrl
        ? '<img class="poster" src="' + escape(r.posterUrl) + '" alt="" />'
        : '<div class="poster"></div>';
      box.innerHTML = '<div class="status-card">' + poster + '<div>' +
        '<div style="font-weight:650;margin-bottom:0.3rem">Your request</div>' +
        '<div>' + escape(r.title) + (r.year ? ' (' + r.year + ')' : '') +
        ' · <span class="badge ' + r.status + '">' + r.status + '</span></div>' +
        '<div class="hint">Id: ' + escape(r.id) + '</div></div></div>';
    } catch (_) {}
  }

  function escape(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  $('searchBtn').onclick = async () => {
    const query = $('query').value.trim();
    const mediaType = $('mediaType').value;
    if (!query) { msg('Enter a title to search.', 'err'); return; }
    msg('Searching…');
    $('results').style.display = 'none';
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaType, query })
      });
      const data = await res.json();
      if (!data.ok) { msg(data.message || 'Search failed', 'err'); return; }
      const items = data.results || [];
      if (!items.length) { msg('No results for “' + escape(query) + '”.', 'err'); return; }
      msg('Pick a result to submit a request.', 'info');
      const box = $('results');
      box.style.display = 'block';
      box.innerHTML = items.map((it) => {
        const title = mediaType === 'movie' ? it.title : it.name;
        const year = mediaType === 'movie'
          ? (it.releaseYear || '')
          : (it.firstAirDate ? String(it.firstAirDate).slice(0, 4) : '');
        const poster = it.posterUrl || '';
        return '<div class="result">' +
          (poster ? '<img class="poster" src="' + escape(poster) + '" alt="" />' : '<div class="poster"></div>') +
          '<div class="result-body"><div class="result-title">' + escape(title) +
          (year ? ' <span class="result-meta">(' + escape(String(year)) + ')</span>' : '') +
          '</div><div class="result-meta">' + escape((it.overview || '').slice(0, 160)) +
          '</div><div style="margin-top:0.45rem"><button type="button" class="primary submit-btn" data-id="' +
          it.id + '" data-title="' + escape(title) + '" data-year="' + escape(String(year || '')) +
          '" data-overview="' + escape(it.overview || '') + '" data-poster="' + escape(poster) +
          '">Request</button></div></div></div>';
      }).join('');
      box.querySelectorAll('.submit-btn').forEach((btn) => {
        btn.addEventListener('click', () => submitOne(btn));
      });
    } catch (e) {
      msg('Search error: ' + (e && e.message ? e.message : e), 'err');
    }
  };

  async function submitOne(btn) {
    const mediaType = $('mediaType').value;
    const payload = {
      mediaType,
      mediaId: Number(btn.getAttribute('data-id')),
      title: btn.getAttribute('data-title') || '',
      year: btn.getAttribute('data-year') ? Number(btn.getAttribute('data-year')) : null,
      overview: btn.getAttribute('data-overview') || '',
      posterUrl: btn.getAttribute('data-poster') || undefined
    };
    btn.disabled = true;
    msg('Submitting…');
    try {
      const res = await fetch('/api/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!data.ok) {
        msg(data.message || 'Request failed', 'err');
        btn.disabled = false;
        return;
      }
      msg(data.message || 'Submitted', 'ok');
      if (data.request && data.request.id) {
        localStorage.setItem('nf_last_request_id', data.request.id);
        pollStatus(data.request.id);
      }
    } catch (e) {
      msg('Submit error: ' + (e && e.message ? e.message : e), 'err');
      btn.disabled = false;
    }
  }

  function setType(t) {
    $('mediaType').value = t;
    $('typeShow').classList.toggle('on', t === 'show');
    $('typeMovie').classList.toggle('on', t === 'movie');
  }
  $('typeShow').onclick = () => setType('show');
  $('typeMovie').onclick = () => setType('movie');
  $('query').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('searchBtn').click();
  });
})();
</script>`;
  return layout('Request', body, 'request');
}

function adminLoginHtml(error?: string): string {
  const body = `
<div class="hero">
  <h2>Admin</h2>
  <p>Approve or deny incoming requests.</p>
</div>
<div class="card" style="max-width:440px">
  <form method="POST" action="/admin/login">
    <div class="field">
      <label>Password</label>
      <input type="password" name="password" autocomplete="current-password" required autofocus />
    </div>
    ${error ? `<div class="msg err">${escapeHtml(error)}</div>` : ''}
    <button type="submit" class="primary">Log in</button>
  </form>
  <div class="hint" style="margin-top:0.75rem">Set in Nightfeed Settings → Web portal.</div>
</div>`;
  return layout('Admin login', body, 'admin');
}

function adminPageHtml(pending: TelegramRequest[], recent: TelegramRequest[]): string {
  const posterHtml = (r: TelegramRequest) => {
    const url = (r.posterUrl || '').trim();
    if (url) {
      return `<img class="req-poster" src="${escapeHtml(url)}" alt="" loading="lazy" />`;
    }
    return `<div class="req-poster ph">No art</div>`;
  };
  const row = (r: TelegramRequest, actions: boolean) => {
    const type = r.mediaType === 'movie' ? 'Movie' : 'TV';
    const year = r.year ? ` (${r.year})` : '';
    const who = r.requesterName || (r.requesterChatId ? `tg:${r.requesterChatId}` : 'Web');
    const src = r.source === 'web' ? 'web' : 'telegram';
    return `<tr>
      <td><code>${escapeHtml(r.id)}</code></td>
      <td><div class="req-cell">${posterHtml(r)}<div>
        <div style="font-weight:650">${escapeHtml(type)}: ${escapeHtml(r.title)}${escapeHtml(year)}</div>
        <div class="hint">${escapeHtml(src)} · ${escapeHtml(who)}${
          r.overview ? ' · ' + escapeHtml(r.overview.slice(0, 140)) : ''
        }</div>
      </div></div></td>
      <td><span class="badge ${escapeHtml(r.status)}">${escapeHtml(r.status)}</span></td>
      <td>${
        actions
          ? `<div class="row">
              <form method="POST" action="/admin/approve" style="display:inline">
                <input type="hidden" name="id" value="${escapeHtml(r.id)}" />
                <button type="submit" class="ok">Approve</button>
              </form>
              <form method="POST" action="/admin/deny" style="display:inline">
                <input type="hidden" name="id" value="${escapeHtml(r.id)}" />
                <button type="submit" class="danger">Deny</button>
              </form>
            </div>`
          : escapeHtml(r.resolvedAt ? new Date(r.resolvedAt).toLocaleString() : '—')
      }</td>
    </tr>`;
  };

  const body = `
<div class="row" style="justify-content:space-between;margin-bottom:0.85rem">
  <div class="hint">Same approve/deny pipeline as Telegram. Auto-refreshes every 30s.</div>
  <form method="POST" action="/admin/logout"><button type="submit">Log out</button></form>
</div>
<div class="stats">
  <div class="stat"><b>${pending.length}</b> pending</div>
  <div class="stat"><b>${recent.filter((r) => r.status === 'approved').length}</b> approved</div>
  <div class="stat"><b>${recent.filter((r) => r.status === 'denied').length}</b> denied</div>
</div>
<div class="card">
  <div style="font-weight:600;margin-bottom:0.5rem">Pending</div>
  ${
    pending.length
      ? `<table class="table"><thead><tr><th>Id</th><th>Title</th><th>Status</th><th></th></tr></thead>
         <tbody>${pending.map((r) => row(r, true)).join('')}</tbody></table>`
      : `<div class="hint">No pending requests.</div>`
  }
</div>
<div class="card">
  <div style="font-weight:600;margin-bottom:0.5rem">Recent</div>
  ${
    recent.length
      ? `<table class="table"><thead><tr><th>Id</th><th>Title</th><th>Status</th><th>Resolved</th></tr></thead>
         <tbody>${recent.map((r) => row(r, false)).join('')}</tbody></table>`
      : `<div class="hint">No recent decisions yet.</div>`
  }
</div>
<script>setTimeout(function(){ if (!document.hidden) location.reload(); }, 30000);</script>`;
  return layout('Admin', body, 'admin', true);
}

export function portalBindHost(settings: AppSettings): string {
  return settings.webPortalBind === 'lan' ? '0.0.0.0' : '127.0.0.1';
}

export function portalPublicUrls(settings: AppSettings, lanIp?: string | null): string[] {
  const port = settings.webPortalPort || 8787;
  const urls = [`http://127.0.0.1:${port}/`];
  if (settings.webPortalBind === 'lan') {
    if (lanIp) urls.push(`http://${lanIp}:${port}/`);
    else urls.push(`http://<LAN-IP>:${port}/`);
  }
  return urls;
}

export class WebPortalServer {
  private server: http.Server | null = null;
  private listening = false;
  private lastError: string | null = null;
  private deps: WebPortalDeps | null = null;
  private bindHost = '127.0.0.1';
  private port = 8787;

  setDeps(deps: WebPortalDeps) {
    this.deps = deps;
  }

  getStatus(settings: AppSettings): {
    enabled: boolean;
    listening: boolean;
    port: number;
    bind: string;
    urls: string[];
    lastError: string | null;
    passwordSet: boolean;
  } {
    return {
      enabled: !!settings.webPortalEnabled,
      listening: this.listening,
      port: settings.webPortalPort || 8787,
      bind: portalBindHost(settings),
      urls: this.listening ? portalPublicUrls(settings) : [],
      lastError: this.lastError,
      passwordSet: !!(settings.webPortalAdminPasswordHash || '').trim(),
    };
  }

  sync(settings: AppSettings) {
    if (settings.webPortalEnabled) {
      void this.start(settings);
    } else {
      this.stop();
    }
  }

  stop() {
    if (this.server) {
      try {
        this.server.close();
      } catch {
        // ignore
      }
      this.server = null;
    }
    this.listening = false;
  }

  async start(settings: AppSettings): Promise<void> {
    const host = portalBindHost(settings);
    const port = Math.max(1, Math.min(65535, Number(settings.webPortalPort) || 8787));
    if (this.listening && this.server && this.bindHost === host && this.port === port) {
      return;
    }
    this.stop();
    this.bindHost = host;
    this.port = port;
    this.lastError = null;

    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;

    await new Promise<void>((resolve) => {
      server.once('error', (err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.listening = false;
        this.server = null;
        resolve();
      });
      server.listen(port, host, () => {
        this.listening = true;
        this.lastError = null;
        resolve();
      });
    });
  }

  private signSession(secret: string, exp: number): string {
    const payload = Buffer.from(JSON.stringify({ exp }), 'utf8').toString('base64url');
    const sig = createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  private verifySession(secret: string, token: string | undefined): boolean {
    if (!secret || !token) return false;
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [payload, sig] = parts;
    const expected = createHmac('sha256', secret).update(payload).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
      if (!data.exp || Date.now() > data.exp) return false;
      return true;
    } catch {
      return false;
    }
  }

  private isAuthed(req: http.IncomingMessage, settings: AppSettings): boolean {
    const secret = (settings.webPortalSessionSecret || '').trim();
    const cookies = parseCookies(req.headers.cookie);
    return this.verifySession(secret, cookies[COOKIE_NAME]);
  }

  private setAuthCookie(res: http.ServerResponse, settings: AppSettings) {
    let secret = (settings.webPortalSessionSecret || '').trim();
    if (!secret) {
      // Should be ensured by settings migration; fall back ephemeral.
      secret = randomBytes(24).toString('hex');
    }
    const token = this.signSession(secret, Date.now() + SESSION_TTL_MS);
    const secure = '';
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
        SESSION_TTL_MS / 1000
      )}${secure}`
    );
  }

  private clearAuthCookie(res: http.ServerResponse) {
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
    );
  }

  private send(res: http.ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8') {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown) {
    this.send(res, status, JSON.stringify(data), 'application/json; charset=utf-8');
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      if (!this.deps) {
        this.send(res, 503, 'Portal not ready');
        return;
      }
      const settings = this.deps.getSettings();
      if (!settings.webPortalEnabled) {
        this.send(res, 503, 'Web portal disabled');
        return;
      }

      const host = req.headers.host || `127.0.0.1:${this.port}`;
      const url = new URL(req.url || '/', `http://${host}`);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const method = (req.method || 'GET').toUpperCase();

      if (method === 'GET' && (path === '/' || path === '/request')) {
        this.send(res, 200, requestPageHtml());
        return;
      }

      if (method === 'GET' && path === '/admin') {
        if (!this.isAuthed(req, settings)) {
          this.send(res, 200, adminLoginHtml());
          return;
        }
        let all = this.deps.listRequests();
        if (this.deps.enrichRequests) {
          try {
            all = await this.deps.enrichRequests(all);
          } catch {
            // keep unenriched
          }
        }
        const pending = all.filter((r) => r.status === 'pending').slice(-50).reverse();
        const recent = all
          .filter((r) => r.status !== 'pending')
          .slice(-30)
          .reverse();
        this.send(res, 200, adminPageHtml(pending, recent));
        return;
      }

      if (method === 'POST' && path === '/admin/login') {
        const raw = await readBody(req);
        const params = new URLSearchParams(raw);
        const password = params.get('password') || '';
        const hash = (settings.webPortalAdminPasswordHash || '').trim();
        if (!hash) {
          this.send(res, 200, adminLoginHtml('Set an admin password in Nightfeed Settings first.'));
          return;
        }
        if (!verifyWebPortalPassword(password, hash)) {
          this.send(res, 200, adminLoginHtml('Invalid password.'));
          return;
        }
        this.setAuthCookie(res, settings);
        res.writeHead(303, { Location: '/admin', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }

      if (method === 'POST' && path === '/admin/logout') {
        this.clearAuthCookie(res);
        res.writeHead(303, { Location: '/admin', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }

      if (method === 'POST' && (path === '/admin/approve' || path === '/admin/deny')) {
        if (!this.isAuthed(req, settings)) {
          res.writeHead(303, { Location: '/admin' });
          res.end();
          return;
        }
        const raw = await readBody(req);
        const params = new URLSearchParams(raw);
        const id = (params.get('id') || '').trim();
        if (id) {
          const action = path.endsWith('approve') ? 'approved' : 'denied';
          await this.deps.resolveRequest(id, action);
        }
        res.writeHead(303, { Location: '/admin', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }

      if (method === 'POST' && path === '/api/search') {
        const body = (await readJson(req)) as { mediaType?: string; query?: string };
        const query = (body.query || '').trim();
        const mediaType = body.mediaType === 'movie' ? 'movie' : 'show';
        if (!query) {
          this.sendJson(res, 400, { ok: false, message: 'Query required' });
          return;
        }
        if (mediaType === 'show') {
          const results = await this.deps.searchShows(query);
          this.sendJson(res, 200, { ok: true, results: results.slice(0, 12) });
        } else {
          const results = await this.deps.searchMovies(query);
          this.sendJson(res, 200, { ok: true, results: results.slice(0, 12) });
        }
        return;
      }

      if (method === 'POST' && path === '/api/request') {
        const body = (await readJson(req)) as WebPortalSubmitInput;
        const mediaType = body.mediaType === 'movie' ? 'movie' : 'show';
        const mediaId = Number(body.mediaId);
        if (!mediaId || !body.title) {
          this.sendJson(res, 400, { ok: false, message: 'mediaId and title required' });
          return;
        }
        if (this.deps.isInLibrary(mediaType, mediaId)) {
          this.sendJson(res, 200, {
            ok: false,
            message: `Already in library: ${body.title}`,
          });
          return;
        }
        const result = await this.deps.submitRequest({
          mediaType,
          mediaId,
          title: String(body.title),
          year: body.year ?? null,
          overview: body.overview,
          posterUrl: body.posterUrl || null,
          requesterName: body.requesterName,
        });
        this.sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (method === 'GET' && path.startsWith('/api/request/')) {
        const id = decodeURIComponent(path.slice('/api/request/'.length));
        const reqItem = this.deps.listRequests().find((r) => r.id === id);
        if (!reqItem) {
          this.sendJson(res, 404, { ok: false, message: 'Not found' });
          return;
        }
        this.sendJson(res, 200, {
          ok: true,
          request: {
            id: reqItem.id,
            title: reqItem.title,
            year: reqItem.year,
            status: reqItem.status,
            mediaType: reqItem.mediaType,
          },
        });
        return;
      }

      if (method === 'GET' && path === '/api/admin/requests') {
        if (!this.isAuthed(req, settings)) {
          this.sendJson(res, 401, { ok: false, message: 'Unauthorized' });
          return;
        }
        this.sendJson(res, 200, { ok: true, requests: this.deps.listRequests().slice(-100).reverse() });
        return;
      }

      this.send(res, 404, 'Not found');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      try {
        this.sendJson(res, 500, { ok: false, message: 'Server error' });
      } catch {
        // ignore
      }
    }
  }
}

export const webPortal = new WebPortalServer();
