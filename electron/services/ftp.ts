import path from 'path';
import { AppSettings } from '../types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ftp = require('basic-ftp');

/**
 * Upload a finished local library file to the configured FTP server.
 * Never logs the password. Throws on failure (caller toasts; does not undo local success).
 */
export async function uploadFinishedFile(
  settings: AppSettings,
  localFilePath: string
): Promise<void> {
  if (!settings.ftpEnabled) return;
  const host = (settings.ftpHost || '').trim();
  if (!host) throw new Error('FTP host is not set');
  const local = (localFilePath || '').trim();
  if (!local) throw new Error('No local file to upload');

  const port = settings.ftpPort > 0 ? Math.floor(settings.ftpPort) : 21;
  const user = settings.ftpUser || 'anonymous';
  const password = settings.ftpPassword || '';
  const remoteBase = (settings.ftpRemoteBasePath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const baseName = path.basename(local);
  const remotePath = remoteBase ? `${remoteBase}/${baseName}` : baseName;

  const client = new ftp.Client(60_000);
  client.ftp.verbose = false;
  try {
    await client.access({
      host,
      port,
      user,
      password,
      secure: false,
    });
    if (remoteBase) {
      await client.ensureDir(remoteBase);
    }
    await client.uploadFrom(local, remotePath);
  } finally {
    client.close();
  }
}
