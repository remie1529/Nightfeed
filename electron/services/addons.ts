import { execFile } from 'child_process';
import { dialog } from 'electron';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

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

interface LoadedAddon {
  record: RecordedAddon;
  manifest: Manifest;
  deactivate?: () => void;
  libraryListeners: Array<() => void>;
  downloadListeners: Array<() => void>;
}

let ctx: AddonContext | null = null;
const loaded = new Map<string, LoadedAddon>();
const pages = new Map<string, AddonPage>();
const loadErrors = new Map<string, string>();

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
  return JSON.parse(JSON.stringify(value)) as T;
}

function pageKey(addonId: string, pageId: string): string {
  return `${addonId}:${pageId}`;
}

function pushPages() {
  ctx?.broadcast('addons:pages', listPages());
  ctx?.broadcast('addons:changed');
}

function createApi(addonId: string, addonName: string) {
  const libraryListeners: Array<() => void> = [];
  const downloadListeners: Array<() => void> = [];
  const api = {
    app: {
      version: ctx?.version || '',
      notify(message: string) {
        ctx?.notify(String(message || '').slice(0, 240));
      },
    },
    log: {
      info(message: string) {
        ctx?.log('info', `${addonName}: ${String(message || '').slice(0, 500)}`);
      },
      warn(message: string) {
        ctx?.log('warn', `${addonName}: ${String(message || '').slice(0, 500)}`);
      },
    },
    library: {
      async listShows() {
        return plain(ctx?.getShows() || []);
      },
      async listMovies() {
        return plain(ctx?.getMovies() || []);
      },
      async addShow(mazeId: number, policy?: 'all' | 'future' | 'manual') {
        return plain(await ctx!.addShow(Number(mazeId), policy));
      },
      async addMovie(imdbNumericId: number) {
        return plain(await ctx!.addMovie(Number(imdbNumericId)));
      },
      async removeShow(mazeId: number) {
        return plain(await ctx!.removeShow(Number(mazeId)));
      },
      async removeMovie(imdbNumericId: number) {
        return plain(await ctx!.removeMovie(Number(imdbNumericId)));
      },
    },
    downloads: {
      list() {
        return plain(ctx?.listDownloads() || []);
      },
    },
    ui: {
      addPage(page: { id?: string; title?: string; html?: string }) {
        const pageId = String(page?.id || '').trim();
        if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(pageId)) {
          throw new Error('Page id must be lowercase letters, digits, or dashes');
        }
        pages.set(pageKey(addonId, pageId), {
          addonId,
          addonName,
          pageId,
          title: String(page?.title || pageId).slice(0, 80),
          html: String(page?.html || ''),
        });
        pushPages();
      },
      setPage(id: string, html: string) {
        const key = pageKey(addonId, String(id || ''));
        const existing = pages.get(key);
        if (!existing) throw new Error(`Unknown page ${id}`);
        existing.html = String(html || '');
        ctx?.broadcast('addons:page', existing);
      },
    },
    events: {
      onLibraryChanged(fn: () => void) {
        if (typeof fn === 'function') libraryListeners.push(fn);
        return () => {
          const idx = libraryListeners.indexOf(fn);
          if (idx >= 0) libraryListeners.splice(idx, 1);
        };
      },
      onDownloadsChanged(fn: () => void) {
        if (typeof fn === 'function') downloadListeners.push(fn);
        return () => {
          const idx = downloadListeners.indexOf(fn);
          if (idx >= 0) downloadListeners.splice(idx, 1);
        };
      },
    },
  };
  return { api, libraryListeners, downloadListeners };
}

function unload(id: string) {
  const current = loaded.get(id);
  if (!current) return;
  try {
    current.deactivate?.();
  } catch {
    // A broken deactivate must not stop the app.
  }
  for (const key of [...pages.keys()]) {
    if (key.startsWith(`${id}:`)) pages.delete(key);
  }
  loaded.delete(id);
}

function loadOne(record: RecordedAddon): InstalledAddon {
  const dir = path.join(rootDir(), record.dirName);
  let manifest: Manifest;
  try {
    manifest = readManifest(dir);
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
  const info: InstalledAddon = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    enabled: record.enabled,
    source: record.source,
    error: '',
  };
  if (!record.enabled) return info;
  loadErrors.delete(manifest.id);
  try {
    unload(manifest.id);
    const mainFile = path.join(dir, manifest.main);
    const req = createRequire(mainFile);
    delete req.cache[req.resolve(mainFile)];
    const mod = req(mainFile) as { activate?: (api: unknown) => unknown; deactivate?: () => void };
    if (typeof mod.activate !== 'function') throw new Error('index.js must export activate(api)');
    const built = createApi(manifest.id, manifest.name);
    const result = mod.activate(built.api);
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<unknown>).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        loadErrors.set(manifest.id, message);
        ctx?.log('warn', `${manifest.name} failed: ${message}`);
        ctx?.broadcast('addons:changed');
      });
    }
    loaded.set(manifest.id, {
      record,
      manifest,
      deactivate: typeof mod.deactivate === 'function' ? mod.deactivate : undefined,
      libraryListeners: built.libraryListeners,
      downloadListeners: built.downloadListeners,
    });
  } catch (err) {
    info.error = err instanceof Error ? err.message : String(err);
    loadErrors.set(manifest.id, info.error);
    ctx?.log('warn', `${manifest.name} failed: ${info.error}`);
  }
  return info;
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

export function touchLibrary() {
  for (const addon of loaded.values()) {
    for (const fn of addon.libraryListeners) {
      try {
        fn();
      } catch (err) {
        ctx?.log('warn', `${addon.manifest.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

export function touchDownloads() {
  for (const addon of loaded.values()) {
    for (const fn of addon.downloadListeners) {
      try {
        fn();
      } catch (err) {
        ctx?.log('warn', `${addon.manifest.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

export function reloadAddons() {
  for (const id of [...loaded.keys()]) unload(id);
  pages.clear();
  for (const record of readState()) {
    if (record.enabled) loadOne(record);
  }
  pushPages();
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

function remember(record: RecordedAddon) {
  const all = readState().filter((item) => item.id !== record.id);
  all.push(record);
  writeState(all);
  reloadAddons();
}

export async function installFromStore(id: string): Promise<InstalledAddon[]> {
  const catalog = await getCatalog();
  const entry = catalog.addons.find((item) => item.id === id);
  if (!entry) throw new Error('That addon is not in the approved store');
  const dirName = await materializeStoreAddon(entry);
  const manifest = readManifest(path.join(rootDir(), dirName));
  remember({ id: manifest.id, enabled: true, source: 'store', dirName });
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
    remember({ id: manifest.id, enabled: true, source: 'file', dirName });
    return listInstalled();
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function setEnabled(id: string, enabled: boolean): InstalledAddon[] {
  const all = readState();
  const record = all.find((item) => item.id === id);
  if (!record) throw new Error('Addon is not installed');
  record.enabled = !!enabled;
  writeState(all);
  reloadAddons();
  return listInstalled();
}

export function removeAddon(id: string): InstalledAddon[] {
  const all = readState();
  const record = all.find((item) => item.id === id);
  if (!record) return listInstalled();
  unload(id);
  fs.rmSync(path.join(rootDir(), record.dirName), { recursive: true, force: true });
  writeState(all.filter((item) => item.id !== id));
  pushPages();
  return listInstalled();
}

export function startAddons(next: AddonContext) {
  ctx = next;
  fs.mkdirSync(rootDir(), { recursive: true });
  reloadAddons();
}
