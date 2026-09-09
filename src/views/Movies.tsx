import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Poster from '../components/Poster';
import type { Movie, TmdbMovieSearchItem } from '../lib/types';
import FolderScanImport from '../components/FolderScanImport';

let moviesCache: Movie[] = [];

export default function Movies({
  onOpenMovie,
  onRefreshDone,
  refreshToken = 0,
}: {
  onOpenMovie: (movie: Movie) => void;
  onRefreshDone: () => void;
  refreshToken?: number;
}) {
  const [movies, setMovies] = useState<Movie[]>(() => moviesCache);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<TmdbMovieSearchItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(!moviesCache.length);
  const loadGen = useRef(0);

  const load = useCallback(async (opts?: { soft?: boolean }) => {
    const gen = ++loadGen.current;
    if (!opts?.soft && !moviesCache.length) setLoading(true);
    try {
      const list = (await window.torrentAPI.getMovies()) as Movie[];
      if (gen !== loadGen.current) return;
      const next = Array.isArray(list) ? list : [];
      moviesCache = next;
      setMovies(next);
      setError(null);
    } catch (e) {
      if (gen !== loadGen.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (gen === loadGen.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load({ soft: moviesCache.length > 0 });
  }, [load, refreshToken]);

  useEffect(() => {
    const off = window.torrentAPI.onMoviesChanged?.(() => {
      void load({ soft: true });
    });
    return () => off?.();
  }, [load]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return movies;
    return movies.filter((m) => m.title.toLowerCase().includes(q));
  }, [movies, filter]);

  const doSearch = async () => {
    setError(null);
    setSearching(true);
    try {
      const res = (await window.torrentAPI.searchMovies(query)) as TmdbMovieSearchItem[];
      setResults(res);
      if (res.length === 0) setError('No movies found. Try a different query.');
    } catch (e) {
      setResults([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  };

  const addMovie = async (id: number) => {
    setBusyId(id);
    setError(null);
    try {
      const movie = (await window.torrentAPI.addMovie(id)) as Movie;
      setResults([]);
      setQuery('');
      await load();
      onOpenMovie(movie);
      onRefreshDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Movies</h1>
          <p>{movies.length} movie{movies.length === 1 ? '' : 's'} tracked</p>
        </div>
        <div className="toolbar">
          <FolderScanImport defaultScope="movies" onDone={() => { void load(); onRefreshDone(); }} />
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="toolbar" style={{ marginBottom: '1.25rem' }}>
        <input
          style={{ maxWidth: 360 }}
          placeholder="Search IMDb to add a movie…"
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
          placeholder="Filter movies…"
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
                <th>Movie</th>
                <th>Year</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Poster path={r.posterUrl} alt={r.title} width={40} height={60} />
                  </td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{r.title}</div>
                    <div style={{ color: 'var(--text-faint)', fontSize: '0.8rem' }}>
                      {(r.overview || '').slice(0, 120)}
                      {(r.overview || '').length > 120 ? '…' : ''}
                    </div>
                  </td>
                  <td className="mono">{r.releaseYear || '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="primary"
                      disabled={busyId === r.id || movies.some((m) => m.tmdbId === r.id)}
                      onClick={() => addMovie(r.id)}
                    >
                      {movies.some((m) => m.tmdbId === r.id)
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

      {loading && movies.length === 0 ? (
        <div className="poster-grid" aria-busy="true" aria-label="Loading movies">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="poster-card skeleton-card">
              <div className="skeleton-poster" />
              <div className="skeleton-line" />
              <div className="skeleton-line short" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <h2>No movies yet</h2>
          <p>
            Search IMDb above to add a movie. Set a movie library folder in Settings first (separate from TV).
          </p>
        </div>
      ) : (
        <div className="poster-grid">
          {filtered.map((movie) => (
            <button
              key={movie.tmdbId}
              className="poster-card"
              onClick={() => onOpenMovie(movie)}
            >
              <Poster path={movie.posterPath} alt={movie.title} width={140} height={210} />
              <div>
                <div style={{ fontWeight: 650, lineHeight: 1.25 }}>{movie.title}</div>
                <div style={{ color: 'var(--text-faint)', fontSize: '0.75rem', marginTop: 4 }}>
                  {movie.releaseYear || '—'}
                  {movie.status ? ` · ${movie.status}` : ''}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
