/**
 * npm run diagnose -- <post link>
 *
 * Crawls one post two ways against the real AppView and explains any difference: the way the live Tracer does
 * (follow every quote it is shown) and the way the saved copy does (GameCrawler into a throwaway in-memory database).
 * Nothing is written to the real games database.
 */
import path from 'path';
import fs from 'fs';
import { parsePostLink } from './links';
import { AppViewClient, NotFound, PostView } from './games/appview';
import { GamesDb, uriHash } from './games/db';
import { GameCrawler } from './games/crawler';
import { HIDE_LABELS } from './games/labels';

export interface Difference { uri: string; reason: string }
export interface Report {
  live: { total: number; noCount: number; refused: Array<{ uri: string; why: string }>; hideLabels: Record<string, number> };
  saved: { total: number; states: Record<string, number>; refusedBranches: number; status: string };
  onlyLive: number;
  differences: Difference[];
}

const labelsOf = (p: PostView): string[] => [...(p.labels ?? []), ...(p.author?.labels ?? [])].map(l => l?.val ?? '').filter(v => HIDE_LABELS.includes(v));

export async function diagnose(client: AppViewClient, rootUri: string, sizeCap = 5000): Promise<Report> {
  // ---- live way: every quote Bluesky shows, whatever its labels, expanding any post whose count is not exactly 0
  const root = (await client.getPosts([rootUri]))[0];
  if (!root) throw new Error('Bluesky did not return that post.');
  const seen = new Map<string, { parent: string | null; post: PostView }>([[root.uri, { parent: null, post: root }]]);
  const refused: Array<{ uri: string; why: string }> = [];
  const queue = [root];
  let noCount = typeof root.quoteCount === 'number' ? 0 : 1;
  const hideLabels: Record<string, number> = {};
  const noteLabels = (p: PostView) => { for (const l of labelsOf(p)) hideLabels[l] = (hideLabels[l] ?? 0) + 1; };
  noteLabels(root);
  while (queue.length && seen.size < sizeCap + 1) {
    const cur = queue.shift()!;
    if (cur.quoteCount === 0) continue;
    let cursor: string | undefined;
    do {
      let page: { posts: PostView[]; cursor?: string };
      try { page = await client.getQuotes(cur.uri, cursor); } catch (e) {
        if (e instanceof NotFound) { refused.push({ uri: cur.uri, why: e.message }); break; }
        throw e;
      }
      for (const p of page.posts) {
        if (!p?.uri || seen.has(p.uri)) continue;
        seen.set(p.uri, { parent: cur.uri, post: p });
        if (typeof p.quoteCount !== 'number') noCount++;
        noteLabels(p);
        queue.push(p);
      }
      cursor = page.cursor && page.posts.length ? page.cursor : undefined;
    } while (cursor);
  }

  // ---- saved way
  const db = new GamesDb(':memory:');
  const crawler = new GameCrawler({ db, appview: client, sizeCap });
  const game = crawler.createGame(root);
  const job = db.createJob(game.id, 'create', 1);
  const out = await crawler.run(job);
  const rows = db.nodesForVersion(game.id, 1);
  const byHash = new Map(rows.map(r => [r.uri_hash, r]));
  const states: Record<string, number> = {};
  for (const r of rows) states[r.state] = (states[r.state] ?? 0) + 1;

  const differences: Difference[] = [];
  let onlyLive = 0;
  for (const [uri, { parent }] of seen) {
    if (byHash.has(uriHash(uri))) continue;
    onlyLive++;
    if (differences.length >= 10) continue;
    let reason = 'unknown';
    // walk up to the nearest ancestor the saved copy has, and say why it stopped there
    let up = parent;
    while (up && !byHash.has(uriHash(up))) up = seen.get(up)?.parent ?? null;
    const a = up ? byHash.get(uriHash(up)) : undefined;
    if (!a) reason = 'no ancestor in the saved copy';
    else if (a.cursor === '!refused') reason = 'Bluesky refused the quotes request for its parent branch';
    else if (a.state !== 'live') reason = `its parent branch was ${a.state}`;
    else if (a.quote_count === 0) reason = 'the nearest saved ancestor reports 0 quotes';
    else reason = 'the size cap or an unfinished branch';
    differences.push({ uri, reason });
  }
  const report: Report = {
    live: { total: seen.size - 1, noCount, refused, hideLabels },
    saved: { total: rows.length - 1, states, refusedBranches: db.refusedBranches(game.id, 1), status: out.status },
    onlyLive, differences,
  };
  db.close();
  return report;
}

function describeLocalDb(say: (s: string) => void, dataDir: string): void {
  const file = path.join(dataDir, 'games.sqlite');
  if (!fs.existsSync(file)) return;
  const db = new GamesDb(file);
  say(`\nLocal saved games (${file}):`);
  const sup = db.db.prepare("SELECT scope = 'all' AS everywhere, COUNT(*) c FROM suppression GROUP BY everywhere").all() as Array<{ everywhere: number; c: number }>;
  say(`  accounts kept out of every game: ${sup.find(s => s.everywhere)?.c ?? 0}; kept out of one game: ${sup.find(s => !s.everywhere)?.c ?? 0}`);
  for (const g of db.db.prepare('SELECT id FROM game').all() as Array<{ id: string }>) {
    const st = db.db.prepare('SELECT state, COUNT(*) c FROM node WHERE game_id = ? GROUP BY state').all(g.id) as Array<{ state: string; c: number }>;
    say(`  game ${g.id}: ${st.map(s => `${s.state} ${s.c}`).join(', ')}`);
  }
  db.close();
}

async function main(): Promise<void> {
  // Loaded only when run from the command line, so tests can import diagnose() without a full environment.
  const { config } = require('./config') as typeof import('./config');
  const { appviewBudget } = require('./budget') as typeof import('./budget');
  const say = (s: string) => console.log(s);
  const link = process.argv.slice(2).find(a => !a.startsWith('--'));
  const parsed = link ? parsePostLink(link) : null;
  if (!parsed) { say('Give a post link, for example: npm run diagnose -- https://bsky.app/profile/someone/post/3abc'); process.exitCode = 1; return; }
  const client = new AppViewClient({ baseUrl: config.appviewUrl, budget: appviewBudget, userAgent: config.userAgent, gapMs: config.games.crawlGapMs, priority: 'user' });
  const did = parsed.id.startsWith('did:') ? parsed.id : await client.resolveHandle(parsed.id);
  const uri = `at://${did}/app.bsky.feed.post/${parsed.rkey}`;
  say(`Crawling ${uri} two ways. This can take a while for a big game...`);
  const r = await diagnose(client, uri, config.games.sizeCap);
  say(`\nLive way:  ${r.live.total} quotes. Without a quote count: ${r.live.noCount}. Refused quotes requests: ${r.live.refused.length}.`);
  say(`           hide labels seen: ${Object.keys(r.live.hideLabels).length ? JSON.stringify(r.live.hideLabels) : 'none'}`);
  for (const f of r.live.refused.slice(0, 5)) say(`           refused: ${f.uri} (${f.why})`);
  say(`Saved way: ${r.saved.total} quotes (${r.saved.status}). States: ${JSON.stringify(r.saved.states)}. Branches that could not be read: ${r.saved.refusedBranches}.`);
  say(`\nReachable live but missing saved: ${r.onlyLive}`);
  for (const d of r.differences) say(`  ${d.uri}\n    why: ${d.reason}`);
  describeLocalDb(say, config.dataDir);
}

if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(), 50));
