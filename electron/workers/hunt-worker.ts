/**
 * Dedicated auto-hunt worker (worker_threads).
 * Decides missing/upgrade jobs, runs torrent search + filters/picks off Electron main.
 * Does not host WebTorrent — returns download intents for main to start.
 */
import { parentPort, workerData } from 'worker_threads';
import type { AppSettings, EpisodeOverrideStatus, Movie, Show } from '../types';
import {
  huntMoviesCore,
  huntShowsCore,
  type HuntDownloadIntent,
  type HuntLogLine,
} from '../services/hunt-core';

export type HuntWorkerShowsRequest = {
  id: number;
  op: 'huntShows';
  shows: Show[];
  settings: AppSettings;
  force?: boolean;
  overrides: Record<string, EpisodeOverrideStatus>;
  triedTorrents: Record<string, string[]>;
  activeEpisodeKeys: string[];
};

export type HuntWorkerMoviesRequest = {
  id: number;
  op: 'huntMovies';
  movies: Movie[];
  settings: AppSettings;
  allowUpgrade?: boolean;
  force?: boolean;
  triedTorrents: Record<string, string[]>;
  activeMovieIds: number[];
};

export type HuntWorkerRequest = HuntWorkerShowsRequest | HuntWorkerMoviesRequest;

export type HuntWorkerResult = {
  intents: HuntDownloadIntent[];
  logs: HuntLogLine[];
};

if (!parentPort) {
  throw new Error('hunt-worker must be run as a worker_threads Worker');
}

parentPort.on('message', (msg: HuntWorkerRequest) => {
  void (async () => {
    try {
      if (msg.op === 'huntShows') {
        const result = await huntShowsCore({
          shows: msg.shows || [],
          settings: msg.settings,
          force: msg.force,
          overrides: msg.overrides || {},
          triedTorrents: msg.triedTorrents || {},
          activeEpisodeKeys: msg.activeEpisodeKeys || [],
          onProgress: (p) => {
            parentPort!.postMessage({
              type: 'progress',
              id: msg.id,
              phase: p.phase,
              current: p.current,
              total: p.total,
              label: p.label,
            });
          },
        });
        parentPort!.postMessage({ id: msg.id, ok: true, result });
        return;
      }
      if (msg.op === 'huntMovies') {
        const result = await huntMoviesCore({
          movies: msg.movies || [],
          settings: msg.settings,
          allowUpgrade: msg.allowUpgrade,
          force: msg.force,
          triedTorrents: msg.triedTorrents || {},
          activeMovieIds: msg.activeMovieIds || [],
          onProgress: (p) => {
            parentPort!.postMessage({
              type: 'progress',
              id: msg.id,
              phase: p.phase,
              current: p.current,
              total: p.total,
              label: p.label,
            });
          },
        });
        parentPort!.postMessage({ id: msg.id, ok: true, result });
        return;
      }
      parentPort!.postMessage({
        id: (msg as { id: number }).id,
        ok: false,
        error: 'Unknown hunt op',
      });
    } catch (err) {
      parentPort!.postMessage({
        id: (msg as { id: number }).id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
});

parentPort.postMessage({ type: 'ready', workerId: workerData?.workerId ?? 0 });
