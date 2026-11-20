/**
 * Pure deterministic epoch-anchored schedule builder for custom library Live TV channels.
 * Zero Electron / store dependencies so it can be unit-tested directly.
 */
import type { LiveTvChannel } from '../types';

export interface LibrarySlot {
  start: number;
  end: number;
  path: string;
  title: string;
  desc: string;
}

export interface LibraryMediaItem {
  path: string;
  title: string;
  desc: string;
  /** Duration in seconds (real ffprobe duration when cached, otherwise fallback). */
  durationSec: number;
  sortKey: string;
  seasonNumber?: number;
  episodeNumber?: number;
}

export const LIBRARY_SCHEDULE_EPOCH_MS = Date.UTC(2025, 0, 1, 0, 0, 0, 0);
export const MIN_LIBRARY_DURATION_SEC = 60;

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

function orderCycleItems(
  ch: LiveTvChannel,
  items: LibraryMediaItem[],
  cycleIndex: number
): LibraryMediaItem[] {
  const mode = ch.libraryMode || 'random-mix';
  if (mode === 'show') {
    return [...items].sort(
      (a, b) =>
        (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0) ||
        (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0) ||
        a.title.localeCompare(b.title)
    );
  }
  if (mode === 'latest-movies' || mode === 'latest-episodes' || mode === 'latest-mix') {
    return [...items].sort(
      (a, b) => b.sortKey.localeCompare(a.sortKey) || a.title.localeCompare(b.title)
    );
  }
  const canonical = [...items].sort((a, b) => a.path.localeCompare(b.path));
  return shuffle(canonical, `${ch.id}|${mode}|cycle-${cycleIndex}`);
}

/**
 * Pure deterministic schedule builder covering [fromMs, fromMs + days).
 * Anchored to a fixed epoch using total cycle length so:
 * - Every cycle has the exact same length regardless of shuffle order,
 * - No episode or movie is cut off or scrambled at midnight,
 * - "One show, in order" plays strictly S01E01 -> S01E02 -> ... in order.
 */
export function buildScheduleFromItems(
  ch: LiveTvChannel,
  items: LibraryMediaItem[],
  fromMs: number,
  days: number
): LibrarySlot[] {
  if (!items.length) return [];
  const durationsMs = items.map(
    (it) => Math.max(MIN_LIBRARY_DURATION_SEC, Math.round(it.durationSec || 2700)) * 1000
  );
  const cycleMs = durationsMs.reduce((sum, d) => sum + d, 0);
  if (cycleMs <= 0) return [];

  const spanMs = Math.max(1, Math.min(7, days)) * 24 * 60 * 60 * 1000;
  const endLimit = fromMs + spanMs;

  let cycleIdx = Math.floor((fromMs - LIBRARY_SCHEDULE_EPOCH_MS) / cycleMs);
  let t = LIBRARY_SCHEDULE_EPOCH_MS + cycleIdx * cycleMs;

  const slots: LibrarySlot[] = [];
  let guard = 0;

  while (t < endLimit && guard < 10_000) {
    const ordered = orderCycleItems(ch, items, cycleIdx);
    for (const item of ordered) {
      guard += 1;
      if (guard >= 10_000) break;
      const durMs = Math.max(MIN_LIBRARY_DURATION_SEC, Math.round(item.durationSec || 2700)) * 1000;
      const slotEnd = t + durMs;
      if (slotEnd > fromMs) {
        slots.push({
          start: t,
          end: slotEnd,
          path: item.path,
          title: item.title,
          desc: item.desc,
        });
      }
      t = slotEnd;
      if (t >= endLimit) break;
    }
    cycleIdx += 1;
  }

  return slots;
}
