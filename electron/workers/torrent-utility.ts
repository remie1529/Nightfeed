/**
 * Electron utilityProcess entry — hosts WebTorrent DownloadEngine off the UI/main process.
 * Communicates with main via process.parentPort message RPC.
 */
import { DownloadEngine, isIgnorableTorrentSocketError } from '../services/engine';
import type { DownloadItem, Movie, Show, TorrentCandidate } from '../types';

type InMsg =
  | { type: 'ping'; requestId: number }
  | { type: 'applySettings'; requestId: number; settings: {
      maxConnections?: number;
      maxDownloadSpeedKBps?: number;
      maxUploadSpeedKBps?: number;
      bindAddress?: string | null;
      bindIfIndex?: number | null;
      vpnHold?: boolean;
      processFolder?: string | null;
    } }
  | {
      type: 'start';
      requestId: number;
      opts: {
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
    }
  | {
      type: 'startMovie';
      requestId: number;
      opts: {
        magnet: string;
        movie: Movie;
        movieLibraryRoot: string;
        candidates?: TorrentCandidate[];
        triedInfoHashes?: string[];
        notifyChatId?: number;
        telegramRequestId?: string;
      };
    }
  | { type: 'pause'; requestId: number; id: string }
  | { type: 'resume'; requestId: number; id: string }
  | { type: 'cancel'; requestId: number; id: string }
  | { type: 'remove'; requestId: number; id: string }
  | { type: 'list'; requestId: number }
  | { type: 'hasEpisodeActivity'; requestId: number; showId: number; season: number; episode: number }
  | { type: 'hasMovieActivity'; requestId: number; movieId: number }
  | { type: 'getDownloadingKeys'; requestId: number }
  | { type: 'getDownloadingMovieIds'; requestId: number }
  | { type: 'restore'; requestId: number; item: DownloadItem; opts: any }
  | { type: 'kickQueue'; requestId: number }
  | { type: 'destroy'; requestId: number };

process.on('uncaughtException', (err) => {
  if (isIgnorableTorrentSocketError(err)) {
    console.error('[torrent-utility] ignored socket exhaustion:', err.message);
    return;
  }
  console.error('[torrent-utility] uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  if (isIgnorableTorrentSocketError(reason)) {
    console.error('[torrent-utility] ignored socket rejection:', reason);
    return;
  }
  console.error('[torrent-utility] unhandledRejection', reason);
});

const port = (process as NodeJS.Process & {
  parentPort?: {
    on: (ev: 'message', cb: (e: { data: InMsg }) => void) => void;
    postMessage: (msg: unknown) => void;
  };
}).parentPort;

if (!port) {
  console.error('[torrent-utility] no parentPort — not running as utilityProcess');
  process.exit(1);
}

const engine = new DownloadEngine();

function reply(requestId: number, payload: Record<string, unknown>): void {
  port!.postMessage({ type: 'reply', requestId, ...payload });
}

engine.on('update', (items: DownloadItem[]) => {
  port!.postMessage({ type: 'event', event: 'update', items });
});
engine.on('done', (item: DownloadItem) => {
  port!.postMessage({ type: 'event', event: 'done', item });
});
engine.on('reject-exe', (item: DownloadItem) => {
  port!.postMessage({ type: 'event', event: 'reject-exe', item });
});
engine.on('engine-error', (message: string) => {
  port!.postMessage({ type: 'event', event: 'engine-error', message });
});

port.on('message', (event) => {
  const msg = event.data;
  void (async () => {
    try {
      switch (msg.type) {
        case 'ping':
          reply(msg.requestId, { ok: true });
          break;
        case 'applySettings':
          engine.applySettings(msg.settings);
          reply(msg.requestId, { ok: true });
          break;
        case 'start': {
          const item = await engine.start(msg.opts);
          reply(msg.requestId, { ok: true, item });
          break;
        }
        case 'startMovie': {
          const item = await engine.startMovie(msg.opts);
          reply(msg.requestId, { ok: true, item });
          break;
        }
        case 'restore': {
          const item = await engine.restore(msg.item, msg.opts);
          reply(msg.requestId, { ok: true, item });
          break;
        }
        case 'kickQueue':
          engine.kickQueue();
          reply(msg.requestId, { ok: true, items: engine.list() });
          break;
        case 'pause':
          engine.pause(msg.id);
          reply(msg.requestId, { ok: true });
          break;
        case 'resume':
          engine.resume(msg.id);
          reply(msg.requestId, { ok: true });
          break;
        case 'cancel':
          engine.cancel(msg.id);
          reply(msg.requestId, { ok: true });
          break;
        case 'remove':
          engine.remove(msg.id);
          reply(msg.requestId, { ok: true });
          break;
        case 'list':
          reply(msg.requestId, { ok: true, items: engine.list() });
          break;
        case 'hasEpisodeActivity':
          reply(msg.requestId, {
            ok: true,
            value: engine.hasEpisodeActivity(msg.showId, msg.season, msg.episode),
          });
          break;
        case 'hasMovieActivity':
          reply(msg.requestId, {
            ok: true,
            value: engine.hasMovieActivity(msg.movieId),
          });
          break;
        case 'getDownloadingKeys':
          reply(msg.requestId, {
            ok: true,
            value: Array.from(engine.getDownloadingKeys()),
          });
          break;
        case 'getDownloadingMovieIds':
          reply(msg.requestId, {
            ok: true,
            value: Array.from(engine.getDownloadingMovieIds()),
          });
          break;
        case 'destroy':
          engine.destroy();
          reply(msg.requestId, { ok: true });
          break;
        default:
          reply((msg as { requestId: number }).requestId, {
            ok: false,
            error: 'Unknown message type',
          });
      }
    } catch (err) {
      reply((msg as { requestId: number }).requestId, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
});

port.postMessage({ type: 'ready' });
