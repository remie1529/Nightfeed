import { useEffect, useMemo, useRef, useState } from 'react';
import Poster from '../components/Poster';
import type { UpcomingItem } from '../lib/types';

type Filter = 'all' | 'show' | 'movie';

function formatShort(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function UpcomingShelf({
  label,
  items,
  busyKey,
  onAdd,
  onOpen,
}: {
  label: string;
  items: UpcomingItem[];
  busyKey: string | null;
  onAdd: (item: UpcomingItem) => void;
  onOpen: (item: UpcomingItem) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);

  const scrollByDir = (direction: -1 | 1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.max(320, Math.round(el.clientWidth * 0.85)), behavior: 'smooth' });
  };

  return (
    <div className="upcoming-day">
      <div className="upcoming-day-head">
        <h3>{label}</h3>
        <div className="upcoming-day-nav">
          <button type="button" aria-label="Scroll back" onClick={() => scrollByDir(-1)}>
            ‹
          </button>
          <button type="button" aria-label="Scroll forward" onClick={() => scrollByDir(1)}>
            ›
          </button>
        </div>
      </div>
      <div className="upcoming-row" ref={scroller}>
        {items.map((item) => {
          const key = `${item.kind}:${item.id}`;
          const busy = busyKey === key;
          const meta = [formatShort(item.date), item.subtitle && item.subtitle !== 'Movie' ? item.subtitle : '']
            .filter(Boolean)
            .join(' · ');
          return (
            <article key={key} className="upcoming-card">
              <button type="button" className="upcoming-poster-btn" onClick={() => onOpen(item)}>
                <Poster path={item.posterUrl} alt="" width={148} height={222} />
              </button>
              <button type="button" className="upcoming-card-title" title={item.title} onClick={() => onOpen(item)}>
                {item.title}
              </button>
              <div className="upcoming-card-meta" title={meta}>
                {meta}
              </div>
              {item.inLibrary ? (
                <button type="button" onClick={() => onOpen(item)}>
                  Open
                </button>
              ) : (
                <button type="button" className="primary" disabled={busy} onClick={() => onAdd(item)}>
                  {busy ? 'Adding…' : 'Add'}
                </button>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
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
    const row = (id: string, label: string, list: UpcomingItem[]) =>
      list.length ? { id, label, items: list } : null;
    const blocks = [
      {
        id: 'english',
        label: 'English',
        rows: [
          row('en-show', 'Series', visible.filter((item) => item.english && item.kind === 'show')),
          row('en-movie', 'Movies', visible.filter((item) => item.english && item.kind === 'movie')),
        ].filter((entry) => entry != null),
      },
      {
        id: 'other',
        label: 'Other languages',
        rows: [
          row('other-show', 'Series', visible.filter((item) => !item.english && item.kind === 'show')),
          row('other-movie', 'Movies', visible.filter((item) => !item.english && item.kind === 'movie')),
        ].filter((entry) => entry != null),
      },
    ];
    return blocks.filter((section) => section.rows.length > 0);
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
            {section.rows.map((shelf) => (
              <UpcomingShelf
                key={shelf.id}
                label={shelf.label}
                items={shelf.items}
                busyKey={busyKey}
                onAdd={(item) => void add(item)}
                onOpen={open}
              />
            ))}
          </section>
        ))}
    </div>
  );
}
