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
  posts: PostRecord[];
}

// Store files alongside the configured database path directory
const dataDir = path.resolve(path.dirname(config.databasePath));
const indexPath = path.join(dataDir, '_index.json');

function ensureDataDir(): void {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function feedFilePath(did: string): string {
  return path.join(dataDir, did.replace(/:/g, '-') + '.json');
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
    feed_uri: feed.feedUri,
    feed_url: feed.feedUrl,
    post_count: feed.postCount,
    generated_at: feed.generatedAt,
    posts: feed.posts,
  };

  fs.writeFileSync(feedFilePath(feed.did), JSON.stringify(record), 'utf8');

  const normalized = feed.handle.startsWith('@') ? feed.handle.slice(1) : feed.handle;
  const index = readIndex();
  index[normalized] = feed.did;
  writeIndex(index);
}

export function getFeedByDid(did: string): UserFeed | null {
  const filePath = feedFilePath(did);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as UserFeed;
  } catch {
    return null;
  }
}

export function getFeedByHandle(handle: string): UserFeed | null {
  const normalized = handle.startsWith('@') ? handle.slice(1) : handle;
  const index = readIndex();
  const did = index[normalized];
  if (!did) return null;
  return getFeedByDid(did);
}

export function deleteFeed(did: string): void {
  const filePath = feedFilePath(did);
  if (fs.existsSync(filePath)) {
    const record = getFeedByDid(did);
    fs.unlinkSync(filePath);
    if (record) {
      const normalized = record.handle.startsWith('@') ? record.handle.slice(1) : record.handle;
      const index = readIndex();
      delete index[normalized];
      writeIndex(index);
    }
  }
}
