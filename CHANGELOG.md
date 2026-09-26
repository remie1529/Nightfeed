# Changelog

## 2.4.7

### Changed
- Custom Live TV channels transcode video on the GPU when ffmpeg has NVENC (NVIDIA), Quick Sync (Intel), or AMF (AMD). Audio is AAC. If the GPU encoder fails to start, that channel falls back to the CPU.

## 2.4.6

### Changed
- Custom Live TV channels install ffmpeg automatically into Nightfeed’s app data the first time one plays (if it is not already on the PC)

## 2.4.5

### Added
- Live TV custom channels that play your downloaded library: random or latest movies, episodes, a mix, or one show in order
- The XMLTV guide lists the actual title on that channel (show, episode, or movie)

### Notes
- ffmpeg is required for these channels
- Includes `latest.yml` on the GitHub release for auto-update

## 2.4.4

### Changed
- Find / Get other torrent window no longer shows search notes (for example “Dropped N pre-air torrent(s)”). Those stay in the activity Log.
- GitHub README no longer shows the large logo above the description

## 2.4.3

### Added
- **TV episode air-date torrent filter**: Find and auto-hunt keep only torrents published on/after the episode air date when the upload date is known (UTC calendar day)
- `SearchResult.publishedAt` parsed from sources that expose it (RSS `pubDate`, API `added`/`created`/`date`/`PublishDate`, etc.); undated results are still shown
- Hunt skips episodes that have not aired yet (reinforces existing upcoming status skip)
- Activity log notes when pre-air torrents are dropped
- Settings hint: episode torrents before air date are ignored when the date is known

### Notes
- No VPN / OpenVPN / bind / split-tunnel changes
- Includes `latest.yml` on the GitHub release for auto-update


## 2.4.2

### Added
- **TV `.nfo` metadata** for Plex / Kodi local agents: writes `tvshow.nfo` in the show root and an episode `.nfo` beside each placed video (same basename as the `.mkv`/`.mp4`)
- `tvshow.nfo` is upserted on successful episode place, when a season folder is created for a download, on single-show refresh, and during refresh-all (folder scan import too)
- **Movies (nice-to-have):** `movie.nfo` plus basename `.nfo` beside the video on successful movie place
- Kodi-shaped XML with title/plot/premiered/year, `uniqueid` for IMDb + TVMaze (show id field), optional poster/fanart URLs
- Activity log: brief `NFO written:` lines per file on download complete; refresh-all reports `tvshow.nfo` count

### Notes
- Folder naming unchanged; VPN / workers unchanged
- Includes `latest.yml` on the GitHub release for auto-update


## 2.4.1

### Fixed
- **Refresh all → hunt UI freeze** on large libraries (300+ shows): library worker now **streams** finished shows in small batches instead of returning one giant structured-clone of every show tree
- Main **upserts with yields** between batches and **throttles `library:changed`** (~500ms) during bulk refresh, with one final emit at the end
- Hunt receives **compact hunt DTOs** (ids + candidate episodes only) — no second full-library postMessage clone
- Hunt verbose logs stay detailed but are **batched** to main (logBatch) so sync IPC does not flood the UI thread
- Library / App renderer **ignore or debounce** mid-refresh `library:changed` floods so poster grids are not fully re-rendered on every emit
- Bulk refresh persists the store every few shows instead of rewriting the entire library file after each upsert

### Notes
- No VPN / OpenVPN / bind / split-tunnel changes
- Includes `latest.yml` on the GitHub release for auto-update


## 2.4.0

### Added
- **Verbose hunt logging restored**: paused shows, ignored episodes, already-downloading, already-have / no-upgrade, status skips, each show scan line, pick reasons, and download starts all appear again in **See log**.
- Hunt worker **streams** log lines to the activity log while hunting (not only a summary at the end).
- **Log writer worker**: activity log file I/O runs on a dedicated worker with buffered async flushes so spam does not freeze the UI (falls back to main if the worker cannot start).
- **FTP worker**: finished-file uploads run off main.
- **Backup worker**: heavy JSON stringify/parse + read/write for export/import run off main.
- **Live TV worker**: lineup / M3U / Xtream / XMLTV fetch+parse run off main; HDHomeRun server stays on main.
- **Telegram send worker**: outbound notify/sendMessage/sendPhoto HTTP runs off main; bot receive/polling stays on main.

### Changed
- Hunt download kickoff still uses the torrent utility path; applying many intents yields between starts so the UI stays responsive.
- App update check/download remains on Electron main (`electron-updater` requires it); logging unchanged.
- VPN / OpenVPN / bind / split-tunnel connect logic **unchanged**; VPN status wiring stays on main.

### Notes
- Existing library / hunt / torrent-utility / search / metadata workers kept.
- Activity log notes worker vs main-fallback once per subsystem.

## 2.3.6

- **Fix**: Auto hunt after refresh no longer freezes the UI — decision/search/pick run on a dedicated `hunt-worker` (`worker_threads`), not Electron main yields
- Worker returns start-download intents only; main handles VPN/kill-switch gate, `downloadEngine.start` / `startMovie` (yielded), progress UI, and activity-log summaries
- Packaged `hunt-worker.js` via vite + `asarUnpack` (same pattern as library/search workers); falls back to main only if the worker fails to start (one log line)
- Same monitored / ignored / upgrade / tried-hash rules; Manual Find unchanged; WebTorrent stays in torrent-utility; no VPN changes
- Activity log: hunt uses worker vs fallback; routine skips summarized (no per-skip spam)

## 2.3.5

- **Fix**: Library **Refresh all** / hunt no longer freezes the UI — heavy TVMaze fetch + local episode indexing run on a dedicated `library-worker` (`worker_threads`), not Electron main or the GUI
- Main only orchestrates: start job, receive progress/results, upsert store, then auto-download/hunt (chunked with yields so Downloads/Settings stay clickable)
- Folder **Scan & import** preview + TV metadata fetch use the same worker; falls back to main only if the worker fails to start (one activity-log line, no spam)
- Packaged `library-worker.js` via vite + `asarUnpack` (same pattern as metadata/search workers)
- Monitored / ignored / upgrade rules unchanged; WebTorrent stays in `torrent-utility`; no VPN changes

## 2.3.4

- **Fix**: Full library **Refresh all** no longer freezes the UI on large libraries (300+ shows)
- Still runs on **Electron main** (not utilityProcess / search workers) — needs store, download engine, and VPN checks — but yields the event loop between every show and every movie hunt job so Settings / Downloads stay navigable
- `library:refreshAll` returns immediately and streams progress / done events; activity log records start + finish with duration and counts
- Movie upgrade hunt: stop INFO-spamming every “already have / no upgrade needed”; one summary line (e.g. skipped 9 already-have). Started downloads and real failures unchanged
- Monitored / ignored / upgrade rules unchanged; no VPN changes

## 2.3.3

- **Fix**: Episode **Ignored** now overrides everything — including when a file is already on disk or a download is active
- Status resolve priority: ignored → downloading → on-disk downloaded → other overrides → air-date
- Setting Ignored (episode or season) cancels any active download for that ep and remembers tried hashes; refresh keeps Ignored (not flipped back to Downloaded)
- Download complete no longer writes a `downloaded` override if the user already set Ignored
- Auto hunt / upgrade / try-next skip ignored (status or override); activity log notes when Ignored overrides a downloaded file or cancels a download
- Manual Find stays available; no VPN changes

## 2.3.2

- **Fix**: WebTorrent `utilityProcess` failed to start on packaged Windows builds because the unpacked entry could not `require()` WebTorrent's JS deps that live only inside `app.asar`
- Set `NODE_PATH` (and a Module.globalPaths bootstrap) so the download helper resolves `app.asar` + `app.asar.unpacked` node_modules
- **Floater / backup download worker**: still only one active WebTorrent utilityProcess; if it fails to become ready, exits, or crashes mid-session, automatically spawn a replacement with backoff (limited retries) and hand the queue to it
- Only fall back to the UI/main process if the floater also cannot start; toast: “Download worker unavailable — using UI process until restart” + concrete reason in **See log**
- Not a pool of idle download workers — search workers stay separate and unchanged
- No VPN / OpenVPN / bind / split-tunnel changes

## 2.3.1

- **Richer activity log**: See log now trails essentially every meaningful action with timestamps
- Auto hunt: which shows/movies are scanned, each episode/movie check, skip reasons (monitoring paused, ignored, already downloading, already have, below min seeders, tried hashes, no candidates)
- Torrent choice in plain words (title, short infoHash, resolution, seeders, preferred/upgrade/try-next, skipped tried hashes)
- Cancel/abandon always includes reason (user cancel, 1h stuck, exe/quality reject, replaced by next)
- Also: refresh/scan/import, episode/season status, backup, requests/Telegram, updater, FTP, Live TV, portal apply, download progress milestones (25/50/75%), restore-after-restart
- Still omits passwords, tokens, VPN credentials, and full magnet URIs (~7 day retention unchanged)
- No VPN/OpenVPN/bind/split-tunnel logic changes

## 2.3.0

- **Activity log**: Settings → Logging → **See log** opens an in-app viewer (not Notepad)
- Timestamped lines for app start/quit, settings saves, library add/remove/refresh, monitor pause/resume, search start/results, download start/pause/resume/cancel/complete/fail/stuck-abandon/try-next, Telegram approve/deny, toasts/errors, and VPN connect/disconnect status changes (no VPN logic changes)
- Daily log files under userData `logs/` with ~**7 day** auto-prune; secrets and full magnets omitted
- Viewer: scrollable dark UI, newest-at-bottom toggle, live refresh, Copy, Open folder

## 2.2.1

- **Downloads seeders**: show real connected seeder count from the torrent engine (no more confusing `0 / N L`); remove the Peers column
- **Health**: never mark DEAD while download speed is > 0; Health tracks seeders + transfer again
- **Tried / rejected torrents**: persist infohashes per episode/movie across restarts (cancel, exe/quality reject, stuck abandon) and skip them on the next auto-download / try-next search
- **Stuck 1 hour**: if an active download gains ~no bytes for 1 hour, abandon it, record as tried, and automatically start the next candidate

## 2.2.0

- **Per-show / per-movie monitoring**: on Show and Movie detail, toggle **Monitor for new episodes** / **Monitor for download**. When off (Paused), Nightfeed skips auto-download, upgrade hunting, and refresh snatch for that title only; global auto-download stays on for everything else. Manual Find / Get still works. Telegram approvals can still force a grab.
- **Library & Movies multi-select**: checkboxes on posters, select-all visible, clear selection, and a sticky bulk bar for pause/resume monitoring, status changes (TV: ignore/want missing episodes; Movies: missing/downloaded), and remove from library.


## 2.1.3

- VPN: fix false **handshake timed out** when OpenVPN was already up (Interactive Service)
- Treat `Initialization Sequence Completed` **or** `CONNECTED,SUCCESS` (log/mgmt) as connected; adopting a bind IP while connecting also promotes to connected
- Management: after auth send `state` (query) plus `state on` so late attach still sees CONNECTED; reconnect mgmt without treating `MANAGEMENT: Client disconnected` as VPN failure
- Soft wait (~25s) and hard timeout (~75s) re-scan `ovpn.log` / log buffer before Waiting… / failHandshake — never kill a tunnel that already reported success

## 2.1.2

- VPN: no code regression from 2.1.1 bind/kick — torrent `kickQueue` during OpenVPN handshake is now skipped / deduped so status spam cannot interfere
- VPN UX: stuck **Waiting for VPN handshake…** shows recent OpenVPN log lines + log path; hard-timeout (~75s) becomes an actionable **error** with Connect-to-retry
- Keep 2.1.1 queue/resume fixes


## 2.1.1

- Fix Downloads stuck on **Queued**: up to 3 torrents now start (**Downloading**) as soon as a slot is taken; the rest stay queued and promote when a slot frees
- Resume-after-restart applies engine settings and kicks the queue before/after restore so persisted items actually start
- Peer/seeder counts refresh while active (Health updates even at 0 B/s); waiting-in-queue no longer shows Health Dead


## 2.1.0

- **Minimum seeders** setting (default 8) for auto-download / best-torrent pick; picks below the threshold are skipped
- Downloads tab shows live **seeders**, peers, and a **Health** label (Excellent → Dead)
- Ranking: preferred resolution first, then higher seeders (Settings hint)
- Incomplete downloads **resume after restart / update** (persisted queue + WebTorrent path resume)
- Bulk **Scan folders & import**: past aired episodes without a local file are marked **ignored** (won’t snatch the back catalog); matched files stay downloaded; future/unaired unchanged
- Show detail opens the **latest season** by default
- **Per-show overrides** for preferred/minimum TV resolution and min file sizes (MB per 720/1080/2160); blank = use global
- **Upgrade hunting**: if an episode or movie was kept at minimum while preferred is higher, keep searching and queue preferred; old file replaced only after the upgrade passes quality checks
- Settings: remove “off by default” / AnimeTosho help wording from torrent & anime source UI


See [GitHub Releases](https://github.com/remie1529/Nightfeed/releases) for **2.0.0+** notes and installers.

## 2.0.3

- Episode Find / auto-download require torrent titles to match the show name (not just a shared franchise word + SxxExx)
- Soft-rank closer show-name matches first (fixes Monster anthology cross-hits)

## 2.0.2

- Remove leftover GitHub token field from Settings (Updates) — sorry it was still there after going public
- Updater uses public remie1529/Nightfeed Releases only (no token)

## 2.0.1

- Fix Find showing wrong episodes when no exact SxxExx match (no unfiltered fallback)
- Harden episode title matching against other SxxExx / NxNN tags


Older 1.x history was removed when Nightfeed went public with v2.0.0.