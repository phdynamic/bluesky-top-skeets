import { BskyAgent } from '@atproto/api';
import { config } from './config';
import { upsertFeed } from './db';
import { fetchAllOriginalPosts } from './bluesky';

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
  const posts = await fetchAllOriginalPosts(agent, did, userHandle);

  // 4. Publish feed generator record under the USER'S OWN account
  await agent.api.com.atproto.repo.putRecord({
    repo: did,
    collection: 'app.bsky.feed.generator',
    rkey: config.feedShortName,
    record: {
      $type: 'app.bsky.feed.generator',
      did: config.feedgenServiceDid, // points to OUR server
      displayName: config.feedDisplayName,
      description: config.feedDescription,
      createdAt: new Date().toISOString(),
    },
  });

  // 5. Construct URIs
  const feedUri = `at://${did}/app.bsky.feed.generator/${config.feedShortName}`;
  const feedUrl = `https://bsky.app/profile/${did}/feed/${config.feedShortName}`;

  // 6. Persist to database
  upsertFeed({
    did,
    handle: userHandle,
    displayName,
    avatarUrl,
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
