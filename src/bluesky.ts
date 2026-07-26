import { BskyAgent, AppBskyFeedGetAuthorFeed } from '@atproto/api';
import { PostRecord, FeedType } from './db';

const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_DELAY_MS = 250;
const PAGE_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = 15_000;

/**
 * Fetch ALL posts for a logged-in agent (no reposts).
 * When includeReplies is false (default), replies are excluded server- and client-side.
 * Paginates until the API returns no more cursor.
 * sortOrder: 'top' sorts by like count descending; 'chrono' keeps newest-first order.
 */
export async function fetchAllOriginalPosts(
  agent: BskyAgent,
  did: string,
  userHandle: string,
  feedType: FeedType,
  /** If provided, stop paginating once posts older than this date are seen. */
  cutoffDate?: Date,
  includeReplies = false,
  /** Called after each page with the cumulative count of raw feed items scanned. */
  onProgress?: (scanned: number) => void,
): Promise<PostRecord[]> {
  const posts: PostRecord[] = [];
  let cursor: string | undefined;
  let reachedCutoff = false;
  let firstPage = true;
  let scanned = 0;

  do {
    if (!firstPage) {
      await new Promise(resolve => setTimeout(resolve, PAGE_DELAY_MS));
    }
    firstPage = false;

    // Retry individual pages so one flaky request doesn't discard a
    // multi-hundred-page fetch of a large account.
    let res: AppBskyFeedGetAuthorFeed.Response;
    for (let attempt = 1; ; attempt++) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
      try {
        res = await agent.api.app.bsky.feed.getAuthorFeed(
          {
            actor: did,
            limit: 100,
            filter: includeReplies ? 'posts_with_replies' : 'posts_no_replies',
            ...(cursor ? { cursor } : {}),
          },
          { signal: abort.signal },
        );
        break;
      } catch (err) {
        if (attempt >= PAGE_RETRIES) throw err;
        const status = (err as { status?: number }).status;
        let backoffMs = attempt * 2_000;
        if (status === 429) {
          // Honor the server's reset headers when present; clamp to 15s–120s
          backoffMs = RATE_LIMIT_BACKOFF_MS;
          const headers = (err as { headers?: Record<string, string> }).headers;
          const retryAfterSec = headers ? parseInt(headers['retry-after'] ?? '', 10) : NaN;
          const resetEpochSec = headers ? parseInt(headers['ratelimit-reset'] ?? '', 10) : NaN;
          if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
            backoffMs = retryAfterSec * 1000;
          } else if (Number.isFinite(resetEpochSec) && resetEpochSec > 0) {
            backoffMs = resetEpochSec * 1000 - Date.now();
          }
          backoffMs = Math.min(Math.max(backoffMs, RATE_LIMIT_BACKOFF_MS), 120_000);
        }
        console.warn(
          `[fetch] page failed for ${userHandle} (attempt ${attempt}/${PAGE_RETRIES}), retrying in ${backoffMs / 1000}s:`,
          err instanceof Error ? err.message : String(err),
        );
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      } finally {
        clearTimeout(timer);
      }
    }

    const { feed, cursor: nextCursor } = res.data;

    for (const item of feed) {
      // Skip reposts BEFORE the cutoff check: a repost's post.indexedAt is
      // the ORIGINAL post's timestamp, not the repost time — an old repost
      // sitting above newer originals would otherwise end the incremental
      // scan early and hide those posts until the next full refresh.
      if (
        item.reason &&
        (item.reason as { $type?: string }).$type === 'app.bsky.feed.defs#reasonRepost'
      ) {
        continue;
      }

      // Stop early if this (own) post is older than the cutoff
      if (cutoffDate && new Date(item.post.indexedAt) < cutoffDate) {
        reachedCutoff = true;
        break;
      }

      // Progress counts posts + replies only — reposts are excluded so the
      // number aligns with the profile's postsCount (the UI's denominator),
      // which doesn't include reposts either.
      scanned++;

      // Skip replies unless includeReplies is set
      const record = item.post.record as Record<string, unknown> | null;
      if (!includeReplies && record && record.reply) {
        continue;
      }

      const rkey = item.post.uri.split('/').pop() ?? '';
      posts.push({
        uri: item.post.uri,
        url: `https://bsky.app/profile/${userHandle}/post/${rkey}`,
        text: (record?.text as string) ?? '',
        likeCount: item.post.likeCount ?? 0,
        indexedAt: item.post.indexedAt,
      });
    }

    if (onProgress) onProgress(scanned);

    cursor = reachedCutoff ? undefined : nextCursor;
  } while (cursor);

  if (feedType.startsWith('top-skeets')) {
    // Sort by like count descending
    posts.sort((a, b) => b.likeCount - a.likeCount);
  }
  // chrono-skeets: getAuthorFeed already returns newest-first; no re-sort needed

  return posts;
}
