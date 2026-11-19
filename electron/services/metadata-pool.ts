/**
 * Dedicated worker for TVMaze / IMDb library search so main-thread download
 * persistence and progress IPC never starve search.
 */
import { resolveDistElectronAsset } from './asset-path';
import { searchShows as searchShowsDirect, type MazeSearchItem } from './tvmaze-search';
import { searchMovies as searchMoviesDirect, type MovieSearchItem } from './imdb';
import { SingleWorkerClient, isWorkerTransportError } from './single-worker-client';

const client = new SingleWorkerClient({
  name: 'metadata-pool',
  workerPath: resolveDistElectronAsset('metadata-worker.js'),
  readyTimeoutMs: 5000,
  serial: true,
  extractResult: (msg) => msg.results,
});

export async function searchShowsMeta(query: string): Promise<MazeSearchItem[]> {
  try {
    return await client.run<MazeSearchItem[]>({ op: 'shows', query });
  } catch (err) {
    if (!isWorkerTransportError(err)) throw err;
    return searchShowsDirect(query);
  }
}

export async function searchMoviesMeta(query: string): Promise<MovieSearchItem[]> {
  try {
    return await client.run<MovieSearchItem[]>({ op: 'movies', query });
  } catch (err) {
    if (!isWorkerTransportError(err)) throw err;
    return searchMoviesDirect(query);
  }
}

export function getMetadataPoolInfo(): { usingWorker: boolean } {
  return { usingWorker: client.isUsingWorker() };
}

export function destroyMetadataPool(): Promise<void> {
  return client.destroy();
}
