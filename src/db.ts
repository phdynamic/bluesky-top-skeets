import path from 'path';
import fs from 'fs';
import initSqlJs, { Database } from 'sql.js';
import { config } from './config';

export interface PostRecord {
  uri: string;
  url: string;
  text: string;
  likeCount: number;
  indexedAt: string;
}

export interface UserFeed {
  did: string;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  feed_uri: string | null;
  feed_url: string | null;
  post_count: number | null;
  generated_at: string | null;
  posts: string; // JSON array
}

let _db: Database | null = null;
const dbPath = path.resolve(config.databasePath);

/**
 * Must be called once at startup before any query functions are used.
 * sql.js is pure WASM — no native compilation required.
 */
export async function initDb(): Promise<void> {
  if (_db) return;

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath);
    _db = new SQL.Database(buf);
  } else {
    _db = new SQL.Database();
  }

  _db.run(`
    CREATE TABLE IF NOT EXISTS user_feeds (
      did           TEXT PRIMARY KEY,
      handle        TEXT NOT NULL,
      display_name  TEXT,
      avatar_url    TEXT,
      feed_uri      TEXT,
      feed_url      TEXT,
      post_count    INTEGER,
      generated_at  TEXT,
      posts         TEXT NOT NULL DEFAULT '[]'
    )
  `);

  _persist();
}

function _db_(): Database {
  if (!_db) throw new Error('DB not initialised — call initDb() first');
  return _db;
}

/** Write the in-memory database back to disk. */
function _persist(): void {
  if (!_db) return;
  const data = _db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

export interface UpsertFeedInput {
  did: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  feedUri: string;
  feedUrl: string;
  postCount: number;
  generatedAt: string;
  posts: PostRecord[];
}

export function upsertFeed(feed: UpsertFeedInput): void {
  _db_().run(
    `INSERT OR REPLACE INTO user_feeds
       (did, handle, display_name, avatar_url, feed_uri, feed_url, post_count, generated_at, posts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      feed.did,
      feed.handle,
      feed.displayName,
      feed.avatarUrl,
      feed.feedUri,
      feed.feedUrl,
      feed.postCount,
      feed.generatedAt,
      JSON.stringify(feed.posts),
    ],
  );
  _persist();
}

export function getFeedByDid(did: string): UserFeed | null {
  const stmt = _db_().prepare('SELECT * FROM user_feeds WHERE did = ?');
  stmt.bind([did]);
  const found = stmt.step();
  const row = found ? (stmt.getAsObject() as unknown as UserFeed) : null;
  stmt.free();
  return row;
}

export function getFeedByHandle(handle: string): UserFeed | null {
  const normalized = handle.startsWith('@') ? handle.slice(1) : handle;
  const stmt = _db_().prepare('SELECT * FROM user_feeds WHERE handle = ?');
  stmt.bind([normalized]);
  const found = stmt.step();
  const row = found ? (stmt.getAsObject() as unknown as UserFeed) : null;
  stmt.free();
  return row;
}
