const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { setup } = require('./helpers/gamesapp');
const { GamesDb, uriHash } = require('../dist/games/db');

const SMALL = { a: { a1: {}, a2: {} }, b: {}, c: { c1: {} } };
const DAY = 86_400_000;

test('a version 1 database upgrades to version 2 in place, keeping its games', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-')), 'games.sqlite');
  const old = new Database(file);
  old.exec(`CREATE TABLE game (id TEXT PRIMARY KEY, root_uri TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, frozen INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active');
    CREATE TABLE version (game_id TEXT NOT NULL, n INTEGER NOT NULL, captured_at INTEGER NOT NULL, node_count INTEGER NOT NULL, max_depth INTEGER NOT NULL, status TEXT NOT NULL, partial_reason TEXT, missing_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (game_id, n));
    CREATE TABLE node (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, v_added INTEGER NOT NULL, ord INTEGER NOT NULL, uri TEXT, uri_hash TEXT NOT NULL, did TEXT, handle TEXT, display_name TEXT, text TEXT, created_at TEXT, parent_id INTEGER, depth INTEGER NOT NULL, quote_count INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'live', missing_checks INTEGER NOT NULL DEFAULT 0, last_missing_at INTEGER NOT NULL DEFAULT 0, cursor TEXT NOT NULL DEFAULT '', exhausted INTEGER NOT NULL DEFAULT 0, UNIQUE (game_id, uri_hash));
    CREATE TABLE suppression (did TEXT NOT NULL, scope TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (did, scope));
    CREATE TABLE crawl_job (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, version_n INTEGER NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, requests INTEGER NOT NULL DEFAULT 0, nodes_added INTEGER NOT NULL DEFAULT 0, error TEXT, retry_count INTEGER NOT NULL DEFAULT 0);`);
  old.prepare("INSERT INTO game (id, root_uri, created_at) VALUES ('abcdefghij', 'at://did:plc:x/app.bsky.feed.post/p', 1)").run();
  old.pragma('user_version = 1'); old.close();
  const db = new GamesDb(file);
  const g = db.getGame('abcdefghij');
  assert.strictEqual(g.root_hash, uriHash('at://did:plc:x/app.bsky.feed.post/p'));
  assert.strictEqual(db.getGameByRoot('at://did:plc:x/app.bsky.feed.post/p').id, 'abcdefghij');
  assert.strictEqual(db.addReport('abcdefghij', null, 'other', 'hi') > 0, true);
  assert.strictEqual(db.db.pragma('user_version', { simple: true }), 2);
  db.close();
  assert.doesNotThrow(() => new GamesDb(file).close(), 'opening it again is fine');
});

test('reports: validated, mapped to the card, and no reporter identity is stored anywhere', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL);
    const id = await x.create('root');
    const data = (await x.req('GET', `/${id}/data.json`)).json;
    const pos = data.nodes.findIndex(n => n.k === 'a1');
    const xff = { 'x-forwarded-for': 'forged, 203.0.113.99' };
    let r = await x.req('POST', `/${id}/report`, { reason: 'nonsense' }, xff); assert.strictEqual(r.status, 400); assert.strictEqual(r.json.message, 'Pick a reason for the report.');
    r = await x.req('POST', `/${id}/report`, {}, xff); assert.strictEqual(r.status, 400);
    const long = 'x'.repeat(900) + '\u0000\u0007bell';
    r = await x.req('POST', `/${id}/report`, { reason: 'harassment', note: long, version: 1, pos }, xff);
    assert.strictEqual(r.status, 201); assert.strictEqual(r.json.message, "Thanks. We've got it.");
    r = await x.req('POST', `/${id}/report`, { reason: 'removal', note: '  please remove  ' }, xff); assert.strictEqual(r.status, 201);
    const rows = x.db.listReports('open');
    assert.strictEqual(rows.length, 2);
    const withNode = rows.find(q => q.reason === 'harassment');
    assert.strictEqual(withNode.note.length, 500); assert.ok(!/[\u0000-\u0008]/.test(withNode.note));
    assert.strictEqual(x.db.getNode(withNode.node_id).uri_hash, uriHash(x.world.uri('a1')), 'the report points at the card that was clicked');
    assert.strictEqual(rows.find(q => q.reason === 'removal').node_id, null);
    assert.strictEqual(rows.find(q => q.reason === 'removal').note, 'please remove');
    assert.deepStrictEqual(Object.keys(rows[0]).sort(), ['created_at', 'game_id', 'id', 'node_id', 'note', 'reason', 'resolved_at', 'status'], 'a report has no identity columns');
    // nothing about the sender anywhere in the database
    const dump = JSON.stringify(x.db.db.prepare("SELECT * FROM report").all()) + JSON.stringify(x.db.db.prepare('SELECT * FROM admin_log').all());
    assert.ok(!/203\.0\.113\.99|forged/.test(dump));
    // an unavailable game answers like any other
    const bad = await x.req('POST', '/zzzzzzzzzz/report', { reason: 'other' }); assert.strictEqual(bad.status, 404);
  } finally { await x.done(); }
});

test('report rate limit', async () => {
  const x = await setup({ reports: 2 });
  try {
    x.world.tree('root', SMALL); const id = await x.create('root');
    const send = ip => x.req('POST', `/${id}/report`, { reason: 'other' }, { 'x-forwarded-for': 'a, ' + ip });
    assert.strictEqual((await send('1.1.1.1')).status, 201); assert.strictEqual((await send('1.1.1.1')).status, 201);
    assert.strictEqual((await send('1.1.1.1')).status, 429); assert.strictEqual((await send('2.2.2.2')).status, 201);
  } finally { await x.done(); }
});

test('"check for deleted posts": rate limited, and a deleted post is wiped only on the second miss a day apart', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL); const id = await x.create('root');
    let r = await x.req('POST', `/${id}/recheck`);
    assert.strictEqual(r.status, 429); assert.match(r.json.message, /checked recently\. You can check again in/);
    x.clock.t += 2 * 3600_000; x.world.remove('c1');
    r = await x.req('POST', `/${id}/recheck`); assert.strictEqual(r.status, 202);
    await x.waitIdle(id);
    const c1 = () => x.db.getNodeByUri(id, x.world.uri('c1'));
    assert.strictEqual(c1().state, 'live'); assert.strictEqual(c1().missing_checks, 1);
    assert.strictEqual(x.db.latestVersion(id).n, 1, 'a re-check never writes a version');
    x.clock.t += 2 * 3600_000; r = await x.req('POST', `/${id}/recheck`); assert.strictEqual(r.status, 202); await x.waitIdle(id);
    assert.strictEqual(c1().state, 'live', 'same day: no second strike');
    x.clock.t += 25 * 3600_000; r = await x.req('POST', `/${id}/recheck`); assert.strictEqual(r.status, 202); await x.waitIdle(id);
    assert.strictEqual(c1().state, 'deleted');
    assert.ok(x.kinds.includes('recheck'));
    const st = (await x.req('GET', `/${id}/status`)).json; assert.ok(st.lastCheckedAt);
  } finally { await x.done(); }
});

test('the weekly sweep queues re-checks for games that are due, behind visitors, and drops old resolved reports', async () => {
  const x = await setup({ run: false });
  try {
    x.world.tree('g1', {}); x.world.tree('g2', {}); x.world.tree('g3', {});
    x.queue.start(); const a = await x.create('g1'), b = await x.create('g2'); await x.queue.stop();
    assert.strictEqual(x.sweeper.tick(), 0, 'just checked: nothing is due');
    x.clock.t += 8 * DAY;
    // a visitor asks for a creation while sweeps are pending
    assert.strictEqual(x.sweeper.tick(), 2);
    assert.strictEqual(x.sweeper.tick(), 0, 'games with a job waiting are not queued twice');
    const g3 = x.db.createGame(x.world.uri('g3')); const job = x.db.createJob(g3.id, 'create', 1);
    const order = x.db.listQueued().map(j => j.kind);
    assert.deepStrictEqual(order, ['create', 'recheck', 'recheck'], 'what a visitor waits for goes first');
    assert.strictEqual(x.db.queuedCount(), 1, 'background re-checks do not count against the visitor queue cap');
    // reports
    x.db.addReport(a, null, 'other', 'old'); x.db.addReport(a, null, 'other', 'open');
    const [oldR] = x.db.listReports('open').filter(r => r.note === 'old'); x.db.setReportStatus(oldR.id, 'resolved');
    x.clock.t += 31 * DAY; x.sweeper.tick();
    assert.deepStrictEqual(x.db.listReports('all').map(r => r.note), ['open'], 'resolved report purged after 30 days; open one kept');
  } finally { await x.done(); }
});

test('admin: nothing works without the secret, and wrong guesses are limited', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL); const id = await x.create('root');
    let n = 0; const ip = () => ({ 'x-forwarded-for': 'a, 10.1.1.' + (++n) });
    for (const [m, p] of [['GET', '/reports'], ['GET', '/log'], ['GET', '/lookup?q=x'], ['POST', `/game/${id}`], ['POST', '/suppress'], ['POST', '/node/1/tombstone'], ['POST', '/report/1']]) {
      const r = await x.call(m, '/api/admin' + p, m === 'POST' ? {} : undefined, ip()); assert.strictEqual(r.status, 401, m + ' ' + p);
    }
    assert.strictEqual((await x.call('GET', '/api/admin/reports', undefined, { authorization: 'Bearer wrong', ...ip() })).status, 401);
    assert.strictEqual((await x.call('GET', '/api/admin/reports', undefined, { authorization: 'Basic ' + x.SECRET, ...ip() })).status, 401);
    for (let i = 0; i < 8; i++) await x.call('GET', '/api/admin/reports', undefined, { authorization: 'Bearer nope' + i, 'x-forwarded-for': 'a, 7.7.7.7' });
    const blocked = await x.call('GET', '/api/admin/reports', undefined, { authorization: 'Bearer ' + x.SECRET, 'x-forwarded-for': 'a, 7.7.7.7' });
    assert.strictEqual(blocked.status, 429, 'after too many wrong tries even the right secret waits');
    const other = await x.admin('GET', '/reports', undefined, { 'x-forwarded-for': 'a, 8.8.8.8' }); assert.strictEqual(other.status, 200);
    assert.strictEqual(other.headers.get('cache-control'), 'no-store'); assert.strictEqual(other.headers.get('x-robots-tag'), 'noindex, nofollow');
  } finally { await x.done(); }
});

test('admin: reports show the card, resolve and dismiss; actions are logged without reporter data', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL); x.world.posts.get('a1').text = 'the reported words';
    const id = await x.create('root');
    const data = (await x.req('GET', `/${id}/data.json`)).json; const pos = data.nodes.findIndex(n => n.k === 'a1');
    await x.req('POST', `/${id}/report`, { reason: 'personal_info', note: 'it has my address', version: 1, pos });
    let r = (await x.admin('GET', '/reports')).json;
    assert.strictEqual(r.open, 1); assert.strictEqual(r.reports.length, 1);
    const rep = r.reports[0];
    assert.strictEqual(rep.reason, 'personal_info'); assert.strictEqual(rep.node.text, 'the reported words'); assert.strictEqual(rep.node.handle, 'a1.example');
    assert.match(rep.node.postLink, /^https:\/\/bsky\.app\/profile\/did:plc:a1\/post\/a1$/); assert.strictEqual(rep.game.id, id);
    // wipe that card
    assert.strictEqual((await x.admin('POST', `/node/${rep.node.id}/tombstone`, { state: 'bogus' })).status, 400);
    assert.strictEqual((await x.admin('POST', `/node/${rep.node.id}/tombstone`, { state: 'removed_by_author' })).status, 200);
    const after = (await x.req('GET', `/${id}/data.json`)).json;
    assert.deepStrictEqual(Object.keys(after.nodes[pos]).sort(), ['p', 'tomb']); assert.strictEqual(after.nodes[pos].tomb, 'removed');
    assert.ok(!JSON.stringify(after).includes('the reported words'));
    assert.strictEqual((await x.admin('POST', `/report/${rep.id}`, { status: 'resolved' })).status, 200);
    assert.strictEqual((await x.admin('GET', '/reports')).json.reports.length, 0);
    assert.strictEqual((await x.admin('GET', '/reports?status=resolved')).json.reports.length, 1);
    assert.strictEqual((await x.admin('POST', '/report/999', { status: 'resolved' })).status, 404);
    const log = (await x.admin('GET', '/log')).json.log.map(l => l.action);
    assert.deepStrictEqual(log, ['report.resolved', 'node.removed_by_author']);
  } finally { await x.done(); }
});

test('admin: hide, unhide, freeze and delete a game; a deleted game cannot be quietly recreated', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL); const id = await x.create('root');
    const unknown = JSON.stringify((await x.req('GET', '/zzzzzzzzzz/data.json')).json);
    let r = await x.admin('POST', `/game/${id}`, { action: 'hide' }); assert.strictEqual(r.json.status, 'hidden');
    assert.strictEqual(JSON.stringify((await x.req('GET', `/${id}/data.json`)).json), unknown, 'hidden looks like unknown');
    r = await x.admin('POST', `/game/${id}`, { action: 'unhide' }); assert.strictEqual(r.json.status, 'active');
    assert.strictEqual((await x.req('GET', `/${id}/data.json`)).status, 200);
    r = await x.admin('POST', `/game/${id}`, { action: 'freeze' }); assert.strictEqual(r.json.frozen, true);
    assert.strictEqual((await x.req('POST', `/${id}/refresh`)).status, 403);
    await x.admin('POST', `/game/${id}`, { action: 'unfreeze' });
    assert.strictEqual((await x.admin('POST', `/game/${id}`, { action: 'explode' })).status, 400);
    assert.strictEqual((await x.admin('POST', '/game/zzzzzzzzzz', { action: 'hide' })).status, 404);
    r = await x.admin('POST', `/game/${id}`, { action: 'delete' }); assert.strictEqual(r.json.status, 'deleted'); assert.strictEqual(r.json.counts.nodes, 0);
    assert.strictEqual(x.db.nodeCount(id), 0); assert.strictEqual(x.db.listVersions(id).length, 0);
    assert.strictEqual(x.db.getGame(id).root_uri, 'deleted:' + id, 'the stored post address is gone');
    assert.strictEqual((await x.req('GET', `/${id}/data.json`)).status, 404);
    const again = await x.req('POST', '/', { post: x.link('root') }, { 'x-forwarded-for': 'a, 9.9.9.9' });
    assert.strictEqual(again.status, 404); assert.strictEqual(again.json.message, "This game isn't available.");
    assert.strictEqual((await x.admin('POST', `/game/${id}`, { action: 'hide' })).status, 409);
  } finally { await x.done(); }
});

test('admin: keeping an account out wipes what is stored and stops it coming back on refresh', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL); x.world.tree('other', { a: {} });   // both games contain the account "a"
    const g1 = await x.create('root'), g2 = await x.create('other');
    let r = await x.admin('GET', '/lookup?q=' + encodeURIComponent('@a.example'));
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.json.games.map(g => g.id).sort(), [g1, g2].sort()); assert.ok(r.json.games.every(g => g.posts === 1));
    r = await x.admin('POST', '/suppress', { account: '@a.example', scope: g1 }); assert.deepStrictEqual([r.status, r.json.wiped], [200, 1]);
    assert.strictEqual(x.db.getNodeByUri(g1, x.world.uri('a')).state, 'removed_by_author');
    assert.strictEqual(x.db.getNodeByUri(g2, x.world.uri('a')).state, 'live', 'the other game is untouched by a one-game scope');
    // the account posts a new quote; the next refresh does not store it in g1
    x.world.quote('root', 'a'); x.world.post('a2'); x.world.handles.set('a2.example', x.world.did('a2'));
    x.world.posts.get('a2').text = 'later';
    x.clock.t += 7 * 3600_000;
    r = await x.req('POST', `/${g1}/refresh`); assert.strictEqual(r.status, 202); await x.waitIdle(g1);
    r = await x.admin('POST', '/suppress', { account: x.world.did('a'), scope: 'all' }); assert.strictEqual(r.status, 200);
    assert.strictEqual(x.db.getNodeByUri(g2, x.world.uri('a')).state, 'removed_by_author');
    assert.strictEqual((await x.admin('POST', '/suppress', { account: 'a.example', scope: 'bad scope' })).status, 400);
    assert.strictEqual((await x.admin('POST', '/suppress', { account: 'a.example', scope: 'zzzzzzzzzz' })).status, 404);
    assert.strictEqual((await x.admin('POST', '/suppress', { account: 'nobody.example', scope: 'all' })).status, 404);
    // a fresh game rooted elsewhere never stores the suppressed account's text
    x.world.tree('third', { a: {} });
    const g3 = await x.create('third');
    const st = x.db.getNodeByUri(g3, x.world.uri('a')); assert.strictEqual(st.state, 'removed_by_author'); assert.strictEqual(st.text, null);
  } finally { await x.done(); }
});

test('admin: lookup by game id and by post link', async () => {
  const x = await setup();
  try {
    x.world.tree('root', SMALL); const id = await x.create('root');
    let r = await x.admin('GET', '/lookup?q=' + id); assert.strictEqual(r.json.games[0].id, id); assert.match(r.json.games[0].rootLink, /post\/root$/);
    r = await x.admin('GET', '/lookup?q=' + encodeURIComponent(x.link('root'))); assert.strictEqual(r.json.games[0].id, id);
    r = await x.admin('GET', '/lookup?q=' + encodeURIComponent('https://bsky.app/profile/root.example/post/zzz')); assert.deepStrictEqual(r.json.games, []);
    assert.strictEqual((await x.admin('GET', '/lookup?q=' + encodeURIComponent(x.link('nobody')))).status, 404);
    assert.strictEqual((await x.admin('GET', '/lookup?q=')).status, 400);
  } finally { await x.done(); }
});
