// Business type, capabilities and the adaptive navigation end to end in Chrome (F2): a new owner sets up the shop (shop
// name, then the type of business — Grocery — and nothing about capabilities), enters the app with Grocery's defaults;
// the tab bar comes from the module registry (Home, Sell, Inventory, Products, Customers, Reports, Settings; Orders only
// when one of its parts exists; never Tables or Kitchen for a grocery); the product form shows batch tracking, the expiry
// note and weight guidance, and the product's tracking reaches the database; Settings is in sections (Business,
// Capabilities, Receipt, Taxes, Team & devices, Roles & permissions, Hardware, Account); switching on serial numbers is
// saved in the shop's synced settings and changes the form; an older copy of the settings uploaded later doesn't wipe the
// choice; changing the type to Hotel / Restaurant changes the recommended set, and Team & devices stays; an older shop
// (profile "Clothing boutique") opens as Retail without any setup; on a 390 px phone the tab bar fits with "More".
// The database is PGlite running the real schema.sql behind the PostgREST stand-in (tests/helpers/pg-rest.mjs).
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest, CORS } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 700) : '')); };
const OWNER = 'cccccccc-0000-4000-8000-00000000c0c1', EMAIL = 'owner.caps@example.com';
const LEGACY = 'dddddddd-0000-4000-8000-00000000d0d1', LEGACY_EMAIL = 'legacy.shop@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: OWNER, email: EMAIL });
const q = async (sql, p = []) => (await pg.db.query(sql, p)).rows;
const reply = (r, status, b) => r.respond({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(b) });
const notSetUp = (r) => { const b = JSON.parse(r.postData() || '{}'); if (b.action === 'channels') return reply(r, 200, { ok: true, channels: { email: false, whatsapp: false, sms: false } }); return reply(r, 200, { ok: false, error: 'not_configured', message: 'Not set up.' }); };
const FUNCTIONS = { '/functions/v1/team': notSetUp, '/functions/v1/payment-gateway': notSetUp, '/functions/v1/send-receipt': notSetUp };
const settingsRow = async (owner = OWNER) => ((await q(`SELECT value FROM public.hangtag_meta WHERE owner_id = $1 AND key = 'settings'`, [owner]))[0] || {}).value || null;

const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
async function phone(label, { session = null, width = 1180, height = 900, mobile = false } = {}) {
  const ctx = await browser.createBrowserContext(); const p = await ctx.newPage();
  await p.setViewport({ width, height, isMobile: mobile, hasTouch: mobile });
  p.on('pageerror', (e) => { fails++; console.log(`[${label} pageerror]`, e.message); });
  p.on('dialog', (d) => d.accept(''));
  await p.setRequestInterception(true);
  p.on('request', async (r) => {
    const u = r.url();
    if (u.startsWith('http://localhost:3210/')) return (u.split('#')[0] === 'http://localhost:3210/' || u.includes('/?')) ? r.respond({ status: 200, contentType: 'text/html', body: H.hookedHtml() }) : r.continue();
    if (u.includes('.supabase.co/')) { if (!(await pg.handle(r, FUNCTIONS))) r.abort(); return; }
    r.continue();
  });
  if (session) await p.evaluateOnNewDocument((s) => { if (location.hostname === 'localhost' && !sessionStorage.__seeded) { sessionStorage.__seeded = 1; localStorage.setItem('hangtag-auth', s); } }, JSON.stringify(session));
  p.run = (b) => p.evaluate((b) => __ev('(async()=>{' + b + '})()'), b);
  p.until = async (cond, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p.run('return !!(' + cond + ')').catch(() => false)) return true; await sleep(120); } return false; };
  p.vis = (sel) => p.$eval(sel, (e) => !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0).catch(() => false);
  p.text = (sel) => p.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
  p.fill = async (sel, v) => { await p.$eval(sel, (e) => { e.value = ''; }); await p.type(sel, v); };
  p.tabs = () => p.$$eval('.nav [data-tab]', (b) => b.filter((x) => getComputedStyle(x).display !== 'none').map((x) => x.dataset.tab));
  return p;
}

try {
  // ================= a new shop: shop name → type of business → the app =================
  const A = await phone('owner', { session: pg.session() });
  await A.goto('http://localhost:3210/', { waitUntil: 'networkidle0' });
  check('new account: the setup screen', await A.until('!document.getElementById("setupGate").hidden'));
  const order = await A.$$eval('#setupForm [data-field]', (x) => x.map((e) => e.dataset.field));
  check('setup asks the shop name first, then the type of business', order[0] === 'shop_name' && order[1] === 'business_type', order);
  check('five types to choose from (Hotel / Restaurant among them), none chosen yet', eq5(await A.$$eval('#su_business_type option', (o) => o.map((x) => x.textContent))));
  function eq5(l) { return JSON.stringify(l) === JSON.stringify(['Choose…', 'Retail', 'Grocery', 'Hotel / Restaurant', 'Electronics', 'Other']); }
  check('no capability switches during setup', !(await A.$('#setupForm [data-cap]')));
  await A.fill('#su_shop_name', 'Fresh Mart');
  await A.click('#setupSubmit'); await sleep(200);
  check('the type must be chosen', (await A.text('#setupErr')) === 'Choose the type of business.');
  await A.select('#su_business_type', 'grocery');
  await A.fill('#su_full_name', 'Nisha Rao'); await A.fill('#su_phone', '9876543210'); await A.fill('#su_city', 'Pune'); await A.fill('#su_state', 'Maharashtra');
  await A.click('#setupSubmit');
  check('setup done: the app opens', await A.until('document.getElementById("setupGate").hidden&&profile&&profile.business_type==="grocery"'));
  check('the type is saved in the shop profile', ((await q(`SELECT business_type FROM public.hangtag_profiles WHERE id = $1`, [OWNER]))[0] || {}).business_type === 'grocery');
  check('Grocery\'s defaults applied silently (nothing stored: they follow the type)', await A.run(`const c=shopCaps();return shopType()==="grocery"&&c.uses_batches&&c.uses_expiry&&c.uses_weight&&c.uses_variants&&!c.uses_serials&&!c.uses_tables&&!settings.caps`));

  // ================= the navigation =================
  await A.run('setTab("home");renderAll()'); await sleep(200);
  const tabs = await A.tabs();
  check('tab bar: Home, Sell, Inventory, Products, Customers, Reports, Ask, Settings (in that order, Orders only with a part)',
    JSON.stringify(tabs.filter((t) => t !== 'orders')) === JSON.stringify(['home', 'sell', 'stock', 'products', 'customers', 'report', 'assistant', 'settings'])
    && tabs.includes('orders') === (await A.run('return subviewsOf("orders").length>0')), tabs);
  check('Inventory is the Stock tab (same id), labelled Inventory', (await A.text('.nav [data-tab="stock"]')) === 'Inventory');
  check('no Tables or Kitchen for a grocery', !tabs.includes('tables') && !tabs.includes('kitchen') && !(await A.run('return moduleShown("tables")||moduleShown("kitchen")')));
  check('Home: today, stock, sync and quick actions', await A.vis('#v-home') && await A.vis('#homeBody .qa') && /Today/.test(await A.text('#homeBody') || '') && /Sync/.test(await A.text('#homeBody') || '')
    && /Grocery/.test(await A.text('#homeBody .viewhead') || ''));
  await A.click('#homeBody .qa [data-tab="sell"]'); await sleep(200);
  check('a quick action opens its module', await A.run('return prefs.tab==="sell"') && await A.vis('#v-sell'));
  await A.click('.nav [data-tab="settings"]'); await sleep(250);
  check('the Settings tab opens the settings', await A.vis('.sheet.settings'));
  const secs = await A.$$eval('.setnav [data-setgo]', (b) => b.map((x) => x.textContent));
  check('settings in sections', JSON.stringify(secs) === JSON.stringify(['Business', 'Capabilities', 'Receipt', 'Taxes', 'Team & devices', 'Roles & permissions', 'Hardware', 'Advanced', 'Account']), secs);
  check('Business holds the profile with its type', (await A.$eval('#ps_business_type', (e) => e.value)) === 'grocery' && await A.vis('#set-business #profileForm'));
  check('Receipt, Taxes and Hardware hold their forms once (no duplicates)', await A.vis('#set-receipt #billingForm') && await A.vis('#set-taxes #taxForm') && await A.vis('#set-hardware #printerForm')
    && (await A.$$('#billingForm')).length === 1 && (await A.$$('#printerForm')).length === 1);
  check('Team & devices is there for a grocery', await A.vis('#teamSec [data-team="open"]') && await A.vis('#set-roles [data-team="roles"]'));
  check('Capabilities: recommended for Grocery first, with human names', /Recommended for Grocery/.test(await A.text('#capsForm .capgrp') || '') && /Batch tracking/.test(await A.text('#capsForm') || '')
    && !/uses_/.test(await A.text('#capsForm') || ''));
  check('restaurant capabilities folded away for a grocery', await A.$eval('#capsForm [data-capgrp="restaurant"]', (d) => !d.open));
  await A.run('closeSettings()');

  // ================= the product form follows the capabilities =================
  await A.run('setTab("products");renderAll();openEditor(null)'); await sleep(250);
  check('grocery product form: tracking None / Batch / Batch with expiry date, the expiry note and weight guidance, variants', JSON.stringify(await A.$$eval('#edTracking option', (o) => o.map((x) => x.value))) === '["none","batch","expiry"]'
    && await A.vis('[data-capnote="expiry"]') && await A.vis('[data-capnote="weight"]') && !!(await A.$('[data-edtoggle="hasOpts"]')));
  await A.type('#edName', 'Basmati Rice'); await A.type('[data-ed="price"]', '120');
  await A.select('#edTracking', 'batch');
  await A.click('[data-act="edsave"]'); await sleep(300);
  check('saved with batch tracking', await A.run('return products().some(p=>p.name==="Basmati Rice"&&p.tracking==="batch")'));
  check('...and uploaded (hangtag_products.tracking)', await A.until('!sbOfflineQueue.length') && ((await q(`SELECT tracking FROM public.hangtag_products WHERE owner_id = $1 AND name = 'Basmati Rice'`, [OWNER]))[0] || {}).tracking === 'batch');

  // ================= a capability switched on: saved in the synced settings =================
  await A.run('openSettings()'); await sleep(200);
  await A.click('#capsForm [data-cap="uses_serials"]');
  await A.click('#capsForm button[type="submit"]'); await sleep(300);
  check('serial numbers on for this grocery', await A.run('return hasCap("uses_serials")&&settings.caps.uses_serials===true&&typeof settings.capsAt==="number"'));
  check('...uploaded with the shop\'s settings (only the difference from the defaults)', await A.until('!sbOfflineQueue.length') && JSON.stringify((await settingsRow() || {}).caps) === '{"uses_serials":true}');
  await A.run('closeSettings();openEditor(null)'); await sleep(200);
  check('the form now offers serial numbers too', JSON.stringify(await A.$$eval('#edTracking option', (o) => o.map((x) => x.value))) === '["none","serial","batch","expiry"]');
  await A.run('closeModal()');
  // a phone with an older copy of the settings (no capabilities) uploads: the database keeps the choice, the app keeps it too
  const before = await settingsRow();
  await pg.as(`UPDATE public.hangtag_meta SET value = $1::jsonb WHERE key = 'settings'`, [JSON.stringify(Object.assign({}, before, { caps: undefined, capsAt: undefined, lowStock: 7 }))]);
  const after = await settingsRow();
  check('an older copy uploaded later doesn\'t wipe the choice (its other settings still arrive)', after.caps && after.caps.uses_serials === true && after.lowStock === 7, after);
  await A.run('await pullSettings()'); await sleep(200);
  check('...and the till still has it after downloading', await A.run('return hasCap("uses_serials")&&settings.lowStock===7'));

  // ================= another type: Hotel / Restaurant =================
  await A.run('openSettings()'); await sleep(200);
  await A.select('#ps_business_type', 'restaurant');
  await A.click('#profileSave');
  check('the type changed to Hotel / Restaurant', await A.until('profile.business_type==="restaurant"&&!document.querySelector("#modalHost .settings")'));
  check('restaurant defaults (serial numbers kept as the shop chose)', await A.run(`const c=shopCaps();return c.uses_tables&&c.uses_kitchen&&c.uses_table_qr&&!c.uses_batches&&c.uses_serials`));
  check('restaurant modules appear when their capabilities are on', (await A.tabs()).includes('tables') && (await A.tabs()).includes('kitchen'));
  await A.run('openSettings()'); await sleep(200);
  check('Capabilities recommended for Hotel / Restaurant; Team & devices still there', /Recommended for Hotel \/ Restaurant/.test(await A.text('#capsForm .capgrp') || '') && await A.vis('#teamSec [data-team="open"]'));
  await A.run('closeSettings();openEditor(null)'); await sleep(200);
  check('restaurant product form kept simple: no variants section for a new product', !(await A.$('[data-edtoggle="hasOpts"]')) && !(await A.$('[data-capnote="weight"]')));
  await A.run('closeModal()');

  // ================= a phone: compact tab bar with More =================
  const P = await phone('phone', { session: pg.session(), width: 390, height: 844, mobile: true });
  await P.goto('http://localhost:3210/', { waitUntil: 'networkidle0' });
  await P.until('sbStatus==="connected"');
  await P.run('setTab("home");renderAll()'); await sleep(250);
  const ptabs = await P.tabs();
  check('phone: at most 5 tabs and More', ptabs.length <= 5 && await P.vis('.nav [data-navmore]') && ptabs.includes('sell') && ptabs.includes('home'), ptabs);
  check('phone: no horizontal scroll', await P.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1);
  await P.click('.nav [data-navmore]'); await sleep(200);
  const more = await P.$$eval('.navsheet [data-tab]', (b) => b.map((x) => x.dataset.tab));
  check('More lists the rest (Settings among them)', more.length >= 1 && more.includes('settings') && !more.some((t) => ptabs.includes(t)), more);
  await P.click('.navsheet [data-tab="settings"]'); await sleep(250);
  check('phone: Settings opens from More', await P.vis('.sheet.settings'));
  check('phone: the settings fit the width', await P.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1);
  await P.screenshot({ path: H.ARTIFACTS + '/f2_phone_settings.png' });

  // ================= an existing shop from before business types =================
  await pg.addUser({ id: LEGACY, email: LEGACY_EMAIL, provider: 'google', meta: { full_name: 'Old Shop' } });
  await q(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, city, state, business_type, onboarded_at) VALUES ($1,$2,'Old Owner','Old Threads','9876500000','Surat','Gujarat','Clothing boutique',now())
    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, city = EXCLUDED.city, state = EXCLUDED.state, business_type = EXCLUDED.business_type, onboarded_at = EXCLUDED.onboarded_at`, [LEGACY, LEGACY_EMAIL]);
  const L = await phone('legacy', { session: pg.session(LEGACY) });
  await L.goto('http://localhost:3210/', { waitUntil: 'networkidle0' });
  check('older shop: no setup screen, straight into the app', await L.until('sbStatus==="connected"') && await L.run('return document.getElementById("setupGate").hidden'));
  check('older shop: a retail shop with retail defaults', await L.run(`const c=shopCaps();return shopType()==="retail"&&c.uses_variants&&c.uses_quotations&&!c.uses_batches&&!c.uses_tables`));
  await L.run('openSettings()'); await sleep(200);
  check('older shop: Business shows Retail; its stored value is kept until the owner saves', (await L.$eval('#ps_business_type', (e) => e.value)) === 'retail'
    && ((await q(`SELECT business_type FROM public.hangtag_profiles WHERE id = $1`, [LEGACY]))[0] || {}).business_type === 'Clothing boutique');
  check('older shop: Sell, Inventory, Products, Customers, Reports as before', await L.run('return ["sell","stock","products","customers","report"].every(tabOpen)'));
} catch (e) { fails++; console.log('FAIL crashed:', e && e.stack || e); }
finally { await browser.close(); }
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
