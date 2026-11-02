// The cashier on a phone (390 × 844), from payment to the customer's receipt, end to end in Chrome. The database is PGlite
// running the real schema.sql behind the PostgREST stand-in (row security on); the send-receipt Edge Function is stubbed
// at its URL (it keeps one invoice PDF per bill and answers as the real one does). Nothing reaches a real provider.
// - Payment: no box takes the focus on opening or on changing the method (a focused box opens the phone's keyboard);
//   cash shows the exact amount filled in ("Exact"), quick amounts give the change at once; the method, the total and
//   Complete sale stay in view; a double tap on Complete sale makes one sale.
// - Checkout's Customer step: Search customer, Add customer, Walk-in.
// - After the sale: the invoice number and amount; what each channel carries (the invoice PDF attached, as a document,
//   or a link to download it); a walk-in bill gets the customer's contact added and is sent — the same bill, no new
//   sale; email, WhatsApp and SMS all carry the one invoice (registered once); a failed SMS is tried again on its own.
// Run: node tests/run.mjs tests/e2e/pos-billing-delivery.test.mjs
import puppeteer from 'puppeteer-core';
import crypto from 'node:crypto';
import H from '../helpers/env.mjs';
import { createPgRest, CORS } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 500) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-000000000002', EMAIL = 'owner@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, gstin, onboarded_at) VALUES ($1,$2,'Owner','Sunrise Garments','9876543210','12 MG Road','Bengaluru','Karnataka','29ABCDE1234F1Z5',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, address = EXCLUDED.address, city = EXCLUDED.city, state = EXCLUDED.state, gstin = EXCLUDED.gstin, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);
const q = async (sql) => (await pg.as(sql, [])).rows;

// ---------- send-receipt, stubbed: one invoice PDF per bill; the first SMS is refused by its provider ----------
const fnCalls = [], invoices = {};
let smsRefusals = 1;
const sendReceipt = async (r) => {
  const body = JSON.parse(r.postData() || '{}'); fnCalls.push(body);
  const reply = (status, b) => r.respond({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(b) });
  if (body.action === 'channels') return reply(200, { ok: true, channels: { email: true, whatsapp: true, sms: true, whatsapp_pdf: true } });
  const id = String(body.sale_id || '').replace(/'/g, "''");
  const sale = (await q(`SELECT id, bill_no, is_void, customer_id FROM public.hangtag_sales WHERE id = '${id}'`))[0];
  if (!sale) return reply(404, { ok: false, error: 'not_found', message: "That bill isn't in the cloud yet." });
  if (body.action === 'invoice') {
    if (invoices[sale.id]) return reply(200, { ok: true, already: true, invoice: invoices[sale.id], url: 'https://files.example/x' });
    if (!body.pdf) return reply(404, { ok: false, error: 'no_invoice', message: 'This bill has no invoice PDF yet.' });
    const pdf = Buffer.from(body.pdf, 'base64');
    if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-')) || !pdf.toString('latin1').includes(`(${sale.bill_no})`)) return reply(422, { ok: false, error: 'invoice_mismatch', message: "That PDF isn't this bill's invoice." });
    invoices[sale.id] = { id: 'inv-' + sale.id, number: sale.bill_no, sha256: crypto.createHash('sha256').update(pdf).digest('hex'), size: pdf.length, filename: `Invoice-${sale.bill_no}.pdf` };
    return reply(200, { ok: true, invoice: invoices[sale.id], url: 'https://files.example/x' });
  }
  // a send: to the bill's customer as saved, or (a walk-in bill) the saved customer named in the request
  const cid = sale.customer_id || body.customer_id;
  const cust = cid ? (await q(`SELECT name, phone, email FROM public.hangtag_customers WHERE id = '${String(cid).replace(/'/g, "''")}'`))[0] : null;
  if (!cust) return reply(422, { ok: false, error: 'missing_contact', message: 'This bill has no saved customer.' });
  const to = body.channel === 'email' ? cust.email : '+91' + String(cust.phone || '').replace(/\D/g, '').slice(-10);
  if (body.channel === 'sms' && smsRefusals > 0) { smsRefusals--; return reply(502, { ok: false, status: 'failed', error: 'provider_error', message: "The SMS service didn't accept the message: busy" }); }
  const inv = invoices[sale.id];
  return reply(200, { ok: true, status: 'sent', channel: body.channel, recipient: to, provider: 'fake', provider_message_id: 'm' + fnCalls.length,
    ...(inv ? { invoice_id: inv.id, format: body.channel === 'email' ? 'attachment' : body.channel === 'whatsapp' ? 'document' : 'pdf_link' } : { format: 'text' }) });
};

const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
const A = await (await browser.createBrowserContext()).newPage();
await A.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
A.on('pageerror', (e) => { fails++; console.log('[pageerror]', e.message); });
await A.setRequestInterception(true);
A.on('request', async (r) => {
  const u = r.url();
  if (u.startsWith('http://localhost:3210/')) return (u === 'http://localhost:3210/' || u.includes('/?')) ? r.respond({ status: 200, contentType: 'text/html', body: H.hookedHtml() }) : r.continue();
  if (u.includes('.supabase.co/')) { if (!(await pg.handle(r, { '/functions/v1/send-receipt': sendReceipt }))) r.abort(); return; }
  r.continue();
});
await A.evaluateOnNewDocument((s) => { if (location.hostname === 'localhost') localStorage.setItem('hangtag-auth', s); }, JSON.stringify(pg.session()));
await A.goto('http://localhost:3210/', { waitUntil: 'networkidle0' });
const run = (b) => A.evaluate((b) => __ev('(async()=>{' + b + '})()'), b);
async function until(cond, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run('return !!(' + cond + ')').catch(() => false)) return true; await sleep(100); } return false; }
const text = (sel) => A.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
const vis = (sel) => A.$eval(sel, (e) => !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0).catch(() => false);
const focused = () => A.evaluate(() => { const a = document.activeElement; return a ? { tag: a.tagName, id: a.id || '', f: a.dataset ? a.dataset.payf || '' : '' } : null; });
check('signed in and connected', await until('sbStatus==="connected"'), await run('return {sbStatus, mode, gate: !document.getElementById("authGate").hidden, setup: !!document.querySelector("#setupGate:not([hidden])")}').catch((e) => String(e)));

await run(`openEditor(null);editor.name="Tee";editor.price="525";edCombos()[0].cell.stock="20";saveEditor();await flushSbQueue();setTab("sell");renderAll()`);
const TEE = await run('return prod(products().find(p=>p.name==="Tee").id).variants[0].id');

// ---------- checkout's Customer step ----------
await run(`addOne(${JSON.stringify(TEE)});renderAll();openCheckout("cash")`); await sleep(250);
check('the Customer step offers Search customer, Add customer and Walk-in', await vis('#modalHost .checkout-choice[data-act="pickcust"]') && await vis('#modalHost .checkout-choice[data-checkoutaddcust]') && await vis('#modalHost .checkout-choice[data-checkoutwalkin]')
  && /Search customer/.test(await text('#modalHost .checkout-choices')) && /Add customer/.test(await text('#modalHost .checkout-choices')) && /Walk-in/.test(await text('#modalHost .checkout-choices')));
await A.click('#modalHost .checkout-choice[data-checkoutaddcust]'); await sleep(250);
check('Add customer opens the form for name, mobile and email — the bill is kept', await vis('#custForm [name=name]') && await vis('#custForm [name=phone]') && await vis('#custForm [name=email]') && (await run('return cart.length')) === 1);
await run('closeModal();checkoutFlow=null'); await sleep(150);
check('…closing it leaves the bill as it was (the item is still there)', (await run('return cart.length')) === 1);

// ---------- payment ----------
await run('openPayment("cash")'); await sleep(300);
let f = await focused();
check('payment opens with the focus on Complete sale, not in a box (no keyboard on a phone)', f && f.tag === 'BUTTON' && f.id === 'payDone', f);
check('cash: the amount received is filled in with the exact total, "Exact" chosen, no change', (await A.$eval('#paySheet [data-payf="recv"]', (e) => e.value)) === '525' && (await A.$eval('#paySheet [data-payexact]', (e) => e.getAttribute('aria-pressed'))) === 'true'
  && /Change ₹0/.test(await text('#payLive')) && !(await A.$eval('#payDone', (e) => e.disabled)));
const foot = await A.evaluate(() => { const b = document.getElementById('payDone').getBoundingClientRect(), m = document.querySelector('[data-paymethod]'); return { bottom: b.bottom, top: b.top, h: innerHeight, method: m && m.textContent }; });
check('the method, the total and Complete sale are in view at the foot of the sheet', foot.top >= 0 && foot.bottom <= foot.h && foot.method === 'Cash' && /Complete sale · ₹525/.test(await text('#payDone')), foot);
await A.tap('[data-payquick="600"]'); await sleep(150);
check('a quick amount (₹600): change ₹75 at once, ₹600 chosen', /Change ₹75/.test(await text('#payLive')) && (await A.$eval('[data-payquick="600"]', (e) => e.classList.contains('on'))) && (await A.$eval('#paySheet [data-payexact]', (e) => e.getAttribute('aria-pressed'))) === 'false');
await A.tap('#paySheet [data-payexact]'); await sleep(150);
check('"Exact" again: no change', /Change ₹0/.test(await text('#payLive')) && (await A.$eval('#paySheet [data-payf="recv"]', (e) => e.value)) === '525');
await A.tap('#paySheet [data-paymode="upi"]'); await sleep(250);
f = await focused();
check('changing the method doesn\'t put the focus in a box either', !(f && (f.tag === 'INPUT' || f.tag === 'TEXTAREA')), f);
await A.tap('#paySheet [data-paymode="cash"]'); await sleep(250);
await A.tap('#paySheet [data-payf="recv"]'); await sleep(100);
f = await focused();
check('the box takes the focus (and the keyboard opens) only when the cashier taps it', f && f.f === 'recv', f);
const salesBefore = await run('return D().sales.length');
await A.evaluate(() => { const b = document.getElementById('payDone'); b.click(); b.click(); b.click(); });   // a triple tap
await sleep(500);
check('a triple tap on Complete sale makes one sale', (await run('return D().sales.length')) === salesBefore + 1, { before: salesBefore, after: await run('return D().sales.length') });
const sid = await run('return lastSale.id'), no = await run('return lastSale.no');
check('the success screen: the invoice number and the amount paid', await vis('#sheetHost [data-paid]') && (await text('#sheetHost [data-paidno]')) === no && /₹525/.test(await text('#sheetHost .paid-amt')));
check('…with View bill, Download PDF and the channels; each says what it carries (PDF attached, PDF document, link to the PDF)', await vis(`#sheetHost [data-billview="${sid}"]`) && await vis(`#sheetHost [data-dlinvoice="${sid}"]`)
  && /Email: the invoice PDF attached · WhatsApp: the invoice PDF · SMS: a link to download the invoice PDF/.test(await text('#sheetHost [data-dlcap]') || ''), await text('#sheetHost [data-dlcap]'));
await run('await flushSbQueue()');

// ---------- a walk-in bill: the contact is added afterwards, the same bill goes out ----------
check('walk-in: email and SMS wait for a contact; "Add customer\'s contact" is offered', await A.$eval(`#sheetHost [data-send="email:${sid}"]`, (b) => b.disabled) && await A.$eval(`#sheetHost [data-send="sms:${sid}"]`, (b) => b.disabled) && await vis(`#sheetHost [data-addcontact="${sid}"]`));
await A.tap(`#sheetHost [data-addcontact="${sid}"]`); await sleep(200);
await A.type(`#sheetHost [data-contactform="${sid}"] [name=name]`, 'Meera');
await A.type(`#sheetHost [data-contactform="${sid}"] [name=phone]`, '98450 22222');
await A.type(`#sheetHost [data-contactform="${sid}"] [name=email]`, 'meera@mail.in');
await A.tap(`#sheetHost [data-contactsave="${sid}"]`); await sleep(400);
check('saved: the buttons work now, for Meera', await until(`!document.querySelector('[data-send="email:${sid}"]').disabled && /meera/i.test(document.querySelector('[data-sendbox="${sid}"] .sendh').innerText)`, 5000), { disabled: await A.$eval(`#sheetHost [data-send="email:${sid}"]`, (b) => b.disabled).catch(() => 'none'), sendh: await text(`#sheetHost [data-sendbox="${sid}"] .sendh`), note: await text(`#sheetHost [data-contactform]`) });
await A.tap(`#sheetHost [data-send="email:${sid}"]`);
check('email: sent, the invoice PDF attached', await until(`/✓ Emailed to meera@mail\\.in with the invoice PDF attached/.test(document.querySelector('[data-sendstate="${sid}"]').innerText)`, 15000), await text(`#sheetHost [data-sendstate="${sid}"]`));
const emailSend = fnCalls.find((c) => c.action === 'send' && c.channel === 'email');
check('the walk-in bill goes to the saved customer named in the request; it carries only ids', emailSend && emailSend.sale_id === sid && /^c/.test(emailSend.customer_id || '') && !('to' in emailSend) && !('message' in emailSend), emailSend);
const dbSale = (await q(`SELECT count(*)::int AS n, max(customer_id) AS c FROM public.hangtag_sales WHERE id = '${sid}'`))[0];
check('…and the bill itself is unchanged: still one bill, still a walk-in (no sale made again)', dbSale.n === 1 && dbSale.c === null && (await run('return D().sales.length')) === salesBefore + 1, dbSale);
await A.tap(`#sheetHost [data-send="sms:${sid}"]`); await sleep(900);
check('SMS: the provider refused — shown as not sent, its own badge says so, Try again offered', /didn't accept the message/.test(await text(`#sheetHost [data-sendstate="${sid}"]`) || '')
  && (await A.$eval(`#sheetHost [data-send="sms:${sid}"] .dlb`, (e) => e.classList.contains('err')).catch(() => false)) && !!(await A.$(`#sheetHost [data-sendstate="${sid}"] [data-send="sms:${sid}"]`)));
check('…the email still shows sent (each channel has its own state)', await A.$eval(`#sheetHost [data-send="email:${sid}"] .dlb`, (e) => e.classList.contains('ok')).catch(() => false));
await A.tap(`#sheetHost [data-sendstate="${sid}"] [data-send="sms:${sid}"]`);
check('Try again: the SMS goes, with the link to the invoice PDF', await until(`/✓ Sent by SMS to \\+919845022222 with a link to the invoice PDF/.test(document.querySelector('[data-sendstate="${sid}"]').innerText)`, 15000), await text(`#sheetHost [data-sendstate="${sid}"]`));
await A.tap(`#sheetHost [data-send="whatsapp:${sid}"]`);
check('WhatsApp: sent with the invoice PDF (the template\'s document)', await until(`/✓ Sent on WhatsApp to \\+919845022222 with the invoice PDF/.test(document.querySelector('[data-sendstate="${sid}"]').innerText)`, 15000), await text(`#sheetHost [data-sendstate="${sid}"]`));
const sends = fnCalls.filter((c) => c.action === 'send' && c.sale_id === sid), regs = fnCalls.filter((c) => c.action === 'invoice' && c.pdf);
check('one invoice PDF for the bill, registered once; every channel used it (email once, SMS twice — the retry —, WhatsApp once)',
  regs.length === 1 && !!invoices[sid] && sends.filter((c) => c.channel === 'email').length === 1 && sends.filter((c) => c.channel === 'sms').length === 2 && sends.filter((c) => c.channel === 'whatsapp').length === 1,
  { regs: regs.length, sends: sends.map((c) => c.channel) });
check('…each press of Send its own request id (the retry a new press: the first one was refused)', new Set(sends.map((c) => c.request_id)).size === sends.length);
const over = await A.evaluate(() => { const s = document.querySelector('#sheetHost .sheet.paid'); return { page: document.documentElement.scrollWidth > innerWidth + 1, sheet: s ? s.scrollWidth > s.clientWidth + 1 : null }; });
check('on the phone nothing scrolls sideways (the success sheet, the send box, the contact form)', !over.page && over.sheet === false, over);
await A.screenshot({ path: H.ARTIFACTS + '/pos-delivery-phone.png' });

await browser.close();
console.log(fails ? `\n${fails} check(s) failed` : '\nall passed');
process.exit(fails ? 1 : 0);
