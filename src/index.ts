import express from 'express';
import path from 'path';
import { config } from './config';
import { wellKnownRouter } from './well-known';
import { feedSkeletonRouter } from './feed-skeleton';
import { registerUserFeed, unregisterUserFeed } from './register';
import { getFeedByHandle, FEED_TYPES, FeedType } from './db';

const app = express();

app.use(express.json());

// DID document
app.use(wellKnownRouter);

// Feed skeleton (public, no auth required)
app.use(feedSkeletonRouter);

// POST /api/register — authenticate as user and publish feed
app.post('/api/register', async (req, res) => {
  const { handle, appPassword, feedType } = req.body as {
    handle?: string;
    appPassword?: string;
    feedType?: string;
  };

  if (!handle || !appPassword) {
    res.status(400).json({ error: 'MissingFields', message: 'handle and appPassword are required' });
    return;
  }

  if (!feedType || !(FEED_TYPES as string[]).includes(feedType)) {
    res.status(400).json({ error: 'InvalidFeedType', message: `feedType must be one of: ${FEED_TYPES.join(', ')}` });
    return;
  }

  try {
    const result = await registerUserFeed(handle, appPassword, feedType as FeedType);
    res.json({
      feedUrl: result.feedUrl,
      handle: result.handle,
      displayName: result.displayName,
      avatarUrl: result.avatarUrl,
      postCount: result.postCount,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    if (
      message.includes('Invalid identifier or password') ||
      message.includes('AuthenticationRequired') ||
      message.includes('Unauthorized') ||
      message.includes('BadCredentials')
    ) {
      res.status(401).json({ error: 'InvalidCredentials', message });
      return;
    }

    console.error('[register error]', message);
    res.status(500).json({ error: 'InternalError', message });
  }
});

// POST /api/unregister — delete feed generator record and remove from store
app.post('/api/unregister', async (req, res) => {
  const { handle, appPassword, feedType } = req.body as {
    handle?: string;
    appPassword?: string;
    feedType?: string;
  };

  if (!handle || !appPassword) {
    res.status(400).json({ error: 'MissingFields', message: 'handle and appPassword are required' });
    return;
  }

  if (!feedType || !(FEED_TYPES as string[]).includes(feedType)) {
    res.status(400).json({ error: 'InvalidFeedType', message: `feedType must be one of: ${FEED_TYPES.join(', ')}` });
    return;
  }

  try {
    const result = await unregisterUserFeed(handle, appPassword, feedType as FeedType);
    res.json({ handle: result.handle, displayName: result.displayName });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    if (
      message.includes('Invalid identifier or password') ||
      message.includes('AuthenticationRequired') ||
      message.includes('Unauthorized') ||
      message.includes('BadCredentials')
    ) {
      res.status(401).json({ error: 'InvalidCredentials', message });
      return;
    }

    console.error('[unregister error]', message);
    res.status(500).json({ error: 'InternalError', message });
  }
});

// GET /api/feed/:handle — look up existing feed by handle
app.get('/api/feed/:handle', (req, res) => {
  const { handle } = req.params;
  const feedType = (req.query.feedType as string) ?? 'top-skeets';

  if (!(FEED_TYPES as string[]).includes(feedType)) {
    res.status(400).json({ error: 'InvalidFeedType', message: `feedType must be one of: ${FEED_TYPES.join(', ')}` });
    return;
  }

  const feed = getFeedByHandle(handle, feedType as FeedType);

  if (!feed) {
    res.status(404).json({ error: 'NotFound', message: 'No feed found for this handle' });
    return;
  }

  res.json({
    handle: feed.handle,
    displayName: feed.display_name,
    avatarUrl: feed.avatar_url,
    postCount: feed.post_count,
    generatedAt: feed.generated_at,
    feedUrl: feed.feed_url,
  });
});

// Serve frontend for all other routes
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(config.port, () => {
  console.log(`Top Skeets running on port ${config.port}`);
  console.log(`Service DID: ${config.feedgenServiceDid}`);
});
