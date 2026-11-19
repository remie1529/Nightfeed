/**
 * FTP upload via dedicated worker; falls back to in-process uploadFinishedFile.
 */
import { resolveDistElectronAsset } from './asset-path';
import { uploadFinishedFile } from './ftp';
import { activityLog } from './activity-log';
import { SingleWorkerClient, isWorkerTransportError } from './single-worker-client';
import type { AppSettings } from '../types';

const client = new SingleWorkerClient({
  name: 'ftp-pool',
  workerPath: resolveDistElectronAsset('ftp-worker.js'),
  readyTimeoutMs: 5000,
  onModeChange: (using) => {
    if (using) activityLog.info('ftp', 'FTP uploads using dedicated worker');
    else activityLog.warn('ftp', 'FTP worker unavailable — uploads falling back to main process');
  },
});

export async function uploadViaPool(settings: AppSettings, localPath: string): Promise<void> {
  if (!settings.ftpEnabled) return;
  try {
    await client.run({
      op: 'upload',
      host: settings.ftpHost,
      port: settings.ftpPort,
      user: settings.ftpUser,
      password: settings.ftpPassword,
      remoteBase: settings.ftpRemoteBasePath,
      localPath,
    });
  } catch (err) {
    if (!isWorkerTransportError(err)) throw err;
    await uploadFinishedFile(settings, localPath);
  }
}

export function destroyFtpPool(): Promise<void> {
  return client.destroy();
}
