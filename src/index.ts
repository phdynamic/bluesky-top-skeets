import express from 'express';
import path from 'path';
import { config } from './config';
import { clientIp, hashIp } from './clientip';
import { startGames } from './games';
import { renderTracerPage, renderAboutPage } from './pages';
import { SAVED_CSP, LIVE_CSP } from './csp';
import { wellKnownRouter } from './well-known';
import { feedSkeletonRouter } from './feed-skeleton';
import { registerUserFeed, unregisterUserFeed } from './register';
import { getFeedMetaByHandle, getAllFeedMetas, FEED_TYPES, FeedType } from './db';
import { startScheduler, stopScheduler, refreshFeedNow, refreshFeedSoon, getSchedulerStatus, getFetchProgress } from './scheduler';

// A stray rejected promise shouldn't kill a healthy server; log and move on.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled rejection:', reason);
});
// Unknown state after a sync throw — log and exit; Railway restarts the
// instance and all persistence writes are atomic, so exiting is safe.
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception:', err);
  process.exit(1);
});

const app = express();

// 2mb: feed icons arrive as base64 in the register body (~33% inflation)
app.use(express.json({ limit: '2mb' }));

// ---------------------------------------------------------------------------
// Simple in-memory rate limiter — max 5 requests per IP per 60 seconds.
// Applies to the three mutation endpoints (register, refresh, unregister).
// ---------------------------------------------------------------------------
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

let loggedForwardedShape = false;
// One log line, once, so the owner can confirm TRUSTED_PROXY_HOPS matches the real proxy chain
// (no addresses are logged, only how many entries the header has).
function noteForwardedHeaderOnce(req: express.Request): void {
  if (loggedForwardedShape) return;
  loggedForwardedShape = true;
  const raw = req.headers['x-forwarded-for'];
  const n = raw ? String(raw).split(',').filter(p => p.trim()).length : 0;
  console.log(`[net] x-forwarded-for has ${n} entr${n === 1 ? 'y' : 'ies'}; TRUSTED_PROXY_HOPS=${config.trustedProxyHops}. If every visitor ends up sharing one rate limit, raise or lower it.`);
}

function rateLimitMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const ip = hashIp(clientIp(req, config.trustedProxyHops));
  noteForwardedHeaderOnce(req);
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

// Sweep expired rate-limit entries so the map can't grow without bound
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now >= entry.resetAt) rateLimitMap.delete(ip);
  }
}, 5 * 60_000).unref();

const MAX_FIELD_LENGTH = 200;

// DID document
app.use(wellKnownRouter);

// Feed skeleton (public, no auth required)
app.use(feedSkeletonRouter);

// Saved quote-post games: built but off unless GAMES_ENABLED=true (then it mounts /api/games and starts a worker).
const games = startGames(app);

// POST /api/register — authenticate as user and publish feed
app.post('/api/register', rateLimitMiddleware, async (req, res) => {
  // includeReplies is no longer read from the body — the replies variants are
  // separate feed types (top-skeets-replies / chrono-skeets-replies).
  const { handle, appPassword, feedType, feedName, feedDescription, feedIcon } = req.body as {
    handle?: string;
    appPassword?: string;
    feedType?: string;
    feedName?: string;
    feedDescription?: string;
    feedIcon?: string;
  };

  if (!handle || !appPassword) {
    res.status(400).json({ error: 'MissingFields', message: 'handle and appPassword are required' });
    return;
  }

  if (handle.length > MAX_FIELD_LENGTH || appPassword.length > MAX_FIELD_LENGTH) {
    res.status(400).json({ error: 'FieldTooLong', message: 'handle and appPassword must be 200 characters or fewer' });
    return;
  }

  // AT Protocol caps feed generator display names at 24 graphemes
  const trimmedFeedName = typeof feedName === 'string' ? feedName.trim() : '';
  if (Array.from(trimmedFeedName).length > 24) {
    res.status(400).json({ error: 'FeedNameTooLong', message: 'Feed name must be 24 characters or fewer' });
    return;
  }

  // AT Protocol caps feed generator descriptions at 300 graphemes
  const trimmedFeedDescription = typeof feedDescription === 'string' ? feedDescription.trim() : '';
  if (Array.from(trimmedFeedDescription).length > 300) {
    res.status(400).json({ error: 'FeedDescriptionTooLong', message: 'Feed description must be 300 characters or fewer' });
    return;
  }

  // Feed icon arrives as base64 JPEG (client crops/downsizes before sending)
  if (feedIcon !== undefined) {
    if (typeof feedIcon !== 'string' || feedIcon.length > 1_400_000 || !/^[A-Za-z0-9+/=]+$/.test(feedIcon)) {
      res.status(400).json({ error: 'InvalidFeedIcon', message: 'Feed icon must be a valid image under 1MB' });
      return;
    }
  }

  if (!feedType || !(FEED_TYPES as string[]).includes(feedType)) {
    res.status(400).json({ error: 'InvalidFeedType', message: `feedType must be one of: ${FEED_TYPES.join(', ')}` });
    return;
  }

  try {
    console.log(`[register] starting for ${handle} (${feedType})`);
    const result = await registerUserFeed(handle, appPassword, feedType as FeedType, trimmedFeedName || null, trimmedFeedDescription || null, feedIcon || null);
    console.log(`[register] done for ${handle} (${feedType}), refreshing posts in background`);
    res.json({
      feedUrl: result.feedUrl,
      handle: result.handle,
      displayName: result.displayName,
      avatarUrl: result.avatarUrl,
      feedName: result.feedName,
      postCount: result.postCount,
      expectedPosts: result.expectedPosts,
    });

    // Fetch posts in the background. If the scheduler is mid-cycle, the new
    // feed jumps to the front of the running queue instead of waiting.
    refreshFeedSoon(result.did, feedType as FeedType).then((status) => {
      if (status === 'fetched') {
        console.log(`[register] background refresh done for ${handle} (${feedType})`);
      } else if (status === 'queued') {
        console.log(`[register] ${handle} (${feedType}) queued at front of running cycle`);
      } else {
        console.log(`[register] ${handle} (${feedType}) already populated — no refresh needed`);
      }
    }).catch((err: unknown) => {
      console.error(`[register] background refresh failed for ${handle} (${feedType}):`, err instanceof Error ? err.message : String(err));
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

  // Authenticate to verify identity and resolve DID — against the PDS that
  // actually hosts the account (third-party PDSes supported)
  const { BskyAgent } = await import('@atproto/api');
  const { resolvePdsService } = await import('./identity');
  const service = await resolvePdsService(handle);
  const agent = new BskyAgent({ service });
  try {
    await agent.login({ identifier: handle, password: appPassword });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(401).json({ error: 'InvalidCredentials', message });
    return;
  }

  const did = agent.session!.did;

  // Full resync runs in the background — a large feed takes minutes and a
  // synchronous response would hit the platform HTTP timeout.
  console.log(`[refresh] full resync requested for ${handle} (${feedType})`);
  refreshFeedNow(did, feedType as FeedType).then(() => {
    console.log(`[refresh] full resync done for ${handle} (${feedType})`);
  }).catch((err: unknown) => {
    console.error(`[refresh] full resync failed for ${handle} (${feedType}):`, err instanceof Error ? err.message : String(err));
  });

  res.json({
    status: 'started',
    handle,
    feedType,
    message: 'Full refresh running in the background — watch GET /api/feed/:handle for postCount/generatedAt updates',
  });
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

  const meta = getFeedMetaByHandle(handle, feedType as FeedType);

  if (!meta) {
    res.status(404).json({ error: 'NotFound', message: 'No feed found for this handle' });
    return;
  }

  res.json({
    handle: meta.handle,
    displayName: meta.display_name,
    avatarUrl: meta.avatar_url,
    feedName: meta.feed_name,
    postCount: meta.post_count,
    generatedAt: meta.generated_at,
    lastFullRefreshAt: meta.last_full_refresh_at,
    fetchProgress: getFetchProgress(meta.did, meta.feed_type),
    feedUrl: meta.feed_url,
  });
});

// GET /health — cheap liveness/status endpoint (metas are in memory)
app.get('/health', (_req, res) => {
  const sched = getSchedulerStatus();
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    feedCount: getAllFeedMetas().length,
    isRefreshing: sched.isRefreshing,
    currentCycleStartedAt: sched.currentCycleStartedAt,
    lastCycleCompletedAt: sched.lastCycleCompletedAt,
    lastCycleDurationMs: sched.lastCycleDurationMs,
  });
});

// Serve frontend for all other routes. HTML is always revalidated so UI
// fixes show up on the next reload after a deploy.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    if (filePath.endsWith('.woff2')) res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  },
}));
// The feed generator UI lives at /feeds; the root is the landing page.
app.get('/feeds', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', 'public', 'feeds.html'));
});
app.get('/tracer', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.set('Content-Security-Policy', LIVE_CSP);
  if (!config.gamesEnabled) { res.sendFile(path.join(__dirname, '..', 'public', 'tracer.html')); return; }
  res.type('html').send(renderTracerPage({ mode: 'live', gamesEnabled: true, sizeCap: config.games.sizeCap }));
});

// Saved games open in the same Tracer page, in saved mode. Every /g/ address gets the page (the page
// itself says "This game isn't available." for anything unknown, hidden or deleted, so the address
// reveals nothing). Only when the feature is on.
if (config.gamesEnabled) {
  const quietHeaders = { 'Cache-Control': 'no-cache', 'Content-Security-Policy': SAVED_CSP, 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' };
  // The explanation and takedown page (before /g/:id so "about" is never read as a game id).
  app.get('/g/about', (_req, res) => { res.set(quietHeaders).type('html').send(renderAboutPage(config.takedownContact)); });
  // The admin page exists only when an admin secret is set.
  if (config.games.adminSecret) {
    app.get('/admin', (_req, res) => { res.set({ ...quietHeaders, 'Cache-Control': 'no-store' }); res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')); });
  }
  app.get(['/g/:id', '/g/:id/v/:n'], (req, res) => {
    res.set({ 'Cache-Control': 'no-cache', 'Content-Security-Policy': SAVED_CSP, 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
    res.type('html').send(renderTracerPage({ mode: 'saved', gameId: req.params.id, version: req.params.n ? parseInt(req.params.n, 10) : undefined }));
  });
}
app.get('/receipt', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', 'public', 'receipt.html'));
});
app.get('/imagine-flagons', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', 'public', 'imagine-flagons.html'));
});
app.get('*', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const server = app.listen(config.port, () => {
  console.log(`Top Skeets running on port ${config.port}`);
  console.log(`Service DID: ${config.feedgenServiceDid}`);
  startScheduler();
});

process.on('SIGTERM', () => {
  console.log('[shutdown] SIGTERM received — stopping scheduler and closing server');
  stopScheduler();
  const closeAll = () => server.close(() => process.exit(0));
  if (games) games.stop().then(closeAll, closeAll); else closeAll();
  // Force exit if keep-alive connections linger past Railway's grace period
  setTimeout(() => process.exit(0), 10_000).unref();
});
