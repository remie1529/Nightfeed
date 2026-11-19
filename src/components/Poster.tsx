import { useEffect, useState } from 'react';

const MAX_CACHE_ENTRIES = 1000;
const posterMemoryCache = new Map<string, string>();
const failedPosters = new Set<string>();

function rememberPoster(remote: string, local: string): void {
  if (posterMemoryCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = posterMemoryCache.keys().next().value;
    if (oldest !== undefined) posterMemoryCache.delete(oldest);
  }
  posterMemoryCache.set(remote, local);
}

export default function Poster({
  path,
  alt,
  width = 140,
  height = 210,
}: {
  path: string | null;
  alt: string;
  width?: number;
  height?: number;
}) {
  const remote = path ? window.torrentAPI.posterUrl(path, width > 200 ? 'w500' : 'w342') : null;
  const cached = remote ? posterMemoryCache.get(remote) || null : null;
  const [src, setSrc] = useState<string | null>(() => {
    if (!remote || failedPosters.has(remote)) return null;
    return cached || (remote && /^https?:\/\//i.test(remote) ? null : remote);
  });

  useEffect(() => {
    if (!remote || failedPosters.has(remote)) {
      setSrc(null);
      return;
    }
    if (!/^https?:\/\//i.test(remote)) {
      setSrc(remote);
      return;
    }
    const hit = posterMemoryCache.get(remote);
    if (hit) {
      setSrc(hit);
      return;
    }
    let cancelled = false;
    // Ask main process cache first to avoid double-fetching remote CDN + main cache simultaneously.
    const cacheCall = window.torrentAPI.cachedPoster?.(remote);
    if (!cacheCall) {
      setSrc(remote);
      return;
    }
    cacheCall
      .then((local) => {
        if (cancelled) return;
        const resolved = local ? String(local) : remote;
        if (local) rememberPoster(remote, resolved);
        setSrc(resolved);
      })
      .catch(() => {
        if (!cancelled) setSrc(remote);
      });
    return () => {
      cancelled = true;
    };
  }, [remote]);

  if (!src) {
    return (
      <div
        className="poster"
        style={{
          width,
          height,
          display: 'grid',
          placeItems: 'center',
          color: 'var(--text-faint)',
          fontSize: 12,
          textAlign: 'center',
          padding: 8,
        }}
      >
        No art
      </div>
    );
  }
  return (
    <img
      className="poster"
      src={src}
      alt={alt}
      width={width}
      height={height}
      loading="lazy"
      decoding="async"
      onError={() => {
        if (remote && src !== remote) {
          posterMemoryCache.delete(remote);
          setSrc(remote);
          return;
        }
        if (remote) failedPosters.add(remote);
        setSrc(null);
      }}
    />
  );
}
