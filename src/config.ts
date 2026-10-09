import 'dotenv/config';
import path from 'path';

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function numEnv(name: string, def: number, min: number): number {
  const v = parseFloat(process.env[name] ?? '');
  return Number.isFinite(v) && v >= min ? v : def;
}
function intEnv(name: string, def: number, min: number): number {
  return Math.floor(numEnv(name, def, min));
}

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  feedgenHostname: required('FEEDGEN_HOSTNAME'),
  feedgenServiceDid: required('FEEDGEN_SERVICE_DID'),
  // DATABASE_PATH is a legacy var from the SQLite era — only its directory is used
  dataDir: process.env.DATA_DIR ?? path.dirname(process.env.DATABASE_PATH ?? './data/feeds.db'),
  refreshIntervalMinutes: parseInt(process.env.REFRESH_INTERVAL_MINUTES ?? '5', 10),
  // Public AppView used for every read; swap in a community AppView without touching code.
  appviewUrl: (process.env.APPVIEW_URL ?? 'https://public.api.bsky.app').replace(/\/+$/, ''),
  // How many reverse proxies sit in front of this server (used to read X-Forwarded-For safely).
  trustedProxyHops: Math.max(0, parseInt(process.env.TRUSTED_PROXY_HOPS ?? '1', 10) || 0),
  userAgent: 'ProfessorKiosk/1.0 (+https://professorkiosk.wtf; feed generator and quote tools)',
};
