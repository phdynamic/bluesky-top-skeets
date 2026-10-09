/**
 * Abuse limits for saved games. Counters live in memory only, are keyed on the salted address hash the
 * rest of the server already uses, and are dropped as soon as their window passes. (Nothing is written
 * down about who asked for what.)
 */
const HOUR = 3600_000;

export interface LimitConfig {
  lookupsPerIpPerHour: number;      // looking a post up before saving (two Bluesky requests each)
  createsPerIpPerHour: number;
  refreshesPerIpPerHour: number;
}

export type LimitResult = { ok: true } | { ok: false; retryAfterSec: number };

export class GamesLimits {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly cfg: LimitConfig, private readonly now: () => number = Date.now) {}

  private take(kind: string, ip: string, max: number): LimitResult {
    const key = kind + ':' + ip, t = this.now();
    const recent = (this.hits.get(key) ?? []).filter(x => t - x < HOUR);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((recent[0] + HOUR - t) / 1000)) };
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.sweep(t);
    return { ok: true };
  }
  private sweep(t: number): void {
    for (const [k, v] of this.hits) if (!v.some(x => t - x < HOUR)) this.hits.delete(k);
  }

  lookup(ip: string): LimitResult { return this.take('lookup', ip, this.cfg.lookupsPerIpPerHour); }
  create(ip: string): LimitResult { return this.take('create', ip, this.cfg.createsPerIpPerHour); }
  refresh(ip: string): LimitResult { return this.take('refresh', ip, this.cfg.refreshesPerIpPerHour); }
}
