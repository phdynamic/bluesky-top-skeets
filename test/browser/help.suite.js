// Every tool page has the same Help button and the same Help dialog look.
const { chromium } = require('playwright-core');
const out = [], errors = [];
const ok = (n, c, x = '') => out.push((c ? 'PASS' : 'FAIL') + ': ' + n + (x ? ' — ' + x : ''));
const PAGES = [['/feeds', 'Top Skeets'], ['/tracer', 'Tracer'], ['/imagine-flagons', 'Saga'], ['/receipt', 'Skeet Receipt'], ['/jokeweb', 'Joke-Web Maker'], ['/mashup', 'Mashup Machine']];
const look = page => page.evaluate(() => { const d = document.getElementById('help'), h = d.querySelector('.hh'), cs = getComputedStyle(d), hs = getComputedStyle(h); return { border: cs.borderTopWidth, radius: cs.borderTopLeftRadius, bg: cs.backgroundColor, shadow: cs.boxShadow, head: hs.backgroundColor, headFont: getComputedStyle(h.querySelector('h2')).fontSize, close: h.querySelector('button').getBoundingClientRect().width, sections: d.querySelectorAll('h3').length, title: h.querySelector('h2').textContent }; });
(async () => {
  const browser = await chromium.launch({ executablePath: require('./env').CHROME });
  async function mk(vp = { width: 1100, height: 900 }, scheme = 'light') {
    const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme }); const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.route(/fonts\.(googleapis|gstatic)/, r => r.abort());
    await page.route('https://public.api.bsky.app/**', r => r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
    return page;
  }
  const page = await mk(); const looks = [];
  for (const [path, name] of PAGES) {
    await page.goto('http://localhost:3988' + path);
    const inBar = await page.evaluate(() => { const b = document.querySelector('.k-top #helpBtn'); return !!b && b.textContent.trim() === '? Help' && !!b.nextElementSibling && b.nextElementSibling.classList.contains('night'); });
    ok('H1 ' + name + ': "? Help" is in the top bar, just left of Night mode', inBar);
    const y0 = await page.evaluate(() => scrollY);
    await page.click('#helpBtn');
    const l = await look(page); looks.push(l);
    ok('H2 ' + name + ': Help opens a dialog with a title and at least three sections', await page.locator('#help').isVisible() && l.sections >= 3 && /How/.test(l.title), l.title + ' / ' + l.sections);
    ok('H3 ' + name + ': Help does not scroll the page', (await page.evaluate(() => scrollY)) === y0);
    await page.keyboard.press('Escape');
    ok('H4 ' + name + ': Esc closes it and focus returns to the button', await page.locator('#help').isHidden() && await page.evaluate(() => document.activeElement.id) === 'helpBtn');
    await page.click('#helpBtn'); await page.mouse.click(4, 4); const outside = await page.locator('#help').isHidden();
    await page.click('#helpBtn'); await page.click('#helpX');
    ok('H5 ' + name + ': clicking outside and the ✕ button both close it', outside && await page.locator('#help').isHidden());
    await page.goto('about:blank'); await page.goto('http://localhost:3988' + path + '#help');
    ok('H6 ' + name + ': the address ending in #help opens it', await page.locator('#help').isVisible());
  }
  const same = looks.every(l => ['border', 'radius', 'bg', 'shadow', 'head', 'headFont', 'close'].every(k => l[k] === looks[0][k]));
  ok('H7 all six Help dialogs share one look (border, radius, colors, shadow, title bar, close button)', same, JSON.stringify(looks[0]));
  ok('H8 the Skeet Receipt no longer has a "how it works" panel at the bottom', await (async () => { await page.goto('http://localhost:3988/receipt'); return (await page.locator('#how').count()) === 0; })());
  ok('H9 the hub page has no Help button', await (async () => { await page.goto('http://localhost:3988/'); return (await page.locator('#helpBtn').count()) === 0; })());
  await page.close();
  // phone, dark
  const ph = await mk({ width: 390, height: 700 }, 'dark');
  for (const [path, name] of PAGES) {
    await ph.goto('http://localhost:3988' + path); await ph.click('#helpBtn');
    const m = await ph.evaluate(() => { const d = document.getElementById('help').getBoundingClientRect(), b = document.querySelector('#help .hb'); return { w: d.width, h: d.height, vw: innerWidth, vh: innerHeight, scrolls: b.scrollHeight > b.clientHeight, over: document.documentElement.scrollWidth > innerWidth + 1 }; });
    ok('H10 ' + name + ': on a phone the dialog fits the screen and scrolls inside', m.w <= m.vw && m.h <= m.vh && m.scrolls && !m.over, JSON.stringify(m));
    if (path === '/receipt' || path === '/feeds' || path === '/tracer') await ph.screenshot({ path: 'help-phone-' + path.slice(1) + '.png' });
  }
  await ph.close();
  console.log(out.join('\n')); console.log('JS errors:', errors.length ? errors.join('|') : 'none');
  await browser.close();
})().catch(e => { console.log(out.join('\n')); console.log('TEST CRASH', e); process.exit(1); });
