import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SingleWorkerClient,
  isWorkerTransportError,
} from '../electron/services/single-worker-client';

function writeTempWorker(code: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-worker-test-'));
  const file = path.join(dir, 'worker.js');
  fs.writeFileSync(file, code, 'utf8');
  return { dir, file };
}

test('SingleWorkerClient keeps worker alive on operational error and respawns after crash', async () => {
  const { dir, file } = writeTempWorker(`
    const { parentPort } = require('worker_threads');
    parentPort.postMessage({ type: 'ready' });
    parentPort.on('message', (msg) => {
      if (msg.op === 'echo') {
        parentPort.postMessage({ id: msg.id, ok: true, result: msg.value });
      } else if (msg.op === 'opError') {
        parentPort.postMessage({ id: msg.id, ok: false, error: 'Bad input' });
      } else if (msg.op === 'crash') {
        process.exit(1);
      } else if (msg.op === 'hang') {
        // intentionally never reply
      }
    });
  `);

  const client = new SingleWorkerClient({
    name: 'test-worker',
    workerPath: file,
    readyTimeoutMs: 3000,
    maxCrashes: 3,
  });

  try {
    // 1. Normal call succeeds
    const r1 = await client.run<string>({ op: 'echo', value: 'hello' });
    assert.equal(r1, 'hello');
    assert.equal(client.isUsingWorker(), true);

    // 2. Operational error rejects with regular Error (NOT WorkerTransportError) and keeps worker alive
    await assert.rejects(
      () => client.run({ op: 'opError' }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, 'Bad input');
        assert.equal(isWorkerTransportError(err), false);
        return true;
      }
    );
    assert.equal(client.isUsingWorker(), true);

    // 3. Crash mid-job rejects pending promise immediately with WorkerTransportError (never hangs)
    await assert.rejects(
      () => client.run({ op: 'crash' }),
      (err: unknown) => {
        assert.equal(isWorkerTransportError(err), true);
        return true;
      }
    );

    // 4. Subsequent call respawns cleanly (crashCount < maxCrashes)
    const r2 = await client.run<string>({ op: 'echo', value: 'recovered' });
    assert.equal(r2, 'recovered');

    // 5. destroy() rejects in-flight hung promise immediately
    const hung = client.run({ op: 'hang' });
    const hungCheck = assert.rejects(hung, (err: unknown) => {
      assert.equal(isWorkerTransportError(err), true);
      return true;
    });
    await new Promise((r) => setTimeout(r, 30));
    await client.destroy();
    await hungCheck;
  } finally {
    await client.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
