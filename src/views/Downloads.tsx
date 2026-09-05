import { formatPercent, formatSpeed, pad2 } from '../lib/format';
import type { DownloadItem } from '../lib/types';

export default function Downloads({ items }: { items: DownloadItem[] }) {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Downloads</h1>
          <p>In-app engine — progress, peers, pause / resume / cancel</p>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="empty-state">
          <h2>Nothing in the queue</h2>
          <p>
            Open a show and Download, or enable auto-download in Settings.
            Completed files rename to Show - SxxExx - Title in Season folders.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="dense">
            <thead>
              <tr>
                <th>Episode</th>
                <th style={{ width: 140 }}>Progress</th>
                <th style={{ width: 100 }}>Speed</th>
                <th style={{ width: 70 }}>Peers</th>
                <th style={{ width: 90 }}>Status</th>
                <th style={{ width: 180 }}></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>
                      {item.showName}{' '}
                      <span className="mono">
                        S{pad2(item.seasonNumber)}E{pad2(item.episodeNumber)}
                      </span>
                    </div>
                    <div style={{ color: 'var(--text-faint)', fontSize: '0.8rem' }}>
                      {item.episodeTitle}
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
                  <td className="mono">{item.numPeers}</td>
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
