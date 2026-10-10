// The Bluesky Tutorials page: text comes from /tutorials.txt, shown as cards.
const { chromium } = require('playwright-core');
const fs = require('fs'), path = require('path');
const out = [], errors = [];
const ok = (n, c, x = '') => out.push((c ? 'PASS' : 'FAIL') + ': ' + n + (x ? ' — ' + x : ''));
const BASE = 'http://localhost:3988/tutorials';
const TXT = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'tutorials.txt'), 'utf8');
(async () => {
  // text-file rules (what the author asked for and what must not creep back in)
  const lower = TXT.toLowerCase();
  ok('T1 the text has no em or en dashes', !/[—–]/.test(TXT));
  ok('T2 it uses "subskeet" and never "subtweet", and leaves out @\'ing', lower.includes('subskeet') && !lower.includes('subtweet') && !TXT.includes("@'ing"));
  ok('T3 it never tells people to save material for original posts, and calls reply guy-ing an art', !/save material/i.test(TXT) && /reply guy-ing is its own art/i.test(TXT) && /compliment to the shitposter/i.test(TXT));
  ok('T4 no joke-thief or buying-followers advice', !/thie(f|ves)/i.test(TXT) && !/buy(ing)? (your )?followers/i.test(TXT) && !/purchase.*follower/i.test(TXT));
  ok('T5 no Bluesky search links in bios', !/search\?q=/i.test(TXT) && !/search link/i.test(TXT));
  ok('T6a no follow-train advice, no hashtag skeets, no "When people can\'t find your posts" section', !/follow train|follow-for-follow/i.test(TXT) && !/summed up in these three skeets|just don't go together|glorified hashtags/i.test(TXT) && !/can't find your posts/i.test(TXT) && /A word on hashtags/.test(TXT));
  ok('T6b it says Shitsky, never "joke Bluesky"', /Shitsky/.test(TXT) && !/joke bluesky/i.test(TXT));
  ok('T6c images: up to ten, grid up to four, carousel above that', /up to ten images/.test(TXT) && /up to four/.test(TXT) && /carousel/.test(TXT) && !/up to four images to a post/.test(TXT));
  ok('T6d timeline and DM facts match Bluesky: Following Feed Preferences, Mute words & tags, detach quote, default follows-only DMs, group chats, Send via direct message', /Following Feed Preferences/.test(TXT) && /Mute words & tags/.test(TXT) && /Moderation/.test(TXT) && /detach their quote/.test(TXT) && /only people you follow can message you/.test(TXT) && /Group chats arrived in June 2026/.test(TXT) && /up to 50 people/.test(TXT) && /Send via direct message/.test(TXT) && /muting them does not/.test(TXT));
  ok('T6e deck.blue is a link and the SkyFeed video is included', /\[deck\.blue\]\(https:\/\/deck\.blue\)/.test(TXT) && /!\[[^\]]+\]\(\/media\/skyfeed-personal-feed\.mp4\)/.test(TXT) && fs.existsSync(path.join(__dirname, '..', '..', 'public', 'media', 'skyfeed-personal-feed.mp4')) && fs.existsSync(path.join(__dirname, '..', '..', 'public', 'media', 'skyfeed-personal-feed.jpg')));
  ok('T6f the Top Skeets paragraph opens with the "too technical or complicated" line and links to the feed maker', /If that's too technical or complicated to bother with, then you can try \[my feed maker, Top Skeets\]\(\/feeds\)\./.test(TXT));
  ok('T6 plugs SkyFeed and the feed maker (Top Skeets and My Skeets), and points to the profile search under the triple dots', /skyfeed\.app/i.test(TXT) && /\]\(\/feeds\)/.test(TXT) && /Top Skeets/.test(TXT) && /My Skeets/.test(TXT) && /triple dots/i.test(TXT) && /Search posts/.test(TXT));

  const browser = await chromium.launch({ executablePath: require('./env').CHROME });
  async function mk(vp = { width: 1100, height: 900 }, scheme = 'light') {
    const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme }); const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.route(/fonts\.(googleapis|gstatic)/, r => r.abort());
    await page.route('https://public.api.bsky.app/**', r => r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
    return page;
  }
  const page = await mk(); await page.goto(BASE); await page.waitForSelector('#cards .card');
  const info = await page.evaluate(() => ({ cards: document.querySelectorAll('#cards .card').length, toc: document.querySelectorAll('#toc a').length, h2: [...document.querySelectorAll('#cards .card h2')].map(h => h.textContent), intro: document.getElementById('intro').textContent, links: [...document.querySelectorAll('#cards a')].map(a => a.getAttribute('href')), tag: document.querySelector('.k-hero .k-tag').textContent }));
  const wanted = (TXT.match(/^## /gm) || []).length;
  ok('T7 every ## heading in the text file becomes a card with a contents chip', info.cards === wanted && info.toc === wanted && wanted >= 12 && wanted === 13, JSON.stringify([info.cards, info.toc, wanted]));
  ok('T8 the introduction comes from the text before the first heading', /technical side of Bluesky/.test(info.intro), info.intro.slice(0, 50));
  ok('T9 links work: site pages stay on the site, others open in a new tab', info.links.includes('/tracer') && info.links.includes('/feeds') && info.links.includes('https://skyfeed.app') && await page.locator('#cards a[href^="https://"]').first().getAttribute('target') === '_blank');
  ok('T10 the page has no skeet-style numbering or counters', !(await page.locator('.skeet, [data-count]').count()));
  const lang = await page.evaluate(() => { const c = [...document.querySelectorAll('#cards .card')][0]; return { ul: c.querySelectorAll('ul li').length, bold: c.querySelectorAll('li strong').length }; });
  ok('T11 lists and bold terms render (the language card)', lang.ul >= 10 && lang.bold >= 10, JSON.stringify(lang));
  const dos = await page.evaluate(() => document.querySelectorAll('#do-s-and-don-ts ol li, #dos-and-donts ol li').length || [...document.querySelectorAll('#cards .card')].find(c => /Do's and don'ts/.test(c.querySelector('h2').textContent)).querySelectorAll('ol li').length);
  ok('T12 the do\'s and don\'ts are a numbered list of ten', dos === 10, String(dos));
  const layout = await page.evaluate(() => { const c = document.querySelectorAll('#cards .card'); const s = getComputedStyle(c[0]); return { panel: c[0].classList.contains('k-panel'), border: s.borderTopWidth, radius: s.borderTopLeftRadius, accents: new Set([...c].slice(0, 6).map(x => x.style.getPropertyValue('--accent'))).size, over: document.documentElement.scrollWidth > innerWidth + 1 }; });
  ok('T13 cards use the site card style with rotating accent colors, no sideways scroll', layout.panel && layout.border === '3px' && layout.accents === 6 && !layout.over, JSON.stringify(layout));
  ok('T14 footer, night mode button and hero match the other pages', await page.locator('footer.k-foot .kofi').count() === 1 && await page.locator('#themeToggle').count() === 1 && /Guide 01/.test(info.tag));
  const vid = await page.evaluate(() => { const v = document.querySelector('#cards figure video'); const card = v && v.closest('.card'); return v ? { src: v.getAttribute('src'), poster: v.getAttribute('poster'), controls: v.controls, card: card.querySelector('h2').textContent, label: v.getAttribute('aria-label'), steps: card.querySelectorAll('ol li').length, w: v.getBoundingClientRect().width, cw: card.getBoundingClientRect().width, deck: [...document.querySelectorAll('#cards a')].some(a => a.getAttribute('href') === 'https://deck.blue') } : null; });
  ok('T19 the SkyFeed video sits in the Feeds card with controls, a poster, a text label and the seven written steps under it', vid && vid.card === 'Feeds' && vid.src === '/media/skyfeed-personal-feed.mp4' && vid.poster === '/media/skyfeed-personal-feed.jpg' && vid.controls && /SkyFeed/.test(vid.label) && vid.steps >= 7 && vid.w > 300, JSON.stringify(vid));
  ok('T20 deck.blue is a real link', vid && vid.deck);
  const files = await page.evaluate(async () => { const h = await fetch('/media/skyfeed-personal-feed.mp4', { headers: { Range: 'bytes=0-1023' } }); const p = await fetch('/media/skyfeed-personal-feed.jpg'); return { range: h.status, mp4: h.headers.get('content-type'), jpg: p.ok && /image\/jpeg/.test(p.headers.get('content-type')) }; });
  ok('T21 the video and poster are served (video supports range requests)', files.range === 206 && /video\/mp4/.test(files.mp4) && files.jpg, JSON.stringify(files));
  await page.screenshot({ path: 'tut-desktop.png', fullPage: true });
  await page.click('#toc a:nth-child(1)'); await page.close();

  // the parser handles the format, and typed markup never runs
  const p2 = await mk();
  await p2.route('**/tutorials.txt', r => r.fulfill({ contentType: 'text/plain; charset=utf-8', body: ';; a note\nIntro with **bold** and [a site link](/feeds).\n\n## First <b>card</b>\n\nPlain paragraph\ncontinued on a second line.\n\n- one\n- two *italic*\n\n1. first\n2. second\n\nText with [bad](javascript:window.__pwn=1) link and <img src=x onerror="window.__pwn=2"> and <script>window.__pwn=3</script>.\n\n## Second\n\nDone.\n' }));
  await p2.goto(BASE); await p2.waitForSelector('#cards .card');
  const r = await p2.evaluate(() => ({ cards: document.querySelectorAll('#cards .card').length, note: document.body.textContent.includes('a note'), h2: document.querySelector('#cards .card h2').textContent, para: document.querySelector('#cards .card p').textContent, ul: document.querySelectorAll('#cards ul li').length, ol: document.querySelectorAll('#cards ol li').length, em: !!document.querySelector('#cards li em'), pwn: window.__pwn, badLink: !!document.querySelector('a[href^="javascript"]'), imgs: document.querySelectorAll('#cards img, #cards script, #cards b').length, intro: document.getElementById('intro').innerHTML }));
  ok('T15 comments are hidden, headings, paragraphs and both list kinds parse', r.cards === 2 && !r.note && r.h2 === 'First <b>card</b>' && r.para === 'Plain paragraph continued on a second line.' && r.ul === 2 && r.ol === 2 && r.em, JSON.stringify(r));
  ok('T16 typed markup shows as text and never runs; javascript: links are dropped', r.pwn === undefined && !r.badLink && r.imgs === 0 && /<strong>bold<\/strong>/.test(r.intro) && /href="\/feeds"/.test(r.intro));
  await p2.close();
  // failure and phone
  const p3 = await mk(); await p3.route('**/tutorials.txt', r => r.fulfill({ status: 500, body: 'x' })); await p3.goto(BASE); await p3.waitForSelector('#cards .msg');
  ok('T17 if the text can not be loaded the page says so', /could not be loaded/.test(await p3.innerText('#cards')));
  await p3.close();
  const ph = await mk({ width: 390, height: 800 }, 'dark'); await ph.goto(BASE); await ph.waitForSelector('#cards .card');
  ok('T18 phone and dark mode: no sideways scroll', await ph.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await ph.screenshot({ path: 'tut-phone.png' }); await ph.close();
  console.log(out.join('\n')); console.log('JS errors:', errors.length ? errors.join('|') : 'none');
  await browser.close();
})().catch(e => { console.log(out.join('\n')); console.log('TEST CRASH', e); process.exit(1); });
