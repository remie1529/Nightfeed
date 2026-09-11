/**
 * OpenVPN helper for Windows Electron — spawn user-provided .ovpn,
 * prefer route-nopull (no full-system default route), expose TUN/TAP IP
 * so WebTorrent can bind torrent sockets to the VPN interface only.
 *
 * Does NOT ship openvpn.exe (GPL). Detects a local install.
 * TAP/TUN needs elevation: prefer OpenVPN Interactive Service, else UAC.
 * Never logs the VPN password.
 */
import { ChildProcessWithoutNullStreams, execFile, execFileSync, spawn } from 'child_process';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';
import { app } from 'electron';

export type VpnConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';
export type VpnLaunchMethod = 'direct' | 'interactive-service' | 'elevated' | null;

export interface VpnStatus {
  enabled: boolean;
  state: VpnConnectionState;
  message: string;
  openvpnFound: boolean;
  openvpnPath: string | null;
  configPath: string | null;
  configName: string | null;
  bindAddress: string | null;
  bindIfIndex: number | null;
  requireForTorrents: boolean;
  usernameSet: boolean;
  /** True when we asked openvpn for route-nopull (torrent-only intent). */
  routeNopull: boolean;
  lastError: string | null;
  launchMethod: VpnLaunchMethod;
  /** True when torrents are blocked because VPN is required and not connected. */
  killSwitch: boolean;
}

const COMMON_OPENVPN_PATHS = [
  'C:\\Program Files\\OpenVPN\\bin\\openvpn.exe',
  'C:\\Program Files (x86)\\OpenVPN\\bin\\openvpn.exe',
  'C:\\Program Files\\OpenVPN Connect\\OpenVPNConnect.exe',
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'OpenVPN', 'bin', 'openvpn.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'OpenVPN', 'bin', 'openvpn.exe'),
];

const OVPN_FILE_DIRECTIVES = [
  'ca',
  'cert',
  'key',
  'pkcs12',
  'dh',
  'extra-certs',
  'tls-auth',
  'tls-crypt',
  'tls-crypt-v2',
  'secret',
  'crl-verify',
  'auth-user-pass',
];

function vpnDir(): string {
  return path.join(app.getPath('userData'), 'vpn');
}

function authFilePath(): string {
  return path.join(vpnDir(), 'auth-user-pass.txt');
}

function storedConfigPath(): string {
  return path.join(vpnDir(), 'client.ovpn');
}

function logFilePath(): string {
  return path.join(vpnDir(), 'ovpn.log');
}

function pidFilePath(): string {
  return path.join(vpnDir(), 'openvpn.pid');
}

function mgmtPwPath(): string {
  return path.join(vpnDir(), 'mgmt.pw');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function whichSync(cmd: string): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
    });
    const first = String(out)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && !s.toLowerCase().includes('openvpnconnect'));
    return first || null;
  } catch {
    return null;
  }
}

/** Prefer classic openvpn.exe CLI (not OpenVPN Connect GUI). */
export async function detectOpenVpn(): Promise<{ found: boolean; path: string | null }> {
  const fromPath = whichSync('openvpn');
  if (fromPath && (await pathExists(fromPath)) && /openvpn\.exe$/i.test(fromPath)) {
    return { found: true, path: fromPath };
  }
  for (const candidate of COMMON_OPENVPN_PATHS) {
    if (!candidate) continue;
    if (/OpenVPNConnect\.exe$/i.test(candidate)) continue;
    if (await pathExists(candidate)) return { found: true, path: candidate };
  }
  return { found: false, path: null };
}

function parseVpnGateway(chunk: string): string | null {
  const patterns = [
    /route-gateway\s+(\d{1,3}(?:\.\d{1,3}){3})/i,
    /PUSH_REPLY.*route-gateway\s+(\d{1,3}(?:\.\d{1,3}){3})/i,
    /ifconfig\s+\d{1,3}(?:\.\d{1,3}){3}\s+(\d{1,3}(?:\.\d{1,3}){3})/i,
  ];
  for (const re of patterns) {
    const m = chunk.match(re);
    if (m?.[1] && !m[1].startsWith('127.') && m[1] !== '0.0.0.0') return m[1];
  }
  return null;
}

function parseIfIndexFromLog(chunk: string): number | null {
  const patterns = [
    /ARP Flush on interface \[(\d+)\]/i,
    /IPv4 MTU set to \d+ on interface (\d+)/i,
    /interface \[(\d+)\] \{[0-9A-F-]+\}/i,
  ];
  for (const re of patterns) {
    const m = chunk.match(re);
    if (m?.[1]) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

function windowsIfIndexForIp(ip: string): number | null {
  if (process.platform !== 'win32' || !ip) return null;
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-NetIPAddress -AddressFamily IPv4 -IPAddress '${ip.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Select-Object -First 1).InterfaceIndex`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 }
    );
    const n = parseInt(String(out).trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function parseIpFromLog(chunk: string): string | null {
  const patterns = [
    /net_addr_v4_add:\s*(\d{1,3}(?:\.\d{1,3}){3})\//i,
    /ip-win32:\s*(?:.+?)\s+(\d{1,3}(?:\.\d{1,3}){3})/i,
    /(?:TUN\/TAP|tap-windows).*?(\d{1,3}(?:\.\d{1,3}){3})/i,
    /ifconfig\s+(\d{1,3}(?:\.\d{1,3}){3})\s+/i,
    /PUSH:.*ifconfig\s+(\d{1,3}(?:\.\d{1,3}){3})/i,
    /CONNECTED,SUCCESS,(\d{1,3}(?:\.\d{1,3}){3})/i,
    /local\s+IPv4:\s*(\d{1,3}(?:\.\d{1,3}){3})/i,
  ];
  for (const re of patterns) {
    const m = chunk.match(re);
    if (m?.[1] && !m[1].startsWith('127.') && m[1] !== '0.0.0.0') return m[1];
  }
  return null;
}

function guessVpnInterfaceIp(before: Set<string>): string | null {
  const ifaces = os.networkInterfaces();
  const candidates: string[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list) continue;
    const n = name.toLowerCase();
    const looksVpn =
      n.includes('tun') ||
      n.includes('tap') ||
      n.includes('openvpn') ||
      n.includes('wintun') ||
      n.includes('ovpn') ||
      n.includes('dco') ||
      n.includes('data channel');
    for (const entry of list) {
      if (entry.family !== 'IPv4' && (entry.family as unknown) !== 4) continue;
      if (entry.internal) continue;
      if (before.has(entry.address)) continue;
      if (looksVpn) return entry.address;
      if (
        entry.address.startsWith('10.') ||
        entry.address.startsWith('100.') ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(entry.address)
      ) {
        candidates.push(entry.address);
      }
    }
  }
  return candidates[0] || null;
}

function parseOvpnFileRefs(text: string): string[] {
  const refs: string[] = [];
  const dirRe = new RegExp(`^(${OVPN_FILE_DIRECTIVES.join('|')})(?:\\s+(.+))?$`, 'i');
  let inline = false;
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (/^<[a-z0-9_-]+>$/i.test(line)) {
      inline = true;
      continue;
    }
    if (/^<\/[a-z0-9_-]+>$/i.test(line)) {
      inline = false;
      continue;
    }
    if (inline) continue;
    const m = line.match(dirRe);
    if (!m?.[2]) continue;
    const rest = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    const file = rest.split(/\s+/)[0];
    if (!file || file.toLowerCase() === 'stdin') continue;
    refs.push(file);
  }
  return [...new Set(refs)];
}

function isSafeRelative(rel: string): boolean {
  if (!rel || path.isAbsolute(rel)) return false;
  const norm = path.normalize(rel);
  const parts = norm.split(/[/\\]/);
  return !parts.includes('..');
}

/**
 * Strip full-tunnel directives from a .ovpn. Many providers put
 * `redirect-gateway def1` in the client file (not only as a pushed option);
 * that adds 0.0.0.0/1 + 128.0.0.0/1 which beat any LAN default route.
 */
function sanitizeOvpnForSplitTunnel(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith(';')) return line;
      if (/^redirect-gateway(\s|$)/i.test(t)) return `# nightfeed-split ${line}`;
      if (/^redirect-private(\s|$)/i.test(t)) return `# nightfeed-split ${line}`;
      if (/^redirect-gateway-ipv6(\s|$)/i.test(t)) return `# nightfeed-split ${line}`;
      if (/^block-outside-dns(\s|$)/i.test(t)) return `# nightfeed-split ${line}`;
      if (/^route\s+0\.0\.0\.0(\s|$)/i.test(t)) return `# nightfeed-split ${line}`;
      if (/^route\s+128\.0\.0\.0(\s|$)/i.test(t)) return `# nightfeed-split ${line}`;
      if (/^route-ipv6\s+::\/0/i.test(t)) return `# nightfeed-split ${line}`;
      if (/^dhcp-option\s+(DNS|DNS6|DOMAIN|DOMAIN-SEARCH|DHCP6)\b/i.test(t)) {
        return `# nightfeed-split ${line}`;
      }
      return line;
    })
    .join('\n');
}

async function writeSanitizedConfig(): Promise<void> {
  const p = storedConfigPath();
  if (!(await pathExists(p))) return;
  const raw = await fsp.readFile(p, 'utf8');
  const sanitized = sanitizeOvpnForSplitTunnel(raw);
  if (sanitized !== raw) await fsp.writeFile(p, sanitized, 'utf8');
}

const BENIGN_OPENVPN_LINE =
  /allow-compression|data channel offload|management on a TCP port WITHOUT passwords|library versions:|Windows version:|OpenVPN \d|DCO version:|built on |git:v|Originally developed|Copyright|NOTE:/i;

export function summarizeOpenVpnLog(log: string): string | null {
  if (!log.trim()) return null;
  const lines = log
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const interesting = lines.filter((l) => {
    if (BENIGN_OPENVPN_LINE.test(l)) return false;
    return /ERROR:|AUTH_FAILED|Options error|Cannot open TUN|All TAP-Windows|Need TAP|ACCESS_DENIED|CreateFile failed on TAP|Failed to parse|No such file or directory|PERMISSION_DENIED|FlushIpNetTable|Requires administrative|TLS Error|RESOLVE: Cannot|Exiting due|fatal error|AUTH: Received control message.*AUTH_FAILED/i.test(
      l
    );
  });
  if (!interesting.length) return null;
  const blob = interesting.slice(-4).join(' · ').slice(0, 700);
  if (/AUTH_FAILED|auth.?fail/i.test(blob)) return 'Authentication failed (check username/password)';
  if (/No such file or directory|cannot open.*\.(crt|key|pem|p12)|Options error: --(ca|cert|key|pkcs12)/i.test(blob)) {
    return `OpenVPN config is missing a certificate/key file next to the .ovpn. ${blob}`;
  }
  if (/Cannot open TUN\/TAP|CreateFile failed on TAP|All TAP-Windows|Need TAP|Requires administrative|ACCESS_DENIED|PERMISSION_DENIED/i.test(
    blob
  )) {
    return `OpenVPN could not open TAP/DCO (needs Administrator / Interactive Service, and OpenVPN Community with TAP or DCO). ${blob}`;
  }
  return blob;
}

function isProcessElevated(): boolean {
  if (process.platform !== 'win32') return typeof process.getuid === 'function' && process.getuid() === 0;
  try {
    execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true, timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'EPERM';
  }
}

function quoteWinArg(s: string): string {
  if (!/[\s"]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function encodeStartupMessage(cwd: string, options: string, stdin: string): Buffer {
  const parts = [cwd, options, stdin].map((s) => {
    const body = Buffer.from(s, 'utf16le');
    const out = Buffer.alloc(body.length + 2);
    body.copy(out);
    return out;
  });
  return Buffer.concat(parts);
}

function parseServiceReply(text: string): { pid?: number; error?: string } {
  const t = text.replace(/\u0000/g, '').trim();
  const lines = t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return { error: 'OpenVPN Interactive Service returned an empty reply' };
  const ok = lines[0] === '0x00000000' || /process id/i.test(lines.join(' '));
  if (ok && lines[1]) {
    const pid = parseInt(lines[1].replace(/^0x/i, ''), 16);
    if (Number.isFinite(pid) && pid > 0) return { pid };
  }
  const msg = lines.slice(1).join(' — ') || t.slice(0, 400);
  return { error: msg };
}

function tryStartInteractiveService(): void {
  try {
    execFileSync('sc.exe', ['start', 'OpenVPNServiceInteractive'], {
      windowsHide: true,
      timeout: 8000,
      stdio: 'ignore',
    });
  } catch {
    // already running, missing, or needs admin — caller falls through
  }
}

function startViaInteractiveServiceFs(cwd: string, options: string): number {
  const pipePath = '\\\\.\\pipe\\openvpn\\service';
  const fd = fs.openSync(pipePath, 'r+');
  try {
    const payload = encodeStartupMessage(cwd, options, '');
    fs.writeSync(fd, payload);
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    const text = buf.slice(0, n).toString('utf16le');
    const parsed = parseServiceReply(text);
    if (parsed.pid) return parsed.pid;
    throw new Error(parsed.error || 'OpenVPN Interactive Service failed');
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

function execFileAsync(file: string, args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function startViaInteractiveServicePs(cwd: string, options: string, workDir: string): Promise<number> {
  const replyPath = path.join(workDir, 'service-reply.txt');
  const ps1 = path.join(workDir, 'iservice.ps1');
  const script = `
param([string]$Cwd,[string]$Options,[string]$Reply)
$ErrorActionPreference = 'Stop'
$pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'openvpn\\service', [System.IO.Pipes.PipeDirection]::InOut)
$pipe.Connect(4000)
try { $pipe.ReadMode = [System.IO.Pipes.PipeTransmissionMode]::Message } catch {}
$enc = New-Object System.Text.UnicodeEncoding $false, $false
function Z([string]$s) {
  $b = $enc.GetBytes($s)
  $o = New-Object byte[] ($b.Length + 2)
  [Buffer]::BlockCopy($b, 0, $o, 0, $b.Length)
  return ,$o
}
$parts = @((Z $Cwd), (Z $Options), (Z ''))
$len = 0; foreach ($p in $parts) { $len += $p.Length }
$msg = New-Object byte[] $len
$off = 0
foreach ($p in $parts) { [Buffer]::BlockCopy($p, 0, $msg, $off, $p.Length); $off += $p.Length }
$pipe.Write($msg, 0, $msg.Length)
$pipe.Flush()
$buf = New-Object byte[] 8192
$n = $pipe.Read($buf, 0, $buf.Length)
$text = $enc.GetString($buf, 0, $n)
Set-Content -Path $Reply -Value $text -Encoding UTF8
$pipe.Dispose()
`;
  fs.writeFileSync(ps1, script, 'utf8');
  try {
    fs.unlinkSync(replyPath);
  } catch {
    // ignore
  }
  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Cwd', cwd, '-Options', options, '-Reply', replyPath],
    15000
  );
  const text = fs.existsSync(replyPath) ? fs.readFileSync(replyPath, 'utf8') : '';
  const parsed = parseServiceReply(text);
  if (parsed.pid) return parsed.pid;
  throw new Error(parsed.error || 'OpenVPN Interactive Service failed');
}

async function startViaInteractiveService(cwd: string, options: string, workDir: string): Promise<number> {
  tryStartInteractiveService();
  try {
    return startViaInteractiveServiceFs(cwd, options);
  } catch {
    return startViaInteractiveServicePs(cwd, options, workDir);
  }
}

async function startElevated(exe: string, args: string[], workDir: string): Promise<number> {
  const pidPath = path.join(workDir, 'elevate.pid');
  const argPath = path.join(workDir, 'elevate-args.json');
  const ps1 = path.join(workDir, 'elevate.ps1');
  const script = `
param([string]$Exe,[string]$ArgFile,[string]$PidFile,[string]$WorkDir)
$ErrorActionPreference = 'Stop'
$argList = @(Get-Content -Raw -Encoding UTF8 $ArgFile | ConvertFrom-Json)
try {
  $p = Start-Process -FilePath $Exe -ArgumentList $argList -WorkingDirectory $WorkDir -Verb RunAs -WindowStyle Hidden -PassThru
  if (-not $p) { throw 'Administrator approval was cancelled' }
  Set-Content -Path $PidFile -Value ([string]$p.Id) -Encoding ASCII
} catch {
  Set-Content -Path $PidFile -Value ("ERROR:" + $_.Exception.Message) -Encoding UTF8
  exit 1
}
`;
  fs.writeFileSync(ps1, script, 'utf8');
  fs.writeFileSync(argPath, JSON.stringify(args), 'utf8');
  try {
    fs.unlinkSync(pidPath);
  } catch {
    // ignore
  }
  try {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        ps1,
        '-Exe',
        exe,
        '-ArgFile',
        argPath,
        '-PidFile',
        pidPath,
        '-WorkDir',
        workDir,
      ],
      120000
    );
  } catch {
    // script writes ERROR: on UAC cancel
  }
  if (!fs.existsSync(pidPath)) {
    throw new Error('Administrator approval was cancelled or OpenVPN did not start');
  }
  const raw = fs.readFileSync(pidPath, 'utf8').trim();
  if (raw.startsWith('ERROR:')) {
    const msg = raw.slice(6).trim();
    if (/cancel|1223/i.test(msg)) {
      throw new Error(
        'Administrator approval was cancelled. TAP/TUN needs a UAC prompt, or start OpenVPN Interactive Service.'
      );
    }
    throw new Error(msg || 'Failed to start OpenVPN elevated');
  }
  const pid = parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error('Elevated OpenVPN started but no PID was returned');
  }
  return pid;
}

const SPLIT_TASK_NAME = 'NightfeedSplitTunnel';
let splitElevateInFlight = false;

function splitIpPath(): string {
  return path.join(vpnDir(), 'split-ip.txt');
}

function splitScriptPath(): string {
  return path.join(vpnDir(), 'split-tunnel.ps1');
}

function writeSplitTunnelScript(): void {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$req = Join-Path $dir 'split-ip.txt'
if (-not (Test-Path $req)) { exit 0 }
$lines = @(Get-Content -Path $req -Encoding UTF8)
$ip = ([string]$lines[0]).Trim()
$gw = ''
if ($lines.Count -gt 1) { $gw = ([string]$lines[1]).Trim() }
if (-not $ip) { exit 0 }
$addr = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -eq $ip } | Select-Object -First 1
if (-not $addr) { exit 0 }
$if = $addr.InterfaceIndex
# VPN adapter must lose the system default (Plex / browser stay on LAN) but still
# have a default so sockets bound to the TUN IP can reach the internet.
Set-NetIPInterface -InterfaceIndex $if -AddressFamily IPv4 -InterfaceMetric 4500 | Out-Null
foreach ($pfx in @('0.0.0.0/1','128.0.0.0/1','::/1','8000::/1')) {
  Get-NetRoute -InterfaceIndex $if -DestinationPrefix $pfx | Remove-NetRoute -Confirm:$false
}
$def = Get-NetRoute -InterfaceIndex $if -DestinationPrefix '0.0.0.0/0' | Select-Object -First 1
if ($def) {
  Set-NetRoute -InterfaceIndex $if -DestinationPrefix '0.0.0.0/0' -RouteMetric 5000 | Out-Null
} else {
  $hop = $gw
  if (-not $hop -or $hop -eq '0.0.0.0') {
    $hop = (Get-NetRoute -InterfaceIndex $if -AddressFamily IPv4 |
      Where-Object { $_.NextHop -ne '0.0.0.0' -and $_.DestinationPrefix -notmatch '^224\\.' } |
      Select-Object -First 1).NextHop
  }
  if ($hop) {
    New-NetRoute -InterfaceIndex $if -DestinationPrefix '0.0.0.0/0' -NextHop $hop -RouteMetric 5000 | Out-Null
  }
}
# Windows weak-host send would take TUN-bound torrent packets out the LAN default
# (wrong source IP → seeders never connect). Force LAN NICs to strong-host.
Get-NetRoute -DestinationPrefix '0.0.0.0/0' -AddressFamily IPv4 |
  Where-Object { $_.InterfaceIndex -ne $if } |
  ForEach-Object {
    Set-NetIPInterface -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4 -WeakHostSend Disabled | Out-Null
  }
Set-NetIPInterface -InterfaceIndex $if -AddressFamily IPv4 -WeakHostSend Enabled | Out-Null
`;
  fs.writeFileSync(splitScriptPath(), script, 'utf8');
}

function splitTaskExists(): boolean {
  try {
    execFileSync('schtasks', ['/Query', '/TN', SPLIT_TASK_NAME], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

function runSplitTask(): void {
  execFile('schtasks', ['/Run', '/TN', SPLIT_TASK_NAME], { windowsHide: true, timeout: 8000 }, () => undefined);
}

async function runElevatedAndWait(exe: string, args: string[], workDir: string): Promise<void> {
  const pidPath = path.join(workDir, 'elevate-split.pid');
  const argPath = path.join(workDir, 'elevate-split-args.json');
  const ps1 = path.join(workDir, 'elevate-split.ps1');
  const script = `
param([string]$Exe,[string]$ArgFile,[string]$PidFile,[string]$WorkDir)
$ErrorActionPreference = 'Stop'
$argList = @(Get-Content -Raw -Encoding UTF8 $ArgFile | ConvertFrom-Json)
try {
  $p = Start-Process -FilePath $Exe -ArgumentList $argList -WorkingDirectory $WorkDir -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  if (-not $p) { throw 'Administrator approval was cancelled' }
  Set-Content -Path $PidFile -Value ("EXIT:" + [string]$p.ExitCode) -Encoding ASCII
} catch {
  Set-Content -Path $PidFile -Value ("ERROR:" + $_.Exception.Message) -Encoding UTF8
  exit 1
}
`;
  fs.writeFileSync(ps1, script, 'utf8');
  fs.writeFileSync(argPath, JSON.stringify(args), 'utf8');
  try {
    fs.unlinkSync(pidPath);
  } catch {
    // ignore
  }
  try {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        ps1,
        '-Exe',
        exe,
        '-ArgFile',
        argPath,
        '-PidFile',
        pidPath,
        '-WorkDir',
        workDir,
      ],
      120000
    );
  } catch {
    // script writes ERROR: on UAC cancel
  }
}

async function ensureSplitTaskAndRun(): Promise<void> {
  const workDir = vpnDir();
  const ps1 = splitScriptPath();
  const install = path.join(workDir, 'install-split.ps1');
  const installScript = `
$ps1 = '${ps1.replace(/'/g, "''")}'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ps1
$task = '${SPLIT_TASK_NAME}'
$arg = '-NoProfile -ExecutionPolicy Bypass -File "' + $ps1 + '"'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings -Force | Out-Null
`;
  fs.writeFileSync(install, installScript, 'utf8');
  if (isProcessElevated()) {
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', install],
      30000
    );
    return;
  }
  await runElevatedAndWait(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', install],
    workDir
  );
}

/**
 * Keep the VPN adapter from winning the system default route (Plex / port-forward),
 * but give TUN-bound torrent sockets a path out the tunnel.
 */
function applyWindowsSplitTunnel(vpnIp: string, gateway?: string | null): void {
  if (process.platform !== 'win32' || !vpnIp) return;
  try {
    fs.mkdirSync(vpnDir(), { recursive: true });
    fs.writeFileSync(splitIpPath(), `${vpnIp}\n${gateway || ''}\n`, 'utf8');
    writeSplitTunnelScript();
  } catch {
    return;
  }
  execFile(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', splitScriptPath()],
    { windowsHide: true, timeout: 15000 },
    () => undefined
  );
  if (splitTaskExists()) {
    runSplitTask();
    return;
  }
  if (splitElevateInFlight) return;
  splitElevateInFlight = true;
  void ensureSplitTaskAndRun()
    .catch(() => undefined)
    .finally(() => {
      splitElevateInFlight = false;
    });
}

function getFreeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function managementSignal(port: number, password: string | null, command = 'signal SIGTERM'): Promise<void> {
  return new Promise((resolve) => {
    let sent = false;
    const sock = net.connect({ host: '127.0.0.1', port });
    const finish = () => {
      try {
        sock.end();
      } catch {
        // ignore
      }
      resolve();
    };
    sock.setTimeout(2000, finish);
    sock.on('error', () => resolve());
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      if (/ENTER PASSWORD:/i.test(chunk) && password && !sent) {
        sock.write(`${password}\r\n`);
        return;
      }
      if (!sent && (/>INFO:/i.test(chunk) || /SUCCESS/i.test(chunk))) {
        sent = true;
        sock.write(`${command}\r\n`);
        setTimeout(finish, 250);
      }
    });
    sock.on('connect', () => {
      if (!password) {
        sent = true;
        sock.write(`${command}\r\n`);
        setTimeout(finish, 250);
      }
    });
  });
}

export class VpnManager extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ownedPid: number | null = null;
  private state: VpnConnectionState = 'disconnected';
  private message = 'Disconnected';
  private lastError: string | null = null;
  private launchMethod: VpnLaunchMethod = null;
  private openvpnPath: string | null = null;
  private openvpnFound = false;
  private bindAddress: string | null = null;
  private bindIfIndex: number | null = null;
  private logBuffer = '';
  private logOffset = 0;
  private ipsBeforeConnect = new Set<string>();
  private pollTimer: NodeJS.Timeout | null = null;
  private logTimer: NodeJS.Timeout | null = null;
  private pidTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private splitFixTimers: NodeJS.Timeout[] = [];
  private mgmtPort: number | null = null;
  private mgmtPassword: string | null = null;
  private mgmtSocket: net.Socket | null = null;
  private mgmtTimer: NodeJS.Timeout | null = null;
  private mgmtBuf = '';
  private mgmtAuthed = false;
  private mgmtPasswordSent = false;
  private intentionalStop = false;
  private generation = 0;

  async refreshDetect(): Promise<void> {
    const d = await detectOpenVpn();
    this.openvpnFound = d.found;
    this.openvpnPath = d.path;
  }

  getStatus(settings: {
    vpnEnabled?: boolean;
    vpnConfigPath?: string;
    vpnConfigName?: string;
    vpnUsername?: string;
    vpnRequireForTorrents?: boolean;
  }): VpnStatus {
    return {
      enabled: !!settings.vpnEnabled,
      state: this.state,
      message: this.message,
      openvpnFound: this.openvpnFound,
      openvpnPath: this.openvpnPath,
      configPath: settings.vpnConfigPath || null,
      configName: settings.vpnConfigName || null,
      bindAddress: this.bindAddress,
      bindIfIndex: this.bindIfIndex,
      requireForTorrents: !!settings.vpnRequireForTorrents,
      usernameSet: !!(settings.vpnUsername && settings.vpnUsername.trim()),
      routeNopull: true,
      lastError: this.lastError,
      launchMethod: this.launchMethod,
      killSwitch: !!(settings.vpnEnabled && settings.vpnRequireForTorrents && this.state !== 'connected'),
    };
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  getBindAddress(): string | null {
    return this.bindAddress;
  }

  getBindIfIndex(): number | null {
    return this.bindIfIndex;
  }

  private resolveBindIfIndex(): void {
    if (this.bindIfIndex) return;
    const fromLog = parseIfIndexFromLog(this.logBuffer);
    if (fromLog) this.bindIfIndex = fromLog;
    else if (this.bindAddress) this.bindIfIndex = windowsIfIndexForIp(this.bindAddress);
    if (this.bindIfIndex) this.emit('bind', this.bindAddress);
  }

  private setState(state: VpnConnectionState, message: string): void {
    this.state = state;
    this.message = message;
    if (state === 'error') this.lastError = message;
    this.emit('status');
  }

  private snapshotLocalIps(): Set<string> {
    const set = new Set<string>();
    for (const list of Object.values(os.networkInterfaces())) {
      if (!list) continue;
      for (const entry of list) {
        if (entry.family === 'IPv4' || (entry.family as unknown) === 4) set.add(entry.address);
      }
    }
    return set;
  }

  /** Copy .ovpn into userData/vpn (plus relative ca/cert/key files) and return stored path + display name. */
  async importConfig(sourcePath: string): Promise<{ configPath: string; configName: string; copiedSidecars: number }> {
    await fsp.mkdir(vpnDir(), { recursive: true });
    const configName = path.basename(sourcePath);
    const dest = storedConfigPath();
    const text = await fsp.readFile(sourcePath, 'utf8');
    await fsp.copyFile(sourcePath, dest);
    let copiedSidecars = 0;
    const srcDir = path.dirname(sourcePath);
    for (const rel of parseOvpnFileRefs(text)) {
      if (!isSafeRelative(rel)) continue;
      const from = path.join(srcDir, rel);
      const to = path.join(vpnDir(), rel);
      if (!(await pathExists(from))) continue;
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.copyFile(from, to);
      copiedSidecars += 1;
    }
    await writeSanitizedConfig();
    try {
      await fsp.chmod(dest, 0o600);
    } catch {
      // Windows may ignore chmod
    }
    return { configPath: dest, configName, copiedSidecars };
  }

  private async writeAuthFile(username: string, password: string): Promise<string | null> {
    if (!username.trim()) return null;
    await fsp.mkdir(vpnDir(), { recursive: true });
    const p = authFilePath();
    await fsp.writeFile(p, `${username}\n${password}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      await fsp.chmod(p, 0o600);
    } catch {
      // ignore
    }
    return p;
  }

  private clearAuthFile(): void {
    try {
      fs.unlinkSync(authFilePath());
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(mgmtPwPath());
    } catch {
      // ignore
    }
  }

  private startIfacePoll(): void {
    this.stopIfacePoll();
    let tries = 0;
    this.pollTimer = setInterval(() => {
      tries += 1;
      if (this.bindAddress || this.state === 'disconnected' || this.state === 'error') {
        this.stopIfacePoll();
        return;
      }
      const ip = guessVpnInterfaceIp(this.ipsBeforeConnect);
      if (ip) {
        this.bindAddress = ip;
        this.resolveBindIfIndex();
        this.scheduleSplitTunnelFix(ip);
        if (this.state === 'connected' || this.state === 'connecting') {
          this.setState('connected', `Connected — torrent bind ${ip}`);
        }
        this.stopIfacePoll();
        this.emit('bind', ip);
      } else if (tries > 40) {
        this.stopIfacePoll();
        if (this.state === 'connected') {
          this.setState(
            'connected',
            'Connected (VPN up) — could not detect TUN/TAP IP yet; torrent bind pending'
          );
        }
      }
    }, 500);
  }

  private stopIfacePoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private startLogTail(): void {
    this.stopLogTail();
    this.logOffset = 0;
    const tick = () => {
      try {
        const st = fs.statSync(logFilePath());
        if (st.size < this.logOffset) this.logOffset = 0;
        if (st.size > this.logOffset) {
          const len = st.size - this.logOffset;
          const buf = Buffer.alloc(len);
          const fd = fs.openSync(logFilePath(), 'r');
          fs.readSync(fd, buf, 0, len, this.logOffset);
          fs.closeSync(fd);
          this.logOffset = st.size;
          this.onLogChunk(buf.toString('utf8'));
        }
      } catch {
        // log file not created yet
      }
    };
    tick();
    this.logTimer = setInterval(tick, 300);
  }

  private stopLogTail(): void {
    if (this.logTimer) {
      clearInterval(this.logTimer);
      this.logTimer = null;
    }
  }

  private startPidPoll(): void {
    this.stopPidPoll();
    this.pidTimer = setInterval(() => {
      if (this.intentionalStop) return;
      if (this.state !== 'connecting' && this.state !== 'connected') return;
      const pid = this.ownedPid || this.child?.pid || null;
      if (pid && !pidAlive(pid)) this.onProcessExit(this.generation, 1, null);
    }, 800);
  }

  private stopPidPoll(): void {
    if (this.pidTimer) {
      clearInterval(this.pidTimer);
      this.pidTimer = null;
    }
  }

  private clearConnectTimeout(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private clearSplitFixTimers(): void {
    for (const t of this.splitFixTimers) clearTimeout(t);
    this.splitFixTimers = [];
  }

  /** Re-apply after OpenVPN finishes adding routes (def1 can appear a second later). */
  private scheduleSplitTunnelFix(ip: string): void {
    if (!ip) return;
    const gw = parseVpnGateway(this.logBuffer);
    applyWindowsSplitTunnel(ip, gw);
    this.clearSplitFixTimers();
    for (const ms of [1000, 3000, 8000]) {
      this.splitFixTimers.push(setTimeout(() => applyWindowsSplitTunnel(ip, parseVpnGateway(this.logBuffer)), ms));
    }
  }

  private stopMgmt(): void {
    if (this.mgmtTimer) {
      clearInterval(this.mgmtTimer);
      this.mgmtTimer = null;
    }
    const sock = this.mgmtSocket;
    this.mgmtSocket = null;
    this.mgmtBuf = '';
    this.mgmtAuthed = false;
    this.mgmtPasswordSent = false;
    if (sock) {
      try {
        sock.destroy();
      } catch {
        // ignore
      }
    }
  }

  private markConnected(ip?: string | null): void {
    if (this.state === 'disconnected' || this.state === 'error') return;
    if (ip && !this.bindAddress) {
      this.bindAddress = ip;
      this.emit('bind', ip);
    }
    if (!this.bindAddress) {
      const guessed = guessVpnInterfaceIp(this.ipsBeforeConnect);
      if (guessed) this.bindAddress = guessed;
    }
    this.resolveBindIfIndex();
    this.lastError = null;
    this.clearConnectTimeout();
    if (this.bindAddress) this.scheduleSplitTunnelFix(this.bindAddress);
    this.setState(
      'connected',
      this.bindAddress ? `Connected — torrent bind ${this.bindAddress}` : 'Connected — detecting TUN/TAP IP…'
    );
    if (!this.bindAddress) this.startIfacePoll();
    else this.emit('bind', this.bindAddress);
  }

  private parseMgmt(chunk: string): void {
    this.mgmtBuf = (this.mgmtBuf + chunk).slice(-20000);
    if (/ENTER PASSWORD:/i.test(this.mgmtBuf) && this.mgmtPassword && this.mgmtSocket && !this.mgmtPasswordSent) {
      this.mgmtSocket.write(`${this.mgmtPassword}\r\n`);
      this.mgmtPasswordSent = true;
      this.mgmtBuf = this.mgmtBuf.replace(/ENTER PASSWORD:.*\r?\n?/, '');
    }
    if (/>INFO:/i.test(this.mgmtBuf) && this.mgmtSocket && !this.mgmtAuthed) {
      this.mgmtAuthed = true;
      this.mgmtSocket.write('state on\r\n');
    }
    const state = this.mgmtBuf.match(/>STATE:[^,]*,CONNECTED,SUCCESS,(\d{1,3}(?:\.\d{1,3}){3})/i);
    if (state?.[1]) {
      this.markConnected(state[1]);
      return;
    }
    if (/>STATE:[^,]*,CONNECTED,/i.test(this.mgmtBuf)) {
      this.markConnected(parseIpFromLog(this.mgmtBuf));
    }
  }

  private startMgmtPoll(): void {
    this.stopMgmt();
    const port = this.mgmtPort;
    if (!port) return;
    const gen = this.generation;
    const tryConnect = () => {
      if (gen !== this.generation) return;
      if (this.mgmtSocket) return;
      if (this.state !== 'connecting' && this.state !== 'connected') return;
      const sock = net.connect({ host: '127.0.0.1', port });
      sock.setEncoding('utf8');
      sock.setTimeout(0);
      sock.on('connect', () => {
        if (gen !== this.generation) {
          sock.destroy();
          return;
        }
        this.mgmtSocket = sock;
        if (!this.mgmtPassword) {
          this.mgmtAuthed = true;
          sock.write('state on\r\n');
        }
      });
      sock.on('data', (chunk: string) => {
        if (gen !== this.generation) return;
        this.parseMgmt(chunk);
      });
      sock.on('error', () => {
        if (this.mgmtSocket === sock) this.mgmtSocket = null;
      });
      sock.on('close', () => {
        if (this.mgmtSocket === sock) {
          this.mgmtSocket = null;
          this.mgmtAuthed = false;
        }
      });
    };
    tryConnect();
    this.mgmtTimer = setInterval(tryConnect, 400);
  }

  private onLogChunk(text: string): void {
    this.logBuffer = (this.logBuffer + text).slice(-20000);
    const ip = parseIpFromLog(text) || parseIpFromLog(this.logBuffer);
    if (ip && !this.bindAddress) {
      this.bindAddress = ip;
      this.emit('bind', ip);
    }
    if (/Initialization Sequence Completed/i.test(text) || /Initialization Sequence Completed/i.test(this.logBuffer)) {
      this.markConnected(ip);
    }
    if (/AUTH_FAILED|auth.?fail/i.test(text)) {
      this.lastError = 'Authentication failed (check username/password)';
      this.setState('error', this.lastError);
    }
  }

  private onProcessExit(generation: number, code: number | null, signal: NodeJS.Signals | null): void {
    if (generation !== this.generation) return;
    if (this.intentionalStop) {
      this.child = null;
      this.ownedPid = null;
      this.stopIfacePoll();
      this.stopLogTail();
      this.stopPidPoll();
      this.stopMgmt();
      this.clearConnectTimeout();
      this.clearSplitFixTimers();
      this.clearAuthFile();
      this.bindAddress = null;
    this.bindIfIndex = null;
      this.mgmtPort = null;
      this.mgmtPassword = null;
      this.launchMethod = null;
      this.emit('bind', null);
      return;
    }
    this.child = null;
    this.ownedPid = null;
    this.stopIfacePoll();
    this.stopLogTail();
    this.stopPidPoll();
    this.stopMgmt();
    this.clearConnectTimeout();
    this.clearSplitFixTimers();
    this.clearAuthFile();
    const wasConnected = this.state === 'connected';
    const wasActive = wasConnected || this.state === 'connecting';
    this.bindAddress = null;
    this.bindIfIndex = null;
    this.mgmtPort = null;
    this.mgmtPassword = null;
    if (this.state === 'error' && /Authentication failed/i.test(this.message)) {
      this.emit('bind', null);
      this.emit('status');
      return;
    }
    if (wasActive) {
      const detail = summarizeOpenVpnLog(this.logBuffer);
      this.lastError = detail;
      const hint =
        detail ||
        (code === 1
          ? 'OpenVPN exited. Install OpenVPN Community on this PC (TAP/TUN), or approve the UAC prompt / start OpenVPN Interactive Service.'
          : `OpenVPN exited (code ${code ?? '—'}, signal ${signal ?? '—'})`);
      this.setState('disconnected', hint);
      if (wasConnected) this.emit('drop', hint);
    } else {
      this.setState('disconnected', 'Disconnected');
    }
    this.launchMethod = null;
    this.emit('bind', null);
  }

  private attachChild(child: ChildProcessWithoutNullStreams): void {
    this.child = child;
    this.ownedPid = child.pid ?? null;
    child.stdout.on('data', (buf: Buffer) => this.onLogChunk(buf.toString('utf8')));
    child.stderr.on('data', (buf: Buffer) => this.onLogChunk(buf.toString('utf8')));
    child.on('error', (err) => {
      this.child = null;
      this.ownedPid = null;
      this.bindAddress = null;
    this.bindIfIndex = null;
      this.clearAuthFile();
      this.lastError = err.message || 'Failed to start openvpn';
      this.setState('error', this.lastError);
      this.emit('bind', null);
    });
    const gen = this.generation;
    child.on('exit', (code, signal) => this.onProcessExit(gen, code, signal));
  }

  private buildArgs(hasAuth: boolean, mgmtPort: number): string[] {
    const args = [
      '--cd',
      vpnDir(),
      '--config',
      'client.ovpn',
      '--log',
      'ovpn.log',
      '--writepid',
      'openvpn.pid',
      '--management',
      '127.0.0.1',
      String(mgmtPort),
      'mgmt.pw',
      // Split tunnel: ignore full-tunnel redirect, but still pull route-gateway /
      // VPN subnet so a high-metric TUN default can be added for bound sockets.
      '--route-metric',
      '999',
      '--route-delay',
      '2',
      '--pull-filter',
      'ignore',
      'redirect-gateway',
      '--pull-filter',
      'ignore',
      'redirect-gateway-ipv6',
      '--pull-filter',
      'ignore',
      'route 0.0.0.0',
      '--pull-filter',
      'ignore',
      'route 128.0.0.0',
      '--pull-filter',
      'ignore',
      'route-ipv6',
      '--pull-filter',
      'ignore',
      'block-outside-dns',
      '--pull-filter',
      'ignore',
      'dhcp-option DNS',
      '--pull-filter',
      'ignore',
      'dhcp-option DNS6',
      // High-metric default on the TUN only — LAN keeps the real default (Plex).
      '--route',
      '0.0.0.0',
      '0.0.0.0',
      'vpn_gateway',
      '999',
      '--verb',
      '3',
    ];
    if (hasAuth) args.push('--auth-user-pass', 'auth-user-pass.txt');
    return args;
  }

  async connect(opts: { configPath: string; username?: string; password?: string }): Promise<VpnStatus> {
    await this.refreshDetect();
    const exe = this.openvpnPath;
    if (!this.openvpnFound || !exe) {
      this.lastError =
        'OpenVPN is not installed on this PC. Nightfeed starts openvpn.exe locally — a VPN on another device is not used. Install OpenVPN Community (openvpn.exe) on the same computer as Nightfeed.';
      this.setState('error', this.lastError);
      return this.getStatus({});
    }
    if (!opts.configPath || !(await pathExists(opts.configPath))) {
      this.lastError = 'No .ovpn config imported. Use Import .ovpn in Settings.';
      this.setState('error', this.lastError);
      return this.getStatus({});
    }

    await this.disconnect(false);

    this.ipsBeforeConnect = this.snapshotLocalIps();
    this.bindAddress = null;
    this.bindIfIndex = null;
    this.logBuffer = '';
    this.logOffset = 0;
    this.lastError = null;
    this.intentionalStop = false;
    this.generation += 1;
    this.launchMethod = null;
    await fsp.mkdir(vpnDir(), { recursive: true });
    try {
      await writeSanitizedConfig();
    } catch {
      // still try to connect with the stored file
    }
    try {
      fs.unlinkSync(logFilePath());
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(pidFilePath());
    } catch {
      // ignore
    }

    this.setState('connecting', 'Starting OpenVPN…');

    let authPath: string | null = null;
    try {
      authPath = await this.writeAuthFile(opts.username || '', opts.password || '');
    } catch {
      this.lastError = 'Could not write auth file in userData';
      this.setState('error', this.lastError);
      return this.getStatus({});
    }

    try {
      this.mgmtPort = await getFreeLocalPort();
    } catch {
      this.mgmtPort = 25340;
    }
    const args = this.buildArgs(!!authPath, this.mgmtPort);
    const optionsLine = args.map(quoteWinArg).join(' ');

    this.startLogTail();
    this.startIfacePoll();
    this.mgmtPassword = crypto.randomBytes(16).toString('hex');
    try {
      await fsp.writeFile(mgmtPwPath(), `${this.mgmtPassword}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      this.mgmtPassword = null;
    }

    this.connectTimer = setTimeout(() => {
      if (this.state !== 'connecting') return;
      const detail = summarizeOpenVpnLog(this.logBuffer);
      if (detail) {
        this.lastError = detail;
        this.setState('connecting', detail);
        return;
      }
      this.setState(
        'connecting',
        'Waiting for VPN handshake… OpenVPN is running (compression/management notes are not errors).'
      );
    }, 25000);

    try {
      if (process.platform === 'win32' && !isProcessElevated()) {
        let started = false;
        try {
          this.setState('connecting', 'Starting OpenVPN via Interactive Service…');
          const pid = await startViaInteractiveService(vpnDir(), optionsLine, vpnDir());
          this.ownedPid = pid;
          this.launchMethod = 'interactive-service';
          this.startPidPoll();
          this.startMgmtPoll();
          started = true;
        } catch (svcErr) {
          try {
            this.setState('connecting', 'Starting OpenVPN (Administrator / UAC)…');
            const pid = await startElevated(exe, args, vpnDir());
            this.ownedPid = pid;
            this.launchMethod = 'elevated';
            this.startPidPoll();
            this.startMgmtPoll();
            started = true;
          } catch (elevErr) {
            const svcMsg = svcErr instanceof Error ? svcErr.message : String(svcErr);
            const elevMsg = elevErr instanceof Error ? elevErr.message : String(elevErr);
            this.setState('connecting', 'Starting OpenVPN without elevation (likely to fail on TAP/TUN)…');
            const child = spawn(exe, args, {
              cwd: vpnDir(),
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            this.launchMethod = 'direct';
            this.attachChild(child);
            this.startMgmtPoll();
            started = true;
            this.lastError = `${elevMsg} (Interactive Service: ${svcMsg})`;
          }
        }
        if (!started) throw new Error('Failed to start OpenVPN');
      } else {
        const child = spawn(exe, args, {
          cwd: vpnDir(),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.launchMethod = 'direct';
        this.attachChild(child);
        this.startMgmtPoll();
      }
    } catch (err) {
      this.clearAuthFile();
      this.stopLogTail();
      this.stopIfacePoll();
      this.stopMgmt();
      this.clearConnectTimeout();
      this.lastError = err instanceof Error ? err.message : String(err);
      this.setState('error', this.lastError);
    }

    return this.getStatus({
      vpnConfigPath: opts.configPath,
      vpnUsername: opts.username,
    });
  }

  async disconnect(emitStatus = true): Promise<void> {
    this.intentionalStop = true;
    this.generation += 1;
    this.stopIfacePoll();
    this.stopLogTail();
    this.stopPidPoll();
    this.clearConnectTimeout();
    this.clearSplitFixTimers();
    const port = this.mgmtPort;
    const pw = this.mgmtPassword;
    if (this.mgmtSocket && this.mgmtAuthed) {
      try {
        this.mgmtSocket.write('signal SIGTERM\r\n');
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 300));
    } else if (port) {
      await managementSignal(port, pw);
      await new Promise((r) => setTimeout(r, 300));
    }
    this.stopMgmt();
    const child = this.child;
    this.child = null;
    const pid = this.ownedPid || child?.pid || null;
    this.ownedPid = null;
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }
    if (pid && pidAlive(pid)) {
      try {
        process.kill(pid);
      } catch {
        // ignore
      }
    }
    await new Promise((r) => setTimeout(r, 400));
    if (pid && pidAlive(pid)) {
      await new Promise<void>((resolve) => {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      });
    }
    this.clearAuthFile();
    this.bindAddress = null;
    this.bindIfIndex = null;
    this.mgmtPort = null;
    this.mgmtPassword = null;
    this.launchMethod = null;
    if (emitStatus) {
      this.setState('disconnected', 'Disconnected');
      this.emit('bind', null);
    }
  }
}

export const vpnManager = new VpnManager();
