/**
 * Dedicated FTP upload worker (worker_threads). Keeps basic-ftp I/O off Electron main.
 */
import { parentPort, workerData } from 'worker_threads';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ftp = require('basic-ftp');

export type FtpUploadRequest = {
  id: number;
  op: 'upload';
  host: string;
  port: number;
  user: string;
  password: string;
  remoteBase: string;
  localPath: string;
};

if (!parentPort) throw new Error('ftp-worker must run as worker_threads Worker');

parentPort.on('message', (msg: FtpUploadRequest) => {
  void (async () => {
    try {
      if (msg.op !== 'upload') {
        parentPort!.postMessage({ id: msg.id, ok: false, error: 'Unknown ftp op' });
        return;
      }
      const host = (msg.host || '').trim();
      if (!host) throw new Error('FTP host is not set');
      const local = (msg.localPath || '').trim();
      if (!local) throw new Error('No local file to upload');
      const port = msg.port > 0 ? Math.floor(msg.port) : 21;
      const user = msg.user || 'anonymous';
      const password = msg.password || '';
      const remoteBase = (msg.remoteBase || '').replace(/\\/g, '/').replace(/\/+$/, '');
      const baseName = path.basename(local);
      const remotePath = remoteBase ? `${remoteBase}/${baseName}` : baseName;
      const client = new ftp.Client(60_000);
      client.ftp.verbose = false;
      try {
        await client.access({ host, port, user, password, secure: false });
        if (remoteBase) await client.ensureDir(remoteBase);
        await client.uploadFrom(local, remotePath);
      } finally {
        client.close();
      }
      parentPort!.postMessage({ id: msg.id, ok: true });
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
