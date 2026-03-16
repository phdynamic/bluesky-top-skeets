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
  posts: PostRecord[];
}

const dataDir = path.resolve(path.dirname(config.databasePath));
const indexPath = path.join(dataDir, '_index.json');

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
  posts: PostRecord[];
}

export function upsertFeed(feed: UpsertFeedInput): void {
  ensureDataDir();

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
    posts: feed.posts,
  };

  fs.writeFileSync(feedFilePath(feed.did, feed.feedType), JSON.stringify(record), 'utf8');

  // Index maps handle → DID (DID is stable across feed types)
  const normalized = feed.handle.startsWith('@') ? feed.handle.slice(1) : feed.handle;
  const index = readIndex();
  index[normalized] = feed.did;
  writeIndex(index);
}

export function getFeedByDid(did: string, feedType: FeedType): UserFeed | null {
  const filePath = feedFilePath(did, feedType);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as UserFeed;
  } catch {
    return null;
  }
}

export function getFeedByHandle(handle: string, feedType: FeedType): UserFeed | null {
  const normalized = handle.startsWith('@') ? handle.slice(1) : handle;
  const index = readIndex();
  const did = index[normalized];
  if (!did) return null;
  return getFeedByDid(did, feedType);
}

export function deleteFeed(did: string, feedType: FeedType): void {
  const filePath = feedFilePath(did, feedType);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
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
