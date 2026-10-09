const test = require('node:test');
const assert = require('node:assert');
const { setup } = require('./helpers/gamesapp');
const { uriHash } = require('../dist/games/db');
const { looksLikeHandleOrDid } = require('../dist/games/auth/provider');

const SMALL = { a: { a1: {}, a2: {} }, b: {}, c: { c1: {} } };

test('sign-in cycle: browser-bound, one-hour cookie session, tokens revoked at once', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL);
    const s = await x.signIn('a.example');
    assert.strictEqual(s.start.status, 200);
    assert.match(s.start.headers.get('set-cookie'), /kiosk_signin=[^;]+; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax/);
    assert.strictEqual(s.cb.status, 302); assert.strictEqual(s.cb.headers.get('location'), '/g/account');
    const sc = s.setCookies.find(c => c.startsWith('kiosk_session='));
    assert.match(sc, /Path=\/; Max-Age=3600; HttpOnly; SameSite=Lax/); assert.ok(!/Secure/.test(sc), 'http: no Secure flag');
    assert.ok(s.setCookies.some(c => /^kiosk_signin=;/.test(c) && /Max-Age=0/.test(c)), 'the one-shot flow cookie is cleared');
    assert.deepStrictEqual(x.provider.revoked, ['did:plc:a'], 'the provider has already discarded the tokens');
    assert.deepStrictEqual([s.me.signedIn, s.me.did], [true, 'did:plc:a']); assert.ok(s.csrf && s.csrf.length > 20);
    assert.deepStrictEqual(Object.keys(s.me).sort(), ['csrf', 'did', 'expiresAt', 'signedIn'], 'nothing about the account but its ID');
    const anon = await x.call('GET', '/api/me'); assert.deepStrictEqual(anon.json, { signedIn: false });
    // after an hour the session is gone
    x.clock.t += 61 * 60_000;
    assert.deepStrictEqual((await x.call('GET', '/api/me', undefined, { cookie: s.cookie })).json, { signedIn: false });
    assert.strictEqual((await x.as(s, 'POST', '/api/me/remove', { scope: 'all' })).status, 401);
  } finally { await x.done(); }
});

test('a sign-in must finish in the browser that started it; bad, reused and cancelled flows land back calmly', async () => {
  const x = await setup();
  try {
    const start = await x.call('POST', '/api/auth/start', { handle: 'a.example' });
    const flow = /kiosk_signin=([^;]+)/.exec(start.headers.get('set-cookie'))[1];
    const go = (url, cookie) => fetch(x.origin + url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
    let r = await go(start.json.url);                                   // no cookie: another browser
    assert.strictEqual(r.headers.get('location'), '/g/account?signin=failed');
    assert.ok(!(r.headers.getSetCookie().some(c => /^kiosk_session=[^;]/.test(c))), 'no session was created');
    const s2 = await x.call('POST', '/api/auth/start', { handle: 'a.example' });
    r = await go(s2.json.url, 'kiosk_signin=not-the-right-nonce');
    assert.strictEqual(r.headers.get('location'), '/g/account?signin=failed');
    const s3 = await x.call('POST', '/api/auth/start', { handle: 'a.example' }); const f3 = /kiosk_signin=([^;]+)/.exec(s3.headers.get('set-cookie'))[1];
    r = await go(s3.json.url, 'kiosk_signin=' + f3); assert.strictEqual(r.headers.get('location'), '/g/account');
    r = await go(s3.json.url, 'kiosk_signin=' + f3); assert.strictEqual(r.headers.get('location'), '/g/account?signin=failed', 'a used sign-in cannot be replayed');
    r = await go('/oauth/callback?error=access_denied'); assert.strictEqual(r.headers.get('location'), '/g/account?signin=denied');
    r = await go('/oauth/callback?state=nope'); assert.strictEqual(r.headers.get('location'), '/g/account?signin=failed');
    assert.strictEqual(x.sessions.size, 1);
  } finally { await x.done(); }
});

test('start: handle shape is checked, provider errors are calm, and it is rate limited', async () => {
  const x = await setup({ startsPerHour: 4 });
  try {
    let n = 0;
    for (const bad of ['', 'a', 'not a handle', 'x'.repeat(300), 'javascript:alert(1)', '../etc', 'did:plc:', 'a..b']) {
      const r = await x.call('POST', '/api/auth/start', { handle: bad }, { 'x-forwarded-for': 'x, 10.9.8.' + (++n) }); assert.strictEqual(r.status, 400, JSON.stringify(bad)); assert.match(r.json.message, /doesn't look like a Bluesky handle/);
    }
    const down = await x.call('POST', '/api/auth/start', { handle: 'boom.example' }, { 'x-forwarded-for': 'x, 5.5.5.5' });
    assert.strictEqual(down.status, 502); assert.match(down.json.message, /couldn't reach that account's server/); assert.ok(!/network down/.test(down.text), 'internals are not shown');
    for (let i = 0; i < 4; i++) await x.call('POST', '/api/auth/start', { handle: 'a.example' }, { 'x-forwarded-for': 'x, 6.6.6.6' });
    const limited = await x.call('POST', '/api/auth/start', { handle: 'a.example' }, { 'x-forwarded-for': 'forged, 6.6.6.6' });
    assert.strictEqual(limited.status, 429);
    assert.strictEqual((await x.call('POST', '/api/auth/start', { handle: 'a.example' }, { 'x-forwarded-for': 'x, 7.7.7.7' })).status, 200);
  } finally { await x.done(); }
  assert.strictEqual(looksLikeHandleOrDid('alice.bsky.social'), true); assert.strictEqual(looksLikeHandleOrDid('did:plc:abc123'), true);
  assert.strictEqual(looksLikeHandleOrDid('did:web:example.com'), true); assert.strictEqual(looksLikeHandleOrDid('localhost'), false);
});

test('every change needs the session, the CSRF token and a same-origin request', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL); const id = await x.create('root');
    const s = await x.signIn('a.example');
    const body = { scope: id };
    assert.strictEqual((await x.call('POST', '/api/me/remove', body)).status, 401, 'no cookie');
    assert.strictEqual((await x.call('POST', '/api/me/remove', body, { cookie: s.cookie, origin: x.PUBLIC })).status, 403, 'no CSRF token');
    assert.strictEqual((await x.call('POST', '/api/me/remove', body, { cookie: s.cookie, origin: x.PUBLIC, 'x-csrf-token': 'wrong' })).status, 403, 'wrong CSRF token');
    assert.strictEqual((await x.call('POST', '/api/me/remove', body, { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: 'https://evil.example' })).status, 403, 'foreign origin');
    assert.strictEqual((await x.call('POST', '/api/me/remove', body, { cookie: s.cookie, 'x-csrf-token': s.csrf })).status, 403, 'no origin and no same-origin marker');
    assert.strictEqual((await x.call('POST', '/api/me/remove', body, { cookie: s.cookie, 'x-csrf-token': s.csrf, 'sec-fetch-site': 'same-origin' })).status, 200, 'same-origin marker is enough when Origin is absent');
    assert.strictEqual((await x.call('POST', `/api/me/game/${id}/owner`, { action: 'freeze' }, { cookie: s.cookie, origin: x.PUBLIC })).status, 403);
    assert.strictEqual((await x.call('POST', '/api/auth/logout', {}, { cookie: s.cookie, origin: x.PUBLIC })).status, 403);
    const other = await x.signIn('b.example', '9.9.9.9');
    assert.strictEqual((await x.call('POST', '/api/me/remove', body, { cookie: s.cookie, 'x-csrf-token': other.csrf, origin: x.PUBLIC })).status, 403, "another session's token is useless");
  } finally { await x.done(); }
});

test('removing yourself: one game, or every game and kept out of future ones; never anyone else', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL); x.world.tree('other', { a: {}, z: {} });
    const g1 = await x.create('root'), g2 = await x.create('other');
    const a = await x.signIn('a.example');
    const list = (await x.call('GET', '/api/me/games', undefined, { cookie: a.cookie })).json;
    assert.deepStrictEqual(list.appearances.map(g => [g.id, g.posts]).sort(), [[g1, 1], [g2, 1]].sort(), 'only this account, in the games it appears in');
    assert.deepStrictEqual(list.started, []);
    let r = await x.as(a, 'POST', '/api/me/remove', { scope: 'nope' }); assert.strictEqual(r.status, 400);
    r = await x.as(a, 'POST', '/api/me/remove', { scope: 'zzzzzzzzzz' }); assert.strictEqual(r.status, 400, 'an unknown game id is refused');
    r = await x.as(a, 'POST', '/api/me/remove', { scope: g1 }); assert.deepStrictEqual([r.status, r.json.wiped], [200, 1]);
    const st = (g, n) => x.db.getNodeByUri(g, x.world.uri(n));
    assert.strictEqual(st(g1, 'a').state, 'removed_by_author'); assert.strictEqual(st(g1, 'a').text, null);
    assert.strictEqual(st(g1, 'a1').parent_id, st(g1, 'a').id, 'replies stay attached');
    assert.strictEqual(st(g1, 'a1').state, 'live', 'other people stay');
    assert.strictEqual(st(g2, 'a').state, 'live', 'the other game is untouched by a one-game removal');
    assert.ok(x.db.isSuppressed('did:plc:a', g1)); assert.ok(!x.db.isSuppressed('did:plc:a', g2));
    // a refresh does not bring the account back, even with a new post by it
    x.world.quote('root', 'a'); x.clock.t += 7 * 3600_000;
    assert.strictEqual((await x.req('POST', `/${g1}/refresh`)).status, 202); await x.waitIdle(g1);
    assert.strictEqual(st(g1, 'a').state, 'removed_by_author');
    // everywhere, and kept out of future ones
    const a2 = await x.signIn('a.example', '1.1.1.9');   // the hour is up, so sign in again
    r = await x.as(a2, 'POST', '/api/me/remove', { scope: 'all' }); assert.deepStrictEqual([r.status, r.json.wiped], [200, 1]);
    assert.strictEqual(st(g2, 'a').state, 'removed_by_author'); assert.strictEqual(st(g2, 'z').state, 'live', 'someone else in the same game is untouched');
    assert.ok(x.db.isSuppressed('did:plc:a', 'any-future-game'));
    x.world.tree('later', { a: {}, q: {} }); const g3 = await x.create('later');
    assert.strictEqual(st(g3, 'a').state, 'removed_by_author'); assert.strictEqual(st(g3, 'q').state, 'live');
    const after = (await x.call('GET', '/api/me/games', undefined, { cookie: a2.cookie })).json; assert.deepStrictEqual(after.appearances, []);
    // another account never sees or touches it
    const b = await x.signIn('b.example', '8.8.8.8');
    const bl = (await x.call('GET', '/api/me/games', undefined, { cookie: b.cookie })).json;
    assert.deepStrictEqual(bl.appearances.map(g => [g.id, g.posts]), [[g1, 1]], 'b sees only its own post (in the first game)');
    assert.strictEqual(x.db.getNodeByUri(g1, x.world.uri('b')).state, 'live');
    const log = x.db.recentAdminLog().filter(l => l.action === 'self.remove'); assert.strictEqual(log.length, 2);
    assert.ok(log.every(l => !/did:|plc/.test(l.target)), 'the log records no account');
  } finally { await x.done(); }
});

test('owner controls: only the account that wrote the original post, even after that post is wiped', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL); const id = await x.create('root');
    const owner = await x.signIn('root.example'), other = await x.signIn('b.example', '3.3.3.3');
    const mine = (await x.call('GET', '/api/me/games', undefined, { cookie: owner.cookie })).json.started;
    assert.deepStrictEqual(mine.map(g => g.id), [id]); assert.strictEqual(mine[0].quotes, 6);
    assert.deepStrictEqual((await x.call('GET', '/api/me/games', undefined, { cookie: other.cookie })).json.started, []);
    let r = await x.as(other, 'POST', `/api/me/game/${id}/owner`, { action: 'freeze' });
    assert.strictEqual(r.status, 403); assert.match(r.json.message, /Only the account that wrote the original post/);
    assert.strictEqual(x.db.getGame(id).frozen, 0);
    r = await x.as(owner, 'POST', `/api/me/game/${id}/owner`, { action: 'freeze' }); assert.strictEqual(r.status, 200);
    assert.strictEqual((await x.req('POST', `/${id}/refresh`)).status, 403, 'frozen means nobody can refresh');
    assert.strictEqual((await x.req('GET', `/${id}/data.json`)).status, 200, 'still readable');
    assert.strictEqual((await x.as(other, 'POST', `/api/me/game/${id}/owner`, { action: 'unfreeze' })).status, 403, 'only the owner can undo it');
    r = await x.as(owner, 'POST', `/api/me/game/${id}/owner`, { action: 'unfreeze' }); assert.strictEqual(r.status, 200); assert.strictEqual(x.db.getGame(id).frozen, 0);
    assert.strictEqual((await x.as(owner, 'POST', `/api/me/game/${id}/owner`, { action: 'explode' })).status, 400);
    assert.strictEqual((await x.as(owner, 'POST', '/api/me/game/zzzzzzzzzz/owner', { action: 'freeze' })).status, 404);
    // the owner removes themselves: the root post is wiped, but they still own the game
    assert.strictEqual((await x.as(owner, 'POST', '/api/me/remove', { scope: id })).status, 200);
    assert.strictEqual(x.db.getNodeByUri(id, x.world.uri('root')).state, 'removed_by_author');
    r = await x.as(owner, 'POST', `/api/me/game/${id}/owner`, { action: 'freeze' }); assert.strictEqual(r.status, 200, 'ownership comes from the stored root address, which outlives the wiped post');
    r = await x.as(owner, 'POST', `/api/me/game/${id}/owner`, { action: 'delete' }); assert.strictEqual(r.status, 200);
    assert.strictEqual(x.db.nodeCount(id), 0); assert.strictEqual((await x.req('GET', `/${id}/data.json`)).status, 404);
    const again = await x.req('POST', '/', { post: x.link('root') }, { 'x-forwarded-for': 'a, 4.4.4.4' }); assert.strictEqual(again.status, 404, 'a deleted game cannot be quietly recreated');
    assert.strictEqual((await x.as(owner, 'POST', `/api/me/game/${id}/owner`, { action: 'freeze' })).status, 404, 'a deleted game is gone for its owner too');
  } finally { await x.done(); }
});

test('logout ends the session; nothing about sign-in is stored in the database', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL); await x.create('root');
    const s = await x.signIn('a.example');
    const r = await x.as(s, 'POST', '/api/auth/logout', {}); assert.strictEqual(r.status, 200); assert.match(r.headers.get('set-cookie'), /kiosk_session=; Path=\/; Max-Age=0/);
    assert.deepStrictEqual((await x.call('GET', '/api/me', undefined, { cookie: s.cookie })).json, { signedIn: false });
    const tables = x.db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(t => t.name).sort();
    assert.deepStrictEqual(tables, ['admin_log', 'crawl_job', 'game', 'node', 'report', 'suppression', 'version'], 'no session or token table exists');
    const dump = JSON.stringify(['game', 'node', 'report', 'suppression', 'admin_log', 'crawl_job'].map(t => x.db.db.prepare(`SELECT * FROM ${t}`).all()));
    assert.ok(!dump.includes(s.cookie.split('=')[1]) && !dump.includes(s.csrf), 'the session token and CSRF token are never written down');
  } finally { await x.done(); }
});

test('over https the session cookie is Secure; the metadata and key endpoints pass through (and fail closed)', async () => {
  const x = await setup({ publicUrl: 'https://kiosk.test' });
  try {
    const start = await x.call('POST', '/api/auth/start', { handle: 'a.example' });
    assert.match(start.headers.get('set-cookie'), /; HttpOnly; SameSite=Lax; Secure$/);
    assert.deepStrictEqual((await x.call('GET', '/oauth/client-metadata.json')).json, { fake: true });
    assert.deepStrictEqual((await x.call('GET', '/oauth/jwks.json')).json, { keys: [] });
    x.provider.jwks = () => { throw new Error('key import failed'); };
    const bad = await x.call('GET', '/oauth/jwks.json'); assert.strictEqual(bad.status, 503); assert.ok(!/key import/.test(bad.text));
  } finally { await x.done(); }
});
