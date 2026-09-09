## Nightfeed status

**Current:** v1.7.5 — Keep UI responsive: max 3 active torrents, no full-app re-render on progress.

# Status v1.7.5

## New
- Only **3 torrents** download in WebTorrent at once; the rest stay queued until a slot frees
- Progress updates no longer re-render Library/Settings; Downloads page owns its own list
- Unpack native `.node` addons so torrent **utilityProcess** can stay off the UI thread
- Yield the main process during library/movie loads and full refresh

## Works (carry-over)
- OpenVPN 2.7 / Interactive Service / UAC
- uTP disabled (Windows ENOBUFS)
- Requests tab, web portal, Telegram, auto-updates
