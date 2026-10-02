// Quotations for customers, end to end in Chrome (Wave 3): the shop's quotation template (title, number prefix, default
// terms, signature, footer) in Settings → Receipt; a quotation numbered with that prefix and headed with that title (never
// an invoice); Print, Download PDF; Send by email through the server (send-receipt stubbed: only the quotation, the
// channel and a request id are sent — Queued while offline, then Sent; never twice); Duplicate; a quotation billed
// straight away stays linked to its bill. The owner's app also keeps the shop's invoice-link page (Receipt → Invoice
// links). The database is PGlite running the real schema.sql behind a PostgREST stand-in (row security on).
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest, CORS } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-0000000000a7', EMAIL = 'quotes@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, gstin, onboarded_at) VALUES ($1,$2,'Owner','Aura Threads','9876543210','12 MG Road','Pune','Maharashtra','27ABCDE1234F1Z5',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, city = EXCLUDED.city, state = EXCLUDED.state, gstin = EXCLUDED.gstin, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);
const q = async (sql, p = []) => (await pg.as(sql, p)).rows;
// the shop charges GST (added to its prices)
await pg.as(`INSERT INTO public.hangtag_meta (key, value) VALUES ('settings', '{"taxOn":true,"taxRate":5,"taxIncl":false}')`, []);
// the send-receipt function: email can send quotations, WhatsApp has no quotation template yet
const fnCalls = [];
const sendReceipt = async (r) => {
  const body = JSON.parse(r.postData() || '{}'); fnCalls.push(body);
  const reply = (status, b) => r.respond({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(b) });
  if (body.action === 'channels') return reply(200, { ok: true, channels: { email: true, whatsapp: true, sms: false, quote_email: true, quote_whatsapp: false } });
  if (body.action === 'send' && body.order_id) return reply(200, { ok: true, status: 'sent', channel: body.channel, recipient: 'riya@example.com', provider: 'resend', provider_message_id: 're_' + fnCalls.length });
  return reply(400, { ok: false, error: 'bad_request', message: 'Unknown action.' });
};

const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
const A = await (await browser.createBrowserContext()).newPage();
await A.setViewport({ width: 1280, height: 900 });
A.on('pageerror', (e) => { fails++; console.log('[pageerror]', e.message); });
A.on('dialog', (d) => d.accept());
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
async function until(cond, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run('return !!(' + cond + ')').catch(() => false)) return true; await sleep(120); } return false; }
const text = (sel) => A.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');
const type = async (sel, v) => { await A.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, v); await sleep(80); };
const choose = async (sel, v) => { await A.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); }, v); await sleep(120); };
const meta = async () => ((await q(`SELECT value FROM public.hangtag_meta WHERE key = 'settings'`))[0] || {}).value || {};
check('signed in and connected', await until('sbStatus==="connected"'));
await run(`openEditor(null);editor.name="Kurta";editor.price="1000";editor.hsn="6109";editor.gst="5";edCombos()[0].cell.stock="40";saveEditor();
  saveCustomer({name:"Riya",phone:"98765 43210",email:"riya@example.com"});
  await flushSbQueue();setTab("sell");renderAll()`);
const RIYA = await run(`return Object.values(customers).find(c=>c.name==="Riya").id`);

// ---------- the invoice-link page and the quotation template ----------
check('the owner\'s app keeps the shop\'s invoice-link page (this app\'s receipt page), in the cloud too', await until('settings.receiptUrl==="http://localhost:3210/receipt.html"')
  && (await until('true', 300)) && (await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 8000) { if ((await meta()).receiptUrl === 'http://localhost:3210/receipt.html') return true; await sleep(200); } return false; })()));
await run('openSettings()'); await sleep(250);
check('Settings → Receipt: Invoice links and Quotations', /Invoice links/.test(await text('#invoicePage')) && /localhost:3210\/receipt\.html/.test(await text('#invoicePage')) && !!(await A.$('#quoteSetForm')));
await type('#quoteSetForm [name="quoteTitle"]', 'Tax invoice');
await A.click('#quoteSetForm [type="submit"]'); await sleep(200);
check('a quotation title that says invoice is refused', /can't say invoice/.test(await text('#quoteSetErr')));
await type('#quoteSetForm [name="quoteTitle"]', 'PRICE QUOTE');
await type('#quoteSetForm [name="quotePrefix"]', 'PQ');
await type('#quoteSetForm [name="quoteTerms"]', '50% advance with the order.');
await type('#quoteSetForm [name="quoteSignature"]', 'For Aura Threads');
await type('#quoteSetForm [name="quoteFooter"]', 'Thank you for asking us.');
await A.click('#quoteSetForm [type="submit"]'); await sleep(300);
await run('await flushSbQueue()');
const m = await meta();
check('saved with the shop\'s settings (here and in the cloud)', (await run('return settings.quoteTitle+"|"+settings.quotePrefix')) === 'PRICE QUOTE|PQ' && m.quoteTitle === 'PRICE QUOTE' && m.quoteTerms === '50% advance with the order.' && m.quoteGst === true, m);
await run('closeSettings()'); await sleep(150);

// ---------- a quotation ----------
await run('chooseSubview("orders","quote");setTab("orders");renderAll()'); await sleep(200);
await A.click('[data-subalt="orders"] [data-ordnew="quote"]'); await sleep(300);
check('a new quotation starts with the shop\'s terms', (await A.$eval('#orderSheet [data-off="terms"]', (e) => e.value)) === '50% advance with the order.');
await choose('#orderSheet [data-ofcust]', RIYA);
await type('#ofQ', 'kurta'); await sleep(150);
await A.click('#ofHits [data-ofadd]'); await sleep(200);
await type('#orderSheet [data-ofl="q:0"]', '2');
await A.click('#orderSheet [data-ofsave]'); await sleep(300);
const QT = await run('return ordersOf("quote")[0]');
check('numbered with the shop\'s prefix (PQ-…), its total kept', QT && /^PQ-\d{6}-[0-9A-Z]{3}\d{3}$/.test(QT.no) && QT.total === 2100, QT);
await run('await flushSbQueue()');
check('…in the cloud with its total', +((await q(`SELECT total FROM public.hangtag_orders WHERE id = $1`, [QT.id]))[0] || {}).total === 2100);
await A.$eval('#orderSheet [data-qdoc="preview"]', (b) => b.click()); await sleep(250);
const pv = await text('.quotation');
check('the document: the shop\'s title, number, validity, customer, GST, terms, signature, footer — and not a bill', /PRICE QUOTE/.test(pv) && pv.includes(QT.no) && /Valid until/.test(pv) && /Riya/.test(pv) && /CGST/.test(pv) && /Taxable/.test(pv)
  && /50% advance/.test(pv) && /For Aura Threads/.test(pv) && /Thank you for asking us/.test(pv) && /not a bill/.test(pv) && !/invoice/i.test(pv), pv.slice(0, 400));
await run('override({files:{...use("files"),saveFile:async(n,b,t)=>{window.__saved={n,t,len:b.length,head:typeof b==="string"?b.slice(0,5):String.fromCharCode(...b.slice(0,5))};return true;}}})');
await A.click('.qprevsheet [data-qdoc="download"]'); await sleep(300);
const saved = await A.evaluate(() => window.__saved);
check('Download PDF: a PDF file named after the quotation', saved && saved.head === '%PDF-' && saved.t === 'application/pdf' && saved.n === QT.no + '.pdf' && saved.len > 800, saved);
await A.click('.qprevsheet [data-qdoc="print"]'); await sleep(100);
const printed = await A.evaluate(() => { const f = [...document.querySelectorAll('iframe')].pop(); return f && f.contentDocument ? f.contentDocument.body.innerText : ''; });
check('Print: the same document goes to the browser\'s print dialog', /PRICE QUOTE/.test(printed) && printed.includes(QT.no), printed.slice(0, 200));

// ---------- sending it ----------
await A.click('.qprevsheet [data-qdoc="send"]'); await sleep(400);
check('Send: Email to Riya, WhatsApp not set up on the server for quotations yet, and Share PDF', !!(await A.$('#quoteSendSheet [data-qsend="email"]')) && /riya@example\.com/.test(await text('#quoteSendSheet [data-qsend="email"]'))
  && /Not set up on the server/.test(await text('#quoteSendSheet [data-qsend="whatsapp"]')) && !!(await A.$('#quoteSendSheet [data-qdoc="share"]')));
await A.click('#quoteSendSheet [data-qsend="email"]');
check('…sent by email: Sent in the list, the quotation now "sent"', await until(`quoteSendsOf(${JSON.stringify(QT.id)})[0]&&quoteSendsOf(${JSON.stringify(QT.id)})[0].status==="sent"`) && (await run(`return orderById(${JSON.stringify(QT.id)}).status`)) === 'sent'
  && /Sent/.test(await text('#quoteSendSheet .qs-jobs')));
const sends = fnCalls.filter((b) => b.action === 'send');
check('only the quotation, the channel and a request id went to the server (no message, address or subject)', sends.length === 1 && sends[0].order_id === QT.id && sends[0].channel === 'email' && /^[A-Za-z0-9_-]{8,64}$/.test(sends[0].request_id)
  && JSON.stringify(Object.keys(sends[0]).sort()) === JSON.stringify(['action', 'channel', 'order_id', 'request_id']), sends);
await A.click('#quoteSendSheet [data-qsend="whatsapp"]'); await sleep(200);
check('WhatsApp: refused with the reason (nothing sent, nothing faked)', fnCalls.filter((b) => b.action === 'send').length === 1 && !(await run(`return quoteSendsOf(${JSON.stringify(QT.id)}).some(j=>j.channel==="whatsapp")`)));
await run('sbStatus="disconnected"');
await A.click('#quoteSendSheet [data-qsend="email"]'); await sleep(300);
check('offline: the next send waits here as Queued (waiting for the internet)', (await run(`return quoteSendsOf(${JSON.stringify(QT.id)})[0].status`)) === 'queued' && /Queued/.test(await text('#quoteSendSheet .qs-jobs')) && /waiting for the internet/.test(await text('#quoteSendSheet .qs-jobs')));
await run('sbStatus="connected";await processQuoteSends();await processQuoteSends()');
const sends2 = fnCalls.filter((b) => b.action === 'send');
check('back online: it goes once, with its own request id', (await run(`return quoteSendsOf(${JSON.stringify(QT.id)})[0].status`)) === 'sent' && sends2.length === 2 && sends2[1].request_id !== sends2[0].request_id);
await run('closeModal()'); await sleep(100);

// ---------- duplicate, then billed straight away ----------
await run(`openOrderEditor(${JSON.stringify(QT.id)})`); await sleep(200);
await A.click('#orderSheet [data-ofdup]'); await sleep(300);
const DUP = await run('return ordersOf("quote").find(o=>o.id!==' + JSON.stringify(QT.id) + ')');
check('Duplicate: a new draft quotation with its own number, the same customer, lines and terms', DUP && DUP.no !== QT.no && /^PQ-/.test(DUP.no) && DUP.status === 'draft' && DUP.cust.id === RIYA && DUP.items[0].q === 2 && DUP.terms === QT.terms, DUP);
await A.click('#orderSheet [data-ofbill]'); await sleep(300);
check('Bill it: its lines on the Sell screen for Riya, from the quotation', (await run('return prefs.tab')) === 'sell' && (await run('return cart.length===1&&cart[0].q===2&&cartCust&&cartCust.id')) === RIYA);
await run('openPayment("cash")'); await sleep(300);
await A.click('#payDone'); await sleep(400);
const S = await run('return lastSale');
check('the bill keeps the quotation; the quotation is converted, pointing at the bill', S.order === DUP.id && (await run(`return orderById(${JSON.stringify(DUP.id)}).status+"|"+orderById(${JSON.stringify(DUP.id)}).convertedTo`)) === 'converted|' + S.id);
await run('closeSheets();await flushSbQueue()');
check('…in the cloud too', ((await q(`SELECT order_id FROM public.hangtag_sales WHERE id = $1`, [S.id]))[0] || {}).order_id === DUP.id);

await browser.close(); await pg.db.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
