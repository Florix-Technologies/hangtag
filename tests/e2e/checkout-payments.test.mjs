// Discounts, GST, payments and the money books, end to end in Chrome against the real schema.sql (PGlite behind a
// PostgREST stand-in, as the signed-in user with row-level security): line and bill discounts, CGST + SGST and IGST,
// cash with change, UPI and card with references, split payments, walk-in and customer bills, phone and desktop, the
// saved bill / payments / financial transactions / cash and bank book rows, cancelling and restoring, returns and
// exchanges, receipts, reports, and a second device downloading the same money.
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 500) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-000000000001', EMAIL = 'owner@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, city, state, gstin, onboarded_at) VALUES ($1,$2,'Owner','Owner Shop','9876543210','Pune','Maharashtra','27ABCDE1234F1Z5',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, city = EXCLUDED.city, state = EXCLUDED.state, gstin = EXCLUDED.gstin, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);
const q = async (sql) => (await pg.as(sql, [])).rows;
const num = (v) => (v == null ? null : +v);

const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
async function device(label) {
  const p = await (await browser.createBrowserContext()).newPage();
  await p.setViewport({ width: 1280, height: 900 });
  p.on('pageerror', (e) => { fails++; console.log(`[${label} pageerror]`, e.message); });
  await p.setRequestInterception(true);
  p.on('request', async (r) => {
    const u = r.url();
    if (u.startsWith('http://localhost:3210/')) return (u === 'http://localhost:3210/' || u.includes('/?')) ? r.respond({ status: 200, contentType: 'text/html', body: H.hookedHtml() }) : r.continue();
    if (u.includes('.supabase.co/')) { if (!(await pg.handle(r))) r.abort(); return; }
    r.continue();
  });
  await p.evaluateOnNewDocument((s) => { if (location.hostname === 'localhost') localStorage.setItem('hangtag-auth', s); }, JSON.stringify(pg.session()));
  await p.goto('http://localhost:3210/', { waitUntil: 'networkidle0' });
  return p;
}
const A = await device('A');
const run = (p, b) => p.evaluate((b) => __ev('(async()=>{' + b + '})()'), b);
async function until(p, cond, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run(p, 'return !!(' + cond + ')').catch(() => false)) return true; await sleep(100); } return false; }
const text = (p, sel) => p.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
const vis = (p, sel) => p.$eval(sel, (e) => !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0).catch(() => false);
async function typeIn(p, sel, v) { await p.focus(sel); await p.$eval(sel, (e) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); }); if (v !== '') await p.type(sel, String(v)); await sleep(80); }
check('signed in and connected to the (stand-in) cloud', await until(A, 'sbStatus==="connected"'), await run(A, 'return sbStatus'));

// products: a Tee with its own 5% GST and HSN, and a Cap without a rate (the shop's 5%); GST on, added on top of prices
await run(A, `openEditor(null);editor.name="Tee";editor.price="999";editor.hsn="6109";editor.gst="5";edCombos()[0].cell.stock="20";saveEditor();
  openEditor(null);editor.name="Cap";editor.price="500";edCombos()[0].cell.stock="20";saveEditor();
  settings.taxOn=true;settings.taxRate=5;settings.taxIncl=false;saveSettings();enqueue({type:"settings"});await flushSbQueue();setTab("sell");renderAll()`);
const vOf = (name) => run(A, `return prod(products().find(p=>p.name===${JSON.stringify(name)}).id).variants[0].id`);
const TEE = await vOf('Tee'), CAP = await vOf('Cap');

// ---------- 1. desktop, walk-in: line discount, bill discount, CGST + SGST, split cash + UPI ----------
await run(A, `addOne(${JSON.stringify(TEE)});addOne(${JSON.stringify(TEE)});addOne(${JSON.stringify(CAP)});renderAll()`); await sleep(150);
await A.click('#billPanel [data-linedisc="0"]'); await sleep(150);
check('line discount: the sheet opens on "% off" for that line', await vis(A, '#ldSheet') && /Tee · 2 × ₹999 = ₹1,998/.test(await text(A, '#ldSheet .sh-t p')) && (await A.$eval('[data-ldtype="percent"]', (b) => b.getAttribute('aria-pressed'))) === 'true');
await A.type('#ldVal', '150'); await sleep(100);
check('line discount: over 100% is explained and not applied', /more than 100%/.test(await text(A, '#ldErr')));
await typeIn(A, '#ldVal', '10');
check('line discount: the preview shows the new line amount', /₹199\.80 off · line becomes ₹1,798\.20/.test(await text(A, '#ldPrev')), await text(A, '#ldPrev'));
await A.click('[data-act="ldapply"]'); await sleep(200);
check('line discount applied: the line shows it and its new amount', /10% off · −₹199\.80/.test(await text(A, '#billPanel [data-ldisc="0"]')) && /₹1,998 ₹1,798\.20/.test(await text(A, '#billPanel [data-lineamt="0"]')), await text(A, '#billPanel [data-lineamt="0"]'));
await A.type('#disc_panel', '5000'); await sleep(150);
check('bill discount too big: the reason shows and payment waits', /Bill discount: A discount can't be more than ₹2,298\.20\./.test(await text(A, '#billPanel [data-discerr]')) && await A.$eval('#billPanel [data-pay="cash"]', (b) => b.disabled));
await typeIn(A, '#disc_panel', '50'); await A.click('#billPanel .bp-title'); await sleep(150);
const sum = await text(A, '#billPanel .bp-foot');
check('the bill shows subtotal, item discounts, bill discount, taxable amount, CGST 2.5%, SGST 2.5%, round off and total',
  /Subtotal ₹2,498/.test(sum) && /Item discounts −₹199\.80/.test(sum) && /Bill discount −₹50/.test(sum) && /Taxable amount ₹2,248\.20/.test(sum) && /CGST 2\.5% ₹56\.21/.test(sum) && /SGST 2\.5% ₹56\.21/.test(sum) && /Round off \+₹0\.38/.test(sum) && /Total ₹2,361/.test(sum), sum);
check('the pay buttons work again once the discount fits', !(await A.$eval('#billPanel [data-pay="cash"]', (b) => b.disabled)));
await A.click('#billPanel [data-pay="cash"]'); await sleep(200);
const ps = await text(A, '#paySheet .paysum');
check('payment screen: subtotal, discount, taxable amount, GST and grand total', /Subtotal ₹2,498/.test(ps) && /Item discounts −₹199\.80/.test(ps) && /Taxable amount ₹2,248\.20/.test(ps) && /CGST 2\.5% ₹56\.21/.test(ps) && /Grand total ₹2,361/.test(ps), ps);
check('payment screen: Paid, Balance and Change are always shown', /Paid ₹2,361 Balance ₹0 Change ₹0/.test(await text(A, '#payLive .paylive')), await text(A, '#payLive'));
await A.click('[data-paymode="split"]'); await sleep(150);
await typeIn(A, '[data-payf="amt:cash"]', '1000'); await typeIn(A, '[data-payf="recv"]', '1200');
check('split: underpaid — the balance shows and Complete waits', /Balance ₹1,361/.test(await text(A, '#payLive')) && /₹1,361 still to pay\./.test(await text(A, '#payErr')) && await A.$eval('#payDone', (b) => b.disabled), await text(A, '#payLive'));
await typeIn(A, '[data-payf="amt:card"]', '1500');
check('split: overpaid — refused (only cash gives change)', /₹139 more than the bill/.test(await text(A, '#payErr')) && await A.$eval('#payDone', (b) => b.disabled), await text(A, '#payErr'));
await typeIn(A, '[data-payf="amt:card"]', '');
await A.click('[data-payrest="upi"]'); await sleep(150);
await A.type('[data-payf="ref:upi"]', '412345678901'); await sleep(100);
check('split: "Rest" puts the balance on UPI; paid in full, change ₹200', /Paid ₹2,361 Balance ₹0 Change ₹200/.test(await text(A, '#payLive .paylive')) && (await A.$eval('[data-payf="amt:upi"]', (i) => i.value)) === '1361' && !(await A.$eval('#payDone', (b) => b.disabled)));
await A.screenshot({ path: H.ARTIFACTS + '/pay1_split_desktop.png' });
await A.click('#payDone'); await sleep(300);
check('sale completed: Payment successful, the split and the change to give', await vis(A, '#sheetHost [data-paid]') && /Cash ₹1,000 \+ UPI ₹1,361/.test(await text(A, '.paid-sub')) && /Give change ₹200/.test(await text(A, '[data-change]')), await text(A, '.paid-sub'));
check('the bill is emptied (discounts too) for the next sale', await run(A, 'return cart.length===0&&disc===null'));
const s1 = await run(A, 'return lastSale');
await run(A, 'closeSheets();await flushSbQueue()');
const row1 = (await q(`SELECT * FROM public.hangtag_sales WHERE id='${s1.id}'`))[0];
check('saved: subtotal, both discounts, taxable amount, CGST + SGST, round off, total, "split"',
  row1 && row1.subtotal === 2498 && num(row1.discount) === 249.8 && num(row1.item_discount) === 199.8 && num(row1.bill_discount) === 50 && num(row1.taxable_amount) === 2248.2
  && num(row1.cgst_amount) === 56.21 && num(row1.sgst_amount) === 56.21 && num(row1.igst_amount) === 0 && num(row1.round_off) === 0.38 && row1.total === 2361 && row1.gst_mode === 'intra' && row1.place_of_supply === '27' && row1.payment_method === 'split', row1);
const it1 = await q(`SELECT line_no, discount_type, discount_value, discount_amount, bill_discount_share, gst_rate, hsn, line_total FROM public.hangtag_sale_items WHERE sale_id='${s1.id}' ORDER BY line_no`);
check('saved lines: the line discount, each line\'s share of the bill discount, its GST rate and HSN', it1.length === 2 && it1[0].discount_type === 'percent' && num(it1[0].discount_value) === 10 && num(it1[0].discount_amount) === 199.8
  && Math.round((num(it1[0].bill_discount_share) + num(it1[1].bill_discount_share)) * 100) === 5000 && num(it1[0].gst_rate) === 5 && it1[0].hsn === '6109', it1);
const pay1 = await q(`SELECT id, method, amount, tendered, change_given, reference, status FROM public.hangtag_payments WHERE sale_id='${s1.id}' ORDER BY method`);
check('saved payments: cash ₹1,000 (₹1,200 handed over, ₹200 change) and UPI ₹1,361 with its reference', JSON.stringify(pay1.map((p) => [p.id, p.method, num(p.amount), num(p.tendered), num(p.change_given), p.reference, p.status]))
  === JSON.stringify([[s1.id + ':cash', 'cash', 1000, 1200, 200, null, 'completed'], [s1.id + ':upi', 'upi', 1361, null, 0, '412345678901', 'completed']]), pay1);
check('the database posted a transaction per payment, one cash book and one bank book entry',
  (await q(`SELECT count(*)::int n FROM public.hangtag_fin_txns WHERE sale_id='${s1.id}' AND status='posted'`))[0].n === 2
  && JSON.stringify((await q(`SELECT id, num_nonnulls(amount_in) a, amount_in, cash_received, change_given FROM public.hangtag_cash_book WHERE sale_id='${s1.id}'`)).map((c) => [c.id, num(c.amount_in), num(c.cash_received), num(c.change_given)])) === JSON.stringify([['cb:ft:' + s1.id + ':cash', 1000, 1200, 200]])
  && (await q(`SELECT reference FROM public.hangtag_bank_book WHERE sale_id='${s1.id}'`))[0].reference === '412345678901');
const rt = await run(A, `return receiptText(D().saleById[${JSON.stringify(s1.id)}])`);
check('receipt: discount, CGST, SGST, round off, total, the split and the change', /Discount: −₹249\.80/.test(rt) && /CGST 2\.5%: ₹56\.21/.test(rt) && /SGST 2\.5%: ₹56\.21/.test(rt) && /Round off: \+₹0\.38/.test(rt)
  && /\*Total: ₹2,361\*/.test(rt) && /Paid: Cash ₹1,000 \+ UPI ₹1,361/.test(rt) && /Change: ₹200/.test(rt), rt);

// ---------- 2. a business customer from Karnataka: IGST, card with its reference ----------
await sleep(700);
await run(A, `const r=saveCustomer({name:"Blr Traders",gstin:"29ABCDE1234F1Z5",type:"business"});pickCustomer(r.customer.id);addOne(${JSON.stringify(CAP)});renderAll()`); await sleep(150);
check('customer from another state: the bill shows IGST 5% instead of CGST + SGST', /IGST 5% ₹25/.test(await text(A, '#billPanel .bp-foot')) && !/CGST/.test(await text(A, '#billPanel .bp-foot')), await text(A, '#billPanel .bp-foot'));
await A.click('#billPanel [data-pay="card"]'); await sleep(150);
await A.type('[data-payf="ref:card"]', 'APPR 0042'); await A.click('#payDone'); await sleep(300);
const s2 = await run(A, 'return lastSale');
await run(A, 'closeSheets();await flushSbQueue()');
const row2 = (await q(`SELECT gst_mode, igst_amount, cgst_amount, place_of_supply, customer_gstin, customer_type, total, customer_name FROM public.hangtag_sales WHERE id='${s2.id}'`))[0];
check('saved: IGST, place of supply 29, the customer\'s GSTIN and type', row2.gst_mode === 'inter' && num(row2.igst_amount) === 25 && num(row2.cgst_amount) === 0 && row2.place_of_supply === '29'
  && row2.customer_gstin === '29ABCDE1234F1Z5' && row2.customer_type === 'business' && row2.total === 525 && row2.customer_name === 'Blr Traders', row2);
check('card payment in the bank book with its reference', (await q(`SELECT method, reference, amount_in FROM public.hangtag_bank_book WHERE sale_id='${s2.id}'`)).map((b) => [b.method, b.reference, num(b.amount_in)]).join() === 'card,APPR 0042,525');
check("the customer's history shows the bill and how it was paid", await run(A, `const h=purchaseHistory(customers[Object.keys(customers)[0]].id);return h.count===1&&h.bills[0].pay==="Card"&&h.bills[0].total===525`));

// ---------- 3. the existing checkout(method) API still pays the whole bill in one method ----------
await sleep(700);
const api = await run(A, `addOne(${JSON.stringify(CAP)});const s=await checkout({method:"upi",ref:"412345678901"});closeSheets();await flushSbQueue();return {pay:s.pay,payments:s.payments,total:s.total,cust:s.cust}`);
check('checkout({ method: "upi", ref }) still pays the whole bill in one method: one UPI payment for the total, walk-in', api.pay === 'upi' && api.payments.length === 1 && api.payments[0].amount === api.total && api.total === 525 && api.cust === null, api);

// ---------- 4. phone: bill sheet → UPI with reference; cash with a quick amount and change ----------
await A.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true }); await sleep(1000);   // (reloads the page)
check('phone: connected again after the reload', await until(A, 'sbStatus==="connected"'));
await sleep(700);
await run(A, `setTab("sell");addOne(${JSON.stringify(TEE)});renderAll()`); await sleep(150);
await A.click('#billBar [data-act="openbill"]'); await sleep(250);
check('phone: the bill sheet shows the GST rows and the discount box', /CGST 2\.5%/.test(await text(A, '#sheetHost .bp-foot')) && await vis(A, '#disc_sheet'));
await A.click('#sheetHost [data-disctype="percent"]'); await sleep(150);
await A.type('#disc_sheet', '10'); await sleep(150);
check('phone: 10% bill discount', /Bill discount 10% −₹99\.90/.test(await text(A, '#sheetHost [data-billsum]')), await text(A, '#sheetHost [data-billsum]'));
await A.tap('#sheetHost [data-pay="upi"]'); await sleep(250);
check('phone: the payment screen opens on UPI over the bill', await vis(A, '#paySheet') && (await A.$eval('[data-paymode="upi"]', (b) => b.getAttribute('aria-pressed'))) === 'true');
await A.screenshot({ path: H.ARTIFACTS + '/pay2_upi_phone.png' });
await A.type('[data-payf="ref:upi"]', 'UTR 998877'); await A.tap('#payDone'); await sleep(300);
check('phone: UPI sale done', await vis(A, '#sheetHost [data-paid]') && /UPI · ref UTR 998877/.test(await text(A, '.paid-sub')), await text(A, '.paid-sub'));
await run(A, 'closeSheets()'); await sleep(700);
await run(A, `addOne(${JSON.stringify(CAP)});renderAll()`); await sleep(150);
await A.tap('#billBar [data-pay="cash"]'); await sleep(250);
const chips = await A.$$eval('[data-payquick]', (b) => b.map((x) => x.textContent));
check('phone: quick cash amounts above the bill (₹525)', chips.join() === '₹600,₹1,000,₹2,000', chips);
await A.tap('[data-payquick="600"]'); await sleep(150);
check('phone: ₹600 handed over → change ₹75', /Change ₹75/.test(await text(A, '#payLive')));
await A.screenshot({ path: H.ARTIFACTS + '/pay3_cash_phone.png' });
await A.tap('#payDone'); await sleep(300);
check('phone: cash sale done, change to give shown', /Give change ₹75/.test(await text(A, '[data-change]')));
await run(A, 'closeSheets();await flushSbQueue()');
await A.setViewport({ width: 1280, height: 900 }); await sleep(1000);
await until(A, 'sbStatus==="connected"');

// ---------- 5. cancel and restore a bill ----------
const st = async (id) => (await q(`SELECT (SELECT string_agg(DISTINCT status, ',') FROM public.hangtag_payments WHERE sale_id='${id}') p, (SELECT string_agg(DISTINCT status, ',') FROM public.hangtag_fin_txns WHERE sale_id='${id}') f,
  (SELECT string_agg(DISTINCT status, ',') FROM public.hangtag_bank_book WHERE sale_id='${id}') b`))[0];
await run(A, `await voidSale(${JSON.stringify(s2.id)},"Wrong items or price");await flushSbQueue()`);
check('cancelling a bill: its payment, transaction and bank entry are marked cancelled', JSON.stringify(await st(s2.id)) === JSON.stringify({ p: 'cancelled', f: 'cancelled', b: 'cancelled' }), await st(s2.id));
check('…and the app leaves it out of the bank book too', await run(A, `const R=periodRange();return bankBookFor(R.from,R.to).entries.find(e=>e.saleId===${JSON.stringify(s2.id)}).status==="cancelled"`));
await run(A, `await unvoid(${JSON.stringify(s2.id)});await flushSbQueue()`);
check('restoring it posts them again', JSON.stringify(await st(s2.id)) === JSON.stringify({ p: 'completed', f: 'posted', b: 'posted' }), await st(s2.id));

// ---------- 6. returns and exchanges still work, and their refunds reach the books ----------
await run(A, `openReturn(${JSON.stringify(s1.id)});retState.q[1]=1;retState.pay="cash";renderReturnSheet();saveReturn();await flushSbQueue()`);
const ret1 = await run(A, `return Object.values(returnsMap).find(r=>r.sale===${JSON.stringify(s1.id)})`);
check('return the Cap: refund = the paise-exact saved line value (after its discount share, with GST)', ret1 && ret1.refund === 513.58 && ret1.pay === 'cash', ret1);
check('the refund leaves the cash book (database)', num((await q(`SELECT amount_out FROM public.hangtag_cash_book WHERE id='cb:ft:${ret1.id}'`))[0].amount_out) === 513.58);
await run(A, `openReturn(${JSON.stringify(s1.id)});retState.mode="exchange";retState.q[0]=1;addToLines(retState.newItems,${JSON.stringify(CAP)},1);retState.pay="upi";renderReturnSheet();saveReturn();closeSheets();await flushSbQueue()`);
const ex = await run(A, 'return lastSale');
const exRet = await run(A, `return Object.values(returnsMap).find(r=>r.kind==="exchange")`);
check('exchange a Tee for a Cap: the new bill is covered by the credit, the difference refunded by UPI', ex.kind === 'exchange' && ex.credit === 525 && ex.payments.length === 0 && exRet.refund === exRet.value - 525 && exRet.pay === 'upi', { ex: [ex.kind, ex.credit, ex.payments], exRet });
check('the exchange bill is saved with no payments and its refund is in the bank book', (await q(`SELECT count(*)::int n FROM public.hangtag_payments WHERE sale_id='${ex.id}'`))[0].n === 0
  && num((await q(`SELECT amount_out FROM public.hangtag_bank_book WHERE id='bb:ft:${exRet.id}'`))[0].amount_out) === exRet.refund);

// ---------- 7. reports: payment mix, cash book and bank book ----------
await run(A, 'prefs.period="today";setTab("report");renderReport()'); await sleep(300);
check('Reports shows a Cash book and a Bank book', /Cash book/.test(await text(A, '#repBody')) && /Bank book/.test(await text(A, '#repBody')) && !!(await A.$('[data-book="cash"]')));
await A.click('[data-book="cash"]'); await sleep(200);
const cbView = await text(A, '#bookSheet');
const app = await run(A, 'const R=periodRange();const c=cashBookFor(R.from,R.to);return {closing:c.closing,sales:c.cashSales,refunds:c.refunds,n:c.entries.length}');
const dbCash = (await q(`SELECT COALESCE(sum(amount_in - amount_out), 0) b, count(*)::int n FROM public.hangtag_cash_book WHERE status = 'posted'`))[0];
check('cash book: the app and the database agree on the balance and the entries', app.closing === num(dbCash.b) && app.n === dbCash.n && app.closing === 1000 + 525 - 513.58, { app, dbCash });
check('cash book view: opening, the cash sales with received / change, the refund and the closing balance', /Opening balance ₹0/.test(cbView) && /received ₹1,200, change ₹200/.test(cbView) && /Cash refund/.test(cbView) && /Closing balance ₹1,011/.test(cbView), cbView);
await A.screenshot({ path: H.ARTIFACTS + '/pay4_cashbook.png' });
await run(A, 'closeModal()'); await A.$eval('[data-book="bank"]', (b) => b.scrollIntoView({ block: 'center' })); await A.click('[data-book="bank"]'); await sleep(200);
const bkView = await text(A, '#bookSheet');
const bank = await run(A, 'const R=periodRange();const b=bankBookFor(R.from,R.to);return {upi:b.upiIn,card:b.cardIn,refunds:b.refunds,net:b.net}');
const dbBank = (await q(`SELECT COALESCE(sum(amount_in) FILTER (WHERE method='upi'), 0) upi, COALESCE(sum(amount_in) FILTER (WHERE method='card'), 0) card, COALESCE(sum(amount_out), 0) out FROM public.hangtag_bank_book WHERE status = 'posted'`))[0];
check('bank book: UPI and card receipts and refunds agree with the database', bank.upi === num(dbBank.upi) && bank.card === num(dbBank.card) && bank.refunds === num(dbBank.out), { bank, dbBank });
check('bank book view: the UPI reference and the card slip number', /ref 412345678901/.test(bkView) && /ref APPR 0042/.test(bkView), bkView);
await run(A, 'closeModal()');
const mix = await text(A, '#repBody .lgd');
check('payment mix counts each part of a split under its own method', /Cash.*₹1,011/.test(mix), mix);
check('every bill reconciles: posted receipts = amount due', await run(A, 'return D().sales.every(s=>billMoney(s).ok)'));

// ---------- 8. a second device downloads the same bills, payments and books ----------
const B = await device('B');
check('device 2 connects', await until(B, 'sbStatus==="connected"&&D().sales.length>=6', 20000), await run(B, 'return D().sales.length'));
const txA = await run(A, 'return shopTransactions().map(x=>[x.id,x.amount,x.status].join(":")).sort().join()');
const txB = await run(B, 'return shopTransactions().map(x=>[x.id,x.amount,x.status].join(":")).sort().join()');
check('device 2 derives the same financial transactions (split payments, refunds, statuses)', txA === txB && txA.length > 0, { txA, txB });
const rtB = await run(B, `return receiptText(D().saleById[${JSON.stringify(s1.id)}])`);
check('device 2 prints the same receipt (discounts, GST split, round off, payments)', rtB === rt, rtB);
await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
