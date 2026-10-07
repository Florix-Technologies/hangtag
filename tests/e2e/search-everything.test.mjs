// Search everything (the app bar's Search, Ctrl+K), end to end in Chrome: exact identifiers first — a bill number or its
// last digits (never another prefix's: a SKU isn't a bill), a phone number written any way, a SKU, a UPI reference, a
// quotation's number, a supplier's phone — then the everyday ways of narrowing bills ("unpaid bills from riya", "bills over
// 1500 today", "upi"), counted and totalled, with Show in Bills carrying the same filter to the Bills page (its amount and
// payment filters as chips that clear), names across customers, products, bills and quotations, and a question going to the
// Agent. The database is PGlite running the real schema.sql behind a PostgREST stand-in (row security on).
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-0000000000b6', EMAIL = 'ownersearch@example.com';
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
const type = async (sel, v) => { await A.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, v); await sleep(200); };
const choose = async (sel, v) => { await A.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); }, v); await sleep(150); };
const rows = () => A.$$eval('#v-bills .billrow', (b) => b.map((r) => r.querySelector('.billrow-top b').textContent));
/* the search sheet's groups: [{ title, rows: [{ title, attrs }] }] */
const groups = () => A.$$eval('#commandResults .command-group', (g) => g.map((x) => ({ title: x.querySelector('h4').textContent.trim(), sum: (x.querySelector('.command-sum') || {}).textContent || '',
  rows: [...x.querySelectorAll('.command-row')].map((b) => ({ title: b.querySelector('b').textContent, attrs: [...b.attributes].map((a) => a.name + '=' + a.value).filter((a) => a.startsWith('data-')).join(' ') })) })));
const open = async () => { if (!(await vis('#commandSearch'))) { await A.click('#globalActions [data-global="search"]'); await sleep(250); } };
const search = async (q) => { await open(); await type('#commandSearch', q); return groups(); };
const group = (G, title) => G.find((g) => g.title === title || g.title.startsWith(title + ' ·')) || { rows: [], sum: '' };
check('signed in and connected', await until('sbStatus==="connected"'));

// a shop: Kurta (SKU KUR-01) and Tee; Riya and Arjun; a supplier; four bills (cash; part credit for Riya; UPI with its
// reference for Arjun; two Tees in cash) and a quotation for Riya
await run(`openEditor(null);editor.name="Kurta";editor.price="1000";editor.hasOpts=false;edCombos()[0].cell.sku="KUR-01";edCombos()[0].cell.stock="40";saveEditor();
  openEditor(null);editor.name="Tee";editor.price="500";edCombos()[0].cell.stock="40";saveEditor();
  saveCustomer({name:"Riya",phone:"98765 43210",email:""});saveCustomer({name:"Arjun",phone:"91234 56789",email:""});
  saveSupplier({name:"Ravi Textiles",phone:"98111 22233",gstin:""});
  closeModal();await flushSbQueue();setTab("sell");renderAll()`);
const KURTA = await run('return products().find(p=>p.name==="Kurta").variants[0].id'), TEE = await run('return products().find(p=>p.name==="Tee").variants[0].id');
const sell = (lines, pay, who) => run(`await new Promise(r=>setTimeout(r,700));${who ? `setBillCustomer(Object.values(customers).find(c=>c.name===${JSON.stringify(who)}));` : ''}
  ${JSON.stringify(lines)}.forEach(v=>addOne(v));const s=await checkout(${pay});closeModal();closeSheets();return s&&{id:s.id,no:s.no,total:s.total}`);
const S1 = await sell([KURTA], '"cash"');
const S2 = await sell([KURTA, KURTA], '[{method:"cash",amount:800},{method:"due",amount:1200}]', 'Riya');
const S3 = await sell([TEE], '{method:"upi",ref:"412345678901",confirmed:true}', 'Arjun');
const S4 = await sell([TEE, TEE], '"cash"');
check('four bills: INV-000001 … INV-000004', [S1, S2, S3, S4].map((s) => s && s.no).join() === 'INV-000001,INV-000002,INV-000003,INV-000004', [S1, S2, S3, S4]);
const RIYA = await run('return Object.values(customers).find(c=>c.name==="Riya").id');
await run('chooseSubview("orders","quote");setTab("orders");renderAll()'); await sleep(200);
await A.click('[data-subalt="orders"] [data-ordnew="quote"]'); await sleep(300);
await choose('#orderSheet [data-ofcust]', RIYA);
await type('#ofQ', 'kurta'); await A.click('#ofHits [data-ofadd]'); await sleep(200);
await A.click('#orderSheet [data-ofsave]'); await sleep(300);
const QT = await run('closeModal();closeSheets();setTab("home");renderAll();const q=ordersOf("quote")[0];return q&&{id:q.id,no:q.no}');
check('a quotation for Riya', !!(QT && QT.no), QT);

console.log('--- exact identifiers first ---');
let G = await search('INV-000003');
check('a bill number: the bill, as the exact match, first', G[0] && G[0].title === 'Exact match' && G[0].rows.length === 1 && G[0].rows[0].attrs.includes(`data-billview=${S3.id}`), G);
G = await search('3');
check('its last digits find it too', group(G, 'Exact match').rows.some((r) => r.attrs.includes(`data-billview=${S3.id}`)) && !G.some((g) => g.title.startsWith('Bills')), G);
G = await search('KUR-01');
check('a SKU: the product, not bill INV-000001 (another prefix\'s digits)', group(G, 'Exact match').rows.length === 1 && /data-commandproduct=/.test(group(G, 'Exact match').rows[0].attrs), G);
G = await search('+91 91234-56789');
check('a phone written with +91 and a dash: Arjun', G[0] && G[0].title === 'Exact match' && G[0].rows[0].title === 'Arjun' && /data-custhist=/.test(G[0].rows[0].attrs), G);
G = await search('412345678901');
check('a UPI reference (12 digits, like a phone with 91): the bill it paid', group(G, 'Exact match').rows.some((r) => r.attrs.includes(`data-billview=${S3.id}`)), G);
G = await search('98111 22233');
check('a supplier\'s phone: the supplier', group(G, 'Exact match').rows.some((r) => r.title === 'Ravi Textiles' && /data-commandsupplier=/.test(r.attrs)), G);
G = await search(QT.no);
check('a quotation number: the quotation', group(G, 'Exact match').rows.some((r) => r.attrs.includes(`data-ordopen=${QT.id}`)), G);
await A.click(`#commandResults [data-ordopen="${QT.id}"]`); await sleep(400);
check('…and it opens', await vis('#orderSheet') && !(await vis('#commandSearch')));
await run('closeModal();closeSheets()'); await sleep(150);

console.log('--- names across the shop ---');
G = await search('riya');
check('a name: the customer, her bill and her quotation', group(G, 'Customers').rows.some((r) => r.title === 'Riya') && group(G, 'Bills').rows.some((r) => r.attrs.includes(`data-billview=${S2.id}`))
  && group(G, 'Quotations and orders').rows.some((r) => r.attrs.includes(`data-ordopen=${QT.id}`)), G);
G = await search('tee');
check('a product: the product and the bills it is on', group(G, 'Products').rows.some((r) => r.title === 'Tee') && group(G, 'Bills').rows.length === 2 && /2 bills · ₹1,500/.test(group(G, 'Bills').sum), G);

console.log('--- bills, the everyday way ---');
G = await search('unpaid bills from riya');
const U = group(G, 'Bills');
check('"unpaid bills from riya": 1 bill · ₹2,000, its heading says unpaid', U.title === 'Bills · unpaid' && /1 bill · ₹2,000/.test(U.sum) && U.rows.length === 1 && U.rows[0].attrs.includes(`data-billview=${S2.id}`), U);
await A.click('#commandResults [data-billsearch]'); await sleep(400);
check('Show in Bills: the Bills page with the same filter (Unpaid, "riya", all time)', await vis('#v-bills') && (await rows()).join() === 'INV-000002' && (await A.$eval('#billSearch', (e) => e.value)) === 'riya'
  && await run('return prefs.billStatus==="unpaid"&&prefs.billPeriod==="all"'), await rows());
G = await search('bills over 1500 today');
check('"bills over 1500 today": the ₹2,000 bill', /1 bill · ₹2,000/.test(group(G, 'Bills').sum) && group(G, 'Bills').title === 'Bills · today · over ₹1,500', group(G, 'Bills'));
await A.click('#commandResults [data-billsearch]'); await sleep(400);
check('Show in Bills: today, over ₹1,500 as a chip; the earlier filter gone', (await rows()).join() === 'INV-000002' && /over ₹1,500/.test(await text('#v-bills .searchchips') || '')
  && (await A.$eval('#billSearch', (e) => e.value)) === '' && await run('return prefs.billStatus==="all"&&prefs.billPeriod==="today"'), [await rows(), await text('#v-bills .searchchips')]);
await A.click('#v-bills [data-billclear="amount"]'); await sleep(250);
check('the chip clears the amount: every bill of today', (await rows()).length === 4 && !(await A.$('#v-bills .searchchips')), await rows());
G = await search('upi');
check('"upi": the bill paid by UPI', group(G, 'Bills').title === 'Bills · by UPI' && /1 bill · ₹500/.test(group(G, 'Bills').sum), group(G, 'Bills'));
await A.click('#commandResults [data-billsearch]'); await sleep(400);
check('Show in Bills: "Paid by UPI" as a chip', (await rows()).join() === 'INV-000003' && /Paid by UPI/.test(await text('#v-bills .searchchips') || ''), await rows());
await A.click('#v-bills [data-billclear="method"]'); await sleep(250);
G = await search('cancelled bills today');
check('nothing to show is said plainly: 0 bills', /^0 bills/.test(group(G, 'Bills').sum.trim()) && !(await A.$('#commandResults [data-billsearch]')), group(G, 'Bills'));
G = await search('zzqx');
check('no match: what to try', G.length === 0 && /No match for/.test(await text('#commandResults') || ''));

console.log('--- a question goes to the Agent ---');
G = await search('how much did I sell today?');
check('a question: Ask the Agent, first', G[0] && G[0].title === 'Ask the Agent' && G[0].rows[0].title === 'how much did I sell today?', G);
await A.click('#commandResults [data-ask-question]');
check('…answered on the Agent page from the shop\'s records', await until('!!document.querySelector("#v-assistant .ask-answer")') && await vis('#v-assistant') && !(await vis('#commandSearch')));

await browser.close(); await pg.close?.();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
