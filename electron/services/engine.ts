import { EventEmitter } from 'events';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { DownloadItem, Movie, Show, TorrentCandidate } from '../types';
import { buildEpisodePath, buildMoviePath } from './paths';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const WebTorrent = require('webtorrent') as any;

/** Valid playable media extensions (case-insensitive). */
const VALID_VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.wmv', '.ts', '.mov']);
/** Also accepted when selecting the largest video from a torrent (legacy extras). */
const SELECT_VIDEO_EXTS = new Set([...VALID_VIDEO_EXTS, '.webm']);

const PROGRESS_THROTTLE_MS = 1500;
/** Cap peer sockets — WebTorrent default is 55; 200+ with uTP hits Windows ENOBUFS. */
const MAX_PEER_CONNS = 80;
/** Only this many torrents in WebTorrent at once; the rest stay queued. */
const MAX_ACTIVE_DOWNLOADS = 3;

type EpisodeStartOpts = {
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

type MovieStartOpts = {
  magnet: string;
  movie: Movie;
  movieLibraryRoot: string;
  candidates?: TorrentCandidate[];
  triedInfoHashes?: string[];
  notifyChatId?: number;
  telegramRequestId?: string;
};

type PendingJob = { kind: 'episode'; opts: EpisodeStartOpts } | { kind: 'movie'; opts: MovieStartOpts };

export function isIgnorableTorrentSocketError(err: unknown): boolean {
  const s = err instanceof Error ? `${err.message}\n${err.stack || ''}` : String(err);
  return /no buffer space|ENOBUFS|UTP\.(bind|connect)|uv_udp_bind/i.test(s);
}

/** Extra public trackers appended on add for better peer discovery. */
export const DEFAULT_ANNOUNCE = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker1.bt.moack.co.kr:80/announce',
  'udp://tracker.theoks.net:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.files.fm:7073/announce',
];

function pickVideoFile(files: Array<{ name: string; length: number; path: string }>) {
  const videos = files.filter((f) => SELECT_VIDEO_EXTS.has(path.extname(f.name).toLowerCase()));
  if (videos.length === 0) return files.sort((a, b) => b.length - a.length)[0];
  return videos.sort((a, b) => b.length - a.length)[0];
}

function hasValidVideo(files: Array<{ name: string }>): boolean {
  return files.some((f) => VALID_VIDEO_EXTS.has(path.extname(f.name).toLowerCase()));
}

/** True when primary file is .exe, or there is no valid video (e.g. exe-only). */
export function shouldRejectBadPayload(files: Array<{ name: string; length: number; path: string }>): boolean {
  if (!files.length) return true;
  if (!hasValidVideo(files)) return true;
  const best = pickVideoFile(files);
  if (!best) return true;
  const ext = path.extname(best.name).toLowerCase();
  return ext === '.exe' || !VALID_VIDEO_EXTS.has(ext);
}

function kbpsToBytesPerSec(kbps: number): number {
  // WebTorrent throttle* / downloadLimit use bytes/sec; -1 = unlimited
  if (!kbps || kbps <= 0) return -1;
  return Math.max(1, Math.round(kbps * 1024));
}

async function moveFileAsync(src: string, dest: string): Promise<void> {
  try {
    await fsp.access(dest);
    await fsp.unlink(dest);
  } catch {
    // dest missing — fine
  }
  try {
    await fsp.rename(src, dest);
  } catch {
    await fsp.copyFile(src, dest);
    try {
      await fsp.unlink(src);
    } catch {
      // ignore
    }
  }
}

export const VPN_KILL_SWITCH_ERROR = 'VPN kill switch';

export interface EngineSettings {
  maxConnections?: number;
  maxDownloadSpeedKBps?: number;
  maxUploadSpeedKBps?: number;
  /** Bind outgoing torrent TCP sockets to this local IPv4 (VPN TUN/TAP). */
  bindAddress?: string | null;
  /** When true, no torrent sockets — pause active downloads (VPN kill switch). */
  vpnHold?: boolean;
}

export class DownloadEngine extends EventEmitter {
  private client: any = null;
  private items = new Map<string, DownloadItem>();
  private torrents = new Map<string, any>();
  private jobs = new Map<string, PendingJob>();
  private maxConns = MAX_PEER_CONNS;
  private maxDownloadSpeedKBps = 0;
  private maxUploadSpeedKBps = 0;
  private bindAddress: string | null = null;
  private vpnHold = false;
  private netBindPatched = false;
  private lastProgressEmit = 0;
  private progressEmitTimer: NodeJS.Timeout | null = null;

  /** Apply connection / speed / VPN bind settings. Safe to call before or after client exists. */
  applySettings(settings: EngineSettings): void {
    if (typeof settings.maxConnections === 'number' && settings.maxConnections > 0) {
      this.maxConns = Math.max(1, Math.min(MAX_PEER_CONNS, Math.floor(settings.maxConnections)));
    }
    if (typeof settings.maxDownloadSpeedKBps === 'number') {
      this.maxDownloadSpeedKBps = Math.max(0, Math.floor(settings.maxDownloadSpeedKBps));
    }
    if (typeof settings.maxUploadSpeedKBps === 'number') {
      this.maxUploadSpeedKBps = Math.max(0, Math.floor(settings.maxUploadSpeedKBps));
    }
    if ('bindAddress' in settings) {
      const next = settings.bindAddress ? String(settings.bindAddress) : null;
      if (next !== this.bindAddress) {
        this.bindAddress = next;
        // Recreate client so new sockets use the updated localAddress bind.
        this.destroyClientOnly();
      }
    }
    if (typeof settings.vpnHold === 'boolean' && settings.vpnHold !== this.vpnHold) {
      this.vpnHold = settings.vpnHold;
      if (this.vpnHold) this.engageKillSwitch();
      else this.releaseKillSwitch();
    }
    if (this.client) {
      this.client.maxConns = this.maxConns;
      // webtorrent 1.9.7: client.throttleDownload / throttleUpload (bytes/sec, -1 = unlimited)
      this.client.throttleDownload(kbpsToBytesPerSec(this.maxDownloadSpeedKBps));
      this.client.throttleUpload(kbpsToBytesPerSec(this.maxUploadSpeedKBps));
    }
  }

  /** Patch net.connect in this process so outgoing torrent TCP uses localAddress. */
  private ensureNetBindPatch(): void {
    if (this.netBindPatched) return;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const net = require('net') as typeof import('net');
    const self = this;
    const original = net.connect.bind(net);
    (net as any).connect = function patchedConnect(...args: any[]) {
      if (self.bindAddress) {
        if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
          if (!args[0].localAddress) {
            args[0] = { ...args[0], localAddress: self.bindAddress };
          }
        }
      }
      return original(...args);
    };
    this.netBindPatched = true;
  }

  /** Destroy WebTorrent client without clearing download items (used on bind change). */
  private destroyClientOnly(): void {
    if (!this.client) return;
    try {
      const ids = [...this.torrents.keys()];
      for (const id of ids) {
        this.dropTorrent(id);
        const item = this.items.get(id);
        if (!item) continue;
        if (item.status === 'downloading') {
          item.status = this.vpnHold ? 'paused' : 'queued';
          item.downloadSpeed = 0;
          item.uploadSpeed = 0;
          item.numPeers = 0;
          if (this.vpnHold) item.error = VPN_KILL_SWITCH_ERROR;
        }
      }
      this.client.destroy(() => undefined);
    } catch {
      // ignore
    }
    this.client = null;
    this.emit('update', this.list());
    if (!this.vpnHold) this.pumpQueue();
  }

  private engageKillSwitch(): void {
    for (const [id, item] of this.items) {
      if (item.status !== 'downloading' && item.status !== 'queued') continue;
      this.dropTorrent(id);
      item.status = 'paused';
      item.downloadSpeed = 0;
      item.uploadSpeed = 0;
      item.numPeers = 0;
      item.error = VPN_KILL_SWITCH_ERROR;
    }
    this.emitUpdateNow();
  }

  private releaseKillSwitch(): void {
    for (const item of this.items.values()) {
      if (item.status === 'paused' && item.error === VPN_KILL_SWITCH_ERROR) {
        item.status = 'queued';
        item.error = undefined;
      }
    }
    this.emitUpdateNow();
    this.pumpQueue();
  }

  private getClient() {
    if (!this.client) {
      this.ensureNetBindPatch();
      const downloadLimit = kbpsToBytesPerSec(this.maxDownloadSpeedKBps);
      const uploadLimit = kbpsToBytesPerSec(this.maxUploadSpeedKBps);
      // uTP (UDP) on Windows throws uncaught "no buffer space available" (ENOBUFS)
      // from utp-native when many peers connect. Always use TCP. When VPN-bound,
      // also disable DHT so peer traffic prefers TCP on the TUN/TAP/DCO IP.
      const opts: Record<string, unknown> = {
        maxConns: Math.min(this.maxConns, MAX_PEER_CONNS),
        downloadLimit,
        uploadLimit,
        utp: false,
      };
      if (this.bindAddress) {
        opts.dht = false;
      }
      this.client = new WebTorrent(opts);
      this.client.on('error', (err: Error) => {
        if (isIgnorableTorrentSocketError(err)) return;
        this.emit('engine-error', err.message);
      });
    }
    return this.client;
  }

  /** Throttle progress IPC so the renderer is not flooded every piece. */
  private emitProgressThrottled(): void {
    const now = Date.now();
    const due = now - this.lastProgressEmit >= PROGRESS_THROTTLE_MS;
    if (due) {
      this.lastProgressEmit = now;
      if (this.progressEmitTimer) {
        clearTimeout(this.progressEmitTimer);
        this.progressEmitTimer = null;
      }
      this.emit('update', this.list());
      return;
    }
    if (!this.progressEmitTimer) {
      const wait = PROGRESS_THROTTLE_MS - (now - this.lastProgressEmit);
      this.progressEmitTimer = setTimeout(() => {
        this.progressEmitTimer = null;
        this.lastProgressEmit = Date.now();
        this.emit('update', this.list());
      }, Math.max(50, wait));
    }
  }

  private emitUpdateNow(): void {
    if (this.progressEmitTimer) {
      clearTimeout(this.progressEmitTimer);
      this.progressEmitTimer = null;
    }
    this.lastProgressEmit = Date.now();
    this.emit('update', this.list());
  }

  private pumpQueue(): void {
    if (this.vpnHold) return;
    if (this.torrents.size >= MAX_ACTIVE_DOWNLOADS) return;
    for (const [id, item] of this.items) {
      if (item.status !== 'queued' || this.torrents.has(id)) continue;
      const job = this.jobs.get(id);
      if (!job) continue;
      if (job.kind === 'episode') this.beginEpisode(id, item, job.opts);
      else this.beginMovie(id, item, job.opts);
      if (this.torrents.size >= MAX_ACTIVE_DOWNLOADS) return;
    }
  }

  private dropTorrent(id: string, destroyStore = false): void {
    const torrent = this.torrents.get(id);
    if (!torrent) return;
    try {
      torrent.destroy({ destroyStore });
    } catch {
      try {
        torrent.destroy();
      } catch {
        // ignore
      }
    }
    this.torrents.delete(id);
  }

  list(): DownloadItem[] {
    return Array.from(this.items.values());
  }

  getDownloadingKeys(): Set<string> {
    const keys = new Set<string>();
    for (const item of this.items.values()) {
      if (item.status === 'downloading' || item.status === 'queued' || item.status === 'paused') {
        keys.add(`${item.showId}:${item.seasonNumber}:${item.episodeNumber}`);
      }
    }
    return keys;
  }

  /** True if this SxxExx is already queued/downloading/paused/done (skip duplicate auto-dl). */
  hasEpisodeActivity(showId: number, season: number, episode: number): boolean {
    for (const item of this.items.values()) {
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

  private selectVideoOnly(torrent: any): void {
    try {
      const files = torrent.files || [];
      if (!files.length) return;
      const mapped = files.map((f: any) => ({
        name: f.name,
        length: f.length,
        path: f.path,
        ref: f,
      }));
      const best = pickVideoFile(mapped);
      if (!best) return;
      for (const f of files) {
        try {
          f.deselect();
        } catch {
          // ignore
        }
      }
      const target = mapped.find((m: any) => m.name === best.name && m.length === best.length)?.ref;
      if (target) {
        try {
          target.select();
        } catch {
          // ignore
        }
      }
    } catch {
      // nice-to-have; never fail the download
    }
  }

  private async handleRejectExe(id: string, item: DownloadItem, torrent: any): Promise<void> {
    const tried = new Set((item.triedInfoHashes || []).map((h) => h.toLowerCase()));
    if (item.infoHash) tried.add(item.infoHash.toLowerCase());
    const snapshot: DownloadItem = {
      ...item,
      status: 'error',
      error: 'Rejected .exe / non-video payload',
      triedInfoHashes: Array.from(tried),
    };
    // Destroy torrent and delete downloaded files — do NOT mark Downloaded
    try {
      torrent.destroy({ destroyStore: true });
    } catch {
      try {
        torrent.destroy();
      } catch {
        // ignore
      }
    }
    this.torrents.delete(id);
    this.jobs.delete(id);
    this.items.delete(id);
    this.emitUpdateNow();
    this.emit('reject-exe', snapshot);
    this.pumpQueue();
  }

  private async finalizeEpisodeDone(
    id: string,
    item: DownloadItem,
    torrent: any,
    opts: {
      show: Show;
      libraryRoot: string;
      seasonNumber: number;
      episodeNumber: number;
      episodeTitle: string;
    }
  ): Promise<void> {
    const files = torrent.files.map((f: any) => ({
      name: f.name,
      length: f.length,
      path: path.join(torrent.path, f.path),
    }));

    if (shouldRejectBadPayload(files)) {
      await this.handleRejectExe(id, item, torrent);
      return;
    }

    const best = pickVideoFile(files);
    const ext = path.extname(best.name) || '.mkv';
    const finalPaths = buildEpisodePath(
      opts.show,
      opts.libraryRoot,
      opts.seasonNumber,
      opts.episodeNumber,
      opts.episodeTitle,
      ext
    );
    const src = best.path;
    const dest = finalPaths.filePath;
    if (src !== dest) {
      try {
        await fsp.access(src);
        await moveFileAsync(src, dest);
      } catch {
        // if move fails, keep original path
      }
    }
    item.progress = 1;
    item.downloadSpeed = 0;
    item.status = 'done';
    item.savePath = dest;
    const snapshot = { ...item };
    this.emit('done', snapshot);
    setImmediate(() => this.remove(id));
  }

  private async finalizeMovieDone(
    id: string,
    item: DownloadItem,
    torrent: any,
    opts: { movie: Movie; movieLibraryRoot: string }
  ): Promise<void> {
    const files = torrent.files.map((f: any) => ({
      name: f.name,
      length: f.length,
      path: path.join(torrent.path, f.path),
    }));

    if (shouldRejectBadPayload(files)) {
      await this.handleRejectExe(id, item, torrent);
      return;
    }

    const best = pickVideoFile(files);
    const ext = path.extname(best.name) || '.mkv';
    const finalPaths = buildMoviePath(opts.movie, opts.movieLibraryRoot, ext);
    const src = best.path;
    const dest = finalPaths.filePath;
    if (src !== dest) {
      try {
        await fsp.access(src);
        await moveFileAsync(src, dest);
      } catch {
        // keep original
      }
    }
    item.progress = 1;
    item.downloadSpeed = 0;
    item.status = 'done';
    item.savePath = dest;
    const snapshot = { ...item };
    this.emit('done', snapshot);
    setImmediate(() => this.remove(id));
  }

  async start(opts: EpisodeStartOpts): Promise<DownloadItem> {
    const id = `${opts.show.tmdbId}-S${opts.seasonNumber}E${opts.episodeNumber}-${Date.now()}`;
    const provisional = buildEpisodePath(
      opts.show,
      opts.libraryRoot,
      opts.seasonNumber,
      opts.episodeNumber,
      opts.episodeTitle,
      '.mkv'
    );
    const item: DownloadItem = {
      id,
      infoHash: '',
      name: `${opts.show.name} S${String(opts.seasonNumber).padStart(2, '0')}E${String(opts.episodeNumber).padStart(2, '0')}`,
      showId: opts.show.tmdbId,
      showName: opts.show.name,
      seasonNumber: opts.seasonNumber,
      episodeNumber: opts.episodeNumber,
      episodeTitle: opts.episodeTitle,
      progress: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      numPeers: 0,
      status: 'queued',
      savePath: provisional.seasonDir,
      magnet: opts.magnet,
      candidates: opts.candidates,
      triedInfoHashes: opts.triedInfoHashes ? [...opts.triedInfoHashes] : [],
      notifyChatId: opts.notifyChatId,
      telegramRequestId: opts.telegramRequestId,
    };
    this.items.set(id, item);
    this.jobs.set(id, { kind: 'episode', opts });
    this.emitUpdateNow();
    this.pumpQueue();
    return item;
  }

  private beginEpisode(id: string, item: DownloadItem, opts: EpisodeStartOpts): void {
    const client = this.getClient();
    try {
      const torrent = client.add(opts.magnet, { path: item.savePath, announce: DEFAULT_ANNOUNCE }, (t: any) => {
        item.infoHash = t.infoHash;
        item.status = 'downloading';
        item.name = t.name || item.name;
        this.emitUpdateNow();
      });
      this.torrents.set(id, torrent);
      torrent.on('ready', () => {
        const mapped = (torrent.files || []).map((f: any) => ({
          name: f.name,
          length: f.length,
          path: path.join(torrent.path, f.path),
        }));
        if (mapped.length && shouldRejectBadPayload(mapped)) {
          void this.handleRejectExe(id, item, torrent);
          return;
        }
        this.selectVideoOnly(torrent);
      });
      torrent.on('download', () => {
        item.progress = torrent.progress;
        item.downloadSpeed = torrent.downloadSpeed;
        item.uploadSpeed = torrent.uploadSpeed;
        item.numPeers = torrent.numPeers;
        item.status = 'downloading';
        this.emitProgressThrottled();
      });
      torrent.on('done', () => {
        void this.finalizeEpisodeDone(id, item, torrent, opts).catch((err) => {
          item.status = 'error';
          item.error = err instanceof Error ? err.message : String(err);
          this.dropTorrent(id);
          this.emitUpdateNow();
          this.pumpQueue();
        });
      });
      torrent.on('error', (err: Error) => {
        item.status = 'error';
        item.error = err.message;
        this.dropTorrent(id);
        this.emitUpdateNow();
        this.pumpQueue();
      });
    } catch (err) {
      item.status = 'error';
      item.error = err instanceof Error ? err.message : String(err);
      this.emitUpdateNow();
      this.pumpQueue();
    }
  }

  /** True if this movie is already queued/downloading/paused/done. */
  hasMovieActivity(movieId: number): boolean {
    for (const item of this.items.values()) {
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

  getDownloadingMovieIds(): Set<number> {
    const ids = new Set<number>();
    for (const item of this.items.values()) {
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

  async startMovie(opts: MovieStartOpts): Promise<DownloadItem> {
    const id = `movie-${opts.movie.tmdbId}-${Date.now()}`;
    const provisional = buildMoviePath(opts.movie, opts.movieLibraryRoot, '.mkv');
    const item: DownloadItem = {
      id,
      infoHash: '',
      name: opts.movie.title,
      showId: opts.movie.tmdbId,
      showName: opts.movie.title,
      seasonNumber: 0,
      episodeNumber: 0,
      episodeTitle: opts.movie.releaseYear ? String(opts.movie.releaseYear) : opts.movie.title,
      progress: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      numPeers: 0,
      status: 'queued',
      savePath: provisional.movieDir,
      magnet: opts.magnet,
      kind: 'movie',
      movieId: opts.movie.tmdbId,
      candidates: opts.candidates,
      triedInfoHashes: opts.triedInfoHashes ? [...opts.triedInfoHashes] : [],
      notifyChatId: opts.notifyChatId,
      telegramRequestId: opts.telegramRequestId,
    };
    this.items.set(id, item);
    this.jobs.set(id, { kind: 'movie', opts });
    this.emitUpdateNow();
    this.pumpQueue();
    return item;
  }

  private beginMovie(id: string, item: DownloadItem, opts: MovieStartOpts): void {
    const client = this.getClient();
    try {
      const torrent = client.add(opts.magnet, { path: item.savePath, announce: DEFAULT_ANNOUNCE }, (t: any) => {
        item.infoHash = t.infoHash;
        item.status = 'downloading';
        item.name = t.name || item.name;
        this.emitUpdateNow();
      });
      this.torrents.set(id, torrent);
      torrent.on('ready', () => {
        const mapped = (torrent.files || []).map((f: any) => ({
          name: f.name,
          length: f.length,
          path: path.join(torrent.path, f.path),
        }));
        if (mapped.length && shouldRejectBadPayload(mapped)) {
          void this.handleRejectExe(id, item, torrent);
          return;
        }
        this.selectVideoOnly(torrent);
      });
      torrent.on('download', () => {
        item.progress = torrent.progress;
        item.downloadSpeed = torrent.downloadSpeed;
        item.uploadSpeed = torrent.uploadSpeed;
        item.numPeers = torrent.numPeers;
        item.status = 'downloading';
        this.emitProgressThrottled();
      });
      torrent.on('done', () => {
        void this.finalizeMovieDone(id, item, torrent, opts).catch((err) => {
          item.status = 'error';
          item.error = err instanceof Error ? err.message : String(err);
          this.dropTorrent(id);
          this.emitUpdateNow();
          this.pumpQueue();
        });
      });
      torrent.on('error', (err: Error) => {
        item.status = 'error';
        item.error = err.message;
        this.dropTorrent(id);
        this.emitUpdateNow();
        this.pumpQueue();
      });
    } catch (err) {
      item.status = 'error';
      item.error = err instanceof Error ? err.message : String(err);
      this.emitUpdateNow();
      this.pumpQueue();
    }
  }

  pause(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    if (item.status === 'queued') {
      item.status = 'paused';
      item.downloadSpeed = 0;
      this.emitUpdateNow();
      return;
    }
    this.dropTorrent(id);
    item.status = 'paused';
    item.downloadSpeed = 0;
    this.emitUpdateNow();
    this.pumpQueue();
  }

  resume(id: string): void {
    const item = this.items.get(id);
    if (!item || !this.jobs.get(id)) return;
    if (this.vpnHold) {
      item.status = 'paused';
      item.error = VPN_KILL_SWITCH_ERROR;
      this.emitUpdateNow();
      return;
    }
    item.status = 'queued';
    item.error = undefined;
    this.emitUpdateNow();
    this.pumpQueue();
  }

  /** Remove from queue and destroy torrent (keep files on disk). */
  remove(id: string): void {
    this.dropTorrent(id);
    this.jobs.delete(id);
    if (this.items.delete(id)) {
      this.emitUpdateNow();
    }
    this.pumpQueue();
  }

  cancel(id: string): void {
    this.remove(id);
  }

  destroy(): void {
    if (this.progressEmitTimer) {
      clearTimeout(this.progressEmitTimer);
      this.progressEmitTimer = null;
    }
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.torrents.clear();
    this.jobs.clear();
    this.items.clear();
  }
}

