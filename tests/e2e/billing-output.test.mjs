// Invoices, receipts with the shop logo, sending bills and Epson thermal printing, end to end in Chrome.
// The database is PGlite running the real schema.sql behind a PostgREST stand-in (row security on). The send-receipt Edge
// Function is stubbed at its URL (it records deliveries as the real one does, with the service role); an Epson printer
// is faked at its network address (ePOS-Print answers, including out-of-paper and unreachable).
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import H from '../helpers/env.mjs';
import { createPgRest, CORS } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 500) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-000000000001', EMAIL = 'owner@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, gstin, onboarded_at) VALUES ($1,$2,'Owner','Aura Threads','9876543210','12 MG Road','Pune','Maharashtra','27ABCDE1234F1Z5',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, address = EXCLUDED.address, city = EXCLUDED.city, state = EXCLUDED.state, gstin = EXCLUDED.gstin, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);
const q = async (sql) => (await pg.as(sql, [])).rows;

// ---------- the send-receipt function, stubbed: email works, SMS is refused by its provider, WhatsApp isn't set up ----------
const fnCalls = [];
const sendReceipt = async (r) => {
  const body = JSON.parse(r.postData() || '{}'); fnCalls.push(body);
  const reply = (status, b) => r.respond({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(b) });
  if (body.action === 'channels') return reply(200, { ok: true, channels: { email: true, whatsapp: false, sms: true } });
  const sale = (await q(`SELECT s.id, s.is_void, c.email, c.phone FROM public.hangtag_sales s LEFT JOIN public.hangtag_customers c ON c.owner_id = s.owner_id AND c.id = s.customer_id WHERE s.id = '${body.sale_id.replace(/'/g, "''")}'`))[0];
  if (!sale) return reply(404, { ok: false, error: 'not_found', message: "That bill isn't in the cloud yet." });
  if (sale.is_void) return reply(409, { ok: false, error: 'cancelled', message: "A cancelled bill can't be sent." });
  const to = body.channel === 'email' ? sale.email : '+91' + String(sale.phone || '').replace(/\D/g, '').slice(-10);
  if (body.channel === 'whatsapp') return reply(503, { ok: false, error: 'not_configured', message: "Sending by WhatsApp isn't set up for this shop yet." });
  const ok = body.channel === 'email';
  await pg.db.query(`INSERT INTO public.hangtag_deliveries (owner_id, sale_id, channel, recipient, status, provider, provider_message_id, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [UID, body.sale_id, body.channel, to, ok ? 'sent' : 'failed', ok ? 'resend' : 'twilio', ok ? 're_' + fnCalls.length : null, ok ? null : 'The To number is not a valid mobile number']);
  return ok ? reply(200, { ok: true, status: 'sent', channel: 'email', recipient: to, provider: 'resend', provider_message_id: 're_' + fnCalls.length })
    : reply(502, { ok: false, status: 'failed', error: 'provider_error', message: "The SMS service didn't accept the message: The To number is not a valid mobile number" });
};
// ---------- a fake Epson printer at https://192.168.1.50 ----------
const PRINTER = 'https://192.168.1.50/cgi-bin/epos/service.cgi';
let printerMode = 'ok'; const prints = [];
const printer = (r) => {
  const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
  if (r.method() === 'OPTIONS') return r.respond({ status: 204, headers: h });
  if (printerMode === 'offline') return r.abort('connectionrefused');
  prints.push(r.postData());
  const code = printerMode === 'paper' ? 'EPTR_REC_EMPTY' : '';
  r.respond({ status: 200, contentType: 'text/xml', headers: h, body: `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><response success="${printerMode === 'ok'}" code="${code}" status="${printerMode === 'ok' ? 2 : 0}" xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print"/></s:Body></s:Envelope>` });
};
// a small logo picture
const LOGO = H.ARTIFACTS + '/shop-logo.png';
fs.writeFileSync(LOGO, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKElEQVR42mNkYPhfz0AEYBxVSF+FjP8ZGBiIUcg4qpC+ChkZGRiQFQIAFIMGEYrXHi4AAAAASUVORK5CYII=', 'base64'));

const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
const A = await (await browser.createBrowserContext()).newPage();
await A.setViewport({ width: 1280, height: 900 });
A.on('pageerror', (e) => { fails++; console.log('[pageerror]', e.message); });
await A.setRequestInterception(true);
A.on('request', async (r) => {
  const u = r.url();
  if (u.startsWith(PRINTER)) return printer(r);
  if (u.startsWith('http://localhost:3210/')) return (u === 'http://localhost:3210/' || u.includes('/?')) ? r.respond({ status: 200, contentType: 'text/html', body: H.hookedHtml() }) : r.continue();
  if (u.includes('.supabase.co/')) { if (!(await pg.handle(r, { '/functions/v1/send-receipt': sendReceipt }))) r.abort(); return; }
  if (u.startsWith('https://wa.me/')) return r.respond({ status: 200, contentType: 'text/html', body: 'wa' });
  r.continue();
});
await A.evaluateOnNewDocument((s) => { if (location.hostname === 'localhost') localStorage.setItem('hangtag-auth', s); }, JSON.stringify(pg.session()));
await A.goto('http://localhost:3210/', { waitUntil: 'networkidle0' });
const run = (b) => A.evaluate((b) => __ev('(async()=>{' + b + '})()'), b);
async function until(cond, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run('return !!(' + cond + ')').catch(() => false)) return true; await sleep(100); } return false; }
const text = (sel) => A.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
// an A4 document is shown in its own frame (receipts/components/doc-render.js): its text, or the receipt's
const docText = () => A.evaluate(() => { const f = document.querySelector('.rcpt-prev iframe'); const t = f && f.contentDocument ? f.contentDocument.body.innerText : (document.querySelector('.rcpt-prev') || {}).innerText; return String(t || '').replace(/\s+/g, ' ').trim(); });
const vis = (sel) => A.$eval(sel, (e) => !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0).catch(() => false);
check('signed in and connected', await until('sbStatus==="connected"'));

// products, GST on (added on top), a business customer from Karnataka with email and mobile, and a walk-in later
await run(`openEditor(null);editor.name="Kurta";editor.price="999";editor.hsn="6109";editor.gst="12";edCombos()[0].cell.stock="20";saveEditor();
  settings.taxOn=true;settings.taxRate=5;settings.taxIncl=false;saveSettings();enqueue({type:"settings"});
  saveCustomer({name:"Blr Traders",phone:"98450 12345",email:"accounts@blr.in",gstin:"29ABCDE1234F1Z5",type:"business"});
  await flushSbQueue();setTab("sell");renderAll()`);
const KURTA = await run('return prod(products().find(p=>p.name==="Kurta").id).variants[0].id');
const custId = await run('return Object.values(customers).find(c=>c.name==="Blr Traders").id');

// ---------- Phase 14: the logo, from settings ----------
await run('openSettings("devices")'); await sleep(200);
const printerHere = !!(await A.$('#printerForm [name=kind]'));
await run('openSettings("billing")'); await sleep(200);
check('settings: Billing & Documents has the logo; Team & Devices has this device\'s printer', await vis('#receiptSetup') && /No logo/.test(await text('#receiptSetup .logoprev')) && printerHere);
const logoInput = await A.$('#receiptSetup [data-logofile]'); await logoInput.uploadFile(LOGO); await sleep(700);
check('logo uploaded: shown in settings and kept for this shop', !!(await A.$('#receiptSetup .logoprev img')) && await run('return /^data:image\\/jpeg;base64,/.test(logo)'));
await run('await flushSbQueue()');
check('logo saved in the cloud (hangtag_meta "logo")', /^data:image\/jpeg;base64,/.test(((await q(`SELECT value FROM public.hangtag_meta WHERE key='logo'`))[0] || {}).value?.data || ''));
await run('closeSettings()');

// ---------- Phase 13: a sale → payment confirmed → invoice, with Print / Download / Send ----------
await run(`pickCustomer(${JSON.stringify(custId)});addOne(${JSON.stringify(KURTA)});addOne(${JSON.stringify(KURTA)});renderAll()`); await sleep(150);
await A.click('#billPanel [data-pay="cash"]'); await sleep(200);
await A.click('[data-paymode="split"]'); await sleep(100);
await A.$eval('[data-payf="amt:cash"]', (e) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); }); await A.type('[data-payf="amt:cash"]', '1000');
await A.click('[data-payrest="upi"]'); await sleep(100);
await A.type('[data-payf="ref:upi"]', '412345678901'); await sleep(100);
await A.click('[data-upireceived]'); await sleep(100);
await A.click('#payDone'); await sleep(400);
const sid = await run('return lastSale.id');
check('payment confirmed: the sheet offers Print, Download and Send to customer (Email, WhatsApp, SMS)', await vis('#sheetHost [data-paid]') && !!(await A.$(`#sheetHost [data-print="${sid}"]`)) && !!(await A.$(`#sheetHost [data-dlreceipt="${sid}"]`))
  && (await A.$$eval('#sheetHost [data-send]', (b) => b.map((x) => x.textContent))).join() === 'Email,WhatsApp,SMS');
await run('await flushSbQueue()');
await A.screenshot({ path: H.ARTIFACTS + '/bo1_paid_desktop.png' });

// ---------- Phase 15: send ----------
await A.click(`#sheetHost [data-send="email:${sid}"]`); await sleep(600);
check('Email: sent — the server confirmed with the provider\'s id', /✓ Emailed to accounts@blr\.in/.test(await text(`#sheetHost [data-sendstate="${sid}"]`)), await text(`#sheetHost [data-sendstate="${sid}"]`));
const emailCall = fnCalls.find((c) => c.channel === 'email');
check('the request carries only the bill and the channel — no recipient and no message (the function writes it from the saved bill)', emailCall.sale_id === sid && emailCall.action === 'send'
  && JSON.stringify(Object.keys(emailCall).sort()) === JSON.stringify(['action', 'channel', 'sale_id']), emailCall);
await A.click(`#sheetHost [data-send="sms:${sid}"]`); await sleep(600);
const smsState = await text(`#sheetHost [data-sendstate="${sid}"]`);
check('SMS: the provider refused — shown as not sent, with Try again (no false success)', /didn't accept the message/.test(smsState) && !/✓/.test(smsState) && !!(await A.$(`#sheetHost [data-sendstate="${sid}"] [data-send="sms:${sid}"]`)), smsState);
const waUrl = await A.evaluate(async (sid) => { let u = null; const o = window.open; window.open = (x) => { u = x; return {}; }; document.querySelector(`#sheetHost [data-send="whatsapp:${sid}"]`).click(); await new Promise((r) => setTimeout(r, 400)); window.open = o; return u; }, sid);
const waState = await text(`#sheetHost [data-sendstate="${sid}"]`);
check('WhatsApp (no provider on the server): opens WhatsApp on this device with the bill, and says to press Send there', /^https:\/\/wa\.me\/919845012345\?text=/.test(waUrl || '') && /Press Send there/.test(waState) && !/✓/.test(waState), { waUrl, waState });
const dels = await q(`SELECT channel, status, provider_message_id FROM public.hangtag_deliveries WHERE sale_id = '${sid}' ORDER BY created_at`);
check('the database has the email as sent (with its id) and the SMS as failed; WhatsApp not recorded (nothing sent)', JSON.stringify(dels.map((d) => [d.channel, d.status, !!d.provider_message_id])) === JSON.stringify([['email', 'sent', true], ['sms', 'failed', false]]), dels);

// ---------- Phase 13/14: receipt and invoice from the saved bill ----------
const printedPage = await A.evaluate(async (sid) => { document.querySelector(`#sheetHost [data-print="${sid}"]`).click(); await new Promise((r) => setTimeout(r, 400)); const f = [...document.querySelectorAll('iframe')].pop(); return f && f.contentDocument ? { html: f.contentDocument.body.innerHTML, text: f.contentDocument.body.innerText } : null; }, sid);
check('Print (no thermal printer set): the print-only 80 mm receipt with the logo, shop, GSTIN, IGST and the split payment', printedPage && /class="r-logo"/.test(printedPage.html) && /Aura Threads/.test(printedPage.text) && /GSTIN 27ABCDE1234F1Z5/.test(printedPage.text)
  && /IGST/.test(printedPage.text) && /Paid by Cash/.test(printedPage.text) && /Paid by UPI/.test(printedPage.text), printedPage && printedPage.text.slice(0, 300));
await run('closeSheets()');
await run(`openBillView(${JSON.stringify(sid)},"a4")`); await sleep(300);
const a4 = await docText();
const sale = await run(`const s=D().saleById[${JSON.stringify(sid)}];return {no:s.no,total:s.total,igst:s.igst,taxable:s.taxable}`);
check('A4 invoice: TAX INVOICE, invoice number, place of supply, Bill to with GSTIN, HSN, taxable value and IGST per line', /TAX INVOICE/.test(a4) && a4.includes(sale.no) && /Place of supply Karnataka \(29\)/.test(a4)
  && /Bill to Blr Traders/i.test(a4) && /Business customer/.test(a4) && /GSTIN 29ABCDE1234F1Z5/.test(a4) && /6109/.test(a4) && /IGST/.test(a4), a4.slice(0, 400));
check('A4 invoice: totals from the saved bill, GST by rate, amount in words, payments', a4.includes('₹' + sale.total.toLocaleString('en-IN')) && /Amount in words Rupees .+ Only/i.test(a4) && /GST rate/i.test(a4) && /Paid by Cash/.test(a4));
await A.screenshot({ path: H.ARTIFACTS + '/bo2_invoice_a4.png' });
await sleep(400);
check('bill view lists what was sent (from the database)', /Sent to the customer/.test(await text(`[data-dlhist="${sid}"]`)) && /✓ Email · accounts@blr\.in/.test(await text(`[data-dlhist="${sid}"]`)) && /✕ SMS/.test(await text(`[data-dlhist="${sid}"]`)), await text(`[data-dlhist="${sid}"]`));
await A.click(`[data-billpaper="80mm:${sid}"]`); await sleep(200);
check('switch to the 80 mm receipt view', !(await A.$('.rcpt.a4')) && /Bill/.test(await text('.rcpt-prev')));
await run('closeModal()');

// ---------- Phase 16: the Epson printer ----------
await run('openSettings("devices")'); await sleep(200);
await A.select('#printerForm [name=kind]', 'epson'); await sleep(100);
await A.type('#printerForm [name=host]', '192.168.1.50');
await A.click('#printerForm [data-act="printertest"]'); await sleep(600);
check('test print: confirmed by the printer', /✓ The printer printed the test receipt/.test(await text('#printerMsg')) && /Hangtag test print/.test(prints[prints.length - 1] || ''), await text('#printerMsg'));
await A.click('#printerForm [type=submit]'); await sleep(200);
check('printer saved on this device only', await run('return printer.kind==="epson"&&printer.host==="192.168.1.50"&&LS.get("rc_printer").host==="192.168.1.50"') && !(await q(`SELECT value FROM public.hangtag_meta WHERE key='settings'`))[0]?.value?.printer);
await run('closeSettings()');
await run(`openBillView(${JSON.stringify(sid)})`); await sleep(200);
prints.length = 0;
await A.click(`.billview [data-print="${sid}"]`); await sleep(700);
check('Print: the receipt goes to the Epson printer and shows Printed only after it confirms', /✓ Printed on the receipt printer/.test(await text(`.billview [data-printstate="${sid}"]`)) && prints.length === 1, await text(`.billview [data-printstate="${sid}"]`));
const xml = prints[0] || '';
check('the printer got ePOS-Print XML: logo image, shop, bill number, items, IGST, TOTAL, split payments, cut', /<image width="\d+" height="\d+" color="color_1" mode="mono">/.test(xml) && /Aura Threads/.test(xml) && xml.includes(sale.no)
  && /Kurta/.test(xml) && /IGST/.test(xml) && /TOTAL/.test(xml) && /Paid by Cash/.test(xml) && /Paid by UPI/.test(xml) && /<cut type="feed"\/>/.test(xml));
printerMode = 'paper';
await A.click(`.billview [data-printstate="${sid}"] [data-print]`).catch(() => A.click(`.billview [data-print="${sid}"]`)); await sleep(700);
const paperState = await text(`.billview [data-printstate="${sid}"]`);
check('out of paper: says so, offers Try again and the print dialog — never "Printed"', /out of paper/.test(paperState) && /Try again/.test(paperState) && /Use the print dialog/.test(paperState) && !/✓/.test(paperState), paperState);
printerMode = 'offline';
await A.click(`.billview [data-printstate="${sid}"] [data-print]`); await sleep(900);
check('printer unreachable: says it can\'t reach it (with the certificate hint)', /Can't reach the printer at 192\.168\.1\.50/.test(await text(`.billview [data-printstate="${sid}"]`)), await text(`.billview [data-printstate="${sid}"]`));
printerMode = 'ok';
await A.click(`.billview [data-printstate="${sid}"] [data-print]`); await sleep(700);
check('try again once the printer is back: printed', /✓ Printed/.test(await text(`.billview [data-printstate="${sid}"]`)));
await run('closeModal()');

// ---------- walk-in and cancelled bills ----------
await sleep(700);
await run(`addOne(${JSON.stringify(KURTA)});renderAll()`); await sleep(100);
await A.click('#billPanel [data-pay="cash"]'); await sleep(150); await A.click('#payDone'); await sleep(400);
const wid = await run('return lastSale.id');
check('walk-in: email and SMS need a customer (buttons off, said why); WhatsApp still opens on this device', await A.$eval(`#sheetHost [data-send="email:${wid}"]`, (b) => b.disabled) && await A.$eval(`#sheetHost [data-send="sms:${wid}"]`, (b) => b.disabled)
  && !(await A.$eval(`#sheetHost [data-send="whatsapp:${wid}"]`, (b) => b.disabled)) && /Walk-in bill/.test(await text('#sheetHost .sendbox')));
// even when the server has a WhatsApp provider, a walk-in bill (no saved customer to send to) opens WhatsApp on this device
const callsBefore = fnCalls.length;
const walkWa = await A.evaluate(async (wid) => { __ev('channels={email:true,whatsapp:true,sms:true}'); let u = null; const o = window.open; window.open = (x) => { u = x; return {}; };
  document.querySelector(`#sheetHost [data-send="whatsapp:${wid}"]`).click(); await new Promise((r) => setTimeout(r, 400)); window.open = o; return u; }, wid);
check('walk-in + WhatsApp provider: WhatsApp opens on this device (nothing sent to the server, nothing claimed as sent)', /^https:\/\/wa\.me\/\?text=|^https:\/\/wa\.me\/\d*\?text=/.test(walkWa || '') && fnCalls.length === callsBefore
  && /Press Send there/.test(await text(`#sheetHost [data-sendstate="${wid}"]`)), { walkWa, calls: fnCalls.length - callsBefore });
await run('channels=null');
await A.click(`#sheetHost [data-undosale="${wid}"]`); await sleep(300);
await A.click('#voidForm button[type="submit"]'); await sleep(300);   // cancelling asks why (the first reason is chosen)
await run(`openBillView(${JSON.stringify(wid)},"a4")`); await sleep(200);
check('cancelled bill: the invoice says CANCELLED — not a valid invoice, and it can\'t be sent', /CANCELLED — not a valid invoice/.test(await docText()) && /A cancelled bill can't be sent/.test(await text('.billview .sendbox'))
  && await A.$eval(`.billview [data-send="email:${wid}"]`, (b) => b.disabled));
await run('closeModal()');

// ---------- phone ----------
await A.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true }); await sleep(1000);   // (reloads the page)
check('phone: connected again', await until('sbStatus==="connected"'));
await run(`openBillView(${JSON.stringify(sid)})`); await sleep(300);
const fits = await A.evaluate(() => { const s = document.querySelector('.billview'); return s && s.scrollWidth <= window.innerWidth + 1 && [...document.querySelectorAll('.billview .sendacts .btn')].every((b) => b.getBoundingClientRect().height >= 40); });
check('phone: the bill view and its send buttons fit the screen, with large touch targets', fits);
await A.screenshot({ path: H.ARTIFACTS + '/bo3_billview_phone.png' });
await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
