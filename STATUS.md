## Nightfeed status

**Current:** v1.7.1 — In-app Requests tab + request posters (admin & app); public web request name field removed.

# Status v1.7.1

## New
- In-app **Requests** nav tab (no password): pending Approve/Deny, recent history, posters, pending count badge
- Admin web portal `/admin` pending/recent rows show movie/TV **posters**
- Persist `posterUrl` on TelegramRequest (Telegram + web); backfill from TVMaze/IMDb when missing
- Public `/request` page: removed “Your name (optional)” — anonymous/Web requests only

## Works (carry-over)
- Local HTTP web portal (default 8787) + Telegram approve/deny
- Hyphenated Telegram `/request-show` / `/request-movie`
- Library performance, mass-import, OpenVPN torrent-only, auto-updates
