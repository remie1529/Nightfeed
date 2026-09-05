# Torrent – TV Show & Movie Manager

Desktop TV show / movie manager (Electron + Vite + React). **v1.5.0**

## Free by default
- **TV metadata:** **TVMaze** — show info, episode air dates, and IMDb ids (for EZTV). No API key.
- **Movie metadata:** **TMDB** — free API key required (Settings → TMDB API key). Get one at [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api).
- Separate **movie library folder** (Settings) — movies never mix into the TV library root.
- Torrent sources (enable any combination in Settings – checkbox grid):
  1. **Apibay** — public Pirate Bay JSON API (apibay.org) — default on
  2. **Knaben** — meta-search JSON API (api.knaben.org) — default on
  3. **YourBittorrent** — public search JSON API — default on
  4. **Torrents.csv** — open dump search API (torrents-csv.com) — default on
  5. **EZTV** — TV-focused API via show IMDb id (eztxx.to) — default on (TV only)
  6. **AnimeTosho** — anime JSON feed — default on
  7. **Nyaa** — anime/raw RSS (nyaa.si) — default on
  8. **LimeTorrents** — public RSS (infohash → magnet) — default on
  9. **Jackett** — optional self-hosted meta-search — default off

Searches query all enabled sources in parallel, merge/dedupe by infohash, and rank by preferred resolution + seeders. Partial source errors never wipe other results. Movie search skips EZTV.

UIndex / FlareSolverr / Cloudflare unlock UI were removed in v1.4.0.

## Features
- Movies tab: search TMDB, track library status, download into `{Title} ({Year})/` under the movie library root
- Manual episode status in store
- Add-show older episode modal
- Auto-download skips ignored (TV)
- On download complete: status → Downloaded, item leaves Downloads queue, torrent destroyed (no seeding by default)
- WebTorrent settings: max connections (default 150), optional download/upload KiB/s caps (0 = unlimited)
- Extra public trackers on magnets for peer discovery
- Telegram and startup
- Auto update from private GitHub Releases (paste a PAT in Settings after installing)

## Setup

    npm install && npm run dev

## Build

    npm run dist
    npm run dist:dir
