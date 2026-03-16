import { BskyAgent } from '@atproto/api';
import { config } from './config';
import { upsertFeed, deleteFeed, FeedType } from './db';
import { fetchAllOriginalPosts } from './bluesky';

const FEED_DISPLAY_NAMES: Record<FeedType, string> = {
  'top-skeets': 'Top Skeets',
  'chrono-skeets': 'Chrono Skeets',
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
  postCount: number;
  posts: Array<{ uri: string; url: string; text: string; likeCount: number; indexedAt: string }>;
}

export async function registerUserFeed(
  handle: string,
  appPassword: string,
  feedType: FeedType,
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

  // 3. Fetch and sort all original posts
  const posts = await fetchAllOriginalPosts(agent, did, userHandle, feedType);

  // 4. Publish feed generator record under the USER'S OWN account
  await agent.api.com.atproto.repo.putRecord({
    repo: did,
    collection: 'app.bsky.feed.generator',
    rkey: feedType,
    record: {
      $type: 'app.bsky.feed.generator',
      did: config.feedgenServiceDid,
      displayName: FEED_DISPLAY_NAMES[feedType],
      description: FEED_DESCRIPTIONS[feedType],
      createdAt: new Date().toISOString(),
    },
  });

  // 5. Construct URIs
  const feedUri = `at://${did}/app.bsky.feed.generator/${feedType}`;
  const feedUrl = `https://bsky.app/profile/${did}/feed/${feedType}`;

  // 6. Persist to database
  upsertFeed({
    did,
    handle: userHandle,
    displayName,
    avatarUrl,
    feedType,
    feedUri,
    feedUrl,
    postCount: posts.length,
    generatedAt: new Date().toISOString(),
    posts,
  });

  return {
    did,
    handle: userHandle,
    displayName,
    avatarUrl,
    feedUrl,
    postCount: posts.length,
    posts,
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
