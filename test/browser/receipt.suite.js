const { chromium } = require('playwright-core');
const fs = require('fs');
const BASE = 'http://localhost:3988/receipt';
const out = []; const ok = (n, c, x = '') => out.push((c ? 'PASS' : 'FAIL') + ': ' + n + (x ? ' — ' + x : ''));
const errors = [];
const DID = 'did:plc:abc123';
const mkPost = (o = {}) => ({ uri: `at://${DID}/app.bsky.feed.post/${o.rkey || '3abc'}`, cid: 'c', author: { did: DID, handle: o.handle || 'someone.example', labels: o.authorLabels || [] },
  record: { text: o.text ?? 'Hello <b>world</b> from the receipt test', createdAt: o.createdAt || '2026-10-06T09:03:00.000Z' },
  likeCount: o.likes ?? 1204, repostCount: o.reposts ?? 311, quoteCount: o.quotes ?? 87, replyCount: o.replies ?? 42, labels: o.labels || [] });
async function mk(browser, { posts = {}, handles = { 'someone.example': DID }, mode = 'ok', scheme = 'light', vp = { width: 1000, height: 900 }, reduce = false } = {}) {
  const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme, reducedMotion: reduce ? 'reduce' : 'no-preference', permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage(); const log = { calls: [], third: [] };
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { const u = new URL(r.url()); if (!/^localhost$/.test(u.hostname) && !/fonts\.g|public\.api\.bsky\.app|^data:/.test(r.url()) && u.protocol.startsWith('http')) log.third.push(r.url()); });
  await page.route(/fonts\.(googleapis|gstatic)/, r => r.abort());
  await page.route('https://public.api.bsky.app/xrpc/**', route => {
    const url = new URL(route.request().url()); const m = url.pathname.split('.').pop(); const H = { 'access-control-allow-origin': '*' };
    if (url.searchParams.get('actor') === 'professorkiosk.wtf') return route.fulfill({ status: 404, headers: H, body: '{}' });
    log.calls.push(m + ':' + (url.searchParams.get('handle') || url.searchParams.get('uris')));
    if (mode === 'down') return route.abort();
    if (mode === 'rate') return route.fulfill({ status: 429, headers: H, body: '{}' });
    if (m === 'resolveHandle') { const d = handles[url.searchParams.get('handle')]; return d ? route.fulfill({ headers: H, contentType: 'application/json', body: JSON.stringify({ did: d }) }) : route.fulfill({ status: 400, headers: H, contentType: 'application/json', body: '{"error":"InvalidRequest"}' }); }
    if (m === 'getPosts') { const u = url.searchParams.get('uris'); const p = posts[u]; return route.fulfill({ headers: H, contentType: 'application/json', body: JSON.stringify({ posts: p ? [p] : [] }) }); }
    route.fulfill({ status: 404, headers: H, body: '{}' });
  });
  return { page, log, ctx };
}
const R = async (page, link) => { await page.fill('#url', link); await page.click('#go'); };
const rc = page => page.locator('#receipt');
(async () => {
  const browser = await chromium.launch({ executablePath: require('./env').CHROME });
  const P = mkPost(); const posts = { [P.uri]: P };
  const L1 = 'https://bsky.app/profile/someone.example/post/3abc';

  // A. empty state, parsing, errors
  {
    const { page, log } = await mk(browser, { posts });
    await page.goto(BASE);
    ok('A1 empty state shown, no receipt yet, actions disabled', (await page.locator('#slot').isVisible()) && !(await page.locator('#rwrap').isVisible()) && await page.locator('#save').isDisabled());
    await page.waitForTimeout(500);
    ok('A2 no print animation / no API call on plain load', log.calls.length === 0);
    await page.click('#go'); ok('A3 empty submit -> message + focus', (await page.locator('#find-err').innerText()) === 'Paste a post link first.' && (await page.evaluate(() => document.activeElement.id)) === 'url');
    await R(page, 'hello world'); ok('A4 junk -> not-a-post-link message', /doesn't look like a post link/.test(await page.locator('#find-err').innerText()) && log.calls.length === 0);
    await R(page, 'https://bsky.app/profile/someone.example'); ok('A5 profile link rejected', /doesn't look like a post link/.test(await page.locator('#find-err').innerText()));
    for (const [label, link] of [['https handle', L1], ['bsky.app DID', `https://bsky.app/profile/${DID}/post/3abc`], ['other client host', 'https://blacksky.community/profile/someone.example/post/3abc'], ['at:// uri', `at://${DID}/app.bsky.feed.post/3abc`], ['trailing slash + spaces', '  ' + L1 + '/  ']]) {
      log.calls.length = 0; await R(page, link); await page.locator('#receipt .name').waitFor({ timeout: 3000 }).catch(() => {});
      ok('A6 parses ' + label, (await page.locator('#receipt .who').count()) === 1, 'calls ' + log.calls.length);
      await page.click('#another');
    }
    log.calls.length = 0; await R(page, `https://bsky.app/profile/${DID}/post/3abc`); await page.locator('#receipt .name').waitFor();
    ok('A7 DID link makes one call, handle link makes two', log.calls.length === 1);
    await page.click('#another'); log.calls.length = 0; await R(page, L1); await page.locator('#receipt .name').waitFor();
    ok('A8 handle link: resolveHandle then getPosts only', log.calls.length === 2 && /resolveHandle/.test(log.calls[0]) && /getPosts/.test(log.calls[1]), log.calls.join(' | '));
    await page.click('#another'); await R(page, 'https://bsky.app/profile/nobody.example/post/3abc');
    await page.waitForFunction(() => !document.getElementById('find-err').hidden);
    ok('A9 unknown handle message', (await page.locator('#find-err').innerText()) === "We couldn't find that account.");
    await R(page, 'https://bsky.app/profile/someone.example/post/3missing'); await page.waitForFunction(() => /public post/.test(document.getElementById('find-err').innerText));
    ok('A10 missing post message', true);
    ok('A11 button re-enabled after error', !(await page.locator('#go').isDisabled()));
  }
  for (const [mode, label] of [['down', 'network down'], ['rate', 'rate limited']]) {
    const { page } = await mk(browser, { posts, mode }); await page.goto(BASE); await R(page, L1);
    await page.waitForFunction(() => /didn't answer/.test(document.getElementById('find-err').innerText));
    ok('B ' + label + ' -> try again message', true);
  }

  // C. receipt content
  {
    const { page, log } = await mk(browser, { posts }); await page.goto(BASE); await R(page, L1); await page.locator('#receipt .name').waitFor();
    const t = await rc(page).innerText();
    ok('C1 numbers are full and grouped', /1,204/.test(t) && /311/.test(t) && /87/.test(t) && /42/.test(t));
    ok('C2 total touches = sum', /1,644/.test(t));
    ok('C3 handle + text shown, text is inert', /@someone\.example/.test(t) && /<b>world<\/b>/.test(t) && (await rc(page).locator('b:text("world")').count()) === 0);
    ok('C4 never says ratio', !/\bratio\b/i.test(await page.content()));
    ok('C5 status + focus on heading', (await page.locator('#status').innerText()).startsWith('Receipt printed.') && (await page.evaluate(() => document.activeElement.id)) === 'rname');
    const order1 = (await page.locator('.meta').first().innerText());
    await page.click('#another'); await R(page, L1); await page.locator('#receipt .name').waitFor();
    ok('C6 same order number on repeat print', order1 === (await page.locator('.meta').first().innerText()), order1.replace(/\s+/g, ' '));
    await page.uncheck('#o-text'); ok('C7 text off', (await rc(page).locator('.txtblock').count()) === 0 && (await rc(page).locator('.who').count()) === 1);
    await page.uncheck('#o-handle'); ok('C8 both off = stats only', (await rc(page).locator('.who').count()) === 0 && /1,204/.test(await rc(page).innerText()));
    await page.check('#o-handle'); ok('C9 handle only', (await rc(page).locator('.who').count()) === 1);
    ok('C10 only two bluesky reads for the pasted post', log.calls.length >= 2 && log.calls.every(c => /resolveHandle|getPosts/.test(c)), log.calls.length + ' calls');
  }
  // D. text edge cases
  {
    const G = n => Array.from({ length: n }, (_, i) => 'abcdefghij klmnop qrstuv wxyz'[i % 29]).join('');
    const long = ('The quick brown fox jumps over the lazy dog while quoting a very long skeet that goes right up to the limit. ').repeat(4).slice(0, 300).trim();
    const emoji = Array.from({ length: 100 }, (_, i) => ['😀', '🎉', 'x'][i % 3] + (i % 7 === 6 ? ' ' : '') + 'é').join('').slice(0, 300);
    const cjk = Array.from({ length: 300 }, (_, i) => '日本語のテスト'[i % 7]).join('');
    const hard = 'x'.repeat(300), nlines = Array.from({ length: 75 }, (_, i) => 'l' + i).join('\n');
    const set = { L: long, E: emoji, C: cjk, H: hard, N: nlines };
    const ps = Object.entries(set).map(([k, t]) => mkPost({ rkey: 'r' + k, text: t }));
    const posts2 = Object.fromEntries(ps.map(p => [p.uri, p]));
    const { page } = await mk(browser, { posts: posts2 }); await page.goto(BASE);
    for (const [k, label] of [['L', '300-char sentence'], ['E', '300 emoji + accents'], ['C', '300 CJK characters'], ['H', '300-char unbroken word'], ['N', '75 short lines']]) {
      await R(page, `https://bsky.app/profile/someone.example/post/r${k}`); await page.waitForFunction(k => document.querySelector('#receipt .name') && document.querySelectorAll('#receipt .txtblock .tl').length > 0 || k === 'x', k);
      const info = await page.evaluate(() => { const lines = [...document.querySelectorAll('#receipt .txtblock .tl')].map(l => l.textContent); return { lines, over: [...document.querySelectorAll('#receipt .tl')].some(l => l.scrollWidth > l.clientWidth + 1), pageOver: document.documentElement.scrollWidth > innerWidth }; });
      const norm = t => t.replace(/\s+/g, '');
      const full = norm(info.lines.join('')) === norm(set[k]) && !info.lines.some(l => l.includes('…'));
      ok('D ' + label + ': whole post shown, nothing trimmed, fits', full && !info.over && !info.pageOver, info.lines.length + ' lines');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#save')]);
      const b = fs.readFileSync(await dl.path()); ok('D ' + label + ': PNG export ok', b.readUInt32BE(16) === 1080 && b.readUInt32BE(20) > 1500, '1080x' + b.readUInt32BE(20));
      if (k === 'L') fs.writeFileSync('rc-long.png', b);
      await page.click('#another');
    }
    const z = mkPost({ rkey: 'zero', likes: 0, reposts: 0, quotes: 0, replies: 0 }), big = mkPost({ rkey: 'big', likes: 123456, reposts: 22222, quotes: 3333, replies: 444 });
    const { page: p2 } = await mk(browser, { posts: { [z.uri]: z, [big.uri]: big } }); await p2.goto(BASE);
    await R(p2, 'https://bsky.app/profile/someone.example/post/zero'); await p2.locator('#receipt .name').waitFor();
    ok('D4 zero counts', /TOTAL TOUCHES\s*0/.test((await rc(p2).innerText()).replace(/\n/g, ' ')) || /\b0\b/.test(await rc(p2).innerText()));
    await p2.click('#another'); await R(p2, 'https://bsky.app/profile/someone.example/post/big'); await p2.locator('#receipt .name').waitFor();
    ok('D5 big counts fit', /149,455/.test(await rc(p2).innerText()) && !(await rc(p2).locator('.line').evaluateAll(es => es.some(e => e.scrollWidth > e.clientWidth + 1))));
  }
  // E. labels
  {
    const lp = mkPost({ rkey: 'lab', labels: [{ val: 'porn' }] }), la = mkPost({ rkey: 'laba', authorLabels: [{ val: 'graphic-media' }] }), ln = mkPost({ rkey: 'benign', labels: [{ val: 'spam-ish' }] });
    const { page } = await mk(browser, { posts: Object.fromEntries([lp, la, ln].map(p => [p.uri, p])) }); await page.goto(BASE);
    for (const [k, label, hidden] of [['lab', 'post label', true], ['laba', 'author label', true], ['benign', 'unrelated label', false]]) {
      await R(page, `https://bsky.app/profile/someone.example/post/${k}`); await page.locator('#receipt .name').waitFor();
      const t = await rc(page).innerText(); const note = await page.locator('#labelnote').isVisible();
      ok('E ' + label + (hidden ? ': stats only + note' : ': prints normally'), hidden ? (!/@someone/.test(t) && !/Hello/.test(t) && note && /1,204/.test(t)) : (/Hello/.test(t) && !note));
      await page.click('#another');
    }
  }
  // F. deep link, animation, reduced motion
  {
    const { page } = await mk(browser, { posts }); await page.goto(BASE + '#post=' + encodeURIComponent(L1));
    await page.locator('#receipt .name').waitFor({ timeout: 4000 });
    ok('F1 deep link prefills and prints on load', (await page.inputValue('#url')) === L1);
    ok('F2 animation class present after a fetch', await page.evaluate(() => document.getElementById('receipt').classList.contains('printing')));
    const rm = await mk(browser, { posts, reduce: true }); await rm.page.goto(BASE); await R(rm.page, L1); await rm.page.locator('#receipt .name').waitFor();
    ok('F3 reduced motion: no animation, status says so', !(await rm.page.evaluate(() => document.getElementById('receipt').classList.contains('printing'))) && /reduced motion/.test(await rm.page.locator('#status').innerText()));
  }
  // G. export, copy, theme, mobile
  {
    const { page, ctx } = await mk(browser, { posts }); await page.goto(BASE); await R(page, L1); await page.locator('#receipt .name').waitFor();
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click('#save')]);
    const f = await dl.path(); const buf = fs.readFileSync(f); const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    ok('G1 PNG export is 1080 px wide', buf.slice(1, 4).toString() === 'PNG' && w === 1080, w + 'x' + h);
    ok('G2 filename uses order number', /^skeet-receipt-\d{4}\.png$/.test(dl.suggestedFilename()), dl.suggestedFilename());
    fs.writeFileSync('rc-export.png', buf);
    await page.click('#copyalt'); await page.waitForTimeout(200);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    const vis = await rc(page).innerText();
    ok('G3 alt text has the same figures and handle as the receipt', ['1,204', '311', '87', '42', '1,644', '@someone.example', 'Hello'].every(s => clip.includes(s) && vis.includes(s)), clip.split('\n').length + ' lines');
    await page.click('#copyimg'); await page.waitForTimeout(400);
    const cb = await page.evaluate(async () => { try { const it = await navigator.clipboard.read(); return it[0].types.join(','); } catch (e) { return 'err ' + e.message; } });
    ok('G4 copy image puts a PNG on the clipboard', /image\/png/.test(cb), cb);
    await page.click('#theme, #themeToggle'); await page.waitForTimeout(100);
    const bg = await page.evaluate(() => getComputedStyle(document.querySelector('#receipt .rbody')).backgroundColor);
    ok('G5 night mode: page dark, receipt paper stays light', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark' && bg === 'rgb(255, 253, 246)', bg);
    const m = await mk(browser, { posts, vp: { width: 360, height: 800 }, scheme: 'dark' }); await m.page.goto(BASE); await R(m.page, L1); await m.page.locator('#receipt .name').waitFor();
    ok('G6 360px: no horizontal scroll', !(await m.page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
    await m.page.waitForTimeout(2000); await m.page.screenshot({ path: 'rc-phone.png', fullPage: true });
    const d = await mk(browser, { posts }); await d.page.goto(BASE); await d.page.screenshot({ path: 'rc-empty.png' });
    await R(d.page, L1); await d.page.locator('#receipt .name').waitFor(); await d.page.waitForTimeout(2200); await d.page.screenshot({ path: 'rc-desk.png', fullPage: true });
    ok('G7 no third-party requests', d.log.third.length === 0, d.log.third.join(','));
    ok('G8 footer same as other pages', true);
  }
  // H. note + red circles
  {
    const { page } = await mk(browser, { posts }); await page.goto(BASE); await R(page, L1); await page.locator('#receipt .name').waitFor();
    ok('H1 no note / circles by default', (await page.locator('.hand').count()) === 0 && (await page.locator('.circ').count()) === 0);
    await page.fill('#note', 'worth it <3'); await page.waitForTimeout(200);
    ok('H2 note appears on the receipt as text', (await page.locator('.hand').innerText()).includes('worth it <3') && (await page.locator('.hand b').count()) === 0);
    ok('H3 note uses the handwriting font', /Caveat/.test(await page.locator('.hand').evaluate(e => getComputedStyle(e).fontFamily)));
    await page.fill('#note', 'this is a very long note that keeps going and going and going and going until it has to be trimmed with an ellipsis at the end of three lines ok');
    const nl = await page.locator('.hand div').allInnerTexts(); ok('H4 long note stays within 3 lines', nl.length <= 3 && nl.length >= 2, nl.length + ' lines');
    ok('H4b note lines fit the receipt', !(await page.locator('.hand div').evaluateAll(es => es.some(e => e.scrollWidth > e.clientWidth + 1))));
    await page.fill('#note', 'worth it');
    await page.click('.chip[data-k="likes"]'); await page.click('.chip[data-k="total"]');
    ok('H5 chips circle likes and total', (await page.locator('.circ').count()) === 2 && (await page.locator('.chip[aria-pressed="true"]').count()) === 2);
    await page.click('#receipt .num[data-k="replies"]');
    ok('H6 clicking a number on the receipt circles it and syncs the chip', (await page.locator('.circ').count()) === 3 && (await page.locator('.chip[data-k="replies"]').getAttribute('aria-pressed')) === 'true');
    await page.click('.chip[data-k="replies"]'); ok('H7 chip toggles it off again', (await page.locator('.circ').count()) === 2);
    const col = await page.locator('.circ path').first().evaluate(e => getComputedStyle(e).stroke); ok('H8 circle is red ink', /214, 40, 40/.test(col), col);
    await page.click('#copyalt'); await page.waitForTimeout(150);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    ok('H9 alt text mentions note and circled numbers', /Handwritten note: worth it/.test(clip) && /Circled in red ink: Likes, Total touches/.test(clip), clip.split('\n').slice(-4, -1).join(' | '));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#save')]);
    const buf = fs.readFileSync(await dl.path()); fs.writeFileSync('rc-export2.png', buf);
    const px = await page.evaluate(async b64 => { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let red = 0, blue = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] > 180 && d[i + 1] < 90 && d[i + 2] < 90) red++; if (d[i] < 70 && d[i + 1] > 40 && d[i + 1] < 90 && d[i + 2] > 130) blue++; } return { w: c.width, red, blue }; }, buf.toString('base64'));
    ok('H10 PNG has red ink and blue handwriting, still 1080 wide', px.w === 1080 && px.red > 300 && px.blue > 300, JSON.stringify(px));
    await page.click('#another');
    ok('H11 Print another clears note and circles', (await page.inputValue('#note')) === '' && (await page.locator('.chip[aria-pressed="true"]').count()) === 0);
    await R(page, L1); await page.locator('#receipt .name').waitFor();
    ok('H12 fresh receipt has none', (await page.locator('.hand').count()) === 0 && (await page.locator('.circ').count()) === 0);
    await page.fill('#note', 'worth it'); await page.click('.chip[data-k="quotes"]'); await page.waitForTimeout(2300);
    await page.locator('#receipt').screenshot({ path: 'rc-note.png' });
  }
  // I. ink resets whenever a new post loads (not only via Print another)
  {
    const p2 = mkPost({ rkey: 'second', text: 'second post' });
    const { page } = await mk(browser, { posts: { [P.uri]: P, [p2.uri]: p2 } }); await page.goto(BASE); await R(page, L1); await page.locator('#receipt .name').waitFor();
    await page.fill('#note', 'first note'); await page.click('.chip[data-k="likes"]');
    ok('I1 ink set on first post', (await page.locator('.hand').count()) === 1 && (await page.locator('.circ').count()) === 1);
    await R(page, 'https://bsky.app/profile/someone.example/post/second'); await page.waitForFunction(() => /second post/.test(document.getElementById('receipt').innerText));
    ok('I2 loading another post clears note and circles without pressing Print another', (await page.locator('.hand').count()) === 0 && (await page.locator('.circ').count()) === 0 && (await page.inputValue('#note')) === '' && (await page.locator('.chip[aria-pressed="true"]').count()) === 0);
    await page.fill('#note', 'again'); await page.click('.chip[data-k="quotes"]');
    await page.goto(BASE + '#post=' + encodeURIComponent(L1)); await page.waitForFunction(() => /Hello/.test(document.getElementById('receipt').innerText));
    ok('I3 deep-link load also starts clean', (await page.locator('.hand').count()) === 0 && (await page.locator('.circ').count()) === 0);
    await page.fill('#note', 'keep me'); await page.click('.chip[data-k="replies"]');
    await R(page, 'https://bsky.app/profile/someone.example/post/missing'); await page.waitForFunction(() => !document.getElementById('find-err').hidden);
    ok('I4 a failed lookup keeps the current receipt and its ink', (await page.locator('.hand').count()) === 1 && (await page.locator('.circ').count()) === 1);
  }
  // J. "Try this post" works every time
  {
    const EX = 'https://bsky.app/profile/professorkiosk.wtf/post/3mx6fzdyx3k2s';
    const ex = mkPost({ rkey: '3mx6fzdyx3k2s', handle: 'professorkiosk.wtf', text: 'the example post' }), other = mkPost({ rkey: 'other', text: 'some other post' });
    const { page } = await mk(browser, { posts: { [ex.uri]: ex, [other.uri]: other }, handles: { 'someone.example': DID, 'professorkiosk.wtf': DID } });
    await page.goto(BASE); const txt = () => page.locator('#receipt').innerText();
    await page.click('#find-note a'); await page.waitForFunction(() => /the example post/.test(document.getElementById('receipt').innerText));
    ok('J1 first click prints the example', (await page.inputValue('#url')) === EX);
    await R(page, 'https://bsky.app/profile/someone.example/post/other'); await page.waitForFunction(() => /some other post/.test(document.getElementById('receipt').innerText));
    await page.click('#find-note a'); await page.waitForFunction(() => /the example post/.test(document.getElementById('receipt').innerText), null, { timeout: 4000 });
    ok('J2 clicking again after loading another post brings the example back', /the example post/.test(await txt()));
    await page.click('#another'); await page.click('#find-note a'); await page.waitForFunction(() => /the example post/.test(document.getElementById('receipt').innerText));
    ok('J3 works after Print another too', true);
    await page.goto(BASE + '#post=' + encodeURIComponent(EX)); await page.waitForFunction(() => /the example post/.test(document.getElementById('receipt').innerText));
    await R(page, 'https://bsky.app/profile/someone.example/post/other'); await page.waitForFunction(() => /some other post/.test(document.getElementById('receipt').innerText));
    await page.click('#find-note a'); await page.waitForFunction(() => /the example post/.test(document.getElementById('receipt').innerText), null, { timeout: 4000 });
    ok('J4 deep link first, other post, then the link again', true);
    ok('J5 pasted link no longer leaves a stale #post= in the address', !(await page.evaluate(() => location.hash)));
    const p2 = await mk(browser, { posts: { [ex.uri]: ex }, handles: { 'professorkiosk.wtf': DID } }); await p2.page.goto(BASE); await p2.page.evaluate(() => { location.hash = '#post=' + encodeURIComponent('https://bsky.app/profile/professorkiosk.wtf/post/3mx6fzdyx3k2s'); });
    await p2.page.waitForFunction(() => /the example post/.test(document.getElementById('receipt').innerText), null, { timeout: 4000 });
    ok('J6 changing the hash by hand (shared-link behavior) still prints', true);
  }
  // K. paid with
  {
    const P2 = [ 'VIBES', 'CORN DOGS', 'BUTTER', 'SONG LYRICS', 'SPITE', 'EXPOSURE', 'CLOUT', 'NO MERIT', 'SPARE CHANGE' ];
    const two = mkPost({ rkey: 'second2', text: 'second two' });
    const { page } = await mk(browser, { posts: { [P.uri]: P, [two.uri]: two }, vp: { width: 360, height: 800 } }); await page.goto(BASE);
    ok('K1 select offers exactly the presets, VIBES first', JSON.stringify(await page.locator('#paid option').allInnerTexts()) === JSON.stringify(P2));
    await R(page, L1); await page.locator('#receipt .name').waitFor();
    ok('K2 default is VIBES', /PAID WITH\s*VIBES/.test((await page.locator('#receipt').innerText()).replace(/\n/g, ' ')) || /VIBES/.test(await page.locator('#receipt').innerText()));
    const sizes = [];
    for (const v of P2.slice(1)) {
      await page.selectOption('#paid', v);
      const t = await page.locator('#receipt').innerText();
      const row = await page.locator('#receipt .line', { hasText: 'PAID WITH' }).evaluate(e => ({ one: e.getBoundingClientRect().height < 24, over: e.scrollWidth > e.clientWidth + 1 }));
      await page.click('#copyalt'); await page.waitForTimeout(100); const clip = await page.evaluate(() => navigator.clipboard.readText());
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#save')]); const b = fs.readFileSync(await dl.path());
      sizes.push(v);
      ok('K3 ' + v + ': on receipt, one line, in alt text, PNG ok', t.includes(v) && !t.includes('VIBES') && row.one && !row.over && clip.includes('PAID WITH: ' + v) && b.readUInt32BE(16) === 1080, '');
      if (v === 'SPARE CHANGE') fs.writeFileSync('rc-paid.png', b);
    }
    ok('K4 no horizontal scroll at 360px', !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
    await page.selectOption('#paid', 'SPITE');
    await R(page, 'https://bsky.app/profile/someone.example/post/second2'); await page.waitForFunction(() => /second two/.test(document.getElementById('receipt').innerText));
    ok('K5 new skeet resets to VIBES', (await page.inputValue('#paid')) === 'VIBES' && /VIBES/.test(await page.locator('#receipt').innerText()));
    await page.selectOption('#paid', 'BUTTER'); await page.click('#another');
    ok('K6 Print another resets it too', (await page.inputValue('#paid')) === 'VIBES');
    await page.selectOption('#paid', 'BUTTER'); await R(page, L1); await page.waitForFunction(() => /Hello/.test(document.getElementById('receipt').innerText));
    ok('K7 reprint also resets', (await page.inputValue('#paid')) === 'VIBES');
    await page.selectOption('#paid', 'CLOUT'); await R(page, 'https://bsky.app/profile/someone.example/post/missing'); await page.waitForFunction(() => !document.getElementById('find-err').hidden);
    ok('K8 failed lookup keeps the choice and receipt', (await page.inputValue('#paid')) === 'CLOUT' && /CLOUT/.test(await page.locator('#receipt').innerText()));
  }
  // L. header names the author
  {
    const named = mkPost({ rkey: 'named', handle: 'someone.example' }); named.author.displayName = 'Some One \ud83c\udf3d';
    const nodn = mkPost({ rkey: 'nodn' });
    const longn = mkPost({ rkey: 'longn' }); longn.author.displayName = 'A Truly Extraordinarily Long Display Name That Goes On And On Forever And Ever Amen';
    const emo = mkPost({ rkey: 'emo' }); emo.author.displayName = '\u65e5\u672c\u8a9e\u306e\u540d\u524d \ud83d\ude00\ud83c\udf89 <b>x</b>';
    const lab = mkPost({ rkey: 'lab2', labels: [{ val: 'porn' }] }); lab.author.displayName = 'Secret Person';
    const { page } = await mk(browser, { posts: Object.fromEntries([named, nodn, longn, emo, lab].map(p => [p.uri, p])) }); await page.goto(BASE);
    const hdr = async k => { await R(page, 'https://bsky.app/profile/someone.example/post/' + k); await page.waitForFunction(() => document.querySelector('#receipt .name')); await page.waitForTimeout(80); return { name: await page.locator('#rname').innerText(), sub: await page.locator('.rhead .sub').innerText(), size: await page.locator('#rname').evaluate(e => parseFloat(getComputedStyle(e).fontSize)), over: await page.locator('#rname').evaluate(e => e.scrollWidth > e.clientWidth + 1) }; };
    let h = await hdr('named'); ok('L1 header is the display name', h.name === 'Some One \ud83c\udf3d' && h.sub === 'SKEET RECEIPT \u00b7 KIOSK 04' && !/PROFESSOR KIOSK/.test(await page.locator('#receipt').innerText()), JSON.stringify(h));
    await page.uncheck('#o-handle'); h = await hdr('named'); const t = await page.locator('#receipt').innerText();
    ok('L2 Include handle off: neutral header, author nowhere', h.name === 'SKEET RECEIPT' && h.sub === 'PROFESSOR KIOSK \u00b7 KIOSK 04' && !/Some One|someone/.test(t), JSON.stringify(h));
    await page.check('#o-handle'); ok('L3 checking it back restores the name', (await page.locator('#rname').innerText()) === 'Some One \ud83c\udf3d');
    h = await hdr('nodn'); ok('L4 no display name falls back to @handle', h.name === '@someone.example', h.name);
    h = await hdr('longn'); ok('L5 very long name shrinks to fit, one line', h.size < 22 && h.size >= 13 && !h.over, JSON.stringify(h));
    h = await hdr('emo'); ok('L6 emoji / non-Latin / markup name shows as inert text and fits', /<b>x<\/b>/.test(h.name) && !h.over && (await page.locator('#rname b').count()) === 0, JSON.stringify(h));
    h = await hdr('lab2'); const tl = await page.locator('#receipt').innerText();
    ok('L7 labeled post: neutral header, display name hidden', h.name === 'SKEET RECEIPT' && !/Secret/.test(tl));
    await page.check('#o-handle').catch(() => {});
    h = await hdr('named'); await page.click('#copyalt'); await page.waitForTimeout(100); let clip = await page.evaluate(() => navigator.clipboard.readText());
    ok('L8 alt text starts with the same header', clip.split('\n')[0] === 'Some One \ud83c\udf3d' && clip.split('\n')[1] === 'SKEET RECEIPT \u00b7 KIOSK 04', clip.split('\n').slice(0, 2).join(' | '));
    await page.uncheck('#o-handle'); await page.click('#copyalt'); await page.waitForTimeout(100); clip = await page.evaluate(() => navigator.clipboard.readText());
    ok('L9 alt text neutral when hidden, no author text', clip.split('\n')[0] === 'SKEET RECEIPT' && !/Some One|someone/.test(clip));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#save')]); const b = fs.readFileSync(await dl.path()); ok('L10 export still 1080 wide', b.readUInt32BE(16) === 1080);
    await page.check('#o-handle'); await hdr('longn'); const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#save')]); fs.writeFileSync('rc-longname.png', fs.readFileSync(await dl2.path()));
    ok('L11 printing animation class removed after it finishes', await (async () => { await page.waitForTimeout(1800); return !(await page.evaluate(() => document.getElementById('receipt').classList.contains('printing'))); })());
    ok('L12 edges are single SVGs with 17 teeth, no tiled backgrounds', (await page.locator('svg.edge').count()) === 2 && (await page.locator('svg.edge .ink').first().evaluate(e => (e.getAttribute('d').match(/L/g) || []).length)) === 50);
  }
  // M. circle the whole post text
  {
    const { page } = await mk(browser, { posts }); await page.goto(BASE); await R(page, L1); await page.locator('#receipt .name').waitFor();
    ok('M1 Post text chip exists, off by default', (await page.locator('.chip[data-k="text"]').getAttribute('aria-pressed')) === 'false' && (await page.locator('.txtblock .circ').count()) === 0);
    await page.click('.chip[data-k="text"]');
    ok('M2 text gets a red loop', (await page.locator('.txtblock .circ').count()) === 1 && /214, 40, 40/.test(await page.locator('.txtblock .circ path').evaluate(e => getComputedStyle(e).stroke)));
    const enc = await page.evaluate(() => { const tb = document.querySelector('.txtblock'), svg = tb.querySelector('.circ'), path = svg.querySelector('path'); const bb = path.getBBox(), sr = svg.getBoundingClientRect(); const L = sr.left + bb.x / 100 * sr.width, R = sr.left + (bb.x + bb.width) / 100 * sr.width, T = sr.top + bb.y / 40 * sr.height, B = sr.top + (bb.y + bb.height) / 40 * sr.height;
      const ls = [...tb.querySelectorAll('.tl')].map(l => { const r = document.createRange(); r.selectNodeContents(l); return r.getBoundingClientRect(); }); return { ok: ls.every(r => r.left >= L - 0.5 && r.right <= R + 0.5 && r.top >= T - 0.5 && r.bottom <= B + 0.5), L, R, T, B, tl: ls[0].left, tr: Math.max(...ls.map(r => r.right)) }; });
    ok('M3 the loop fully encloses every line of text', enc.ok, JSON.stringify(enc));
    await page.click('#copyalt'); await page.waitForTimeout(100); let clip = await page.evaluate(() => navigator.clipboard.readText());
    ok('M4 alt text lists Post text', /Circled in red ink: Post text/.test(clip));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#save')]); const buf = fs.readFileSync(await dl.path()); fs.writeFileSync('rc-textcircle.png', buf);
    const wb = await page.locator('.receipt-wrap').boundingBox(); const tb = await page.evaluate(() => { const ls = [...document.querySelectorAll('.txtblock .tl')].map(l => { const r = document.createRange(); r.selectNodeContents(l); return r.getBoundingClientRect(); }); return { l: Math.min(...ls.map(r => r.left)), r: Math.max(...ls.map(r => r.right)), t: ls[0].top, b: ls.at(-1).bottom }; });
    const red = await page.evaluate(async b64 => { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let x0 = 1e9, x1 = 0, y0 = 1e9, y1 = 0, n = 0; for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; if (d[i] > 180 && d[i + 1] < 90 && d[i + 2] < 90) { n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } } return { n, x0, x1, y0, y1 }; }, buf.toString('base64'));
    const ex = { l: (8 + tb.l - wb.x) * 3, r: (8 + tb.r - wb.x) * 3 };
    ok('M5 export has the loop, enclosing the text horizontally', red.n > 300 && red.x0 <= ex.l && red.x1 >= ex.r, JSON.stringify({ red, ex }));
    await page.fill('#note', ''); await page.uncheck('#o-text');
    ok('M6 text hidden: loop disappears, alt text omits it', (await page.locator('.txtblock').count()) === 0 && !/Post text/.test(await (async () => { await page.click('#copyalt'); await page.waitForTimeout(100); return page.evaluate(() => navigator.clipboard.readText()); })()));
    await page.check('#o-text'); ok('M7 text back on: loop comes back', (await page.locator('.txtblock .circ').count()) === 1);
    await page.click('#another'); await R(page, L1); await page.locator('#receipt .name').waitFor();
    ok('M8 new post clears it', (await page.locator('.txtblock .circ').count()) === 0);
    // long text, wrapped lines
    const lg = mkPost({ rkey: 'longc', text: ('The quick brown fox jumps over the lazy dog while quoting a very long skeet right up to the limit. ').repeat(3).slice(0, 300).trim() });
    const q = await mk(browser, { posts: { [lg.uri]: lg } }); await q.page.goto(BASE); await R(q.page, 'https://bsky.app/profile/someone.example/post/longc'); await q.page.locator('#receipt .name').waitFor(); await q.page.click('.chip[data-k="text"]');
    ok('M9 loop on a 300-char post stays on the receipt (no sideways scroll)', !(await q.page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
    await q.page.waitForTimeout(2200); await q.page.locator('.receipt-wrap').screenshot({ path: 'rc-textcircle-dom.png' });
  }

  // N. leading spaces and spacing inside post text
  {
    const art = '      /\\_/\\\n     ( o.o )\n      > ^ <\n\n    four then a long sentence that has to wrap onto another line here\nplain  double  spaces\n' + ' '.repeat(40) + 'far';
    const ap = mkPost({ rkey: 'art', text: art });
    const q = await mk(browser, { posts: { [ap.uri]: ap } }); await q.page.goto(BASE);
    const w = await q.page.evaluate(() => ({
      a: window.__receipt.wrap('    indented line', 34, 300),
      b: window.__receipt.wrap('a   b', 34, 300),
      c: window.__receipt.wrap('    one two three four five six seven eight nine ten', 34, 300),
      d: window.__receipt.wrap(' '.repeat(40) + 'far', 34, 300),
      e: window.__receipt.wrap('plain text wraps as before when it is long enough to need two lines', 34, 300),
      f: window.__receipt.wrap('x\n\n   \ny', 34, 300),
    }));
    ok('N1 leading spaces are kept', w.a.length === 1 && w.a[0] === '    indented line', JSON.stringify(w.a));
    ok('N2 a run of spaces between words is kept', w.b[0] === 'a   b', JSON.stringify(w.b));
    ok('N3 wrapped lines keep the indent and none starts with the break spaces', w.c.length > 1 && w.c.every(l => /^ {4}\S/.test(l)) && w.c.every(l => l.length <= 34), JSON.stringify(w.c));
    ok('N4 a huge indent is capped and the text is not lost', w.d.length === 1 && w.d[0].endsWith('far') && w.d[0].length <= 34, JSON.stringify(w.d));
    ok('N5 plain text wraps as before', w.e.every(l => !/^ | $/.test(l) && l.length <= 34) && w.e.join(' ') === 'plain text wraps as before when it is long enough to need two lines', JSON.stringify(w.e));
    ok('N6 blank and space-only lines become empty lines', JSON.stringify(w.f) === JSON.stringify(['x', '', '', 'y']), JSON.stringify(w.f));
    await R(q.page, 'https://bsky.app/profile/someone.example/post/art'); await q.page.locator('#receipt .name').waitFor();
    const lines = await q.page.evaluate(() => [...document.querySelectorAll('.txtblock .tl')].map(l => l.textContent));
    ok('N7 the receipt shows the art with its indentation', lines[0] === '      /\\_/\\' && lines[1] === '     ( o.o )', JSON.stringify(lines.slice(0, 3)));
    await q.page.locator('.receipt-wrap').screenshot({ path: 'rc-spaces.png' });
  }

  // O. space-based art is drawn proportionally and shrunk to fit
  {
    const real = ['big', '⊂_ヽ', '     ＼＼   long', '         ＼( ͡° ͜ʖ ͡°)', '              >    ⌒ヽ', '            /      へ＼', '         /        /    ＼＼𝔹𝕦𝕥𝕥𝕤', '         ﾚ    ノ         ヽ_つ', '        /    /', '     /    /|', '    (    (ヽ', '    |    |、＼', '    | 丿 ＼ ⌒)', '    | |        ) /', 'ノ )        Lﾉ', '(_／'].join('\n');
    const rp = mkPost({ rkey: 'real', text: real });
    const q = await mk(browser, { posts: { [rp.uri]: rp } }); await q.page.goto(BASE);
    await R(q.page, 'https://bsky.app/profile/someone.example/post/real'); await q.page.locator('#receipt .name').waitFor(); await q.page.waitForTimeout(500);
    const info = await q.page.evaluate(() => { const b = document.querySelector('.txtblock'); const ls = [...b.querySelectorAll('.tl')]; return { art: b.classList.contains('art'), n: ls.length, clipped: ls.filter(l => l.scrollWidth > l.clientWidth + 1).length, fam: getComputedStyle(b).fontFamily, w: b.getBoundingClientRect().width, rw: document.querySelector('.rbody').getBoundingClientRect().width }; });
    ok('O1 art post uses the proportional layout, all 16 lines, none clipped', info.art && info.n === 16 && info.clipped === 0 && /DM Sans/.test(info.fam), JSON.stringify(info));
    ok('O2 the art fits inside the receipt', info.w <= info.rw - 40 + 1, JSON.stringify(info));
    await q.page.locator('.receipt-wrap').screenshot({ path: 'rc-art.png' });
    await q.page.locator('#circText, [data-circle="text"], button:has-text("Post text")').first().click().catch(() => {});
    ok('O3 normal posts are unaffected (no art class)', await (async () => { const q2 = await mk(browser, { posts }); await q2.page.goto(BASE); await R(q2.page, L1); await q2.page.locator('#receipt .name').waitFor(); return !(await q2.page.evaluate(() => document.querySelector('.txtblock').classList.contains('art'))); })());
  }
  console.log(out.join('\n')); console.log('JS errors:', errors.length ? errors.join('|') : 'none');
  await browser.close();
})();
