## Nightfeed status

**Current:** v1.6.1 — Harden Telegram chat-ID matching (Requests/Admin lists).

# Status v1.6.1

## Fix
- `parseChatIds` / `telegramRoleForChat`: normalize unicode dashes, extract `-?\d+`, compare normalized forms
- Unknown-chat reply includes Save hint (Admin or Requests)
- Settings shows loaded Admin/Requests ID counts after Save
- Private chats also match `from.id`

## Works (carry-over)
- Library list performance + season bulk status (v1.6.0)
- Telegram Admin/Requests approve/deny workflow
- Manual mass-import, OpenVPN torrent-only split tunnel, auto-updates via GitHub Releases
