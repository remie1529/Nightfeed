## Nightfeed status

**Current:** v1.5.8 — Manual mass-import from library folders (Scan folders & import…).

# Status v1.5.8

## Works
- Settings / Library / Movies: **Scan folders & import…** (manual only — never on launch or timer)
- Scope: TV root, movie root, or both
- Preview with match status (will add / already in library / no match / ambiguous)
- Confirm → TVMaze shows + IMDb movies; skip already present; local files marked downloaded via existing path logic
- Progress + summary (added / skipped / failed)
- Read-only scan (no delete/move); UNC paths respected via configured roots

## Limitations
- Conservative metadata matching; ambiguous titles need user pick from alternatives
- Large libraries take time (rate-limited TVMaze/IMDb lookups)
