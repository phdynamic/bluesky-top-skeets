# Saved games: launch checklist

Everything is built and switched off. Nothing below changes the live site until step 7, when you turn it on.
Work through the steps in order. Each says what to do, why, and how to know it worked.

## 1. Make sure the latest code is what's running

**Why.** Railway deploys when you push; the saved-games code only does anything once it's deployed *and* switched on.
**How.** Railway, your project, the service, **Deployments**. The newest deployment should show the latest commit from
`claude/bluesky-top-skeets-feed-wE2R4` and a green "Active". Open the site and `/tracer`: it should look and work as before
(with the flag off there is no Save button).

## 2. Run the automated tests on your computer

**Why.** A quick proof that nothing was broken on the way.
**How.** In a terminal, in the project folder:

    git pull
    npm install --include=dev
    npm test                  # server tests: should end with "fail 0"
    npm run test:browser      # needs Chrome; every line should start with "ok"

If it says it can't find a browser, install Chrome, Brave or Edge, or run `npx playwright-core install chromium` and try again, or point `CHROME_PATH` at the browser program (the message shows the exact line to use for your system).
This step is a safety net, not a launch requirement: the server tests are the important ones, and step 3 is the real check.

## 3. Try the whole thing on your own computer, with the real Bluesky

**Why.** This is the one check I could not do for you: real Bluesky answering, real sign-in. Nothing is public while you do it.
**How.**
1. `cp .env.example .env` (skip if you have one) and set these lines in `.env`:
   - `FEEDGEN_HOSTNAME` and `FEEDGEN_SERVICE_DID` can stay as the placeholders.
   - `GAMES_ENABLED=true`
   - `ADMIN_SECRET=` a long random string. Make one with
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
   - `OAUTH_PUBLIC_URL=http://127.0.0.1:3000`  (local test mode: no key needed)
   - `GAMES_REFRESH_COOLDOWN_HOURS=0.01`  (about 36 seconds, so you can test Refresh without waiting 6 hours)
2. `npm run build` then `npm start`. The terminal should print `[games] saved games are ON`, `[games] admin tools are ON at /admin`
   and `[games] sign in with Bluesky is ON`.
3. Open **http://127.0.0.1:3000/tracer** (use `127.0.0.1`, not `localhost`; sign-in needs it to match).
4. Walk through it:
   - Trace a real post (try `https://bsky.app/profile/professorkiosk.wtf/post/3ma4vpkdvwk26`), then **Save this game**. Read the box, save.
   - You land on `/g/...`: "Taking the snapshot", then the tree. Check the banner, no avatars or images, search, fold, Leaderboards.
   - Wait about a minute, press **Refresh**. A version 2 should appear and the picker should list both.
   - Press a card's **Report**, send it. Open **http://127.0.0.1:3000/admin**, sign in with your `ADMIN_SECRET`, see the report, **Wipe this card**, then reload the saved game: that card is now a gravestone with its replies still attached, and the banner says "(1 deleted or removed)".
   - Open **/g/about** and read it as a stranger would.
   - **Sign in:** on the saved game press **Remove my posts**, sign in with your own Bluesky account. If you're in a game, remove yourself from it, then sign out. Then sign in again (as the account that wrote the original post, if you traced one of yours) and try Freeze, Unfreeze and Delete.
5. Stop it with Ctrl+C. Delete `./data/games.sqlite` to start clean.

If sign-in fails, the terminal prints `[games] sign-in failed:` with the reason; send it to me.

## 4. Find the right request rate (the probe)

**Why.** Bluesky's public service doesn't say how fast you may ask, so we find out. Your Railway server shares one address for the feed refreshes and the game crawler.
**How.** On your computer: `npm run build`, then

    npm run probe -- "https://bsky.app/profile/professorkiosk.wtf/post/3ma4vpkdvwk26" --ramp

(about 450 requests, about a minute and a half). Paste me the output. If it reports a `429` at some speed, set `APPVIEW_MAX_RPS` on Railway
to about half of that speed (requests per second); if it never hits one, you can leave it unset at first.
The server also slows itself down automatically if Bluesky ever says "too many requests".

## 5. Prepare the Railway settings

**Where.** Railway, your project, the service, **Variables**. Add each, then Railway will offer to redeploy; accept.
Add everything except `GAMES_ENABLED` first (harmless while it's off):

| Variable | Value | Notes |
| --- | --- | --- |
| `ADMIN_SECRET` | a long random string | Make a new one for the live site (command in step 3). Keep it in a password manager. |
| `OAUTH_PUBLIC_URL` | `https://professorkiosk.wtf` | The address the site is really served from. |
| `OAUTH_PRIVATE_KEY_JWK` | one line of JSON | On your computer run `npm run oauth:genkey`; paste the single line it prints. Never commit or share it. |
| `TAKEDOWN_CONTACT` | `phdynamic@icloud.com` | Already the default. Change it here later without code. |
| `DATA_DIR` | `/app/data` | Should already be set; it must point at the persistent volume so `games.sqlite` survives redeploys. |
| `APPVIEW_MAX_RPS` | from step 4 | Optional. |
| `GAMES_HEALTH_POST` | an `at://` post address | Optional extra "is Bluesky answering?" check. A stable post of yours is fine. |

The rest (`GAMES_SIZE_CAP`, `GAMES_REFRESH_COOLDOWN_HOURS`, `GAMES_WIPE_SPACING_HOURS`, and so on) have sensible defaults; see `.env.example`.

**Check the volume.** Railway, the service, **Volumes**: one should be mounted at `/app/data`.

## 6. Check nothing changed yet

After the redeploy with those variables (and `GAMES_ENABLED` still unset): `/tracer` has no Save button, `/g/about` and `/admin` show the normal site,
and the logs show no `[games]` lines. That proves "off" is really off.

## 7. Turn it on

Add `GAMES_ENABLED=true` and deploy. In **Deployments, View logs** you should see, near the start:

    [games] database: /app/data/games.sqlite
    [games] admin tools are ON at /admin
    [games] sign in with Bluesky is ON (https://professorkiosk.wtf)
    [games] saved games are ON (cap 5000 quotes, refresh every 6 h)
    [net] x-forwarded-for has N entries; TRUSTED_PROXY_HOPS=1 ...

If you see `sign in with Bluesky is OFF:` the line says why (a missing or malformed key, usually).
The `[net]` line: if it says 1 or 2 entries all is normal. If every visitor ends up sharing one rate limit, change `TRUSTED_PROXY_HOPS` (try 2) and redeploy.

## 8. Smoke test on the live site

1. `https://professorkiosk.wtf/oauth/client-metadata.json` loads JSON whose `client_id` is that same address and `scope` is `atproto`.
2. `https://professorkiosk.wtf/oauth/jwks.json` loads a key with `kty`, `x`, `y` and **no** `d`.
3. Trace and save one of your own posts. Check the saved page, Refresh (6-hour cooldown now), the version picker, Report.
4. `/admin` with the live secret: the report is there. Resolve it.
5. **Sign in with your own account** at `/g/account`; remove yourself from that game; check the saved page shows the gravestone.
6. **Try an account on another server** (Blacksky, Northsky, or a custom domain) if you can; the sign-in must find their own server.
7. Delete your test game from `/admin` (Look up, Delete game) when you're done.

## 9. Read the policy page as a stranger, and have someone check it

`/g/about` is plain-language text I wrote. It says what's stored, how to be removed, and gives your takedown address. Because the tool holds other people's
words, it's worth having someone qualified read it. Also decide whether you want to promise a response time on it (it currently promises none).

## 10. The first days

- **Reports:** open `/admin` daily; the number of open reports shows at the top. Resolve or dismiss each; wipe a card or hide a game if needed.
- **Logs to watch for:** `[games] job N gave up` (Bluesky wasn't answering; the game keeps what it found), repeated `rate limited` pauses (lower `APPVIEW_MAX_RPS`).
- **Removal requests** that arrive by report or email: Look up the account in `/admin`, then **Keep out and wipe** (scope `all` or one game id).
- **Turning it off quickly:** remove `GAMES_ENABLED` (or set it to `false`) and redeploy. Saved pages stop being served; the data stays on the volume; the live Tracer and the rest of the site are untouched.
  To take down just one game, hide it in `/admin`.

## 11. Backups: one thing to know

Railway can snapshot the volume. A restored backup brings back the saved games **and the list of people who asked to be kept out, as they were at that moment**.
So people who removed themselves after the backup would reappear. Avoid restoring unless you must; if you do, afterwards set `GAMES_SWEEP_DAYS=0.001`
for one deploy (it re-checks every game for deleted posts straight away), then set it back, and be ready to redo any recent removal requests.
