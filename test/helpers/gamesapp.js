// A full games app (database, queue, API, admin) in one process over a fake AppView, for tests.
const express = require('express');
const { World, serve, stubBudget } = require('./fakeappview');
const { GamesDb } = require('../../dist/games/db');
const { AppViewClient } = require('../../dist/games/appview');
const { GamesQueue } = require('../../dist/games/queue');
const { GamesLimits } = require('../../dist/games/ratelimit');
const { GamesSweeper } = require('../../dist/games/sweep');
const { createGamesRouter } = require('../../dist/games/api');
const { createAdminRouter } = require('../../dist/games/admin');
const { createAccountRouter } = require('../../dist/games/auth/routes');
const { SessionStore } = require('../../dist/games/auth/sessions');
const { FakeProvider } = require('./fakeauth');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function setup(o = {}) {
  const world = new World(), fake = await serve(world), budget = stubBudget();
  const clock = { t: Date.UTC(2026, 9, 8, 12, 0, 0) };
  const db = new GamesDb(o.file || ':memory:', () => clock.t);
  const kinds = [];
  const client = (opts = {}) => new AppViewClient({ baseUrl: fake.url, budget, userAgent: 'test', gapMs: 0, maxAttempts: 3, sleep: async () => {}, ...opts });
  const queue = new GamesQueue({ db, sizeCap: o.sizeCap ?? 5000, makeAppView: kind => { kinds.push(kind); return client(); }, retryDelayMs: 5, maxRetries: 2, idleMs: 10 });
  const limits = new GamesLimits({ lookupsPerIpPerHour: 100, createsPerIpPerHour: 50, refreshesPerIpPerHour: 50, reportsPerIpPerHour: o.reports ?? 10, rechecksPerIpPerHour: 50 }, () => clock.t);
  const app = express(); app.use(express.json());
  const makeLookupClient = () => client({ maxAttempts: 2 });
  app.use('/api/games', createGamesRouter({ db, queue, limits, makeLookupClient, sizeCap: o.sizeCap ?? 5000,
    refreshCooldownMs: 6 * 3600_000, recheckCooldownMs: 60 * 60_000, maxCreatesPerDay: 100, maxQueued: 20, trustedProxyHops: 1, now: () => clock.t }));
  const SECRET = 'a-long-test-secret';
  app.use('/api/admin', createAdminRouter({ db, secret: SECRET, makeLookupClient, trustedProxyHops: 1, now: () => clock.t }));
  const provider = o.provider || new FakeProvider();
  const PUBLIC = o.publicUrl || 'http://kiosk.test';
  const sessions = new SessionStore(3600_000, () => clock.t);
  app.use(createAccountRouter({ db, provider, sessions, publicUrl: PUBLIC, trustedProxyHops: 1, startsPerIpPerHour: o.startsPerHour ?? 50, now: () => clock.t }));
  const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const origin = `http://127.0.0.1:${srv.address().port}`;
  if (o.run !== false) queue.start();
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(origin + path, { method, headers: { 'content-type': 'application/json', 'accept-encoding': 'identity', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; const text = await r.text(); try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  const req = (m, p, b, h) => call(m, '/api/games' + p, b, h);
  const admin = (m, p, b, h = {}) => call(m, '/api/admin' + p, b, { authorization: 'Bearer ' + SECRET, ...h });
  const link = name => `https://bsky.app/profile/${name}.example/post/${name}`;
  const waitFor = async (fn, what = 'condition') => { for (let i = 0; i < 400; i++) { const v = await fn(); if (v) return v; await sleep(15); } throw new Error('timed out waiting for ' + what); };
  const waitReady = id => waitFor(async () => { const s = (await req('GET', `/${id}/status`)).json; return s && s.state === 'ready' ? s : null; }, 'game ' + id + ' ready');
  const waitIdle = id => waitFor(() => !db.activeJob(id), 'jobs of ' + id + ' to finish');
  const create = async name => { const r = await req('POST', '/', { post: link(name) }, { 'x-forwarded-for': 'x, 198.51.100.' + Math.floor(Math.random() * 250) }); if (r.status !== 202) throw new Error('create failed ' + JSON.stringify(r.json)); await waitReady(r.json.id); return r.json.id; };
  // sign in as `handle` (through the stand-in provider); returns what the browser would hold
  const signIn = async (handle, ip = '1.2.3.4') => {
    const start = await call('POST', '/api/auth/start', { handle }, { 'x-forwarded-for': 'x, ' + ip });
    if (start.status !== 200) return { start };
    const flow = /kiosk_signin=([^;]+)/.exec(start.headers.get('set-cookie') || '')[1];
    const cb = await fetch(origin + start.json.url, { redirect: 'manual', headers: { cookie: 'kiosk_signin=' + flow } });
    const setc = cb.headers.getSetCookie ? cb.headers.getSetCookie() : [];
    const sess = setc.map(c => /kiosk_session=([^;]*)/.exec(c)).filter(Boolean)[0];
    const cookie = sess && sess[1] ? 'kiosk_session=' + sess[1] : null;
    const me = cookie ? (await call('GET', '/api/me', undefined, { cookie })).json : null;
    return { start, cb, cookie, csrf: me && me.csrf, me, flow, setCookies: setc };
  };
  const as = (a, method, path, body, extra = {}) => call(method, path, body, { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: PUBLIC, ...extra });
  const sweeper = new GamesSweeper({ db, queue, sweepIntervalMs: 7 * 86_400_000, reportRetentionMs: 30 * 86_400_000, now: () => clock.t });
  const done = async () => { await queue.stop(); await new Promise(r => srv.close(r)); await fake.close(); db.close(); };
  return { world, fake, db, clock, queue, sweeper, req, admin, call, link, create, waitReady, waitIdle, waitFor, done, kinds, SECRET, origin, provider, sessions, signIn, as, PUBLIC };
}
module.exports = { setup, sleep };
