## Nightfeed status

**Current:** v1.8.2 — OpenVPN split tunnel restored (ISP IP for Plex / port-forward).

# Status v1.8.2

## New
- Split tunnel again: `route-nopull`, ignore `redirect-gateway` def1, high-metric TUN default
- Strip full-tunnel lines from the imported .ovpn so the VPN cannot steal the PC default route
- Torrent sockets bind to the VPN IP; whatismyipaddress.com / Plex should show the ISP IP
- Disconnect + reconnect OpenVPN after installing

# Status v1.8.1

## New
- Private GitHub updates use a full installer download (no .blockmap hang)
- Progress percent, Retry download, Restart & install when the file is actually ready
