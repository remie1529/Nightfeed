import { AppSettings, TelegramStatus } from '../types';

type SendFn = (chatId: number | string, text: string) => Promise<void>;
type CommandHandler = (chatId: number, args: string, reply: SendFn) => Promise<void>;

export type TelegramHandlers = {
  status: CommandHandler;
  shows: CommandHandler;
  check: CommandHandler;
  downloads: CommandHandler;
  add: CommandHandler;
  help: CommandHandler;
};

function parseAllowedIds(raw: string): Set<string> {
  return new Set(
    (raw || '')
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function maskToken(_token: string): string {
  return '[redacted]';
}

export class TelegramBot {
  private timer: NodeJS.Timeout | null = null;
  private offset = 0;
  private polling = false;
  private lastError: string | null = null;
  private lastOkAt: string | null = null;
  private handlers: TelegramHandlers | null = null;
  private inFlight = false;

  setHandlers(handlers: TelegramHandlers) {
    this.handlers = handlers;
  }

  getStatus(settings: AppSettings): TelegramStatus {
    return {
      enabled: !!settings.telegramEnabled,
      configured: !!(settings.telegramBotToken && settings.telegramAllowedChatIds.trim()),
      polling: this.polling,
      lastUpdateId: this.offset || null,
      lastError: this.lastError,
      lastOkAt: this.lastOkAt,
    };
  }

  sync(settings: AppSettings) {
    if (settings.telegramEnabled && settings.telegramBotToken.trim()) {
      this.start(settings);
    } else {
      this.stop();
    }
  }

  start(settings: AppSettings) {
    this.stop();
    if (!settings.telegramBotToken.trim()) {
      this.lastError = 'Bot token missing';
      return;
    }
    this.polling = true;
    this.lastError = null;
    const tick = async () => {
      if (!this.polling || this.inFlight) return;
      this.inFlight = true;
      try {
        await this.pollOnce(settings);
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      } finally {
        this.inFlight = false;
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), 2500);
  }

  stop() {
    this.polling = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private apiUrl(token: string, method: string): string {
    return `https://api.telegram.org/bot${token}/${method}`;
  }

  async sendMessage(token: string, chatId: number | string, text: string): Promise<void> {
    const res = await fetch(this.apiUrl(token, 'sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 3900),
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Telegram send failed: HTTP ${res.status} ${body.slice(0, 120)}`);
    }
  }

  async sendTest(settings: AppSettings): Promise<{ ok: boolean; error?: string }> {
    const token = settings.telegramBotToken.trim();
    const ids = parseAllowedIds(settings.telegramAllowedChatIds);
    if (!token) return { ok: false, error: 'Bot token required' };
    if (ids.size === 0) return { ok: false, error: 'At least one allowed chat id required' };
    try {
      const first = [...ids][0];
      await this.sendMessage(token, first, 'Torrent TV Manager: test message OK.');
      this.lastOkAt = new Date().toISOString();
      this.lastError = null;
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      return { ok: false, error: message };
    }
  }

  private async pollOnce(settings: AppSettings) {
    const token = settings.telegramBotToken.trim();
    if (!token) return;
    const url =
      this.apiUrl(token, 'getUpdates') +
      `?timeout=0&offset=${this.offset}` +
      `&allowed_updates=${encodeURIComponent(JSON.stringify(['message']))}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // Never include token in error text
        throw new Error(`getUpdates HTTP ${res.status}: ${body.slice(0, 160).replace(token, maskToken(token))}`);
      }
      const data = (await res.json()) as {
        ok: boolean;
        result?: Array<{
          update_id: number;
          message?: {
            message_id: number;
            text?: string;
            chat: { id: number };
            from?: { id: number };
          };
        }>;
      };
      if (!data.ok) throw new Error('getUpdates returned ok=false');
      this.lastOkAt = new Date().toISOString();
      this.lastError = null;
      const allowed = parseAllowedIds(settings.telegramAllowedChatIds);
      for (const update of data.result || []) {
        this.offset = Math.max(this.offset, update.update_id + 1);
        const msg = update.message;
        if (!msg?.text) continue;
        const chatId = msg.chat.id;
        if (allowed.size > 0 && !allowed.has(String(chatId))) {
          continue;
        }
        await this.handleCommand(settings, chatId, msg.text.trim());
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async handleCommand(settings: AppSettings, chatId: number, text: string) {
    if (!this.handlers) return;
    const token = settings.telegramBotToken.trim();
    const reply: SendFn = async (id, body) => {
      await this.sendMessage(token, id, body);
    };
    const match = text.match(/^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
    if (!match) {
      await reply(chatId, 'Unknown input. Try /help');
      return;
    }
    const cmd = match[1].toLowerCase();
    const args = (match[2] || '').trim();
    try {
      switch (cmd) {
        case 'status':
          await this.handlers.status(chatId, args, reply);
          break;
        case 'shows':
          await this.handlers.shows(chatId, args, reply);
          break;
        case 'check':
          await this.handlers.check(chatId, args, reply);
          break;
        case 'downloads':
          await this.handlers.downloads(chatId, args, reply);
          break;
        case 'add':
          await this.handlers.add(chatId, args, reply);
          break;
        case 'help':
        case 'start':
          await this.handlers.help(chatId, args, reply);
          break;
        default:
          await reply(chatId, `Unknown command /${cmd}. Try /help`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      try {
        await reply(chatId, `Error: ${message}`);
      } catch {
        // ignore
      }
    }
  }
}

export const telegramBot = new TelegramBot();
