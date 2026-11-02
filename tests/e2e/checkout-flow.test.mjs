// The sale journey, end to end in Chrome: Add products → Customer (walk-in, add, or skip) → Review → Payment → Done, each
// step saying what happened to it (a sale paid straight from Cash / UPI / Card skips Customer and Review: "Skipped", never
// done), Back from the payment screen, a bill of an order keeping its customer, and the Done screen of a sale left partly
// on the customer's account (what was paid now, what is on the account, the invoice number — never "Payment successful"
// for money not taken). Voice search asks for the microphone only from the Voice tap, with its states (asking, listening,
// blocked) and messages that can be closed; and the Sell page on a phone: the categories and the Grid / List switch side
// by side, never on top of each other, products without a photo shown with a quiet placeholder. The database is PGlite
// running the real schema.sql behind a PostgREST stand-in.
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-0000000000c1', EMAIL = 'ownerco@example.com';
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
/* the steps as shown: "items:done customer:skipped review:on payment:" */
const steps = (scope) => A.$$eval(scope + ' .checkout-progress li', (l) => l.map((x) => x.dataset.step + ':' + x.className).join(' ')).catch(() => '');
check('signed in and connected', await until('sbStatus==="connected"'));
await run(`openEditor(null);editor.name="Kurta";editor.price="1000";editor.cat="Kurtas";edCombos()[0].cell.stock="40";saveEditor();
  openEditor(null);editor.name="Tee";editor.price="500";editor.cat="T-shirts";edCombos()[0].cell.stock="40";saveEditor();
  openEditor(null);editor.name="Dupatta";editor.price="700";editor.cat="Accessories";edCombos()[0].cell.stock="10";saveEditor();
  openEditor(null);editor.name="Sneakers";editor.price="2400";editor.cat="Footwear";edCombos()[0].cell.stock="6";saveEditor();
  saveCustomer({name:"Riya",phone:"98765 43210",email:""});closeModal();await flushSbQueue();setTab("sell");renderAll()`);
const KURTA = await run('return products().find(p=>p.name==="Kurta").variants[0].id');

console.log('--- guided checkout: customer skipped, review done ---');
await run(`addOne(${JSON.stringify(KURTA)});renderAll()`); await sleep(200);
await A.click('#billPanel [data-act="checkout"]'); await sleep(300);
check('Review & pay opens the Customer step: Items done, Customer now, Review and Payment to do', await steps('#modalHost') === 'items:done customer:on review: payment:');
check('the Customer step offers Walk-in, Add customer and Skip', await vis('#modalHost .checkout-choice[data-checkoutwalkin]') && await vis('#modalHost .checkout-choice[data-act="pickcust"]') && await vis('#modalHost [data-checkoutstep="skip"]'));
await A.click('#modalHost [data-checkoutstep="skip"]'); await sleep(250);
check('Skip: on to Review, Customer marked Skipped (not done)', await steps('#modalHost') === 'items:done customer:skipped review:on payment:' && /Skipped/.test(await text('#modalHost .checkout-progress li[data-step="customer"]') || ''));
check('Review shows the walk-in customer, the lines and the total', /Walk-in/.test(await text('#modalHost .checkout-who') || '') && /Kurta/.test(await text('#modalHost .checkout-lines') || '') && /1,000/.test(await text('#modalHost [data-checkouttotal]') || ''));
await A.click('#modalHost [data-checkoutpay]'); await sleep(350);
check('Continue to payment: the payment screen, Customer skipped, Review done', await vis('#paySheet') && await steps('#paySheet') === 'items:done customer:skipped review:done payment:on');
check('the payment screen names the bill by its number (no "#")', /Bill INV-0000\d\d ·/.test(await text('#paySheet .sh-t p') || '') && !/#INV/.test(await text('#paySheet .sh-t p') || ''), await text('#paySheet .sh-t p'));
await A.click('#paySheet [data-checkoutback]'); await sleep(300);
check('Back: to Review, the bill as it was (nothing paid)', await vis('#modalHost .checkout-sheet') && await steps('#modalHost') === 'items:done customer:skipped review:on payment:' && await run('return !payState&&cart.length===1'));
await A.click('#modalHost [data-checkoutstep="customer"]'); await sleep(200);
await A.click('#modalHost .checkout-choice[data-checkoutwalkin]'); await sleep(250);
check('choosing Walk-in is a decision: Customer done', await steps('#modalHost') === 'items:done customer:done review:on payment:');
await A.click('#modalHost [data-checkoutpay]'); await sleep(350);
await A.click('#payDone'); await sleep(500);
const S1 = await run('return lastSale&&{no:lastSale.no,total:lastSale.total}');
check('Done: Payment successful, the invoice number, View bill, Print, Send and New sale', /Payment successful/.test(await text('#sheetHost .paid') || '') && (await text('#sheetHost [data-paidno]')) === S1.no
  && await vis('#sheetHost [data-billview]') && await vis('#sheetHost [data-print]') && await vis('#newSaleBtn') && await vis(`#sheetHost [data-send="whatsapp:${await run('return lastSale.id')}"]`), S1);
await run('closeSheets()');

console.log('--- quick payment skips Customer and Review ---');
await run(`await new Promise(r=>setTimeout(r,700));addOne(${JSON.stringify(KURTA)});renderAll()`); await sleep(200);
await A.click('#billPanel [data-pay="cash"]'); await sleep(350);
check('Cash straight from the bill: Customer and Review are Skipped, never shown as done', await steps('#paySheet') === 'items:done customer:skipped review:skipped payment:on' && !(await A.$('#paySheet [data-checkoutback]')));
await run('payClosed();payState=null;closeModal()'); await sleep(150);

console.log('--- credit: Done says what was paid and what is on the account ---');
await run(`setBillCustomer(Object.values(customers).find(c=>c.name==="Riya"));addOne(${JSON.stringify(KURTA)});renderAll()`); await sleep(200);
await A.click('#billPanel [data-act="checkout"]'); await sleep(300);
check('a customer on the bill: the Customer step shows her, with Continue', /Riya/.test(await text('#modalHost .checkout-customer') || '') && await vis('#modalHost [data-checkoutstep="review"]'));
await A.click('#modalHost [data-checkoutstep="review"]'); await sleep(250);
await A.click('#modalHost [data-checkoutpay]'); await sleep(350);
await A.click('#paySheet [data-paymode="credit"]'); await sleep(250);
await A.$eval('#paySheet [data-payf="amt:cash"]', (e) => { e.value = '800'; e.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(200);
await A.click('#payDone'); await sleep(500);
const done = await text('#sheetHost .paid');
check('Done for a sale left partly on account: "Sale completed", ₹800 paid now, ₹1,200 on Riya\'s account — not "Payment successful"', /Sale completed/.test(done || '') && !/Payment successful/.test(done || '')
  && /₹800 paid now/.test(done || '') && /₹1,200 on Riya's account/.test(await text('#sheetHost [data-paidowed]') || ''), done);
await run('closeSheets()');

console.log('--- a bill of an order keeps its customer ---');
await run(`await new Promise(r=>setTimeout(r,700));setBillCustomer(Object.values(customers).find(c=>c.name==="Riya"));cartOrder={id:"o-test",no:"SO-000001",kind:"sales"};addOne(${JSON.stringify(KURTA)});renderAll()`); await sleep(200);
await run('openCheckout("cash")'); await sleep(250);
check('the Customer step says why, offers no Skip and no Walk-in', /keeps the order's customer/.test(await text('#modalHost [data-custneed]') || '') && !(await A.$('#modalHost [data-checkoutstep="skip"]')) && !(await A.$('#modalHost [data-checkoutwalkin]')));
await run('closeModal();checkoutFlow=null;cart=[];cartOrder=null;cartCust=null;saveCart();renderAll()'); await sleep(150);

console.log('--- voice search: the microphone asked for from the tap ---');
// a fake browser: the Permissions API says "prompt"; the prompt is answered by the test
await run(`window.__mic="deny";override({voiceInput:{available:()=>true,secure:()=>true,permission:async()=>"prompt",
  requestMic:()=>new Promise(r=>{window.__answer=r}),listen:async()=>{if(window.__mic!=="allow")throw Object.assign(new Error("denied"),{code:"denied"});return "kurta"},stop(){},canSpeak:()=>false,speak:()=>false}})`);
await A.click('.sell-search [data-voice-search="sellSearch"]'); await sleep(200);
check('tap Voice: it asks (the browser prompt is up): the button says so, nothing is red yet', (await A.$eval('[data-voice-search="sellSearch"]', (b) => b.dataset.voiceState)) === 'asking'
  && /Allow the microphone in the browser's prompt/.test(await text('#vs-sellSearch') || '') && !(await A.$('#vs-sellSearch.bad')));
await run('window.__answer("denied")'); await sleep(250);
check('refused: the button shows blocked and the message says how to allow it, with a close button', (await A.$eval('[data-voice-search="sellSearch"]', (b) => b.dataset.voiceState)) === 'blocked'
  && /blocked/.test(await text('#vs-sellSearch') || '') && await vis('#vs-sellSearch [data-voice-dismiss]'));
await A.click('#vs-sellSearch [data-voice-dismiss]'); await sleep(150);
check('the message closes (no warning left on screen)', !(await vis('#vs-sellSearch')));
await run('window.__mic="allow"'); await A.click('.sell-search [data-voice-search="sellSearch"]'); await sleep(150);
await run('window.__answer("granted")'); await sleep(400);
check('allowed: it listens and the words go in the search box', (await A.$eval('#sellSearch', (e) => e.value)) === 'kurta' && (await A.$eval('[data-voice-search="sellSearch"]', (b) => b.dataset.voiceState)) === 'idle');
await run('const i=document.getElementById("sellSearch");i.value="";i.dispatchEvent(new Event("input",{bubbles:true}))');

console.log('--- the Sell page on a phone ---');
for (const w of [320, 375]) {
  await A.setViewport({ width: w, height: 760 }); await sleep(450);
  await run('setTab("sell");renderAll()'); await sleep(250);
  const L = await A.evaluate(() => { const r = (s) => { const e = document.querySelector(s).getBoundingClientRect(); return { l: Math.round(e.left), r: Math.round(e.right), t: Math.round(e.top), b: Math.round(e.bottom) }; };
    return { over: document.documentElement.scrollWidth - document.documentElement.clientWidth, toggle: r('.view-toggle'), cats: r('#sellCats'), search: r('.search-input-wrapper') }; });
  check(`${w} px: the categories and Grid / List sit side by side, never overlapping; nothing scrolls sideways`, L.over <= 0 && L.cats.r <= L.toggle.l && L.toggle.r <= w && L.search.r <= w
    && L.toggle.t < L.cats.b && L.cats.t < L.toggle.b, L);
}
const ph = await A.$eval(`#grid .tile[data-pid="${await run('return products().find(p=>p.name==="Kurta").id')}"] .ph`, (e) => ({ noimg: e.classList.contains('noimg'), glyph: !!e.querySelector('.ph-glyph'), ini: (e.querySelector('.ini') || {}).textContent, size: parseFloat(getComputedStyle(e.querySelector('.ini')).fontSize) }));
check('a product without a photo: a quiet placeholder (tag glyph and small initials), not a big letter block', ph.noimg && ph.glyph && ph.ini === 'K' && ph.size <= 14, ph);

await browser.close();
await pg.close?.();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
