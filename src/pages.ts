import fs from 'fs';
import path from 'path';

const FILE = path.join(__dirname, '..', 'public', 'tracer.html');
let cached: { mtime: number; html: string } | null = null;

function template(): string {
  const mtime = fs.statSync(FILE).mtimeMs;
  if (!cached || cached.mtime !== mtime) cached = { mtime, html: fs.readFileSync(FILE, 'utf8') };
  return cached.html;
}

export interface TracerPageOptions {
  /** 'saved' for /g/... pages; 'live' for /tracer. */
  mode: 'live' | 'saved';
  /** Only for saved pages: the game id and version from the address (already validated, or empty). */
  gameId?: string;
  version?: number;
  /** Shows the Save button on the live page. */
  gamesEnabled?: boolean;
  sizeCap?: number;
}

/**
 * The Tracer page with a few facts the page cannot know for itself written onto <body> as attributes.
 * Everything here is either a fixed word or a value that was checked against a strict pattern first.
 */
export function renderTracerPage(o: TracerPageOptions): string {
  const attrs: string[] = [`data-mode="${o.mode}"`];
  if (o.mode === 'saved') {
    attrs.push(`data-game="${/^[a-z0-9]{10}$/.test(o.gameId ?? '') ? o.gameId : ''}"`);
    if (o.version && Number.isInteger(o.version) && o.version > 0 && o.version < 1_000_000) attrs.push(`data-version="${o.version}"`);
  } else if (o.gamesEnabled) {
    attrs.push('data-games="1"', `data-cap="${Math.max(1, Math.floor(o.sizeCap ?? 5000))}"`);
  }
  return template().replace('<body>', `<body ${attrs.join(' ')}>`);
}
