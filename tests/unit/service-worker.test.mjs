// The service worker's rules, run in Node against stand-ins for the browser's caches, network and windows (sw.js itself,
// unchanged): what it keeps for offline use, and how it retires itself on the old address. Since hangtag.vercel.app began
// redirecting to the custom domain, the worker browsers kept there followed the redirect for stylesheets and config.js,
// kept the opaque answers, and the page's Content-Security-Policy then blocked them on every visit (an unstyled app with a
// giant logo). Also checked: vercel.json lets the old address serve sw.js (a worker script can't be redirected) while
// sending everything else to the custom domain. tests/e2e/legacy-sw-retire.test.mjs runs the same in Chrome.
// Run: npm run test:unit
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { redirectFor } from '../helpers/vercel-routes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}

const SRC = readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const vercel = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const constant = (name) => JSON.parse((new RegExp(`const ${name} = ([^;]+);`).exec(SRC) || [])[1] || 'null');
const CACHE = constant('CACHE'), CANONICAL = constant('CANONICAL_ORIGIN'), RETIRED = constant('RETIRED_HOSTS');
const APP_HOST = new URL(CANONICAL).hostname, OLD_HOST = RETIRED[0];

// ---- the stand-ins: one worker loaded on a host, with its caches, network and open windows ----
const R = (type, { status = type === 'opaque' || type === 'opaqueredirect' ? 0 : 200, redirected = false, tag = '' } = {}) =>
  ({ type, status, ok: status >= 200 && status < 300, redirected, tag, clone() { return this; } });
const Q = (url, { mode = 'no-cors', destination = 'style', method = 'GET' } = {}) => ({ url, mode, destination, method });
const settle = () => new Promise((r) => setTimeout(r, 0));

function load(host, { caches: initial = {}, windows = [] } = {}) {
  const origin = `https://${host}`;
  const keyOf = (k) => (typeof k === 'string' ? new URL(k, origin + '/').href : k.url);
  const store = new Map(Object.entries(initial).map(([n, entries]) => [n, new Map(Object.entries(entries).map(([k, v]) => [keyOf(k), v]))]));
  const log = { order: [], put: [], deleted: [], addAll: null, skipWaiting: 0, navigated: [], matchAll: null };
  const cache = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name);
    return { match: async (k) => m.get(keyOf(k)), put: async (k, res) => { log.put.push(keyOf(k)); m.set(keyOf(k), res); },
      addAll: async (list) => { log.addAll = list; } };
  };
  const handlers = {};
  const sw = {
    network: () => Promise.reject(new TypeError('Failed to fetch')),
    log, store, handlers,
    entry: (k) => store.get(CACHE) && store.get(CACHE).get(keyOf(k)),
  };
  const self = {
    location: new URL(origin + '/sw.js'),
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: () => { log.skipWaiting++; },
    clients: {
      claim: async () => { log.order.push('claim'); },
      matchAll: async (opts) => { log.order.push('matchAll'); log.matchAll = opts; return windows.map((w) => ({ type: 'window', ...w,
        navigate: async (to) => { log.order.push('navigate'); log.navigated.push(to); if (w.fails) throw new TypeError('navigation refused'); return null; } })); },
    },
    registration: { unregister: async () => { log.order.push('unregister'); return true; } },
  };
  const caches = { open: async (n) => cache(n), keys: async () => [...store.keys()], delete: async (n) => { log.deleted.push(n); return store.delete(n); } };
  vm.runInContext(SRC, vm.createContext({ self, caches, fetch: (req) => sw.network(req), URL, console }), { filename: 'sw.js' });
  return sw;
}
async function lifecycle(sw, type) {
  let wait = null;
  const r = sw.handlers[type]({ waitUntil: (p) => { wait = p; } });
  await wait; await settle();
  return r;
}
/* a request through the worker: whether it answered, with what, once its background refresh has finished */
async function request(sw, req, network) {
  if (network) sw.network = typeof network === 'function' ? network : () => Promise.resolve(network);
  let answer = null;
  sw.handlers.fetch({ request: req, respondWith: (p) => { answer = p; } });
  const res = answer ? await answer : undefined;
  await settle(); await settle();
  return { handled: !!answer, res };
}

// ---- 1. the configuration: one canonical address, one old one, and vercel.json agreeing with sw.js ----
check('sw.js names the app\'s address and the old one, and never retires on the app\'s own address',
  CANONICAL === 'https://app.hangtag.florixtechnologies.com' && JSON.stringify(RETIRED) === '["hangtag.vercel.app"]' && !RETIRED.includes(APP_HOST), { CANONICAL, RETIRED });
check('vercel.json redirects nothing on the app\'s own address', ['/', '/sw.js', '/platform/login/', '/src/styles/00-base.css'].every((p) => redirectFor(vercel, APP_HOST, p) === null));
check('…nor on another vercel.app address (previews, deployment URLs)', redirectFor(vercel, 'hangtag-git-main-florix.vercel.app', '/') === null && redirectFor(vercel, 'xhangtag.vercel.app', '/') === null);
check('the old address serves /sw.js itself: no redirect (browsers refuse a redirected worker script)', redirectFor(vercel, OLD_HOST, '/sw.js') === null && redirectFor(vercel, OLD_HOST, '/sw.js?v=2') === null);
const moved = {
  '/': CANONICAL + '/',
  '/?code=abc&state=xyz': CANONICAL + '/?code=abc&state=xyz',
  '/platform/login/': CANONICAL + '/platform/login/',
  '/platform/?code=1': CANONICAL + '/platform/?code=1',
  '/receipt.html?id=r1': CANONICAL + '/receipt.html?id=r1',
  '/src/styles/00-base.css': CANONICAL + '/src/styles/00-base.css',
  '/config.js': CANONICAL + '/config.js',
  '/sw.jsx': CANONICAL + '/sw.jsx',
  '/sw.js/x': CANONICAL + '/sw.js/x',
  '/src/sw.js': CANONICAL + '/src/sw.js',
};
const got = Object.fromEntries(Object.keys(moved).map((p) => [p, redirectFor(vercel, OLD_HOST, p)]));
check('the old address sends every other path to the same path and query on the app\'s address, with a temporary 307',
  Object.entries(moved).every(([p, to]) => got[p] && got[p].status === 307 && got[p].location === to), got);
const crafted = redirectFor(vercel, OLD_HOST, '//elsewhere.example/x?y=1');
check('…and a crafted path ("//elsewhere.example/") stays a path on the app\'s address', crafted && new URL(crafted.location).origin === CANONICAL, crafted);

// ---- 2. the worker on the app's address: what it keeps ----
const page = (p) => `https://${APP_HOST}${p}`;
{
  const sw = load(APP_HOST, { caches: { 'hangtag-0000000000': {}, 'other-cache': {} } });
  await lifecycle(sw, 'install');
  check('installing saves the whole app shell and takes over at once', Array.isArray(sw.log.addAll) && sw.log.addAll.length > 100 && sw.log.addAll.includes('./config.js') && sw.log.skipWaiting === 1);
  await lifecycle(sw, 'activate');
  check('activating clears older caches and keeps working: no unregistering, no page moved',
    sw.log.deleted.includes('hangtag-0000000000') && !sw.log.order.includes('unregister') && !sw.log.navigated.length, sw.log);
}
{
  const sw = load(APP_HOST);
  const css = Q(page('/src/styles/00-base.css'));
  let r = await request(sw, css, R('basic', { tag: 'good css' }));
  check('a stylesheet from this site (200, plain) is kept', r.res.tag === 'good css' && sw.entry(css).tag === 'good css');
  r = await request(sw, css, R('opaque', { tag: 'followed a redirect to another site' }));
  check('an opaque answer (a redirect followed to another site) never replaces the kept stylesheet, which is what the page gets',
    r.res.tag === 'good css' && sw.entry(css).tag === 'good css', { served: r.res.tag, kept: sw.entry(css).tag });
  await request(sw, css, R('basic', { redirected: true, tag: 'redirected on this site' }));
  check('nor does a redirected answer from this site', sw.entry(css).tag === 'good css');
  await request(sw, css, R('basic', { status: 404, tag: 'not found' }));
  await request(sw, css, R('basic', { status: 500, tag: 'server error' }));
  check('nor a 404 or a 500', sw.entry(css).tag === 'good css');
  r = await request(sw, css, () => Promise.reject(new TypeError('Failed to fetch')));
  check('nor a failed request (offline, blocked): the kept copy is served', r.res.tag === 'good css' && sw.entry(css).tag === 'good css');
  await request(sw, css, R('basic', { tag: 'new build css' }));
  check('a new plain answer still refreshes it (the next build shows up)', sw.entry(css).tag === 'new build css');

  const config = Q(page('/config.js'), { destination: 'script' });
  r = await request(sw, config, R('opaque', { tag: 'opaque config' }));
  check('config.js: an opaque answer with nothing kept goes to the page as the network gave it, and is not kept',
    r.handled && r.res.tag === 'opaque config' && !sw.entry(config));
  await request(sw, config, R('basic', { tag: 'good config' }));
  await request(sw, config, R('basic', { redirected: true, tag: 'redirected config' }));
  await request(sw, config, () => Promise.reject(new TypeError('Failed to fetch')));
  check('config.js: kept when plain, then kept through a redirect and a failure', sw.entry(config).tag === 'good config');
}
{
  // a cache an older version filled (opaque answers for this site's files) is never served from
  const sw = load(APP_HOST, { caches: { [CACHE]: { [page('/src/styles/00-base.css')]: R('opaque', { tag: 'poisoned' }) } } });
  const css = Q(page('/src/styles/00-base.css'));
  const r = await request(sw, css, R('basic', { tag: 'fresh css' }));
  check('an opaque copy of this site\'s file already kept is not served: the fresh plain answer is, and replaces it',
    r.res.tag === 'fresh css' && sw.entry(css).tag === 'fresh css', { served: r.res.tag, kept: sw.entry(css).tag });
}
{
  const sw = load(APP_HOST);
  const nav = (p) => Q(page(p), { mode: 'navigate', destination: 'document' });
  await request(sw, nav('/?code=abc123'), R('basic', { tag: 'index' }));
  check('a sign-in return (/?code=…) is kept under the page\'s address without the query', !!sw.entry(page('/')) && !sw.log.put.some((k) => k.includes('code=')), sw.log.put);
  await request(sw, nav('/'), R('opaqueredirect', { tag: 'redirect' }));
  check('a page that answers with a redirect doesn\'t replace the kept page', sw.entry(page('/')).tag === 'index');
  sw.store.get(CACHE).set(page('/index.html'), R('basic', { tag: 'index.html' }));
  const off = await request(sw, nav('/platform/'), () => Promise.reject(new TypeError('Failed to fetch')));
  check('offline, a page not kept yet opens the saved app (index.html)', off.res && off.res.tag === 'index.html');
  const post = await request(sw, Q(page('/x'), { method: 'POST' }), R('basic'));
  check('a POST goes to the network untouched', !post.handled);
}
{
  const sw = load(APP_HOST);
  const lib = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js';
  let r = await request(sw, Q(lib, { mode: 'cors', destination: 'script' }), R('cors', { tag: 'library' }));
  check('the Supabase library (a CORS script from jsdelivr) is kept for offline use', r.handled && sw.entry(lib).tag === 'library');
  await request(sw, Q(lib, { mode: 'cors', destination: 'script' }), R('cors', { status: 503, tag: 'cdn down' }));
  check('…and a failed answer from the CDN doesn\'t replace it', sw.entry(lib).tag === 'library');
  r = await request(sw, Q('https://cdn.jsdelivr.net/npm/other@1/x.js', { mode: 'cors', destination: '' }), R('cors'));
  check('jsdelivr for anything but a script (a fetch()) goes to the network untouched', !r.handled);
  const opaqueLib = 'https://cdn.jsdelivr.net/npm/x@1/y.js';
  r = await request(sw, Q(opaqueLib, { destination: 'script' }), R('opaque'));
  check('a script from jsdelivr without CORS (opaque) goes to the network untouched: the library is always loaded with CORS', !r.handled && !sw.entry(opaqueLib));
  const fontsCss = 'https://fonts.googleapis.com/css2?family=Instrument+Sans';
  await request(sw, Q(fontsCss, { destination: 'style' }), R('opaque', { tag: 'fonts css' }));
  check('Google Fonts\' stylesheet (opaque: a plain stylesheet link) is kept when nothing is kept yet', sw.entry(fontsCss).tag === 'fonts css');
  await request(sw, Q(fontsCss, { destination: 'style' }), R('opaque', { tag: 'unknown opaque answer' }));
  check('…but a later opaque answer (its status can\'t be read) never replaces it', sw.entry(fontsCss).tag === 'fonts css');
  const font = 'https://fonts.gstatic.com/s/instrumentsans/v1/a.woff2';
  await request(sw, Q(font, { mode: 'cors', destination: 'font' }), R('cors', { tag: 'font' }));
  await request(sw, Q(font, { mode: 'cors', destination: 'font' }), R('cors', { redirected: true, tag: 'redirected font' }));
  check('a font file (CORS) is kept, and a redirected answer doesn\'t replace it', sw.entry(font).tag === 'font');
  r = await request(sw, Q('https://fonts.gstatic.com/s/x.css', { destination: 'style' }), R('opaque'));
  const r1 = await request(sw, Q(fontsCss, { mode: 'cors', destination: '' }), R('cors'));
  check('a static host asked for another kind of file, or in another mode, goes to the network untouched', !r.handled && !r1.handled);
  r = await request(sw, Q('https://wcorlmgkwcahyfastjoz.supabase.co/rest/v1/x', { mode: 'cors', destination: '' }), R('cors'));
  const r2 = await request(sw, Q('https://elsewhere.example/a.css'), R('opaque'));
  check('Supabase and every other site go to the network untouched (never kept)', !r.handled && !r2.handled);
}

// ---- 3. the same worker on the old address: it retires itself ----
{
  const sw = load(OLD_HOST);
  await lifecycle(sw, 'install');
  check('on the old address, installing saves nothing (every file there redirects) and takes over at once', sw.log.addAll === null && sw.log.skipWaiting === 1, sw.log.addAll && sw.log.addAll.length);
  const r = await request(sw, Q(`https://${OLD_HOST}/src/styles/00-base.css`), R('basic'));
  const n = await request(sw, Q(`https://${OLD_HOST}/`, { mode: 'navigate', destination: 'document' }), R('basic'));
  check('…and answers nothing itself: every request goes to the network (which redirects to the app\'s address)', !r.handled && !n.handled);
}
{
  const windows = [
    { url: `https://${OLD_HOST}/?code=abc&state=xyz#top` },
    { url: `https://${OLD_HOST}/platform/login/` },
    { url: `https://${OLD_HOST}/receipt.html?id=r1`, fails: true },
    { url: `https://${OLD_HOST}//elsewhere.example/steal?x=1` },
  ];
  const sw = load(OLD_HOST, { windows, caches: { 'hangtag-db09103bf2': { '/': R('basic') }, 'hangtag-v3': {}, 'other-app-cache': {}, 'workbox-precache-v2': {} } });
  await lifecycle(sw, 'activate');
  check('retiring deletes every Hangtag cache (all versions are named hangtag-…)', ['hangtag-db09103bf2', 'hangtag-v3'].every((n) => sw.log.deleted.includes(n)) && ![...sw.store.keys()].some((n) => n.startsWith('hangtag-')), sw.log.deleted);
  check('…and no other cache on the address', sw.store.has('other-app-cache') && sw.store.has('workbox-precache-v2') && sw.log.deleted.length === 2, sw.log.deleted);
  check('it takes over the open pages, then unregisters itself', sw.log.order.indexOf('claim') < sw.log.order.indexOf('matchAll') && sw.log.order.indexOf('matchAll') < sw.log.order.indexOf('unregister')
    && sw.log.order.filter((s) => s === 'unregister').length === 1 && sw.log.matchAll && sw.log.matchAll.type === 'window', sw.log.order);
  check('…and moves each open page to the same path, query and #part on the app\'s address',
    JSON.stringify(sw.log.navigated.slice(0, 3)) === JSON.stringify([CANONICAL + '/?code=abc&state=xyz#top', CANONICAL + '/platform/login/', CANONICAL + '/receipt.html?id=r1']), sw.log.navigated);
  check('a crafted path ("//elsewhere.example/") stays on the app\'s address', sw.log.navigated[3] && new URL(sw.log.navigated[3]).origin === CANONICAL, sw.log.navigated[3]);
  check('no page is sent to the old address again (no redirect loop), and one page refusing doesn\'t stop the others',
    sw.log.navigated.length === 4 && sw.log.navigated.every((u) => !RETIRED.includes(new URL(u).hostname)), sw.log.navigated);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
