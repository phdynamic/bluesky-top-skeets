# Top Skeets

A Bluesky Feed Generator that gives every user their own permanent feed — published under their own AT Protocol account. Two feed types are available:

- **Top Skeets** (`top-skeets`) — the owner's posts ranked by like count
- **My Skeets** (`chrono-skeets`) — the owner's posts, newest first

Both can optionally include replies (an "Include replies" checkbox at registration).

---

## What Top Skeets Does

Each person who visits the app gets a unique, personalised feed published to the AT Protocol network under **their own Bluesky DID**. The feed shows the feed *owner's* posts and is the same for every viewer — it is not personalised to whoever is looking.

Users share a single short link in their Bluesky bio:

```
https://bsky.app/profile/{THEIR_DID}/feed/top-skeets
https://bsky.app/profile/{THEIR_DID}/feed/chrono-skeets
```

---

## How It Works Technically

1. **User authenticates** using an App Password (never stored). The account's PDS is resolved from its handle (via DID document), so accounts hosted on any AT Protocol server work — not just bsky.social.
2. **A feed generator record is written to the user's own AT Protocol repo** via `com.atproto.repo.putRecord` on `app.bsky.feed.generator/{feed-type}`. The record's `did` field points to *our* service — so Bluesky knows to call our server for skeleton responses — but the record lives in *the user's* repo, so the feed URI contains their DID.
3. **Posts are fetched in the background** by paginating `app.bsky.feed.getAuthorFeed` (with or without replies, per the user's choice), filtered of reposts, sorted (by likes for `top-skeets`, chronologically for `chrono-skeets`), and stored as one JSON file per feed in the data directory.
4. **When anyone opens the feed**, Bluesky's AppView calls our `/xrpc/app.bsky.feed.getFeedSkeleton` endpoint. We extract the user's DID from the AT URI, look up their pre-sorted posts, and return the skeleton.

```
Feed URI:  at://{userDid}/app.bsky.feed.generator/top-skeets
                  ↑ user's DID — their repo, their feed
```

### Storage

Feeds are stored as **JSON files** (not a database) in the data directory:

- `{did-slug}-{feed-type}.json` — one file per feed, the source of truth (posts included)
- `_index.json` — handle → DID lookup map
- `_meta.json` — per-feed metadata (post count, refresh timestamps) used by the scheduler and status lookups

Both sidecar files are derived state: if either is missing or corrupt it is automatically rebuilt from the feed files. All writes are atomic (temp file + rename), so a crash or redeploy mid-write cannot corrupt data.

### Background refresh

A scheduler ticks every `REFRESH_INTERVAL_MINUTES` (default 5) and refreshes feeds that are due, with new registrations always first:

- **chrono-skeets**: incremental refresh every 15 minutes (only new posts fetched)
- **top-skeets**: incremental refresh every hour
- **both types**: a full refresh every ~24 hours (updates like counts, drops deleted posts; a per-feed 0–6h jitter spreads these out so they don't pile into one long cycle)

Feeds whose accounts have been deleted, deactivated, or suspended are pruned automatically.

---

## Prerequisites

- Node.js 20 (see `.nvmrc`)
- A Bluesky account and an App Password for testing
- (Production) A publicly accessible HTTPS host, e.g. Railway

---

## Local Development

```bash
# 1. Install dependencies (--include=dev overrides the omit=dev in .npmrc)
npm install --include=dev

# 2. Configure environment
cp .env.example .env
# Edit .env — set FEEDGEN_HOSTNAME and FEEDGEN_SERVICE_DID

# 3. Run in dev mode (hot-reload)
npm run dev
```

### Test Endpoints

```bash
# Well-known DID document
curl http://localhost:3000/.well-known/did.json | jq .

# Health / scheduler status
curl http://localhost:3000/health | jq .

# Feed skeleton (replace DID with a real registered user's DID)
curl "http://localhost:3000/xrpc/app.bsky.feed.getFeedSkeleton?feed=at://did:plc:example/app.bsky.feed.generator/top-skeets" | jq .

# Feed metadata by handle
curl "http://localhost:3000/api/feed/yourhandle.bsky.social?feedType=top-skeets" | jq .
```

---

## Railway Deployment

1. **Push to GitHub**

2. **Create a new Railway project**
   - New Project → Deploy from GitHub Repo → select this repo

3. **Add environment variables** (Railway → Variables tab):
   ```
   PORT=3000
   FEEDGEN_HOSTNAME=your-app.up.railway.app
   FEEDGEN_SERVICE_DID=did:web:your-app.up.railway.app
   DATA_DIR=/app/data
   REFRESH_INTERVAL_MINUTES=5
   ```
   (`DATABASE_PATH` from older deployments is still honored as a fallback — its directory is used as the data dir.)

4. **Add a persistent volume** (Railway → Volumes):
   - Mount path: `/app/data`
   - This keeps the feed JSON files across redeploys.

5. **Start command** (Railway → Settings → Deploy → Custom Start Command):
   ```
   npm run build && npm start
   ```

6. **Get your Railway public URL**, set it as `FEEDGEN_HOSTNAME` (no `https://` prefix).

7. **Verify the DID document is accessible**:
   ```bash
   curl https://your-app.up.railway.app/.well-known/did.json
   ```
   Bluesky will crawl this URL to verify that your server is the legitimate handler for your service DID.

8. **(Optional) Health check** (Railway → Settings → Deploy → Healthcheck Path): `/health`

---

## Refreshing a Feed

Feeds refresh automatically on the schedule described above — no user action needed. Right after registration, the success screen shows a live post count as the initial background fetch completes.

---

## Security Notes

- **App Passwords are never logged or stored.** They are used once to call `agent.login()` and the resulting session token is used only for that request. The password is not written to disk, logs, or storage.
- **No server-side auth is required to view a feed skeleton.** Feeds are public by design — that's how the AT Protocol feed generator protocol works.
- **Users publish to their own AT Protocol repos.** The server never has write access to any user's account other than via the temporary session established by their own App Password.
- **Mutation endpoints are rate-limited** (5 requests per IP per minute).
