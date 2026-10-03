/**
 * Alternate titles and release dates for one IMDb movie.
 * Used to reject torrent names that belong to a different film.
 */

export interface MovieIdentity {
  imdbId: string;
  titles: string[];
  releaseDates: string[];
}

const GRAPHQL = 'https://api.graphql.imdb.com/';
const CACHE_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: MovieIdentity }>();

function normalizeImdbId(raw: string): string | null {
  const m = String(raw || '').trim().match(/^(?:tt)?(\d{7,8})$/i);
  if (!m) return null;
  return `tt${m[1]}`;
}

function isoDate(year?: number | null, month?: number | null, day?: number | null): string | null {
  if (!year || !month || !day) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) {
    return null;
  }
  return iso;
}

const QUERY = `query MovieIdentity($id: ID!) {
  title(id: $id) {
    titleText { text }
    originalTitleText { text }
    releaseDate { year month day }
    akas(first: 40) { edges { node { text } } }
    releaseDates(first: 40) { edges { node { year month day } } }
  }
}`;

export async function loadMovieIdentity(imdbId: string): Promise<MovieIdentity | null> {
  const id = normalizeImdbId(imdbId);
  if (!id) return null;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: 'https://www.imdb.com',
      Referer: `https://www.imdb.com/title/${id}/`,
      'x-imdb-client-name': 'imdb-web-app',
    },
    body: JSON.stringify({ operationName: 'MovieIdentity', variables: { id }, query: QUERY }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return null;
  const parsed = (await res.json()) as {
    data?: {
      title?: {
        titleText?: { text?: string | null } | null;
        originalTitleText?: { text?: string | null } | null;
        releaseDate?: { year?: number | null; month?: number | null; day?: number | null } | null;
        akas?: { edges?: Array<{ node?: { text?: string | null } | null } | null> | null } | null;
        releaseDates?: {
          edges?: Array<{
            node?: { year?: number | null; month?: number | null; day?: number | null } | null;
          } | null> | null;
        } | null;
      } | null;
    };
  };
  const title = parsed.data?.title;
  if (!title) return null;
  const titles = [
    title.titleText?.text,
    title.originalTitleText?.text,
    ...(title.akas?.edges || []).map((edge) => edge?.node?.text),
  ].map((name) => (name || '').trim()).filter(Boolean);
  const releaseDates = [
    isoDate(title.releaseDate?.year, title.releaseDate?.month, title.releaseDate?.day),
    ...(title.releaseDates?.edges || []).map((edge) =>
      isoDate(edge?.node?.year, edge?.node?.month, edge?.node?.day)
    ),
  ].filter((date): date is string => !!date);
  const value: MovieIdentity = {
    imdbId: id,
    titles: [...new Set(titles)],
    releaseDates: [...new Set(releaseDates)],
  };
  cache.set(id, { at: Date.now(), value });
  return value;
}
