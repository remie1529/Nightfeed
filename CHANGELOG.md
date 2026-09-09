# Changelog

All notable Nightfeed releases. Also listed on the [GitHub repo page](README.md#version-log) and under [Releases](https://github.com/remie1529/Nightfeed/releases).

## 1.7.9

- Update checks on startup and every 6 hours; in-app banner when a release is ready
- Optional Telegram daily briefing of downloads in the last 24 hours (no message if nothing finished)
- OpenVPN pulls routes so torrents can download while connected (GUI will not show Nightfeed’s CLI session)
- Movie/show posters cached on disk
- Get other next to Get for already-downloaded episodes/movies
- Multiple TV and movie library roots, drag to reorder; top is default for new titles; existing season/movie folders are reused
- Removed “Prefer legal sources…” about text

## 1.7.8

- Movies tab cached (no per-folder disk scan on each visit)
- Telegram posters on requests, add, approve/deny, download finished
- Extra bot commands: `/search`, `/add-movie`, `/vpn`, `/pause`, `/resume`, `/missing`
- Scrollbar styled to match the dark Nightfeed chrome

## 1.7.7

- Auto-download / retry pick preferred resolution only
- Skip torrents with fewer than 8 seeders
- Rank by exact resolution first, then seeders; CAM/TS/trailer junk last
- TV results filtered to the matching SxxExx (not season packs)

## 1.7.6

- OpenVPN auto-connects on app start when enabled with an imported .ovpn
- Kill switch when Require VPN for torrents is on
- Admin Telegram alert on VPN drop / failed startup connect
- Persistent bottom-right banner until OpenVPN is connected
- One reconnect attempt after an unexpected drop

## 1.7.5

- Only 3 torrents download in WebTorrent at once; the rest stay queued
- Progress updates no longer re-render Library/Settings
- Unpack native `.node` addons so torrent utilityProcess can stay off the UI thread
- Yield the main process during library/movie loads and full refresh

## 1.7.4

- Disable uTP (Windows `no buffer space available` crash)
- Cap torrent peer connections at 80
- Ignore that socket error so it cannot take down the main process
- Pause torrents and VPN before Restart to install

## 1.7.3

- OpenVPN 2.7 startup notes are not treated as errors
- Management interface uses a local password; Nightfeed watches CONNECTED
- Settings only shows a red error for real failures

## 1.7.2

- OpenVPN starts through Interactive Service or a UAC prompt
- Import .ovpn also copies relative ca/cert/key files
- Settings shows the real OpenVPN log error

## 1.7.1

- In-app Requests tab with posters
- Admin web portal posters
- Public request page: removed “Your name (optional)”

## 1.7.0

- Local HTTP web request/admin portal
- Hyphenated Telegram `/request-show` / `/request-movie`

## 1.6.1

- Harden Telegram chat-ID matching for Admin/Requests

## 1.6.0

- Fast Library list + season bulk status

## 1.5.9

- Fix Scan folders radio layout

## 1.5.8

- Manual mass-import from library folders

## 1.5.7

- Telegram Admin vs Requests workflow with approve/deny

## 1.5.6

- App icon + OpenVPN torrent-only split tunnel

## 1.5.5

- Search stays responsive during downloads; backup export/import

## 1.5.4

- Rename app and repo to Nightfeed

## 1.5.3

- worker_threads search + utilityProcess WebTorrent; IMDb movie scrape

## 1.5.2

- Throttle progress, reject .exe torrents, FTP + UNC paths

## 1.5.1

- Movie metadata without TMDB API key

## 1.5.0

- Movie support with movie library
