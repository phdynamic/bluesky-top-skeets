# Top Skeets

A Bluesky Feed Generator that gives every user their own permanent feed — their posts, ranked by likes — published under their own AT Protocol account.

---

## What Top Skeets Does

Each person who visits the app gets a unique, personalised feed published to the AT Protocol network under **their own Bluesky DID**. The feed always shows the feed *owner's* top-liked original posts (no replies, no reposts) and is the same for every viewer — it is not personalised to whoever is looking.

Users share a single short link in their Bluesky bio:

```
https://bsky.app/profile/{THEIR_DID}/feed/top-skeets
```

Anyone who clicks that link sees the feed owner's greatest hits, sorted by like count.

---

## How It Works Technically

1. **User authenticates** using a Bluesky App Password (never stored).
2. **Server fetches all original posts** by paginating `app.bsky.feed.getAuthorFeed` with `filter: posts_no_replies`, then filters out reposts and reply records.
3. **Posts are sorted** by `likeCount` descending and stored in SQLite.
4. **A feed generator record is written to the user's own AT Protocol repo** via `com.atproto.repo.putRecord` on `app.bsky.feed.generator/{FEED_SHORT_NAME}`. The record's `did` field points to *our* service — so Bluesky knows to call our server for skeleton responses — but the record lives in *the user's* repo, so the feed URI contains their DID.
5. **When anyone opens the feed**, Bluesky's AppView calls our `/xrpc/app.bsky.feed.getFeedSkeleton` endpoint. We extract the user's DID from the AT URI, look up their pre-sorted posts in SQLite, and return the skeleton.

```
Feed URI:  at://{userDid}/app.bsky.feed.generator/top-skeets
                  ↑ user's DID — their repo, their feed
```

---

## Prerequisites

- Node.js 18+
- A Bluesky account and an App Password for testing
- (Production) A publicly accessible HTTPS host, e.g. Railway

---

## Local Development

```bash
# 1. Install dependencies
npm install

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

# Feed skeleton (replace DID with a real registered user's DID)
curl "http://localhost:3000/xrpc/app.bsky.feed.getFeedSkeleton?feed=at://did:plc:example/app.bsky.feed.generator/top-skeets" | jq .

# Feed metadata by handle
curl http://localhost:3000/api/feed/yourhandle.bsky.social | jq .
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
   FEED_SHORT_NAME=top-skeets
   FEED_DISPLAY_NAME=Top Skeets
   FEED_DESCRIPTION=My posts, ranked by likes.
   DATABASE_PATH=/app/data/feeds.db
   ```

4. **Add a persistent volume** (Railway → Volumes):
   - Mount path: `/app/data`
   - This keeps the SQLite database across redeploys.

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

---

## Refreshing a Feed

Users can re-submit the form at any time with the same handle and App Password. The upsert overwrites the existing database row and re-publishes the feed generator record with fresh post data. This is the recommended way to sync new posts or updated like counts.

---

## Security Notes

- **App Passwords are never logged or stored.** They are used once to call `agent.login()` and the resulting session token is used only for that registration request. The password is not written to disk, logs, or the database.
- **No server-side auth is required to view a feed skeleton.** Feeds are public by design — that's how the AT Protocol feed generator protocol works.
- **Users publish to their own AT Protocol repos.** The server never has write access to any user's account other than via the temporary session established by their own App Password.
