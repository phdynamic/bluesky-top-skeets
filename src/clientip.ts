import type { IncomingMessage } from 'http';
import crypto from 'crypto';

/**
 * The address of the visitor, taken from the RIGHT side of X-Forwarded-For.
 *
 * Each proxy appends the address it saw, so the left-most entries are whatever the client
 * chose to send and can be forged; only the entries our own proxies added are trustworthy.
 * `hops` is how many proxies sit in front of this server (Railway: 1 by default). If the header
 * has fewer entries than that, it did not pass through our proxies, so it is ignored and the
 * socket address is used instead.
 */
export function clientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>, hops: number): string {
  const socketIp = req.socket?.remoteAddress ?? 'unknown';
  if (hops <= 0) return socketIp;
  const raw = req.headers['x-forwarded-for'];
  const joined = Array.isArray(raw) ? raw.join(',') : raw;
  if (!joined) return socketIp;
  const parts = joined.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length < hops) return socketIp;
  return parts[parts.length - hops];
}

// Limits are keyed on a hash of the address with a per-process random salt, so the map never
// holds a readable address and nothing can be correlated across restarts.
const SALT = crypto.randomBytes(16);
export function hashIp(ip: string): string {
  return crypto.createHash('sha256').update(SALT).update(ip).digest('hex').slice(0, 24);
}
