// Suppliers, purchases, stock count, factory barcode intake and bulk product import, end to end in Chrome (batch T2,
// schema.sql section 3l): Inventory's parts in the navigation; a supplier and a purchase with a kg line and cash paid
// (stock in, the cloud's purchase row, stock-in records and cash book entry, what the supplier is still owed); the same
// invoice flagged; a stock count adjustment; an unknown barcode made into a product; an import that is all or nothing.
// The database is PGlite running the real schema.sql behind a PostgREST stand-in.
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-000000000041', EMAIL = 'owner41@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, city, state, onboarded_at) VALUES ($1,$2,'Owner','Mill Store','9876543210','Pune','Maharashtra',now())
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
const today = await A.run(`return dayKey(Date.now())`);

// two products: one by the piece, one by the kg (the shop sells by weight: Weight-based products switched on)
await A.run(`saveCapabilities({uses_weight:true});openEditor(null);editor.name="Tee";editor.price="500";edCombos()[0].cell.stock="5";saveEditor();
  openEditor(null);editor.name="Rice";editor.price="90";editor.unit="kg";edCombos()[0].cell.stock="10.5";saveEditor();await flushSbQueue()`);
const TEE = await A.run(`const p=products().find(p=>p.name==="Tee");return {pid:p.id,vid:p.variants[0].id}`);
const RICE = await A.run(`const p=products().find(p=>p.name==="Rice");return {pid:p.id,vid:p.variants[0].id,unit:p.unit}`);
check('products saved (rice by the kg)', !!TEE.vid && RICE.unit === 'kg', RICE);

console.log('--- Inventory parts in the navigation ---');
await A.run(`setTab("stock");renderAll()`); await sleep(200);
const parts = await A.P.$$eval('[data-subnav="stock"] [data-subview]', (b) => b.map((x) => x.dataset.subview));
check('Inventory shows Stock, Purchases, Suppliers and Stock count', ['stock:levels', 'stock:purchases', 'stock:suppliers', 'stock:count'].every((p) => parts.includes(p)), parts);

console.log('--- suppliers and a purchase ---');
const SUP = await A.run(`const r=saveSupplier({name:"Ravi Textiles",phone:"9876543210",gstin:"27ABCDE1234F1Z5"});await flushSbQueue();return r.supplier&&r.supplier.id`);
check('a supplier is saved in the cloud', !!SUP && (await q(`SELECT name FROM public.hangtag_suppliers WHERE id = $1`, [SUP]))[0]?.name === 'Ravi Textiles');
const PU = await A.run(`const r=savePurchase({supplierId:${JSON.stringify(SUP)},invoiceNo:"INV-77",invoiceDate:${JSON.stringify(today)},
  lines:[{v:${JSON.stringify(TEE.vid)},q:"10",cost:"200",gst:"5"},{v:${JSON.stringify(RICE.vid)},q:"2.5",cost:"50",gst:"0"}],paid:"500",method:"cash"});
  await flushSbQueue();return r.error?{error:r.error}:{id:r.purchase.id,total:r.purchase.total}`);
check('a purchase with a kg line (2.5 kg) and cash paid is saved', PU && PU.id && PU.total === 2225, PU);
check('stock comes in: tee 5 → 15, rice 10.5 → 13 kg', await A.run(`return stockOf(${JSON.stringify(TEE.vid)})===15&&stockOf(${JSON.stringify(RICE.vid)})===13`));
const imp = (await q(`SELECT kind, supplier_id, invoice_no, total_amount, paid_amount, units FROM public.hangtag_stock_imports WHERE id = $1`, [PU.id]))[0];
const mv = await q(`SELECT type, qty FROM public.hangtag_stock_moves WHERE import_id = $1 ORDER BY qty`, [PU.id]);
const cash = await q(`SELECT type, amount FROM public.hangtag_cash_moves WHERE id = $1`, ['pur:' + PU.id]);
check('in the cloud: the purchase, its stock-in records and the cash paid out', imp && imp.kind === 'purchase' && imp.supplier_id === SUP && +imp.total_amount === 2225 && +imp.units === 12.5
  && mv.length === 2 && +mv[0].qty === 2.5 && mv.every((m) => m.type === 'RESTOCK') && cash.length === 1 && cash[0].type === 'out' && +cash[0].amount === 500, { imp, mv, cash });
check('the supplier is owed the rest', await A.run(`const a=supplierAccount(${JSON.stringify(SUP)},purchasesList(),Object.values(supplierPays||{}));return a.outstanding===1725`));
await A.run(`chooseSubview("stock","purchases");renderAll()`); await sleep(200);
check('Inventory → Purchases lists it', /INV-77/.test(await A.text('[data-subalt="stock"]') || ''));
const dup = await A.run(`const r=savePurchase({supplierId:${JSON.stringify(SUP)},invoiceNo:"inv-77",lines:[{v:${JSON.stringify(TEE.vid)},q:"1",cost:"200"}],paid:"0"});return r`);
check('the same invoice from the same supplier is flagged before saving twice', dup && dup.duplicate === true, dup);

console.log('--- stock count ---');
const SC = await A.run(`const r=confirmStockCount({rows:[{vid:${JSON.stringify(TEE.vid)},pid:${JSON.stringify(TEE.pid)},system:stockOf(${JSON.stringify(TEE.vid)}),dec:0}],typed:{${JSON.stringify(TEE.vid)}:"14"},reason:"Damaged"});await flushSbQueue();return r`);
const adj = await q(`SELECT qty, note FROM public.hangtag_stock_moves WHERE variant_id = $1 AND type = 'ADJUST'`, [TEE.vid]);
const left = await A.run(`renderAll();return stockOf(${JSON.stringify(TEE.vid)})`);
check('a count of 14 against 15: one ADJUST of −1 "Stock count: Damaged", in the cloud', SC && SC.changed === 1 && adj.length === 1 && +adj[0].qty === -1 && adj[0].note === 'Stock count: Damaged' && left === 14, { SC, adj, left });

console.log('--- factory barcode intake ---');
const code = '5012345678900';
check('an unknown code offers a new product', await A.run(`return findCode(${JSON.stringify(code)}).unknown===${JSON.stringify(code)}`));
const QP = await A.run(`const r=quickCreateProduct({code:${JSON.stringify(code)},name:"Soap",price:"40",unit:"pcs"});await flushSbQueue();return r.error?r:{vid:r.variant.id}`);
check('the new product has the code as its barcode (and the cloud has it)', QP.vid && await A.run(`return findCode(${JSON.stringify(code)}).hit.v.id===${JSON.stringify(QP.vid)}`)
  && (await q(`SELECT barcode FROM public.hangtag_variants WHERE id = $1`, [QP.vid]))[0]?.barcode === code, QP);

console.log('--- bulk import ---');
const csv = (rows) => JSON.stringify(rows.join('\n'));
const bad = await A.run(`return importProducts(parseCsv(${csv(['Name,Price,SKU', 'Mug,120,M-1', 'Cup,abc,M-1'])}))`);
check('a file with a bad row imports nothing', bad && /nothing is imported/.test(bad.error || '') && await A.run(`return !products().some(p=>p.name==="Mug")`), bad);
const good = await A.run(`const r=importProducts(parseCsv(${csv(['Name,Option 1 name,Option 1 value,Price,Opening stock,Unit', 'Mug,Colour,Red,120,4,pcs', 'Mug,Colour,Blue,120,6,pcs', 'Sugar,,,45,7.5,kg'])}));await flushSbQueue();return r`);
check('a good file: 2 products, 3 variants, opening stock (7.5 kg sugar)', good && good.products === 2 && good.variants === 3 && await A.run(`renderAll();const s=products().find(p=>p.name==="Sugar");return s&&s.unit==="kg"&&stockOf(s.variants[0].id)===7.5`), good);
check('imported products are in the cloud', (await q(`SELECT count(*)::int AS n FROM public.hangtag_products WHERE name IN ('Mug','Sugar')`))[0].n === 2);
await A.P.screenshot({ path: H.ARTIFACTS + '/pic_purchases_phone.png' });

await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
