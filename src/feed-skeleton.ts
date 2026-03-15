import { Router, Request, Response } from 'express';
import { config } from './config';
import { getFeedByDid, PostRecord } from './db';

export const feedSkeletonRouter = Router();

feedSkeletonRouter.get('/xrpc/app.bsky.feed.getFeedSkeleton', (req: Request, res: Response) => {
  const feedParam = req.query.feed as string | undefined;

  if (!feedParam) {
    res.status(400).json({ error: 'UnknownFeed', message: 'Missing feed parameter' });
    return;
  }

  // Parse AT URI: at://{userDid}/app.bsky.feed.generator/{rkey}
  let userDid: string;
  let rkey: string;

  try {
    if (!feedParam.startsWith('at://')) throw new Error('Invalid AT URI');
    const withoutScheme = feedParam.slice('at://'.length);
    const slashIdx = withoutScheme.indexOf('/');
    if (slashIdx === -1) throw new Error('Malformed AT URI');
    userDid = withoutScheme.slice(0, slashIdx);
    const rest = withoutScheme.slice(slashIdx + 1); // app.bsky.feed.generator/{rkey}
    const parts = rest.split('/');
    if (parts.length < 2) throw new Error('Malformed AT URI');
    rkey = parts[parts.length - 1];
  } catch {
    res.status(400).json({ error: 'UnknownFeed', message: 'Malformed feed URI' });
    return;
  }

  if (rkey !== config.feedShortName) {
    res.status(400).json({ error: 'UnknownFeed', message: 'Unknown feed rkey' });
    return;
  }

  const feedRecord = getFeedByDid(userDid);
  if (!feedRecord) {
    res.status(400).json({ error: 'UnknownFeed', message: 'No feed found for this user' });
    return;
  }

  let posts: PostRecord[];
  try {
    posts = JSON.parse(feedRecord.posts) as PostRecord[];
  } catch {
    posts = [];
  }

  const limit = Math.min(Math.max(parseInt((req.query.limit as string) ?? '30', 10) || 30, 1), 100);
  const cursorParam = req.query.cursor as string | undefined;
  const cursorIndex = cursorParam ? parseInt(cursorParam, 10) : 0;

  const page = posts.slice(cursorIndex, cursorIndex + limit);
  const nextCursor =
    cursorIndex + limit < posts.length ? String(cursorIndex + limit) : undefined;

  res.json({
    ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
    feed: page.map((p) => ({ post: p.uri })),
  });
});
