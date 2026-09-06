# Status v1.5.6

## Works
- App icon (build/icon.png + multi-size build/icon.ico) wired into electron-builder / BrowserWindow
- OpenVPN Settings: enable, import .ovpn into userData, optional user/pass (never logged), connect/disconnect + status
- Split intent: openvpn `--route-nopull` + ignore redirect-gateway; WebTorrent TCP `localAddress` bind to detected TUN/TAP IP; DHT/uTP off while bound
- Optional "Require VPN for torrents" gates manual + auto downloads
- Does not ship openvpn.exe — detects PATH / Program Files\OpenVPN\bin

## Limitations
- Admin rights often needed for TAP/TUN
- Until TUN/TAP IP is detected, torrent bind is pending (honest Settings hint)
- Tracker announces may still use the default route; metadata APIs never go through VPN
- Mid-download VPN bind change stops those torrents (restart download)

## Artifacts
- /workspace/torrent-tv-manager
- Release v1.5.6 on remie1529/Nightfeed
