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
  const src = path ? window.torrentAPI.posterUrl(path, width > 200 ? 'w500' : 'w342') : null;
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
  return <img className="poster" src={src} alt={alt} width={width} height={height} />;
}
