## Nightfeed status

**Current:** v1.9.0 — Live TV icons, EPG mapping, fake guide.

# Status v1.9.0

## New
- Per-channel custom icon and XMLTV EPG id
- Fake repeating EPG (per channel or auto when missing)

# Status v1.8.9

## New
- Convert IPTV HLS to MPEG-TS for Plex; VLC M3U headers; stream errors in the Live TV tab

# Status v1.8.8

## New
- IPTV → Plex HDHomeRun tuner (M3U / Xtream / direct), channel picker, tuners, buffer
- WebTorrent no longer recreates the client on VPN ifIndex-only updates; fewer peers / slower UI ticks

# Status v1.8.7

## New
- Calendar tab: Monday–Sunday week of episode air dates
- Library **Missing episodes** filter

# Status v1.8.6

## New
- OpenVPN TAP log was parsed as `10.x.x.0` (network); torrents now bind `10.x.x.228` (host)

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
