import crypto from 'crypto';

/**
 * Sign-in sessions, kept in server memory only. Each one is a random token (the cookie value), the account's
 * DID, a display handle, a CSRF token and an expiry one hour out. Nothing here is ever written to disk, so
 * there is nothing to leak from a backup, and a restart simply signs everyone out.
 */
export interface Session { did: string; handle: string; csrf: string; expiresAt: number }

export const SESSION_TTL_MS = 3600_000;

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly ttlMs: number = SESSION_TTL_MS, private readonly now: () => number = Date.now, private readonly max = 5000) {}

  create(did: string, handle: string): { token: string; session: Session } {
    this.sweep();
    if (this.sessions.size >= this.max) this.sessions.delete(this.sessions.keys().next().value as string);
    const token = crypto.randomBytes(32).toString('base64url');
    const session: Session = { did, handle, csrf: crypto.randomBytes(24).toString('base64url'), expiresAt: this.now() + this.ttlMs };
    this.sessions.set(token, session);
    return { token, session };
  }
  get(token: string | undefined): Session | undefined {
    if (!token || token.length > 100) return undefined;
    const s = this.sessions.get(token);
    if (!s) return undefined;
    if (s.expiresAt <= this.now()) { this.sessions.delete(token); return undefined; }
    return s;
  }
  destroy(token: string | undefined): void { if (token) this.sessions.delete(token); }
  private sweep(): void { const t = this.now(); for (const [k, v] of this.sessions) if (v.expiresAt <= t) this.sessions.delete(k); }
  get size(): number { return this.sessions.size; }
}
