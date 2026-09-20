/**
 * Download engine facade for the Electron main process.
 * Prefers Electron utilityProcess (WebTorrent + piece hashing off the UI process).
 * One active download worker + floater respawns on failure; in-process only as last resort.
 */
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { resolveDistElectronAsset, buildUtilityProcessEnv } from './asset-path';
import { utilityProcess, app } from 'electron';
import { DownloadEngine, EngineSettings } from './engine';
import { activityLog } from './activity-log';
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
  notifyChatId?: number;
  telegramRequestId?: string;
};

type StartMovieOpts = {
  magnet: string;
  movie: Movie;
  movieLibraryRoot: string;
  candidates?: TorrentCandidate[];
  triedInfoHashes?: string[];
  notifyChatId?: number;
  telegramRequestId?: string;
};

export type UtilityStartFailure = {
  pathTried: string;
  pathExists: boolean;
  forkError?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  stderr?: string;
  stdout?: string;
  attempt: number;
  note?: string;
};

/** Primary + floater forks before giving up on utilityProcess. */
const MAX_UTILITY_SPAWNS = 6;
const FLOATER_BACKOFF_MS = 500;

let lastUtilityFailure: UtilityStartFailure | null = null;

export function getLastUtilityFailure(): UtilityStartFailure | null {
  return lastUtilityFailure;
}

function summarizeFailure(f: UtilityStartFailure): string {
  const bits: string[] = [];
  bits.push(`path=${f.pathTried}`);
  bits.push(`exists=${f.pathExists ? 'yes' : 'no'}`);
  if (f.forkError) bits.push(`forkError=${f.forkError}`);
  if (f.timedOut) bits.push('timedOut=yes');
  if (f.exitCode !== undefined && f.exitCode !== null) bits.push(`exit=${f.exitCode}`);
  if (f.stderr) bits.push(`stderr=${f.stderr.slice(0, 800)}`);
  if (f.stdout && !f.stderr) bits.push(`stdout=${f.stdout.slice(0, 400)}`);
  if (f.note) bits.push(f.note);
  return bits.join(' | ');
}

function logUtilityFailure(f: UtilityStartFailure, level: 'warn' | 'error' = 'warn'): void {
  lastUtilityFailure = f;
  const msg = `WebTorrent utilityProcess start failed (spawn ${f.attempt}): ${summarizeFailure(f)}`;
  console.error(`[engine-bridge] ${msg}`);
  try {
    activityLog[level]('download', msg, {
      path: f.pathTried,
      exists: f.pathExists,
      exit: f.exitCode ?? '',
      timedOut: !!f.timedOut,
    });
  } catch {
    // activity log may not be ready very early
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Rebuild start opts from a cached item so a floater can resume the queue. */
function synthesizeOpts(item: DownloadItem): StartEpisodeOpts | StartMovieOpts {
  const save = item.savePath || '';
  if (item.kind === 'movie') {
    const movieLibraryRoot = save ? path.dirname(save) : '';
    const movie = {
      id: item.movieId || item.showId,
      tmdbId: item.movieId || item.showId,
      title: item.showName || item.name,
      overview: '',
      posterPath: null,
      backdropPath: null,
      releaseDate: null,
      releaseYear: null,
      runtime: null,
      status: 'downloading' as const,
      addedAt: '',
    } satisfies Movie;
    return {
      magnet: item.magnet || '',
      movie,
      movieLibraryRoot,
      candidates: item.candidates,
      triedInfoHashes: item.triedInfoHashes,
      notifyChatId: item.notifyChatId,
      telegramRequestId: item.telegramRequestId,
    };
  }
  // savePath is usually .../Show/Season N/.nf-work-... — library root ≈ show dir parent
  const seasonDir = save ? path.dirname(save) : '';
  const showDir = seasonDir ? path.dirname(seasonDir) : '';
  const libraryRoot = showDir ? path.dirname(showDir) : '';
  const show = {
    id: item.showId,
    tmdbId: item.showId,
    name: item.showName || item.name,
    overview: '',
    posterPath: null,
    backdropPath: null,
    firstAirDate: null,
    status: '',
    seasons: [],
    addedAt: '',
  } satisfies Show;
  return {
    magnet: item.magnet || '',
    show,
    libraryRoot,
    seasonNumber: item.seasonNumber,
    episodeNumber: item.episodeNumber,
    episodeTitle: item.episodeTitle || '',
    candidates: item.candidates,
    triedInfoHashes: item.triedInfoHashes,
    notifyChatId: item.notifyChatId,
    telegramRequestId: item.telegramRequestId,
  };
}

class UtilityEngineProxy extends EventEmitter {
  private child: Electron.UtilityProcess | null = null;
  private ready = false;
  private requestId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private cachedItems: DownloadItem[] = [];
  private startPromise: Promise<boolean> | null = null;
  private spawnsUsed = 0;
  private everReady = false;
  private permanentlyFailed = false;
  private needsRehydrate = false;
  private floaterLaunching = false;
  private lastSettings: EngineSettings | null = null;

  async ensureStarted(): Promise<boolean> {
    if (this.ready && this.child) return true;
    if (this.permanentlyFailed) return false;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.spawnWithBudget().then((ok) => {
      this.startPromise = null;
      if (!ok) this.permanentlyFailed = true;
      return ok;
    });
    return this.startPromise;
  }

  private async spawnWithBudget(): Promise<boolean> {
    while (this.spawnsUsed < MAX_UTILITY_SPAWNS) {
      this.spawnsUsed += 1;
      const attempt = this.spawnsUsed;
      const isFloater = this.everReady || this.needsRehydrate;
      if (isFloater) {
        activityLog.info(
          'download',
          `Launching floater download worker (spawn ${attempt}/${MAX_UTILITY_SPAWNS})`
        );
      }
      const ok = await this.fork(attempt, isFloater);
      if (ok) {
        this.everReady = true;
        if (this.needsRehydrate) {
          this.needsRehydrate = false;
          await this.rehydrateAfterFloater();
        }
        return true;
      }
      this.child = null;
      this.ready = false;
      if (this.spawnsUsed < MAX_UTILITY_SPAWNS) {
        const delay = Math.min(
          8000,
          Math.round(FLOATER_BACKOFF_MS * Math.pow(1.8, Math.max(0, attempt - 1)))
        );
        activityLog.info(
          'download',
          `Download worker spawn ${attempt} failed — retrying in ${delay}ms (${MAX_UTILITY_SPAWNS - this.spawnsUsed} left)`
        );
        await sleep(delay);
      }
    }
    return false;
  }

  private async rehydrateAfterFloater(): Promise<void> {
    activityLog.info('download', 'Floater ready — re-applying settings and handing off queue');
    try {
      if (this.lastSettings) {
        await this.call('applySettings', { settings: this.lastSettings });
      }
    } catch (err) {
      activityLog.warn(
        'download',
        `Floater applySettings failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const active = this.cachedItems.filter(
      (i) =>
        (i.status === 'downloading' || i.status === 'queued' || i.status === 'paused') &&
        !!(i.magnet && i.magnet.trim())
    );
    let restored = 0;
    for (const item of active) {
      try {
        const res = await this.call('restore', { item, opts: synthesizeOpts(item) });
        if (res?.item) this.upsertCachedItem(res.item);
        restored += 1;
      } catch (err) {
        activityLog.warn(
          'download',
          `Floater could not restore: ${item.name}`,
          { error: err instanceof Error ? err.message : String(err) }
        );
      }
    }
    try {
      await this.call('kickQueue');
    } catch {
      // ignore
    }
    this.emit('update', this.cachedItems);
    activityLog.info(
      'download',
      `Floater handoff done: restored ${restored}/${active.length} download(s)`
    );
  }

  private fork(attempt: number, isFloater: boolean): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };

      try {
        const script = resolveDistElectronAsset('torrent-utility.js');
        const pathExists = fs.existsSync(script);
        const stderrChunks: string[] = [];
        const stdoutChunks: string[] = [];

        if (!pathExists) {
          logUtilityFailure({
            pathTried: script,
            pathExists: false,
            attempt,
            note: 'torrent-utility.js missing (asarUnpack / build issue)',
          });
          finish(false);
          return;
        }

        activityLog.info('download', `Starting WebTorrent utilityProcess`, {
          path: script,
          attempt,
          floater: isFloater,
          packaged: !!app.isPackaged,
        });

        const child = utilityProcess.fork(script, [], {
          serviceName: isFloater ? 'torrent-engine-floater' : 'torrent-engine',
          stdio: 'pipe',
          env: buildUtilityProcessEnv(),
        });
        this.child = child;

        const timer = setTimeout(() => {
          const failure: UtilityStartFailure = {
            pathTried: script,
            pathExists: true,
            timedOut: true,
            attempt,
            stderr: stderrChunks.join('').trim().slice(0, 1200) || undefined,
            stdout: stdoutChunks.join('').trim().slice(0, 600) || undefined,
            note: isFloater
              ? 'floater: no ready message within 20s'
              : 'no ready message within 20s',
          };
          logUtilityFailure(failure);
          try {
            child.kill();
          } catch {
            // ignore
          }
          this.child = null;
          this.ready = false;
          finish(false);
        }, 20000);

        child.on('message', (msg: any) => {
          if (msg?.type === 'ready') {
            clearTimeout(timer);
            this.ready = true;
            activityLog.info(
              'download',
              isFloater
                ? 'Floater WebTorrent utilityProcess ready'
                : 'WebTorrent utilityProcess ready',
              { path: script, attempt }
            );
            finish(true);
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
          const wasReady = this.ready;
          const hadBeenReady = this.everReady;
          console.error('[engine-bridge] utilityProcess exited', code);
          clearTimeout(timer);
          this.ready = false;
          this.child = null;
          this.startPromise = null;
          for (const [, p] of this.pending) {
            p.reject(new Error('Torrent utility process exited'));
          }
          this.pending.clear();

          if (!settled) {
            logUtilityFailure({
              pathTried: script,
              pathExists: true,
              exitCode: code,
              attempt,
              stderr: stderrChunks.join('').trim().slice(0, 1200) || undefined,
              stdout: stdoutChunks.join('').trim().slice(0, 600) || undefined,
              note: isFloater ? 'floater exited before ready' : 'exited before ready',
            });
            finish(false);
            return;
          }

          // Unexpected death after ready — launch floater if budget remains.
          if (wasReady || hadBeenReady) {
            const detail = `exit=${code}${
              stderrChunks.length ? ` stderr=${stderrChunks.join('').trim().slice(0, 400)}` : ''
            }`;
            activityLog.warn(
              'download',
              `Download utilityProcess exited unexpectedly (${detail})`
            );
            this.emit('engine-error', `Torrent utility process exited (${code})`);
            this.scheduleFloater();
          }
        });

        child.stdout?.on('data', (buf: Buffer) => {
          const s = buf.toString();
          stdoutChunks.push(s);
          const t = s.trim();
          if (t) console.log('[torrent-utility]', t);
        });
        child.stderr?.on('data', (buf: Buffer) => {
          const s = buf.toString();
          stderrChunks.push(s);
          const t = s.trim();
          if (t) console.error('[torrent-utility]', t);
        });
      } catch (err) {
        const script = resolveDistElectronAsset('torrent-utility.js');
        logUtilityFailure({
          pathTried: script,
          pathExists: fs.existsSync(script),
          forkError: err instanceof Error ? err.message : String(err),
          attempt,
        });
        finish(false);
      }
    });
  }

  private scheduleFloater(): void {
    if (this.floaterLaunching || this.permanentlyFailed) return;
    if (this.spawnsUsed >= MAX_UTILITY_SPAWNS) {
      activityLog.error(
        'download',
        'Download worker floater budget exhausted — in-process fallback needed'
      );
      this.permanentlyFailed = true;
      this.emit('utility-dead');
      return;
    }
    this.floaterLaunching = true;
    this.needsRehydrate = true;
    activityLog.info(
      'download',
      `Primary download worker died — spawning floater (${MAX_UTILITY_SPAWNS - this.spawnsUsed} attempt(s) left)`
    );
    void this.ensureStarted()
      .then((ok) => {
        this.floaterLaunching = false;
        if (ok) {
          activityLog.info('download', 'Floater download worker is active');
        } else {
          activityLog.error(
            'download',
            `Floater download worker unavailable. ${
              lastUtilityFailure ? summarizeFailure(lastUtilityFailure) : ''
            }`
          );
          this.emit('utility-dead');
        }
      })
      .catch((err) => {
        this.floaterLaunching = false;
        activityLog.error(
          'download',
          `Floater launch error: ${err instanceof Error ? err.message : String(err)}`
        );
        this.emit('utility-dead');
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

  private upsertCachedItem(item: DownloadItem): void {
    const idx = this.cachedItems.findIndex((i) => i.id === item.id);
    if (idx < 0) {
      this.cachedItems.push(item);
      return;
    }
    const prev = this.cachedItems[idx];
    if (prev.status === 'downloading' && item.status === 'queued') {
      this.cachedItems[idx] = {
        ...item,
        status: 'downloading',
        progress: Math.max(prev.progress || 0, item.progress || 0),
      };
      return;
    }
    this.cachedItems[idx] = item;
  }

  applySettings(settings: EngineSettings): void {
    this.lastSettings = settings;
    void this.call('applySettings', { settings }).catch(() => undefined);
  }

  async applySettingsAsync(settings: EngineSettings): Promise<void> {
    this.lastSettings = settings;
    await this.call('applySettings', { settings });
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
    if (res.item) this.upsertCachedItem(res.item);
    return res.item as DownloadItem;
  }

  async startMovie(opts: StartMovieOpts): Promise<DownloadItem> {
    const res = await this.call('startMovie', { opts });
    if (res.item) this.upsertCachedItem(res.item);
    return res.item as DownloadItem;
  }

  async restore(item: DownloadItem, opts: StartEpisodeOpts | StartMovieOpts): Promise<DownloadItem> {
    const res = await this.call('restore', { item, opts });
    if (res.item) this.upsertCachedItem(res.item);
    return res.item as DownloadItem;
  }

  kickQueue(): void {
    void this.call('kickQueue')
      .then((res) => {
        if (Array.isArray(res?.items)) this.cachedItems = res.items;
      })
      .catch(() => undefined);
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
    this.permanentlyFailed = true;
    void this.call('destroy').catch(() => undefined);
    try {
      this.child?.kill();
    } catch {
      // ignore
    }
    this.child = null;
    this.ready = false;
    this.startPromise = null;
    this.cachedItems = [];
  }
}

class EngineFacade extends EventEmitter {
  private backend: UtilityEngineProxy | DownloadEngine | null = null;
  private mode: 'utilityProcess' | 'in-process' = 'in-process';
  private initPromise: Promise<void> | null = null;
  private pendingSettings: EngineSettings | null = null;
  private _tempLocal: DownloadEngine | null = null;
  private proxy: UtilityEngineProxy | null = null;

  getMode(): 'utilityProcess' | 'in-process' {
    return this.mode;
  }

  private switchToInProcess(reason: string): void {
    if (this.mode === 'in-process' && this.backend && !(this.backend instanceof UtilityEngineProxy)) {
      return;
    }
    activityLog.warn('download', `Falling back to in-process WebTorrent: ${reason}`);
    const local = new DownloadEngine();
    local.on('update', (items) => this.emit('update', items));
    local.on('done', (item) => this.emit('done', item));
    local.on('reject-exe', (item) => this.emit('reject-exe', item));
    local.on('engine-error', (msg) => this.emit('engine-error', msg));
    if (this.pendingSettings) {
      local.applySettings(this.pendingSettings);
    }
    // Best-effort: keep UI list; new downloads will use in-process engine.
    try {
      this.proxy?.destroy();
    } catch {
      // ignore
    }
    this.backend = local;
    this.mode = 'in-process';
    this.proxy = null;
    this.emit('fallback-in-process', reason);
  }

  ensureReady(): Promise<void> {
    if (this.backend) return Promise.resolve();
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const proxy = new UtilityEngineProxy();
      this.proxy = proxy;
      const forward = (event: string) => {
        proxy.on(event, (...args: unknown[]) => this.emit(event, ...args));
      };
      forward('update');
      forward('done');
      forward('reject-exe');
      forward('engine-error');
      proxy.on('utility-dead', () => {
        if (this.mode === 'utilityProcess') {
          this.switchToInProcess('floater budget exhausted after utilityProcess failure');
        }
      });

      const ok = await proxy.ensureStarted();
      if (ok) {
        this.backend = proxy;
        this.mode = 'utilityProcess';
      } else {
        const detail = lastUtilityFailure ? summarizeFailure(lastUtilityFailure) : 'unknown';
        console.error(
          `[engine-bridge] utilityProcess unavailable after floater retries — in-process (${detail})`
        );
        activityLog.warn(
          'download',
          `Download worker unavailable after floater retries — using UI process. ${detail}`
        );
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
        this.proxy = null;
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

  async applySettingsAsync(settings: EngineSettings): Promise<void> {
    await this.ensureReady();
    const backend = this.syncBackend();
    if (backend instanceof UtilityEngineProxy) {
      await backend.applySettingsAsync(settings);
      return;
    }
    backend.applySettings(settings);
  }

  kickQueue(): void {
    const backend = this.syncBackend();
    if (backend instanceof UtilityEngineProxy) {
      backend.kickQueue();
      return;
    }
    if ('kickQueue' in backend && typeof (backend as DownloadEngine).kickQueue === 'function') {
      (backend as DownloadEngine).kickQueue();
    }
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

  async restore(item: DownloadItem, opts: StartEpisodeOpts | StartMovieOpts): Promise<DownloadItem> {
    await this.ensureReady();
    const backend = this.syncBackend();
    if ('restore' in backend && typeof (backend as any).restore === 'function') {
      return (backend as any).restore(item, opts);
    }
    if ((item.kind === 'movie' || (opts as StartMovieOpts).movie) && (opts as StartMovieOpts).movie) {
      return this.startMovie(opts as StartMovieOpts);
    }
    return this.start(opts as StartEpisodeOpts);
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
  if (mode === 'utilityProcess') {
    return {
      mode,
      detail:
        'WebTorrent in utilityProcess (one download worker + floater respawn on failure)',
    };
  }
  const fail = lastUtilityFailure;
  return {
    mode,
    detail: fail
      ? `WebTorrent on UI process (download worker unavailable: ${summarizeFailure(fail)})`
      : 'WebTorrent on UI process (download worker unavailable)',
  };
}

export async function ensureTorrentEngine(): Promise<void> {
  await downloadEngine.ensureReady();
}

if (app.isReady()) {
  void downloadEngine.ensureReady();
} else {
  app.whenReady().then(() => void downloadEngine.ensureReady());
}
