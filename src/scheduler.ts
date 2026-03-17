import { BskyAgent } from '@atproto/api';
import { getAllFeeds, upsertFeed, UserFeed } from './db';
import { fetchAllOriginalPosts } from './bluesky';
import { config } from './config';

const CONCURRENCY = 3;
const RETRY_DELAY_MS = 5_000;

export function startScheduler(): void {
  const intervalMs = config.refreshIntervalMinutes * 60_000;
  console.log(`[scheduler] auto-refresh every ${config.refreshIntervalMinutes} min`);
  // First run after 30s so startup isn't slammed; then on the regular interval
  setTimeout(() => { void runRefresh(); }, 30_000);
  setInterval(() => { void runRefresh(); }, intervalMs);
}

async function runRefresh(): Promise<void> {
  const feeds = getAllFeeds().filter(f => f.feed_uri && f.feed_url);
  if (feeds.length === 0) return;
  console.log(`[scheduler] refreshing ${feeds.length} feed(s) (concurrency=${CONCURRENCY})…`);

  // Process feeds in batches of CONCURRENCY
  for (let i = 0; i < feeds.length; i += CONCURRENCY) {
    const batch = feeds.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(feed => refreshFeedWithRetry(feed)));
  }
}

async function refreshFeed(feed: UserFeed): Promise<void> {
  const agent = new BskyAgent({ service: 'https://public.api.bsky.app' });

  // For chrono-skeets: only fetch posts newer than the last generated_at,
  // then prepend them to the existing list (deduplicating by URI).
  // For top-skeets: always full refresh so like counts stay accurate.
  const latestPostDate = feed.posts.length > 0
    ? new Date(feed.posts[0].indexedAt)
    : null;
  const isIncremental = feed.feed_type === 'chrono-skeets' && latestPostDate != null;
  const cutoffDate = isIncremental ? latestPostDate! : undefined;

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
    feedUri: feed.feed_uri!,
    feedUrl: feed.feed_url!,
    postCount: allPosts.length,
    generatedAt: new Date().toISOString(),
    posts: allPosts,
  });

  console.log(`[scheduler] refreshed ${feed.handle} (${feed.feed_type}): ${allPosts.length} posts`);
}

async function refreshFeedWithRetry(feed: UserFeed): Promise<void> {
  try {
    await refreshFeed(feed);
  } catch (err) {
    console.warn(`[scheduler] first attempt failed for ${feed.handle} (${feed.feed_type}), retrying in ${RETRY_DELAY_MS / 1000}s…`, err);
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    try {
      await refreshFeed(feed);
    } catch (retryErr) {
      console.error(`[scheduler] retry failed for ${feed.handle} (${feed.feed_type}):`, retryErr);
    }
  }
}
