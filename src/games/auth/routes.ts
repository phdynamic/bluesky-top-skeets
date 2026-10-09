import express from 'express';
import crypto from 'crypto';
import { GamesDb, GameRow } from '../db';
import { AuthProvider, AuthError, looksLikeHandleOrDid } from './provider';
import { SessionStore, Session, SESSION_TTL_MS } from './sessions';
import { clientIp, hashIp } from '../../clientip';

export interface AccountRouterOptions {
  db: GamesDb;
  provider: AuthProvider;
  sessions: SessionStore;
  /** The site's public origin, e.g. https://professorkiosk.wtf; also decides whether cookies are Secure. */
  publicUrl: string;
  trustedProxyHops: number;
  startsPerIpPerHour?: number;
  now?: () => number;
}

const COOKIE = 'kiosk_session';
const FLOW_COOKIE = 'kiosk_signin';
const SLUG = /^[a-z0-9]{10}$/;

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function same(a: string, b: string): boolean {
  const x = crypto.createHash('sha256').update(a).digest(), y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}
const rootDidOf = (g: GameRow): string | null => /^at:\/\/([^/]+)\//.exec(g.root_uri)?.[1] ?? null;

/**
 * Sign in with Bluesky, for exactly two jobs: letting people remove their own posts from saved games, and
 * letting the person who wrote a game's original post freeze or delete that game. The account's DID is all
 * that is learned. Sessions live one hour in memory; every change needs the session cookie, a CSRF token and
 * a same-origin request.
 */
export function createAccountRouter(o: AccountRouterOptions): express.Router {
  const { db, provider, sessions } = o;
  const now = o.now ?? Date.now;
  const origin = new URL(o.publicUrl).origin;
  const secure = origin.startsWith('https:');
  const router = express.Router();
  const starts = new Map<string, number[]>();
  const maxStarts = o.startsPerIpPerHour ?? 10;

  const noStore = (res: express.Response) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex, nofollow'); };
  const cookie = (name: string, value: string, maxAgeSec: number) =>
    `${name}=${value}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const clear = (name: string) => `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

  const sessionOf = (req: express.Request): { token: string; session: Session } | null => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const session = sessions.get(token);
    return session && token ? { token, session } : null;
  };
  /** Cookie + CSRF header + same-origin, for anything that changes state. */
  const guarded = (req: express.Request, res: express.Response): { token: string; session: Session } | null => {
    noStore(res);
    const s = sessionOf(req);
    if (!s) { res.status(401).json({ error: 'SignedOut', message: 'Sign in first.' }); return null; }
    const o1 = req.headers.origin, site = req.headers['sec-fetch-site'];
    const okOrigin = o1 ? o1 === origin : site === 'same-origin';
    const csrf = String(req.headers['x-csrf-token'] ?? '');
    if (!okOrigin || !csrf || !same(csrf, s.session.csrf)) { res.status(403).json({ error: 'Forbidden', message: 'That request could not be verified. Reload the page and try again.' }); return null; }
    return s;
  };

  router.get('/oauth/client-metadata.json', async (_req, res) => { try { const m = await provider.clientMetadata(); res.setHeader('Cache-Control', 'public, max-age=300'); res.json(m); } catch { res.status(503).json({ error: 'Unavailable' }); } });
  router.get('/oauth/jwks.json', async (_req, res) => { try { const k = await provider.jwks(); res.setHeader('Cache-Control', 'public, max-age=300'); res.json(k); } catch { res.status(503).json({ error: 'Unavailable' }); } });

  router.post('/api/auth/start', async (req, res) => {
    noStore(res);
    const ip = hashIp(clientIp(req, o.trustedProxyHops)), t = now();
    const recent = (starts.get(ip) ?? []).filter(x => t - x < 3600_000);
    if (recent.length >= maxStarts) return res.status(429).json({ error: 'TooManyRequests', message: 'Too many sign-in attempts from here. Try again in a few minutes.' });
    recent.push(t); starts.set(ip, recent);
    const handle = typeof (req.body as { handle?: unknown })?.handle === 'string' ? (req.body as { handle: string }).handle.trim().replace(/^@/, '') : '';
    if (!looksLikeHandleOrDid(handle)) return res.status(400).json({ error: 'BadHandle', message: "That doesn't look like a Bluesky handle. It should look like name.bsky.social or your own domain." });
    const nonce = crypto.randomBytes(24).toString('base64url');   // ties this sign-in to this browser
    try {
      const { url } = await provider.start(handle, nonce);
      res.setHeader('Set-Cookie', cookie(FLOW_COOKIE, nonce, 600));
      res.json({ url });
    } catch (e) {
      if (e instanceof AuthError && e.kind === 'bad_handle') return res.status(400).json({ error: 'BadHandle', message: "That doesn't look like a Bluesky handle. It should look like name.bsky.social or your own domain." });
      console.error('[games] sign-in start failed:', e instanceof Error ? e.message : String(e));
      res.status(502).json({ error: 'SignInFailed', message: "We couldn't reach that account's server. Check the handle and try again." });
    }
  });

  router.get('/oauth/callback', async (req, res) => {
    noStore(res);
    const back = (why: string) => { res.setHeader('Set-Cookie', clear(FLOW_COOKIE)); res.redirect(302, `/g/account?signin=${why}`); };
    const flow = parseCookies(req.headers.cookie)[FLOW_COOKIE];
    try {
      const params = new URLSearchParams(req.url.split('?')[1] ?? '');
      const { did, appState } = await provider.finish(params);
      // The sign-in must have been started from this very browser.
      if (!flow || !appState || !same(flow, appState)) return back('failed');
      const { token } = sessions.create(did, '');
      res.setHeader('Set-Cookie', [cookie(COOKIE, token, Math.floor(SESSION_TTL_MS / 1000)), clear(FLOW_COOKIE)]);
      res.redirect(302, '/g/account');
    } catch (e) {
      if (e instanceof AuthError && e.kind === 'denied') return back('denied');
      console.error('[games] sign-in failed:', e instanceof Error ? e.message : String(e));
      back('failed');
    }
  });

  router.get('/api/me', (req, res) => {
    noStore(res);
    const s = sessionOf(req);
    if (!s) return res.json({ signedIn: false });
    res.json({ signedIn: true, did: s.session.did, csrf: s.session.csrf, expiresAt: s.session.expiresAt });
  });

  router.get('/api/me/games', (req, res) => {
    noStore(res);
    const s = sessionOf(req);
    if (!s) return res.status(401).json({ error: 'SignedOut', message: 'Sign in first.' });
    const did = s.session.did;
    const appearances = db.gamesWithAccount(did)
      .map(a => ({ a, g: db.getGame(a.game_id) })).filter(x => x.g && x.g.status === 'active')
      .map(({ a, g }) => ({ id: g!.id, posts: a.posts, link: `/g/${g!.id}` }));
    const started = db.gamesStartedBy(did).map(g => ({ id: g.id, frozen: !!g.frozen, createdAt: g.created_at, link: `/g/${g.id}`, quotes: Math.max(0, db.gameSummary(g.id).live - 1) }));
    res.json({ did, appearances, started });
  });

  // Remove my posts: from one game, or from every game and keep me out of future ones.
  router.post('/api/me/remove', (req, res) => {
    const s = guarded(req, res); if (!s) return;
    const scope = (req.body as { scope?: unknown } | undefined)?.scope;
    if (scope !== 'all' && !(typeof scope === 'string' && SLUG.test(scope) && db.getGame(scope))) return res.status(400).json({ error: 'BadRequest', message: "Choose one of your games, or 'all'." });
    db.addSuppression(s.session.did, scope as string);
    const wiped = db.tombstoneByDid(s.session.did, scope as string);
    db.logAdmin('self.remove', `scope:${scope === 'all' ? 'all' : 'game'} wiped:${wiped}`);
    res.json({ ok: true, wiped });
  });

  // Owner controls: only the account that wrote the original post.
  router.post('/api/me/game/:id/owner', (req, res) => {
    const s = guarded(req, res); if (!s) return;
    const game = SLUG.test(req.params.id) ? db.getGame(req.params.id) : undefined;
    if (!game || game.status !== 'active') return res.status(404).json({ error: 'NotAvailable', message: "This game isn't available." });
    if (rootDidOf(game) !== s.session.did) return res.status(403).json({ error: 'NotYours', message: 'Only the account that wrote the original post can do that.' });
    const action = (req.body as { action?: unknown } | undefined)?.action;
    if (action === 'freeze') db.setFrozen(game.id, true);
    else if (action === 'unfreeze') db.setFrozen(game.id, false);
    else if (action === 'delete') db.deleteGameContents(game.id);
    else return res.status(400).json({ error: 'BadRequest', message: 'Unknown action.' });
    db.logAdmin('owner.' + action, `game:${game.id}`);
    res.json({ ok: true, frozen: action === 'freeze' ? true : action === 'unfreeze' ? false : undefined, deleted: action === 'delete' });
  });

  router.post('/api/auth/logout', (req, res) => {
    const s = guarded(req, res); if (!s) return;
    sessions.destroy(s.token);
    res.setHeader('Set-Cookie', clear(COOKIE));
    res.json({ ok: true });
  });

  return router;
}
