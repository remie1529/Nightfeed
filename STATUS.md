## Nightfeed status

**Current:** v1.7.6 — OpenVPN auto-connect on launch + torrent kill switch with Telegram and in-app banner.

# Status v1.7.6

## New
- OpenVPN **auto-connects on app start** when enabled with an imported .ovpn
- **Kill switch** when “Require VPN for torrents” is on: if OpenVPN drops, torrent sockets stop immediately (no download without VPN)
- Admin **Telegram alert** on VPN drop / failed startup connect
- Persistent **bottom-right banner** until OpenVPN is connected again
- One reconnect attempt after an unexpected drop

## Works (carry-over)
- Max 3 active torrents, UI stays responsive
- OpenVPN 2.7 / Interactive Service / UAC
- uTP disabled, auto-updates
