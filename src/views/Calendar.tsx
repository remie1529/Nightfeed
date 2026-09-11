import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CalendarEpisode } from '../lib/types';
import { epCode } from '../lib/format';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function startOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatWeekRange(start: Date): string {
  const end = addDays(start, 6);
  const sameMonth = start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth();
  if (sameMonth) {
    return `${start.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })} – ${end.getDate()}, ${end.getFullYear()}`;
  }
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const left = start.toLocaleDateString(
    undefined,
    start.getFullYear() === end.getFullYear() ? opts : { ...opts, year: 'numeric' }
  );
  const right = end.toLocaleDateString(undefined, { ...opts, year: 'numeric' });
  return `${left} – ${right}`;
}

export default function CalendarView({
  onOpenShow,
  refreshToken = 0,
}: {
  onOpenShow: (tmdbId: number) => void;
  refreshToken?: number;
}) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [items, setItems] = useState<CalendarEpisode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const from = isoDate(weekStart);
  const to = isoDate(addDays(weekStart, 6));
  const today = isoDate(new Date());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = (await window.torrentAPI.getCalendar?.(from, to)) as CalendarEpisode[] | undefined;
      setItems(Array.isArray(list) ? list : []);
      setError(null);
    } catch (e) {
      setItems([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEpisode[]>();
    for (let i = 0; i < 7; i++) map.set(isoDate(addDays(weekStart, i)), []);
    for (const ep of items) {
      const bucket = map.get(ep.airDate);
      if (bucket) bucket.push(ep);
    }
    return map;
  }, [items, weekStart]);

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  );

  const isThisWeek = from === isoDate(startOfWeek(new Date()));

  return (
    <div className="page page-wide">
      <div className="page-header">
        <div>
          <h1>Calendar</h1>
          <p>
            {formatWeekRange(weekStart)}
            {loading ? ' · loading…' : ` · ${items.length} episode${items.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="toolbar">
          <button type="button" onClick={() => setWeekStart((w) => addDays(w, -7))}>
            Previous
          </button>
          <button
            type="button"
            className={isThisWeek ? 'primary' : ''}
            onClick={() => setWeekStart(startOfWeek(new Date()))}
            disabled={isThisWeek}
          >
            This week
          </button>
          <button type="button" onClick={() => setWeekStart((w) => addDays(w, 7))}>
            Next
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="cal-grid">
        {days.map((d, i) => {
          const key = isoDate(d);
          const eps = byDay.get(key) || [];
          const isToday = key === today;
          return (
            <div key={key} className={`cal-day${isToday ? ' today' : ''}`}>
              <div className="cal-day-head">
                <span>{DAY_NAMES[i]}</span>
                <span>{d.getDate()}</span>
              </div>
              <div className="cal-day-body">
                {eps.length === 0 ? (
                  <div className="cal-empty">{isToday ? 'Nothing today' : ''}</div>
                ) : (
                  eps.map((ep) => (
                    <button
                      key={`${ep.tmdbId}-${ep.seasonNumber}-${ep.episodeNumber}`}
                      type="button"
                      className="cal-ep"
                      onClick={() => onOpenShow(ep.tmdbId)}
                      title={`${ep.showName} ${epCode(ep.seasonNumber, ep.episodeNumber)} ${ep.name}`}
                    >
                      <div className="cal-ep-show">{ep.showName}</div>
                      <div className="cal-ep-meta">
                        {epCode(ep.seasonNumber, ep.episodeNumber)}
                        {ep.name ? ` · ${ep.name}` : ''}
                      </div>
                      <span className={`badge ${ep.status}`}>{ep.status}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
