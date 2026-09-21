/**
 * Dedicated Live TV lineup refresh worker (fetch + parse off Electron main).
 */
import { parentPort, workerData } from 'worker_threads';
import type { AppSettings, LiveTvChannel } from '../types';
import { refreshLiveTvCore } from '../services/livetv-refresh-core';

export type LiveTvWorkerRequest = {
  id: number;
  op: 'refresh';
  settings: AppSettings;
  existing: LiveTvChannel[];
};

if (!parentPort) throw new Error('livetv-worker must run as worker_threads Worker');

parentPort.on('message', (msg: LiveTvWorkerRequest) => {
  void (async () => {
    try {
      if (msg.op !== 'refresh') {
        parentPort!.postMessage({ id: msg.id, ok: false, error: 'Unknown livetv op' });
        return;
      }
      const result = await refreshLiveTvCore({
        settings: msg.settings,
        existing: msg.existing || [],
      });
      parentPort!.postMessage({ id: msg.id, ok: true, result });
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
