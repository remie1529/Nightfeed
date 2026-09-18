/**
 * Windows Task Scheduler watchdog: if Nightfeed exits unexpectedly
 * (lock file still present), start it again. Graceful quit removes the lock.
 *
 * Registration must work without elevation: current-user InteractiveToken,
 * LeastPrivilege, LogonTrigger scoped to this user (not “any user” / SYSTEM).
 */
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';

export const CRASH_WATCHDOG_ARG = '--crash-watchdog';
export const CRASH_TASK_NAME = 'NightfeedCrashRestart';

const ACCESS_DENIED_HINT =
  'Access denied registering the crash-restart task. Run Nightfeed as your normal Windows user (not blocked/elevated-only), then turn the setting on again. If Windows still asks for admin, accept UAC once so the task can be created — after that it runs as your user with limited rights (no SYSTEM, highest privileges off).';

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

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Current Windows account for InteractiveToken tasks (no SYSTEM). */
function currentUserId(): string {
  const user = (process.env.USERNAME || os.userInfo().username || '').trim();
  const domain = (process.env.USERDOMAIN || '').trim();
  if (domain && user && domain.toLowerCase() !== user.toLowerCase()) {
    return `${domain}\\${user}`;
  }
  return user;
}

function watchdogCommandLine(): { exe: string; args: string; cwd: string; tr: string } {
  const exe = process.execPath;
  const args = CRASH_WATCHDOG_ARG;
  const cwd = app.isPackaged ? path.dirname(exe) : process.cwd();
  // schtasks /TR wants a single command string; quote exe when it has spaces
  const tr = /\s/.test(exe) ? `"${exe}" ${args}` : `${exe} ${args}`;
  return { exe, args, cwd, tr };
}

/**
 * Prefer XML: logon trigger for *this* user only (UserId on trigger is required —
 * without it the task is “any user logon” and schtasks /Create needs admin → Access denied).
 * Principal: InteractiveToken, LeastPrivilege, current user (not SYSTEM / HighestAvailable).
 */
function taskXml(): string {
  const { exe, args, cwd } = watchdogCommandLine();
  const userId = currentUserId();
  const cmd = xmlEscape(exe);
  const work = xmlEscape(cwd);
  // Empty UserId is valid for current-user InteractiveToken; still set it when known.
  const uidXml = userId ? `<UserId>${xmlEscape(userId)}</UserId>` : '';
  // LogonTrigger MUST include UserId for non-elevated registration.
  const triggerUserXml = userId
    ? `<UserId>${xmlEscape(userId)}</UserId>`
    : '';
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Restart Nightfeed if it closed unexpectedly. Disable from Nightfeed Settings.</Description>
    <URI>\\${CRASH_TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      ${triggerUserXml}
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
      ${uidXml}
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

function schtasks(args: string[], timeoutMs = 20000): string {
  return execFileSync('schtasks', args, {
    windowsHide: true,
    timeout: timeoutMs,
    encoding: 'utf8',
  });
}

function deleteCrashTask(): void {
  try {
    schtasks(['/Delete', '/TN', CRASH_TASK_NAME, '/F'], 15000);
  } catch {
    // already gone or never registered
  }
  try {
    const file = xmlPath();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    // ignore
  }
}

function isAccessDenied(msg: string): boolean {
  return /access is denied|access denied|0x80070005|ERROR:\s*Access/i.test(msg);
}

function formatError(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err) {
    const stderr = String((err as { stderr?: Buffer | string }).stderr || '').trim();
    if (stderr) return stderr;
  }
  if (err instanceof Error) {
    // execFileSync often puts stdout/stderr on the message
    return err.message;
  }
  return String(err);
}

function tryRegisterViaXml(): void {
  const xml = taskXml();
  const file = xmlPath();
  fs.writeFileSync(file, `\ufeff${xml}`, { encoding: 'utf16le' });
  schtasks(['/Create', '/TN', CRASH_TASK_NAME, '/XML', file, '/F']);
}

/**
 * Non-XML fallbacks: limited rights, current user (omit /RU so schtasks uses the caller).
 * Prefer minute schedule so the lock file is polled without needing a logon trigger XML.
 */
function tryRegisterViaCli(): void {
  const { tr } = watchdogCommandLine();
  const user = currentUserId();
  const attempts: string[][] = [
    // Every minute, limited, current user
    ['/Create', '/TN', CRASH_TASK_NAME, '/TR', tr, '/SC', 'MINUTE', '/MO', '1', '/RL', 'LIMITED', '/F'],
    // Explicit /RU current user
    ...(user
      ? [
          [
            '/Create',
            '/TN',
            CRASH_TASK_NAME,
            '/TR',
            tr,
            '/SC',
            'MINUTE',
            '/MO',
            '1',
            '/RL',
            'LIMITED',
            '/RU',
            user,
            '/F',
          ],
        ]
      : []),
    // ONLOGON limited (runs at logon; less frequent than minute poll but no admin)
    ['/Create', '/TN', CRASH_TASK_NAME, '/TR', tr, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F'],
    ...(user
      ? [
          [
            '/Create',
            '/TN',
            CRASH_TASK_NAME,
            '/TR',
            tr,
            '/SC',
            'ONLOGON',
            '/RL',
            'LIMITED',
            '/RU',
            user,
            '/F',
          ],
        ]
      : []),
  ];

  let lastErr: unknown;
  for (const args of attempts) {
    try {
      // Remove any partial task from a previous attempt before retrying
      deleteCrashTask();
      schtasks(args);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function applyCrashRestartTask(enabled: boolean): { ok: boolean; message: string } {
  if (process.platform !== 'win32') {
    return { ok: false, message: 'Task Scheduler is Windows-only' };
  }
  if (!enabled) {
    deleteCrashTask();
    return { ok: true, message: 'Watchdog task removed' };
  }

  // Drop any old/broken registration first so we never leave a half-registered task
  deleteCrashTask();

  const errors: string[] = [];
  try {
    tryRegisterViaXml();
    return { ok: true, message: `Task “${CRASH_TASK_NAME}” registered (checks every minute)` };
  } catch (err) {
    errors.push(`XML: ${formatError(err)}`);
  }

  try {
    tryRegisterViaCli();
    return {
      ok: true,
      message: `Task “${CRASH_TASK_NAME}” registered via schtasks (limited, current user)`,
    };
  } catch (err) {
    errors.push(`CLI: ${formatError(err)}`);
  }

  // Ensure nothing half-registered remains
  deleteCrashTask();

  const combined = errors.join(' | ');
  if (errors.some(isAccessDenied) || isAccessDenied(combined)) {
    return { ok: false, message: `${ACCESS_DENIED_HINT} (${combined})` };
  }
  return { ok: false, message: combined };
}
