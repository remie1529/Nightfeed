## Nightfeed status

**Current:** v1.8.5 — TAP-forced torrent sockets (IP_UNICAST_IF); Plex stays on ISP IP.

# Status v1.8.5

## New
- Windows torrent TCP uses IP_UNICAST_IF on the OpenVPN TAP index so seeders are reachable without a full-tunnel default route

# Status v1.8.4

## New
- High-metric TUN default plus Windows strong-host on the LAN so torrent sockets bound to the VPN actually leave through the tunnel
- One-time Administrator prompt (scheduled task) so this routing survives later Connects
- OpenVPN log: `%AppData%\Nightfeed\vpn\ovpn.log`

# Status v1.8.3

## New
- Long torrent titles wrap in the Find window
- Res, Size, Seeds, and Download stay on one line (no clipped columns)

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
