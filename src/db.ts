import path from 'path';
import fs from 'fs';
import { config } from './config';

export type FeedType = 'top-skeets' | 'chrono-skeets' | 'top-skeets-replies' | 'chrono-skeets-replies';

export const FEED_TYPES: FeedType[] = ['top-skeets', 'chrono-skeets', 'top-skeets-replies', 'chrono-skeets-replies'];

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
  feed_name: string | null;
  feed_uri: string | null;
  feed_url: string | null;
  post_count: number | null;
  generated_at: string | null;
  include_replies: boolean;
  last_full_refresh_at: string | null;
  last_checked_at: string | null;
  posts: PostRecord[];
}

/**
 * UserFeed minus posts — kept in the _meta.json sidecar so the scheduler's
 * due-check and status lookups never parse full post arrays. Strictly derived
 * state: always rebuildable from the feed files.
 */
export interface FeedMeta {
  did: string;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  feed_type: FeedType;
  feed_name: string | null;
  feed_uri: string | null;
  feed_url: string | null;
  post_count: number;
  generated_at: string | null;
  include_replies: boolean;
  last_full_refresh_at: string | null;
  last_checked_at: string | null;
}

const dataDir = path.resolve(config.dataDir);
const indexPath = path.join(dataDir, '_index.json');
const metaPath = path.join(dataDir, '_meta.json');

// In-memory LRU cache of full feeds (posts included) — bounded so hundreds of
// feeds can't accumulate unbounded memory. Writes keep entries coherent.
const MAX_CACHED_FEEDS = 50;
const feedCache = new Map<string, UserFeed>();
function cacheKey(did: string, feedType: FeedType): string { return `${did}::${feedType}`; }

function cacheGet(key: string): UserFeed | undefined {
  const feed = feedCache.get(key);
  if (feed) {
    // Re-insert so Map iteration order tracks recency
    feedCache.delete(key);
    feedCache.set(key, feed);
  }
  return feed;
}

function cacheSet(key: string, feed: UserFeed): void {
  feedCache.delete(key);
  feedCache.set(key, feed);
  while (feedCache.size > MAX_CACHED_FEEDS) {
    const oldest = feedCache.keys().next().value;
    if (oldest === undefined) break;
    feedCache.delete(oldest);
  }
}

function ensureDataDir(): void {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function feedFilePath(did: string, feedType: FeedType): string {
  return path.join(dataDir, did.replace(/:/g, '-') + '-' + feedType + '.json');
}

/**
 * Write via a temp file + rename so a crash mid-write can never leave a
 * truncated JSON file behind (rename is atomic on the same filesystem).
 */
function atomicWriteFileSync(filePath: string, data: string): void {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, data, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Read and parse a feed file. On corruption, quarantine it as .corrupt so the
 * failure is loud once, visible on the volume, and the data is preserved for
 * inspection. With atomic writes this should never fire for new corruption.
 */
function readFeedFile(filePath: string): UserFeed | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null; // missing file
  }
  try {
    return JSON.parse(raw) as UserFeed;
  } catch (err) {
    console.error(`[db] CORRUPT feed file, quarantining: ${filePath}`, err instanceof Error ? err.message : String(err));
    try {
      fs.renameSync(filePath, filePath + '.corrupt');
    } catch { /* quarantine is best-effort */ }
    return null;
  }
}

function scanFeedFiles(): string[] {
  if (!fs.existsSync(dataDir)) return [];
  return fs.readdirSync(dataDir).filter(f => !f.startsWith('_') && f.endsWith('.json'));
}

function hasFeedFiles(): boolean {
  return scanFeedFiles().length > 0;
}

/**
 * Rebuild _index.json from the feed files themselves. Feed files are the
 * source of truth; the index is derived and can always be regenerated.
 */
function rebuildIndex(): Record<string, string> {
  const index: Record<string, string> = {};
  for (const file of scanFeedFiles()) {
    const feed = readFeedFile(path.join(dataDir, file));
    if (!feed) continue;
    const normalized = feed.handle.startsWith('@') ? feed.handle.slice(1) : feed.handle;
    index[normalized] = feed.did;
  }
  writeIndex(index);
  console.log(`[db] rebuilt _index.json with ${Object.keys(index).length} entries`);
  return index;
}

function readIndex(): Record<string, string> {
  if (!fs.existsSync(indexPath)) {
    // Missing index but feed files present — regenerate rather than letting
    // the next upsert write a near-empty index over everyone's lookups.
    return hasFeedFiles() ? rebuildIndex() : {};
  }
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8')) as Record<string, string>;
  } catch {
    return rebuildIndex();
  }
}

function writeIndex(index: Record<string, string>): void {
  ensureDataDir();
  atomicWriteFileSync(indexPath, JSON.stringify(index));
}

// ---------------------------------------------------------------------------
// Feed metadata sidecar (_meta.json) — held in memory and written through on
// every persist, so the scheduler and status lookups cost zero feed-file
// reads. Missing or corrupt, it is rebuilt from the feed files.
// ---------------------------------------------------------------------------
let metas: Record<string, FeedMeta> | null = null;

function metaFromFeed(feed: UserFeed): FeedMeta {
  return {
    did: feed.did,
    handle: feed.handle,
    display_name: feed.display_name,
    avatar_url: feed.avatar_url,
    feed_type: feed.feed_type,
    feed_name: feed.feed_name ?? null,
    feed_uri: feed.feed_uri,
    feed_url: feed.feed_url,
    post_count: feed.post_count ?? (feed.posts ?? []).length,
    generated_at: feed.generated_at,
    include_replies: feed.include_replies ?? false,
    last_full_refresh_at: feed.last_full_refresh_at ?? null,
    last_checked_at: feed.last_checked_at ?? null,
  };
}

function rebuildMetas(): Record<string, FeedMeta> {
  const result: Record<string, FeedMeta> = {};
  for (const file of scanFeedFiles()) {
    const feed = readFeedFile(path.join(dataDir, file));
    if (!feed) continue;
    result[cacheKey(feed.did, feed.feed_type)] = metaFromFeed(feed);
  }
  console.log(`[db] rebuilt feed metadata with ${Object.keys(result).length} entries`);
  return result;
}

/** Repair drift from a crash between a feed-file write and the meta write. */
function reconcileMetas(m: Record<string, FeedMeta>): void {
  for (const key of Object.keys(m)) {
    if (!fs.existsSync(feedFilePath(m[key].did, m[key].feed_type))) delete m[key];
  }
  const known = new Set(
    Object.values(m).map(meta => path.basename(feedFilePath(meta.did, meta.feed_type)))
  );
  for (const file of scanFeedFiles()) {
    if (known.has(file)) continue;
    const feed = readFeedFile(path.join(dataDir, file));
    if (feed) m[cacheKey(feed.did, feed.feed_type)] = metaFromFeed(feed);
  }
}

function loadMetas(): Record<string, FeedMeta> {
  if (metas) return metas;
  let loaded: Record<string, FeedMeta> | null = null;
  if (fs.existsSync(metaPath)) {
    try {
      loaded = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, FeedMeta>;
    } catch {
      console.error('[db] corrupt _meta.json — rebuilding from feed files');
    }
  }
  if (!loaded) loaded = rebuildMetas();
  reconcileMetas(loaded);
  metas = loaded;
  writeMetas();
  return metas;
}

function writeMetas(): void {
  if (!metas) return;
  ensureDataDir();
  atomicWriteFileSync(metaPath, JSON.stringify(metas));
}

export function getAllFeedMetas(): FeedMeta[] {
  return Object.values(loadMetas());
}

export function getFeedMetaByDid(did: string, feedType: FeedType): FeedMeta | null {
  return loadMetas()[cacheKey(did, feedType)] ?? null;
}

export function getFeedMetaByHandle(handle: string, feedType: FeedType): FeedMeta | null {
  const normalized = handle.startsWith('@') ? handle.slice(1) : handle;
  const did = readIndex()[normalized];
  if (!did) return null;
  return getFeedMetaByDid(did, feedType);
}

export interface UpsertFeedInput {
  did: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  feedType: FeedType;
  feedName: string | null;
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
    feed_name: feed.feedName,
    feed_uri: feed.feedUri,
    feed_url: feed.feedUrl,
    post_count: feed.postCount,
    generated_at: feed.generatedAt,
    include_replies: feed.includeReplies,
    last_full_refresh_at: feed.lastFullRefreshAt,
    last_checked_at: now,
    posts: feed.posts,
  };

  atomicWriteFileSync(feedFilePath(feed.did, feed.feedType), JSON.stringify(record));
  cacheSet(cacheKey(feed.did, feed.feedType), record);

  const m = loadMetas();
  m[cacheKey(feed.did, feed.feedType)] = metaFromFeed(record);
  writeMetas();

  // Index maps handle → DID (DID is stable across feed types)
  const normalized = feed.handle.startsWith('@') ? feed.handle.slice(1) : feed.handle;
  const index = readIndex();
  index[normalized] = feed.did;
  writeIndex(index);
}

export function getFeedByDid(did: string, feedType: FeedType): UserFeed | null {
  const key = cacheKey(did, feedType);
  const cached = cacheGet(key);
  if (cached) return cached;

  const feed = readFeedFile(feedFilePath(did, feedType));
  if (!feed) return null;
  cacheSet(key, feed);
  return feed;
}

/** Update last_checked_at without changing posts — used when incremental refresh finds nothing new. */
export function touchFeedChecked(did: string, feedType: FeedType): void {
  const feed = getFeedByDid(did, feedType);
  if (!feed) return;
  const updated = { ...feed, last_checked_at: new Date().toISOString() };
  atomicWriteFileSync(feedFilePath(did, feedType), JSON.stringify(updated));
  cacheSet(cacheKey(did, feedType), updated);

  const m = loadMetas();
  m[cacheKey(did, feedType)] = metaFromFeed(updated);
  writeMetas();
}

export function deleteFeed(did: string, feedType: FeedType): void {
  feedCache.delete(cacheKey(did, feedType));
  const filePath = feedFilePath(did, feedType);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  const m = loadMetas();
  delete m[cacheKey(did, feedType)];
  writeMetas();
}
