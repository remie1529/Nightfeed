# Status v1.5.3

## Works
- Multi-core CPU: torrent search (fetch + merge/dedupe by infohash + resolution ranking) on `worker_threads` pool (size = min(4, CPUs))
- WebTorrent in Electron `utilityProcess` when available (piece hashing / peer churn off UI process); in-process fallback
- Movie metadata via IMDb.com scrape (suggestion search + GraphQL/HTML detail) — no API key; TV stays on TVMaze
- Movies: separate movieLibraryRoot; posters from m.media-amazon.com
- Progress IPC throttled, async rename, maxConnections 200, .exe skip+retry, UNC+FTP
- Multi-source torrent search; Jackett optional; electron-updater + GitHub PAT

## Removed
- Wikidata movie metadata (replaced by IMDb scrape in 1.5.3)
- TMDB API key requirement for movies (1.5.1+)

## Artifacts
- /workspace/torrent-tv-manager
- Release v1.5.3 on remie1529/TV-Show-Manager
