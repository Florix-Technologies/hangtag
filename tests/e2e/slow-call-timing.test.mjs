// A slow call, told apart in Chrome with the real supabase-js and the app's own plan-status check (rpc
// hangtag_subscription_status). The app's timer runs until the page's thread takes the answer, so a busy page makes a
// quick answer look slow (on 10-13 the live database ran this check in 18 ms on average, yet calls were noted at 1–5 s).
// Now a slow call carries the network's own time, as the browser measured it, and whether the page was hidden:
//   1. the page is busy for 3.5 s while the answer comes at once: "slow call (…) · 3–10 s · network under 1 s";
//   2. the answer itself takes 3.5 s: "… · 3–10 s · network 3–10 s";
//   3. the same while the page is hidden: "… · network 3–10 s · page hidden";
// only an operation name, two duration bands and a flag: no address, no value. Isolated (tests/helpers/isolation.cjs).
// Run: node tests/run.mjs tests/e2e/slow-call-timing.test.mjs
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-00000000d014', EMAIL = 'owner-slow@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, business_type, onboarded_at)
  VALUES ($1, $2, 'Owner', 'Aura Threads', '9876543210', '12 MG Road', 'Pune', 'Maharashtra', 'retail', now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, address = EXCLUDED.address, city = EXCLUDED.city,
    state = EXCLUDED.state, business_type = EXCLUDED.business_type, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);

const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
const A = await (await browser.createBrowserContext()).newPage();
await A.setViewport({ width: 1280, height: 900 });
A.on('pageerror', (e) => { fails++; console.log('[pageerror]', e.message); });
let mode = null;   // how the next plan-status check is answered: 'busy' (at once, while the page works 3.5 s) or 'slow' (after 3.5 s)
await A.setRequestInterception(true);
A.on('request', async (r) => {
  const u = r.url();
  if (u.startsWith('http://localhost:3210/')) return (u === 'http://localhost:3210/' || u.includes('/?')) ? r.respond({ status: 200, contentType: 'text/html', body: H.hookedHtml() }) : r.continue();
  if (u.includes('/rest/v1/rpc/hangtag_subscription_status') && r.method() === 'POST' && mode) {
    const m = mode; mode = null;
    if (m === 'busy') await A.evaluate(() => { setTimeout(() => { const t = performance.now(); while (performance.now() - t < 3500) { /* the page's own work */ } }, 0); });
    else await sleep(3500);
  }
  if (u.includes('.supabase.co/')) { if (!(await pg.handle(r))) r.abort(); return; }
  r.continue();
});
await A.evaluateOnNewDocument((s) => { if (location.hostname === 'localhost') localStorage.setItem('hangtag-auth', s); }, JSON.stringify(pg.session(UID)));
await A.goto('http://localhost:3210/', { waitUntil: 'networkidle0' });
const run = (b) => A.evaluate((b) => __ev('(async()=>{' + b + '})()'), b);
async function until(cond, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run('return !!(' + cond + ')').catch(() => false)) return true; await sleep(150); } return false; }
check('signed in and connected (the stand-in on this computer)', await until('sbStatus==="connected"&&!!authUser'));
await sleep(1500);   // the app's own checks at start are done

/* one plan-status check answered as `how`; the slow-call entry it leaves (noted once the browser has told the network time) */
async function slowCheck(how) {
  await run('clearDiagnostics()');
  mode = how;
  await run('await use("cloud").subscriptionStatus()');
  for (let i = 0; i < 80; i++) {
    const e = await run('return getDiagnostics().filter(e => e.kind === "slow-call" && e.op === "rpc:hangtag_subscription_status").map(e => ({ level: e.level, message: e.message, net: e.net || null, hidden: !!e.hidden }))');
    if (e.length) return e[0];
    await sleep(150);
  }
  return null;
}
const busy = await slowCheck('busy');
check('1. the page busy for 3.5 s while the answer comes at once: "slow call … · 3–10 s · network under 1 s" (the page\'s time, not the network\'s)',
  busy && busy.level === 'warn' && busy.message === 'slow call (rpc:hangtag_subscription_status) · 3–10 s · network under 1 s' && busy.net === 'under 1 s' && !busy.hidden, busy);
const slow = await slowCheck('slow');
check('2. the answer itself taking 3.5 s: "… · 3–10 s · network 3–10 s"', slow && slow.message === 'slow call (rpc:hangtag_subscription_status) · 3–10 s · network 3–10 s' && !slow.hidden, slow);
await run('Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange"))');
const hidden = await slowCheck('slow');
await run('delete document.visibilityState; delete document.hidden; document.dispatchEvent(new Event("visibilitychange"))');
check('3. the same while the page is hidden: "… · network 3–10 s · page hidden"', hidden && hidden.message === 'slow call (rpc:hangtag_subscription_status) · 3–10 s · network 3–10 s · page hidden'
  && hidden.hidden === true, hidden);
const all = await run('return JSON.stringify(getDiagnostics())');
check('…nothing but an operation name, bands and a flag: no address, no value, no exact time', !/supabase\.co|\/rest\/v1|apikey|eq\.|3[45]\d\d ?ms/.test(all), all.slice(0, 300));

await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
