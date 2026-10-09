const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const zlib = require('node:zlib');
const express = require('express');
const { World, serve, stubBudget } = require('./helpers/fakeappview');
const { GamesDb } = require('../dist/games/db');
const { AppViewClient } = require('../dist/games/appview');
const { GamesQueue } = require('../dist/games/queue');
const { GamesLimits } = require('../dist/games/ratelimit');
const { createGamesRouter } = require('../dist/games/api');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function setup(o = {}) {
  const world = new World(), fake = await serve(world), budget = stubBudget();
  const clock = { t: Date.UTC(2026, 9, 8, 12, 0, 0) };
  const db = new GamesDb(':memory:', () => clock.t);
  const client = (opts = {}) => new AppViewClient({ baseUrl: fake.url, budget, userAgent: 'test', gapMs: 0, maxAttempts: 3, sleep: async () => {}, ...opts });
  const queue = new GamesQueue({ db, sizeCap: o.sizeCap ?? 5000, makeAppView: () => client({ maxAttempts: o.crawlAttempts ?? 3 }), retryDelayMs: 5, maxRetries: 2, idleMs: 10 });
  const limits = new GamesLimits({ lookupsPerIpPerHour: o.lookups ?? 100, createsPerIpPerHour: o.creates ?? 50, refreshesPerIpPerHour: 50, reportsPerIpPerHour: o.reports ?? 10, rechecksPerIpPerHour: 6 }, () => clock.t);
  const app = express(); app.use(express.json());
  app.use('/api/games', createGamesRouter({ db, queue, limits, makeLookupClient: () => client({ maxAttempts: 2 }), sizeCap: o.sizeCap ?? 5000,
    refreshCooldownMs: 6 * 3600_000, recheckCooldownMs: 60 * 60_000, maxCreatesPerDay: o.maxPerDay ?? 100, maxQueued: o.maxQueued ?? 20, trustedProxyHops: 1, now: () => clock.t }));
  const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api/games`;
  if (o.run !== false) queue.start();
  const req = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'accept-encoding': 'identity', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; const text = await r.text(); try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  const link = name => `https://bsky.app/profile/${name}.example/post/${name}`;
  const waitReady = async id => { for (let i = 0; i < 200; i++) { const s = await req('GET', `/${id}/status`); if (s.json && s.json.state === 'ready') return s.json; await sleep(15); } throw new Error('never became ready'); };
  const done = async () => { await queue.stop(); await new Promise(r => srv.close(r)); await fake.close(); db.close(); };
  return { world, fake, db, clock, queue, req, link, waitReady, done, base, budget, app, limits, client };
}
const SMALL = { a: { a1: {}, a2: {} }, b: {}, c: { c1: {} } };

test('input checks: empty, junk, unknown account, missing post, Bluesky down', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL);
    let r = await x.req('POST', '/', { post: '   ' }); assert.strictEqual(r.status, 400); assert.strictEqual(r.json.message, 'Paste a post link first.');
    r = await x.req('POST', '/', { post: 'hello world' }); assert.strictEqual(r.status, 400); assert.match(r.json.message, /doesn't look like a post link/);
    r = await x.req('POST', '/', {}); assert.strictEqual(r.status, 400);
    r = await x.req('POST', '/', { post: 'https://bsky.app/profile/nobody.example/post/zzz' }); assert.strictEqual(r.status, 404); assert.strictEqual(r.json.message, "We couldn't find that account.");
    r = await x.req('POST', '/', { post: 'https://bsky.app/profile/root.example/post/missing' }); assert.strictEqual(r.status, 404); assert.strictEqual(r.json.message, "We couldn't find a public post at that link.");
    x.world.failAlways({ status: 500 });
    r = await x.req('POST', '/', { post: x.link('root') }); assert.strictEqual(r.status, 503); assert.strictEqual(r.json.message, "Bluesky didn't answer. Try again in a minute.");
    assert.strictEqual(x.db.gamesCreatedSince(0), 0, 'a failed lookup creates nothing');
  } finally { await x.done(); }
});

test('create, wait, read: a saved game serves a well-formed tree and never leaks a post address', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL); x.world.post('hidden', { labels: ['porn'] }); x.world.quote('b', 'hidden');
    let r = await x.req('POST', '/', { post: x.link('root') });
    assert.strictEqual(r.status, 202); assert.strictEqual(r.json.status, 'queued'); assert.match(r.json.id, /^[a-z0-9]{10}$/);
    const id = r.json.id;
    const st = await x.waitReady(id);
    assert.strictEqual(st.latest.n, 1); assert.strictEqual(st.latest.status, 'complete'); assert.strictEqual(st.quotesFound, 7);
    assert.strictEqual(st.refresh.available, false);
    assert.ok(st.refresh.secondsLeft > 0);
    r = await x.req('GET', `/${id}/data.json`);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex, nofollow');
    const d = r.json;
    assert.strictEqual(d.nodes.length, 8); assert.strictEqual(d.nodes[0].p, -1);
    d.nodes.forEach((n, i) => { if (i) assert.ok(n.p >= 0 && n.p < i, 'parents come first'); });
    assert.strictEqual(d.nodes.filter(n => n.tomb === 'label').length, 1);
    const tomb = d.nodes.find(n => n.tomb); assert.deepStrictEqual(Object.keys(tomb).sort(), ['p', 'tomb']);
    assert.ok(!/at:\/\//.test(r.text), 'no post address anywhere in the payload');
    const live = d.nodes.find(n => n.k === 'a1'); assert.deepStrictEqual(Object.keys(live).sort(), ['d', 'did', 'dn', 'h', 'k', 'p', 'qc', 't']);
    assert.strictEqual(d.version.n, 1); assert.deepStrictEqual(d.version.versions, [1]);
    // gzip and etag
    const gz = await fetch(`${x.base}/${id}/data.json`, { headers: { 'accept-encoding': 'gzip' } });
    assert.strictEqual(gz.headers.get('content-encoding'), 'gzip');
    const etag = gz.headers.get('etag'); assert.ok(etag);
    const inflated = await gz.json();   // fetch inflates it for us
    const rawGz = zlib.gzipSync(Buffer.from(JSON.stringify(inflated))); assert.ok(rawGz.length < JSON.stringify(inflated).length, 'it is the compressed form that goes over the wire');
    assert.strictEqual(inflated.nodes.length, 8);
    const again = await fetch(`${x.base}/${id}/data.json`, { headers: { 'if-none-match': etag } }); assert.strictEqual(again.status, 304);
    r = await x.req('GET', `/${id}/v/1/data.json`); assert.strictEqual(r.status, 200);
    r = await x.req('GET', `/${id}/v/2/data.json`); assert.strictEqual(r.status, 404);
    r = await x.req('GET', `/${id}/v/0/data.json`); assert.strictEqual(r.status, 404);
    // a second request for the same post goes to the same game
    r = await x.req('POST', '/', { post: x.link('root') }); assert.deepStrictEqual(r.json, { status: 'exists', id });
    const byDid = await x.req('POST', '/', { post: `at://${x.world.did('root')}/app.bsky.feed.post/root` }); assert.deepStrictEqual(byDid.json, { status: 'exists', id });
  } finally { await x.done(); }
});

test('a post that quotes another asks which to start from', async () => {
  const x = await setup();
  try {
    x.world.post('orig'); x.world.quote('orig', 'q'); x.world.quote('q', 'q1');
    let r = await x.req('POST', '/', { post: x.link('q') });
    assert.strictEqual(r.json.status, 'is_quote'); assert.strictEqual(r.json.quotedUri, x.world.uri('orig'));
    assert.strictEqual(x.db.gamesCreatedSince(0), 0);
    const mine = await x.req('POST', '/', { post: x.link('q'), start: 'this' }); assert.strictEqual(mine.status, 202);
    const orig = await x.req('POST', '/', { post: x.link('q'), start: 'original' }); assert.strictEqual(orig.status, 202);
    assert.notStrictEqual(mine.json.id, orig.json.id);
    assert.strictEqual(x.db.getGame(mine.json.id).root_uri, x.world.uri('q'));
    assert.strictEqual(x.db.getGame(orig.json.id).root_uri, x.world.uri('orig'));
    await x.waitReady(mine.json.id); await x.waitReady(orig.json.id);
  } finally { await x.done(); }
});

test('refresh: cooldown is enforced by the server, a running refresh is reported, frozen games refuse', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL);
    const id = (await x.req('POST', '/', { post: x.link('root') })).json.id; await x.waitReady(id);
    let r = await x.req('POST', `/${id}/refresh`);
    assert.strictEqual(r.status, 429); assert.strictEqual(r.json.error, 'Cooldown'); assert.strictEqual(r.json.message, 'You can refresh again in 6 hours.');
    x.clock.t += 3 * 3600_000;
    r = await x.req('POST', `/${id}/refresh`); assert.strictEqual(r.status, 429); assert.match(r.json.message, /^You can refresh again in 3 hours\.$/);
    x.clock.t += 3 * 3600_000 + 1000;
    x.world.quote('c', 'c2');
    r = await x.req('POST', `/${id}/refresh`); assert.strictEqual(r.status, 202);
    for (let i = 0; i < 200; i++) { const s = (await x.req('GET', `/${id}/status`)).json; if (s.latest.n === 2) break; await sleep(15); }
    const st = (await x.req('GET', `/${id}/status`)).json;
    assert.strictEqual(st.latest.n, 2); assert.strictEqual(st.versions[1].added, 1);
    assert.strictEqual(st.refresh.available, false, 'cooldown restarts after a refresh');
    x.clock.t += 7 * 3600_000; x.db.setFrozen(id, true);
    r = await x.req('POST', `/${id}/refresh`); assert.strictEqual(r.status, 403); assert.match(r.json.message, /frozen by the person who wrote the original post/);
    assert.strictEqual((await x.req('GET', `/${id}/data.json`)).status, 200, 'a frozen game can still be viewed');
  } finally { await x.done(); }
});

test('a refresh already running is reported instead of starting a second', async () => {
  const x = await setup({ run: false });
  try {
    x.world.tree('root', SMALL);
    const id = (await x.req('POST', '/', { post: x.link('root') })).json.id;
    x.queue.start(); await x.waitReady(id); await x.queue.stop();
    x.clock.t += 7 * 3600_000;
    let r = await x.req('POST', `/${id}/refresh`); assert.strictEqual(r.status, 202);
    r = await x.req('POST', `/${id}/refresh`); assert.deepStrictEqual([r.status, r.json.status], [200, 'running']);
    assert.strictEqual(x.db.listQueued().length, 1);
    const st = (await x.req('GET', `/${id}/status`)).json; assert.strictEqual(st.refresh.available, false);
  } finally { await x.done(); }
});

test('unknown, malformed, hidden and deleted games are indistinguishable', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL); x.world.tree('r2', SMALL); x.world.tree('r3', SMALL);
    const a = (await x.req('POST', '/', { post: x.link('root') })).json.id, b = (await x.req('POST', '/', { post: x.link('r2') })).json.id;
    await x.waitReady(a); await x.waitReady(b);
    x.db.setGameStatus(a, 'hidden'); x.db.setGameStatus(b, 'deleted');
    const probe = async id => JSON.stringify(await Promise.all([['GET', '/status'], ['GET', '/data.json'], ['GET', '/v/1/data.json'], ['POST', '/refresh']].map(async ([m, p]) => { const r = await x.req(m, `/${id}${p}`); return [r.status, r.json]; })));
    const unknown = await probe('zzzzzzzzzz'), bad = await probe('not-a-slug'), hidden = await probe(a), deleted = await probe(b);
    assert.strictEqual(unknown, bad); assert.strictEqual(unknown, hidden); assert.strictEqual(unknown, deleted);
    assert.match(unknown, /This game isn't available\./);
    // a taken-down game cannot be quietly recreated from the same post
    const again = await x.req('POST', '/', { post: x.link('root') }); assert.strictEqual(again.status, 404); assert.strictEqual(again.json.message, "This game isn't available.");
  } finally { await x.done(); }
});

test('abuse limits: per visitor, not bypassable with a forged forwarded address, plus daily and queue caps', async () => {
  const x = await setup({ creates: 2, run: false });
  try {
    for (const n of ['g1', 'g2', 'g3', 'g4']) x.world.tree(n, {});
    const as = (name, xff) => x.req('POST', '/', { post: x.link(name) }, { 'x-forwarded-for': xff });
    assert.strictEqual((await as('g1', 'forged1, 203.0.113.7')).status, 202);
    assert.strictEqual((await as('g2', 'forged2, 203.0.113.7')).status, 202);
    const third = await as('g3', 'forged3, 203.0.113.7');
    assert.strictEqual(third.status, 429); assert.strictEqual(third.json.message, 'Too many requests from here. Try again in a few minutes.'); assert.ok(Number(third.headers.get('retry-after')) > 0);
    assert.strictEqual((await as('g3', 'x, 203.0.113.8')).status, 202, 'a different real address is a different visitor');
    x.clock.t += 61 * 60_000;
    assert.strictEqual((await as('g4', 'x, 203.0.113.7')).status, 202, 'the window passes');
  } finally { await x.done(); }
  const y = await setup({ maxQueued: 1, run: false });
  try {
    y.world.tree('q1', {}); y.world.tree('q2', {});
    assert.strictEqual((await y.req('POST', '/', { post: y.link('q1') }, { 'x-forwarded-for': 'a, 1.1.1.1' })).status, 202);
    assert.strictEqual((await y.req('POST', '/', { post: y.link('q2') }, { 'x-forwarded-for': 'a, 2.2.2.2' })).status, 429, 'the queue is full');
  } finally { await y.done(); }
  const z = await setup({ maxPerDay: 1, run: false });
  try {
    z.world.tree('d1', {}); z.world.tree('d2', {});
    assert.strictEqual((await z.req('POST', '/', { post: z.link('d1') }, { 'x-forwarded-for': 'a, 1.1.1.1' })).status, 202);
    assert.strictEqual((await z.req('POST', '/', { post: z.link('d2') }, { 'x-forwarded-for': 'a, 2.2.2.2' })).status, 429, 'daily cap');
  } finally { await z.done(); }
});

test('queue: a Bluesky outage pauses a job, then keeps what was found as a partial version; a restart resumes', async () => {
  const x = await setup({ run: false, crawlAttempts: 1 });
  try {
    x.world.tree('root', SMALL);
    const id = (await x.req('POST', '/', { post: x.link('root') })).json.id;
    x.world.failAlways({ status: 500 });
    x.queue.start();
    for (let i = 0; i < 300; i++) { const j = x.db.lastJob(id); if (j.state === 'partial' || j.state === 'failed') break; await sleep(15); }
    const job = x.db.lastJob(id);
    assert.strictEqual(job.state, 'partial'); assert.strictEqual(job.error, "Bluesky didn't answer"); assert.ok(job.retry_count >= 3);
    const v = x.db.getVersion(id, 1); assert.strictEqual(v.status, 'partial'); assert.strictEqual(v.partial_reason, "Bluesky didn't answer");
    await x.queue.stop();
    // restart: a job left 'crawling' goes back in the queue and finishes
    x.world.heal(); x.clock.t += 7 * 3600_000;
    const refresh = x.db.createJob(id, 'refresh', 2); x.db.markJobStarted(refresh.id);
    x.queue.start();
    for (let i = 0; i < 300 && x.db.getJob(refresh.id).state !== 'complete'; i++) await sleep(15);
    assert.strictEqual(x.db.getJob(refresh.id).state, 'complete');
    assert.strictEqual(x.db.getVersion(id, 2).node_count, 7);
  } finally { await x.done(); }
});
