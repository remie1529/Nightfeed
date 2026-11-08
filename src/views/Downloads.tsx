import { useEffect, useState } from 'react';
import { formatPercent, formatSpeed, pad2 } from '../lib/format';
import type { DownloadItem } from '../lib/types';

type HealthLabel = 'Excellent' | 'Good' | 'Fair' | 'Poor' | 'Dead';

function torrentHealth(item: DownloadItem): HealthLabel {
  const seeders = item.numSeeders ?? 0;
  const peers = item.numPeers ?? 0;
  const progress = item.progress || 0;
  const speed = item.downloadSpeed || 0;
  if (item.status === 'done') return 'Excellent';
  if (item.status === 'error') return 'Dead';
  // Waiting for a free download slot — not dead.
  if (item.status === 'queued') return 'Fair';
  if (item.status === 'paused') {
    if (seeders >= 20) return 'Good';
    if (seeders >= 8) return 'Fair';
    if (seeders >= 1) return 'Poor';
    return 'Dead';
  }
  // Actively transferring — never Dead regardless of seeder flag lag.
  if (speed > 0) {
    if (seeders >= 50) return 'Excellent';
    if (seeders >= 20) return 'Good';
    if (seeders >= 8) return 'Fair';
    if (seeders >= 1 || peers >= 1) return 'Fair';
    return 'Fair';
  }
  // Stalled download with no useful peers
  if (progress < 1 && seeders <= 0 && peers <= 0) return 'Dead';
  if (progress < 1 && seeders < 3) return 'Poor';
  if (seeders >= 50) return 'Excellent';
  if (seeders >= 20) return 'Good';
  if (seeders >= 8) return 'Fair';
  if (seeders >= 1) return 'Poor';
  return 'Dead';
}

function ipcMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const cut = text.split('Error: ').pop() || text;
  return cut.trim();
}

function healthClass(h: HealthLabel): string {
  switch (h) {
    case 'Excellent':
      return 'health-excellent';
    case 'Good':
      return 'health-good';
    case 'Fair':
      return 'health-fair';
    case 'Poor':
      return 'health-poor';
    default:
      return 'health-dead';
  }
}

export default function Downloads() {
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [magnet, setMagnet] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const addMagnet = async () => {
    const link = magnet.trim();
    if (!link) return;
    setAdding(true);
    setAddError(null);
    try {
      await window.torrentAPI.addManualDownload({ magnet: link });
      setMagnet('');
      setShowAdd(false);
    } catch (err) {
      setAddError(ipcMessage(err));
    } finally {
      setAdding(false);
    }
  };

  const addTorrentFile = async () => {
    setAddError(null);
    const picked = await window.torrentAPI.pickFile?.([{ name: 'Torrent', extensions: ['torrent'] }]);
    if (!picked) return;
    setAdding(true);
    try {
      await window.torrentAPI.addManualDownload({ torrentPath: picked });
      setMagnet('');
      setShowAdd(false);
    } catch (err) {
      setAddError(ipcMessage(err));
    } finally {
      setAdding(false);
    }
  };

  useEffect(() => {
    window.torrentAPI.getDownloads().then((list) => setItems(list as DownloadItem[])).catch(() => undefined);
    const off = window.torrentAPI.onDownloadsUpdate((list) => {
      setItems(list as DownloadItem[]);
    });
    return () => off();
  }, []);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Downloads</h1>
          <p>Up to 3 torrents download at once; the rest stay queued. Pause / resume / cancel anytime. Incomplete downloads resume after restart or update.</p>
        </div>
        <button className="primary" onClick={() => { setShowAdd((open) => !open); setAddError(null); }}>
          Add torrent
        </button>
      </div>

      {showAdd && (
        <div className="card" style={{ marginBottom: '1rem', padding: '0.9rem 1rem' }}>
          <div className="field">
            <label>Magnet link</label>
            <input
              value={magnet}
              placeholder="magnet:?xt=urn:btih:..."
              onChange={(e) => setMagnet(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addMagnet();
              }}
            />
          </div>
          <div className="toolbar">
            <button className="primary" disabled={adding || !magnet.trim()} onClick={() => void addMagnet()}>
              {adding ? 'Adding…' : 'Add magnet'}
            </button>
            <button disabled={adding} onClick={() => void addTorrentFile()}>
              Add torrent file
            </button>
          </div>
          <div className="hint">
            Nightfeed matches the name to a show or movie already in the library, then moves the video into that folder when the download finishes. A torrent file is deleted after that.
          </div>
          {addError && <div className="error-banner" style={{ marginTop: '0.75rem' }}>{addError}</div>}
        </div>
      )}

      {items.length === 0 ? (
        <div className="empty-state">
          <h2>Nothing in the queue</h2>
          <p>
            Open a show or movie and Download, or enable auto-download for TV in Settings.
            TV files rename to Show - SxxExx - Title; movies go under the movie library folder.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="dense">
            <thead>
              <tr>
                <th>Item</th>
                <th style={{ width: 140 }}>Progress</th>
                <th style={{ width: 100 }}>Speed</th>
                <th style={{ width: 80 }}>Seeders</th>
                <th style={{ width: 100 }}>Health</th>
                <th style={{ width: 90 }}>Status</th>
                <th style={{ width: 180 }}></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const health = torrentHealth(item);
                return (
                <tr key={item.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>
                      {item.showName}{' '}
                      {item.kind === 'movie' ? (
                        <span className="mono">Movie</span>
                      ) : (
                        <span className="mono">
                          S{pad2(item.seasonNumber)}E{pad2(item.episodeNumber)}
                        </span>
                      )}
                    </div>
                    <div style={{ color: 'var(--text-faint)', fontSize: '0.8rem' }}>
                      {item.kind === 'movie' ? (item.episodeTitle || 'Movie') : item.episodeTitle}
                    </div>
                    <div className="mono" style={{ color: 'var(--text-faint)', fontSize: '0.7rem' }}>
                      {item.savePath}
                    </div>
                    {item.error && (
                      <div style={{ color: 'var(--danger)', fontSize: '0.8rem' }}>{item.error}</div>
                    )}
                  </td>
                  <td>
                    <div className="progress" title={formatPercent(item.progress)}>
                      <span style={{ width: formatPercent(item.progress) }} />
                    </div>
                    <div className="mono" style={{ marginTop: 4, fontSize: '0.75rem' }}>
                      {formatPercent(item.progress)}
                    </div>
                  </td>
                  <td className="mono">{formatSpeed(item.downloadSpeed)}</td>
                  <td className="mono">{item.numSeeders ?? 0}</td>
                  <td>
                    <span className={`badge health ${healthClass(health)}`}>{health}</span>
                  </td>
                  <td>
                    <span className={`badge ${item.status === 'done' ? 'downloaded' : item.status === 'error' ? 'missing' : 'downloading'}`}>
                      {item.status}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div className="toolbar" style={{ justifyContent: 'flex-end' }}>
                      {item.status === 'paused' ? (
                        <button onClick={() => window.torrentAPI.resumeDownload(item.id)}>Resume</button>
                      ) : item.status === 'downloading' || item.status === 'queued' ? (
                        <button onClick={() => window.torrentAPI.pauseDownload(item.id)}>Pause</button>
                      ) : null}
                      {item.status !== 'done' && (
                        <button className="danger" onClick={() => window.torrentAPI.cancelDownload(item.id)}>
                          Cancel
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
