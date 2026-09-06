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

const PROGRESS_THROTTLE_MS = 350;

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

export interface EngineSettings {
  maxConnections?: number;
  maxDownloadSpeedKBps?: number;
  maxUploadSpeedKBps?: number;
}

export class DownloadEngine extends EventEmitter {
  private client: any = null;
  private items = new Map<string, DownloadItem>();
  private torrents = new Map<string, any>();
  private maxConns = 200;
  private maxDownloadSpeedKBps = 0;
  private maxUploadSpeedKBps = 0;
  private lastProgressEmit = 0;
  private progressEmitTimer: NodeJS.Timeout | null = null;

  /** Apply connection / speed settings. Safe to call before or after client exists. */
  applySettings(settings: EngineSettings): void {
    if (typeof settings.maxConnections === 'number' && settings.maxConnections > 0) {
      this.maxConns = Math.max(1, Math.floor(settings.maxConnections));
    }
    if (typeof settings.maxDownloadSpeedKBps === 'number') {
      this.maxDownloadSpeedKBps = Math.max(0, Math.floor(settings.maxDownloadSpeedKBps));
    }
    if (typeof settings.maxUploadSpeedKBps === 'number') {
      this.maxUploadSpeedKBps = Math.max(0, Math.floor(settings.maxUploadSpeedKBps));
    }
    if (this.client) {
      this.client.maxConns = this.maxConns;
      // webtorrent 1.9.7: client.throttleDownload / throttleUpload (bytes/sec, -1 = unlimited)
      this.client.throttleDownload(kbpsToBytesPerSec(this.maxDownloadSpeedKBps));
      this.client.throttleUpload(kbpsToBytesPerSec(this.maxUploadSpeedKBps));
    }
  }

  private getClient() {
    if (!this.client) {
      const downloadLimit = kbpsToBytesPerSec(this.maxDownloadSpeedKBps);
      const uploadLimit = kbpsToBytesPerSec(this.maxUploadSpeedKBps);
      this.client = new WebTorrent({
        maxConns: this.maxConns,
        downloadLimit,
        uploadLimit,
      });
      this.client.on('error', (err: Error) => {
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
    this.items.delete(id);
    this.emitUpdateNow();
    this.emit('reject-exe', snapshot);
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

  async start(opts: {
    magnet: string;
    show: Show;
    libraryRoot: string;
    seasonNumber: number;
    episodeNumber: number;
    episodeTitle: string;
    candidates?: TorrentCandidate[];
    triedInfoHashes?: string[];
  }): Promise<DownloadItem> {
    const client = this.getClient();
    const id = `${opts.show.tmdbId}-S${opts.seasonNumber}E${opts.episodeNumber}-${Date.now()}`;

    // provisional season dir; final rename after we know extension
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
    };
    this.items.set(id, item);
    this.emitUpdateNow();

    return new Promise((resolve, reject) => {
      try {
        const torrent = client.add(
          opts.magnet,
          { path: provisional.seasonDir, announce: DEFAULT_ANNOUNCE },
          (t: any) => {
            item.infoHash = t.infoHash;
            item.status = 'downloading';
            item.name = t.name || item.name;
            this.emitUpdateNow();
            resolve(item);
          }
        );

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
            this.emitUpdateNow();
          });
        });

        torrent.on('error', (err: Error) => {
          item.status = 'error';
          item.error = err.message;
          this.emitUpdateNow();
          reject(err);
        });
      } catch (err) {
        item.status = 'error';
        item.error = err instanceof Error ? err.message : String(err);
        this.emitUpdateNow();
        reject(err);
      }
    });
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

  async startMovie(opts: {
    magnet: string;
    movie: Movie;
    movieLibraryRoot: string;
    candidates?: TorrentCandidate[];
    triedInfoHashes?: string[];
  }): Promise<DownloadItem> {
    const client = this.getClient();
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
    };
    this.items.set(id, item);
    this.emitUpdateNow();

    return new Promise((resolve, reject) => {
      try {
        const torrent = client.add(
          opts.magnet,
          { path: provisional.movieDir, announce: DEFAULT_ANNOUNCE },
          (t: any) => {
            item.infoHash = t.infoHash;
            item.status = 'downloading';
            item.name = t.name || item.name;
            this.emitUpdateNow();
            resolve(item);
          }
        );

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
            this.emitUpdateNow();
          });
        });

        torrent.on('error', (err: Error) => {
          item.status = 'error';
          item.error = err.message;
          this.emitUpdateNow();
          reject(err);
        });
      } catch (err) {
        item.status = 'error';
        item.error = err instanceof Error ? err.message : String(err);
        this.emitUpdateNow();
        reject(err);
      }
    });
  }

  pause(id: string): void {
    const torrent = this.torrents.get(id);
    const item = this.items.get(id);
    if (torrent && item) {
      torrent.pause();
      item.status = 'paused';
      item.downloadSpeed = 0;
      this.emitUpdateNow();
    }
  }

  resume(id: string): void {
    const torrent = this.torrents.get(id);
    const item = this.items.get(id);
    if (torrent && item) {
      torrent.resume();
      item.status = 'downloading';
      this.emitUpdateNow();
    }
  }

  /** Remove from queue and destroy torrent (keep files on disk). */
  remove(id: string): void {
    const torrent = this.torrents.get(id);
    const item = this.items.get(id);
    if (torrent) {
      try {
        torrent.destroy({ destroyStore: false });
      } catch {
        // already destroyed
      }
      this.torrents.delete(id);
    }
    if (item) {
      this.items.delete(id);
      this.emitUpdateNow();
    }
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
    this.items.clear();
  }
}

