// The browser-tab icon: PK badge by default, your Bluesky avatar once it has loaded, remembered for the next page.
const { chromium } = require('playwright-core');
const out = [], errors = [];
const ok = (n, c, x = '') => out.push((c ? 'PASS' : 'FAIL') + ': ' + n + (x ? ' — ' + x : ''));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const AV = 'https://cdn.bsky.app/img/avatar/plain/did:plc:x/abc@jpeg';
const PAGES = ['/', '/feeds', '/tracer', '/imagine-flagons', '/receipt', '/jokeweb', '/mashup'];
(async () => {
  const browser = await chromium.launch({ executablePath: require('./env').CHROME });
  async function mk(profile) {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.route(/fonts\.(googleapis|gstatic)/, r => r.abort());
    await page.route('https://cdn.bsky.app/**', r => r.fulfill({ contentType: 'image/png', body: PNG }));
    await page.route('https://public.api.bsky.app/**', r => {
      const u = new URL(r.request().url());
      if (u.pathname.endsWith('getProfile')) return r.fulfill({ status: profile ? 200 : 500, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify(profile || {}) });
      return r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '{}' });
    });
    return page;
  }
  const icon = page => page.evaluate(() => { const l = document.querySelector('link[rel="icon"]'); return l ? l.getAttribute('href') : null; });
  // every page has the fallback icon, and it is a real file
  const p0 = await mk(null);
  for (const pg of PAGES) { await p0.goto('http://localhost:3988' + pg); await p0.waitForTimeout(150); ok('I1 ' + pg + ' has the PK badge icon when Bluesky is unreachable', (await icon(p0)) === '/favicon.svg'); }
  const svg = await p0.evaluate(() => fetch('/favicon.svg').then(r => r.text().then(t => ({ ok: r.ok, type: r.headers.get('content-type'), t }))));
  ok('I2 favicon.svg is served as an SVG', svg.ok && /svg/.test(svg.type) && /<svg/.test(svg.t), svg.type);
  await p0.close();
  // avatar replaces it, and is remembered
  const p1 = await mk({ avatar: AV });
  await p1.goto('http://localhost:3988/mashup'); await p1.waitForFunction(a => document.querySelector('link[rel="icon"]').getAttribute('href') === a, AV, { timeout: 5000 }).catch(() => {});
  ok('I3 the live avatar becomes the tab icon once it has loaded', (await icon(p1)) === AV, await icon(p1));
  await p1.route('https://public.api.bsky.app/**', r => r.abort());
  await p1.goto('http://localhost:3988/receipt');
  ok('I4 the next page opens with the remembered avatar straight away', (await icon(p1)) === AV, await icon(p1));
  await p1.close();
  // a bad avatar address never replaces the icon
  const p2 = await mk({ avatar: 'javascript:alert(1)' });
  await p2.goto('http://localhost:3988/'); await p2.waitForTimeout(400);
  ok('I5 a non-https avatar value is ignored', (await icon(p2)) === '/favicon.svg');
  await p2.close();
  console.log(out.join('\n')); console.log('JS errors:', errors.length ? errors.join('|') : 'none');
  await browser.close();
})().catch(e => { console.log(out.join('\n')); console.log('TEST CRASH', e); process.exit(1); });
