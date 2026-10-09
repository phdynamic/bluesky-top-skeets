import path from 'path';
import type express from 'express';
import { config } from '../config';
import { appviewBudget } from '../budget';

export interface RunningGames { stop(): Promise<void> }

/**
 * Saved quote-post games. Everything here is off unless GAMES_ENABLED=true: with the flag unset this
 * returns immediately, no route exists, no database file is created and no worker starts.
 */
export function startGames(app: express.Express): RunningGames | null {
  if (!config.gamesEnabled) return null;

  // Loaded only now, so that a server with the flag off never touches the native SQLite module
  // (if it were ever missing on a host, the rest of the site must still start).
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { GamesDb } = require('./db') as typeof import('./db');
  const { AppViewClient } = require('./appview') as typeof import('./appview');
  const { GamesQueue } = require('./queue') as typeof import('./queue');
  const { GamesLimits } = require('./ratelimit') as typeof import('./ratelimit');
  const { createGamesRouter } = require('./api') as typeof import('./api');

  const db = new GamesDb(path.join(config.dataDir, 'games.sqlite'));
  const client = (gapMs: number, maxAttempts: number) => new AppViewClient({
    baseUrl: config.appviewUrl, budget: appviewBudget, userAgent: config.userAgent, gapMs, maxAttempts, priority: 'user',
  });
  const queue = new GamesQueue({
    db, sizeCap: config.games.sizeCap, log: msg => console.log(msg),
    makeAppView: () => client(config.games.crawlGapMs, 6),
  });
  const limits = new GamesLimits({
    lookupsPerIpPerHour: config.games.maxCreatesPerIpPerHour * 10,
    createsPerIpPerHour: config.games.maxCreatesPerIpPerHour,
    refreshesPerIpPerHour: config.games.maxCreatesPerIpPerHour * 3,
  });
  app.use('/api/games', createGamesRouter({
    db, queue, limits,
    makeLookupClient: () => client(0, 3),
    sizeCap: config.games.sizeCap,
    refreshCooldownMs: config.games.refreshCooldownHours * 3600_000,
    maxCreatesPerDay: config.games.maxCreatesPerDay,
    maxQueued: config.games.maxQueued,
    trustedProxyHops: config.trustedProxyHops,
  }));
  queue.start();
  console.log(`[games] saved games are ON (cap ${config.games.sizeCap} quotes, refresh every ${config.games.refreshCooldownHours} h)`);
  return { stop: async () => { await queue.stop(); db.close(); } };
}
