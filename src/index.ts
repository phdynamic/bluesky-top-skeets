import express from 'express';
import path from 'path';
import { config } from './config';
import { wellKnownRouter } from './well-known';
import { feedSkeletonRouter } from './feed-skeleton';
import { registerUserFeed, unregisterUserFeed } from './register';
import { getFeedByHandle, FEED_TYPES, FeedType } from './db';
import { startScheduler, refreshFeedNow, getIsRefreshing } from './scheduler';

const app = express();

app.use(express.json());

// ---------------------------------------------------------------------------
// Simple in-memory rate limiter — max 5 requests per IP per 60 seconds.
// Applies to the three mutation endpoints (register, refresh, unregister).
// ---------------------------------------------------------------------------
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

function rateLimitMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim() ?? req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    next();
    return;
  }

  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX) {
    res.status(429).json({ error: 'TooManyRequests', message: 'Too many requests. Please wait a moment and try again.' });
    return;
  }

  next();
}

const MAX_FIELD_LENGTH = 200;

// DID document
app.use(wellKnownRouter);

// Feed skeleton (public, no auth required)
app.use(feedSkeletonRouter);

// POST /api/register — authenticate as user and publish feed
app.post('/api/register', rateLimitMiddleware, async (req, res) => {
  const { handle, appPassword, feedType, includeReplies } = req.body as {
    handle?: string;
    appPassword?: string;
    feedType?: string;
    includeReplies?: boolean;
  };

  if (!handle || !appPassword) {
    res.status(400).json({ error: 'MissingFields', message: 'handle and appPassword are required' });
    return;
  }

  if (handle.length > MAX_FIELD_LENGTH || appPassword.length > MAX_FIELD_LENGTH) {
    res.status(400).json({ error: 'FieldTooLong', message: 'handle and appPassword must be 200 characters or fewer' });
    return;
  }

  if (!feedType || !(FEED_TYPES as string[]).includes(feedType)) {
    res.status(400).json({ error: 'InvalidFeedType', message: `feedType must be one of: ${FEED_TYPES.join(', ')}` });
    return;
  }

  try {
    console.log(`[register] starting for ${handle} (${feedType}, includeReplies=${includeReplies ?? false})`);
    const result = await registerUserFeed(handle, appPassword, feedType as FeedType, includeReplies ?? false);
    console.log(`[register] done for ${handle} (${feedType}), refreshing posts in background`);
    res.json({
      feedUrl: result.feedUrl,
      handle: result.handle,
      displayName: result.displayName,
      avatarUrl: result.avatarUrl,
      postCount: result.postCount,
    });

    // Fetch posts in the background only if the scheduler isn't already running.
    // If it is running, the next scheduler cycle will pick up the new feed.
    if (!getIsRefreshing()) {
      refreshFeedNow(result.did, feedType as FeedType).then(() => {
        console.log(`[register] background refresh done for ${handle} (${feedType})`);
      }).catch((err: unknown) => {
        console.error(`[register] background refresh failed for ${handle} (${feedType}):`, err instanceof Error ? err.message : String(err));
      });
    } else {
      console.log(`[register] scheduler running — ${handle} (${feedType}) will be refreshed in next cycle`);
    }
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

// POST /api/refresh — immediately re-fetch posts for an existing feed
app.post('/api/refresh', rateLimitMiddleware, async (req, res) => {
  const { handle, appPassword, feedType } = req.body as {
    handle?: string;
    appPassword?: string;
    feedType?: string;
  };

  if (!handle || !appPassword) {
    res.status(400).json({ error: 'MissingFields', message: 'handle and appPassword are required' });
    return;
  }

  if (handle.length > MAX_FIELD_LENGTH || appPassword.length > MAX_FIELD_LENGTH) {
    res.status(400).json({ error: 'FieldTooLong', message: 'handle and appPassword must be 200 characters or fewer' });
    return;
  }

  if (!feedType || !(FEED_TYPES as string[]).includes(feedType)) {
    res.status(400).json({ error: 'InvalidFeedType', message: `feedType must be one of: ${FEED_TYPES.join(', ')}` });
    return;
  }

  // Authenticate to verify identity and resolve DID
  const { BskyAgent } = await import('@atproto/api');
  const agent = new BskyAgent({ service: 'https://bsky.social' });
  try {
    await agent.login({ identifier: handle, password: appPassword });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(401).json({ error: 'InvalidCredentials', message });
    return;
  }

  const did = agent.session!.did;

  try {
    await refreshFeedNow(did, feedType as FeedType);
    const feed = getFeedByHandle(handle, feedType as FeedType);
    res.json({ handle, feedType, generatedAt: feed?.generated_at, postCount: feed?.post_count });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[refresh error]', message);
    res.status(500).json({ error: 'InternalError', message });
  }
});

// POST /api/unregister — delete feed generator record and remove from store
app.post('/api/unregister', rateLimitMiddleware, async (req, res) => {
  const { handle, appPassword, feedType } = req.body as {
    handle?: string;
    appPassword?: string;
    feedType?: string;
  };

  if (!handle || !appPassword) {
    res.status(400).json({ error: 'MissingFields', message: 'handle and appPassword are required' });
    return;
  }

  if (handle.length > MAX_FIELD_LENGTH || appPassword.length > MAX_FIELD_LENGTH) {
    res.status(400).json({ error: 'FieldTooLong', message: 'handle and appPassword must be 200 characters or fewer' });
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
  startScheduler();
});
