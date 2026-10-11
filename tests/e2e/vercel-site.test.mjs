// What Vercel serves: the files of dist/site (siteFiles in scripts/sw-cache.mjs) with vercel.json's headers, and nothing
// else. Every other browser suite loads the repository itself through a test page whose Content-Security-Policy is
// loosened for the test hook, so none of them could see a page that breaks under the real policy (an inline handler, eval,
// a new origin), a file the site leaves out, or a service worker that can't install. This serves exactly what Vercel would,
// with its headers, and opens the shop app, the receipt, order and store pages and the Platform Console in Chrome.
// Supabase is blocked: config.js names the live project, which a test must never reach.
// Run: node tests/e2e/vercel-site.test.mjs
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { siteFiles, toUrl } from '../../scripts/sw-cache.mjs';

if (!H.CHROME) { console.log('skipped: ' + H.NO_BROWSER); process.exit(77); }
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 900) : '')); };

const PORT = 3219, BASE = `http://127.0.0.1:${PORT}`;
const vercel = JSON.parse(readFileSync(path.join(H.ROOT, 'vercel.json'), 'utf8'));
const files = siteFiles(H.ROOT);
const SITE = new Map(files.map((f) => [toUrl(H.ROOT, f).slice(1), f]));   // "/src/app/main.js" → the file
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
// vercel.json's headers for a path (each "source" is a path pattern; ours is "/(.*)")
const headersFor = (p) => Object.fromEntries(vercel.headers.filter((h) => new RegExp('^' + h.source + '$').test(p)).flatMap((h) => h.headers.map((x) => [x.key, x.value])));
const served = [];
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, BASE).pathname);
  const file = SITE.get(p.endsWith('/') ? p + 'index.html' : p);   // like Vercel: a folder serves its index.html
  served.push({ p, status: file ? 200 : 404 });
  if (!file) { res.writeHead(404, headersFor(p)); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', ...headersFor(p) });
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

// the deploy itself
check(`the site is the app shell, sw.js and the maskable icon (${files.length} files)`, SITE.has('/index.html') && SITE.has('/sw.js') && SITE.has('/icon-maskable-512.png') && SITE.has('/config.js'));
const risky = files.map((f) => toUrl(H.ROOT, f).slice(2)).filter((u) => /(^|\/)\.|\.(sql|env|pem|key|map|mjs|cjs|test\.js)$|secret|node_modules|^(tests?|scripts|supabase|dist)\//i.test(u));
check('nothing in it that should never be published (dotfiles, SQL, keys, tests, supabase/, source maps)', !risky.length, risky);
const sw = readFileSync(path.join(H.ROOT, 'sw.js'), 'utf8');
const CACHE = (sw.match(/const CACHE = "([^"]+)"/) || [])[1];
const SHELL = JSON.parse((sw.match(/const SHELL = (\[[\s\S]*?\]);/) || [])[1] || '[]');
const unservable = SHELL.filter((u) => u !== './' && !SITE.has(u.slice(1)));
check(`every file the service worker saves for offline use is in the site (${SHELL.length} entries)`, SHELL.length > 100 && !unservable.length, unservable);

const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
async function open(pathname) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1100, height: 800 });
  const problems = [], requests = [];
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  // Supabase is blocked on purpose, so its failed requests are expected
  page.on('console', (m) => { const at = (m.location() && m.location().url) || ''; if (m.type() === 'error' && !/supabase\.co/.test(at + ' ' + m.text())) problems.push('console: ' + m.text() + (at ? ' @ ' + at : '')); });
  await page.evaluateOnNewDocument(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI || ''} ${e.sourceFile || ''}:${e.lineNumber || ''}`));
  });
  await page.setRequestInterception(true);
  page.on('request', (r) => { const u = r.url(); requests.push(u); if (/\.supabase\.co\b/.test(new URL(u).hostname)) return r.abort('blockedbyclient'); r.continue(); });
  const resp = await page.goto(BASE + pathname, { waitUntil: 'networkidle0', timeout: 60000 });
  return { ctx, page, problems, requests, resp, csp: () => page.evaluate(() => window.__csp) };
}

try {
  // the shop app
  const app = await open('/');
  const h = app.resp.headers();
  check('it is served with vercel.json\'s headers (Content-Security-Policy, X-Frame-Options, nosniff, HSTS)',
    h['content-security-policy'] === headersFor('/')['Content-Security-Policy'] && h['x-frame-options'] === 'DENY' && h['x-content-type-options'] === 'nosniff' && /max-age=/.test(h['strict-transport-security'] || ''), h);
  const gate = await app.page.waitForFunction(() => { const f = document.getElementById('authForms'); return f && !f.hidden; }, { timeout: 20000 }).then(() => true, () => false);
  check('the shop app starts and offers sign-in (Supabase unreachable, nobody signed in)', gate, await app.page.$eval('#authMsg', (e) => e.textContent).catch(() => null));
  // the app registers sw.js only over https (src/app/pwa.js), as Vercel serves it; here it is registered the same way by hand
  const reg = await app.page.evaluate(async () => {
    await navigator.serviceWorker.register('sw.js').catch(() => {});
    const r = await Promise.race([navigator.serviceWorker.ready, new Promise((res) => setTimeout(() => res(null), 30000))]);
    if (!r || !r.active) return null;
    for (let i = 0; i < 100 && r.active.state !== 'activated'; i++) await new Promise((res) => setTimeout(res, 100));
    const keys = await caches.keys(), mine = keys.find((k) => k.startsWith('hangtag-'));
    return { state: r.active.state, keys, saved: mine ? (await (await caches.open(mine)).keys()).length : 0 };
  });
  check(`the service worker installs and saves the whole app under the committed cache name (${CACHE})`,
    reg && reg.state === 'activated' && reg.keys.includes(CACHE) && reg.saved === SHELL.length, { reg, expected: SHELL.length });
  const loaded = new Set(app.requests.filter((u) => u.startsWith(BASE)).map((u) => new URL(u).pathname));
  const fields = ['/src/domain/catalog/attributes.js', '/src/features/products/components/shop-fields-settings.js', '/src/features/products/components/product-fields.js', '/src/features/products/use-cases/shop-fields.js'];
  check('the modules of the shop\'s own fields and units load from the site', fields.every((f) => loaded.has(f)), fields.filter((f) => !loaded.has(f)));
  check(`the app's own scripts and styles (${loaded.size} files) break no rule of the Content-Security-Policy`, !(await app.csp()).length, await app.csp());
  check('no page error or console error while it starts', !app.problems.length, app.problems);
  await app.ctx.close();

  // the public pages and the Platform Console
  for (const p of ['/receipt.html', '/order.html', '/store.html', '/platform/', '/platform/login/']) {
    const page = await open(p);
    const csp = await page.csp();
    check(`${p}: served (200) and breaks no rule of the Content-Security-Policy, with no page error`, page.resp.status() === 200 && !csp.length && !page.problems.filter((x) => x.startsWith('pageerror')).length,
      { status: page.resp.status(), csp, problems: page.problems });
    await page.ctx.close();
  }

  const missing = [...new Set(served.filter((s) => s.status === 404).map((s) => s.p))];
  check(`every file the pages asked for is in the site (${served.length} requests)`, !missing.length, missing);
} finally {
  await browser.close().catch(() => {});
  server.close();
}
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
