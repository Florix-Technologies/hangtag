// Business today, end to end in Chrome: Home's card compares today with a usual weekday by this time and explains every
// figure from the shop's own records. Four past same-weekdays of bills make the comparison; today sells less, and half of
// it is a low-margin product; an old bill is still owed on; the cash is closed ₹1,000 short. The owner sees why for each
// (the worst open by itself), each reason opens where to look, and the Agent answers the same why-questions with the same
// reasons. A manager sees no money split or reconciliation; a cashier sees plain figures; it fits a phone. The database is
// PGlite running the real schema.sql behind a PostgREST stand-in (row security on).
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 700) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-0000000000b7', EMAIL = 'ownerbt@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, onboarded_at) VALUES ($1,$2,'Owner','Mehta Stores','9876543210','4 Station Road','Nashik','Maharashtra',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, address = EXCLUDED.address, city = EXCLUDED.city, state = EXCLUDED.state, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);

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
const home = async () => { await run('closeModal();closeSheets();setTab("home");renderAll();window.scrollTo(0,0)'); await sleep(300); };
const tiles = () => A.$$eval('#homeBody .htoday .hkpi', (l) => Object.fromEntries(l.map((k) => [k.querySelector('span').textContent, { v: k.querySelector('b').textContent, s: k.querySelector('small').textContent.trim(), unusual: k.classList.contains('unusual'), btn: k.tagName === 'BUTTON', key: k.dataset.bt || '' }])));
const why = () => text('#homeBody #btWhy');
check('signed in and connected', await until('sbStatus==="connected"'));

// Kurta (40% margin) and Rice (5%); Riya
await run(`openEditor(null);editor.name="Kurta";editor.price="1000";editor.cost="600";edCombos()[0].cell.stock="40";saveEditor();
  openEditor(null);editor.name="Rice";editor.price="100";editor.cost="95";editor.unit="pcs";edCombos()[0].cell.stock="60";saveEditor();
  saveCustomer({name:"Riya",phone:"98765 43210",email:""});closeModal();await flushSbQueue();setTab("sell");renderAll()`);
const KURTA = await run('return products().find(p=>p.name==="Kurta").variants[0].id'), RICE = await run('return products().find(p=>p.name==="Rice").variants[0].id');
// a bill at a time in the past (Date.now stubbed while it is saved, as a sale made then)
const sellAt = (ago, lines, pay, who) => run(`await new Promise(r=>setTimeout(r,650));const real=Date.now;setTab("sell");${who ? `setBillCustomer(Object.values(customers).find(c=>c.name===${JSON.stringify(who)}));` : ''}
  ${JSON.stringify(lines)}.forEach(v=>addOne(v));lastCheckout=0;Date.now=()=>real()-${ago};const p=checkout(${pay});Date.now=real;const s=await p;closeModal();closeSheets();return s&&{id:s.id,no:s.no,total:s.total}`);
const DAY = 864e5;
// four past same-weekdays: 4 cash bills of one Kurta each, a little before this time of day
for (const w of [7, 14, 21, 28]) for (let i = 1; i <= 4; i++) await sellAt(w * DAY + i * 4e3, [KURTA], '"cash"');
// 40 days ago Riya took a Kurta on account (unpaid since)
const OLD = await sellAt(40 * DAY, [KURTA], '[{method:"due",amount:1000}]', 'Riya');
// today: a Kurta for cash, and nine Rice for cash (low margin)
const K1 = await sellAt(0, [KURTA], '"cash"');
const R1 = await sellAt(0, Array(9).fill(RICE), '"cash"');
check('16 past bills, one 40 days old on account, two today', await run('return D().sales.length') === 19 && OLD && OLD.no && K1 && R1 && K1.total === 1000 && R1.total === 900, [OLD, K1, R1]);
// close today's cash ₹1,000 short of what the books expect
const CL = await run(`const e=dayCash(dayKey(Date.now()),"shop").closing;const r=closeDay({counted:e-1000,note:""});return {expected:e,diff:r.close&&r.close.diff}`);
check('the day closed ₹1,000 short', CL.diff === -1000, CL);
await run('await flushSbQueue()');

console.log('--- the owner ---');
await home();
const WD = await run('return fmtDate(Date.now(),{weekday:"long"})');
check('"Business today", compared with a usual weekday by this time (the last 4)', /^Business today/.test(await text('#homeBody .htoday .card-h h3') || '')
  && (await text('#homeBody .bt-basis')) === `Compared with a usual ${WD} by this time (the last 4 ${WD}s).`, await text('#homeBody .bt-basis'));
let T = await tiles();
check('sales ₹1,900, 52% below the usual ₹4,000 by now: marked', T.Sales.v === '₹1,900' && T.Sales.s === '▼ 52% vs usual' && T.Sales.unusual && T.Sales.btn, T.Sales);
check('bills 2, the average bill against the usual ₹1,000', T.Bills.v === '2' && T['Average bill'].v === '₹950' && T['Average bill'].s === '₹1,000 usually', [T.Bills, T['Average bill']]);
check('gross profit at a 23.4% margin (40% usually): marked', /23\.4% margin/.test(T['Gross profit'].s) && T['Gross profit'].unusual, T['Gross profit']);
check('customers owe ₹1,000, all of it over 7 days: marked', T['Customers owe'].v === '₹1,000' && T['Customers owe'].s === '₹1,000 over 7 days' && T['Customers owe'].unusual, T['Customers owe']);
check('stock value at cost', !!T['Stock value'] && /^₹/.test(T['Stock value'].v) && /at cost/.test(T['Stock value'].s), T['Stock value']);
check('money today: cash ₹1,900 (100%), UPI and card ₹0; reconciliation: 1 to check', T.Cash.v === '₹1,900' && /100% of money taken/.test(T.Cash.s) && T.UPI.v === '₹0' && T.Card.v === '₹0'
  && T.Reconciliation.v === '1 to check' && T.Reconciliation.s === '₹1,000 involved' && T.Reconciliation.unusual, [T.Cash, T.Reconciliation]);
let W = await why();
check('the worst opens by itself — reconciliation: ₹1,000 short at today\'s close', /Cash was ₹1,000 short at today's close/.test(W || '') && await A.$eval('#homeBody [data-bt="reconciliation"]', (b) => b.getAttribute('aria-expanded')) === 'true', W);
check('...and ₹1,000 is exactly the cash on today\'s Kurta bill (not the ₹900 one)', W.includes(`₹1,000 is exactly the cash on ${K1.no}`) && !W.includes(R1.no), W);
await A.click(`#homeBody #btWhy [data-agentopen="bill|${K1.id}"]`); await sleep(500);
check('...its Open bill shows that bill', await vis('.billview') && (await text('#modalHost') || '').includes(K1.no));
await home();

await A.click('#homeBody [data-bt="sales"]'); await sleep(300);
W = await why();
check('Sales opens why: 52% below, fewer bills, Kurta selling less', /Sales are 52% below a usual \w+ by this time: ₹1,900 against ₹4,000\./.test(W || '') && /Fewer bills: 2 so far against 4/.test(W) && /Kurta ₹1,000 against ₹4,000/.test(W), W);
check('...with Ask the Agent', await vis('#homeBody #btWhy [data-ask-question="Why are sales down today?"]'));
await A.click('#homeBody [data-bt="profit"]'); await sleep(300);
W = await why();
check('Gross profit: 23.4% today against 40% over 30 days — Rice was 47% of sales at a 5% margin', /The margin is 23\.4% today against 40% over the last 30 days/.test(W || '') && /Rice was 47% of today's sales at a 5% margin/.test(W), W);
await A.click('#homeBody [data-bt="receivables"]'); await sleep(300);
W = await why();
check('Customers owe: ₹1,000 owed for more than 7 days, the oldest Riya (40 days)', /₹1,000 has been owed for more than 7 days, on 1 bill/.test(W || '') && new RegExp(`Oldest: Riya — ₹1,000 on ${OLD.no} from 40 days ago`).test(W), W);
await A.click('#homeBody [data-bt="receivables"]'); await sleep(300);
check('tapped again: closed', !(await A.$('#homeBody #btWhy')));
await A.click('#homeBody [data-bt="cash"]'); await sleep(300);
W = await why();
check('Cash: the drawer now, and today\'s close', /The drawer should hold/.test(W || '') && /Today's close: counted ₹[\d,]+, ₹1,000 short/.test(W), W);
await A.click('#homeBody #btWhy [data-bt=""]'); await sleep(300);
check('Close closes it', !(await A.$('#homeBody #btWhy')));

console.log('--- the owner\'s day: GST, bank and cash, the team ---');
await run('window.__tax=settings.taxOn;settings=Object.assign({},settings,{taxOn:true});rememberTeam([{userId:"u-asha",name:"Asha",role:"cashier",active:true}]);renderAll()'); await home();
const LM = await run('const q=createReadOnlyBusinessQuery();return {g:q.gst("lastmonth").taxable>0,name:fmtDate(new Date(new Date().getFullYear(),new Date().getMonth()-1,1),{month:"long"})}');
const gst = await text('#homeBody .hgst');
check('GST: this month so far, and last month — to prepare, with when GSTR-1 and GSTR-3B are due', /This month so far\s*₹[\d,]+/.test(gst || '') && gst.includes(LM.name)
  && (LM.g ? /GSTR-1 (was )?due/.test(gst) && !!(await A.$(`#homeBody .hgst [data-act="gstview"]`)) : /No sales to file/.test(gst)), [gst, LM]);
const bank = await text('#homeBody .hbank');
check('Bank & cash: the drawer by the books (closed today), and where to add bank accounts', /Cash in the drawer\s*₹17,900\s*closed today/.test(bank || '') && /Add your bank accounts/.test(bank || ''), bank);
const team = await text('#homeBody .hteam');
check('Team today: what you sold, and who of the team hasn\'t sold yet', /You\s*₹1,900\s*2 bills · ₹1,900 cash/.test(team || '') && /Not selling today: Asha/.test(team || ''), team);
await run('settings=Object.assign({},settings,{taxOn:window.__tax});rememberTeam([]);renderAll()'); await home();

console.log('--- the morning briefing ---');
await home();
const brf = await text('#homeBody .hbrief');
check('the owner\'s Home opens with the morning briefing: first, check the cash (₹1,000 short at today\'s close)', /Your morning briefing/.test(brf || '') && /First Check the cash: it was ₹1,000 short at today's close\./i.test(brf || '')
  && !!(await A.$('#homeBody .hbrief .brf-first [data-agentopen="cashbook|"]')), brf);
check('...then yesterday (no bills), the last 7 days, the overdue payment (Riya, 40 days) and the money', /No bills yesterday\./.test(brf) && /The last 7 days: ₹4,000/.test(brf) && /₹1,000 owed for more than 7 days by 1 customer/.test(brf)
  && /Riya: ₹1,000, the oldest 40 days ago/.test(brf) && /1 thing to check before the money reconciles/.test(brf), brf);
const firstCards = await A.evaluate(() => [...document.querySelectorAll('#homeBody .hcard')].slice(0, 2).map((c) => [...c.classList].find((x) => x !== 'card' && x !== 'hcard')));
check('...above Business today', firstCards[0] === 'hbrief' && firstCards[1] === 'htoday', firstCards);
await A.click('#homeBody .hbrief [data-brief="hide"]'); await sleep(300);
check('Hide for today: gone until tomorrow', !(await A.$('#homeBody .hbrief')) && await run('return prefs.briefingHidden===dayKey(Date.now())'));
await run('prefs.briefingHidden=null;renderAll()'); await home();

console.log('--- the Agent ---');
await A.click('#homeBody [data-bt="sales"]'); await sleep(300);
await A.click('#homeBody #btWhy [data-ask-question]'); await sleep(900);
check('Ask the Agent: the Agent page, answering why sales are down — the same reasons', await vis('#v-assistant') && /Sales: why it is out of the ordinary/.test(await text('#v-assistant .ask-answer h3') || '')
  && /52% below/.test(await text('#v-assistant .ask-answer') || '') && /Fewer bills: 2 so far against 4/.test(await text('#v-assistant .ask-answer') || ''), await text('#v-assistant .ask-answer'));
await A.$eval('#askQuestion', (e) => { e.value = 'Why is cash short?'; }); await A.click('#askForm button[type="submit"]'); await sleep(900);
const AQ = await text('#v-assistant .ask-answer') || '';
check('"Why is cash short?": the close and the entry of exactly that amount, with the bill to open', /₹1,000 short at today's close/.test(AQ) && AQ.includes(`₹1,000 is exactly the cash on ${K1.no}`) && !!(await A.$(`#v-assistant [data-agentopen="bill|${K1.id}"]`)), AQ);
await A.$eval('#askQuestion', (e) => { e.value = "What's unusual today?"; }); await A.click('#askForm button[type="submit"]'); await sleep(900);
check('"What\'s unusual today?": everything out of the ordinary, worst first', /out of the ordinary today/.test(await text('#v-assistant .ask-answer') || '') && /Reconciliation/.test(await text('#v-assistant .ask-answer dl') || ''), await text('#v-assistant .ask-answer'));

await A.$eval('#askQuestion', (e) => { e.value = 'How was yesterday?'; }); await A.click('#askForm button[type="submit"]'); await sleep(900);
check('"How was yesterday?": the morning briefing, with what to do first', /Morning briefing/.test(await text('#v-assistant .ask-answer h3') || '') && /First: Check the cash/.test(await text('#v-assistant .ask-answer') || ''), await text('#v-assistant .ask-answer'));

console.log('--- by role ---');
await run('window.__owner=access;access={role:"manager",perms:[...ROLE_DEFAULTS.manager],shopName:"Mehta Stores"};homeWhy=undefined;renderAll()'); await home();
T = await tiles();
check('manager: sales, what customers owe and stock — gross profit, cash / UPI / card and reconciliation stay the owner\'s (Reports)',Object.keys(T).join() === 'Sales,Bills,Average bill,Customers owe,Stock value' && !(await A.$('#homeBody .bt-money')), Object.keys(T));
check('...the worst they can act on opens by itself: sales', /Sales are 52% below/.test(await why() || ''), await why());
await run('access={role:"cashier",perms:[...ROLE_DEFAULTS.cashier],shopName:"Mehta Stores"};renderAll()'); await home();
T = await tiles();
check('cashier: my shift (my sales ₹1,900 on 2 bills, the cash I took) — not the shop\'s Business today, no why', !(await A.$('#homeBody .htoday')) && !(await A.$('#homeBody #btWhy'))
  && /My sales\s*₹1,900\s*2 bills/.test(await text('#homeBody .hshift') || '') && /Cash I took\s*₹1,900/.test(await text('#homeBody .hshift') || ''), await text('#homeBody .hshift'));
await run('access=window.__owner;homeWhy=undefined;renderAll()'); await home();

console.log('--- phone ---');
await A.setViewport({ width: 375, height: 812 }); await sleep(400); await home();
await A.click('#homeBody [data-bt="sales"]'); await sleep(300);
const fit = await A.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  wide: [...document.querySelectorAll('#homeBody .htoday *')].filter((e) => e.getBoundingClientRect().right > 376).map((e) => e.className).slice(0, 5),
  cols: getComputedStyle(document.querySelector('#homeBody .hkpis')).gridTemplateColumns.split(' ').length,
  small: [...document.querySelectorAll('#homeBody .htoday button.hkpi')].filter((b) => b.getBoundingClientRect().height < 44).length }));
check('on a phone: no sideways scrolling, two columns, every figure a 44 px target, the reasons fit', fit.over <= 0 && !fit.wide.length && fit.cols === 2 && fit.small === 0 && await vis('#homeBody #btWhy'), fit);

await browser.close();
await pg.close?.();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
