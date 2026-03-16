import { BskyAgent, AppBskyFeedGetAuthorFeed } from '@atproto/api';
import { PostRecord, FeedType } from './db';

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

  do {
    const res: AppBskyFeedGetAuthorFeed.Response = await agent.api.app.bsky.feed.getAuthorFeed({
      actor: did,
      limit: 100,
      filter: 'posts_no_replies',
      ...(cursor ? { cursor } : {}),
    });

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
