/**
 * Runs the local MCP server and writes the stdio bridge agents can launch.
 */
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import type { AppSettings } from '../types';
import { createNightfeedTools, type NightfeedMcpApi } from './mcp-tools';

// Kept as a runtime file next to dist-electron/main.js. The packager does not
// inline this require, so vite copies mcp-protocol.js beside the bundle.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const protocol = require('./mcp-protocol.js') as {
  createMcpHttpServer: (options: { token: () => string; tools: () => unknown[] }) => {
    listen: (port: number) => Promise<number>;
    close: () => Promise<void>;
  };
  BRIDGE_SOURCE: string;
};

type Server = ReturnType<typeof protocol.createMcpHttpServer>;

class NightfeedMcp {
  private server: Server | null = null;
  private api: NightfeedMcpApi | null = null;
  private port = 0;
  private lastError = '';
  private starting: Promise<void> | null = null;

  setApi(api: NightfeedMcpApi): void {
    this.api = api;
  }

  status(settings: AppSettings): {
    enabled: boolean;
    running: boolean;
    port: number;
    url: string;
    token: string;
    bridgePath: string;
    error: string;
  } {
    const port = this.port || settings.mcpPort || 47321;
    const dir = app.getPath('userData');
    return {
      enabled: !!settings.mcpEnabled,
      running: !!this.server,
      port,
      url: `http://127.0.0.1:${port}/mcp`,
      token: settings.mcpToken || '',
      bridgePath: path.join(dir, 'mcp-bridge.cjs'),
      error: this.lastError,
    };
  }

  sync(settings: AppSettings): void {
    this.starting = (this.starting || Promise.resolve())
      .then(() => this.apply(settings))
      .catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
      });
  }

  async stop(): Promise<void> {
    if (this.starting) await this.starting.catch(() => undefined);
    await this.closeServer();
  }

  private async apply(settings: AppSettings): Promise<void> {
    await this.closeServer();
    this.lastError = '';
    if (!settings.mcpEnabled) return;
    if (!this.api) throw new Error('MCP API is not ready');
    const token = (settings.mcpToken || '').trim();
    if (token.length < 16) throw new Error('MCP token is missing');
    const port = clampPort(settings.mcpPort);
    const tools = createNightfeedTools(this.api);
    const server = protocol.createMcpHttpServer({
      token: () => token,
      tools: () => tools,
    });
    try {
      const actual = await server.listen(port);
      this.server = server;
      this.port = actual;
      this.writeBridge(settings, actual);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      try {
        await server.close();
      } catch {
        // ignore
      }
      throw err;
    }
  }

  private async closeServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = 0;
    if (server) await server.close();
  }

  private writeBridge(settings: AppSettings, port: number): void {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    const bridgePath = path.join(dir, 'mcp-bridge.cjs');
    fs.writeFileSync(bridgePath, protocol.BRIDGE_SOURCE, 'utf8');
    const config = {
      url: `http://127.0.0.1:${port}/mcp`,
      token: settings.mcpToken,
    };
    fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify(config, null, 2), 'utf8');
  }
}

function clampPort(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 47321;
  return Math.max(1, Math.min(65535, Math.floor(n)));
}

export const nightfeedMcp = new NightfeedMcp();
