import path from 'path';
import fs from 'fs';
import { config } from './config';

export type FeedType = 'top-skeets' | 'chrono-skeets';

export const FEED_TYPES: FeedType[] = ['top-skeets', 'chrono-skeets'];

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
  feed_type: FeedType;
  feed_uri: string | null;
  feed_url: string | null;
  post_count: number | null;
  generated_at: string | null;
  include_replies: boolean;
  last_full_refresh_at: string | null;
  last_checked_at: string | null;
  posts: PostRecord[];
}

const dataDir = path.resolve(path.dirname(config.databasePath));
const indexPath = path.join(dataDir, '_index.json');

// In-memory cache — invalidated on every upsert
const feedCache = new Map<string, UserFeed>();
function cacheKey(did: string, feedType: FeedType): string { return `${did}::${feedType}`; }

function ensureDataDir(): void {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function feedFilePath(did: string, feedType: FeedType): string {
  return path.join(dataDir, did.replace(/:/g, '-') + '-' + feedType + '.json');
}

function readIndex(): Record<string, string> {
  if (!fs.existsSync(indexPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeIndex(index: Record<string, string>): void {
  fs.writeFileSync(indexPath, JSON.stringify(index), 'utf8');
}

export interface UpsertFeedInput {
  did: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  feedType: FeedType;
  feedUri: string;
  feedUrl: string;
  postCount: number;
  generatedAt: string;
  includeReplies: boolean;
  lastFullRefreshAt: string | null;
  posts: PostRecord[];
}

export function upsertFeed(feed: UpsertFeedInput): void {
  ensureDataDir();

  const now = new Date().toISOString();
  const record: UserFeed = {
    did: feed.did,
    handle: feed.handle,
    display_name: feed.displayName,
    avatar_url: feed.avatarUrl,
    feed_type: feed.feedType,
    feed_uri: feed.feedUri,
    feed_url: feed.feedUrl,
    post_count: feed.postCount,
    generated_at: feed.generatedAt,
    include_replies: feed.includeReplies,
    last_full_refresh_at: feed.lastFullRefreshAt,
    last_checked_at: now,
    posts: feed.posts,
  };

  fs.writeFileSync(feedFilePath(feed.did, feed.feedType), JSON.stringify(record), 'utf8');
  feedCache.set(cacheKey(feed.did, feed.feedType), record);

  // Index maps handle → DID (DID is stable across feed types)
  const normalized = feed.handle.startsWith('@') ? feed.handle.slice(1) : feed.handle;
  const index = readIndex();
  index[normalized] = feed.did;
  writeIndex(index);
}

export function getFeedByDid(did: string, feedType: FeedType): UserFeed | null {
  const key = cacheKey(did, feedType);
  const cached = feedCache.get(key);
  if (cached) return cached;

  const filePath = feedFilePath(did, feedType);
  if (!fs.existsSync(filePath)) return null;
  try {
    const feed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as UserFeed;
    feedCache.set(key, feed);
    return feed;
  } catch {
    return null;
  }
}

export function getAllFeeds(): UserFeed[] {
  if (!fs.existsSync(dataDir)) return [];
  const feeds: UserFeed[] = [];
  for (const file of fs.readdirSync(dataDir)) {
    if (file === '_index.json' || !file.endsWith('.json')) continue;
    try {
      const feed = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8')) as UserFeed;
      feeds.push(feed);
    } catch { /* skip corrupted file */ }
  }
  return feeds;
}

export function getFeedByHandle(handle: string, feedType: FeedType): UserFeed | null {
  const normalized = handle.startsWith('@') ? handle.slice(1) : handle;
  const index = readIndex();
  const did = index[normalized];
  if (!did) return null;
  return getFeedByDid(did, feedType);
}

/** Update last_checked_at without changing posts — used when incremental refresh finds nothing new. */
export function touchFeedChecked(did: string, feedType: FeedType): void {
  const feed = getFeedByDid(did, feedType);
  if (!feed) return;
  const updated = { ...feed, last_checked_at: new Date().toISOString() };
  fs.writeFileSync(feedFilePath(did, feedType), JSON.stringify(updated), 'utf8');
  feedCache.set(cacheKey(did, feedType), updated);
}

export function deleteFeed(did: string, feedType: FeedType): void {
  feedCache.delete(cacheKey(did, feedType));
  const filePath = feedFilePath(did, feedType);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * One-time migration: read the legacy sql.js SQLite database (feeds.db) and
 * write each row as a {did}-top-skeets.json file. Renames feeds.db to
 * feeds.db.migrated afterward so it never runs again.
 */
export async function migrateV0ToV1(): Promise<void> {
  const legacyDb = path.resolve(config.databasePath);
  console.log(`[migration v0→v1] checking for legacy DB at: ${legacyDb}`);
  if (!fs.existsSync(legacyDb)) {
    console.log('[migration v0→v1] not found — skipping');
    return;
  }

  console.log('[migration v0→v1] found feeds.db — migrating to JSON files…');
  ensureDataDir();

  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(legacyDb);
  const db = new SQL.Database(buf);

  const stmt = db.prepare('SELECT * FROM user_feeds');
  let count = 0;

  while (stmt.step()) {
    const row = stmt.getAsObject() as Record<string, unknown>;
    const did = row['did'] as string;
    const handle = row['handle'] as string;
    let posts: PostRecord[] = [];
    try {
      posts = JSON.parse(row['posts'] as string) as PostRecord[];
    } catch { /* leave empty */ }

    const record: UserFeed = {
      did,
      handle,
      display_name: (row['display_name'] as string | null) ?? null,
      avatar_url: (row['avatar_url'] as string | null) ?? null,
      feed_type: 'top-skeets',
      feed_uri: (row['feed_uri'] as string | null) ?? null,
      feed_url: (row['feed_url'] as string | null) ?? null,
      post_count: (row['post_count'] as number | null) ?? null,
      generated_at: (row['generated_at'] as string | null) ?? null,
      include_replies: false,
      last_full_refresh_at: null,
      last_checked_at: null,
      posts,
    };

    fs.writeFileSync(feedFilePath(did, 'top-skeets'), JSON.stringify(record), 'utf8');

    const normalized = handle.startsWith('@') ? handle.slice(1) : handle;
    const index = readIndex();
    index[normalized] = did;
    writeIndex(index);

    console.log(`[migration v0→v1] migrated ${handle}`);
    count++;
  }

  stmt.free();
  db.close();

  // Rename so this migration never runs again
  fs.renameSync(legacyDb, legacyDb + '.migrated');
  console.log(`[migration v0→v1] done — migrated ${count} feed(s), renamed feeds.db → feeds.db.migrated`);
}

/**
 * One-time migration: rename legacy {did-slug}.json files (created before
 * feed types were introduced) to {did-slug}-top-skeets.json.
 * Safe to call on every startup — no-op if nothing to rename.
 */
export function migrateV1ToV2(): void {
  if (!fs.existsSync(dataDir)) return;
  const files = fs.readdirSync(dataDir);
  for (const file of files) {
    if (
      file.startsWith('did-') &&
      file.endsWith('.json') &&
      !file.endsWith('-top-skeets.json') &&
      !file.endsWith('-chrono-skeets.json')
    ) {
      const oldPath = path.join(dataDir, file);
      const newName = file.replace(/\.json$/, '-top-skeets.json');
      const newPath = path.join(dataDir, newName);
      fs.renameSync(oldPath, newPath);
      console.log(`[migration] ${file} → ${newName}`);
    }
  }
}
