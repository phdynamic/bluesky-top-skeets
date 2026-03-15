import express from 'express';
import path from 'path';
import { config } from './config';
import { wellKnownRouter } from './well-known';
import { feedSkeletonRouter } from './feed-skeleton';
import { registerUserFeed } from './register';
import { initDb, getFeedByHandle } from './db';

const app = express();

app.use(express.json());

// DID document
app.use(wellKnownRouter);

// Feed skeleton (public, no auth required)
app.use(feedSkeletonRouter);

// POST /api/register — authenticate as user and publish feed
app.post('/api/register', async (req, res) => {
  const { handle, appPassword } = req.body as { handle?: string; appPassword?: string };

  if (!handle || !appPassword) {
    res.status(400).json({ error: 'MissingFields', message: 'handle and appPassword are required' });
    return;
  }

  try {
    const result = await registerUserFeed(handle, appPassword);
    // Return top-5 posts for preview; never echo the password
    res.json({
      feedUrl: result.feedUrl,
      handle: result.handle,
      displayName: result.displayName,
      avatarUrl: result.avatarUrl,
      postCount: result.postCount,
      topPosts: result.posts.slice(0, 5),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Detect auth failures from @atproto/api
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

// GET /api/feed/:handle — look up existing feed by handle
app.get('/api/feed/:handle', (req, res) => {
  const { handle } = req.params;
  const feed = getFeedByHandle(handle);

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

initDb()
  .then(() => {
    app.listen(config.port, () => {
      console.log(`Top Skeets running on port ${config.port}`);
      console.log(`Service DID: ${config.feedgenServiceDid}`);
      console.log(`Feed short name: ${config.feedShortName}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialise database:', err);
    process.exit(1);
  });
