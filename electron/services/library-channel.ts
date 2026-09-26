/**
 * Custom Live TV channels that play local library movies and episodes.
 * The schedule is deterministic so the XMLTV guide matches what is streaming.
 */
import fs from 'fs';
import type { LiveTvChannel, Show } from '../types';
import { getMovies, getShows } from './store';

export type LibraryPlayMode =
  | 'random-movies'
  | 'random-episodes'
  | 'random-mix'
  | 'latest-movies'
  | 'latest-episodes'
  | 'latest-mix'
  | 'show';

export interface LibrarySlot {
  start: number;
  end: number;
  path: string;
  title: string;
  desc: string;
}

interface MediaItem {
  path: string;
  title: string;
  desc: string;
  minutes: number;
  sortKey: string;
}

const VIDEO = /\.(mkv|mp4|m4v|avi|ts|webm|mov)$/i;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], seed: string): T[] {
  const next = [...items];
  const rnd = mulberry32(hashSeed(seed));
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = next[i];
    next[i] = next[j];
    next[j] = tmp;
  }
  return next;
}

function fileOk(p?: string): p is string {
  if (!p || !VIDEO.test(p)) return false;
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function movies(): MediaItem[] {
  const out: MediaItem[] = [];
  for (const m of getMovies()) {
    if (m.status !== 'downloaded' || !fileOk(m.localPath)) continue;
    const year = m.releaseYear ? ` (${m.releaseYear})` : '';
    out.push({
      path: m.localPath,
      title: `${m.title}${year}`,
      desc: (m.overview || 'Movie').slice(0, 400),
      minutes: m.runtime && m.runtime >= 20 ? m.runtime : 105,
      sortKey: m.releaseDate || (m.releaseYear ? `${m.releaseYear}-01-01` : m.addedAt || ''),
    });
  }
  return out;
}

function episodes(showId?: number | null): MediaItem[] {
  const out: MediaItem[] = [];
  for (const show of getShows()) {
    if (showId != null && show.tmdbId !== showId) continue;
    for (const season of show.seasons || []) {
      for (const ep of season.episodes || []) {
        if (ep.status !== 'downloaded' || !fileOk(ep.localPath)) continue;
        out.push({
          path: ep.localPath,
          title: `${show.name} S${pad2(ep.seasonNumber)}E${pad2(ep.episodeNumber)} — ${ep.name || 'Episode'}`,
          desc: (ep.overview || show.overview || 'Episode').slice(0, 400),
          minutes: 45,
          sortKey: ep.airDate || show.firstAirDate || '',
        });
      }
    }
  }
  return out;
}

function pickItems(ch: LiveTvChannel): { items: MediaItem[]; latest: boolean } {
  const mode = ch.libraryMode || 'random-mix';
  if (mode === 'random-movies') return { items: movies(), latest: false };
  if (mode === 'latest-movies') return { items: movies(), latest: true };
  if (mode === 'random-episodes') return { items: episodes(), latest: false };
  if (mode === 'latest-episodes') return { items: episodes(), latest: true };
  if (mode === 'show') return { items: episodes(ch.showTmdbId), latest: false };
  if (mode === 'latest-mix') return { items: [...movies(), ...episodes()], latest: true };
  return { items: [...movies(), ...episodes()], latest: false };
}

/** Timeline covering [from, from + days). */
export function buildLibrarySchedule(ch: LiveTvChannel, from: Date, days: number): LibrarySlot[] {
  const { items, latest } = pickItems(ch);
  if (!items.length) return [];
  const ordered = latest
    ? [...items].sort((a, b) => b.sortKey.localeCompare(a.sortKey) || a.title.localeCompare(b.title))
    : shuffle(items, `${ch.id}|${from.getFullYear()}-${from.getMonth()}-${from.getDate()}|${items.length}`);
  const span = Math.max(1, Math.min(7, days)) * 24 * 60 * 60 * 1000;
  const start0 = from.getTime();
  const endLimit = start0 + span;
  const slots: LibrarySlot[] = [];
  let t = start0;
  let i = 0;
  let guard = 0;
  while (t < endLimit && guard < 5000) {
    guard += 1;
    const item = ordered[i % ordered.length];
    i += 1;
    const dur = Math.max(15, item.minutes) * 60 * 1000;
    slots.push({
      start: t,
      end: t + dur,
      path: item.path,
      title: item.title,
      desc: item.desc,
    });
    t += dur;
  }
  return slots;
}

export function libraryScheduleNow(ch: LiveTvChannel, days: number): LibrarySlot[] {
  const from = new Date();
  from.setMinutes(0, 0, 0);
  return buildLibrarySchedule(ch, from, days);
}

export function currentLibrarySlot(ch: LiveTvChannel, days: number, now = Date.now()): LibrarySlot | null {
  const slots = libraryScheduleNow(ch, days);
  return slots.find((s) => now >= s.start && now < s.end) || slots[0] || null;
}

export function libraryShowOptions(): Array<{ tmdbId: number; name: string }> {
  return getShows()
    .map((s: Show) => ({ tmdbId: s.tmdbId, name: s.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
