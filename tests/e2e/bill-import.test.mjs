// Supplier bill import, end to end in Chrome: upload (PDF and photo) → extraction (Edge Function stubbed) → review →
// summary → confirm. The database is PGlite running the real schema.sql behind a PostgREST stand-in, as the signed-in
// user with row-level security, so the import RPC, its all-or-nothing save and the duplicate checks are real.
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import crypto from 'crypto';
import H from '../helpers/env.mjs';
import { createPgRest, CORS } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 400) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-000000000001', OTHER = 'bbbbbbbb-0000-0000-0000-000000000002', EMAIL = 'owner@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'other@example.com')`, [OTHER]);
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, city, state, onboarded_at) VALUES ($1,$2,'Owner','Owner Shop','9876543210','Pune','Maharashtra',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, city = EXCLUDED.city, state = EXCLUDED.state, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);
const q1 = async (sql, who) => (await pg.as(sql, [], who)).rows;

// ---------- files and the stubbed extract-bill function ----------
const PDF = H.ARTIFACTS + '/bill-inv-1042.pdf', IMG = H.ARTIFACTS + '/bill-photo.png', PDF2 = H.ARTIFACTS + '/notconfigured.pdf';
fs.writeFileSync(PDF, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
fs.writeFileSync(PDF2, '%PDF-1.4\n% other\n%%EOF\n');
fs.writeFileSync(IMG, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
const L = (o) => Object.assign({ name: 'Dress', description: null, brand: 'Aura', options: [], quantity: 1, unit_price: 600, total_price: null, mrp: 999, sku: null, barcode: null, hsn: '6204', gst_rate: 5, tax_amount: null, confidence: 0.95, notes: null }, o);
const opt = (c, s) => [{ name: 'Colour', value: c }, { name: 'Size', value: s }];
const head = { ok: true, provider: 'mock', model: 'mock', supplier: { name: 'Ravi Textiles', gstin: '27ABCDE1234F1Z5' }, invoice: { number: 'INV-1042', date: '2026-09-20' }, currency: 'INR' };
const FULL = { ...head, warnings: ['Skipped: Freight ₹200'], lines: [
  L({ sku: 'DR-BLK-M', options: opt('Black', 'M'), quantity: 5 }),            // 1 existing: SKU
  L({ barcode: 'DRBL-001', quantity: 2 }),                                   // 2 existing: barcode
  L({ options: opt('White', 'M'), quantity: 3 }),                            // 3 existing: product + options
  L({ options: opt('Red', 'M'), quantity: 4, mrp: 1049 }),                   // 4 new variant of Dress
  L({ name: 'Kurti', brand: null, options: opt('Black', 'S'), quantity: 2, mrp: 799, unit_price: 400 }),   // 5-7 one new product, 3 variants
  L({ name: 'Kurti', brand: null, options: opt('Black', 'M'), quantity: 2, mrp: 799, unit_price: 400 }),
  L({ name: 'Kurti', brand: null, options: opt('White', 'S'), quantity: 2, mrp: 799, unit_price: 400, confidence: 0.6, notes: 'Colour smudged' }),
  L({ name: 'Tote Bag', brand: null, quantity: 10, mrp: null, unit_price: 180, hsn: null, gst_rate: 12, confidence: 0.5 }),   // 8 simple new product, price missing
  L({ name: 'Belt', brand: null, quantity: null, unit_price: null, mrp: null, hsn: null, gst_rate: null, confidence: 0.3 }),     // 9 missing fields
] };
const PHOTO = { ...head, warnings: [], lines: [L({ sku: 'DR-BLK-M', options: opt('Black', 'M'), quantity: 1 })] };
const fnCalls = [];
const extractBill = async (r) => {
  const body = JSON.parse(r.postData());
  fnCalls.push({ type: body.mime_type, name: body.file_name, bytes: body.data.length, hash: body.file_hash });
  if (body.file_name === 'notconfigured.pdf') return r.respond({ status: 503, contentType: 'application/json', headers: CORS, body: JSON.stringify({ ok: false, error: 'not_configured', message: 'no key' }) });
  r.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body.mime_type === 'application/pdf' ? FULL : PHOTO) });
};

// ---------- the app, signed in and connected ----------
const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
const A = await (await browser.createBrowserContext()).newPage();
await A.setViewport({ width: 1280, height: 900 });
A.on('pageerror', (e) => { fails++; console.log('[pageerror]', e.message); });
A.on('dialog', (d) => d.accept());
await A.setRequestInterception(true);
A.on('request', async (r) => {
  const u = r.url();
  if (u.startsWith('http://localhost:3210/')) return (u === 'http://localhost:3210/' || u.includes('/?')) ? r.respond({ status: 200, contentType: 'text/html', body: H.hookedHtml() }) : r.continue();
  if (u.includes('.supabase.co/')) { if (!(await pg.handle(r, { '/functions/v1/extract-bill': extractBill }))) r.abort(); return; }
  r.continue();
});
await A.evaluateOnNewDocument((s) => { if (location.hostname === 'localhost') localStorage.setItem('hangtag-auth', s); }, JSON.stringify(pg.session()));
await A.goto('http://localhost:3210/', { waitUntil: 'networkidle0' });
const run = (b) => A.evaluate((b) => __ev('(async()=>{' + b + '})()'), b);
async function until(cond, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run('return !!(' + cond + ')').catch(() => false)) return true; await sleep(100); } return false; }
check('signed in and connected to the (stand-in) cloud', await until('sbStatus==="connected"'), await run('return sbStatus'));

// existing catalog: Dress (Colour × Size) with a SKU and a barcode, made in the product editor and uploaded
await run(`openEditor(null);editor.name="Dress";editor.brand="Aura";editor.price="999";editor.cost="600";edToggleOptions(true);edAddOption("Colour");edAddValues(0,["Black","White"]);edAddOption("Size");edAddValues(1,["M","L"]);
  editor.codesOn=true;const c=edCombos();c[0].cell.sku="DR-BLK-M";c[0].cell.stock="4";c[1].cell.bc="DRBL-001";saveEditor();await flushSbQueue();`);
const dress = await q1(`SELECT v.id, v.option_values, v.sku, v.barcode FROM public.hangtag_variants v JOIN public.hangtag_products p ON p.id = v.product_id AND p.owner_id = v.owner_id WHERE p.name = 'Dress' ORDER BY v.sort_order`);
check('the Dress and its 4 variants are in the database with their option values', dress.length === 4 && JSON.stringify(dress[0].option_values) === '["Black","M"]' && dress[1].barcode === 'DRBL-001', dress);
const vid = (c, s) => run(`return prod(products().find(p=>p.name==="Dress").id).variants.find(v=>v.o[0]===${JSON.stringify(c)}&&v.o[1]===${JSON.stringify(s)}).id`);
const vBM = await vid('Black', 'M');
const counts = async () => (await q1(`SELECT (SELECT count(*) FROM public.hangtag_products)::int p, (SELECT count(*) FROM public.hangtag_variants)::int v, (SELECT count(*) FROM public.hangtag_stock_moves)::int m, (SELECT count(*) FROM public.hangtag_stock_imports)::int i`))[0];

// ---------- 1. PDF upload → review ----------
await run('setTab("stock")'); await sleep(200);
await A.click('.vh-acts [data-act="billimport"]'); await sleep(200);
check('Stock page has "Upload bill"; it offers camera, gallery and PDF', (await A.$$('.bi-pick input[data-bifile]')).length === 3
  && !!(await A.$('.bi-pick input[capture="environment"]')) && !!(await A.$('.bi-pick input[accept^="application/pdf"]')));
await A.screenshot({ path: H.ARTIFACTS + '/bi1_pick.png' });
const before = await counts();
await (await A.$('.bi-pick input[accept^="application/pdf"]')).uploadFile(PDF);
check('reading → review screen', await until('billImport&&billImport.step==="review"'), await run('return billImport&&[billImport.step,billImport.err]'));
check('PDF sent to the extract-bill function as a PDF with its fingerprint', fnCalls[0] && fnCalls[0].type === 'application/pdf' && fnCalls[0].bytes > 50 && /^[0-9a-f]{64}$/.test(fnCalls[0].hash), fnCalls);
check('review before commit: nothing was added to the database yet', JSON.stringify(await counts()) === JSON.stringify(before));
const lines = await run('return billImport.lines.map(l=>({id:l.id,name:l.name,action:l.action,kind:l.match.kind,nr:l.needsReview,sell:l.sellPrice,qty:l.qty}))');
check('9 lines, each with the suggested action', lines.length === 9 && lines.map((l) => l.action).join() === 'existing,existing,existing,new-variant,new-product,new-product,new-product,new-product,new-product', lines.map((l) => l.action + ':' + l.kind));
check('match kinds: SKU, barcode, product + options, product only', lines.slice(0, 4).map((l) => l.kind).join() === 'sku,barcode,variant,product');
check('missing fields stay blank (no invented price or quantity)', lines[7].sell === null && lines[8].qty === null);
await run('billImport.filter="all";renderBillImport()'); await sleep(100);
const cards = await A.$$eval('.bi-line', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ')));
check('review cards show "Existing product found: Dress → Black → M"', /Existing product found: Dress → Black → M/.test(cards[0]), cards[0]);
check('uncertain lines are marked "Needs review" with the reason', (await A.$$('.bi-line.nr')).length === 3 && /Colour smudged/.test(cards[6]) && /No quantity/.test(cards[8]));
check('a new variant of an existing product is announced', /New variant of Dress: Red \/ M/.test(cards[3]), cards[3]);
await A.screenshot({ path: H.ARTIFACTS + '/bi2_review_desktop.png' });

// summary refuses while lines need attention
await A.click('[data-bi="tosummary"]'); await sleep(300);
check('summary lists what must be fixed and offers no Confirm yet', (await A.$$('.bi-errs li')).length >= 3 && !(await A.$('[data-bi="commit"]')));
check('still nothing in the database', JSON.stringify(await counts()) === JSON.stringify(before));
await A.click('[data-bi="back"]'); await sleep(200);

// fix: selling price for the tote, remove the unreadable line, confirm the rest
const tote = lines[7].id, belt = lines[8].id;
await A.type(`#bi-${tote} [data-bif="sellPrice"]`, '449'); await A.click('#biT'); await sleep(150);
await A.click(`#bi-${belt} [data-bi="remove"]`); await sleep(100);
await A.click('[data-bi="confirmall"]'); await sleep(150);
await A.click('[data-bi="tosummary"]'); await sleep(400);
const sums = await A.$$eval('.bi-sum b', (x) => x.map((e) => +e.textContent));
check('summary: 2 products to create, 5 variants, 1 existing product matched, 30 units', JSON.stringify(sums) === '[2,5,1,30]', sums);
await A.screenshot({ path: H.ARTIFACTS + '/bi3_summary.png' });
await A.click('[data-bi="commit"]');
check('confirm → stock added', await until('billImport&&billImport.step==="done"'), await run('return billImport&&[billImport.step,billImport.err]'));

// ---------- 2. what the database and the app now hold ----------
const imp = await q1(`SELECT id, invoice_no, supplier_gstin, units, line_count, file_hash FROM public.hangtag_stock_imports`);
const mv = await q1(`SELECT type, qty, import_id, note FROM public.hangtag_stock_moves WHERE import_id IS NOT NULL`);
check('one import record with the invoice and 30 units', imp.length === 1 && imp[0].invoice_no === 'INV-1042' && imp[0].units === 30 && imp[0].line_count === 8, imp);
check('stock went in as 8 RESTOCK moves in the ledger (no stock numbers written)', mv.length === 8 && mv.every((m) => m.type === 'RESTOCK' && m.import_id === imp[0].id) && mv.reduce((a, m) => a + m.qty, 0) === 30 && /Supplier bill INV-1042 · Ravi Textiles/.test(mv[0].note), mv);
const kurti = await q1(`SELECT p.options, (SELECT json_agg(v.option_values ORDER BY v.sort_order) FROM public.hangtag_variants v WHERE v.owner_id = p.owner_id AND v.product_id = p.id) AS vs FROM public.hangtag_products p WHERE p.name = 'Kurti'`);
check('new product Kurti with Colour × Size options and 3 variants', kurti.length === 1 && JSON.stringify(kurti[0].vs) === '[["Black","S"],["Black","M"],["White","S"]]', kurti);
const dressOpts = (await q1(`SELECT options FROM public.hangtag_products WHERE name = 'Dress'`))[0].options;
check('Dress gained the new value Red and a Red / M variant', dressOpts.opts[0].values.includes('Red') && (await q1(`SELECT count(*)::int n FROM public.hangtag_variants WHERE option_values = '["Red","M"]'`))[0].n === 1);
const toteRow = (await q1(`SELECT price, cost_price, gst_rate::float g FROM public.hangtag_products WHERE name = 'Tote Bag'`))[0];
check('the simple new product took the corrected price, cost and GST', toteRow && toteRow.price === 449 && toteRow.cost_price === 180 && toteRow.g === 12, toteRow);
check('the unreadable line was left out', !(await q1(`SELECT 1 FROM public.hangtag_products WHERE name = 'Belt'`)).length);
const local = await run(`return {bm:stockOf(${JSON.stringify(vBM)}),kurti:products().filter(p=>p.name==="Kurti").length,history:$("#stockBody").textContent.includes("Supplier bill")}`);
check('this device: Black / M 4 → 9, new products shown, stock history names the bill', local.bm === 9 && local.kurti === 1 && local.history, local);
await A.click('[data-bi="close"]'); await sleep(150);

// ---------- 3. the same file again ----------
await A.click('.vh-acts [data-act="billimport"]'); await sleep(200);
await (await A.$('.bi-pick input[accept^="application/pdf"]')).uploadFile(PDF);
check('the same file again → "This bill may already have been imported."', await until('billImport&&billImport.step==="dup"') && /may already have been imported/.test(await A.$eval('.bi-warn', (e) => e.textContent)));
await A.click('.sh-acts [data-bi="cancel"]'); await sleep(150);

// ---------- 4. a photo of the same invoice (another shop has this photo on file) ----------
const photoHash = crypto.createHash('sha256').update(fs.readFileSync(IMG)).digest('hex');
await pg.as(`INSERT INTO public.hangtag_stock_imports (id, file_hash, invoice_no) VALUES ('b-imp', '${photoHash}', 'INV-1042')`, [], OTHER);
await A.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true }); await sleep(300);
await A.click('.vh-acts [data-act="billimport"]'); await sleep(200);
await (await A.$('.bi-pick input[accept="image/*"]:not([capture])')).uploadFile(IMG);
check("another shop's import of the same photo doesn't count (isolation) → straight to review", await until('billImport&&billImport.step==="review"'), await run('return billImport.step'));
check('the photo was sent as a JPEG picture', fnCalls[fnCalls.length - 1].type === 'image/jpeg');
const overflow = await A.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check('phone: the review screen fits the width (no sideways scrolling)', overflow <= 1, overflow);
await A.screenshot({ path: H.ARTIFACTS + '/bi4_review_phone.png' });
await A.click('[data-bi="tosummary"]'); await sleep(600);
check('same supplier + invoice number → warning before confirming', /This invoice was added/.test(await A.$eval('.billimp', (e) => e.textContent)));
await A.screenshot({ path: H.ARTIFACTS + '/bi5_summary_phone.png' });
const m1 = (await counts()).m;
await A.click('[data-bi="commit"]'); await sleep(800);
check('the database refuses the repeat (nothing added) and asks', (await counts()).m === m1 && !!(await A.$('[data-bi="commitdup"]')));
await A.click('[data-bi="commitdup"]');
check('"Add anyway" adds it', await until('billImport&&billImport.step==="done"') && (await counts()).m === m1 + 1);
await A.click('[data-bi="close"]'); await sleep(150);
await A.setViewport({ width: 1280, height: 900 }); await sleep(200);

// ---------- 5. a save that fails leaves no partial stock ----------
await A.click('.vh-acts [data-act="billimport"]'); await sleep(200);
await A.click('[data-bi="manual"]'); await sleep(200);
const man = await run('return billImport.lines[0].id');
for (const [f, v] of [['name', 'Scarf'], ['qty', '3'], ['sellPrice', '299'], ['sku', 'SC-RACE']]) { await A.type(`#bi-${man} [data-bif="${f}"]`, v); await A.click('#biT'); await sleep(120); }
await A.click('[data-bi="tosummary"]'); await sleep(400);
check('hand-entered line: 1 new product, 3 units', JSON.stringify(await A.$$eval('.bi-sum b', (x) => x.map((e) => +e.textContent))) === '[1,1,0,3]');
// meanwhile another device takes the SKU
const toteId = (await q1(`SELECT id FROM public.hangtag_products WHERE name = 'Tote Bag'`))[0].id;
await pg.as(`INSERT INTO public.hangtag_variants (id, product_id, option_values, sku, active) VALUES ('race', '${toteId}', '["Race"]', 'sc-race', false)`, []);
const snap = await counts(), localSnap = await run('return products().length+":"+Object.keys(moves).length');
await A.click('[data-bi="commit"]'); await sleep(1200);
check('failed save: an error, and nothing added in the database', JSON.stringify(await counts()) === JSON.stringify(snap) && /Nothing was changed/.test(await A.$eval('.billimp', (e) => e.textContent)), await counts());
check('…or on this device', (await run('return products().length+":"+Object.keys(moves).length')) === localSnap);
await run('billImport=null;closeModal()');

// ---------- 6. the reading service isn't set up ----------
await A.click('.vh-acts [data-act="billimport"]'); await sleep(200);
await (await A.$('.bi-pick input[accept^="application/pdf"]')).uploadFile(PDF2);
check('no API key on the server → a plain message and "enter by hand"', await until('billImport&&billImport.step==="pick"&&billImport.err') && /isn't set up yet/.test(await A.$eval('.billimp', (e) => e.textContent)) && !!(await A.$('[data-bi="manual"]')));

await browser.close(); await pg.db.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
