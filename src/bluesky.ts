import type { BskyAgent } from '@atproto/api';
import { PostRecord, FeedType } from './db';
import { config } from './config';
import { appviewBudget } from './budget';

// The public AppView indexes the whole federated network, so author feeds for
// accounts on any PDS are fetched from here.
const APPVIEW_URL = config.appviewUrl;

/** The only fields of getAuthorFeed we read. */
interface FeedItem {
  post: {
    uri: string;
    indexedAt: string;
    likeCount?: number;
    record?: Record<string, unknown> | null;
  };
  reason?: { $type?: string };
}

/**
 * Plain-fetch getAuthorFeed. Deliberately NOT the @atproto/api client: it
 * validates every response against the lexicon, so a single post with e.g.
 * over-long image alt text rejects the entire 100-post page — a deterministic
 * failure no retry can fix. We only need a handful of fields, so lenient
 * parsing is strictly more robust. Errors carry `status` and `headers` so the
 * retry loop's 429 handling still works, and the server's message (e.g.
 * "Profile not found") so the scheduler can still detect gone accounts.
 */
async function fetchAuthorFeedPage(
  params: { actor: string; limit: number; filter: string; cursor?: string },
  signal: AbortSignal,
): Promise<{ feed: FeedItem[]; cursor?: string }> {
  const qs = new URLSearchParams({
    actor: params.actor,
    limit: String(params.limit),
    filter: params.filter,
  });
  if (params.cursor) qs.set('cursor', params.cursor);

  await appviewBudget.take('feeds');   // shared pacing across everything that talks to the AppView
  const res = await fetch(`${APPVIEW_URL}/xrpc/app.bsky.feed.getAuthorFeed?${qs.toString()}`, {
    signal,
    headers: { 'User-Agent': config.userAgent },
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json() as { message?: string };
      if (body && typeof body.message === 'string') message = body.message;
    } catch { /* non-JSON error body */ }
    const err = new Error(message) as Error & { status?: number; headers?: Record<string, string> };
    err.status = res.status;
    err.headers = Object.fromEntries(res.headers.entries());
    throw err;
  }
  const body = await res.json() as { feed?: FeedItem[]; cursor?: string };
  return { feed: Array.isArray(body.feed) ? body.feed : [], cursor: body.cursor };
}

const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_DELAY_MS = 250;
const PAGE_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = 15_000;

/**
 * Fetch ALL posts for a logged-in agent (no reposts).
 * When includeReplies is false (default), replies are excluded server- and client-side.
 * Paginates until the API returns no more cursor.
 * sortOrder: 'top' sorts by like count descending; 'chrono' keeps newest-first order.
 */
export async function fetchAllOriginalPosts(
  _agent: BskyAgent,
  did: string,
  userHandle: string,
  feedType: FeedType,
  /** If provided, stop paginating once posts older than this date are seen. */
  cutoffDate?: Date,
  includeReplies = false,
  /** Called after each page with the cumulative count of raw feed items scanned. */
  onProgress?: (scanned: number) => void,
): Promise<PostRecord[]> {
  const posts: PostRecord[] = [];
  let cursor: string | undefined;
  let reachedCutoff = false;
  let firstPage = true;
  let scanned = 0;

  do {
    if (!firstPage) {
      await new Promise(resolve => setTimeout(resolve, PAGE_DELAY_MS));
    }
    firstPage = false;

    // Retry individual pages so one flaky request doesn't discard a
    // multi-hundred-page fetch of a large account.
    let page: { feed: FeedItem[]; cursor?: string };
    for (let attempt = 1; ; attempt++) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
      try {
        page = await fetchAuthorFeedPage(
          {
            actor: did,
            limit: 100,
            filter: includeReplies ? 'posts_with_replies' : 'posts_no_replies',
            ...(cursor ? { cursor } : {}),
          },
          abort.signal,
        );
        break;
      } catch (err) {
        if (attempt >= PAGE_RETRIES) throw err;
        const status = (err as { status?: number }).status;
        let backoffMs = attempt * 2_000;
        if (status === 429) {
          // Honor the server's reset headers when present; clamp to 15s–120s
          backoffMs = RATE_LIMIT_BACKOFF_MS;
          const headers = (err as { headers?: Record<string, string> }).headers;
          const retryAfterSec = headers ? parseInt(headers['retry-after'] ?? '', 10) : NaN;
          const resetEpochSec = headers ? parseInt(headers['ratelimit-reset'] ?? '', 10) : NaN;
          if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
            backoffMs = retryAfterSec * 1000;
          } else if (Number.isFinite(resetEpochSec) && resetEpochSec > 0) {
            backoffMs = resetEpochSec * 1000 - Date.now();
          }
          backoffMs = Math.min(Math.max(backoffMs, RATE_LIMIT_BACKOFF_MS), 120_000);
          appviewBudget.penalize(backoffMs);   // everyone else sharing this address pauses too
        }
        console.warn(
          `[fetch] page failed for ${userHandle} (attempt ${attempt}/${PAGE_RETRIES}), retrying in ${backoffMs / 1000}s:`,
          err instanceof Error ? err.message : String(err),
        );
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      } finally {
        clearTimeout(timer);
      }
    }

    const { feed, cursor: nextCursor } = page;

    for (const item of feed) {
      // Skip reposts BEFORE the cutoff check: a repost's post.indexedAt is
      // the ORIGINAL post's timestamp, not the repost time — an old repost
      // sitting above newer originals would otherwise end the incremental
      // scan early and hide those posts until the next full refresh.
      if (item.reason && item.reason.$type === 'app.bsky.feed.defs#reasonRepost') {
        continue;
      }

      // Stop early if this (own) post is older than the cutoff
      if (cutoffDate && new Date(item.post.indexedAt) < cutoffDate) {
        reachedCutoff = true;
        break;
      }

      // Progress counts posts + replies only — reposts are excluded so the
      // number aligns with the profile's postsCount (the UI's denominator),
      // which doesn't include reposts either.
      scanned++;

      // Skip replies unless includeReplies is set
      const record = item.post.record ?? null;
      if (!includeReplies && record && record.reply) {
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

    if (onProgress) onProgress(scanned);

    cursor = reachedCutoff ? undefined : nextCursor;
  } while (cursor);

  if (feedType.startsWith('top-skeets')) {
    // Sort by like count descending
    posts.sort((a, b) => b.likeCount - a.likeCount);
  }
  // chrono-skeets: getAuthorFeed already returns newest-first; no re-sort needed

  return posts;
}
