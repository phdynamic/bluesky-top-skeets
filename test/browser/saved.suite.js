// End to end: the real server with GAMES_ENABLED, a fake AppView for the server's crawl, and the mocked
// Bluesky API for the browser's live trace. Trace, save, open the saved page, refresh, pick a version.
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const Database = require('better-sqlite3');
const { World, serve } = require('../helpers/fakeappview');
const { buildTree, install } = require('./tracermock');
const { CHROME } = require('./env');

const out = []; const ok = (n, c, x = '') => out.push((c ? 'PASS' : 'FAIL') + ': ' + n + (x ? ' — ' + x : ''));
const errors = [];
const ROOT_LINK = 'https://bsky.app/profile/root.bsky.social/post/r0';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function boot(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-e2e-'));
  const port = 21000 + Math.floor(Math.random() * 15000);
  const child = spawn('node', [path.join(__dirname, '..', '..', 'dist', 'index.js')], {
    env: { ...process.env, PORT: String(port), FEEDGEN_HOSTNAME: 'x.test', FEEDGEN_SERVICE_DID: 'did:web:x.test', DATA_DIR: dir, GAMES_ENABLED: 'true', GAMES_CRAWL_GAP_MS: '0', ...env }, stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const ready = (async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) return; } catch { /* not yet */ } await sleep(100); } throw new Error('server did not start'); })();
  return { dir, base, ready, stop: () => new Promise(r => { child.once('exit', r); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000).unref(); }) };
}
async function page(browser, o = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 }, colorScheme: 'light' }); const p = await ctx.newPage();
  const outside = [], violations = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => { if (/Content Security Policy|Refused to/.test(m.text())) violations.push(m.text().slice(0, 200)); });
  p.on('request', r => { const u = new URL(r.url()); if (u.hostname !== '127.0.0.1' && !/^data:/.test(r.url())) outside.push(r.url()); });
  if (o.mock !== false) await install(p, buildTree(60, 7), {});
  return { p, outside, violations, ctx };
}

(async () => {
  const world = new World();
  world.post('r0'); world.handles.set('root.bsky.social', world.did('r0'));
  world.tree('r0', { a: { a1: {}, a2: {} }, b: {}, c: { c1: { c1a: {} } } });
  const fake = await serve(world);
  const browser = await chromium.launch({ executablePath: CHROME });
  const s = boot({ APPVIEW_URL: fake.url, GAMES_REFRESH_COOLDOWN_HOURS: '0.0008', ADMIN_SECRET: 'e2e-admin-secret-long', TAKEDOWN_CONTACT: 'takedown@example.test', GAMES_RECHECK_COOLDOWN_MINUTES: '0' });
  try {
    await s.ready;
    // ---- live Tracer with the feature on
    const A = await page(browser);
    const live = await A.p.goto(s.base + '/tracer');
    ok('E1 live page has a script-only security policy', /script-src 'self'/.test(live.headers()['content-security-policy'] || ''));
    ok('E2 save bar is hidden before a trace', !(await A.p.locator('#savebar').isVisible()));
    await A.p.fill('#postInput', ROOT_LINK); await A.p.click('#go');
    await A.p.locator('#savebar').waitFor({ timeout: 20000 });
    ok('E3 after a trace, the save bar offers Save with the cap noted', /Saving keeps up to 5,000 quotes/.test(await A.p.locator('#savebar').innerText()));
    await A.p.click('#saveBtn');
    const dlgText = await A.p.locator('#saveDlg').innerText();
    ok('E4 the confirm box says what is stored and that the link goes to the server', /What this stores/.test(dlgText) && /does not keep images, avatars, likes/.test(dlgText) && /sends this post's link to our server/.test(dlgText));
    await A.p.click('#saveCancel'); ok('E5 Cancel closes it and saves nothing', !(await A.p.locator('#saveDlg').isVisible()) && new Database(path.join(s.dir, 'games.sqlite'), { readonly: true }).prepare('SELECT COUNT(*) c FROM game').get().c === 0);
    await A.p.click('#saveBtn'); await A.p.click('#saveGo');
    await A.p.waitForURL(/\/g\/[a-z0-9]{10}$/, { timeout: 20000 });
    const gameUrl = A.p.url(), id = gameUrl.split('/').pop();
    await A.p.locator('#snapReady').waitFor({ state: 'visible', timeout: 30000 });
    await A.p.locator('#tree .card').first().waitFor();
    ok('E6 the saved page shows the tree', (await A.p.locator('#tree .card').count()) > 0);
    ok('E7 banner: version, capture time, counts', /Version 1, captured .+\. 7 quotes, 3 levels deep\. Public posts only\. Some posts may be missing\./.test(await A.p.locator('#snapLine').innerText()), (await A.p.locator('#snapLine').innerText()).slice(0, 120));
    ok('E8 saved mode: page says Saved game, live form is gone', (await A.p.locator('h1:visible').first().innerText()) === 'Saved game' && !(await A.p.locator('#postInput').isVisible()));
    ok('E9 text only: no images in the tree, initials instead', (await A.p.locator('#tree img, #rootcard img, #tree .media').count()) === 0);
    ok('E10 no post addresses or avatars in the page', !/at:\/\/|cdn\.bsky\.app/.test(await A.p.content()));
    ok('E11 no security-policy violations anywhere in the flow', A.violations.length === 0, A.violations.join(' | '));

    // ---- opening the saved link cold: nothing leaves this server
    const B = await page(browser, { mock: false });
    const nav = await B.p.goto(gameUrl);
    await B.p.locator('#snapReady').waitFor({ state: 'visible', timeout: 20000 }); await B.p.locator('#tree .card').first().waitFor();
    const h = nav.headers();
    ok('E12 saved page: no request to Bluesky, its CDN, fonts or anyone else', B.outside.length === 0, B.outside.join(',') || 'none');
    ok('E13 saved page security policy forbids outside connections and images', /connect-src 'self'/.test(h['content-security-policy']) && /img-src 'self' data:/.test(h['content-security-policy']) && /default-src 'none'/.test(h['content-security-policy']));
    ok('E14 saved page is noindex (header and tag) and sends no referrer', /noindex/.test(h['x-robots-tag']) && /noindex/.test(await B.p.locator('meta[name=robots]').getAttribute('content')) && h['referrer-policy'] === 'no-referrer');
    ok('E15 the page itself would stop a script from calling Bluesky', await B.p.evaluate(async () => { try { await fetch('https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=bsky.app'); return false; } catch (e) { return true; } }));
    ok('E16 no violations on the cold open', B.violations.filter(v => !/public\.api\.bsky\.app/.test(v)).length === 0, B.violations.join(' | '));

    // ---- refresh
    await sleep(3300);   // the test server's cooldown is about three seconds
    await B.p.reload(); await B.p.locator('#snapReady').waitFor({ state: 'visible' });
    ok('E17 after the cooldown the Refresh button is enabled', await B.p.locator('#refreshBtn').isEnabled());
    world.quote('a', 'newq1', 'newq2');
    await B.p.click('#refreshBtn');
    await B.p.waitForFunction(() => /Version 2, captured/.test(document.getElementById('snapLine').textContent), null, { timeout: 30000 });
    ok('E18 refresh makes version 2 and reloads into it', /9 quotes/.test(await B.p.locator('#snapLine').innerText()), await B.p.locator('#snapLine').innerText());
    ok('E19 version picker lists both versions with the change', (await B.p.locator('#versionPick option').count()) === 2 && /\+2 quotes/.test(await B.p.locator('#versionPick option').nth(1).innerText()), (await B.p.locator('#versionPick option').allInnerTexts()).join(' | '));
    ok('E20 the cooldown starts again after a refresh', await B.p.locator('#refreshBtn').isDisabled() && /You can refresh again in/.test(await B.p.locator('#refreshNote').innerText()), await B.p.locator('#refreshNote').innerText());
    await B.p.selectOption('#versionPick', '1');
    await B.p.waitForURL(new RegExp('/g/' + id + '/v/1$'));
    await B.p.locator('#snapReady').waitFor({ state: 'visible' });
    ok('E21 version 1 is still as it was, with a note about the newer one and no Refresh', /Version 1,.*7 quotes/.test(await B.p.locator('#snapLine').innerText()) && /older version/.test(await B.p.locator('#snapLatest').innerText()) && !(await B.p.locator('#refreshBtn').isVisible()));

    // ---- saving the same game again goes to the existing one
    await A.p.goto(s.base + '/tracer'); await A.p.fill('#postInput', ROOT_LINK); await A.p.click('#go');
    await A.p.locator('#savebar').waitFor({ timeout: 20000 }); await A.p.click('#saveBtn'); await A.p.click('#saveGo');
    await A.p.waitForURL(/\/g\/[a-z0-9]{10}$/);
    await A.p.locator('#snapExists').waitFor({ state: 'visible', timeout: 20000 });
    ok('E22 saving again lands on the same game with a note', A.p.url() === gameUrl && /already has a snapshot/.test(await A.p.locator('#snapExists').innerText()));

    // ---- report, policy, re-check (still on the cold-open page B)
    await B.p.goto(gameUrl); await B.p.locator('#snapReady').waitFor({ state: 'visible' }); await B.p.locator('#tree .card').first().waitFor();
    await B.p.locator('#tree [data-a="report"]:visible').nth(1).click();
    ok('E26 a card Report button opens the report box, naming the card', /reporting one card by @/.test(await B.p.locator('#reportAbout').innerText()));
    await B.p.click('#reportSend');
    ok('E27 sending with no reason asks for one', /Pick a reason/.test(await B.p.locator('#reportErr').innerText()));
    await B.p.check('input[value=removal]');
    ok('E28 choosing "Remove my post" shows the delete-it-on-Bluesky hint', await B.p.locator('#removalHint').isVisible());
    await B.p.fill('#reportNote', 'this one is mine'); await B.p.click('#reportSend');
    await B.p.locator('#reportOk').waitFor({ state: 'visible' });
    ok('E29 report accepted with the plain thank-you', /Thanks\. We've got it\./.test(await B.p.locator('#reportOk').innerText()));
    await B.p.click('#reportCancel');
    await B.p.click('#reportGame'); await B.p.check('input[value=harassment]'); await B.p.click('#reportSend'); await B.p.locator('#reportOk').waitFor({ state: 'visible' }); await B.p.click('#reportCancel');
    const db = new Database(path.join(s.dir, 'games.sqlite'), { readonly: true });
    const reps = db.prepare('SELECT * FROM report ORDER BY id').all();
    ok('E30 two reports stored, one on a card and one on the game, with no sender information', reps.length === 2 && reps[0].node_id !== null && reps[1].node_id === null && Object.keys(reps[0]).join() === 'id,game_id,node_id,reason,note,created_at,status,resolved_at', JSON.stringify(reps.map(r => r.reason)));
    const href = await B.p.locator('a[href="/g/about"]').getAttribute('href');
    ok('E31 the saved page links to the policy page', href === '/g/about');
    await B.p.click('#recheckBtn'); await B.p.waitForFunction(() => document.getElementById('recheckNote').textContent.length > 0);
    ok('E32 "Check for deleted posts" answers', /Checking for deleted posts|checked recently|already running/.test(await B.p.locator('#recheckNote').innerText()), await B.p.locator('#recheckNote').innerText());
    await B.p.goto(s.base + '/g/about');
    ok('E33 the policy page loads, shows the takedown address, is noindex and keeps the shared footer', /How saved games work/.test(await B.p.locator('h1').innerText()) && /takedown@example\.test/.test(await B.p.locator('.contact').first().innerText()) && /Support these projects on Ko-fi/.test(await B.p.locator('footer.k-foot').innerText()));

    // ---- admin page
    const AD = await page(browser, { mock: false });
    const adminNav = await AD.p.goto(s.base + '/admin');
    ok('E34 admin page: no outside requests, strict policy, never cached', /script-src 'self'/.test(adminNav.headers()['content-security-policy']) && adminNav.headers()['cache-control'] === 'no-store');
    await AD.p.fill('#secret', 'wrong'); await AD.p.click('#signIn');
    await AD.p.locator('#loginErr').waitFor({ state: 'visible' });
    ok('E35 a wrong secret is refused', /Wrong or missing admin secret/.test(await AD.p.locator('#loginErr').innerText()) && !(await AD.p.locator('#app').isVisible()));
    await AD.p.fill('#secret', 'e2e-admin-secret-long'); await AD.p.click('#signIn');
    await AD.p.locator('#app').waitFor({ state: 'visible' });
    await AD.p.locator('#reports .card').first().waitFor();
    ok('E36 signed in: the open reports are listed with the card text and reason', (await AD.p.locator('#reports .card').count()) === 2 && /Remove my post/i.test(await AD.p.locator('#reports').innerText()) && /this one is mine/.test(await AD.p.locator('#reports').innerText()), (await AD.p.locator('#reports .card').count()) + ' cards: ' + (await AD.p.locator('#reports').innerText()).replace(/\n/g, ' | ').slice(0, 300));
    ok('E37 the open count shows', /2 open/i.test(await AD.p.locator('#openCount').innerText()), await AD.p.locator('#openCount').innerText());
    const wipeBtn = AD.p.locator('#reports button', { hasText: 'Wipe this card' }).first();
    await wipeBtn.click(); await AD.p.waitForFunction(() => /Card wiped/.test(document.getElementById('msg').textContent));
    await AD.p.reload(); await AD.p.locator('#reports .card').first().waitFor();
    ok('E38 wiping a card works and the admin stays signed in for the tab', /already wiped/.test(await AD.p.locator('#reports').innerText()));
    await AD.p.locator('#reports button', { hasText: 'Mark resolved' }).first().click();
    await AD.p.waitForFunction(() => document.querySelectorAll('#reports .card').length === 1);
    ok('E39 resolving a report removes it from the open list', true);
    await B.p.goto(gameUrl); await B.p.locator('#snapReady').waitFor({ state: 'visible' }); await B.p.locator('#tree .card').first().waitFor();
    ok('E40 the wiped card now shows as a placeholder on the saved page', (await B.p.locator('#tree .card.tomb').count()) >= 1);
    ok('E40b the banner counts it as deleted or removed', /\(1 deleted or removed\)/.test(await B.p.locator('#snapLine').innerText()), await B.p.locator('#snapLine').innerText());
    await AD.p.click('[data-tab=lookup]'); await AD.p.fill('#q', id); await AD.p.click('#find');
    await AD.p.locator('#found .card').waitFor();
    ok('E41 look up a game by id and see its counts', /Game /.test(await AD.p.locator('#found').innerText()) && /live,/.test(await AD.p.locator('#found').innerText()));
    AD.p.on('dialog', d => d.accept());
    await AD.p.locator('#found button', { hasText: 'Hide game' }).click(); await AD.p.locator('#found button', { hasText: 'Unhide' }).waitFor();
    await B.p.goto(gameUrl); await B.p.locator('#snapError').waitFor({ state: 'visible', timeout: 10000 });
    ok('E42 hiding a game makes its saved page say it is not available', (await B.p.locator('#snapError').innerText()) === "This game isn't available.");
    await AD.p.locator('#found button', { hasText: 'Unhide' }).click(); await AD.p.locator('#found button', { hasText: 'Hide game' }).waitFor();
    await B.p.goto(gameUrl); await B.p.locator('#snapReady').waitFor({ state: 'visible', timeout: 10000 });
    ok('E43 unhiding brings it back', true);
    await AD.p.click('[data-tab=log]'); await AD.p.locator('#log p').first().waitFor();
    ok('E44 the log lists the actions without any reporter details', /node\./.test(await AD.p.locator('#log').innerText()) && /game\.hide/.test(await AD.p.locator('#log').innerText()), (await AD.p.locator('#log').innerText()).replace(/\n/g, ' | ').slice(0, 300));
    ok('E45 no violations on the admin page', AD.violations.length === 0, AD.violations.join(' | '));

    // ---- frozen
    new Database(path.join(s.dir, 'games.sqlite')).prepare('UPDATE game SET frozen = 1 WHERE id = ?').run(id);
    await sleep(1500);
    await B.p.goto(gameUrl); await B.p.locator('#snapReady').waitFor({ state: 'visible' });
    ok('E23 a frozen game says so, has no Refresh, and can still be read', !(await B.p.locator('#refreshBtn').isVisible()) && /frozen by the person who wrote the original post/.test(await B.p.locator('#refreshNote').innerText()) && (await B.p.locator('#tree .card').count()) > 0);

    // ---- unavailable
    for (const bad of ['/g/aaaaaaaaaa', '/g/not-a-real-id', '/g/' + id + '/v/99']) {
      await B.p.goto(s.base + bad); await B.p.locator('#snapError').waitFor({ state: 'visible', timeout: 10000 });
      ok('E24 ' + bad + ' says this game is not available', (await B.p.locator('#snapError').innerText()) === "This game isn't available.");
    }
  } finally { await s.stop(); }

  // ---- the default cooldown
  const s2 = boot({ APPVIEW_URL: fake.url });
  try {
    await s2.ready;
    const A = await page(browser);
    await A.p.goto(s2.base + '/tracer'); await A.p.fill('#postInput', ROOT_LINK); await A.p.click('#go');
    await A.p.locator('#savebar').waitFor({ timeout: 20000 }); await A.p.click('#saveBtn'); await A.p.click('#saveGo');
    await A.p.waitForURL(/\/g\/[a-z0-9]{10}$/); await A.p.locator('#snapReady').waitFor({ state: 'visible', timeout: 30000 });
    ok('E25 default cooldown shows the time left and disables Refresh', await A.p.locator('#refreshBtn').isDisabled() && /You can refresh again in (5\.9|6) hours?|You can refresh again in 6 hours/.test(await A.p.locator('#refreshNote').innerText()), await A.p.locator('#refreshNote').innerText());
  } finally { await s2.stop(); await fake.close(); await browser.close(); }
  console.log(out.join('\n')); console.log('JS errors:', errors.length ? errors.join('|') : 'none');
})();
