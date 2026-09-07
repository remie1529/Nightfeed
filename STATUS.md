## Nightfeed status

**Current:** v1.7.0 — Local web request/admin portal + hyphenated Telegram commands.

# Status v1.7.0

## New
- Local HTTP web portal (default port 8787): public `/` `/request`, admin `/admin` with hashed password + session cookie
- Settings: enable portal, port, bind (localhost/LAN), admin password, show portal URL
- Web requests create the same pending TelegramRequest records; admin chats get approve/deny notify when configured
- Telegram: `/request-show` / `/request-movie` (legacy `/request show|movie` still accepted); /help documents hyphen forms only

## Works (carry-over)
- Negative Telegram group chat IDs (hardened in 1.6.1) with web + telegram
- Library list performance + season bulk status
- Telegram Admin/Requests approve/deny workflow
- Manual mass-import, OpenVPN torrent-only split tunnel, auto-updates via GitHub Releases
