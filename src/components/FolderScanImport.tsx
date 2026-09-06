import { useMemo, useState } from 'react';
import Poster from './Poster';

type Scope = 'tv' | 'movies' | 'both';
type MatchStatus = 'will_add' | 'already_in_library' | 'no_match' | 'ambiguous';

interface Candidate {
  id: string;
  kind: 'show' | 'movie';
  folderName: string;
  folderPath: string;
  parsedTitle: string;
  parsedYear: number | null;
  status: MatchStatus;
  note: string;
  matchId: number | null;
  matchName: string | null;
  matchYear: number | null;
  matchPoster: string | null;
  alternatives?: Array<{ id: number; name: string; year: number | null }>;
  isLooseFile?: boolean;
  selected: boolean;
}

interface Preview {
  scope: Scope;
  tvRoot: string;
  movieRoot: string;
  candidates: Candidate[];
  errors: string[];
}

interface ImportResult {
  added: number;
  skipped: number;
  failed: number;
  errors: string[];
  addedTitles: string[];
}

const STATUS_LABEL: Record<MatchStatus, string> = {
  will_add: 'Will add',
  already_in_library: 'Already in library',
  no_match: 'No metadata match',
  ambiguous: 'Ambiguous — confirm',
};

export default function FolderScanImport({
  defaultScope = 'both',
  onDone,
}: {
  defaultScope?: Scope;
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Scope>(defaultScope);
  const [phase, setPhase] = useState<'idle' | 'scanning' | 'preview' | 'importing' | 'done'>('idle');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [rows, setRows] = useState<Candidate[]>([]);
  const [summary, setSummary] = useState<ImportResult | null>(null);

  const counts = useMemo(() => {
    const c = { will_add: 0, already_in_library: 0, no_match: 0, ambiguous: 0, selected: 0 };
    for (const r of rows) {
      c[r.status] += 1;
      if (r.selected && r.matchId) c.selected += 1;
    }
    return c;
  }, [rows]);

  const openModal = () => {
    setOpen(true);
    setPhase('idle');
    setError(null);
    setPreview(null);
    setRows([]);
    setSummary(null);
    setProgress('');
    setScope(defaultScope);
  };

  const close = () => {
    if (phase === 'scanning' || phase === 'importing') return;
    setOpen(false);
  };

  const runScan = async () => {
    setError(null);
    setSummary(null);
    setPhase('scanning');
    setProgress('Scanning library folders…');
    try {
      const res = (await window.torrentAPI.scanLibraryPreview(scope)) as Preview;
      setPreview(res);
      setRows(
        (res.candidates || []).map((c) => ({
          ...c,
          selected:
            c.selected &&
            !!c.matchId &&
            (c.status === 'will_add' || c.status === 'ambiguous'),
        }))
      );
      setPhase('preview');
      if (res.errors?.length) {
        setError(res.errors.slice(0, 5).join(' · '));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('idle');
    } finally {
      setProgress('');
    }
  };

  const toggleRow = (id: string) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r;
        if (!r.matchId || r.status === 'already_in_library' || r.status === 'no_match') return r;
        return { ...r, selected: !r.selected };
      })
    );
  };

  const selectMatch = (id: string, matchId: number, name: string, year: number | null) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r;
        return {
          ...r,
          matchId,
          matchName: name,
          matchYear: year,
          status: 'will_add',
          note: `User chose “${name}”`,
          selected: true,
        };
      })
    );
  };

  const selectAllAddable = (on: boolean) => {
    setRows((prev) =>
      prev.map((r) => {
        if (!r.matchId || r.status === 'already_in_library' || r.status === 'no_match') {
          return { ...r, selected: false };
        }
        return { ...r, selected: on };
      })
    );
  };

  const confirmImport = async () => {
    const items = rows
      .filter((r) => r.selected && r.matchId)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        folderPath: r.folderPath,
        matchId: r.matchId as number,
        selected: true,
      }));
    if (!items.length) {
      setError('Select at least one matched title to import.');
      return;
    }
    setError(null);
    setPhase('importing');
    setProgress(`Importing ${items.length} item(s)…`);
    try {
      const res = (await window.torrentAPI.scanLibraryImport(items)) as ImportResult;
      setSummary(res);
      setPhase('done');
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('preview');
    } finally {
      setProgress('');
    }
  };

  return (
    <>
      <button type="button" onClick={openModal}>
        Scan folders &amp; import…
      </button>

      {open && (
        <div className="modal-backdrop" onClick={close}>
          <div
            className="modal"
            style={{ width: 'min(920px, 100%)', maxHeight: 'min(88vh, 820px)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <h2>Scan folders &amp; import</h2>
              <button className="ghost" onClick={close} disabled={phase === 'scanning' || phase === 'importing'}>
                Close
              </button>
            </header>
            <div className="body">
              <p style={{ color: 'var(--text-dim)', marginTop: 0, fontSize: '0.9rem' }}>
                Manual only — reads folder names under your library roots, matches TVMaze / IMDb,
                then adds on confirm. Files are never moved or deleted.
              </p>

              {error && <div className="error-banner">{error}</div>}

              {(phase === 'idle' || phase === 'scanning') && (
                <div className="choice-stack" style={{ marginBottom: '1rem' }}>
                  <label className="toggle-row">
                    <input
                      type="radio"
                      name="scan-scope"
                      checked={scope === 'tv'}
                      onChange={() => setScope('tv')}
                      disabled={phase === 'scanning'}
                    />
                    TV library root only
                  </label>
                  <label className="toggle-row">
                    <input
                      type="radio"
                      name="scan-scope"
                      checked={scope === 'movies'}
                      onChange={() => setScope('movies')}
                      disabled={phase === 'scanning'}
                    />
                    Movie library root only
                  </label>
                  <label className="toggle-row">
                    <input
                      type="radio"
                      name="scan-scope"
                      checked={scope === 'both'}
                      onChange={() => setScope('both')}
                      disabled={phase === 'scanning'}
                    />
                    Both TV and movies
                  </label>
                </div>
              )}

              {(phase === 'scanning' || phase === 'importing') && (
                <div className="status-line" style={{ marginBottom: '1rem' }}>
                  {progress || (phase === 'scanning' ? 'Scanning…' : 'Importing…')}
                </div>
              )}

              {phase === 'idle' && (
                <div className="toolbar">
                  <button className="primary" onClick={runScan}>
                    Scan now
                  </button>
                </div>
              )}

              {phase === 'preview' && preview && (
                <>
                  <div
                    className="toolbar"
                    style={{ marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}
                  >
                    <span style={{ color: 'var(--text-faint)', fontSize: '0.85rem' }}>
                      {rows.length} detected · {counts.will_add} will add · {counts.ambiguous}{' '}
                      ambiguous · {counts.already_in_library} already · {counts.no_match} no match
                    </span>
                    <div style={{ flex: 1 }} />
                    <button type="button" onClick={() => selectAllAddable(true)}>
                      Select all matched
                    </button>
                    <button type="button" onClick={() => selectAllAddable(false)}>
                      Clear selection
                    </button>
                    <button type="button" onClick={runScan}>
                      Rescan
                    </button>
                    <button
                      className="primary"
                      onClick={confirmImport}
                      disabled={counts.selected === 0}
                    >
                      Import selected ({counts.selected})
                    </button>
                  </div>

                  <div className="table-wrap">
                    <table className="dense">
                      <thead>
                        <tr>
                          <th style={{ width: 36 }}></th>
                          <th style={{ width: 48 }}></th>
                          <th>Folder / file</th>
                          <th>Match</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => {
                          const canSelect =
                            !!r.matchId &&
                            r.status !== 'already_in_library' &&
                            r.status !== 'no_match';
                          return (
                            <tr key={r.id}>
                              <td>
                                <input
                                  type="checkbox"
                                  checked={!!r.selected && canSelect}
                                  disabled={!canSelect}
                                  onChange={() => toggleRow(r.id)}
                                />
                              </td>
                              <td>
                                <Poster
                                  path={r.matchPoster}
                                  alt={r.matchName || r.folderName}
                                  width={36}
                                  height={54}
                                />
                              </td>
                              <td>
                                <div style={{ fontWeight: 600 }}>
                                  {r.kind === 'show' ? 'TV' : 'Movie'}: {r.folderName}
                                </div>
                                <div
                                  style={{
                                    color: 'var(--text-faint)',
                                    fontSize: '0.75rem',
                                    fontFamily: 'var(--font-mono)',
                                  }}
                                  title={r.folderPath}
                                >
                                  {r.folderPath.length > 64
                                    ? `…${r.folderPath.slice(-60)}`
                                    : r.folderPath}
                                </div>
                              </td>
                              <td>
                                <div style={{ fontWeight: 600 }}>
                                  {r.matchName || '—'}
                                  {r.matchYear ? ` (${r.matchYear})` : ''}
                                </div>
                                <div style={{ color: 'var(--text-dim)', fontSize: '0.78rem' }}>
                                  {r.note}
                                </div>
                                {r.alternatives && r.alternatives.length > 1 && (
                                  <select
                                    style={{ marginTop: 4, maxWidth: 260, fontSize: '0.8rem' }}
                                    value={r.matchId ?? ''}
                                    onChange={(e) => {
                                      const id = parseInt(e.target.value, 10);
                                      const alt = r.alternatives?.find((a) => a.id === id);
                                      if (alt) selectMatch(r.id, alt.id, alt.name, alt.year);
                                    }}
                                  >
                                    {r.alternatives.map((a) => (
                                      <option key={a.id} value={a.id}>
                                        {a.name}
                                        {a.year ? ` (${a.year})` : ''}
                                      </option>
                                    ))}
                                  </select>
                                )}
                              </td>
                              <td>
                                <span className={`scan-badge scan-${r.status}`}>
                                  {STATUS_LABEL[r.status]}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                        {rows.length === 0 && (
                          <tr>
                            <td colSpan={5} style={{ color: 'var(--text-faint)' }}>
                              No folders or video files found under the selected root(s).
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {phase === 'done' && summary && (
                <div>
                  <div className="status-line" style={{ marginBottom: '1rem' }}>
                    Added <strong>{summary.added}</strong>, skipped{' '}
                    <strong>{summary.skipped}</strong>, failed <strong>{summary.failed}</strong>
                  </div>
                  {summary.addedTitles.length > 0 && (
                    <ul style={{ marginTop: 0, color: 'var(--text-dim)', fontSize: '0.9rem' }}>
                      {summary.addedTitles.slice(0, 30).map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                      {summary.addedTitles.length > 30 && (
                        <li>…and {summary.addedTitles.length - 30} more</li>
                      )}
                    </ul>
                  )}
                  {summary.errors.length > 0 && (
                    <div className="error-banner" style={{ marginTop: '0.75rem' }}>
                      {summary.errors.slice(0, 8).join(' · ')}
                    </div>
                  )}
                  <div className="toolbar" style={{ marginTop: '1rem' }}>
                    <button className="primary" onClick={close}>
                      Done
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setPhase('idle');
                        setSummary(null);
                        setRows([]);
                        setPreview(null);
                      }}
                    >
                      Scan again
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
