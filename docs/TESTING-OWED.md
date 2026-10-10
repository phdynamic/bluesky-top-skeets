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
