import { BskyAgent } from '@atproto/api';
import { getAllFeeds, getFeedByDid, upsertFeed, UserFeed, FeedType } from './db';
import { fetchAllOriginalPosts } from './bluesky';
import { config } from './config';

const CONCURRENCY = 6;
const RETRY_DELAY_MS = 5_000;

let isRefreshing = false;

export function getIsRefreshing(): boolean { return isRefreshing; }

export function startScheduler(): void {
  const intervalMs = config.refreshIntervalMinutes * 60_000;
  console.log(`[scheduler] auto-refresh every ${config.refreshIntervalMinutes} min`);
  // First run after 30s so startup isn't slammed; then on the regular interval
  setTimeout(() => { void runRefresh(); }, 30_000);
  setInterval(() => { void runRefresh(); }, intervalMs);
}

async function runRefresh(): Promise<void> {
  if (isRefreshing) {
    console.log('[scheduler] previous refresh still running — skipping this tick');
    return;
  }
  isRefreshing = true;
  const feeds = getAllFeeds().filter(f => f.feed_uri && f.feed_url);
  if (feeds.length === 0) {
    isRefreshing = false;
    return;
  }
  console.log(`[scheduler] refreshing ${feeds.length} feed(s) (concurrency=${CONCURRENCY})…`);

  try {
    // Worker pool: CONCURRENCY workers each pull the next feed as soon as they
    // finish their current one, so a slow feed never blocks a fast one.
    const queue = [...feeds];
    const workers = Array.from({ length: Math.min(CONCURRENCY, feeds.length) }, async () => {
      while (queue.length > 0) {
        const feed = queue.shift();
        if (feed) await refreshFeedWithRetry(feed);
      }
    });
    await Promise.all(workers);
  } finally {
    isRefreshing = false;
  }
}

async function refreshFeed(feed: UserFeed): Promise<void> {
  const agent = new BskyAgent({ service: 'https://public.api.bsky.app' });

  // Always do a full refresh for both feed types so new posts are never missed.
  // (top-skeets needs it for accurate like counts; chrono-skeets needs it
  // because the Bluesky API sorts by createdAt, not indexedAt, making an
  // incremental cutoff based on indexedAt unreliable.)
  const includeReplies = feed.include_replies ?? false;
  const allPosts = await fetchAllOriginalPosts(agent, feed.did, feed.handle, feed.feed_type, undefined, includeReplies);

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
    includeReplies,
    posts: allPosts,
  });

  console.log(`[scheduler] refreshed ${feed.handle} (${feed.feed_type}): ${allPosts.length} posts`);
}

/** Force an immediate refresh for a specific feed. Throws on failure. */
export async function refreshFeedNow(did: string, feedType: FeedType): Promise<void> {
  const feed = getFeedByDid(did, feedType);
  if (!feed) throw new Error('Feed not found');
  if (!feed.feed_uri || !feed.feed_url) throw new Error('Feed is not fully registered');
  await refreshFeed(feed);
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
