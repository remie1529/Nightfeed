# Changelog

All notable Nightfeed releases. Also listed on the [GitHub repo page](README.md#version-log) and under [Releases](https://github.com/remie1529/Nightfeed/releases).

## 1.9.4

- Settings sections are collapsible (collapsed by default); Updates, Backup, and About stay open
- Library/Movies grid uses the full window width when maximized

## 1.9.3

- Loading screen stays up until the torrent engine, VPN detect, and settings are ready — then the UI appears

## 1.9.2

- Startup loading screen while Nightfeed initializes
- Settings: restart Nightfeed after a crash via Task Scheduler (`NightfeedCrashRestart`); a normal quit does not restart

## 1.9.1

- Live TV icons: CSP no longer blocks previews; custom files are stored as PNG and served at `/icon/{id}.png` for Plex
- Remote M3U logos for enabled channels are cached locally so Plex can fetch them

## 1.9.0

- Live TV: custom channel icon (URL or local file) and EPG id mapping from the XMLTV guide
- Fake EPG: repeating Live blocks per channel or automatically when a channel has no guide
- Custom icon/EPG survive playlist refresh

## 1.8.9

- Live TV streams to Plex: convert HLS (.m3u8) to MPEG-TS (Plex cannot play a raw playlist)
- Honor VLC M3U extras (`#EXTVLCOPT`, `|User-Agent=`), skip HEAD probes, TLS quirks, surface provider errors

## 1.8.8

- Live TV for Plex: HDHomeRun tuner + XMLTV (M3U, Xtream Codes, or a direct stream)
- Settings enable toggle; Live TV tab to pick channels, tuners, and Plex URLs
- Buffer: off, memory, or ffmpeg remux; IPTV stays off the torrent VPN
- Downloads: stop tearing down WebTorrent when only the VPN interface index changes (that froze the UI and killed speed)
- Cap peer connections at 48; slower progress/save ticks so the app stays responsive while torrents run

## 1.8.7

- Calendar tab: week view of episode air dates (Monday–Sunday), click an episode to open the show
- Library filter **Missing episodes** to show only series that still have missing/aired episodes

## 1.8.6

- Bind torrents to the TAP **host** IP (e.g. `10.33.112.228`), not the subnet `.0` parsed from the OpenVPN TAP log
- That wrong bind was why seeders never connected while the VPN itself was up

## 1.8.5

- Torrent sockets now force the OpenVPN TAP adapter on Windows (`IP_UNICAST_IF`) so they can reach seeders while Plex stays on the ISP IP
- Binding only the VPN IP was not enough: Windows still sent those packets out Ethernet

## 1.8.4

- Split tunnel now gives torrent sockets a path out the VPN so they can reach seeders
- Windows may ask for Administrator once so bound torrent traffic uses the TUN (Plex still uses your ISP IP)
- OpenVPN log is `%AppData%\\Nightfeed\\vpn\\ovpn.log`

## 1.8.3

- Get / Get other torrent list keeps Res, Size, Seeds, and Download inside the window
- Long torrent names wrap in the title column instead of pushing the other columns off-screen

## 1.8.2

- OpenVPN split tunnel restored: Plex, port-forwarding, and the browser keep your ISP IP
- Ignore `redirect-gateway` / def1 routes from the .ovpn and from the server (those were sending the whole PC through the VPN)
- Torrent sockets still bind to the TUN IP, with a high-metric VPN default so downloads can leave the tunnel
- Disconnect and reconnect VPN after installing this update, then confirm whatismyipaddress.com shows your normal IP

## 1.8.1

- In-app updater no longer hangs on “downloading…” for the private GitHub repo
- Full installer download (skip broken .blockmap delta), percent progress, Retry download, Install when ready

## 1.8.0

- Optional **process folder**: download first, check real video resolution and minimum size, rename, then move into the library
- **Preferred** and **minimum** TV/movie resolution, plus minimum file size (MB) per 720p / 1080p / 2160p
- Auto-download tries preferred first but never keeps a file below the minimum
- Request website restyle (public + admin): larger posters, type pills, stats, auto-refresh admin

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
