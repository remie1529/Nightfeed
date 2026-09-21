import { app, shell } from 'electron';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import {
  appendLogLines,
  destroyLogWriter,
  getLogWriterInfo,
  initLogWriter,
  readLogAll,
  setLogWriterModeLogger,
} from './log-writer-pool';

const RETENTION_DAYS = 7;
const FILE_PREFIX = 'nightfeed-';
const FILE_SUFFIX = '.log';
/** Cap how much text we send to the renderer in one read. */
const MAX_READ_BYTES = 2.5 * 1024 * 1024;

export type LogLevel = 'info' | 'warn' | 'error';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local wall-clock stamp for Remco (box/user zone). */
function formatLocalStamp(d = new Date()): string {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseDayFromName(name: string): Date | null {
  const m = name.match(/^nightfeed-(\d{4})-(\d{2})-(\d{2})\.log$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function safeMeta(meta?: Record<string, unknown>): string {
  if (!meta || !Object.keys(meta).length) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v == null || v === '') continue;
    const key = k.toLowerCase();
    if (
      key.includes('password') ||
      key.includes('token') ||
      key.includes('secret') ||
      key.includes('credential') ||
      key === 'magnet'
    ) {
      continue;
    }
    let s: string;
    if (typeof v === 'string') s = v.length > 200 ? `${v.slice(0, 197)}…` : v;
    else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
    else {
      try {
        s = JSON.stringify(v);
        if (s.length > 200) s = `${s.slice(0, 197)}…`;
      } catch {
        s = String(v);
      }
    }
    parts.push(`${k}=${s}`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/**
 * Central activity log: daily files under userData/logs, ~7 day retention.
 * Emits `changed` after each write so the UI can tail.
 */
class ActivityLogService extends EventEmitter {
  private dir = '';
  private currentDay = '';
  private stream: fs.WriteStream | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private ready = false;
  private pendingLines: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private useLogWorker = false;
  private modeLogged = false;

  init(): void {
    if (this.ready) return;
    this.dir = path.join(app.getPath('userData'), 'logs');
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      // ignore
    }
    this.openToday();
    this.pruneOld();
    this.pruneTimer = setInterval(
      () => {
        this.pruneOld();
        this.openToday();
        void this.flush(true);
      },
      60 * 60 * 1000
    );
    this.pruneTimer.unref?.();
    this.ready = true;
    setLogWriterModeLogger((using) => {
      if (this.modeLogged && using) return;
      if (using) {
        // Defer so we don't recurse into write during init
        setImmediate(() => this.info('log', 'Activity log using dedicated writer worker'));
        this.modeLogged = true;
        this.useLogWorker = true;
      } else if (!this.modeLogged) {
        setImmediate(() =>
          this.warn('log', 'Log writer worker unavailable — activity log falling back to main process')
        );
        this.modeLogged = true;
        this.useLogWorker = false;
      }
    });
    void initLogWriter(this.dir).then((r) => {
      this.useLogWorker = !!r.usedWorker;
    });
  }

  getDir(): string {
    if (!this.dir) this.init();
    return this.dir;
  }

  /** Newest retained daily file path (today's log). */
  getCurrentPath(): string {
    this.openToday();
    return path.join(this.dir, `${FILE_PREFIX}${this.currentDay}${FILE_SUFFIX}`);
  }

  info(category: string, message: string, meta?: Record<string, unknown>): void {
    this.write('info', category, message, meta);
  }

  warn(category: string, message: string, meta?: Record<string, unknown>): void {
    this.write('warn', category, message, meta);
  }

  error(category: string, message: string, meta?: Record<string, unknown>): void {
    this.write('error', category, message, meta);
  }

  private write(
    level: LogLevel,
    category: string,
    message: string,
    meta?: Record<string, unknown>
  ): void {
    try {
      if (!this.ready) this.init();
      this.openToday();
      const line =
        `${formatLocalStamp()} [${level.toUpperCase()}] [${category}] ${message}` +
        `${safeMeta(meta)}\n`;
      this.pendingLines.push(line);
      this.emit('changed');
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          void this.flush(false);
        }, 16);
        this.flushTimer.unref?.();
      }
    } catch {
      // never throw from logger
    }
  }

  /** Flush buffered lines to log-writer worker (or sync fallback). */
  private async flush(_force: boolean): Promise<void> {
    if (!this.pendingLines.length) return;
    const batch = this.pendingLines.splice(0, this.pendingLines.length);
    const day = this.currentDay || dayKey();
    if (this.useLogWorker || getLogWriterInfo().usingWorker) {
      try {
        await appendLogLines(day, batch);
        this.useLogWorker = true;
        return;
      } catch {
        this.useLogWorker = false;
      }
    }
    try {
      if (this.stream && !this.stream.destroyed) {
        for (const line of batch) this.stream.write(line);
      } else {
        fs.appendFileSync(this.getCurrentPath(), batch.join(''), 'utf8');
      }
    } catch {
      // ignore
    }
  }

  private openToday(): void {
    const today = dayKey();
    if (this.stream && this.currentDay === today && !this.stream.destroyed) return;
    try {
      this.stream?.end();
    } catch {
      // ignore
    }
    this.currentDay = today;
    const file = path.join(this.dir, `${FILE_PREFIX}${today}${FILE_SUFFIX}`);
    this.stream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
    this.stream.on('error', () => {
      // ignore disk errors
    });
  }

  pruneOld(): void {
    try {
      if (!this.dir) return;
      const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
      for (const name of fs.readdirSync(this.dir)) {
        const day = parseDayFromName(name);
        if (!day) continue;
        if (day.getTime() < cutoff) {
          try {
            fs.unlinkSync(path.join(this.dir, name));
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }

  /** List retained log files oldest → newest. */
  listFiles(): string[] {
    this.init();
    try {
      return fs
        .readdirSync(this.dir)
        .filter((n) => parseDayFromName(n))
        .sort()
        .map((n) => path.join(this.dir, n));
    } catch {
      return [];
    }
  }

  /**
   * Read retained logs (capped). Returns plain text with newest content at the end.
   */
  readAll(maxBytes = MAX_READ_BYTES): { text: string; path: string; truncated: boolean; size: number } {
    this.init();
    this.pruneOld();
    const files = this.listFiles();
    let total = 0;
    for (const f of files) {
      try {
        total += fs.statSync(f).size;
      } catch {
        // ignore
      }
    }
    let truncated = false;
    let remaining = maxBytes;
    const chunks: string[] = [];
    // Read from newest backwards until budget, then reverse for chronological display.
    for (let i = files.length - 1; i >= 0 && remaining > 0; i--) {
      const f = files[i];
      try {
        const buf = fs.readFileSync(f);
        if (buf.length <= remaining) {
          chunks.unshift(buf.toString('utf8'));
          remaining -= buf.length;
        } else {
          truncated = true;
          const slice = buf.subarray(buf.length - remaining);
          let text = slice.toString('utf8');
          const nl = text.indexOf('\n');
          if (nl >= 0 && nl < text.length - 1) text = text.slice(nl + 1);
          chunks.unshift(text);
          remaining = 0;
        }
      } catch {
        // ignore
      }
    }
    const text = chunks.join('');
    return {
      text,
      path: this.getCurrentPath(),
      truncated: truncated || total > maxBytes,
      size: total,
    };
  }

  /** Last N lines across retained files (newest last). */
  tail(lines = 500): { text: string; path: string; truncated: boolean; size: number } {
    const all = this.readAll();
    const parts = all.text.split(/\r?\n/);
    // Drop trailing empty from final newline
    if (parts.length && parts[parts.length - 1] === '') parts.pop();
    const sliced = parts.length > lines ? parts.slice(-lines) : parts;
    return {
      text: sliced.length ? `${sliced.join('\n')}\n` : '',
      path: all.path,
      truncated: all.truncated || parts.length > lines,
      size: all.size,
    };
  }

  async openFolder(): Promise<{ ok: boolean; path: string; error?: string }> {
    this.init();
    try {
      const p = this.getDir();
      const err = await shell.openPath(p);
      if (err) return { ok: false, path: p, error: err };
      return { ok: true, path: p };
    } catch (e) {
      return {
        ok: false,
        path: this.getDir(),
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  destroy(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    void this.flush(true);
    void destroyLogWriter();
    try {
      this.stream?.end();
    } catch {
      // ignore
    }
    this.stream = null;
    this.ready = false;
  }
}

export const activityLog = new ActivityLogService();

/** Redact common secret field names from a settings-diff summary. */
export function summarizeSettingsKeys(partial: Record<string, unknown>): string {
  const secret = /password|token|secret|credential/i;
  const keys = Object.keys(partial || {}).filter((k) => k !== 'webPortalAdminPassword');
  if (!keys.length) return '(none)';
  return keys
    .map((k) => (secret.test(k) ? `${k}=***` : k))
    .join(', ');
}
