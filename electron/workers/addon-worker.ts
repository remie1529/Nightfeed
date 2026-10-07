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
  if (msg.type === 'library-changed') {
    runListeners(libraryListeners);
    return;
  }
  if (msg.type === 'downloads-changed') {
    downloads = Array.isArray(msg.items) ? msg.items : [];
    runListeners(downloadListeners);
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
