import { useEffect, useState } from 'react';
import Poster from '../components/Poster';
import StatusBadge from '../components/StatusBadge';
import { formatBytes } from '../lib/format';
import type { Movie, MovieStatus, Resolution, SearchResult } from '../lib/types';

export default function MovieDetail({
  tmdbId,
  onBack,
  onRemoved,
}: {
  tmdbId: number;
  onBack: () => void;
  onRemoved: () => void;
}) {
  const [movie, setMovie] = useState<Movie | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [showSearch, setShowSearch] = useState(false);

  const load = async () => {
    const m = (await window.torrentAPI.getMovie(tmdbId)) as Movie | null;
    setMovie(m);
  };

  useEffect(() => {
    load().catch((e) => setError(e.message || String(e)));
  }, [tmdbId]);

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const m = (await window.torrentAPI.refreshMovie(tmdbId)) as Movie;
      setMovie(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  const updateMovie = async (partial: Partial<Movie>) => {
    const m = (await window.torrentAPI.updateMovie(tmdbId, partial)) as Movie;
    setMovie(m);
  };

  const openSearch = async () => {
    setShowSearch(true);
    setResults([]);
    setSearchError(null);
    setSearchQuery('');
    setSearching(true);
    try {
      const res = (await window.torrentAPI.searchMovieTorrents(tmdbId)) as {
        results: SearchResult[];
        query: string;
        error?: string;
      };
      setResults(res.results || []);
      setSearchQuery(res.query || '');
      if (res.error) setSearchError(res.error);
      else if (!res.results?.length) setSearchError('No results found for this movie.');
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  };

  const startDownload = async (result: SearchResult) => {
    setStarting(result.magnet);
    setSearchError(null);
    try {
      await window.torrentAPI.startMovieDownload({
        tmdbId,
        magnet: result.magnet,
        candidates: results.map((r) => ({
          magnet: r.magnet,
          infoHash: r.infoHash,
          title: r.title,
        })),
      });
      setShowSearch(false);
      await refresh();
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(null);
    }
  };

  const downloadBest = async () => {
    setSearching(true);
    setError(null);
    try {
      const res = (await window.torrentAPI.searchMovieTorrents(tmdbId)) as {
        results: SearchResult[];
        query: string;
        error?: string;
      };
      if (!res.results?.length) {
        setError(res.error || 'No torrents found for preferred resolution.');
        return;
      }
      await window.torrentAPI.startMovieDownload({
        tmdbId,
        magnet: res.results[0].magnet,
        candidates: res.results.map((r) => ({
          magnet: r.magnet,
          infoHash: r.infoHash,
          title: r.title,
        })),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  };

  const remove = async () => {
    await window.torrentAPI.removeMovie(tmdbId);
    onRemoved();
  };

  if (!movie) {
    return (
      <div className="page">
        <button className="ghost" onClick={onBack}>← Movies</button>
        <p style={{ color: 'var(--text-dim)' }}>{error || 'Loading…'}</p>
      </div>
    );
  }

  const statusLabel = (movie.status || 'missing') as MovieStatus;

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <div className="toolbar" style={{ marginBottom: '1rem' }}>
        <button className="ghost" onClick={onBack}>← Movies</button>
        <div style={{ flex: 1 }} />
        <button onClick={refresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
        <button className="danger" onClick={remove}>Remove</button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: '1.35rem' }}>
        <Poster path={movie.posterPath} alt={movie.title} width={180} height={270} />
        <div>
          <h1 style={{ margin: '0 0 0.35rem', fontSize: '1.7rem' }}>{movie.title}</h1>
          <div style={{ color: 'var(--text-dim)', marginBottom: '0.85rem', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <StatusBadge status={statusLabel} />
            {movie.releaseYear ? <span>{movie.releaseYear}</span> : null}
            {movie.runtime ? <span>{movie.runtime} min</span> : null}
            {movie.lastRefreshedAt
              ? <span>refreshed {new Date(movie.lastRefreshedAt).toLocaleString()}</span>
              : null}
          </div>
          <p style={{ color: 'var(--text-dim)', maxWidth: 680 }}>{movie.overview}</p>

          {movie.localPath && (
            <div className="mono" style={{ color: 'var(--text-faint)', fontSize: '0.8rem', marginTop: 8 }}>
              {movie.localPath}
            </div>
          )}

          <div className="form-grid" style={{ marginTop: '1.25rem', maxWidth: 520 }}>
            <div className="field">
              <label>Preferred resolution</label>
              <select
                value={movie.preferredResolution || ''}
                onChange={(e) =>
                  updateMovie({
                    preferredResolution: (e.target.value || undefined) as Resolution | undefined,
                  })
                }
              >
                <option value="">Use global movie default</option>
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
                <option value="2160p">2160p</option>
              </select>
            </div>
          </div>

          <div className="toolbar" style={{ marginTop: '1.25rem' }}>
            <button
              className="primary"
              disabled={movie.status === 'downloaded' || movie.status === 'downloading' || searching}
              onClick={downloadBest}
            >
              {searching ? 'Searching…' : 'Download best'}
            </button>
            {movie.status === 'downloaded' && (
              <button onClick={openSearch} title="See all available torrents">
                Get other
              </button>
            )}
            <button
              disabled={movie.status === 'downloaded' || movie.status === 'downloading'}
              onClick={openSearch}
            >
              Get…
            </button>
          </div>
        </div>
      </div>

      {showSearch && (
        <div className="modal-backdrop" onClick={() => setShowSearch(false)}>
          <div className="modal torrent-pick" onClick={(e) => e.stopPropagation()}>
            <header>
              <h2>
                Find · {movie.title}
                {movie.releaseYear ? ` (${movie.releaseYear})` : ''}
              </h2>
              <button className="ghost" onClick={() => setShowSearch(false)}>Close</button>
            </header>
            <div className="body">
              {searchQuery && (
                <p style={{ color: 'var(--text-dim)', marginTop: 0 }}>
                  Query: <span className="mono">{searchQuery}</span>
                </p>
              )}
              {searchError && <div className="error-banner">{searchError}</div>}
              {searching ? (
                <p style={{ color: 'var(--text-dim)' }}>Searching indexers…</p>
              ) : (
                <div className="table-wrap">
                  <table className="dense">
                    <colgroup>
                      <col />
                      <col className="col-res" />
                      <col className="col-size" />
                      <col className="col-seeds" />
                      <col className="col-action" />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>Title</th>
                        <th>Res</th>
                        <th>Size</th>
                        <th>Seeds</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.map((r) => (
                        <tr key={r.magnet}>
                          <td>
                            <div className="torrent-title" style={{ fontWeight: 520 }} title={r.title}>
                              {r.title}
                            </div>
                            <div style={{ color: 'var(--text-faint)', fontSize: '0.72rem' }}>
                              {r.source}
                            </div>
                          </td>
                          <td className="mono">{r.resolution || '—'}</td>
                          <td className="mono">{formatBytes(r.size)}</td>
                          <td className="mono">{r.seeders}</td>
                          <td style={{ textAlign: 'right' }}>
                            <button
                              className="primary"
                              disabled={starting === r.magnet}
                              onClick={() => startDownload(r)}
                            >
                              {starting === r.magnet ? 'Starting…' : 'Download'}
                            </button>
                          </td>
                        </tr>
                      ))}
                      {!results.length && !searchError && (
                        <tr>
                          <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-faint)' }}>
                            No results
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
