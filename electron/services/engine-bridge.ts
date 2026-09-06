/**
 * Download engine facade for the Electron main process.
 * Prefers Electron utilityProcess (WebTorrent + piece hashing off the UI process).
 * Falls back to in-process DownloadEngine if utilityProcess cannot start.
 */
import { EventEmitter } from 'events';
import { resolveDistElectronAsset } from './asset-path';
import { utilityProcess, app } from 'electron';
import { DownloadEngine, EngineSettings } from './engine';
import { DownloadItem, Movie, Show, TorrentCandidate } from '../types';

type StartEpisodeOpts = {
  magnet: string;
  show: Show;
  libraryRoot: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string;
  candidates?: TorrentCandidate[];
  triedInfoHashes?: string[];
};

type StartMovieOpts = {
  magnet: string;
  movie: Movie;
  movieLibraryRoot: string;
  candidates?: TorrentCandidate[];
  triedInfoHashes?: string[];
};

class UtilityEngineProxy extends EventEmitter {
  private child: Electron.UtilityProcess | null = null;
  private ready = false;
  private requestId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private cachedItems: DownloadItem[] = [];
  private startPromise: Promise<boolean> | null = null;

  async ensureStarted(): Promise<boolean> {
    if (this.ready && this.child) return true;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.fork();
    return this.startPromise;
  }

  private fork(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const script = resolveDistElectronAsset('torrent-utility.js');
        const child = utilityProcess.fork(script, [], {
          serviceName: 'torrent-engine',
          stdio: 'pipe',
        });
        this.child = child;

        const timer = setTimeout(() => {
          console.error('[engine-bridge] utilityProcess ready timeout');
          try {
            child.kill();
          } catch {
            // ignore
          }
          this.child = null;
          this.ready = false;
          resolve(false);
        }, 8000);

        child.on('message', (msg: any) => {
          if (msg?.type === 'ready') {
            clearTimeout(timer);
            this.ready = true;
            resolve(true);
            return;
          }
          if (msg?.type === 'reply' && typeof msg.requestId === 'number') {
            const p = this.pending.get(msg.requestId);
            if (!p) return;
            this.pending.delete(msg.requestId);
            if (msg.ok === false) p.reject(new Error(msg.error || 'Utility engine error'));
            else p.resolve(msg);
            return;
          }
          if (msg?.type === 'event') {
            if (msg.event === 'update') {
              this.cachedItems = msg.items || [];
              this.emit('update', this.cachedItems);
            } else if (msg.event === 'done') {
              this.emit('done', msg.item);
            } else if (msg.event === 'reject-exe') {
              this.emit('reject-exe', msg.item);
            } else if (msg.event === 'engine-error') {
              this.emit('engine-error', msg.message);
            }
          }
        });

        child.on('exit', (code) => {
          console.error('[engine-bridge] utilityProcess exited', code);
          this.ready = false;
          this.child = null;
          for (const [, p] of this.pending) {
            p.reject(new Error('Torrent utility process exited'));
          }
          this.pending.clear();
        });

        child.stdout?.on('data', (buf: Buffer) => {
          const s = buf.toString().trim();
          if (s) console.log('[torrent-utility]', s);
        });
        child.stderr?.on('data', (buf: Buffer) => {
          const s = buf.toString().trim();
          if (s) console.error('[torrent-utility]', s);
        });
      } catch (err) {
        console.error('[engine-bridge] fork failed', err);
        resolve(false);
      }
    });
  }

  private call(type: string, payload: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      void this.ensureStarted().then((ok) => {
        if (!ok || !this.child) {
          reject(new Error('Torrent utility process not available'));
          return;
        }
        const requestId = this.requestId++;
        this.pending.set(requestId, { resolve, reject });
        this.child.postMessage({ type, requestId, ...payload });
      });
    });
  }

  applySettings(settings: EngineSettings): void {
    void this.call('applySettings', { settings }).catch(() => undefined);
  }

  list(): DownloadItem[] {
    return this.cachedItems;
  }

  getDownloadingKeys(): Set<string> {
    const keys = new Set<string>();
    for (const item of this.cachedItems) {
      if (item.status === 'downloading' || item.status === 'queued' || item.status === 'paused') {
        keys.add(`${item.showId}:${item.seasonNumber}:${item.episodeNumber}`);
      }
    }
    return keys;
  }

  getDownloadingMovieIds(): Set<number> {
    const ids = new Set<number>();
    for (const item of this.cachedItems) {
      if (
        item.kind === 'movie' &&
        item.movieId != null &&
        (item.status === 'downloading' || item.status === 'queued' || item.status === 'paused')
      ) {
        ids.add(item.movieId);
      }
    }
    return ids;
  }

  hasEpisodeActivity(showId: number, season: number, episode: number): boolean {
    for (const item of this.cachedItems) {
      if (
        item.showId === showId &&
        item.seasonNumber === season &&
        item.episodeNumber === episode &&
        (item.status === 'downloading' ||
          item.status === 'queued' ||
          item.status === 'paused' ||
          item.status === 'done')
      ) {
        return true;
      }
    }
    return false;
  }

  hasMovieActivity(movieId: number): boolean {
    for (const item of this.cachedItems) {
      if (
        item.kind === 'movie' &&
        item.movieId === movieId &&
        (item.status === 'downloading' ||
          item.status === 'queued' ||
          item.status === 'paused' ||
          item.status === 'done')
      ) {
        return true;
      }
    }
    return false;
  }

  async start(opts: StartEpisodeOpts): Promise<DownloadItem> {
    const res = await this.call('start', { opts });
    if (res.item) {
      const idx = this.cachedItems.findIndex((i) => i.id === res.item.id);
      if (idx >= 0) this.cachedItems[idx] = res.item;
      else this.cachedItems.push(res.item);
    }
    return res.item as DownloadItem;
  }

  async startMovie(opts: StartMovieOpts): Promise<DownloadItem> {
    const res = await this.call('startMovie', { opts });
    if (res.item) {
      const idx = this.cachedItems.findIndex((i) => i.id === res.item.id);
      if (idx >= 0) this.cachedItems[idx] = res.item;
      else this.cachedItems.push(res.item);
    }
    return res.item as DownloadItem;
  }

  pause(id: string): void {
    void this.call('pause', { id }).catch(() => undefined);
  }

  resume(id: string): void {
    void this.call('resume', { id }).catch(() => undefined);
  }

  remove(id: string): void {
    void this.call('remove', { id }).catch(() => undefined);
    this.cachedItems = this.cachedItems.filter((i) => i.id !== id);
  }

  cancel(id: string): void {
    this.remove(id);
  }

  destroy(): void {
    void this.call('destroy').catch(() => undefined);
    try {
      this.child?.kill();
    } catch {
      // ignore
    }
    this.child = null;
    this.ready = false;
    this.cachedItems = [];
  }
}

class EngineFacade extends EventEmitter {
  private backend: UtilityEngineProxy | DownloadEngine | null = null;
  private mode: 'utilityProcess' | 'in-process' = 'in-process';
  private initPromise: Promise<void> | null = null;
  private pendingSettings: EngineSettings | null = null;
  private _tempLocal: DownloadEngine | null = null;

  getMode(): 'utilityProcess' | 'in-process' {
    return this.mode;
  }

  ensureReady(): Promise<void> {
    if (this.backend) return Promise.resolve();
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const proxy = new UtilityEngineProxy();
      // Forward events
      const forward = (event: string) => {
        proxy.on(event, (...args: unknown[]) => this.emit(event, ...args));
      };
      forward('update');
      forward('done');
      forward('reject-exe');
      forward('engine-error');

      const ok = await proxy.ensureStarted();
      if (ok) {
        this.backend = proxy;
        this.mode = 'utilityProcess';
      } else {
        const local = new DownloadEngine();
        local.on('update', (items) => this.emit('update', items));
        local.on('done', (item) => this.emit('done', item));
        local.on('reject-exe', (item) => this.emit('reject-exe', item));
        local.on('engine-error', (msg) => this.emit('engine-error', msg));
        this.backend = local;
        this.mode = 'in-process';
        try {
          proxy.destroy();
        } catch {
          // ignore
        }
      }
      if (this._tempLocal) {
        try {
          this._tempLocal.destroy();
        } catch {
          // ignore
        }
        this._tempLocal = null;
      }
      if (this.pendingSettings) {
        this.backend.applySettings(this.pendingSettings);
        this.pendingSettings = null;
      }
    })();
    return this.initPromise;
  }

  private syncBackend(): UtilityEngineProxy | DownloadEngine {
    if (!this.backend) {
      // Init still pending — use a temporary empty local until ensureReady finishes.
      // Do not set this.backend permanently here (would race with utilityProcess).
      void this.ensureReady();
      if (!this._tempLocal) {
        this._tempLocal = new DownloadEngine();
      }
      return this._tempLocal;
    }
    return this.backend;
  }

  applySettings(settings: EngineSettings): void {
    if (!this.backend) {
      this.pendingSettings = settings;
      void this.ensureReady();
      return;
    }
    this.backend.applySettings(settings);
  }

  list(): DownloadItem[] {
    return this.syncBackend().list();
  }

  getDownloadingKeys(): Set<string> {
    return this.syncBackend().getDownloadingKeys();
  }

  getDownloadingMovieIds(): Set<number> {
    return this.syncBackend().getDownloadingMovieIds();
  }

  hasEpisodeActivity(showId: number, season: number, episode: number): boolean {
    return this.syncBackend().hasEpisodeActivity(showId, season, episode);
  }

  hasMovieActivity(movieId: number): boolean {
    return this.syncBackend().hasMovieActivity(movieId);
  }

  async start(opts: StartEpisodeOpts): Promise<DownloadItem> {
    await this.ensureReady();
    return this.syncBackend().start(opts);
  }

  async startMovie(opts: StartMovieOpts): Promise<DownloadItem> {
    await this.ensureReady();
    return this.syncBackend().startMovie(opts);
  }

  pause(id: string): void {
    this.syncBackend().pause(id);
  }

  resume(id: string): void {
    this.syncBackend().resume(id);
  }

  remove(id: string): void {
    this.syncBackend().remove(id);
  }

  cancel(id: string): void {
    this.syncBackend().cancel(id);
  }

  destroy(): void {
    this.backend?.destroy();
    this.backend = null;
  }
}

export const downloadEngine = new EngineFacade();

export function getTorrentEngineInfo(): {
  mode: 'utilityProcess' | 'in-process';
  detail: string;
} {
  const mode = downloadEngine.getMode();
  return {
    mode,
    detail:
      mode === 'utilityProcess'
        ? 'WebTorrent runs in Electron utilityProcess (piece hashing & peer churn off the UI process)'
        : 'WebTorrent on main process (utilityProcess unavailable)',
  };
}

export async function ensureTorrentEngine(): Promise<void> {
  await downloadEngine.ensureReady();
}

// Kick off as soon as the module loads once app can fork
if (app.isReady()) {
  void downloadEngine.ensureReady();
} else {
  app.whenReady().then(() => void downloadEngine.ensureReady());
}
