# Build log 01: feed generator (backfilled 2026-10-10 from git history)

## 2026-03-16 to 2026-04-05 · first pass
- commits: b021f23..716a209
- built: Top and My Skeets feeds; background scheduler with auto-refresh; in-memory cache; on-demand refresh endpoint; "include replies" option; worker pool; per-type refresh intervals; security and efficiency pass; pruning of deactivated or deleted accounts
- note: project predates this git history (the SQLite to JSON storage move happened earlier); exact date unknown
- note: refresh strategy changed twice in this span (see decisions/architecture-and-storage.md)
- live-tested: not recorded

## 2026-07-23 to 2026-08-27 · hardening and features
- commits: 80a9e1c..4970451
- built: atomic writes and metadata sidecar; `/health`; graceful SIGTERM shutdown; live progress bar; custom feed names, descriptions and icons; replies variants as separate feeds (up to four per account); dark mode; footer with live avatar and Ko-fi link; Help modal; any-PDS login
- note: no commits between 2026-04-05 and 2026-07-23, or between 2026-07-26 and 2026-08-27
- live-tested: not recorded
