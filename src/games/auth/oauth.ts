import { AuthProvider, AuthError, looksLikeHandleOrDid } from './provider';

export interface OAuthConfig {
  /** The public origin of this site, e.g. https://professorkiosk.wtf (or http://127.0.0.1:3000 for local testing). */
  publicUrl: string;
  /** An ES256 private key as a JWK (a JSON string). Required unless publicUrl is a loopback address. */
  privateKeyJwk?: string;
}

export const OAUTH_SCOPE = 'atproto';

const isLoopback = (u: URL) => u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === 'localhost');

/** A short-lived in-memory store with the get/set/del shape the OAuth library wants. */
class TtlStore<V> {
  private readonly m = new Map<string, { v: V; exp: number }>();
  constructor(private readonly ttlMs: number) {}
  async get(k: string): Promise<V | undefined> {
    const e = this.m.get(k); if (!e) return undefined;
    if (e.exp <= Date.now()) { this.m.delete(k); return undefined; }
    return e.v;
  }
  async set(k: string, v: V): Promise<void> {
    if (this.m.size > 2000) { const now = Date.now(); for (const [kk, e] of this.m) if (e.exp <= now) this.m.delete(kk); }
    this.m.set(k, { v, exp: Date.now() + this.ttlMs });
  }
  async del(k: string): Promise<void> { this.m.delete(k); }
}

/** Throws a clear message if the sign-in settings cannot work, before anything starts. */
export function checkOAuthConfig(cfg: OAuthConfig): void {
  let base: URL;
  try { base = new URL(cfg.publicUrl); } catch { throw new Error('OAUTH_PUBLIC_URL is not a valid address'); }
  buildClientMetadata(cfg);
  if (!isLoopback(base)) {
    if (!cfg.privateKeyJwk) throw new Error('OAUTH_PRIVATE_KEY_JWK is required when OAUTH_PUBLIC_URL is a public address (run: npm run oauth:genkey)');
    try { const k = JSON.parse(cfg.privateKeyJwk); if (typeof k.d !== 'string' || k.kty !== 'EC') throw new Error('x'); }
    catch { throw new Error('OAUTH_PRIVATE_KEY_JWK must be a private EC (ES256) key as JSON (run: npm run oauth:genkey)'); }
  }
}

/** The client metadata document for this site (what other servers read to learn who we are). */
export function buildClientMetadata(cfg: OAuthConfig): Record<string, unknown> {
  const base = new URL(cfg.publicUrl);
  const origin = base.origin;
  const redirect = `${origin}/oauth/callback`;
  if (isLoopback(base)) {
    // The AT Protocol's "loopback client" for local testing: no key, identified by a special localhost client id.
    const clientId = `http://localhost?redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent(OAUTH_SCOPE)}`;
    return {
      client_id: clientId, client_name: 'Professor Kiosk (local test)', redirect_uris: [redirect], scope: OAUTH_SCOPE,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], application_type: 'web',
      token_endpoint_auth_method: 'none', dpop_bound_access_tokens: true,
    };
  }
  if (base.protocol !== 'https:') throw new Error('OAUTH_PUBLIC_URL must be https (or a 127.0.0.1 address for local testing)');
  return {
    client_id: `${origin}/oauth/client-metadata.json`, client_name: 'Professor Kiosk', client_uri: origin,
    redirect_uris: [redirect], scope: OAUTH_SCOPE, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    application_type: 'web', token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_signing_alg: 'ES256',
    dpop_bound_access_tokens: true, jwks_uri: `${origin}/oauth/jwks.json`,
  };
}

/**
 * The real provider, a thin wrapper over @atproto/oauth-client-node. Confidential client: it proves who it is
 * to each person's server with a signing key held only in an environment variable. Sign-ins are discovered
 * from the handle (any server, never a default), requests to those servers use the library's SSRF-safe fetch,
 * and the tokens are revoked and deleted the instant the callback has told us the account's DID.
 */
export async function createOAuthProvider(cfg: OAuthConfig): Promise<AuthProvider> {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { NodeOAuthClient } = require('@atproto/oauth-client-node');
  const { requestLocalLock } = require('@atproto/oauth-client');
  const { safeFetchWrap } = require('@atproto-labs/fetch-node');
  const { JoseKey } = require('@atproto/jwk-jose');
  /* eslint-enable */
  const metadata = buildClientMetadata(cfg);
  const loopback = isLoopback(new URL(cfg.publicUrl));
  let keyset: unknown[] | undefined;
  if (!loopback) {
    if (!cfg.privateKeyJwk) throw new Error('OAUTH_PRIVATE_KEY_JWK is required when OAUTH_PUBLIC_URL is a public address (run: npm run oauth:genkey)');
    let jwk: Record<string, unknown>;
    try { jwk = JSON.parse(cfg.privateKeyJwk); } catch { throw new Error('OAUTH_PRIVATE_KEY_JWK is not valid JSON'); }
    if (typeof jwk.d !== 'string' || jwk.kty !== 'EC') throw new Error('OAUTH_PRIVATE_KEY_JWK must be a private EC (ES256) key');
    keyset = [await JoseKey.fromImportable(jwk, typeof jwk.kid === 'string' ? jwk.kid : undefined)];
  }
  const client = new NodeOAuthClient({
    clientMetadata: metadata,
    keyset,
    stateStore: new TtlStore<unknown>(10 * 60_000),
    sessionStore: new TtlStore<unknown>(10 * 60_000),
    requestLock: requestLocalLock,
    fetch: safeFetchWrap({ ssrfProtection: true, allowImplicitRedirect: true, responseMaxSize: 1_000_000, timeout: 15_000 }),
  });

  return {
    clientMetadata: () => metadata,
    jwks: () => client.jwks as Record<string, unknown>,
    async start(handle: string, appState: string) {
      const input = handle.trim().replace(/^@/, '');
      if (!looksLikeHandleOrDid(input)) throw new AuthError('bad_handle');
      try {
        const url: URL = await client.authorize(input, { scope: OAUTH_SCOPE, state: appState });
        return { url: url.toString() };
      } catch (e) {
        throw new AuthError('failed', e instanceof Error ? e.message : String(e));
      }
    },
    async finish(params: URLSearchParams) {
      if (params.get('error')) throw new AuthError(params.get('error') === 'access_denied' ? 'denied' : 'failed', params.get('error_description') ?? undefined);
      let did: string, appState: string | null = null;
      try {
        const out = await client.callback(params);
        did = out.session.did;
        appState = typeof out.state === 'string' ? out.state : null;
      } catch (e) {
        throw new AuthError('failed', e instanceof Error ? e.message : String(e));
      }
      // Done with the tokens: revoke them with the person's server and delete them here. All we keep is the DID.
      try { await client.revoke(did); } catch { /* the local copy is dropped below either way */ }
      try { await (client as unknown as { sessionGetter: { delStored(sub: string): Promise<void> } }).sessionGetter.delStored(did); } catch { /* already gone */ }
      return { did, appState };
    },
  };
}
