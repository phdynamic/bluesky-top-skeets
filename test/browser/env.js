// Where the browser suites find a Chromium-based browser. Set CHROME_PATH to use a specific one.
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = os.homedir();
const pf = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);

// the newest browser Playwright itself may have downloaded (npx playwright install chromium)
function playwrightCache() {
  const roots = [path.join(home, 'Library', 'Caches', 'ms-playwright'), path.join(home, '.cache', 'ms-playwright'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'), process.env.PLAYWRIGHT_BROWSERS_PATH].filter(Boolean);
  const subs = [['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'], ['chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ['chrome-linux', 'chrome'], ['chrome-linux64', 'chrome'], ['chrome-win', 'chrome.exe'], ['chrome-win64', 'chrome.exe']];
  const out = [];
  for (const r of roots) {
    let dirs = []; try { dirs = fs.readdirSync(r).filter(d => /^chromium-/.test(d)).sort().reverse(); } catch { /* none */ }
    for (const d of dirs) for (const s of subs) out.push(path.join(r, d, ...s));
  }
  return out;
}

const candidates = [
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  path.join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
  // Linux
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/usr/bin/brave-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium',
  // Windows
  ...pf.flatMap(p => [path.join(p, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(p, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]),
  ...playwrightCache(),
].filter(Boolean);

const CHROME = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
module.exports = { CHROME, BASE: 'http://localhost:3988' };
