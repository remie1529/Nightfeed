import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { DownloadItem } from '../types';
import { buildEpisodePath } from './paths';
import { Show } from '../types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const WebTorrent = require('webtorrent') as any;

const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv', '.ts', '.webm']);

function pickVideoFile(files: Array<{ name: string; length: number; path: string }>) {
  const videos = files.filter((f) => VIDEO_EXTS.has(path.extname(f.name).toLowerCase()));
  if (videos.length === 0) return files.sort((a, b) => b.length - a.length)[0];
  return videos.sort((a, b) => b.length - a.length)[0];
}

export class DownloadEngine extends EventEmitter {
  private client: any = null;
  private items = new Map<string, DownloadItem>();
  private torrents = new Map<string, any>();

  private getClient() {
    if (!this.client) {
      this.client = new WebTorrent({ maxConns: 55 });
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
        const torrent = client.add(opts.magnet, { path: provisional.seasonDir }, (t: any) => {
          item.infoHash = t.infoHash;
          item.status = 'downloading';
          item.name = t.name || item.name;
          this.emit('update', this.list());
          resolve(item);
        });

        this.torrents.set(id, torrent);

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
            this.emit('update', this.list());
            this.emit('done', item);
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

  cancel(id: string): void {
    const torrent = this.torrents.get(id);
    const item = this.items.get(id);
    if (torrent) {
      torrent.destroy({ destroyStore: false });
      this.torrents.delete(id);
    }
    if (item) {
      this.items.delete(id);
      this.emit('update', this.list());
    }
  }

  destroy(): void {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.torrents.clear();
  }
}

export const downloadEngine = new DownloadEngine();
