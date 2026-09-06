/**
 * Pure TVMaze show search — no electron-store / app dependency.
 * Safe to load from worker_threads.
 */
const BASE = 'https://api.tvmaze.com';

function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface MazeSearchItem {
  id: number;
  name: string;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  firstAirDate: string | null;
  status: string;
}

interface MazeShow {
  id: number;
  name: string;
  summary: string | null;
  status: string;
  premiered: string | null;
  image: { medium: string | null; original: string | null } | null;
}

export async function searchShows(query: string): Promise<MazeSearchItem[]> {
  if (!query.trim()) return [];
  const url = `${BASE}/search/shows?q=${encodeURIComponent(query.trim())}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`TVMaze ${res.status}: ${text || res.statusText}`);
  }
  const data = (await res.json()) as Array<{ show: MazeShow }>;
  return (data || []).map(({ show }) => ({
    id: show.id,
    name: show.name,
    overview: stripHtml(show.summary),
    posterUrl: show.image?.medium || show.image?.original || null,
    backdropUrl: show.image?.original || show.image?.medium || null,
    firstAirDate: show.premiered,
    status: show.status || '',
  }));
}
