import { AppSettings, TelegramStatus } from '../types';

type SendFn = (
  chatId: number | string,
  text: string,
  extra?: Record<string, unknown>
) => Promise<void>;

type CommandHandler = (
  chatId: number,
  args: string,
  reply: SendFn,
  meta?: { fromName?: string }
) => Promise<void>;

type CallbackHandler = (
  chatId: number,
  data: string,
  reply: SendFn,
  meta?: { fromName?: string; callbackQueryId?: string }
) => Promise<void>;

export type TelegramRole = 'admin' | 'requests' | 'unknown';

export type TelegramHandlers = {
  status: CommandHandler;
  shows: CommandHandler;
  movies?: CommandHandler;
  check: CommandHandler;
  downloads: CommandHandler;
  add: CommandHandler;
  addMovie?: CommandHandler;
  vpn?: CommandHandler;
  pause?: CommandHandler;
  resume?: CommandHandler;
  missing?: CommandHandler;
  search?: CommandHandler;
  help: CommandHandler;
  helpRequests?: CommandHandler;
  request?: CommandHandler;
  approve?: CommandHandler;
  deny?: CommandHandler;
  myrequests?: CommandHandler;
  /** Inline keyboard callback_query (approve:/deny:…). */
  callback?: CallbackHandler;
};

export function escapeHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Normalize unicode dashes/minus and strip junk; keep signed numeric chat ids. */
export function normalizeChatIdToken(raw: string): string | null {
  if (raw == null) return null;
  // Unicode minus/dashes → ASCII hyphen-minus; drop zero-width / BOM junk
  let s = String(raw)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u2212\u2010-\u2015\uFE58\uFE63\uFF0D]/g, '-')
    .trim();
  if (!s) return null;
  const m = s.match(/-?\d+/);
  return m ? m[0] : null;
}

export function parseChatIds(raw: string): Set<string> {
  const out = new Set<string>();
  for (const token of (raw || '').split(/[\s,;]+/)) {
    const id = normalizeChatIdToken(token);
    if (id) out.add(id);
  }
  return out;
}

/** Resolve admin + requests lists with legacy telegramAllowedChatIds migration. */
export function resolveTelegramChatLists(settings: AppSettings): {
  admin: Set<string>;
  requests: Set<string>;
} {
  let adminRaw = (settings.telegramAdminChatIds || '').trim();
  const requestsRaw = (settings.telegramRequestChatIds || '').trim();
  const legacy = (settings.telegramAllowedChatIds || '').trim();
  if (!adminRaw && !requestsRaw && legacy) {
    adminRaw = legacy;
  }
  return {
    admin: parseChatIds(adminRaw),
    requests: parseChatIds(requestsRaw),
  };
}

export function telegramRoleForChat(
  settings: AppSettings,
  chatId: number | string,
  fromId?: number | string | null
): TelegramRole {
  const { admin, requests } = resolveTelegramChatLists(settings);
  const candidates = [chatId, fromId]
    .filter((v) => v != null && v !== '')
    .map((v) => normalizeChatIdToken(String(v)))
    .filter((v): v is string => !!v);
  for (const id of candidates) {
    if (admin.has(id)) return 'admin';
  }
  for (const id of candidates) {
    if (requests.has(id)) return 'requests';
  }
  return 'unknown';
}

function unknownChatHint(chatId: number | string): string {
  return (
    `Your chat ID: ${chatId}\n\n` +
    'Add this exact ID under Admin or Requests in Settings, then Save.'
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
  /** Fresh settings getter so poll uses latest allow-lists. */
  private getSettings: (() => AppSettings) | null = null;

  setHandlers(handlers: TelegramHandlers) {
    this.handlers = handlers;
  }

  setSettingsGetter(fn: () => AppSettings) {
    this.getSettings = fn;
  }

  getStatus(settings: AppSettings): TelegramStatus {
    const { admin, requests } = resolveTelegramChatLists(settings);
    return {
      enabled: !!settings.telegramEnabled,
      configured: !!(settings.telegramBotToken && (admin.size > 0 || requests.size > 0)),
      polling: this.polling,
      lastUpdateId: this.offset || null,
      lastError: this.lastError,
      lastOkAt: this.lastOkAt,
      adminChatIdCount: admin.size,
      requestChatIdCount: requests.size,
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
        const live = this.getSettings ? this.getSettings() : settings;
        await this.pollOnce(live);
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

  async sendMessage(
    token: string,
    chatId: number | string,
    text: string,
    extra?: Record<string, unknown>
  ): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: text.slice(0, 3900),
      disable_web_page_preview: true,
      ...(extra || {}),
    };
    const res = await fetch(this.apiUrl(token, 'sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Telegram send failed: HTTP ${res.status} ${errBody.slice(0, 120)}`);
    }
  }

  async sendPhoto(
    token: string,
    chatId: number | string,
    photoUrl: string,
    caption: string,
    extra?: Record<string, unknown>
  ): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      photo: photoUrl,
      caption: (caption || '').slice(0, 1024),
      parse_mode: 'HTML',
      ...(extra || {}),
    };
    const res = await fetch(this.apiUrl(token, 'sendPhoto'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      await this.sendMessage(token, chatId, caption.replace(/<[^>]+>/g, ''), extra);
    }
  }

  async answerCallbackQuery(
    token: string,
    callbackQueryId: string,
    text?: string
  ): Promise<void> {
    const res = await fetch(this.apiUrl(token, 'answerCallbackQuery'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: text ? text.slice(0, 200) : undefined,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Telegram answerCallbackQuery failed: HTTP ${res.status} ${errBody.slice(0, 120)}`);
    }
  }

  /** Notify a chat using current settings token (fire-and-forget safe). */
  async notifyChat(
    settings: AppSettings,
    chatId: number | string,
    text: string,
    photoUrl?: string | null
  ): Promise<void> {
    const token = settings.telegramBotToken.trim();
    // Skip empty / web-only (0) chat ids — negative group ids remain valid.
    if (!token || chatId == null || chatId === '' || chatId === 0 || chatId === '0') return;
    if (photoUrl) {
      await this.sendPhoto(token, chatId, photoUrl, text);
      return;
    }
    const extra = /<[a-zA-Z]/.test(text) ? { parse_mode: 'HTML' } : undefined;
    await this.sendMessage(token, chatId, text, extra);
  }

  async notifyAdminChats(
    settings: AppSettings,
    text: string,
    extra?: Record<string, unknown>,
    photoUrl?: string | null
  ): Promise<void> {
    const token = settings.telegramBotToken.trim();
    if (!token) return;
    const { admin } = resolveTelegramChatLists(settings);
    for (const id of admin) {
      try {
        if (photoUrl) await this.sendPhoto(token, id, photoUrl, text, extra);
        else await this.sendMessage(token, id, text, extra);
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  async sendTest(settings: AppSettings): Promise<{ ok: boolean; error?: string }> {
    const token = settings.telegramBotToken.trim();
    const { admin, requests } = resolveTelegramChatLists(settings);
    if (!token) return { ok: false, error: 'Bot token required' };
    const ids = admin.size > 0 ? admin : requests;
    if (ids.size === 0) {
      return { ok: false, error: 'At least one Admin or Requests chat id required' };
    }
    try {
      const first = [...ids][0];
      await this.sendMessage(token, first, 'Nightfeed: test message OK.');
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
      `&allowed_updates=${encodeURIComponent(JSON.stringify(['message', 'callback_query']))}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `getUpdates HTTP ${res.status}: ${body.slice(0, 160).replace(token, maskToken(token))}`
        );
      }
      const data = (await res.json()) as {
        ok: boolean;
        result?: Array<{
          update_id: number;
          message?: {
            message_id: number;
            text?: string;
            chat: { id: number; type?: string };
            from?: { id: number; first_name?: string; username?: string };
          };
          callback_query?: {
            id: string;
            data?: string;
            from?: { id: number; first_name?: string; username?: string };
            message?: { chat: { id: number }; message_id: number };
          };
        }>;
      };
      if (!data.ok) throw new Error('getUpdates returned ok=false');
      this.lastOkAt = new Date().toISOString();
      this.lastError = null;

      for (const update of data.result || []) {
        this.offset = Math.max(this.offset, update.update_id + 1);
        if (update.callback_query) {
          await this.handleCallback(settings, update.callback_query);
          continue;
        }
        const msg = update.message;
        if (!msg?.text) continue;
        const chatId = msg.chat.id;
        const fromId = msg.from?.id;
        const fromName =
          msg.from?.username ||
          msg.from?.first_name ||
          (fromId != null ? String(fromId) : undefined);
        // Private chats: also try matching from.id (usually same as chat.id).
        const matchFromId =
          msg.chat.type === 'private' && fromId != null ? fromId : undefined;
        await this.handleMessage(settings, chatId, msg.text.trim(), fromName, matchFromId);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private makeReply(token: string): SendFn {
    return async (id, body, extra) => {
      await this.sendMessage(token, id, body, extra);
    };
  }

  private async handleCallback(
    settings: AppSettings,
    cq: {
      id: string;
      data?: string;
      from?: { id: number; first_name?: string; username?: string };
      message?: { chat: { id: number }; message_id: number };
    }
  ) {
    const token = settings.telegramBotToken.trim();
    const chatId = cq.message?.chat.id ?? cq.from?.id;
    if (chatId == null) return;
    const role = telegramRoleForChat(settings, chatId, cq.from?.id);
    const reply = this.makeReply(token);

    // Always ack the spinner
    try {
      await this.answerCallbackQuery(token, cq.id);
    } catch {
      // ignore
    }

    if (role === 'unknown') {
      await reply(chatId, unknownChatHint(chatId));
      return;
    }
    if (role !== 'admin') {
      await reply(chatId, 'Only admins can approve or deny requests.');
      return;
    }
    if (!this.handlers?.callback || !cq.data) return;
    const fromName = cq.from?.username || cq.from?.first_name;
    try {
      await this.handlers.callback(chatId, cq.data, reply, {
        fromName,
        callbackQueryId: cq.id,
      });
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

  private async handleMessage(
    settings: AppSettings,
    chatId: number,
    text: string,
    fromName?: string,
    fromId?: number
  ) {
    const token = settings.telegramBotToken.trim();
    const reply = this.makeReply(token);
    const role = telegramRoleForChat(settings, chatId, fromId);

    // Critical: unknown chats only ever see their chat id (+ Save hint).
    if (role === 'unknown') {
      await reply(chatId, unknownChatHint(chatId));
      return;
    }

    if (!this.handlers) return;

    const match = text.match(/^\/([a-zA-Z0-9_-]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
    if (!match) {
      if (role === 'requests') {
        await reply(
          chatId,
          'Use /request-show <name> or /request-movie <name>. Try /help'
        );
      } else {
        await reply(chatId, 'Unknown input. Try /help');
      }
      return;
    }

    const cmd = match[1].toLowerCase();
    const args = (match[2] || '').trim();
    const meta = { fromName };

    try {
      if (role === 'requests') {
        await this.dispatchRequestsCommand(cmd, chatId, args, reply, meta);
        return;
      }
      await this.dispatchAdminCommand(cmd, chatId, args, reply, meta);
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

  private async dispatchRequestsCommand(
    cmd: string,
    chatId: number,
    args: string,
    reply: SendFn,
    meta: { fromName?: string }
  ) {
    if (!this.handlers) return;
    switch (cmd) {
      case 'request-show':
        if (this.handlers.request) await this.handlers.request(chatId, `show ${args}`.trim(), reply, meta);
        else await reply(chatId, 'Request command not available.');
        break;
      case 'request-movie':
        if (this.handlers.request) await this.handlers.request(chatId, `movie ${args}`.trim(), reply, meta);
        else await reply(chatId, 'Request command not available.');
        break;
      case 'request':
        // Legacy alias: /request show|movie <name>
        if (this.handlers.request) await this.handlers.request(chatId, args, reply, meta);
        else await reply(chatId, 'Request command not available.');
        break;
      case 'myrequests':
      case 'my-requests':
      case 'requests':
        if (this.handlers.myrequests) await this.handlers.myrequests(chatId, args, reply, meta);
        else await reply(chatId, 'No request status available.');
        break;
      case 'status':
        // Own requests status for request-only users
        if (this.handlers.myrequests) await this.handlers.myrequests(chatId, args, reply, meta);
        else await reply(chatId, 'No request status available.');
        break;
      case 'help':
      case 'start':
        if (this.handlers.helpRequests) await this.handlers.helpRequests(chatId, args, reply, meta);
        else if (this.handlers.help) await this.handlers.help(chatId, args, reply, meta);
        break;
      default:
        await reply(
          chatId,
          `Unknown command /${cmd}. Requests chats can use /request-show, /request-movie, /status, /help.`
        );
    }
  }

  private async dispatchAdminCommand(
    cmd: string,
    chatId: number,
    args: string,
    reply: SendFn,
    meta: { fromName?: string }
  ) {
    if (!this.handlers) return;
    switch (cmd) {
      case 'status':
        await this.handlers.status(chatId, args, reply, meta);
        break;
      case 'shows':
        await this.handlers.shows(chatId, args, reply, meta);
        break;
      case 'movies':
        if (this.handlers.movies) await this.handlers.movies(chatId, args, reply, meta);
        else await reply(chatId, 'Movies command not available.');
        break;
      case 'check':
        await this.handlers.check(chatId, args, reply, meta);
        break;
      case 'downloads':
        await this.handlers.downloads(chatId, args, reply, meta);
        break;
      case 'add':
        await this.handlers.add(chatId, args, reply, meta);
        break;
      case 'add-movie':
      case 'addmovie':
        if (this.handlers.addMovie) await this.handlers.addMovie(chatId, args, reply, meta);
        else await reply(chatId, 'Add movie not available.');
        break;
      case 'search':
        if (this.handlers.search) await this.handlers.search(chatId, args, reply, meta);
        else await reply(chatId, 'Search not available.');
        break;
      case 'vpn':
        if (this.handlers.vpn) await this.handlers.vpn(chatId, args, reply, meta);
        else await reply(chatId, 'VPN command not available.');
        break;
      case 'pause':
        if (this.handlers.pause) await this.handlers.pause(chatId, args, reply, meta);
        else await reply(chatId, 'Pause not available.');
        break;
      case 'resume':
        if (this.handlers.resume) await this.handlers.resume(chatId, args, reply, meta);
        else await reply(chatId, 'Resume not available.');
        break;
      case 'missing':
        if (this.handlers.missing) await this.handlers.missing(chatId, args, reply, meta);
        else await reply(chatId, 'Missing command not available.');
        break;
      case 'request-show':
        if (this.handlers.request) await this.handlers.request(chatId, `show ${args}`.trim(), reply, meta);
        else await reply(chatId, 'Request command not available.');
        break;
      case 'request-movie':
        if (this.handlers.request) await this.handlers.request(chatId, `movie ${args}`.trim(), reply, meta);
        else await reply(chatId, 'Request command not available.');
        break;
      case 'request':
        // Legacy alias: /request show|movie <name>
        if (this.handlers.request) await this.handlers.request(chatId, args, reply, meta);
        else await reply(chatId, 'Request command not available.');
        break;
      case 'approve':
        if (this.handlers.approve) await this.handlers.approve(chatId, args, reply, meta);
        else await reply(chatId, 'Approve not available.');
        break;
      case 'deny':
        if (this.handlers.deny) await this.handlers.deny(chatId, args, reply, meta);
        else await reply(chatId, 'Deny not available.');
        break;
      case 'myrequests':
      case 'my-requests':
      case 'requests':
        if (this.handlers.myrequests) await this.handlers.myrequests(chatId, args, reply, meta);
        else await reply(chatId, 'No request status available.');
        break;
      case 'help':
      case 'start':
        await this.handlers.help(chatId, args, reply, meta);
        break;
      default:
        await reply(chatId, `Unknown command /${cmd}. Try /help`);
    }
  }
}

export const telegramBot = new TelegramBot();

/** Inline keyboard for admin approve/deny. */
export function approveDenyKeyboard(requestId: string): Record<string, unknown> {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `approve:${requestId}` },
          { text: '❌ Deny', callback_data: `deny:${requestId}` },
        ],
      ],
    },
  };
}
