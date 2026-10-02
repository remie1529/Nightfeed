import { useEffect, useMemo, useState } from 'react';
import Poster from '../components/Poster';
import type { UpcomingItem } from '../lib/types';

type Filter = 'all' | 'show' | 'movie';

function formatDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function Upcoming({
  onOpenShow,
  onOpenMovie,
}: {
  onOpenShow: (id: number) => void;
  onOpenMovie: (id: number) => void;
}) {
  const [items, setItems] = useState<UpcomingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    window.torrentAPI
      .getUpcoming()
      .then((feed: { items?: UpcomingItem[]; error?: string }) => {
        if (cancelled) return;
        setItems(Array.isArray(feed?.items) ? feed.items : []);
        setError(feed?.error ? String(feed.error) : null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setItems([]);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(
    () => (filter === 'all' ? items : items.filter((item) => item.kind === filter)),
    [items, filter]
  );

  const sections = useMemo(() => {
    const english = visible.filter((item) => item.english);
    const other = visible.filter((item) => !item.english);
    const group = (list: UpcomingItem[]) => {
      const map = new Map<string, UpcomingItem[]>();
      for (const item of list) {
        const bucket = map.get(item.date);
        if (bucket) bucket.push(item);
        else map.set(item.date, [item]);
      }
      return Array.from(map.entries());
    };
    return [
      { id: 'english', label: 'English', days: group(english) },
      { id: 'other', label: 'Other languages', days: group(other) },
    ].filter((section) => section.days.length > 0);
  }, [visible]);

  const showCount = items.filter((item) => item.kind === 'show').length;
  const movieCount = items.length - showCount;

  const markInLibrary = (item: UpcomingItem) => {
    setItems((prev) =>
      prev.map((row) =>
        row.kind === item.kind && row.id === item.id ? { ...row, inLibrary: true } : row
      )
    );
  };

  const add = async (item: UpcomingItem) => {
    const key = `${item.kind}:${item.id}`;
    setBusyKey(key);
    setActionError(null);
    try {
      if (item.kind === 'show') await window.torrentAPI.addShow(item.id, 'future');
      else await window.torrentAPI.addMovie(item.id);
      markInLibrary(item);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  };

  const open = (item: UpcomingItem) => {
    if (!item.inLibrary) return;
    if (item.kind === 'show') onOpenShow(item.id);
    else onOpenMovie(item.id);
  };

  return (
    <div className="page page-wide">
      <div className="page-header">
        <div>
          <h1>Upcoming</h1>
          <p>
            New series and movies opening in the next 90 days, in any language. English is listed first.
            {loading
              ? ' Loading…'
              : ` ${showCount} series · ${movieCount} movie${movieCount === 1 ? '' : 's'}.`}
          </p>
        </div>
        <div className="toolbar">
          <button type="button" className={filter === 'all' ? 'primary' : ''} onClick={() => setFilter('all')}>
            All
          </button>
          <button type="button" className={filter === 'show' ? 'primary' : ''} onClick={() => setFilter('show')}>
            TV shows
          </button>
          <button type="button" className={filter === 'movie' ? 'primary' : ''} onClick={() => setFilter('movie')}>
            Movies
          </button>
        </div>
      </div>

      {error && (
        <div className="error-banner">
          {items.length ? `Part of this list could not be loaded. ${error}` : error}
        </div>
      )}
      {actionError && <div className="error-banner">{actionError}</div>}

      {loading && (
        <div className="empty-state">
          <h2>Loading new premieres</h2>
          <p>Checking schedules for series and movies that have not opened yet. The first open can take a few seconds.</p>
        </div>
      )}

      {!loading && visible.length === 0 && (
        <div className="empty-state">
          <h2>Nothing coming up</h2>
          <p>
            {items.length
              ? 'Nothing in this filter for the next 90 days.'
              : 'No new series or movies turned up for the next 90 days.'}
          </p>
        </div>
      )}

      {!loading &&
        sections.map((section) => (
          <section key={section.id} className="upcoming-lang">
            <h2>{section.label}</h2>
            {section.days.map(([date, rows]) => (
              <div key={date} className="upcoming-day">
                <h3>{formatDay(date)}</h3>
                <div className="table-wrap">
                  <table className="dense">
                    <tbody>
                      {rows.map((item) => {
                        const key = `${item.kind}:${item.id}`;
                        const busy = busyKey === key;
                        return (
                          <tr key={key}>
                            <td style={{ width: 56 }}>
                              <Poster path={item.posterUrl} alt="" width={40} height={60} />
                            </td>
                            <td>
                              {item.inLibrary ? (
                                <button type="button" className="upcoming-title" onClick={() => open(item)}>
                                  {item.title}
                                </button>
                              ) : (
                                <div className="upcoming-title">{item.title}</div>
                              )}
                              <div className="upcoming-meta">
                                <span className="badge">{item.kind === 'show' ? 'Series' : 'Movie'}</span>
                                {item.subtitle && item.subtitle !== 'Movie' ? <span>{item.subtitle}</span> : null}
                              </div>
                              {item.overview ? <div className="upcoming-overview">{item.overview}</div> : null}
                            </td>
                            <td style={{ width: 110, textAlign: 'right' }}>
                              {item.inLibrary ? (
                                <button type="button" onClick={() => open(item)}>
                                  Open
                                </button>
                              ) : (
                                <button type="button" className="primary" disabled={busy} onClick={() => void add(item)}>
                                  {busy ? 'Adding…' : 'Add'}
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </section>
        ))}
    </div>
  );
}
