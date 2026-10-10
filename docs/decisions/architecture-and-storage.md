# Decisions: architecture and storage

### 2026-03-16 · Incremental refresh for chrono feeds, with an in-memory cache · partly superseded
- what: fetch only posts newer than the newest stored one; cache feeds in memory
- why: not recorded
- source: b021f23
> the incremental cutoff was replaced on 2026-03-17 and restored differently on 2026-03-26 (entries below)

### 2026-03-17 · Full refresh every cycle instead of incremental · superseded
- what: both feed types refetch fully each cycle; default interval 60 to 15 min
- why: the incremental cutoff used `posts[0].indexedAt`, but the API sorts by createdAt, so a pinned or reordered post could end the scan early and silently miss new posts
- source: e444928
> superseded by the 2026-03-26 entry (6d0dd02)

### 2026-03-26 · Incremental refresh restored, plus a full refresh every 24h · active
- what: after the first full fetch, fetch only newer posts; Top Skeets does a full refresh every 24h to update like counts (My Skeets got the same 24h full refresh on 2026-04-05 to fix missing posts)
- why: cut per-cycle API calls from hundreds of pages to typically 1 to 2 for large accounts
- source: 6d0dd02, 716a209

### 2026-03-26 · Post fetching is decoupled from registration · active
- what: registration publishes the record and returns at once; posts are fetched in the background
- why: avoid Railway's HTTP timeout for accounts with large histories
- source: 7898256

### 2026-07-23 · Feeds are JSON files, not a database · active
- what: one JSON file per feed in `DATA_DIR`; SQLite and the sql.js dependency removed; `DATABASE_PATH` still honored as a legacy fallback (its directory is used)
- why: not recorded
- source: 3c1f5ae (deleted the "SQLite to JSON" and filename migrations as "long completed in production"); README
- note: the move to JSON happened before this git history; exact date unknown

### 2026-07-23 · Atomic writes, self-healing index, corrupt-file quarantine · active
- what: write via temp file and rename; rebuild a bad `_index.json` from the feed files; quarantine corrupt feed files as `.corrupt` with a loud log
- why: a crash or SIGTERM mid-write could truncate a file; a corrupt index had wiped every handle-to-DID mapping on the next registration
- source: 80a9e1c

### 2026-07-23 · `_meta.json` sidecar and a bounded LRU cache · active
- what: all feed metadata except posts kept in a sidecar and in memory; cache capped at 50 entries; derived state, rebuilt from feed files if missing
- why: scheduler due-checks and lookups need no feed-file reads
- source: fb929e6

### 2026-07-23 · Refresh pacing tuned: 5-minute ticks, jittered 24h full refresh, hourly Top Skeets incremental · active
- what: tick every 5 min; 0 to 6 h deterministic jitter on the 24h full refresh; Top Skeets incremental hourly
- why: spread the daily refetch burst across the day; new posts appear within about an hour
- source: 9a6a3b5
- note: values have been tuned several times; the code is the source of truth

### 2026-07-24 · Reposts are skipped before the incremental cutoff check · active
- what: a repost's `indexedAt` is the original post's time, so it can no longer end the scan; `POST /api/refresh` now forces a full refetch in the background
- why: a repost of an old post above newer originals made the scan stop early and hide new posts until the next full refresh
- source: 8a57bac

### 2026-07-26 · At most 2 scheduled full refreshes per cycle; 429 backoff honors server headers · active
- what: oldest `last_full_refresh_at` first; new registrations are exempt; backoff uses retry-after / ratelimit-reset, clamped 15 to 120 s
- why: several large daily refetches at once brushed the per-IP rate limit and stretched a cycle to an hour
- source: e69b62f
