const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { execFile } = require('node:child_process');
const path = require('node:path');

// A tiny fake AppView so the probe can be exercised without Bluesky.
function fakeAppView({ ratelimitAfter = Infinity, noHeaders = false } = {}) {
  let calls = 0;
  const DID = 'did:plc:probe';
  const post = (i, q) => ({ uri: `at://${DID}/app.bsky.feed.post/p${i}`, author: { handle: 'p.example', labels: [] }, labels: i === 3 ? [{ val: 'sexual' }] : [], quoteCount: q, likeCount: 5 });
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      calls++;
      const u = new URL(req.url, 'http://x');
      const send = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...(noHeaders ? {} : { 'ratelimit-limit': '3000', 'ratelimit-remaining': String(3000 - calls) }), ...headers }); res.end(JSON.stringify(body)); };
      if (calls > ratelimitAfter) return send(429, { error: 'RateLimitExceeded' }, { 'retry-after': '60' });
      const m = u.pathname.split('/').pop();
      if (m === 'com.atproto.identity.resolveHandle') return send(200, { did: DID });
      if (m === 'app.bsky.feed.getPosts') {
        const uris = u.searchParams.getAll('uris');
        if (uris.length > 25) return send(400, { error: 'InvalidRequest', message: 'too many uris' });
        return send(200, { posts: uris.map(x => post(Number(x.split('/p').pop()) || 0, 1)) });
      }
      if (m === 'app.bsky.feed.getQuotes') {
        const depth = Number(u.searchParams.get('uri').split('/p').pop()) || 0;
        if (depth >= 3) return send(200, { posts: [] });
        const list = Array.from({ length: 30 }, (_, i) => post(depth === 0 ? i + 100 : depth + 1, i === 0 ? 1 : 0));
        list[0] = post(depth + 1, 1);
        return send(200, { posts: list, cursor: 'c' });
      }
      send(404, {});
    }).listen(0, () => resolve({ srv, port: srv.address().port, calls: () => calls }));
  });
}
const run = (port, args) => new Promise(resolve => execFile('node', [path.join(__dirname, '..', 'dist', 'probe.js'), ...args], { env: { ...process.env, APPVIEW_URL: `http://127.0.0.1:${port}` } }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));

test('probe reports headers, depth, batch cap and handles a 429 burst', async () => {
  const { srv, port } = await fakeAppView({ ratelimitAfter: 40 });
  try {
    const r = await run(port, ['https://bsky.app/profile/p.example/post/p0', '--uri', 'at://did:plc:probe/app.bsky.feed.post/p9', '--burst', '100']);
    assert.ifError(r.err);
    assert.match(r.stdout, /resolveHandle p\.example: HTTP 200/);
    assert.match(r.stdout, /ratelimit-limit.*3000/);
    assert.match(r.stdout, /Chain depth reached: \d+ level/);
    assert.match(r.stdout, /getPosts with 25 URIs: HTTP 200/);
    assert.match(r.stdout, /getPosts with 26 URIs: HTTP 400/);
    assert.match(r.stdout, /--uri at:\/\/did:plc:probe\/app\.bsky\.feed\.post\/p9: HTTP 200/);
    assert.match(r.stdout, /429 after \d+ calls.*retry-after.*60/);
  } finally { srv.close(); }
});

test('probe without a link explains itself and fails politely', async () => {
  const { srv, port } = await fakeAppView();
  try {
    const r = await run(port, []);
    assert.match(r.stdout, /Give a post link/);
  } finally { srv.close(); }
});

test('probe follows the deepest chain, counts labels, and does not repeat batch sizes', async () => {
  const { srv, port } = await fakeAppView();
  try {
    const r = await run(port, ['https://bsky.app/profile/p.example/post/p0']);
    assert.match(r.stdout, /Chain depth reached: 4 level/);
    assert.match(r.stdout, /Labels on the quotes seen: \{.*sexual/);
    assert.strictEqual((r.stdout.match(/getPosts with 26 URIs/g) || []).length, 1);
    assert.match(r.stdout, /getPosts with 25 URIs: HTTP 200/);
  } finally { srv.close(); }
});

test('probe says plainly when the AppView sends no rate-limit headers', async () => {
  const { srv, port } = await fakeAppView({ noHeaders: true });
  try {
    const r = await run(port, ['https://bsky.app/profile/p.example/post/p0']);
    assert.match(r.stdout, /returned NO rate-limit headers/);
  } finally { srv.close(); }
});

test('--ramp stops at the first 429 and reports the step', async () => {
  const { srv, port } = await fakeAppView({ ratelimitAfter: 25 });
  try {
    const r = await run(port, ['https://bsky.app/profile/p.example/post/p0', '--ramp', '--ramp-seconds', '1']);
    assert.match(r.stdout, /Ramp test: 2, 4, 8, 16 requests per second/);
    assert.match(r.stdout, /First 429 during the \d+ rps step after \d+ requests in total/);
  } finally { srv.close(); }
});

test('--ramp reports plainly when no 429 is reached', async () => {
  const { srv, port } = await fakeAppView();
  try {
    const r = await run(port, ['https://bsky.app/profile/p.example/post/p0', '--ramp', '--ramp-seconds', '1']);
    assert.match(r.stdout, /No 429 up to 16 rps/);
  } finally { srv.close(); }
});
