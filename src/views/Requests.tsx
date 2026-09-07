import { useCallback, useEffect, useState } from 'react';
import Poster from '../components/Poster';
import type { TelegramRequest } from '../lib/types';

function formatWhen(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function requesterLabel(r: TelegramRequest): string {
  if (r.source === 'web' || !r.requesterChatId) return 'Web';
  if (r.requesterName) return `${r.requesterName} (tg:${r.requesterChatId})`;
  return `tg:${r.requesterChatId}`;
}

export default function Requests({ refreshToken }: { refreshToken: number }) {
  const [items, setItems] = useState<TelegramRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = (await window.torrentAPI.listRequests()) as TelegramRequest[];
      setItems(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load, refreshToken]);

  useEffect(() => {
    const off = window.torrentAPI.onRequestsChanged?.(() => {
      void load();
    });
    const timer = setInterval(() => void load(), 15000);
    return () => {
      off?.();
      clearInterval(timer);
    };
  }, [load]);

  const resolve = async (id: string, action: 'approved' | 'denied') => {
    setBusyId(id);
    setError(null);
    try {
      const result = await window.torrentAPI.resolveRequest(id, action);
      if (!result?.ok) {
        setError(result?.message || 'Action failed');
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const pending = items
    .filter((r) => r.status === 'pending')
    .slice()
    .reverse();
  const recent = items
    .filter((r) => r.status !== 'pending')
    .slice()
    .reverse()
    .slice(0, 40);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Requests</h1>
          <p>Approve or deny movie &amp; TV requests from Telegram and the web portal</p>
        </div>
        <div className="toolbar">
          <button onClick={() => void load()} disabled={loading}>
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="msg err" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      <section className="card" style={{ marginBottom: '1.25rem' }}>
        <div style={{ fontWeight: 600, marginBottom: '0.75rem' }}>
          Pending{pending.length ? ` (${pending.length})` : ''}
        </div>
        {loading && !items.length ? (
          <div className="hint">Loading…</div>
        ) : pending.length === 0 ? (
          <div className="hint">No pending requests.</div>
        ) : (
          <div className="request-list">
            {pending.map((r) => (
              <div key={r.id} className="request-row">
                <Poster path={r.posterUrl || null} alt={r.title} width={48} height={72} />
                <div className="request-body">
                  <div className="request-title">
                    {r.mediaType === 'movie' ? 'Movie' : 'TV'}: {r.title}
                    {r.year ? ` (${r.year})` : ''}
                  </div>
                  <div className="request-meta">
                    <span className="badge pending">{r.status}</span>
                    <span>{r.source === 'web' ? 'web' : 'telegram'}</span>
                    <span>{requesterLabel(r)}</span>
                    <span className="mono">{r.id}</span>
                    <span>{formatWhen(r.createdAt)}</span>
                  </div>
                  {r.overview ? (
                    <div className="request-overview">{r.overview.slice(0, 180)}</div>
                  ) : null}
                </div>
                <div className="request-actions">
                  <button
                    className="ok-btn"
                    disabled={busyId === r.id}
                    onClick={() => void resolve(r.id, 'approved')}
                  >
                    Approve
                  </button>
                  <button
                    className="danger"
                    disabled={busyId === r.id}
                    onClick={() => void resolve(r.id, 'denied')}
                  >
                    Deny
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div style={{ fontWeight: 600, marginBottom: '0.75rem' }}>Recent</div>
        {recent.length === 0 ? (
          <div className="hint">No recent decisions yet.</div>
        ) : (
          <div className="request-list">
            {recent.map((r) => (
              <div key={r.id} className="request-row">
                <Poster path={r.posterUrl || null} alt={r.title} width={40} height={60} />
                <div className="request-body">
                  <div className="request-title">
                    {r.mediaType === 'movie' ? 'Movie' : 'TV'}: {r.title}
                    {r.year ? ` (${r.year})` : ''}
                  </div>
                  <div className="request-meta">
                    <span className={`badge ${r.status}`}>{r.status}</span>
                    <span>{r.source === 'web' ? 'web' : 'telegram'}</span>
                    <span>{requesterLabel(r)}</span>
                    <span className="mono">{r.id}</span>
                    <span>{formatWhen(r.resolvedAt || r.createdAt)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
