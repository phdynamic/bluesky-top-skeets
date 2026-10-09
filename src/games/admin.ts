import express from 'express';
import crypto from 'crypto';
import { GamesDb, GameRow, NodeRow } from './db';
import { AppViewClient, BskyUnavailable, NotFound } from './appview';
import { parsePostLink } from '../links';
import { clientIp, hashIp } from '../clientip';

export interface AdminOptions {
  db: GamesDb;
  secret: string;
  makeLookupClient: () => AppViewClient;
  trustedProxyHops: number;
  now?: () => number;
}

const SLUG = /^[a-z0-9]{10}$/;
const NODE_STATES = ['deleted', 'label_hidden', 'removed_by_author'] as const;

function sameSecret(given: string, secret: string): boolean {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

/** The bluesky.app link for a stored post address, for an admin to open. */
function postLink(uri: string | null): string | null {
  const m = uri && /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri);
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null;
}

/**
 * The admin tools: list and resolve reports, hide / freeze / delete a game, wipe one card, and keep an
 * account out of one game or all of them. Everything needs the ADMIN_SECRET (Authorization: Bearer ...),
 * wrong guesses are rate limited, and responses are never cached or indexed. Admins can see stored text
 * (they run the database); nothing here is reachable without the secret.
 */
export function createAdminRouter(o: AdminOptions): express.Router {
  const { db } = o;
  const now = o.now ?? Date.now;
  const router = express.Router();
  const fails = new Map<string, number[]>();

  router.use((_req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.use((req, res, next) => {
    const ip = hashIp(clientIp(req, o.trustedProxyHops));
    const t = now();
    const recent = (fails.get(ip) ?? []).filter(x => t - x < 600_000);
    if (recent.length >= 8) { res.status(429).json({ error: 'TooManyRequests', message: 'Too many wrong tries. Wait ten minutes.' }); return; }
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''));
    if (!m || !o.secret || !sameSecret(m[1], o.secret)) {
      recent.push(t); fails.set(ip, recent);
      res.status(401).json({ error: 'Unauthorized', message: 'Wrong or missing admin secret.' }); return;
    }
    next();
  });

  const gameView = (g: GameRow) => {
    const s = db.gameSummary(g.id);
    const root = db.db.prepare('SELECT uri FROM node WHERE game_id = ? ORDER BY ord LIMIT 1').get(g.id) as { uri: string | null } | undefined;
    const open = (db.db.prepare("SELECT COUNT(*) c FROM report WHERE game_id = ? AND status = 'open'").get(g.id) as { c: number }).c;
    return {
      id: g.id, status: g.status, frozen: !!g.frozen, createdAt: g.created_at, lastCheckedAt: g.last_checked_at || null,
      rootLink: postLink(root?.uri ?? null), counts: s, openReports: open, link: `/g/${g.id}`,
    };
  };
  const nodeView = (n: NodeRow | undefined) => n ? { id: n.id, gameId: n.game_id, state: n.state, handle: n.handle, did: n.did, text: n.text, postLink: postLink(n.uri) } : null;

  router.get('/reports', (req, res) => {
    const status = req.query.status === 'resolved' || req.query.status === 'dismissed' || req.query.status === 'all' ? req.query.status : 'open';
    const rows = db.listReports(status, 200).map(r => ({
      id: r.id, gameId: r.game_id, reason: r.reason, note: r.note, createdAt: r.created_at, status: r.status,
      node: r.node_id ? nodeView(db.getNode(r.node_id)) : null, game: (() => { const g = db.getGame(r.game_id); return g ? gameView(g) : null; })(),
    }));
    res.json({ reports: rows, open: db.openReportCount() });
  });

  router.post('/report/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const status = (req.body as { status?: unknown } | undefined)?.status;
    if (!Number.isInteger(id) || (status !== 'resolved' && status !== 'dismissed' && status !== 'open')) return res.status(400).json({ error: 'BadRequest', message: 'Give a report id and a status.' });
    if (!db.setReportStatus(id, status)) return res.status(404).json({ error: 'NotFound', message: 'No such report.' });
    db.logAdmin('report.' + status, `report:${id}`);
    res.json({ ok: true });
  });

  // Find a game by its id or by a post link, or find every game an account appears in.
  router.get('/lookup', async (req, res) => {
    const q = String(req.query.q ?? '').trim().slice(0, 700);
    if (!q) return res.status(400).json({ error: 'BadRequest', message: 'Type a game id, a post link, or an account.' });
    try {
      if (SLUG.test(q)) { const g = db.getGame(q); return res.json({ games: g ? [gameView(g)] : [], accounts: [] }); }
      const link = parsePostLink(q);
      const client = o.makeLookupClient();
      if (link) {
        const did = link.id.startsWith('did:') ? link.id : await client.resolveHandle(link.id);
        const g = db.getGameByRoot(`at://${did}/app.bsky.feed.post/${link.rkey}`);
        return res.json({ games: g ? [gameView(g)] : [], accounts: [] });
      }
      const account = q.replace(/^@/, '');
      const did = account.startsWith('did:') ? account : await client.resolveHandle(account);
      const games = db.gamesWithAccount(did).map(a => ({ ...gameView(db.getGame(a.game_id)!), posts: a.posts }));
      return res.json({ games, accounts: [{ did }] });
    } catch (e) {
      if (e instanceof NotFound) return res.status(404).json({ error: 'NotFound', message: "Couldn't find that account or post." });
      if (e instanceof BskyUnavailable) return res.status(503).json({ error: 'BskyUnavailable', message: "Bluesky didn't answer. Try again in a minute." });
      return res.status(500).json({ error: 'ServerError', message: 'Something went wrong.' });
    }
  });

  router.get('/game/:id', (req, res) => {
    const g = SLUG.test(req.params.id) ? db.getGame(req.params.id) : undefined;
    if (!g) return res.status(404).json({ error: 'NotFound', message: 'No such game.' });
    res.json(gameView(g));
  });

  router.post('/game/:id', (req, res) => {
    const g = SLUG.test(req.params.id) ? db.getGame(req.params.id) : undefined;
    if (!g) return res.status(404).json({ error: 'NotFound', message: 'No such game.' });
    const action = (req.body as { action?: unknown } | undefined)?.action;
    if (g.status === 'deleted') return res.status(409).json({ error: 'Deleted', message: 'That game is deleted.' });
    switch (action) {
      case 'hide': db.setGameStatus(g.id, 'hidden'); break;
      case 'unhide': db.setGameStatus(g.id, 'active'); break;
      case 'freeze': db.setFrozen(g.id, true); break;
      case 'unfreeze': db.setFrozen(g.id, false); break;
      case 'delete': db.deleteGameContents(g.id); break;
      default: return res.status(400).json({ error: 'BadRequest', message: 'Unknown action.' });
    }
    db.logAdmin(`game.${action}`, `game:${g.id}`);
    res.json(gameView(db.getGame(g.id)!));
  });

  router.post('/node/:id/tombstone', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const state = (req.body as { state?: unknown } | undefined)?.state;
    const n = Number.isInteger(id) ? db.getNode(id) : undefined;
    if (!n) return res.status(404).json({ error: 'NotFound', message: 'No such card.' });
    if (typeof state !== 'string' || !(NODE_STATES as readonly string[]).includes(state)) return res.status(400).json({ error: 'BadRequest', message: 'Pick deleted, label_hidden or removed_by_author.' });
    if (n.state === 'live') db.tombstone(n.id, state as typeof NODE_STATES[number]);
    db.logAdmin('node.' + state, `node:${n.id} game:${n.game_id}`);
    res.json({ ok: true });
  });

  // Keep an account out of one game or all games, and wipe what is stored now.
  router.post('/suppress', async (req, res) => {
    const b = (req.body ?? {}) as { account?: unknown; scope?: unknown };
    const scope = typeof b.scope === 'string' ? b.scope : '';
    if (scope !== 'all' && !SLUG.test(scope)) return res.status(400).json({ error: 'BadRequest', message: "Scope must be 'all' or a game id." });
    if (scope !== 'all' && !db.getGame(scope)) return res.status(404).json({ error: 'NotFound', message: 'No such game.' });
    const account = typeof b.account === 'string' ? b.account.trim().replace(/^@/, '').slice(0, 300) : '';
    if (!account) return res.status(400).json({ error: 'BadRequest', message: 'Give a handle or DID.' });
    try {
      const did = account.startsWith('did:') ? account : await o.makeLookupClient().resolveHandle(account);
      db.addSuppression(did, scope);
      const wiped = db.tombstoneByDid(did, scope);
      db.logAdmin('suppress', `scope:${scope} wiped:${wiped}`);
      res.json({ ok: true, wiped });
    } catch (e) {
      if (e instanceof NotFound) return res.status(404).json({ error: 'NotFound', message: "Couldn't find that account." });
      if (e instanceof BskyUnavailable) return res.status(503).json({ error: 'BskyUnavailable', message: "Bluesky didn't answer. Try again in a minute." });
      res.status(500).json({ error: 'ServerError', message: 'Something went wrong.' });
    }
  });

  router.get('/log', (_req, res) => res.json({ log: db.recentAdminLog(100) }));
  return router;
}
