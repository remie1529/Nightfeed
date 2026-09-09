import { useEffect, useState } from 'react';

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
  const [src, setSrc] = useState<string | null>(remote);

  useEffect(() => {
    setSrc(remote);
    if (!remote || !/^https?:\/\//i.test(remote)) return;
    let cancelled = false;
    window.torrentAPI
      .cachedPoster?.(remote)
      .then((local) => {
        if (!cancelled && local) setSrc(String(local));
      })
      .catch(() => undefined);
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
    />
  );
}
