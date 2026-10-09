const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function boot(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'games-flag-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn('node', [path.join(__dirname, '..', 'dist', 'index.js')], {
    env: { ...process.env, PORT: String(port), FEEDGEN_HOSTNAME: 'x.test', FEEDGEN_SERVICE_DID: 'did:web:x.test', DATA_DIR: dir, GAMES_ENABLED: '', ...env }, stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const ready = (async () => { for (let i = 0; i < 100; i++) { try { const r = await fetch(base + '/health'); if (r.ok) return; } catch { /* not yet */ } await new Promise(r => setTimeout(r, 100)); } throw new Error('server did not start'); })();
  const stop = () => new Promise(r => { child.once('exit', r); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000).unref(); });
  return { dir, base, ready, stop };
}

test('flag off: no games routes, no database file, nothing changes for the site', async () => {
  const s = boot({});
  try {
    await s.ready;
    const post = await fetch(s.base + '/api/games', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"post":"x"}' });
    assert.strictEqual(post.status, 404);
    const get = await fetch(s.base + '/api/games/abcdefghij/status');
    assert.match(get.headers.get('content-type'), /html/, 'falls through to the normal site, not a games answer');
    assert.strictEqual(get.headers.get('x-robots-tag'), null);
    assert.ok(!fs.existsSync(path.join(s.dir, 'games.sqlite')), 'no database file is created');
    assert.strictEqual((await fetch(s.base + '/tracer')).status, 200);
  } finally { await s.stop(); }
});

test('flag off: the site starts even if the SQLite module cannot be loaded at all', async () => {
  const s = boot({ NODE_OPTIONS: '--require ' + path.join(__dirname, 'helpers', 'block-sqlite.js') });
  try {
    await s.ready;
    assert.strictEqual((await fetch(s.base + '/tracer')).status, 200);
    assert.strictEqual((await fetch(s.base + '/health')).status, 200);
  } finally { await s.stop(); }
});

test('flag on: the routes exist, the database is created, and an unknown game is a clean 404', async () => {
  const s = boot({ GAMES_ENABLED: 'true' });
  try {
    await s.ready;
    const r = await fetch(s.base + '/api/games/abcdefghij/status');
    assert.strictEqual(r.status, 404);
    assert.deepStrictEqual(await r.json(), { error: 'NotAvailable', message: "This game isn't available." });
    assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.ok(fs.existsSync(path.join(s.dir, 'games.sqlite')));
    const bad = await fetch(s.base + '/api/games', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"post":"hello"}' });
    assert.strictEqual(bad.status, 400);
  } finally { await s.stop(); }
});

test('pages: flag off leaves /tracer as it was and /g/ is just the normal site; flag on adds the Save button data and saved pages', async () => {
  const off = boot({});
  try {
    await off.ready;
    const t = await fetch(off.base + '/tracer'); const th = await t.text();
    assert.match(t.headers.get('content-security-policy'), /script-src 'self'/);
    assert.ok(/<body>/.test(th), 'the body carries no games attributes with the flag off');
    const g = await fetch(off.base + '/g/abcdefghij'); const gh = await g.text();
    assert.ok(!/data-mode="saved"/.test(gh) && !(g.headers.get('content-security-policy')), 'not a saved page');
    const f = await fetch(off.base + '/fonts/dm-sans-latin-400-normal.woff2');
    assert.strictEqual(f.status, 200); assert.match(f.headers.get('cache-control'), /max-age=2592000/);
    assert.strictEqual((await fetch(off.base + '/fonts/fonts.css')).status, 200);
  } finally { await off.stop(); }
  const on = boot({ GAMES_ENABLED: 'true' });
  try {
    await on.ready;
    const t = await fetch(on.base + '/tracer'); const th = await t.text();
    assert.match(th, /<body data-mode="live" data-games="1" data-cap="5000">/);
    const g = await fetch(on.base + '/g/abcdefghij/v/3'); const gh = await g.text();
    assert.match(gh, /<body data-mode="saved" data-game="abcdefghij" data-version="3">/);
    const csp = g.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/); assert.match(csp, /connect-src 'self'/); assert.match(csp, /img-src 'self' data:/); assert.match(csp, /script-src 'self'/);
    assert.strictEqual(g.headers.get('x-robots-tag'), 'noindex, nofollow'); assert.strictEqual(g.headers.get('referrer-policy'), 'no-referrer');
    // anything that is not a well-formed id reaches the page as an empty id, never as raw text
    const evil = await (await fetch(on.base + '/g/' + encodeURIComponent('"><script>alert(1)</script>'))).text();
    assert.match(evil, /data-game=""/); assert.ok(!/<script>alert\(1\)/.test(evil));
    const badV = await (await fetch(on.base + '/g/abcdefghij/v/9999999999')).text();
    assert.ok(!/data-version=/.test(badV));
    assert.ok(!/<script>(?!<)/.test(th.replace(/<script src=[^>]*><\/script>/g, '')), 'the page has no inline scripts, so the policy is enforceable');
  } finally { await on.stop(); }
});

test('policy page and admin page: only with the flag, the contact is escaped, the admin page needs a secret to exist', async () => {
  const off = boot({ ADMIN_SECRET: 'secret-with-flag-off' });
  try {
    await off.ready;
    const a = await fetch(off.base + '/g/about'); assert.ok(!/How saved games work/.test(await a.text()), 'no policy page with the flag off');
    const adm = await fetch(off.base + '/admin'); assert.ok(!/Admin tools|id="login"/.test(await adm.text()), 'no admin page with the flag off');
    const api = await fetch(off.base + '/api/admin/reports'); assert.match(api.headers.get('content-type'), /html/, 'no admin API with the flag off');
  } finally { await off.stop(); }

  const noSecret = boot({ GAMES_ENABLED: 'true', TAKEDOWN_CONTACT: 'x"><img src=x onerror=alert(1)>@evil.test' });
  try {
    await noSecret.ready;
    const about = await fetch(noSecret.base + '/g/about'); const html = await about.text();
    assert.match(html, /How saved games work/); assert.strictEqual(about.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.match(about.headers.get('content-security-policy'), /default-src 'none'/);
    assert.ok(!/<img src=x/.test(html) && /&lt;img src=x/.test(html), 'the takedown address is escaped');
    assert.ok(!/<script>(?!<)/.test(html.replace(/<script src=[^>]*><\/script>/g, '')), 'no inline scripts');
    const adm = await fetch(noSecret.base + '/admin'); assert.ok(!/id="login"/.test(await adm.text()), 'no secret: no admin page');
    const api = await fetch(noSecret.base + '/api/admin/reports'); assert.match(api.headers.get('content-type'), /html/, 'no secret: no admin API');
  } finally { await noSecret.stop(); }

  const on = boot({ GAMES_ENABLED: 'true', ADMIN_SECRET: 'a-long-admin-secret-for-tests', TAKEDOWN_CONTACT: 'takedown@example.test' });
  try {
    await on.ready;
    const html = await (await fetch(on.base + '/g/about')).text();
    assert.match(html, /mailto:takedown@example\.test/);
    const adm = await fetch(on.base + '/admin'); const ah = await adm.text();
    assert.match(ah, /id="login"/); assert.strictEqual(adm.headers.get('cache-control'), 'no-store'); assert.match(adm.headers.get('content-security-policy'), /script-src 'self'/);
    assert.ok(!/<script>(?!<)/.test(ah.replace(/<script src=[^>]*><\/script>/g, '')), 'no inline scripts on the admin page');
    assert.strictEqual((await fetch(on.base + '/api/admin/reports')).status, 401);
    const ok = await fetch(on.base + '/api/admin/reports', { headers: { authorization: 'Bearer a-long-admin-secret-for-tests' } });
    assert.strictEqual(ok.status, 200); assert.deepStrictEqual(Object.keys(await ok.json()).sort(), ['open', 'reports']);
  } finally { await on.stop(); }
});

test('sign in: off unless configured; with a loopback address it is on, the account page and saved-page links appear, and the policy text says so', async () => {
  const none = boot({ GAMES_ENABLED: 'true' });
  try {
    await none.ready;
    const api = await fetch(none.base + '/api/me'); assert.match(api.headers.get('content-type'), /html/, 'no sign-in routes unless configured');
    assert.strictEqual((await fetch(none.base + '/oauth/client-metadata.json')).headers.get('content-type').includes('json'), false);
    const saved = await (await fetch(none.base + '/g/abcdefghij')).text(); assert.ok(!/data-signin/.test(saved));
    assert.match(await (await fetch(none.base + '/g/about')).text(), /not available on this site yet/);
    const acct = await fetch(none.base + '/g/account'); assert.strictEqual(acct.status, 200); assert.match(acct.headers.get('content-security-policy'), /default-src 'none'/);
  } finally { await none.stop(); }
  const bad = boot({ GAMES_ENABLED: 'true', OAUTH_PUBLIC_URL: 'https://example.test' });   // public address but no key
  try {
    await bad.ready;
    assert.match((await fetch(bad.base + '/api/me')).headers.get('content-type'), /html/, 'a bad setting leaves sign-in off, and the site still runs');
  } finally { await bad.stop(); }
  const on = boot({ GAMES_ENABLED: 'true', OAUTH_PUBLIC_URL: 'http://127.0.0.1:3000' });
  try {
    await on.ready;
    const me = await fetch(on.base + '/api/me'); assert.deepStrictEqual(await me.json(), { signedIn: false });
    const meta = await (await fetch(on.base + '/oauth/client-metadata.json')).json();
    assert.match(meta.client_id, /^http:\/\/localhost\?redirect_uri=/); assert.strictEqual(meta.scope, 'atproto');
    const saved = await (await fetch(on.base + '/g/abcdefghij')).text(); assert.match(saved, /data-signin="1"/);
    const about = await (await fetch(on.base + '/g/about')).text(); assert.match(about, /href="\/g\/account"/); assert.ok(!/not available on this site yet/.test(about));
    const page = await (await fetch(on.base + '/g/account')).text();
    assert.match(page, /What this asks for/); assert.match(page, /atproto/); assert.ok(!/<script>(?!<)/.test(page.replace(/<script src=[^>]*><\/script>/g, '')), 'no inline scripts');
    const start = await fetch(on.base + '/api/auth/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"handle":"nope nope"}' });
    assert.strictEqual(start.status, 400);
  } finally { await on.stop(); }
});
