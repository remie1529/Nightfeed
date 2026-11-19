/**
 * Live TV refresh via dedicated worker; falls back to in-process refreshLiveTvCore.
 */
import { resolveDistElectronAsset } from './asset-path';
import { activityLog } from './activity-log';
import { SingleWorkerClient, isWorkerTransportError } from './single-worker-client';
import {
  refreshLiveTvCore,
  type LiveTvRefreshInput,
  type LiveTvRefreshOutput,
} from './livetv-refresh-core';

const client = new SingleWorkerClient({
  name: 'livetv-pool',
  workerPath: resolveDistElectronAsset('livetv-worker.js'),
  readyTimeoutMs: 8000,
  onModeChange: (using) => {
    if (using) activityLog.info('livetv', 'Live TV refresh using dedicated worker');
    else activityLog.warn('livetv', 'Live TV worker unavailable — refresh falling back to main process');
  },
});

export async function refreshLiveTvViaPool(
  input: LiveTvRefreshInput
): Promise<LiveTvRefreshOutput & { usedWorker: boolean }> {
  try {
    const result = await client.run<LiveTvRefreshOutput>({
      op: 'refresh',
      settings: input.settings,
      existing: input.existing,
    });
    return { ...result, usedWorker: true };
  } catch (err) {
    if (!isWorkerTransportError(err)) throw err;
    console.error('[livetv-pool] worker unavailable, falling back', err);
    const result = await refreshLiveTvCore(input);
    return { ...result, usedWorker: false };
  }
}

export function destroyLiveTvPool(): Promise<void> {
  return client.destroy();
}
