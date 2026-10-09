// The Tracer's viewer in 'saved' mode, fed hand-made nodes. The live crawler script is replaced by a
// stub that only starts the viewer in saved mode, as a saved game's page will; no Bluesky mock is
// installed, so any request that leaves this machine is a failure.
const { chromium } = require('playwright-core');
const { CHROME, BASE } = require('./env');
const out = []; const ok = (n, c, x = '') => out.push((c ? 'PASS' : 'FAIL') + ': ' + n + (x ? ' — ' + x : ''));
const errors = [];

async function open(browser, viewport = { width: 1000, height: 900 }) {
  const ctx = await browser.newContext({ viewport, colorScheme: 'light' }); const page = await ctx.newPage();
  const outside = [], fonts = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (/Content Security Policy|Refused to/.test(m.text())) errors.push('CSP: ' + m.text().slice(0, 160)); });
  page.on('request', r => { const u = new URL(r.url()); if (u.hostname === 'localhost' || /^data:/.test(r.url())) return; if (/fonts\.(googleapis|gstatic)\.com/.test(u.hostname)) fonts.push(r.url()); else outside.push(r.url()); });
  await page.route(/fonts\.(googleapis|gstatic)/, r => r.abort());
  await page.route('**/tracer-live.js', r => r.fulfill({ contentType: 'text/javascript', body: "window.TracerViewer.init({mode:'saved'});" }));
  await page.goto(BASE + '/tracer');
  return { page, outside, fonts, ctx };
}
// builds: root, 12 quotes, a tombstone (with 3 children) among them, a deeper chain, a hostile handle
const build = () => {
  const V = window.TracerViewer;
  const mk = (i, over = {}) => Object.assign({ uri: 'at://did:plc:u' + i + '/app.bsky.feed.post/r' + i, k: 'r' + i, h: 'user' + i + '.example', did: 'did:plc:u' + i, dn: 'User ' + i, av: 'https://cdn.bsky.app/img/avatar/plain/x/a@jpeg', d: new Date(Date.UTC(2026, 8, 1, 10, i)).toISOString(), t: 'quote ' + i, qc: 0, media: { type: 'images', images: [{ thumb: 'https://cdn.bsky.app/t.jpg', full: 'https://cdn.bsky.app/f.jpg', alt: '' }] } }, over);
  const root = V.add(mk(0, { h: 'root.example', t: 'The original post' }), null);
  const kids = []; for (let i = 1; i <= 12; i++) kids.push(V.add(mk(i, i === 7 ? { h: '"><script>window.__pwn=1</script>', t: '<img src=x onerror="window.__pwn=2">' } : {}), root));
  const tomb = V.add({ tomb: 'deleted' }, root);
  const under = [20, 21, 22].map(i => V.add(mk(i), tomb));
  const tomb2 = V.add({ tomb: 'removed' }, kids[0]);
  V.add(mk(30), tomb2);
  const lab = V.add({ tomb: 'label' }, kids[1]);
  let cur = kids[2]; for (let d = 0; d < 4; d++) cur = V.add(mk(40 + d, { h: 'deep' + d + '.example', t: 'deep ' + d }), cur);
  V.defaultOpen(1); document.getElementById('result').hidden = false; V.renderRoot(); V.renderAll();
  return { tomb: tomb.i, under: under.map(n => n.i) };
};

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  {
    const { page, outside, fonts } = await open(browser);
    await page.waitForTimeout(600);
    ok('V0 the page asks no one for fonts any more (they are self-hosted)', fonts.length === 0, String(fonts.length));
    ok('V1 saved mode loads with no request leaving localhost (no Bluesky, no CDN, no footer avatar lookup)', outside.length === 0, outside.join(',') || 'none');
    ok('V2 mode flag is on the page', (await page.evaluate(() => document.body.dataset.mode)) === 'saved' && (await page.evaluate(() => TracerViewer.mode())) === 'saved');
    const ids = await page.evaluate(build);
    await page.waitForTimeout(300);
    ok('V3 no <img> and no media anywhere in the tree, even though nodes carry avatar and media data', (await page.locator('#tree img, #rootcard img, #tree .media, #tree .imgs').count()) === 0);
    ok('V4 initials circles are shown instead', (await page.locator('#tree .av').first().innerText()).trim().length > 0);
    ok('V5 tombstone cards show fixed messages and no author, text, date or Bluesky link', await page.evaluate(() => { const cs = [...document.querySelectorAll('#tree .card.tomb')]; const t = cs.map(c => c.innerText); return cs.length === 3 && t.some(x => /This post was deleted/.test(x)) && t.some(x => /Removed by its author/.test(x)) && t.some(x => /Hidden because of a content label/.test(x)) && cs.every(c => !c.querySelector('a') && !/@|Day \d/.test(c.innerText)); }));
    ok('V6 a tombstone keeps its replies attached', await page.evaluate(id => { const n = document.getElementById('n' + id.tomb); return n && n.querySelectorAll('.kids .card').length === 3; }, ids));
    ok('V7 tombstone folds and unfolds', await page.evaluate(id => { const n = document.getElementById('n' + id.tomb); const was = n.classList.contains('closed'); n.querySelector(':scope > .card [data-a="tog"]').click(); const flipped = n.classList.contains('closed') !== was; n.querySelector(':scope > .card [data-a="tog"]').click(); return flipped && n.classList.contains('closed') === was; }, ids));
    ok('V8 hostile handle and text render as inert text', (await page.evaluate(() => window.__pwn)) === undefined && (await page.locator('#tree script, #tree img[src="x"]').count()) === 0);
    const stats = await page.locator('#stats').innerText();
    ok('V9 contributors do not count tombstones', /(\d+)\s*CONTRIBUTORS/i.test(stats) && Number(stats.match(/(\d+)\s*CONTRIBUTORS/i)[1]) === 12 + 3 + 1 + 4, stats.replace(/\n/g, ' '));
    await page.fill('#q', 'quote 2'); await page.waitForTimeout(400);
    ok('V10 search finds posts and never matches a tombstone', (await page.locator('#tree .card:not(.tomb) mark').count()) > 0 && (await page.locator('#tree .card.tomb').count()) <= 1);
    await page.fill('#q', ''); await page.waitForTimeout(300);
    await page.click('#lead'); const lb = await page.locator('#dbody').innerText(); await page.click('[data-tab="people"]'); const lb2 = await page.locator('#lbc').innerText(); await page.click('#dx');
    ok('V11 leaderboards leave tombstones out', !/deleted|Removed by|content label/.test(lb + lb2));
    await page.evaluate(() => document.querySelectorAll('#tree [data-a="trace"]')[0].click());
    ok('V12 lineage bar works', await page.locator('#trace.on').count() === 1);
    await page.evaluate(id => { document.querySelector('#n' + id.under[0] + ' [data-a="trace"]').click(); }, ids);
    ok('V13 lineage through a tombstone names it by its message', /This post was deleted/.test(await page.locator('#trace').innerText()));
    await page.click('#trace .x');
    await page.click('#deep'); ok('V14 deepest dive opens', /in a row/.test(await page.locator('#dbody').innerText())); await page.click('#dx');
    await page.click('#vCmp'); ok('V15 compact view', await page.evaluate(() => document.body.classList.contains('compact'))); await page.click('#vExp');
    const closedParents = () => page.evaluate(() => [...document.querySelectorAll('#tree .node.closed')].filter(n => n.querySelector(':scope > .kids')).length);
    await page.click('#coAll'); const closed = await closedParents(); await page.click('#exAll'); const closed2 = await closedParents();
    ok('V16 collapse all / expand all', closed > 0 && closed2 === 0);
    await page.keyboard.press('c'); const c1 = await closedParents(); await page.keyboard.press('e'); const c2 = await closedParents();
    await page.keyboard.press('/'); ok('V17 keyboard shortcuts c / e / "/"', c1 > 0 && c2 === 0 && (await page.evaluate(() => document.activeElement.id)) === 'q');
    await page.selectOption('#sort', 'big'); ok('V18 sort by biggest branch', (await page.locator('#tree .card').count()) > 5);
    ok('V19 Copy link does nothing on a tombstone and works on a post', await page.evaluate(id => { const t = document.querySelector('#n' + id.tomb + ' > .card [data-a="copy"]'); const p = document.querySelector('#n' + id.under[0] + ' > .card [data-a="copy"]'); return !t && !!p; }, ids));
    ok('V20 still no request left localhost after all of that', outside.length === 0, outside.join(',') || 'none');
  }
  {   // many nodes
    const { page, outside } = await open(browser);
    const t = await page.evaluate(() => {
      const V = window.TracerViewer; const t0 = performance.now();
      const root = V.add({ uri: 'u0', k: 'r0', h: 'root.example', did: 'did:plc:r', dn: '', av: '', d: '2026-09-01T10:00:00Z', t: 'root', qc: 5000, media: null }, null);
      const pool = [root]; let tombs = 0;
      for (let i = 1; i <= 5000; i++) {
        const parent = i < 60 ? root : pool[Math.floor(Math.sqrt(i * 7919 % 10007) * pool.length / 100) % pool.length];
        const f = i % 40 === 0 ? { tomb: 'deleted' } : { uri: 'u' + i, k: 'r' + i, h: 'user' + (i % 700) + '.example', did: 'did:plc:u' + (i % 700), dn: 'User ' + i, av: '', d: new Date(Date.UTC(2026, 8, 1 + i / 400, 10, i % 60)).toISOString(), t: 'quote number ' + i + ' with some words in it', qc: 0, media: null };
        pool.push(V.add(f, parent));
      }
      const built = performance.now() - t0;
      V.defaultOpen(2); document.getElementById('result').hidden = false; const t1 = performance.now(); V.renderRoot(); V.renderAll(); const render = performance.now() - t1;
      const q = document.getElementById('q'); const t2 = performance.now(); q.value = 'number 4999'; q.dispatchEvent(new Event('input')); return new Promise(res => setTimeout(() => res({ built, render, searchMs: performance.now() - t2 - 180, cards: document.querySelectorAll('#tree .card').length, count: V.count() }), 400));
    });
    ok('V21 5,000-node tree renders in under 3 s and a search answers in under 1.5 s', t.render < 3000 && t.searchMs < 1500 && t.count === 5001, JSON.stringify({ buildMs: Math.round(t.built), renderMs: Math.round(t.render), searchMs: Math.round(t.searchMs), cards: t.cards }));
    ok('V22 nothing left localhost with 5,000 nodes either', outside.length === 0);
  }
  console.log(out.join('\n')); console.log('JS errors:', errors.length ? errors.join('|') : 'none');
  await browser.close();
})();
