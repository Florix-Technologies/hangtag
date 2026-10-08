// The browser test harness. One shop's cloud is PGlite running the real supabase/schema.sql behind the PostgREST stand-in
// (row security on, tests/helpers/pg-rest.mjs); each device is a Chrome page of the app as tests load it (window.__ev, see
// src/app/test-hook.js), signed in to that shop. What scenarios need beyond that:
//   · more devices of the same shop (or another shop's owner: a second account in the same database)
//   · a screen size (VIEWPORTS: phone, large phone, tablet, desktop)
//   · the network: online, offline (the device knows it is offline — navigator.onLine and the "offline" event — while the
//     app's own files keep loading, as the installed app's cache serves them), the server unreachable while the device
//     thinks it is online, the server answering 503, or the answer lost AFTER the server saved (the retry must not double)
//   · Edge Function stubs by path ('/functions/v1/send-receipt': handler), as pg.handle takes them
// Every check goes through the shared reporter (tests/helpers/report.mjs); an uncaught page error fails the suite.
//
//   const S = await startShop({ report: R, uid, email, shop: { shop_name: 'Aura Threads' } });
//   const A = await S.openDevice({ viewport: 'phone' });   await A.run('…');   await A.until('…');
//   A.net.offline(); A.net.online(); A.net.down(); A.net.failing(503); A.net.dropAfterSave(pred);
//   const rows = await S.sql('SELECT …', [params]);   await S.close();
import puppeteer from 'puppeteer-core';
import H from './env.mjs';
import { createPgRest } from './pg-rest.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const VIEWPORTS = Object.freeze({
  phone: Object.freeze({ width: 360, height: 740, isMobile: true, hasTouch: true }),
  phoneLarge: Object.freeze({ width: 414, height: 896, isMobile: true, hasTouch: true }),
  tablet: Object.freeze({ width: 768, height: 1024, isMobile: true, hasTouch: true }),
  desktop: Object.freeze({ width: 1280, height: 900 }),
});
const DEFAULT_SHOP = Object.freeze({ full_name: 'Owner', shop_name: 'Aura Threads', phone: '9876543210', address: '12 MG Road', city: 'Pune', state: 'Maharashtra', gstin: '27ABCDE1234F1Z5' });

/* A shop profile, onboarded (the app opens straight on Home) */
export async function seedProfile(pg, uid, email, shop = {}){
  const p = { ...DEFAULT_SHOP, ...shop };
  await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, gstin, onboarded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, address = EXCLUDED.address, city = EXCLUDED.city,
      state = EXCLUDED.state, gstin = EXCLUDED.gstin, onboarded_at = EXCLUDED.onboarded_at`, [uid, email, p.full_name, p.shop_name, p.phone, p.address, p.city, p.state, p.gstin || null]);
}

/* The shop's cloud and a browser: { pg, sql, openDevice, close }. users: more accounts in the same database ({ id, email, shop? }) */
export async function startShop({ report, uid, email, shop = {}, users = [], functions = {}, headless = true } = {}){
  if(!report) throw new Error('startShop needs the suite\'s report');
  await H.ensureServer();
  const pg = await createPgRest(H.SCHEMA_PATH, { uid, email, users: users.map(({ shop: _s, ...u }) => u) });
  await seedProfile(pg, uid, email, shop);
  for(const u of users) if(u.shop) await seedProfile(pg, u.id, u.email, u.shop);
  const browser = await puppeteer.launch({ executablePath: H.CHROME, headless });
  const devices = [];
  const S = {
    pg, browser, devices,
    /* SQL as the database itself (no row security): what the cloud really holds */
    sql: async (q, params) => (await pg.db.query(q, params)).rows,
    /* a device signed in as `who` (default: the owner) — { page, run, until, …, net } */
    async openDevice({ viewport = 'desktop', who = uid, label = String.fromCharCode(65 + devices.length), connect = true } = {}){
      const ctx = await browser.createBrowserContext(), page = await ctx.newPage();
      await page.setViewport(typeof viewport === 'string' ? VIEWPORTS[viewport] : viewport);
      page.on('pageerror', (e) => report.problem(`[${label} pageerror] ${e.message}`));
      page.on('dialog', (d) => d.accept());
      const net = networkOf(page);
      await page.setRequestInterception(true);
      page.on('request', async (r) => {
        const u = r.url();
        if(u.startsWith(H.BASE_URL + '/')) return (u === H.BASE_URL + '/' || u.includes('/?')) ? r.respond({ status: 200, contentType: 'text/html', body: H.hookedHtml() }) : r.continue();
        if(!u.includes('.supabase.co/')) return r.continue();
        const mode = net.state.mode, auth = /\/auth\/v1\//.test(u);
        if(mode === 'offline' || mode === 'down') return r.abort('internetdisconnected');
        if(mode === 'failing' && !auth) return r.respond({ status: net.state.status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ message: 'Service unavailable' }) });
        // the answer lost after the server saved: the database runs the request, the device never hears back
        if(mode === 'online' && net.state.drop && r.method() !== 'OPTIONS' && net.state.drop(r)){
          net.state.dropped++;
          const lost = { url: () => r.url(), method: () => r.method(), headers: () => r.headers(), postData: () => r.postData(), respond: () => r.abort('failed'), abort: (x) => r.abort(x) };
          if(!(await pg.handle(lost, functions))) r.abort('failed');
          return;
        }
        if(!(await pg.handle(r, functions))) r.abort();
      });
      const session = pg.session(who);
      await page.evaluateOnNewDocument((s) => { if(location.hostname === 'localhost') localStorage.setItem('hangtag-auth', s); }, JSON.stringify(session));
      await page.goto(H.BASE_URL + '/', { waitUntil: 'networkidle0' });
      const D = deviceOf(page, net, label);
      devices.push(D);
      if(connect && !(await D.until('sbStatus==="connected"', 20000))) report.check(`[${label}] signed in and connected`, false);
      return D;
    },
    async close(){ await browser.close().catch(() => {}); await pg.close?.(); },
  };
  return S;
}

/* The network as one device sees it (the page's request handler reads state) */
function networkOf(page){
  const state = { mode: 'online', status: 503, drop: null, dropped: 0 };
  const flag = (on) => page.evaluate((on) => {
    // the device's own idea of the network (the installed app's files still load: the service worker's cache does that)
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => on });
    window.dispatchEvent(new Event(on ? 'online' : 'offline'));
  }, on).catch(() => {});
  return {
    state,
    /* offline: the device knows, nothing reaches the server */
    async offline(){ state.mode = 'offline'; await flag(false); },
    /* back online: the device is told (the app's own "online" handling runs) */
    async online(){ state.mode = 'online'; state.drop = null; await flag(true); },
    /* the server can't be reached, though the device thinks it is online */
    down(){ state.mode = 'down'; },
    /* the server answers with an error (default 503) to everything but sign-in */
    failing(status = 503){ state.mode = 'failing'; state.status = status; },
    /* requests matching pred(request) are saved by the database but their answers never arrive */
    dropAfterSave(pred){ state.mode = 'online'; state.drop = pred; state.dropped = 0; },
    get dropped(){ return state.dropped; },
  };
}

/* One device: the app's internals (run / until), the screen (text / vis / click / type / choose), and its network */
function deviceOf(page, net, label){
  const run = (body) => page.evaluate((b) => window.__ev('(async()=>{' + b + '})()'), body);
  const D = {
    page, net, label,
    run,
    /* wait until an expression on the device is true (false when it never is) */
    async until(cond, ms = 15000){ const t0 = Date.now(); while(Date.now() - t0 < ms){ if(await run('return !!(' + cond + ')').catch(() => false)) return true; await sleep(120); } return false; },
    text: (sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null),
    texts: (sel) => page.$$eval(sel, (l) => l.map((e) => e.innerText.replace(/\s+/g, ' ').trim())).catch(() => []),
    vis: (sel) => page.$eval(sel, (e) => !e.hidden && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' && e.getClientRects().length > 0).catch(() => false),
    exists: async (sel) => !!(await page.$(sel)),
    async click(sel, wait = 250){ await page.click(sel); await sleep(wait); },
    async type(sel, v, wait = 120){ await page.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, v); await sleep(wait); },
    async choose(sel, v, wait = 150){ await page.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); }, v); await sleep(wait); },
    /* a workspace, drawn */
    async go(tab, wait = 250){ await run(`closeModal();closeSheets();setTab(${JSON.stringify(tab)});renderAll()`); await sleep(wait); },
    /* uploads: what is waiting, and send it now */
    queued: () => run('return sbOfflineQueue.length'),
    review: () => run('return syncReview.length'),
    sync: () => run('await flushSbQueue();return sbOfflineQueue.length'),
  };
  return D;
}
