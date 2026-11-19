import { useEffect, useRef, useState } from 'react';

export default function TrailerButton({ imdbId }: { imdbId?: string | null }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const reqGenRef = useRef(0);

  const close = () => {
    reqGenRef.current += 1;
    videoRef.current?.pause();
    setOpen(false);
    setBusy(false);
    setUrl(null);
    setError(null);
  };

  useEffect(() => {
    reqGenRef.current += 1;
    setOpen(false);
    setBusy(false);
    setUrl(null);
    setError(null);
  }, [imdbId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const play = async () => {
    const gen = ++reqGenRef.current;
    setOpen(true);
    setUrl(null);
    setError(null);
    if (!imdbId) {
      setError('No trailer for this title.');
      return;
    }
    setBusy(true);
    try {
      const res = await window.torrentAPI.getTrailer(imdbId);
      if (gen !== reqGenRef.current) return;
      if (!res?.url) setError('No trailer for this title.');
      else setUrl(res.url);
    } catch (e) {
      if (gen !== reqGenRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (gen === reqGenRef.current) setBusy(false);
    }
  };

  return (
    <>
      <button type="button" onClick={() => void play()} disabled={busy}>
        {busy ? 'Trailer…' : 'Trailer'}
      </button>
      {open && (
        <div className="modal-backdrop" onClick={close}>
          <div className="modal trailer-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h2>Trailer</h2>
              <button type="button" className="ghost" onClick={close}>
                Close
              </button>
            </header>
            <div className="body">
              {busy && <p className="trailer-status">Loading trailer…</p>}
              {error && <p className="trailer-status">{error}</p>}
              {url && (
                <video
                  ref={videoRef}
                  className="trailer-video"
                  src={url}
                  controls
                  autoPlay
                  playsInline
                  onError={() => {
                    setUrl(null);
                    setError('Trailer could not be played.');
                  }}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
