## Nightfeed status

**Current:** v1.7.7 — Auto-download only preferred resolution with enough seeders (skip 0–5 seed dead torrents).

# Status v1.7.7

## New
- Auto-download / retry pick **preferred resolution only** (1080p stays 1080p)
- Skip torrents with **fewer than 8 seeders** (0–5 seed releases almost never complete)
- Rank search results by exact resolution first, then seeders; CAM/TS/trailer junk last
- TV results filtered to the matching SxxExx (not season packs)

## Works (carry-over)
- OpenVPN auto-connect + torrent kill switch
- Max 3 active torrents, UI stays responsive
- Auto-updates
