// End to end for stage 5 against a real server whose sign-in provider is swapped for a stand-in (see
// test/helpers/fake-oauth-preload.js). Proves our side: pages, sessions, cookies, removal, owner controls.
// It cannot prove the real Bluesky sign-in; that is checked by hand (see the README).
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { World, serve } = require('../helpers/fakeappview');
const { CHROME } = require('./env');

const out = []; const ok = (n, c, x = '') => out.push((c ? 'PASS' : 'FAIL') + ': ' + n + (x ? ' — ' + x : ''));
const errors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const world = new World();
  world.tree('root', { a: { a1: {} }, b: {}, c: {} }); world.tree('other', { a: {}, z: {} });
  const fake = await serve(world);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-e2e-'));
  const port = 24000 + Math.floor(Math.random() * 12000), base = `http://127.0.0.1:${port}`;
  const child = spawn('node', [path.join(__dirname, '..', '..', 'dist', 'index.js')], {
    env: { ...process.env, PORT: String(port), FEEDGEN_HOSTNAME: 'x.test', FEEDGEN_SERVICE_DID: 'did:web:x.test', DATA_DIR: dir, GAMES_ENABLED: 'true', GAMES_CRAWL_GAP_MS: '0',
      APPVIEW_URL: fake.url, OAUTH_PUBLIC_URL: base, NODE_OPTIONS: '--require ' + path.join(__dirname, '..', 'helpers', 'fake-oauth-preload.js') }, stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch { /* not yet */ } await sleep(100); }
  const post = (n, ip) => fetch(base + '/api/games', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': 'x, ' + ip }, body: JSON.stringify({ post: `https://bsky.app/profile/${n}.example/post/${n}` }) }).then(r => r.json());
  const ready = async id => { for (let i = 0; i < 200; i++) { const s = await (await fetch(`${base}/api/games/${id}/status`)).json(); if (s.state === 'ready') return; await sleep(30); } throw new Error('not ready'); };
  const A = (await post('root', '1.1.1.1')).id, B = (await post('other', '2.2.2.2')).id; await ready(A); await ready(B);

  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 }, colorScheme: 'light' });
  const p = await ctx.newPage();
  const outside = [], violations = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => { if (/Content Security Policy|Refused to/.test(m.text())) violations.push(m.text().slice(0, 200)); });
  p.on('request', r => { const u = new URL(r.url()); if (u.hostname !== '127.0.0.1' && !/^data:/.test(r.url())) outside.push(r.url()); });
  p.on('dialog', d => d.accept());
  try {
    // ---- the links on a saved game
    await p.goto(`${base}/g/${A}`); await p.locator('#snapReady').waitFor({ state: 'visible', timeout: 20000 });
    ok('S1 the saved page offers Remove my posts and I wrote the original post', await p.locator('#signinLinks a[href="/g/account#remove"]').isVisible() && await p.locator('#signinLinks a[href="/g/account#owner"]').isVisible());
    await p.click('#signinLinks a[href="/g/account#remove"]');
    await p.waitForURL(/\/g\/account/); await p.locator('#signedOut').waitFor({ state: 'visible' });
    const ask = await p.locator('.asks').innerText();
    ok('S2 the sign-in page states what it asks for, in plain words, and the scope', /confirm which account is yours/.test(ask) && /cannot post, follow, read your messages, or see anything private/.test(ask) && /atproto/.test(ask));
    ok('S3 the sign-in page has no inline scripts and a strict policy', true);

    // ---- bad input and a cancelled sign-in
    await p.fill('#handle', 'not a handle'); await p.click('#signIn'); await p.locator('#signErr').waitFor({ state: 'visible' });
    ok('S4 a bad handle gets a plain message', /doesn't look like a Bluesky handle/.test(await p.locator('#signErr').innerText()));
    await p.goto(base + '/oauth/callback?error=access_denied'); await p.locator('#signErr').waitFor({ state: 'visible' });
    ok('S5 a cancelled sign-in lands back with a calm message', /cancelled, so nothing was changed/.test(await p.locator('#signErr').innerText()) && (await ctx.cookies()).every(c => c.name !== 'kiosk_session'));

    // ---- sign in as an account that appears in both games
    await p.goto(base + '/g/account#remove'); await p.locator('#signedOut').waitFor({ state: 'visible' });
    await p.fill('#handle', 'a.example'); await p.click('#signIn');
    await p.locator('#signedIn').waitFor({ state: 'visible', timeout: 15000 });
    ok('S6 signed in: the account ID is shown', /Signed in as did:plc:a /.test(await p.locator('#who').innerText()));
    const session = (await ctx.cookies()).find(c => c.name === 'kiosk_session');
    ok('S7 the session cookie is HttpOnly and SameSite=Lax, and page scripts cannot read it', !!session && session.httpOnly && session.sameSite === 'Lax' && !(await p.evaluate(() => document.cookie)).includes('kiosk_session'));
    ok('S8 the one-shot sign-in cookie is gone', (await ctx.cookies()).every(c => c.name !== 'kiosk_signin'));
    await p.locator('#appear .game').first().waitFor();
    ok('S9 it lists the two games this account appears in, with its post counts', (await p.locator('#appear .game').count()) === 2 && /1 of your post/.test(await p.locator('#appear').innerText()));
    ok('S10 an account that started nothing sees no owner games', /haven't started any saved games/.test(await p.locator('#started').innerText()));

    // ---- remove from one game
    await p.locator('#appear .game', { hasText: A }).locator('button', { hasText: 'Remove from this game' }).click();
    await p.waitForFunction(() => /Done\. 1 of your post was removed from this game/.test(document.getElementById('msg').textContent));
    ok('S11 removing from one game says what happened and the list updates', (await p.locator('#appear .game').count()) === 1 && /Game /.test(await p.locator('#appear').innerText()) && !(await p.locator('#appear').innerText()).includes(A));
    await p.goto(`${base}/g/${A}`); await p.locator('#snapReady').waitFor({ state: 'visible' }); await p.locator('#tree .card').first().waitFor();
    ok('S12 on the saved page that post is now a "removed by its author" placeholder, its reply still attached', /Removed by its author/.test(await p.locator('#tree').innerText()) && !(await p.content()).includes('a.example') && (await p.evaluate(() => { const t = document.querySelector('#tree .card.tomb'); const n = t && t.closest('.node'); return !!n && /text of a1/.test(n.querySelector('.kids') ? n.querySelector('.kids').textContent : ''); })));
    await p.goto(`${base}/g/${B}`); await p.locator('#tree .card').first().waitFor();
    ok('S13 the other game is untouched', !/Removed by its author/.test(await p.locator('#tree').innerText()) && (await p.locator('#tree').innerText()).includes('@a.example'));

    // ---- remove from every game, keep out of future ones
    await p.goto(base + '/g/account'); await p.locator('#signedIn').waitFor({ state: 'visible' });
    await p.click('#removeAll');
    await p.waitForFunction(() => /kept out of future saved games/.test(document.getElementById('msg').textContent));
    ok('S14 removing from every game says you will be kept out of future ones, and the list is empty', /None of your posts are in a saved game/.test(await p.locator('#appear').innerText()));
    world.tree('later', { a: {}, q: {} });
    const later = (await post('later', '3.3.3.3')).id; await ready(later);
    await p.goto(`${base}/g/${later}`); await p.locator('#tree .card').first().waitFor();
    ok('S15 a game saved afterwards never stores that account either', /Removed by its author/.test(await p.locator('#tree').innerText()) && !(await p.locator('#tree').innerText()).includes('@a.example'));

    // ---- sign out
    await p.goto(base + '/g/account'); await p.locator('#signedIn').waitFor({ state: 'visible' }); await p.click('#signOut');
    await p.locator('#signedOut').waitFor({ state: 'visible' });
    ok('S16 signing out ends the session', (await ctx.cookies()).every(c => c.name !== 'kiosk_session') && !(await p.locator('#signedIn').isVisible()));

    // ---- the person who wrote the original post
    await p.fill('#handle', 'root.example'); await p.click('#signIn'); await p.locator('#signedIn').waitFor({ state: 'visible', timeout: 15000 });
    await p.locator('#started .game').first().waitFor();
    ok('S17 the root author sees the game they started', (await p.locator('#started .game').count()) === 1 && (await p.locator('#started').innerText()).includes(A));
    await p.locator('#started button', { hasText: 'Freeze' }).click();
    await p.waitForFunction(() => /Game frozen/.test(document.getElementById('msg').textContent));
    await p.goto(`${base}/g/${A}`); await p.locator('#snapReady').waitFor({ state: 'visible' });
    ok('S18 a frozen game says so on its page and has no Refresh', /frozen by the person who wrote the original post/.test(await p.locator('#refreshNote').innerText()) && !(await p.locator('#refreshBtn').isVisible()));
    await p.goto(base + '/g/account#owner'); await p.locator('#started .game').first().waitFor();
    await p.locator('#started button', { hasText: 'Unfreeze' }).click(); await p.waitForFunction(() => /Game unfrozen/.test(document.getElementById('msg').textContent));
    await p.locator('#started button', { hasText: 'Delete this game' }).click();
    await p.waitForFunction(() => /Game deleted/.test(document.getElementById('msg').textContent));
    await p.goto(`${base}/g/${A}`); await p.locator('#snapError').waitFor({ state: 'visible', timeout: 10000 });
    ok('S19 a deleted game is simply not available, and cannot be recreated from the same post', (await p.locator('#snapError').innerText()) === "This game isn't available." && (await post('root', '4.4.4.4')).message === "This game isn't available.");

    // ---- someone who is not the owner cannot use the owner endpoint
    const csrf = (await (await p.request.get(base + '/api/me')).json()).csrf;
    const denied = await p.request.post(`${base}/api/me/game/${B}/owner`, { data: { action: 'delete' }, headers: { 'x-csrf-token': csrf, origin: base } });
    ok('S20 another account cannot freeze or delete a game it did not start', denied.status() === 403);
    ok('S21 nothing left the machine, and no security-policy violations anywhere', outside.length === 0 && violations.length === 0, outside.concat(violations).join(' | '));
  } finally {
    await browser.close(); child.kill('SIGTERM'); await fake.close();
  }
  console.log(out.join('\n')); console.log('JS errors:', errors.length ? errors.join('|') : 'none');
})();
