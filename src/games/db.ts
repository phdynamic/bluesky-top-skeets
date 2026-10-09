import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Storage for saved games: one SQLite file on the data volume.
 *
 * Posts on Bluesky cannot be edited, so a node (one stored post) is append-only. A version is simply
 * "every node with v_added <= n", which means an old version never changes and a tombstone (a wiped
 * post) disappears from every version at once. All SQL here is parameterized; nothing is built from
 * user text.
 */

export type NodeState = 'live' | 'deleted' | 'removed_by_author' | 'label_hidden';
export type JobKind = 'create' | 'refresh' | 'recheck';
export type JobState = 'queued' | 'crawling' | 'complete' | 'partial' | 'failed';

export interface GameRow { id: string; root_uri: string; root_hash: string; created_at: number; frozen: number; status: 'active' | 'hidden' | 'deleted'; last_checked_at: number }
export interface VersionRow {
  game_id: string; n: number; captured_at: number; node_count: number; max_depth: number;
  status: 'complete' | 'partial'; partial_reason: string | null; missing_count: number; root_quote_count: number;
}
export interface NodeRow {
  id: number; game_id: string; v_added: number; ord: number; uri: string | null; uri_hash: string;
  did: string | null; handle: string | null; display_name: string | null; text: string | null; created_at: string | null;
  parent_id: number | null; depth: number; quote_count: number; state: NodeState;
  missing_checks: number; last_missing_at: number; cursor: string; exhausted: number;
}
export interface JobRow {
  id: number; game_id: string; kind: JobKind; state: JobState; version_n: number; created_at: number;
  started_at: number | null; finished_at: number | null; requests: number; nodes_added: number; error: string | null; retry_count: number;
}

export interface NewNode {
  gameId: string; vAdded: number; uri: string; did: string; handle: string; displayName: string; text: string;
  createdAt: string; parentId: number | null; depth: number; quoteCount: number; state?: NodeState;
}

export type ReportReason = 'personal_info' | 'harassment' | 'label' | 'wrong' | 'removal' | 'other';
export interface ReportRow { id: number; game_id: string; node_id: number | null; reason: ReportReason; note: string; created_at: number; status: 'open' | 'resolved' | 'dismissed'; resolved_at: number | null }

const SCHEMA_VERSION = 2;
// Added in schema version 2; also part of a fresh database.
const SCHEMA_V2_TABLES = `
CREATE TABLE report (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  node_id INTEGER,
  reason TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_at INTEGER
);
CREATE INDEX report_status ON report (status, id);
CREATE TABLE admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL
);`;

const SCHEMA = `
CREATE TABLE game (
  id TEXT PRIMARY KEY,
  root_uri TEXT NOT NULL UNIQUE,
  root_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  frozen INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  last_checked_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX game_root_hash ON game (root_hash);
CREATE TABLE version (
  game_id TEXT NOT NULL REFERENCES game(id),
  n INTEGER NOT NULL,
  captured_at INTEGER NOT NULL,
  node_count INTEGER NOT NULL,
  max_depth INTEGER NOT NULL,
  status TEXT NOT NULL,
  partial_reason TEXT,
  missing_count INTEGER NOT NULL DEFAULT 0,
  root_quote_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, n)
);
CREATE TABLE node (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL REFERENCES game(id),
  v_added INTEGER NOT NULL,
  ord INTEGER NOT NULL,
  uri TEXT,
  uri_hash TEXT NOT NULL,
  did TEXT,
  handle TEXT,
  display_name TEXT,
  text TEXT,
  created_at TEXT,
  parent_id INTEGER REFERENCES node(id),
  depth INTEGER NOT NULL,
  quote_count INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'live',
  missing_checks INTEGER NOT NULL DEFAULT 0,
  last_missing_at INTEGER NOT NULL DEFAULT 0,
  cursor TEXT NOT NULL DEFAULT '',
  exhausted INTEGER NOT NULL DEFAULT 0,
  UNIQUE (game_id, uri_hash)
);
CREATE INDEX node_game_ord ON node (game_id, ord);
CREATE INDEX node_parent ON node (parent_id);
CREATE INDEX node_did ON node (did);
CREATE TABLE suppression (
  did TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (did, scope)
);
CREATE TABLE crawl_job (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL REFERENCES game(id),
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  version_n INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  requests INTEGER NOT NULL DEFAULT 0,
  nodes_added INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX job_state ON crawl_job (state, id);
CREATE INDEX job_game ON crawl_job (game_id, id);
${SCHEMA_V2_TABLES}
`;

/** One-way hash used to recognize a post again after its address has been wiped. */
export function uriHash(uri: string): string {
  return crypto.createHash('sha256').update(uri).digest('hex').slice(0, 32);
}

/** Stored in the cursor of a finished node whose quotes request was refused. */
const REFUSED = '!refused';

const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';   // no look-alikes
export function newSlug(): string {
  const bytes = crypto.randomBytes(10);
  let s = '';
  for (let i = 0; i < 10; i++) s += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  return s;
}

export class GamesDb {
  readonly db: Database.Database;
  readonly now: () => number;

  constructor(file: string, now: () => number = Date.now) {
    this.now = now;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    try { this.db.pragma('journal_mode = WAL'); } catch { /* some filesystems refuse WAL; the default mode still works */ }
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
  }

  private migrate(): void {
    const v = this.db.pragma('user_version', { simple: true }) as number;
    if (v === 0) {
      this.db.exec(SCHEMA);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    } else if (v === 1) {
      this.db.transaction(() => {
        this.db.exec('ALTER TABLE game ADD COLUMN root_hash TEXT');
        this.db.exec('ALTER TABLE game ADD COLUMN last_checked_at INTEGER NOT NULL DEFAULT 0');
        for (const g of this.db.prepare('SELECT id, root_uri FROM game').all() as Array<{ id: string; root_uri: string }>) {
          this.db.prepare('UPDATE game SET root_hash = ? WHERE id = ?').run(uriHash(g.root_uri), g.id);
        }
        this.db.exec('CREATE UNIQUE INDEX game_root_hash ON game (root_hash)');
        this.db.exec(SCHEMA_V2_TABLES);
        this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
      })();
    } else if (v > SCHEMA_VERSION) {
      throw new Error(`games database is newer (v${v}) than this server understands (v${SCHEMA_VERSION})`);
    }
  }

  close(): void { this.db.close(); }
  tx<T>(fn: () => T): T { return this.db.transaction(fn)(); }

  // ---- games
  createGame(rootUri: string): GameRow {
    for (let attempt = 0; ; attempt++) {
      const id = newSlug();
      try {
        this.db.prepare('INSERT INTO game (id, root_uri, root_hash, created_at) VALUES (?, ?, ?, ?)').run(id, rootUri, uriHash(rootUri), this.now());
        return this.getGame(id)!;
      } catch (e) {
        if (attempt < 5 && /UNIQUE.*game\.id|PRIMARY KEY/.test(String(e))) continue;
        throw e;
      }
    }
  }
  getGame(id: string): GameRow | undefined { return this.db.prepare('SELECT * FROM game WHERE id = ?').get(id) as GameRow | undefined; }
  getGameByRoot(rootUri: string): GameRow | undefined { return this.db.prepare('SELECT * FROM game WHERE root_hash = ?').get(uriHash(rootUri)) as GameRow | undefined; }
  setFrozen(id: string, frozen: boolean): void { this.db.prepare('UPDATE game SET frozen = ? WHERE id = ?').run(frozen ? 1 : 0, id); }
  setGameStatus(id: string, status: GameRow['status']): void { this.db.prepare('UPDATE game SET status = ? WHERE id = ?').run(status, id); }
  gamesCreatedSince(ms: number): number { return (this.db.prepare('SELECT COUNT(*) c FROM game WHERE created_at >= ?').get(ms) as { c: number }).c; }

  // ---- versions
  nextVersionNumber(gameId: string): number {
    const r = this.db.prepare('SELECT MAX(n) m FROM version WHERE game_id = ?').get(gameId) as { m: number | null };
    return (r.m ?? 0) + 1;
  }
  latestVersion(gameId: string): VersionRow | undefined {
    return this.db.prepare('SELECT * FROM version WHERE game_id = ? ORDER BY n DESC LIMIT 1').get(gameId) as VersionRow | undefined;
  }
  getVersion(gameId: string, n: number): VersionRow | undefined {
    return this.db.prepare('SELECT * FROM version WHERE game_id = ? AND n = ?').get(gameId, n) as VersionRow | undefined;
  }
  listVersions(gameId: string): VersionRow[] {
    return this.db.prepare('SELECT * FROM version WHERE game_id = ? ORDER BY n').all(gameId) as VersionRow[];
  }
  /** Writes the version row for `n`, computing its counts from the nodes it contains. */
  writeVersion(gameId: string, n: number, status: 'complete' | 'partial', partialReason: string | null): VersionRow {
    const c = this.db.prepare('SELECT COUNT(*) c, COALESCE(MAX(depth), 0) d FROM node WHERE game_id = ? AND v_added <= ?').get(gameId, n) as { c: number; d: number };
    const miss = this.db.prepare(
      `SELECT COALESCE(SUM(MAX(0, p.quote_count - (SELECT COUNT(*) FROM node k WHERE k.parent_id = p.id AND k.v_added <= ?))), 0) m
         FROM node p WHERE p.game_id = ? AND p.v_added <= ? AND p.state = 'live' AND p.exhausted = 1`).get(n, gameId, n) as { m: number };
    const root = this.db.prepare('SELECT quote_count FROM node WHERE game_id = ? ORDER BY ord LIMIT 1').get(gameId) as { quote_count: number } | undefined;
    this.db.prepare(
      `INSERT OR REPLACE INTO version (game_id, n, captured_at, node_count, max_depth, status, partial_reason, missing_count, root_quote_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(gameId, n, this.now(), c.c, c.d, status, partialReason, miss.m, root?.quote_count ?? 0);
    return this.getVersion(gameId, n)!;
  }

  // ---- nodes
  nextOrd(gameId: string): number {
    const r = this.db.prepare('SELECT MAX(ord) m FROM node WHERE game_id = ?').get(gameId) as { m: number | null };
    return (r.m ?? -1) + 1;
  }
  hasNode(gameId: string, uri: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM node WHERE game_id = ? AND uri_hash = ?').get(gameId, uriHash(uri));
  }
  getNode(id: number): NodeRow | undefined { return this.db.prepare('SELECT * FROM node WHERE id = ?').get(id) as NodeRow | undefined; }
  getNodeByUri(gameId: string, uri: string): NodeRow | undefined {
    return this.db.prepare('SELECT * FROM node WHERE game_id = ? AND uri_hash = ?').get(gameId, uriHash(uri)) as NodeRow | undefined;
  }
  /** Inserts a node; a tombstone state stores no identifying fields, only its place and hash. */
  insertNode(n: NewNode): number {
    const state: NodeState = n.state ?? 'live';
    const live = state === 'live';
    // A hidden post that has replies keeps its address only until those replies are fetched (see releaseUri).
    const hold = !live && n.quoteCount !== 0;
    const ord = this.nextOrd(n.gameId);
    const r = this.db.prepare(
      `INSERT INTO node (game_id, v_added, ord, uri, uri_hash, did, handle, display_name, text, created_at, parent_id, depth, quote_count, state, exhausted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      n.gameId, n.vAdded, ord,
      live || hold ? n.uri : null, uriHash(n.uri),
      live ? n.did : null, live ? n.handle : null, live ? n.displayName : null, live ? n.text : null, live ? n.createdAt : null,
      n.parentId, n.depth, live || hold ? n.quoteCount : 0, state, live || hold ? 0 : 1);
    return Number(r.lastInsertRowid);
  }
  childCount(nodeId: number): number { return (this.db.prepare('SELECT COUNT(*) c FROM node WHERE parent_id = ?').get(nodeId) as { c: number }).c; }
  nodeCount(gameId: string): number { return (this.db.prepare('SELECT COUNT(*) c FROM node WHERE game_id = ?').get(gameId) as { c: number }).c; }
  setNodeProgress(id: number, cursor: string, exhausted: boolean): void {
    this.db.prepare('UPDATE node SET cursor = ?, exhausted = ? WHERE id = ?').run(cursor, exhausted ? 1 : 0, id);
  }
  setQuoteCount(id: number, quoteCount: number): void { this.db.prepare('UPDATE node SET quote_count = ? WHERE id = ?').run(quoteCount, id); }
  /** A hidden post's replies are all fetched: forget its address and leave only its place in the tree. */
  releaseUri(id: number): void { this.db.prepare("UPDATE node SET uri = NULL, quote_count = 0 WHERE id = ? AND state != 'live'").run(id); }
  /** Marks a node whose quotes Bluesky refused to give, so the copy can say so. */
  markRefused(id: number): void { this.db.prepare("UPDATE node SET cursor = ?, exhausted = 1 WHERE id = ?").run(REFUSED, id); }
  /** Posts in a version whose quotes could not be read. */
  refusedBranches(gameId: string, n: number): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM node WHERE game_id = ? AND v_added <= ? AND cursor = ?').get(gameId, n, REFUSED) as { c: number }).c;
  }
  reopenNode(id: number): void { this.db.prepare("UPDATE node SET cursor = '', exhausted = 0 WHERE id = ?").run(id); }
  /** Live nodes still to expand, the one with the most quotes left to fetch first. */
  nextFrontier(gameId: string): NodeRow | undefined {
    return this.db.prepare(
      `SELECT n.* FROM node n
        WHERE n.game_id = ? AND n.uri IS NOT NULL AND n.quote_count != 0 AND n.exhausted = 0
        ORDER BY CASE WHEN n.quote_count < 0 THEN 1 ELSE n.quote_count - (SELECT COUNT(*) FROM node k WHERE k.parent_id = n.id) END DESC, n.ord ASC
        LIMIT 1`).get(gameId) as NodeRow | undefined;
  }
  frontierSize(gameId: string): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM node WHERE game_id = ? AND uri IS NOT NULL AND quote_count != 0 AND exhausted = 0").get(gameId) as { c: number }).c;
  }
  liveNodesAfter(gameId: string, afterId: number, limit: number): NodeRow[] {
    return this.db.prepare("SELECT * FROM node WHERE game_id = ? AND state = 'live' AND id > ? ORDER BY id LIMIT ?").all(gameId, afterId, limit) as NodeRow[];
  }
  /** Nodes whose reported quote count is above the children stored under them. */
  nodesWithNewQuotes(gameId: string): NodeRow[] {
    return this.db.prepare(
      `SELECT n.* FROM node n WHERE n.game_id = ? AND n.state = 'live' AND n.quote_count >
         (SELECT COUNT(*) FROM node k WHERE k.parent_id = n.id)`).all(gameId) as NodeRow[];
  }
  noteMissing(id: number, wipeAt: number, spacingMs: number = 3600_000): 'counted' | 'wiped-due' | 'ignored' {
    const n = this.getNode(id);
    if (!n || n.state !== 'live') return 'ignored';
    if (n.last_missing_at && this.now() - n.last_missing_at < spacingMs) return 'ignored';   // strikes are spaced out
    const checks = n.missing_checks + 1;
    this.db.prepare('UPDATE node SET missing_checks = ?, last_missing_at = ? WHERE id = ?').run(checks, this.now(), id);
    return checks >= wipeAt ? 'wiped-due' : 'counted';
  }
  clearMissing(id: number): void { this.db.prepare('UPDATE node SET missing_checks = 0, last_missing_at = 0 WHERE id = ?').run(id); }
  /** Wipes every identifying field of a node but keeps its place, so replies stay attached. */
  tombstone(id: number, state: Exclude<NodeState, 'live'>): void {
    this.db.prepare(
      `UPDATE node SET state = ?, uri = NULL, did = NULL, handle = NULL, display_name = NULL, text = NULL, created_at = NULL,
         exhausted = 1, cursor = '', missing_checks = 0, last_missing_at = 0 WHERE id = ?`).run(state, id);
  }
  nodesForVersion(gameId: string, n: number): NodeRow[] {
    return this.db.prepare('SELECT * FROM node WHERE game_id = ? AND v_added <= ? ORDER BY ord').all(gameId, n) as NodeRow[];
  }
  /** A cheap value that changes whenever a version's contents do (nodes added, posts wiped). */
  fingerprint(gameId: string, n: number): string {
    const r = this.db.prepare("SELECT COUNT(*) c, COALESCE(SUM(state != 'live'), 0) t, COALESCE(MAX(id), 0) m, COALESCE(SUM(quote_count), 0) q FROM node WHERE game_id = ? AND v_added <= ?").get(gameId, n) as { c: number; t: number; m: number; q: number };
    return `${r.c}.${r.t}.${r.m}.${r.q}`;
  }
  /** How many of the root's direct quotes a version holds (its quote count at capture is frozen on the version row). */
  directQuotes(gameId: string, n: number): number {
    const root = this.db.prepare('SELECT id FROM node WHERE game_id = ? ORDER BY ord LIMIT 1').get(gameId) as { id: number } | undefined;
    if (!root) return 0;
    return (this.db.prepare('SELECT COUNT(*) c FROM node WHERE parent_id = ? AND v_added <= ?').get(root.id, n) as { c: number }).c;
  }
  /** Up to `limit` live posts to ask Bluesky about as a control: from other games first, then from this one. */
  controlNodes(gameId: string, limit: number): NodeRow[] {
    const others = this.db.prepare("SELECT * FROM node WHERE game_id != ? AND state = 'live' AND uri IS NOT NULL AND missing_checks = 0 ORDER BY id DESC LIMIT ?").all(gameId, limit) as NodeRow[];
    if (others.length >= limit) return others;
    const own = this.db.prepare("SELECT * FROM node WHERE game_id = ? AND state = 'live' AND uri IS NOT NULL AND missing_checks = 0 ORDER BY ord ASC LIMIT ?").all(gameId, limit - others.length) as NodeRow[];
    return others.concat(own);
  }
  /** A live node from some other game, used to tell "Bluesky is down" from "these posts are gone". */
  otherGameLiveNode(gameId: string): NodeRow | undefined {
    return this.db.prepare("SELECT * FROM node WHERE game_id != ? AND state = 'live' AND uri IS NOT NULL ORDER BY id LIMIT 1").get(gameId) as NodeRow | undefined;
  }

  // ---- checking and sweeping
  markChecked(gameId: string): void { this.db.prepare('UPDATE game SET last_checked_at = ? WHERE id = ?').run(this.now(), gameId); }
  /** Active games not checked for deleted posts since `olderThanMs`, with no job in flight. */
  dueForSweep(olderThanMs: number, limit: number): GameRow[] {
    return this.db.prepare(
      `SELECT g.* FROM game g WHERE g.status = 'active' AND g.last_checked_at < ?
          AND NOT EXISTS (SELECT 1 FROM crawl_job j WHERE j.game_id = g.id AND j.state IN ('queued','crawling'))
          AND EXISTS (SELECT 1 FROM version v WHERE v.game_id = g.id)
        ORDER BY g.last_checked_at ASC LIMIT ?`).all(olderThanMs, limit) as GameRow[];
  }

  // ---- reports (no reporter identity is ever stored)
  addReport(gameId: string, nodeId: number | null, reason: ReportReason, note: string): number {
    const r = this.db.prepare('INSERT INTO report (game_id, node_id, reason, note, created_at) VALUES (?, ?, ?, ?, ?)').run(gameId, nodeId, reason, note, this.now());
    return Number(r.lastInsertRowid);
  }
  listReports(status: 'open' | 'resolved' | 'dismissed' | 'all', limit = 200): ReportRow[] {
    return (status === 'all'
      ? this.db.prepare('SELECT * FROM report ORDER BY id DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT * FROM report WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit)) as ReportRow[];
  }
  getReport(id: number): ReportRow | undefined { return this.db.prepare('SELECT * FROM report WHERE id = ?').get(id) as ReportRow | undefined; }
  setReportStatus(id: number, status: 'open' | 'resolved' | 'dismissed'): boolean {
    return this.db.prepare('UPDATE report SET status = ?, resolved_at = ? WHERE id = ?').run(status, status === 'open' ? null : this.now(), id).changes > 0;
  }
  /** Drops resolved and dismissed reports older than `beforeMs`. */
  purgeReports(beforeMs: number): number {
    return this.db.prepare("DELETE FROM report WHERE status != 'open' AND resolved_at IS NOT NULL AND resolved_at < ?").run(beforeMs).changes;
  }
  openReportCount(): number { return (this.db.prepare("SELECT COUNT(*) c FROM report WHERE status = 'open'").get() as { c: number }).c; }

  // ---- moderation actions (used by the admin tools)
  /** Wipes every stored post by this account, in one game or in all of them. Returns how many. */
  tombstoneByDid(did: string, scope: string): number {
    const where = scope === 'all' ? '' : ' AND game_id = ?';
    const args: Array<string> = scope === 'all' ? [did] : [did, scope];
    return this.db.prepare(
      `UPDATE node SET state = 'removed_by_author', uri = NULL, did = NULL, handle = NULL, display_name = NULL, text = NULL, created_at = NULL,
         exhausted = 1, cursor = '', missing_checks = 0, last_missing_at = 0 WHERE state = 'live' AND did = ?${where}`).run(...args).changes;
  }
  /** Active games whose original post was written by this account (read from the stored root address). */
  gamesStartedBy(did: string): GameRow[] {
    const prefix = `at://${did}/`;
    return this.db.prepare("SELECT * FROM game WHERE status = 'active' AND substr(root_uri, 1, ?) = ? ORDER BY created_at DESC").all(prefix.length, prefix) as GameRow[];
  }
  gamesWithAccount(did: string): Array<{ game_id: string; posts: number }> {
    return this.db.prepare("SELECT game_id, COUNT(*) posts FROM node WHERE did = ? AND state = 'live' GROUP BY game_id").all(did) as Array<{ game_id: string; posts: number }>;
  }
  /** Removes every version and post of a game but keeps a hash of its root, so it cannot be quietly recreated. */
  deleteGameContents(gameId: string): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM node WHERE game_id = ?').run(gameId);
      this.db.prepare('DELETE FROM version WHERE game_id = ?').run(gameId);
      this.db.prepare("DELETE FROM crawl_job WHERE game_id = ? AND state IN ('queued','crawling')").run(gameId);
      this.db.prepare("UPDATE report SET node_id = NULL WHERE game_id = ?").run(gameId);
      this.db.prepare("UPDATE game SET status = 'deleted', root_uri = ?, frozen = 0 WHERE id = ?").run('deleted:' + gameId, gameId);
    });
  }
  logAdmin(action: string, target: string): void { this.db.prepare('INSERT INTO admin_log (at, action, target) VALUES (?, ?, ?)').run(this.now(), action, target); }
  recentAdminLog(limit = 50): Array<{ at: number; action: string; target: string }> {
    return this.db.prepare('SELECT at, action, target FROM admin_log ORDER BY id DESC LIMIT ?').all(limit) as Array<{ at: number; action: string; target: string }>;
  }
  gameSummary(gameId: string): { nodes: number; live: number; tombstones: number; versions: number } {
    const n = this.db.prepare("SELECT COUNT(*) c, COALESCE(SUM(state = 'live'), 0) l FROM node WHERE game_id = ?").get(gameId) as { c: number; l: number };
    const v = this.db.prepare('SELECT COUNT(*) c FROM version WHERE game_id = ?').get(gameId) as { c: number };
    return { nodes: n.c, live: n.l, tombstones: n.c - n.l, versions: v.c };
  }

  // ---- suppression
  isSuppressed(did: string, gameId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM suppression WHERE did = ? AND (scope = 'all' OR scope = ?)").get(did, gameId);
  }
  addSuppression(did: string, scope: string): void {
    this.db.prepare('INSERT OR IGNORE INTO suppression (did, scope, created_at) VALUES (?, ?, ?)').run(did, scope, this.now());
  }

  // ---- jobs
  createJob(gameId: string, kind: JobKind, versionN: number): JobRow {
    const r = this.db.prepare('INSERT INTO crawl_job (game_id, kind, state, version_n, created_at) VALUES (?, ?, ?, ?, ?)').run(gameId, kind, 'queued', versionN, this.now());
    return this.getJob(Number(r.lastInsertRowid))!;
  }
  getJob(id: number): JobRow | undefined { return this.db.prepare('SELECT * FROM crawl_job WHERE id = ?').get(id) as JobRow | undefined; }
  activeJob(gameId: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM crawl_job WHERE game_id = ? AND state IN ('queued','crawling') ORDER BY id LIMIT 1").get(gameId) as JobRow | undefined;
  }
  lastJob(gameId: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM crawl_job WHERE game_id = ? ORDER BY id DESC LIMIT 1').get(gameId) as JobRow | undefined;
  }
  nextQueuedJob(): JobRow | undefined { return this.db.prepare("SELECT * FROM crawl_job WHERE state = 'queued' ORDER BY id LIMIT 1").get() as JobRow | undefined; }
  /** Queued jobs: creations and refreshes (someone is waiting) before background re-checks, oldest first within each. */
  listQueued(): JobRow[] { return this.db.prepare("SELECT * FROM crawl_job WHERE state = 'queued' ORDER BY (kind = 'recheck') ASC, id ASC").all() as JobRow[]; }
  setJobQueued(id: number): void { this.db.prepare("UPDATE crawl_job SET state = 'queued' WHERE id = ?").run(id); }
  queuedCount(): number { return (this.db.prepare("SELECT COUNT(*) c FROM crawl_job WHERE state = 'queued' AND kind != 'recheck'").get() as { c: number }).c; }
  queuedAhead(jobId: number): number { return (this.db.prepare("SELECT COUNT(*) c FROM crawl_job WHERE state = 'queued' AND kind != 'recheck' AND id < ?").get(jobId) as { c: number }).c; }
  markJobStarted(id: number): void { this.db.prepare("UPDATE crawl_job SET state = 'crawling', started_at = COALESCE(started_at, ?) WHERE id = ?").run(this.now(), id); }
  addJobProgress(id: number, requests: number, nodesAdded: number): void {
    this.db.prepare('UPDATE crawl_job SET requests = requests + ?, nodes_added = nodes_added + ? WHERE id = ?').run(requests, nodesAdded, id);
  }
  finishJob(id: number, state: 'complete' | 'partial' | 'failed', error: string | null): void {
    this.db.prepare('UPDATE crawl_job SET state = ?, finished_at = ?, error = ? WHERE id = ?').run(state, this.now(), error, id);
  }
  bumpJobRetry(id: number): number {
    this.db.prepare('UPDATE crawl_job SET retry_count = retry_count + 1 WHERE id = ?').run(id);
    return this.getJob(id)!.retry_count;
  }
  /** After a restart, anything that was mid-crawl goes back in the queue and resumes from its saved cursors. */
  requeueInterrupted(): number {
    return this.db.prepare("UPDATE crawl_job SET state = 'queued' WHERE state = 'crawling'").run().changes;
  }
}
