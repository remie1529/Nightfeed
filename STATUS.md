# Status v1.5.5

## Works
- Library zoekfunctie (TVMaze) + movie IMDb search on dedicated worker_threads metadata worker — stays responsive during active downloads
- Download progress no longer sync-writes electron-store every tick (debounced 5s + setImmediate); progress IPC ~1s throttle; candidates stripped from UI payload
- WebTorrent prefers utilityProcess (retry + 12s ready timeout); clear fallback warning if in-process
- Native File/Edit/View menu bar hidden (Menu.setApplicationMenu(null) + setMenuBarVisibility(false))
- Settings backup export/import (full electron-store JSON; replace-with-confirm; secrets included with UI warning)
- Movies: IMDb scrape; TV: TVMaze; FTP; UNC; multi-source torrents; Telegram; electron-updater + PAT

## Root cause (1.5.4 bug)
pushDownloads() called sync saveDownloads() (electron-store) on every progress update (~350ms), blocking the main event loop so tmdb:search / TVMaze fetch could not complete until the download finished.

## Artifacts
- /workspace/torrent-tv-manager
- Release v1.5.5 on remie1529/Nightfeed
