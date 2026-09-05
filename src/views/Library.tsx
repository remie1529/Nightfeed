import { useEffect, useMemo, useState } from 'react';
import Poster from '../components/Poster';
import type { AddShowPolicy, Show, MazeSearchItem } from '../lib/types';

export default function Library({
  onOpenShow,
  onRefreshDone,
}: {
  onOpenShow: (show: Show) => void;
  onRefreshDone: () => void;
}) {
  const [shows, setShows] = useState<Show[]>([]);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<MazeSearchItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('');
  const [pendingAdd, setPendingAdd] = useState<MazeSearchItem | null>(null);

  const load = async () => {
    const list = (await window.torrentAPI.getShows()) as Show[];
    setShows(list);
  };

  useEffect(() => {
    load().catch((e) => setError(e.message || String(e)));
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return shows;
    return shows.filter((s) => s.name.toLowerCase().includes(q));
  }, [shows, filter]);

  const doSearch = async () => {
    setError(null);
    setSearching(true);
    try {
      const res = (await window.torrentAPI.searchShows(query)) as MazeSearchItem[];
      setResults(res);
      if (res.length === 0) setError('No shows found. Try a different query.');
    } catch (e) {
      setResults([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  };

  const confirmAdd = async (policy: AddShowPolicy) => {
    if (!pendingAdd) return;
    const id = pendingAdd.id;
    setBusyId(id);
    setError(null);
    setPendingAdd(null);
    try {
      const show = (await window.torrentAPI.addShow(id, policy)) as Show;
      setResults([]);
      setQuery('');
      await load();
      onOpenShow(show);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const refreshAll = async () => {
    setRefreshing(true);
    setError(null);
    try {
      await window.torrentAPI.refreshAll();
      await load();
      onRefreshDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Library</h1>
          <p>{shows.length} show{shows.length === 1 ? '' : 's'} tracked</p>
        </div>
        <div className="toolbar">
          <button onClick={refreshAll} disabled={refreshing || shows.length === 0}>
            {refreshing ? 'Refreshing…' : 'Check new episodes'}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="toolbar" style={{ marginBottom: '1.25rem' }}>
        <input
          style={{ maxWidth: 360 }}
          placeholder="Search TVMaze to add a show…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doSearch()}
        />
        <button className="primary" onClick={doSearch} disabled={searching || !query.trim()}>
          {searching ? 'Searching…' : 'Search'}
        </button>
        <div style={{ flex: 1 }} />
        <input
          style={{ maxWidth: 220 }}
          placeholder="Filter library…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {results.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: '1.5rem' }}>
          <table className="dense">
            <thead>
              <tr>
                <th style={{ width: 56 }}></th>
                <th>Show</th>
                <th>First aired</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Poster path={r.posterUrl} alt={r.name} width={40} height={60} />
                  </td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{r.name}</div>
                    <div style={{ color: 'var(--text-faint)', fontSize: '0.8rem' }}>
                      {(r.overview || '').slice(0, 120)}
                      {(r.overview || '').length > 120 ? '…' : ''}
                    </div>
                  </td>
                  <td className="mono">{r.firstAirDate || '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="primary"
                      disabled={busyId === r.id || shows.some((s) => s.tmdbId === r.id)}
                      onClick={() => setPendingAdd(r)}
                    >
                      {shows.some((s) => s.tmdbId === r.id)
                        ? 'Added'
                        : busyId === r.id
                          ? 'Adding…'
                          : 'Add'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="empty-state">
          <h2>No shows yet</h2>
          <p>
            Search TVMaze above to add a series — no API key required.
            Then set your library folder in Settings.
          </p>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))',
            gap: '1.1rem',
          }}
        >
          {filtered.map((show) => {
            const missing = show.seasons
              .flatMap((s) => s.episodes)
              .filter((e) => e.status === 'missing').length;
            return (
              <button
                key={show.tmdbId}
                onClick={() => onOpenShow(show)}
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)',
                  padding: '0.65rem',
                  textAlign: 'left',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.55rem',
                }}
              >
                <Poster path={show.posterPath} alt={show.name} width={140} height={210} />
                <div>
                  <div style={{ fontWeight: 650, lineHeight: 1.25 }}>{show.name}</div>
                  <div style={{ color: 'var(--text-faint)', fontSize: '0.75rem', marginTop: 4 }}>
                    {show.status}
                    {missing ? ` · ${missing} missing` : ''}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {pendingAdd && (
        <div className="modal-backdrop" onClick={() => setPendingAdd(null)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <header>
              <h2>Add {pendingAdd.name}</h2>
              <button className="ghost" onClick={() => setPendingAdd(null)}>Close</button>
            </header>
            <div className="body">
              <p style={{ color: 'var(--text-dim)', marginTop: 0 }}>
                What should we do with episodes that already aired?
              </p>
              <div className="choice-stack">
                <button
                  className="choice-card"
                  onClick={() => confirmAdd('all')}
                  disabled={busyId === pendingAdd.id}
                >
                  <strong>Download all missing</strong>
                  <span>
                    Past aired episodes stay wanted / missing and queue for auto-download.
                  </span>
                </button>
                <button
                  className="choice-card"
                  onClick={() => confirmAdd('future')}
                  disabled={busyId === pendingAdd.id}
                >
                  <strong>Only future episodes</strong>
                  <span>
                    Mark already-aired episodes as Ignored so auto-download skips them.
                  </span>
                </button>
                <button
                  className="choice-card"
                  onClick={() => confirmAdd('manual')}
                  disabled={busyId === pendingAdd.id}
                >
                  <strong>I&apos;ll choose manually</strong>
                  <span>
                    Add the show with computed statuses — tweak Ignored / Missing per episode later.
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
