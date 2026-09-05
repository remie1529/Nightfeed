import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { DownloadItem, Show } from '../types';
import { buildEpisodePath } from './paths';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const WebTorrent = require('webtorrent') as any;

const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv', '.ts', '.webm']);

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
  const videos = files.filter((f) => VIDEO_EXTS.has(path.extname(f.name).toLowerCase()));
  if (videos.length === 0) return files.sort((a, b) => b.length - a.length)[0];
  return videos.sort((a, b) => b.length - a.length)[0];
}

function kbpsToBytesPerSec(kbps: number): number {
  // WebTorrent throttle* / downloadLimit use bytes/sec; -1 = unlimited
  if (!kbps || kbps <= 0) return -1;
  return Math.max(1, Math.round(kbps * 1024));
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
  private maxConns = 150;
  private maxDownloadSpeedKBps = 0;
  private maxUploadSpeedKBps = 0;

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

  async start(opts: {
    magnet: string;
    show: Show;
    libraryRoot: string;
    seasonNumber: number;
    episodeNumber: number;
    episodeTitle: string;
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
    };
    this.items.set(id, item);
    this.emit('update', this.list());

    return new Promise((resolve, reject) => {
      try {
        const torrent = client.add(
          opts.magnet,
          { path: provisional.seasonDir, announce: DEFAULT_ANNOUNCE },
          (t: any) => {
            item.infoHash = t.infoHash;
            item.status = 'downloading';
            item.name = t.name || item.name;
            this.emit('update', this.list());
            resolve(item);
          }
        );

        this.torrents.set(id, torrent);

        torrent.on('ready', () => {
          this.selectVideoOnly(torrent);
        });

        torrent.on('download', () => {
          item.progress = torrent.progress;
          item.downloadSpeed = torrent.downloadSpeed;
          item.uploadSpeed = torrent.uploadSpeed;
          item.numPeers = torrent.numPeers;
          item.status = 'downloading';
          this.emit('update', this.list());
        });

        torrent.on('done', async () => {
          try {
            const files = torrent.files.map((f: any) => ({
              name: f.name,
              length: f.length,
              path: path.join(torrent.path, f.path),
            }));
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
            if (src !== dest && fs.existsSync(src)) {
              try {
                if (fs.existsSync(dest)) fs.unlinkSync(dest);
                fs.renameSync(src, dest);
              } catch {
                fs.copyFileSync(src, dest);
              }
            }
            item.progress = 1;
            item.downloadSpeed = 0;
            item.status = 'done';
            item.savePath = dest;
            // Emit done first so main can set override + toast; then remove from queue / stop seeding
            const snapshot = { ...item };
            this.emit('done', snapshot);
            setImmediate(() => this.remove(id));
          } catch (err) {
            item.status = 'error';
            item.error = err instanceof Error ? err.message : String(err);
            this.emit('update', this.list());
          }
        });

        torrent.on('error', (err: Error) => {
          item.status = 'error';
          item.error = err.message;
          this.emit('update', this.list());
          reject(err);
        });
      } catch (err) {
        item.status = 'error';
        item.error = err instanceof Error ? err.message : String(err);
        this.emit('update', this.list());
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
      this.emit('update', this.list());
    }
  }

  resume(id: string): void {
    const torrent = this.torrents.get(id);
    const item = this.items.get(id);
    if (torrent && item) {
      torrent.resume();
      item.status = 'downloading';
      this.emit('update', this.list());
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
      this.emit('update', this.list());
    }
  }

  cancel(id: string): void {
    this.remove(id);
  }

  destroy(): void {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.torrents.clear();
    this.items.clear();
  }
}

export const downloadEngine = new DownloadEngine();
