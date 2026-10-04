// Verified payments, automatic receipts, cash entries and GST filing preparation, end to end in Chrome.
// The database is PGlite running the real schema.sql behind a PostgREST stand-in (row security on). The payment-gateway
// and send-receipt Edge Functions are stubbed at their URLs and write their rows as the real ones do (service role): the
// provider "confirms" a QR on its second status check, and the database refuses a verified payment without that row.
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest, CORS } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-000000000009', EMAIL = 'owner9@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, gstin, onboarded_at) VALUES ($1,$2,'Owner','Aura Threads','9876543210','12 MG Road','Pune','Maharashtra','27ABCDE1234F1Z5',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, city = EXCLUDED.city, state = EXCLUDED.state, gstin = EXCLUDED.gstin, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);
const q = async (sql, p = []) => (await pg.as(sql, p)).rows;
const QR_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// ---------- payment-gateway, stubbed: a QR is confirmed on its second status check ----------
const gwCalls = [], checks = {};
const reply = (r, status, b) => r.respond({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(b) });
const view = (x) => ({ ok: true, id: x.id, method: x.method, kind: x.kind, status: x.status, amount: +x.amount, paidAmount: x.paid_amount == null ? null : +x.paid_amount, reference: x.reference,
  paymentId: x.provider_payment_id, qrUrl: x.qr_url, linkUrl: x.link_url, expiresAt: Date.parse(x.expires_at), saleId: x.client_sale_id, resolution: x.resolution, createdAt: Date.now() });
const one = async (id) => (await pg.db.query(`SELECT * FROM public.hangtag_payment_intents WHERE id = $1`, [id])).rows[0];
const paymentGateway = async (r) => {
  const b = JSON.parse(r.postData() || '{}'); gwCalls.push(b);
  if (b.action === 'config') return reply(r, 200, { ok: true, provider: 'razorpay', upi: true, cardLink: true });
  if (b.action === 'create') {
    const id = crypto.randomUUID(), n = gwCalls.filter((x) => x.action === 'create').length;
    await pg.db.query(`INSERT INTO public.hangtag_payment_intents (id, owner_id, client_sale_id, amount, method, kind, provider, provider_intent_id, reference, status, qr_url, link_url, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,'razorpay',$7,$7,'pending',$8,$9, now() + interval '5 minutes')`, [id, UID, b.sale_id, b.amount, b.method, b.method === 'upi' ? 'qr' : 'link', (b.method === 'upi' ? 'qr_' : 'plink_') + n, b.method === 'upi' ? QR_PNG : null, b.method === 'card' ? 'https://rzp.io/l/e2e' + n : null]);
    return reply(r, 200, view(await one(id)));
  }
  if (b.action === 'status') {
    checks[b.id] = (checks[b.id] || 0) + 1;
    const x = await one(b.id);
    if (x && x.status === 'pending' && checks[b.id] >= 2) await pg.db.query(`UPDATE public.hangtag_payment_intents SET status = 'verified', paid_amount = amount, provider_payment_id = $2 WHERE id = $1`, [b.id, 'pay_' + b.id.slice(0, 6)]);
    return reply(r, 200, view(await one(b.id)));
  }
  if (b.action === 'cancel') { await pg.db.query(`UPDATE public.hangtag_payment_intents SET status = 'cancelled' WHERE id = $1 AND status = 'pending'`, [b.id]); return reply(r, 200, view(await one(b.id))); }
  if (b.action === 'verify') {
    const p = (await pg.db.query(`SELECT * FROM public.hangtag_payments WHERE owner_id = $1 AND id = $2`, [UID, b.sale_id + ':upi'])).rows[0];
    if (!p) return reply(r, 404, { ok: false, error: 'not_found', message: "That bill isn't in the cloud yet." });
    if (b.reference !== '412345678901') return reply(r, 200, { ok: true, status: 'not_found' });
    const id = crypto.randomUUID();
    await pg.db.query(`INSERT INTO public.hangtag_payment_intents (id, owner_id, client_sale_id, amount, method, kind, provider, provider_intent_id, provider_payment_id, reference, status, paid_amount)
      VALUES ($1,$2,$3,$4,'upi','match','razorpay','pay_m1','pay_m1','pay_m1','verified',$4)`, [id, UID, b.sale_id, p.amount]);
    await pg.db.query(`UPDATE public.hangtag_payments SET verification = 'verified', intent_id = $1, provider_payment_id = 'pay_m1' WHERE owner_id = $2 AND id = $3`, [id, UID, p.id]);
    return reply(r, 200, { ok: true, status: 'verified', paymentId: 'pay_m1', intentId: id });
  }
  if (b.action === 'refund_return') {
    const ret = (await pg.db.query(`SELECT * FROM public.hangtag_returns WHERE owner_id = $1 AND id = $2`, [UID, b.return_id])).rows[0];
    if (!ret) return reply(r, 404, { ok: false, error: 'not_found', message: "That return isn't in the cloud yet." });
    if (ret.provider_refund_id) return reply(r, 200, { ok: true, status: 'refunded', refundId: ret.provider_refund_id, already: true });
    const pay = (await pg.db.query(`SELECT * FROM public.hangtag_payments WHERE owner_id = $1 AND sale_id = $2 AND method = $3`, [UID, ret.sale_id, ret.refund_method])).rows[0];
    if (!pay || pay.verification !== 'verified') return reply(r, 422, { ok: false, error: 'bad_request', message: 'Not paid through the provider.' });
    await pg.db.query(`UPDATE public.hangtag_returns SET provider_refund_id = 'rfnd_e2e' WHERE owner_id = $1 AND id = $2`, [UID, ret.id]);
    return reply(r, 200, { ok: true, status: 'refunded', refundId: 'rfnd_e2e' });
  }
  if (b.action === 'unmatched') return reply(r, 200, { ok: true, items: (await pg.db.query(`SELECT * FROM public.hangtag_payment_intents WHERE status = 'unmatched'`)).rows.map(view) });
  return reply(r, 400, { ok: false, error: 'bad_request', message: 'Unknown action.' });
};
// ---------- send-receipt, stubbed: SMS set up; automatic sends recorded once ----------
const sent = [];
const sendReceipt = async (r) => {
  const b = JSON.parse(r.postData() || '{}');
  if (b.action === 'channels') return reply(r, 200, { ok: true, channels: { email: false, whatsapp: false, sms: true } });
  if (b.action === 'refresh') return reply(r, 200, { ok: true, updated: 0 });
  if (b.action === 'link') return reply(r, 200, { ok: true, url: 'https://shop.example/receipt.html#' + 'x'.repeat(43) });
  const s = (await q(`SELECT s.id, c.phone FROM public.hangtag_sales s LEFT JOIN public.hangtag_customers c ON c.owner_id = s.owner_id AND c.id = s.customer_id WHERE s.id = $1`, [b.sale_id]))[0];
  if (!s) return reply(r, 404, { ok: false, error: 'not_found', message: "That bill isn't in the cloud yet." });
  sent.push(b);
  const to = '+91' + String(s.phone || '').replace(/\D/g, '').slice(-10);
  await pg.db.query(`INSERT INTO public.hangtag_deliveries (owner_id, sale_id, channel, recipient, status, provider, provider_message_id, mode) VALUES ($1,$2,$3,$4,'sent','twilio',$5,$6)`,
    [UID, b.sale_id, b.channel, to, 'SM' + sent.length, b.auto ? 'auto' : 'manual']);
  return reply(r, 200, { ok: true, status: 'sent', channel: b.channel, recipient: to, provider: 'twilio', provider_message_id: 'SM' + sent.length });
};

const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
const A = await (await browser.createBrowserContext()).newPage();
await A.setViewport({ width: 420, height: 900 });
A.on('pageerror', (e) => { fails++; console.log('[pageerror]', e.message); });
A.on('dialog', (d) => d.accept());
await A.setRequestInterception(true);
A.on('request', async (r) => {
  const u = r.url();
  if (u.startsWith('http://localhost:3210/')) return (u === 'http://localhost:3210/' || u.includes('/?')) ? r.respond({ status: 200, contentType: 'text/html', body: H.hookedHtml() }) : r.continue();
  if (u.includes('.supabase.co/')) { if (!(await pg.handle(r, { '/functions/v1/payment-gateway': paymentGateway, '/functions/v1/send-receipt': sendReceipt }))) r.abort(); return; }
  r.continue();
});
await A.evaluateOnNewDocument((s) => { if (location.hostname === 'localhost') localStorage.setItem('hangtag-auth', s); }, JSON.stringify(pg.session()));
await A.goto('http://localhost:3210/', { waitUntil: 'networkidle0' });
const run = (b) => A.evaluate((b) => __ev('(async()=>{' + b + '})()'), b);
async function until(cond, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run('return !!(' + cond + ')').catch(() => false)) return true; await sleep(120); } return false; }
const text = (sel) => A.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
const vis = (sel) => A.$eval(sel, (e) => !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0).catch(() => false);
const type = async (sel, v) => { await A.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, v); await sleep(80); };
check('signed in and connected', await until('sbStatus==="connected"'));

await run(`openEditor(null);editor.name="Kurta";editor.price="1000";editor.hsn="6109";edCombos()[0].cell.stock="40";saveEditor();
  settings.upiId="aura@okaxis";saveSettings();enqueue({type:"settings"});
  saveCustomer({name:"Riya",phone:"98765 43210",email:""});
  await flushSbQueue();setTab("sell");renderAll()`);
const PID = await run(`return prod(products().find(p=>p.name==="Kurta").id).variants[0].id`);
const RIYA = await run(`return Object.values(customers).find(c=>c.name==="Riya").id`);

console.log('--- UPI through the payment provider: QR → pending → verified → bill completes by itself ---');
await run(`addOne(${JSON.stringify(PID)});openPayment("upi")`);
check('the verified QR appears for the exact amount, marked Payment pending', await until(`payState&&payState.pi.upi&&payState.pi.upi.status==="pending"`) && await vis('#paySheet [data-pistate="pending"] img') && /Payment pending/.test(await text('#paySheet [data-pistate="pending"]')), await run('return {cart:cart.length,pay:!!payState,pi:payState&&payState.pi,cfg:payConfig,host:document.querySelector("#modalHost").innerHTML.slice(0,300),gw:' + JSON.stringify(gwCalls.length) + '}'));
check('showing the QR completes nothing: the Complete button stays off', await A.$eval('#payDone', (b) => b.disabled));
await A.screenshot({ path: H.ARTIFACTS + '/pcg1_upi_qr_phone.png' });
const c1 = gwCalls.find((x) => x.action === 'create');
check('the QR was asked for the bill total, for a bill id fixed before payment', c1 && c1.amount === 1000 && c1.method === 'upi' && c1.sale_id === await run('return payState.saleId'), c1);
check('the provider confirms → the bill completes with no tap', await until('lastSale&&lastSale.payments[0]&&lastSale.payments[0].verification==="verified"', 20000) && await vis('#sheetHost [data-paid]'), await run('return lastSale&&lastSale.payments'));
const S1 = await run('return lastSale');
check('…under the id the provider knows, with the provider\'s payment id', S1.id === c1.sale_id && S1.payments[0].intent && /^pay_/.test(S1.payments[0].providerRef));
await run('closeSheets();await flushSbQueue()');
const p1 = (await q(`SELECT verification, via, provider_payment_id, intent_id::text FROM public.hangtag_payments WHERE sale_id = $1`, [S1.id]))[0];
check('the cloud keeps it verified (the database checked the provider\'s record)', p1 && p1.verification === 'verified' && p1.via === 'qr' && p1.intent_id === S1.payments[0].intent, p1);
check('bank book entry labelled verified', (await q(`SELECT verification FROM public.hangtag_bank_book WHERE sale_id = $1`, [S1.id]))[0].verification === 'verified');
check('the pending payment is no longer kept for a restart', await run('return !payPending&&!localStorage.getItem("hangtag_pay_pending")'));
// a return on that bill: the refund goes back through the provider onto the same UPI payment
await run(`openReturn(${JSON.stringify(S1.id)});retState.q[0]=1;renderReturnSheet()`); await sleep(250);
check('return of a provider-paid bill: the refund can go back through the provider (on by default)', await A.$eval('#sheetHost [data-rtprov]', (e) => e.checked).catch(() => false));
await A.click('#sheetHost [data-act="rtsave"]');
const RT = await run(`return D().rets.find(r=>r.sale===${JSON.stringify(S1.id)})`);
check('refund sent through the provider once the return uploaded; its id kept on the return (here and in the cloud)', await until(`returnsMap[${JSON.stringify(RT && RT.id)}]&&returnsMap[${JSON.stringify(RT && RT.id)}].providerRefund==="rfnd_e2e"`, 15000)
  && (await q(`SELECT provider_refund_id, refund_method FROM public.hangtag_returns WHERE id = $1`, [RT.id]))[0].provider_refund_id === 'rfnd_e2e', RT);

console.log('--- UPI checked by hand: explicit receipt confirmation, optional UTR, saved unverified ---');
await run(`addOne(${JSON.stringify(PID)});openPayment("upi")`);
await until(`payState&&payState.pi.upi&&payState.pi.upi.status==="pending"`);
await A.click('[data-payvia="upi:manual"]'); await sleep(300);
check('switching to "check by hand" closes the QR at the provider', await until(`!payState.pi.upi`) && gwCalls.some((x) => x.action === 'cancel'));
check('the shop\'s own UPI QR with the amount is shown', await vis('#paySheet .pi-qr.small svg') && /aura@okaxis/.test(await text('#paySheet .payfields')));
check('before the cashier marks it received → can\'t complete (UTR is optional)', await A.$eval('#payDone', (b) => b.disabled) && /Mark the UPI payment received/.test(await text('#payErr')) && /optional/.test(await text('#paySheet .payfields')));
await type('#paySheet [data-payf="ref:upi"]', '412345678901');
check('a reference alone still cannot complete it', await A.$eval('#payDone', (b) => b.disabled));
await A.click('[data-upireceived]'); await sleep(150);
check('after “Mark payment received” it can complete', !(await A.$eval('#payDone', (b) => b.disabled)));
await A.screenshot({ path: H.ARTIFACTS + '/pcg2_upi_manual_phone.png' });
await A.click('#payDone'); await sleep(400);
const S2 = await run('return lastSale');
check('saved as UPI checked by hand: unverified', S2.payments[0].verification === 'unverified' && S2.payments[0].ref === '412345678901' && /Unverified/.test(await text('#sheetHost [data-paid]')));
await run('closeSheets();await flushSbQueue();setTab("report");renderAll()'); await sleep(300);
check('Reports → reconciliation lists it as not verified', /UPI not verified 1/.test((await text('#reconcileCard')) || ''), await text('#reconcileCard'));
await A.click('#reconcileCard [data-act="verifyupi"]');
check('"Check with the provider" matches it: verified on this device and in the cloud', await until(`D().saleById[${JSON.stringify(S2.id)}].payments[0].verification==="verified"`)
  && (await q(`SELECT verification FROM public.hangtag_payments WHERE sale_id = $1`, [S2.id]))[0].verification === 'verified');

console.log('--- card machine: reference and last 4 optional, marked received, never a card number, CVV or PIN ---');
await run(`setTab("sell");addOne(${JSON.stringify(PID)});openPayment("card")`); await sleep(400);
await type('#paySheet [data-payf="ref:card"]', '4111 1111 1111 1111');
check('a card number typed as the reference is refused', await A.$eval('#payDone', (b) => b.disabled) && /card number/.test(await text('#payErr')));
await type('#paySheet [data-payf="ref:card"]', 'APPR77'); await type('#paySheet [data-payf="last4"]', '42424242');
check('the last-4 box keeps 4 digits at most', await A.$eval('#paySheet [data-payf="last4"]', (e) => e.value) === '4242');
await A.click('#payDone'); await sleep(400);
const S3 = await run('return lastSale');
await run('closeSheets();await flushSbQueue()');
const p3 = (await q(`SELECT verification, via, card_last4, reference FROM public.hangtag_payments WHERE sale_id = $1`, [S3.id]))[0];
check('card on the machine: recorded, reference and last 4 in the cloud', p3.verification === 'recorded' && p3.via === 'terminal' && p3.card_last4 === '4242' && p3.reference === 'APPR77', p3);
// no approval number at hand: the cashier marks it received once the machine approves (nothing else is required)
await run(`setTab("sell");addOne(${JSON.stringify(PID)});openPayment("card")`); await sleep(400);
const cardLabels = await A.$$eval('#paySheet [data-payf]', (els) => els.map((e) => (e.closest('label') || e).textContent.trim()));
check('the card fields are the approval number and last 4, both optional (never a card number, CVV or PIN)', cardLabels.length === 2 && cardLabels.every((l) => /optional/.test(l)) && !cardLabels.some((l) => /card number|cvv|pin|expiry/i.test(l)), cardLabels);
check('without a reference it waits for "Mark card payment received"', await A.$eval('#payDone', (b) => b.disabled) && /Mark the card payment received/.test(await text('#payErr')));
await A.click('#paySheet [data-cardreceived]'); await sleep(150);
check('marked received: it can complete', !(await A.$eval('#payDone', (b) => b.disabled)) && (await A.$eval('#paySheet [data-cardreceived]', (b) => b.getAttribute('aria-pressed'))) === 'true');
await A.click('#payDone'); await sleep(400);
const S3b = await run('return lastSale');
await run('closeSheets();await flushSbQueue()');
const p3b = (await q(`SELECT verification, via, card_last4, reference FROM public.hangtag_payments WHERE sale_id = $1`, [S3b.id]))[0];
check('card marked received with no reference: recorded on the machine, nothing invented', S3b.id !== S3.id && p3b && p3b.verification === 'recorded' && p3b.via === 'terminal' && !p3b.reference && !p3b.card_last4, p3b);

console.log('--- the receipt goes out by itself (SMS), once ---');
await run(`settings.autoSend={whatsapp:false,sms:true,email:false};saveSettings();channels=null;await loadChannels();addOne(${JSON.stringify(PID)});pickCustomer(${JSON.stringify(RIYA)});openPayment("cash")`); await sleep(300);
check('the payment screen offers "Send the receipt" (on)', await A.$eval('#paySheet [data-paysend]', (e) => e.checked) && /SMS/.test(await text('#paySheet .paysend')));
await A.click('#payDone'); await sleep(300);
const S4 = await run('return lastSale');
check('queued straight away, sent once the bill has uploaded', await until(`deliveryQueue.some(j=>j.saleId===${JSON.stringify(S4.id)}&&j.status==="sent")`, 20000), await run('return deliveryQueue'));
check('the payment sheet says it went automatically', await until(`/sent automatically/.test(document.querySelector('#sheetHost [data-sendstate]')?.innerText||"")`));
await run('await processDeliveryQueue()');
check('one SMS for the bill, marked automatic, in the cloud', (await q(`SELECT mode, status FROM public.hangtag_deliveries WHERE sale_id = $1`, [S4.id])).map((x) => x.mode + ':' + x.status).join() === 'auto:sent' && sent.filter((b) => b.sale_id === S4.id).length === 1);
await run('closeSheets()');
await run(`addOne(${JSON.stringify(PID)});pickCustomer(${JSON.stringify(RIYA)});openPayment("cash")`); await sleep(300);
await A.click('#paySheet [data-paysend]'); await A.click('#payDone'); await sleep(1500);
const S5 = await run('return lastSale');
check('turned off for one sale: nothing is sent', !(await run(`return deliveryQueue.some(j=>j.saleId===${JSON.stringify(S5.id)})`)) && !sent.some((b) => b.sale_id === S5.id));
await run('closeSheets()');

console.log('--- a provider payment open when the app closes comes back ---');
await run(`addOne(${JSON.stringify(PID)});openPayment("upi")`);
await until(`payState&&payState.pi.upi&&payState.pi.upi.status==="pending"`);
const openId = await run('return payState.pi.upi.id');
await A.reload({ waitUntil: 'networkidle0' });
check('after reopening, the bill and its pending QR are shown again', await until('sbStatus==="connected"') && await until(`payState&&payState.pi.upi&&payState.pi.upi.id===${JSON.stringify(openId)}`) && await vis('#paySheet [data-pistate]'));
await A.click('#paySheet [data-payintent="cancel:upi"]');
check('cancel: closed at the provider, nothing charged', await until(`!payState.pi.upi`) && (await one(openId)).status === 'cancelled');
await run('payClosed();payState=null;closeModal();cart=[];saveCart();renderAll()');

console.log('--- cash without a bill, day close, reversal ---');
await run('setTab("report");renderAll()'); await sleep(300);
await A.click('[data-cashform="opening"]'); await sleep(150); await type('#cashForm [name="amount"]', '1000'); await A.click('#cashForm button[type="submit"]'); await sleep(250);
await A.click('[data-cashform="expense"]'); await sleep(150); await type('#cashForm [name="amount"]', '150');
await A.click('#cashForm button[type="submit"]'); await sleep(150);
check('an expense without its category is refused', /category/.test(await text('#cashErr') || ''), await run('return {f:cashForm,host:document.querySelector("#modalHost").innerHTML.slice(0,400)}'));
await A.select('#cashForm [name="category"]', 'Food'); await sleep(100); await type('#cashForm [name="reason"]', 'Tea for staff'); await A.click('#cashForm button[type="submit"]'); await sleep(300);
const day = await run('return dayKey(Date.now())');
const CB = await run(`return cashBookFor(${JSON.stringify(day)},${JSON.stringify(day)})`);
check('cash book: opening float and the expense, apart from sales', CB.openingFloat === 1000 && CB.expenses === 150 && CB.cashSales === 2000, CB);
await run('await flushSbQueue()');
check('both entries in the cloud', (await q(`SELECT type, amount FROM public.hangtag_cash_moves ORDER BY t`)).map((x) => x.type + ':' + +x.amount).join() === 'opening:1000,expense:150');
await A.click('[data-cashform="close"]'); await sleep(200);
check('closing the day shows the cash expected in the drawer', (await text('#cashForm [data-expected]')) === '₹2,850', await text('#cashForm [data-expected]'));
await type('#cashForm [name="counted"]', '2840'); await A.click('#cashForm button[type="submit"]'); await sleep(300); await run('await flushSbQueue()');
const dcl = (await q(`SELECT expected, counted, difference FROM public.hangtag_day_closes`))[0];
check('day closed in the cloud: expected, counted, difference', dcl && +dcl.expected === 2850 && +dcl.counted === 2840 && +dcl.difference === -10, dcl);
await run('openBook("cash")'); await sleep(200);
await run('document.querySelector("#toastHost").innerHTML=""');   // a toast can cover the bottom row
await A.click('#bookSheet [data-cashform^="reverse:"]'); await sleep(200);
await type('#cashForm [name="reason"]', 'Paid by the owner'); await A.click('#cashForm button[type="submit"]'); await sleep(300); await run('await flushSbQueue();renderAll()');
check('an entry reversed (never edited): a reversal in the cloud, and the day shows "changed after close"', (await q(`SELECT count(*)::int n FROM public.hangtag_cash_moves WHERE type = 'reversal' AND reverses IS NOT NULL`))[0].n === 1
  && /changed after close/.test(await text('.card [data-cashform="close"]').then(() => A.$eval('body', (b) => b.innerText))));

console.log('--- cancelling a bill needs a reason ---');
await run(`openBillView(${JSON.stringify(S3.id)})`); await sleep(250);
// Cancel bill is in the bill's Actions menu
await A.click(`[data-menu="bill-${S3.id}"]`); await sleep(100);
await A.click(`[data-void="${S3.id}"]`); await sleep(200);
check('the cancel form asks why', await vis('#voidForm') && (await A.$$eval('#voidForm select option', (o) => o.length)) >= 4);
await A.select('#voidForm [name="reason"]', 'Duplicate bill'); await A.click('#voidForm button[type="submit"]'); await sleep(300); await run('await flushSbQueue()');
const v = (await q(`SELECT is_void, void_reason FROM public.hangtag_sales WHERE id = $1`, [S3.id]))[0];
check('cancelled with its reason, in the cloud', v.is_void === true && v.void_reason === 'Duplicate bill', v);

console.log('--- GST filing preparation for the month ---');
await run(`gstMonthChosen(${JSON.stringify(day.slice(0, 7))})`); await sleep(300);
check('the month view: sections of the return and the checks', await vis('#gstSheet #gstMonth') && /B2C others/.test(await text('#gstSheet')) && /Documents/.test(await text('#gstSheet')) && /does not file/.test(await text('#gstSheet')));
await run(`window.__saved=[];const f=use("files");override({files:{...f,saveFile:async(n,d,t)=>{window.__saved.push({n,t,size:d.length!=null?d.length:d.size,head:typeof d==="string"?d.slice(0,20):String.fromCharCode(...d.slice(0,5))});return true}}})`);
for (const f of ['xlsx', 'pdf', 'csv', 'json']) { await A.click(`#gstSheet [data-gstexp="${f}"]`); await sleep(400); }
await A.screenshot({ path: H.ARTIFACTS + '/pcg3_gst_filing_phone.png' });
const saved = await run('return window.__saved');
check('Excel, PDF, CSV and JSON files made from the month', saved.length === 4 && saved[0].n.endsWith('.xlsx') && saved[0].head.startsWith('PK') && saved[1].head.startsWith('%PDF') && saved[2].n.endsWith('.csv') && saved[3].n.endsWith('-gstr1.json') && saved[3].head.startsWith('{'), saved);
check('each export is logged with its fingerprint and shown', (await run('return settings.gstExports.length')) === 4 && /XLSX/.test(await text('#gstSheet')));

await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
