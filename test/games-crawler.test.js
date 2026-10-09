const test = require('node:test');
const assert = require('node:assert');
const { World, serve, stubBudget } = require('./helpers/fakeappview');
const { GamesDb, uriHash } = require('../dist/games/db');
const { AppViewClient, BskyUnavailable } = require('../dist/games/appview');
const { GameCrawler, quotedPostUri } = require('../dist/games/crawler');
const { HIDE_LABELS } = require('../dist/games/labels');

async function setup() {
  const world = new World(), fake = await serve(world), budget = stubBudget();
  const clock = { t: Date.UTC(2026, 9, 8, 12, 0, 0) };
  const db = new GamesDb(':memory:', () => clock.t);
  const mkClient = (o = {}) => new AppViewClient({ baseUrl: fake.url, budget, userAgent: 'test', gapMs: 0, maxAttempts: 3, sleep: async () => {}, ...o });
  const ctx = { world, fake, budget, clock, db, mkClient };
  ctx.create = async (rootName, cap = 5000, clientOpts) => {
    const client = mkClient(clientOpts), root = (await client.getPosts([world.uri(rootName)]))[0];
    const crawler = new GameCrawler({ db, appview: client, sizeCap: cap });
    const game = crawler.createGame(root), job = db.createJob(game.id, 'create', 1);
    return { game, job, crawler, client };
  };
  ctx.refresh = async (game, cap = 5000, clientOpts, crawlerOpts = {}) => {
    const client = mkClient(clientOpts), crawler = new GameCrawler({ db, appview: client, sizeCap: cap, ...crawlerOpts });
    const job = db.createJob(game.id, 'refresh', db.nextVersionNumber(game.id));
    return { job, crawler, client, outcome: await crawler.run(job) };
  };
  ctx.done = async () => { await fake.close(); db.close(); };
  ctx.names = (gameId, n) => db.nodesForVersion(gameId, n).map(r => (r.uri ? world.nameOf(r.uri) : '·' + r.state));
  return ctx;
}
// what a viewer of a version can see: the stored content and its place in the tree (internal crawl bookkeeping excluded)
const project = rows => JSON.stringify(rows.map(r => [r.id, r.uri_hash, r.handle, r.text, r.parent_id, r.depth, r.state, r.v_added]));
const SMALL = { a: { a1: {}, a2: {} }, b: {}, c: { c1: { c1a: {} } } };

test('a created game stores every quote and only expands posts that have quotes', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL);
    const { game, job, crawler } = await x.create('root');
    const out = await crawler.run(job);
    assert.strictEqual(out.status, 'complete');
    assert.deepStrictEqual(x.names(game.id, 1).sort(), ['a', 'a1', 'a2', 'b', 'c', 'c1', 'c1a', 'root']);
    const expanded = x.world.calls('app.bsky.feed.getQuotes').map(p => x.world.nameOf(p.uri)).sort();
    assert.deepStrictEqual(expanded, ['a', 'c', 'c1', 'root'], 'leaf posts (quoteCount 0) must never be queried');
    const v = x.db.getVersion(game.id, 1);
    assert.strictEqual(v.node_count, 8); assert.strictEqual(v.max_depth, 3); assert.strictEqual(v.missing_count, 0);
  } finally { await x.done(); }
});

test('the same post under two parents is stored once; long lists page through the cursor', async () => {
  const x = await setup();
  try {
    x.world.post('root'); x.world.post('p1'); x.world.post('p2'); x.world.quote('root', 'p1', 'p2');
    x.world.quote('p1', 'shared'); x.world.children.get('p2').push('shared');
    for (let i = 0; i < 250; i++) x.world.quote('p2', 'bulk' + i);
    const { game, job, crawler } = await x.create('root');
    await crawler.run(job);
    assert.strictEqual(x.db.nodeCount(game.id), 1 + 2 + 1 + 250);
    const pages = x.world.calls('app.bsky.feed.getQuotes').filter(p => x.world.nameOf(p.uri) === 'p2').length;
    assert.strictEqual(pages, 3);
  } finally { await x.done(); }
});

test('the size cap stops a crawl as partial, and a later refresh resumes without touching version 1', async () => {
  const x = await setup();
  try {
    x.world.tree('root', { a: { a1: {}, a2: {}, a3: {} }, b: { b1: {}, b2: {} }, c: { c1: {}, c2: {} } });
    const { game, job, crawler } = await x.create('root', 5);
    const out = await crawler.run(job);
    assert.deepStrictEqual(out, { status: 'partial', reason: 'size cap reached' });
    assert.strictEqual(x.db.nodeCount(game.id) - 1, 5);
    const v1before = project(x.db.nodesForVersion(game.id, 1));
    const r = await x.refresh(game, 50);
    assert.strictEqual(r.outcome.status, 'complete');
    assert.strictEqual(x.db.nodeCount(game.id), 11);
    assert.strictEqual(project(x.db.nodesForVersion(game.id, 1)), v1before, 'version 1 must not change');
    assert.strictEqual(x.db.getVersion(game.id, 2).node_count, 11);
    assert.strictEqual(x.db.listVersions(game.id).length, 2);
  } finally { await x.done(); }
});

test('a crawl interrupted by Bluesky errors resumes where it stopped and never duplicates', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL);
    const { game, job, crawler } = await x.create('root', 5000, { maxAttempts: 2 });
    x.world.failNext(0, {});
    // let the first two requests through, then break Bluesky
    let n = 0; const real = x.world.failures;
    x.world.failAlways(null);
    const orig = x.world.view.bind(x.world);
    const crawlerBroken = new GameCrawler({ db: x.db, appview: x.mkClient({ maxAttempts: 2 }), sizeCap: 5000 });
    x.world.failNext(0, {});
    // fail the third and later calls
    const start = x.world.log.length;
    const t = setInterval(() => { if (x.world.log.length - start >= 2) x.world.failAlways({ status: 500 }); }, 1);
    await assert.rejects(crawlerBroken.run(job), BskyUnavailable);
    clearInterval(t); x.world.heal();
    const partialCount = x.db.nodeCount(game.id);
    assert.ok(partialCount >= 1 && partialCount < 8, 'some progress was saved: ' + partialCount);
    x.world.clearLog();
    const resumed = await new GameCrawler({ db: x.db, appview: x.mkClient(), sizeCap: 5000 }).run(x.db.getJob(job.id));
    assert.strictEqual(resumed.status, 'complete');
    assert.strictEqual(x.db.nodeCount(game.id), 8);
    const rows = x.db.nodesForVersion(game.id, 1);
    assert.strictEqual(new Set(rows.map(r => r.uri_hash)).size, rows.length, 'no duplicates');
  } finally { await x.done(); }
});

test('labeled posts and suppressed authors are stored as tombstones with no text or address', async () => {
  const x = await setup();
  try {
    x.world.post('root'); x.world.post('lab', { labels: ['porn'] }); x.world.post('alab', { authorLabels: ['graphic-media'] }); x.world.post('sup'); x.world.post('ok');
    x.world.quote('root', 'lab', 'alab', 'sup', 'ok'); x.world.quote('lab', 'under');
    x.db.addSuppression(x.world.did('sup'), 'all');
    x.db.addSuppression(x.world.did('ok'), 'someothergame');
    const { game, job, crawler } = await x.create('root');
    await crawler.run(job);
    const rows = x.db.nodesForVersion(game.id, 1);
    const by = n => rows.find(r => r.uri_hash === uriHash(x.world.uri(n)));
    for (const [n, state] of [['lab', 'label_hidden'], ['alab', 'label_hidden'], ['sup', 'removed_by_author']]) {
      const r = by(n);
      assert.strictEqual(r.state, state, n);
      assert.deepStrictEqual([r.uri, r.did, r.handle, r.display_name, r.text, r.created_at], [null, null, null, null, null, null], n + ' must hold nothing identifying');
    }
    assert.strictEqual(by('ok').state, 'live'); assert.ok(by('ok').text);
    assert.strictEqual(by('under'), undefined, 'a tombstone is never expanded, so nothing under it is fetched');
  } finally { await x.done(); }
});

test('a labeled root is kept as a single tombstone', async () => {
  const x = await setup();
  try {
    x.world.post('root', { labels: ['sexual'] }); x.world.quote('root', 'a');
    const { game, job, crawler } = await x.create('root');
    assert.strictEqual((await crawler.run(job)).status, 'complete');
    assert.strictEqual(x.db.nodeCount(game.id), 1);
    assert.strictEqual(x.db.getNode(x.db.nodesForVersion(game.id, 1)[0].id).state, 'label_hidden');
  } finally { await x.done(); }
});

test('missing count: quotes counted by Bluesky but not returned are reported', async () => {
  const x = await setup();
  try {
    x.world.tree('root', { a: {}, b: {} }); x.world.posts.get('root').quoteCountExtra = 3;
    const { game, job, crawler } = await x.create('root');
    await crawler.run(job);
    assert.strictEqual(x.db.getVersion(game.id, 1).missing_count, 3);
    assert.strictEqual(x.db.getVersion(game.id, 1).root_quote_count, 5);
    assert.strictEqual(x.db.directQuotes(game.id, 1), 2);
  } finally { await x.done(); }
});

test('refresh adds a version, leaves older ones identical, and only reopens posts with new quotes', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL);
    const { game, job, crawler } = await x.create('root');
    await crawler.run(job);
    const v1 = project(x.db.nodesForVersion(game.id, 1));
    const v1banner = JSON.stringify([x.db.getVersion(game.id, 1), x.db.directQuotes(game.id, 1)]);
    x.world.quote('a', 'a3'); x.world.quote('b', 'b1');
    x.world.clearLog();
    const r = await x.refresh(game);
    assert.strictEqual(r.outcome.status, 'complete');
    const expanded = x.world.calls('app.bsky.feed.getQuotes').map(p => x.world.nameOf(p.uri)).sort();
    assert.deepStrictEqual(expanded, ['a', 'b'], 'only posts whose quote count rose are asked again');
    assert.strictEqual(project(x.db.nodesForVersion(game.id, 1)), v1);
    assert.strictEqual(JSON.stringify([x.db.getVersion(game.id, 1), x.db.directQuotes(game.id, 1)]), v1banner, 'the banner numbers of version 1 are frozen too');
    assert.deepStrictEqual(x.names(game.id, 2).sort(), ['a', 'a1', 'a2', 'a3', 'b', 'b1', 'c', 'c1', 'c1a', 'root']);
    assert.strictEqual(x.db.getVersion(game.id, 2).node_count, 10);
    assert.ok(x.world.calls('app.bsky.feed.getPosts').every(p => [].concat(p.uris).length <= 25));
  } finally { await x.done(); }
});

test('a deleted post is wiped from every version, but only on the second miss an hour apart; replies stay attached', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL);
    const { game, job, crawler } = await x.create('root');
    await crawler.run(job);
    x.world.remove('c1');
    await x.refresh(game);                                   // first miss
    const c1 = () => x.db.getNodeByUri(game.id, x.world.uri('c1'));
    assert.strictEqual(c1().state, 'live'); assert.strictEqual(c1().missing_checks, 1);
    x.clock.t += 30 * 60_000; await x.refresh(game);         // half an hour later: not counted again
    assert.strictEqual(c1().state, 'live'); assert.strictEqual(c1().missing_checks, 1);
    x.clock.t += 31 * 60_000; await x.refresh(game);         // over an hour after the first: second miss
    const gone = c1();
    assert.strictEqual(gone.state, 'deleted');
    assert.deepStrictEqual([gone.uri, gone.did, gone.handle, gone.text, gone.created_at], [null, null, null, null, null]);
    for (const n of [1, 2, 3, 4]) {
      const rows = x.db.nodesForVersion(game.id, n);
      assert.ok(!rows.some(r => r.text === 'text of c1'), 'wiped in version ' + n);
    }
    const kid = x.db.getNodeByUri(game.id, x.world.uri('c1a'));
    assert.strictEqual(kid.parent_id, gone.id, 'reply stays attached to the tombstone');
    assert.strictEqual(kid.state, 'live');
  } finally { await x.done(); }
});

test('a Bluesky error, or an empty answer from a sick Bluesky, wipes nothing', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL);
    const { game, job, crawler } = await x.create('root');
    await crawler.run(job);
    x.world.failAlways({ status: 500 });
    await assert.rejects(x.refresh(game, 5000, { maxAttempts: 2 }), BskyUnavailable);
    x.world.heal();
    // an empty batch while the health probe also comes back empty: Bluesky is not trusted
    x.world.failNext(2, { blank: true });
    await assert.rejects(x.refresh(game), BskyUnavailable);
    const rows = x.db.nodesForVersion(game.id, 1);
    assert.ok(rows.every(r => r.state === 'live' && r.missing_checks === 0), 'nothing was struck or wiped');
  } finally { await x.done(); }
});

test('an empty batch is believed when a known-live post still answers: strikes are counted, nothing is wiped', async () => {
  const x = await setup();
  try {
    x.world.post('root'); for (let i = 0; i < 30; i++) x.world.quote('root', 'k' + String(i).padStart(2, '0'));
    const { game, job, crawler } = await x.create('root');
    await crawler.run(job);
    x.world.passNext(1); x.world.failNext(1, { blank: true });   // the control answers, then the first batch of 25 comes back empty
    await x.refresh(game);
    const rows = x.db.nodesForVersion(game.id, 1);
    assert.ok(rows.every(r => r.state === 'live'));
    assert.strictEqual(rows.filter(r => r.missing_checks === 1).length, 25, 'strike recorded for the posts that did not answer');
    // a day later the same thing again: still no wipe, because the batch was empty
    x.clock.t += 25 * 3600_000; x.world.passNext(1); x.world.failNext(1, { blank: true });
    await x.refresh(game);
    assert.ok(x.db.nodesForVersion(game.id, 1).every(r => r.state === 'live'), 'an empty batch alone never wipes');
    // a day after that Bluesky answers normally and the posts are back: strikes clear
    x.clock.t += 25 * 3600_000; await x.refresh(game);
    assert.ok(x.db.nodesForVersion(game.id, 1).every(r => r.state === 'live' && r.missing_checks === 0));
  } finally { await x.done(); }
});

test('a tiny game with nothing else to test Bluesky against does not trust an empty answer', async () => {
  const x = await setup();
  try {
    x.world.tree('root', { a: {}, b: {} });
    const { game, job, crawler } = await x.create('root');
    await crawler.run(job);
    x.world.passNext(1); x.world.failNext(1, { blank: true });
    await assert.rejects(x.refresh(game), BskyUnavailable);
    assert.ok(x.db.nodesForVersion(game.id, 1).every(r => r.missing_checks === 0));
  } finally { await x.done(); }
});

test('a post that gains a label, or whose author is suppressed, is tombstoned at the next refresh', async () => {
  const x = await setup();
  try {
    x.world.tree('root', { a: {}, b: {}, c: {} });
    const { game, job, crawler } = await x.create('root');
    await crawler.run(job);
    x.world.posts.get('a').labels = ['nudity'];
    x.db.addSuppression(x.world.did('b'), game.id);
    await x.refresh(game);
    const st = n => x.db.getNodeByUri(game.id, x.world.uri(n));
    assert.strictEqual(st('c').state, 'live');
    const rows = x.db.nodesForVersion(game.id, 1);
    assert.strictEqual(rows.filter(r => r.state === 'label_hidden').length, 1);
    assert.strictEqual(rows.filter(r => r.state === 'removed_by_author').length, 1);
    assert.ok(!rows.some(r => r.text === 'text of a' || r.text === 'text of b'));
  } finally { await x.done(); }
});

test('a 429 is honored: everyone is paused for the Retry-After, then the request is retried', async () => {
  const x = await setup();
  try {
    x.world.tree('root', { a: {} });
    const client = x.mkClient({ maxAttempts: 3 });
    x.world.failNext(1, { status: 429, headers: { 'retry-after': '7' } });
    const posts = await client.getPosts([x.world.uri('root')]);
    assert.strictEqual(posts.length, 1);
    assert.deepStrictEqual(x.budget.penalties, [7000]);
    assert.strictEqual(x.world.count('app.bsky.feed.getPosts'), 2);
    x.budget.penalties.length = 0;
    x.world.failAlways({ status: 429 });
    await assert.rejects(client.getPosts([x.world.uri('root')]), BskyUnavailable);
    assert.strictEqual(x.budget.penalties.length, 3, 'three tries, each pausing everyone (15 s when no Retry-After)');
    assert.ok(x.budget.penalties.every(ms => ms === 15000));
  } finally { await x.done(); }
});

test('hostile text, handles and SQL-looking strings round-trip untouched', async () => {
  const x = await setup();
  try {
    const nasty = `'); DROP TABLE node;-- <script>alert(1)</script> "quoted" \\ ${'😀'.repeat(5)}`;
    x.world.post('root'); x.world.post('evil', { text: nasty }); x.world.quote('root', 'evil');
    const { game, job, crawler } = await x.create('root');
    await crawler.run(job);
    assert.strictEqual(x.db.getNodeByUri(game.id, x.world.uri('evil')).text, nasty);
    assert.strictEqual(x.db.nodeCount(game.id), 2);
  } finally { await x.done(); }
});

test('quotedPostUri finds the post a post quotes (plain and with media), and ignores other embeds', () => {
  assert.strictEqual(quotedPostUri({ uri: 'x', record: { embed: { $type: 'app.bsky.embed.record', record: { uri: 'at://d/app.bsky.feed.post/q' } } } }), 'at://d/app.bsky.feed.post/q');
  assert.strictEqual(quotedPostUri({ uri: 'x', record: { embed: { $type: 'app.bsky.embed.recordWithMedia', record: { record: { uri: 'at://d/app.bsky.feed.post/m' } } } } }), 'at://d/app.bsky.feed.post/m');
  assert.strictEqual(quotedPostUri({ uri: 'x', record: { embed: { $type: 'app.bsky.embed.record', record: { uri: 'at://d/app.bsky.graph.list/l' } } } }), null);
  assert.strictEqual(quotedPostUri({ uri: 'x', record: { embed: { $type: 'app.bsky.embed.images' } } }), null);
  assert.strictEqual(quotedPostUri({ uri: 'x', record: {} }), null);
});

test('every label we hide is still a label @atproto/api defines', () => {
  const { LABELS } = require('@atproto/api');
  for (const l of HIDE_LABELS) assert.ok(l in LABELS, l);
});

test('control checks: no misses are recorded unless Bluesky answers for known-live posts at the start AND the end of the run', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL);
    const { game, job, crawler } = await x.create('root');
    await crawler.run(job);
    const noStrikes = () => assert.ok(x.db.nodesForVersion(game.id, 1).every(r => r.missing_checks === 0 && r.state === 'live'));
    x.world.remove('b');
    // 1. the control at the start is blank: stop, count nothing
    x.world.failNext(1, { blank: true });
    await assert.rejects(x.refresh(game), BskyUnavailable); noStrikes();
    // 2. the start control and the batch are fine but the control at the end is blank: the miss is not recorded
    x.world.passNext(2); x.world.failNext(1, { blank: true });
    await assert.rejects(x.refresh(game), BskyUnavailable); noStrikes();
    // 3. all fine: control, batch, control (three getPosts calls for a small game) and the miss is recorded
    x.world.clearLog();
    await x.refresh(game);
    assert.strictEqual(x.world.count('app.bsky.feed.getPosts'), 3);
    assert.strictEqual(x.db.getNodeByUri(game.id, x.world.uri('b')).missing_checks, 1);
  } finally { await x.done(); }
});

test('a game with nothing deleted needs only the start control (no extra request at the end)', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL);
    const { game, job, crawler } = await x.create('root'); await crawler.run(job);
    x.world.clearLog(); await x.refresh(game);
    assert.strictEqual(x.world.count('app.bsky.feed.getPosts'), 2, 'one control and one batch');
  } finally { await x.done(); }
});

test('the spacing between two misses is configurable, and an optional stable post is used as a control', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL); x.world.post('stable');
    const { game, job, crawler } = await x.create('root'); await crawler.run(job);
    x.world.remove('c1');
    const opts = { wipeSpacingMs: 24 * 3600_000, healthPost: x.world.uri('stable') };
    x.world.clearLog();
    await x.refresh(game, 5000, undefined, opts);
    assert.ok([].concat(x.world.calls('app.bsky.feed.getPosts')[0].uris).includes(x.world.uri('stable')), 'the configured post is asked about first');
    x.clock.t += 2 * 3600_000; await x.refresh(game, 5000, undefined, opts);
    assert.strictEqual(x.db.getNodeByUri(game.id, x.world.uri('c1')).state, 'live', 'two hours is not enough when the spacing is a day');
    x.clock.t += 23 * 3600_000; await x.refresh(game, 5000, undefined, opts);
    assert.strictEqual(x.db.getNodeByUri(game.id, x.world.uri('c1')).state, 'deleted');
    // the stable post itself going missing does not stop checks while other control posts answer
    x.world.remove('stable'); x.world.remove('b'); x.clock.t += 2 * 3600_000;
    await assert.doesNotReject(x.refresh(game, 5000, undefined, opts));
  } finally { await x.done(); }
});
