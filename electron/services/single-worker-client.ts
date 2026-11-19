/**
 * Shared single-worker lifecycle client for Electron main-process worker pools.
 *
 * Key guarantees:
 * - Event-driven ready handshake (no polling loops).
 * - Rejects all pending promises on worker error, unexpected exit, or destroy().
 * - Distinguishes worker transport/crash errors (WorkerTransportError) from
 *   normal operational errors returned by the worker ({ ok: false, error }),
 *   so operational errors never permanently kill the worker or duplicate work.
 */
import { Worker } from 'worker_threads';

export class WorkerTransportError extends Error {
  readonly isWorkerTransport = true;
  constructor(message: string) {
    super(message);
    this.name = 'WorkerTransportError';
  }
}

export function isWorkerTransportError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { isWorkerTransport?: boolean }).isWorkerTransport === true
  );
}

export interface SingleWorkerClientOptions {
  name: string;
  workerPath: string;
  readyTimeoutMs?: number;
  maxCrashes?: number;
  serial?: boolean;
  extractResult?: (msg: Record<string, unknown>) => unknown;
  onModeChange?: (usingWorker: boolean) => void;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export class SingleWorkerClient {
  private readonly name: string;
  private readonly workerPath: string;
  private readonly readyTimeoutMs: number;
  private readonly maxCrashes: number;
  private readonly serial: boolean;
  private readonly extractResult: (msg: Record<string, unknown>) => unknown;
  private readonly onModeChange?: (usingWorker: boolean) => void;

  private worker: Worker | null = null;
  private ready = false;
  private busy = false;
  private disabled = false;
  private destroyed = false;
  private crashCount = 0;
  private nextId = 1;
  private initPromise: Promise<boolean> | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly queue: Array<() => void> = [];
  private lastModeNotified: boolean | null = null;

  constructor(opts: SingleWorkerClientOptions) {
    this.name = opts.name;
    this.workerPath = opts.workerPath;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 5000;
    this.maxCrashes = opts.maxCrashes ?? 3;
    this.serial = !!opts.serial;
    this.extractResult = opts.extractResult ?? ((msg) => msg.result);
    this.onModeChange = opts.onModeChange;
  }

  private notifyMode(usingWorker: boolean): void {
    if (this.lastModeNotified === usingWorker) return;
    this.lastModeNotified = usingWorker;
    try {
      this.onModeChange?.(usingWorker);
    } catch {
      // ignore mode logger errors
    }
  }

  private rejectAllPending(reason: string): void {
    this.busy = false;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(new WorkerTransportError(reason));
    }
    while (this.queue.length) {
      const fn = this.queue.shift();
      if (fn) fn();
    }
  }

  private pump(): void {
    if (!this.serial) return;
    while (this.queue.length && !this.busy && this.ready && this.worker) {
      const job = this.queue.shift();
      if (job) job();
    }
  }

  isUsingWorker(): boolean {
    return !this.disabled && !this.destroyed && !!this.worker && this.ready;
  }

  async ensure(): Promise<boolean> {
    if (this.disabled || this.destroyed) {
      this.notifyMode(false);
      return false;
    }
    if (this.worker && this.ready) return true;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise<boolean>((resolveInit) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (!ok) {
          this.initPromise = null;
        }
        resolveInit(ok);
      };

      let w: Worker;
      try {
        w = new Worker(this.workerPath, { workerData: { workerId: 0 } });
      } catch (err) {
        console.error(`[${this.name}] worker spawn failed`, err);
        this.disabled = true;
        this.notifyMode(false);
        finish(false);
        return;
      }

      this.worker = w;

      w.on('message', (msg: Record<string, unknown>) => {
        if (msg && msg.type === 'ready') {
          this.ready = true;
          this.notifyMode(true);
          finish(true);
          this.pump();
          return;
        }
        if (this.serial) this.busy = false;
        if (msg && typeof msg.id === 'number') {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            if (msg.ok) {
              p.resolve(this.extractResult(msg));
            } else {
              // Operational error from worker logic — do NOT disable the worker
              p.reject(new Error(String(msg.error || `${this.name} operation failed`)));
            }
          }
        }
        this.pump();
      });

      w.on('error', (err) => {
        console.error(`[${this.name}] worker error`, err);
        if (this.worker === w) {
          this.ready = false;
          this.worker = null;
          this.initPromise = null;
        }
        this.crashCount += 1;
        if (this.crashCount >= this.maxCrashes) {
          this.disabled = true;
          this.notifyMode(false);
        }
        this.rejectAllPending(
          `${this.name} worker error: ${err instanceof Error ? err.message : String(err)}`
        );
        finish(false);
      });

      w.on('exit', (code) => {
        const wasActive = this.worker === w;
        if (wasActive) {
          this.ready = false;
          this.worker = null;
          this.initPromise = null;
        }
        if (!this.destroyed && code !== 0) {
          console.error(`[${this.name}] worker exited with code ${code}`);
          this.crashCount += 1;
          if (this.crashCount >= this.maxCrashes) {
            this.disabled = true;
            this.notifyMode(false);
          }
        }
        this.rejectAllPending(`${this.name} worker exited (${code})`);
        finish(false);
      });

      timer = setTimeout(() => {
        if (this.ready) {
          finish(true);
          return;
        }
        console.error(`[${this.name}] worker ready handshake timed out`);
        if (this.worker === w) {
          this.worker = null;
          this.ready = false;
        }
        this.disabled = true;
        this.notifyMode(false);
        try {
          void w.terminate();
        } catch {
          // ignore
        }
        this.rejectAllPending(`${this.name} worker ready timeout`);
        finish(false);
      }, this.readyTimeoutMs);
    });

    return this.initPromise;
  }

  async run<T = unknown>(payload: Record<string, unknown>): Promise<T> {
    const ok = await this.ensure();
    if (!ok || !this.worker || !this.ready) {
      throw new WorkerTransportError(`${this.name} worker unavailable`);
    }

    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const send = () => {
        if (!this.worker || !this.ready || this.destroyed) {
          reject(new WorkerTransportError(`${this.name} worker unavailable`));
          return;
        }
        if (this.serial && this.busy) {
          this.queue.push(send);
          return;
        }
        if (this.serial) this.busy = true;
        this.pending.set(id, {
          resolve: (v) => resolve(v as T),
          reject,
        });
        try {
          this.worker.postMessage({ ...payload, id });
        } catch (err) {
          this.pending.delete(id);
          if (this.serial) this.busy = false;
          reject(
            new WorkerTransportError(
              `${this.name} postMessage failed: ${err instanceof Error ? err.message : String(err)}`
            )
          );
          this.pump();
        }
      };

      send();
    });
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.ready = false;
    this.initPromise = null;
    const w = this.worker;
    this.worker = null;
    this.rejectAllPending(`${this.name} worker destroyed`);
    if (w) {
      try {
        await w.terminate();
      } catch {
        // ignore
      }
    }
  }
}
