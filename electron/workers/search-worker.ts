/**
 * Search worker — runs torrent HTTP fetch + merge/dedupe/rank off the Electron main thread.
 * Loaded via worker_threads from search-pool.ts.
 */
import { parentPort, workerData } from 'worker_threads';
import {
  mergeByInfoHash,
  rankResults,
  searchEpisodeTorrents,
  searchMovieTorrents,
} from '../services/search';
import type { AppSettings, Resolution, SearchResult } from '../types';

export type SearchWorkerRequest =
  | {
      id: number;
      op: 'episode';
      settings: AppSettings;
      showName: string;
      season: number;
      episode: number;
      preferred: Resolution;
      opts?: { imdbId?: string | null; mazeId?: number; airDate?: string | null };
    }
  | {
      id: number;
      op: 'movie';
      settings: AppSettings;
      title: string;
      year: number | null | undefined;
      preferred: Resolution;
    }
  | {
      id: number;
      op: 'rank';
      groups: SearchResult[][];
      preferred: Resolution;
    };

export type SearchWorkerResponse =
  | {
      id: number;
      ok: true;
      result: { results: SearchResult[]; query: string; error?: string; dateFiltered?: number };
    }
  | {
      id: number;
      ok: true;
      result: { results: SearchResult[]; query?: string; error?: string };
    }
  | { id: number; ok: false; error: string };

async function handle(msg: SearchWorkerRequest): Promise<SearchWorkerResponse> {
  try {
    if (msg.op === 'episode') {
      const result = await searchEpisodeTorrents(
        msg.settings,
        msg.showName,
        msg.season,
        msg.episode,
        msg.preferred,
        msg.opts || {}
      );
      return { id: msg.id, ok: true, result };
    }
    if (msg.op === 'movie') {
      const result = await searchMovieTorrents(
        msg.settings,
        msg.title,
        msg.year,
        msg.preferred
      );
      return { id: msg.id, ok: true, result };
    }
    if (msg.op === 'rank') {
      const merged = mergeByInfoHash(msg.groups);
      const ranked = rankResults(merged, msg.preferred);
      return { id: msg.id, ok: true, result: { results: ranked, query: '' } };
    }
    return { id: (msg as { id: number }).id, ok: false, error: 'Unknown op' };
  } catch (err) {
    return {
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

if (!parentPort) {
  throw new Error('search-worker must be run as a worker_threads Worker');
}

parentPort.on('message', (msg: SearchWorkerRequest) => {
  void handle(msg).then((res) => parentPort!.postMessage(res));
});

// Ready handshake (pool waits for this)
parentPort.postMessage({ type: 'ready', workerId: workerData?.workerId ?? 0 });
