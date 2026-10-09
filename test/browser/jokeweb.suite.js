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
    ok('A4 break it down: subject is greyed, first branch selected', await page.locator('#frame .nd.dim').count() === 1 && /Working on:\s*Walk out/.test(await page.locator('#controls .crumbs').innerText()));
    for (const t of ['Flounce out', 'Conga']) { await page.fill('#kid-input', t); await page.press('#kid-input', 'Enter'); }
    ok('A5 associations attach under the selected branch', await nds(page).count() === 6);
    await page.click('#to4');
    ok('A6 apply it back: subject is no longer greyed', await page.locator('#frame .nd.dim').count() === 0);
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
    const first = nds(page).nth(2); const b0 = await first.boundingBox();
    await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2); await page.mouse.down(); await page.mouse.move(b0.x + b0.width / 2 + 80, b0.y + b0.height / 2 + 40, { steps: 6 }); await page.mouse.up();
    const b1 = await nds(page).nth(2).boundingBox();
    ok('C2 dragging moves a bubble', Math.abs(b1.x - b0.x - 80) < 25 && Math.abs(b1.y - b0.y - 40) < 25, JSON.stringify([b0.x, b1.x]));
    await page.reload(); const b2 = await nds(page).nth(2).boundingBox();
    ok('C3 the moved position survives reload', Math.abs(b2.x - b1.x) < 3);
    await page.click('#tidy'); const b3 = await nds(page).nth(2).boundingBox();
    ok('C4 Tidy up puts it back', Math.abs(b3.x - b0.x) < 3 && Math.abs(b3.y - b0.y) < 3);
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
  ok('F1 no requests beyond this site and the shared footer avatar lookup', third.length === 0, third.join(' '));
  console.log(out.join('\n')); console.log('JS errors:', errors.length ? errors.join('|') : 'none');
  await browser.close();
})().catch(e => { console.log(out.join('\n')); console.log('TEST CRASH', e); process.exit(1); });
