const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const SERVER_EXE = 'Plex Media Server.exe';
const HELPER_EXES = [
  'Plex Tuner Service.exe',
  'Plex Script Host.exe',
  'Plex Media Scanner.exe',
  'Plex Transcoder.exe',
];
const FALLBACK_EXES = [
  'C:\\Program Files\\Plex\\Plex Media Server\\Plex Media Server.exe',
  'C:\\Program Files (x86)\\Plex\\Plex Media Server\\Plex Media Server.exe',
];

function preferencesPath() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'Plex Media Server', 'Preferences.xml');
}

function tokenFile() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'Nightfeed', 'plex-control-token.txt');
}

function normalizeToken(raw) {
  const text = String(raw || '').trim();
  const fromUrl = text.match(/X-Plex-Token=([^&\s"']+)/i);
  const token = decodeURIComponent(fromUrl ? fromUrl[1] : text);
  if (!token) return '';
  if (!/^[A-Za-z0-9._~-]{8,200}$/.test(token)) {
    throw new Error('That does not look like a Plex token. Paste only the X-Plex-Token value.');
  }
  return token;
}

function parseDotNetDate(value) {
  if (!value) return null;
  const match = String(value).match(/Date\((\d+)\)/);
  const date = match ? new Date(Number(match[1])) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatUptime(start) {
  if (!start) return '';
  const ms = Date.now() - start.getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60000);
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const mins = minutes % 60;
  if (days) return days + 'd ' + hours + 'h';
  if (hours) return hours + 'h ' + mins + 'm';
  return Math.max(mins, 0) + 'm';
}

function formatMb(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n / (1024 * 1024));
}

function asList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function readAttr(xml, name) {
  const match = String(xml || '').match(new RegExp(name + '="([^"]*)"'));
  return match ? match[1] : '';
}

function readPreferences() {
  try {
    const xml = fs.readFileSync(preferencesPath(), 'utf8');
    return {
      friendlyName: readAttr(xml, 'FriendlyName'),
      token: readAttr(xml, 'PlexOnlineToken'),
    };
  } catch {
    return { friendlyName: '', token: '' };
  }
}

function readSavedToken() {
  try {
    return normalizeToken(fs.readFileSync(tokenFile(), 'utf8'));
  } catch {
    return '';
  }
}

function tokenInfo() {
  const prefs = readPreferences();
  const saved = readSavedToken();
  if (saved) return { token: saved, source: 'saved', friendlyName: prefs.friendlyName };
  if (prefs.token) return { token: prefs.token, source: 'plex', friendlyName: prefs.friendlyName };
  return { token: '', source: '', friendlyName: prefs.friendlyName };
}

function saveToken(raw) {
  const token = normalizeToken(raw);
  if (!token) throw new Error('Paste a Plex token first.');
  const file = tokenFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
}

function clearToken() {
  try {
    fs.unlinkSync(tokenFile());
  } catch {
    // already gone
  }
}

async function runPowerShell(script) {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 }
  );
  return String(stdout || '').trim();
}

async function serverProcesses() {
  const script = [
    "$p = Get-CimInstance Win32_Process -Filter \"Name = 'Plex Media Server.exe'\"",
    '$p | Select-Object ProcessId,WorkingSetSize,CreationDate,ExecutablePath | ConvertTo-Json -Compress',
  ].join('; ');
  const raw = await runPowerShell(script);
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return asList(parsed).map((row) => ({
    pid: Number(row.ProcessId) || null,
    memoryMb: formatMb(row.WorkingSetSize),
    started: parseDotNetDate(row.CreationDate),
    path: String(row.ExecutablePath || ''),
  })).filter((row) => row.pid);
}

async function findInstalledExe() {
  for (const candidate of FALLBACK_EXES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const script = [
    "$keys = @(",
    "'HKCU:\\Software\\Plex, Inc.\\Plex Media Server',",
    "'HKLM:\\Software\\Plex, Inc.\\Plex Media Server',",
    "'HKLM:\\Software\\WOW6432Node\\Plex, Inc.\\Plex Media Server'",
    ')',
    'foreach ($key in $keys) {',
    '  $item = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue',
    '  if ($item.InstallFolder) { Write-Output $item.InstallFolder; break }',
    '}',
  ].join('\n');
  let folder = '';
  try {
    folder = (await runPowerShell(script)).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || '';
  } catch {
    folder = '';
  }
  if (!folder) return '';
  const exe = path.join(folder, SERVER_EXE);
  return fs.existsSync(exe) ? exe : '';
}

async function taskkill(image, force) {
  const args = force ? ['/F', '/IM', image] : ['/IM', image];
  try {
    await execFileAsync('taskkill', args, { windowsHide: true, timeout: 20000 });
    return true;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (/not found|no running instance|not running/i.test(message)) return false;
    if (!force && /could not be terminated|access is denied/i.test(message)) return false;
    throw err;
  }
}

async function waitUntilStopped(attempts) {
  for (let i = 0; i < attempts; i += 1) {
    const rows = await serverProcesses();
    if (!rows.length) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function fetchJson(url, token) {
  const headers = { Accept: 'application/json' };
  if (token) headers['X-Plex-Token'] = token;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error('Plex HTTP ' + res.status);
  return res.json();
}

function sessionProgress(item) {
  const duration = Number(item.duration) || 0;
  const offset = Number(item.viewOffset) || 0;
  if (!duration || offset < 0) return '';
  return Math.min(100, Math.round((offset / duration) * 100)) + '%';
}

function parseSessions(payload) {
  const container = payload && (payload.MediaContainer || payload);
  const rows = asList(container && (container.Metadata || container.metadata));
  return rows.slice(0, 12).map((item) => ({
    title: String(item.title || item.grandparentTitle || 'Untitled'),
    user: String((item.User && (item.User.title || item.User.name)) || ''),
    player: String((item.Player && (item.Player.title || item.Player.product)) || ''),
    progress: sessionProgress(item),
  }));
}

async function serverInfo(running) {
  const auth = tokenInfo();
  let version = '';
  let sessions = [];
  let sessionsNote = '';
  if (running) {
    try {
      const identity = await fetchJson('http://127.0.0.1:32400/identity', '');
      const container = identity && (identity.MediaContainer || identity);
      version = String((container && container.version) || '');
    } catch {
      version = '';
    }
    if (auth.token) {
      try {
        const body = await fetchJson('http://127.0.0.1:32400/status/sessions', auth.token);
        sessions = parseSessions(body);
      } catch (err) {
        sessionsNote = err && err.message ? err.message : 'Could not read sessions';
      }
    } else {
      sessionsNote = 'Paste a Plex token below to show who is watching.';
    }
  }
  return {
    friendlyName: auth.friendlyName || 'Plex Media Server',
    version,
    sessions,
    sessionsNote,
    tokenSource: auth.source,
  };
}

async function snapshot(note) {
  const processes = await serverProcesses();
  const primary = processes[0] || null;
  const installed = primary && primary.path ? primary.path : await findInstalledExe();
  const info = await serverInfo(!!primary);
  return {
    running: !!primary,
    count: processes.length,
    pid: primary ? primary.pid : null,
    memoryMb: processes.reduce((sum, row) => sum + (row.memoryMb || 0), 0) || null,
    uptime: primary ? formatUptime(primary.started) : '',
    path: installed || '',
    friendlyName: info.friendlyName,
    version: info.version,
    sessions: info.sessions,
    sessionsNote: info.sessionsNote,
    tokenSource: info.tokenSource,
    note: note || '',
    checkedAt: new Date().toISOString(),
  };
}

async function startServer() {
  const current = await serverProcesses();
  if (current.length) return snapshot('Already running.');
  const exe = await findInstalledExe();
  if (!exe) throw new Error('Could not find Plex Media Server.exe');
  const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  await waitUntilStopped(0);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const after = await snapshot('Start requested.');
  if (!after.running) after.note = 'Start was requested, but the process is not up yet.';
  return after;
}

async function stopServer(force) {
  const current = await serverProcesses();
  if (!current.length) return snapshot('Plex Media Server is not running.');
  let stopped = await taskkill(SERVER_EXE, force);
  if (!stopped && !force) stopped = await taskkill(SERVER_EXE, true);
  for (const image of HELPER_EXES) {
    try {
      await taskkill(image, true);
    } catch {
      // A helper that is already gone is fine.
    }
  }
  const gone = await waitUntilStopped(8);
  const after = await snapshot(force ? 'Kill requested.' : 'Stop requested.');
  if (!gone && after.running) after.note = 'Plex is still running.';
  return after;
}

async function restartServer() {
  await stopServer(false);
  return startServer();
}

function openWeb() {
  const child = spawn('cmd.exe', ['/c', 'start', '', 'http://127.0.0.1:32400/web'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function telegramText(status) {
  const lines = [
    status.friendlyName || 'Plex Media Server',
    status.running ? 'Running' : 'Stopped',
  ];
  if (status.version) lines.push('Version ' + status.version);
  if (status.running) {
    const bits = [];
    if (status.pid) bits.push('PID ' + status.pid);
    if (status.memoryMb) bits.push(status.memoryMb + ' MB');
    if (status.uptime) bits.push('up ' + status.uptime);
    if (status.count > 1) bits.push(status.count + ' processes');
    if (bits.length) lines.push(bits.join(' · '));
  }
  if (status.path) lines.push(status.path);
  if (status.sessions && status.sessions.length) {
    lines.push('', 'Watching:');
    for (const item of status.sessions) {
      const who = [item.user, item.player].filter(Boolean).join(' · ');
      lines.push('- ' + item.title + (who ? ' (' + who + ')' : '') + (item.progress ? ' ' + item.progress : ''));
    }
  } else if (status.running) {
    lines.push('', status.tokenSource
      ? (status.sessionsNote || 'Nobody is watching.')
      : 'Nobody is watching, or no Plex token is saved. Add it on the Plex tab in Nightfeed.');
  }
  if (status.note) lines.push('', status.note);
  lines.push('', '/plex status | start | stop | kill | restart | web');
  return lines.join('\n');
}

async function runCommand(args) {
  const verb = String(args || '').trim().toLowerCase().split(/\s+/)[0] || 'status';
  if (verb === 'start') return telegramText(await startServer());
  if (verb === 'stop') return telegramText(await stopServer(false));
  if (verb === 'kill') return telegramText(await stopServer(true));
  if (verb === 'restart') return telegramText(await restartServer());
  if (verb === 'web') {
    openWeb();
    return 'Opening http://127.0.0.1:32400/web on this PC.';
  }
  if (verb !== 'status' && verb !== 'sessions') {
    return 'Use /plex status, start, stop, kill, restart, or web.';
  }
  return telegramText(await snapshot(''));
}

module.exports = {
  snapshot,
  saveToken,
  clearToken,
  startServer,
  stopServer,
  restartServer,
  openWeb,
  runCommand,
  parseSessions,
  readAttr,
};
