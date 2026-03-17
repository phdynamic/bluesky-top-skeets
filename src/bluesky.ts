import { BskyAgent, AppBskyFeedGetAuthorFeed } from '@atproto/api';
import { PostRecord, FeedType } from './db';

const REQUEST_TIMEOUT_MS = 10_000;
const PAGE_DELAY_MS = 250;

/**
 * Fetch ALL original posts for a logged-in agent (no replies, no reposts).
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
): Promise<PostRecord[]> {
  const posts: PostRecord[] = [];
  let cursor: string | undefined;
  let reachedCutoff = false;
  let firstPage = true;

  do {
    if (!firstPage) {
      await new Promise(resolve => setTimeout(resolve, PAGE_DELAY_MS));
    }
    firstPage = false;

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);

    let res: AppBskyFeedGetAuthorFeed.Response;
    try {
      res = await agent.api.app.bsky.feed.getAuthorFeed(
        {
          actor: did,
          limit: 100,
          filter: 'posts_no_replies',
          ...(cursor ? { cursor } : {}),
        },
        { signal: abort.signal },
      );
    } finally {
      clearTimeout(timer);
    }

    const { feed, cursor: nextCursor } = res.data;

    for (const item of feed) {
      // Stop early if this post is older than the cutoff
      if (cutoffDate && new Date(item.post.indexedAt) < cutoffDate) {
        reachedCutoff = true;
        break;
      }

      // Skip reposts
      if (
        item.reason &&
        (item.reason as { $type?: string }).$type === 'app.bsky.feed.defs#reasonRepost'
      ) {
        continue;
      }

      // Skip replies (belt-and-suspenders — filter param should handle this too)
      const record = item.post.record as Record<string, unknown> | null;
      if (record && record.reply) {
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

    cursor = reachedCutoff ? undefined : nextCursor;
  } while (cursor);

  if (feedType === 'top-skeets') {
    // Sort by like count descending
    posts.sort((a, b) => b.likeCount - a.likeCount);
  }
  // chrono-skeets: getAuthorFeed already returns newest-first; no re-sort needed

  return posts;
}
