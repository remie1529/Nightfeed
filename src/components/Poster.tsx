import { useEffect, useRef, useState } from 'react';

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

function tierForWidth(width: number): 'thumb' | 'w342' | 'w500' {
  if (width <= 64) return 'thumb';
  if (width >= 170) return 'w500';
  return 'w342';
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
  const remote = path ? window.torrentAPI.posterUrl(path, tierForWidth(width)) : null;
  const memoryHit = remote ? posterMemoryCache.get(remote) || null : null;
  const isRemoteHttp = !!remote && /^https?:\/\//i.test(remote);

  const [inView, setInView] = useState<boolean>(() => !isRemoteHttp || !!memoryHit);
  const [src, setSrc] = useState<string | null>(() => {
    if (!remote || failedPosters.has(remote)) return null;
    if (!isRemoteHttp) return remote;
    return memoryHit;
  });
  const [failed, setFailed] = useState<boolean>(() => !remote || failedPosters.has(remote));
  const holderRef = useRef<HTMLDivElement | null>(null);

  // Defer remote cache requests for off-screen cards so visible posters load first.
  useEffect(() => {
    if (!remote || !isRemoteHttp || posterMemoryCache.has(remote)) {
      setInView(true);
      return;
    }
    const el = holderRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    let done = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (done) return;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            done = true;
            setInView(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: '400px 0px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [remote, isRemoteHttp]);

  useEffect(() => {
    if (!remote || failedPosters.has(remote)) {
      setSrc(null);
      setFailed(true);
      return;
    }
    setFailed(false);
    if (!isRemoteHttp) {
      setSrc(remote);
      return;
    }
    const hit = posterMemoryCache.get(remote);
    if (hit) {
      setSrc(hit);
      return;
    }
    if (!inView) return;
    let cancelled = false;
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
  }, [remote, isRemoteHttp, inView]);

  if (!remote || failed) {
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

  if (!src) {
    return (
      <div
        ref={holderRef}
        className="poster skeleton-poster"
        aria-label={alt}
        style={{ width, height }}
      />
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
        setFailed(true);
        setSrc(null);
      }}
    />
  );
}
