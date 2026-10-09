const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { buildClientMetadata, checkOAuthConfig, createOAuthProvider, OAUTH_SCOPE } = require('../dist/games/auth/oauth');
const { AuthError } = require('../dist/games/auth/provider');

const genKey = () => execFileSync('node', [path.join(__dirname, '..', 'scripts', 'oauth-genkey.js')], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

test('the key generator makes a usable ES256 private key with an id', () => {
  const jwk = JSON.parse(genKey());
  assert.strictEqual(jwk.kty, 'EC'); assert.strictEqual(jwk.crv, 'P-256'); assert.strictEqual(jwk.alg, 'ES256'); assert.ok(jwk.d && jwk.x && jwk.y && jwk.kid);
  assert.notStrictEqual(genKey(), genKey(), 'every run makes a new key');
  assert.deepStrictEqual(jwk.key_ops, ['sign']); assert.ok(!('use' in jwk), 'no deprecated "use" on a private key');
});

test('client metadata (public site): exactly what the AT Protocol needs, scope atproto only', () => {
  const m = buildClientMetadata({ publicUrl: 'https://professorkiosk.wtf/', privateKeyJwk: genKey() });
  assert.deepStrictEqual(m, {
    client_id: 'https://professorkiosk.wtf/oauth/client-metadata.json', client_name: 'Professor Kiosk', client_uri: 'https://professorkiosk.wtf',
    redirect_uris: ['https://professorkiosk.wtf/oauth/callback'], scope: 'atproto', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    application_type: 'web', token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_signing_alg: 'ES256', dpop_bound_access_tokens: true,
    jwks_uri: 'https://professorkiosk.wtf/oauth/jwks.json',
  });
  assert.strictEqual(OAUTH_SCOPE, 'atproto');
  assert.strictEqual(m.scope.includes('transition'), false, 'no broad permissions');
});

test('client metadata (local testing on 127.0.0.1): the loopback client, no key', () => {
  const m = buildClientMetadata({ publicUrl: 'http://127.0.0.1:3000' });
  assert.strictEqual(m.client_id, 'http://localhost?redirect_uri=' + encodeURIComponent('http://127.0.0.1:3000/oauth/callback') + '&scope=atproto');
  assert.deepStrictEqual(m.redirect_uris, ['http://127.0.0.1:3000/oauth/callback']); assert.strictEqual(m.token_endpoint_auth_method, 'none'); assert.strictEqual(m.dpop_bound_access_tokens, true);
  assert.ok(!('jwks_uri' in m));
});

test('settings are checked up front with clear messages', () => {
  assert.throws(() => checkOAuthConfig({ publicUrl: 'not a url' }), /not a valid address/);
  assert.throws(() => checkOAuthConfig({ publicUrl: 'http://example.com' }), /must be https/);
  assert.throws(() => checkOAuthConfig({ publicUrl: 'https://example.com' }), /OAUTH_PRIVATE_KEY_JWK is required/);
  assert.throws(() => checkOAuthConfig({ publicUrl: 'https://example.com', privateKeyJwk: '{nope' }), /private EC \(ES256\) key/);
  const pub = JSON.parse(genKey()); delete pub.d;
  assert.throws(() => checkOAuthConfig({ publicUrl: 'https://example.com', privateKeyJwk: JSON.stringify(pub) }), /private EC \(ES256\) key/, 'a public-only key is refused');
  assert.doesNotThrow(() => checkOAuthConfig({ publicUrl: 'https://example.com', privateKeyJwk: genKey() }));
  assert.doesNotThrow(() => checkOAuthConfig({ publicUrl: 'http://127.0.0.1:3000' }));
});

test('the real provider builds from a generated key, publishes public keys only, and refuses bad input before any network call', async () => {
  const jwkText = genKey(); const priv = JSON.parse(jwkText);
  const p = await createOAuthProvider({ publicUrl: 'https://example.test', privateKeyJwk: jwkText });
  const keys = p.jwks().keys; assert.strictEqual(keys.length, 1);
  assert.strictEqual(keys[0].kid, priv.kid); assert.strictEqual(keys[0].x, priv.x);
  const wire = JSON.parse(JSON.stringify(p.jwks())).keys[0];   // what actually goes over the network
  for (const secret of ['d', 'p', 'q', 'dp', 'dq', 'qi']) assert.ok(!(secret in wire), 'the public key document has no "' + secret + '"');
  assert.ok(!JSON.stringify(p.jwks()).includes(priv.d), 'the private part never appears');
  assert.strictEqual(p.clientMetadata().client_id, 'https://example.test/oauth/client-metadata.json');
  await assert.rejects(p.start('not a handle!!', 'nonce'), e => e instanceof AuthError && e.kind === 'bad_handle');
  await assert.rejects(p.finish(new URLSearchParams('error=access_denied')), e => e instanceof AuthError && e.kind === 'denied');
  await assert.rejects(p.finish(new URLSearchParams('error=server_error')), e => e instanceof AuthError && e.kind === 'failed');
  await assert.rejects(p.finish(new URLSearchParams('state=unknown&code=x')), e => e instanceof AuthError && e.kind === 'failed', 'an unknown state is refused without leaving this machine');
  const loop = await createOAuthProvider({ publicUrl: 'http://127.0.0.1:3000' });
  assert.deepStrictEqual(loop.jwks().keys, []);
});
