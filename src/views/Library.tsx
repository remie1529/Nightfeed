import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Poster from '../components/Poster';
import type { AddShowPolicy, MazeSearchItem, ShowListItem } from '../lib/types';
import FolderScanImport from '../components/FolderScanImport';

export default function Library({
  onOpenShow,
  onRefreshDone,
  refreshToken = 0,
}: {
  onOpenShow: (tmdbId: number) => void;
  onRefreshDone: () => void;
  refreshToken?: number;
}) {
  const [shows, setShows] = useState<ShowListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<MazeSearchItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('');
  const [missingOnly, setMissingOnly] = useState(false);
  const [pendingAdd, setPendingAdd] = useState<MazeSearchItem | null>(null);
  const loadGen = useRef(0);
  const hasShowsRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (opts?: { soft?: boolean }) => {
    const gen = ++loadGen.current;
    if (!opts?.soft && !hasShowsRef.current) {
      setLoading(true);
    }
    try {
      const list = (await window.torrentAPI.getShows()) as ShowListItem[];
      if (gen !== loadGen.current) return;
      const next = Array.isArray(list) ? list : [];
      hasShowsRef.current = next.length > 0;
      setShows(next);
      setError(null);
    } catch (e) {
      if (gen !== loadGen.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (gen === loadGen.current) setLoading(false);
    }
  }, []);

  const scheduleLoad = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void load({ soft: true });
    }, 180);
  }, [load]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  useEffect(() => {
    const off = window.torrentAPI.onLibraryChanged?.(() => scheduleLoad());
    return () => {
      off?.();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [scheduleLoad]);

  const filtered = useMemo(() => {
    let list = shows;
    if (missingOnly) list = list.filter((s) => (s.missingCount || 0) > 0);
    const q = filter.trim().toLowerCase();
    if (q) list = list.filter((s) => s.name.toLowerCase().includes(q));
    return list;
  }, [shows, filter, missingOnly]);

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
      const show = (await window.torrentAPI.addShow(id, policy)) as { tmdbId: number };
      setResults([]);
      setQuery('');
      await load({ soft: true });
      onOpenShow(show.tmdbId);
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
      await load({ soft: true });
      onRefreshDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  const showEmpty = !loading && filtered.length === 0;
  const showSkeleton = loading && shows.length === 0;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Library</h1>
          <p>
            {loading && shows.length === 0
              ? 'Loading…'
              : missingOnly
                ? `${filtered.length} of ${shows.length} with missing episodes`
                : `${shows.length} show${shows.length === 1 ? '' : 's'} tracked`}
            {loading && shows.length > 0 ? ' · refreshing…' : ''}
          </p>
        </div>
        <div className="toolbar">
          <FolderScanImport
            defaultScope="tv"
            onDone={() => {
              void load({ soft: true });
              onRefreshDone();
            }}
          />
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
        <button
          type="button"
          className={missingOnly ? 'primary' : ''}
          onClick={() => setMissingOnly((v) => !v)}
          title="Show only series that still have missing episodes"
        >
          Missing episodes
        </button>
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

      {showSkeleton ? (
        <div className="poster-grid" aria-busy="true" aria-label="Loading library">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="poster-card skeleton-card">
              <div className="skeleton-poster" />
              <div className="skeleton-line" />
              <div className="skeleton-line short" />
            </div>
          ))}
        </div>
      ) : showEmpty ? (
        <div className="empty-state">
          <h2>
            {shows.length === 0
              ? 'No shows yet'
              : missingOnly
                ? 'No shows with missing episodes'
                : 'No matching shows'}
          </h2>
          <p>
            {shows.length === 0
              ? 'Search TVMaze above to add a series — no API key required. Then set your library folder in Settings.'
              : missingOnly
                ? 'Every tracked show is complete, or aired episodes are marked ignored.'
                : 'Try a different filter.'}
          </p>
        </div>
      ) : (
        <div className="poster-grid">
          {filtered.map((show) => {
            const missing = show.missingCount || 0;
            return (
              <button
                key={show.tmdbId}
                className="poster-card"
                onClick={() => onOpenShow(show.tmdbId)}
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
