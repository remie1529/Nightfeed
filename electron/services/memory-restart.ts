import { app } from 'electron';
import { nextSoftRebootSample, SOFT_REBOOT_RAM_BYTES } from './memory-restart-policy';

const CHECK_MS = 60 * 1000;
/** Let startup, the first refresh, and VPN connect finish. */
const STARTUP_GRACE_MS = 15 * 60 * 1000;

/** RAM pinned by every Nightfeed process (main, window, download worker, addons). */
export function totalWorkingSetBytes(): number {
  let kb = 0;
  for (const metric of app.getAppMetrics()) {
    kb += metric.memory?.workingSetSize || 0;
  }
  return kb * 1024;
}

export function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * When Nightfeed is idle and still using more than 2 GB, quit and start again.
 * app.relaunch runs the new process after this one has exited.
 */
export function startMemorySoftReboot(opts: {
  isBusy: () => string | null;
  log: (message: string) => void;
  notify?: (message: string) => void;
}): void {
  const startedAt = Date.now();
  let overCount = 0;
  let rebooting = false;
  let lastWait = '';
  const timer = setInterval(() => {
    if (rebooting) return;
    if (Date.now() - startedAt < STARTUP_GRACE_MS) return;
    let bytes = 0;
    try {
      bytes = totalWorkingSetBytes();
    } catch {
      return;
    }
    const busy = opts.isBusy();
    const sample = nextSoftRebootSample(overCount, bytes, !busy);
    overCount = sample.overCount;
    if (bytes < SOFT_REBOOT_RAM_BYTES) {
      lastWait = '';
      return;
    }
    const mb = formatMegabytes(bytes);
    if (busy) {
      if (busy !== lastWait) {
        lastWait = busy;
        opts.log(`Memory ${mb}. Soft reboot is waiting: ${busy}`);
      }
      return;
    }
    lastWait = '';
    if (!sample.reboot) return;
    rebooting = true;
    const message = `Restarting to free memory (using ${mb})`;
    opts.log(message);
    opts.notify?.(message);
    setTimeout(() => {
      const stillBusy = opts.isBusy();
      let stillBytes = bytes;
      try {
        stillBytes = totalWorkingSetBytes();
      } catch {
        // keep the earlier reading
      }
      if (stillBusy || stillBytes < SOFT_REBOOT_RAM_BYTES) {
        rebooting = false;
        overCount = 0;
        opts.log(
          stillBusy
            ? `Soft reboot cancelled: ${stillBusy}`
            : `Soft reboot cancelled: memory is ${formatMegabytes(stillBytes)}`
        );
        return;
      }
      try {
        app.relaunch();
        app.quit();
      } catch (err) {
        rebooting = false;
        overCount = 0;
        opts.log(`Soft reboot failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 1500);
  }, CHECK_MS);
  timer.unref?.();
}
