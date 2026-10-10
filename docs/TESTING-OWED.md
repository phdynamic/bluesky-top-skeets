# Testing owed

Live checks owed on the developer's machine. Each entry: what to test, how, and what should happen.
Source for the first group: `public/tutorials.txt`, written 2026-10-10 from web searches and memory without access to Bluesky itself. Fix the text if a check fails.

## Tutorials: facts about the Bluesky app (open the app and the page side by side)
- Profile search. How: open your own profile, tap the triple dots button. Expect: a "Search posts" option that searches your own posts. Unconfirmed on your own profile.
- Search dates. How: search `from:yourhandle since:2024-01-01 until:2025-06-30`. Expect: only posts in that range.
- Bio link. How: Edit Profile, Description box, paste a link, Save. Expect: the link is clickable on the profile.
- Pinning. How: three dots on one of your posts. Expect: "Pin to your profile".
- Following Feed Preferences. How: Settings, find Following Feed Preferences. Expect: switches for replies, reposts and quote posts, affecting only the Following feed.
- Mute words. How: Settings, Moderation, Mute words & tags. Expect: choose text and tags or tags only, a duration, and a way to skip people you follow.
- Hide replies and detach quote. How: on your own thread, hide a reply; on someone's quote of your post, open its menu. Expect: hidden replies sit behind a "hidden replies" screen; "Detach quote" removes it from your post's quotes.
- Direct message settings. How: chat settings. Expect: default is people you follow only; options for everyone and no one; a blocked user cannot message you, a muted one can.
- Group chats. How: chat tab, start a group, share the invite link. Expect: up to 50 people; invite setting (everyone, people you follow, no one); media sharing may have been added since launch (the text says it was not supported at launch).
- Share to chat. How: tap the share button under a post. Expect: "Send via direct message" (lowercase m).
- Images. How: attach 4 images, then 5 or more in a post. Expect: limit of ten; up to four show as a grid, more than four as a carousel with numbered badges.
- Domain handle and blue checks. How: Settings, change handle to a domain you own; look at how blue checks are issued now. Expect: free to use your own domain; checks come from trusted organizations, not purchase.

## Tutorials: outside tools
- deck.blue. How: open it. Expect: still a working multi-column Bluesky client.
- SkyFeed steps. How: follow the seven written steps and the video at skyfeed.app. Expect: they still match the current screens (app password, Feed Builder, Create Feed, Single User, Publish Feed).
- SkyFeed description. How: read skyfeed.app. Expect: it still builds feeds from rules (lists, words, like counts) with no code.

## Mashup Machine: claims in its Help dialog (live site, real browser)
Source: the Help text in `public/mashup.html`. The automated suite covers these with a seeded random generator and mocks; these are the by-hand confirmations.
- Randomize and Mashup. How: switch modes and press Spin several times. Expect: Randomize gives one card; Mashup gives two; each card shows its category.
- Third topic. How: Mashup, drag Weirdness to the top, spin 5 times. Expect: three cards every time near the top; mostly two at low Weirdness.
- Spin key. How: click an empty part of the page, press Space. Expect: a spin. Typing a space in the "My topics" box must not spin.
- Distance. How: spin about 10 times with Distance at the far left, then far right. Expect: left pairs topics from the same category (two foods, two TV shows); right pairs far-apart categories (for example Food with History & mythology). Help's examples are illustrations, not guaranteed results.
- Odd pairings. How: Distance low, Weirdness about 70 to 80, spin about 15 times. Expect: some pairs from unrelated categories (for example Animals with Law & government), even though Distance is low.
- Spicy and My topics switches. How: turn Spicy off and spin about 30 times; add a topic of your own, then turn "Include my topics" off. Expect: no topic marked with `*` in `public/topics.js` appears; your topic shows up sometimes when on, never when off.
- Lock. How: lock one card and spin. Expect: the locked card stays, the others change.
- Favorite and History. How: spin 10 times, star one result, reload the page. Expect: History shows only the last 8; the favorite is still listed after the reload.
- Send to Joke-Web Maker. How: click it with a Joke-Web already started. Expect: a new web whose subject is the mashup and whose branches are the topics, and the earlier web one tap away ("Swap with previous web").
- Saved on this device only. How: use the browser's Network tab while spinning; open the page in a second browser. Expect: no requests except the footer avatar lookup to Bluesky; your topics, history and favorites do not appear in the second browser.

## Joke-Web Maker: claims in its Help dialog (live site, real browser, desktop and phone)
Source: the Help text in `public/jokeweb.html`. The automated suite covers these with mocks; these are the by-hand confirmations.
- Step 2. How: start a web, add three branches. Expect: only main branches can be added; the subject stays visible.
- Step 3. How: tap Break it down. Expect: the subject fades; you can add under any branch, go several levels out, and add another main branch from the "Another main branch" box; the trail above the input leaves the subject out.
- "Ways to think about words". How: look in step 3. Expect: the list (split, pun, move, other meanings, look back, sound-alikes, flip, clichés) is there and open by default.
- Step 4. How: tap Apply it back and choose a deep bubble. Expect: the subject returns; only it and the chosen idea stand out, the bubbles linking them are half-visible, the rest are faded; Save idea adds to the list.
- Use in draft. How: tap it on a saved idea. Expect: the idea is added to the Draft post box.
- Free board. How: switch to it; drag a bubble, rename, add under it, delete one with children. Expect: dragging never clips the bubble or snaps the board; delete removes the bubble and its whole branch. On a phone, drag with a finger.
- Tidy up. How: after dragging, tap it; switch back to Guided. Expect: bubbles return to automatic places; the button shows only in Free mode.
- Keyboard nudge. How: select a bubble in Free mode, press the arrow keys, then Shift plus an arrow. Expect: it moves in small steps, then bigger ones.
- Zoom. How: +, minus and Fit. Expect: Fit always shows the whole web, even three levels deep on a phone.
- Crowding. How: build about 40 bubbles. Expect: still usable with zoom, as the Help says ("fine, but crowded").
- Keeping your work. How: make a web and a draft, reload; use Save image, Copy web, Copy joke ideas; tap Start over once, then again. Expect: web and draft survive; a PNG downloads; the outline and the ideas copy; the first tap only asks, the second clears; nothing is sent anywhere except the footer avatar lookup.
- Send from Mashup. How: send a mashup while a web exists. Expect: a new web starts at once, and "Swap with previous web" brings the old one back (also checked under Mashup).
- Help itself. How: open Help on a phone. Expect: it fits the screen and scrolls inside; Esc and the close button work.

## Skeet Receipt: claims in its Help dialog (live site, real browser, desktop and phone)
Source: the Help text in `public/receipt.html`. The automated suite covers these with a mocked Bluesky; these are the by-hand confirmations.
- Links from any client. How: paste a post link copied from the share menu of bsky.app, then one from another Bluesky app or community server, then an `at://` address. Expect: all print a receipt.
- Numbers. How: compare a receipt with the post in Bluesky. Expect: likes, reposts, quotes and replies match, and total touches is their sum.
- Include post text / handle. How: untick each. Expect: the text or the handle disappears; the numbers stay.
- Paid with. How: pick another preset, then print another post. Expect: the choice shows on the receipt, and resets to VIBES for the next post.
- Handwritten note. How: type 80 characters, then try more. Expect: it stops at 80 and is written across the receipt in handwriting.
- Red circles. How: circle each number, then the whole post text. Expect: red loops appear on screen and in the saved image.
- Share it. How: Share or save image, Copy image, Copy alt text (on a phone and a computer). Expect: an image file or share sheet; the image on the clipboard (the button is hidden where the browser can't do it); alt text on the clipboard.
- Content labels. How: print a receipt for a post with a content label. Expect: its text is hidden and a note says why.
- Order number. How: print the same post twice and on two devices. Expect: the same order number each time.
- Long posts. How: print a post of close to 300 characters. Expect: all of it, on a longer receipt.
- Runs in the browser. How: Network tab while printing. Expect: requests only to Bluesky's public API (and the footer avatar lookup).
- Space-heavy posts (not a Help claim, from the decision "proportional font for space art"). How: print a post that uses leading spaces for ASCII art, such as the one by demandavoider.bsky.social (3lztjwjvmqc22), and compare with Bluesky. Expect: spacing looks the same as in Bluesky; check with the Japanese fonts on your own machine.

## Top Skeets (feed generator): claims in its Help dialog (live site, real account)
Source: the Help text in `public/feeds.html` (kept word for word from the older pop-up). Needs a real Bluesky account and an app password.
- Create. How: enter a handle and app password, pick Top Skeets, add a name, description and an icon image (non-square), Generate. Expect: a feed link; the icon is cropped square; the feed appears on Bluesky under your name. Try an account on a non-bsky.social server if you have one.
- Four feeds. How: create each type with and without "Include replies". Expect: up to four feeds per account, each with its own link.
- Share and fill. How: open the link in Bluesky right after creating; close the page during the progress bar. Expect: the feed fills in on its own, and the progress bar closed early does no harm.
- Update timing. How: post something new and watch both feed types. Expect: My Skeets shows it within about 15 minutes, Top Skeets within about an hour; like-count re-ranking happens about once a day (compare against a post with new likes).
- Rename. How: re-submit with the same account and a new name or description; then again with a new icon, and once with no icon. Expect: the feed link never changes; the new icon replaces the old; leaving it empty keeps the current one.
- Unpublish. How: enter credentials, pick the feed type (and the replies box), click Unpublish. Expect: the feed disappears from Bluesky and from the site; the other feeds stay.
- App password never stored. How: check the Railway logs and data directory after a registration. Expect: no password anywhere.

## Quote Post Game Tracer: claims in its Help dialog (live site, real Bluesky)
Source: the Help text in `public/tracer.html`.
- Trace. How: paste the post that started a quote post game (try the example on the page) and press Trace. Expect: the tree fills in as quotes are found; you can browse while it loads.
- Most-quoted branches first. How: watch the order in which branches grow on a big game. Expect: the biggest branches are filled first.
- Stop, resume, load more. How: press Stop partway, then Resume; on a game over 2,000 quotes press "Load more". Expect: it keeps what it has and continues; "Load more" adds about 2,000 at a time, up to 20,000.
- Rate limits. How: trace a very large game. Expect: if Bluesky slows down it waits and picks up again, and offers Resume if it stops.
- Missing quotes. How: trace a game that has locked, blocked or deleted posts. Expect: a message says how many are missing, and what was quoted under them is absent.
- Explore. How: search a name and a phrase; fold and open branches; change depth; trace a quote back to the original. Expect: each does what Help says.
- Card links. How: click the link on a card, including an author with an unusual handle. Expect: it opens that post on Bluesky without an error (links use the handle, not an encoded ID).
- Nothing stored. How: Network tab during a trace. Expect: requests only to Bluesky's public API and the footer avatar lookup.

## The Imagine Flagons Saga: claims in its Help dialog (live site, real Bluesky)
Source: the Help text in `public/imagine-flagons.html`.
- Live trace. How: open the page. Expect: a progress bar, then the whole tree; how long it takes is not recorded yet (note it here).
- Size. How: read the post count. Expect: well over a thousand posts (the page text says more than a thousand people took part).
- Search. How: search a band name, a word and a handle. Expect: matching cards stay and the rest fold away.
- Expanded and Compact. How: toggle them. Expect: Expanded shows full posts with pictures; Compact is a short overview.
- Depth, Expand all, Collapse all, thread lines. How: use each. Expect: depth opens that many levels; the buttons do what they say; clicking a thread line folds that branch.
- Order. How: switch between oldest first and biggest branch. Expect: the tree reorders.
- Random band, Deepest dive, Leaderboards. How: use each. Expect: each jumps to something sensible.
- Shortcuts. How: press `/`, `e`, `c`, `r` (not while typing in the search box). Expect: search focus, expand all, collapse all, a random band.
- Failure. How: block Bluesky in the browser (offline) and reload. Expect: "Try again", or the part that did load.
- Nothing stored. How: Network tab. Expect: requests only to Bluesky's public API and the footer avatar lookup.

