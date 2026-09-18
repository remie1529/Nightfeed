# Nightfeed

![Nightfeed](build/icon.png)

Desktop TV show & movie manager with embedded torrent downloads.

**Electron · React · WebTorrent · TVMaze · IMDb**

**[Features & screenshots →](FEATURES.md)** — full showcase of Library, Movies, Downloads, Requests, Settings, VPN, Telegram, and the web portal.

---

## Install

1. Open [Releases](https://github.com/remie1529/Nightfeed/releases)
2. Download `Nightfeed-Setup-x.y.z.exe` (Windows x64)
3. Run the installer and launch **Nightfeed**

In-app updates check GitHub Releases on startup and every few hours.

---

## Features

Highlights below — see **[FEATURES.md](FEATURES.md)** for screenshots and detail.

- **TV library** — search & track shows via [TVMaze](https://www.tvmaze.com/) (no API key); filter to shows with missing episodes; full-width grid when maximized
- **Calendar** — week view of episode air dates
- **Movies** — search & metadata via IMDb.com scrape (no API key); separate movie library folder
- **Requests** — in-app Requests tab + web/Telegram request workflow with posters and approve/deny
- **Embedded downloads** — WebTorrent in an Electron `utilityProcess` when available
- **Multi-thread search** — torrent index fetch/merge/rank on `worker_threads`; library zoekfunctie (TVMaze / IMDb) on its own worker so search stays responsive during downloads
- **Multi-source torrents** — Apibay, Knaben, YourBittorrent, Torrents.csv, EZTV, AnimeTosho, Nyaa, LimeTorrents; optional Jackett
- **Quality gates** — preferred + minimum resolution; separate TV vs movie minimum file size per resolution
- **Auto-download** — missing episodes on a schedule; skip ignored
- **FTP upload** — optional upload when a download finishes
- **Telegram bot** — admin commands + request-only chats (`/request-show` / `/request-movie`, approve/deny)
- **Web portal** — local request page + admin approve/deny UI (optional LAN bind)
- **Backup** — export/import settings + TV + movie libraries (JSON; includes secrets — keep private)
- **Manual folder import** — Scan library folders & import (preview + confirm; never auto)
- **UNC paths** — Windows network library roots supported
- **Multiple library roots** — several TV/movie folders, drag to reorder; top is default for new titles
- **OpenVPN** — Nightfeed starts Community `openvpn.exe` (not the GUI), auto-connect, torrent-only split tunnel, kill switch
- **Live TV** — optional HDHomeRun tuner + XMLTV for Plex (M3U, Xtream Codes, or a direct stream)
- **Reliability** — startup loading screen until backend ready; optional crash-restart via Task Scheduler; collapsible full-width Settings

---

## Settings notes

| Setting | Purpose |
|--------|---------|
| TV / movie library roots | One or more folders; drag to set default |
| Torrent sources | Enable any combination |
| Max connections / speed caps | WebTorrent limits |
| Min size (TV / movies) | Separate per-resolution minimums |
| Backup | Export or replace-all import |
| VPN (OpenVPN) | Import `.ovpn`, auto-connect, torrent-only split tunnel, kill switch; own CLI session (not OpenVPN GUI) |
| Telegram Admin / Requests chat IDs | Admins get full control + approvals; Requests can only `/request` |
| Unknown Telegram chats | Bot replies only with `Your chat ID: …` |

---

## License

Copyright © 2026 **HoffSoftware**. All rights reserved.

Nightfeed is free for **private, personal use** only. Business use, resale, and commercial redistribution are not allowed without written permission from HoffSoftware.

Full terms: [LICENSE](LICENSE)

---

## Disclaimer

HoffSoftware / Nightfeed **does not condone** downloading movies or TV shows you do not have the rights to.

Nightfeed is a desktop tool. **You** choose what to search and download. Prefer legal sources and content you own or are licensed to use.

**We do not manage or host torrents or illegal files.**


## Develop

```bash
npm install
npm run dev          # Vite + Electron
npm run dist         # Windows NSIS installer → release/
```

Requires Node 20+ recommended. Product name: **Nightfeed**. Package name remains `tv-show-manager` for continuity.

---

## Version log

Full notes: [CHANGELOG.md](CHANGELOG.md) · [Releases](https://github.com/remie1529/Nightfeed/releases)

**1.9.6** — Separate minimum file size for TV shows vs movies (per resolution).
**1.9.5** — Crash-restart Task Scheduler without admin; Settings fills maximized width.
**1.9.4** — Collapsible Settings sections; library grid fills the window when maximized.
**1.9.3** — Loading screen stays until the backend is ready.
**1.9.2** — Startup loading screen; optional Task Scheduler restart after a crash.
**1.9.1** – **1.9.0** — Live TV icons, EPG mapping, fake guide for channels with no XMLTV.
**1.8.x** — Live TV for Plex, calendar, OpenVPN split tunnel, process-folder quality gates, web portal restyle, and more (see CHANGELOG).
