// Where a sign-in sends the browser back to, from the app's real address. Supabase returns the browser to the redirect_to
// the app asks for only if it is on the project's allow-list, otherwise to its Site URL (which still named
// hangtag.vercel.app: sign-ins from the custom domain came back there). The app must ask for the address it is on.
// Chrome opens the deployed pages (dist/site's files, vercel.json's headers) at https://app.hangtag.florixtechnologies.com
// itself, every request answered by this test (nothing reaches that host or Supabase), and the real Supabase library builds
// the requests; what they carry as redirect_to is checked: Google and Microsoft from the shop app, the password-reset email,
// and Google from the Platform Console's sign-in page. config.js names a stand-in project, never the live one.
// Run: node tests/run.mjs tests/e2e/oauth-redirect-origin.test.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { siteFiles, toUrl } from '../../scripts/sw-cache.mjs';

if (!H.CHROME) { console.log('skipped: ' + H.NO_BROWSER); process.exit(77); }
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 900) : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const APP = 'https://app.hangtag.florixtechnologies.com', OLD = 'https://hangtag.vercel.app';
const PROJECT = 'https://oauth-origin-test.supabase.co';   // a stand-in: every request to it is answered here
const vercel = JSON.parse(readFileSync(path.join(H.ROOT, 'vercel.json'), 'utf8'));
const SITE = new Map(siteFiles(H.ROOT).map((f) => [toUrl(H.ROOT, f).slice(1), f]));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const headersFor = (p) => Object.fromEntries(vercel.headers.filter((h) => new RegExp('^' + h.source + '$').test(p)).flatMap((h) => h.headers.map((x) => [x.key, x.value])));
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };

const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
/* a fresh browser profile with the site served at APP and OLD, and the stand-in project; returns what reached the project */
async function open(url) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1100, height: 800 });
  const sent = [], problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  // the app registers its worker on https; its script request wouldn't come through this test's handler
  await page.evaluateOnNewDocument(() => { ServiceWorkerContainer.prototype.register = () => Promise.reject(new Error('no service worker in this test')); });
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.origin === PROJECT) {
      sent.push({ method: r.method(), path: u.pathname, params: Object.fromEntries(u.searchParams), navigation: r.isNavigationRequest() });
      if (r.method() === 'OPTIONS') return r.respond({ status: 204, headers: CORS });
      if (u.pathname === '/auth/v1/settings') return r.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ external: { google: true, azure: true, email: true } }) });
      if (u.pathname === '/auth/v1/recover') return r.respond({ status: 200, contentType: 'application/json', headers: CORS, body: '{}' });
      if (u.pathname === '/auth/v1/authorize') return r.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><title>provider</title>' });
      return r.abort('blockedbyclient');
    }
    if (u.origin === APP || u.origin === OLD) {
      const p = u.pathname;
      if (p === '/config.js') return r.respond({ status: 200, contentType: TYPES['.js'], headers: headersFor(p), body: `window.HANGTAG_CONFIG = { SUPABASE_URL: "${PROJECT}", SUPABASE_ANON_KEY: "sb_publishable_test" };\n` });
      const file = SITE.get(p.endsWith('/') ? p + 'index.html' : p);
      if (!file) return r.respond({ status: 404, headers: headersFor(p), body: 'Not found' });
      return r.respond({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', headers: headersFor(p), body: readFileSync(file) });
    }
    if (['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(u.hostname)) return r.continue();
    return r.abort('blockedbyclient');
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { ctx, page, sent, problems };
}
const until = async (page, fn, ms = 20000) => page.waitForFunction(fn, { timeout: ms }).then(() => true, () => false);
const authorize = async (sent) => { for (let i = 0; i < 50 && !sent.some((s) => s.path === '/auth/v1/authorize'); i++) await sleep(100); return sent.find((s) => s.path === '/auth/v1/authorize'); };
const shown = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && !e.disabled && e.getClientRects().length > 0; })()`;

try {
  // ---- the shop app on its own address ----
  let t = await open(APP + '/');
  check('the shop app at the custom domain offers Continue with Google', await until(t.page, shown('[data-provider="google"]')), t.problems);
  await t.page.click('[data-provider="google"]');
  let a = await authorize(t.sent);
  check('Google sign-in asks Supabase to come back to https://app.hangtag.florixtechnologies.com/', a && a.navigation && a.params.provider === 'google' && a.params.redirect_to === APP + '/', a);
  // the page is at the provider now: back on the custom domain, a blank page (404) reads its storage
  await t.page.goto(APP + '/__blank', { waitUntil: 'domcontentloaded' });
  const verifier = await t.page.evaluate(() => Object.keys(localStorage).some((k) => /code-verifier$/.test(k)));
  check('…with a PKCE challenge, its verifier kept on the custom domain (where the browser comes back)',
    a && a.params.code_challenge && /^s256$/i.test(a.params.code_challenge_method || '') && verifier, { params: a && a.params, verifier });
  await t.ctx.close();

  t = await open(APP + '/');
  const ms = await until(t.page, shown('[data-provider="azure"]'));
  if (ms) {
    await t.page.click('[data-provider="azure"]');
    a = await authorize(t.sent);
    check('Microsoft sign-in comes back to the custom domain too', a && a.params.provider === 'azure' && a.params.redirect_to === APP + '/', a);
  } else check('the Microsoft button is offered when the project has it switched on', false, await t.page.$$eval('[data-provider]', (b) => b.map((x) => x.dataset.provider)));
  await t.ctx.close();

  t = await open(APP + '/?ref=poster&utm_source=x');
  await until(t.page, shown('[data-provider="google"]'));
  await t.page.click('[data-provider="google"]');
  a = await authorize(t.sent);
  check('opened with a query (?ref=…), it still asks for the page\'s address without the query', a && a.params.redirect_to === APP + '/', a);
  await t.ctx.close();

  t = await open(APP + '/');
  await until(t.page, shown('#forgotBtn'));
  await t.page.click('#forgotBtn');
  await t.page.type('#authEmail', 'owner@example.com');
  await t.page.click('#emailSubmit');
  for (let i = 0; i < 50 && !t.sent.some((s) => s.path === '/auth/v1/recover' && s.method === 'POST'); i++) await sleep(100);
  const reset = t.sent.find((s) => s.path === '/auth/v1/recover' && s.method === 'POST');
  check('the password-reset email links back to the custom domain', reset && reset.params.redirect_to === APP + '/', reset || t.sent);
  await t.ctx.close();

  // ---- the Platform Console's sign-in page ----
  t = await open(APP + '/platform/login/');
  check('the console\'s sign-in page at the custom domain offers Google', await until(t.page, shown('[data-pc="google"]')), t.problems);
  await t.page.click('[data-pc="google"]');
  a = await authorize(t.sent);
  check('the console\'s Google sign-in comes back to https://app.hangtag.florixtechnologies.com/platform/', a && a.params.provider === 'google' && a.params.redirect_to === APP + '/platform/', a);
  await t.ctx.close();

  // ---- the same files on another address: the address is the page's own, never written into the app ----
  t = await open(OLD + '/');
  await until(t.page, shown('[data-provider="google"]'));
  await t.page.click('[data-provider="google"]');
  a = await authorize(t.sent);
  check('served elsewhere, the app asks for that address instead (nothing hard-codes a host)', a && a.params.redirect_to === OLD + '/', a);
  await t.ctx.close();
} finally {
  await browser.close().catch(() => {});
}
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
