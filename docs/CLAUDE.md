# docs/CLAUDE.md: start here

Project: Professor Kiosk site (professorkiosk.wtf). Two parts in one Express + TypeScript server (Node 20, Railway): the Top Skeets feed generator (`/feeds`, `src/`) and a set of browser-only Bluesky tool pages (`public/`).

## Reading order
1. This file.
2. `STATUS.md` (what exists, what is tested).
3. `NEXT-SESSION.txt` (where work stopped).
4. Only then the routed file you need (table below).

## Routing
| Need | File |
|---|---|
| What is built / tested / unknown | `STATUS.md` |
| Why something is the way it is | `DECISIONS.md` then `decisions/<theme>.md` |
| When something happened | `BUILD-LOG.md` then `build-log/<era>.md` |
| Recurring technical lessons | `standing-rules.md` |
| Live checks owed on the developer's machine | `TESTING-OWED.md` |
| How to run, config, endpoints | `../README.md`, `../.env.example` |

## Core concept
- Feed generator: each user registers with a Bluesky app password and gets their own published feed (Top Skeets by likes, My Skeets newest first, each with or without replies). The server fetches posts in the background and serves the feed skeleton.
- Tool pages: `/tutorials`, `/jokeweb`, `/mashup`, `/receipt`, `/tracer`, `/imagine-flagons`. Static HTML in `public/`, no sign-in, no server calls except to Bluesky's public API from the visitor's browser.
- Hub at `/` links all of them plus four external sites.

## Architecture notes (rarely change)
- Server: `src/index.ts` (routes), `scheduler.ts` (refresh cycles), `db.ts` (JSON files in `DATA_DIR`), `bluesky.ts` (author-feed fetch), `register.ts` / `identity.ts` (publish feed, find the account's PDS), `feed-skeleton.ts`, `well-known.ts`, `budget.ts` (shared AppView request budget), `clientip.ts`, `links.ts` (wraps `public/kiosk-links.js`).
- Static pages share `public/kiosk.css`, `kiosk.js`, `kiosk-help.js`, `kiosk-links.js`, `favicon.svg`, `fonts/`.
- Text-driven pages: `/tutorials` reads `public/tutorials.txt`; `/mashup` reads `public/topics.js`.
- Tests: unit in `test/*.test.js` (`npm test`); browser suites in `test/browser/` (`npm run test:browser`, needs a Chromium-family browser, mocks Bluesky).

## Maintenance rules (how these docs are kept)
- Build-log entries: bullets only, fixed short tags (built / note / live-tested / source). Append only; if an old entry is wrong, add a new entry plus a one-line blockquoted pointer under the old one.
- Decisions: one entry per non-obvious choice, in the matching themed file, date order, status flag (`active`, `superseded`, `partly superseded`) with a blockquoted pointer when superseded. No master table.
- Write the "why" only where the repo or the developer states it; otherwise `why: not recorded`.
- Tighten before filing: cut each entry to what a future session with no other context needs.
- When behavior changes, update the routed-to file in the same session.
- Do not silently override a documented decision: add a proposing entry and ask the developer first.
- Origin: these rules come from the `commenting-on-code-skill` skill text. The `comments.md` the developer mentioned was not in the repo when this was set up.
