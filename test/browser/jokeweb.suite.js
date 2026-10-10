const { chromium } = require('playwright-core');
const fs = require('fs');
const BASE = 'http://localhost:3988/jokeweb';
const out = [], errors = [], third = [];
const ok = (n, c, x = '') => out.push((c ? 'PASS' : 'FAIL') + ': ' + n + (x ? ' — ' + x : ''));
const KEY = 'pk-jokeweb-v1';

function bigWeb() {
  const nodes = [{ id: 0, t: 'Strikes', p: null, x: null, y: null, jokes: ['Picket line-dancing'] }]; let id = 1;
  ['Walk out', 'Picket', 'Union', 'Tea break', 'Scab', 'Overtime'].forEach(t => { nodes.push({ id, t, p: 0, x: null, y: null, jokes: [] }); const par = id++;
    for (let k = 0; k < 3; k++) { nodes.push({ id, t: t + ' idea ' + (k + 1), p: par, x: null, y: null, jokes: [] }); const p2 = id++; nodes.push({ id, t: 'second ' + id, p: p2, x: null, y: null, jokes: [] }); id++; } });
  return { mode: 'guided', step: 3, sel: 1, nextId: id, nodes, draft: 'saved draft' };
}
async function mk(browser, { init, vp = { width: 1100, height: 900 }, blockStorage = false, scheme = 'light' } = {}) {
  const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { const u = new URL(r.url()); if (u.protocol.startsWith('http') && u.hostname !== 'localhost' && !/public\.api\.bsky\.app/.test(u.hostname)) third.push(r.url()); });
  await page.route(/fonts\.(googleapis|gstatic)/, r => r.abort());
  await page.route('https://public.api.bsky.app/**', r => r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
  if (blockStorage) await page.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }); });
  else if (init) await page.addInitScript(([k, v]) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem(k, v); sessionStorage.setItem('seeded', '1'); } }, [KEY, JSON.stringify(init)]);
  return { page, ctx };
}
const nds = page => page.locator('#frame .nd');
const labels = page => page.evaluate(() => [...document.querySelectorAll('#frame .nd text')].map(t => t.textContent));
(async () => {
  const browser = await chromium.launch({ executablePath: require('./env').CHROME });

  // A. guided flow
  {
    const { page } = await mk(browser); await page.goto(BASE);
    ok('A1 empty state: web empty, later steps disabled', await page.locator('#frame .empty').isVisible() && await page.locator('[data-step="2"]').isDisabled() && await page.locator('[data-step="4"]').isDisabled());
    await page.fill('#subject', 'Strikes'); await page.press('#subject', 'Enter');
    ok('A2 subject starts the web and moves to branches', await nds(page).count() === 1 && await page.locator('#sub-input').isVisible());
    for (const t of ['Walk out', 'Picket', 'Union']) { await page.fill('#sub-input', t); await page.press('#sub-input', 'Enter'); }
    ok('A3 three branches are in the web and listed', await nds(page).count() === 4 && await page.locator('.chips .chip').count() === 3);
    await page.click('#to3');
    ok('A4 break it down: subject is grayed, first branch selected', await page.locator('#frame .nd.dim').count() === 1 && /Working on:\s*Walk out/.test(await page.locator('#controls .crumbs').innerText()));
    for (const t of ['Flounce out', 'Conga']) { await page.fill('#kid-input', t); await page.press('#kid-input', 'Enter'); }
    ok('A5 associations attach under the selected branch', await nds(page).count() === 6);
    await page.click('#to4');
    ok('A6 apply it back: subject is no longer grayed', await page.locator('#frame .nd.dim').count() === 0);
    await page.fill('#joke-input', 'Actors flounce out. Stage left.'); await page.press('#joke-input', 'Enter');
    ok('A7 joke idea is saved and listed', await page.locator('#ideas li').count() === 1);
    await page.click('#ideas [data-use]');
    ok('A8 Use in draft fills the composer', (await page.inputValue('#draft')) === 'Actors flounce out. Stage left.');
    await page.fill('#joke-input', 'Second one'); await page.press('#joke-input', 'Enter');
    await page.locator('#ideas li').nth(1).locator('[data-use]').click();
    ok('A9 a second idea is appended on a new line', (await page.inputValue('#draft')) === 'Actors flounce out. Stage left.\nSecond one');
    await page.reload();
    ok('A10 reload restores the web, ideas and draft', await nds(page).count() === 6 && await page.locator('#ideas li').count() === 2 && (await page.inputValue('#draft')).includes('Second one'));
    await page.close();
  }
  // B. composer
  {
    const { page } = await mk(browser); await page.goto(BASE);
    await page.fill('#draft', '👍'.repeat(300));
    ok('B1 300 emoji count as 300, not over', (await page.innerText('#dcount')) === '300 / 300' && !(await page.locator('#dcount.over').count()));
    await page.fill('#draft', '👍'.repeat(301));
    ok('B2 301 is over the limit', (await page.locator('#dcount.over').count()) === 1 && /301 \/ 300/.test(await page.innerText('#dcount')));
    await page.fill('#draft', 'a & b? ok');
    ok('B3 Open in Bluesky carries the encoded draft', (await page.getAttribute('#dbluesky', 'href')) === 'https://bsky.app/intent/compose?text=' + encodeURIComponent('a & b? ok'));
    await page.click('#dcopy');
    ok('B4 Copy puts the draft on the clipboard', (await page.evaluate(() => navigator.clipboard.readText())) === 'a & b? ok');
    await page.reload(); ok('B5 draft survives reload', (await page.inputValue('#draft')) === 'a & b? ok');
    await page.click('#dclear');
    ok('B6 Clear empties it', (await page.inputValue('#draft')) === '' && (await page.innerText('#dcount')) === '0 / 300' && (await page.getAttribute('#dbluesky', 'href')) === 'https://bsky.app/intent/compose');
    await page.close();
  }
  // C. free board, drag, rename, delete, tidy
  {
    const { page } = await mk(browser, { init: bigWeb() }); await page.goto(BASE);
    ok('C1 a restored web draws every bubble', await nds(page).count() === 43);
    await page.click('#mode-free');
    const rel = async () => page.evaluate(() => { const s = document.querySelector('#frame svg').getBoundingClientRect(), b = document.querySelectorAll('#frame .nd')[2].getBoundingClientRect(); return { x: b.left - s.left, y: b.top - s.top }; });
    const first = nds(page).nth(2); await first.scrollIntoViewIfNeeded(); const b0 = await first.boundingBox(); const r0 = await rel();
    await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2); await page.mouse.down(); await page.mouse.move(b0.x + b0.width / 2 + 80, b0.y + b0.height / 2 + 40, { steps: 6 }); await page.mouse.up();
    const b1 = await nds(page).nth(2).boundingBox();
    const moved = await page.evaluate(() => window.__jokeweb.state().nodes.filter(n => n.x !== null).length);
    ok('C2 dragging moves a bubble (and only that one)', moved === 1 && (Math.abs(b1.x - b0.x) > 5 || Math.abs(b1.y - b0.y) > 5), JSON.stringify([b0.x, b1.x, moved]));
    await page.reload(); const b2 = await nds(page).nth(2).boundingBox();
    ok('C3 the moved position survives reload', Math.abs(b2.x - b1.x) < 3);
    await page.click('#tidy'); const b3 = await nds(page).nth(2).boundingBox();
    const r3 = await rel();
    ok('C4 Tidy up puts it back', Math.abs(r3.x - r0.x) < 3 && Math.abs(r3.y - r0.y) < 3, JSON.stringify([r0, r3]));
    await nds(page).nth(1).click();
    await page.fill('#free-rename', 'Walkout'); await page.click('#free-rename-go');
    ok('C5 rename works', (await labels(page)).includes('Walkout'));
    await page.fill('#free-add', 'new idea'); await page.press('#free-add', 'Enter');
    ok('C6 add under selected adds a bubble', await nds(page).count() === 44);
    await nds(page).nth(1).click(); await page.click('#free-del');
    ok('C7 delete removes the bubble and its whole branch', await nds(page).count() === 44 - 8, String(await nds(page).count()));
    await page.close();
  }
  // D. exports
  {
    const { page } = await mk(browser, { init: bigWeb() }); await page.goto(BASE);
    const t = await page.evaluate(() => window.__jokeweb.outline());
    ok('D1 outline is indented by level', t.split('\n')[0] === 'Strikes' && t.split('\n')[1] === '  Walk out' && t.split('\n')[2] === '    Walk out idea 1' && t.split('\n')[3] === '      second 3', t.split('\n').slice(0, 4).join('|'));
    await page.click('#copyWeb'); ok('D2 Copy web copies the outline', (await page.evaluate(() => navigator.clipboard.readText())) === t);
    await page.click('#copyIdeas'); ok('D3 Copy joke ideas copies just the ideas', (await page.evaluate(() => navigator.clipboard.readText())) === 'Picket line-dancing');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#saveImg')]);
    const file = await dl.path(); const buf = fs.readFileSync(file);
    ok('D4 Save image downloads a PNG', buf.slice(1, 4).toString() === 'PNG' && /\.png$/.test(dl.suggestedFilename()), dl.suggestedFilename());
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    ok('D5 the image is a reasonable size', w > 800 && h > 500 && w <= 4000 && h <= 4100, w + 'x' + h);
    fs.copyFileSync(file, 'jw-export.png');
    await page.screenshot({ path: 'jw-desktop.png', fullPage: true });
    await page.close();
  }
  // E. phone, dark, storage blocked, XSS
  {
    const { page } = await mk(browser, { init: bigWeb(), vp: { width: 390, height: 800 }, scheme: 'dark' }); await page.goto(BASE);
    ok('E1 no horizontal overflow at 390px', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: 'jw-phone.png', fullPage: true });
    await page.close();
    const q = await mk(browser, { blockStorage: true }); await q.page.goto(BASE);
    await q.page.fill('#subject', 'Cheese'); await q.page.press('#subject', 'Enter');
    ok('E2 works with storage blocked', await nds(q.page).count() === 1);
    await q.page.close();
    const x = await mk(browser); await x.page.goto(BASE);
    await x.page.fill('#subject', '<img src=x onerror=window.__pwn=1>'); await x.page.press('#subject', 'Enter');
    await x.page.fill('#sub-input', '<script>window.__pwn=2</script>'); await x.page.press('#sub-input', 'Enter');
    await x.page.waitForTimeout(300);
    ok('E3 typed markup is shown as text, never run', (await x.page.evaluate(() => window.__pwn)) === undefined && (await labels(x.page)).some(s => /<img/.test(s) || /<script/.test(s)));
    await x.page.close();
  }
  // G. desktop: web on top at full width; phone: whole web fits, even when deep
  {
    const { page } = await mk(browser, { init: bigWeb(), vp: { width: 1280, height: 900 } }); await page.goto(BASE);
    const r = await page.evaluate(() => { const b = id => document.getElementById(id).getBoundingClientRect(), w = b('webpanel'), c = b('controls'), d = b('composer'), k = document.querySelector('.k-wrap').getBoundingClientRect(); return { ww: w.width, kw: k.width, wb: w.bottom, ct: c.top, dt: d.top, cl: c.left, dl: d.left, over: document.documentElement.scrollWidth > innerWidth + 1 }; });
    ok('G1 desktop: the web panel spans the full content width', r.ww >= r.kw - 41, JSON.stringify(r));
    ok('G2 desktop: steps and draft boxes sit under the web, side by side', r.ct >= r.wb && r.dt >= r.wb && Math.abs(r.ct - r.dt) < 2 && r.dl > r.cl && !r.over, JSON.stringify(r));
    const fit = await page.evaluate(() => { const f = document.getElementById('frame'), s = f.querySelector('svg'); return { fw: f.clientWidth, sw: s.getBoundingClientRect().width, sh: s.getBoundingClientRect().height, fh: f.clientHeight, sc: f.scrollWidth - f.clientWidth }; });
    ok('G3 desktop: the whole 43-bubble web fits the frame without scrolling', fit.sc <= 1 && fit.sw <= fit.fw && fit.sh <= fit.fh + 1, JSON.stringify(fit));
    await page.screenshot({ path: 'jw-desktop2.png', fullPage: true });
    await page.close();
    function deep(n) { const nodes = [{ id: 0, t: 'Strikes', p: null, x: null, y: null, jokes: [] }]; let id = 1; const lv1 = [];
      for (let i = 0; i < 6; i++) { nodes.push({ id, t: 'Branch ' + (i + 1), p: 0, x: null, y: null, jokes: [] }); lv1.push(id++); }
      let cur = lv1; for (let d = 0; d < 3 && nodes.length < n; d++) { const next = []; cur.forEach(p => { for (let k = 0; k < (d === 0 ? 3 : 2) && nodes.length < n; k++) { nodes.push({ id, t: 'Level ' + (d + 2) + ' idea ' + id, p, x: null, y: null, jokes: [] }); next.push(id++); } }); cur = next; }
      return { mode: 'guided', step: 3, sel: 1, nextId: id, nodes, draft: '' }; }
    for (const [label, n] of [['43', 43], ['120', 120]]) {
      const w = deep(n), q = await mk(browser, { init: w, vp: { width: 390, height: 800 } }); await q.page.goto(BASE);
      const f = await q.page.evaluate(() => { const fr = document.getElementById('frame'), s = fr.querySelector('svg'); return { fw: fr.clientWidth, sw: s.getBoundingClientRect().width, scx: fr.scrollWidth - fr.clientWidth, over: document.documentElement.scrollWidth > innerWidth + 1, n: fr.querySelectorAll('.nd').length }; });
      ok('G4 phone: a ' + label + '-bubble web fits the frame width, no sideways scroll', f.scx <= 1 && f.sw <= f.fw && !f.over, JSON.stringify(f));
      await q.page.click('#zoomIn'); await q.page.click('#zoomIn'); await q.page.click('#fit');
      const g = await q.page.evaluate(() => { const fr = document.getElementById('frame'), s = fr.querySelector('svg'); return { scx: fr.scrollWidth - fr.clientWidth, sw: s.getBoundingClientRect().width, fw: fr.clientWidth }; });
      ok('G5 phone: Fit brings the whole ' + label + '-bubble web back after zooming', g.scx <= 1 && g.sw <= g.fw, JSON.stringify(g));
      await q.page.screenshot({ path: 'jw-phone' + label + '.png', fullPage: false });
      await q.page.close();
    }
  }
  // H. centered subject; dragging to the edge never clips or snaps
  {
    const { page } = await mk(browser, { init: bigWeb(), vp: { width: 1280, height: 900 } }); await page.goto(BASE);
    const centered = async pg => pg.evaluate(() => { const f = document.getElementById('frame').getBoundingClientRect(), r = document.querySelector('#frame .nd[data-id="0"]').getBoundingClientRect(); return { dx: (r.left + r.width / 2) - (f.left + f.width / 2), dy: (r.top + r.height / 2) - (f.top + f.height / 2) }; });
    const c0 = await centered(page);
    ok('H1 desktop: the subject is in the middle of the board', Math.abs(c0.dx) < 3, JSON.stringify(c0));
    const lop = { mode: 'guided', step: 3, sel: 1, nextId: 8, draft: '', nodes: [{ id: 0, t: 'Cheese', p: null, x: null, y: null, jokes: [] }, ...[1, 2, 3].map(i => ({ id: i, t: 'Branch ' + i, p: 0, x: 400 + i * 60, y: -80 + i * 70, jokes: [] })), ...[4, 5, 6, 7].map(i => ({ id: i, t: 'Child ' + i, p: 1, x: 700 + i * 40, y: 100 * (i - 5), jokes: [] }))] };
    const { page: lp } = await mk(browser, { init: lop, vp: { width: 1280, height: 900 } }); await lp.goto(BASE);
    const c1 = await centered(lp);
    ok('H2 a lopsided web still has the subject in the middle', Math.abs(c1.dx) < 3 && Math.abs(c1.dy) < 3, JSON.stringify(c1));
    await lp.close();
    const { page: ph } = await mk(browser, { init: bigWeb(), vp: { width: 390, height: 800 } }); await ph.goto(BASE);
    const c2 = await centered(ph);
    ok('H3 phone: the subject is in the middle too', Math.abs(c2.dx) < 3, JSON.stringify(c2));
    await ph.close();
    // drag
    await page.click('#mode-free');
    const snap = () => page.evaluate(() => { const f = document.getElementById('frame'), s = f.querySelector('svg'), ids = [...f.querySelectorAll('.nd')], o = ids[10].getBoundingClientRect(), t = ids[2].getBoundingClientRect(), sr = s.getBoundingClientRect(), vbw = s.viewBox.baseVal.width; return { ox: o.left, oy: o.top, tx: t.left, ty: t.top, tr: t.right, tb: t.bottom, sl: sr.left, sr: sr.right, st: sr.top, sb: sr.bottom, scale: sr.width / vbw, sw: sr.width }; });
    await page.locator('#frame .nd').nth(2).scrollIntoViewIfNeeded();
    const s0 = await snap(); const fb = await page.locator('#frame').boundingBox();
    await page.mouse.move(s0.tx + 20, s0.ty + 8); await page.mouse.down();
    const targets = [[fb.x + fb.width - 12, s0.ty + 8], [fb.x + fb.width - 12, fb.y + fb.height - 14], [fb.x + 14, fb.y + fb.height - 14]];
    let clipped = 0, shifted = 0, scaleChanged = 0;
    for (const [x, y] of targets) {
      await page.mouse.move(x, y, { steps: 12 });
      const m = await snap();
      if (m.tx < m.sl - 1 || m.tr > m.sr + 1 || m.ty < m.st - 1 || m.tb > m.sb + 1) clipped++;
      if (Math.abs(m.scale - s0.scale) > 0.001) scaleChanged++;
      if (Math.abs((m.ox - m.sl) - (s0.ox - s0.sl) - 0) > 1000) shifted++;
    }
    await page.mouse.up();
    const s1 = await snap();
    ok('H4 while dragging toward every edge the bubble is never clipped', clipped === 0, 'clipped samples: ' + clipped);
    ok('H5 the board does not rescale during or after the drag', scaleChanged === 0 && Math.abs(s1.scale - s0.scale) < 0.001, JSON.stringify([s0.scale, s1.scale]));
    ok('H6 an untouched bubble has not moved on screen', Math.abs(s1.ox - s0.ox) < 2 && Math.abs(s1.oy - s0.oy) < 2, JSON.stringify([[s0.ox, s0.oy], [s1.ox, s1.oy]]));
    const c3 = await centered(page);
    ok('H7 the subject stays centered after the drag', Math.abs(c3.dx) < 3 && Math.abs(c3.dy) < 3, JSON.stringify(c3));
    await page.click('#fit');
    const fit = await page.evaluate(() => { const f = document.getElementById('frame'), s = f.querySelector('svg'); return { sc: f.scrollWidth - f.clientWidth, sw: s.getBoundingClientRect().width, fw: f.clientWidth }; });
    ok('H8 Fit brings the whole board back into view', fit.sc <= 1 && fit.sw <= fit.fw, JSON.stringify(fit));
    await page.close();
  }
  // K. sub-branches before forgetting the subject; Tidy up only in Free mode
  {
    const { page } = await mk(browser); await page.goto(BASE);
    await page.fill('#subject', 'Strikes'); await page.press('#subject', 'Enter');
    for (const t of ['Walk out', 'Picket']) { await page.fill('#sub-input', t); await page.press('#sub-input', 'Enter'); }
    await page.locator('.chips .chip button[data-chip]').first().click();
    ok('K1 step 2: tapping a branch lets you add sub-branches while the subject is still visible', /Adding to:\s*Strikes\s*›\s*Walk out/.test(await page.locator('#controls .crumbs').innerText()) && await page.locator('#frame .nd.dim').count() === 0);
    for (const t of ['Flounce out', 'Conga']) { await page.fill('#sub-input', t); await page.press('#sub-input', 'Enter'); }
    ok('K2 the sub-branches are in the web under that branch', await nds(page).count() === 5);
    await page.locator('.chips .chip button[data-chip]').first().click();
    ok('K3 you can go a level deeper again', /Strikes\s*›\s*Walk out\s*›\s*Flounce out/.test(await page.locator('#controls .crumbs').innerText()));
    await page.locator('#controls .crumbs button', { hasText: 'Strikes' }).click();
    ok('K4 tapping a name above goes back up to add more top-level branches', /Adding to:\s*Strikes$/.test((await page.locator('#controls .crumbs').innerText()).trim()));
    ok('K5 Tidy up is not shown in Guided mode', await page.locator('#tidy').count() === 0);
    await page.click('#to3');
    ok('K6 step 3 forgets the subject (dimmed, left out of the path) for one more round', await page.locator('#frame .nd.dim').count() === 1 && /Working on:/.test(await page.locator('#controls .crumbs').innerText()) && !/Strikes/.test(await page.locator('#controls .crumbs').innerText()));
    await page.fill('#kid-input', 'One last idea'); await page.press('#kid-input', 'Enter');
    ok('K7 the last round adds under the selected branch', await nds(page).count() === 6);
    await page.click('#mode-free');
    ok('K8 Tidy up appears in Free mode', await page.locator('#tidy').count() === 1);
    await page.click('#mode-guided');
    ok('K9 and disappears again in Guided mode', await page.locator('#tidy').count() === 0);
    await page.close();
  }
  // L. Apply it back: only the subject and the chosen idea stand out
  {
    const { page } = await mk(browser, { init: bigWeb() }); await page.goto(BASE);
    await page.click('[data-step="4"]');
    const f1 = await page.evaluate(() => { const nd = [...document.querySelectorAll('#frame .nd')]; return { n: nd.length, faded: nd.filter(x => x.classList.contains('faded')).length, mid: nd.filter(x => x.classList.contains('mid')).length, rootClear: !document.querySelector('.nd[data-id="0"]').classList.contains('faded') && !document.querySelector('.nd[data-id="0"]').classList.contains('mid'), edgesFaded: document.querySelectorAll('#frame .edge.faded').length, edges: document.querySelectorAll('#frame .edge').length }; });
    ok('L1 a first-level idea is chosen: subject and idea clear, everything else faded', f1.rootClear && f1.mid === 0 && f1.faded === f1.n - 2 && f1.edgesFaded === f1.edges - 1, JSON.stringify(f1));
    const deepId = await page.evaluate(() => window.__jokeweb.state().nodes.find(n => n.t === 'second 3').id);
    await page.locator('#frame .nd[data-id="' + deepId + '"]').click();
    const f2 = await page.evaluate(() => { const nd = [...document.querySelectorAll('#frame .nd')]; return { n: nd.length, mid: nd.filter(x => x.classList.contains('mid')).length, faded: nd.filter(x => x.classList.contains('faded')).length, op: getComputedStyle(nd.find(x => x.classList.contains('faded'))).opacity }; });
    ok('L2 a deeper idea: the bubbles linking it to the subject are half-visible, the rest faded', f2.mid === 2 && f2.faded === f2.n - 4 && +f2.op < 0.3, JSON.stringify(f2));
    await page.click('[data-step="3"]');
    ok('L3 the fading only belongs to the last step', await page.locator('#frame .faded').count() === 0);
    await page.close();
  }
  ok('F1 no requests beyond this site and the shared footer avatar lookup', third.length === 0, third.join(' '));
  console.log(out.join('\n')); console.log('JS errors:', errors.length ? errors.join('|') : 'none');
  await browser.close();
})().catch(e => { console.log(out.join('\n')); console.log('TEST CRASH', e); process.exit(1); });
