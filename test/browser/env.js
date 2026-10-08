// Where the browser suites find Chromium. Set CHROME_PATH to override.
const fs = require('fs');
const candidates = [
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const CHROME = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
module.exports = { CHROME, BASE: 'http://localhost:3988' };
