# Torrent – TV Show Manager

Desktop TV show / episode manager (Electron + Vite + React). **v1.4.1**

## Free by default
- Metadata: **TVMaze** — show info, episode air dates, and IMDb ids (for EZTV). No API key.
- Torrent sources (enable any combination in Settings – checkbox grid):
  1. **Apibay** — public Pirate Bay JSON API (apibay.org) — default on
  2. **Knaben** — meta-search JSON API (api.knaben.org) — default on
  3. **YourBittorrent** — public search JSON API — default on
  4. **Torrents.csv** — open dump search API (torrents-csv.com) — default on
  5. **EZTV** — TV-focused API via show IMDb id (eztxx.to) — default on
  6. **AnimeTosho** — anime JSON feed — default on
  7. **Nyaa** — anime/raw RSS (nyaa.si) — default on
  8. **LimeTorrents** — public RSS (infohash → magnet) — default on
  9. **Jackett** — optional self-hosted meta-search — default off

Searches query all enabled sources in parallel, merge/dedupe by infohash, and rank by preferred resolution + seeders. Partial source errors never wipe other results.

UIndex / FlareSolverr / Cloudflare unlock UI were removed in v1.4.0.

## Features
- Manual episode status in store
- Add-show older episode modal
- Auto-download skips ignored
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
