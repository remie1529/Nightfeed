/**
 * Dedicated backup JSON read/write worker (heavy stringify/parse + disk off main).
 */
import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';

export type BackupRequest =
  | { id: number; op: 'writeJson'; filePath: string; data: unknown }
  | { id: number; op: 'readJson'; filePath: string };

if (!parentPort) throw new Error('backup-worker must run as worker_threads Worker');

parentPort.on('message', (msg: BackupRequest) => {
  try {
    if (msg.op === 'writeJson') {
      const text = JSON.stringify(msg.data, null, 2);
      fs.writeFileSync(msg.filePath, text, 'utf8');
      parentPort!.postMessage({ id: msg.id, ok: true, bytes: Buffer.byteLength(text, 'utf8') });
      return;
    }
    if (msg.op === 'readJson') {
      const raw = fs.readFileSync(msg.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      parentPort!.postMessage({ id: msg.id, ok: true, result: parsed });
      return;
    }
    parentPort!.postMessage({ id: (msg as any).id, ok: false, error: 'Unknown backup op' });
  } catch (err) {
    parentPort!.postMessage({
      id: (msg as any).id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

parentPort.postMessage({ type: 'ready', workerId: workerData?.workerId ?? 0 });
