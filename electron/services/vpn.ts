/**
 * OpenVPN helper for Windows Electron — spawn user-provided .ovpn,
 * prefer route-nopull (no full-system default route), expose TUN/TAP IP
 * so WebTorrent can bind torrent sockets to the VPN interface only.
 *
 * Does NOT ship openvpn.exe (GPL). Detects a local install.
 * Never logs the VPN password.
 */
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { app } from 'electron';

export type VpnConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface VpnStatus {
  enabled: boolean;
  state: VpnConnectionState;
  message: string;
  openvpnFound: boolean;
  openvpnPath: string | null;
  configPath: string | null;
  configName: string | null;
  bindAddress: string | null;
  requireForTorrents: boolean;
  usernameSet: boolean;
  /** True when we asked openvpn for route-nopull (torrent-only intent). */
  routeNopull: boolean;
}

const COMMON_OPENVPN_PATHS = [
  'C:\\Program Files\\OpenVPN\\bin\\openvpn.exe',
  'C:\\Program Files (x86)\\OpenVPN\\bin\\openvpn.exe',
  'C:\\Program Files\\OpenVPN Connect\\OpenVPNConnect.exe',
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'OpenVPN', 'bin', 'openvpn.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'OpenVPN', 'bin', 'openvpn.exe'),
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
    const { execFileSync } = require('child_process') as typeof import('child_process');
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
    if (/OpenVPNConnect\.exe$/i.test(candidate)) continue; // GUI only — not useful for CLI spawn
    if (await pathExists(candidate)) return { found: true, path: candidate };
  }
  return { found: false, path: null };
}

function parseIpFromLog(chunk: string): string | null {
  // Common OpenVPN log lines that include the assigned TUN/TAP IPv4
  const patterns = [
    /net_addr_v4_add:\s*(\d{1,3}(?:\.\d{1,3}){3})\//i,
    /ip-win32:\s*(?:.+?)\s+(\d{1,3}(?:\.\d{1,3}){3})/i,
    /(?:TUN\/TAP|tap-windows).*?(\d{1,3}(?:\.\d{1,3}){3})/i,
    /ifconfig\s+(\d{1,3}(?:\.\d{1,3}){3})\s+/i,
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
      n.includes('ovpn');
    for (const entry of list) {
      if (entry.family !== 'IPv4' && (entry.family as unknown) !== 4) continue;
      if (entry.internal) continue;
      if (before.has(entry.address)) continue;
      if (looksVpn) return entry.address;
      // Private ranges often used by VPN providers
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

export class VpnManager extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: VpnConnectionState = 'disconnected';
  private message = 'Disconnected';
  private openvpnPath: string | null = null;
  private openvpnFound = false;
  private bindAddress: string | null = null;
  private logBuffer = '';
  private ipsBeforeConnect = new Set<string>();
  private pollTimer: NodeJS.Timeout | null = null;

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
      requireForTorrents: !!settings.vpnRequireForTorrents,
      usernameSet: !!(settings.vpnUsername && settings.vpnUsername.trim()),
      routeNopull: true,
    };
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  getBindAddress(): string | null {
    return this.bindAddress;
  }

  private setState(state: VpnConnectionState, message: string): void {
    this.state = state;
    this.message = message;
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

  /** Copy .ovpn into userData/vpn and return stored path + display name. */
  async importConfig(sourcePath: string): Promise<{ configPath: string; configName: string }> {
    await fsp.mkdir(vpnDir(), { recursive: true });
    const configName = path.basename(sourcePath);
    const dest = storedConfigPath();
    await fsp.copyFile(sourcePath, dest);
    try {
      await fsp.chmod(dest, 0o600);
    } catch {
      // Windows may ignore chmod
    }
    return { configPath: dest, configName };
  }

  private async writeAuthFile(username: string, password: string): Promise<string | null> {
    if (!username.trim()) return null;
    await fsp.mkdir(vpnDir(), { recursive: true });
    const p = authFilePath();
    // OpenVPN auth-user-pass file: username\npassword\n — never log contents
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

  async connect(opts: {
    configPath: string;
    username?: string;
    password?: string;
  }): Promise<VpnStatus> {
    await this.refreshDetect();
    if (!this.openvpnFound || !this.openvpnPath) {
      this.setState(
        'error',
        'OpenVPN not found. Install OpenVPN Community (openvpn.exe) and ensure it is on PATH, or under Program Files\\OpenVPN\\bin.'
      );
      return this.getStatus({});
    }
    if (!opts.configPath || !(await pathExists(opts.configPath))) {
      this.setState('error', 'No .ovpn config imported. Use Import .ovpn in Settings.');
      return this.getStatus({});
    }

    await this.disconnect(false);

    this.ipsBeforeConnect = this.snapshotLocalIps();
    this.bindAddress = null;
    this.logBuffer = '';
    this.setState('connecting', 'Starting OpenVPN…');

    let authPath: string | null = null;
    try {
      authPath = await this.writeAuthFile(opts.username || '', opts.password || '');
    } catch {
      this.setState('error', 'Could not write auth file in userData');
      return this.getStatus({});
    }

    const args = [
      '--config',
      opts.configPath,
      // Avoid pulling default route so the whole PC is not forced through VPN
      '--route-nopull',
      '--pull-filter',
      'ignore',
      'redirect-gateway',
      '--verb',
      '3',
    ];
    if (authPath) {
      args.push('--auth-user-pass', authPath);
    }

    try {
      const child = spawn(this.openvpnPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;

      const onChunk = (buf: Buffer) => {
        const text = buf.toString('utf8');
        this.logBuffer = (this.logBuffer + text).slice(-12000);
        const ip = parseIpFromLog(text) || parseIpFromLog(this.logBuffer);
        if (ip && !this.bindAddress) {
          this.bindAddress = ip;
          this.emit('bind', ip);
        }
        if (/Initialization Sequence Completed/i.test(text) || /Initialization Sequence Completed/i.test(this.logBuffer)) {
          const addr = this.bindAddress || guessVpnInterfaceIp(this.ipsBeforeConnect);
          if (addr) this.bindAddress = addr;
          this.setState(
            'connected',
            this.bindAddress
              ? `Connected — torrent bind ${this.bindAddress}`
              : 'Connected — detecting TUN/TAP IP…'
          );
          if (!this.bindAddress) this.startIfacePoll();
          else this.emit('bind', this.bindAddress);
        }
        if (/AUTH_FAILED|auth.?fail/i.test(text)) {
          this.setState('error', 'Authentication failed (check username/password)');
        }
        if (/Cannot open TUN\/TAP|All TAP-Windows|ERROR:/i.test(text) && this.state === 'connecting') {
          // Keep connecting unless process exits; surface later
        }
      };

      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);

      child.on('error', (err) => {
        this.child = null;
        this.bindAddress = null;
        this.clearAuthFile();
        this.setState('error', err.message || 'Failed to start openvpn');
        this.emit('bind', null);
      });

      child.on('exit', (code, signal) => {
        this.child = null;
        this.stopIfacePoll();
        this.clearAuthFile();
        const wasConnected = this.state === 'connected' || this.state === 'connecting';
        this.bindAddress = null;
        if (this.state === 'error' && /Authentication failed/i.test(this.message)) {
          this.emit('bind', null);
          this.emit('status');
          return;
        }
        if (wasConnected) {
          const hint =
            code === 1
              ? 'OpenVPN exited (admin rights may be required for TAP/TUN).'
              : `OpenVPN exited (code ${code ?? '—'}, signal ${signal ?? '—'})`;
          this.setState('disconnected', hint);
        } else {
          this.setState('disconnected', 'Disconnected');
        }
        this.emit('bind', null);
      });

      this.startIfacePoll();
    } catch (err) {
      this.clearAuthFile();
      this.setState('error', err instanceof Error ? err.message : String(err));
    }

    return this.getStatus({
      vpnConfigPath: opts.configPath,
      vpnUsername: opts.username,
    });
  }

  async disconnect(emitStatus = true): Promise<void> {
    this.stopIfacePoll();
    const child = this.child;
    this.child = null;
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        // ignore
      }
      // Windows: try taskkill if still alive after short wait
      await new Promise((r) => setTimeout(r, 400));
      try {
        if (!child.killed && child.pid) {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        }
      } catch {
        // ignore
      }
    }
    this.clearAuthFile();
    this.bindAddress = null;
    if (emitStatus) {
      this.setState('disconnected', 'Disconnected');
      this.emit('bind', null);
    }
  }
}

export const vpnManager = new VpnManager();
