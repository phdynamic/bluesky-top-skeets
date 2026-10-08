/**
 * One shared request budget for everything this server asks of the public AppView.
 *
 * Feed refreshes and (later) game crawls all leave from the same Railway address, so they share
 * one allowance. Callers `await budget.take(priority)` before each request and call
 * `budget.penalize(ms)` when the AppView answers 429, which pauses everyone, not just the caller.
 * Priority decides who goes next when several are waiting: 'user' (someone is watching) before
 * 'feeds' before 'background' (sweeps).
 *
 * `ratePerSec` of 0 means no pacing (the default until the real limits have been measured with
 * `npm run probe`); a penalty still pauses callers either way.
 */
export type Priority = 'user' | 'feeds' | 'background';
const ORDER: Priority[] = ['user', 'feeds', 'background'];

export class RequestBudget {
  private readonly intervalMs: number;
  private nextSlot = 0;
  private pausedUntil = 0;
  private readonly queues: Record<Priority, Array<() => void>> = { user: [], feeds: [], background: [] };
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: { ratePerSec: number }) {
    this.intervalMs = opts.ratePerSec > 0 ? 1000 / opts.ratePerSec : 0;
  }

  take(priority: Priority = 'feeds'): Promise<void> {
    const now = Date.now();
    const free = this.pendingCount() === 0 && now >= this.pausedUntil && now >= this.nextSlot;
    if (free) {
      this.nextSlot = now + this.intervalMs;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.queues[priority].push(resolve);
      this.schedule();
    });
  }

  /** The AppView said "slow down": nobody sends anything for `ms`. */
  penalize(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + Math.max(0, ms));
  }

  private pendingCount(): number {
    return this.queues.user.length + this.queues.feeds.length + this.queues.background.length;
  }

  private schedule(): void {
    if (this.timer || this.pendingCount() === 0) return;
    const wait = Math.max(0, this.pausedUntil - Date.now(), this.nextSlot - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      const now = Date.now();
      if (now < this.pausedUntil || now < this.nextSlot) { this.schedule(); return; }
      for (const p of ORDER) {
        const next = this.queues[p].shift();
        if (next) { this.nextSlot = Date.now() + this.intervalMs; next(); break; }
      }
      this.schedule();
    }, wait);
  }
}

export const appviewBudget = new RequestBudget({
  ratePerSec: Math.max(0, parseFloat(process.env.APPVIEW_MAX_RPS ?? '0') || 0),
});
