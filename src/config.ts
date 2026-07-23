import 'dotenv/config';
import path from 'path';

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  feedgenHostname: required('FEEDGEN_HOSTNAME'),
  feedgenServiceDid: required('FEEDGEN_SERVICE_DID'),
  // DATABASE_PATH is a legacy var from the SQLite era — only its directory is used
  dataDir: process.env.DATA_DIR ?? path.dirname(process.env.DATABASE_PATH ?? './data/feeds.db'),
  refreshIntervalMinutes: parseInt(process.env.REFRESH_INTERVAL_MINUTES ?? '5', 10),
};
