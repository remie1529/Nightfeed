# Torrent – TV Show Manager

Desktop TV show / episode manager (Electron + Vite + React). **v1.3.3**

## Free by default
- Metadata: **TVMaze** — show info and episode air dates, no API key
- Torrent sources (enable any combination in Settings):
  - **Apibay** — public Pirate Bay JSON API miror; no key
  - **UIndex** — public torrent index at uindex.org (persistent Chromium session + visible Cloudflare unlock + optional FlareSolverr); no key
  - **Jackett** — optional self-hosted meta-search if you run Jackett yourself

Searches query **all enabled** sources, merge/dedupe by infohash, and rank by preferred resolution + seeders.

## UIndex Cloudflare
UIndex uses persist:uindex so CF cookies survive restarts. A visible unlock window handles Turnstile. Settings: Unlock UIndex (Cloudflare), Clear UIndex cookies, optional FlareSolverr (parses solution.response HTML directly).
If unlock still fails: docker run -d -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest

## Features
- Manual episode status in store
- Add-show older episode modal
- Auto-download skips ignored
- Telegram and startup
- Auto update from private GitHub Releases (paste a PAT in Settings after installing)

## Setup

    npm install && npm run dev

## Publishing a Release

Repo: remie1529/TV-Show-Manager
Bump version, then publish with electron-builder, or draft a Release and upload Torrent-Setup exe, blockmap, latest.yml.
Clients check on startup and via Settings Check for updates.

## Build

    npm run dist
    npm run dist:dir
