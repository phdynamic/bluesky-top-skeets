// Runs every browser suite against a static copy of public/ and fails on any FAIL line,
// any JS error line, or a non-zero exit. Usage: npm run test:browser   (set CHROME_PATH if needed)
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const http = require('http');
const { CHROME } = require('./env');

if (!CHROME) { console.error('No Chromium found. Set CHROME_PATH to a Chrome/Chromium executable.'); process.exit(2); }
const only = process.argv.slice(2);
const SUITES = ['tracer', 'viewer', 'saved', 'receipt', 'feeds', 'footer'].filter(n => !only.length || only.includes(n));

function waitForServer(tries = 40) {
  return new Promise((resolve, reject) => {
    const ping = n => http.get('http://localhost:3988/', res => { res.resume(); resolve(); }).on('error', () => n > 0 ? setTimeout(() => ping(n - 1), 100) : reject(new Error('static server did not start')));
    ping(tries);
  });
}
function runSuite(name) {
  return new Promise(resolve => {
    const file = path.join(__dirname, name + '.suite.js');
    const child = spawn('node', [file], { cwd: os.tmpdir(), env: { ...process.env, CHROME_PATH: CHROME } });
    let out = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ name, code, out }));
  });
}
(async () => {
  const server = spawn('node', [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: '3988' }, stdio: 'ignore' });
  let failed = 0;
  try {
    await waitForServer();
    for (const name of SUITES) {
      const r = await runSuite(name);
      const lines = r.out.split('\n');
      const bad = lines.filter(l => /^FAIL/.test(l) || /JS errors:/.test(l) && !/JS errors: none/.test(l) || /^errors:/.test(l) && !/^errors: none/.test(l));
      const passes = lines.filter(l => /^PASS/.test(l)).length;
      const ok = r.code === 0 && bad.length === 0;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (${passes} checks passed${bad.length ? ', ' + bad.length + ' problem(s)' : ''})`);
      if (!ok) { failed++; console.log(bad.join('\n') || r.out.slice(-1500)); }
    }
  } finally { server.kill(); }
  process.exit(failed ? 1 : 0);
})();
