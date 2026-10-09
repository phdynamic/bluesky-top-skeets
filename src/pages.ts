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
  /** Saved pages: show the Remove my posts / I wrote the original post links. */
  signin?: boolean;
}

/**
 * The Tracer page with a few facts the page cannot know for itself written onto <body> as attributes.
 * Everything here is either a fixed word or a value that was checked against a strict pattern first.
 */
export function renderTracerPage(o: TracerPageOptions): string {
  const attrs: string[] = [`data-mode="${o.mode}"`];
  if (o.mode === 'saved') {
    attrs.push(`data-game="${/^[a-z0-9]{10}$/.test(o.gameId ?? '') ? o.gameId : ''}"`);
    if (o.signin) attrs.push('data-signin="1"');
    if (o.version && Number.isInteger(o.version) && o.version > 0 && o.version < 1_000_000) attrs.push(`data-version="${o.version}"`);
  } else if (o.gamesEnabled) {
    attrs.push('data-games="1"', `data-cap="${Math.max(1, Math.floor(o.sizeCap ?? 5000))}"`);
  }
  return template().replace('<body>', `<body ${attrs.join(' ')}>`);
}

const escapeHtml = (t: string) => t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** The "how saved games work" page, with the takedown address written in (escaped). */
export function renderAboutPage(takedownContact: string, signinEnabled = false, wipeSpacingHours = 1): string {
  const spacing = wipeSpacingHours >= 24 ? (wipeSpacingHours === 24 ? 'a day' : `${Math.round(wipeSpacingHours / 24)} days`) : wipeSpacingHours <= 1 ? 'an hour' : `${Math.round(wipeSpacingHours)} hours`;
  const file = path.join(__dirname, '..', 'public', 'g-about.html');
  const signin = signinEnabled
    ? 'You can also do it yourself: open <a href="/g/account">Remove my posts</a>, sign in with Bluesky (this only confirms which account is yours; it cannot post, follow or read anything), and choose one game or every game. Your posts are wiped from the game and you are kept out of future saves.'
    : 'Signing in with Bluesky to do this yourself is not available on this site yet.';
  return fs.readFileSync(file, 'utf8').split('{{TAKEDOWN_CONTACT}}').join(escapeHtml(takedownContact)).split('{{SIGNIN_SENTENCE}}').join(signin).split('{{WIPE_SPACING}}').join(spacing);
}
