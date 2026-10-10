const { chromium } = require('playwright-core');
const BASE = 'http://localhost:3988/mashup';
const out = [], errors = [], third = [];
const ok = (n, c, x = '') => out.push((c ? 'PASS' : 'FAIL') + ': ' + n + (x ? ' — ' + x : ''));
async function mk(browser, { vp = { width: 1100, height: 900 }, reduce = true, scheme = 'light', init = null } = {}) {
  const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme, reducedMotion: reduce ? 'reduce' : 'no-preference', acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { const u = new URL(r.url()); if (u.protocol.startsWith('http') && u.hostname !== 'localhost' && !/public\.api\.bsky\.app/.test(u.hostname)) third.push(r.url()); });
  await page.route(/fonts\.(googleapis|gstatic)/, r => r.abort());
  await page.route('https://public.api.bsky.app/**', r => r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
  if (init) await page.addInitScript(([k, v]) => { try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem(k, v); sessionStorage.setItem('seeded', '1'); } } catch (e) {} }, init);
  return page;
}
const cards = page => page.evaluate(() => [...document.querySelectorAll('#cards .card')].map(c => ({ text: c.querySelector('.big').textContent, tag: c.querySelector('.tag').textContent })));
// roll many times with given dials, returning results as plain data
const many = (page, set, n = 80) => page.evaluate(([set, n]) => { const S = window.__mashup.state(); Object.assign(S, set); S.cards = []; const out = []; for (let i = 0; i < n; i++) { S.cards = []; out.push(window.__mashup.roll().map(c => ({ text: c.text, cat: c.cat }))); } return out; }, [set, n]);
(async () => {
  const browser = await chromium.launch({ executablePath: require('./env').CHROME });
  const page = await mk(browser); await page.goto(BASE);

  // A. data
  const d = await page.evaluate(() => { const D = window.__mashup.data, names = D.POOL.map(t => t.text.toLowerCase()); return { n: D.POOL.length, cats: Object.keys(D.CATS).length - 1, dup: names.length - new Set(names).size, long: D.POOL.filter(t => t.text.length > 40 || !t.text).length, nocat: D.POOL.filter(t => !D.CATS[t.cat]).length, spicy: D.POOL.filter(t => t.spicy).length, oddBad: Object.keys(D.ODD).filter(k => !D.CATS[k]).length, per: Object.keys(D.CATS).filter(k => k !== 'yours').map(k => D.POOL.filter(t => t.cat === k).length) }; });
  ok('A1 about 600 topics in 20 categories', d.n >= 580 && d.n <= 620 && d.cats === 20, JSON.stringify([d.n, d.cats]));
  ok('A2 no duplicates, empties, over-long topics, or unknown categories', d.dup === 0 && d.long === 0 && d.nocat === 0 && d.oddBad === 0, JSON.stringify(d));
  ok('A3 every category has at least 25 topics, and some are spicy', d.per.every(x => x >= 25) && d.spicy >= 15, d.spicy + ' spicy');

  // B. modes and cards
  await page.waitForSelector('#cards .card');
  ok('B1 starts in Mashup with two topic cards', (await cards(page)).length === 2 && await page.locator('#dials').isVisible());
  await page.click('#m-rand'); await page.waitForTimeout(100);
  ok('B2 Randomize shows one card and hides the dials', (await cards(page)).length === 1 && await page.locator('#dials').isHidden() && await page.locator('.lock').count() === 0);
  await page.click('#m-mash'); await page.waitForTimeout(100);
  ok('B3 back to Mashup shows two cards again', (await cards(page)).length >= 2 && await page.locator('#dials').isVisible());

  // C. dials
  const stat = async set => page.evaluate(([set]) => { const S = window.__mashup.state(), M = window.__mashup; Object.assign(S, set); let same = 0, total = 0, sum = 0, three = 0, rep = 0, odd = 0; const N = 150;
    for (let i = 0; i < N; i++) { S.cards = []; const r = M.roll(); if (r.length === 3) three++; if (new Set(r.map(c => c.text.toLowerCase())).size !== r.length) rep++; if (r.length > 1) { total++; const dd = M.cdist(r[0].cat, r[1].cat); sum += dd; if (r[0].cat === r[1].cat) same++; if (M.data.ODD[r[0].cat] && M.data.ODD[r[0].cat][r[1].cat]) odd++; } }
    return { same: same / total, avg: sum / total, three: three / N, rep, odd: odd / total }; }, [set]);
  const close = await stat({ mode: 'mashup', dist: 0, weird: 0, spicy: true, mine: true });
  const mid = await stat({ mode: 'mashup', dist: 50, weird: 0 });
  const far = await stat({ mode: 'mashup', dist: 100, weird: 0 });
  ok('C1 Distance 0 almost always pairs topics from the same category', close.same > 0.85, JSON.stringify(close));
  ok('C2 Distance rises monotonically (close < middle < far)', close.avg < mid.avg && mid.avg < far.avg && far.avg > close.avg + 3, [close.avg, mid.avg, far.avg].map(x => x.toFixed(2)).join(' < '));
  ok('C3 Distance 100 never pairs from the same category', far.same < 0.02, JSON.stringify(far));
  const w0 = await stat({ dist: 50, weird: 0 }), w100 = await stat({ dist: 50, weird: 100 }), w70 = await stat({ dist: 50, weird: 70 }), w80d0 = await stat({ dist: 0, weird: 80 });
  ok('C4 Weirdness 0 never adds a third topic, 100 always does', w0.three === 0 && w100.three === 1, JSON.stringify([w0.three, w100.three]));
  ok('C5 in between, a third topic sometimes joins', w70.three > 0.05 && w70.three < 0.95, String(w70.three));
  ok('C6 odd pairing rules kick in as Weirdness rises (even with Distance at 0)', w80d0.odd > 0.4 && w0.odd < 0.4, JSON.stringify([w80d0.odd, w0.odd]));
  ok('C7 a result never repeats a topic', w0.rep + w100.rep + far.rep + close.rep === 0);

  // D. spicy and own topics
  const sp = await page.evaluate(() => { const S = window.__mashup.state(); S.spicy = false; const bad = window.__mashup.pool().filter(t => t.spicy).length; let seen = 0; for (let i = 0; i < 200; i++) { S.cards = []; seen += window.__mashup.roll().filter(c => window.__mashup.data.POOL.find(t => t.text === c.text && t.spicy)).length; } S.spicy = true; return { bad, seen }; });
  ok('D1 Spicy off never shows a spicy topic', sp.bad === 0 && sp.seen === 0, JSON.stringify(sp));
  await page.fill('#own', 'Pickle Ball Nonsense'); await page.press('#own', 'Enter');
  ok('D2 a topic can be added to My topics', await page.locator('#ownlist .chip').count() === 1);
  await page.reload(); await page.waitForSelector('#cards .card');
  ok('D3 My topics survive a reload', await page.locator('#ownlist .chip').count() === 1);
  const mine = await page.evaluate(() => { const S = window.__mashup.state(); S.dist = 50; S.weird = 0; const saved = S.own.slice(); for (let i = 0; i < 40; i++) S.own.push('my extra topic ' + i); let hits = 0; for (let i = 0; i < 400; i++) { S.cards = []; if (window.__mashup.roll().some(c => c.cat === 'yours')) hits++; } S.mine = false; const off = window.__mashup.pool().filter(t => t.cat === 'yours').length; S.mine = true; S.own = saved; return { hits, off, withIt: window.__mashup.pool().some(t => t.text === 'Pickle Ball Nonsense') }; });
  ok('D4 your topics can come up, and "Include my topics" off removes them', mine.hits > 0 && mine.off === 0 && mine.withIt, JSON.stringify(mine));
  await page.click('#ownlist .chip button'); ok('D5 a topic can be removed', await page.locator('#ownlist .chip').count() === 0);

  // E. lock, history, favorites, copy, keyboard
  await page.evaluate(() => window.__mashup.seed(7));
  await page.click('#spin');
  const first = (await cards(page))[0].text;
  await page.locator('.card .lock').first().click();
  let kept = 0, changed = 0, prevSecond = (await cards(page))[1].text;
  for (let i = 0; i < 6; i++) { await page.click('#spin'); const c = await cards(page); if (c[0].text === first) kept++; if (c[1].text !== prevSecond) changed++; prevSecond = c[1].text; }
  ok('E1 a locked card stays while the others re-roll', kept === 6 && changed >= 4, JSON.stringify([kept, changed]));
  await page.locator('.card .lock').first().click();
  const h0 = await page.locator('#histlist li').count();
  await page.locator('body').click({ position: { x: 5, y: 5 } }); await page.keyboard.press('Space');
  ok('E2 Space spins', (await page.locator('#histlist li').count()) >= Math.min(8, h0));
  for (let i = 0; i < 25; i++) await page.click('#spin');
  ok('E3 history keeps only the last 8', await page.locator('#histlist li').count() === 8);
  const txt = (await cards(page)).map(c => c.text).join(' × ');
  await page.click('#copy'); ok('E4 Copy puts "A × B" on the clipboard', (await page.evaluate(() => navigator.clipboard.readText())) === txt, txt);
  await page.click('#fav');
  ok('E5 Favorite stars the result', await page.locator('#favlist li').count() === 1 && (await page.getAttribute('#fav', 'aria-pressed')) === 'true');
  const favText = txt;
  await page.click('#spin'); await page.reload(); await page.waitForSelector('#cards .card');
  ok('E6 favorites and history survive a reload', await page.locator('#favlist li b').first().innerText() === favText && await page.locator('#histlist li').count() === 8);
  await page.locator('#favlist li button', { hasText: 'Bring back' }).click();
  ok('E7 Bring back restores a saved result', (await cards(page)).map(c => c.text).join(' × ') === favText);
  await page.locator('#favlist li button[aria-label="Remove favorite"]').click();
  ok('E8 a favorite can be removed', await page.locator('#favlist li b').first().innerText() !== favText);

  // F. send to the Joke-Web Maker
  await page.evaluate(() => { const S = window.__mashup.state(); S.weird = 0; });
  await page.click('#spin');
  const cs = await cards(page); const href = await page.getAttribute('#send', 'href');
  ok('F1 the send link carries the subject and branches in the fragment', href.startsWith('/jokeweb#subject=') && decodeURIComponent(href.split('&branches=')[1]) === cs.map(c => c.text).join('|'), href.slice(0, 80));
  await page.click('#send'); await page.waitForSelector('#frame .nd');
  const jw = await page.evaluate(() => ({ n: document.querySelectorAll('#frame .nd').length, hash: location.hash, step: document.querySelector('[aria-current="step"]').textContent }));
  ok('F2 the Joke-Web Maker starts a web from it, step 3, address cleaned', jw.n === 1 + cs.length && jw.hash === '' && /Break it down/.test(jw.step), JSON.stringify(jw));
  // with an existing web: banner, then keep or replace
  const q = await mk(browser, { init: ['pk-jokeweb-v1', JSON.stringify({ mode: 'guided', step: 2, sel: 0, nextId: 2, nodes: [{ id: 0, t: 'Mine', p: null, x: null, y: null, jokes: [] }, { id: 1, t: 'Kept', p: 0, x: null, y: null, jokes: [] }], draft: 'keep this draft' })] });
  await q.goto('http://localhost:3988/jokeweb#subject=Cheese%20%C3%97%20Tax&branches=Cheese%7CTax');
  ok('F3 sending with a web already in progress starts the new web at once and says so', await q.locator('#incoming').isVisible() && /New web started/.test(await q.locator('#inc-title').innerText()) && (await q.locator('#frame .nd text').allTextContents()).includes('Cheese × Tax'));
  const sent = await q.evaluate(() => ({ n: document.querySelectorAll('#frame .nd').length, draft: document.getElementById('draft').value, prev: !!document.getElementById('prev') }));
  ok('F4 the new web has the subject plus a branch per topic, the draft stays, and a swap button is offered', sent.n === 3 && sent.draft === 'keep this draft' && sent.prev, JSON.stringify(sent));
  await q.click('#inc-new');
  const back = await q.evaluate(() => ({ t: [...document.querySelectorAll('#frame .nd text')].map(x => x.textContent), draft: document.getElementById('draft').value }));
  ok('F5 switching back restores the web I had, and I can swap again', back.t.join() === 'Mine,Kept' && back.draft === 'keep this draft' && await q.locator('#prev').count() === 1, JSON.stringify(back));
  await q.reload(); ok('F6 the swap survives a reload', await q.locator('#prev').count() === 1 && await q.locator('#frame .nd').count() === 2);
  await q.close();

  // G. animation, phone, dark, hub
  const an = await mk(browser, { reduce: false }); await an.goto(BASE);
  await an.click('#spin'); await an.waitForTimeout(250);
  ok('G1 the spin animation runs, then settles on the real topics', await an.locator('.card.spinning').count() > 0);
  await an.waitForTimeout(1300);
  const settled = await an.evaluate(() => ({ spinning: document.querySelectorAll('.card.spinning').length, same: [...document.querySelectorAll('#cards .big')].map(b => b.textContent).join('|') === window.__mashup.state().cards.map(c => c.text).join('|') }));
  ok('G2 after the spin the cards show the real result', settled.spinning === 0 && settled.same, JSON.stringify(settled));
  await an.close();
  const ph = await mk(browser, { vp: { width: 390, height: 800 }, scheme: 'dark' }); await ph.goto(BASE); await ph.waitForSelector('#cards .card');
  await ph.evaluate(() => { const S = window.__mashup.state(); S.weird = 100; document.getElementById('weird').value = 100; }); await ph.click('#spin');
  ok('G3 phone: three stacked cards, no sideways scroll', (await cards(ph)).length === 3 && await ph.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await ph.screenshot({ path: 'mu-phone.png', fullPage: true }); await ph.close();
  await page.setViewportSize({ width: 1280, height: 900 }); await page.goto(BASE); await page.waitForSelector('#cards .card'); await page.screenshot({ path: 'mu-desktop.png', fullPage: true });
  await page.goto('http://localhost:3988/');
  const nums = await page.evaluate(() => [...document.querySelectorAll('.tool .num')].map(n => n.textContent));
  ok('G4 hub numbers are unique and run 01 to 10', nums.join(',') === '01,02,03,04,05,06,07,08,09,10', nums.join(','));
  ok('G5 the hub has a Mashup Machine card linking to /mashup', await page.locator('a[href="/mashup"]').count() === 1);
  // H. layout: favorites full width below controls and history; old long histories are trimmed
  {
    const old = { mode: 'mashup', dist: 50, weird: 0, spicy: true, mine: true, own: [], cards: [], favs: [], history: Array.from({ length: 20 }, (_, i) => ({ cards: [{ text: 'a topic ' + i, cat: 'food' }, { text: 'b topic ' + i, cat: 'home' }] })) };
    const pg = await mk(browser, { vp: { width: 1280, height: 900 }, init: ['pk-mashup-v1', JSON.stringify(old)] }); await pg.goto(BASE); await pg.waitForSelector('#cards .card');
    ok('H1 an old stored history of 20 shows only 8', await pg.locator('#histlist li').count() === 8);
    const g = await pg.evaluate(() => { const r = id => document.getElementById(id).closest('section').getBoundingClientRect(), c = r('ctl'), h = r('hist'), f = r('favs'), k = document.querySelector('.k-wrap').getBoundingClientRect(); return { cBottom: c.bottom, hBottom: h.bottom, fTop: f.top, fW: f.width, kW: k.width, side: h.left > c.left }; });
    ok('H2 controls and history sit side by side with Favorites full width below both', g.side && g.fTop >= Math.max(g.cBottom, g.hBottom) && g.fW >= g.kW - 41, JSON.stringify(g));
    await pg.screenshot({ path: 'mu-layout.png', fullPage: true }); await pg.close();
  }
  ok('Z1 no requests beyond this site and the shared footer avatar lookup', third.length === 0, third.join(' '));
  console.log(out.join('\n')); console.log('JS errors:', errors.length ? errors.join('|') : 'none');
  await browser.close();
})().catch(e => { console.log(out.join('\n')); console.log('TEST CRASH', e); process.exit(1); });
