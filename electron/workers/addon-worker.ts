/**
 * One utility process per installed addon. The addon is required here, and
 * every Nightfeed API call is a message back to the main process.
 */
import { createRequire } from 'module';

type HostMsg =
  | {
      type: 'load';
      mainFile: string;
      addonId: string;
      addonName: string;
      version: string;
      downloads: unknown[];
    }
  | { type: 'call-result'; requestId: number; ok: boolean; result?: unknown; error?: string }
  | { type: 'library-changed' }
  | { type: 'downloads-changed'; items: unknown[] }
  | { type: 'action'; requestId: number; action: string; payload: unknown }
  | { type: 'telegram'; requestId: number; command: string; args: string; chatId?: number; fromName?: string }
  | { type: 'request'; action: string; request: unknown }
  | { type: 'settings-changed'; values: Record<string, string> }
  | { type: 'setting-action'; requestId: number; fieldId: string }
  | { type: 'deactivate' };

const port = (process as NodeJS.Process & {
  parentPort?: {
    on: (ev: 'message', cb: (e: { data: HostMsg }) => void) => void;
    postMessage: (msg: unknown) => void;
  };
}).parentPort;

if (!port) {
  console.error('[addon-worker] no parentPort');
  process.exit(1);
}

const parent = port;

function post(msg: unknown) {
  parent.postMessage(msg);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let downloads: unknown[] = [];
let actionHandler: ((action: string, payload: unknown) => unknown) | null = null;
const telegramHandlers = new Map<string, (args: string, meta?: { chatId?: number; fromName?: string }) => unknown>();
let requestListener: ((request: unknown, action: string) => unknown) | null = null;
let settingsListener: ((values: Record<string, string>) => unknown) | null = null;
let settingsAction: ((id: string) => unknown) | null = null;
let deactivate: (() => void) | undefined;
const libraryListeners: Array<() => void> = [];
const downloadListeners: Array<() => void> = [];
const pages = new Set<string>();
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
let requestId = 0;
let loaded = false;

function callMain(method: string, args: unknown[]): Promise<unknown> {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    post({ type: 'call', requestId: id, method, args });
  });
}

function runListeners(list: Array<() => void>) {
  for (const fn of list) {
    try {
      const result = fn() as unknown;
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).catch((err) => {
          post({ type: 'event', event: 'log', level: 'warn', message: messageOf(err).slice(0, 500) });
        });
      }
    } catch (err) {
      post({ type: 'event', event: 'log', level: 'warn', message: messageOf(err).slice(0, 500) });
    }
  }
}

function createApi(version: string) {
  return {
    app: {
      version,
      notify(message: string) {
        post({ type: 'event', event: 'notify', message: String(message || '').slice(0, 240) });
      },
      ffmpegPath() {
        return callMain('ensureFfmpeg', []);
      },
    },
    log: {
      info(message: string) {
        post({ type: 'event', event: 'log', level: 'info', message: String(message || '').slice(0, 500) });
      },
      warn(message: string) {
        post({ type: 'event', event: 'log', level: 'warn', message: String(message || '').slice(0, 500) });
      },
    },
    library: {
      listShows: () => callMain('listShows', []),
      listMovies: () => callMain('listMovies', []),
      addShow: (mazeId: number, policy?: string) => callMain('addShow', [mazeId, policy]),
      addMovie: (imdbNumericId: number) => callMain('addMovie', [imdbNumericId]),
      removeShow: (mazeId: number) => callMain('removeShow', [mazeId]),
      removeMovie: (imdbNumericId: number) => callMain('removeMovie', [imdbNumericId]),
    },
    downloads: {
      list() {
        return JSON.parse(JSON.stringify(downloads)) as unknown[];
      },
    },
    ui: {
      addPage(page: { id?: string; title?: string; html?: string }) {
        const pageId = String(page?.id || '').trim();
        if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(pageId)) {
          throw new Error('Page id must be lowercase letters, digits, or dashes');
        }
        pages.add(pageId);
        post({
          type: 'event',
          event: 'addPage',
          pageId,
          title: String(page?.title || pageId).slice(0, 80),
          html: String(page?.html || ''),
        });
      },
      setPage(id: string, html: string) {
        const pageId = String(id || '');
        if (!pages.has(pageId)) throw new Error(`Unknown page ${id}`);
        post({ type: 'event', event: 'setPage', pageId, html: String(html || '') });
      },
      onAction(fn: (action: string, payload: unknown) => unknown) {
        if (typeof fn === 'function') actionHandler = fn;
      },
      openShow(id: number) {
        post({ type: 'event', event: 'openShow', id: Number(id) });
      },
      openMovie(id: number) {
        post({ type: 'event', event: 'openMovie', id: Number(id) });
      },
    },
    telegram: {
      command(
        name: string,
        spec: {
          description?: string;
          audience?: string;
          run?: (args: string, meta?: { chatId?: number; fromName?: string }) => unknown;
        } | ((args: string) => unknown)
      ) {
        const command = String(name || '').toLowerCase().replace(/^\//, '').replace(/[^a-z0-9-]/g, '');
        if (!command) throw new Error('Telegram command name is empty');
        const run = typeof spec === 'function' ? spec : spec && spec.run;
        if (typeof run !== 'function') throw new Error('Telegram command needs a function');
        const audience = typeof spec === 'object' && spec && (spec.audience === 'requests' || spec.audience === 'all')
          ? spec.audience
          : 'admin';
        telegramHandlers.set(command, run);
        post({
          type: 'event',
          event: 'telegram',
          command,
          description: String((typeof spec === 'object' && spec && spec.description) || '').slice(0, 120),
          audience,
        });
      },
    },
    settings: {
      define(fields: unknown) {
        post({ type: 'event', event: 'settings', fields });
      },
      get(id: string) {
        return callMain('getSetting', [id]);
      },
      onChanged(fn: (values: Record<string, string>) => unknown) {
        if (typeof fn === 'function') settingsListener = fn;
      },
      onAction(fn: (id: string) => unknown) {
        if (typeof fn === 'function') settingsAction = fn;
      },
    },
    requests: {
      submit(input: unknown) {
        return callMain('submitMusicRequest', [input]);
      },
      complete(id: string) {
        return callMain('completeMusicRequest', [id]);
      },
      fail(id: string, message: string) {
        return callMain('failMusicRequest', [id, message]);
      },
      onResolved(fn: (request: unknown, action: string) => unknown) {
        if (typeof fn === 'function') {
          requestListener = fn;
          post({ type: 'event', event: 'requests-listen' });
        }
      },
    },
    events: {
      onLibraryChanged(fn: () => void) {
        if (typeof fn === 'function') libraryListeners.push(fn);
        return () => {
          const idx = libraryListeners.indexOf(fn);
          if (idx >= 0) libraryListeners.splice(idx, 1);
        };
      },
      onDownloadsChanged(fn: () => void) {
        if (typeof fn === 'function') downloadListeners.push(fn);
        return () => {
          const idx = downloadListeners.indexOf(fn);
          if (idx >= 0) downloadListeners.splice(idx, 1);
        };
      },
    },
  };
}

function loadAddon(msg: Extract<HostMsg, { type: 'load' }>) {
  if (loaded) return;
  loaded = true;
  downloads = Array.isArray(msg.downloads) ? msg.downloads : [];
  try {
    const req = createRequire(msg.mainFile);
    const resolved = req.resolve(msg.mainFile);
    delete req.cache[resolved];
    const mod = req(msg.mainFile) as { activate?: (api: unknown) => unknown; deactivate?: () => void };
    if (typeof mod.activate !== 'function') throw new Error('index.js must export activate(api)');
    deactivate = typeof mod.deactivate === 'function' ? mod.deactivate : undefined;
    const result = mod.activate(createApi(msg.version || ''));
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<unknown>).catch((err) => {
        post({ type: 'activate-error', error: messageOf(err) });
      });
    }
    post({ type: 'ready' });
  } catch (err) {
    post({ type: 'failed', error: messageOf(err) });
  }
}

process.on('uncaughtException', (err) => {
  post({ type: 'failed', error: messageOf(err) });
  setTimeout(() => process.exit(1), 30);
});
process.on('unhandledRejection', (reason) => {
  post({ type: 'failed', error: messageOf(reason) });
  setTimeout(() => process.exit(1), 30);
});

parent.on('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'load') {
    loadAddon(msg);
    return;
  }
  if (msg.type === 'call-result') {
    const waiter = pending.get(msg.requestId);
    if (!waiter) return;
    pending.delete(msg.requestId);
    if (msg.ok) waiter.resolve(msg.result);
    else waiter.reject(new Error(msg.error || 'Addon call failed'));
    return;
  }
  if (msg.type === 'settings-changed') {
    if (settingsListener) {
      try {
        settingsListener(msg.values || {});
      } catch (err) {
        post({ type: 'event', event: 'log', level: 'warn', message: messageOf(err).slice(0, 500) });
      }
    }
    return;
  }
  if (msg.type === 'request') {
    if (requestListener) {
      void Promise.resolve(requestListener(msg.request, String(msg.action || ''))).catch((err) => {
        post({ type: 'event', event: 'log', level: 'warn', message: messageOf(err).slice(0, 500) });
      });
    }
    return;
  }
  if (msg.type === 'library-changed') {
    runListeners(libraryListeners);
    return;
  }
  if (msg.type === 'downloads-changed') {
    downloads = Array.isArray(msg.items) ? msg.items : [];
    runListeners(downloadListeners);
    return;
  }
  if (msg.type === 'telegram') {
    void (async () => {
      try {
        const fn = telegramHandlers.get(String(msg.command || ''));
        if (!fn) throw new Error('This addon does not handle that command');
        const text = await fn(String(msg.args || ''), {
          chatId: Number(msg.chatId) || 0,
          fromName: String(msg.fromName || ''),
        });
        post({
          type: 'telegram-result',
          requestId: msg.requestId,
          ok: true,
          text: String(text == null ? '' : text).slice(0, 3500),
        });
      } catch (err) {
        post({ type: 'telegram-result', requestId: msg.requestId, ok: false, error: messageOf(err) });
      }
    })();
    return;
  }
  if (msg.type === 'setting-action') {
    void (async () => {
      try {
        if (!settingsAction) throw new Error('This addon has no settings action');
        const text = await settingsAction(String(msg.fieldId || ''));
        post({
          type: 'action-result',
          requestId: msg.requestId,
          ok: true,
          result: text == null ? '' : String(text).slice(0, 500),
        });
      } catch (err) {
        post({ type: 'action-result', requestId: msg.requestId, ok: false, error: messageOf(err) });
      }
    })();
    return;
  }
  if (msg.type === 'action') {
    void (async () => {
      try {
        if (!actionHandler) throw new Error('This addon is not running');
        const result = await actionHandler(String(msg.action || ''), msg.payload);
        const cloned = result === undefined ? null : JSON.parse(JSON.stringify(result));
        post({ type: 'action-result', requestId: msg.requestId, ok: true, result: cloned });
      } catch (err) {
        post({ type: 'action-result', requestId: msg.requestId, ok: false, error: messageOf(err) });
      }
    })();
    return;
  }
  if (msg.type === 'deactivate') {
    try {
      deactivate?.();
    } catch (err) {
      post({ type: 'event', event: 'log', level: 'warn', message: messageOf(err).slice(0, 500) });
    }
    for (const waiter of pending.values()) waiter.reject(new Error('Addon worker stopped'));
    pending.clear();
    post({ type: 'stopped' });
  }
});
