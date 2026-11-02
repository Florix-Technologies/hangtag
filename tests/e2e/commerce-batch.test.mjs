// The commerce batch end to end in Chrome on a phone-sized screen (schema.sql section 3r): a customer's own price list
// prices the bill (the chip says so) and a bill already made keeps its prices when the list changes; a kit is sold as its
// items (stock comes off each); a purchase order changes no stock, is received in part on the Receive sheet (Ordered /
// Previously received / Receiving now / Remaining) and refuses more than is still to come; a gift voucher pays part of a
// bill on the payment screen and the rest is paid in cash; a webhook's secret is shown once and never kept on the phone.
// The database is PGlite running the real schema.sql behind a PostgREST stand-in.
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-000000000041', EMAIL = 'owner41@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, city, state, business_type, onboarded_at) VALUES ($1,$2,'Owner','Aura Electronics','9876543210','Pune','Maharashtra','electronics',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, city = EXCLUDED.city, state = EXCLUDED.state, business_type = EXCLUDED.business_type, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);
const q = async (sql, p = []) => (await pg.as(sql, p)).rows;

const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
const P = await (await browser.createBrowserContext()).newPage();
await P.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
P.on('pageerror', (e) => { fails++; console.log('[pageerror]', e.message); });
P.on('dialog', (d) => d.accept());
await P.setRequestInterception(true);
P.on('request', async (r) => {
  const u = r.url();
  if (u.startsWith('http://localhost:3210/')) return (u === 'http://localhost:3210/' || u.includes('/?')) ? r.respond({ status: 200, contentType: 'text/html', body: H.hookedHtml() }) : r.continue();
  if (u.includes('.supabase.co/')) { if (!(await pg.handle(r, {}))) r.abort(); return; }
  r.continue();
});
await P.evaluateOnNewDocument((s) => { if (location.hostname === 'localhost') localStorage.setItem('hangtag-auth', s); }, JSON.stringify(pg.session()));
await P.goto('http://localhost:3210/', { waitUntil: 'networkidle0' });
const run = (b) => P.evaluate((b) => __ev('(async()=>{' + b + '})()'), b);
const until = async (cond, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run('return !!(' + cond + ')').catch(() => false)) return true; await sleep(120); } return false; };
const text = (sel) => P.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
const vis = (sel) => P.$eval(sel, (e) => !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0).catch(() => false);
const typeIn = async (sel, v) => { await P.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, v); await sleep(80); };
const noSideScroll = () => P.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
check('signed in and connected', await until('sbStatus==="connected"'));

console.log('--- setup: capabilities, products, a supplier ---');
await run(`saveCapabilities({uses_price_lists:true,uses_vouchers:true});
  openEditor(null);editor.name="Earbuds";editor.price="500";edCombos()[0].cell.stock="20";saveEditor();
  openEditor(null);editor.name="Cable";editor.price="200";edCombos()[0].cell.stock="20";saveEditor();
  saveSupplier({name:"Ravi Traders",phone:"9876500001"});await flushSbQueue();setTab("sell");renderAll()`);
const vOf = (name) => run(`return prod(products().find(p=>p.name===${JSON.stringify(name)}).id).variants[0].id`);
const EAR = await vOf('Earbuds'), CAB = await vOf('Cable');
const SUP = await run(`return suppliersList().find(s=>s.name==="Ravi Traders").id`);
const caps = (await q(`SELECT value -> 'caps' AS c FROM public.hangtag_meta WHERE key = 'settings'`))[0];
check('price lists and vouchers switched on (in the cloud too); an electronics shop has kits and POs', caps && caps.c && caps.c.uses_price_lists === true && caps.c.uses_vouchers === true
  && await run('return hasCap("uses_bundles")&&hasCap("uses_purchase_orders")'), caps);

console.log('--- price lists ---');
const PL = await run(`const r=savePriceList({name:"Wholesale"});if(r.error)return r;const x=setItemPrice(r.list.id,"v:"+${JSON.stringify(EAR)},"450");return x.error?x:r.list.id`);
await run(`const r=saveCustomer({name:"Kiran Traders",phone:"9988776655",priceList:${JSON.stringify(PL)}});pickCustomer(r.customer.id);addOne(${JSON.stringify(EAR)});renderAll()`); await sleep(200);
check('the customer\'s own list prices the line (₹450, not ₹500)', await run('return cart.length===1&&cart[0].price===450'), await run('return cart'));
check('the bill says which prices it uses (one chip, no form)', /Wholesale · customer's/.test(await text('#billPanel .plchip') || ''), await text('#billPanel .plline'));
const s1 = await run(`const s=await checkout({method:"cash"});closeSheets();await flushSbQueue();return {id:s.id,total:s.total}`);
const li1 = (await q(`SELECT unit_price FROM public.hangtag_sale_items WHERE sale_id = $1`, [s1.id]))[0];
const cl = (await q(`SELECT c.price_list_id, l.name, l.prices FROM public.hangtag_customers c JOIN public.hangtag_price_lists l ON l.owner_id = c.owner_id AND l.id = c.price_list_id WHERE c.name = 'Kiran Traders'`))[0];
check('saved at ₹450; the list and the customer\'s link are in the cloud', s1.total === 450 && li1 && +li1.unit_price === 450 && cl && cl.name === 'Wholesale' && +cl.prices['v:' + EAR] === 450, { s1, li1, cl });
await run(`setItemPrice(${JSON.stringify(PL)},"v:"+${JSON.stringify(EAR)},"480");await flushSbQueue()`);
check('changing the list later never changes the bill already made', await run(`return D().saleById[${JSON.stringify(s1.id)}].items[0].price===450`)
  && +(await q(`SELECT unit_price FROM public.hangtag_sale_items WHERE sale_id = $1`, [s1.id]))[0].unit_price === 450);

console.log('--- a kit ---');
const KIT = await run(`const r=saveKit({name:"Starter kit",price:"600",bundle:[{v:${JSON.stringify(EAR)},q:1},{v:${JSON.stringify(CAB)},q:2}]});await flushSbQueue();return r.error?r:prod(r.product.id).variants[0].id`);
const before = await run(`return [stockOf(${JSON.stringify(EAR)}),stockOf(${JSON.stringify(CAB)})]`);
await run(`setTab("sell");renderAll()`); await sleep(150);
const kitTile = await text(`.tile[data-pid="${await run(`return vRec(${JSON.stringify(KIT)}).p.id`)}"]`);
check('the kit is on the sell screen with how many can be made from stock', !!kitTile && /Starter kit/.test(kitTile), kitTile);
const s2 = await run(`lastCheckout=0;cart.length=0;cartCust=null;addOne(${JSON.stringify(KIT)});renderAll();const s=await checkout({method:"cash"});closeSheets();await flushSbQueue();return {id:s.id,total:s.total,n:s.items.length}`);
const it2 = await q(`SELECT variant_id, quantity, line_total, kit FROM public.hangtag_sale_items WHERE sale_id = $1 ORDER BY line_no`, [s2.id]);
check('sold for ₹600 as its items: 1 earbuds + 2 cables, each line remembering the kit', s2.total === 600 && it2.length === 2 && it2[0].variant_id === EAR && +it2[1].quantity === 2
  && it2.every((l) => l.kit && l.kit.name === 'Starter kit') && Math.round(it2.reduce((a, l) => a + +l.line_total, 0)) === 600, { s2, it2 });
check('stock came off each item', await run(`return stockOf(${JSON.stringify(EAR)})===${before[0] - 1}&&stockOf(${JSON.stringify(CAB)})===${before[1] - 2}`));

console.log('--- a purchase order, received in part ---');
const ear0 = await run(`return stockOf(${JSON.stringify(EAR)})`);
const PO = await run(`const d=newPODraft({supplierId:${JSON.stringify(SUP)},items:[poLine(${JSON.stringify(EAR)},10),poLine(${JSON.stringify(CAB)},5)]});const r=savePO({...d,status:"sent"});await flushSbQueue();return r.error?r:r.po.id`);
const poRow = (await q(`SELECT status, jsonb_array_length(items) AS n FROM public.hangtag_purchase_orders WHERE id = $1`, [PO]))[0];
check('a PO of 10 earbuds and 5 cables is sent; stock is unchanged', poRow && poRow.status === 'sent' && poRow.n === 2 && await run(`return stockOf(${JSON.stringify(EAR)})===${ear0}`), poRow);
await run(`openReceive(${JSON.stringify(PO)})`); await sleep(200);
const sheet = await text('#bizSheet') || await text('.bizsheet') || await text('#sheetHost');
check('the Receive sheet: Ordered, Previously received, Receiving now and Remaining per line, starting at what is still to come',
  /Ordered 10/.test(sheet) && /Previously received 0/.test(sheet) && /Receiving now/.test(sheet) && /Remaining 0/.test(sheet), sheet);
check('…and fits the phone screen (no sideways scrolling)', await noSideScroll());
await typeIn(`[data-recvq="${EAR}"]`, '4'); await typeIn(`[data-recvq="${CAB}"]`, '0');
await P.click('[data-biz="porecvok"]'); await sleep(300); await run('await flushSbQueue()');
const rc = await q(`SELECT id, po_id, units FROM public.hangtag_stock_imports WHERE po_id = $1`, [PO]);
check('4 earbuds received: a purchase pointing at the PO, stock +4', rc.length === 1 && +rc[0].units === 4 && await run(`return stockOf(${JSON.stringify(EAR)})===${ear0 + 4}`), rc);
check('the PO shows what is still to come (6 earbuds, 5 cables)', await run(`const p=poProgressOf(poById(${JSON.stringify(PO)}));return p.lines.find(l=>l.v===${JSON.stringify(EAR)}).remaining===6&&p.lines.find(l=>l.v===${JSON.stringify(CAB)}).remaining===5`));
const over = await run(`const r=receivePO(${JSON.stringify(PO)},{[${JSON.stringify(EAR)}]:7},{},{});return r.over?r.over[0]:r`);
check('receiving 7 more (6 to come) asks first: did the supplier send extra?', over && over.remaining === 6 && over.q === 7, over);

console.log('--- a gift voucher pays part of a bill ---');
await run('closeModal();setTab("home");renderAll();document.querySelector("[data-global=quick]").click()'); await sleep(200);
await P.click('#quickActions [data-gvnew]'); await sleep(250);
check('selling a voucher starts from New (not Settings): New → Gift voucher opens it, with All vouchers beside it', /Sell a gift voucher/.test(await text('#modalHost') || '') && !!(await P.$('#modalHost [data-gvlist]'))
  && !(await run('openSettings("sales");return !!document.querySelector("#v-settings [data-gvnew],#v-settings [data-gvlist]")')));
await run('closeModal();setTab("sell");renderAll()');
const GV = await run(`const r=await issueVoucher({amount:"300",method:"cash"});return r.error?r:r.voucher`);
check('a ₹300 voucher is sold (code from the database)', GV && /^GV-/.test(GV.code) && GV.amount === 300, GV);
await run(`closeSheets();cart.length=0;cartCust=null;addOne(${JSON.stringify(EAR)});setTab("sell");renderAll()`); await sleep(150);
await P.click('#billPanel [data-pay="cash"]').catch(() => run('openPayment("cash")')); await sleep(250);
check('the payment screen has a gift voucher box', await vis('#payVoucher'));
await typeIn('#payVoucher', GV.code.toLowerCase());
await P.click('[data-payvoucher]'); await until('payState&&payState.voucher&&payState.voucher.redemption'); await sleep(150);
check('the voucher pays ₹300 and the rest (₹200) is paid below', /Gift voucher ···/.test(await text('#paySheet') || '') && /pays ₹300/.test(await text('#paySheet') || ''), await text('#paySheet'));
await P.click('#payDone'); await sleep(400);
const s3 = await run(`const s=lastSale;closeSheets();await flushSbQueue();return {id:s.id,payments:s.payments}`);
const pays = await q(`SELECT method, amount FROM public.hangtag_payments WHERE sale_id = $1 ORDER BY method`, [s3.id]);
const gv = (await q(`SELECT balance, status FROM public.hangtag_vouchers WHERE code = $1`, [GV.code]))[0];
check('saved: ₹200 cash + ₹300 voucher; the voucher is used up', JSON.stringify(pays.map((p) => [p.method, +p.amount])) === JSON.stringify([['cash', 200], ['voucher', 300]]) && gv && +gv.balance === 0 && gv.status === 'fully_redeemed', { pays, gv });
const ft = await q(`SELECT method FROM public.hangtag_fin_txns WHERE sale_id = $1`, [s3.id]);
check('the voucher part is not counted as money in (only the cash is in the books)', ft.length === 1 && ft[0].method === 'cash', ft);

console.log('--- webhooks: the secret is shown once, never kept ---');
const wh = await run(`const r=await addWebhook({url:"https://hooks.example.com/hangtag",events:["sale.completed"]},[]);return r.error?r:{id:r.endpoint.id,secret:r.secret}`);
check('the owner adds a webhook and gets its signing secret once', wh && /^whsec_[0-9a-f]{64}$/.test(wh.secret), wh);
const kept = await P.evaluate((s) => JSON.stringify(localStorage).includes(s) || JSON.stringify(sessionStorage).includes(s), wh.secret);
check('the secret is in neither the phone\'s storage nor the app\'s state', !kept && await run(`return !JSON.stringify(biz||{}).includes(${JSON.stringify(wh.secret)})`));
await run(`openSettings&&openSettings()`); await sleep(200);
check('Settings has Advanced → Integrations for the owner', /Integrations/.test(await text('#modalHost') || await text('body')));

await browser.close();
await pg.close?.();
console.log(fails ? `\n${fails} FAILED` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
