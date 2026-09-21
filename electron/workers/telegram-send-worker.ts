/**
 * Dedicated Telegram outbound HTTP worker (sendMessage / sendPhoto).
 * Bot polling/receive stays on main; heavy outbound posts off main.
 */
import { parentPort, workerData } from 'worker_threads';

export type TelegramSendRequest =
  | {
      id: number;
      op: 'sendMessage';
      token: string;
      chatId: number | string;
      text: string;
      extra?: Record<string, unknown>;
    }
  | {
      id: number;
      op: 'sendPhoto';
      token: string;
      chatId: number | string;
      photoUrl: string;
      caption: string;
      extra?: Record<string, unknown>;
    };

if (!parentPort) throw new Error('telegram-send-worker must run as worker_threads Worker');

async function api(token: string, method: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Telegram ${method} failed: HTTP ${res.status} ${errBody.slice(0, 120)}`);
  }
}

parentPort.on('message', (msg: TelegramSendRequest) => {
  void (async () => {
    try {
      if (msg.op === 'sendMessage') {
        await api(msg.token, 'sendMessage', {
          chat_id: msg.chatId,
          text: String(msg.text || '').slice(0, 3900),
          disable_web_page_preview: true,
          ...(msg.extra || {}),
        });
        parentPort!.postMessage({ id: msg.id, ok: true });
        return;
      }
      if (msg.op === 'sendPhoto') {
        try {
          await api(msg.token, 'sendPhoto', {
            chat_id: msg.chatId,
            photo: msg.photoUrl,
            caption: String(msg.caption || '').slice(0, 1024),
            parse_mode: 'HTML',
            ...(msg.extra || {}),
          });
        } catch {
          await api(msg.token, 'sendMessage', {
            chat_id: msg.chatId,
            text: String(msg.caption || '').replace(/<[^>]+>/g, '').slice(0, 3900),
            disable_web_page_preview: true,
            ...(msg.extra || {}),
          });
        }
        parentPort!.postMessage({ id: msg.id, ok: true });
        return;
      }
      parentPort!.postMessage({ id: (msg as any).id, ok: false, error: 'Unknown telegram op' });
    } catch (err) {
      parentPort!.postMessage({
        id: (msg as any).id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
});

parentPort.postMessage({ type: 'ready', workerId: workerData?.workerId ?? 0 });
