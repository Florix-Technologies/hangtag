// Returns and after-sales, end to end in Chrome: from a bill, a return — each item, how many, why it came back, whether it
// goes back on the shelf — and the refund. A damaged piece stays off the shelf by default; the others go back, and the
// stock shows it. Each line's reason reaches the cloud (section 3u). An exchange for another size is one tap ("Swap for"),
// with the difference settled. Reports count returns by reason. A returned bill can't be cancelled (a return is not a
// cancellation). The database is PGlite running the real schema.sql behind a PostgREST stand-in (row security on).
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 700) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-0000000000a9', EMAIL = 'ownerret@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, onboarded_at) VALUES ($1,$2,'Owner','Rang Mahal','9876543210','2 Fort Road','Jaipur','Rajasthan',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, address = EXCLUDED.address, city = EXCLUDED.city, state = EXCLUDED.state, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);
const q = async (sql, p) => (await pg.db.query(sql, p)).rows;
async function dbUntil(sql, ok, ms = 8000) { const t0 = Date.now(); let r = []; while (Date.now() - t0 < ms) { r = await q(sql); if (ok(r)) return r; await sleep(150); } return r; }

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

// a Kurta in S, M and L (5 of each) and a Dupatta (10)
await run(`openEditor(null);editor.name="Kurta";editor.price="1000";editor.cost="600";editor.hasOpts=true;edAddOption("Size");edAddValues(0,["S","M","L"]);edCombos().forEach(c=>{c.cell.stock="5"});saveEditor();
  openEditor(null);editor.name="Dupatta";editor.price="500";editor.cost="250";edCombos()[0].cell.stock="10";saveEditor();closeModal();await flushSbQueue();setTab("sell");renderAll()`);
const V = await run('const k=products().find(p=>p.name==="Kurta");return {S:k.variants.find(v=>v.o[0]==="S").id,M:k.variants.find(v=>v.o[0]==="M").id,L:k.variants.find(v=>v.o[0]==="L").id,D:products().find(p=>p.name==="Dupatta").variants[0].id}');
const stock = () => run(`return {S:stockOf(${JSON.stringify(V.S)}),M:stockOf(${JSON.stringify(V.M)}),L:stockOf(${JSON.stringify(V.L)}),D:stockOf(${JSON.stringify(V.D)})}`);
check('a Kurta in three sizes (5 each) and a Dupatta (10)', JSON.stringify(await stock()) === '{"S":5,"M":5,"L":5,"D":10}', await stock());
const B1 = await run(`await new Promise(r=>setTimeout(r,650));[${JSON.stringify(V.M)},${JSON.stringify(V.M)},${JSON.stringify(V.D)}].forEach(v=>addOne(v));const s=await checkout("cash");closeModal();closeSheets();return s&&{id:s.id,no:s.no,total:s.total}`);
check('a bill: two Kurtas in M and a Dupatta, ₹2,500 in cash', B1 && B1.total === 2500 && JSON.stringify(await stock()) === '{"S":5,"M":3,"L":5,"D":9}', [B1, await stock()]);
await run('await flushSbQueue()');

console.log('--- a return: each item, how many, why, back on the shelf or not, the refund ---');
await run(`openBillView(${JSON.stringify(B1.id)})`); await sleep(300);
await A.click(`.billview [data-menu="bill-${B1.id}"]`); await sleep(150);
await A.click(`.billview [data-return="${B1.id}"]`); await sleep(300);
check('from the bill: Return opens the return sheet for it', await vis('#sheetHost .retsheet') && (await text('#sheetHost .retsheet h3') || '').includes(B1.no));
const lnOf = (name) => run(`return D().saleById[${JSON.stringify(B1.id)}].items.findIndex(i=>i.n===${JSON.stringify(name)})`);
const KL = await lnOf('Kurta'), DL = await lnOf('Dupatta');
await A.click(`#sheetHost [data-rtp="${KL}"]`); await sleep(150);
await A.click(`#sheetHost [data-rtp="${DL}"]`); await sleep(150);
check('each line coming back asks why (and whether it goes back on the shelf)', !!(await A.$(`#sheetHost [data-rtreason="${KL}"]`)) && !!(await A.$(`#sheetHost [data-rtreason="${DL}"]`)) && !(await A.$('#sheetHost #rtReason')));
await A.select(`#sheetHost [data-rtreason="${KL}"]`, 'Wrong size'); await sleep(150);
await A.select(`#sheetHost [data-rtreason="${DL}"]`, 'Damaged or faulty'); await sleep(150);
check('damaged or faulty: "Not for resale" ticks itself; wrong size stays for resale', await A.$eval(`#sheetHost [data-rtnfr="${DL}"]`, (c) => c.checked) && !(await A.$eval(`#sheetHost [data-rtnfr="${KL}"]`, (c) => c.checked)));
check('the refund: ₹1,500 by cash (how it was paid)', /Refund\s*₹1,500/.test(await text('#sheetHost .rt-sum') || '') && await A.$eval('#sheetHost [data-rtpay="pay:cash"]', (b) => b.getAttribute('aria-pressed') === 'true'));
await A.click('#sheetHost [data-act="rtsave"]'); await sleep(500);
const R1 = await run(`return D().rets.find(r=>r.sale===${JSON.stringify(B1.id)})`);
check('saved with a credit note: each line keeps its reason; the damaged one stays off the shelf', R1 && /^CN-/.test(R1.no) && R1.items.find((i) => i.n === 'Kurta').reason === 'Wrong size' && R1.items.find((i) => i.n === 'Kurta').restock !== false
  && R1.items.find((i) => i.n === 'Dupatta').reason === 'Damaged or faulty' && R1.items.find((i) => i.n === 'Dupatta').restock === false && R1.note === 'Wrong size; Damaged or faulty', R1);
check('stock: the Kurta M is back on the shelf (4), the damaged Dupatta is not (9)', JSON.stringify(await stock()) === '{"S":5,"M":4,"L":5,"D":9}', await stock());
await run('await flushSbQueue()');
const cloud = await dbUntil(`SELECT product_name, reason, restock FROM public.hangtag_return_items ORDER BY product_name`, (r) => r.length === 2);
check('in the cloud: each line with its reason and whether it went back', JSON.stringify(cloud) === JSON.stringify([{ product_name: 'Dupatta', reason: 'Damaged or faulty', restock: false }, { product_name: 'Kurta', reason: 'Wrong size', restock: true }]), cloud);

console.log('--- an exchange for another size: one tap ---');
await run(`openReturn(${JSON.stringify(B1.id)},"exchange")`); await sleep(300);
await A.click(`#sheetHost [data-rtp="${KL}"]`); await sleep(200);
const chips = await A.$$eval('#sheetHost .rt-swap [data-rtswap]', (l) => l.map((b) => b.textContent.trim()));
check('the Kurta M coming back offers its other sizes in stock: Swap for S, L', JSON.stringify(chips) === '["S","L"]', chips);
await A.select(`#sheetHost [data-rtreason="${KL}"]`, 'Wrong size'); await sleep(150);
await A.click(`#sheetHost [data-rtswap="${KL}|${V.L}"]`); await sleep(200);
check('...L goes on the new bill, as many as come back; same price: an even exchange', await run(`return retState.newItems.length===1&&retState.newItems[0].v===${JSON.stringify(V.L)}&&retState.newItems[0].q===1`)
  && /Even exchange/.test(await text('#sheetHost .rt-sum') || '') && !(await A.$(`#sheetHost [data-rtswap="${KL}|${V.L}"]`)), await text('#sheetHost .rt-sum'));
await A.click('#sheetHost [data-act="rtsave"]'); await sleep(600);
await run('closeModal();closeSheets()');
const X = await run(`return D().rets.filter(r=>r.sale===${JSON.stringify(B1.id)}).map(r=>({kind:r.kind,reason:r.items[0].reason}))`);
check('the exchange is saved: M back on the shelf, L out on the new bill', X.length === 2 && X[1].kind === 'exchange' && X[1].reason === 'Wrong size' && JSON.stringify(await stock()) === '{"S":5,"M":5,"L":4,"D":9}', [X, await stock()]);

console.log('--- after-sales in Reports; a return is not a cancellation ---');
await run('prefs.period="today";setTab("report");renderAll()'); await sleep(400);
const rc = await text('#returnsCard');
check('Reports: returns by reason — Wrong size 2, Damaged or faulty 1; the Kurta came back most', /2 returns · 3 pieces/.test(rc || '') && /Wrong size\s*2/.test(rc || '') && /Damaged or faulty\s*1/.test(rc || '') && /Kurta — 2 back, mostly “Wrong size”/.test(rc || '')
  && /Back on the shelf: 2 .* kept off, damaged: 1/.test(rc || ''), rc);
const v = await run(`return await voidSale(${JSON.stringify(B1.id)},"Mistake")`);
check('a bill with a return can\'t be cancelled — use a return instead', v && /has a return or exchange, so it can't be cancelled/.test(v.error || ''), v);
// the exchange's new bill: its credit note paid for it, so cancelling it would leave that credit nowhere
const XB = await run(`return D().sales.find(s=>s.kind==="exchange"&&!s.void).id`);
const xv = await run(`return await voidSale(${JSON.stringify(XB)},"Mistake")`);
check('the new bill of an exchange can\'t be cancelled either (its items come back as a return instead)', xv && /new bill of an exchange, so it can't be cancelled/.test(xv.error || '') && !(await run(`return D().saleById[${JSON.stringify(XB)}].void`)), xv);
await run(`openBillView(${JSON.stringify(XB)})`); await sleep(300);
check('…and its bill doesn\'t offer "Cancel bill"', !(await A.$(`[data-void="${XB}"]`)) && !!(await A.$('#modalHost .sheet')));
await run('closeModal()');
const PB = await run(`return (D().sales.find(s=>s.kind!=="exchange"&&!s.void&&!(D().retBySale[s.id]||[]).length)||{}).id||null`);
if (PB) { await run(`openBillView(${JSON.stringify(PB)})`); await sleep(300); check('(a bill without a return or exchange does offer it)', !!(await A.$(`[data-void="${PB}"]`))); await run('closeModal()'); }
else { await run(`addOne(${JSON.stringify(V.S)});await checkout("cash");closeSheets()`); const nb = await run('return lastSale.id'); await run(`openBillView(${JSON.stringify(nb)})`); await sleep(300);
  check('(a bill without a return or exchange does offer it)', !!(await A.$(`[data-void="${nb}"]`))); await run('closeModal()'); }

await browser.close();
await pg.close?.();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
