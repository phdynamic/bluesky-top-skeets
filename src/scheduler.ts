import { BskyAgent } from '@atproto/api';
import { getAllFeeds, upsertFeed } from './db';
import { fetchAllOriginalPosts } from './bluesky';
import { config } from './config';

export function startScheduler(): void {
  const intervalMs = config.refreshIntervalMinutes * 60_000;
  console.log(`[scheduler] auto-refresh every ${config.refreshIntervalMinutes} min`);
  // First run after 30s so startup isn't slammed; then on the regular interval
  setTimeout(() => { void runRefresh(); }, 30_000);
  setInterval(() => { void runRefresh(); }, intervalMs);
}

async function runRefresh(): Promise<void> {
  const feeds = getAllFeeds();
  if (feeds.length === 0) return;
  console.log(`[scheduler] refreshing ${feeds.length} feed(s)…`);

  for (const feed of feeds) {
    if (!feed.feed_uri || !feed.feed_url) continue;

    try {
      // Use the public read-only API — no credentials needed for public posts
      const agent = new BskyAgent({ service: 'https://public.api.bsky.app' });

      // For chrono-skeets: only fetch posts newer than the last generated_at,
      // then prepend them to the existing list (deduplicating by URI).
      // For top-skeets: always full refresh so like counts stay accurate.
      const isIncremental = feed.feed_type === 'chrono-skeets' && feed.generated_at != null;
      const cutoffDate = isIncremental ? new Date(feed.generated_at!) : undefined;

      const newPosts = await fetchAllOriginalPosts(agent, feed.did, feed.handle, feed.feed_type, cutoffDate);

      let allPosts: typeof newPosts;
      if (isIncremental) {
        if (newPosts.length > 0) {
          const newUris = new Set(newPosts.map(p => p.uri));
          const retained = feed.posts.filter(p => !newUris.has(p.uri));
          allPosts = [...newPosts, ...retained];
        } else {
          // No new posts — keep the existing list unchanged
          allPosts = feed.posts;
        }
      } else {
        allPosts = newPosts;
      }

      upsertFeed({
        did: feed.did,
        handle: feed.handle,
        displayName: feed.display_name,
        avatarUrl: feed.avatar_url,
        feedType: feed.feed_type,
        feedUri: feed.feed_uri,
        feedUrl: feed.feed_url,
        postCount: allPosts.length,
        generatedAt: new Date().toISOString(),
        posts: allPosts,
      });

      console.log(`[scheduler] refreshed ${feed.handle} (${feed.feed_type}): ${allPosts.length} posts`);
    } catch (err) {
      console.error(`[scheduler] failed to refresh ${feed.handle} (${feed.feed_type}):`, err);
    }
  }
}
