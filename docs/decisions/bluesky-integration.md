# Decisions: Bluesky integration

### 2026-03-27 · Mutation endpoints rate-limited; inputs capped · active
- what: 5 requests per IP per minute on register, refresh and unregister; 200-character cap on handle and app password; `Cache-Control: public, max-age=60` on the feed skeleton
- why: prevent API quota abuse
- source: 2674a43

### 2026-08-27 · Accounts on any AT Protocol PDS are supported · active
- what: resolve handle to DID to DID document to PDS endpoint before login; https endpoints only; any failure falls back to bsky.social; profile lookups go to the public AppView
- why: login was hardcoded to bsky.social; credentials are sent to the resolved endpoint and the DID document is user-controlled, so only https is accepted
- source: 4970451 (`src/identity.ts`)

### 2026-10-06 · Author-feed pages are fetched with plain `fetch` and lenient parsing · active
- what: read only the few fields used, so a malformed field in one post cannot reject a page; errors still carry status and headers (429 backoff and "Profile not found" pruning intact)
- why: one post with alt text over 1000 graphemes made the `@atproto/api` client reject a whole page, so that feed failed every cycle and, because the most overdue feeds go first, took both full-refresh slots while 73 others were deferred
- source: 52a5199

### 2026-10-08 · One shared AppView request budget · active
- what: every AppView call takes from one allowance with priorities (user, feeds, background); halves on a 429, recovers slowly; `APPVIEW_MAX_RPS` is the ceiling and 0 (default) means no pacing
- why: everything leaves from the same Railway address, and the AppView sends no rate-limit headers, so the limit cannot be read
- source: `src/budget.ts` header, 5013636, 9e2a794
- note: kept after the game feature was removed

### 2026-10-08 · Client address comes from the proxy side of X-Forwarded-For; limits keyed on a salted hash · active
- what: `TRUSTED_PROXY_HOPS` says how many proxies sit in front; rate limits use a salted hash of the address
- why: a client could otherwise forge a new identity on every request
- source: 5013636 (`src/clientip.ts`)

### 2026-10-08 · One post-link parser for the Tracer, Skeet Receipt and the server · active
- what: `public/kiosk-links.js`, loaded by pages and by `src/links.ts`; the Tracer accepts links from any client host, not only bsky.app
- why: not recorded beyond "one parser"
- source: 5013636
