import { GamesDb } from './db';
import { GamesQueue } from './queue';

export interface SweepOptions {
  db: GamesDb;
  queue: GamesQueue;
  /** A game is re-checked for deleted posts when it has not been checked for this long. */
  sweepIntervalMs: number;
  /** Resolved and dismissed reports are dropped after this long. */
  reportRetentionMs: number;
  /** How often to look for work. */
  tickMs?: number;
  /** Most games queued per look, so a backlog never floods the queue. */
  perTick?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * The slow background sweep: abandoned games would otherwise keep deleted text forever, so every game
 * is re-checked on a schedule (default weekly), gently, one at a time, behind anything a visitor asked
 * for. It also drops old resolved reports.
 */
export class GamesSweeper {
  private timer: NodeJS.Timeout | null = null;
  private readonly o: Required<Omit<SweepOptions, 'log'>> & { log: (m: string) => void };

  constructor(opts: SweepOptions) {
    this.o = { tickMs: 3600_000, perTick: 5, now: Date.now, log: () => {}, ...opts };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { this.o.log(`[games] sweep failed: ${e instanceof Error ? e.message : String(e)}`); } }, this.o.tickMs);
    this.timer.unref();
    setTimeout(() => { try { this.tick(); } catch { /* the next tick tries again */ } }, 30_000).unref();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /** One look: queue re-checks for games that are due and purge old reports. Returns how many were queued. */
  tick(): number {
    const { db } = this.o;
    const due = db.dueForSweep(this.o.now() - this.o.sweepIntervalMs, this.o.perTick);
    for (const g of due) db.createJob(g.id, 'recheck', 0);
    if (due.length) { this.o.queue.kick(); this.o.log(`[games] sweep queued ${due.length} re-check${due.length === 1 ? '' : 's'}`); }
    const purged = db.purgeReports(this.o.now() - this.o.reportRetentionMs);
    if (purged) this.o.log(`[games] dropped ${purged} old resolved report${purged === 1 ? '' : 's'}`);
    return due.length;
  }
}
