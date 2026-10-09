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
