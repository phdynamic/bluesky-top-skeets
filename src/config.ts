import 'dotenv/config';

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  feedgenHostname: required('FEEDGEN_HOSTNAME'),
  feedgenServiceDid: required('FEEDGEN_SERVICE_DID'),
  feedShortName: process.env.FEED_SHORT_NAME ?? 'top-skeets',
  feedDisplayName: process.env.FEED_DISPLAY_NAME ?? 'Top Skeets',
  feedDescription: process.env.FEED_DESCRIPTION ?? 'My posts, ranked by likes.',
  databasePath: process.env.DATABASE_PATH ?? './data/feeds.db',
  refreshIntervalMinutes: parseInt(process.env.REFRESH_INTERVAL_MINUTES ?? '15', 10),
};
