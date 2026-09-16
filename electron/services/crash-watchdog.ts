/**
 * Windows Task Scheduler watchdog: if Nightfeed exits unexpectedly
 * (lock file still present), start it again. Graceful quit removes the lock.
 */
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';

export const CRASH_WATCHDOG_ARG = '--crash-watchdog';
export const CRASH_TASK_NAME = 'NightfeedCrashRestart';

function lockPath(): string {
  return path.join(app.getPath('userData'), 'session.lock');
}

function xmlPath(): string {
  return path.join(app.getPath('userData'), 'nightfeed-crash-task.xml');
}

export function isCrashWatchdogArg(): boolean {
  return process.argv.includes(CRASH_WATCHDOG_ARG);
}

export function writeSessionLock(): void {
  try {
    fs.writeFileSync(lockPath(), String(process.pid), 'utf8');
  } catch {
    // ignore
  }
}

export function clearSessionLock(): void {
  try {
    fs.unlinkSync(lockPath());
  } catch {
    // ignore
  }
}

function pidAlive(pid: number): boolean {
  if (!pid || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnNightfeed(): void {
  const exe = process.execPath;
  const args = app.isPackaged ? [] : [path.join(app.getAppPath(), '.')];
  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    cwd: app.isPackaged ? path.dirname(exe) : process.cwd(),
    windowsHide: false,
  });
  child.unref();
}

/** Short-lived: no window. Exit 0 always so the scheduled task stays healthy. */
export function runCrashWatchdog(): void {
  try {
    const lock = lockPath();
    if (!fs.existsSync(lock)) return;
    const pid = parseInt(fs.readFileSync(lock, 'utf8').trim(), 10);
    if (pidAlive(pid)) return;
    spawnNightfeed();
  } catch {
    // ignore
  }
}

function taskXml(): string {
  const exe = process.execPath;
  const args = CRASH_WATCHDOG_ARG;
  const cwd = app.isPackaged ? path.dirname(exe) : process.cwd();
  const user = process.env.USERNAME || os.userInfo().username;
  const domain = process.env.USERDOMAIN || '';
  const userId = domain && domain !== user ? `${domain}\\${user}` : user;
  const cmd = exe.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const work = cwd.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const uid = userId.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Restart Nightfeed if it closed unexpectedly. Disable from Nightfeed Settings.</Description>
    <URI>\\${CRASH_TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Delay>PT15S</Delay>
      <Repetition>
        <Interval>PT1M</Interval>
        <Duration>P3650D</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${uid}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT2M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${cmd}</Command>
      <Arguments>${args}</Arguments>
      <WorkingDirectory>${work}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export function applyCrashRestartTask(enabled: boolean): { ok: boolean; message: string } {
  if (process.platform !== 'win32') {
    return { ok: false, message: 'Task Scheduler is Windows-only' };
  }
  if (!enabled) {
    try {
      execFileSync('schtasks', ['/Delete', '/TN', CRASH_TASK_NAME, '/F'], {
        windowsHide: true,
        timeout: 15000,
        stdio: 'ignore',
      });
    } catch {
      // already gone
    }
    return { ok: true, message: 'Watchdog task removed' };
  }
  try {
    const xml = taskXml();
    const file = xmlPath();
    fs.writeFileSync(file, `\ufeff${xml}`, { encoding: 'utf16le' });
    execFileSync('schtasks', ['/Create', '/TN', CRASH_TASK_NAME, '/XML', file, '/F'], {
      windowsHide: true,
      timeout: 20000,
    });
    return { ok: true, message: `Task “${CRASH_TASK_NAME}” registered (checks every minute)` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: msg };
  }
}
