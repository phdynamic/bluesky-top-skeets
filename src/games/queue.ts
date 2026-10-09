import { GamesDb, JobRow, JobKind } from './db';
import { AppViewClient, BskyUnavailable } from './appview';
import { GameCrawler, JobStopped } from './crawler';

export interface QueueOptions {
  db: GamesDb;
  /** A client for this kind of job: background re-checks take a lower place in the shared budget. */
  makeAppView: (kind: JobKind) => AppViewClient;
  sizeCap: number;
  /** How many times a job is put back after Bluesky fails before it keeps what it found and stops. */
  maxRetries?: number;
  retryDelayMs?: number;
  idleMs?: number;
  wipeSpacingMs?: number;
  healthPost?: string;
  log?: (msg: string) => void;
}

/**
 * Runs crawl jobs one at a time, oldest first. A job that hits a Bluesky problem goes back in the queue
 * after a pause (its progress is already saved, so it resumes, it does not restart); after a few tries
 * it keeps what it found as a partial version. A restart puts interrupted jobs back and carries on.
 */
export class GamesQueue {
  private readonly o: Required<Omit<QueueOptions, 'log' | 'wipeSpacingMs' | 'healthPost'>> & { wipeSpacingMs?: number; healthPost?: string } & { log: (m: string) => void };
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private readonly notBefore = new Map<number, number>();

  constructor(opts: QueueOptions) {
    this.o = { maxRetries: 3, retryDelayMs: 60_000, idleMs: 2_000, log: () => {}, ...opts };
  }

  get isRunning(): boolean { return this.running; }

  start(): void {
    if (this.running) return;
    const n = this.o.db.requeueInterrupted();
    if (n) this.o.log(`[games] resumed ${n} interrupted crawl${n === 1 ? '' : 's'}`);
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.kick();
    if (this.loopPromise) await this.loopPromise;
    this.loopPromise = null;
  }

  /** Wake the worker (a job was just queued). */
  kick(): void { if (this.wake) { const w = this.wake; this.wake = null; w(); } }

  private nextDueJob(): JobRow | undefined {
    const now = Date.now();
    return this.o.db.listQueued().find(j => (this.notBefore.get(j.id) ?? 0) <= now);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const job = this.nextDueJob();
      if (!job) {
        await new Promise<void>(resolve => { this.wake = resolve; setTimeout(resolve, this.o.idleMs); });
        this.wake = null;
        continue;
      }
      await this.runOne(job);
    }
  }

  private async runOne(job: JobRow): Promise<void> {
    const db = this.o.db;
    db.markJobStarted(job.id);
    const crawler = new GameCrawler({ db, appview: this.o.makeAppView(job.kind), sizeCap: this.o.sizeCap, wipeSpacingMs: this.o.wipeSpacingMs, healthPost: this.o.healthPost, shouldStop: () => !this.running });
    try {
      const outcome = await crawler.run(job);
      this.notBefore.delete(job.id);
      db.finishJob(job.id, outcome.status, outcome.reason);
      this.o.log(`[games] job ${job.id} (${job.kind}, game ${job.game_id}) ${outcome.status}${outcome.reason ? ': ' + outcome.reason : ''}`);
    } catch (e) {
      if (e instanceof JobStopped) return;   // left as 'crawling'; requeued on the next start
      if (e instanceof BskyUnavailable) {
        const tries = db.bumpJobRetry(job.id);
        if (tries <= this.o.maxRetries) {
          this.notBefore.set(job.id, Date.now() + this.o.retryDelayMs * tries);
          db.setJobQueued(job.id);
          this.o.log(`[games] job ${job.id} paused (${e.message}), try ${tries}/${this.o.maxRetries}`);
          return;
        }
        const kept = crawler.keepProgress(job, "Bluesky didn't answer");
        db.finishJob(job.id, kept ? 'partial' : 'failed', "Bluesky didn't answer");
        this.notBefore.delete(job.id);
        this.o.log(`[games] job ${job.id} gave up (${e.message}); ${kept ? 'kept a partial version' : 'nothing to keep'}`);
        return;
      }
      this.o.log(`[games] job ${job.id} failed: ${e instanceof Error ? e.message : String(e)}`);
      const kept = crawler.keepProgress(job, 'The crawl stopped unexpectedly');
      db.finishJob(job.id, kept ? 'partial' : 'failed', 'Something went wrong');
      this.notBefore.delete(job.id);
    }
  }
}
