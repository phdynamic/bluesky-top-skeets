/**
 * Content Security Policies for the Tracer page.
 *
 * SAVED pages show a stored copy of other people's posts. They must not call Bluesky or anyone else,
 * run only our own scripts, and load no images from anywhere, so the browser itself is told to refuse:
 * `connect-src 'self'` means even a bug could not send a request to Bluesky or a third party.
 *
 * LIVE pages keep working exactly as before (they talk to Bluesky and show its images), but may only run
 * our own scripts, which blocks an injected inline script from doing anything.
 */
export const SAVED_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const LIVE_CSP = ["script-src 'self'", "object-src 'none'", "base-uri 'none'"].join('; ');
