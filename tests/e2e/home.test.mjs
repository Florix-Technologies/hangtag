// Home, end to end in Chrome: the day at a glance from the shop's own records. Today (sales, bills, average bill, gross
// profit only while cost prices cover enough of the sales, cash / UPI / card), Needs attention (stock sold out, customer
// dues, UPI checked by hand, held bills — each opening where to act on it), the Hangtag Agent's insights (what to
// reorder, the week's best seller), the last 7 days, the latest bills with their state, what each role sees (owner,
// manager, cashier) and the phone layout. The database is PGlite running the real schema.sql behind a PostgREST
// stand-in (row security on).
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-0000000000e1', EMAIL = 'ownerhome@example.com';
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
const home = async () => { await run('closeModal();closeSheets();setTab("home");renderAll();window.scrollTo(0,0)'); await sleep(250); };
const attn = () => A.$$eval('#homeBody [data-attn]', (l) => l.map((x) => x.dataset.attn));
const kpis = () => A.$$eval('#homeBody .htoday .hkpi', (l) => Object.fromEntries(l.map((k) => [k.querySelector('span').textContent, { v: k.querySelector('b').textContent, s: k.querySelector('small').textContent.trim() }])));
const qa = () => A.$$eval('#homeBody .qa .qa-b', (l) => l.map((b) => b.textContent.trim()));
check('signed in and connected', await until('sbStatus==="connected"'));

console.log('--- a new shop ---');
await home();
let K = await kpis();
check('Today: ₹0 and no bills yet, average bill and gross profit shown honestly', K.Sales && K.Sales.v === '₹0' && /no bills yet/.test(K.Sales.s) && K.Bills.v === '0' && K['Average bill'].v === '—' && K['Gross profit'] && K['Gross profit'].v === '₹0', K);
check('Needs attention: all clear', /All clear/.test(await text('#homeBody .hattn') || '') && (await attn()).length === 0);
check('the Hangtag Agent: nothing unusual (no figures invented)', /Nothing unusual/.test(await text('#homeBody .hagent') || '') && /never changes anything/.test(await text('#homeBody .hagent') || ''));
check('the owner\'s quick actions: New sale, Scan to sell, Receive stock (the same words as Sell and the New menu)', JSON.stringify(await qa()) === '["New sale","Scan to sell","Receive stock"]', await qa());
check('the shop name, its type and the sync line', /Aura Threads/.test(await text('#homeBody .viewhead') || '') && /Sync:\s*\S/.test(await text('#homeBody .hsync') || '') && await vis('#homeBody .hsync span'));

// two products with cost prices; a few bills: cash, part on account, UPI checked by hand, one cancelled; a held bill
await run(`openEditor(null);editor.name="Kurta";editor.price="1000";editor.cost="600";edCombos()[0].cell.stock="40";saveEditor();
  openEditor(null);editor.name="Dupatta";editor.price="500";editor.cost="250";edCombos()[0].cell.stock="2";saveEditor();
  saveCustomer({name:"Riya",phone:"98765 43210",email:""});closeModal();await flushSbQueue();setTab("sell");renderAll()`);
const KURTA = await run('return products().find(p=>p.name==="Kurta").variants[0].id'), DUP = await run('return products().find(p=>p.name==="Dupatta").variants[0].id');
const sell = (lines, pay, who) => run(`await new Promise(r=>setTimeout(r,700));${who ? `setBillCustomer(Object.values(customers).find(c=>c.name===${JSON.stringify(who)}));` : ''}
  ${JSON.stringify(lines)}.forEach(v=>addOne(v));const s=await checkout(${pay});closeModal();closeSheets();return s&&{id:s.id,no:s.no,total:s.total}`);
const S1 = await sell([DUP, DUP], '"cash"');
const S2 = await sell([KURTA, KURTA, KURTA], '[{method:"cash",amount:1000},{method:"due",amount:2000}]', 'Riya');
const S3 = await sell([KURTA], '{method:"upi",confirmed:true}');   // checked by hand on the customer's phone: unverified
const S4 = await sell([KURTA], '"cash"');
await run(`await voidSale(${JSON.stringify(S4.id)},"Duplicate bill");addOne(${JSON.stringify(KURTA)});holdCart("Mrs Rao");await flushSbQueue()`);
check('four bills made (one cancelled) and one on hold', [S1, S2, S3, S4].every((x) => x && x.no) && await run('return Object.values(heldCarts).filter(Boolean).length') === 1);

console.log('--- today ---');
await home();
K = await kpis();
check('Today: ₹5,000 from 3 bills (the cancelled one left out), ₹1,667 a bill', K.Sales.v === '₹5,000' && K.Bills.v === '3' && /6 pieces/.test(K.Bills.s) && K['Average bill'].v === '₹1,667', K);
check('gross profit: ₹2,100 at 42% (cost prices known for every sale)', K['Gross profit'].v === '₹2,100' && /^42% margin$/.test(K['Gross profit'].s), K['Gross profit']);
check('the same sales figure as Reports for today', await run('const x=periodData(dayKey(Date.now()),dayKey(Date.now()),"");return kstats(x.live,x.rets).rev===5000'));
check('cash, UPI and card taken today (owner), under Money today', K.Cash && K.Cash.v === '₹2,000' && K.UPI.v === '₹1,000' && K.Card.v === '₹0' && await vis('#homeBody .bt-money'), [K.Cash, K.UPI, K.Card]);
check('...and reconciliation: the UPI checked by hand is one thing to check, marked — nothing opens by itself (Home stays calm)', K.Reconciliation && K.Reconciliation.v === '1 to check' && !(await A.$('#homeBody #btWhy'))
  && await A.$eval('#homeBody [data-bt="reconciliation"]', (b) => b.classList.contains('unusual') && /Why\?|Check/.test(b.textContent)), [K.Reconciliation, await text('#homeBody #btWhy')]);
await A.click('#homeBody [data-bt="reconciliation"]'); await sleep(300);
check('...a tap on it shows why', /1 UPI payment \(₹1,000\) checked only by hand/.test(await text('#homeBody #btWhy') || ''), await text('#homeBody #btWhy'));
await A.click('#homeBody [data-bt="reconciliation"]'); await sleep(200);
check('...the four headline figures first (sales, bills, average bill, gross profit), the money and what is owed and in stock after them',
  JSON.stringify(await A.$$eval('#homeBody .bt-hero .hkpi span:first-child', (l) => l.map((s) => s.textContent))) === '["Sales","Bills","Average bill","Gross profit"]'
  && (await A.$$('#homeBody .bt-money .hkpi')).length === 4 && (await A.$$('#homeBody .bt-more .hkpi')).length === 2);
check('the main action stands out: New sale is the larger, primary button', await A.$eval('#homeBody .qa .qa-main', (b) => b.classList.contains('primary') && /New sale/.test(b.textContent) && b.getBoundingClientRect().height >= 48));

await A.screenshot({ path: H.ARTIFACTS + '/home_desktop.png', fullPage: true });
console.log('--- needs attention ---');
const at = await attn();
check('needs attention, worst first: sold out, then UPI to verify, held bill and dues', at[0] === 'stock' && ['upi', 'held', 'dues'].every((k) => at.includes(k)) && !at.includes('orders'), at);
check('...each says what and how much', /1 item sold out/.test(await text('#homeBody [data-attn="stock"]') || '') && /Dupatta/.test(await text('#homeBody [data-attn="stock"]') || '')
  && /1 UPI payment to verify/.test(await text('#homeBody [data-attn="upi"]') || '') && /₹1,000/.test(await text('#homeBody [data-attn="upi"]') || '')
  && /1 bill on hold/.test(await text('#homeBody [data-attn="held"]') || '') && /₹2,000 to collect/.test(await text('#homeBody [data-attn="dues"]') || '') && /Riya/.test(await text('#homeBody [data-attn="dues"]') || ''));
check('the count beside the heading', (await text('#homeBody .hattn .hcount')) === String(at.length));
await A.click('#homeBody [data-attn="upi"] button'); await sleep(500);
check('UPI to verify → Reports, the last 30 days, at Reconciliation', await vis('#v-report') && await run('return prefs.period==="30d"') && await A.$eval('#reconcileCard', (c) => { const r = c.getBoundingClientRect(); return r.top >= -2 && r.top < innerHeight; }).catch(() => false)
  && /UPI not verified\s*1/.test(await text('#reconcileCard') || ''), await text('#reconcileCard .bookkpis'));
await home();
await A.click('#homeBody [data-attn="dues"] button'); await sleep(400);
check('₹2,000 to collect (one customer) → that customer\'s account', /Riya/.test(await text('#modalHost') || ''), (await text('#modalHost') || '').slice(0, 120));
await home();
await A.click('#homeBody [data-attn="held"] button'); await sleep(400);
check('a bill on hold → Held bills', await vis('#v-orders') && await run('return currentSubview("orders").id==="held"') && /Mrs Rao/.test(await text('#v-orders') || ''));
await home();
await A.click('#homeBody [data-attn="stock"] button'); await sleep(400);
check('sold out → Stock, Smart reorder', await vis('#v-stock') && await run('return currentSubview("stock").id==="smart"'));

console.log('--- the Hangtag Agent ---');
await home();
check('it notices what to reorder: Dupatta sold out with recent sales', /Dupatta: sold out — reorder \d+/.test(await text('#homeBody [data-insight="reorder"]') || ''), await text('#homeBody [data-insight="reorder"]'));
check('...and the week\'s best seller from the bills (cancelled bills left out)', /Kurta is this week's best seller: 4 sold for ₹4,000/.test(await text('#homeBody [data-insight="best"]') || ''), await text('#homeBody [data-insight="best"]'));
check('at most three insights, each with where to look', (await A.$$eval('#homeBody [data-insight]', (l) => l.length)) <= 3 && (await A.$$eval('#homeBody [data-insight] button', (l) => l.length)) === (await A.$$eval('#homeBody [data-insight]', (l) => l.length)));
await A.click('#homeBody [data-insight="best"] button'); await sleep(400);
check('the best seller\'s View opens the product', /Kurta/.test(await text('#modalHost') || ''));
await home();
check('Ask the Agent is one tap away', await vis('#homeBody .hagent [data-tab="assistant"]'));

console.log('--- the last 7 days and recent bills ---');
const bars = await A.$$eval('#homeBody .htrend .hbar', (l) => l.map((b) => ({ on: b.classList.contains('on'), d: b.querySelector('.hbar-d').textContent, h: b.querySelector('.hbar-c i').style.height })));
check('7 days of sales, today last and highest', bars.length === 7 && bars[6].on && bars[6].d === 'Today' && bars[6].h === '100%' && bars.slice(0, 6).every((b) => b.h === '0%'), bars);
check('...described for screen readers and totalled', /Sales, last 7 days: .*₹5,000/.test(await A.$eval('#homeBody .htrend', (e) => e.getAttribute('aria-label'))) && /₹5,000/.test(await text('#homeBody .htrend-sum') || ''));
const recent = await A.$$eval('#homeBody .hbills .orow', (l) => l.map((r) => ({ no: r.querySelector('.hno').textContent, chips: [...r.querySelectorAll('.chip-s')].map((c) => c.textContent.trim()), amt: r.querySelector('.o-amt').textContent })));
check('recent bills, newest first, each with its state', recent.length === 4 && recent[0].no === S4.no && recent[0].chips.includes('Cancelled') && recent.find((r) => r.no === S2.no).chips.includes('Unpaid') && recent.find((r) => r.no === S1.no).chips.includes('Paid'), recent);
await A.click('#homeBody .hbills .orow'); await sleep(500);
check('...a bill opens its view', await vis('.billview'));
await home();
check('All bills → the Bills workspace', await A.$eval('#homeBody .hbills [data-tab="bills"]', (b) => !!b).catch(() => false));

console.log('--- gross profit needs cost prices ---');
await run(`openEditor(null);editor.name="Belt";editor.price="2500";edCombos()[0].cell.stock="5";saveEditor();closeModal()`);
const BELT = await run('return products().find(p=>p.name==="Belt").variants[0].id');
await sell([BELT], '"cash"');
await home();
K = await kpis();
check('a sale without a cost price: profit isn\'t guessed (cost missing on 33% of sales)', K['Gross profit'].v === '—' && /cost prices missing on 33% of sales/.test(K['Gross profit'].s), K['Gross profit']);

console.log('--- by role ---');
await run('window.__owner=access;access={role:"manager",perms:[...ROLE_DEFAULTS.manager],shopName:"Aura Threads"};renderAll()'); await home();
check('manager: Business today without gross profit or the money split (they stay in Reports), the Agent and the 7 days', await vis('#homeBody .htoday') && !/Gross profit/.test(await text('#homeBody .htoday') || '')
  && /Customers owe/.test(await text('#homeBody .htoday') || '') && !(await vis('#homeBody .bt-money')) && await vis('#homeBody .hagent') && await vis('#homeBody .htrendc'));
check('...and what a manager acts on: stock (1 sold out) — no owner cards (bank, GST, team)', /Sold out\s*1/.test(await text('#homeBody .hstk') || '') && !(await vis('#homeBody .hbank')) && !(await vis('#homeBody .hteam')), await text('#homeBody .hstk'));
await run('access={role:"cashier",perms:[...ROLE_DEFAULTS.cashier],shopName:"Aura Threads"};renderAll()'); await home();
check('cashier: New sale and Scan to sell', JSON.stringify(await qa()) === '["New sale","Scan to sell"]', await qa());
check('...my shift (my sales, the cash I took, this till\'s drawer) instead of the shop\'s figures; no Agent, no 7 days', await vis('#homeBody .hshift') && /My sales\s*₹[\d,]+/.test(await text('#homeBody .hshift') || '') && /Cash I took/.test(await text('#homeBody .hshift') || '')
  && /This till's drawer/.test(await text('#homeBody .hshift') || '') && !(await vis('#homeBody .htoday')) && !(await vis('#homeBody .hagent')) && !(await vis('#homeBody .htrendc')), await text('#homeBody .hshift'));
check('...the held bill, to recall in one tap', /Mrs Rao/.test(await text('#homeBody .hheld') || '') && !!(await A.$('#homeBody .hheld [data-heldrecall]')), await text('#homeBody .hheld'));
const cat = await attn();
check('...needs attention only what a cashier can act on: held bill and dues, not UPI reconciliation', cat.includes('held') && cat.includes('dues') && !cat.includes('upi'), cat);
check('...recent bills and customers', await vis('#homeBody .hbills') && await vis('#homeBody .hcust'));
await run('access=window.__owner;renderAll()'); await home();

console.log('--- phone ---');
await A.setViewport({ width: 375, height: 812 }); await sleep(500); await home();
await A.screenshot({ path: H.ARTIFACTS + '/home_phone.png', fullPage: true });
const fit = await A.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth, wide: [...document.querySelectorAll('#homeBody *')].filter((e) => e.getBoundingClientRect().right > 376).map((e) => e.className).slice(0, 5),
  order: [...document.querySelectorAll('#homeBody .hcard')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((c) => [...c.classList].find((x) => x !== 'card' && x !== 'hcard')),
  cols: getComputedStyle(document.querySelector('#homeBody .hkpis')).gridTemplateColumns.split(' ').length }));
check('on a phone everything fits (no sideways scrolling), today in two columns', fit.over <= 0 && !fit.wide.length && fit.cols === 2, fit);
check('...in reading order: the morning briefing, Business today, needs attention, bank and cash, the Agent, recent bills, the 7 days', JSON.stringify(fit.order) === '["hbrief","htoday","hattn","hbank","hagent","hbills","htrendc"]', fit.order);
await A.setViewport({ width: 320, height: 700 }); await sleep(400); await home();
check('...also at 320 px', await A.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0);

await browser.close();
await pg.close?.();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
