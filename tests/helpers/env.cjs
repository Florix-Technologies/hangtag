// Shared settings for the browser (e2e) and database test suites.
// Paths are relative to the repository. The browser: CHROME_PATH (or PUPPETEER_EXECUTABLE_PATH), else Chrome, Chromium or
// Edge where Windows, macOS or Linux install them (and Puppeteer's own download); null when there is none — the runner
// then reports the browser suites as skipped for the environment, not as failures of the app.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3210;                                   // the tests expect the app at http://localhost:3210/
const BASE_URL = `http://localhost:${PORT}`;
const ARTIFACTS = path.join(ROOT, 'tests', '.artifacts');   // screenshots (git-ignored)
const SCHEMA_PATH = path.join(ROOT, 'supabase', 'schema.sql');
fs.mkdirSync(ARTIFACTS, { recursive: true });

function browserCandidates() {
  const env = process.env, home = os.homedir();
  const downloaded = (dir) => { try { return fs.readdirSync(dir).flatMap((v) => fs.readdirSync(path.join(dir, v)).map((p) => path.join(dir, v, p))); } catch { return []; } };
  const puppeteer = downloaded(path.join(home, '.cache', 'puppeteer', 'chrome'))
    .map((d) => path.join(d, process.platform === 'win32' ? 'chrome.exe' : process.platform === 'darwin'
      ? 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' : 'chrome'));
  if (process.platform === 'win32') {
    const roots = [env.PROGRAMFILES || 'C:/Program Files', env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', env.LOCALAPPDATA].filter(Boolean);
    return [...roots.map((r) => path.join(r, 'Google/Chrome/Application/chrome.exe')), ...roots.map((r) => path.join(r, 'Microsoft/Edge/Application/msedge.exe')), ...puppeteer];
  }
  if (process.platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', ...puppeteer];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    '/opt/google/chrome/chrome', '/usr/bin/microsoft-edge', ...puppeteer];
}
// Chrome refuses to start as root without --no-sandbox (Linux containers): there, a two-line wrapper adds it
function rootSafe(exe) {
  if (process.platform !== 'linux' || !(process.getuid && process.getuid() === 0)) return exe;
  const wrapper = path.join(ARTIFACTS, 'chrome-no-sandbox.sh');
  try {
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${exe.replace(/"/g, '\\"')}" --no-sandbox "$@"\n`, { mode: 0o755 });
    fs.chmodSync(wrapper, 0o755);
    return wrapper;
  } catch { return exe; }
}
function findBrowser() {
  const set = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (set) return rootSafe(set);
  const found = browserCandidates().find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  return found ? rootSafe(found) : null;
}
const CHROME = findBrowser();
const NO_BROWSER = 'No Chrome, Chromium or Edge found: set CHROME_PATH to a Chromium-based browser (or run "npx puppeteer browsers install chrome").';

const indexHtml = () => fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// The page the tests load. It sets window.__HANGTAG_TEST__ before any app script runs, which makes
// the app install window.__ev(src): evaluate test code against the app's internals (see src/app/test-hook.js).
function hookedHtml() {
  let html = indexHtml().replace('<head>', '<head><script>window.__HANGTAG_TEST__=true</script>');
  // The hook evaluates test code (new Function): only the page served to tests lets its Content-Security-Policy allow that.
  // The live page keeps script-src without 'unsafe-eval' (the app itself never evaluates strings).
  html = html.replace(/(<meta http-equiv="Content-Security-Policy" content="[^"]*script-src [^;"]*)/, "$1 'unsafe-eval'");
  // Older single-file build: the whole app is one inline script, so the hook is injected into it.
  const inline = /<script>\s*\(function\(\)\{/.test(html);
  if (inline) {
    const at = html.lastIndexOf('})();');
    html = html.slice(0, at) + 'window.__ev=(src)=>eval(src);' + html.slice(at);
  }
  return html;
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

// A tiny static file server for the repository root on port 3210, on both loopback addresses
// (Chrome may resolve localhost to ::1 or 127.0.0.1). Reused if one is already running.
function ensureServer() {
  const handler = (req, res) => {
    const url = new URL(req.url, BASE_URL);
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  };
  const listen = (host) => new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.on('error', () => resolve(null));              // taken: assume a test server is already serving the repo
    srv.listen(PORT, host, () => { srv.unref(); resolve(srv); });
  });
  return Promise.all([listen('127.0.0.1'), listen('::1')]);
}

module.exports = { ROOT, PORT, BASE_URL, CHROME, NO_BROWSER, ARTIFACTS, SCHEMA_PATH, indexHtml, hookedHtml, ensureServer };
