import { execFile } from 'child_process';
import { dialog, utilityProcess } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { resolveDistElectronAsset, buildUtilityProcessEnv } from './asset-path';

const execFileAsync = promisify(execFile);
const CATALOG_URL = 'https://raw.githubusercontent.com/remie1529/Nightfeed/main/addons/catalog.json';
const RAW_ROOT = 'https://raw.githubusercontent.com/remie1529/Nightfeed/main/addons';

export interface CatalogAddon {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  dir: string;
}

export interface InstalledAddon {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  enabled: boolean;
  source: 'store' | 'file';
  error: string;
}

export interface AddonPage {
  addonId: string;
  addonName: string;
  pageId: string;
  title: string;
  html: string;
  rev: number;
}

interface Manifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  api: number;
  main: string;
  files: string[];
}

interface RecordedAddon {
  id: string;
  enabled: boolean;
  source: 'store' | 'file';
  dirName: string;
}

interface AddonContext {
  userData: string;
  getShows: () => unknown[];
  getMovies: () => unknown[];
  addShow: (mazeId: number, policy?: 'all' | 'future' | 'manual') => Promise<unknown>;
  addMovie: (imdbNumericId: number) => Promise<unknown>;
  removeShow: (mazeId: number) => Promise<unknown>;
  removeMovie: (imdbNumericId: number) => Promise<unknown>;
  listDownloads: () => unknown[];
  notify: (message: string) => void;
  log: (level: 'info' | 'warn', message: string) => void;
  version: string;
  broadcast: (channel: string, payload?: unknown) => void;
}

interface AddonWorker {
  id: string;
  name: string;
  token: number;
  child: ReturnType<typeof utilityProcess.fork>;
  ready: boolean;
  stopping: boolean;
  done: boolean;
  finish: ((error: string | null) => void) | null;
  actions: Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>;
  telegram: Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>;
}

interface TelegramCommand {
  addonId: string;
  description: string;
}

let ctx: AddonContext | null = null;
const workers = new Map<string, AddonWorker>();
const pages = new Map<string, AddonPage>();
const loadErrors = new Map<string, string>();
let generation = 0;
let reloadChain: Promise<void> = Promise.resolve();
let actionSeq = 0;
const telegramCommands = new Map<string, TelegramCommand>();

function rootDir(): string {
  if (!ctx) throw new Error('Addons are not ready');
  return path.join(ctx.userData, 'addons');
}

function statePath(): string {
  return path.join(rootDir(), 'state.json');
}

function bundledAddonsDir(): string | null {
  const candidates = [
    path.join(process.resourcesPath, 'addons'),
    path.join(process.cwd(), 'addons'),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'catalog.json'))) || null;
}

function readState(): RecordedAddon[] {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as { addons?: RecordedAddon[] };
    return Array.isArray(raw.addons) ? raw.addons : [];
  } catch {
    return [];
  }
}

function writeState(addons: RecordedAddon[]) {
  fs.mkdirSync(rootDir(), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify({ addons }, null, 2), 'utf8');
}

function validId(id: string): boolean {
  return /^[a-z0-9][a-z0-9.-]{1,80}$/.test(id);
}

function safeRelative(file: string): string | null {
  const rel = String(file || '').replace(/\\/g, '/').trim();
  if (!rel || rel.startsWith('/') || rel.includes('..')) return null;
  if (!/^[a-zA-Z0-9._/-]+$/.test(rel)) return null;
  return rel;
}

function readManifest(dir: string, requireFiles = true): Manifest {
  const file = path.join(dir, 'addon.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Manifest>;
  const id = String(raw.id || '').trim();
  const main = safeRelative(String(raw.main || 'index.js'));
  const files = (Array.isArray(raw.files) ? raw.files : ['index.js'])
    .map((item) => safeRelative(String(item)))
    .filter((item): item is string => !!item);
  if (!validId(id)) throw new Error('Addon id must be lowercase letters, digits, dots, or dashes');
  if (Number(raw.api) !== 1) throw new Error('This addon needs API version 1');
  if (!main || !files.includes(main)) throw new Error('addon.json main must be listed in files');
  if (requireFiles && !fs.existsSync(path.join(dir, main))) throw new Error(`Missing ${main}`);
  return {
    id,
    name: String(raw.name || id).slice(0, 80),
    version: String(raw.version || '0.0.0').slice(0, 40),
    description: String(raw.description || '').slice(0, 400),
    author: String(raw.author || '').slice(0, 80),
    api: 1,
    main,
    files,
  };
}

function plain<T>(value: T): T {
  if (value === undefined) return null as T;
  return JSON.parse(JSON.stringify(value)) as T;
}

function pageKey(addonId: string, pageId: string): string {
  return `${addonId}:${pageId}`;
}

function pushPages() {
  ctx?.broadcast('addons:pages', listPages());
  ctx?.broadcast('addons:changed');
}

function clearPages(id: string) {
  let changed = false;
  for (const key of [...pages.keys()]) {
    if (key.startsWith(`${id}:`)) {
      pages.delete(key);
      changed = true;
    }
  }
  if (changed) pushPages();
}

function rejectWaiters(
  waiters: Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>,
  error: string
) {
  for (const waiter of waiters.values()) waiter.reject(new Error(error));
  waiters.clear();
}

function clearTelegramCommands(addonId: string) {
  for (const [command, owner] of telegramCommands) {
    if (owner.addonId === addonId) telegramCommands.delete(command);
  }
}

function stopWorker(id: string) {
  const worker = workers.get(id);
  if (!worker) return;
  worker.stopping = true;
  workers.delete(id);
  clearTelegramCommands(id);
  rejectWaiters(worker.actions, 'Addon worker stopped');
  rejectWaiters(worker.telegram, 'Addon worker stopped');
  try {
    worker.child.postMessage({ type: 'deactivate' });
  } catch {
    // The process may already be gone.
  }
  const timer = setTimeout(() => {
    try {
      worker.child.kill();
    } catch {
      // ignore
    }
  }, 1500);
  worker.child.once('exit', () => clearTimeout(timer));
}

function finishStart(worker: AddonWorker, error: string | null) {
  if (worker.done) return;
  worker.done = true;
  worker.finish?.(error);
}

function applyAddonEvent(worker: AddonWorker, msg: any) {
  const addonId = worker.id;
  const addonName = worker.name;
  if (msg.event === 'notify') {
    ctx?.notify(String(msg.message || '').slice(0, 240));
    return;
  }
  if (msg.event === 'log') {
    const level = msg.level === 'warn' ? 'warn' : 'info';
    ctx?.log(level, `${addonName}: ${String(msg.message || '').slice(0, 500)}`);
    return;
  }
  if (msg.event === 'addPage') {
    const pageId = String(msg.pageId || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(pageId)) return;
    pages.set(pageKey(addonId, pageId), {
      addonId,
      addonName,
      pageId,
      title: String(msg.title || pageId).slice(0, 80),
      html: String(msg.html || ''),
      rev: 1,
    });
    pushPages();
    return;
  }
  if (msg.event === 'setPage') {
    const existing = pages.get(pageKey(addonId, String(msg.pageId || '')));
    if (!existing) return;
    existing.html = String(msg.html || '');
    existing.rev += 1;
    ctx?.broadcast('addons:page', existing);
    ctx?.broadcast('addons:changed');
    return;
  }
  if (msg.event === 'openShow') {
    ctx?.broadcast('addons:navigate', { kind: 'show', id: Number(msg.id) });
    return;
  }
  if (msg.event === 'openMovie') {
    ctx?.broadcast('addons:navigate', { kind: 'movie', id: Number(msg.id) });
    return;
  }
  if (msg.event === 'telegram') {
    const command = String(msg.command || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!command || command.length > 32) return;
    telegramCommands.set(command, {
      addonId,
      description: String(msg.description || '').slice(0, 120),
    });
  }
}

async function answerCall(worker: AddonWorker, msg: { requestId: number; method?: string; args?: unknown[] }) {
  const args = Array.isArray(msg.args) ? msg.args : [];
  try {
    let result: unknown = null;
    if (msg.method === 'listShows') result = plain(ctx?.getShows() || []);
    else if (msg.method === 'listMovies') result = plain(ctx?.getMovies() || []);
    else if (msg.method === 'addShow') result = plain(await ctx!.addShow(Number(args[0]), args[1] as 'all' | 'future' | 'manual' | undefined));
    else if (msg.method === 'addMovie') result = plain(await ctx!.addMovie(Number(args[0])));
    else if (msg.method === 'removeShow') result = plain(await ctx!.removeShow(Number(args[0])));
    else if (msg.method === 'removeMovie') result = plain(await ctx!.removeMovie(Number(args[0])));
    else throw new Error('Unknown addon call');
    if (worker.stopping) return;
    worker.child.postMessage({ type: 'call-result', requestId: msg.requestId, ok: true, result });
  } catch (err) {
    if (worker.stopping) return;
    const error = err instanceof Error ? err.message : String(err);
    try {
      worker.child.postMessage({ type: 'call-result', requestId: msg.requestId, ok: false, error });
    } catch {
      // ignore
    }
  }
}

function markWorkerStopped(worker: AddonWorker, error: string) {
  if (worker.stopping || worker.token !== generation) return;
  workers.delete(worker.id);
  worker.stopping = true;
  clearTelegramCommands(worker.id);
  rejectWaiters(worker.actions, error);
  rejectWaiters(worker.telegram, error);
  try {
    worker.child.kill();
  } catch {
    // ignore
  }
  loadErrors.set(worker.id, error);
  clearPages(worker.id);
  ctx?.log('warn', `${worker.name}: ${error}`);
  ctx?.broadcast('addons:changed');
}

function launchWorker(record: RecordedAddon, manifest: Manifest, token: number): Promise<void> {
  const script = resolveDistElectronAsset('addon-worker.js');
  if (!fs.existsSync(script)) {
    const error = 'addon-worker.js missing';
    loadErrors.set(manifest.id, error);
    ctx?.log('warn', `${manifest.name}: ${error}`);
    return Promise.resolve();
  }
  const mainFile = path.join(rootDir(), record.dirName, manifest.main);
  let stderr = '';
  const child = utilityProcess.fork(script, [], {
    serviceName: `addon-${manifest.id.replace(/[^a-z0-9-]/g, '-')}`.slice(0, 48),
    stdio: 'pipe',
    env: buildUtilityProcessEnv(),
  });
  const worker: AddonWorker = {
    id: manifest.id,
    name: manifest.name,
    token,
    child,
    ready: false,
    stopping: false,
    done: false,
    finish: null,
    actions: new Map(),
    telegram: new Map(),
  };
  if (token !== generation) {
    try {
      child.kill();
    } catch {
      // ignore
    }
    return Promise.resolve();
  }
  workers.set(manifest.id, worker);
  const outcome = new Promise<string | null>((resolve) => {
    worker.finish = resolve;
  });
  const timer = setTimeout(() => finishStart(worker, 'Addon worker did not start'), 20000);

  child.stderr?.on('data', (buf: Buffer) => {
    stderr = (stderr + buf.toString()).slice(-800);
  });
  child.on('message', (msg: any) => {
    if (worker.stopping || worker.token !== generation) return;
    if (msg?.type === 'call') {
      void answerCall(worker, msg);
      return;
    }
    if (msg?.type === 'event') {
      applyAddonEvent(worker, msg);
      return;
    }
    if (msg?.type === 'ready') {
      worker.ready = true;
      clearTimeout(timer);
      finishStart(worker, null);
      return;
    }
    if (msg?.type === 'failed') {
      clearTimeout(timer);
      if (!worker.ready) finishStart(worker, String(msg.error || 'Addon failed'));
      else markWorkerStopped(worker, String(msg.error || 'Addon failed'));
      return;
    }
    if (msg?.type === 'activate-error') {
      const error = String(msg.error || 'Addon failed');
      loadErrors.set(worker.id, error);
      ctx?.log('warn', `${worker.name}: ${error}`);
      ctx?.broadcast('addons:changed');
      return;
    }
    if (msg?.type === 'action-result') {
      const waiter = worker.actions.get(msg.requestId);
      if (!waiter) return;
      worker.actions.delete(msg.requestId);
      if (msg.ok) waiter.resolve(msg.result);
      else waiter.reject(new Error(msg.error || 'Addon action failed'));
      return;
    }
    if (msg?.type === 'telegram-result') {
      const waiter = worker.telegram.get(msg.requestId);
      if (!waiter) return;
      worker.telegram.delete(msg.requestId);
      if (msg.ok) waiter.resolve(msg.text);
      else waiter.reject(new Error(msg.error || 'Addon command failed'));
    }
  });
  child.on('exit', (code) => {
    clearTimeout(timer);
    if (!worker.ready) {
      const detail = stderr.trim().slice(0, 300);
      finishStart(worker, detail || `Addon worker exited (${code})`);
      return;
    }
    if (!worker.stopping) markWorkerStopped(worker, `Addon worker exited (${code})`);
  });

  try {
    child.postMessage({
      type: 'load',
      mainFile,
      addonId: manifest.id,
      addonName: manifest.name,
      version: ctx?.version || '',
      downloads: plain(ctx?.listDownloads() || []),
    });
  } catch (err) {
    clearTimeout(timer);
    finishStart(worker, err instanceof Error ? err.message : String(err));
  }

  return outcome.then((error) => {
    if (token !== generation || worker.stopping) return;
    if (error) {
      loadErrors.set(manifest.id, error);
      ctx?.log('warn', `${manifest.name}: ${error}`);
      stopWorker(manifest.id);
      return;
    }
    loadErrors.delete(manifest.id);
    ctx?.log('info', `${manifest.name}: worker started`);
  });
}

async function reloadNow(): Promise<void> {
  const token = ++generation;
  for (const id of [...workers.keys()]) stopWorker(id);
  pages.clear();
  const records = readState();
  await Promise.all(
    records.map(async (record) => {
      if (!record.enabled || token !== generation) return;
      const dir = path.join(rootDir(), record.dirName);
      let manifest: Manifest;
      try {
        manifest = readManifest(dir);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        loadErrors.set(record.id, error);
        ctx?.log('warn', `${record.id}: ${error}`);
        return;
      }
      if (token !== generation) return;
      await launchWorker(record, manifest, token);
    })
  );
  if (token !== generation) return;
  pushPages();
}

function reloadAddons(): Promise<void> {
  const run = reloadChain.then(() => reloadNow());
  reloadChain = run.catch(() => undefined);
  return run;
}

export function listInstalled(): InstalledAddon[] {
  return readState().map((record) => {
    const dir = path.join(rootDir(), record.dirName);
    try {
      const manifest = readManifest(dir);
      return {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        enabled: record.enabled,
        source: record.source,
        error: loadErrors.get(manifest.id) || '',
      };
    } catch (err) {
      return {
        id: record.id,
        name: record.id,
        version: '',
        description: '',
        author: '',
        enabled: record.enabled,
        source: record.source,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

export function listPages(): AddonPage[] {
  return [...pages.values()];
}

export function renderAddonPage(addonId: string, pageId: string): string | null {
  const page = pages.get(pageKey(addonId, pageId));
  if (!page) return null;
  return `<!doctype html><html><head><meta charset="utf-8"><script>
    (function () {
      const pending = {};
      let n = 0;
      window.nightfeed = {
        call(action, payload) {
          const id = ++n;
          return new Promise(function (resolve) {
            pending[id] = resolve;
            parent.postMessage({ source: 'nf-addon', id: id, action: action, payload: payload || null }, '*');
          });
        }
      };
      window.addEventListener('message', function (e) {
        const data = e.data;
        if (!data || data.source !== 'nf-addon-result') return;
        const done = pending[data.id];
        if (!done) return;
        delete pending[data.id];
        done(data.result);
      });
    })();
  </script></head><body>${page.html}</body></html>`;
}

function postToWorkers(msg: unknown) {
  for (const worker of workers.values()) {
    if (worker.stopping) continue;
    try {
      worker.child.postMessage(msg);
    } catch {
      // ignore
    }
  }
}

export function touchLibrary() {
  postToWorkers({ type: 'library-changed' });
}

export function touchDownloads() {
  postToWorkers({ type: 'downloads-changed', items: plain(ctx?.listDownloads() || []) });
}

async function readCatalogFile(): Promise<CatalogAddon[]> {
  const dir = bundledAddonsDir();
  if (!dir) return [];
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')) as { addons?: CatalogAddon[] };
  return Array.isArray(raw.addons) ? raw.addons : [];
}

export async function getCatalog(): Promise<{ addons: CatalogAddon[]; error?: string }> {
  try {
    const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const raw = (await res.json()) as { addons?: CatalogAddon[] };
      if (Array.isArray(raw.addons)) return { addons: raw.addons.filter((item) => validId(String(item.id || ''))) };
    }
  } catch {
    // The copy shipped with the app is used when GitHub cannot be reached.
  }
  try {
    return { addons: await readCatalogFile() };
  } catch (err) {
    return { addons: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return res.text();
}

function copyAddonDir(sourceDir: string, dest: string) {
  const manifest = readManifest(sourceDir);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(sourceDir, 'addon.json'), path.join(dest, 'addon.json'));
  for (const file of manifest.files) {
    const from = path.resolve(sourceDir, file);
    if (!from.startsWith(path.resolve(sourceDir))) throw new Error('Addon file escapes its folder');
    fs.mkdirSync(path.dirname(path.join(dest, file)), { recursive: true });
    fs.copyFileSync(from, path.join(dest, file));
  }
}

async function downloadAddonDir(entry: CatalogAddon, dest: string) {
  const base = `${RAW_ROOT}/${entry.dir.replace(/^\/+|\/+$/g, '')}`;
  fs.mkdirSync(dest, { recursive: true });
  const manifestText = await fetchText(`${base}/addon.json`);
  fs.writeFileSync(path.join(dest, 'addon.json'), manifestText, 'utf8');
  const manifest = readManifest(dest, false);
  for (const file of manifest.files) {
    const body = await fetchText(`${base}/${file}`);
    fs.mkdirSync(path.dirname(path.join(dest, file)), { recursive: true });
    fs.writeFileSync(path.join(dest, file), body, 'utf8');
  }
  readManifest(dest);
}

async function materializeStoreAddon(entry: CatalogAddon): Promise<string> {
  const dirName = entry.id.replace(/[^a-z0-9.-]/g, '_');
  const dest = path.join(rootDir(), dirName);
  const staging = path.join(rootDir(), `.staging-${dirName}`);
  fs.rmSync(staging, { recursive: true, force: true });
  const alreadyInstalled = fs.existsSync(path.join(dest, 'addon.json'));
  try {
    try {
      await downloadAddonDir(entry, staging);
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      if (alreadyInstalled) {
        throw new Error('Could not download the addon update. The installed copy was left as it is.');
      }
      const bundled = bundledAddonsDir();
      const localDir = bundled ? path.join(bundled, entry.dir) : '';
      if (!localDir || !fs.existsSync(path.join(localDir, 'addon.json'))) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      copyAddonDir(localDir, staging);
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(staging, dest);
    return dirName;
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

async function remember(record: RecordedAddon) {
  const all = readState().filter((item) => item.id !== record.id);
  all.push(record);
  writeState(all);
  await reloadAddons();
}

export async function installFromStore(id: string): Promise<InstalledAddon[]> {
  const catalog = await getCatalog();
  const entry = catalog.addons.find((item) => item.id === id);
  if (!entry) throw new Error('That addon is not in the approved store');
  const dirName = await materializeStoreAddon(entry);
  const manifest = readManifest(path.join(rootDir(), dirName));
  await remember({ id: manifest.id, enabled: true, source: 'store', dirName });
  return listInstalled();
}

function findManifestDir(dir: string): string | null {
  if (fs.existsSync(path.join(dir, 'addon.json'))) return dir;
  const children = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (children.length === 1) {
    const nested = path.join(dir, children[0].name);
    if (fs.existsSync(path.join(nested, 'addon.json'))) return nested;
  }
  return null;
}

async function copyManifestTree(sourceDir: string, dirName: string) {
  const manifest = readManifest(sourceDir);
  const dest = path.join(rootDir(), dirName);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(sourceDir, 'addon.json'), path.join(dest, 'addon.json'));
  for (const file of manifest.files) {
    const from = path.resolve(sourceDir, file);
    if (!from.startsWith(path.resolve(sourceDir))) throw new Error('Addon file escapes its folder');
    if (!fs.existsSync(from)) throw new Error(`Missing ${file}`);
    fs.mkdirSync(path.dirname(path.join(dest, file)), { recursive: true });
    fs.copyFileSync(from, path.join(dest, file));
  }
  return manifest;
}

export async function installFromDialog(): Promise<InstalledAddon[]> {
  const picked = await dialog.showOpenDialog({
    title: 'Install a Nightfeed addon',
    properties: ['openFile'],
    filters: [{ name: 'Nightfeed addon', extensions: ['zip', 'json'] }],
  });
  if (picked.canceled || !picked.filePaths[0]) return listInstalled();
  const chosen = picked.filePaths[0];
  let sourceDir = '';
  let tempDir = '';
  if (chosen.toLowerCase().endsWith('.zip')) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-addon-'));
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${chosen.replace(/'/g, "''")}' -DestinationPath '${tempDir.replace(/'/g, "''")}' -Force`,
      ],
      { windowsHide: true }
    );
    const found = findManifestDir(tempDir);
    if (!found) throw new Error('The zip does not contain addon.json');
    sourceDir = found;
  } else {
    if (path.basename(chosen).toLowerCase() !== 'addon.json') {
      throw new Error('Choose addon.json or a .zip of the addon folder');
    }
    sourceDir = path.dirname(chosen);
  }
  try {
    const manifest = await copyManifestTree(sourceDir, 'pending');
    const dirName = manifest.id.replace(/[^a-z0-9.-]/g, '_');
    if (dirName !== 'pending') {
      const finalDir = path.join(rootDir(), dirName);
      fs.rmSync(finalDir, { recursive: true, force: true });
      fs.renameSync(path.join(rootDir(), 'pending'), finalDir);
    }
    await remember({ id: manifest.id, enabled: true, source: 'file', dirName });
    return listInstalled();
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function setEnabled(id: string, enabled: boolean): Promise<InstalledAddon[]> {
  const all = readState();
  const record = all.find((item) => item.id === id);
  if (!record) throw new Error('Addon is not installed');
  record.enabled = !!enabled;
  writeState(all);
  await reloadAddons();
  return listInstalled();
}

export async function removeAddon(id: string): Promise<InstalledAddon[]> {
  const all = readState();
  const record = all.find((item) => item.id === id);
  if (!record) return listInstalled();
  stopWorker(id);
  loadErrors.delete(id);
  clearPages(id);
  fs.rmSync(path.join(rootDir(), record.dirName), { recursive: true, force: true });
  writeState(all.filter((item) => item.id !== id));
  pushPages();
  return listInstalled();
}

export function handleAddonAction(addonId: string, action: string, payload: unknown) {
  const worker = workers.get(String(addonId || ''));
  if (!worker || !worker.ready || worker.stopping) throw new Error('This addon is not running');
  const requestId = ++actionSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.actions.delete(requestId);
      reject(new Error('Addon action timed out'));
    }, 60000);
    worker.actions.set(requestId, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    try {
      worker.child.postMessage({
        type: 'action',
        requestId,
        action: String(action || ''),
        payload: plain(payload),
      });
    } catch (err) {
      clearTimeout(timer);
      worker.actions.delete(requestId);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function listTelegramCommands(): { command: string; description: string }[] {
  return [...telegramCommands.entries()]
    .map(([command, info]) => ({ command, description: info.description }))
    .sort((a, b) => a.command.localeCompare(b.command));
}

/** Admin Telegram command owned by an addon. Null when this command is not registered. */
export function handleTelegramCommand(command: string, args: string): Promise<string | null> {
  const key = String(command || '').toLowerCase().replace(/^\//, '');
  const owner = telegramCommands.get(key);
  if (!owner) return Promise.resolve(null);
  const worker = workers.get(owner.addonId);
  if (!worker || !worker.ready || worker.stopping) {
    return Promise.resolve('That addon is not running.');
  }
  const requestId = ++actionSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.telegram.delete(requestId);
      reject(new Error('Addon command timed out'));
    }, 30000);
    worker.telegram.set(requestId, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(String(value ?? ''));
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    try {
      worker.child.postMessage({ type: 'telegram', requestId, command: key, args: String(args || '') });
    } catch (err) {
      clearTimeout(timer);
      worker.telegram.delete(requestId);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function startAddons(next: AddonContext) {
  ctx = next;
  fs.mkdirSync(rootDir(), { recursive: true });
  void reloadAddons();
}
