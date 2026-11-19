/**
 * Outbound Telegram HTTP via dedicated worker; falls back to main-thread fetch.
 */
import { resolveDistElectronAsset } from './asset-path';
import { activityLog } from './activity-log';
import { SingleWorkerClient, isWorkerTransportError } from './single-worker-client';

const client = new SingleWorkerClient({
  name: 'telegram-send-pool',
  workerPath: resolveDistElectronAsset('telegram-send-worker.js'),
  readyTimeoutMs: 5000,
  onModeChange: (using) => {
    if (using) activityLog.info('telegram', 'Telegram outbound using dedicated worker');
    else activityLog.warn('telegram', 'Telegram send worker unavailable — outbound falling back to main');
  },
});

async function mainFetch(token: string, method: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const safeBody = token ? errBody.split(token).join('[redacted]') : errBody;
    throw new Error(`Telegram ${method} failed: HTTP ${res.status} ${safeBody.slice(0, 120)}`);
  }
}

export async function sendTelegramMessageViaPool(
  token: string,
  chatId: number | string,
  text: string,
  extra?: Record<string, unknown>
): Promise<void> {
  try {
    await client.run({ op: 'sendMessage', token, chatId, text, extra });
  } catch (err) {
    if (!isWorkerTransportError(err)) throw err;
    await mainFetch(token, 'sendMessage', {
      chat_id: chatId,
      text: String(text || '').slice(0, 3900),
      disable_web_page_preview: true,
      ...(extra || {}),
    });
  }
}

export async function sendTelegramPhotoViaPool(
  token: string,
  chatId: number | string,
  photoUrl: string,
  caption: string,
  extra?: Record<string, unknown>
): Promise<void> {
  try {
    await client.run({ op: 'sendPhoto', token, chatId, photoUrl, caption, extra });
  } catch (err) {
    if (!isWorkerTransportError(err)) throw err;
    try {
      await mainFetch(token, 'sendPhoto', {
        chat_id: chatId,
        photo: photoUrl,
        caption: String(caption || '').slice(0, 1024),
        parse_mode: 'HTML',
        ...(extra || {}),
      });
    } catch {
      await mainFetch(token, 'sendMessage', {
        chat_id: chatId,
        text: String(caption || '').replace(/<[^>]+>/g, '').slice(0, 3900),
        disable_web_page_preview: true,
        ...(extra || {}),
      });
    }
  }
}

export function destroyTelegramSendPool(): Promise<void> {
  return client.destroy();
}
