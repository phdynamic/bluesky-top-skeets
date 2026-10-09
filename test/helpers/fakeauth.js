// A stand-in for "sign in with Bluesky" with the same contract as the real provider (see src/games/auth/provider.ts).
const crypto = require('node:crypto');
const { AuthError } = require('../../dist/games/auth/provider');

class FakeProvider {
  constructor() { this.pending = new Map(); this.revoked = []; this.dids = {}; }
  async start(handle, appState) {
    if (handle === 'boom.example') throw new Error('network down');
    const state = crypto.randomBytes(8).toString('hex');
    this.pending.set(state, { handle, appState });
    return { url: `/oauth/callback?state=${state}&code=FAKE` };
  }
  async finish(params) {
    if (params.get('error')) throw new AuthError(params.get('error') === 'access_denied' ? 'denied' : 'failed');
    const st = this.pending.get(params.get('state'));
    if (!st) throw new AuthError('failed');
    this.pending.delete(params.get('state'));
    const did = this.dids[st.handle] || 'did:plc:' + st.handle.split('.')[0];
    this.revoked.push(did);          // the real provider revokes the tokens before returning
    return { did, appState: st.appState };
  }
  clientMetadata() { return { fake: true }; }
  jwks() { return { keys: [] }; }
}
module.exports = { FakeProvider };
