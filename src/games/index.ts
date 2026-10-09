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
  const { createAdminRouter } = require('./admin') as typeof import('./admin');
  const { GamesSweeper } = require('./sweep') as typeof import('./sweep');

  const db = new GamesDb(path.join(config.dataDir, 'games.sqlite'));
  const client = (gapMs: number, maxAttempts: number, priority: 'user' | 'background' = 'user') => new AppViewClient({
    baseUrl: config.appviewUrl, budget: appviewBudget, userAgent: config.userAgent, gapMs, maxAttempts, priority,
  });
  const makeLookupClient = () => client(0, 3);
  const queue = new GamesQueue({
    db, sizeCap: config.games.sizeCap, log: msg => console.log(msg),
    makeAppView: kind => client(config.games.crawlGapMs, 6, kind === 'recheck' ? 'background' : 'user'),
  });
  const limits = new GamesLimits({
    lookupsPerIpPerHour: config.games.maxCreatesPerIpPerHour * 10,
    createsPerIpPerHour: config.games.maxCreatesPerIpPerHour,
    refreshesPerIpPerHour: config.games.maxCreatesPerIpPerHour * 3,
    reportsPerIpPerHour: 10,
    rechecksPerIpPerHour: 6,
  });
  app.use('/api/games', createGamesRouter({
    db, queue, limits,
    makeLookupClient,
    sizeCap: config.games.sizeCap,
    refreshCooldownMs: config.games.refreshCooldownHours * 3600_000,
    recheckCooldownMs: config.games.recheckCooldownMinutes * 60_000,
    maxCreatesPerDay: config.games.maxCreatesPerDay,
    maxQueued: config.games.maxQueued,
    trustedProxyHops: config.trustedProxyHops,
  }));
  if (config.games.adminSecret) {
    app.use('/api/admin', createAdminRouter({ db, secret: config.games.adminSecret, makeLookupClient, trustedProxyHops: config.trustedProxyHops }));
    console.log('[games] admin tools are ON at /admin');
  }
  const sweeper = new GamesSweeper({
    db, queue, sweepIntervalMs: config.games.sweepDays * 86_400_000, reportRetentionMs: config.games.reportRetentionDays * 86_400_000,
    log: msg => console.log(msg),
  });
  queue.start();
  sweeper.start();
  console.log(`[games] saved games are ON (cap ${config.games.sizeCap} quotes, refresh every ${config.games.refreshCooldownHours} h)`);
  return { stop: async () => { sweeper.stop(); await queue.stop(); db.close(); } };
}
