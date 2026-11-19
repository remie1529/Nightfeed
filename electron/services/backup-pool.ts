/**
 * Backup JSON serialize/parse + file I/O on a dedicated worker.
 */
import fs from 'fs';
import { resolveDistElectronAsset } from './asset-path';
import { activityLog } from './activity-log';
import { SingleWorkerClient, isWorkerTransportError } from './single-worker-client';

const client = new SingleWorkerClient({
  name: 'backup-pool',
  workerPath: resolveDistElectronAsset('backup-worker.js'),
  readyTimeoutMs: 5000,
  extractResult: (msg) => msg.result ?? msg.bytes,
  onModeChange: (using) => {
    if (using) activityLog.info('backup', 'Backup export/import using dedicated worker');
    else activityLog.warn('backup', 'Backup worker unavailable — falling back to main process');
  },
});

export async function writeBackupJsonViaPool(filePath: string, data: unknown): Promise<void> {
  try {
    await client.run({ op: 'writeJson', filePath, data });
  } catch (err) {
    if (!isWorkerTransportError(err)) throw err;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }
}

export async function readBackupJsonViaPool(filePath: string): Promise<unknown> {
  try {
    return await client.run({ op: 'readJson', filePath });
  } catch (err) {
    if (!isWorkerTransportError(err)) throw err;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
}

export function destroyBackupPool(): Promise<void> {
  return client.destroy();
}
