// The Store, end to end in Chrome: the owner's Store area (open / close, the public link to copy and share, the QR, what
// customers see, the orders from the store) and the public storefront (store.html, as a signed-out visitor: the catalog,
// long names, search, categories, sold out / few left, the cart, checkout with validation, the order, its status link),
// on the one commerce engine: the order is the shop's sales order, reserves the stock, shows in the Store area; closing
// the store closes the storefront. No horizontal overflow at 320 / 375 / 768 / 1280 px.
// The database is PGlite running the real schema.sql behind a PostgREST stand-in (the storefront calls run as anon).
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-0000000000e1', EMAIL = 'ownerstore@example.com';
// a second account makes the stand-in treat requests without a sign-in as a signed-out visitor (anon), as the real API does
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL, users: [{ id: 'aaaaaaaa-0000-0000-0000-0000000000e2', email: 'someone@example.com' }] });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, gstin, onboarded_at) VALUES ($1,$2,'Owner','Aura Threads','9876543210','12 MG Road','Pune','Maharashtra','27ABCDE1234F1Z5',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, address = EXCLUDED.address, city = EXCLUDED.city, state = EXCLUDED.state, gstin = EXCLUDED.gstin, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);
const sql = async (q, p = []) => (await pg.db.query(q, p)).rows;

const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
async function open(url, { width = 1280, session = true } = {}) {
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setViewport({ width, height: 900 });
  page.on('pageerror', (e) => { fails++; console.log('[pageerror]', e.message); });
  page.on('dialog', (d) => d.accept());
  await page.setRequestInterception(true);
  page.on('request', async (r) => {
    const u = r.url();
    if (u.startsWith('http://localhost:3210/')) return (u === 'http://localhost:3210/' || u.includes('/?')) ? r.respond({ status: 200, contentType: 'text/html', body: H.hookedHtml() }) : r.continue();
    if (u.includes('.supabase.co/')) { if (!(await pg.handle(r))) r.abort(); return; }
    r.continue();
  });
  await page.evaluateOnNewDocument((s, withSession) => {
    if (withSession && location.hostname === 'localhost') localStorage.setItem('hangtag-auth', s);
    window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied.push(t); } }, configurable: true });
    window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; };
  }, JSON.stringify(pg.session()), session);
  await page.goto(url, { waitUntil: 'networkidle0' });
  return page;
}
const A = await open('http://localhost:3210/');
const run = (b, P = A) => P.evaluate((b) => __ev('(async()=>{' + b + '})()'), b);
async function until(cond, ms = 15000, P = A) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run('return !!(' + cond + ')', P).catch(() => false)) return true; await sleep(120); } return false; }
async function waitFor(P, fn, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await P.evaluate(fn).catch(() => false)) return true; await sleep(120); } return false; }
const text = (sel, P = A) => P.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
const overflow = (P) => P.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check('signed in and connected', await until('sbStatus==="connected"'));

console.log('--- the shop and its products ---');
const LONG = 'Hand-block printed Jaipur cotton kurta with mirror work, wooden buttons and a contrast placket — festive edition';
await run(`saveCapabilities({uses_sales_orders:true, uses_mobile_store:false});
  openEditor(null);editor.name="Everyday tee";editor.price="499";editor.cost="200";editor.cat="Clothing";edCombos()[0].cell.stock="2";saveEditor();
  openEditor(null);editor.name=${JSON.stringify(LONG)};editor.price="1899";editor.cost="900";editor.cat="Clothing";edCombos()[0].cell.stock="9";saveEditor();
  openEditor(null);editor.name="Silk dupatta";editor.price="799";editor.cost="300";editor.cat="Accessories";saveEditor();
  closeModal(); await flushSbQueue();`);
check('three products saved to the cloud', (await sql(`SELECT count(*)::int n FROM public.hangtag_products WHERE owner_id = $1`, [UID]))[0].n === 3);

console.log('--- the Store area ---');
await run('setTab("store");renderAll()'); await sleep(300);
const closedPage = await text('#v-store');
check('the Store area: closed at first, with "Open store"', /Your store is closed/.test(closedPage || '') && !!(await A.$('#v-store [data-store="open"]')), closedPage);
await A.click('#v-store [data-store="open"]'); await sleep(300); await run('await flushSbQueue()');
check('Open store switches the mobile store on (and keeps sales orders on)', await run('return hasCap("uses_mobile_store") && hasCap("uses_sales_orders")'));
const storePage = await text('#v-store');
check('open: the public link, the QR, what customers see (3 on sale, 1 sold out), the orders', /Your store is open/.test(storePage || '') && /store\.html#s=st_/.test(storePage || '')
  && !!(await A.$('#v-store .sq-code svg')) && /3 products on sale/.test(storePage || '') && /1 sold out/.test(storePage || '') && /Store orders/.test(storePage || ''), storePage);
await A.click('#v-store [data-store="copy"]'); await sleep(150);
const copied = await A.evaluate(() => window.__copied.slice(-1)[0]);
check('Copy link puts the store link on the clipboard', /^http:\/\/localhost:3210\/store\.html#s=st_[A-Za-z0-9_-]{32,}$/.test(copied || ''), copied);
await A.click('#v-store [data-store="qr"]'); await sleep(200);
check('Show QR opens the QR with Download and Print', !!(await A.$('#modalHost .tqr-code svg')) && !!(await A.$('#modalHost [data-store="dl"]')) && !!(await A.$('#modalHost [data-store="print"]')));
await run('closeModal()');
check('the Store area is in More (not in Settings only)', await run('openNavMore(); const ok = !!document.querySelector("#modalHost [data-tab=\\"store\\"]"); closeModal(); return ok;'));
const storeUrl = copied;
for (const w of [320, 375, 768, 1280]) { await A.setViewport({ width: w, height: 900 }); await sleep(200); check(`the Store area at ${w}px: no horizontal overflow`, !(await overflow(A))); }
await A.setViewport({ width: 1280, height: 900 });

console.log('--- the public storefront (signed out) ---');
const S = await open(storeUrl, { width: 375, session: false });
check('the storefront loads the shop\'s catalog (as a signed-out visitor)', await waitFor(S, () => document.querySelectorAll('.pc').length === 3) && /Aura Threads/.test(await text('.brand h1', S) || ''));
const cards = await S.$$eval('.pc', (l) => l.map((c) => ({ name: c.querySelector('.pc-name').textContent, stock: (c.querySelector('.stock') || {}).textContent, h: c.querySelector('.pc-name').getBoundingClientRect().height, w: c.getBoundingClientRect().width, sw: c.scrollWidth })));
check('stock states: "Only 2 left", "In stock", "Sold out"', cards.some((c) => c.stock === 'Only 2 left') && cards.some((c) => c.stock === 'In stock') && cards.some((c) => c.stock === 'Sold out'), cards);
const longCard = cards.find((c) => c.name === LONG);
check('a very long name is clamped to two lines inside its card (no overflow)', longCard && longCard.h <= 40 && longCard.sw <= longCard.w + 1, longCard);
check('no image: a quiet placeholder, never a giant letter', await S.$$eval('.pc-img', (l) => l.every((b) => !b.textContent.trim() && !!b.querySelector('svg'))));
await S.type('.search input', 'dupatta'); await sleep(250);
check('search filters the products', (await S.$$eval('.pc .pc-name', (l) => l.map((x) => x.textContent))).join() === 'Silk dupatta');
await S.$eval('.search input', (e) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(200);
await S.evaluate(() => [...document.querySelectorAll('.cats button')].find((b) => b.textContent === 'Accessories').click()); await sleep(200);
check('categories filter too', (await S.$$eval('.pc .pc-name', (l) => l.map((x) => x.textContent))).join() === 'Silk dupatta');
await S.evaluate(() => [...document.querySelectorAll('.cats button')].find((b) => b.textContent === 'All').click()); await sleep(200);
for (const w of [320, 375, 768, 1280]) { await S.setViewport({ width: w, height: 900 }); await sleep(200); check(`the storefront at ${w}px: no horizontal overflow`, !(await overflow(S))); }
await S.setViewport({ width: 1280, height: 900 });
await S.evaluate(() => [...document.querySelectorAll('.pc')].find((c) => /Everyday tee/.test(c.textContent)).querySelector('.add').click()); await sleep(200);
check('desktop: the cart panel at the side shows the tee and the total', /Everyday tee/.test(await text('.panel', S) || '') && /₹499/.test(await text('.panel', S) || ''));
await S.setViewport({ width: 375, height: 900 }); await sleep(200);
await S.evaluate(() => [...document.querySelectorAll('.pc')].find((c) => /Everyday tee/.test(c.textContent)).querySelector('.stepper button:last-child').click()); await sleep(200);
check('phone: the sticky cart bar says 2 items · ₹998; the stepper stops at the 2 in stock', /2 items · ₹998/.test(await text('.cartbar', S) || '')
  && await S.evaluate(() => [...document.querySelectorAll('.pc')].find((c) => /Everyday tee/.test(c.textContent)).querySelector('.stepper button:last-child').disabled));
await S.evaluate(() => [...document.querySelectorAll('.cartbar button')].pop().click()); await sleep(200);
await S.evaluate(() => [...document.querySelectorAll('.cartbar button')].pop().click()); await sleep(200);
await S.evaluate(() => [...document.querySelectorAll('.cartbar button')].pop().click()); await sleep(300);
check('checkout without a name: "Enter your name." next to the field, nothing sent', /Enter your name/.test(await text('.field .err', S) || '') && await S.$eval('#f-name', (e) => e.getAttribute('aria-invalid') === 'true')
  && (await sql(`SELECT count(*)::int n FROM public.hangtag_orders WHERE owner_id = $1`, [UID]))[0].n === 0);
await S.type('#f-name', 'Asha Verma'); await S.type('#f-phone', '12345');
await S.evaluate(() => [...document.querySelectorAll('.cartbar button')].pop().click()); await sleep(300);
check('a short mobile number is refused too', /valid mobile number/.test(await text('.field .err', S) || ''));
await S.$eval('#f-phone', (e) => { e.value = ''; }); await S.type('#f-phone', '9876543210');
await S.evaluate(() => [...document.querySelectorAll('.cartbar button')].pop().click());
check('the order is placed: "Order received", its number, the stages, a status link', await waitFor(S, () => /Order received/.test(document.body.innerText))
  && /MO-\d{6}-[A-Z0-9]+/.test(await text('.order-no', S) || '') && /Received/.test(await text('.stages', S) || '') && /&o=mo_/.test(await S.$eval('.linkbox input', (e) => e.value).catch(() => '')));
const order = (await sql(`SELECT id, no, status, source, total, kind FROM public.hangtag_orders WHERE owner_id = $1`, [UID]))[0];
check('…the shop\'s own sales order (source customer), total ₹998 decided by the database', order && order.kind === 'sales' && order.source === 'customer' && +order.total === 998, order);
const statusUrl = await S.$eval('.linkbox input', (e) => e.value);
const catalog = await S.evaluate(async () => { const c = window.HANGTAG_CONFIG; const r = await fetch(c.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/rpc/hangtag_mobile_catalog', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: c.SUPABASE_ANON_KEY }, body: JSON.stringify({ p_token: location.hash.slice(3).split('&')[0] }) }); return r.json(); });
const tee = catalog.items.find((p) => p.name === 'Everyday tee');
check('the order reserves the stock: the tee shows 0 available to the next customer', tee && tee.variants[0].available === 0, tee && tee.variants[0]);
for (const w of [320, 375, 768, 1280]) { await S.setViewport({ width: w, height: 900 }); await sleep(150); check(`the confirmation at ${w}px: no horizontal overflow`, !(await overflow(S))); }

console.log('--- the order in the shop ---');
await run('await pullOrders(); renderAll();');   // the shop's devices get it live (realtime); the stand-in has no realtime, so pull
check('the order reaches the shop\'s Orders', await until(`Object.values(orders||{}).some(o=>o.source==="customer"&&o.custName!==undefined||o.source==="customer")`, 15000));
await run('setTab("store");renderAll()'); await sleep(300);
check('the Store area lists it as Received (as the customer sees it), with the customer and the amount', /Asha Verma/.test(await text('#v-store') || '') && /Received/.test(await text('#v-store .olist') || '') && /₹998/.test(await text('#v-store .olist') || ''), await text('#v-store .olist'));

console.log('--- the status link, and closing the store ---');
const T = await open(statusUrl, { width: 375, session: false });
check('the status link opens the order\'s status (stages, items, total, call the shop)', await waitFor(T, () => /Your order|Order received/.test(document.body.innerText))
  && /Received/.test(await text('.stages', T) || '') && /Everyday tee/.test(await text('main', T) || '') && /₹998/.test(await text('main', T) || '') && !!(await T.$('.contact a[href^="tel:"]')));
await A.click('#v-store [data-store="close"]'); await sleep(300); await run('await flushSbQueue()');
check('Close store switches the mobile store off', await run('return !hasCap("uses_mobile_store")'));
const C = await open(storeUrl, { width: 320, session: false });
check('the storefront now says the shop\'s store is closed', await waitFor(C, () => /closed right now/.test(document.body.innerText)) && /Aura Threads/.test(await text('.brand h1', C) || '') && !(await overflow(C)));
const T2 = await open(statusUrl, { width: 375, session: false });
check('…while the customer\'s order status still opens', await waitFor(T2, () => /Received/.test((document.querySelector('.stages') || {}).innerText || '')));
await sql(`UPDATE public.hangtag_orders SET status = 'cancelled' WHERE public_token = $1`, [statusUrl.match(/o=(mo_[A-Za-z0-9_-]+)/)[1]]);
const T3 = await open(statusUrl, { width: 375, session: false });
check('a cancelled order says so: "Order cancelled", cancelled by the shop, a cross (not the green tick), no stages', await waitFor(T3, () => /Order cancelled/.test(document.body.innerText))
  && /Cancelled by the shop/.test(await text('main', T3) || '') && !!(await T3.$('.tick.off')) && !(await T3.$('.stages')));

await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
