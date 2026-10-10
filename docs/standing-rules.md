# Standing rules

One line each, with a pointer to where it came from.

- bsky.app post links: use the handle, or the raw DID with literal colons; an encoded DID (`did%3Aplc%3A...`) crashes bsky.app. Source: 449f79b.
- Parse Bluesky responses leniently; one malformed field in one post must not reject a whole page. Source: 52a5199.
- A repost's `indexedAt` is the original post's time; never use it as the user's post time. Source: 8a57bac.
