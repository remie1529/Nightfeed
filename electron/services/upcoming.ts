/**
 * New TV series premieres (TVMaze) and new movies (IMDb) for the Upcoming tab.
 * Not the next episode of shows already in the library.
 */
const TVMAZE = 'https://api.tvmaze.com/schedule/full';
const IMDB_GRAPHQL = 'https://api.graphql.imdb.com/';
const WINDOW_DAYS = 90;
const CACHE_MS = 6 * 60 * 60 * 1000;

export interface UpcomingPick {
  kind: 'show' | 'movie';
  id: number;
  title: string;
  date: string;
  overview: string;
  posterUrl: string | null;
  subtitle: string;
  /** English titles are listed before every other language. */
  english: boolean;
}

let cache: { at: number; today: string; items: UpcomingPick[] } | null = null;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function imdbNumber(id: string): number | null {
  const m = String(id || '').match(/^(?:tt)?(\d+)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isoDate(year?: number | null, month?: number | null, day?: number | null): string | null {
  if (!year || !month || !day) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

interface MazeEpisode {
  airdate?: string | null;
  season?: number | null;
  number?: number | null;
  _embedded?: {
    show?: {
      id?: number;
      name?: string;
      language?: string | null;
      summary?: string | null;
      premiered?: string | null;
      image?: { medium?: string | null; original?: string | null } | null;
      network?: { name?: string | null } | null;
      webChannel?: { name?: string | null } | null;
    };
  };
}

async function fetchPremieres(today: string, end: string): Promise<UpcomingPick[]> {
  const res = await fetch(TVMAZE, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`TVMaze schedule ${res.status}`);
  const episodes = (await res.json()) as MazeEpisode[];
  const seen = new Set<number>();
  const items: UpcomingPick[] = [];
  for (const ep of episodes || []) {
    if (ep.season !== 1 || ep.number !== 1) continue;
    const date = String(ep.airdate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today || date > end) continue;
    const show = ep._embedded?.show;
    if (!show?.id || !show.name) continue;
    if (seen.has(show.id)) continue;
    seen.add(show.id);
    const where = show.webChannel?.name || show.network?.name || '';
    const language = (show.language || '').trim();
    const english = language.toLowerCase() === 'english';
    items.push({
      kind: 'show',
      id: show.id,
      title: show.name,
      date,
      overview: stripHtml(show.summary),
      posterUrl: show.image?.medium || show.image?.original || null,
      subtitle: [where, language].filter(Boolean).join(' · ') || 'TV',
      english,
    });
  }
  return items;
}

interface ImdbTitleNode {
  id?: string;
  titleText?: { text?: string | null };
  releaseDate?: { year?: number | null; month?: number | null; day?: number | null } | null;
  primaryImage?: { url?: string | null } | null;
  plot?: { plotText?: { plainText?: string | null } | null } | null;
  spokenLanguages?: {
    spokenLanguages?: Array<{ id?: string | null; text?: string | null } | null> | null;
  } | null;
}

function spokenLabels(title: ImdbTitleNode): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const entry of title.spokenLanguages?.spokenLanguages || []) {
    const text = (entry?.text || '').trim();
    const key = (entry?.id || text).toLowerCase();
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    labels.push(text);
    if (labels.length >= 3) break;
  }
  return labels;
}

/** Notable new movies. `english` selects the English page or every other language. */
async function fetchMoviePage(today: string, end: string, english: boolean): Promise<UpcomingPick[]> {
  const languageConstraint = english
    ? '{ anyLanguages: ["en"] }'
    : '{ excludeLanguages: ["en"] }';
  const query = `query UpcomingMovies($start: Date!, $end: Date!) {
    advancedTitleSearch(
      first: 40
      constraints: {
        titleTypeConstraint: { anyTitleTypeIds: ["movie"] }
        releaseDateConstraint: { releaseDateRange: { start: $start, end: $end } }
        languageConstraint: ${languageConstraint}
      }
      sort: { sortBy: USER_RATING, sortOrder: DESC }
    ) {
      edges {
        node {
          title {
            id
            titleText { text }
            releaseDate { year month day }
            primaryImage { url }
            plot { plotText { plainText } }
            spokenLanguages { spokenLanguages { id text } }
          }
        }
      }
    }
  }`;
  const res = await fetch(IMDB_GRAPHQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: 'https://www.imdb.com',
      Referer: 'https://www.imdb.com/',
      'x-imdb-client-name': 'imdb-web-app',
    },
    body: JSON.stringify({
      operationName: 'UpcomingMovies',
      variables: { start: today, end },
      query,
    }),
  });
  if (!res.ok) throw new Error(`IMDb upcoming ${res.status}`);
  const parsed = (await res.json()) as {
    errors?: Array<{ message?: string }>;
    data?: {
      advancedTitleSearch?: {
        edges?: Array<{ node?: { title?: ImdbTitleNode } }>;
      };
    };
  };
  if (parsed.errors?.length) {
    throw new Error(parsed.errors[0]?.message || 'IMDb upcoming failed');
  }
  const items: UpcomingPick[] = [];
  const seen = new Set<number>();
  for (const edge of parsed.data?.advancedTitleSearch?.edges || []) {
    const title = edge.node?.title;
    if (!title) continue;
    const id = imdbNumber(title.id || '');
    const name = (title.titleText?.text || '').trim();
    const date = isoDate(title.releaseDate?.year, title.releaseDate?.month, title.releaseDate?.day);
    if (!id || !name || !date || date < today || date > end) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const labels = spokenLabels(title);
    items.push({
      kind: 'movie',
      id,
      title: name,
      date,
      overview: (title.plot?.plotText?.plainText || '').trim(),
      posterUrl: title.primaryImage?.url || null,
      subtitle: labels.join(' · ') || (english ? 'English' : 'Movie'),
      english,
    });
  }
  return items;
}

export async function loadUpcomingPicks(): Promise<{ items: UpcomingPick[]; error?: string }> {
  const today = localToday();
  if (cache && cache.today === today && Date.now() - cache.at < CACHE_MS) {
    return { items: cache.items };
  }
  const end = addDays(today, WINDOW_DAYS);
  const errors: string[] = [];
  const [shows, englishMovies, otherMovies] = await Promise.all([
    fetchPremieres(today, end).catch((err) => {
      errors.push(err instanceof Error ? err.message : String(err));
      return [] as UpcomingPick[];
    }),
    fetchMoviePage(today, end, true).catch((err) => {
      errors.push(err instanceof Error ? err.message : String(err));
      return [] as UpcomingPick[];
    }),
    fetchMoviePage(today, end, false).catch((err) => {
      errors.push(err instanceof Error ? err.message : String(err));
      return [] as UpcomingPick[];
    }),
  ]);
  const movies = new Map<number, UpcomingPick>();
  for (const item of [...otherMovies, ...englishMovies]) {
    const prev = movies.get(item.id);
    if (!prev || item.english) movies.set(item.id, item);
  }
  const items = [...shows, ...movies.values()].sort((a, b) => {
    if (a.english !== b.english) return a.english ? -1 : 1;
    const byDate = a.date.localeCompare(b.date);
    if (byDate) return byDate;
    if (a.kind !== b.kind) return a.kind === 'show' ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
  if (items.length) cache = { at: Date.now(), today, items };
  return { items, error: errors.length ? errors.join(' · ') : undefined };
}
