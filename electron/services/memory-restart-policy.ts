/** Whole-app RAM above this starts a soft reboot, once the app is idle. */
export const SOFT_REBOOT_RAM_BYTES = 2 * 1024 * 1024 * 1024;

/** Minutes the app must stay over the limit and idle before restarting. */
export const SOFT_REBOOT_SUSTAIN = 2;

export function nextSoftRebootSample(
  overCount: number,
  bytes: number,
  idle: boolean
): { overCount: number; reboot: boolean } {
  if (!idle || bytes < SOFT_REBOOT_RAM_BYTES) return { overCount: 0, reboot: false };
  const next = overCount + 1;
  return { overCount: next, reboot: next >= SOFT_REBOOT_SUSTAIN };
}
