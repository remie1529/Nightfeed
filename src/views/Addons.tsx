import { useCallback, useEffect, useState } from 'react';

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

function pageFrame(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; padding: 16px; background: #161616; color: #eee; font: 15px Segoe UI, sans-serif; }
    h1 { font-size: 1.3rem; margin: 0 0 0.6rem; }
    p { margin: 0.25rem 0; color: #ccc; }
  </style></head><body>${html}</body></html>`;
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

  const installedIds = new Set(installed.map((item) => item.id));
  const openPage = pages.find((page) => `${page.addonId}:${page.pageId}` === openKey) || null;

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
            const have = installedIds.has(item.id);
            return (
              <article key={item.id} className="addon-card">
                <h2>{item.name}</h2>
                <p className="addon-meta">
                  {item.version}
                  {item.author ? ` · ${item.author}` : ''}
                  {' · Approved'}
                </p>
                <p>{item.description}</p>
                <button
                  type="button"
                  className="primary"
                  disabled={have || busy === item.id}
                  onClick={() => void run(item.id, () => window.torrentAPI.installStoreAddon(item.id))}
                >
                  {have ? 'Installed' : busy === item.id ? 'Installing…' : 'Install'}
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
                    return (
                      <tr key={item.id}>
                        <td>
                          <div style={{ fontWeight: 650 }}>{item.name}</div>
                          <div className="addon-meta">
                            {item.version || '—'}
                            {item.author ? ` · ${item.author}` : ''}
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
                              onClick={() => setOpenKey(`${page.addonId}:${page.pageId}`)}
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
              <iframe className="addon-frame" title={openPage.title} sandbox="allow-scripts" srcDoc={pageFrame(openPage.html)} />
            </section>
          )}
        </>
      )}
    </div>
  );
}
