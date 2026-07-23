import { BskyAgent } from '@atproto/api';
import { config } from './config';
import { upsertFeed, deleteFeed, getFeedByDid, FeedType } from './db';

const FEED_DISPLAY_NAMES: Record<FeedType, string> = {
  'top-skeets': 'Top Skeets',
  'chrono-skeets': 'My Skeets',
};

const FEED_DESCRIPTIONS: Record<FeedType, string> = {
  'top-skeets': 'My posts, ranked by likes.',
  'chrono-skeets': 'My posts, newest first.',
};

export interface RegisterResult {
  did: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  feedUrl: string;
  feedName: string;
  postCount: number;
  /** Total posts on the user's profile (incl. replies/reposts) — progress denominator. */
  expectedPosts: number | null;
}

export async function registerUserFeed(
  handle: string,
  appPassword: string,
  feedType: FeedType,
  includeReplies = false,
  feedName: string | null = null,
): Promise<RegisterResult> {
  const agent = new BskyAgent({ service: 'https://bsky.social' });

  // 1. Login — throws on bad credentials
  await agent.login({ identifier: handle, password: appPassword });

  const did = agent.session!.did;
  const userHandle = agent.session!.handle;

  // 2. Fetch profile for display name + avatar
  const profileRes = await agent.api.app.bsky.actor.getProfile({ actor: did });
  const displayName = profileRes.data.displayName ?? null;
  const avatarUrl = profileRes.data.avatar ?? null;
  const expectedPosts = profileRes.data.postsCount ?? null;

  // 3. Publish feed generator record under the USER'S OWN account
  const effectiveFeedName = feedName || FEED_DISPLAY_NAMES[feedType];
  await agent.api.com.atproto.repo.putRecord({
    repo: did,
    collection: 'app.bsky.feed.generator',
    rkey: feedType,
    record: {
      $type: 'app.bsky.feed.generator',
      did: config.feedgenServiceDid,
      displayName: effectiveFeedName,
      description: FEED_DESCRIPTIONS[feedType],
      createdAt: new Date().toISOString(),
    },
  });

  // 4. Construct URIs
  const feedUri = `at://${did}/app.bsky.feed.generator/${feedType}`;
  const feedUrl = `https://bsky.app/profile/${did}/feed/${feedType}`;

  // 5. Persist. If the feed already exists (re-register / rename), keep its
  // posts so the live feed never goes empty while a refetch runs. If the
  // include-replies setting changed, null lastFullRefreshAt so the next
  // refresh is a full refetch honoring the new setting.
  const existing = getFeedByDid(did, feedType);
  const existingPosts = existing?.posts ?? [];
  const settingsChanged = existing ? (existing.include_replies ?? false) !== includeReplies : false;
  upsertFeed({
    did,
    handle: userHandle,
    displayName,
    avatarUrl,
    feedType,
    feedName: feedName ?? null,
    feedUri,
    feedUrl,
    postCount: existingPosts.length,
    generatedAt: existing?.generated_at ?? new Date().toISOString(),
    includeReplies,
    lastFullRefreshAt: settingsChanged ? null : existing?.last_full_refresh_at ?? null,
    posts: existingPosts,
  });

  return {
    did,
    handle: userHandle,
    displayName,
    avatarUrl,
    feedUrl,
    feedName: effectiveFeedName,
    postCount: existingPosts.length,
    expectedPosts,
  };
}

export async function unregisterUserFeed(
  handle: string,
  appPassword: string,
  feedType: FeedType,
): Promise<{ handle: string; displayName: string | null }> {
  const agent = new BskyAgent({ service: 'https://bsky.social' });

  // 1. Login — throws on bad credentials
  await agent.login({ identifier: handle, password: appPassword });

  const did = agent.session!.did;
  const userHandle = agent.session!.handle;
  const profileRes = await agent.api.app.bsky.actor.getProfile({ actor: did });
  const displayName = profileRes.data.displayName ?? null;

  // 2. Delete the feed generator record from the user's AT Proto repo
  await agent.api.com.atproto.repo.deleteRecord({
    repo: did,
    collection: 'app.bsky.feed.generator',
    rkey: feedType,
  });

  // 3. Remove from our store
  deleteFeed(did, feedType);

  return { handle: userHandle, displayName };
}
