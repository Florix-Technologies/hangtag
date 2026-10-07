// Communication automation, end to end in Chrome: after a sale, the receipt goes out by itself (the shop's delivery
// policy: email and SMS on, WhatsApp off) through the send-receipt function, and every bill says where its receipt is —
// Queued, Sent, Delivered or Failed. The provider's "delivered" (heard by the server) reaches the Bills list; a receipt
// that reached nobody is marked, counted on Bills and on Home, and goes out again with one tap. The function is stubbed
// here (it records each send in hangtag_deliveries like the real one); the database is PGlite running the real schema.sql
// behind a PostgREST stand-in (row security on).
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { CORS, createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 700) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-0000000000d4', EMAIL = 'ownerdl@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, onboarded_at) VALUES ($1,$2,'Owner','Neel Fashions','9876543210','5 Ring Road','Surat','Gujarat',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, address = EXCLUDED.address, city = EXCLUDED.city, state = EXCLUDED.state, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);
const q = async (sql, p = []) => (await pg.db.query(sql, p)).rows;

// ---------- the send-receipt function, stubbed: each channel answers as `mode` says, and records the send ----------
const mode = { email: 'ok', sms: 'ok' }, calls = [];
const sendReceipt = async (r) => {
  const body = JSON.parse(r.postData() || '{}'); calls.push(body);
  const reply = (status, b) => r.respond({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(b) });
  if (body.action === 'channels') return reply(200, { ok: true, channels: { email: true, whatsapp: false, sms: true } });
  if (body.action !== 'send') return reply(200, { ok: true, updated: 0 });
  const sale = (await q(`SELECT s.id, c.email, c.phone FROM public.hangtag_sales s LEFT JOIN public.hangtag_customers c ON c.owner_id = s.owner_id AND c.id = s.customer_id WHERE s.id = $1`, [body.sale_id]))[0];
  if (!sale) return reply(404, { ok: false, error: 'not_found', message: "That bill isn't in the cloud yet." });
  const to = body.channel === 'email' ? sale.email : '+91' + String(sale.phone || '').replace(/\D/g, '').slice(-10), ok = mode[body.channel] === 'ok';
  await q(`INSERT INTO public.hangtag_deliveries (owner_id, sale_id, channel, recipient, status, provider, provider_message_id, error, mode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [UID, body.sale_id, body.channel, to, ok ? 'sent' : 'failed', body.channel === 'email' ? 'resend' : 'msg91', ok ? 'm_' + calls.length : null, ok ? null : 'The number is not a valid mobile number', body.auto ? 'auto' : 'manual']);
  return ok ? reply(200, { ok: true, status: 'sent', channel: body.channel, recipient: to, provider: body.channel === 'email' ? 'resend' : 'msg91', provider_message_id: 'm_' + calls.length })
    : reply(422, { ok: false, status: 'failed', error: 'missing_contact', message: "The SMS service couldn't send to this number: it isn't a valid mobile number." });
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
async function until(cond, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run('return !!(' + cond + ')').catch(() => false)) return true; await sleep(150); } return false; }
const text = (sel) => A.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
const vis = (sel) => A.$eval(sel, (e) => !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0).catch(() => false);
check('signed in and connected', await until('sbStatus==="connected"'));

// the delivery policy: email and SMS by themselves (WhatsApp off)
await run(`openEditor(null);editor.name="Saree";editor.price="2500";edCombos()[0].cell.stock="20";saveEditor();
  saveCustomer({name:"Riya Shah",phone:"98200 11223",email:"riya@example.com"});saveCustomer({name:"Arjun Rao",phone:"98765 00000",email:""});closeModal();
  settings=Object.assign({},settings,{autoSend:{email:true,sms:true,whatsapp:false}});await loadChannels();await flushSbQueue();setTab("sell");renderAll()`);
const SAREE = await run('return products().find(p=>p.name==="Saree").variants[0].id');
const sellTo = (who) => run(`await new Promise(r=>setTimeout(r,650));setTab("sell");${who ? `setBillCustomer(Object.values(customers).find(c=>c.name===${JSON.stringify(who)}));` : ''}addOne(${JSON.stringify(SAREE)});
  const s=await checkout("cash");closeModal();closeSheets();await flushSbQueue();return s&&{id:s.id,no:s.no}`);
const settled = (id) => until(`autoJobs(${JSON.stringify(id)}).length&&autoJobs(${JSON.stringify(id)}).every(j=>j.status!=="queued"&&j.status!=="sending")`, 20000);
const state = (id) => run(`return receiptStatusOf(${JSON.stringify(id)})`);

console.log('--- after a sale: queued, then sent by itself ---');
const R1 = await sellTo('Riya Shah');
const q1 = await state(R1.id);
check('the payment completes: the receipt is queued for SMS and email (the policy), before anything is sent', ['queued', 'sent'].includes(q1.state) && JSON.stringify(q1.channels.map((c) => c.channel).sort()) === '["email","sms"]', q1);
check('...then both went out by themselves: Sent', await settled(R1.id) && (await state(R1.id)).state === 'sent', await state(R1.id));
check('the function was asked only for the bill and the channel, marked automatic', calls.filter((c) => c.action === 'send' && c.sale_id === R1.id).every((c) => c.auto === true && !c.to && !c.message));
const W = await sellTo(null);
check('a walk-in bill: nothing queued (no customer to send to)', (await state(W.id)).state === '' && !(await run(`return autoJobs(${JSON.stringify(W.id)}).length`)));

console.log('--- the Bills list says where each receipt is ---');
await run('setTab("bills");prefs.billPeriod="today";renderAll()'); await sleep(400);
const chip = (no) => A.$$eval('#v-bills .billrow', (rows, no) => { const r = rows.find((x) => x.querySelector('.billrow-top b').textContent === no); return r ? [...r.querySelectorAll('.chip-s')].map((c) => c.textContent.trim()) : null; }, no);
check('Riya\'s bill: "Receipt sent"; the walk-in bill: no receipt chip', (await chip(R1.no)).includes('Receipt sent') && !(await chip(W.no)).some((c) => /Receipt/.test(c)), [await chip(R1.no), await chip(W.no)]);
await q(`UPDATE public.hangtag_deliveries SET status = 'delivered', delivered_at = now() WHERE sale_id = $1 AND channel = 'email'`, [R1.id]);   // the provider's webhook
await run('await loadRecentDeliveries(true);renderAll()'); await sleep(300);
check('the provider says the email arrived: "Receipt delivered" (from the server\'s record)', (await chip(R1.no)).includes('Receipt delivered') && (await state(R1.id)).state === 'delivered', [await chip(R1.no), await state(R1.id)]);

console.log('--- a receipt that reached nobody ---');
mode.sms = 'bad';
const R2 = await sellTo('Arjun Rao');
check('Arjun has only a phone (SMS, no email), and the SMS service refuses it: Failed', await settled(R2.id) && (await state(R2.id)).state === 'failed' && /isn't a valid mobile number/.test((await state(R2.id)).channels[0].error), await state(R2.id));
await run('setTab("bills");renderAll()'); await sleep(300);
check('Bills: "Receipt not sent" on the bill, and the count with Send again', (await chip(R2.no)).includes('Receipt not sent') && /1 receipt not sent/.test(await text('#v-bills .bill-alert') || '') && await vis('#v-bills [data-billresend]'), [await chip(R2.no), await text('#v-bills .bill-alert')]);
await A.click('#v-bills .bill-alert [data-billstatus="unsent"]'); await sleep(300);
check('...Show them: the "Receipts not sent" filter lists just that bill', (await A.$$eval('#v-bills .billrow', (l) => l.length)) === 1 && (await chip(R2.no)) !== null, await A.$$eval('#v-bills .billrow .billrow-top b', (l) => l.map((x) => x.textContent)));
await run('setTab("home");renderAll()'); await sleep(300);
check('Home: 1 receipt not sent (the delivered and the walk-in bills don\'t count)', /1 receipt not sent/.test(await text('#homeBody [data-attn="receipts"]') || ''), await text('#homeBody .hattn'));

console.log('--- sent again ---');
mode.sms = 'ok';
await run('setTab("bills");prefs.billStatus="all";renderAll()'); await sleep(300);
await A.click('#v-bills [data-billresend]'); await sleep(300);
check('Send again: it goes out, and the bill says Sent', await settled(R2.id) && (await state(R2.id)).state === 'sent', await state(R2.id));
await run('renderAll()'); await sleep(300);
check('...the banner and Home\'s item are gone', !(await A.$('#v-bills .bill-alert')) && (await chip(R2.no)).includes('Receipt sent') && !(await run('return watchFindings(Date.now()).some(f=>f.id==="receipts")')), await chip(R2.no));
const rows = await q(`SELECT channel, status, mode FROM public.hangtag_deliveries WHERE sale_id = $1 ORDER BY created_at`, [R2.id]);
check('the server\'s record: the failed SMS, then the one that went (both automatic)', JSON.stringify(rows) === JSON.stringify([{ channel: 'sms', status: 'failed', mode: 'auto' }, { channel: 'sms', status: 'sent', mode: 'auto' }]), rows);

await browser.close();
await pg.close?.();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
