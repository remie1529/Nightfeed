import { useEffect, useMemo, useState } from 'react';
import Poster from '../components/Poster';
import StatusBadge from '../components/StatusBadge';
import { epCode, formatBytes } from '../lib/format';
import type {
  Episode,
  EpisodeOverrideStatus,
  EpisodeStatus,
  Resolution,
  SearchResult,
  Show,
} from '../lib/types';

const MANUAL_STATUSES: EpisodeOverrideStatus[] = [
  'missing',
  'downloaded',
  'ignored',
  'upcoming',
];

function selectValue(status: EpisodeStatus): EpisodeOverrideStatus {
  if (status === 'downloading' || status === 'aired') return 'missing';
  return status as EpisodeOverrideStatus;
}

export default function ShowDetail({
  tmdbId,
  onBack,
  onRemoved,
}: {
  tmdbId: number;
  onBack: () => void;
  onRemoved: () => void;
}) {
  const [show, setShow] = useState<Show | null>(null);
  const [season, setSeason] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [searchEp, setSearchEp] = useState<Episode | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [statusBusy, setStatusBusy] = useState<string | null>(null);
  const [seasonBusy, setSeasonBusy] = useState(false);

  const load = async () => {
    const s = (await window.torrentAPI.getShow(tmdbId)) as Show | null;
    setShow(s);
    if (s && s.seasons.length) {
      setSeason((prev) => prev ?? s.seasons[0].seasonNumber);
    }
  };

  useEffect(() => {
    load().catch((e) => setError(e.message || String(e)));
  }, [tmdbId]);

  const currentSeason = useMemo(
    () => show?.seasons.find((s) => s.seasonNumber === season) || null,
    [show, season]
  );

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const s = (await window.torrentAPI.refreshShow(tmdbId)) as Show;
      setShow(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  const updateShow = async (partial: Partial<Show>) => {
    const s = (await window.torrentAPI.updateShow(tmdbId, partial)) as Show;
    setShow({ ...show!, ...s, seasons: show!.seasons });
  };

  const pickPath = async () => {
    const folder = await window.torrentAPI.pickLibraryFolder();
    if (folder) await updateShow({ libraryPath: folder });
  };

  const changeStatus = async (ep: Episode, status: EpisodeOverrideStatus) => {
    const key = `${ep.seasonNumber}:${ep.episodeNumber}`;
    setStatusBusy(key);
    setError(null);
    try {
      const s = (await window.torrentAPI.setEpisodeStatus(
        tmdbId,
        ep.seasonNumber,
        ep.episodeNumber,
        status
      )) as Show;
      setShow(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStatusBusy(null);
    }
  };

  const changeSeasonStatus = async (status: EpisodeOverrideStatus) => {
    if (season == null) return;
    const seasonObj = show?.seasons.find((s) => s.seasonNumber === season);
    const count = seasonObj?.episodes?.length || 0;
    if (!count) return;
    const label = status.charAt(0).toUpperCase() + status.slice(1);
    if (!window.confirm(`Set all ${count} episode(s) in Season ${season} to ${label}?`)) {
      return;
    }
    setSeasonBusy(true);
    setError(null);
    try {
      const s = (await window.torrentAPI.setSeasonStatus(tmdbId, season, status)) as Show;
      setShow(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSeasonBusy(false);
    }
  };

  const openSearch = async (ep: Episode) => {
    setSearchEp(ep);
    setResults([]);
    setSearchError(null);
    setSearchQuery('');
    setSearching(true);
    try {
      const res = (await window.torrentAPI.searchTorrents(
        tmdbId,
        ep.seasonNumber,
        ep.episodeNumber
      )) as { results: SearchResult[]; query: string; error?: string };
      setResults(res.results || []);
      setSearchQuery(res.query || '');
      if (res.error) setSearchError(res.error);
      else if (!res.results?.length) setSearchError('No results found for this episode.');
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  };

  const startDownload = async (result: SearchResult) => {
    if (!searchEp) return;
    setStarting(result.magnet);
    setSearchError(null);
    try {
      await window.torrentAPI.startDownload({
        tmdbId,
        season: searchEp.seasonNumber,
        episode: searchEp.episodeNumber,
        episodeTitle: searchEp.name,
        magnet: result.magnet,
        candidates: results.map((r) => ({
          magnet: r.magnet,
          infoHash: r.infoHash,
          title: r.title,
        })),
      });
      setSearchEp(null);
      await refresh();
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(null);
    }
  };

  const remove = async () => {
    await window.torrentAPI.removeShow(tmdbId);
    onRemoved();
  };

  if (!show) {
    return (
      <div className="page">
        <button className="ghost" onClick={onBack}>← Library</button>
        <p style={{ color: 'var(--text-dim)' }}>{error || 'Loading…'}</p>
      </div>
    );
  }

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <div className="toolbar" style={{ marginBottom: '1rem' }}>
        <button className="ghost" onClick={onBack}>← Library</button>
        <div style={{ flex: 1 }} />
        <button onClick={refresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh metadata'}
        </button>
        <button className="danger" onClick={remove}>Remove</button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: '1.35rem' }}>
        <Poster path={show.posterPath} alt={show.name} width={180} height={270} />
        <div>
          <h1 style={{ margin: '0 0 0.35rem', fontSize: '1.7rem' }}>{show.name}</h1>
          <div style={{ color: 'var(--text-dim)', marginBottom: '0.85rem' }}>
            {show.status}
            {show.firstAirDate ? ` · since ${show.firstAirDate.slice(0, 4)}` : ''}
            {show.lastRefreshedAt
              ? ` · refreshed ${new Date(show.lastRefreshedAt).toLocaleString()}`
              : ''}
          </div>
          <p style={{ color: 'var(--text-dim)', maxWidth: 680 }}>{show.overview}</p>

          <div className="form-grid" style={{ marginTop: '1.25rem', maxWidth: 520 }}>
            <div className="field">
              <label>Preferred resolution</label>
              <select
                value={show.preferredResolution || ''}
                onChange={(e) =>
                  updateShow({
                    preferredResolution: (e.target.value || undefined) as Resolution | undefined,
                  })
                }
              >
                <option value="">Use global default</option>
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
                <option value="2160p">2160p</option>
              </select>
            </div>
            <div className="field">
              <label>Library path override</label>
              <div className="row">
                <input
                  value={show.libraryPath || ''}
                  placeholder="Default: {library root}/{show name}"
                  onChange={(e) => setShow({ ...show, libraryPath: e.target.value })}
                  onBlur={() => updateShow({ libraryPath: show.libraryPath || '' })}
                />
                <button onClick={pickPath}>Browse</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="toolbar" style={{ marginTop: '1.75rem', marginBottom: '0.75rem' }}>
        {show.seasons.map((s) => (
          <button
            key={s.seasonNumber}
            className={season === s.seasonNumber ? 'primary' : ''}
            onClick={() => setSeason(s.seasonNumber)}
          >
            Season {s.seasonNumber}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {season != null && (
          <label className="season-bulk" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--text-faint)', fontSize: '0.8rem' }}>
              Set all in season
            </span>
            <select
              disabled={seasonBusy || !(currentSeason?.episodes?.length)}
              defaultValue=""
              key={`bulk-${season}-${show.lastRefreshedAt || ''}-${currentSeason?.episodes?.length || 0}`}
              onChange={(e) => {
                const v = e.target.value as EpisodeOverrideStatus | '';
                e.target.value = '';
                if (v) void changeSeasonStatus(v);
              }}
              title="Set status for every episode in this season"
            >
              <option value="" disabled>
                {seasonBusy ? 'Updating…' : 'Choose status…'}
              </option>
              {MANUAL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="table-wrap">
        <table className="dense">
          <thead>
            <tr>
              <th style={{ width: 72 }}>Ep</th>
              <th>Title</th>
              <th style={{ width: 110 }}>Air date</th>
              <th style={{ width: 150 }}>Status</th>
              <th style={{ width: 110 }}></th>
            </tr>
          </thead>
          <tbody>
            {(currentSeason?.episodes || []).map((ep) => {
              const busyKey = `${ep.seasonNumber}:${ep.episodeNumber}`;
              const derived = ep.status === 'downloading';
              return (
                <tr key={ep.id}>
                  <td className="mono">{epCode(ep.seasonNumber, ep.episodeNumber)}</td>
                  <td>
                    <div style={{ fontWeight: 560 }}>{ep.name}</div>
                    {ep.localPath && (
                      <div className="mono" style={{ color: 'var(--text-faint)', fontSize: '0.72rem' }}>
                        {ep.localPath}
                      </div>
                    )}
                  </td>
                  <td className="mono">{ep.airDate || '—'}</td>
                  <td>
                    <div className="status-cell">
                      {derived ? (
                        <StatusBadge status={ep.status} />
                      ) : (
                        <select
                          className={`status-select status-${ep.status}`}
                          value={selectValue(ep.status)}
                          disabled={statusBusy === busyKey}
                          onChange={(e) =>
                            changeStatus(ep, e.target.value as EpisodeOverrideStatus)
                          }
                          title="Change episode status (persists across refresh)"
                        >
                          {MANUAL_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {s.charAt(0).toUpperCase() + s.slice(1)}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div className="toolbar" style={{ justifyContent: 'flex-end', gap: 6 }}>
                      {ep.status === 'downloaded' && (
                        <button
                          onClick={() => openSearch(ep)}
                          title="See all available torrents and download a different copy"
                        >
                          Get other
                        </button>
                      )}
                      <button
                        disabled={ep.status === 'upcoming' || ep.status === 'downloaded'}
                        onClick={() => openSearch(ep)}
                        title={
                          ep.status === 'upcoming'
                            ? 'Not aired yet'
                            : ep.status === 'ignored'
                              ? 'Find download (ignored — auto-download skipped)'
                              : 'Find download'
                        }
                      >
                        Get
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!currentSeason?.episodes?.length && (
              <tr>
                <td colSpan={5} style={{ color: 'var(--text-faint)', textAlign: 'center' }}>
                  No episodes in this season.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {searchEp && (
        <div className="modal-backdrop" onClick={() => setSearchEp(null)}>
          <div className="modal torrent-pick" onClick={(e) => e.stopPropagation()}>
            <header>
              <h2>
                Find · {show.name} {epCode(searchEp.seasonNumber, searchEp.episodeNumber)}
              </h2>
              <button className="ghost" onClick={() => setSearchEp(null)}>Close</button>
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
