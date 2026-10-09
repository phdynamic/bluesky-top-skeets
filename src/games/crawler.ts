import { GamesDb, GameRow, JobRow, NodeRow, NodeState } from './db';
import { AppViewClient, BskyUnavailable, NotFound, PostView } from './appview';
import { hasHideLabel } from './labels';

/** A post is wiped only after it has been missing on this many checks, at least a day apart. */
export const WIPE_AFTER_MISSES = 2;

export interface CrawlerOptions {
  db: GamesDb;
  appview: AppViewClient;
  sizeCap: number;
  /** Return true to stop as soon as it is safe (the progress made so far is kept). */
  shouldStop?: () => boolean;
}

/** The server is shutting down; the job keeps its saved progress and resumes after the restart. */
export class JobStopped extends Error {
  constructor() { super('stopped'); this.name = 'JobStopped'; }
}

export interface CrawlOutcome { status: 'complete' | 'partial'; reason: string | null }

const PARTIAL_CAP = 'size cap reached';

const validDate = (...c: Array<string | undefined>): string => {
  for (const x of c) { if (!x) continue; const t = Date.parse(x); if (!isNaN(t)) return new Date(t).toISOString(); }
  return '';
};

/** If the post is itself a quote of another post, the address of the post it quotes. */
export function quotedPostUri(post: PostView): string | null {
  const e = post.record?.embed as { $type?: string; record?: { uri?: string; record?: { uri?: string } } } | undefined;
  if (!e) return null;
  const uri = e.$type?.startsWith('app.bsky.embed.recordWithMedia') ? e.record?.record?.uri : e.$type?.startsWith('app.bsky.embed.record') ? e.record?.uri : undefined;
  return typeof uri === 'string' && uri.includes('/app.bsky.feed.post/') ? uri : null;
}

export class GameCrawler {
  private readonly db: GamesDb;
  private readonly appview: AppViewClient;
  private readonly sizeCap: number;
  private readonly shouldStop: () => boolean;

  constructor(o: CrawlerOptions) {
    this.db = o.db; this.appview = o.appview; this.sizeCap = o.sizeCap; this.shouldStop = o.shouldStop ?? (() => false);
  }

  /** Which state a fetched post should be stored in: its text is kept only when it is live. */
  private classify(gameId: string, p: PostView): NodeState {
    if (hasHideLabel(p)) return 'label_hidden';
    if (p.author?.did && this.db.isSuppressed(p.author.did, gameId)) return 'removed_by_author';
    return 'live';
  }

  private insert(gameId: string, vAdded: number, parent: NodeRow | null, p: PostView): number {
    const state = this.classify(gameId, p);
    return this.db.insertNode({
      gameId, vAdded, uri: p.uri, did: p.author?.did ?? '', handle: p.author?.handle ?? 'unknown',
      displayName: p.author?.displayName ?? '', text: typeof p.record?.text === 'string' ? p.record.text : '',
      createdAt: validDate(p.record?.createdAt, p.indexedAt), parentId: parent ? parent.id : null,
      depth: parent ? parent.depth + 1 : 0, quoteCount: typeof p.quoteCount === 'number' ? p.quoteCount : 0, state,
    });
  }

  /** Creates the game and its root node for an already-fetched root post. */
  createGame(root: PostView): GameRow {
    return this.db.tx(() => {
      const game = this.db.createGame(root.uri);
      this.insert(game.id, 1, null, root);
      return game;
    });
  }

  // ---- crawl: fetch the quotes of every live node that still has some, most-quoted first
  private async expand(job: JobRow): Promise<boolean /* hit the cap with work left */> {
    for (;;) {
      if (this.shouldStop()) throw new JobStopped();
      const node = this.db.nextFrontier(job.game_id);
      if (!node) return false;
      if (this.db.nodeCount(job.game_id) - 1 >= this.sizeCap) return true;
      const before = this.appview.requests;
      let page: { posts: PostView[]; cursor?: string };
      try {
        page = await this.appview.getQuotes(node.uri!, node.cursor || undefined);
      } catch (e) {
        if (e instanceof NotFound) { this.db.setNodeProgress(node.id, '', true); this.db.addJobProgress(job.id, this.appview.requests - before, 0); continue; }
        throw e;
      }
      let added = 0, capped = false;
      this.db.tx(() => {
        for (const p of page.posts) {
          if (!p || !p.uri || this.db.hasNode(job.game_id, p.uri)) continue;
          if (this.db.nodeCount(job.game_id) - 1 >= this.sizeCap) { capped = true; break; }
          this.insert(job.game_id, job.version_n, node, p); added++;
        }
        // On the cap the page is left unfinished: it is fetched again on resume and dedupe skips what is stored.
        if (!capped) {
          if (page.cursor && page.posts.length && page.cursor !== node.cursor) this.db.setNodeProgress(node.id, page.cursor, false);
          else this.db.setNodeProgress(node.id, '', true);
        }
        this.db.addJobProgress(job.id, this.appview.requests - before, added);
      });
      if (capped) return true;
    }
  }

  async runCreate(job: JobRow): Promise<CrawlOutcome> {
    const capped = await this.expand(job);
    const partial = capped && this.db.frontierSize(job.game_id) > 0;
    this.db.writeVersion(job.game_id, job.version_n, partial ? 'partial' : 'complete', partial ? PARTIAL_CAP : null);
    return { status: partial ? 'partial' : 'complete', reason: partial ? PARTIAL_CAP : null };
  }

  // ---- refresh: re-check everything stored, then follow only what has new quotes
  /**
   * Is Bluesky answering sensibly right now? True when a post we know is alive, from this game outside
   * the batch or else from another game, still comes back. With nothing to test against the answer is "no".
   */
  private async looksHealthy(gameId: string, batch: NodeRow[]): Promise<boolean> {
    const ids = new Set(batch.map(n => n.id));
    const probe = this.db.liveNodesAfter(gameId, 0, 200).find(n => !ids.has(n.id)) ?? this.db.otherGameLiveNode(gameId);
    if (!probe || !probe.uri) return false;
    const got = await this.appview.getPosts([probe.uri]);
    return got.some(p => p.uri === probe.uri);
  }

  private async recheckAll(job: JobRow): Promise<void> {
    let after = 0;
    for (;;) {
      if (this.shouldStop()) throw new JobStopped();
      const batch = this.db.liveNodesAfter(job.game_id, after, 25);
      if (batch.length === 0) return;
      after = batch[batch.length - 1].id;
      const before = this.appview.requests;
      const posts = await this.appview.getPosts(batch.map(n => n.uri!));
      // A whole batch missing is only believed when a post we know is alive still answers; otherwise it is a Bluesky problem.
      const emptyBatch = posts.length === 0;
      if (emptyBatch && !(await this.looksHealthy(job.game_id, batch))) throw new BskyUnavailable('Bluesky returned nothing for a batch');
      const byUri = new Map(posts.map(p => [p.uri, p]));
      this.db.tx(() => {
        for (const n of batch) {
          const p = byUri.get(n.uri!);
          if (!p) {
            // Strikes are counted, but nothing is wiped on the strength of an empty batch alone.
            if (this.db.noteMissing(n.id, WIPE_AFTER_MISSES) === 'wiped-due' && !emptyBatch) this.db.tombstone(n.id, 'deleted');
            continue;
          }
          this.db.clearMissing(n.id);
          const state = this.classify(job.game_id, p);
          if (state !== 'live') { this.db.tombstone(n.id, state); continue; }
          if (typeof p.quoteCount === 'number' && p.quoteCount !== n.quote_count) this.db.setQuoteCount(n.id, p.quoteCount);
        }
        this.db.addJobProgress(job.id, this.appview.requests - before, 0);
      });
    }
  }

  async runRefresh(job: JobRow): Promise<CrawlOutcome> {
    await this.recheckAll(job);
    // Nodes with more quotes than we hold are opened again; unfinished nodes from a capped run are already open.
    this.db.tx(() => { for (const n of this.db.nodesWithNewQuotes(job.game_id)) if (n.exhausted) this.db.reopenNode(n.id); });
    const capped = await this.expand(job);
    const partial = capped && this.db.frontierSize(job.game_id) > 0;
    this.db.writeVersion(job.game_id, job.version_n, partial ? 'partial' : 'complete', partial ? PARTIAL_CAP : null);
    return { status: partial ? 'partial' : 'complete', reason: partial ? PARTIAL_CAP : null };
  }

  async run(job: JobRow): Promise<CrawlOutcome> {
    return job.kind === 'create' ? this.runCreate(job) : this.runRefresh(job);
  }

  /** Called when a job gives up: keep whatever it found as a partial version, so no progress is lost. */
  keepProgress(job: JobRow, reason: string): boolean {
    const j = this.db.getJob(job.id);
    if (!j || j.nodes_added === 0 && job.kind === 'refresh') return false;
    if (this.db.getVersion(job.game_id, job.version_n)) return false;
    this.db.writeVersion(job.game_id, job.version_n, 'partial', reason);
    return true;
  }
}
