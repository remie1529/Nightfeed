/**
 * Metadata search worker — TVMaze show search + IMDb movie search off the main thread.
 * Keeps library zoekfunctie responsive while WebTorrent (even in-process fallback) is busy.
 */
import { parentPort, workerData } from 'worker_threads';
import { searchShows } from '../services/tvmaze-search';
import { searchMovies } from '../services/imdb';

export type MetadataWorkerRequest =
  | { id: number; op: 'shows'; query: string }
  | { id: number; op: 'movies'; query: string };

if (!parentPort) {
  throw new Error('metadata-worker must be run as a worker_threads Worker');
}

parentPort.on('message', (msg: MetadataWorkerRequest) => {
  void (async () => {
    try {
      if (msg.op === 'shows') {
        const results = await searchShows(msg.query || '');
        parentPort!.postMessage({ id: msg.id, ok: true, results });
        return;
      }
      if (msg.op === 'movies') {
        const results = await searchMovies(msg.query || '');
        parentPort!.postMessage({ id: msg.id, ok: true, results });
        return;
      }
      parentPort!.postMessage({
        id: (msg as { id: number }).id,
        ok: false,
        error: 'Unknown metadata op',
      });
    } catch (err) {
      parentPort!.postMessage({
        id: msg.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
});

parentPort.postMessage({ type: 'ready', workerId: workerData?.workerId ?? 0 });
