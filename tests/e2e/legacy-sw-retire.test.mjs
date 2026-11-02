// The move from hangtag.vercel.app to the custom domain, in Chrome, with two addresses on this computer: OLD
// (http://127.0.0.1:…, playing hangtag.vercel.app) and APP (http://localhost:…, playing app.hangtag.florixtechnologies.com).
// Both serve the deployed site (dist/site's files) with vercel.json's headers; config.js is an empty one (no Supabase).
//   1. The redirect that broke the app: a browser that installed the deployed worker on OLD, once OLD redirects everything,
//      shows the app unstyled from the second visit on (the worker kept opaque answers that the page's
//      Content-Security-Policy blocks). The new worker, in the same place, stays styled visit after visit.
//   2. The retirement: OLD as vercel.json now has it (every path redirected but /sw.js). A browser with the deployed worker
//      and a poisoned cache opens OLD/?code=…: it picks up the new sw.js, which deletes Hangtag's caches there (only
//      those), unregisters, and moves the page to the same path and query on APP, styled. APP's own worker stays, and
//      works offline.
// sw.js is served as committed, except its two addresses, set to these two (checked to be the only change).
// Run: node tests/run.mjs tests/e2e/legacy-sw-retire.test.mjs
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { siteFiles, toUrl } from '../../scripts/sw-cache.mjs';
import { redirectFor } from '../helpers/vercel-routes.mjs';

const iso = createRequire(import.meta.url)('../helpers/isolation.cjs');
if (!H.CHROME) { console.log('skipped: ' + H.NO_BROWSER); process.exit(77); }
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 900) : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vercel = JSON.parse(readFileSync(path.join(H.ROOT, 'vercel.json'), 'utf8'));
const SITE = new Map(siteFiles(H.ROOT).map((f) => [toUrl(H.ROOT, f).slice(1), f]));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const headersFor = (p) => Object.fromEntries(vercel.headers.filter((h) => new RegExp('^' + h.source + '$').test(p)).flatMap((h) => h.headers.map((x) => [x.key, x.value])));
const SW = readFileSync(path.join(H.ROOT, 'sw.js'), 'utf8');
const DEPLOYED_SW = readFileSync(path.join(H.ROOT, 'tests', 'fixtures', 'sw-before-retirement.js'), 'utf8');
const APP_LINE = 'const CANONICAL_ORIGIN = "https://app.hangtag.florixtechnologies.com";', OLD_LINE = 'const RETIRED_HOSTS = ["hangtag.vercel.app"];';
const OLD_HOST = 'hangtag.vercel.app', APP_ORIGIN = 'https://app.hangtag.florixtechnologies.com';
// the stylesheets index.html links from the site itself (Google Fonts' is the one other)
const OWN_SHEETS = [...H.indexHtml().matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]).filter((h) => !/^https?:/.test(h)).length;

/* one address on this computer; what it serves is switched by the test (mode), and /__probe is a blank page on it */
function site(name) {
  const s = { mode: 'app', worker: SW, offline: false, other: '', base: '' };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), p = u.pathname;
    if (s.offline) return req.socket.destroy();
    if (p === '/__probe') { res.writeHead(200, { 'Content-Type': TYPES['.html'] }); return res.end('<!doctype html><title>probe</title>'); }
    if (s.mode === 'redirect-all') { res.writeHead(307, { Location: s.other + p + u.search }); return res.end(); }
    if (s.mode === 'vercel') {
      const r = redirectFor(vercel, OLD_HOST, p + u.search);
      if (r) { res.writeHead(r.status, { Location: r.location.replace(APP_ORIGIN, s.other) }); return res.end(); }
    }
    if (p === '/config.js') { res.writeHead(200, { ...headersFor(p), 'Content-Type': TYPES['.js'] }); return res.end('window.HANGTAG_CONFIG = {};\n'); }
    if (p === '/sw.js') { res.writeHead(200, { ...headersFor(p), 'Content-Type': TYPES['.js'] }); return res.end(s.worker); }
    const file = SITE.get(p.endsWith('/') ? p + 'index.html' : p);
    if (!file) { res.writeHead(404, headersFor(p)); return res.end('Not found'); }
    res.writeHead(200, { ...headersFor(p), 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  // both listen on 127.0.0.1; Chrome reaches APP as localhost, another origin (and host name) than OLD
  s.ready = new Promise((resolve) => server.listen(0, '127.0.0.1', () => { s.base = `http://${name}:${server.address().port}`; resolve(); }));
  s.close = () => { server.closeAllConnections && server.closeAllConnections(); server.close(); };
  return s;
}
const OLD = site('127.0.0.1'), APP = site('localhost');
await Promise.all([OLD.ready, APP.ready]);
OLD.other = APP.base;
// the committed sw.js with its two addresses set to these two; nothing else differs
const NEW_SW = SW.replace(APP_LINE, `const CANONICAL_ORIGIN = "${APP.base}";`).replace(OLD_LINE, 'const RETIRED_HOSTS = ["127.0.0.1"];');
check('sw.js served here is the committed one with only its two addresses changed',
  SW.split(APP_LINE).length === 2 && SW.split(OLD_LINE).length === 2 && NEW_SW.length - SW.length === APP.base.length - APP_ORIGIN.length + '127.0.0.1'.length - OLD_HOST.length);

/* how the page looks: its stylesheets, the sign-in logo's width as styled (44px; without CSS it fills the screen; the card
   itself is hidden here, with no Supabase), the hidden heading */
const look = () => {
  const logo = document.querySelector('.authcard .logo'), sr = document.querySelector('h2.sr');
  const own = [...document.styleSheets].filter((s) => s.href && new URL(s.href).origin === location.origin);
  const applied = own.filter((s) => { try { return s.cssRules.length > 0; } catch { return false; } }).length;
  return { url: location.href, applied, logo: logo ? getComputedStyle(logo).width : null, srHidden: sr ? sr.getBoundingClientRect().width <= 1 : null,
    controller: navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null, csp: window.__csp || [] };
};
const styled = (l) => l && l.applied === OWN_SHEETS && l.logo === '44px' && l.srHidden === true && !l.csp.length;
/* every entry the page's origin has cached, with its type: a same-origin one must be a plain ("basic") answer */
const cacheState = () => (async () => {
  const out = { names: await caches.keys(), bad: [], entries: 0, css: 0 };
  for (const n of out.names) {
    const c = await caches.open(n);
    for (const q of await c.keys()) {
      const r = await c.match(q); out.entries++;
      if (/\.css$/.test(new URL(q.url).pathname)) out.css++;
      if (new URL(q.url).origin === location.origin && (r.type !== 'basic' || r.redirected)) out.bad.push(`${new URL(q.url).pathname} ${r.type}`);
    }
  }
  return out;
})();

const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
async function newPage(ctx) {
  const page = iso.noBackend(await ctx.newPage());   // no request interception: it would bypass the worker
  await page.setViewport({ width: 1100, height: 800 });
  await page.evaluateOnNewDocument(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI || ''}`));
  });
  return page;
}
async function settled(page) {
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
  await sleep(1200);   // the worker's background refresh
}
/* install the worker on the page's address and wait until it controls the page and has kept every stylesheet */
async function install(page, base) {
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.evaluate(async () => { await navigator.serviceWorker.register('sw.js'); await navigator.serviceWorker.ready; });
  await page.reload({ waitUntil: 'load' });
  for (let i = 0; i < 50 && (await page.evaluate(cacheState)).css < OWN_SHEETS; i++) await sleep(200);
  await settled(page);
}
async function visit(page, url) { await page.goto(url, { waitUntil: 'load' }); await settled(page); return page.evaluate(look); }

try {
  // ---- 1. a worker on an address that starts redirecting everything (as hangtag.vercel.app did) ----
  for (const [label, worker] of [['the deployed worker', DEPLOYED_SW], ['the new worker', SW]]) {
    const ctx = await browser.createBrowserContext();
    const page = await newPage(ctx);
    OLD.mode = 'app'; OLD.worker = worker;
    await install(page, OLD.base);
    const before = await page.evaluate(look);
    OLD.mode = 'redirect-all';
    const visits = [];
    for (let i = 1; i <= 3; i++) visits.push(await visit(page, `${OLD.base}/?code=visit-${i}`));
    const cache = await page.evaluate(cacheState);
    if (worker === DEPLOYED_SW) {
      check(`${label}: styled before the redirect, unstyled from the second visit after it (the bug, reproduced)`,
        styled(before) && styled(visits[0]) && !styled(visits[1]) && visits[1].applied === 0 && visits[1].csp.some((c) => /^style-src/.test(c)), { before, visits });
      check(`${label}: its cache holds opaque answers for the site's own stylesheets and config.js`, cache.bad.some((b) => /\.css opaque$/.test(b)) && cache.bad.some((b) => /config\.js opaque$/.test(b)), cache.bad.slice(0, 5));
    } else {
      check(`${label}: styled before the redirect and on every visit after it (3 visits, no CSP violation)`,
        styled(before) && visits.every(styled), { before, visits });
      check(`${label}: nothing it kept for the site is opaque or redirected`, cache.entries > 100 && !cache.bad.length, { entries: cache.entries, bad: cache.bad.slice(0, 5) });
    }
    await ctx.close();
  }

  // ---- 2. the retirement ----
  const ctx = await browser.createBrowserContext();
  OLD.mode = 'app'; OLD.worker = DEPLOYED_SW; APP.mode = 'app'; APP.worker = NEW_SW;
  // the app's own address has its worker (the new one) and its cache
  const app = await newPage(ctx);
  await install(app, APP.base);
  const appBefore = await app.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return { active: !!(r && r.active), script: r && r.active && r.active.scriptURL, caches: await caches.keys() }; });
  // a browser that used the old address: the deployed worker, the shop's data, another app's cache there
  const page = await newPage(ctx);
  await install(page, OLD.base);
  await page.evaluate(async () => { localStorage.setItem('hangtag-keep-me', 'shop data'); await (await caches.open('not-hangtag')).put('/x', new Response('x')); });
  // today: everything on the old address redirects, /sw.js too; the cache gets poisoned
  OLD.mode = 'redirect-all';
  await visit(page, `${OLD.base}/?code=a`);
  const today = await visit(page, `${OLD.base}/?code=b`);
  check('before the fix: the old address shows the app unstyled (as reported)', !styled(today) && today.applied === 0, today);

  // after the deploy and the domain change: vercel.json's rule
  OLD.mode = 'vercel'; OLD.worker = NEW_SW;
  const raw = (p) => new Promise((resolve) => http.get(OLD.base + p, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, type: r.headers['content-type'], location: r.headers.location, body: b })); }));
  const swGet = await raw('/sw.js'), rootGet = await raw('/?code=x&state=y'), cssGet = await raw('/src/styles/00-base.css');
  check('the old address serves /sw.js itself (200, JavaScript, no redirect): the new worker',
    swGet.status === 200 && /javascript/.test(swGet.type) && !swGet.location && swGet.body === NEW_SW, { status: swGet.status, type: swGet.type, location: swGet.location });
  check('…and redirects every other path to the same path and query on the app\'s address (307)',
    rootGet.status === 307 && rootGet.location === APP.base + '/?code=x&state=y' && cssGet.status === 307 && cssGet.location === APP.base + '/src/styles/00-base.css', { rootGet, cssGet });

  const navigations = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations.push(f.url()); });
  const t0 = Date.now();
  // the page the deployed worker kept (/), as a sign-in return: it answers from its cache, then the new worker moves the page
  await page.goto(`${OLD.base}/?code=lab-code&state=s1#part`, { waitUntil: 'load' }).catch(() => {});
  while (Date.now() - t0 < 30000 && !page.url().startsWith(APP.base)) await sleep(200);
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  check(`the page on the old address moves to the same path, query and #part on the app's address (${seconds} s)`,
    page.url() === `${APP.base}/?code=lab-code&state=s1#part`, { url: page.url(), navigations });
  await settled(page);
  const settledAt = navigations.length;
  await sleep(3000);
  check('…once: no further reloads or redirects (no loop)', navigations.length === settledAt && navigations.filter((u) => u.startsWith(APP.base)).length === 1, navigations);

  await page.goto(`${OLD.base}/?code=again`, { waitUntil: 'load' });
  const landed = await page.evaluate(look);
  check('opening the old address again goes straight to the app\'s address, styled, under the app\'s own worker',
    landed.url === `${APP.base}/?code=again` && styled(landed) && landed.controller === APP.base + '/sw.js', landed);

  const probe = await newPage(ctx);
  await probe.goto(OLD.base + '/__probe', { waitUntil: 'load' });
  const oldState = await probe.evaluate(async () => ({ registrations: (await navigator.serviceWorker.getRegistrations()).length, caches: await caches.keys(), kept: localStorage.getItem('hangtag-keep-me') }));
  check('on the old address: no service worker is registered any more', oldState.registrations === 0, oldState);
  check('…every Hangtag cache is gone, and the other cache and the shop\'s data (localStorage) are still there',
    !oldState.caches.some((n) => n.startsWith('hangtag-')) && oldState.caches.includes('not-hangtag') && oldState.kept === 'shop data', oldState);
  await probe.close();

  const appAfter = await app.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return { active: !!(r && r.active), script: r && r.active && r.active.scriptURL, caches: await caches.keys() }; });
  check('the app\'s own worker is untouched: still active, same cache', appBefore.active && appAfter.active && appAfter.script === appBefore.script
    && JSON.stringify(appAfter.caches) === JSON.stringify(appBefore.caches) && appAfter.caches.length === 1, { appBefore, appAfter });

  // offline on the app's address: the kept app still opens, styled
  APP.offline = true;
  const offline = await visit(app, `${APP.base}/?code=offline`);
  check('offline, the app\'s address still opens the app from its worker, styled', styled(offline) && offline.controller === APP.base + '/sw.js', offline);
  APP.offline = false;
  const cleanApp = await app.evaluate(cacheState);
  check('…and nothing the app\'s worker kept is opaque or redirected', cleanApp.entries > 100 && !cleanApp.bad.length, cleanApp.bad.slice(0, 5));
  await ctx.close();
} finally {
  await browser.close().catch(() => {});
  OLD.close(); APP.close();
}
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
