import path from 'path';

// The same parser the browser pages use (public/kiosk-links.js), so the server and the
// Tracer / Skeet Receipt pages always agree on what counts as a post link.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const shared = require(path.join(__dirname, '..', 'public', 'kiosk-links.js')) as {
  parsePostLink(input: unknown): { id: string; rkey: string } | null;
};

export const parsePostLink = shared.parsePostLink;
