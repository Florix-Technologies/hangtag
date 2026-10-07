// Customer intelligence, end to end in Chrome: a customer's profile says what their own bills show. Meera has bought
// four times in four weeks — Kurtas every time, a Dupatta with two of them — and left one bill on account. Her profile
// shows one summary (total purchases, bills, what she owes and since when, the last purchase), what her bills show (how
// often she comes, favourites, what she buys together, the old due), what she buys most, how she pays — and the Agent
// answers "Tell me about Meera" with the same facts. A cashier sees what helps serve her, not where she stands. It fits a
// phone. The database is PGlite running the real schema.sql behind a PostgREST stand-in (row security on).
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 700) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-0000000000c4', EMAIL = 'ownerci@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, onboarded_at) VALUES ($1,$2,'Owner','Kala Boutique','9876543210','8 Hill Road','Mumbai','Maharashtra',now())
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
check('signed in and connected', await until('sbStatus==="connected"'));

await run(`openEditor(null);editor.name="Kurta";editor.price="1000";editor.cost="600";edCombos()[0].cell.stock="40";saveEditor();
  openEditor(null);editor.name="Dupatta";editor.price="500";editor.cost="250";edCombos()[0].cell.stock="20";saveEditor();
  saveCustomer({name:"Meera Iyer",phone:"98200 11223",email:""});closeModal();await flushSbQueue();setTab("sell");renderAll()`);
const KURTA = await run('return products().find(p=>p.name==="Kurta").variants[0].id'), DUP = await run('return products().find(p=>p.name==="Dupatta").variants[0].id');
const MEERA = await run('return Object.values(customers).find(c=>c.name==="Meera Iyer").id');
const DAY = 864e5;
const sellAt = (ago, lines, pay) => run(`await new Promise(r=>setTimeout(r,650));const real=Date.now;setTab("sell");setBillCustomer(customers[${JSON.stringify(MEERA)}]);
  ${JSON.stringify(lines)}.forEach(v=>addOne(v));lastCheckout=0;Date.now=()=>real()-${ago};const p=checkout(${pay});Date.now=real;const s=await p;closeModal();closeSheets();return s&&{id:s.id,no:s.no,total:s.total}`);
// every week for four weeks: Kurtas each time, a Dupatta with two of them; the bill three weeks ago on account
const B = [];
B.push(await sellAt(28 * DAY, [KURTA, KURTA, DUP], '"cash"'));
B.push(await sellAt(21 * DAY, [KURTA], '[{method:"due",amount:1000}]'));
B.push(await sellAt(14 * DAY, [KURTA, KURTA, DUP], '{method:"upi",confirmed:true}'));
B.push(await sellAt(7 * DAY, [KURTA], '"cash"'));
check('four bills for Meera, one on account', B.every((b) => b && b.no) && await run(`return accountOf(${JSON.stringify(MEERA)}).outstanding`) === 1000, B);
await run('await flushSbQueue()');

console.log('--- the owner opens her profile ---');
await run(`closeModal();setTab("customers");renderAll();openCustHistory(${JSON.stringify(MEERA)})`); await sleep(400);
const sum = await A.$$eval('#modalHost .tmini.cust4 > div', (l) => l.map((d) => d.innerText.replace(/\s+/g, ' ').trim()));
check('one summary: total purchases ₹7,000, 4 bills (₹1,750 a bill), ₹1,000 owed from 21 days ago, last purchase 7 days ago', /^Total purchases ₹7,000/.test(sum[0] || '') && /^Bills 4 ₹1,750 a bill$/.test(sum[1] || '')
  && /^Outstanding ₹1,000 oldest 21 days ago$/.test(sum[2] || '') && /^Last purchase .+ 7 days ago$/.test(sum[3] || ''), sum);
check('...with Collect payment (she owes)', await vis('#modalHost [data-collect]'));
const ins = await A.$$eval('#modalHost .cinsight li', (l) => l.map((x) => x.dataset.cins + ': ' + x.textContent));
check('what her bills show: every 7 days, Kurta on every visit, Kurta with Dupatta, the due', ins.some((s) => /^rhythm: Comes about every 7 days \(last visit 7 days ago\)\.$/.test(s)) && ins.some((s) => /^favourite: Buys Kurta on most visits \(4 of 4 bills\)/.test(s))
  && ins.some((s) => /^together: Often buys Kurta with Dupatta \(2 bills\)\.$/.test(s)) && ins.some((s) => /^due: Owes ₹1,000, the oldest part from 21 days ago\.$/.test(s)), ins);
check('...from the shop\'s own bills, said so; no where-she-stands with too few customers', /From this shop’s own bills/.test(await text('#modalHost .cinsight') || '') && !ins.some((s) => /^standing/.test(s)));
const top = await A.$$eval('#modalHost .ctop-r', (l) => l.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
check('buys most: Kurta 6 on 4 bills ₹6,000 — then Dupatta 2 on 2 bills', /^Kurta 6 · 4 bills ₹6,000/.test(top[0] || '') && /^Dupatta 2 · 2 bills ₹1,000/.test(top[1] || ''), top);
check('how she pays: cash, UPI and on account, with shares; paid ₹6,000 of ₹7,000', /Cash ₹3,500 50%/.test(await text('#modalHost .cpay-l') || '') && /UPI ₹2,500 36%/.test(await text('#modalHost .cpay-l') || '') && /On account ₹1,000 14%/.test(await text('#modalHost .cpay-l') || '')
  && /Paid ₹6,000(\.00)? of ₹7,000(\.00)?; ₹1,000 taken on account on 1 bill/.test(await text('#modalHost .custsheet') || ''), [await text('#modalHost .cpay-l'), await text('#modalHost .custsheet')]);
check('...the account and the purchase history follow', /Account/.test(await text('#modalHost .custsheet') || '') && (await A.$$eval('#modalHost .custbill', (l) => l.length)) === 4);
await A.click('#modalHost .ctop-r'); await sleep(400);
check('a product she buys opens it', /Kurta/.test(await text('#modalHost') || ''));
await run(`closeModal();openCustHistory(${JSON.stringify(MEERA)})`); await sleep(300);

console.log('--- the Agent ---');
await A.click('#modalHost .cinsight [data-ask-question]'); await sleep(900);
const ans = await text('#v-assistant .ask-answer') || '';
check('Ask the Agent: "Tell me about Meera Iyer" — the same facts, with her profile to open', await vis('#v-assistant') && /Meera Iyer/.test(await text('#v-assistant .ask-answer h3') || '') && /₹7,000 over 4 bills/.test(ans)
  && /Comes about every 7 days/.test(ans) && !!(await A.$(`#v-assistant [data-agentopen="customer|${MEERA}"]`)), ans);

console.log('--- a cashier ---');
await run(`window.__owner=access;access={role:"cashier",perms:[...ROLE_DEFAULTS.cashier],shopName:"Kala Boutique"};closeModal();renderAll();openCustHistory(${JSON.stringify(MEERA)})`); await sleep(400);
const cins = await A.$$eval('#modalHost .cinsight li', (l) => l.map((x) => x.dataset.cins));
check('cashier: what helps serve her and what she owes (they collect it) — no Ask the Agent (no reports)', cins.includes('favourite') && cins.includes('due') && !(await A.$('#modalHost .cinsight [data-ask-question]')), cins);
await run('access=window.__owner;closeModal();renderAll()');

console.log('--- phone ---');
await A.setViewport({ width: 375, height: 812 }); await sleep(400);
await run(`openCustHistory(${JSON.stringify(MEERA)})`); await sleep(400);
const fit = await A.evaluate(() => { const s = document.querySelector('#modalHost .custsheet'); return { over: s.scrollWidth - s.clientWidth, cols: getComputedStyle(document.querySelector('#modalHost .tmini.cust4')).gridTemplateColumns.split(' ').length,
  wide: [...s.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > 376).map((e) => e.className).slice(0, 5) }; });
check('on a phone: the summary in two columns, nothing wider than the screen', fit.over <= 0 && fit.cols === 2 && !fit.wide.length, fit);

await browser.close();
await pg.close?.();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
