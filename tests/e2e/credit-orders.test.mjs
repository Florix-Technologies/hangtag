// Customer credit, held bills and the orders engine, end to end in Chrome (section 3m).
// The database is PGlite running the real schema.sql behind a PostgREST stand-in (row security on).
//   · Credit: part now + the rest on a saved customer's account (due_amount), a walk-in can't; the customer's account;
//     a refund to the account (no book entry); "Collect payment" (a collection posted to the bank book).
//   · Hold a bill (never touches stock) and recall it from Orders → Held bills (removed in the cloud).
//   · Quotation (customer, lines, discount, GST, validity) → sales order → bill (order_id) → completed; an expired
//     quotation shows expired; a save on an old version is refused (changed on another device) → sync review.
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-00000000003d', EMAIL = 'owner3m@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, gstin, onboarded_at) VALUES ($1,$2,'Owner','Aura Threads','9876543210','12 MG Road','Pune','Maharashtra','27ABCDE1234F1Z5',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, city = EXCLUDED.city, state = EXCLUDED.state, gstin = EXCLUDED.gstin, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);
const q = async (sql, p = []) => (await pg.as(sql, p)).rows;

const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
const A = await (await browser.createBrowserContext()).newPage();
await A.setViewport({ width: 420, height: 900 });
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
const type = async (sel, v) => { await A.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, v); await sleep(80); };
const choose = async (sel, v) => { await A.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); }, v); await sleep(120); };
check('signed in and connected', await until('sbStatus==="connected"'));

await run(`openEditor(null);editor.name="Kurta";editor.price="1000";editor.hsn="6109";edCombos()[0].cell.stock="40";saveEditor();
  saveCustomer({name:"Riya",phone:"98765 43210",email:""});
  await flushSbQueue();setTab("sell");renderAll()`);
const PID = await run(`return prod(products().find(p=>p.name==="Kurta").id).variants[0].id`);
const RIYA = await run(`return Object.values(customers).find(c=>c.name==="Riya").id`);

console.log('--- credit: part now, the rest on the customer\'s account ---');
await run(`addOne(${JSON.stringify(PID)});addOne(${JSON.stringify(PID)});openPayment("cash")`); await sleep(300);
await A.click('#paySheet [data-paymode="credit"]'); await sleep(250);
check('Credit on a walk-in bill: asks for a saved customer, can\'t complete', /saved customer/.test(await text('#paySheet .paycred')) && await A.$eval('#payDone', (b) => b.disabled));
await run(`payClosed();payState=null;closeModal();setBillCustomer(customers[${JSON.stringify(RIYA)}]);renderAll();openPayment("cash")`); await sleep(300);
await A.click('#paySheet [data-paymode="credit"]'); await sleep(250);
check('Credit for Riya: nothing typed = all ₹2,000 on account, and it can complete', /2,000/.test(await text('#paySheet .paycred [data-payacct]')) && !(await A.$eval('#payDone', (b) => b.disabled)));
await type('#paySheet [data-payf="amt:cash"]', '800');
check('₹800 cash now: ₹1,200 left on account', /1,200/.test(await text('#paySheet .paylive [data-payacct]')) && !(await A.$eval('#payDone', (b) => b.disabled)));
await A.screenshot({ path: H.ARTIFACTS + '/co1_payment_credit_phone.png' });
await A.click('#payDone'); await sleep(400);
const S1 = await run('return lastSale');
check('the bill: ₹800 paid in cash, ₹1,200 on account', S1.dueAmt === 1200 && S1.payments.length === 1 && S1.payments[0].amount === 800 && S1.cust.id === RIYA, S1);
await run('closeSheets();await flushSbQueue()');
const s1 = (await q(`SELECT due_amount::float AS due, payment_method AS pm, (SELECT sum(amount)::float FROM public.hangtag_payments p WHERE p.sale_id = s.id) AS paid FROM public.hangtag_sales s WHERE id = $1`, [S1.id]))[0];
check('in the cloud: due_amount 1200, payments 800', s1 && s1.due === 1200 && s1.paid === 800 && s1.pm === 'cash', s1);

console.log('--- the customer\'s account, a refund to it, collecting a payment ---');
await run(`setTab("customers");renderAll();openCustHistory(${JSON.stringify(RIYA)})`); await sleep(300);
check('Riya\'s profile: total purchases ₹2,000, paid ₹800, outstanding ₹1,200, with a Collect payment button', /2,000/.test(await text('[data-acctbuy]')) && /800/.test(await text('[data-acctpaid]')) && /1,200/.test(await text('[data-acctdue]')) && await vis('#modalHost [data-collect]'));
check('the customers list shows what she owes', /Owes ₹1,200/.test(await text('#custList')));
await run(`closeModal();openReturn(${JSON.stringify(S1.id)});retState.q[0]=1;retState.pay="due";renderReturnSheet()`); await sleep(250);
check('the return sheet offers "On account" for this bill', await vis('#sheetHost [data-rtpay="pay:due"]'));
await A.click('#sheetHost [data-act="rtsave"]'); await sleep(300);
const R1 = await run(`return D().rets.find(r=>r.sale===${JSON.stringify(S1.id)})`);
check('refunded to the account: what she owes goes down to ₹200, no book entry', R1 && R1.pay === 'due' && R1.refund === 1000 && (await run(`return accountOf(${JSON.stringify(RIYA)}).outstanding`)) === 200
  && !(await run(`return shopTransactions().some(x=>x.returnId===${JSON.stringify(R1 && R1.id)})`)), R1);
await run(`openCustHistory(${JSON.stringify(RIYA)})`); await sleep(200);
await A.click('#modalHost [data-collect]'); await sleep(250);
check('Collect payment: the amount owed is filled in', (await A.$eval('#colAmount', (e) => e.value)) === '200');
await A.evaluate(() => { document.getElementById('toastHost').innerHTML = ''; });   // the return's toast sits over the form's buttons
await A.click('#collectForm [data-colmethod="upi"]'); await sleep(200);
await A.click('#collectForm [type=submit]'); await sleep(200);
check('UPI without its reference is refused', /UTR/.test(await text('#colErr')));
await type('#colRef', '412345678901');
await A.click('#collectForm [type=submit]'); await sleep(300);
check('recorded: Riya owes nothing; the profile shows the payment', (await run(`return accountOf(${JSON.stringify(RIYA)}).outstanding`)) === 0 && /Payment · UPI/.test(await text('#modalHost .acents')));
await A.screenshot({ path: H.ARTIFACTS + '/co2_customer_account_phone.png' });
await run('closeModal();await flushSbQueue()');
const col = (await q(`SELECT c.amount::float AS a, c.method, c.verification, f.kind, b.entry_type FROM public.hangtag_collections c LEFT JOIN public.hangtag_fin_txns f ON f.id = 'ft:' || c.id LEFT JOIN public.hangtag_bank_book b ON b.fin_txn_id = f.id WHERE c.customer_id = $1`, [RIYA]))[0];
check('in the cloud: the collection, its "collection" transaction and its bank book entry', col && col.a === 200 && col.method === 'upi' && col.verification === 'unverified' && col.kind === 'collection' && !!col.entry_type, col);
check('in the cloud: the refund to the account has no transaction', (await q(`SELECT count(*)::int n FROM public.hangtag_fin_txns WHERE return_id = $1`, [R1.id]))[0].n === 0
  && (await q(`SELECT refund_method FROM public.hangtag_returns WHERE id = $1`, [R1.id]))[0].refund_method === 'due');

console.log('--- hold a bill and recall it ---');
await run(`setTab("sell");addOne(${JSON.stringify(PID)});renderAll()`); await sleep(200);
const stockBefore = await run(`return stockOf(${JSON.stringify(PID)})`);
await A.click('#billBar [data-act="openbill"]'); await sleep(300);
await A.click('#sheetHost [data-hold]'); await sleep(300);
check('held: the bill is cleared, stock unchanged, "Held (1)" shown', (await run('return cart.length')) === 0 && (await run(`return stockOf(${JSON.stringify(PID)})`)) === stockBefore && /Held \(1\)/.test(await text('#billBar')));
await run('await flushSbQueue()');
check('in the cloud: one held bill', (await q(`SELECT count(*)::int n FROM public.hangtag_held_carts`))[0].n === 1);
await A.click('#billBar [data-heldopen]'); await sleep(300);
check('Orders → Held bills lists it', await vis('#v-orders') && await vis('#ordersList [data-heldrecall]'));
await A.screenshot({ path: H.ARTIFACTS + '/co3_held_bills_phone.png' });
await A.click('#ordersList [data-heldrecall]'); await sleep(300);
check('recalled onto the Sell screen', (await run('return prefs.tab')) === 'sell' && (await run('return cart.length')) === 1 && (await run('return listHeldCarts().length')) === 0);
await run('await flushSbQueue();cart=[];disc=null;cartCust=null;saveCart();renderAll()');
check('in the cloud: removed', (await q(`SELECT count(*)::int n FROM public.hangtag_held_carts`))[0].n === 0);

console.log('--- quotation → sales order → bill ---');
await run('chooseSubview("orders","quote");setTab("orders");renderAll()'); await sleep(200);
await A.click('[data-subalt="orders"] [data-ordnew="quote"]'); await sleep(300);
await choose('#orderSheet [data-ofcust]', RIYA);
await type('#ofQ', 'kurta'); await sleep(150);
await A.click('#ofHits [data-ofadd]'); await sleep(200);
await type('#orderSheet [data-ofl="q:0"]', '3');
await type('#orderSheet [data-ofl="dv:0"]', '10');
await type('#orderSheet [data-off="notes"]', 'Blue stock only');
await type('#orderSheet [data-off="terms"]', 'Prices valid until the date shown.');
check('the editor adds it up with the one bill calculation (3 × ₹1,000 − 10%)', /2,700/.test(await text('#ofTotals')));
await A.screenshot({ path: H.ARTIFACTS + '/co4_quotation_editor_phone.png' });
await A.click('#orderSheet [data-ofsave]'); await sleep(300);
const QT = await run('return ordersOf("quote")[0]');
check('saved: QT- number, draft, valid for 15 days', QT && /^QT-/.test(QT.no) && QT.status === 'draft' && QT.validUntil > (await run('return todayKey()')) && QT.items[0].q === 3, QT);
await run('await flushSbQueue()');
const qt = (await q(`SELECT o.version, o.status, i.qty::float AS q, i.disc FROM public.hangtag_orders o JOIN public.hangtag_order_items i ON i.order_id = o.id WHERE o.id = $1`, [QT.id]))[0];
check('in the cloud: version 1, its line with the discount', qt && qt.version === 1 && qt.q === 3 && qt.disc && +qt.disc.value === 10 && (await run(`return orderById(${JSON.stringify(QT.id)}).version`)) === 1, qt);
check('quotation actions are available from the saved quotation', (await A.$$('#orderSheet [data-qdoc="preview"],#orderSheet [data-qdoc="print"],#orderSheet [data-qdoc="download"],#orderSheet [data-qdoc="send"],#orderSheet [data-ofdup]')).length === 5);
await A.$eval('#orderSheet [data-qdoc="preview"]', (b) => b.click()); await sleep(250);
// the preview shows the quotation in the shop's document template, in its own frame
await A.waitForFunction(() => { const f = document.querySelector('.qprevsheet iframe'); return !!(f && f.contentDocument && f.contentDocument.body && f.contentDocument.body.innerText.trim()); });
const preview = await A.evaluate(() => { const f = document.querySelector('.qprevsheet iframe'); return f && f.contentDocument ? f.contentDocument.body.innerText.replace(/\s+/g, ' ').trim() : null; });
// this shop charges no GST, so the quotation has no Taxable / GST columns (a GST shop's are checked in quotations.test.mjs)
check('preview is a full QUOTATION, never an invoice', /QUOTATION/.test(preview || '') && /Valid until/.test(preview || '') && /Unit price/i.test(preview || '') && /Discount/i.test(preview || '') && !/Taxable/i.test(preview || '') && /Blue stock only/.test(preview || '') && /Prices valid/.test(preview || '') && /not a bill/.test(preview || '') && !/INVOICE/.test(preview || ''), preview);
await A.click('[data-modal-close]'); await sleep(150);
await run(`openOrderEditor(${JSON.stringify(QT.id)})`); await sleep(150);
await A.click('#orderSheet [data-ofconvert]'); await sleep(300);
const SO = await run('return ordersOf("sales")[0]');
check('made a sales order: SO- number, Pending; quotation reference and terms preserved', SO && /^SO-/.test(SO.no) && SO.status === 'draft' && SO.quoteId === QT.id && SO.quoteNo === QT.no && SO.notes === 'Blue stock only' && /Prices valid/.test(SO.terms) && (await run(`return orderById(${JSON.stringify(QT.id)}).status`)) === 'converted');
check('Pending sales order cannot be billed yet', !(await A.$('#orderSheet [data-ofbill]')) && /Pending/.test(await text('#orderSheet .ostat')));
await choose('#orderSheet [data-off="status"]', 'confirmed');
await A.click('#orderSheet [data-ofsave]'); await sleep(250);
check('sales order is explicitly Confirmed before billing', (await run(`return orderById(${JSON.stringify(SO.id)}).status`)) === 'confirmed' && await A.$('#orderSheet [data-ofbill]'));
await A.click('#orderSheet [data-ofbill]'); await sleep(300);
check('billing it: the Sell screen with its lines at the order\'s price and discount, for Riya', (await run('return prefs.tab')) === 'sell' && (await run('return cart.length===1&&cart[0].q===3&&cart[0].disc.value===10&&cartCust.id')) === RIYA
  && /From sales order/.test(await run('return billPanelHTML("sheet")')));
await run('openPayment("cash")'); await sleep(300);
await A.click('#payDone'); await sleep(400);
const S2 = await run('return lastSale');
check('the bill keeps the order; the order is completed', S2.order === SO.id && (await run(`return orderById(${JSON.stringify(SO.id)}).status`)) === 'completed');
await run('closeSheets();await flushSbQueue()');
const so = (await q(`SELECT o.status, o.version, o.sale_ids, i.fulfilled_qty::float AS f, (SELECT order_id FROM public.hangtag_sales WHERE id = $2) AS sale_order FROM public.hangtag_orders o JOIN public.hangtag_order_items i ON i.order_id = o.id WHERE o.id = $1`, [SO.id, S2.id]))[0];
check('in the cloud: completed, 3 delivered, the bill listed and pointing at the order', so && so.status === 'completed' && so.f === 3 && so.sale_ids.includes(S2.id) && so.sale_order === SO.id, so);

console.log('--- expired quotations; a save on an old version ---');
await run(`saveOrder({...newOrderDraft("quote",{}),cust:{id:${JSON.stringify(RIYA)},name:"Riya"},validUntil:"2020-01-01",items:[orderLine(${JSON.stringify(PID)},1)]});chooseSubview("orders","quote");setTab("orders");renderAll()`); await sleep(300);
check('an expired quotation is shown expired, with no Bill button', /Expired/.test(await text('#ordersList')) && (await A.$$('#ordersList [data-ordbill]')).length === 0);
await run('await flushSbQueue()');
const QX = await run('return ordersOf("quote").find(o=>o.validUntil==="2020-01-01")');
// another till saves it first (version 1 → 2)
const other = await pg.as(`SELECT public.hangtag_save_order($1::jsonb, $2::jsonb) AS r`, [JSON.stringify({ id: QX.id, kind: 'quote', no: QX.no, status: 'cancelled', customer_id: RIYA, customer: { id: RIYA, name: 'Riya', phone: '' }, version: 1, t: QX.t, updated_t: Date.now(), device_id: 'till-2', valid_until: '2020-01-01', source: 'staff', sale_ids: [] }),
  JSON.stringify([{ line_no: 0, product_id: QX.items[0].p, variant_id: QX.items[0].v, name: QX.items[0].name, qty: 1, price: 1000, fulfilled_qty: 0 }])]);
check('another till changed it (version 2)', other.rows[0].r && +other.rows[0].r.version === 2, other.rows[0]);
await run(`setOrderStatus(${JSON.stringify(QX.id)},"sent");await flushSbQueue()`);
check('this till\'s change on version 1 is refused as changed on another device → sync review', await until(`syncReview.some(r=>r.item.type==="order"&&r.item.id===${JSON.stringify(QX.id)})`)
  && (await q(`SELECT status, version FROM public.hangtag_orders WHERE id = $1`, [QX.id]))[0].status === 'cancelled');
await run('await pullOrders();renderAll()');
check('the download shows the other till\'s version', (await run(`return orderById(${JSON.stringify(QX.id)}).status+":"+orderById(${JSON.stringify(QX.id)}).version`)) === 'cancelled:2');

await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
