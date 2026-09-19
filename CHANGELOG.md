# Changelog

## 2.2.0

- **Per-show / per-movie monitoring**: on Show and Movie detail, toggle **Monitor for new episodes** / **Monitor for download**. When off (Paused), Nightfeed skips auto-download, upgrade hunting, and refresh snatch for that title only; global auto-download stays on for everything else. Manual Find / Get still works. Telegram approvals can still force a grab.
- **Library & Movies multi-select**: checkboxes on posters, select-all visible, clear selection, and a sticky bulk bar for pause/resume monitoring, status changes (TV: ignore/want missing episodes; Movies: missing/downloaded), and remove from library.


## 2.1.3

- VPN: fix false **handshake timed out** when OpenVPN was already up (Interactive Service)
- Treat `Initialization Sequence Completed` **or** `CONNECTED,SUCCESS` (log/mgmt) as connected; adopting a bind IP while connecting also promotes to connected
- Management: after auth send `state` (query) plus `state on` so late attach still sees CONNECTED; reconnect mgmt without treating `MANAGEMENT: Client disconnected` as VPN failure
- Soft wait (~25s) and hard timeout (~75s) re-scan `ovpn.log` / log buffer before Waiting… / failHandshake — never kill a tunnel that already reported success

## 2.1.2

- VPN: no code regression from 2.1.1 bind/kick — torrent `kickQueue` during OpenVPN handshake is now skipped / deduped so status spam cannot interfere
- VPN UX: stuck **Waiting for VPN handshake…** shows recent OpenVPN log lines + log path; hard-timeout (~75s) becomes an actionable **error** with Connect-to-retry
- Keep 2.1.1 queue/resume fixes


## 2.1.1

- Fix Downloads stuck on **Queued**: up to 3 torrents now start (**Downloading**) as soon as a slot is taken; the rest stay queued and promote when a slot frees
- Resume-after-restart applies engine settings and kicks the queue before/after restore so persisted items actually start
- Peer/seeder counts refresh while active (Health updates even at 0 B/s); waiting-in-queue no longer shows Health Dead


## 2.1.0

- **Minimum seeders** setting (default 8) for auto-download / best-torrent pick; picks below the threshold are skipped
- Downloads tab shows live **seeders**, peers, and a **Health** label (Excellent → Dead)
- Ranking: preferred resolution first, then higher seeders (Settings hint)
- Incomplete downloads **resume after restart / update** (persisted queue + WebTorrent path resume)
- Bulk **Scan folders & import**: past aired episodes without a local file are marked **ignored** (won’t snatch the back catalog); matched files stay downloaded; future/unaired unchanged
- Show detail opens the **latest season** by default
- **Per-show overrides** for preferred/minimum TV resolution and min file sizes (MB per 720/1080/2160); blank = use global
- **Upgrade hunting**: if an episode or movie was kept at minimum while preferred is higher, keep searching and queue preferred; old file replaced only after the upgrade passes quality checks
- Settings: remove “off by default” / AnimeTosho help wording from torrent & anime source UI


See [GitHub Releases](https://github.com/remie1529/Nightfeed/releases) for **2.0.0+** notes and installers.

## 2.0.3

- Episode Find / auto-download require torrent titles to match the show name (not just a shared franchise word + SxxExx)
- Soft-rank closer show-name matches first (fixes Monster anthology cross-hits)

## 2.0.2

- Remove leftover GitHub token field from Settings (Updates) — sorry it was still there after going public
- Updater uses public remie1529/Nightfeed Releases only (no token)

## 2.0.1

- Fix Find showing wrong episodes when no exact SxxExx match (no unfiltered fallback)
- Harden episode title matching against other SxxExx / NxNN tags


Older 1.x history was removed when Nightfeed went public with v2.0.0.