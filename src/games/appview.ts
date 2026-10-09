import type { RequestBudget } from '../budget';

/** Bluesky could not be reached, kept rate-limiting us, or kept failing. Nothing should be wiped because of it. */
export class BskyUnavailable extends Error {
  constructor(message: string) { super(message); this.name = 'BskyUnavailable'; }
}
/** Bluesky answered clearly that the thing is not there (unknown handle, missing post). */
export class NotFound extends Error {
  constructor(message: string) { super(message); this.name = 'NotFound'; }
}

export interface Label { val?: string }
export interface PostView {
  uri: string;
  author?: { did?: string; handle?: string; displayName?: string; labels?: Label[] };
  record?: { text?: string; createdAt?: string; embed?: { $type?: string; record?: { uri?: string } | { record?: { uri?: string } } } };
  indexedAt?: string;
  quoteCount?: number;
  labels?: Label[];
}

export interface AppViewOptions {
  baseUrl: string;
  budget: RequestBudget;
  userAgent: string;
  /** Pause between this client's own requests, on top of the shared budget. */
  gapMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  priority?: 'user' | 'background';
}

const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * The only door from the games code to the public AppView. Every request takes the shared budget,
 * names the site in its User-Agent, has a timeout, and on a 429 pauses everyone (via the budget)
 * for the server's Retry-After (15 s when it gives none) before trying again. After a few failures
 * it gives up with BskyUnavailable, which callers treat as "try later", never as "deleted".
 */
export class AppViewClient {
  requests = 0;
  private nextAllowed = 0;
  private readonly o: Required<Omit<AppViewOptions, 'fetchFn' | 'sleep'>> & { fetchFn: typeof fetch; sleep: (ms: number) => Promise<void> };

  constructor(opts: AppViewOptions) {
    this.o = {
      gapMs: 250, timeoutMs: 20_000, maxAttempts: 6, priority: 'user',
      fetchFn: opts.fetchFn ?? fetch, sleep: opts.sleep ?? realSleep, ...opts,
    } as AppViewClient['o'];
  }

  private async call(method: string, params: Record<string, string | string[]>): Promise<any> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) (Array.isArray(v) ? v : [v]).forEach(x => qs.append(k, x));
    const url = `${this.o.baseUrl}/xrpc/${method}?${qs.toString()}`;
    let lastError = 'no answer';
    for (let attempt = 1; attempt <= this.o.maxAttempts; attempt++) {
      const wait = this.nextAllowed - Date.now();
      if (wait > 0) await this.o.sleep(wait);
      this.nextAllowed = Date.now() + this.o.gapMs;
      await this.o.budget.take(this.o.priority);
      this.requests++;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.o.timeoutMs);
      let res: Response;
      try {
        res = await this.o.fetchFn(url, { signal: ac.signal, headers: { 'User-Agent': this.o.userAgent, Accept: 'application/json' } });
      } catch (e) {
        lastError = e instanceof Error ? e.message : 'network error';
        await this.o.sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)));
        continue;
      } finally { clearTimeout(timer); }

      if (res.ok) {
        try { return await res.json(); } catch { lastError = 'unreadable answer'; continue; }
      }
      if (res.status === 429) {
        let sec = parseInt(res.headers.get('retry-after') ?? '', 10);
        if (!(sec > 0)) sec = 15;
        const ms = Math.min(Math.max(sec * 1000, 5_000), 120_000);
        this.o.budget.penalize(ms);
        lastError = 'rate limited';
        await this.o.sleep(ms);
        continue;
      }
      if (res.status >= 500) {
        lastError = `Bluesky error ${res.status}`;
        await this.o.sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)));
        continue;
      }
      // 4xx other than 429: a clear "no"
      let message = `HTTP ${res.status}`;
      try { const b = await res.json() as { message?: string }; if (b?.message) message = b.message; } catch { /* ignore */ }
      throw new NotFound(message);
    }
    throw new BskyUnavailable(lastError);
  }

  async resolveHandle(handle: string): Promise<string> {
    const r = await this.call('com.atproto.identity.resolveHandle', { handle });
    if (!r || typeof r.did !== 'string') throw new NotFound('handle did not resolve');
    return r.did;
  }

  /** Up to 25 posts. Posts that are missing, hidden or not public are simply absent from the result. */
  async getPosts(uris: string[]): Promise<PostView[]> {
    if (uris.length === 0) return [];
    if (uris.length > 25) throw new Error('getPosts takes at most 25 URIs');
    const r = await this.call('app.bsky.feed.getPosts', { uris });
    return Array.isArray(r?.posts) ? r.posts as PostView[] : [];
  }

  async getQuotes(uri: string, cursor?: string): Promise<{ posts: PostView[]; cursor?: string }> {
    const params: Record<string, string> = { uri, limit: '100' };
    if (cursor) params.cursor = cursor;
    const r = await this.call('app.bsky.feed.getQuotes', params);
    return { posts: Array.isArray(r?.posts) ? r.posts as PostView[] : [], cursor: typeof r?.cursor === 'string' && r.cursor ? r.cursor : undefined };
  }
}
