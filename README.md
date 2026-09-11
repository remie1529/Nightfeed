# Nightfeed

![Nightfeed](build/icon.png)

Desktop TV show & movie manager with embedded torrent downloads.

**Electron · React · WebTorrent · TVMaze · IMDb**

---

## Install

1. Open [Releases](https://github.com/remie1529/Nightfeed/releases)
2. Download `Nightfeed-Setup-x.y.z.exe` (Windows x64)
3. Run the installer and launch **Nightfeed**

In-app updates use GitHub Releases. Because this repo is **private**, add a GitHub personal access token under **Settings → Updates** (classic PAT with `repo`, or fine-grained with Contents: Read on this repo).

---

## Features

- **TV library** — search & track shows via [TVMaze](https://www.tvmaze.com/) (no API key)
- **Movies** — search & metadata via IMDb.com scrape (no API key); separate movie library folder
- **Requests** — in-app Requests tab + web/Telegram request workflow with posters and approve/deny
- **Embedded downloads** — WebTorrent in an Electron `utilityProcess` when available
- **Multi-thread search** — torrent index fetch/merge/rank on `worker_threads`; library zoekfunctie (TVMaze / IMDb) on its own worker so search stays responsive during downloads
- **Multi-source torrents** — Apibay, Knaben, YourBittorrent, Torrents.csv, EZTV, AnimeTosho, Nyaa, LimeTorrents; optional Jackett
- **Auto-download** — missing episodes on a schedule; skip ignored
- **FTP upload** — optional upload when a download finishes
- **Telegram bot** — admin commands + request-only chats (`/request-show` / `/request-movie`, approve/deny)
- **Web portal** — local request page + admin approve/deny UI (optional LAN bind)
- **Backup** — export/import settings + TV + movie libraries (JSON; includes secrets — keep private)
- **Manual folder import** — Scan library folders & import (preview + confirm; never auto)
- **UNC paths** — Windows network library roots supported
- **Multiple library roots** — several TV/movie folders, drag to reorder; top is default for new titles
- **OpenVPN** — Nightfeed starts Community `openvpn.exe` (not the GUI), auto-connect, torrent kill switch

---

## Settings notes

| Setting | Purpose |
|--------|---------|
| TV / movie library roots | One or more folders; drag to set default |
| Torrent sources | Enable any combination |
| Max connections / speed caps | WebTorrent limits |
| GitHub PAT | Private-repo update checks |
| Backup | Export or replace-all import |
| VPN (OpenVPN) | Import `.ovpn`, auto-connect, kill switch; own CLI session (not OpenVPN GUI) |
| Telegram Admin / Requests chat IDs | Admins get full control + approvals; Requests can only `/request` |
| Unknown Telegram chats | Bot replies only with `Your chat ID: …` |

---

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

**1.8.1** — Fix in-app updater stuck on “downloading…” (full installer download, progress, Retry/Install).

**1.8.0** — Process folder (download → verify resolution/size → rename → move); preferred + minimum resolution and min file size per resolution; redesigned request/admin website.

**1.7.9** — Update banner (startup + every 6h); optional Telegram daily download briefing; OpenVPN pulls routes so torrents work; poster disk cache; Get other; multiple library roots (drag to reorder).

**1.7.8** — Movies tab cache; Telegram posters; `/search` `/add-movie` `/vpn` `/pause` `/resume` `/missing`; app-styled scrollbar.

**1.7.7** — Auto-download only preferred resolution with ≥8 seeders; skip 0–5 seed and season packs.

**1.7.6** — OpenVPN auto-connect on launch; torrent kill switch; Telegram + in-app banner on drop.

**1.7.5** — Max 3 active torrents (rest queued); progress no longer re-renders the whole UI.

**1.7.4** — Disable uTP (Windows ENOBUFS crash); pause torrents before update install.

**1.7.3** — OpenVPN 2.7 handshake; ignore startup notes; management password.

**1.7.2** — OpenVPN Interactive Service / UAC; copy cert/key sidecars; real TAP errors.

**1.7.1** — In-app Requests tab; posters on admin/app requests; public request page no longer asks for a name.

**1.7.0** — Local web request/admin portal; hyphenated Telegram request commands.

**1.6.1** — Harden Telegram chat-ID matching (Requests/Admin lists).

**1.6.0** — Fast Library list + season bulk status.

**1.5.9** — Fix Scan folders radio layout.

**1.5.8** — Manual mass-import from library folders.

**1.5.7** — Telegram Admin vs Requests chat IDs; request workflow with approve/deny.

**1.5.6** — App icon + OpenVPN torrent-only split tunnel.

**1.5.5** — Search stays responsive during downloads; backup export/import.

**1.5.4** — Rename app and repo to Nightfeed.

**1.5.3** — worker_threads search + utilityProcess WebTorrent; IMDb movie scrape.

**1.5.2** — Throttle progress, reject .exe torrents, FTP + UNC paths.

**1.5.1** — Movie metadata without TMDB API key.

**1.5.0** — Movie support with movie library.
