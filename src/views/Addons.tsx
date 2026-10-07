import { useCallback, useEffect, useRef, useState } from 'react';

interface CatalogAddon {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
}

interface InstalledAddon {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  enabled: boolean;
  source: 'store' | 'file';
  error: string;
}

interface AddonPage {
  addonId: string;
  addonName: string;
  pageId: string;
  title: string;
  html: string;
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split(/[^0-9]+/).filter(Boolean).map((part) => Number(part));
  const a = parse(left);
  const b = parse(right);
  const count = Math.max(a.length, b.length);
  for (let i = 0; i < count; i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function pageKey(page: { addonId: string; pageId: string }): string {
  return `${page.addonId}:${page.pageId}`;
}

function pageFrame(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><script>
    (function () {
      const pending = {};
      let n = 0;
      window.nightfeed = {
        call(action, payload) {
          const id = ++n;
          return new Promise(function (resolve) {
            pending[id] = resolve;
            parent.postMessage({ source: 'nf-addon', id: id, action: action, payload: payload || null }, '*');
          });
        }
      };
      window.addEventListener('message', function (e) {
        const data = e.data;
        if (!data || data.source !== 'nf-addon-result') return;
        const done = pending[data.id];
        if (!done) return;
        delete pending[data.id];
        done(data.result);
      });
    })();
  </script></head><body>${html}</body></html>`;
}

export function AddonPageView({
  addonId,
  pageId,
  title,
  html,
}: {
  addonId: string;
  pageId: string;
  title: string;
  html: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { source?: string; id?: number; action?: string; payload?: unknown };
      if (!data || data.source !== 'nf-addon') return;
      let result: unknown = { ok: false, error: 'Addon action failed' };
      try {
        result = await window.torrentAPI.addonPageAction(addonId, String(data.action || ''), data.payload);
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      frameRef.current?.contentWindow?.postMessage({ source: 'nf-addon-result', id: data.id, result }, '*');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [addonId, pageId]);
  return (
    <div className="page page-wide addon-page-view">
      <iframe
        ref={frameRef}
        className="addon-frame addon-frame-fill"
        title={title}
        sandbox="allow-scripts"
        srcDoc={pageFrame(html)}
      />
    </div>
  );
}

export default function Addons() {
  const [tab, setTab] = useState<'store' | 'installed'>('store');
  const [catalog, setCatalog] = useState<CatalogAddon[]>([]);
  const [installed, setInstalled] = useState<InstalledAddon[]>([]);
  const [pages, setPages] = useState<AddonPage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [store, local, addonPages] = await Promise.all([
      window.torrentAPI.getAddonCatalog() as Promise<{ addons?: CatalogAddon[]; error?: string }>,
      window.torrentAPI.getInstalledAddons() as Promise<InstalledAddon[]>,
      window.torrentAPI.getAddonPages() as Promise<AddonPage[]>,
    ]);
    setCatalog(Array.isArray(store?.addons) ? store.addons : []);
    setInstalled(Array.isArray(local) ? local : []);
    setPages(Array.isArray(addonPages) ? addonPages : []);
    if (store?.error) setError(store.error);
  }, []);

  useEffect(() => {
    refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    const off = window.torrentAPI.onAddonsChanged?.(() => {
      refresh().catch(() => undefined);
    });
    return () => off?.();
  }, [refresh]);

  const run = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await work();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const installedById = new Map(installed.map((item) => [item.id, item]));
  const openPage = pages.find((page) => pageKey(page) === openKey) || null;

  return (
    <div className="page page-wide">
      <div className="page-header">
        <div>
          <h1>Addons</h1>
          <p>Approved addons are in the store. Addons you install from a file are managed here too.</p>
        </div>
        <div className="toolbar">
          <button type="button" className={tab === 'store' ? 'primary' : ''} onClick={() => setTab('store')}>
            Store
          </button>
          <button
            type="button"
            className={tab === 'installed' ? 'primary' : ''}
            onClick={() => setTab('installed')}
          >
            Installed
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void run('file', () => window.torrentAPI.installAddonFile())}>
            {busy === 'file' ? 'Installing…' : 'Install from file'}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {tab === 'store' && (
        <div className="addon-grid">
          {catalog.length === 0 && (
            <div className="empty-state">
              <h2>No approved addons</h2>
              <p>The store list could not be loaded.</p>
            </div>
          )}
          {catalog.map((item) => {
            const current = installedById.get(item.id);
            const newer = !!current && compareVersions(item.version, current.version) > 0;
            return (
              <article key={item.id} className="addon-card">
                <h2>{item.name}</h2>
                <p className="addon-meta">
                  {item.version}
                  {item.author ? ` · ${item.author}` : ''}
                  {' · Approved'}
                  {newer ? ` · Installed ${current?.version}` : ''}
                </p>
                <p>{item.description}</p>
                <button
                  type="button"
                  className="primary"
                  disabled={(!!current && !newer) || busy === item.id}
                  onClick={() => void run(item.id, () => window.torrentAPI.installStoreAddon(item.id))}
                >
                  {busy === item.id ? (newer ? 'Updating…' : 'Installing…') : newer ? 'Update' : current ? 'Installed' : 'Install'}
                </button>
              </article>
            );
          })}
        </div>
      )}

      {tab === 'installed' && (
        <>
          {installed.length === 0 && (
            <div className="empty-state">
              <h2>No addons installed</h2>
              <p>Install one from the store, or from a zip or addon.json on this PC.</p>
            </div>
          )}
          {installed.length > 0 && (
            <div className="table-wrap">
              <table className="dense">
                <thead>
                  <tr>
                    <th>Addon</th>
                    <th>Source</th>
                    <th>On</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {installed.map((item) => {
                    const ownPages = pages.filter((page) => page.addonId === item.id);
                    const storeItem = catalog.find((entry) => entry.id === item.id);
                    const newer = !!storeItem && compareVersions(storeItem.version, item.version) > 0;
                    return (
                      <tr key={item.id}>
                        <td>
                          <div style={{ fontWeight: 650 }}>{item.name}</div>
                          <div className="addon-meta">
                            {item.version || '—'}
                            {item.author ? ` · ${item.author}` : ''}
                            {newer ? ` · Update ${storeItem?.version} in the store` : ''}
                          </div>
                          {item.description ? <div className="addon-meta">{item.description}</div> : null}
                          {item.error ? <div className="error-banner" style={{ marginTop: 6 }}>{item.error}</div> : null}
                        </td>
                        <td>{item.source === 'store' ? 'Store' : 'File'}</td>
                        <td>
                          <input
                            type="checkbox"
                            checked={item.enabled}
                            onChange={(e) =>
                              void run(`en-${item.id}`, () =>
                                window.torrentAPI.setAddonEnabled(item.id, e.target.checked)
                              )
                            }
                          />
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {ownPages.map((page) => (
                            <button
                              key={page.pageId}
                              type="button"
                              onClick={() => setOpenKey(pageKey(page))}
                            >
                              {page.title}
                            </button>
                          ))}
                          <button
                            type="button"
                            className="danger"
                            disabled={busy === `rm-${item.id}`}
                            onClick={() => void run(`rm-${item.id}`, () => window.torrentAPI.removeAddon(item.id))}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {openPage && (
            <section className="addon-page">
              <div className="toolbar">
                <h2 style={{ margin: 0 }}>{openPage.title}</h2>
                <button type="button" className="ghost" onClick={() => setOpenKey(null)}>
                  Close
                </button>
              </div>
              <AddonPageView addonId={openPage.addonId} pageId={openPage.pageId} title={openPage.title} html={openPage.html} />
            </section>
          )}
        </>
      )}
    </div>
  );
}
