import express from 'express';
import zlib from 'zlib';
import crypto from 'crypto';
import { GamesDb, GameRow, NodeRow, ReportReason } from './db';
import { AppViewClient, BskyUnavailable, NotFound, PostView } from './appview';
import { GameCrawler, quotedPostUri } from './crawler';
import { GamesQueue } from './queue';
import { GamesLimits } from './ratelimit';
import { parsePostLink } from '../links';
import { clientIp, hashIp } from '../clientip';

export interface GamesApiOptions {
  db: GamesDb;
  queue: GamesQueue;
  /** A short-lived client for the quick lookups done while answering a request. */
  makeLookupClient: () => AppViewClient;
  limits: GamesLimits;
  sizeCap: number;
  refreshCooldownMs: number;
  recheckCooldownMs: number;
  maxCreatesPerDay: number;
  maxQueued: number;
  trustedProxyHops: number;
  now?: () => number;
}

const MSG = {
  badLink: "That doesn't look like a post link. It should end in /post/ and a string of letters and numbers.",
  postNotFound: "We couldn't find a public post at that link.",
  noAccount: "We couldn't find that account.",
  bskyDown: "Bluesky didn't answer. Try again in a minute.",
  tooMany: 'Too many requests from here. Try again in a few minutes.',
  notAvailable: "This game isn't available.",
  frozen: 'This game is frozen by the person who wrote the original post. It can still be viewed.',
};

const TOMB_LABEL: Record<string, string> = { deleted: 'deleted', removed_by_author: 'removed', label_hidden: 'label' };

export const REPORT_REASONS: ReportReason[] = ['personal_info', 'harassment', 'label', 'wrong', 'removal', 'other'];

function fmtDuration(sec: number): string {
  if (sec < 90) return `${Math.max(1, Math.round(sec))} seconds`;
  const m = Math.round(sec / 60);
  if (m < 90) return `${m} minutes`;
  const h = sec / 3600;
  return `${h >= 10 ? Math.round(h) : Math.round(h * 10) / 10} hours`;
}

export function createGamesRouter(o: GamesApiOptions): express.Router {
  const { db, queue, limits } = o;
  const now = o.now ?? Date.now;
  const router = express.Router();

  // Saved pages must never be indexed, and none of these responses should be cached by anyone else.
  router.use((_req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-cache');
    next();
  });

  const ipKey = (req: express.Request) => hashIp(clientIp(req, o.trustedProxyHops));
  const notAvailable = (res: express.Response) => res.status(404).json({ error: 'NotAvailable', message: MSG.notAvailable });
  const limited = (res: express.Response, retryAfterSec: number) => {
    res.setHeader('Retry-After', String(retryAfterSec));
    res.status(429).json({ error: 'TooManyRequests', message: MSG.tooMany, retryAfterSec });
  };
  /** An active game, or nothing: hidden, deleted and unknown games all look the same. */
  const activeGame = (id: string): GameRow | undefined => {
    if (!/^[a-z0-9]{10}$/.test(id)) return undefined;
    const g = db.getGame(id);
    return g && g.status === 'active' ? g : undefined;
  };

  function refreshInfo(game: GameRow) {
    const active = db.activeJob(game.id);
    const last = db.latestVersion(game.id);
    const lastJob = db.lastJob(game.id);
    const base = Math.max(last?.captured_at ?? 0, lastJob?.finished_at ?? 0);
    const availableAt = base ? base + o.refreshCooldownMs : 0;
    const secondsLeft = Math.max(0, Math.ceil((availableAt - now()) / 1000));
    return { active, available: !game.frozen && !active && secondsLeft === 0, availableAt, secondsLeft };
  }

  // ---- create (or find) a game
  router.post('/', async (req, res) => {
    const ip = ipKey(req);
    const body = (req.body ?? {}) as { post?: unknown; start?: unknown };
    const raw = typeof body.post === 'string' ? body.post.slice(0, 600) : '';
    if (!raw.trim()) return res.status(400).json({ error: 'BadLink', message: 'Paste a post link first.' });
    const parsed = parsePostLink(raw);
    if (!parsed) return res.status(400).json({ error: 'BadLink', message: MSG.badLink });
    const look = limits.lookup(ip); if (!look.ok) return limited(res, look.retryAfterSec);

    const client = o.makeLookupClient();
    try {
      let did = parsed.id;
      if (!did.startsWith('did:')) {
        try { did = await client.resolveHandle(parsed.id); }
        catch (e) { if (e instanceof NotFound) return res.status(404).json({ error: 'NoAccount', message: MSG.noAccount }); throw e; }
      }
      const fetchOne = async (uri: string): Promise<PostView | undefined> => (await client.getPosts([uri]))[0];
      let post = await fetchOne(`at://${did}/app.bsky.feed.post/${parsed.rkey}`);
      if (!post) return res.status(404).json({ error: 'PostNotFound', message: MSG.postNotFound });

      const quoted = quotedPostUri(post);
      const start = body.start === 'this' || body.start === 'original' ? body.start : null;
      if (quoted && !start) return res.json({ status: 'is_quote', quotedUri: quoted });
      if (quoted && start === 'original') {
        const orig = await fetchOne(quoted);
        if (!orig) return res.status(404).json({ error: 'PostNotFound', message: MSG.postNotFound });
        post = orig;
      }

      const existing = db.getGameByRoot(post.uri);
      if (existing) return existing.status === 'active' ? res.json({ status: 'exists', id: existing.id }) : notAvailable(res);

      // Past the cheap checks: this is a real creation, so it counts against the creation limits.
      const c = limits.create(ip); if (!c.ok) return limited(res, c.retryAfterSec);
      if (db.gamesCreatedSince(now() - 24 * 3600_000) >= o.maxCreatesPerDay || db.queuedCount() >= o.maxQueued) {
        return limited(res, 600);
      }
      const crawler = new GameCrawler({ db, appview: client, sizeCap: o.sizeCap });
      const game = crawler.createGame(post);
      db.createJob(game.id, 'create', 1);
      queue.kick();
      return res.status(202).json({ status: 'queued', id: game.id });
    } catch (e) {
      if (e instanceof BskyUnavailable) return res.status(503).json({ error: 'BskyUnavailable', message: MSG.bskyDown });
      if (e instanceof NotFound) return res.status(404).json({ error: 'PostNotFound', message: MSG.postNotFound });
      console.error('[games] create failed:', e instanceof Error ? e.message : String(e));
      return res.status(500).json({ error: 'ServerError', message: 'Something went wrong. Try again in a minute.' });
    }
  });

  // ---- progress and state
  router.get('/:id/status', (req, res) => {
    const game = activeGame(req.params.id); if (!game) return notAvailable(res);
    const r = refreshInfo(game);
    const job = r.active ?? db.lastJob(game.id);
    const versions = db.listVersions(game.id);
    res.json({
      id: game.id,
      frozen: !!game.frozen,
      state: r.active ? r.active.state : versions.length ? 'ready' : (job?.state ?? 'none'),
      kind: job?.kind ?? null,
      queuedAhead: r.active && r.active.state === 'queued' ? db.queuedAhead(r.active.id) : 0,
      requests: job?.requests ?? 0,
      quotesFound: Math.max(0, db.nodeCount(game.id) - 1),
      latest: versions.length ? versionSummary(versions[versions.length - 1]) : null,
      versions: versions.map((v, i) => ({ n: v.n, capturedAt: v.captured_at, nodeCount: v.node_count, added: v.node_count - (i ? versions[i - 1].node_count : 1) , status: v.status })),
      refresh: { available: r.available, availableAt: r.availableAt || null, secondsLeft: r.secondsLeft },
      failed: job?.state === 'failed',
      lastCheckedAt: game.last_checked_at || null,
      recheck: { secondsLeft: Math.max(0, Math.ceil(((game.last_checked_at || 0) + o.recheckCooldownMs - now()) / 1000)) },
    });
  });

  router.post('/:id/refresh', (req, res) => {
    const game = activeGame(req.params.id); if (!game) return notAvailable(res);
    if (game.frozen) return res.status(403).json({ error: 'Frozen', message: MSG.frozen });
    const r = refreshInfo(game);
    if (r.active) return res.json({ status: 'running', state: r.active.state });
    if (r.secondsLeft > 0) {
      return res.status(429).json({ error: 'Cooldown', message: `You can refresh again in ${fmtDuration(r.secondsLeft)}.`, secondsLeft: r.secondsLeft });
    }
    if (!db.latestVersion(game.id)) return res.status(409).json({ error: 'NotReady', message: 'This snapshot is still being taken.' });
    const lim = limits.refresh(ipKey(req)); if (!lim.ok) return limited(res, lim.retryAfterSec);
    if (db.queuedCount() >= o.maxQueued) return limited(res, 300);
    db.createJob(game.id, 'refresh', db.nextVersionNumber(game.id));
    queue.kick();
    res.status(202).json({ status: 'queued' });
  });

  // ---- report a game or one card (no reporter identity is stored: no address, no account, nothing)
  router.post('/:id/report', (req, res) => {
    const game = activeGame(req.params.id); if (!game) return notAvailable(res);
    const b = (req.body ?? {}) as { reason?: unknown; note?: unknown; version?: unknown; pos?: unknown };
    if (typeof b.reason !== 'string' || !REPORT_REASONS.includes(b.reason as ReportReason)) {
      return res.status(400).json({ error: 'BadReason', message: 'Pick a reason for the report.' });
    }
    const note = (typeof b.note === 'string' ? b.note : '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 500);
    const lim = limits.report(ipKey(req)); if (!lim.ok) return limited(res, lim.retryAfterSec);
    let nodeId: number | null = null;
    const pos = typeof b.pos === 'number' && Number.isInteger(b.pos) && b.pos >= 0 ? b.pos : null;
    const ver = typeof b.version === 'number' && Number.isInteger(b.version) && b.version >= 1 ? b.version : null;
    if (pos !== null && ver !== null && db.getVersion(game.id, ver)) nodeId = db.nodesForVersion(game.id, ver)[pos]?.id ?? null;
    db.addReport(game.id, nodeId, b.reason as ReportReason, note);
    res.status(201).json({ ok: true, message: "Thanks. We've got it." });
  });

  // ---- ask for a fresh look at whether any posts have been deleted (rate limited per game and per visitor)
  router.post('/:id/recheck', (req, res) => {
    const game = activeGame(req.params.id); if (!game) return notAvailable(res);
    if (db.activeJob(game.id)) return res.json({ status: 'running' });
    const left = Math.ceil(((game.last_checked_at || 0) + o.recheckCooldownMs - now()) / 1000);
    if (left > 0) return res.status(429).json({ error: 'Cooldown', message: `Posts were checked recently. You can check again in ${fmtDuration(left)}.`, secondsLeft: left });
    if (!db.latestVersion(game.id)) return res.status(409).json({ error: 'NotReady', message: 'This snapshot is still being taken.' });
    const lim = limits.recheck(ipKey(req)); if (!lim.ok) return limited(res, lim.retryAfterSec);
    db.createJob(game.id, 'recheck', 0);
    queue.kick();
    res.status(202).json({ status: 'queued', message: 'Checking for deleted posts. Wiped posts disappear from the copy once they have been missing on two separate checks.' });
  });

  // ---- the stored tree, for the viewer
  const cache = new Map<string, { etag: string; raw: Buffer; gz: Buffer }>();
  function serveData(req: express.Request, res: express.Response, game: GameRow, n: number | null) {
    const version = n === null ? db.latestVersion(game.id) : db.getVersion(game.id, n);
    if (!version) {
      return n === null && !db.activeJob(game.id) ? notAvailable(res)
        : n === null ? res.status(409).json({ error: 'NotReady', message: 'This snapshot is still being taken.' }) : notAvailable(res);
    }
    const fp = db.fingerprint(game.id, version.n);
    const key = `${game.id}:${version.n}`;
    const tag = `"${crypto.createHash('sha1').update(`${version.captured_at}:${game.frozen}:${fp}`).digest('hex').slice(0, 20)}"`;
    let entry = cache.get(key);
    if (!entry || entry.etag !== tag) {
      const rows = db.nodesForVersion(game.id, version.n);
      const pos = new Map<number, number>(); rows.forEach((r, i) => pos.set(r.id, i));
      const payload = {
        game: { id: game.id, createdAt: game.created_at, frozen: !!game.frozen },
        version: { ...versionSummary(version), versions: db.listVersions(game.id).map(v => v.n), rootQuoteCount: version.root_quote_count, directQuotes: db.directQuotes(game.id, version.n) },
        nodes: rows.map(r => nodeForViewer(r, pos)),
      };
      const raw = Buffer.from(JSON.stringify(payload));
      entry = { etag: tag, raw, gz: zlib.gzipSync(raw) };
      cache.set(key, entry);
      if (cache.size > 40) cache.delete(cache.keys().next().value as string);
    }
    res.setHeader('ETag', entry.etag);
    res.setHeader('Vary', 'Accept-Encoding');
    if (req.headers['if-none-match'] === entry.etag) return res.status(304).end();
    res.type('application/json');
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) { res.setHeader('Content-Encoding', 'gzip'); return res.send(entry.gz); }
    return res.send(entry.raw);
  }
  router.get('/:id/data.json', (req, res) => { const g = activeGame(req.params.id); if (!g) return notAvailable(res); serveData(req, res, g, null); });
  router.get('/:id/v/:n/data.json', (req, res) => {
    const g = activeGame(req.params.id); if (!g) return notAvailable(res);
    const n = /^\d{1,6}$/.test(req.params.n) ? parseInt(req.params.n, 10) : 0;
    if (n < 1) return notAvailable(res);
    serveData(req, res, g, n);
  });

  return router;
}

function versionSummary(v: { n: number; captured_at: number; node_count: number; max_depth: number; status: string; partial_reason: string | null; missing_count: number }) {
  return { n: v.n, capturedAt: v.captured_at, nodeCount: v.node_count, maxDepth: v.max_depth, status: v.status, partialReason: v.partial_reason, missing: v.missing_count };
}

function nodeForViewer(r: NodeRow, pos: Map<number, number>) {
  const p = r.parent_id === null ? -1 : (pos.get(r.parent_id) ?? -1);
  if (r.state !== 'live') return { p, tomb: TOMB_LABEL[r.state] ?? 'deleted' };
  return { p, h: r.handle, did: r.did, dn: r.display_name, d: r.created_at, t: r.text, k: String(r.uri).split('/').pop(), qc: r.quote_count };
}
