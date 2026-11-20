/**
 * Custom Live TV channels that play local library movies and episodes.
 * The schedule is deterministic and epoch-anchored so the XMLTV guide matches
 * playback continuously across midnight boundaries without truncating items.
 */
import fs from 'fs';
import path from 'path';
import type { LiveTvChannel, Show } from '../types';
import { getMovies, getShows } from './store';
import {
  buildScheduleFromItems,
  MIN_LIBRARY_DURATION_SEC,
  type LibraryMediaItem,
  type LibrarySlot,
} from './library-schedule-core';

export { buildScheduleFromItems, type LibraryMediaItem, type LibrarySlot };

export type LibraryPlayMode =
  | 'random-movies'
  | 'random-episodes'
  | 'random-mix'
  | 'latest-movies'
  | 'latest-episodes'
  | 'latest-mix'
  | 'show';

const VIDEO = /\.(mkv|mp4|m4v|avi|ts|webm|mov)$/i;
const MAX_DURATION_CACHE_ENTRIES = 10_000;

interface DurationCacheEntry {
  size: number;
  mtimeMs: number;
  durationSec: number;
}

const durationCache = new Map<string, DurationCacheEntry>();
let durationCacheFile: string | null = null;
let durationSaveTimer: NodeJS.Timeout | null = null;

function flushDurationCacheNow(): void {
  if (!durationCacheFile) return;
  try {
    fs.mkdirSync(path.dirname(durationCacheFile), { recursive: true });
    const obj: Record<string, DurationCacheEntry> = {};
    for (const [k, v] of durationCache.entries()) obj[k] = v;
    fs.writeFileSync(durationCacheFile, JSON.stringify(obj), 'utf8');
  } catch {
    // ignore disk cache write errors
  }
}

function scheduleDurationCacheSave(): void {
  if (!durationCacheFile || durationSaveTimer) return;
  durationSaveTimer = setTimeout(() => {
    durationSaveTimer = null;
    flushDurationCacheNow();
  }, 2000);
}

/** Configure persistent JSON cache file for probed media durations. */
export function initDurationCache(filePath: string): void {
  durationCacheFile = filePath;
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const e = v as Partial<DurationCacheEntry>;
      if (
        typeof e.size === 'number' &&
        typeof e.mtimeMs === 'number' &&
        typeof e.durationSec === 'number' &&
        e.durationSec >= MIN_LIBRARY_DURATION_SEC
      ) {
        durationCache.set(k, {
          size: e.size,
          mtimeMs: e.mtimeMs,
          durationSec: Math.round(e.durationSec),
        });
      }
    }
  } catch {
    // ignore corrupt cache
  }
}

export function getCachedDurationSec(filePath: string, stat?: fs.Stats): number | null {
  const hit = durationCache.get(filePath);
  if (!hit) return null;
  try {
    const st = stat || fs.statSync(filePath);
    if (hit.size === st.size && Math.abs(hit.mtimeMs - st.mtimeMs) < 2000) {
      return hit.durationSec;
    }
  } catch {
    return null;
  }
  return null;
}

export function setCachedDurationSec(filePath: string, durationSec: number): void {
  if (!Number.isFinite(durationSec) || durationSec < MIN_LIBRARY_DURATION_SEC) return;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return;
    if (durationCache.size >= MAX_DURATION_CACHE_ENTRIES && !durationCache.has(filePath)) {
      const oldest = durationCache.keys().next().value;
      if (oldest !== undefined) durationCache.delete(oldest);
    }
    durationCache.set(filePath, {
      size: st.size,
      mtimeMs: st.mtimeMs,
      durationSec: Math.round(durationSec),
    });
    scheduleDurationCacheSave();
  } catch {
    // ignore missing file
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function statVideo(p?: string): fs.Stats | null {
  if (!p || !VIDEO.test(p)) return null;
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

function movies(): LibraryMediaItem[] {
  const out: LibraryMediaItem[] = [];
  for (const m of getMovies()) {
    if (m.status !== 'downloaded' || !m.localPath) continue;
    const st = statVideo(m.localPath);
    if (!st) continue;
    const year = m.releaseYear ? ` (${m.releaseYear})` : '';
    const cached = getCachedDurationSec(m.localPath, st);
    const fallbackSec = (m.runtime && m.runtime >= 20 ? m.runtime : 105) * 60;
    out.push({
      path: m.localPath,
      title: `${m.title}${year}`,
      desc: (m.overview || 'Movie').slice(0, 400),
      durationSec: cached ?? fallbackSec,
      sortKey: m.releaseDate || (m.releaseYear ? `${m.releaseYear}-01-01` : m.addedAt || ''),
    });
  }
  return out;
}

function episodes(showId?: number | null): LibraryMediaItem[] {
  const out: LibraryMediaItem[] = [];
  for (const show of getShows()) {
    if (showId != null && show.tmdbId !== showId) continue;
    for (const season of show.seasons || []) {
      for (const ep of season.episodes || []) {
        if (ep.status !== 'downloaded' || !ep.localPath) continue;
        const st = statVideo(ep.localPath);
        if (!st) continue;
        const cached = getCachedDurationSec(ep.localPath, st);
        out.push({
          path: ep.localPath,
          title: `${show.name} S${pad2(ep.seasonNumber)}E${pad2(ep.episodeNumber)} — ${ep.name || 'Episode'}`,
          desc: (ep.overview || show.overview || 'Episode').slice(0, 400),
          durationSec: cached ?? 45 * 60,
          sortKey: ep.airDate || show.firstAirDate || '',
          seasonNumber: ep.seasonNumber,
          episodeNumber: ep.episodeNumber,
        });
      }
    }
  }
  return out;
}

function pickItems(ch: LiveTvChannel): LibraryMediaItem[] {
  const mode = ch.libraryMode || 'random-mix';
  if (mode === 'random-movies' || mode === 'latest-movies') return movies();
  if (mode === 'random-episodes' || mode === 'latest-episodes') return episodes();
  if (mode === 'show') return episodes(ch.showTmdbId);
  return [...movies(), ...episodes()];
}

/** Timeline covering [from, from + days). */
export function buildLibrarySchedule(ch: LiveTvChannel, from: Date, days: number): LibrarySlot[] {
  const items = pickItems(ch);
  return buildScheduleFromItems(ch, items, from.getTime(), days);
}

export function libraryScheduleNow(ch: LiveTvChannel, days: number, now = Date.now()): LibrarySlot[] {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  return buildLibrarySchedule(ch, from, days);
}

export function currentLibrarySlot(ch: LiveTvChannel, days: number, now = Date.now()): LibrarySlot | null {
  const slots = libraryScheduleNow(ch, days, now);
  return slots.find((s) => now >= s.start && now < s.end) || slots[0] || null;
}

export function nextLibrarySlot(ch: LiveTvChannel, days: number, afterMs: number): LibrarySlot | null {
  const slots = libraryScheduleNow(ch, days, afterMs);
  return slots.find((s) => s.start >= afterMs) || null;
}

/** Return downloaded library file paths referenced by library channels that lack cached durations. */
export function unprobedLibraryFiles(channels: LiveTvChannel[]): string[] {
  const need = new Set<string>();
  for (const ch of channels) {
    if (ch.kind !== 'library') continue;
    for (const item of pickItems(ch)) {
      if (getCachedDurationSec(item.path) === null) need.add(item.path);
    }
  }
  return [...need];
}

export function libraryShowOptions(): Array<{ tmdbId: number; name: string }> {
  return getShows()
    .map((s: Show) => ({ tmdbId: s.tmdbId, name: s.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
