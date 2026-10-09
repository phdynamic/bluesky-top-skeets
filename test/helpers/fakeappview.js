// An in-process fake of the public AppView with a tiny, controllable world of posts.
const http = require('node:http');

class World {
  constructor() {
    this.posts = new Map();      // name -> { name, text, labels, authorLabels, quoteCountExtra, quoteOf, deleted, createdAt }
    this.children = new Map();   // name -> [child names] (quote order)
    this.handles = new Map();    // handle -> did
    this.log = [];               // [{ method, params }]
    this.failures = [];          // queued behaviours for the next calls
    this.t0 = Date.UTC(2026, 8, 1, 10, 0, 0);
  }
  did(name) { return 'did:plc:' + name; }
  uri(name) { return `at://${this.did(name)}/app.bsky.feed.post/${name}`; }
  nameOf(uri) { return uri.split('/').pop(); }
  post(name, o = {}) {
    this.posts.set(name, { name, text: 'text of ' + name, labels: [], authorLabels: [], quoteCountExtra: 0, deleted: false, createdAt: new Date(this.t0 + this.posts.size * 60000).toISOString(), ...o });
    if (!this.children.has(name)) this.children.set(name, []);
    this.handles.set(name + '.example', this.did(name));
    return this;
  }
  quote(parent, ...kids) {
    for (const k of kids) {
      if (!this.posts.has(k)) this.post(k);
      this.posts.get(k).quoteOf = this.posts.get(k).quoteOf || parent;
      this.children.get(parent).push(k);
    }
    return this;
  }
  /** a tree: tree('root', { a: { a1: {}, a2: {} }, b: {}, c: { c1: {} } }) */
  tree(rootName, spec) {
    if (!this.posts.has(rootName)) this.post(rootName);
    const walk = (parent, s) => { for (const [k, sub] of Object.entries(s)) { this.quote(parent, k); walk(k, sub); } };
    walk(rootName, spec);
    return this;
  }
  remove(name) { this.posts.get(name).deleted = true; }
  live(name) { const p = this.posts.get(name); return p && !p.deleted; }
  view(name) {
    const p = this.posts.get(name);
    const kids = (this.children.get(name) || []).filter(k => this.live(k));
    const v = {
      uri: this.uri(name),
      author: { did: this.did(name), handle: name + '.example', displayName: name.toUpperCase(), labels: p.authorLabels.map(val => ({ val })) },
      record: { text: p.text, createdAt: p.createdAt },
      indexedAt: p.createdAt,
      quoteCount: kids.length + p.quoteCountExtra,
      labels: p.labels.map(val => ({ val })),
    };
    if (p.quoteOf && !p.noEmbed) v.record.embed = { $type: 'app.bsky.embed.record', record: { uri: this.uri(p.quoteOf) } };
    return v;
  }
  count(method) { return this.log.filter(l => l.method === method).length; }
  calls(method) { return this.log.filter(l => l.method === method).map(l => l.params); }
  clearLog() { this.log.length = 0; }
  /** the next `n` calls answer with this behaviour: {status, headers} or {blank: true} for an empty getPosts */
  failNext(n, behaviour) { for (let i = 0; i < n; i++) this.failures.push(behaviour); }
  /** let the next `n` calls through normally (to place a failure later in a sequence) */
  passNext(n) { for (let i = 0; i < n; i++) this.failures.push({ pass: true }); }
  failAlways(behaviour) { this.always = behaviour; }
  heal() { this.always = null; this.failures.length = 0; }
}

function serve(world) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const method = u.pathname.split('/').pop();
    const params = {};
    for (const [k, v] of u.searchParams) (params[k] = params[k] === undefined ? v : [].concat(params[k], v));
    world.log.push({ method, params });
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    const f = world.failures.shift() || world.always;
    if (f && !f.pass && !(f.blank && method !== 'app.bsky.feed.getPosts')) {
      if (f.blank) return send(200, { posts: [] });
      return send(f.status, { error: 'Fail', message: 'fail ' + f.status }, f.headers || {});
    }
    if (method === 'com.atproto.identity.resolveHandle') {
      const did = world.handles.get(params.handle);
      return did ? send(200, { did }) : send(400, { error: 'InvalidRequest', message: 'Unable to resolve handle' });
    }
    if (method === 'app.bsky.feed.getPosts') {
      const uris = [].concat(params.uris || []);
      if (uris.length > 25) return send(400, { error: 'InvalidRequest', message: 'array too big (maximum 25)' });
      return send(200, { posts: uris.map(x => world.nameOf(x)).filter(n => world.posts.has(n) && world.live(n)).map(n => world.view(n)) });
    }
    if (method === 'app.bsky.feed.getQuotes') {
      const name = world.nameOf(params.uri);
      if (!world.posts.has(name) || !world.live(name)) return send(400, { error: 'InvalidRequest', message: 'Post not found' });
      const kids = (world.children.get(name) || []).filter(k => world.live(k));
      const limit = Number(params.limit || 50), start = Number(params.cursor || 0);
      const page = kids.slice(start, start + limit);
      const next = start + limit < kids.length ? String(start + limit) : undefined;
      return send(200, { uri: params.uri, posts: page.map(k => world.view(k)), ...(next ? { cursor: next } : {}) });
    }
    send(404, { error: 'NotFound' });
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise(r => srv.close(r)) })));
}

/** A stand-in for the shared request budget that records penalties instead of waiting them out. */
function stubBudget() {
  const penalties = [];
  return { take: async () => {}, penalize: ms => { penalties.push(ms); }, penalties };
}

module.exports = { World, serve, stubBudget };
