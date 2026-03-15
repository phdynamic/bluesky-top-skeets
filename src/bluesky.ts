import { BskyAgent, AppBskyFeedGetAuthorFeed } from '@atproto/api';
import { PostRecord } from './db';

/**
 * Fetch ALL original posts for a logged-in agent (no replies, no reposts).
 * Paginates until the API returns no more cursor.
 */
export async function fetchAllOriginalPosts(
  agent: BskyAgent,
  did: string,
  userHandle: string,
): Promise<PostRecord[]> {
  const posts: PostRecord[] = [];
  let cursor: string | undefined;

  do {
    const res: AppBskyFeedGetAuthorFeed.Response = await agent.api.app.bsky.feed.getAuthorFeed({
      actor: did,
      limit: 100,
      filter: 'posts_no_replies',
      ...(cursor ? { cursor } : {}),
    });

    const { feed, cursor: nextCursor } = res.data;

    for (const item of feed) {
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

    cursor = nextCursor;
  } while (cursor);

  // Sort by like count descending
  posts.sort((a, b) => b.likeCount - a.likeCount);

  return posts;
}
