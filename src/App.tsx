import { useEffect, useState } from 'react';
import Library from './views/Library';
import CalendarView from './views/Calendar';
import ShowDetail from './views/ShowDetail';
import Movies from './views/Movies';
import MovieDetail from './views/MovieDetail';
import Downloads from './views/Downloads';
import Requests from './views/Requests';
import SettingsView from './views/Settings';
import LiveTvView from './views/LiveTv';
import type { AppSettings, DownloadItem, Movie, UpdateStatus, VpnStatus } from './lib/types';

type View =
  | 'library'
  | 'calendar'
  | 'movies'
  | 'downloads'
  | 'requests'
  | 'settings'
  | 'show'
  | 'movie'
  | 'livetv';

interface Toast {
  id: number;
  message: string;
  kind: string;
}

export default function App() {
  const [view, setView] = useState<View>('library');
  const [showBack, setShowBack] = useState<View>('library');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedMovieId, setSelectedMovieId] = useState<number | null>(null);
  const [activeDownloads, setActiveDownloads] = useState(0);
  const [libraryKey, setLibraryKey] = useState(0);
  const [moviesKey, setMoviesKey] = useState(0);
  const [requestsKey, setRequestsKey] = useState(0);
  const [pendingRequests, setPendingRequests] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [vpnKillSwitch, setVpnKillSwitch] = useState(false);
  const [updateBanner, setUpdateBanner] = useState<UpdateStatus | null>(null);
  const [appVersion, setAppVersion] = useState('');
  const [liveTvOn, setLiveTvOn] = useState(false);

  useEffect(() => {
    window.torrentAPI.getAppVersion?.().then((v) => setAppVersion(String(v || ''))).catch(() => undefined);
    window.torrentAPI
      .getSettings()
      .then((s) => setLiveTvOn(!!(s as AppSettings).liveTvEnabled))
      .catch(() => undefined);
    const offSettings = window.torrentAPI.onSettingsChanged?.((s) => {
      setLiveTvOn(!!(s as AppSettings)?.liveTvEnabled);
    });
    const countActive = (items: DownloadItem[]) =>
      items.filter((d) => d.status === 'downloading' || d.status === 'queued' || d.status === 'paused').length;
    window.torrentAPI
      .getDownloads()
      .then((items) => setActiveDownloads(countActive(items as DownloadItem[])))
      .catch(() => undefined);
    const offDl = window.torrentAPI.onDownloadsUpdate((items) => {
      const n = countActive(items as DownloadItem[]);
      setActiveDownloads((prev) => (prev === n ? prev : n));
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
    const refreshPending = () => {
      window.torrentAPI
        .getPendingRequestCount?.()
        .then((n) => setPendingRequests(Number(n) || 0))
        .catch(() => undefined);
    };
    refreshPending();
    const offReq = window.torrentAPI.onRequestsChanged?.(() => {
      setRequestsKey((k) => k + 1);
      refreshPending();
    });
    const applyVpn = (s: VpnStatus | null | undefined) => {
      setVpnKillSwitch(!!s?.killSwitch);
    };
    window.torrentAPI.getVpnStatus?.().then((s) => applyVpn(s as VpnStatus)).catch(() => undefined);
    const offVpn = window.torrentAPI.onVpnStatus?.((s) => applyVpn(s as VpnStatus));
    const applyUpdate = (s: UpdateStatus | null | undefined) => {
      if (s && (s.available || s.downloaded)) setUpdateBanner(s);
      else setUpdateBanner(null);
    };
    window.torrentAPI.getUpdateStatus?.().then((s) => applyUpdate(s as UpdateStatus)).catch(() => undefined);
    const offUpd = window.torrentAPI.onUpdateStatus?.((s) => applyUpdate(s as UpdateStatus));
    const pendingTimer = setInterval(refreshPending, 20000);
    return () => {
      offDl();
      offLib();
      offMovies?.();
      offToast();
      offReq?.();
      offVpn?.();
      offUpd?.();
      offSettings?.();
      clearInterval(pendingTimer);
    };
  }, []);

  useEffect(() => {
    if (!liveTvOn && view === 'livetv') setView('settings');
  }, [liveTvOn, view]);

  const openShow = (tmdbId: number, back: View = 'library') => {
    setSelectedId(tmdbId);
    setShowBack(back === 'show' ? 'library' : back);
    setView('show');
  };

  const openMovie = (movie: Movie) => {
    setSelectedMovieId(movie.tmdbId);
    setView('movie');
  };

  return (
    <div className="app-shell">
      <nav className="nav">
        <div className="brand">
          <div className="brand-name">Nightfeed</div>
          <div className="brand-sub">TV & Movies</div>
        </div>
        <button
          className={`nav-item ${view === 'library' || (view === 'show' && showBack !== 'calendar') ? 'active' : ''}`}
          onClick={() => setView('library')}
        >
          Library
        </button>
        <button
          className={`nav-item ${view === 'calendar' || (view === 'show' && showBack === 'calendar') ? 'active' : ''}`}
          onClick={() => setView('calendar')}
        >
          Calendar
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
          className={`nav-item ${view === 'requests' ? 'active' : ''}`}
          onClick={() => setView('requests')}
        >
          Requests
          {pendingRequests > 0 ? <span className="nav-badge">{pendingRequests}</span> : null}
        </button>
        {liveTvOn && (
          <button
            className={`nav-item ${view === 'livetv' ? 'active' : ''}`}
            onClick={() => setView('livetv')}
          >
            Live TV
          </button>
        )}
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
        {view === 'calendar' && (
          <CalendarView
            refreshToken={libraryKey}
            onOpenShow={(id) => openShow(id, 'calendar')}
          />
        )}
        {view === 'show' && selectedId != null && (
          <ShowDetail
            tmdbId={selectedId}
            onBack={() => setView(showBack === 'calendar' ? 'calendar' : 'library')}
            onRemoved={() => {
              setSelectedId(null);
              setView('library');
              setLibraryKey((k) => k + 1);
            }}
          />
        )}
        {view === 'movies' && (
          <Movies
            refreshToken={moviesKey}
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
        {view === 'downloads' && <Downloads />}
        {view === 'requests' && <Requests refreshToken={requestsKey} />}
        {view === 'livetv' && liveTvOn && <LiveTvView />}
        {view === 'settings' && <SettingsView />}
      </main>
      <div className="toast-stack" aria-live="polite">
        {updateBanner && (
          <div className="vpn-kill-banner" style={{ background: '#241f14', borderColor: '#5a4d2a' }} role="status">
            <div className="vpn-kill-banner-title" style={{ color: 'var(--accent)' }}>
              Update {updateBanner.version || ''}
            </div>
            <div>
              {updateBanner.downloaded
                ? 'Ready to install.'
                : updateBanner.message || 'A new version is available.'}
            </div>
            {updateBanner.downloaded ? (
              <button type="button" className="primary" onClick={() => window.torrentAPI.installUpdate?.()}>
                Restart &amp; install
              </button>
            ) : (
              <button type="button" onClick={() => void window.torrentAPI.downloadUpdate?.()}>
                {typeof updateBanner.progress === 'number'
                  ? `Retry download (${updateBanner.progress}%)`
                  : 'Download update'}
              </button>
            )}
          </div>
        )}
        {vpnKillSwitch && (
          <div className="vpn-kill-banner" role="alert">
            <div className="vpn-kill-banner-title">VPN kill switch</div>
            <div>Torrents are paused until OpenVPN reconnects. No download traffic without the VPN.</div>
            <button type="button" onClick={() => setView('settings')}>
              Open Settings
            </button>
          </div>
        )}
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
