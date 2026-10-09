// Imagine Flagons is always a live trace: nothing is embedded, the whole tree comes from Bluesky on each visit.
const { chromium } = require('playwright-core');
const BASE = 'http://localhost:3988/imagine-flagons';
const DID = 'did:plc:orig', RKEY = '3ma4vpkdvwk26';
const out = [], errors = [];
const ok = (name, cond, extra = '') => out.push((cond ? 'PASS' : 'FAIL') + ': ' + name + (extra ? ' — ' + extra : ''));

// root -> 150 quotes (two pages); q0 -> q0a, q0b; q1 is from an account that opted out of logged-out viewing
function world() {
  const kids = { root: Array.from({ length: 150 }, (_, i) => 'q' + i), q0: ['q0a', 'q0b'] };
  const view = k => ({
    uri: `at://did:plc:${k}/app.bsky.feed.post/${k}`,
    author: { did: 'did:plc:' + k, handle: k + '.example', labels: k === 'q1' ? [{ val: '!no-unauthenticated' }] : [] },
    record: { text: k === 'q1' ? 'opted out but visible live' : 'A band called ' + k.toUpperCase(), createdAt: '2025-12-16T10:00:00Z' },
    labels: k === 'q1' ? [{ val: '!no-unauthenticated' }] : [],
    quoteCount: (kids[k] || []).length,
  });
  return { kids, view };
}
async function mk(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  const w = world(), log = { quotes: 0 };
  let fails = opts.failFirst || 0;
  await page.route('https://public.api.bsky.app/xrpc/**', async route => {
    const url = new URL(route.request().url()), m = url.pathname.split('/').pop();
    const J = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(b) });
    if (m === 'app.bsky.actor.getProfile') return J({});
    if (m === 'app.bsky.actor.getProfiles') return J({ profiles: [] });
    if (m === 'app.bsky.feed.getPosts') return J({ posts: [] });
    if (opts.down) return route.abort();
    if (m === 'com.atproto.identity.resolveHandle') return J({ did: DID });
    if (m === 'app.bsky.feed.getQuotes') {
      log.quotes++;
      if (fails > 0) { fails--; return J({ error: 'x' }, 400); }
      const uri = url.searchParams.get('uri'), k = uri.endsWith('/' + RKEY) ? 'root' : uri.split('/').pop();
      const list = w.kids[k] || [], cur = +(url.searchParams.get('cursor') || 0), lim = +(url.searchParams.get('limit') || 50);
      return J({ uri, posts: list.slice(cur, cur + lim).map(w.view), ...(cur + lim < list.length ? { cursor: String(cur + lim) } : {}) });
    }
    return J({}, 404);
  });
  await page.route('https://fonts.g*/**', r => r.abort());
  return { page, log };
}
(async () => {
  const browser = await chromium.launch({ executablePath: require('./env').CHROME });
  {
    const { page, log } = await mk(browser);
    await page.goto(BASE);
    await page.waitForSelector('#app:not([hidden])', { timeout: 15000 });
    await page.waitForTimeout(1600);   // the stat numbers count up
    const total = await page.locator('#stats').innerText();
    ok('I1 the whole tree is fetched live (150 + 2 quotes)', /152/.test(total), total.replace(/\s+/g, ' ').slice(0, 80));
    ok('I2 it paged through the cursor and expanded sub-branches', log.quotes === 3, 'getQuotes calls: ' + log.quotes);
    ok('I3 loading box is gone once the trace is done', await page.locator('#loadbox').isHidden());
    await page.fill('#q', 'opted out but visible');
    await page.waitForTimeout(300);
    const txt = await page.locator('#tree').innerText();
    ok('I4 a post from an opted-out author is shown with its text, not locked', /opted out but visible live/.test(txt) && !/Locked/.test(txt));
    ok('I5 nothing is embedded in the page', !/geftokingmongoose/.test(await page.content()));
    await page.close();
  }
  {
    const { page, log } = await mk(browser, { failFirst: 100 });
    await page.goto(BASE);
    await page.waitForSelector('#retry:not([hidden])', { timeout: 20000 });
    ok('I6 a failed trace says so and offers Try again', /Could not finish/.test(await page.locator('#loadtext').innerText()) && await page.locator('#loaderr').isVisible());
    ok('I7 the tree is not shown when nothing loaded', await page.locator('#app').isHidden());
    await page.close();
  }
  console.log(out.join('\n')); console.log('errors:', errors.join('|') || 'none');
  await browser.close();
})();
