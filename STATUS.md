# Status v1.5.0

## Works
- Movies: TMDB search/metadata (free API key), separate movieLibraryRoot, Movies + MovieDetail UI
- Movie torrent search (multi-source, skips EZTV); downloads only under movieLibraryRoot
- Download complete for movies -> status downloaded + movies:changed; TV unchanged
- Manual episode status overrides in electron-store
- Add-show older-episode modal
- Auto-download skips Ignored
- Download complete -> setEpisodeOverride downloaded, remove from queue, torrent.destroy({ destroyStore: false })
- WebTorrent maxConns default 150; Settings speed/connection caps
- Extra public UDP/WSS trackers on magnets; select largest video file early
- electron-updater + private GitHub via Settings githubToken (PAT)
- Nav version label from app.getVersion()
- TVMaze metadata + IMDb id on show for EZTV
- Multi-source torrent search (Apibay, Knaben, YourBittorrent, Torrents.csv, EZTV, AnimeTosho, Nyaa, LimeTorrents, optional Jackett)
- Settings: torrent sources grid; movie library picker; TMDB key; default movie resolution
- Parallel search, merge/dedupe by infohash, rank by resolution + seeders

## Removed (v1.4.0)
- UIndex / FlareSolverr / Cloudflare unlock UI

## Artifacts
- /workspace/torrent-tv-manager
- Release v1.5.0 on remie1529/TV-Show-Manager
