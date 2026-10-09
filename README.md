# Top Skeets

> The site root (`/`) is a Professor Kiosk landing page; the feed generator UI lives at `/feeds`. The API, `/health`, and feed endpoints are unchanged. All pages share the "kiosk" design system in `public/kiosk.css` (tokens, buttons, header, footer, night mode via the `theme` localStorage key).

A Bluesky Feed Generator that gives every user their own permanent feed — published under their own AT Protocol account. Two feed types are available:

- **Top Skeets** (`top-skeets`) — the owner's posts ranked by like count
- **My Skeets** (`chrono-skeets`) — the owner's posts, newest first

Both can optionally include replies (an "Include replies" checkbox at registration).

---

## Quote Post Game Tracer

`/tracer` turns any public Bluesky post into a browsable tree of its quote posts. It runs entirely in the visitor's browser against Bluesky's public API (no login, nothing stored on the server). The page is split in two scripts: `public/tracer-viewer.js` shows a tree (and makes no network requests of its own) and `public/tracer-live.js` is the crawler that feeds it. A trace loads up to 2,000 quotes, with a "Load more" button to keep going (up to 20,000). Only quotes visible to logged-out viewers can be traced. Share a trace with `/tracer?post=<bsky.app post link>`.

## Skeet Receipt

`/receipt` turns any public Bluesky post link into a receipt of its stats (likes, reposts, quotes, replies), which can be shared or saved as a 1080 px PNG, copied as an image, or copied as alt text. A handwritten note (Caveat font, blue ink) and red-ink circles around any of the numbers, or the whole post text, can be added; both appear in the PNG and the alt text. It runs entirely in the visitor's browser with two unauthenticated reads against the public AppView (`resolveHandle`, then `getPosts`); there is no sign-in and nothing is stored. The "paid with" line can be switched from VIBES to a handful of presets. Posts with adult, graphic or moderation labels print stats only. Deep link: `/receipt#post=<encoded post URL>` (a fragment, so pasted links never reach server logs).

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

## Operations

- **Rate limits and the visitor's address.** Mutation endpoints are limited per visitor. The visitor's address is read from the right-hand side of `X-Forwarded-For` (the part our own proxy adds), controlled by `TRUSTED_PROXY_HOPS` (default 1). On the first request the server logs a `[net]` line showing how many entries the header had. If every visitor appears to share one limit, adjust the value.
- **Shared AppView budget.** Everything this server asks of the public AppView draws from one allowance. The AppView sends no rate-limit headers (the probe confirmed it), so the limit can't be read; the budget learns it. `APPVIEW_MAX_RPS` is the ceiling in requests per second (0, the default, means no pacing and no adapting). Optionally `APPVIEW_START_RPS` sets where it starts. On every `429` it halves its rate and pauses all callers for the retry delay, then climbs back about 10% every 30 quiet seconds, never above the ceiling.
- **Diagnose.** `npm run build && npm run diagnose -- <post link>` crawls one post the live way and the saved way against the real AppView (nothing is saved) and prints both totals, the saved copy's states, hide labels seen, refused requests, and the first posts only the live way reaches, each with the reason. If a local `games.sqlite` exists it also gives counts of kept-out accounts (counts only) and each saved game's states.
- **Probe.** `npm run build && npm run probe -- <post link> [--ramp [--ramp-seconds N]] [--burst N] [--uri at://...]` is read-only and stores nothing. It reports the `getPosts` batch cap (25, confirmed), how deep the biggest quote branch goes, quotes counted but not returned, labels seen, and whether the AppView sends rate-limit headers. `--ramp` steps through 2, 4, 8 and 16 requests per second to find where `429`s begin; `--burst N` fires up to N back-to-back requests; `--uri` checks whether specific posts are visible to a public read.
- **Takedown contact.** `TAKEDOWN_CONTACT` (default `phdynamic@icloud.com`) is where removal and takedown requests are sent; it is shown on the policy page for saved games once those are built.
- **Tests.** `npm test` builds and runs the unit tests in `test/` (link parsing, client address, request budget, probe). `npm run test:browser` runs the browser suites in `test/browser/` (Tracer, Tracer viewer, saved games end to end, Skeet Receipt, Top Skeets form, footer) against a static copy of `public/`; it needs a Chromium (`CHROME_PATH` if it is not found automatically) and a dev install (`npm install --include=dev`).

## Saved games (built, switched off)

Saving a quote post game is built behind `GAMES_ENABLED` (off by default). With the flag off nothing about it exists: no `/api/games` routes, no `/g/` pages, no Save button, no database file, and the SQLite module is never loaded.

**What it does when on.** After a live trace in the Tracer, a **Save this game** button (with a confirm box saying exactly what is stored) sends the post link to the server, which crawls the quotes itself (the browser's trace is never trusted) and keeps them in `${DATA_DIR}/games.sqlite`. The visitor lands on `/g/{id}`, which shows the progress, then the stored tree in the same Tracer page in *saved mode*: text only (no avatars or media), a banner with the version, capture time, counts and what is missing, a version picker (`/g/{id}/v/{n}` for a fixed version), and a **Refresh** button with a cooldown. Settings are in `.env.example`.

- **Saved pages make no outside requests, and the server enforces it.** They are sent with a `Content-Security-Policy` of `default-src 'none'; connect-src 'self'; img-src 'self' data:; script-src 'self'`, `X-Robots-Tag: noindex`, and `Referrer-Policy: no-referrer`. The live Tracer gets a script-only policy (`script-src 'self'`). Fonts are self-hosted in `public/fonts/` (SIL Open Font License, see `LICENSE.txt`), so no page asks Google for anything.
- **API.** `POST /api/games {post, start?}` finds or creates a game (`queued`, `exists`, or `is_quote` when the post quotes another and `start` is not given); `GET /api/games/:id/status`; `POST /api/games/:id/refresh` (cooldown enforced on the server); `GET /api/games/:id[/v/:n]/data.json` (gzipped, ETag, no post addresses).
- **Posts never change**, so a version is every node added at or before it and old versions stay fixed. A deleted, removed or label-hidden post is wiped (address, author, text, date) from every version but keeps its place so replies stay attached; only a one-way hash of the address is kept so a refresh cannot add it back. A post is wiped only after it has been missing on two checks at least an hour apart (`GAMES_WIPE_SPACING_HOURS`). The misses are held until the end of a check and recorded only if Bluesky answered for posts known to be alive both at the start and at the end (an optional stable post, `GAMES_HEALTH_POST`, can be added as an extra control). Nothing is wiped from an empty batch alone, and nothing because Bluesky errored. A hidden post's branch is kept: while the crawl runs, a hidden post keeps its address only long enough to fetch what quoted it, then the address is wiped, so replies stay under the gravestone. Limit: a later refresh cannot find new quotes under an already-wiped gravestone. A post whose quote count Bluesky omits is treated as unknown and opened once. A quotes request Bluesky refuses is logged and counted ("N branches could not be read"). The saved page's banner counts the gravestones ("7 quotes (2 deleted or removed)").
- **Unknown, hidden and deleted games all look the same** ("This game isn't available.").
- **Reports.** Every saved game has a **Report this game** link and every card a **Report** button (reasons: personal information, harassment, should be labeled, wrong or misleading, remove my post, something else). A report stores the reason, an optional note (500 characters), the game and the card, and nothing about the sender.
- **Deleted posts.** A slow background sweep re-checks every game (default weekly, `GAMES_SWEEP_DAYS`) behind anything a visitor asked for, and anyone can press **Check for deleted posts** (cooldown `GAMES_RECHECK_COOLDOWN_MINUTES`). Resolved reports are dropped after `GAMES_REPORT_RETENTION_DAYS`.
- **Policy page** at `/g/about`: what is stored and for how long, how to get a post or yourself removed, and the takedown address (`TAKEDOWN_CONTACT`).
- **Admin tools** at `/admin` exist only when `ADMIN_SECRET` is set (use a long random value and keep it in the environment only; wrong guesses are rate limited). From a phone you can list and resolve reports, wipe a card, hide / freeze / delete a game (a deleted game cannot be recreated from the same post), look a game up by id or post link, see every game an account appears in, and keep an account out of one game or all of them. Actions are logged without any reporter information.
- **Sign in with Bluesky** (`/g/account`, linked from every saved game as **Remove my posts** and **I wrote the original post**) lets a person remove their own posts from one game, or from every game and be kept out of future ones, and lets the account that wrote a game's original post freeze, unfreeze or delete it. It uses AT Protocol OAuth with the base `atproto` scope only, so it can confirm which account is yours and nothing else (no posting, following or reading messages). The server reads the account's ID, then revokes and deletes the OAuth tokens at once; all it keeps is a one-hour session (account ID, a CSRF token, an expiry) in memory only, in an `HttpOnly`, `SameSite=Lax` cookie. Every change needs the cookie, the CSRF token and a same-origin request. It is off unless `OAUTH_PUBLIC_URL` is set.

**Setting up sign-in**
1. On Railway set `OAUTH_PUBLIC_URL` to the site's public address (for example `https://professorkiosk.wtf`; the server must be reachable there).
2. Make the signing key once with `npm run oauth:genkey`, put the single line it prints in `OAUTH_PRIVATE_KEY_JWK`, and keep it secret. (Rotate it any time by making a new one.)
3. The server then serves `/oauth/client-metadata.json` and `/oauth/jwks.json` (public keys only), which other servers read to learn who we are.
4. To try it on your own computer instead, set `OAUTH_PUBLIC_URL=http://127.0.0.1:3000` (the AT Protocol's loopback client: no key needed) and open `http://127.0.0.1:3000/g/account`.

**What has been tested, and what has not.** Everything on this server's side is tested with a stand-in for Bluesky's side (sessions, cookies, CSRF, removal, owner checks, the pages). The real OAuth conversation with a person's server (finding their server from a handle, the authorization request, the token exchange) uses the `@atproto/oauth-client-node` library (pinned to 0.3.x so it runs on Node 20) and could not be run against real Bluesky servers while it was written. Check it by hand before turning the feature on: (a) locally in loopback mode, sign in with your own account, remove yourself from a saved game, sign out; (b) on Railway, fetch `/oauth/client-metadata.json` and sign in; (c) try an account on a non-Bluesky server (Blacksky, Northsky, a custom domain).

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
