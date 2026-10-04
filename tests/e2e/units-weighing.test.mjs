// Units, weighing and device-scoped numbers, end to end in Chrome (batch T1, schema.sql section 3k).
// A product sold by the kg is set up in the product form (Unit select, 10.5 kg opening stock); tapping its tile opens the
// weight dialog (typed weight, then "Read scale" with a reading fed to the manual provider); the bill line keeps its weight
// in kg next to a product sold by the piece; the bill gets this device's number and saves 1.25 kg in the cloud with who
// made it; a return of 0.75 kg; a second device the same day numbers its own series; a bill forced onto a taken number is
// refused by the database, shown in the sync review and sent again with a new number; Settings → Hardware saves this
// device's scale settings. The database is PGlite running the real schema.sql behind a PostgREST stand-in.
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-000000000031', EMAIL = 'owner31@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, city, state, onboarded_at) VALUES ($1,$2,'Owner','Grain Store','9876543210','Pune','Maharashtra',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, city = EXCLUDED.city, state = EXCLUDED.state, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);
const q = async (sql, p = []) => (await pg.as(sql, p)).rows;

const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
async function openPage() {
  const P = await (await browser.createBrowserContext()).newPage();
  await P.setViewport({ width: 420, height: 900 });
  P.on('pageerror', (e) => { fails++; console.log('[pageerror]', e.message); });
  P.on('dialog', (d) => d.accept());
  await P.setRequestInterception(true);
  P.on('request', async (r) => {
    const u = r.url();
    if (u.startsWith('http://localhost:3210/')) return (u === 'http://localhost:3210/' || u.includes('/?')) ? r.respond({ status: 200, contentType: 'text/html', body: H.hookedHtml() }) : r.continue();
    if (u.includes('.supabase.co/')) { if (!(await pg.handle(r, {}))) r.abort(); return; }
    r.continue();
  });
  await P.evaluateOnNewDocument((s) => { if (location.hostname === 'localhost') localStorage.setItem('hangtag-auth', s); }, JSON.stringify(pg.session()));
  await P.goto('http://localhost:3210/', { waitUntil: 'networkidle0' });
  const run = (b) => P.evaluate((b) => __ev('(async()=>{' + b + '})()'), b);
  const until = async (cond, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run('return !!(' + cond + ')').catch(() => false)) return true; await sleep(120); } return false; };
  const text = (sel) => P.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
  const vis = (sel) => P.$eval(sel, (e) => !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0).catch(() => false);
  const type = async (sel, v) => { await P.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, v); await sleep(80); };
  return { P, run, until, text, vis, type };
}
const A = await openPage();
check('signed in and connected', await A.until('sbStatus==="connected"'));

console.log('--- the product form: Unit ---');
await A.run(`openEditor(null)`); await sleep(200);
const plain = await A.P.$$eval('#edUnit option', (o) => o.map((x) => x.value));
check('without Weight-based products: pieces, box, pack, dozen and metre (no kg, gram or litre)', JSON.stringify(plain) === JSON.stringify(['pcs', 'box', 'pack', 'dozen', 'm']), plain);
check('…and a product can\'t be saved by the kg (the capability is checked, not just hidden)', /Selling by weight is switched off/.test(await A.run(`editor.name="Dal";editor.price="90";editor.unit="kg";return (saveProduct({draft:editor})||{}).error||""`)));
await A.run(`closeModal();saveCapabilities({uses_weight:true});openEditor(null)`); await sleep(200);
const opts = await A.P.$$eval('#edUnit option', (o) => o.map((x) => x.value));
check('the product form has a Unit select with the nine units', JSON.stringify(opts) === JSON.stringify(['pcs', 'box', 'pack', 'dozen', 'kg', 'g', 'l', 'ml', 'm']), opts);
await A.type('#modalHost [data-ed="name"]', 'Basmati Rice'); await A.type('#modalHost [data-ed="price"]', '120');
await A.P.select('#edUnit', 'kg'); await sleep(150);
const kgBox = await A.P.$eval('#modalHost [data-edf="stock"]', (i) => [i.getAttribute('inputmode'), i.step]).catch((e) => String(e)), kgText = await A.text('#modalHost');
check('choosing kg: the stock box takes decimals', kgBox[0] === 'decimal' && kgBox[1] === 'any' && /per kg/.test(kgText), { kgBox, unit: await A.run('return editor.unit'), t: (kgText || '').slice(0, 300) });
await A.run(`edCombos()[0].cell.stock="10.5";saveEditor()`);
await A.run(`openEditor(null);editor.name="Tote";editor.price="300";edCombos()[0].cell.stock="5";saveEditor();await flushSbQueue();setTab("sell");renderAll()`);
const RICE = await A.run(`const p=products().find(p=>p.name==="Basmati Rice");return {pid:p.id,vid:p.variants[0].id,unit:p.unit}`);
const TOTE = await A.run(`const p=products().find(p=>p.name==="Tote");return {pid:p.id,vid:p.variants[0].id,unit:p.unit||"pcs"}`);
check('saved: rice is sold by the kg with 10.5 kg in stock; the tote by the piece', RICE.unit === 'kg' && TOTE.unit === 'pcs' && await A.run(`return stockOf(${JSON.stringify(RICE.vid)})===10.5`), RICE);
const cp = (await q(`SELECT unit FROM public.hangtag_products WHERE id = $1`, [RICE.pid]))[0], cm = (await q(`SELECT sum(qty) AS q FROM public.hangtag_stock_moves WHERE variant_id = $1`, [RICE.vid]))[0];
check('in the cloud: unit kg, opening stock 10.500', cp && cp.unit === 'kg' && +cm.q === 10.5, { cp, cm });

console.log('--- selling by weight ---');
await A.P.click(`.tile[data-pid="${RICE.pid}"]`).catch(async () => { await A.run(`openPicker(${JSON.stringify(RICE.pid)})`); });
await sleep(250);
check('tapping a product sold by the kg opens the weight dialog (typing works without a scale)', await A.vis('#wgSheet') && /No scale connected/.test(await A.text('#wgSheet')) && await A.run('return !!weigh&&cart.length===0'));
await A.type('#wgVal', '2.5');
check('the amount is shown as the weight is typed: 2.5 kg × ₹120/kg = ₹300', /2\.5 kg × ₹120\/kg = ₹300/.test(await A.text('#wgAmt')), await A.text('#wgAmt'));
await A.type('#wgVal', '11');
await A.P.click('#wgSheet [data-act="wgadd"]'); await sleep(200);
check('more than the stock is refused in the dialog', /Only 10\.5 kg in stock/.test(await A.text('#wgErr')) && await A.run('return cart.length===0'));
await A.type('#wgVal', '2.5');
await A.P.click('#wgSheet [data-act="wgadd"]'); await sleep(250);
check('added: one line of 2.5 kg', await A.run('return cart.length===1&&cart[0].q===2.5&&cart[0].u==="kg"&&!weigh'), await A.run('return cart'));
// weigh the line again from the scale (a reading fed to the manual provider, as a scale would print it)
await A.run(`weightScale().feed("ST,GS,+  1.250kg");openWeigh(${JSON.stringify(RICE.vid)},0)`); await sleep(200);
await A.P.click('#wgSheet [data-act="wgread"]'); await sleep(300);
check('"Read scale" puts the settled weight in the box', (await A.P.$eval('#wgVal', (i) => i.value)) === '1.25' && /Read from the scale: 1\.25 kg/.test(await A.text('#wgNote')), await A.text('#wgSheet'));
await A.P.click('#wgSheet [data-act="wgadd"]'); await sleep(250);
check('"Update weight" replaces the line\'s quantity: 1.25 kg', await A.run('return cart.length===1&&cart[0].q===1.25'));
await A.run(`addOne(${JSON.stringify(TOTE.vid)})`);
const bad = await A.run(`return setLineQty(1,"1.5")`);
check('a product sold by the piece keeps whole numbers', !bad.ok && /whole number/.test(bad.message) && await A.run('return cart[1].q===1'), bad);
check('the items on the bill count the weighed line once (1.25 kg + 1 tote = 2 items)', await A.run('return cartPcs()===2'));
await A.run(`const s=await checkout("cash");window.__s1=s`); await sleep(300);
const S1 = await A.run('return window.__s1');
const DEV_A = await A.run('return dev'), CODE_A = await A.run(`return deviceCode(dev)`);
check('the bill gets this device\'s number: INV-yymmdd-' + CODE_A + '001', S1 && new RegExp('^INV-\\d{6}-' + CODE_A + '001$').test(S1.no), S1 && S1.no);
check('the line is 1.25 kg at ₹120/kg = ₹150; the tote ₹300', S1.items[0].q === 1.25 && S1.items[0].u === 'kg' && S1.sub === 450, S1.items);
check('the receipt says 1.25 kg', await A.run(`return /Basmati Rice × 1\\.25 kg = ₹150/.test(receiptText(lastSale))`), await A.run('return receiptText(lastSale)'));
check('stock of rice after selling 1.25 kg: 9.25 kg', await A.run(`return stockOf(${JSON.stringify(RICE.vid)})===9.25`));
await A.run('closeSheets();await flushSbQueue()');
const cl = await q(`SELECT i.quantity, i.unit, s.bill_no, s.subtotal, s.user_id::text AS u FROM public.hangtag_sale_items i JOIN public.hangtag_sales s ON s.owner_id = i.owner_id AND s.id = i.sale_id WHERE s.id = $1 ORDER BY i.line_no`, [S1.id]);
check('in the cloud: 1.250 kg and 1 pcs, the device number, ₹450.00, made by this account', cl.length === 2 && +cl[0].quantity === 1.25 && cl[0].unit === 'kg' && cl[1].unit === 'pcs' && cl[0].bill_no === S1.no && +cl[0].subtotal === 450 && cl[0].u === UID, cl);

console.log('--- a return of 0.75 kg ---');
await A.run(`openReturn(${JSON.stringify(S1.id)})`); await sleep(250);
await A.type('#sheetHost [data-rtq="0"]', '0.75').catch(() => {});
await A.run(`if(!retState.q||retState.q[0]!==0.75){setReturnQty(0,"0.75")}`);
check('the return sheet takes 0.75 kg of the 1.25 kg line', await A.run('return retState.q[0]===0.75'));
await A.P.click('#sheetHost [data-act="rtsave"]'); await sleep(400);
const R1 = await A.run(`return D().rets.find(r=>r.sale===${JSON.stringify(S1.id)})`);
check('credit note in this device\'s series; 0.75 kg back on the shelf', R1 && new RegExp('^CN-\\d{6}-' + CODE_A + '001$').test(R1.no) && R1.items[0].q === 0.75 && await A.run(`return stockOf(${JSON.stringify(RICE.vid)})===10`), R1);
await A.run('await flushSbQueue()');
const cr = (await q(`SELECT quantity, unit FROM public.hangtag_return_items WHERE return_id = $1`, [R1 && R1.id]))[0];
check('in the cloud: 0.750 kg returned', cr && +cr.quantity === 0.75 && cr.unit === 'kg', cr);

console.log('--- a second device the same day ---');
const B = await openPage();
check('device B signed in and connected', await B.until('sbStatus==="connected"') && await B.run('return dev') !== DEV_A);
await B.until(`products().some(p=>p.name==="Tote")`);
await B.run(`addOne(products().find(p=>p.name==="Tote").variants[0].id);window.__sb=await checkout("cash");await flushSbQueue()`);
const SB = await B.run('return window.__sb'), CODE_B = await B.run('return deviceCode(dev)');
check('device B numbers its own series from 001; both bills are in the cloud with different numbers', SB && new RegExp('^INV-\\d{6}-' + CODE_B + '001$').test(SB.no) && SB.no !== S1.no
  && (await q(`SELECT count(DISTINCT bill_no)::int AS n FROM public.hangtag_sales WHERE id IN ($1, $2)`, [S1.id, SB.id]))[0].n === 2, SB && SB.no);

console.log('--- a taken number: refused, reviewed, renumbered ---');
await A.run(`addOne(${JSON.stringify(TOTE.vid)});const s=newSaleRecord(cart.map(c=>({...c})),null,"cash",{cust:null});s.no=${JSON.stringify(S1.no)};cart.length=0;recordSale(s);window.__dup=s.id;await flushSbQueue()`);
check('the database refuses a second bill with the same number; it waits in the sync review', await A.until('syncReview.length===1') && await A.run('return numberTaken(syncReview[0])'), await A.run('return syncReview'));
await A.run('openSyncPanel()'); await sleep(250);
check('the sync review offers "Give it a new number and send"', await A.vis('#modalHost [data-syncrenumber="0"]'));
await A.P.click('#modalHost [data-syncrenumber="0"]');
const DUP = await A.run('return window.__dup');
check('renumbered to the next of this device\'s series and uploaded', await A.until(`syncReview.length===0&&!sbOfflineQueue.length`)
  && new RegExp(CODE_A + '003$').test((await q(`SELECT bill_no FROM public.hangtag_sales WHERE id = $1`, [DUP]))[0]?.bill_no || ''), await q(`SELECT bill_no FROM public.hangtag_sales WHERE id = $1`, [DUP]));
await A.run('closeModal()');

console.log('--- Settings → Team & Devices: the weighing scale on this device ---');
await A.run('openSettings("devices")'); await sleep(300);
check('the settings show this device\'s weighing scale', await A.vis('#scaleSetup') && /Weighing scale/.test(await A.text('#scaleSetup')));
await A.P.select('#scaleForm [name="baud"]', '4800');
await A.type('#scaleForm [name="request"]', 'W');
await A.P.click('#scaleForm [type="submit"]'); await sleep(250);
check('saved on this device only (not synced)', await A.run(`return scale.baud===4800&&scale.request==="W"&&JSON.parse(localStorage.getItem("hangtag_scale")).baud===4800`)
  && !(await q(`SELECT key FROM public.hangtag_meta WHERE value::text LIKE '%4800%'`)).length);
await A.P.screenshot({ path: H.ARTIFACTS + '/uw_scale_settings_phone.png' });

await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
