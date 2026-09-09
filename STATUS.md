## Nightfeed status

**Current:** v1.7.3 — OpenVPN 2.7 handshake: ignore startup notes, management password, CONNECTED state.

# Status v1.7.3

## New
- OpenVPN 2.7 startup notes (`--allow-compression`, management warning, version banner) are not treated as errors
- Management interface uses a local password; Nightfeed watches **CONNECTED** instead of guessing from the log
- Settings only shows a red error for real failures (auth, missing certs, TAP/DCO)

## Works (carry-over)
- OpenVPN Interactive Service / UAC, sidecar certs
- In-app Requests tab + admin/web posters
- Local HTTP web portal + Telegram approve/deny
- Library performance, mass-import, OpenVPN torrent-only, auto-updates
