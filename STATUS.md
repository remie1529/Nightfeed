## Nightfeed status

**Current:** v1.7.2 — OpenVPN connect via Interactive Service/UAC, sidecar certs, real TAP/TUN errors.

# Status v1.7.2

## New
- OpenVPN starts through **Interactive Service** when available, otherwise a **UAC prompt**, so TAP/TUN can be created without running Nightfeed as admin
- Import `.ovpn` also copies relative `ca` / `cert` / `key` files from the same folder
- Settings shows the **real OpenVPN log error** instead of a generic TAP/TUN exit
- OpenVPN must be installed on the same PC as Nightfeed (Community edition); a VPN on another device is not used

## Works (carry-over)
- In-app Requests tab + admin/web posters
- Local HTTP web portal (default 8787) + Telegram approve/deny
- Hyphenated Telegram `/request-show` / `/request-movie`
- Library performance, mass-import, OpenVPN torrent-only, auto-updates
