// Restaurant / hotel mode, end to end in Chrome: a hotel/restaurant shop gets Tables and Kitchen; tables are set up with
// their own QR codes (shop + table only, nothing secret); orders are taken per table (two tables never mix), go through the
// kitchen (New → Accepted → Preparing → Ready → Served) and show on the floor; a guest scans the table's QR, sees only the
// menu and orders from their phone; the table is billed through the ordinary bill (GST, payment, receipt) and paying it
// closes the table. The database is PGlite running the real schema.sql behind a PostgREST stand-in, as the signed-in
// owner with row-level security; the guest page talks to it signed out (anon), as on a real phone.
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest, CORS } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 500) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-000000000001', EMAIL = 'owner@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, city, state, business_type, onboarded_at) VALUES ($1,$2,'Owner','Udupi Corner','9876543210','Pune','Maharashtra','restaurant',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, city = EXCLUDED.city, state = EXCLUDED.state, business_type = EXCLUDED.business_type, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);
await pg.as(`INSERT INTO public.hangtag_products (id, name, price, cost_price, category, gst_rate, options) VALUES ('dosa', 'Masala Dosa', 120, 45, 'South Indian', 5, '{"opts":[]}'), ('coffee', 'Filter Coffee', 40, 12, 'Drinks', 5, '{"opts":[]}')`, []);
await pg.as(`INSERT INTO public.hangtag_variants (id, product_id, option_values) VALUES ('dosa:', 'dosa', '[]'), ('coffee:', 'coffee', '[]')`, []);
await pg.as(`INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, t) VALUES ('m1', 'dosa:', 'dosa', 'RESTOCK', 100, 1), ('m2', 'coffee:', 'coffee', 'RESTOCK', 100, 1)`, []);
// the restaurant charges GST (5% on its menu, added to the prices)
await pg.as(`INSERT INTO public.hangtag_meta (key, value) VALUES ('settings', '{"taxOn":true,"taxRate":5,"taxIncl":false}')`, []);
const q1 = async (sql, params = []) => (await pg.as(sql, params)).rows;
async function dbUntil(sql, test, ms = 15000) { const t0 = Date.now(); let rows = []; while (Date.now() - t0 < ms) { rows = await q1(sql); if (test(rows)) return rows; await sleep(150); } return rows; }

// ---------- the owner's till ----------
const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
const A = await (await browser.createBrowserContext()).newPage();
await A.setViewport({ width: 1280, height: 900 });
A.on('pageerror', (e) => { fails++; console.log('[pageerror]', e.message); });
A.on('dialog', (d) => d.accept());
await A.setRequestInterception(true);
A.on('request', async (r) => {
  const u = r.url();
  if (u.startsWith('http://localhost:3210/')) return (u === 'http://localhost:3210/' || u.includes('/?')) ? r.respond({ status: 200, contentType: 'text/html', body: H.hookedHtml() }) : r.continue();
  if (u.includes('.supabase.co/')) { if (!(await pg.handle(r))) r.abort(); return; }
  r.continue();
});
await A.evaluateOnNewDocument((s) => { if (location.hostname === 'localhost') localStorage.setItem('hangtag-auth', s); }, JSON.stringify(pg.session()));
await A.goto('http://localhost:3210/', { waitUntil: 'networkidle0' });
const run = (b) => A.evaluate((b) => __ev('(async()=>{' + b + '})()'), b);
async function until(cond, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run('return !!(' + cond + ')').catch(() => false)) return true; await sleep(100); } return false; }
const text = (sel) => A.$eval(sel, (e) => e.textContent).catch(() => '');
check('signed in and connected; a hotel / restaurant shop', await until('sbStatus==="connected"') && (await run('return shopType()')) === 'restaurant');
// the bar picks the workspace; Tables and Kitchen are tasks of the Sell workspace (its own bar), not more top-level places
await run('setTab("sell");renderAll()'); await sleep(200);
check('the Sell workspace has Tables and Kitchen (the restaurant capabilities are on for this type of business)', !!(await A.$('[data-subnav="sell"] [data-tab="tables"]')) && !!(await A.$('[data-subnav="sell"] [data-tab="kitchen"]'))
  && !(await A.$('.nav [data-tab="tables"]')));
await run('setTab("home");renderAll()'); await sleep(200);
check('Home: the owner of a restaurant gets Tables as a quick action (in place of Scan to sell)', !!(await A.$('#homeBody .qa [data-tab="tables"]')) && !(await A.$('#homeBody .qa [data-act="scan"]')) && !!(await A.$('#homeBody .qa [data-tab="sell"]')));

// ---------- 1. tables and their QR codes ----------
await run('setTab("tables");renderAll()'); await sleep(200);
await A.click('#v-tables [data-tmode="setup"]'); await sleep(150);
for (const [name, seats] of [['T1', '4'], ['T2', '2']]) {
  await A.click('#v-tables [data-tedit="new"]'); await sleep(150);
  await A.type('#tableForm [name="name"]', name); await A.type('#tableForm [name="seats"]', seats);
  await A.click('#tableForm [type="submit"]'); await sleep(250);
}
const dbTables = await dbUntil(`SELECT id, name, seats, qr_token FROM public.hangtag_tables ORDER BY name`, (r) => r.length === 2);
check('two tables set up and saved in the cloud, each with a QR token of its own', dbTables.length === 2 && dbTables[0].name === 'T1' && dbTables[0].seats === 4 && dbTables[0].qr_token !== dbTables[1].qr_token
  && dbTables.every((t) => /^[A-Za-z0-9_-]{43}$/.test(t.qr_token)), dbTables);
await A.click('#v-tables [data-tedit="new"]'); await sleep(150);
await A.type('#tableForm [name="name"]', 't1'); await A.click('#tableForm [type="submit"]'); await sleep(250);
check('a second table called T1 is refused', /already a table called T1/.test(await text('#tableForm')));
await A.click('#tableForm [data-tedit=""]'); await sleep(150);
const T1 = dbTables[0], T2 = dbTables[1];
await A.click(`#v-tables [data-tqr="${T1.id}"]`); await sleep(250);
const qrUrl = await text('.tqr-sheet .tqr-url');
check('T1\'s QR opens the ordering page with only the table\'s token after "#" (no key, password or sign-in in it)', qrUrl === `http://localhost:3210/order.html#t=${T1.qr_token}` && !/key|apikey|sb_|password|eyJ/i.test(qrUrl)
  && !!(await A.$('.tqr-sheet svg')) && !!(await A.$(`[data-tqrprint="${T1.id}"]`)) && !!(await A.$(`[data-tqrdl="${T1.id}"]`)), qrUrl);
await A.click('.tqr-sheet [data-modal-close]'); await sleep(150);

// ---------- 2. orders per table ----------
await A.click('#v-tables [data-tmode="floor"]'); await sleep(150);
check('the floor: both tables Available', (await A.$$eval('#v-tables .tcard', (x) => x.map((e) => e.className))).every((c) => /st-available/.test(c)));
async function orderFor(table, items, note) {
  if (!(await A.$(`#tablePanel[data-tpanel="${table.id}"]`))) { await A.click(`#v-tables [data-tbl="${table.id}"]`); await sleep(150); }
  await A.click(`#v-tables [data-tneworder="${table.id}"]`); await sleep(200);
  for (const v of items) { await A.click(`#tableOrderSheet [data-toadd="${v}"]`); await sleep(80); }
  if (note) { await A.type('#tableOrderSheet [data-tonote="0"]', note); }
  await A.click('#tableOrderSheet [data-tosend]'); await sleep(300);
}
await orderFor(T1, ['dosa:', 'dosa:', 'coffee:'], 'less spicy');
await orderFor(T2, ['coffee:', 'coffee:', 'coffee:']);
const dbOrders = await dbUntil(`SELECT o.id, o.table_id, o.session_id, o.status, o.kind, o.source, (SELECT json_agg(json_build_object('v', i.variant_id, 'q', i.qty::float, 'note', i.note) ORDER BY i.line_no) FROM public.hangtag_order_items i WHERE i.order_id = o.id) AS items FROM public.hangtag_orders o WHERE o.kind = 'table' ORDER BY o.table_id`, (r) => r.length === 2);
const o1 = dbOrders.find((o) => o.table_id === T1.id), o2 = dbOrders.find((o) => o.table_id === T2.id);
check('each table\'s order belongs to its own table and session, sent to the kitchen (New)', o1 && o2 && o1.session_id !== o2.session_id && o1.status === 'new' && o2.status === 'new' && o1.source === 'staff'
  && JSON.stringify(o1.items) === JSON.stringify([{ v: 'dosa:', q: 2, note: 'less spicy' }, { v: 'coffee:', q: 1, note: null }]) && JSON.stringify(o2.items) === JSON.stringify([{ v: 'coffee:', q: 3, note: null }]), dbOrders);
check('nothing in stock moved for an order (only a bill changes stock)', (await q1(`SELECT count(*)::int AS n FROM public.hangtag_stock_moves`))[0].n === 2);
const st = async () => run('return tablesList().map(t=>t.name+":"+tableStateOf(t.id)).join(" ")');
check('the floor: T1 Preparing, T2 Preparing', (await st()) === 'T1:preparing T2:preparing', await st());

// ---------- 3. the kitchen ----------
await run('setTab("kitchen");renderAll()'); await sleep(200);
const kt = await text('#v-kitchen');
check('the kitchen sees both tickets: table, number, items, quantities, notes and time — no prices or money', /T1/.test(kt) && /T2/.test(kt) && /2 ×\s*Masala Dosa/.test(kt) && /less spicy/.test(kt) && /3 ×\s*Filter Coffee/.test(kt) && !/₹/.test(kt), kt.slice(0, 400));
for (const label of ['Accept', 'Start preparing', 'Ready']) {
  await A.click(`#v-kitchen [data-kstep="${o1.id}:${{ Accept: 'accepted', 'Start preparing': 'preparing', Ready: 'ready' }[label]}"]`); await sleep(200);
}
check('T1\'s ticket moves New → Accepted → Preparing → Ready', (await run(`return orderRepository().get("${o1.id}").status`)) === 'ready');
check('…and the floor shows T1 Ready (T2 still Preparing)', (await st()) === 'T1:ready T2:preparing', await st());
await dbUntil(`SELECT status FROM public.hangtag_orders WHERE id = '${o1.id}'`, (r) => r[0] && r[0].status === 'ready');
await run('setTab("tables");renderAll()'); await sleep(200);
if (!(await A.$(`#tablePanel[data-tpanel="${T1.id}"]`))) { await A.click(`#v-tables [data-tbl="${T1.id}"]`); await sleep(150); }
const panel = await text('#tablePanel');
check('T1\'s panel: the session (seated, by whom), its order and items, and the bill so far', /Seated/.test(panel) && /Masala Dosa/.test(panel) && /So far/.test(panel) && /₹/.test(panel) && !!(await A.$(`#tablePanel [data-tbill="${T1.id}"]`)), panel.slice(0, 300));
await A.click(`#tablePanel [data-tserve="${o1.id}"]`); await sleep(250);
check('Served: T1 Occupied (guests eating, nothing to prepare)', (await run(`return orderRepository().get("${o1.id}").status`)) === 'served' && (await st()) === 'T1:occupied T2:preparing', await st());

// ---------- 4. a guest orders from T2's QR on their phone ----------
const G = await (await browser.createBrowserContext()).newPage();
await G.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
G.on('pageerror', (e) => { fails++; console.log('[guest pageerror]', e.message); });
const guestCalls = [];
await G.setRequestInterception(true);
G.on('request', async (r) => {
  const u = r.url();
  if (u.includes('.supabase.co/rest/v1/rpc/')) {
    const fn = new URL(u).pathname.split('/').pop(), body = JSON.parse(r.postData() || '{}'), hdr = r.headers();
    guestCalls.push({ fn, auth: hdr['authorization'] || null });
    if (r.method() === 'OPTIONS') return r.respond({ status: 204, headers: CORS });
    const keys = Object.keys(body), params = keys.map((k) => (body[k] !== null && typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k]));
    try { const res = await pg.as(`SELECT public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) AS r`, params, null);
      return r.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(res.rows[0].r) }); }
    catch (e) { return r.respond({ status: 400, contentType: 'application/json', headers: CORS, body: JSON.stringify({ message: e.message }) }); }
  }
  if (u.includes('.supabase.co/')) return r.abort();
  r.continue();
});
await G.goto(`http://localhost:3210/order.html#t=${T2.qr_token}`, { waitUntil: 'networkidle0' });
const gText = () => G.$eval('#app', (e) => e.textContent);
const menuText = await gText();
check('the guest page shows the shop, the table and the menu with prices — no stock, costs or anything else of the shop', /Udupi Corner/.test(menuText) && /Table T2/.test(menuText) && /Masala Dosa/.test(menuText) && /₹120/.test(menuText)
  && !/₹45|₹12\b|stock|Stock|supplier|profit/.test(menuText), menuText.slice(0, 300));
check('…signed out (only the publishable key; no sign-in, password or service key)', guestCalls.length >= 1 && guestCalls.every((c) => !c.auth || !/service|eyJ/.test(c.auth)) && guestCalls[0].fn === 'hangtag_table_menu');
const addDosa = await G.evaluateHandle(() => [...document.querySelectorAll('.item')].find((e) => /Masala Dosa/.test(e.textContent)).querySelector('button'));
await addDosa.tap(); await sleep(150);
await G.evaluate(() => [...document.querySelectorAll('.bar button')].find((b) => /View order/.test(b.textContent)).click()); await sleep(150);
await G.type('#gname', 'Meera'); await G.type('#gnote', 'extra chutney');
await G.evaluate(() => [...document.querySelectorAll('.bar button')].find((b) => /Place order/.test(b.textContent)).click());
await sleep(800);
check('Place order → "Order sent" with its number', /Order sent/.test(await gText()) && /QR-\d{6}-001/.test(await gText()), (await gText()).slice(0, 200));
const qrOrder = await dbUntil(`SELECT id, table_id, session_id, source, status, notes, customer FROM public.hangtag_orders WHERE source = 'customer'`, (r) => r.length === 1);
check('the guest\'s order is a New table order for T2, in T2\'s open session (with the staff\'s order), priced from the catalog', qrOrder.length === 1 && qrOrder[0].table_id === T2.id && qrOrder[0].session_id === o2.session_id
  && qrOrder[0].status === 'new' && qrOrder[0].notes === 'extra chutney' && qrOrder[0].customer.name === 'Meera'
  && (await q1(`SELECT price::float AS p FROM public.hangtag_order_items WHERE order_id = '${qrOrder[0].id}'`))[0].p === 120, qrOrder);
await run('await pullOrderChanges()'); await sleep(300);
await run('setTab("kitchen");renderAll()'); await sleep(200);
check('the shop receives it: the kitchen shows it as ordered by the guests (QR)', /Ordered by the guests \(QR\)/.test(await text('#v-kitchen')) && /extra chutney/.test(await text('#v-kitchen')));

// ---------- 5. billing T1 through the ordinary bill ----------
await run('setTab("tables");renderAll()'); await sleep(200);
if (!(await A.$(`#tablePanel[data-tpanel="${T1.id}"]`))) { await A.click(`#v-tables [data-tbl="${T1.id}"]`); await sleep(150); }
await A.click(`#tablePanel [data-tbill="${T1.id}"]`); await sleep(300);
const cart = await run('return cart.map(c=>c.v+"x"+c.q+"@"+c.price).join(",")');
check('Bill → the Sell screen with T1\'s items at the order prices, marked as T1\'s bill; T1 shows Billing', cart === 'dosa:x2@120,coffee:x1@40' && /Bill of table\s*T1/.test(await text('#billPanel'))
  && (await st()).startsWith('T1:billing'), { cart, st: await st() });
const busy = await pg.as(`SELECT public.hangtag_place_table_order(p_token => $1, p_items => $2::jsonb) AS r`, [T1.qr_token, JSON.stringify([{ v: 'coffee:', q: 1 }])], null);
await sleep(100);
await dbUntil(`SELECT status FROM public.hangtag_table_sessions WHERE table_id = '${T1.id}' AND status <> 'closed'`, (r) => r.length && r[0].status === 'billing');
const busy2 = await pg.as(`SELECT public.hangtag_place_table_order(p_token => $1, p_items => $2::jsonb) AS r`, [T1.qr_token, JSON.stringify([{ v: 'coffee:', q: 1 }])], null);
check('while T1 is being billed, a guest can\'t add an order that wouldn\'t be on the bill', busy2.rows[0].r.ok === false && /being billed/.test(busy2.rows[0].r.message), { busy: busy.rows[0].r, busy2: busy2.rows[0].r });
const total = await run('return billTotals(cart,disc).total');
check('the ordinary bill: GST (5%) on the table\'s items: ₹280 + ₹14', total === 294 && (await run('return billTotals(cart,disc).tax')) === 14, total);
const stockBefore = await run('return stockOf("dosa:")');
await A.click('#billPanel [data-pay="cash"]'); await sleep(250);
await A.click('#payDone'); await sleep(600);
const sale = await dbUntil(`SELECT id, table_id, session_id, total::float AS total FROM public.hangtag_sales WHERE table_id IS NOT NULL`, (r) => r.length === 1);
check('paid: one bill in the cloud for T1 and its session', sale.length === 1 && sale[0].table_id === T1.id && sale[0].session_id === o1.session_id && sale[0].total === total, sale);
const sess = await dbUntil(`SELECT status, sale_id FROM public.hangtag_table_sessions WHERE table_id = '${T1.id}'`, (r) => r.length && r.every((s) => s.status === 'closed'));
check('…the table\'s session is closed with that bill (in the cloud too)', sess.length === 1 && sess[0].status === 'closed' && sess[0].sale_id === sale[0].id, sess);
check('…and T1 is Available again; T2 is still going (Preparing)', (await st()) === 'T1:available T2:preparing', await st());
check('the bill took the items out of stock (the bill, not the orders: 100 until it was paid)', stockBefore === 100 && (await run('return stockOf("dosa:")')) === 98, { stockBefore, after: await run('return stockOf("dosa:")') });
check('a receipt for the bill (the usual one)', /Masala Dosa/.test(await run('return receiptText(lastSale)')));

// ---------- 6. switched off: hidden, unreachable, refused (and the guest page stops) ----------
check('the owner switches Table ordering off', await run('const r=saveCapabilities({uses_tables:false});renderAll();return r.ok&&!hasCap("uses_tables")'));
await sleep(200);
await run('setTab("sell");renderAll()'); await sleep(200);
check('…Tables and Kitchen leave the navigation (the features built on tables go with it)', !(await A.$('[data-subnav="sell"] [data-tab="tables"]')) && !(await A.$('[data-subnav="sell"] [data-tab="kitchen"]'))
  && !(await A.$('.nav [data-tab="tables"]')) && !(await run('return hasCap("uses_kitchen")||hasCap("uses_table_qr")')));
await run('setTab("tables");renderAll()'); await sleep(200);
check('…the Tables screen can\'t be opened directly', (await run('return prefs.tab')) !== 'tables' && !(await A.$eval('#v-tables', (e) => !e.hidden).catch(() => false)));
check('…its use cases refuse', /doesn't use tables/.test(await run(`return (saveTable({name:"T9"})||{}).error||""`)) && /doesn't use tables/.test(await run(`return (sendTableOrder(${JSON.stringify(T2.id)},[{v:"coffee:",q:1}])||{}).error||""`)));
await run('await flushSbQueue()');
const off = await pg.as(`SELECT public.hangtag_table_menu(p_token => $1) AS r`, [T2.qr_token], null);
check('…and the server refuses the guest page too (the shop\'s settings in the cloud decide)', off.rows[0].r.ok === false, off.rows[0].r);
await run('saveCapabilities({uses_tables:true});setTab("sell");renderAll()'); await sleep(200);
check('switched back on: Tables is back in the Sell workspace', !!(await A.$('[data-subnav="sell"] [data-tab="tables"]')));

await browser.close(); await pg.db.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
