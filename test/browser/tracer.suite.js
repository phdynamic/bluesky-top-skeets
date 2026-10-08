const { chromium } = require('playwright-core');
const { buildTree, install } = require('./tracermock');
const BASE = 'http://localhost:3988/tracer';
const ROOT = 'https://bsky.app/profile/root.bsky.social/post/r0';
const out = [];
const ok = (name, cond, extra = '') => { out.push((cond ? 'PASS' : 'FAIL') + ': ' + name + (extra ? ' — ' + extra : '')); };
const errors = [];
(async () => {
  const browser = await chromium.launch({ executablePath: require('./env').CHROME });
  async function mk(nodes, opts = {}, tracer = null, viewport = { width: 1000, height: 900 }) {
    const ctx = await browser.newContext({ viewport, colorScheme: 'light' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    if (tracer) await page.addInitScript(t => { window.TRACER_TEST = t }, tracer);
    const log = await install(page, nodes, opts);
    return { page, log, ctx };
  }
  const go = async (page, q) => { await page.goto(BASE); await page.fill('#postInput', q || ROOT); await page.click('#go') };
  const nodeCount = page => page.locator('#tree .node').count();
  const small = buildTree(40, 3);
  const big = buildTree(5000, 7);
  const reachable = big.length - 1;
  const hiddenTrue = big.reduce((s, n) => s + n.hiddenExtra, 0);

  // ---- A. link parsing + errors
  {
    const { page, log } = await mk(small, {}, { gapMs: 1 });
    await go(page, 'hello world'); await page.waitForTimeout(200);
    ok('A1 junk input shows a friendly error and makes no API calls', (await page.locator('#error').isVisible()) && log.calls.length === 0, (await page.locator('#error').innerText()).slice(0, 60));
    for (const [label, input] of [['https link', ROOT], ['at:// URI', 'at://did:plc:u0/app.bsky.feed.post/r0'], ['bare path', 'bsky.app/profile/did:plc:u0/post/r0'], ['trailing slash + query', ROOT + '/?foo=1']]) {
      await page.goto(BASE); await page.fill('#postInput', input); await page.click('#go');
      await page.waitForSelector('#rootcard .card', { timeout: 5000 }).then(() => ok('A2 parses ' + label, true), () => ok('A2 parses ' + label, false));
    }
    await go(page, 'https://bsky.app/profile/nobody.example/post/r0'); await page.waitForSelector('#error:not([hidden])');
    ok('A3 unknown handle -> clear error', /find an account/i.test(await page.locator('#error').innerText()));
    await go(page, 'https://bsky.app/profile/root.bsky.social/post/r99999'); await page.waitForSelector('#error:not([hidden])');
    ok('A4 missing post -> clear error', /find that post/i.test(await page.locator('#error').innerText()));
    await page.close();
  }

  // ---- B. cap, leaf skipping, load more
  {
    const { page, log } = await mk(big, { delay: 4 }, { gapMs: 3 });
    await go(page);
    await page.waitForSelector('#capbar:not([hidden])', { timeout: 60000 });
    const n1 = await nodeCount(page);
    ok('B1 stops at exactly 2,000 quotes', n1 === 2000, 'rendered ' + n1);
    ok('B2 banner shows a lower-bound remaining estimate + Load more', /2,000 quotes/.test(await page.locator('#captext').innerText()) && /at least [\d,]+ more not loaded/.test(await page.locator('#captext').innerText()) && /Load 2,000 more/.test(await page.locator('#moreBtn').innerText()), (await page.locator('#captext').innerText()));
    ok('B3 never queries posts with zero quotes', log.getQuotes.every(c => c.qc > 0), log.getQuotes.length + ' getQuotes calls');
    await page.screenshot({ path: 'tr-capped.png' });
    await page.click('#moreBtn'); await page.waitForFunction(() => document.querySelector('#progress').hidden, null, { timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('#capbar').hidden, null, { timeout: 60000 });
    const n2 = await nodeCount(page);
    ok('B4 Load more adds exactly 2,000 more', n2 === 4000, 'rendered ' + n2);
    await page.click('#moreBtn'); await page.waitForFunction(() => document.querySelector('#progress').hidden && document.querySelector('#capbar').hidden, null, { timeout: 60000 });
    const n3 = await nodeCount(page);
    const ids = await page.evaluate(() => { const a = [...document.querySelectorAll('#tree .node')].map(e => e.id); return a.length - new Set(a).size });
    ok('B5 finishes with every reachable quote, no duplicates', n3 === reachable && ids === 0, 'rendered ' + n3 + ' of ' + reachable + ', duplicate ids ' + ids);
    const note = await page.locator('#hiddennote').innerText();
    ok('B6 hidden-quotes note uses "at least" wording', /^At least \d+ quotes? aren't visible/.test(note), note.slice(0, 80) + ' (true hidden ' + hiddenTrue + ')');
    const seen = new Map(); let dup = 0; log.getQuotes.forEach(c => { const k = c.i + ':' + c.cur; if (seen.has(k)) dup++; seen.set(k, 1) });
    ok('B7 few repeat page fetches across resumes', dup <= 40, dup + ' repeated pages of ' + log.getQuotes.length);
    await page.screenshot({ path: 'tr-finished.png' });
    // ---- viewer features on the finished tree
    await page.fill('#q', 'quote 1234'); await page.waitForTimeout(500);
    ok('I1 search narrows the tree', /1 match/.test(await page.locator('#count').innerText()), await page.locator('#count').innerText());
    await page.fill('#q', ''); await page.waitForTimeout(400);
    await page.click('#vCmp'); await page.waitForTimeout(200);
    ok('I2 compact view toggles (media hidden)', await page.evaluate(() => document.body.classList.contains('compact')));
    await page.click('#vExp');
    await page.click('#exAll'); await page.waitForTimeout(300);
    await page.locator('#tree .card [data-a="trace"]').first().click();
    ok('I3 lineage bar appears', await page.locator('#trace.on').count() === 1);
    await page.click('#lead'); await page.waitForSelector('#dlg[open]');
    ok('I4 leaderboards show 12 rows', await page.locator('#lbc li').count() === 12);
    await page.click('[data-tab="time"]'); ok('I5 timeline renders bars', await page.locator('#lbc .tl div').count() > 1);
    await page.keyboard.press('Escape');
    await page.click('#deep'); await page.waitForSelector('#dlg[open]'); ok('I6 deepest dive lists a chain', await page.locator('#dbody .chain li').count() > 3); await page.keyboard.press('Escape');
    await page.screenshot({ path: 'tr-viewer.png' });
    ok('B8 no JS errors so far', errors.length === 0, errors.join('|'));
    await page.close();
  }

  // ---- C. pacing + concurrency at production defaults
  {
    const { page, log } = await mk(buildTree(220, 4), { delay: 300 });
    await go(page); await page.waitForFunction(() => document.querySelector('#progress').hidden && document.querySelectorAll('#tree .node').length >= 219, null, { timeout: 60000 });
    await page.waitForTimeout(400);
    const gq = log.t.filter((t, i) => log.calls[i] === 'getQuotes');
    const gaps = gq.slice(1).map((t, i) => t - gq[i]);
    ok('C1 requests are paced (>= ~100ms apart)', gaps.length > 5 && Math.min(...gaps) >= 90, 'min gap ' + Math.min(...gaps) + 'ms over ' + gaps.length + ' gaps');
    ok('C2 several requests overlap but never more than 4', log.maxInflight > 1 && log.maxInflight <= 4, 'max ' + log.maxInflight);
    await page.close();
  }

  // ---- D. stop / resume
  {
    const { page, log } = await mk(big, { delay: 15 }, { gapMs: 20 });
    await go(page); await page.waitForSelector('#progress:not([hidden])');
    await page.screenshot({ path: 'tr-progress.png' });
    await page.waitForTimeout(500); await page.click('#stopBtn'); await page.waitForSelector('#capbar:not([hidden])');
    const c0 = log.calls.length; await page.waitForTimeout(700);
    ok('D1 Stop halts requests', log.calls.length - c0 <= 1, 'extra calls after stop: ' + (log.calls.length - c0));
    ok('D2 stopped banner offers Resume', /Stopped at/.test(await page.locator('#captext').innerText()) && /Resume/.test(await page.locator('#moreBtn').innerText()), await page.locator('#captext').innerText());
    const nStop = await nodeCount(page);
    await page.click('#moreBtn'); await page.waitForFunction(() => !document.querySelector('#capbar').hidden && !/Stopped/.test(document.querySelector('#captext').textContent), null, { timeout: 60000 });
    ok('D3 Resume continues to the cap', (await nodeCount(page)) === 2000 && nStop < 2000, nStop + ' -> ' + await nodeCount(page));
    await page.close();
  }

  // ---- E. 429 handling
  {
    const { page, log } = await mk(buildTree(120, 5), { fail429: 1, expose: true }, { gapMs: 3 });
    await go(page); await page.waitForSelector('#pnotice:not([hidden])', { timeout: 8000 });
    ok('E1 rate-limit notice appears and honors an exposed retry-after (clamped to 5s)', /rate-limiting/.test(await page.locator('#pnotice').innerText()) && /waiting 5s/.test(await page.locator('#pnotice').innerText()), await page.locator('#pnotice').innerText());
    await page.waitForFunction(() => document.querySelector('#progress').hidden, null, { timeout: 30000 });
    ok('E2 recovers and finishes after the wait', (await nodeCount(page)) === 119, 'rendered ' + await nodeCount(page));
    await page.close();
  }

  {
    const { page } = await mk(buildTree(60, 5), { fail429: 1 }, { gapMs: 3 });
    await go(page); await page.waitForSelector('#pnotice:not([hidden])', { timeout: 8000 });
    ok('E3 headers hidden by CORS -> falls back to a 15s wait', /waiting 15s/.test(await page.locator('#pnotice').innerText()), await page.locator('#pnotice').innerText());
    await page.close();
  }

  // ---- F. API down
  {
    const { page } = await mk(small, { down: true }, { gapMs: 1 });
    await go(page); await page.waitForSelector('#error:not([hidden])', { timeout: 15000 });
    ok('F1 API down -> clear error, no crash', /reach Bluesky/i.test(await page.locator('#error').innerText()), await page.locator('#error').innerText());
    await page.close();
  }

  // ---- G. ceiling
  {
    const { page } = await mk(big, { delay: 2 }, { cap: 600, more: 600, ceiling: 1200, gapMs: 2 });
    await go(page); await page.waitForSelector('#capbar:not([hidden])', { timeout: 60000 });
    await page.click('#moreBtn'); await page.waitForFunction(() => !document.querySelector('#capbar').hidden && document.querySelector('#progress').hidden, null, { timeout: 60000 });
    await page.waitForTimeout(300);
    ok('G1 ceiling reached: limit message, no more button', /limit/.test(await page.locator('#captext').innerText()) && await page.locator('#moreBtn').isHidden(), await page.locator('#captext').innerText());
    ok('G2 ceiling respected', (await nodeCount(page)) === 1200, 'rendered ' + await nodeCount(page));
    await page.close();
  }

  // ---- H. XSS
  {
    const { page } = await mk(buildTree(60, 9), { xss: true }, { gapMs: 1 });
    await go(page); await page.waitForFunction(() => document.querySelector('#progress').hidden && document.querySelectorAll('#tree .node').length > 40, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => ({ pwn: window.__pwn, scripts: document.querySelectorAll('#tree script, #rootcard script').length, js: document.querySelectorAll('[src^="javascript" i],[href^="javascript" i]').length,
      hasText: document.body.innerText.includes('<img src=x onerror'), hasHandle: document.body.innerText.includes('"><script>') }));
    ok('H1 hostile text/handles/alt/URLs never execute', r.pwn === undefined && r.scripts === 0 && r.js === 0, JSON.stringify(r));
    ok('H2 hostile strings are shown as inert text', r.hasText && r.hasHandle);
    await page.close();
  }

  // ---- J. deep link, hash, theme, phone, dark
  {
    const { page } = await mk(buildTree(400, 11), {}, { gapMs: 1 });
    await page.goto(BASE + '?post=' + encodeURIComponent(ROOT) + '#r57');
    await page.waitForFunction(() => document.querySelector('#progress').hidden && document.querySelectorAll('#tree .node').length >= 399, null, { timeout: 20000 });
    ok('J1 ?post= link auto-starts the trace', (await nodeCount(page)) === 399);
    await page.waitForTimeout(600);
    ok('J2 #key deep link scrolls to and flashes the quote', await page.evaluate(() => !!document.querySelector('#n57 .card.flash')));
    await page.click('#themeToggle'); await page.reload();
    ok('J3 theme persists across reload', await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'dark');
    await page.waitForFunction(() => document.querySelectorAll('#tree .node').length >= 399, null, { timeout: 20000 });
    await page.screenshot({ path: 'tr-dark.png' });
    await page.close();
    const { page: ph } = await mk(buildTree(400, 11), {}, { gapMs: 1 }, { width: 390, height: 800 });
    await go(ph); await ph.waitForFunction(() => document.querySelectorAll('#tree .node').length >= 399, null, { timeout: 20000 });
    await ph.screenshot({ path: 'tr-phone.png' });
    ok('J4 phone width: no horizontal overflow', await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  }
  console.log(out.join('\n'));
  console.log('JS errors:', errors.length ? errors.join(' | ') : 'none');
  await browser.close();
})().catch(e => { console.log(out.join('\n')); console.log('TEST CRASH', e); process.exit(1) });
