/**
 * What the rest of the server needs from "sign in with Bluesky". Everything (routes, sessions, removal,
 * owner controls) depends on this small interface rather than on the OAuth library, so it can be tested
 * with a stand-in and the real thing is a thin wrapper (oauth.ts).
 *
 * The contract: `finish` returns the account's DID and has already thrown the OAuth tokens away. Nothing
 * else about the account is ever read.
 */
export interface AuthProvider {
  /** Begin a sign-in for a handle or DID. `appState` comes back unchanged from `finish` (used to bind the flow to this browser). */
  start(handle: string, appState: string): Promise<{ url: string }>;
  /** Complete a sign-in from the parameters the account's server sent back to us. */
  finish(params: URLSearchParams): Promise<{ did: string; appState: string | null }>;
  /** The public client metadata document (served at /oauth/client-metadata.json). */
  clientMetadata(): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** The public signing keys (served at /oauth/jwks.json): never any private part. */
  jwks(): Record<string, unknown> | Promise<Record<string, unknown>>;
}

export type AuthFailure = 'bad_handle' | 'denied' | 'failed';
export class AuthError extends Error {
  constructor(readonly kind: AuthFailure, message?: string) { super(message ?? kind); this.name = 'AuthError'; }
}

/** A handle (example.com) or a DID (did:plc:...), nothing else, before it goes anywhere near the network. */
export function looksLikeHandleOrDid(input: string): boolean {
  if (input.length < 3 || input.length > 253) return false;
  if (input.startsWith('did:')) return /^did:[a-z]+:[A-Za-z0-9._:%-]{1,200}$/.test(input);
  return /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(input);
}
