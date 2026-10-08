/**
 * One shared request budget for everything this server asks of the public AppView.
 *
 * Feed refreshes and (later) game crawls all leave from the same Railway address, so they share
 * one allowance. Callers `await budget.take(priority)` before each request and call
 * `budget.penalize(ms)` when the AppView answers 429.
 *
 * The public AppView sends no rate-limit headers, so the limit can't be read; the budget learns it:
 *  - `ratePerSec` is the CEILING (requests per second). 0 means no pacing at all (the default until
 *    the limits have been measured with `npm run probe -- ... --ramp`), and then nothing adapts.
 *  - It starts at `startRatePerSec` (default: the ceiling), HALVES on every penalty, and climbs back
 *    by `recoverStep` every `recoverMs` without one, never above the ceiling or below `minRatePerSec`.
 *  - A penalty also pauses every caller for `ms`, whoever hit the 429.
 *
 * Priority decides who goes next when several are waiting: 'user' (someone is watching) before
 * 'feeds' before 'background' (sweeps).
 */
export type Priority = 'user' | 'feeds' | 'background';
const ORDER: Priority[] = ['user', 'feeds', 'background'];

export interface BudgetOptions {
  ratePerSec: number;
  startRatePerSec?: number;
  minRatePerSec?: number;
  recoverMs?: number;
  recoverStep?: number;
}

export class RequestBudget {
  private readonly ceiling: number;
  private readonly floor: number;
  private readonly recoverMs: number;
  private readonly recoverStep: number;
  private rate: number;
  private nextSlot = 0;
  private pausedUntil = 0;
  private lastAdjust = Date.now();
  private readonly queues: Record<Priority, Array<() => void>> = { user: [], feeds: [], background: [] };
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: BudgetOptions) {
    this.ceiling = Math.max(0, opts.ratePerSec);
    this.floor = Math.min(this.ceiling, Math.max(0.1, opts.minRatePerSec ?? 0.5));
    this.recoverMs = opts.recoverMs ?? 30_000;
    this.recoverStep = opts.recoverStep ?? 0.1;
    this.rate = this.ceiling === 0 ? 0 : Math.min(this.ceiling, Math.max(this.floor, opts.startRatePerSec ?? this.ceiling));
  }

  /** The rate currently allowed, in requests per second (0 = unpaced). */
  currentRate(): number {
    this.recover();
    return this.rate;
  }

  take(priority: Priority = 'feeds'): Promise<void> {
    this.recover();
    const now = Date.now();
    const free = this.pendingCount() === 0 && now >= this.pausedUntil && now >= this.nextSlot;
    if (free) {
      this.nextSlot = now + this.interval();
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.queues[priority].push(resolve);
      this.schedule();
    });
  }

  /** The AppView said "slow down": nobody sends anything for `ms`, and the rate is halved. */
  penalize(ms: number): void {
    const now = Date.now();
    this.pausedUntil = Math.max(this.pausedUntil, now + Math.max(0, ms));
    if (this.ceiling > 0) this.rate = Math.max(this.floor, this.rate / 2);
    this.lastAdjust = now;
  }

  private interval(): number {
    return this.rate > 0 ? 1000 / this.rate : 0;
  }

  private recover(): void {
    if (this.ceiling === 0 || this.rate >= this.ceiling) return;
    const now = Date.now();
    if (now - this.lastAdjust < this.recoverMs) return;
    const steps = Math.floor((now - this.lastAdjust) / this.recoverMs);
    this.rate = Math.min(this.ceiling, this.rate * Math.pow(1 + this.recoverStep, steps));
    this.lastAdjust = now;
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
      this.recover();
      for (const p of ORDER) {
        const next = this.queues[p].shift();
        if (next) { this.nextSlot = Date.now() + this.interval(); next(); break; }
      }
      this.schedule();
    }, wait);
  }
}

function envNum(name: string): number | undefined {
  const v = parseFloat(process.env[name] ?? '');
  return Number.isFinite(v) && v >= 0 ? v : undefined;
}

export const appviewBudget = new RequestBudget({
  ratePerSec: envNum('APPVIEW_MAX_RPS') ?? 0,
  startRatePerSec: envNum('APPVIEW_START_RPS'),
});
