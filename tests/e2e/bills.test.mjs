// The Bills workspace, end to end in Chrome: its place in the navigation (desktop bar and phone tab bar), every bill of the
// period with its state (paid, unpaid with what is still owed, credit, returned, cancelled), search by bill number,
// customer, phone and product, the state and period filters with their counts, the period's figures, the bill view
// (its state, what is left on the customer's account on the receipt, Print / PDF / Send and More: return, exchange,
// credit notes, cancel / restore), a payment collected later turning an unpaid bill into a settled credit bill, Open
// anything (bills, suppliers, settings) and the phone layout. The database is PGlite running the real schema.sql behind a
// PostgREST stand-in (row security on).
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-0000000000b1', EMAIL = 'ownerbills@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, gstin, onboarded_at) VALUES ($1,$2,'Owner','Aura Threads','9876543210','12 MG Road','Pune','Maharashtra','27ABCDE1234F1Z5',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, city = EXCLUDED.city, state = EXCLUDED.state, gstin = EXCLUDED.gstin, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);

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
async function until(cond, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run('return !!(' + cond + ')').catch(() => false)) return true; await sleep(120); } return false; }
const text = (sel) => A.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
const vis = (sel) => A.$eval(sel, (e) => !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0).catch(() => false);
const type = async (sel, v) => { await A.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, v); await sleep(150); };
/* the bills drawn: [{ no, chips, sub }] in order */
const rows = () => A.$$eval('#v-bills .billrow', (b) => b.map((r) => ({ no: r.querySelector('.billrow-top b').textContent, chips: [...r.querySelectorAll('.billrow-chips .chip-s')].map((c) => c.textContent.trim()), sub: r.querySelector('.billrow-end small').textContent })));
const counts = () => A.$$eval('#v-bills [data-billstatus]', (b) => Object.fromEntries(b.map((x) => [x.dataset.billstatus, +(x.querySelector('.cnt') || {}).textContent])));
check('signed in and connected', await until('sbStatus==="connected"'));

// a shop with two products, two customers and five bills: cash, part credit, another customer's, returned, cancelled
await run(`openEditor(null);editor.name="Kurta";editor.price="1000";edCombos()[0].cell.stock="40";saveEditor();
  openEditor(null);editor.name="Tee";editor.price="500";edCombos()[0].cell.stock="40";saveEditor();
  saveCustomer({name:"Riya",phone:"98765 43210",email:""});saveCustomer({name:"Arjun",phone:"91234 56789",email:""});
  closeModal();await flushSbQueue();setTab("sell");renderAll()`);
const KURTA = await run('return products().find(p=>p.name==="Kurta").variants[0].id'), TEE = await run('return products().find(p=>p.name==="Tee").variants[0].id');
const sell = (lines, pay, who) => run(`await new Promise(r=>setTimeout(r,700));${who ? `setBillCustomer(Object.values(customers).find(c=>c.name===${JSON.stringify(who)}));` : ''}
  ${JSON.stringify(lines)}.forEach(v=>addOne(v));const s=await checkout(${pay});closeModal();closeSheets();return s&&{id:s.id,no:s.no,total:s.total}`);
const S1 = await sell([KURTA], '"cash"');
const S2 = await sell([KURTA, KURTA], '[{method:"cash",amount:800},{method:"due",amount:1200}]', 'Riya');
const S3 = await sell([TEE], '"cash"', 'Arjun');
const S4 = await sell([TEE, TEE], '"cash"');
const S5 = await sell([KURTA], '"cash"');
check('five bills made with short numbers INV-000001 … INV-000005', [S1, S2, S3, S4, S5].map((s) => s && s.no).join() === 'INV-000001,INV-000002,INV-000003,INV-000004,INV-000005', [S1, S2, S3, S4, S5]);
await run(`openReturn(${JSON.stringify(S4.id)});retState.q[0]=1;renderReturnSheet()`); await sleep(250);
await A.click('#sheetHost [data-act="rtsave"]'); await sleep(400);
await run(`closeSheets();await voidSale(${JSON.stringify(S5.id)},"Duplicate bill");await flushSbQueue()`);

console.log('--- Bills in the navigation ---');
const bar = await A.$$eval('.nav .navi', (b) => b.filter((x) => x.getClientRects().length).map((x) => x.dataset.tab));
check('desktop: the workspace bar is Home · Sell · Bills · Stock · Customers · Reports (and More)', JSON.stringify(bar) === JSON.stringify(['home', 'sell', 'bills', 'stock', 'customers', 'report']) && await vis('.nav [data-navmore]'), bar);
await A.click('.nav [data-tab="bills"]'); await sleep(300);
check('Bills opens its own page, marked as the current place', await vis('#v-bills') && (await A.$eval('.nav [data-tab="bills"]', (b) => b.getAttribute('aria-current'))) === 'page');
await run('prefs.billPeriod="today";prefs.billStatus="all";savePrefs();renderAll()'); await sleep(200);

console.log('--- every bill of the period, with its state ---');
let R = await rows();
check('newest first: all five bills', R.map((r) => r.no).join() === 'INV-000005,INV-000004,INV-000003,INV-000002,INV-000001', R.map((r) => r.no));
const by = (no) => R.find((r) => r.no === no) || { chips: [], sub: '' };
check('the part-credit bill is Unpaid with what is still owed (₹1,200), never "Paid"', by('INV-000002').chips[0] === 'Unpaid' && !by('INV-000002').chips.includes('Paid') && /₹1,200 due/.test(by('INV-000002').sub), by('INV-000002'));
check('cash bills are Paid; the returned one says Returned; the cancelled one Cancelled', by('INV-000001').chips.join() === 'Paid' && by('INV-000004').chips.join() === 'Paid,Returned'
  && by('INV-000005').chips.join() === 'Cancelled', [by('INV-000001'), by('INV-000004'), by('INV-000005')]);
const C = await counts();
check('filter counts for the period: All 5, Paid 3, Unpaid 1, Credit 1, Returned 1, Cancelled 1 (no Delivery filter)', JSON.stringify(C) === JSON.stringify({ all: 5, paid: 3, unpaid: 1, credit: 1, returns: 1, cancelled: 1 }), C);
const kpi = await A.$$eval('#v-bills .bill-kpis > div', (d) => d.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
const sold = S1.total + S2.total + S3.total + S4.total;
check('the period\'s figures: 4 bills (the cancelled one left out), their sales, ₹1,200 unpaid, ₹500 returned', kpi[0] === 'Bills 4' && kpi[1] === 'Sales ₹' + sold.toLocaleString('en-IN') && kpi[2] === 'Unpaid ₹1,200' && kpi[3] === 'Returned ₹500', kpi);

console.log('--- filters, search and period ---');
const only = async (key) => { await A.click(`#v-bills [data-billstatus="${key}"]`); await sleep(200); return (await rows()).map((r) => r.no).join(); };
check('Unpaid: only the bill still owed', await only('unpaid') === 'INV-000002');
check('Credit: the bill sold on the customer\'s account', await only('credit') === 'INV-000002');
check('Returned: the bill with a return', await only('returns') === 'INV-000004');
check('Cancelled: the cancelled bill', await only('cancelled') === 'INV-000005');
check('Paid: the three paid bills', await only('paid') === 'INV-000004,INV-000003,INV-000001');
await only('all');
const found = async (q) => { await type('#billSearch', q); return (await rows()).map((r) => r.no).join(); };
check('search by bill number', await found('INV-000003') === 'INV-000003');
check('search by customer name (any case)', await found('riya') === 'INV-000002');
check('search by phone', await found('91234') === 'INV-000003');
check('search by product', await found('tee') === 'INV-000004,INV-000003');
check('the search box keeps focus and what was typed while the list redraws', (await A.evaluate(() => document.activeElement && document.activeElement.id)) === 'billSearch' && (await A.$eval('#billSearch', (e) => e.value)) === 'tee');
check('nothing found: a clear empty state', await found('zzz') === '' && /No bills found/.test(await text('#v-bills .bill-results') || ''));
await type('#billSearch', '');
await A.click('#v-bills [data-billperiod="yesterday"]'); await sleep(200);
check('Yesterday: no bills, figures for that day only', (await rows()).length === 0 && /Bills 0/.test(await text('#v-bills .bill-kpis') || ''));
await A.click('#v-bills [data-billperiod="today"]'); await sleep(200);

console.log('--- the bill view ---');
await A.click(`#v-bills [data-billview="${S2.id}"]`); await sleep(400);
check('the unpaid bill opens with its state and what is left to collect from Riya', /Unpaid/.test(await text('.billview .sh-head') || '') && !/\bPaid\b/.test(await text('.billview .billchips') || '')
  && /₹1,200 still to collect from Riya/.test(await text('.billview [data-billowed]') || ''), await text('.billview .sh-head'));
const rc = await text('.billview .rcpt-prev');
check('its receipt says what was paid and what is on the account (never "Paid" for the whole bill)', /Paid by Cash ₹800/.test(rc || '') && /Balance due \(on account\) ₹1,200/.test(rc || ''), rc);
check('Print, PDF and Send on the bar', await vis('.billview [data-print]') && await vis('.billview [data-billpdf]') && await vis('.billview [data-gosend]'));
await A.click(`.billview [data-menu="bill-${S2.id}"]`); await sleep(150);
const menu = await A.$$eval(`.billview [data-menufor="bill-${S2.id}"] [role="menuitem"]`, (b) => b.map((x) => x.querySelector('span').childNodes[0].textContent.trim()));
check('More: Return, Exchange, Share, the receipt image and Cancel bill', ['Return', 'Exchange', 'Share', 'Download receipt image', 'Cancel bill'].every((x) => menu.includes(x)), menu);
await A.click(`.billview [data-exchange="${S2.id}"]`); await sleep(300);
check('Exchange opens the return sheet on its exchange side', await run('return retState&&retState.mode==="exchange"') && await vis('#sheetHost .retsheet'));
await run('closeSheets();retState=null;closeModal()'); await sleep(150);
await run(`openBillView(${JSON.stringify(S5.id)})`); await sleep(300);
await A.click(`.billview [data-menu="bill-${S5.id}"]`); await sleep(150);
check('a cancelled bill: Cancelled, and its More menu offers Restore (not Return)', /Cancelled/.test(await text('.billview .billchips') || '') && await vis(`.billview [data-unvoid="${S5.id}"]`) && !(await A.$(`.billview [data-return="${S5.id}"]`)));
await run('closeModal()');
await run(`openBillView(${JSON.stringify(S4.id)})`); await sleep(300);
await A.click(`.billview [data-menu="bill-${S4.id}"]`); await sleep(150);
check('a returned bill lists its credit note in More', /Credit note CN-000001/.test(await text(`.billview [data-menufor="bill-${S4.id}"]`) || ''));
await run('closeModal()');

console.log('--- a payment collected later ---');
const RIYA = await run('return Object.values(customers).find(c=>c.name==="Riya").id');
const col = await run(`return collectPayment(${JSON.stringify(RIYA)},{amount:"1200",method:"cash"})`);
await run('setTab("bills");renderAll()'); await sleep(250);
R = await rows();
check('Riya pays the ₹1,200: her bill is Paid, marked as a settled credit sale; nothing unpaid', !col.error && by('INV-000002').chips.join() === 'Paid,Credit · settled' && (await counts()).unpaid === 0
  && /Unpaid ₹0/.test(await text('#v-bills .bill-kpis') || ''), [col, by('INV-000002')]);

console.log('--- Open anything ---');
await run(`saveSupplier({name:"Ravi Textiles",phone:"98111 22233",gstin:""})`);
await A.click('#globalActions [data-global="search"]'); await sleep(200);
await type('#commandSearch', 'INV-000003');
check('Open anything finds a bill by its number', /INV-000003/.test(await text('#commandResults') || '') && await vis(`#commandResults [data-billview="${S3.id}"]`));
await A.click(`#commandResults [data-billview="${S3.id}"]`); await sleep(300);
check('...and opens it', /Bill INV-000003/.test(await text('.billview .sh-head') || ''));
await run('closeModal()');
await A.click('#globalActions [data-global="search"]'); await sleep(200);
await type('#commandSearch', 'ravi');
check('finds a supplier', await vis('#commandResults [data-commandsupplier]'));
await A.click('#commandResults [data-commandsupplier]'); await sleep(350);
check('...and opens it in Stock → Suppliers', await run('return prefs.tab==="stock"&&currentSubview("stock").id==="suppliers"&&!!supplierView&&!!supplierView.id') && /Ravi Textiles/.test(await text('#v-stock') || ''));
await A.click('#globalActions [data-global="search"]'); await sleep(200);
await type('#commandSearch', 'printer');
check('finds a setting, the named one first (Receipt printer on this device, in Team & Devices)', /Receipt printer on this device/.test(await text('#commandResults [data-commandsetting]') || ''));
await A.click('#commandResults [data-commandsetting^="devices|"]'); await sleep(350);
check('...and opens its section of Settings', await run('return prefs.tab==="settings"') && await vis('#set-devices #printerForm'));
await run('setTab("bills");renderAll()'); await sleep(200);
await A.click('.nav [data-navmore]'); await sleep(250);
const more = await A.$$eval('.navsheet .navitem', (b) => b.map((x) => x.dataset.tab || x.dataset.navsub));
check('desktop More: no Hangtag Agent (it is the app bar\'s Agent button), Settings is there', !more.includes('assistant') && more.includes('settings') && await vis('#globalActions [data-tab="assistant"]'), more);
await run('closeModal()');

console.log('--- phone ---');
await A.setViewport({ width: 390, height: 844 }); await sleep(500);
await run('setTab("bills");renderAll()'); await sleep(300);
const tabs = await A.$$eval('.nav .navi.pb', (b) => b.filter((x) => x.getClientRects().length).map((x) => x.dataset.tab));
check('phone tab bar: Home · Sell · Bills · Stock and More', JSON.stringify(tabs) === JSON.stringify(['home', 'sell', 'bills', 'stock']) && await vis('.nav [data-navmore]'), tabs);
const fit = await A.evaluate(() => { const W = document.documentElement.clientWidth; return { over: document.documentElement.scrollWidth - W, out: [...document.querySelectorAll('#v-bills *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > W + 1 && !e.closest('.billfilters'); }).length }; });
check('the Bills page fits a 390 px phone (nothing sticks out; the filter chips scroll in their row)', fit.over <= 0 && fit.out === 0, fit);
const rowH = await A.$eval('#v-bills .billrow', (e) => Math.round(e.getBoundingClientRect().height));
check('bill rows are big touch targets', rowH >= 56, rowH);
await A.click(`#v-bills [data-billview="${S1.id}"]`); await sleep(400);
const tb = await A.$$eval('.billview .billtools .btnrow > *', (b) => b.map((x) => { const r = x.getBoundingClientRect(); return { h: Math.round(r.height), right: Math.round(r.right) }; }));
check('phone bill view: its actions fit the screen and are at least 44 px tall', tb.length >= 3 && tb.every((x) => x.h >= 44 && x.right <= 390), tb);

await browser.close();
await pg.close?.();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
