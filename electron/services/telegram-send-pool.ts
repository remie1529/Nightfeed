/**
 * Outbound Telegram HTTP via dedicated worker; falls back to main-thread fetch.
 */
import { Worker } from 'worker_threads';
import { resolveDistElectronAsset } from './asset-path';
import { activityLog } from './activity-log';

const WORKER_PATH = resolveDistElectronAsset('telegram-send-worker.js');

type Pending = { resolve: () => void; reject: (e: Error) => void };
let worker: Worker | null = null;
let ready = false;
let useWorker = true;
let nextId = 1;
const pending = new Map<number, Pending>();
let initPromise: Promise<void> | null = null;
let logged = false;

function note(using: boolean) {
  if (logged && using) return;
  if (using) { activityLog.info('telegram', 'Telegram outbound using dedicated worker'); logged = true; }
  else if (!logged) { activityLog.warn('telegram', 'Telegram send worker unavailable — outbound falling back to main'); logged = true; }
}

async function ensure(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const w = new Worker(WORKER_PATH, { workerData: { workerId: 0 } });
      worker = w;
      w.on('message', (msg: any) => {
        if (msg?.type === 'ready') { ready = true; return; }
        if (typeof msg?.id === 'number') {
          const p = pending.get(msg.id);
          if (!p) return;
          pending.delete(msg.id);
          if (msg.ok) p.resolve();
          else p.reject(new Error(msg.error || 'Telegram send worker failed'));
        }
      });
      w.on('error', () => { useWorker = false; note(false); });
      w.on('exit', (code) => { ready = false; worker = null; initPromise = null; if (code !== 0) { useWorker = false; note(false); } });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !ready) await new Promise((r) => setTimeout(r, 20));
      if (!ready) { try { await w.terminate(); } catch {} worker = null; useWorker = false; note(false); }
      else note(true);
    } catch { useWorker = false; worker = null; note(false); }
  })();
  return initPromise;
}

async function run(payload: Record<string, unknown>): Promise<void> {
  await ensure();
  if (!useWorker || !worker || !ready) throw new Error('Telegram send worker not ready');
  await new Promise<void>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker!.postMessage({ ...payload, id });
  });
}

async function mainFetch(token: string, method: string, body: Record<string, unknown>): Promise<void> {
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

export async function sendTelegramMessageViaPool(
  token: string,
  chatId: number | string,
  text: string,
  extra?: Record<string, unknown>
): Promise<void> {
  try {
    await run({ op: 'sendMessage', token, chatId, text, extra });
  } catch {
    useWorker = false; note(false);
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
    await run({ op: 'sendPhoto', token, chatId, photoUrl, caption, extra });
  } catch {
    useWorker = false; note(false);
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
