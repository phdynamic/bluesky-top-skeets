/**
 * Read-only probe of the public AppView, run once on the real server:
 *
 *   npm run build && npm run probe -- <post link> [--burst N] [--uri at://...]...
 *
 * It measures what the Game Preserver spec says must be measured rather than assumed: rate-limit
 * headers, what a 429 looks like (only with --burst), the getPosts batch cap, how deep a quote
 * chain can be followed, labels on the posts it sees, and (with --uri) whether specific posts you
 * know about, such as an opted-out author's or a detached quote, come back from a public read.
 * It prints a report and stores nothing. It needs no secrets and does not load the server config.
 */
import { parsePostLink } from './links';

const APPVIEW = (process.env.APPVIEW_URL ?? 'https://public.api.bsky.app').replace(/\/+$/, '');
const UA = 'ProfessorKiosk-Probe/1.0 (+https://professorkiosk.wtf)';
const RL_HEADERS = ['ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'ratelimit-policy', 'retry-after'];

interface Reply { status: number; headers: Record<string, string>; body: any; ms: number }
const seenRateLimit: Record<string, string>[] = [];

async function call(method: string, params: Record<string, string | string[]>): Promise<Reply> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) (Array.isArray(v) ? v : [v]).forEach(x => qs.append(k, x));
  const t0 = Date.now();
  const res = await fetch(`${APPVIEW}/xrpc/${method}?${qs.toString()}`, { headers: { 'User-Agent': UA } });
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  const headers: Record<string, string> = {};
  for (const h of RL_HEADERS) { const v = res.headers.get(h); if (v) headers[h] = v; }
  if (Object.keys(headers).length) seenRateLimit.push(headers);
  return { status: res.status, headers, body, ms: Date.now() - t0 };
}

const out: string[] = [];
const say = (s = '') => { out.push(s); console.log(s); };
const labels = (p: any): string => {
  const v = [...(p?.labels ?? []), ...(p?.author?.labels ?? [])].map((l: any) => l?.val).filter(Boolean);
  return v.length ? v.join(',') : 'none';
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const link = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--uri' && args[i - 1] !== '--burst');
  const burstIdx = args.indexOf('--burst');
  const burst = burstIdx >= 0 ? Math.min(500, Math.max(0, parseInt(args[burstIdx + 1] ?? '0', 10) || 0)) : 0;
  const extraUris = args.flatMap((a, i) => (args[i - 1] === '--uri' ? [a] : []));

  say(`AppView: ${APPVIEW}`);
  say(`Date: ${new Date().toISOString()}`);
  const parsed = link ? parsePostLink(link) : null;
  if (!parsed) { say('Give a post link as the first argument.'); process.exitCode = 1; return; }

  let did = parsed.id;
  if (!did.startsWith('did:')) {
    const r = await call('com.atproto.identity.resolveHandle', { handle: parsed.id });
    say(`resolveHandle ${parsed.id}: HTTP ${r.status} in ${r.ms} ms ${JSON.stringify(r.headers)}`);
    if (r.status !== 200 || !r.body?.did) { say('Handle did not resolve.'); process.exitCode = 1; return; }
    did = r.body.did;
  }
  const rootUri = `at://${did}/app.bsky.feed.post/${parsed.rkey}`;
  const root = await call('app.bsky.feed.getPosts', { uris: rootUri });
  const post = root.body?.posts?.[0];
  say(`getPosts root: HTTP ${root.status} in ${root.ms} ms, found=${!!post} ${JSON.stringify(root.headers)}`);
  if (!post) { say('Root not returned (deleted, hidden, or opted out of logged-out viewing).'); process.exitCode = 1; return; }
  say(`  author=${post.author?.handle} quoteCount=${post.quoteCount} likeCount=${post.likeCount} labels=${labels(post)}`);

  // Walk one chain of quotes as deep as it goes (max 8) and collect URIs for the batch test.
  const pool: string[] = [rootUri];
  let cur = rootUri, depth = 0;
  const chain: string[] = [];
  while (depth < 8) {
    const q = await call('app.bsky.feed.getQuotes', { uri: cur, limit: '100' });
    const posts: any[] = q.body?.posts ?? [];
    say(`getQuotes depth ${depth}: HTTP ${q.status} in ${q.ms} ms, returned=${posts.length}, cursor=${q.body?.cursor ? 'yes' : 'no'}`);
    if (q.status !== 200 || !posts.length) break;
    posts.forEach(p => pool.push(p.uri));
    chain.push(`${posts.length}@${depth + 1}`);
    const next = posts.find(p => (p.quoteCount ?? 0) > 0);
    if (!next) break;
    cur = next.uri; depth++;
  }
  say(`Chain depth reached: ${depth + 1} level(s) of quotes (${chain.join(', ') || 'none'})`);
  say(`Labels seen on quotes: ${pool.length > 1 ? 'see getQuotes bodies; none printed here to keep the report short' : 'n/a'}`);

  // getPosts batch cap
  const uniq = Array.from(new Set(pool));
  if (uniq.length >= 26) {
    for (const n of [25, 26, Math.min(50, uniq.length)]) {
      const r = await call('app.bsky.feed.getPosts', { uris: uniq.slice(0, n) });
      say(`getPosts with ${n} URIs: HTTP ${r.status}, returned=${r.body?.posts?.length ?? 'n/a'}${r.body?.message ? ' message=' + r.body.message : ''}`);
    }
  } else {
    say(`getPosts batch cap: only ${uniq.length} URIs available; use a post with more than 26 quotes to test.`);
  }

  for (const uri of extraUris) {
    const r = await call('app.bsky.feed.getPosts', { uris: uri });
    say(`--uri ${uri}: HTTP ${r.status}, returned=${r.body?.posts?.length ?? 0} (0 means a public read cannot see it)`);
  }

  if (burst > 0) {
    say(`Burst test: up to ${burst} back-to-back getPosts calls, stopping at the first 429...`);
    let sent = 0, hit: Reply | null = null;
    for (let i = 0; i < burst; i++) {
      const r = await call('app.bsky.feed.getPosts', { uris: rootUri });
      sent++;
      if (r.status === 429) { hit = r; break; }
    }
    if (hit) say(`  429 after ${sent} calls. headers=${JSON.stringify(hit.headers)} body=${JSON.stringify(hit.body)}`);
    else say(`  No 429 in ${sent} calls.`);
  }

  say('');
  say(`Rate-limit headers seen (${seenRateLimit.length} responses): ${seenRateLimit.length ? JSON.stringify(seenRateLimit[seenRateLimit.length - 1]) : 'none returned'}`);
  say('Paste this report back so the limits can be set in config (APPVIEW_MAX_RPS).');
}

main().catch(err => { console.error('Probe failed:', err instanceof Error ? err.message : err); process.exitCode = 1; });
