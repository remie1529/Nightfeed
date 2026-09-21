/**
 * Dedicated auto-hunt worker (worker_threads).
 * Decides missing/upgrade jobs, runs torrent search + filters/picks off Electron main.
 * Does not host WebTorrent — returns download intents for main to start.
 */
import { parentPort, workerData } from 'worker_threads';
import type { AppSettings, EpisodeOverrideStatus, Movie } from '../types';
import {
  huntMoviesCore,
  huntShowsCore,
  type HuntDownloadIntent,
  type HuntLogLine,
  type HuntShowDto,
} from '../services/hunt-core';

export type HuntWorkerShowsRequest = {
  id: number;
  op: 'huntShows';
  shows: HuntShowDto[];
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

function createLogBuffer(jobId: number) {
  let buf: HuntLogLine[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!buf.length) return;
    const lines = buf;
    buf = [];
    parentPort!.postMessage({ type: 'logBatch', id: jobId, lines });
  };
  return {
    push(line: HuntLogLine) {
      buf.push(line);
      if (buf.length >= 15) flush();
      else if (!timer) timer = setTimeout(flush, 40);
    },
    flush,
  };
}



parentPort.on('message', (msg: HuntWorkerRequest) => {
  void (async () => {
    try {
      if (msg.op === 'huntShows') {
        const logBuf = createLogBuffer(msg.id);
        try {
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
            onLog: (line) => logBuf.push(line),
          });
          logBuf.flush();
          parentPort!.postMessage({ id: msg.id, ok: true, result });
        } catch (err) {
          logBuf.flush();
          throw err;
        }
        return;
      }
      if (msg.op === 'huntMovies') {
        const logBuf = createLogBuffer(msg.id);
        try {
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
            onLog: (line) => logBuf.push(line),
          });
          logBuf.flush();
          parentPort!.postMessage({ id: msg.id, ok: true, result });
        } catch (err) {
          logBuf.flush();
          throw err;
        }
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
