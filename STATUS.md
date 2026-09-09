## Nightfeed status

**Current:** v1.7.4 — Stop WebTorrent uTP ENOBUFS crash on update/downloads.

# Status v1.7.4

## New
- Disable uTP (UDP) — Windows `utp-native` was throwing uncaught **no buffer space available** during peer connect
- Cap torrent peer connections at 80
- Ignore that socket error so it cannot take down the main process
- Pause torrents and VPN before **Restart to install** an update

## Works (carry-over)
- OpenVPN 2.7 handshake / Interactive Service / UAC
- In-app Requests tab + admin/web posters
- Local HTTP web portal + Telegram approve/deny
- Library performance, mass-import, auto-updates
