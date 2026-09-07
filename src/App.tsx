import { useEffect, useState } from 'react';
import Library from './views/Library';
import ShowDetail from './views/ShowDetail';
import Movies from './views/Movies';
import MovieDetail from './views/MovieDetail';
import Downloads from './views/Downloads';
import SettingsView from './views/Settings';
import type { DownloadItem, Movie } from './lib/types';

type View = 'library' | 'movies' | 'downloads' | 'settings' | 'show' | 'movie';

interface Toast {
  id: number;
  message: string;
  kind: string;
}

export default function App() {
  const [view, setView] = useState<View>('library');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedMovieId, setSelectedMovieId] = useState<number | null>(null);
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [libraryKey, setLibraryKey] = useState(0);
  const [moviesKey, setMoviesKey] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    window.torrentAPI.getAppVersion?.().then((v) => setAppVersion(String(v || ''))).catch(() => undefined);
    window.torrentAPI.getDownloads().then(setDownloads).catch(() => undefined);
    const offDl = window.torrentAPI.onDownloadsUpdate((items) => {
      setDownloads(items as DownloadItem[]);
    });
    const offLib = window.torrentAPI.onLibraryChanged(() => {
      setLibraryKey((k) => k + 1);
    });
    const offMovies = window.torrentAPI.onMoviesChanged?.(() => {
      setMoviesKey((k) => k + 1);
    });
    const offToast = window.torrentAPI.onToast((payload) => {
      const id = Date.now() + Math.random();
      setToasts((prev) => [...prev.slice(-4), { id, message: payload.message, kind: payload.kind || 'info' }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4500);
    });
    return () => {
      offDl();
      offLib();
      offMovies?.();
      offToast();
    };
  }, []);

  const openShow = (tmdbId: number) => {
    setSelectedId(tmdbId);
    setView('show');
  };

  const openMovie = (movie: Movie) => {
    setSelectedMovieId(movie.tmdbId);
    setView('movie');
  };

  const activeDownloads = downloads.filter(
    (d) => d.status === 'downloading' || d.status === 'queued' || d.status === 'paused'
  ).length;

  return (
    <div className="app-shell">
      <nav className="nav">
        <div className="brand">
          <div className="brand-name">Nightfeed</div>
          <div className="brand-sub">TV & Movies</div>
        </div>
        <button
          className={`nav-item ${view === 'library' || view === 'show' ? 'active' : ''}`}
          onClick={() => setView('library')}
        >
          Library
        </button>
        <button
          className={`nav-item ${view === 'movies' || view === 'movie' ? 'active' : ''}`}
          onClick={() => setView('movies')}
        >
          Movies
        </button>
        <button
          className={`nav-item ${view === 'downloads' ? 'active' : ''}`}
          onClick={() => setView('downloads')}
        >
          Downloads{activeDownloads ? ` (${activeDownloads})` : ''}
        </button>
        <button
          className={`nav-item ${view === 'settings' ? 'active' : ''}`}
          onClick={() => setView('settings')}
        >
          Settings
        </button>
        <div style={{ flex: 1 }} />
        <div style={{ padding: '0.75rem', color: 'var(--text-faint)', fontSize: '0.75rem' }}>
          {appVersion ? `v${appVersion}` : '…'} · local library
        </div>
      </nav>
      <main className="main">
        {view === 'library' && (
          <Library
            refreshToken={libraryKey}
            onOpenShow={openShow}
            onRefreshDone={() => setLibraryKey((k) => k + 1)}
          />
        )}
        {view === 'show' && selectedId != null && (
          <ShowDetail
            tmdbId={selectedId}
            onBack={() => setView('library')}
            onRemoved={() => {
              setSelectedId(null);
              setView('library');
              setLibraryKey((k) => k + 1);
            }}
          />
        )}
        {view === 'movies' && (
          <Movies
            key={moviesKey}
            onOpenMovie={openMovie}
            onRefreshDone={() => setMoviesKey((k) => k + 1)}
          />
        )}
        {view === 'movie' && selectedMovieId != null && (
          <MovieDetail
            tmdbId={selectedMovieId}
            onBack={() => setView('movies')}
            onRemoved={() => {
              setSelectedMovieId(null);
              setView('movies');
              setMoviesKey((k) => k + 1);
            }}
          />
        )}
        {view === 'downloads' && <Downloads items={downloads} />}
        {view === 'settings' && <SettingsView />}
      </main>
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
