# Torrent — TV Show Manager

Desktop TV show / episode manager (Electron + Vite + React). **v1.2.0**

## Free by default
- Metadata: TVMaze — no API key
- Search: Apibay — no key; optional Jackett

## Features
- Manual episode status in store
- Add-show older episode modal
- Auto-download skips ignored
- Telegram and startup
- Auto update from GitHub

## Setup

*** npm install && npm run dev

## Publishing a Release

Repo: remie1529/TV-Show-Manager
Bump version, then publish with electron-builder, or draft a Release and upload Torrent-Setup exe, blockmap, latest.yml.
Clients check on startup and via Settings Check for updates.

## Build

    npm run dist
    npm run dist:dir
