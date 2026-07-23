import { BskyAgent } from '@atproto/api';
import { getAllFeedMetas, getFeedMetaByDid, getFeedByDid, upsertFeed, touchFeedChecked, deleteFeed, UserFeed, FeedMeta, FeedType, PostRecord } from './db';
import { fetchAllOriginalPosts } from './bluesky';
import { config } from './config';

const CONCURRENCY = 6;
const RETRY_DELAY_MS = 5_000;
const CHRONO_REFRESH_INTERVAL_MS = 15 * 60 * 1000;       // 15 minutes
const TOP_REFRESH_INTERVAL_MS    = 60 * 60 * 1000;       // 1 hour (incremental checks are ~1 page)
const FULL_REFRESH_INTERVAL_MS   = 24 * 60 * 60 * 1000;  // 24 hours (like-count accuracy)

/**
 * Deterministic 0–6h per-feed offset added to the full-refresh interval so the
 * daily full refreshes spread out instead of piling into one long cycle.
 */
function fullRefreshJitterMs(did: string, feedType: FeedType): number {
  const key = `${did}:${feedType}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % (6 * 60 * 60 * 1000);
}

// Live progress of full refetches (raw feed items scanned), keyed did::feedType.
// Ephemeral — only exists while a fetch is running; served by /api/feed/:handle.
const fetchProgress = new Map<string, number>();

export function getFetchProgress(did: string, feedType: FeedType): number | null {
  return fetchProgress.get(`${did}::${feedType}`) ?? null;
}

// The running cycle's live queue — non-null only while a cycle is in flight.
// refreshFeedSoon unshifts new registrations onto it so they jump the line.
let activeQueue: FeedMeta[] | null = null;

let isRefreshing = false;
let stopped = false;
let initialTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;
let lastCycleCompletedAt: string | null = null;
let lastCycleDurationMs: number | null = null;

export function getIsRefreshing(): boolean { return isRefreshing; }

export function getSchedulerStatus(): {
  isRefreshing: boolean;
  lastCycleCompletedAt: string | null;
  lastCycleDurationMs: number | null;
} {
  return { isRefreshing, lastCycleCompletedAt, lastCycleDurationMs };
}

export function startScheduler(): void {
  const intervalMs = config.refreshIntervalMinutes * 60_000;
  console.log(`[scheduler] auto-refresh every ${config.refreshIntervalMinutes} min`);
  // First run after 30s so startup isn't slammed; then on the regular interval
  initialTimer = setTimeout(() => { void runRefresh(); }, 30_000);
  intervalTimer = setInterval(() => { void runRefresh(); }, intervalMs);
}

/** Stop scheduling new work. In-flight feeds finish their current write. */
export function stopScheduler(): void {
  stopped = true;
  if (initialTimer) clearTimeout(initialTimer);
  if (intervalTimer) clearInterval(intervalTimer);
}

async function runRefresh(): Promise<void> {
  if (isRefreshing) {
    console.log('[scheduler] previous refresh still running — skipping this tick');
    return;
  }
  isRefreshing = true;
  const cycleStart = Date.now();
  let totalFeeds = 0;
  let dueChrono = 0;
  let dueTop = 0;
  try {
    const now = Date.now();
    // Metadata only — no post arrays are parsed for feeds that aren't due
    const allMetas = getAllFeedMetas().filter(m => m.feed_uri && m.feed_url);

    // Filter to feeds that are due for a refresh based on their type
    const dueMetas = allMetas.filter(m => {
      if (m.post_count === 0) return true; // new registration — always refresh
      const lastChecked = m.last_checked_at ? new Date(m.last_checked_at).getTime() : 0;
      return m.feed_type.startsWith('chrono')
        ? now - lastChecked >= CHRONO_REFRESH_INTERVAL_MS
        : now - lastChecked >= TOP_REFRESH_INTERVAL_MS;
    });

    totalFeeds = allMetas.length;
    dueChrono = dueMetas.filter(m => m.feed_type.startsWith('chrono')).length;
    dueTop = dueMetas.length - dueChrono;

    if (dueMetas.length > 0) {
      // Priority: new registrations first, then chrono-skeets, then top-skeets
      dueMetas.sort((a, b) => priority(a) - priority(b));

      console.log(`[scheduler] refreshing ${dueMetas.length}/${allMetas.length} feed(s) (concurrency=${CONCURRENCY})…`);

      // Worker pool: CONCURRENCY workers each pull the next feed as soon as they
      // finish their current one, so a slow feed never blocks a fast one.
      const queue = [...dueMetas];
      activeQueue = queue;
      const workers = Array.from({ length: Math.min(CONCURRENCY, dueMetas.length) }, async () => {
        while (!stopped && queue.length > 0) {
          const meta = queue.shift();
          if (!meta) continue;
          // The full feed (posts included) is only loaded for feeds actually due
          const feed = getFeedByDid(meta.did, meta.feed_type);
          if (!feed) {
            console.warn(`[scheduler] feed file missing for ${meta.handle} (${meta.feed_type}) — skipping`);
            continue;
          }
          await refreshFeedWithRetry(feed);
        }
      });
      await Promise.all(workers);

      // Sweep anything injected after the workers drained the queue. No await
      // between the final length check and clearing activeQueue, so nothing
      // can slip in unprocessed.
      while (!stopped && queue.length > 0) {
        const meta = queue.shift();
        if (!meta) continue;
        const feed = getFeedByDid(meta.did, meta.feed_type);
        if (feed) await refreshFeedWithRetry(feed);
      }
      activeQueue = null;
    }
  } finally {
    activeQueue = null;
    isRefreshing = false;
    lastCycleCompletedAt = new Date().toISOString();
    lastCycleDurationMs = Date.now() - cycleStart;

    // One self-explanatory line per cycle, so quiet logs never look like a stall
    const dueTotal = dueChrono + dueTop;
    if (dueTotal === 0) {
      console.log(`[scheduler] cycle done: nothing due (${totalFeeds} feeds)`);
    } else {
      const durationS = Math.round(lastCycleDurationMs / 1000);
      console.log(`[scheduler] cycle done in ${durationS}s: processed ${dueTotal}/${totalFeeds} (${dueChrono} chrono, ${dueTop} top), ${totalFeeds - dueTotal} not yet due`);
    }
  }
}

function priority(meta: FeedMeta): number {
  if (meta.post_count === 0) return 0;
  return meta.feed_type.startsWith('chrono') ? 1 : 2;
}

// Guards against two concurrent refreshes of the same feed (e.g. the
// registration fetch plus a scheduler tick that still sees post_count 0).
// Duplicates wasted API quota and made the shared progress counter bounce.
const inFlightRefreshes = new Set<string>();

async function refreshFeed(feed: UserFeed): Promise<void> {
  const inFlightKey = `${feed.did}::${feed.feed_type}`;
  if (inFlightRefreshes.has(inFlightKey)) {
    console.log(`[scheduler] refresh already in flight for ${feed.handle} (${feed.feed_type}) — skipping duplicate`);
    return;
  }
  inFlightRefreshes.add(inFlightKey);
  try {
    await doRefreshFeed(feed);
  } finally {
    inFlightRefreshes.delete(inFlightKey);
  }
}

async function doRefreshFeed(feed: UserFeed): Promise<void> {
  const agent = new BskyAgent({ service: 'https://public.api.bsky.app' });
  const includeReplies = feed.include_replies ?? false;
  const existingPosts = feed.posts ?? [];

  // Decide between full and incremental refresh.
  // Full refresh when:
  //   - no posts stored yet (first-time fetch)
  //   - top-skeets and 24h have elapsed since last full refresh (to update like counts)
  const lastFullMs = feed.last_full_refresh_at ? new Date(feed.last_full_refresh_at).getTime() : 0;
  const needsFullRefresh =
    existingPosts.length === 0 ||
    Date.now() - lastFullMs > FULL_REFRESH_INTERVAL_MS + fullRefreshJitterMs(feed.did, feed.feed_type);

  let allPosts: PostRecord[];
  let lastFullRefreshAt = feed.last_full_refresh_at ?? null;

  if (needsFullRefresh) {
    const progressKey = `${feed.did}::${feed.feed_type}`;
    fetchProgress.set(progressKey, 0);
    try {
      allPosts = await fetchAllOriginalPosts(
        agent, feed.did, feed.handle, feed.feed_type, undefined, includeReplies,
        scanned => fetchProgress.set(progressKey, scanned),
      );
    } finally {
      fetchProgress.delete(progressKey);
    }
    lastFullRefreshAt = new Date().toISOString();
    console.log(`[scheduler] full refresh ${feed.handle} (${feed.feed_type}): ${allPosts.length} posts`);
  } else {
    // Find the newest indexedAt among stored posts.
    // Subtract 1s as a buffer to handle same-millisecond edge cases; dedup by URI handles any overlap.
    const newestIndexedAt = existingPosts.reduce((latest, p) =>
      p.indexedAt > latest ? p.indexedAt : latest, '');
    const cutoff = new Date(new Date(newestIndexedAt).getTime() - 1000);

    const newPosts = await fetchAllOriginalPosts(agent, feed.did, feed.handle, feed.feed_type, cutoff, includeReplies);

    // Deduplicate against existing posts (handles the 1s overlap)
    const existingUris = new Set(existingPosts.map(p => p.uri));
    const uniqueNew = newPosts.filter(p => !existingUris.has(p.uri));

    if (uniqueNew.length === 0) {
      console.log(`[scheduler] no new posts for ${feed.handle} (${feed.feed_type})`);
      touchFeedChecked(feed.did, feed.feed_type);
      return;
    }

    if (feed.feed_type.startsWith('top-skeets')) {
      allPosts = [...uniqueNew, ...existingPosts];
      allPosts.sort((a, b) => b.likeCount - a.likeCount);
    } else {
      // chrono-skeets: newest first — new posts go at the front
      allPosts = [...uniqueNew, ...existingPosts];
    }

    console.log(`[scheduler] incremental refresh ${feed.handle} (${feed.feed_type}): +${uniqueNew.length} new (${allPosts.length} total)`);
  }

  upsertFeed({
    did: feed.did,
    handle: feed.handle,
    displayName: feed.display_name,
    avatarUrl: feed.avatar_url,
    feedType: feed.feed_type,
    feedName: feed.feed_name ?? null,
    feedUri: feed.feed_uri!,
    feedUrl: feed.feed_url!,
    postCount: allPosts.length,
    generatedAt: new Date().toISOString(),
    includeReplies,
    lastFullRefreshAt,
    posts: allPosts,
  });
}

/** Force an immediate refresh for a specific feed. Throws on failure. */
export async function refreshFeedNow(did: string, feedType: FeedType): Promise<void> {
  const feed = getFeedByDid(did, feedType);
  if (!feed) throw new Error('Feed not found');
  if (!feed.feed_uri || !feed.feed_url) throw new Error('Feed is not fully registered');
  await refreshFeed(feed);
}

/**
 * Refresh a feed as soon as possible. If a scheduler cycle is running, the
 * feed jumps to the front of its live queue (next free worker picks it up in
 * seconds); otherwise it is fetched directly. The in-flight lock in
 * refreshFeed prevents duplicate concurrent fetches either way.
 */
export async function refreshFeedSoon(did: string, feedType: FeedType): Promise<'skipped' | 'queued' | 'fetched'> {
  const meta = getFeedMetaByDid(did, feedType);
  if (!meta || !meta.feed_uri || !meta.feed_url) return 'skipped';
  // Already populated (e.g. a rename re-register). An include-replies change
  // nulls last_full_refresh_at in register.ts, so those still refetch.
  if (meta.last_full_refresh_at && meta.post_count > 0) return 'skipped';

  if (isRefreshing && activeQueue) {
    activeQueue.unshift(meta);
    console.log(`[scheduler] ${meta.handle} (${feedType}) jumped to the front of the running cycle`);
    return 'queued';
  }

  const feed = getFeedByDid(did, feedType);
  if (!feed) return 'skipped';
  await refreshFeed(feed);
  return 'fetched';
}

function isGoneError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('Profile not found') ||
    msg.includes('Account has been deactivated') ||
    msg.includes('Account has been suspended') ||
    msg.includes('AccountDeactivated') ||
    msg.includes('AccountTakedown')
  );
}

async function refreshFeedWithRetry(feed: UserFeed): Promise<void> {
  try {
    await refreshFeed(feed);
  } catch (err) {
    if (isGoneError(err)) {
      console.log(`[scheduler] pruning ${feed.handle} (${feed.feed_type}) — account gone`);
      deleteFeed(feed.did, feed.feed_type);
      return;
    }
    console.warn(`[scheduler] first attempt failed for ${feed.handle} (${feed.feed_type}), retrying in ${RETRY_DELAY_MS / 1000}s…`, err);
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    try {
      await refreshFeed(feed);
    } catch (retryErr) {
      if (isGoneError(retryErr)) {
        console.log(`[scheduler] pruning ${feed.handle} (${feed.feed_type}) — account gone`);
        deleteFeed(feed.did, feed.feed_type);
        return;
      }
      console.error(`[scheduler] retry failed for ${feed.handle} (${feed.feed_type}):`, retryErr);
    }
  }
}
