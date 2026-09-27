// Shared settings for the browser (e2e) and database test suites.
// Paths are relative to the repository; Chrome can be overridden with CHROME_PATH.
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3210;                                   // the tests expect the app at http://localhost:3210/
const BASE_URL = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ARTIFACTS = path.join(ROOT, 'tests', '.artifacts');   // screenshots (git-ignored)
const SCHEMA_PATH = path.join(ROOT, 'supabase', 'schema.sql');
fs.mkdirSync(ARTIFACTS, { recursive: true });

const indexHtml = () => fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// The page the tests load. It sets window.__HANGTAG_TEST__ before any app script runs, which makes
// the app install window.__ev(src): evaluate test code against the app's internals (see src/app/test-hook.js).
function hookedHtml() {
  let html = indexHtml().replace('<head>', '<head><script>window.__HANGTAG_TEST__=true</script>');
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

module.exports = { ROOT, PORT, BASE_URL, CHROME, ARTIFACTS, SCHEMA_PATH, indexHtml, hookedHtml, ensureServer };
