/**
 * Read-only probe of the public AppView, run once on the real server:
 *
 *   npm run build && npm run probe -- <post link> [--ramp [--ramp-seconds N]] [--burst N] [--uri at://...]...
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
const RAMP_STEPS = [2, 4, 8, 16];
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
  const link = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--uri' && args[i - 1] !== '--burst' && args[i - 1] !== '--ramp-seconds');
  const burstIdx = args.indexOf('--burst');
  const burst = burstIdx >= 0 ? Math.min(500, Math.max(0, parseInt(args[burstIdx + 1] ?? '0', 10) || 0)) : 0;
  const ramp = args.includes('--ramp');
  const rsIdx = args.indexOf('--ramp-seconds');
  const rampSeconds = rsIdx >= 0 ? Math.min(60, Math.max(1, parseInt(args[rsIdx + 1] ?? '15', 10) || 15)) : 15;
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

  // Follow the biggest branch (the child with the most quotes) as deep as it goes, up to 25 levels,
  // collecting URIs for the batch-size test and counting labels on every quote seen.
  const pool: string[] = [rootUri];
  const labelCounts: Record<string, number> = {};
  let cur = rootUri, depth = 0, notReturned = 0;
  const chain: string[] = [];
  let expected = post.quoteCount ?? 0;
  while (depth < 25) {
    const q = await call('app.bsky.feed.getQuotes', { uri: cur, limit: '100' });
    const posts: any[] = q.body?.posts ?? [];
    say(`getQuotes level ${depth + 1}: HTTP ${q.status} in ${q.ms} ms, returned=${posts.length} of quoteCount=${expected}, cursor=${q.body?.cursor ? 'yes' : 'no'}`);
    if (q.status !== 200 || !posts.length) break;
    if (!q.body?.cursor) notReturned += Math.max(0, expected - posts.length);
    for (const p of posts) {
      pool.push(p.uri);
      for (const l of [...(p.labels ?? []), ...(p.author?.labels ?? [])]) if (l?.val) labelCounts[l.val] = (labelCounts[l.val] ?? 0) + 1;
    }
    chain.push(`${posts.length}@${depth + 1}`);
    const next = posts.filter(p => (p.quoteCount ?? 0) > 0).sort((a, b) => (b.quoteCount ?? 0) - (a.quoteCount ?? 0))[0];
    if (!next) break;
    cur = next.uri; expected = next.quoteCount ?? 0; depth++;
  }
  say(`Chain depth reached: ${depth + 1} level(s) of quotes (${chain.join(', ') || 'none'})`);
  say(`Quotes counted but not returned on single-page levels: ${notReturned} (deleted, hidden, detached, or opted out of logged-out viewing)`);
  say(`Labels on the quotes seen: ${Object.keys(labelCounts).length ? JSON.stringify(labelCounts) : 'none'}`);

  // getPosts batch cap: 25 should work and 26 should not; also try 50 when enough URIs exist.
  const uniq = Array.from(new Set(pool));
  const sizes = [25, 26, 50].filter(n => n <= uniq.length);
  if (!sizes.includes(26)) say(`getPosts batch cap: only ${uniq.length} URIs found, so 26 could not be tried; use a post with more quotes.`);
  for (const n of sizes) {
    const r = await call('app.bsky.feed.getPosts', { uris: uniq.slice(0, n) });
    say(`getPosts with ${n} URIs: HTTP ${r.status}, returned=${r.body?.posts?.length ?? 'n/a'}${r.body?.message ? ' message=' + r.body.message : ''}`);
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

  if (ramp) {
    const secs = rampSeconds;
    say(`Ramp test: ${RAMP_STEPS.join(', ')} requests per second, ${secs} s each, stopping at the first 429...`);
    let total = 0, hitAt: { rps: number; reply: Reply } | null = null;
    for (const rps of RAMP_STEPS) {
      const gap = 1000 / rps, end = Date.now() + secs * 1000;
      const inflight: Promise<void>[] = [];
      let stepSent = 0, codes: Record<number, number> = {};
      while (Date.now() < end && !hitAt) {
        const started = Date.now();
        stepSent++; total++;
        inflight.push(call('app.bsky.feed.getPosts', { uris: rootUri }).then(r => {
          codes[r.status] = (codes[r.status] ?? 0) + 1;
          if (r.status === 429 && !hitAt) hitAt = { rps, reply: r };
        }, () => { codes[0] = (codes[0] ?? 0) + 1; }));
        const wait = gap - (Date.now() - started);
        if (wait > 0) await new Promise(res => setTimeout(res, wait));
      }
      await Promise.all(inflight);
      say(`  ${rps} rps: sent ${stepSent}, responses ${JSON.stringify(codes)}`);
      if (hitAt) break;
    }
    if (hitAt) {
      const h = hitAt as { rps: number; reply: Reply };
      say(`  First 429 during the ${h.rps} rps step after ${total} requests in total. headers=${JSON.stringify(h.reply.headers)} body=${JSON.stringify(h.reply.body)}`);
    } else {
      say(`  No 429 up to ${RAMP_STEPS[RAMP_STEPS.length - 1]} rps (${total} requests). The limit, if there is one, is higher than this test reaches (it may count over a longer window).`);
    }
  }

  say('');
  say(seenRateLimit.length
    ? `Rate-limit headers seen (${seenRateLimit.length} responses): ${JSON.stringify(seenRateLimit[seenRateLimit.length - 1])}`
    : 'The AppView returned NO rate-limit headers on any response, so its limit cannot be read from them. Use --ramp to find where 429s begin.');
  say('Paste this report back so the request budget can be tuned (APPVIEW_MAX_RPS is the ceiling).');
}

main().catch(err => { console.error('Probe failed:', err instanceof Error ? err.message : err); process.exitCode = 1; });
