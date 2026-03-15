import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
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

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = path.resolve(config.databasePath);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');

  _db.exec(`
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

  return _db;
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
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO user_feeds
      (did, handle, display_name, avatar_url, feed_uri, feed_url, post_count, generated_at, posts)
    VALUES
      (@did, @handle, @displayName, @avatarUrl, @feedUri, @feedUrl, @postCount, @generatedAt, @posts)
  `);
  stmt.run({
    did: feed.did,
    handle: feed.handle,
    displayName: feed.displayName,
    avatarUrl: feed.avatarUrl,
    feedUri: feed.feedUri,
    feedUrl: feed.feedUrl,
    postCount: feed.postCount,
    generatedAt: feed.generatedAt,
    posts: JSON.stringify(feed.posts),
  });
}

export function getFeedByDid(did: string): UserFeed | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM user_feeds WHERE did = ?').get(did) as UserFeed | undefined;
  return row ?? null;
}

export function getFeedByHandle(handle: string): UserFeed | null {
  const db = getDb();
  // Normalize handle — strip leading @
  const normalized = handle.startsWith('@') ? handle.slice(1) : handle;
  const row = db.prepare('SELECT * FROM user_feeds WHERE handle = ?').get(normalized) as UserFeed | undefined;
  return row ?? null;
}
