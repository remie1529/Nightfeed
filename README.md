# Nightfeed

Desktop TV show & movie manager with embedded torrent downloads.

**Electron · React · WebTorrent · TVMaze · IMDb**

---

## Install

1. Open [Releases](https://github.com/remie1529/Nightfeed/releases)
2. Download `Nightfeed-Setup-x.yz.exe` (Windows x64)
3. Run the installer and launch **Nightfeed**

In-app updates use GitHub Releases. Because this repo is **private**, add a GitHub personal access token under **Settings → Updates** (classic PAT with `repo`, or fine-grained with Contents: Read on this repo).

---

## Features

- **TV library** — search & track shows via [TVMaze](https://www.tvmaze.com/) (no API key)
- **Movies** — search & metadata via IMDb.com scrape (no API key); separate movie library folder
- **Embedded downloads** — WebTorrent in an Electron `utilityProcess` when available
- **Multi-thread search** — torrent index fetch/merge/rank on `worker_threads`; library zoekfunctie (TVMaze / IMDb) on its own worker so search stays responsive during downloads
- **Multi-source torrents** — Apibay, Knaben, YourBittorrent, Torrents.csv, EZTV, AnimeTosho, Nyaa, LimeTorrents; optional Jackett
- **Auto-download** — missing episodes on a schedule; skip ignored
- **FTP upload** — optional upload when a download finishes
- **Telegram bot** — status / search / downloads from chat
- **Backup** — export/import settings + TV + movie libraries (JSON; includes secrets — keep private)
- **UNC paths** — Windows network library roots supported

---

## Settings notes

| Setting | Purpose |
|--------|---------|
| TV / movie library roots | Where finished files are filed |
| Torrent sources | Enable any combination |
| Max connections / speed caps | WebTorrent limits |
| GitHub PAT | Private-repo update checks |
| Backup | Export or replace-all import |

Prefer legal sources and content you have rights to download.

---

## Develop

```bash
npm install
npm run dev          # Vite + Electron
npm run dist         # Windows NSIS installer → release/
```

Requires Node 20+ recommended. Product name: **Nightfeed**. Package name remains `tv-show-manager` for continuity.

---

## Version

**1.5.5** — library search stays responsive during downloads; hide native menu bar; backup export/import; README refresh.
