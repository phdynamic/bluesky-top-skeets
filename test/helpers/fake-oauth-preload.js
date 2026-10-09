// Preloaded into a test server (node --require) to stand in for the real "sign in with Bluesky" provider.
// The production code has no switch for this: the test swaps the module's export before the server starts.
const crypto = require('node:crypto');
const path = require('node:path');
const oauth = require(path.join(__dirname, '..', '..', 'dist', 'games', 'auth', 'oauth.js'));
const { AuthError } = require(path.join(__dirname, '..', '..', 'dist', 'games', 'auth', 'provider.js'));

const pending = new Map();
const fake = {
  async start(handle, appState) {
    const state = crypto.randomBytes(8).toString('hex');
    pending.set(state, { handle, appState });
    return { url: `/oauth/callback?state=${state}&code=FAKE` };
  },
  async finish(params) {
    if (params.get('error')) throw new AuthError(params.get('error') === 'access_denied' ? 'denied' : 'failed');
    const st = pending.get(params.get('state'));
    if (!st) throw new AuthError('failed');
    pending.delete(params.get('state'));
    return { did: 'did:plc:' + st.handle.split('.')[0], appState: st.appState };
  },
  clientMetadata: () => ({ fake: true }),
  jwks: () => ({ keys: [] }),
};
oauth.createOAuthProvider = async () => fake;
